/**
 * BROUILLON du serveur WebSocket — non déployé, non testé en conditions réelles.
 *
 * Il montre comment brancher GameHost (src/net/host.js) sur de vraies sockets :
 * le serveur ne contient AUCUNE règle de jeu, il route seulement les messages.
 *
 *   npm install ws
 *   node server/index.js          (PORT=8080 par défaut)
 *
 * Côté client : src/config.js → wsUrl: 'ws://localhost:8080'
 */
import { WebSocketServer } from 'ws';
import { GameHost } from '../src/net/host.js';
import { C2S, S2C, ERROR_CODES, generateGameCode, randomId } from '../src/net/protocol.js';

const PORT = Number(process.env.PORT ?? 8080);
/** URL publique du frontend (GitHub Pages) pour fabriquer les liens d'invitation. */
const FRONT_URL = process.env.FRONT_URL ?? 'http://localhost:5180/';

/** @type {Map<string, GameHost>} */
const games = new Map();
/** @type {Map<string, import('ws').WebSocket>} clientId → socket */
const sockets = new Map();

function sendTo(clientId, message) {
  const ws = sockets.get(clientId);
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function createGame(settings) {
  let gameId = generateGameCode();
  while (games.has(gameId)) gameId = generateGameCode();
  const host = new GameHost({ gameId, settings, inviteUrl: `${FRONT_URL}?game=${gameId}`, sendTo });
  games.set(gameId, host);
  return host;
}

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
      if (msg.type === C2S.JOIN) {
        host = games.get(String(msg.gameId ?? '').toUpperCase()) ?? null;
        if (!host) return sendTo(clientId, { type: S2C.ERROR, code: ERROR_CODES.GAME_NOT_FOUND, message: 'Partie introuvable' });
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

// Nettoyage des parties abandonnées (aucun humain connecté) toutes les 10 minutes
setInterval(() => {
  for (const [id, host] of games) {
    if (host.isAbandoned() && host.state.status !== 'lobby') {
      host.close();
      games.delete(id);
    }
  }
}, 10 * 60 * 1000);

console.log(`Serveur Risk en écoute sur ws://localhost:${PORT} (front : ${FRONT_URL})`);
