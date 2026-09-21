/**
 * Node 18 n'expose pas `globalThis.crypto` par défaut (il apparaît en Node 19).
 * Le jeu en a besoin pour ses jetons, ses codes de partie et la clé des dés
 * (src/core/random.js), et refuse de démarrer sans : pas de repli sur Math.random.
 * Ce module doit être importé EN PREMIER par le serveur.
 */
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.getRandomValues) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
}
