/**
 * GameHost : l'autorité d'une partie. Reçoit les messages des clients, valide
 * et applique les actions via rules.js, fait jouer les bots, route le chat
 * (public / mentions / privé), gère déconnexions et reprises.
 *
 * Indépendant du transport : on lui injecte `sendTo(clientId, message)`.
 *  - Aujourd'hui il tourne dans l'onglet du créateur (LocalHostRuntime),
 *  - demain sur le serveur Node (server/index.js) SANS modification :
 *    il n'utilise ni DOM, ni WebSocket, ni API Node — seulement des timers.
 *
 * Un "client" = une connexion (onglet, socket). Un client contrôle au plus un
 * joueur. Les bots n'ont pas de client.
 */
import { createLobbyState, getPlayer, redactStateFor, alivePlayers } from '../core/state.js';
import { applyAction, validateAction } from '../core/rules.js';
import { decideBotAction } from '../core/bot.js';
import { C2S, S2C, ERROR_CODES, isValidName, parseChat, canSeeChat, randomId } from './protocol.js';

const BOT_NAMES = ['Napoléon', 'Sun_Tzu', 'Hannibal', 'Jeanne', 'Gengis', 'Cléopâtre', 'Alexandre', 'Boudica'];

/** Délai avant qu'un bot ne remplace un humain déconnecté (ms). */
const TAKEOVER_DELAY_MS = 15000;
/** Sans battement de cœur pendant ce délai, le client est considéré déconnecté. */
const HEARTBEAT_TIMEOUT_MS = 75000; // large : les onglets en arrière-plan ralentissent les timers

export class GameHost {
  /**
   * @param {object} opts
   * @param {string} opts.gameId
   * @param {object} [opts.settings]  { maxPlayers, botDelayMs, seed }
   * @param {string} [opts.inviteUrl]
   * @param {(clientId:string, message:object)=>void} opts.sendTo
   * @param {object} [opts.timers] { setTimeout, clearTimeout } (injectables pour les tests)
   */
  constructor({ gameId, settings = {}, inviteUrl = '', sendTo, timers }) {
    this.gameId = gameId;
    this.inviteUrl = inviteUrl;
    this.sendTo = sendTo;
    this.timers = timers ?? { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
    this.state = createLobbyState({ id: gameId, ...settings });
    this.ownerId = null; // joueur créateur (droits de lobby)
    /** @type {Map<string,{playerId:string|null,lastSeen:number}>} */
    this.clients = new Map();
    /** @type {Map<string,{token:string,clientId:string|null,takeoverTimer:any}>} */
    this.seats = new Map(); // par playerId (humains)
    this.chat = []; // historique complet (l'hôte filtre à l'envoi)
    this.botTimer = null;
    this.closed = false;
    this.onChange = null; // hook optionnel (debug / persistance)
    this.heartbeatTimer = this.timers.setTimeout(() => this.checkHeartbeats(), HEARTBEAT_TIMEOUT_MS / 2);
  }

  // ═════════════════════════ Entrées ═════════════════════════

  /** Un client (connexion) arrive. */
  addClient(clientId) {
    this.clients.set(clientId, { playerId: null, lastSeen: Date.now() });
  }

  /** Message reçu d'un client. */
  handleMessage(clientId, msg) {
    if (this.closed) return;
    const client = this.clients.get(clientId);
    if (!client) this.addClient(clientId);
    const c = this.clients.get(clientId);
    c.lastSeen = Date.now();
    if (!msg || typeof msg.type !== 'string') return this.error(clientId, ERROR_CODES.BAD_MESSAGE, 'Message invalide');

    try {
      switch (msg.type) {
        case C2S.JOIN:
          return this.onJoin(clientId, msg);
        case C2S.LOBBY:
          return this.onLobby(clientId, msg);
        case C2S.ACTION:
          return this.onAction(clientId, msg);
        case C2S.CHAT:
          return this.onChat(clientId, msg);
        case C2S.PING:
          return this.sendTo(clientId, { type: S2C.PONG });
        case C2S.LEAVE:
          return this.handleDisconnect(clientId);
        default:
          return this.error(clientId, ERROR_CODES.BAD_MESSAGE, `Type inconnu : ${msg.type}`);
      }
    } catch (e) {
      this.error(clientId, ERROR_CODES.ILLEGAL_ACTION, e.message, msg.seq);
    }
  }

  /** Connexion perdue (fermeture d'onglet, socket coupée, heartbeat expiré). */
  handleDisconnect(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.clients.delete(clientId);
    const playerId = client.playerId;
    if (!playerId) return;
    const seat = this.seats.get(playerId);
    if (seat) seat.clientId = null;

    if (this.state.status === 'lobby') {
      // Dans le lobby, on libère simplement la place
      this.apply({ type: 'REMOVE_PLAYER', playerId });
      this.seats.delete(playerId);
      if (this.ownerId === playerId) this.ownerId = this.state.players.find((p) => p.type === 'human')?.id ?? null;
      this.broadcast({ type: S2C.PLAYER, op: 'left', playerId });
      this.broadcastState();
      return;
    }
    // En partie : marqué déconnecté, un bot prendra le relais après un délai
    this.apply({ type: 'SET_CONNECTED', playerId, connected: false });
    this.broadcast({ type: S2C.PLAYER, op: 'disconnected', playerId });
    this.systemChat(`${getPlayer(this.state, playerId).name} s’est déconnecté·e.`);
    this.broadcastState();
    if (seat) {
      this.timers.clearTimeout(seat.takeoverTimer);
      seat.takeoverTimer = this.timers.setTimeout(() => this.botTakeover(playerId), TAKEOVER_DELAY_MS);
    }
  }

  // ═════════════════════════ Lobby ═════════════════════════

  onJoin(clientId, msg) {
    const client = this.clients.get(clientId);
    // Reconnexion par jeton
    if (msg.token) {
      for (const [playerId, seat] of this.seats) {
        if (seat.token === msg.token && getPlayer(this.state, playerId)) {
          return this.reconnect(clientId, playerId, seat);
        }
      }
    }
    if (client.playerId) return this.error(clientId, ERROR_CODES.BAD_MESSAGE, 'Déjà dans la partie');
    if (!isValidName(msg.playerName)) return this.error(clientId, ERROR_CODES.INVALID_NAME, 'Pseudo invalide (2-16 caractères, lettres/chiffres/_/-)');
    if (this.state.status !== 'lobby') return this.error(clientId, ERROR_CODES.GAME_FULL, 'La partie a déjà commencé');
    const playerId = randomId('p');
    const err = validateAction(this.state, { type: 'ADD_PLAYER', player: { id: playerId, name: msg.playerName, type: 'human' } });
    if (err) return this.error(clientId, err === 'Partie complète' ? ERROR_CODES.GAME_FULL : ERROR_CODES.NAME_TAKEN, err);

    this.apply({ type: 'ADD_PLAYER', player: { id: playerId, name: msg.playerName, type: 'human' } });
    this.apply({ type: 'SET_CONNECTED', playerId, connected: true });
    if (!this.ownerId) this.ownerId = playerId;
    const token = randomId('tok');
    this.seats.set(playerId, { token, clientId, takeoverTimer: null });
    client.playerId = playerId;

    this.sendTo(clientId, { type: S2C.WELCOME, playerId, token, gameId: this.gameId, inviteUrl: this.inviteUrl, isOwner: this.ownerId === playerId });
    this.sendChatHistory(clientId, playerId);
    this.broadcast({ type: S2C.PLAYER, op: 'joined', playerId });
    this.systemChat(`${msg.playerName} a rejoint la partie.`);
    this.broadcastState();
  }

  reconnect(clientId, playerId, seat) {
    // Si un autre client tient encore la place (ex. ancien onglet), on le remplace
    if (seat.clientId && seat.clientId !== clientId && this.clients.has(seat.clientId)) {
      this.clients.get(seat.clientId).playerId = null;
    }
    seat.clientId = clientId;
    this.timers.clearTimeout(seat.takeoverTimer);
    this.clients.get(clientId).playerId = playerId;
    this.apply({ type: 'SET_CONNECTED', playerId, connected: true, controlledByBot: false });
    this.sendTo(clientId, { type: S2C.WELCOME, playerId, token: seat.token, gameId: this.gameId, inviteUrl: this.inviteUrl, isOwner: this.ownerId === playerId });
    this.sendChatHistory(clientId, playerId);
    this.broadcast({ type: S2C.PLAYER, op: 'reconnected', playerId });
    this.systemChat(`${getPlayer(this.state, playerId).name} est de retour.`);
    this.broadcastState();
    this.scheduleBot();
  }

  onLobby(clientId, msg) {
    const playerId = this.clients.get(clientId).playerId;
    if (!playerId || playerId !== this.ownerId) return this.error(clientId, ERROR_CODES.NOT_OWNER, 'Réservé au créateur de la partie');
    switch (msg.op) {
      case 'addBot':
        this.addBot();
        break;
      case 'kick': {
        const target = getPlayer(this.state, msg.playerId);
        if (!target || target.id === this.ownerId) return;
        const seat = this.seats.get(target.id);
        if (seat?.clientId) {
          const cid = seat.clientId;
          this.clients.get(cid).playerId = null;
          this.error(cid, ERROR_CODES.GAME_FULL, 'Vous avez été retiré de la partie');
        }
        this.seats.delete(target.id);
        this.apply({ type: 'REMOVE_PLAYER', playerId: target.id });
        this.broadcast({ type: S2C.PLAYER, op: 'left', playerId: target.id });
        break;
      }
      case 'settings':
        if (msg.maxPlayers >= 5 && msg.maxPlayers <= 7 && msg.maxPlayers >= this.state.players.length)
          this.state.settings.maxPlayers = msg.maxPlayers;
        if (Number.isFinite(msg.botDelayMs)) this.state.settings.botDelayMs = Math.max(0, Math.min(5000, msg.botDelayMs));
        this.state.version += 1;
        break;
      case 'start': {
        // Les places vides sont comblées par des bots
        while (this.state.players.length < this.state.settings.maxPlayers) this.addBot();
        this.apply({ type: 'START_GAME' });
        this.systemChat('La partie commence ! Placement initial des troupes.');
        break;
      }
      default:
        return this.error(clientId, ERROR_CODES.BAD_MESSAGE, `Opération lobby inconnue : ${msg.op}`);
    }
    this.broadcastState();
    this.scheduleBot();
  }

  addBot() {
    const used = new Set(this.state.players.map((p) => p.name.toLowerCase()));
    const name = BOT_NAMES.find((n) => !used.has(n.toLowerCase())) ?? `Bot_${this.state.players.length + 1}`;
    this.apply({ type: 'ADD_PLAYER', player: { id: randomId('b'), name, type: 'bot' } });
  }

  // ═════════════════════════ Jeu ═════════════════════════

  onAction(clientId, msg) {
    const playerId = this.clients.get(clientId).playerId;
    if (!playerId) return this.error(clientId, ERROR_CODES.BAD_MESSAGE, 'Rejoignez la partie d’abord', msg.seq);
    const action = { ...msg.action, playerId }; // l'identité vient de la connexion, jamais du message
    const err = validateAction(this.state, action);
    if (err) return this.error(clientId, ERROR_CODES.ILLEGAL_ACTION, err, msg.seq);
    const events = this.apply(action);
    this.broadcastEvents(events);
    this.broadcastState();
    this.scheduleBot();
  }

  /** Applique une action et met à jour l'état ; renvoie les événements. */
  apply(action) {
    const { state, events } = applyAction(this.state, action);
    this.state = state;
    this.onChange?.(state, events);
    return events;
  }

  /** Programme le prochain coup si le joueur actif est un bot (ou un humain remplacé). */
  scheduleBot() {
    if (this.closed || this.botTimer) return;
    const s = this.state;
    if (s.status !== 'setup' && s.status !== 'playing') return;
    const active = getPlayer(s, s.turn.playerId);
    if (!active?.controlledByBot) return;
    this.botTimer = this.timers.setTimeout(() => {
      this.botTimer = null;
      this.botStep();
    }, s.settings.botDelayMs);
  }

  botStep() {
    const s = this.state;
    if (s.status !== 'setup' && s.status !== 'playing') return;
    const active = getPlayer(s, s.turn.playerId);
    if (!active?.controlledByBot) return;
    const action = decideBotAction(s, active.id);
    if (!action) return;
    try {
      const events = this.apply(action);
      this.broadcastEvents(events);
      this.broadcastState();
    } catch (e) {
      // Ne doit pas arriver (decideBotAction valide) ; on force la fin de phase pour ne pas bloquer.
      console.error('[GameHost] action bot illégale', action, e.message);
      try {
        this.apply({ type: 'END_PHASE', playerId: active.id });
        this.broadcastState();
      } catch {
        /* partie bloquée : laissée telle quelle */
      }
    }
    this.scheduleBot();
  }

  botTakeover(playerId) {
    const p = getPlayer(this.state, playerId);
    if (!p || p.connected || p.controlledByBot) return;
    this.apply({ type: 'SET_CONNECTED', playerId, controlledByBot: true });
    this.broadcast({ type: S2C.PLAYER, op: 'bot_takeover', playerId });
    this.systemChat(`Un bot prend le contrôle de ${p.name}.`);
    this.broadcastState();
    this.scheduleBot();
  }

  // ═════════════════════════ Chat ═════════════════════════

  onChat(clientId, msg) {
    const playerId = this.clients.get(clientId).playerId;
    if (!playerId) return this.error(clientId, ERROR_CODES.BAD_MESSAGE, 'Rejoignez la partie d’abord');
    const text = String(msg.text ?? '').trim().slice(0, 500);
    if (!text) return;
    const { mentions, privateTo } = parseChat(text, this.state.players);
    const recipients = privateTo.filter((id) => id !== playerId);
    const message = {
      id: randomId('m'),
      ts: Date.now(),
      kind: recipients.length ? 'private' : 'public',
      from: playerId,
      fromName: getPlayer(this.state, playerId).name,
      text,
      mentions,
      to: recipients,
    };
    this.pushChat(message);
  }

  systemChat(text) {
    this.pushChat({ id: randomId('m'), ts: Date.now(), kind: 'system', from: null, fromName: 'Système', text, mentions: [], to: [] });
  }

  pushChat(message) {
    this.chat.push(message);
    for (const [clientId, c] of this.clients) {
      if (c.playerId && canSeeChat(message, c.playerId)) this.sendTo(clientId, { type: S2C.CHAT, message });
    }
  }

  sendChatHistory(clientId, playerId) {
    const messages = this.chat.filter((m) => canSeeChat(m, playerId));
    this.sendTo(clientId, { type: S2C.CHAT_HISTORY, messages });
  }

  // ═════════════════════════ Sorties ═════════════════════════

  broadcast(message) {
    for (const [clientId, c] of this.clients) if (c.playerId) this.sendTo(clientId, message);
  }

  broadcastState() {
    for (const [clientId, c] of this.clients) {
      if (!c.playerId) continue;
      this.sendTo(clientId, { type: S2C.STATE, state: redactStateFor(this.state, c.playerId) });
    }
  }

  broadcastEvents(events) {
    if (!events.length) return;
    this.broadcast({ type: S2C.EVENTS, events, version: this.state.version });
  }

  error(clientId, code, message, seq) {
    this.sendTo(clientId, { type: S2C.ERROR, code, message, seq });
  }

  checkHeartbeats() {
    if (this.closed) return;
    const now = Date.now();
    for (const [clientId, c] of [...this.clients]) {
      if (now - c.lastSeen > HEARTBEAT_TIMEOUT_MS) this.handleDisconnect(clientId);
    }
    this.heartbeatTimer = this.timers.setTimeout(() => this.checkHeartbeats(), HEARTBEAT_TIMEOUT_MS / 2);
  }

  /** Arrêt propre (timers). */
  close() {
    this.closed = true;
    this.timers.clearTimeout(this.botTimer);
    this.timers.clearTimeout(this.heartbeatTimer);
    for (const seat of this.seats.values()) this.timers.clearTimeout(seat.takeoverTimer);
  }

  /** Vrai s'il ne reste plus aucun humain vivant (utile au serveur pour nettoyer). */
  isAbandoned() {
    return !alivePlayers(this.state).some((p) => p.type === 'human' && p.connected);
  }
}
