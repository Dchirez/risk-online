/**
 * Configuration réseau du frontend.
 *
 *  - wsUrl vide  → mode "sans serveur" : l'onglet créateur héberge la partie
 *                  (LocalHostRuntime) et les invités se connectent par BroadcastChannel
 *                  (même navigateur). Idéal pour développer et tester.
 *  - wsUrl rempli → mode serveur : toutes les connexions passent par WebSocketAdapter.
 *
 * En ligne (GitHub Pages) on utilise le serveur de parties ; en local (localhost)
 * on reste sans serveur, sauf si LOCAL_WS_URL est renseigné pour tester le serveur.
 * Aucun autre fichier ne doit changer pour passer d'un mode à l'autre.
 */

/** Serveur de parties en production (reverse proxy TLS → node server/index.js). */
const PROD_WS_URL = 'wss://risk.skayzax.fr/ws';
/** Pour tester le serveur en local : 'ws://localhost:8080' (sinon laisser vide). */
const LOCAL_WS_URL = '';

const isLocal = typeof location !== 'undefined' && ['localhost', '127.0.0.1'].includes(location.hostname);

export const NET = {
  wsUrl: isLocal ? LOCAL_WS_URL : PROD_WS_URL,
  /** Délai par défaut entre deux coups d'un bot (ms). */
  botDelayMs: 700,
};
