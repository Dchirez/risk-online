/**
 * GameClient : le point d'accès unique de l'interface au réseau.
 * Il ne connaît que l'interface d'adaptateur (adapters.js) et le protocole.
 *
 *   const client = new GameClient(adapter);
 *   await client.join({ gameId, playerName, token });
 *   client.on('state', (state) => render(state));
 *   client.sendAction({ type:'ATTACK', from, to, dice:3 });
 *
 * Événements émis : 'welcome', 'state', 'events', 'chat', 'player', 'error', 'close'
 */
import { C2S, S2C } from './protocol.js';

const PING_INTERVAL_MS = 5000;
const JOIN_TIMEOUT_MS = 4000;

export class GameClient {
  constructor(adapter) {
    this.adapter = adapter;
    this.playerId = null;
    this.token = null;
    this.gameId = null;
    this.inviteUrl = null;
    this.isOwner = false;
    this.isSpectator = false;
    this.state = null;
    this.chat = [];
    this.listeners = new Map();
    this.seq = 0;
    this.pending = new Map(); // seq → { resolve, reject }
    this.pingTimer = null;
    this.connected = false;

    adapter.onMessage((msg) => this.handle(msg));
    adapter.onClose((reason) => {
      this.connected = false;
      clearInterval(this.pingTimer);
      this.emit('close', reason);
    });
  }

  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(cb);
    return () => this.listeners.get(event).delete(cb);
  }
  emit(event, payload) {
    for (const cb of this.listeners.get(event) ?? []) cb(payload);
  }

  /**
   * Connexion + entrée dans la partie. Résout à la réception du WELCOME.
   * `gameId` est indispensable en mode serveur (plusieurs parties sur une même
   * adresse) ; en mode local/BroadcastChannel l'adaptateur le connaît déjà.
   */
  join({ gameId, playerName, token }) {
    return this.handshake({ type: C2S.JOIN, gameId, playerName, token });
  }

  /**
   * Entrée en spectateur : voir la partie sans y jouer (partie pleine, déjà
   * commencée, ou simple curieux). Résout au WELCOME.
   */
  spectate({ gameId, name }) {
    return this.handshake({ type: C2S.SPECTATE, gameId, name });
  }

  /**
   * Création d'une partie côté serveur (mode WebSocket uniquement : en mode local,
   * la partie est créée en instanciant LocalHostRuntime). Résout au WELCOME.
   */
  create({ playerName, settings }) {
    return this.handshake({ type: C2S.CREATE, playerName, settings });
  }

  async handshake(firstMessage) {
    await this.adapter.connect();
    this.connected = true;
    this.pingTimer = setInterval(() => this.adapter.send({ type: C2S.PING }), PING_INTERVAL_MS);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        offW();
        offE();
        reject(new Error('Aucune réponse de l’hôte (l’onglet qui a créé la partie est-il ouvert ?)'));
      }, JOIN_TIMEOUT_MS);
      const offW = this.on('welcome', (w) => {
        clearTimeout(timer);
        offW();
        offE();
        resolve(w);
      });
      const offE = this.on('error', (e) => {
        clearTimeout(timer);
        offW();
        offE();
        reject(new Error(e.message));
      });
      this.adapter.send(firstMessage);
    });
  }

  /** Envoie une action de jeu. Résout quand un nouvel état arrive, rejette sur ERROR corrélée. */
  sendAction(action) {
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      this.adapter.send({ type: C2S.ACTION, action, seq });
      setTimeout(() => {
        if (this.pending.delete(seq)) resolve(null);
      }, 3000);
    });
  }

  sendChat(text) {
    this.adapter.send({ type: C2S.CHAT, text });
  }

  /** Commande de chat traitée par l'hôte (/bot, /passer, /delai…). */
  sendCommand(name, args = []) {
    this.adapter.send({ type: C2S.COMMAND, name, args });
  }

  /** Message système visible uniquement dans cet onglet (réponses des commandes locales). */
  localSystem(text) {
    this.chat.push({ id: `local_${Date.now()}`, ts: Date.now(), kind: 'system', from: null, fromName: 'Système', text, mentions: [], to: [] });
    this.emit('chat', null);
  }

  lobby(op, extra = {}) {
    this.adapter.send({ type: C2S.LOBBY, op, ...extra });
  }

  leave() {
    clearInterval(this.pingTimer);
    this.adapter.close();
  }

  /** Le joueur que ce client contrôle (null en spectateur). */
  get me() {
    if (this.isSpectator) return null;
    return this.state?.players.find((p) => p.id === this.playerId) ?? null;
  }

  handle(msg) {
    switch (msg.type) {
      case S2C.WELCOME:
        this.playerId = msg.playerId;
        this.token = msg.token;
        this.gameId = msg.gameId;
        this.inviteUrl = msg.inviteUrl;
        this.isOwner = msg.isOwner;
        this.isSpectator = !!msg.spectator;
        this.emit('welcome', msg);
        break;
      case S2C.STATE:
        this.state = msg.state;
        // Toute action en attente est considérée acceptée dès qu'un état arrive
        for (const [seq, p] of this.pending) {
          p.resolve(msg.state);
          this.pending.delete(seq);
        }
        this.emit('state', msg.state);
        break;
      case S2C.EVENTS:
        this.emit('events', msg.events);
        break;
      case S2C.CHAT:
        this.chat.push(msg.message);
        this.emit('chat', msg.message);
        break;
      case S2C.CHAT_HISTORY:
        this.chat = msg.messages;
        this.emit('chat', null);
        break;
      case S2C.PLAYER:
        this.emit('player', msg);
        break;
      case S2C.ERROR:
        if (msg.seq && this.pending.has(msg.seq)) {
          this.pending.get(msg.seq).reject(new Error(msg.message));
          this.pending.delete(msg.seq);
        }
        this.emit('error', msg);
        break;
      case S2C.PONG:
        break;
      default:
        console.warn('[GameClient] message inconnu', msg);
    }
  }
}
