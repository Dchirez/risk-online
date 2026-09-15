/**
 * LocalHostRuntime : fait tourner un GameHost DANS l'onglet du créateur et le
 * relie à deux types de clients :
 *   - clients locaux (LocalAdapter, même onglet : créateur, joueurs hot-seat),
 *   - clients distants d'autres onglets (BroadcastAdapter, via BroadcastChannel).
 *
 * C'est le remplaçant temporaire du serveur : le jour où server/index.js
 * existe, ce fichier n'est plus utilisé, et rien d'autre ne change.
 */
import { GameHost } from './host.js';
import { channelName } from './adapters.js';

export class LocalHostRuntime {
  constructor({ gameId, settings, inviteUrl }) {
    this.gameId = gameId;
    this.localClients = new Map(); // clientId → deliver(msg)
    this.remoteClients = new Set(); // clientIds venant du BroadcastChannel
    this.host = new GameHost({
      gameId,
      settings,
      inviteUrl,
      sendTo: (clientId, message) => this.route(clientId, message),
    });
    this.channel = null;
    if (typeof BroadcastChannel !== 'undefined') this.openChannel();
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this.close());
    }
  }

  openChannel() {
    this.channel = new BroadcastChannel(channelName(this.gameId));
    this.channel.onmessage = (ev) => {
      const env = ev.data;
      if (env?.dir !== 'c2s') return;
      if (!this.remoteClients.has(env.clientId)) {
        this.remoteClients.add(env.clientId);
        this.host.addClient(env.clientId);
      }
      this.host.handleMessage(env.clientId, env.message);
    };
  }

  attachLocal(clientId, deliver) {
    this.localClients.set(clientId, deliver);
    this.host.addClient(clientId);
  }
  detachLocal(clientId) {
    this.localClients.delete(clientId);
  }

  route(clientId, message) {
    const local = this.localClients.get(clientId);
    if (local) {
      // Copie JSON : le client ne doit jamais partager de référence avec l'hôte
      const copy = JSON.parse(JSON.stringify(message));
      queueMicrotask(() => local(copy));
      return;
    }
    if (this.remoteClients.has(clientId)) this.channel?.postMessage({ dir: 's2c', clientId, message });
  }

  close() {
    this.channel?.postMessage({ dir: 'host_closed' });
    this.channel?.close();
    this.host.close();
  }
}
