# Serveur WebSocket

`index.js` réutilise `src/net/host.js` et `src/core/*` sans modification : le
serveur ne contient aucune règle de jeu, il route seulement les messages vers la
bonne partie (`create` / `join`), puis vers `GameHost`.

`app.js` exporte `startServer(options)` (démarrable par les tests sur un port libre),
`index.js` lit la configuration d'environnement et le lance. Protections réseau
(taille, débit, origine, plafond de parties, résistance aux messages piégés) :
voir `docs/SECURITE.md`, tests dans `test/server.security.test.js`.

```bash
cd server
npm install
PORT=8080 FRONT_URL=https://dchirez.fr/risk-online/ node index.js
```

Côté frontend : `src/config.js` → `PROD_WS_URL`.

Variables : `PORT`, `FRONT_URL`, `ALLOWED_ORIGINS`, `DATA_DIR`, `RETENTION_HOURS`, `MAX_GAMES` (voir l'en-tête de `index.js`).

Procédure complète (GitHub Pages, systemd, nginx/TLS) : `docs/DEPLOIEMENT.md`.
Contrat des messages : `docs/PROTOCOL.md`.
