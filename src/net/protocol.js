/**
 * Contrat d'interface client ⇄ hôte (serveur WebSocket demain, hôte local
 * aujourd'hui). Tous les messages sont des objets JSON `{ type, ... }`.
 * La documentation complète est dans docs/PROTOCOL.md.
 *
 * Ce module est partagé par le client ET l'hôte : il doit rester pur
 * (pas de DOM, pas de Node).
 */

/** Messages envoyés par le client. */
export const C2S = Object.freeze({
  CREATE: 'create', // { playerName, settings:{maxPlayers,botDelayMs} }
  JOIN: 'join', // { gameId, playerName, token? }  (token = reconnexion)
  LOBBY: 'lobby', // { op:'start'|'addBot'|'addLocal'|'kick'|'settings', ... } (hôte de partie uniquement)
  ACTION: 'action', // { action:{type,...}, seq }  seq = numéro client pour corréler les erreurs
  CHAT: 'chat', // { text }
  COMMAND: 'command', // { name, args:[] }  commande "/nom args" tapée dans le chat (dépannage, gestion)
  PING: 'ping', // { }   battement de cœur
  LEAVE: 'leave', // { }
});

/** Messages envoyés par l'hôte / le serveur. */
export const S2C = Object.freeze({
  WELCOME: 'welcome', // { playerId, token, gameId, inviteUrl, isOwner }
  STATE: 'state', // { state } vue redactée pour ce joueur (voir redactStateFor)
  EVENTS: 'events', // { events:[...], version }
  CHAT: 'chat', // { message:{ id, ts, kind, from, fromName, text, mentions:[], to:[] } }
  CHAT_HISTORY: 'chat_history', // { messages:[...] } à la connexion
  PLAYER: 'player', // { op:'joined'|'left'|'disconnected'|'reconnected'|'bot_takeover', playerId }
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
 * @param {{id:string,name:string}[]} players
 * @returns {{ mentions:string[], privateTo:string[] }}  identifiants de joueurs
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

/** Génère un code de partie lisible (6 caractères sans ambiguïté O/0, I/1). */
export function generateGameCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

export function randomId(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
