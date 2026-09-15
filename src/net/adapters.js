/**
 * Adaptateurs réseau côté client. Tous exposent la même interface minimale :
 *
 *   adapter.connect()            → Promise<void>
 *   adapter.send(message)        → void        (objet JSON, voir protocol.js)
 *   adapter.onMessage(cb)        → () => void  (désabonnement)
 *   adapter.onClose(cb)          → () => void
 *   adapter.close()              → void
 *
 * GameClient (client.js) ne connaît que cette interface : remplacer
 * LocalAdapter par WebSocketAdapter ne change rien au reste de l'application.
 *
 *  - LocalAdapter        : connexion directe à un GameHost dans le même onglet
 *                          (mode solo / hot-seat / debug).
 *  - BroadcastAdapter    : connexion à un GameHost hébergé dans UN AUTRE onglet
 *                          du même navigateur via BroadcastChannel — simule le
 *                          multijoueur (lien d'invitation) sans serveur.
 *  - WebSocketAdapter    : connexion au futur serveur Node (déjà fonctionnel côté
 *                          client, à brancher quand le serveur existera).
 */
import { randomId } from './protocol.js';

class BaseAdapter {
  constructor() {
    this.messageListeners = new Set();
    this.closeListeners = new Set();
  }
  onMessage(cb) {
    this.messageListeners.add(cb);
    return () => this.messageListeners.delete(cb);
  }
  onClose(cb) {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }
  emitMessage(msg) {
    for (const cb of this.messageListeners) cb(msg);
  }
  emitClose(reason) {
    for (const cb of this.closeListeners) cb(reason);
  }
}

// ═══════════════════════════ Local (même onglet) ═══════════════════════════

export class LocalAdapter extends BaseAdapter {
  /** @param {import('./hostRuntime.js').LocalHostRuntime} runtime */
  constructor(runtime) {
    super();
    this.runtime = runtime;
    this.clientId = randomId('local');
  }
  async connect() {
    this.runtime.attachLocal(this.clientId, (msg) => this.emitMessage(msg));
  }
  send(message) {
    // Passage asynchrone pour imiter un vrai réseau (l'UI ne doit pas dépendre d'une réponse synchrone)
    const copy = JSON.parse(JSON.stringify(message));
    queueMicrotask(() => this.runtime.host.handleMessage(this.clientId, copy));
  }
  close() {
    this.runtime.host.handleDisconnect(this.clientId);
    this.runtime.detachLocal(this.clientId);
    this.emitClose('closed');
  }
}

// ═══════════════════════ BroadcastChannel (multi-onglets) ═══════════════════════

export const channelName = (gameId) => `risk-online:${gameId}`;

export class BroadcastAdapter extends BaseAdapter {
  constructor(gameId) {
    super();
    this.gameId = gameId;
    this.clientId = randomId('bc');
    this.channel = null;
  }
  async connect() {
    if (typeof BroadcastChannel === 'undefined') throw new Error('BroadcastChannel non supporté');
    this.channel = new BroadcastChannel(channelName(this.gameId));
    this.channel.onmessage = (ev) => {
      const env = ev.data;
      if (env?.dir === 's2c' && env.clientId === this.clientId) this.emitMessage(env.message);
      if (env?.dir === 'host_closed') this.emitClose('host_closed');
    };
    // Fermeture d'onglet : on prévient l'hôte tout de suite (sinon il attend l'expiration du heartbeat)
    window.addEventListener('pagehide', () => this.channel?.postMessage({ dir: 'c2s', clientId: this.clientId, message: { type: 'leave' } }));
  }
  send(message) {
    this.channel?.postMessage({ dir: 'c2s', clientId: this.clientId, message });
  }
  close() {
    this.send({ type: 'leave' });
    this.channel?.close();
    this.channel = null;
    this.emitClose('closed');
  }
}

// ═══════════════════════════ WebSocket (serveur) ═══════════════════════════

export class WebSocketAdapter extends BaseAdapter {
  /** @param {string} url ex. wss://risk.example.com/ws */
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('Connexion WebSocket impossible'));
      ws.onmessage = (ev) => {
        try {
          this.emitMessage(JSON.parse(ev.data));
        } catch {
          /* message non JSON ignoré */
        }
      };
      ws.onclose = () => this.emitClose('closed');
    });
  }
  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }
  close() {
    this.ws?.close();
  }
}
