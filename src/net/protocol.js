/**
 * Contrat d'interface client ⇄ hôte (serveur WebSocket demain, hôte local
 * aujourd'hui). Tous les messages sont des objets JSON `{ type, ... }`.
 * La documentation complète est dans docs/PROTOCOL.md.
 *
 * Ce module est partagé par le client ET l'hôte : il doit rester pur
 * (pas de DOM, pas de Node).
 */
import { secureRandomBytes } from '../core/random.js';
import { MAP_CATALOG, DEFAULT_MAP_ID } from '../core/map.js';

/** Messages envoyés par le client. */
export const C2S = Object.freeze({
  CREATE: 'create', // { playerName, settings:{maxPlayers,botDelayMs} }
  JOIN: 'join', // { gameId, playerName, token? }  (token = reconnexion)
  SPECTATE: 'spectate', // { gameId, name }  entrer en spectateur (partie pleine, commencée, ou simple curieux)
  LOBBY: 'lobby', // { op:'start'|'addBot'|'addLocal'|'kick'|'settings', ... } (hôte de partie uniquement)
  ACTION: 'action', // { action:{type,...}, seq }  seq = numéro client pour corréler les erreurs
  CHAT: 'chat', // { text }
  COMMAND: 'command', // { name, args:[] }  commande "/nom args" tapée dans le chat (dépannage, gestion)
  PING: 'ping', // { }   battement de cœur
  LEAVE: 'leave', // { }
});

/** Messages envoyés par l'hôte / le serveur. */
export const S2C = Object.freeze({
  WELCOME: 'welcome', // { playerId, token, gameId, inviteUrl, isOwner, spectator? }
  STATE: 'state', // { state } vue redactée pour ce joueur (voir redactStateFor)
  EVENTS: 'events', // { events:[...], version }
  CHAT: 'chat', // { message:{ id, ts, kind, from, fromName, text, mentions:[], to:[] } }
  CHAT_HISTORY: 'chat_history', // { messages:[...] } à la connexion
  PLAYER: 'player', // { op:'joined'|'left'|'disconnected'|'reconnected'|'bot_takeover'|'spectator_joined'|'spectator_left', playerId }
  ERROR: 'error', // { code, message, seq? }
  PONG: 'pong',
});

export const ERROR_CODES = Object.freeze({
  GAME_NOT_FOUND: 'GAME_NOT_FOUND',
  GAME_FULL: 'GAME_FULL',
  NAME_TAKEN: 'NAME_TAKEN',
  INVALID_NAME: 'INVALID_NAME',
  NOT_OWNER: 'NOT_OWNER',
  ILLEGAL_ACTION: 'ILLEGAL_ACTION',
  BAD_MESSAGE: 'BAD_MESSAGE',
  SPECTATOR_ONLY: 'SPECTATOR_ONLY', // action de joueur tentée depuis le mode spectateur
  SEAT_TAKEN: 'SEAT_TAKEN', // votre place a été reprise depuis un autre appareil (jeton d'origine)
  RATE_LIMITED: 'RATE_LIMITED', // trop de messages en peu de temps (serveur)
  SERVER_FULL: 'SERVER_FULL', // nombre maximal de parties atteint (serveur)
});

/** Pseudo : 2 à 16 caractères alphanumériques / tiret bas (pas d'espace → mentions non ambiguës). */
export const NAME_REGEX = /^[A-Za-z0-9_\-]{2,16}$/;
export function isValidName(name) {
  return typeof name === 'string' && NAME_REGEX.test(name);
}

/**
 * Analyse un message de chat.
 *  - `@pseudo`  → mention (le message reste public, le joueur est mis en évidence)
 *  - `#pseudo`  → message privé : visible uniquement par l'expéditeur et les destinataires
 * Le pseudo est insensible à la casse. Les pseudos inconnus sont ignorés.
 *
 * @param {string} text
 * @param {{id:string,name:string}[]} players  joueurs ET spectateurs (tous mentionnables)
 * @returns {{ mentions:string[], privateTo:string[] }}  identifiants
 */
export function parseChat(text, players) {
  const byName = new Map(players.map((p) => [p.name.toLowerCase(), p.id]));
  const mentions = new Set();
  const privateTo = new Set();
  const re = /(^|[^A-Za-z0-9_])([@#])([A-Za-z0-9_\-]{2,16})/g;
  let m;
  while ((m = re.exec(text))) {
    const id = byName.get(m[3].toLowerCase());
    if (!id) continue;
    if (m[2] === '@') mentions.add(id);
    else privateTo.add(id);
  }
  return { mentions: [...mentions], privateTo: [...privateTo] };
}

/** Un message privé est visible par l'expéditeur et ses destinataires seulement. */
export function canSeeChat(message, playerId) {
  if (message.kind !== 'private') return true;
  return message.from === playerId || message.to.includes(playerId);
}

// ═══════════════════════════ Aléa : codes, identifiants, jetons ═══════════════════════════
// Tout vient du générateur cryptographique (random.js), jamais de Math.random :
// ses sorties se devinent à partir de quelques valeurs observées, or les
// identifiants de joueurs et de messages sont visibles de tous. Avec l'ancien
// code, observer ces identifiants permettait en principe de prédire le jeton de
// reconnexion d'un autre joueur, donc de lui voler sa place.

/** Alphabet des codes de partie : 32 symboles sans ambiguïté (ni O/0 ni I/1), 5 bits chacun. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Code de partie lisible, 6 caractères (30 bits), tirage uniforme. */
export function generateGameCode() {
  // 32 divise 256 : `octet & 31` est parfaitement uniforme, sans biais de modulo.
  return Array.from(secureRandomBytes(6), (b) => CODE_ALPHABET[b & 31]).join('');
}

/** Taille d'un jeton de reconnexion : 16 octets = 128 bits, hors de portée d'une recherche exhaustive. */
export const TOKEN_BYTES = 16;

/**
 * Identifiant aléatoire en hexadécimal, préfixé.
 * `bytes` = 8 (64 bits) pour un identifiant public, TOKEN_BYTES pour un secret.
 */
export function randomId(prefix = 'id', bytes = 8) {
  const hex = Array.from(secureRandomBytes(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}`;
}

/** Jeton secret de reconnexion à une place. */
export function newToken() {
  return randomId('tok', TOKEN_BYTES);
}

// ═══════════════════════════ Réglages de création ═══════════════════════════

export const PLAYER_RANGE = Object.freeze({ min: 5, max: 7, default: 6 });
export const BOT_DELAY_RANGE = Object.freeze({ min: 0, max: 5000, default: 700 });

/**
 * Filtre les réglages envoyés par un client à la création d'une partie.
 * Seuls trois champs sont retenus, validés et bornés. Tout le reste est écarté,
 * en particulier `seed` (qui aurait permis de choisir, donc de connaître à
 * l'avance, tous les dés de la partie) et `id` (qui écrasait le code de partie).
 */
export function sanitizeCreateSettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const maxPlayers =
    Number.isInteger(src.maxPlayers) && src.maxPlayers >= PLAYER_RANGE.min && src.maxPlayers <= PLAYER_RANGE.max
      ? src.maxPlayers
      : PLAYER_RANGE.default;
  const botDelayMs =
    typeof src.botDelayMs === 'number' && Number.isFinite(src.botDelayMs)
      ? Math.round(Math.min(BOT_DELAY_RANGE.max, Math.max(BOT_DELAY_RANGE.min, src.botDelayMs)))
      : BOT_DELAY_RANGE.default;
  const mapId = typeof src.mapId === 'string' && MAP_CATALOG.some((m) => m.id === src.mapId) ? src.mapId : DEFAULT_MAP_ID;
  return { maxPlayers, botDelayMs, mapId };
}
