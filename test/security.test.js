/**
 * Tests de sécurité avancés — moteur de règles et hôte de partie.
 *
 * On se met dans la peau d'un client malveillant qui forge ses messages JSON à
 * la main, et on vérifie que l'hôte reste l'autorité :
 *  - il ne plante jamais et ne se laisse pas usurper ;
 *  - il refuse tout coup illégal, y compris par confusion de types ou clés de prototype ;
 *  - il ne divulgue ni les mains des autres, ni le paquet, ni la clé des dés, ni les jetons ;
 *  - l'aléa (dés, jetons, codes) est imprévisible ;
 *  - l'affichage du chat neutralise toute tentative d'injection HTML.
 *
 * Chaque bloc rappelle la faille réelle qu'il empêche de revenir. Aucun réseau ni
 * navigateur : timers simulés. Les attaques au niveau des sockets sont dans
 * server.security.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameHost } from '../src/net/host.js';
import { getMap } from '../src/core/map.js';
import { createRng, rollDice, isValidRng } from '../src/core/dice.js';
import { chacha20Block } from '../src/core/random.js';
import { applyAction, validateAction, possibleMoves } from '../src/core/rules.js';
import { createLobbyState, redactStateFor } from '../src/core/state.js';
import { decideBotAction } from '../src/core/bot.js';
import { randomId, newToken, generateGameCode, sanitizeCreateSettings, isValidName } from '../src/net/protocol.js';
import { ChatView } from '../src/ui/chat.js';

// ═══════════════════════════ Outils de test ═══════════════════════════

/** Timers contrôlés : on avance le temps avec tick(). */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => (pending.set(++seq, { at: now + ms, fn }), seq),
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
  };
}

/**
 * Hôte de test. Les messages sortants sont recopiés en JSON, exactement comme
 * s'ils passaient par le réseau : on inspecte ce qu'un client recevrait vraiment.
 */
function makeHost(settings = {}) {
  const outbox = new Map();
  const timers = fakeTimers();
  const host = new GameHost({
    gameId: 'SECU01',
    settings: { maxPlayers: 5, botDelayMs: 1, seed: 7, ...settings },
    sendTo: (cid, m) => outbox.set(cid, [...(outbox.get(cid) ?? []), JSON.parse(JSON.stringify(m))]),
    timers,
  });
  const h = {
    host,
    timers,
    outbox,
    send(cid, msg) {
      if (!host.clients.has(cid)) host.addClient(cid);
      host.handleMessage(cid, msg);
    },
    join(cid, name, token) {
      h.send(cid, { type: 'join', playerName: name, token });
      return h.last(cid, 'welcome');
    },
    all: (cid) => outbox.get(cid) ?? [],
    last: (cid, type) => [...(outbox.get(cid) ?? [])].reverse().find((m) => m.type === type),
    pid: (cid) => h.all(cid).find((m) => m.type === 'welcome')?.playerId,
    cid(playerId) {
      for (const [cid, c] of host.clients) if (c.playerId === playerId) return cid;
      return null;
    },
    /** Fait avancer la partie : les humains jouent comme des bots (via le protocole), les bots au fil du temps. */
    drive(until, maxSteps = 4000) {
      for (let i = 0; i < maxSteps; i++) {
        const s = host.state;
        if (until(s)) return true;
        if (s.status !== 'setup' && s.status !== 'playing') return false;
        const active = s.players.find((p) => p.id === s.turn.playerId);
        const cid = h.cid(active.id);
        if (cid && !active.controlledByBot) {
          const { playerId, ...action } = decideBotAction(s, active.id);
          host.handleMessage(cid, { type: 'action', seq: i, action });
        } else timers.tick(5);
      }
      return until(host.state);
    },
  };
  return h;
}

/** Partie commencée avec les humains donnés (le premier est le créateur). */
function startedHost(names = ['Alice', 'Bob'], settings = {}) {
  const h = makeHost(settings);
  names.forEach((n, i) => h.join(`c${i + 1}`, n));
  h.send('c1', { type: 'lobby', op: 'start' });
  assert.equal(h.host.state.status, 'setup');
  return h;
}

/** Partie « cœur » (sans hôte) amenée à une phase donnée pour le premier joueur. */
function coreStateIn(phase, seed = 5) {
  let s = createLobbyState({ id: 'CORE01', maxPlayers: 5, seed });
  ['Aa', 'Bb', 'Cc', 'Dd', 'Ee'].forEach((n, i) => (s = applyAction(s, { type: 'ADD_PLAYER', player: { id: `p${i}`, name: n } }).state));
  s = applyAction(s, { type: 'START_GAME' }).state;
  for (let i = 0; i < 5000; i++) {
    if (s.status === 'playing' && s.turn.phase === phase && !s.turn.pendingOccupy && !s.turn.mustExchange) {
      if (phase !== 'reinforce' || s.turn.reinforcements > 0) break;
    }
    s = applyAction(s, decideBotAction(s, s.turn.playerId)).state;
  }
  assert.equal(s.turn.phase, phase);
  return s;
}

/** Toutes les valeurs « presque nombres » qu'un client peut forger. */
const BAD_NUMBERS = ['3', '1e3', ' 2', '', null, undefined, NaN, Infinity, -Infinity, -1, 0, 1.5, 1e21, [2], [], {}, true, false, { valueOf: 2 }];
/** Identifiants piégés : clés héritées d'Object.prototype, types inattendus. */
const BAD_IDS = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__', '', ' ', null, undefined, 7, true, {}, [], ['alaska']];

/** Parcourt récursivement un objet JSON et renvoie les chemins des clés interdites. */
function findKeys(obj, forbidden, path = '$', out = []) {
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (forbidden.includes(k)) out.push(`${path}.${k}`);
      findKeys(v, forbidden, `${path}.${k}`, out);
    }
  }
  return out;
}

// ═══════════════════════════ 1. Autorité de l'hôte ═══════════════════════════

test('usurpation : le playerId glissé dans une action est ignoré, l’identité vient de la connexion', () => {
  const h = startedHost();
  const alice = h.pid('c1');
  h.drive((s) => s.turn.playerId === alice);
  const mine = Object.keys(h.host.state.territories).find((t) => h.host.state.territories[t].owner === alice);
  const before = JSON.stringify(h.host.state.territories);
  // Bob se fait passer pour Alice pendant le tour d'Alice
  h.send('c2', { type: 'action', seq: 1, action: { type: 'PLACE_TROOPS', playerId: alice, territory: mine, count: 1 } });
  assert.equal(h.last('c2', 'error').code, 'ILLEGAL_ACTION');
  assert.equal(h.last('c2', 'error').message, 'Ce n’est pas votre tour');
  assert.equal(JSON.stringify(h.host.state.territories), before, 'aucun effet sur le plateau');
});

test('autorité : client non inscrit, spectateur ou joueur hors de son tour ne peuvent rien faire', () => {
  const h = startedHost();
  h.send('sp', { type: 'spectate', name: 'Zoe' });
  const v0 = h.host.state.version;
  const bogus = { type: 'action', seq: 9, action: { type: 'END_PHASE' } };
  h.send('ghost', bogus);
  assert.match(h.last('ghost', 'error').message, /Rejoignez/);
  h.send('ghost', { type: 'chat', text: 'coucou' });
  h.send('ghost', { type: 'command', name: 'bot', args: [] });
  h.send('ghost', { type: 'lobby', op: 'start' });
  assert.equal(h.last('ghost', 'error').code, 'NOT_OWNER');
  h.send('sp', bogus);
  assert.equal(h.last('sp', 'error').code, 'SPECTATOR_ONLY');
  const notMyTurn = h.host.state.turn.playerId === h.pid('c1') ? 'c2' : 'c1';
  h.send(notMyTurn, bogus);
  assert.equal(h.last(notMyTurn, 'error').message, 'Ce n’est pas votre tour');
  assert.equal(h.host.state.version, v0, 'aucune de ces tentatives n’a modifié la partie');
  assert.ok(!h.host.chat.some((m) => m.text === 'coucou'), 'un client non inscrit ne peut pas écrire');
});

test('faille corrigée : les actions réservées à l’hôte ne passent pas par le canal des coups', () => {
  // Historique : le canal `action` acceptait ADD_PLAYER, START_GAME, SET_CONNECTED…
  // Un joueur qui n'était pas le créateur pouvait ajouter un joueur fantôme (sans
  // connexion : la partie se bloquait à son tour) ou démarrer la partie lui-même.
  const h = makeHost({ maxPlayers: 7 });
  ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'].forEach((n, i) => h.join(`c${i + 1}`, n));
  const hostOnly = [
    { type: 'START_GAME' },
    { type: 'ADD_PLAYER', player: { id: 'fantome', name: 'Fantome', type: 'human' } },
    { type: 'REMOVE_PLAYER', playerId: h.pid('c1') },
    { type: 'SET_CONNECTED', controlledByBot: true, connected: false },
  ];
  for (const action of hostOnly) {
    h.send('c2', { type: 'action', seq: 1, action });
    assert.equal(h.last('c2', 'error').code, 'ILLEGAL_ACTION', `${action.type} accepté depuis un client`);
  }
  assert.equal(h.host.state.status, 'lobby', 'la partie n’a pas démarré');
  assert.deepEqual(h.host.state.players.map((p) => p.name), ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'], 'aucun joueur ajouté ni retiré');
  assert.ok(h.host.state.players.every((p) => !p.controlledByBot && p.connected));
  // Même le créateur doit passer par le message de salon prévu
  h.send('c1', { type: 'action', seq: 2, action: { type: 'START_GAME' } });
  assert.equal(h.host.state.status, 'lobby');
  h.send('c1', { type: 'lobby', op: 'start' });
  assert.equal(h.host.state.status, 'setup');
});

// ═══════════════════════════ 2. Messages malformés ═══════════════════════════

test('robustesse : aucun message malformé ne fait planter l’hôte ni ne modifie la partie', () => {
  const h = startedHost();
  const garbage = [
    null, undefined, 0, 42, -1, 'hello', '', true, false, [], [1, 2], {},
    { type: 42 }, { type: null }, { type: ['action'] }, { type: { toString: 'action' } }, { type: '' },
    { type: '__proto__' }, { type: 'constructor' }, { type: 'toString' },
    { type: 'action' }, { type: 'action', action: null }, { type: 'action', action: 'ATTACK' },
    { type: 'action', action: [] }, { type: 'action', action: 42 }, { type: 'action', action: { type: 123 } },
    { type: 'action', action: { type: '__proto__' } }, { type: 'action', action: { type: 'START_GAME' } },
    { type: 'action', action: { type: 'ADD_PLAYER', player: { id: 'x', name: 'Intrus' } } },
    { type: 'action', action: { type: 'SET_CONNECTED', playerId: 'p', controlledByBot: true } },
    { type: 'action', action: { type: 'REMOVE_PLAYER', playerId: 'p' } },
    { type: 'lobby' }, { type: 'lobby', op: {} }, { type: 'lobby', op: 'kick', playerId: {} },
    { type: 'command' }, { type: 'command', name: {}, args: 'x' }, { type: 'command', name: 'bot', args: [{}, null] },
    { type: 'join' }, { type: 'join', playerName: {} }, { type: 'join', playerName: 'A'.repeat(10_000) },
    { type: 'spectate', name: [] }, { type: 'spectate', name: null },
  ];
  const board = () => JSON.stringify([h.host.state.territories, h.host.state.turn, h.host.state.players]);
  const before = board();
  for (const cid of ['c1', 'c2', 'stranger']) {
    for (const g of garbage) {
      assert.doesNotThrow(() => h.send(cid, g), `message ${JSON.stringify(g)} depuis ${cid}`);
    }
  }
  assert.equal(board(), before, 'aucun message malformé n’a changé le plateau, les joueurs ou le tour');
  // Les actions d'hôte (ADD_PLAYER, SET_CONNECTED…) ne sont jamais accessibles aux clients
  assert.equal(h.host.state.players.length, 5);
  assert.ok(h.host.state.players.every((p) => p.type === 'bot' || !p.controlledByBot));
});

// ═══════════════════════════ 3. Confusion de types ═══════════════════════════

test('faille corrigée : un nombre de troupes envoyé en texte ne multiplie plus les troupes', () => {
  // Historique : count "5" passait Number() à la validation, puis `troupes += "5"`
  // concaténait : 4 troupes + "5" donnaient "45" troupes.
  const h = startedHost(['Alice']);
  const alice = h.pid('c1');
  assert.ok(h.drive((s) => s.status === 'playing' && s.turn.playerId === alice && s.turn.phase === 'reinforce' && !s.turn.mustExchange));
  const s = h.host.state;
  const t = Object.keys(s.territories).find((id) => s.territories[id].owner === alice);
  const before = s.territories[t].troops;
  const reinf = s.turn.reinforcements;
  for (const count of [String(reinf), `${reinf}`, [reinf], { valueOf: reinf }]) {
    h.send('c1', { type: 'action', seq: 1, action: { type: 'PLACE_TROOPS', territory: t, count } });
    assert.equal(h.last('c1', 'error').code, 'ILLEGAL_ACTION', `count ${JSON.stringify(count)} doit être refusé`);
  }
  assert.equal(h.host.state.territories[t].troops, before);
  assert.equal(typeof h.host.state.territories[t].troops, 'number');
  // Le bon type passe toujours
  h.send('c1', { type: 'action', seq: 2, action: { type: 'PLACE_TROOPS', territory: t, count: reinf } });
  assert.equal(h.host.state.territories[t].troops, before + reinf);
});

test('confusion de types : chaque champ numérique n’accepte qu’un entier JavaScript réel', () => {
  // Renfort
  const r = coreStateIn('reinforce');
  const me = r.turn.playerId;
  const mine = Object.keys(r.territories).find((t) => r.territories[t].owner === me);
  for (const count of BAD_NUMBERS) {
    const action = { type: 'PLACE_TROOPS', playerId: me, territory: mine, count };
    assert.ok(validateAction(r, action), `PLACE_TROOPS count=${String(count)} accepté`);
    assert.throws(() => applyAction(r, action));
  }
  // Attaque
  const a = coreStateIn('attack');
  const att = possibleMoves(a, a.turn.playerId).attacks[0];
  for (const dice of BAD_NUMBERS) {
    assert.ok(validateAction(a, { type: 'ATTACK', playerId: a.turn.playerId, from: att.from, to: att.to, dice }), `ATTACK dice=${String(dice)} accepté`);
  }
  assert.equal(validateAction(a, { type: 'ATTACK', playerId: a.turn.playerId, from: att.from, to: att.to, dice: 1 }), null);
  // Déplacement
  const f = coreStateIn('fortify');
  const fid = f.turn.playerId;
  const own = Object.keys(f.territories).filter((t) => f.territories[t].owner === fid);
  f.territories[own[0]].troops = 10;
  const dest = own.find((t) => t !== own[0] && possibleMoves(f, fid).fortifies.some((m) => m.from === own[0] && m.to === t));
  if (dest) {
    for (const count of BAD_NUMBERS) {
      assert.ok(validateAction(f, { type: 'FORTIFY', playerId: fid, from: own[0], to: dest, count }), `FORTIFY count=${String(count)} accepté`);
    }
    // L'exploit par concaténation sur le territoire d'arrivée est fermé
    assert.throws(() => applyAction(f, { type: 'FORTIFY', playerId: fid, from: own[0], to: dest, count: '5' }));
  }
});

// ═══════════════════════════ 4. Clés de prototype ═══════════════════════════

test('prototype : identifiants piégés refusés partout, Object.prototype jamais pollué', () => {
  const protoKeys = Object.getOwnPropertyNames(Object.prototype).sort().join(',');
  const r = coreStateIn('reinforce');
  const a = coreStateIn('attack');
  const f = coreStateIn('fortify');
  const mine = (s) => Object.keys(s.territories).find((t) => s.territories[t].owner === s.turn.playerId);
  for (const id of BAD_IDS) {
    assert.ok(validateAction(r, { type: 'PLACE_TROOPS', playerId: r.turn.playerId, territory: id, count: 1 }), `territory=${JSON.stringify(id)}`);
    assert.ok(validateAction(a, { type: 'ATTACK', playerId: a.turn.playerId, from: id, to: mine(a), dice: 1 }));
    assert.ok(validateAction(a, { type: 'ATTACK', playerId: a.turn.playerId, from: mine(a), to: id, dice: 1 }));
    assert.ok(validateAction(f, { type: 'FORTIFY', playerId: f.turn.playerId, from: id, to: mine(f), count: 1 }));
    assert.ok(validateAction(r, { type: 'EXCHANGE_CARDS', playerId: r.turn.playerId, cardIds: [id, 'b', 'c'] }));
  }
  // Charge utile JSON contenant une clé « __proto__ » (JSON.parse en fait une propriété propre)
  const h = startedHost();
  for (const raw of [
    '{"type":"action","action":{"__proto__":{"polluted":true},"type":"END_PHASE"}}',
    '{"type":"chat","text":"x","__proto__":{"polluted":true}}',
    '{"type":"join","playerName":"Eve","__proto__":{"isAdmin":true}}',
    '{"type":"lobby","op":"settings","__proto__":{"maxPlayers":99},"constructor":{"prototype":{"polluted":true}}}',
  ]) {
    h.send('c2', JSON.parse(raw));
  }
  assert.equal({}.polluted, undefined);
  assert.equal({}.isAdmin, undefined);
  assert.equal(Object.getOwnPropertyNames(Object.prototype).sort().join(','), protoKeys, 'Object.prototype intact');
});

test('robustesse : un joueur qui s’appelle « constructor » ou « __proto__ » joue et discute normalement', () => {
  const h = makeHost();
  assert.ok(h.join('c1', 'constructor'), 'pseudo accepté (il ne sert jamais de clé d’objet)');
  assert.ok(h.join('c2', '__proto__'));
  assert.ok(h.join('c3', 'toString'));
  h.send('c1', { type: 'lobby', op: 'start' });
  h.send('c2', { type: 'chat', text: '#constructor alliance ? @toString' });
  const msg = h.host.chat.at(-1);
  assert.equal(msg.kind, 'private');
  assert.deepEqual(msg.to, [h.pid('c1')]);
  assert.deepEqual(msg.mentions, [h.pid('c3')]);
  assert.ok(h.last('c1', 'chat')?.message.id === msg.id, 'reçu par son destinataire');
  assert.notEqual(h.last('c3', 'chat')?.message.id, msg.id, 'invisible pour les autres');
});

// ═══════════════════════════ 5. Fuzzing ═══════════════════════════

test('fuzzing : 4 000 messages aléatoires ou hostiles, la partie reste cohérente à chaque instant', () => {
  let seed = 0xc0ffee;
  const rand = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  const h = startedHost(['Alice', 'Bob']);
  h.send('sp', { type: 'spectate', name: 'Zoe' });
  const map = getMap(h.host.state.mapId);
  const totalCards = map.TERRITORY_IDS.length + 2;
  const ids = [...map.TERRITORY_IDS.slice(0, 20), ...BAD_IDS];
  const clients = ['c1', 'c2', 'sp', 'ghost'];
  const types = ['PLACE_TROOPS', 'ATTACK', 'OCCUPY', 'FORTIFY', 'END_PHASE', 'EXCHANGE_CARDS', 'BOGUS', 42, null];
  const nums = [1, 2, 3, 5, 99, ...BAD_NUMBERS];
  let lastVersion = h.host.state.version;

  for (let i = 0; i < 4000; i++) {
    const r = rand();
    if (r < 0.45) {
      h.drive(() => false, 1); // un coup légitime (humain via le protocole, ou bots)
    } else if (r < 0.9) {
      const action = { type: pick(types), territory: pick(ids), from: pick(ids), to: pick(ids), count: pick(nums), dice: pick(nums) };
      if (rand() < 0.3) {
        const me = h.host.state.players.find((p) => p.id === h.pid('c1'));
        action.cardIds = rand() < 0.5 ? (me?.cards ?? []).slice(0, 3).map((c) => c.id) : [pick(ids), pick(ids), pick(ids)];
      }
      if (rand() < 0.2) action.playerId = pick(h.host.state.players).id; // tentative d'usurpation
      h.send(pick(clients), { type: 'action', seq: i, action });
    } else {
      h.send(pick(clients), pick([
        { type: 'chat', text: `<img src=x onerror=alert(${i})> #Bob @Zoe` },
        { type: 'command', name: pick(['bot', 'humain', 'passer', 'delai', 'kick', 'sync', 'x']), args: [pick(['Alice', 'Bob', '0', '__proto__'])] },
        { type: 'lobby', op: pick(['start', 'kick', 'settings', 'addBot']), maxPlayers: pick(nums) },
        { type: 'join', playerName: pick(['Alice', 'Bob', 'Mallory', '__proto__']), token: pick(['', 'tok_x', null]) },
        { type: pick(['__proto__', 'constructor', 'hack']) },
      ]));
    }

    const s = h.host.state;
    assert.ok(s.version >= lastVersion, 'version jamais en recul');
    lastVersion = s.version;
    if (s.status === 'lobby') continue;
    for (const t of map.TERRITORY_IDS) {
      const terr = s.territories[t];
      assert.ok(Number.isInteger(terr.troops) && terr.troops >= 1, `pas ${i} : ${t} a ${JSON.stringify(terr.troops)} troupes`);
      assert.ok(s.players.some((p) => p.id === terr.owner), `pas ${i} : ${t} a un propriétaire inconnu`);
    }
    const cards = s.players.reduce((n, p) => n + p.cards.length, 0) + s.cards.deck.length + s.cards.discard.length;
    assert.equal(cards, totalCards, `pas ${i} : cartes créées ou détruites`);
    assert.equal(Object.keys(s.territories).length, map.TERRITORY_IDS.length, `pas ${i} : territoire ajouté ou supprimé`);
    if (s.status === 'finished') break;
  }
});

// ═══════════════════════════ 6. Confidentialité ═══════════════════════════

test('confidentialité : rien de secret dans ce que reçoivent un adversaire ou un spectateur', () => {
  const h = startedHost(['Alice', 'Bob']);
  h.send('sp', { type: 'spectate', name: 'Zoe' });
  const alice = h.host.state.players.find((p) => p.id === h.pid('c1'));
  const aliceToken = h.last('c1', 'welcome').token;
  const bobToken = h.last('c2', 'welcome').token;
  // Trois cartes secrètes à Alice (deux infanteries + une cavalerie : pas échangeables seules)
  const inf = h.host.state.cards.deck.filter((c) => c.symbol === 'infantry').slice(0, 2);
  const cav = h.host.state.cards.deck.find((c) => c.symbol === 'cavalry');
  const secret = [...inf, cav];
  h.host.state.cards.deck = h.host.state.cards.deck.filter((c) => !secret.includes(c));
  alice.cards.push(...secret);
  alice.cardCount = alice.cards.length;
  // Un privé pour chacun des deux observateurs : chacun ne doit voir QUE le sien
  h.send('c1', { type: 'chat', text: '#Zoe secret-pour-zoe' });
  h.send('c1', { type: 'chat', text: '#Bob secret-pour-bob' });
  h.drive((s) => s.turnNumber >= 3, 1500);

  // Cartes rendues publiques par un échange : exclues de la vérification
  const exchanged = new Set();
  for (const m of h.all('c2')) for (const e of m.events ?? []) if (e.type === 'CARDS_EXCHANGED') e.cardIds.forEach((id) => exchanged.add(id));
  const hidden = secret.map((c) => c.id).filter((id) => !exchanged.has(id));
  assert.ok(hidden.length > 0);

  for (const [cid, ownToken, notForMe, forMe] of [
    ['c2', bobToken, 'secret-pour-zoe', 'secret-pour-bob'],
    ['sp', undefined, 'secret-pour-bob', 'secret-pour-zoe'],
  ]) {
    const inbox = h.all(cid);
    assert.ok(inbox.length > 20, 'le test inspecte bien un vrai flux de messages');
    const wire = JSON.stringify(inbox);
    assert.ok(!wire.includes(aliceToken), `${cid} a reçu le jeton d’Alice`);
    for (const id of hidden) assert.ok(!wire.includes(`"${id}"`), `${cid} a vu la carte ${id} d’Alice`);
    assert.ok(!wire.includes(notForMe), `${cid} a lu un message privé qui ne lui était pas destiné`);
    assert.ok(wire.includes(forMe), `${cid} n’a pas reçu le privé qui lui était destiné`);
    assert.deepEqual(findKeys(inbox, ['rng', 'deck', 'discard', 'seats', 'claims', 'k']), [], `${cid} a reçu une donnée interne de l’hôte`);
    for (const m of inbox) if ('token' in m) assert.equal(m.token, ownToken, `${cid} a reçu un jeton qui n’est pas le sien`);
  }
  // Contrôle positif : Alice voit bien ses propres cartes (le test n'est pas vide)
  assert.ok(JSON.stringify(h.all('c1')).includes(`"${hidden[0]}"`));
});

test('confidentialité : l’historique renvoyé à la reconnexion ne contient que ce qui vous était destiné', () => {
  const h = startedHost(['Alice', 'Bob', 'Carol']);
  h.send('c1', { type: 'chat', text: '#Carol plan-contre-Bob' });
  h.send('c2', { type: 'chat', text: 'message public' });
  const bobToken = h.last('c2', 'welcome').token;
  h.host.handleDisconnect('c2');
  h.join('c2b', 'Bob', bobToken);
  const history = h.last('c2b', 'chat_history').messages;
  assert.ok(history.some((m) => m.text === 'message public'));
  assert.ok(!history.some((m) => m.text.includes('plan-contre-Bob')), 'Bob ne récupère pas le privé Alice → Carol');
});

// ═══════════════════════════ 7. Chat ═══════════════════════════

test('chat : les champs forgés par le client (auteur, type, destinataires) sont ignorés', () => {
  const h = startedHost();
  h.send('c2', { type: 'chat', text: 'bonjour', fromName: 'Système', kind: 'system', from: null, to: [h.pid('c1')], mentions: ['x'], spectator: true, id: 'm_forge', ts: 0 });
  const m = h.host.chat.at(-1);
  assert.equal(m.fromName, 'Bob');
  assert.equal(m.from, h.pid('c2'));
  assert.equal(m.kind, 'public');
  assert.deepEqual(m.to, []);
  assert.deepEqual(m.mentions, []);
  assert.equal(m.spectator, false);
  assert.notEqual(m.id, 'm_forge');
  assert.ok(m.ts > 0);
});

test('chat : injection HTML neutralisée à l’affichage, y compris dans les mentions', () => {
  // Faux DOM minimal : ChatView n'utilise que innerHTML, querySelector et quelques propriétés
  const fakeEl = () => {
    const el = { innerHTML: '', value: '', scrollHeight: 0, scrollTop: 0, clientHeight: 0, kids: {}, addEventListener() {}, focus() {} };
    el.querySelector = (sel) => (el.kids[sel] ??= fakeEl());
    return el;
  };
  const container = fakeEl();
  const view = new ChatView(container, () => {});
  const players = [{ id: 'p1', name: 'Alice', color: 'red' }, { id: 'p2', name: 'Bob', color: 'blue' }];
  const payloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '"><svg onload=alert(1)>',
    "' onmouseover='alert(1)",
    '@Bob<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">clic</a>',
    '@constructor @toString #__proto__ @hasOwnProperty',
  ];
  const messages = payloads.map((text, i) => ({ id: `m${i}`, ts: Date.now(), kind: 'public', from: 'p1', fromName: 'Alice', text, mentions: [], to: [] }));
  view.render(messages, players, 'p2');
  const html = container.querySelector('.chat-list').innerHTML;

  // Les seules balises présentes sont celles du gabarit (div, span) et aucune n'a d'attribut d'événement
  const tags = html.match(/<[^>]*>/g) ?? [];
  for (const tag of tags) {
    assert.match(tag, /^<\/?(div|span)[\s>]/, `balise inattendue : ${tag}`);
    assert.ok(!/\son\w+\s*=/i.test(tag), `attribut d’événement dans ${tag}`);
    assert.ok(!/javascript:/i.test(tag), `URL javascript: dans ${tag}`);
  }
  assert.ok(html.includes('&lt;script&gt;'), 'le texte est échappé, pas supprimé');
  assert.ok(html.includes('class="mention"'), 'la vraie mention @Bob est bien mise en valeur');
  // Les pseudos « prototype » restent du texte : plus de « @Object » ni « @Function »
  assert.ok(html.includes('@constructor') && html.includes('@toString'));
  assert.ok(!html.includes('@Object') && !html.includes('@Function'));
});

test('pseudos : seuls lettres, chiffres, _ et - sont acceptés (rien d’interprétable en HTML)', () => {
  for (const bad of ['<b>x</b>', 'a b', 'x', 'a'.repeat(17), '', 'éric', 'a\nb', 'a"b', "a'b", 'a<b', 'a&b', 'a/b', null, 42, ['ab'], {}]) {
    assert.equal(isValidName(bad), false, `pseudo accepté : ${JSON.stringify(bad)}`);
  }
  for (const ok of ['Alice', 'Bob_42', 'a-b', 'XX']) assert.equal(isValidName(ok), true);
  const h = makeHost();
  h.send('c1', { type: 'join', playerName: '<img src=x>' });
  assert.equal(h.last('c1', 'error').code, 'INVALID_NAME');
  h.send('s1', { type: 'spectate', name: '<script>' });
  assert.equal(h.last('s1', 'error').code, 'INVALID_NAME');
});

// ═══════════════════════════ 8. Jetons, codes, identifiants ═══════════════════════════

test('faille corrigée : jetons, codes et identifiants ne dépendent plus de Math.random', () => {
  // Historique : tout sortait de Math.random, dont l'état se reconstitue à partir
  // de quelques sorties observées (identifiants de joueurs, de messages…).
  const real = Math.random;
  Math.random = () => 0.5;
  try {
    assert.notEqual(newToken(), newToken(), 'jeton');
    assert.notEqual(generateGameCode(), generateGameCode(), 'code de partie');
    assert.notEqual(randomId('p'), randomId('p'), 'identifiant');
  } finally {
    Math.random = real;
  }
});

test('jetons : 128 bits, uniques, et codes de partie uniformes (aucun biais exploitable)', () => {
  assert.match(newToken(), /^tok_[0-9a-f]{32}$/, 'jeton de 128 bits');
  const tokens = new Set(Array.from({ length: 20000 }, newToken));
  assert.equal(tokens.size, 20000);
  // Uniformité des caractères des codes (khi-deux, 31 degrés de liberté, seuil p = 0,001)
  const counts = new Map();
  const N = 6000;
  for (let i = 0; i < N; i++) {
    const code = generateGameCode();
    assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
    for (const ch of code) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  assert.equal(counts.size, 32, 'les 32 symboles apparaissent');
  const expected = (N * 6) / 32;
  const chi2 = [...counts.values()].reduce((s, o) => s + (o - expected) ** 2 / expected, 0);
  assert.ok(chi2 < 61.1, `distribution biaisée (khi-deux = ${chi2.toFixed(1)})`);
});

// ═══════════════════════════ 9. Reprise de place ═══════════════════════════

test('reprise de place : seul le jeton exact, sous forme de texte, rend une place', () => {
  const h = startedHost();
  const alice = h.pid('c1');
  const token = h.last('c1', 'welcome').token;
  h.host.handleDisconnect('c1');
  const forged = ['', ' ', token.slice(0, -1), `${token}0`, ` ${token}`, token.toUpperCase(), token.replace('tok_', ''), [token], { token }, 12345, true, null];
  forged.forEach((t, i) => {
    const cid = `x${i}`;
    h.send(cid, { type: 'join', playerName: 'Mallory', token: t });
    assert.notEqual(h.last(cid, 'welcome')?.playerId, alice, `jeton forgé accepté : ${JSON.stringify(t)}`);
  });
  assert.equal(h.join('good', 'Alice', token).playerId, alice, 'le vrai jeton fonctionne');
});

test('faille corrigée : reprendre une place par son pseudo ne dépossède plus le vrai joueur', () => {
  // Historique : pendant une coupure d'Alice, n'importe qui tapant « Alice »
  // prenait sa place ET invalidait son jeton : la vraie Alice était refusée.
  const h = startedHost();
  const alice = h.pid('c1');
  const aliceToken = h.last('c1', 'welcome').token;

  h.send('mallory', { type: 'join', playerName: 'Alice' });
  assert.equal(h.last('mallory', 'error').code, 'NAME_TAKEN', 'refusé tant qu’Alice est connectée');

  h.host.handleDisconnect('c1'); // coupure réseau
  const stolen = h.join('mallory2', 'Alice');
  assert.equal(stolen.playerId, alice, 'la reprise par pseudo reste possible (autre appareil)');
  assert.notEqual(stolen.token, aliceToken, 'on remet un jeton de reprise, jamais le jeton d’origine');
  assert.ok(!JSON.stringify(h.all('mallory2')).includes(aliceToken));

  // La vraie Alice revient avec son jeton : elle récupère sa place
  assert.equal(h.join('alice2', 'Alice', aliceToken).playerId, alice);
  assert.equal(h.last('mallory2', 'error').code, 'SEAT_TAKEN', 'l’intrus est prévenu');
  h.send('mallory2', { type: 'action', seq: 1, action: { type: 'END_PHASE' } });
  assert.match(h.last('mallory2', 'error').message, /Rejoignez/, 'et ne peut plus rien faire');
  // Son jeton de reprise est révoqué
  h.send('mallory3', { type: 'join', playerName: 'Alice', token: stolen.token });
  assert.notEqual(h.last('mallory3', 'welcome')?.playerId, alice);
});

test('pseudos : un joueur ne peut pas prendre le nom d’un spectateur (ni l’inverse)', () => {
  const h = makeHost();
  h.join('c1', 'Alice');
  h.send('s1', { type: 'spectate', name: 'Bob' });
  h.send('c2', { type: 'join', playerName: 'bob' });
  assert.equal(h.last('c2', 'error').code, 'NAME_TAKEN');
  h.send('s2', { type: 'spectate', name: 'ALICE' });
  assert.equal(h.last('s2', 'error').code, 'NAME_TAKEN');
});

// ═══════════════════════════ 10. Privilèges ═══════════════════════════

test('privilèges : seul le créateur gère le salon, et ses réglages sont typés strictement', () => {
  const h = makeHost();
  h.join('c1', 'Alice');
  h.join('c2', 'Bob');
  for (const op of [{ op: 'start' }, { op: 'addBot' }, { op: 'kick', playerId: h.pid('c1') }, { op: 'settings', maxPlayers: 7 }]) {
    h.send('c2', { type: 'lobby', ...op });
    assert.equal(h.last('c2', 'error').code, 'NOT_OWNER', `op ${op.op}`);
  }
  assert.equal(h.host.state.status, 'lobby');
  assert.equal(h.host.state.players.length, 2);
  // Réglages du créateur : un "6" en texte ou 6,5 étaient acceptés
  for (const maxPlayers of ['6', 6.5, 99, 4, -1, null, [6], true]) {
    h.send('c1', { type: 'lobby', op: 'settings', maxPlayers });
    assert.equal(h.host.state.settings.maxPlayers, 5, `maxPlayers=${JSON.stringify(maxPlayers)} accepté`);
  }
  h.send('c1', { type: 'lobby', op: 'settings', maxPlayers: 7 });
  assert.equal(h.host.state.settings.maxPlayers, 7);
  h.send('c1', { type: 'lobby', op: 'settings', botDelayMs: '100' });
  assert.equal(h.host.state.settings.botDelayMs, 1);
  h.send('c1', { type: 'lobby', op: 'settings', botDelayMs: -50 });
  assert.equal(h.host.state.settings.botDelayMs, 0);
  h.send('c1', { type: 'lobby', op: 'settings', botDelayMs: 1e12 });
  assert.equal(h.host.state.settings.botDelayMs, 5000);
});

test('privilèges : les commandes de dépannage visant un autre joueur sont réservées au créateur', () => {
  const h = startedHost(['Alice', 'Bob']);
  h.send('sp', { type: 'spectate', name: 'Zoe' });
  const alice = h.host.state.players.find((p) => p.id === h.pid('c1'));
  const delay = h.host.state.settings.botDelayMs;
  for (const [name, args] of [['bot', ['Alice']], ['humain', ['Alice']], ['delai', ['0']], ['kick', ['Alice']]]) {
    h.send('c2', { type: 'command', name, args });
    assert.match(h.last('c2', 'chat').message.text, /Réservé|Uniquement/, `/${name} par Bob`);
  }
  assert.equal(alice.controlledByBot, false, 'Alice n’a pas été remplacée par un bot');
  assert.equal(h.host.state.settings.botDelayMs, delay);
  h.drive((s) => s.turn.playerId === alice.id);
  h.send('c2', { type: 'command', name: 'passer', args: [] });
  assert.match(h.last('c2', 'chat').message.text, /Réservé/);
  assert.equal(alice.controlledByBot, false, 'Bob ne peut pas faire jouer le tour d’Alice par un bot');
  h.send('sp', { type: 'command', name: 'bot', args: ['Alice'] });
  assert.match(h.last('sp', 'chat').message.text, /réservée aux joueurs/);
});

// ═══════════════════════════ 11. Aléa du jeu ═══════════════════════════

test('dés : ChaCha20 conforme au vecteur de test officiel (RFC 8439 §2.3.2)', () => {
  const key = [0x03020100, 0x07060504, 0x0b0a0908, 0x0f0e0d0c, 0x13121110, 0x17161514, 0x1b1a1918, 0x1f1e1d1c];
  const out = chacha20Block(key, 1, [0x09000000, 0x4a000000, 0]).map((w) => w.toString(16).padStart(8, '0')).join(' ');
  assert.equal(out, 'e4e7f110 15593bd1 1fdd0f50 c47120a3 c7f4d1c7 0368c033 9aaa2204 4e6cd4c3 466482d2 09aa9f07 05d7c214 a2028bd9 d19c12b5 b94e16de e883d0cb 4e3c50a2');
});

test('faille corrigée : la clé des dés n’est plus dérivée de l’heure ni de Math.random', () => {
  // Historique : graine = Date.now() et générateur mulberry32. Retrouver la graine
  // à partir de la seule répartition publique des territoires prenait 5 secondes,
  // et révélait le paquet de cartes entier et tous les dés futurs.
  const realRandom = Math.random;
  const realNow = Date.now;
  Math.random = () => 0.5;
  Date.now = () => 1_700_000_000_000;
  try {
    const keys = Array.from({ length: 1000 }, () => createRng().k.join(','));
    assert.equal(new Set(keys).size, 1000, 'mille clés distinctes créées « au même instant »');
    const lobbyA = createLobbyState({ id: 'AAAAAA' });
    const lobbyB = createLobbyState({ id: 'BBBBBB' });
    assert.notDeepEqual(lobbyA.rng.k, lobbyB.rng.k, 'deux parties créées au même instant ont des dés différents');
  } finally {
    Math.random = realRandom;
    Date.now = realNow;
  }
  const rng = createRng();
  assert.ok(isValidRng(rng));
  assert.equal(rng.k.length, 8, 'clé de 256 bits');
});

test('dés : reproductibles avec une graine (tests, rejeu), et non truqués (khi-deux sur 60 000 lancers)', () => {
  assert.deepEqual(rollDice(createRng(42), 3)[0], rollDice(createRng(42), 3)[0]);
  assert.notDeepEqual(createRng(42).k, createRng(43).k);
  let rng = createRng(2026);
  const faces = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 20000; i++) {
    let rolls;
    [rolls, rng] = rollDice(rng, 3);
    for (const v of rolls) faces[v - 1]++;
  }
  const expected = 60000 / 6;
  const chi2 = faces.reduce((s, o) => s + (o - expected) ** 2 / expected, 0);
  assert.ok(chi2 < 20.5, `dés biaisés : ${faces.join(' / ')} (khi-deux = ${chi2.toFixed(2)}, seuil 20,5 pour p = 0,001)`);
});

test('dés : la clé ne quitte jamais l’hôte', () => {
  const h = startedHost();
  h.drive((s) => s.turnNumber >= 2, 800);
  const state = h.host.state;
  assert.ok(isValidRng(state.rng));
  assert.equal(redactStateFor(state, state.players[0].id).rng, undefined);
  for (const cid of ['c1', 'c2']) {
    assert.deepEqual(findKeys(h.all(cid), ['rng', 'k']), []);
    const wire = JSON.stringify(h.all(cid));
    for (const w of state.rng.k) assert.ok(!wire.includes(String(w)) || String(w).length < 6, 'mot de clé retrouvé dans le trafic');
  }
});

// ═══════════════════════════ 12. Réglages de création ═══════════════════════════

test('faille corrigée : un client ne choisit plus la graine des dés ni le code de partie', () => {
  // Historique : createLobbyState({ id, ...settings }) — `seed` et `id` venaient du client.
  const clean = sanitizeCreateSettings({ seed: 1, id: 'PIRATE', maxPlayers: 99, botDelayMs: -5, mapId: '../../etc/passwd', __proto__: { x: 1 }, extra: true });
  assert.deepEqual(clean, { maxPlayers: 6, botDelayMs: 0, mapId: 'world' });
  assert.deepEqual(sanitizeCreateSettings({ maxPlayers: 7, botDelayMs: 250, mapId: 'middle_earth' }), { maxPlayers: 7, botDelayMs: 250, mapId: 'middle_earth' });
  for (const raw of [null, undefined, 'x', 42, [], [1, 2]]) {
    assert.deepEqual(sanitizeCreateSettings(raw), { maxPlayers: 6, botDelayMs: 700, mapId: 'world' });
  }
  const host = new GameHost({ gameId: 'REAL01', settings: { id: 'PIRATE', maxPlayers: '7' }, sendTo() {} });
  assert.equal(host.state.id, 'REAL01', 'le code de partie ne peut pas être écrasé');
  assert.equal(host.state.settings.maxPlayers, 6, 'un "7" en texte est ignoré');
  host.close();
});

// ═══════════════════════════ 13. Sauvegardes ═══════════════════════════

test('sauvegardes : ancien générateur migré, code de partie validé, jetons de reprise conservés', () => {
  const h = startedHost();
  h.host.handleDisconnect('c1');
  h.join('claimer', 'Alice'); // crée un jeton de reprise
  const snap = JSON.parse(JSON.stringify(h.host.serialize()));
  assert.equal(snap.seats.find(([id]) => id === h.pid('claimer'))[1].claims.length, 1);

  // Ancienne sauvegarde : générateur mulberry32 { seed, count }
  const legacy = JSON.parse(JSON.stringify(snap));
  legacy.state.rng = { seed: 123456, count: 42 };
  legacy.seats = legacy.seats.map(([id, s]) => [id, { token: s.token }]); // ancien format, sans claims
  const restored = GameHost.restore(legacy, { sendTo() {}, timers: fakeTimers() });
  assert.ok(isValidRng(restored.state.rng), 'générateur remplacé par une clé cryptographique');
  assert.ok([...restored.seats.values()].every((s) => Array.isArray(s.claims)));
  restored.close();

  const withClaims = GameHost.restore(snap, { sendTo() {}, timers: fakeTimers() });
  assert.equal([...withClaims.seats.values()].reduce((n, s) => n + s.claims.length, 0), 1);
  withClaims.close();

  // Un code de partie qui contient un chemin est refusé (il sert à nommer le fichier)
  for (const gameId of ['../evil', 'a/b/cd', 'SECU0', 'SECU011', 'secu01', '', null, 42]) {
    assert.throws(() => GameHost.restore({ ...snap, gameId }, { sendTo() {}, timers: fakeTimers() }), `gameId ${JSON.stringify(gameId)}`);
  }
});

// ═══════════════════════════ 14. Déni de service logique ═══════════════════════════

test('déni de service : messages géants et avalanches restent bornés', () => {
  const h = startedHost();
  h.send('c1', { type: 'chat', text: 'x'.repeat(1_000_000) });
  assert.equal(h.host.chat.at(-1).text.length, 500, 'texte tronqué à 500 caractères');

  const huge = Array.from({ length: 100_000 }, (_, i) => `c_${i}`);
  const t0 = performance.now();
  const s = coreStateIn('reinforce');
  assert.ok(validateAction(s, { type: 'EXCHANGE_CARDS', playerId: s.turn.playerId, cardIds: huge }));
  assert.ok(performance.now() - t0 < 1000, 'refus immédiat, pas de traitement proportionnel à la taille');

  for (let i = 0; i < 2000; i++) h.send('c2', { type: 'chat', text: `spam ${i}` });
  assert.ok(h.host.chat.length <= 400, `historique borné (${h.host.chat.length} messages)`);
});
