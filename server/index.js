/**
 * Point d'entrée du serveur WebSocket du Risk en ligne : lit la configuration
 * d'environnement et démarre `startServer` (app.js).
 *
 *   cd server && npm install
 *   PORT=8080 FRONT_URL=https://dchirez.fr/risk-online/ node index.js
 *
 * Variables d'environnement :
 *   PORT              port d'écoute (défaut 8080)
 *   FRONT_URL         URL publique du site : liens d'invitation ET origine de
 *                     navigateur autorisée (avec sa variante www / sans www)
 *   ALLOWED_ORIGINS   origines supplémentaires autorisées, séparées par des virgules
 *   DATA_DIR          dossier des sauvegardes (défaut : server/data)
 *   RETENTION_HOURS   conservation d'une partie sans aucun humain (défaut 96 h)
 *   MAX_GAMES         nombre maximal de parties simultanées (défaut 500)
 *
 * Persistance : chaque partie est écrite dans DATA_DIR/games/<code>.json à chaque
 * changement et rechargée au démarrage. Partie terminée supprimée aussitôt,
 * partie sans humain depuis RETENTION_HOURS supprimée, salon vide depuis 1 h aussi.
 * Quand plus aucun humain n'est connecté, les bots ne jouent pas (pause).
 */
import './crypto-polyfill.js';
import { fileURLToPath } from 'node:url';
import { startServer, DEFAULTS } from './app.js';

const env = process.env;
const server = await startServer({
  port: Number(env.PORT ?? DEFAULTS.port),
  frontUrl: env.FRONT_URL ?? DEFAULTS.frontUrl,
  allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(','),
  dataDir: env.DATA_DIR ?? fileURLToPath(new URL('./data/', import.meta.url)),
  retentionMs: Number(env.RETENTION_HOURS ?? 96) * 3600 * 1000,
  maxGames: Number(env.MAX_GAMES ?? DEFAULTS.maxGames),
});

// Arrêt propre : on force l'écriture des sauvegardes en attente
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.flush();
    process.exit(0);
  });
}
