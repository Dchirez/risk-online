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
import { createRng, isValidRng } from '../core/dice.js';
import { applyAction, validateAction, PLAYER_ACTION_TYPES } from '../core/rules.js';
import { decideBotAction } from '../core/bot.js';
import { C2S, S2C, ERROR_CODES, isValidName, parseChat, canSeeChat, randomId, newToken, sanitizeCreateSettings } from './protocol.js';

const BOT_NAMES = ['Napoléon', 'Sun_Tzu', 'Hannibal', 'Jeanne', 'Gengis', 'Cléopâtre', 'Alexandre', 'Boudica'];

/** Délai avant qu'un bot ne remplace un humain déconnecté (ms). */
const TAKEOVER_DELAY_MS = 15000;
/** Jetons de reprise « par pseudo » conservés par place (les plus récents). */
const MAX_CLAIMS = 3;
/** Format d'un code de partie (valide aussi les sauvegardes relues sur disque). */
const GAME_ID_REGEX = /^[A-Z0-9]{6}$/;
/** Nombre maximal de messages de chat conservés (mémoire et sauvegarde). */
const MAX_CHAT = 400;
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
    // Réglages de jeu bornés (joueurs, vitesse des bots, carte). `seed` reste
    // accepté ici pour les tests : c'est au SERVEUR de ne jamais le transmettre
    // depuis un client (sanitizeCreateSettings). L'identifiant est imposé en
    // dernier : un réglage `id` ne peut plus écraser le code de partie.
    this.state = createLobbyState({ ...settings, ...sanitizeCreateSettings(settings), id: gameId });
    this.ownerId = null; // joueur créateur (droits de lobby)
    /** @type {Map<string,{playerId:string|null,lastSeen:number}>} */
    this.clients = new Map();
    /**
     * Places des humains. `token` = jeton d'origine, remis à l'inscription ; il
     * prime toujours. `claims` = jetons remis lors d'une reprise « par pseudo »
     * (autre appareil, navigateur vidé) ; ils sont révoqués dès que le jeton
     * d'origine revient, pour qu'un inconnu qui a tapé le bon pseudo pendant une
     * coupure ne garde jamais la place face à son vrai titulaire.
     * @type {Map<string,{token:string,claims:string[],clientId:string|null,takeoverTimer:any}>}
     */
    this.seats = new Map(); // par playerId (humains)
    this.chat = []; // historique complet (l'hôte filtre à l'envoi)
    this.botTimer = null;
    this.closed = false;
    this.tempBots = new Set(); // joueurs dont le tour en cours est fini par un bot (/passer), rendus ensuite
    this.lastActivity = Date.now(); // dernière présence d'un humain (sert à l'expiration côté serveur)
    this.onChange = null; // hook optionnel (state, events) après chaque action
    this.onDirty = null; // hook optionnel : quelque chose à sauvegarder (état, chat, réglages)
    this.heartbeatTimer = this.timers.setTimeout(() => this.checkHeartbeats(), HEARTBEAT_TIMEOUT_MS / 2);
  }

  // ═════════════════════════ Entrées ═════════════════════════

  /** Un client (connexion) arrive. */
  addClient(clientId) {
    this.clients.set(clientId, { playerId: null, spectator: null, lastSeen: Date.now() });
  }

  /**
   * Identifiant du « regardeur » derrière une connexion : joueur ou spectateur.
   * C'est lui qui sert à filtrer le chat et à redacter l'état.
   */
  viewerId(c) {
    return c.playerId ?? c.spectator?.id ?? null;
  }

  /** Message reçu d'un client. */
  handleMessage(clientId, msg) {
    if (this.closed) return;
    const client = this.clients.get(clientId);
    if (!client) this.addClient(clientId);
    const c = this.clients.get(clientId);
    c.lastSeen = Date.now();
    // Un humain est présent (joueur ou spectateur) : la partie n'est pas à l'abandon
    if (this.viewerId(c)) this.lastActivity = c.lastSeen;
    if (!msg || typeof msg.type !== 'string') return this.error(clientId, ERROR_CODES.BAD_MESSAGE, 'Message invalide');

    try {
      switch (msg.type) {
        case C2S.JOIN:
          return this.onJoin(clientId, msg);
        case C2S.SPECTATE:
          return this.onSpectate(clientId, msg);
        case C2S.LOBBY:
          return this.onLobby(clientId, msg);
        case C2S.ACTION:
          return this.onAction(clientId, msg);
        case C2S.CHAT:
          return this.onChat(clientId, msg);
        case C2S.COMMAND:
          return this.onCommand(clientId, msg);
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
    if (client.spectator) {
      this.systemChat(`${client.spectator.name} ne regarde plus la partie.`);
      this.broadcast({ type: S2C.PLAYER, op: 'spectator_left', playerId: client.spectator.id });
      this.broadcastState();
      return;
    }
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
    if (seat) {
      this.timers.clearTimeout(seat.takeoverTimer);
      seat.takeoverTimer = this.timers.setTimeout(() => this.botTakeover(playerId), TAKEOVER_DELAY_MS);
    }
    if (!this.hasConnectedHuman()) this.pause();
    this.broadcastState();
  }

  // ═════════════════════════ Pause (aucun humain connecté) ═════════════════════════

  /** Au moins un joueur humain a une connexion active. */
  hasConnectedHuman() {
    for (const c of this.clients.values()) {
      if (c.playerId && getPlayer(this.state, c.playerId)?.type === 'human') return true;
    }
    return false;
  }

  /** Vrai quand la partie est figée : personne n'est là, les bots ne jouent pas. */
  get paused() {
    return (this.state.status === 'setup' || this.state.status === 'playing') && !this.hasConnectedHuman();
  }

  pause() {
    this.timers.clearTimeout(this.botTimer);
    this.botTimer = null;
    if (this.state.status === 'setup' || this.state.status === 'playing') {
      this.systemChat('Partie en pause : plus aucun joueur connecté. Les bots ne jouent pas en votre absence.');
    }
  }

  /** Arme le remplacement par un bot pour chaque humain absent (après une reprise ou un rechargement). */
  armTakeovers() {
    for (const [playerId, seat] of this.seats) {
      const p = getPlayer(this.state, playerId);
      if (!p || p.connected || p.controlledByBot || seat.takeoverTimer) continue;
      seat.takeoverTimer = this.timers.setTimeout(() => this.botTakeover(playerId), TAKEOVER_DELAY_MS);
    }
  }

  // ═════════════════════════ Lobby ═════════════════════════

  onJoin(clientId, msg) {
    const client = this.clients.get(clientId);
    // Reconnexion par jeton : comparaison exacte, jeton d'origine ou jeton de reprise encore valide
    if (typeof msg.token === 'string' && msg.token) {
      for (const [playerId, seat] of this.seats) {
        if (!getPlayer(this.state, playerId)) continue;
        if (seat.token === msg.token) return this.reconnect(clientId, playerId, seat, { token: seat.token, original: true });
        if (seat.claims.includes(msg.token)) return this.reconnect(clientId, playerId, seat, { token: msg.token, original: false });
      }
    }
    if (client.playerId) return this.error(clientId, ERROR_CODES.BAD_MESSAGE, 'Déjà dans la partie');
    if (!isValidName(msg.playerName)) return this.error(clientId, ERROR_CODES.INVALID_NAME, 'Pseudo invalide (2-16 caractères, lettres/chiffres/_/-)');
    if (this.state.status !== 'lobby') {
      // Partie en cours : on peut reprendre la place d'un humain déconnecté (même remplacé
      // par un bot) en se présentant avec son pseudo, sans jeton (onglet fermé, autre appareil…).
      const wanted = String(msg.playerName).toLowerCase();
      const seatPlayer = this.state.players.find((p) => p.type === 'human' && p.name.toLowerCase() === wanted);
      const seat = seatPlayer && this.seats.get(seatPlayer.id);
      if (seat && (!seat.clientId || !this.clients.has(seat.clientId))) {
        // Jeton de reprise distinct : le jeton d'origine reste valide et prioritaire,
        // et n'est jamais révélé à celui qui reprend la place par son pseudo.
        const claim = newToken();
        seat.claims = [...seat.claims, claim].slice(-MAX_CLAIMS);
        return this.reconnect(clientId, seatPlayer.id, seat, { token: claim, original: false });
      }
      if (seatPlayer) return this.error(clientId, ERROR_CODES.NAME_TAKEN, `${seatPlayer.name} est déjà connecté·e à cette partie`);
      return this.error(clientId, ERROR_CODES.GAME_FULL, 'La partie a déjà commencé. Entrez le pseudo que vous aviez pour reprendre votre place, ou regardez en spectateur.');
    }
    // Un pseudo déjà porté par un spectateur est refusé : sinon les messages
    // #privés destinés à l'un pouvaient arriver à l'autre.
    if (this.spectatorList().some((sp) => sp.name.toLowerCase() === msg.playerName.toLowerCase())) {
      return this.error(clientId, ERROR_CODES.NAME_TAKEN, 'Ce pseudo est déjà utilisé dans cette partie');
    }
    const playerId = randomId('p');
    const err = validateAction(this.state, { type: 'ADD_PLAYER', player: { id: playerId, name: msg.playerName, type: 'human' } });
    if (err) return this.error(clientId, err === 'Partie complète' ? ERROR_CODES.GAME_FULL : ERROR_CODES.NAME_TAKEN, err);

    this.apply({ type: 'ADD_PLAYER', player: { id: playerId, name: msg.playerName, type: 'human' } });
    this.apply({ type: 'SET_CONNECTED', playerId, connected: true });
    if (!this.ownerId) this.ownerId = playerId;
    const token = newToken();
    this.seats.set(playerId, { token, claims: [], clientId, takeoverTimer: null });
    client.playerId = playerId;

    this.sendTo(clientId, { type: S2C.WELCOME, playerId, token, gameId: this.gameId, inviteUrl: this.inviteUrl, isOwner: this.ownerId === playerId });
    this.sendChatHistory(clientId, playerId);
    this.broadcast({ type: S2C.PLAYER, op: 'joined', playerId });
    this.systemChat(`${msg.playerName} a rejoint la partie.`);
    this.broadcastState();
  }

  /**
   * Rattache une connexion à une place.
   * @param {{token:string, original:boolean}} auth  jeton présenté (renvoyé tel quel, jamais un autre)
   */
  reconnect(clientId, playerId, seat, auth) {
    // Le jeton d'origine révoque toutes les reprises « par pseudo » ; un jeton de
    // reprise révoque les autres reprises (le dernier arrivé légitime l'emporte).
    seat.claims = auth.original ? [] : seat.claims.filter((c) => c === auth.token);
    // Si un autre client tient encore la place (ancien onglet, ou intrus), on le déloge et on le prévient
    if (seat.clientId && seat.clientId !== clientId && this.clients.has(seat.clientId)) {
      this.clients.get(seat.clientId).playerId = null;
      this.error(seat.clientId, ERROR_CODES.SEAT_TAKEN, 'Votre place a été reprise depuis un autre appareil.');
    }
    const wasPaused = this.paused;
    seat.clientId = clientId;
    this.timers.clearTimeout(seat.takeoverTimer);
    seat.takeoverTimer = null;
    this.clients.get(clientId).playerId = playerId;
    this.lastActivity = Date.now();
    this.apply({ type: 'SET_CONNECTED', playerId, connected: true, controlledByBot: false });
    if (wasPaused) {
      this.systemChat('Reprise de la partie.');
      this.armTakeovers(); // les autres absents seront remplacés par des bots dans 15 s
    }
    this.sendTo(clientId, { type: S2C.WELCOME, playerId, token: auth.token, gameId: this.gameId, inviteUrl: this.inviteUrl, isOwner: this.ownerId === playerId });
    this.sendChatHistory(clientId, playerId);
    this.broadcast({ type: S2C.PLAYER, op: 'reconnected', playerId });
    this.systemChat(`${getPlayer(this.state, playerId).name} est de retour.`);
    this.broadcastState();
    this.scheduleBot();
  }

  // ═════════════════════════ Spectateurs ═════════════════════════

  /**
   * Entrée en spectateur : accessible à tout moment via le lien d'invitation,
   * y compris quand la partie est pleine ou déjà commencée. Un spectateur voit
   * la carte, le journal et le chat public, mais aucune main de joueur et ne
   * peut agir sur la partie.
   */
  onSpectate(clientId, msg) {
    const c = this.clients.get(clientId);
    if (this.viewerId(c)) return this.error(clientId, ERROR_CODES.BAD_MESSAGE, 'Vous êtes déjà dans la partie');
    const name = String(msg.name ?? '').trim();
    if (!isValidName(name)) return this.error(clientId, ERROR_CODES.INVALID_NAME, 'Pseudo invalide (2-16 caractères, lettres/chiffres/_/-)');
    const taken = [...this.chatParticipants()].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return this.error(clientId, ERROR_CODES.NAME_TAKEN, 'Ce pseudo est déjà utilisé dans cette partie');

    const id = randomId('s');
    c.spectator = { id, name };
    this.lastActivity = Date.now();
    this.sendTo(clientId, { type: S2C.WELCOME, playerId: id, spectator: true, gameId: this.gameId, inviteUrl: this.inviteUrl, isOwner: false });
    this.sendChatHistory(clientId, id);
    this.broadcast({ type: S2C.PLAYER, op: 'spectator_joined', playerId: id });
    this.systemChat(`${name} regarde la partie (spectateur).`);
    this.broadcastState();
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
        // Types stricts : un "6" en texte ou un 6.5 étaient acceptés et polluaient l'état
        if (Number.isInteger(msg.maxPlayers) && msg.maxPlayers >= 5 && msg.maxPlayers <= 7 && msg.maxPlayers >= this.state.players.length)
          this.state.settings.maxPlayers = msg.maxPlayers;
        if (typeof msg.botDelayMs === 'number' && Number.isFinite(msg.botDelayMs))
          this.state.settings.botDelayMs = Math.round(Math.max(0, Math.min(5000, msg.botDelayMs)));
        this.state.version += 1;
        this.onDirty?.();
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
    const c = this.clients.get(clientId);
    if (c.spectator) return this.error(clientId, ERROR_CODES.SPECTATOR_ONLY, 'Vous regardez la partie en spectateur : vous ne pouvez pas jouer.', msg.seq);
    const playerId = c.playerId;
    if (!playerId) return this.error(clientId, ERROR_CODES.BAD_MESSAGE, 'Rejoignez la partie d’abord', msg.seq);
    const raw = msg.action;
    // Uniquement des coups de jeu : jamais d'action d'hôte (ajout de joueur, démarrage…)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !PLAYER_ACTION_TYPES.includes(raw.type)) {
      return this.error(clientId, ERROR_CODES.ILLEGAL_ACTION, 'Action inconnue', msg.seq);
    }
    const action = { ...raw, playerId }; // l'identité vient de la connexion, jamais du message
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
    this.onDirty?.();
    // Fin d'un tour joué par un bot "temporaire" (/passer) : l'humain reprend la main
    if (this.tempBots.size && events.some((e) => e.type === 'TURN_STARTED')) {
      for (const id of [...this.tempBots]) {
        if (this.state.turn?.playerId === id) continue;
        this.tempBots.delete(id);
        const p = getPlayer(this.state, id);
        if (p?.connected) this.apply({ type: 'SET_CONNECTED', playerId: id, controlledByBot: false });
      }
    }
    return events;
  }

  /** Programme le prochain coup si le joueur actif est un bot (ou un humain remplacé). */
  scheduleBot() {
    if (this.closed || this.botTimer) return;
    const s = this.state;
    if (s.status !== 'setup' && s.status !== 'playing') return;
    if (!this.hasConnectedHuman()) return; // partie en pause : les bots ne jouent pas sans public
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
    const seat = this.seats.get(playerId);
    if (seat) seat.takeoverTimer = null;
    const p = getPlayer(this.state, playerId);
    if (!p || p.connected || p.controlledByBot) return;
    this.apply({ type: 'SET_CONNECTED', playerId, controlledByBot: true });
    this.broadcast({ type: S2C.PLAYER, op: 'bot_takeover', playerId });
    this.systemChat(`Un bot prend le contrôle de ${p.name}.`);
    this.broadcastState();
    this.scheduleBot();
  }

  // ═════════════════════════ Chat ═════════════════════════

  /** Joueurs et spectateurs réunis : tout le monde est mentionnable (@) et joignable en privé (#). */
  chatParticipants() {
    return [...this.state.players.map((p) => ({ id: p.id, name: p.name })), ...this.spectatorList()];
  }

  onChat(clientId, msg) {
    const c = this.clients.get(clientId);
    const from = this.viewerId(c);
    if (!from) return this.error(clientId, ERROR_CODES.BAD_MESSAGE, 'Rejoignez la partie d’abord');
    const text = String(msg.text ?? '').trim().slice(0, 500);
    if (!text) return;
    const { mentions, privateTo } = parseChat(text, this.chatParticipants());
    const recipients = privateTo.filter((id) => id !== from);
    const message = {
      id: randomId('m'),
      ts: Date.now(),
      kind: recipients.length ? 'private' : 'public',
      from,
      fromName: c.spectator ? c.spectator.name : getPlayer(this.state, from).name,
      spectator: !!c.spectator, // affiché avec une pastille « spectateur »
      text,
      mentions,
      to: recipients,
    };
    this.pushChat(message);
  }

  systemChat(text) {
    this.pushChat({ id: randomId('m'), ts: Date.now(), kind: 'system', from: null, fromName: 'Système', text, mentions: [], to: [] });
  }

  /** Message système visible par un seul joueur (réponse à une commande). */
  systemChatTo(playerId, text) {
    this.pushChat({ id: randomId('m'), ts: Date.now(), kind: 'private', from: null, fromName: 'Système', text, mentions: [], to: [playerId] });
  }

  // ═════════════════════════ Commandes (/nom args) ═════════════════════════

  /**
   * Commandes de dépannage tapées dans le chat. Certaines sont réservées au
   * créateur de la partie. Les commandes purement locales (/aide, /joueurs, /lien…)
   * sont traitées côté client et n'arrivent jamais ici.
   */
  onCommand(clientId, msg) {
    const c = this.clients.get(clientId);
    const playerId = c.playerId;
    if (!playerId && !c.spectator) return this.error(clientId, ERROR_CODES.BAD_MESSAGE, 'Rejoignez la partie d’abord');
    // Un spectateur ne peut pas agir sur la partie : seules /sync et /ping lui répondent.
    if (c.spectator) {
      const cmd = String(msg.name ?? '').toLowerCase();
      if (cmd === 'ping') return this.systemChatTo(c.spectator.id, 'pong');
      if (cmd === 'sync') {
        const view = redactStateFor(this.state, null);
        view.spectators = this.spectatorList();
        this.sendTo(clientId, { type: S2C.STATE, state: view });
        this.sendChatHistory(clientId, c.spectator.id);
        return this.systemChatTo(c.spectator.id, 'État et chat resynchronisés.');
      }
      return this.systemChatTo(c.spectator.id, `/${cmd} est réservée aux joueurs : vous regardez la partie en spectateur.`);
    }
    const me = getPlayer(this.state, playerId);
    const isOwner = playerId === this.ownerId;
    const name = String(msg.name ?? '').toLowerCase();
    const args = Array.isArray(msg.args) ? msg.args.map(String) : [];
    const reply = (text) => this.systemChatTo(playerId, text);
    const findPlayer = (n) => {
      const wanted = String(n ?? '').replace(/^[@#]/, '').toLowerCase();
      return wanted ? this.state.players.find((p) => p.name.toLowerCase() === wanted) : null;
    };
    const inGame = this.state.status === 'setup' || this.state.status === 'playing';

    switch (name) {
      case 'ping':
        return reply('pong');

      case 'bot': {
        // /bot [pseudo] : un bot joue à la place d'un humain (soi-même, ou n'importe qui pour le créateur)
        const target = args[0] ? findPlayer(args[0]) : me;
        if (!target) return reply(`Joueur inconnu : ${args[0]}`);
        if (target.id !== playerId && !isOwner) return reply('Réservé au créateur de la partie (sauf pour vous-même).');
        if (target.type === 'bot' || target.controlledByBot) return reply(`${target.name} est déjà joué·e par un bot.`);
        this.apply({ type: 'SET_CONNECTED', playerId: target.id, controlledByBot: true });
        this.systemChat(`Un bot joue désormais pour ${target.name} (commande de ${me.name}).`);
        this.broadcastState();
        this.scheduleBot();
        return;
      }

      case 'humain': {
        // /humain [pseudo] : rend le contrôle à l'humain (s'il est connecté)
        const target = args[0] ? findPlayer(args[0]) : me;
        if (!target) return reply(`Joueur inconnu : ${args[0]}`);
        if (target.id !== playerId && !isOwner) return reply('Réservé au créateur de la partie (sauf pour vous-même).');
        if (target.type === 'bot') return reply(`${target.name} est un bot de la partie, pas un humain remplacé.`);
        if (!target.connected) return reply(`${target.name} n’est pas connecté·e : il/elle doit d’abord rejoindre avec son pseudo.`);
        if (!target.controlledByBot) return reply(`${target.name} joue déjà en humain.`);
        this.tempBots.delete(target.id);
        this.apply({ type: 'SET_CONNECTED', playerId: target.id, controlledByBot: false });
        this.timers.clearTimeout(this.botTimer);
        this.botTimer = null;
        this.systemChat(`${target.name} reprend la main (commande de ${me.name}).`);
        this.broadcastState();
        return;
      }

      case 'passer': {
        // /passer : un bot termine le tour EN COURS du joueur actif (bloqué, absent…), puis lui rend la main
        if (!inGame || !this.state.turn) return reply('Aucun tour en cours.');
        const active = getPlayer(this.state, this.state.turn.playerId);
        if (active.id !== playerId && !isOwner) return reply('Réservé au créateur de la partie (sauf pour votre propre tour).');
        if (active.controlledByBot) return reply(`${active.name} est déjà joué·e par un bot.`);
        this.tempBots.add(active.id);
        this.apply({ type: 'SET_CONNECTED', playerId: active.id, controlledByBot: true });
        this.systemChat(`Un bot termine le tour de ${active.name} (commande de ${me.name}).`);
        this.broadcastState();
        this.scheduleBot();
        return;
      }

      case 'delai': {
        // /delai <ms> : vitesse des bots (créateur)
        if (!isOwner) return reply('Réservé au créateur de la partie.');
        const ms = Number(args[0]);
        if (!Number.isFinite(ms)) return reply('Usage : /delai <millisecondes> (0 à 5000)');
        this.state.settings.botDelayMs = Math.max(0, Math.min(5000, Math.round(ms)));
        this.state.version += 1;
        this.onDirty?.();
        this.systemChat(`Délai des bots réglé à ${this.state.settings.botDelayMs} ms.`);
        this.broadcastState();
        return;
      }

      case 'kick': {
        // /kick <pseudo> : retirer un joueur du lobby (créateur)
        if (!isOwner) return reply('Réservé au créateur de la partie.');
        if (this.state.status !== 'lobby') return reply('Uniquement dans le lobby. En partie, utilisez /bot <pseudo>.');
        const target = findPlayer(args[0]);
        if (!target) return reply(`Joueur inconnu : ${args[0]}`);
        return this.onLobby(clientId, { op: 'kick', playerId: target.id });
      }

      case 'sync':
        // /sync : renvoie l'état complet et l'historique du chat (affichage désynchronisé)
        this.sendTo(clientId, { type: S2C.STATE, state: redactStateFor(this.state, playerId) });
        this.sendChatHistory(clientId, playerId);
        return reply('État et chat resynchronisés.');

      default:
        return reply(`Commande inconnue : /${name}. Tapez /aide.`);
    }
  }

  pushChat(message) {
    this.chat.push(message);
    if (this.chat.length > MAX_CHAT) this.chat.splice(0, this.chat.length - MAX_CHAT); // borne la mémoire et la sauvegarde
    this.onDirty?.();
    for (const [clientId, c] of this.clients) {
      const viewer = this.viewerId(c);
      if (viewer && canSeeChat(message, viewer)) this.sendTo(clientId, { type: S2C.CHAT, message });
    }
  }

  sendChatHistory(clientId, viewerId) {
    const messages = this.chat.filter((m) => canSeeChat(m, viewerId));
    this.sendTo(clientId, { type: S2C.CHAT_HISTORY, messages });
  }

  // ═════════════════════════ Sorties ═════════════════════════

  broadcast(message) {
    for (const [clientId, c] of this.clients) if (this.viewerId(c)) this.sendTo(clientId, message);
  }

  broadcastState() {
    for (const [clientId, c] of this.clients) {
      if (!this.viewerId(c)) continue;
      // Un spectateur reçoit la vue « personne » : aucune main de joueur n'est visible.
      const view = redactStateFor(this.state, c.playerId);
      view.spectators = this.spectatorList();
      this.sendTo(clientId, { type: S2C.STATE, state: view });
    }
  }

  /** Liste publique des spectateurs, jointe à chaque état diffusé. */
  spectatorList() {
    const out = [];
    for (const c of this.clients.values()) if (c.spectator) out.push({ id: c.spectator.id, name: c.spectator.name });
    return out;
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

  /** Vrai s'il ne reste plus aucun humain vivant et connecté. */
  isAbandoned() {
    return !alivePlayers(this.state).some((p) => p.type === 'human' && p.connected);
  }

  // ═════════════════════════ Sauvegarde / rechargement ═════════════════════════

  /**
   * Instantané JSON complet de la partie (état, jetons, chat…). Le serveur
   * l'écrit sur disque à chaque changement (hook onDirty) et le relit au démarrage.
   */
  serialize() {
    return {
      version: 1,
      gameId: this.gameId,
      inviteUrl: this.inviteUrl,
      ownerId: this.ownerId,
      state: this.state,
      seats: [...this.seats].map(([playerId, s]) => [playerId, { token: s.token, claims: s.claims }]),
      chat: this.chat,
      tempBots: [...this.tempBots],
      lastActivity: this.lastActivity,
      savedAt: Date.now(),
    };
  }

  /**
   * Recrée une partie depuis un instantané. Tous les humains sont marqués
   * déconnectés (aucune connexion n'a survécu) : la partie est en pause jusqu'au
   * retour d'un joueur, qui reprend sa place avec son jeton ou son pseudo.
   */
  static restore(snapshot, { sendTo, timers }) {
    // La sauvegarde vient du disque du serveur, mais on reste prudent : le code
    // sert à nommer le fichier, il ne doit jamais contenir de chemin (« ../ »).
    if (typeof snapshot?.gameId !== 'string' || !GAME_ID_REGEX.test(snapshot.gameId)) throw new Error('Sauvegarde invalide : code de partie');
    if (!snapshot.state || typeof snapshot.state !== 'object') throw new Error('Sauvegarde invalide : état absent');
    const host = new GameHost({ gameId: snapshot.gameId, inviteUrl: snapshot.inviteUrl, sendTo, timers });
    host.state = snapshot.state;
    host.state.id = snapshot.gameId;
    // Anciennes sauvegardes : générateur mulberry32 à graine horaire, prédictible.
    // On le remplace par une clé cryptographique neuve (les dés à venir changent,
    // personne ne pouvait légitimement s'appuyer dessus).
    if (!isValidRng(host.state.rng)) host.state.rng = createRng();
    host.ownerId = snapshot.ownerId;
    host.chat = snapshot.chat ?? [];
    host.tempBots = new Set(snapshot.tempBots ?? []);
    host.lastActivity = snapshot.lastActivity ?? Date.now();
    for (const [playerId, s] of snapshot.seats ?? []) {
      host.seats.set(playerId, { token: s.token, claims: Array.isArray(s.claims) ? s.claims : [], clientId: null, takeoverTimer: null });
    }
    for (const p of host.state.players) {
      if (p.type === 'human') {
        p.connected = false;
        p.controlledByBot = false; // ils reprendront en humain ; les bots ne jouent pas tant que personne n'est là
      }
    }
    host.state.version += 1;
    return host;
  }
}
