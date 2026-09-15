# Serveur WebSocket

`index.js` réutilise `src/net/host.js` et `src/core/*` sans modification : le
serveur ne contient aucune règle de jeu, il route seulement les messages vers la
bonne partie (`create` / `join`), puis vers `GameHost`.

Testé en local (deux onglets, création, jonction par lien, bots, chat public et privé).

```bash
cd server
npm install
PORT=8080 FRONT_URL=https://dchirez.github.io/risk-online/ node index.js
```

Côté frontend : `src/config.js` → `wsUrl: 'wss://<domaine>/ws'`.

Procédure complète (GitHub Pages, systemd, nginx/TLS) : `docs/DEPLOIEMENT.md`.
Contrat des messages : `docs/PROTOCOL.md`.
