/**
 * Tests de sécurité du serveur WebSocket, avec de VRAIES connexions : le serveur
 * est démarré sur un port libre avec un dossier de sauvegarde temporaire.
 *
 * Faille historique que ces tests empêchent de revenir : un message de 4 octets,
 * `null`, faisait tomber le serveur de production (lecture de `msg.type` sur null,
 * hors de tout try), déconnectant tous les joueurs, et pouvait être répété en boucle.
 *
 * Nécessite la dépendance du serveur : `cd server && npm install`. Sans elle,
 * ces tests sont ignorés (et le signalent).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let WebSocket;
let startServer;
try {
  WebSocket = (await import('../server/node_modules/ws/index.js')).default;
  ({ startServer } = await import('../server/app.js'));
} catch {
  /* dépendance ws absente */
}
const skip = WebSocket ? false : 'dépendance « ws » absente : lancez « cd server && npm install »';

const FRONT = 'https://dchirez.fr/risk-online/';
const quiet = { log() {}, warn() {}, error() {} };
const tempDirs = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'risk-secu-'));
  tempDirs.push(d);
  return d;
}

/** Client de test : file de messages reçus, attente d'un message futur, code de fermeture. */
function connect(port, { origin } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { headers: { Origin: origin } } : {});
    const waiters = [];
    const client = {
      ws,
      inbox: [],
      closeCode: null,
      send: (x) => ws.send(typeof x === 'string' || Buffer.isBuffer(x) ? x : JSON.stringify(x)),
      /** Prochain message (futur) vérifiant `pred`. */
      expect(pred, ms = 3000) {
        return new Promise((res, rej) => {
          const w = { pred, res };
          waiters.push(w);
          setTimeout(() => {
            if (waiters.includes(w)) {
              waiters.splice(waiters.indexOf(w), 1);
              rej(new Error('délai dépassé en attendant un message'));
            }
          }, ms);
        });
      },
      closed: () => new Promise((res) => (client.closeCode !== null ? res(client.closeCode) : ws.once('close', (code) => res(code)))),
      close: () => ws.close(),
    };
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      client.inbox.push(m);
      for (const w of [...waiters]) {
        if (w.pred(m)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.res(m);
        }
      }
    });
    ws.on('close', (code) => (client.closeCode = code));
    ws.once('open', () => resolve(client));
    ws.once('error', reject);
  });
}
const isType = (type) => (m) => m.type === type;
const isError = (code) => (m) => m.type === 'error' && (!code || m.code === code);

/** Crée une partie et renvoie le client (créateur) et son message de bienvenue. */
async function createGame(port, settings = {}, name = 'Alice') {
  const c = await connect(port);
  const welcome = c.expect(isType('welcome'));
  const state = c.expect(isType('state'));
  c.send({ type: 'create', playerName: name, settings });
  return { c, welcome: await welcome, state: (await state).state };
}

let server;
before(async () => {
  if (skip) return;
  server = await startServer({ port: 0, frontUrl: FRONT, dataDir: tempDir(), log: quiet });
});
after(async () => {
  await server?.close();
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

// ═══════════════════════════ Robustesse ═══════════════════════════

test('serveur : aucune charge utile inattendue ne le fait tomber (dont le « null » historique)', { skip }, async () => {
  const c = await connect(server.port);
  const payloads = ['null', '5', '-1', 'true', '[]', '[1,2]', '"x"', '{}', '{"type":5}', '{"type":null}', '{"type":"__proto__"}', '{pas du json', '', ' ', '{"type":"create","playerName":{}}', `${'['.repeat(3000)}${']'.repeat(3000)}`];
  for (const p of payloads) {
    const err = c.expect(isError());
    c.send(p);
    assert.ok(await err, `pas de réponse à ${JSON.stringify(p.slice(0, 30))}`);
  }
  const pong = c.expect(isType('pong'));
  c.send({ type: 'ping' });
  await pong;
  assert.equal(c.ws.readyState, WebSocket.OPEN, 'la connexion reste ouverte');
  // Et le serveur sert toujours les autres
  const { welcome } = await createGame(server.port);
  assert.match(welcome.gameId, /^[A-Z0-9]{6}$/);
  c.close();
});

test('serveur : message binaire refusé, message géant → connexion fermée (1009), serveur intact', { skip }, async () => {
  const c = await connect(server.port);
  const err = c.expect(isError('BAD_MESSAGE'));
  c.send(Buffer.from('{"type":"ping"}'));
  assert.match((await err).message, /texte/);

  const big = await connect(server.port);
  big.send(JSON.stringify({ type: 'chat', text: 'x'.repeat(200 * 1024) }));
  assert.equal(await big.closed(), 1009, 'fermeture « message trop grand »');

  const pong = c.expect(isType('pong'));
  c.send({ type: 'ping' });
  await pong;
  c.close();
});

// ═══════════════════════════ Limitation de débit ═══════════════════════════

test('serveur : une inondation de messages est freinée puis coupée (1008), sans gêner les autres', { skip }, async () => {
  const flooder = await connect(server.port);
  const bystander = await connect(server.port);
  const limited = flooder.expect(isError('RATE_LIMITED'));
  for (let i = 0; i < 400; i++) flooder.send({ type: 'ping' });
  assert.ok(await limited, 'avertissement de débit reçu');
  assert.equal(await flooder.closed(), 1008, 'connexion fermée pour abus');
  const pongs = flooder.inbox.filter((m) => m.type === 'pong').length;
  assert.ok(pongs <= 70, `${pongs} messages traités sur 400`);

  const pong = bystander.expect(isType('pong'));
  bystander.send({ type: 'ping' });
  await pong;
  bystander.close();
});

test('serveur : le chat est limité (anti-spam) sans couper la connexion', { skip }, async () => {
  const { c } = await createGame(server.port, { maxPlayers: 5 }, 'Bavard');
  const limited = c.expect(isError('RATE_LIMITED'));
  for (let i = 0; i < 30; i++) c.send({ type: 'chat', text: `spam ${i}` });
  await limited;
  await new Promise((r) => setTimeout(r, 200));
  const delivered = c.inbox.filter((m) => m.type === 'chat' && m.message.fromName === 'Bavard').length;
  assert.ok(delivered <= 9, `${delivered} messages de chat passés sur 30`);
  assert.equal(c.ws.readyState, WebSocket.OPEN, 'un bavard n’est pas déconnecté pour autant');
  c.close();
});

// ═══════════════════════════ Création de partie ═══════════════════════════

test('serveur : réglages de création filtrés (graine, code, carte, joueurs, vitesse)', { skip }, async () => {
  const { c, welcome, state } = await createGame(server.port, { seed: 1, id: 'PIRATE', maxPlayers: 99, botDelayMs: -5, mapId: '../../etc/passwd', admin: true });
  assert.match(welcome.gameId, /^[A-Z0-9]{6}$/);
  assert.notEqual(welcome.gameId, 'PIRATE');
  assert.equal(state.id, welcome.gameId, 'le code de partie ne peut pas être imposé');
  assert.equal(state.settings.maxPlayers, 6);
  assert.equal(state.settings.botDelayMs, 0);
  assert.equal(state.mapId, 'world');
  assert.equal(state.rng, undefined, 'la clé des dés n’est jamais envoyée');
  assert.match(welcome.token, /^tok_[0-9a-f]{32}$/, 'jeton de 128 bits');
  c.close();
});

test('faille corrigée : la graine des dés ne peut pas être imposée par le client', { skip }, async () => {
  // Deux parties identiques (même graine demandée, même pseudo, mêmes bots) :
  // si la graine était honorée, la répartition des territoires serait identique.
  const layouts = [];
  for (let i = 0; i < 2; i++) {
    const { c } = await createGame(server.port, { seed: 424242, maxPlayers: 5 }, 'Alice');
    const started = c.expect((m) => m.type === 'state' && m.state.status === 'setup');
    c.send({ type: 'lobby', op: 'start' });
    const s = (await started).state;
    const nameOf = Object.fromEntries(s.players.map((p) => [p.id, p.name]));
    layouts.push(JSON.stringify(Object.keys(s.territories).sort().map((t) => nameOf[s.territories[t].owner])));
    c.close();
  }
  assert.notEqual(layouts[0], layouts[1], 'les deux parties ont la même répartition : la graine du client est utilisée');
});

test('serveur : nombre maximal de parties simultanées', { skip }, async () => {
  const small = await startServer({ port: 0, frontUrl: FRONT, dataDir: tempDir(), log: quiet, maxGames: 1 });
  try {
    const first = await createGame(small.port);
    const c2 = await connect(small.port);
    const full = c2.expect(isError('SERVER_FULL'));
    c2.send({ type: 'create', playerName: 'Bob', settings: {} });
    await full;
    first.c.close();
    c2.close();
  } finally {
    await small.close();
  }
});

test('serveur : une connexion reste liée à une seule partie', { skip }, async () => {
  const a = await createGame(server.port, {}, 'Alice');
  const b = await createGame(server.port, {}, 'Bob');
  const err = a.c.expect(isError());
  a.c.send({ type: 'join', gameId: b.welcome.gameId, playerName: 'Alice2' });
  assert.match((await err).message, /Déjà dans la partie/);
  const err2 = a.c.expect(isError());
  a.c.send({ type: 'create', playerName: 'Alice3', settings: {} });
  assert.ok(await err2, 'pas de seconde partie sur la même connexion');
  a.c.close();
  b.c.close();
});

// ═══════════════════════════ Origine du navigateur ═══════════════════════════

test('serveur : seules les pages du site (et localhost) peuvent ouvrir une connexion depuis un navigateur', { skip }, async () => {
  for (const origin of ['https://dchirez.fr', 'https://www.dchirez.fr', 'http://localhost:5180', 'http://127.0.0.1:8080', undefined]) {
    const c = await connect(server.port, { origin });
    c.close();
  }
  for (const origin of ['https://evil.example', 'https://dchirez.fr.evil.com', 'https://evildchirez.fr', 'http://dchirez.fr', 'https://dchirez.fr:8443', 'null', 'file://']) {
    await assert.rejects(connect(server.port, { origin }), `origine acceptée à tort : ${origin}`);
  }
});

// ═══════════════════════════ Sauvegardes ═══════════════════════════

test('serveur : des fichiers de sauvegarde piégés sont ignorés au démarrage, sans rien écrire ailleurs', { skip }, async () => {
  const dir = tempDir();
  const games = join(dir, 'games');
  mkdirSync(games, { recursive: true });
  writeFileSync(join(games, 'ABCDEF.json'), JSON.stringify({ gameId: '../../../evil', state: { status: 'playing', players: [] } }));
  writeFileSync(join(games, 'GHJKLM.json'), '{ ceci n’est pas du JSON');
  writeFileSync(join(games, 'QRSTUV.json'), JSON.stringify({ gameId: 'QRSTUV' })); // état absent
  writeFileSync(join(games, 'NULL00.json'), 'null');
  writeFileSync(join(games, 'nom-bizarre.json'), JSON.stringify({ gameId: 'WXYZ23', state: {} }));
  writeFileSync(join(games, 'ZZZZZZ.json.tmp'), '{}');
  const s = await startServer({ port: 0, frontUrl: FRONT, dataDir: dir, log: quiet });
  try {
    assert.equal(s.games.size, 0, 'aucune partie piégée n’est chargée');
    assert.ok(!existsSync(join(dir, '..', 'evil.json')) && !existsSync(join(dir, '..', '..', 'evil.json')));
    const { c } = await createGame(s.port);
    c.close();
  } finally {
    await s.close();
  }
  assert.ok(readdirSync(games).every((f) => !f.includes('..')));
});
