/**
 * Serveur WebSocket du Risk en ligne.
 *
 * Il ne contient AUCUNE règle de jeu : il route les messages vers la bonne
 * partie (GameHost, src/net/host.js) et s'occupe de la persistance.
 *
 *   cd server && npm install
 *   PORT=8080 FRONT_URL=https://dchirez.fr/risk-online/ node index.js
 *
 * Variables d'environnement :
 *   PORT             port d'écoute (défaut 8080)
 *   FRONT_URL        URL publique du site, pour fabriquer les liens d'invitation
 *   DATA_DIR         dossier des sauvegardes (défaut : server/data)
 *   RETENTION_HOURS  conservation d'une partie sans aucun humain (défaut 96 h)
 *
 * Persistance : chaque partie est écrite dans DATA_DIR/games/<code>.json à chaque
 * changement (état, chat, réglages) et rechargée au démarrage. Une partie
 * terminée est supprimée immédiatement ; une partie sans présence humaine depuis
 * RETENTION_HOURS est supprimée ; un lobby vide depuis 1 h aussi.
 * Quand plus aucun humain n'est connecté, les bots ne jouent pas (pause).
 */
import { WebSocketServer } from 'ws';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameHost } from '../src/net/host.js';
import { C2S, S2C, ERROR_CODES, generateGameCode, randomId } from '../src/net/protocol.js';

const PORT = Number(process.env.PORT ?? 8080);
/** URL publique du frontend (GitHub Pages) pour fabriquer les liens d'invitation. */
const FRONT_URL = process.env.FRONT_URL ?? 'http://localhost:5180/';
const DATA_DIR = process.env.DATA_DIR ?? fileURLToPath(new URL('./data/', import.meta.url));
const GAMES_DIR = join(DATA_DIR, 'games');
const RETENTION_MS = Number(process.env.RETENTION_HOURS ?? 96) * 3600 * 1000;
const EMPTY_LOBBY_MS = 60 * 60 * 1000;
const SWEEP_MS = 10 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 300;

/** @type {Map<string, GameHost>} */
const games = new Map();
/** @type {Map<string, import('ws').WebSocket>} clientId → socket */
const sockets = new Map();

function sendTo(clientId, message) {
  const ws = sockets.get(clientId);
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

// ═══════════════════════════ Persistance ═══════════════════════════

mkdirSync(GAMES_DIR, { recursive: true });
const gameFile = (id) => join(GAMES_DIR, `${id}.json`);
const saveTimers = new Map();

function saveNow(host) {
  saveTimers.delete(host.gameId);
  if (host.closed) return;
  try {
    const tmp = gameFile(host.gameId) + '.tmp';
    writeFileSync(tmp, JSON.stringify(host.serialize()));
    renameSync(tmp, gameFile(host.gameId)); // écriture atomique
  } catch (e) {
    console.error(`[persist] échec de sauvegarde ${host.gameId} :`, e.message);
  }
}

function scheduleSave(host) {
  if (saveTimers.has(host.gameId)) return;
  saveTimers.set(host.gameId, setTimeout(() => saveNow(host), SAVE_DEBOUNCE_MS));
}

function removeGame(id, reason) {
  const host = games.get(id);
  if (host) host.close();
  games.delete(id);
  clearTimeout(saveTimers.get(id));
  saveTimers.delete(id);
  try {
    if (existsSync(gameFile(id))) unlinkSync(gameFile(id));
  } catch (e) {
    console.error(`[persist] suppression ${id} :`, e.message);
  }
  console.log(`[games] ${id} supprimée (${reason})`);
}

/** Branche les hooks de persistance sur une partie. */
function track(host) {
  games.set(host.gameId, host);
  host.onDirty = () => {
    if (host.state.status === 'finished') {
      // Partie terminée : supprimée tout de suite (après que l'état final soit parti aux clients)
      setTimeout(() => removeGame(host.gameId, 'terminée'), 1000);
      return;
    }
    scheduleSave(host);
  };
  return host;
}

function loadGames() {
  let n = 0;
  for (const file of readdirSync(GAMES_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const snapshot = JSON.parse(readFileSync(join(GAMES_DIR, file), 'utf8'));
      if (snapshot.state?.status === 'finished') {
        unlinkSync(join(GAMES_DIR, file));
        continue;
      }
      track(GameHost.restore(snapshot, { sendTo }));
      n++;
    } catch (e) {
      console.error(`[persist] fichier ignoré ${file} :`, e.message);
    }
  }
  return n;
}

/** Nettoyage périodique : parties expirées, lobbies vides. */
function sweep() {
  const now = Date.now();
  for (const [id, host] of games) {
    if (host.state.status === 'finished') removeGame(id, 'terminée');
    else if (host.state.status === 'lobby' && host.state.players.length === 0 && now - host.lastActivity > EMPTY_LOBBY_MS) removeGame(id, 'lobby vide');
    else if (!host.hasConnectedHuman() && now - host.lastActivity > RETENTION_MS) removeGame(id, `inactive depuis ${Math.round(RETENTION_MS / 3600000)} h`);
  }
}

// ═══════════════════════════ Parties ═══════════════════════════

function createGame(settings) {
  let gameId = generateGameCode();
  while (games.has(gameId)) gameId = generateGameCode();
  const host = new GameHost({ gameId, settings, inviteUrl: `${FRONT_URL}?game=${gameId}`, sendTo });
  return track(host);
}

// ═══════════════════════════ WebSocket ═══════════════════════════

const restored = loadGames();
const wss = new WebSocketServer({ port: PORT });
wss.on('connection', (ws) => {
  const clientId = randomId('ws');
  sockets.set(clientId, ws);
  /** @type {GameHost|null} */
  let host = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return sendTo(clientId, { type: S2C.ERROR, code: ERROR_CODES.BAD_MESSAGE, message: 'JSON invalide' });
    }
    // Routage vers la bonne partie : create / join sont traités ici, le reste par l'hôte.
    if (!host) {
      if (msg.type === C2S.CREATE) {
        host = createGame(msg.settings ?? {});
        host.addClient(clientId);
        return host.handleMessage(clientId, { type: C2S.JOIN, playerName: msg.playerName });
      }
      if (msg.type === C2S.JOIN || msg.type === C2S.SPECTATE) {
        host = games.get(String(msg.gameId ?? '').toUpperCase()) ?? null;
        if (!host) return sendTo(clientId, { type: S2C.ERROR, code: ERROR_CODES.GAME_NOT_FOUND, message: 'Partie introuvable (code erroné, partie terminée ou expirée)' });
        host.addClient(clientId);
        return host.handleMessage(clientId, msg);
      }
      if (msg.type === C2S.PING) return sendTo(clientId, { type: S2C.PONG });
      return sendTo(clientId, { type: S2C.ERROR, code: ERROR_CODES.BAD_MESSAGE, message: 'Rejoignez une partie d’abord' });
    }
    host.handleMessage(clientId, msg);
  });

  ws.on('close', () => {
    sockets.delete(clientId);
    host?.handleDisconnect(clientId);
  });
});

setInterval(sweep, SWEEP_MS);

// Arrêt propre : on force l'écriture des sauvegardes en attente
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const host of games.values()) if (saveTimers.has(host.gameId)) saveNow(host);
    process.exit(0);
  });
}

console.log(`Serveur Risk en écoute sur ws://localhost:${PORT} (front : ${FRONT_URL})`);
console.log(`Sauvegardes : ${GAMES_DIR} — ${restored} partie(s) rechargée(s), conservation ${Math.round(RETENTION_MS / 3600000)} h`);
