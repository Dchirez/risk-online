/**
 * Tests de l'hôte de partie (GameHost) avec transport et timers simulés :
 * pause sans humain, reprise de place par pseudo, sauvegarde / rechargement.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameHost } from '../src/net/host.js';
import { getPlayer } from '../src/core/state.js';

/** Timers contrôlés à la main : on avance le temps avec tick(). */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => {
      const id = ++seq;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => pending.delete(id),
    tick(ms) {
      now += ms;
      for (const [id, t] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) {
          pending.delete(id);
          t.fn();
        }
      }
    },
    get size() {
      return pending.size;
    },
  };
}

function makeHost() {
  const outbox = new Map(); // clientId → messages
  const timers = fakeTimers();
  const host = new GameHost({
    gameId: 'TEST01',
    settings: { maxPlayers: 5, botDelayMs: 10, seed: 42 },
    sendTo: (cid, m) => outbox.set(cid, [...(outbox.get(cid) ?? []), m]),
    timers,
  });
  const last = (cid, type) => [...(outbox.get(cid) ?? [])].reverse().find((m) => m.type === type);
  return { host, timers, outbox, last };
}

function joinAndStart(h) {
  h.host.addClient('c1');
  h.host.handleMessage('c1', { type: 'join', playerName: 'Alice' });
  h.host.addClient('c2');
  h.host.handleMessage('c2', { type: 'join', playerName: 'Bob' });
  h.host.handleMessage('c1', { type: 'lobby', op: 'start' });
  assert.equal(h.host.state.status, 'setup');
}

test('pause : sans humain connecté les bots ne jouent pas, reprise au retour', () => {
  const h = makeHost();
  joinAndStart(h);
  const v0 = h.host.state.version;
  h.timers.tick(100); // les bots jouent tant qu'un humain est là
  assert.ok(h.host.state.version > v0);

  h.host.handleDisconnect('c1');
  h.host.handleDisconnect('c2');
  assert.ok(h.host.paused);
  const board = () => JSON.stringify([h.host.state.territories, h.host.state.turn, h.host.state.turnNumber]);
  const frozen = board();
  h.timers.tick(60000); // les remplacements par des bots s'arment, mais aucun coup n'est joué
  assert.equal(board(), frozen, 'aucun coup joué pendant la pause');
  assert.ok(h.host.chat.some((m) => m.text.startsWith('Partie en pause')));

  // Alice revient avec son pseudo (nouvel onglet, sans jeton)
  h.host.addClient('c3');
  h.host.handleMessage('c3', { type: 'join', playerName: 'alice' });
  assert.equal(h.last('c3', 'welcome').playerId, h.host.state.players.find((p) => p.name === 'Alice').id);
  assert.ok(!h.host.paused);
  h.timers.tick(20000); // Bob absent → bot après 15 s, puis la partie avance
  assert.notEqual(board(), frozen, 'la partie reprend');
  const bob = h.host.state.players.find((p) => p.name === 'Bob');
  assert.ok(bob.controlledByBot && !bob.connected);
});

test('reprise de place : pseudo connecté refusé, pseudo inconnu refusé en partie', () => {
  const h = makeHost();
  joinAndStart(h);
  h.host.addClient('c9');
  h.host.handleMessage('c9', { type: 'join', playerName: 'Alice' });
  assert.equal(h.last('c9', 'error').code, 'NAME_TAKEN');
  h.host.addClient('c10');
  h.host.handleMessage('c10', { type: 'join', playerName: 'Zoe' });
  assert.equal(h.last('c10', 'error').code, 'GAME_FULL');
});

test('sauvegarde / rechargement : état, chat et jetons conservés, humains déconnectés', () => {
  const h = makeHost();
  let dirty = 0;
  h.host.onDirty = () => dirty++;
  joinAndStart(h);
  h.host.handleMessage('c2', { type: 'chat', text: '#Alice on s’allie ?' });
  assert.ok(dirty > 0);
  const snapshot = JSON.parse(JSON.stringify(h.host.serialize()));
  const aliceToken = h.last('c1', 'welcome').token;

  const h2 = makeHost();
  const restored = GameHost.restore(snapshot, { sendTo: h2.host.sendTo, timers: h2.timers });
  assert.equal(restored.state.status, 'setup');
  assert.equal(restored.chat.length, h.host.chat.length);
  assert.ok(restored.paused);
  assert.ok(restored.state.players.filter((p) => p.type === 'human').every((p) => !p.connected && !p.controlledByBot));

  // Retour d'Alice avec son ancien jeton : même joueur, chat privé visible
  restored.addClient('n1');
  restored.handleMessage('n1', { type: 'join', playerName: 'Alice', token: aliceToken });
  const welcome = h2.last('n1', 'welcome');
  assert.equal(welcome.playerId, getPlayer(restored.state, snapshot.ownerId).id);
  const history = h2.last('n1', 'chat_history');
  assert.ok(history.messages.some((m) => m.kind === 'private' && m.text.includes('allie')));
  assert.ok(!restored.paused);
});

// ───────────────────────────── Mode spectateur ─────────────────────────────

test('spectateur : accès à une partie pleine ou commencée, sans voir les mains ni pouvoir jouer', () => {
  const h = makeHost();
  joinAndStart(h);
  const alice = h.host.state.players.find((p) => p.name === 'Alice');
  alice.cards = [{ id: 'c_x', symbol: 'joker', territory: null }];
  alice.cardCount = 1; // normalement recalculé par le moteur de règles

  // Rejoindre en joueur est refusé, regarder est accepté
  h.host.addClient('sp');
  h.host.handleMessage('sp', { type: 'join', playerName: 'Zoe' });
  assert.equal(h.last('sp', 'error').code, 'GAME_FULL');
  h.host.handleMessage('sp', { type: 'spectate', name: 'Zoe' });
  const welcome = h.last('sp', 'welcome');
  assert.equal(welcome.spectator, true);
  assert.ok(welcome.playerId.startsWith('s_'));

  // L'état reçu masque toutes les mains et liste le spectateur
  const view = h.last('sp', 'state').state;
  assert.ok(view.players.every((p) => p.cards.length === 0), 'aucune main visible');
  assert.equal(view.players.find((p) => p.name === 'Alice').cardCount, 1);
  assert.equal(view.rng, undefined);
  assert.deepEqual(view.spectators.map((s) => s.name), ['Zoe']);

  // Aucune action de jeu possible
  h.host.handleMessage('sp', { type: 'action', seq: 1, action: { type: 'END_PHASE' } });
  assert.equal(h.last('sp', 'error').code, 'SPECTATOR_ONLY');

  // Les joueurs voient le spectateur dans leur propre vue
  assert.deepEqual(h.last('c1', 'state').state.spectators.map((s) => s.name), ['Zoe']);

  // Pseudo déjà pris
  h.host.addClient('sp2');
  h.host.handleMessage('sp2', { type: 'spectate', name: 'zoe' });
  assert.equal(h.last('sp2', 'error').code, 'NAME_TAKEN');
  h.host.addClient('sp3');
  h.host.handleMessage('sp3', { type: 'spectate', name: 'Alice' });
  assert.equal(h.last('sp3', 'error').code, 'NAME_TAKEN');
});

test('spectateur : chat public et privé dans les deux sens, départ propre', () => {
  const h = makeHost();
  joinAndStart(h);
  h.host.addClient('sp');
  h.host.handleMessage('sp', { type: 'spectate', name: 'Zoe' });
  const specId = h.last('sp', 'welcome').playerId;

  // Message public du spectateur : marqué, visible par les joueurs
  h.host.handleMessage('sp', { type: 'chat', text: 'belle partie !' });
  const pub = h.host.chat.at(-1);
  assert.equal(pub.kind, 'public');
  assert.equal(pub.spectator, true);
  assert.equal(pub.fromName, 'Zoe');
  assert.equal(h.last('c1', 'chat').message.text, 'belle partie !');

  // Privé du spectateur vers un joueur : invisible pour les autres
  h.host.handleMessage('sp', { type: 'chat', text: '#Alice bien joué' });
  const priv = h.host.chat.at(-1);
  assert.equal(priv.kind, 'private');
  assert.notEqual(h.last('c2', 'chat').message.id, priv.id, 'Bob ne voit pas le privé');
  assert.equal(h.last('c1', 'chat').message.id, priv.id, 'Alice le voit');

  // Privé d'un joueur vers le spectateur
  h.host.handleMessage('c1', { type: 'chat', text: '#Zoe merci' });
  assert.equal(h.last('sp', 'chat').message.text, '#Zoe merci');

  // Les commandes de jeu sont refusées au spectateur
  h.host.handleMessage('sp', { type: 'command', name: 'passer', args: [] });
  assert.match(h.last('sp', 'chat').message.text, /réservée aux joueurs/);

  // Un spectateur ne relance pas la partie en pause
  h.host.handleDisconnect('c1');
  h.host.handleDisconnect('c2');
  assert.ok(h.host.paused, 'seuls les joueurs réveillent la partie');

  // Départ : retiré de la liste
  h.host.handleDisconnect('sp');
  assert.equal(h.host.spectatorList().length, 0);
  assert.equal(h.host.spectatorList().find((s) => s.id === specId), undefined);
});
