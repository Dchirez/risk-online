# Déploiement

Deux morceaux à mettre en ligne, indépendants l'un de l'autre :

| Morceau | Quoi | Où |
|---|---|---|
| Frontend | `index.html`, `css/`, `src/` (fichiers statiques, aucun build) | GitHub Pages |
| Serveur de parties | `server/index.js` + `src/core` + `src/net` (Node ≥ 18) | le serveur externe |

Le frontend fonctionne aussi **sans** serveur (mode « onglet hôte + BroadcastChannel »),
mais alors seuls des onglets du même navigateur peuvent se rejoindre. Pour jouer
à plusieurs machines il faut le serveur WebSocket.

---

## 1. Frontend sur GitHub Pages

1. Créer un dépôt GitHub (ex. `risk-online`) et y pousser le projet :

   ```bash
   cd Projet_Perso/risk-online
   git init
   git add .
   git commit -m "Risk en ligne"
   git branch -M main
   git remote add origin https://github.com/dchirez/risk-online.git
   git push -u origin main
   ```

   Le `.gitignore` exclut déjà `node_modules/` et le cache Natural Earth de `tools/`.

2. Sur GitHub : **Settings → Pages → Build and deployment → Source : Deploy from a branch**,
   branche `main`, dossier `/ (root)`. Enregistrer.

3. Le compte GitHub a déjà un domaine personnalisé (dchirez.fr) : le site est donc servi sur
   `https://dchirez.fr/risk-online/`.
   Les liens d'invitation auront la forme `https://dchirez.fr/risk-online/?game=K7Q2ZP`.

4. **Brancher le serveur** : rien à faire, `src/config.js` contient déjà l'adresse
   de production, utilisée automatiquement dès que le site n'est pas ouvert sur
   `localhost` :

   ```js
   const PROD_WS_URL = 'wss://risk.skayzax.fr/ws';
   const LOCAL_WS_URL = ''; // 'ws://localhost:8080' pour tester le serveur en local
   ```

   En local (`localhost`), le site reste en mode sans serveur tant que `LOCAL_WS_URL`
   est vide.

> GitHub Pages est servi en HTTPS : le navigateur refuse une connexion `ws://` non
> chiffrée depuis une page HTTPS (« mixed content »). L'adresse doit donc être en
> **`wss://`**, ce qui impose un certificat TLS côté serveur (voir plus bas).

---

## 2. Serveur de parties (Node + WebSocket)

Le serveur ne contient aucune règle : il route les messages vers `GameHost`
(`src/net/host.js`), qui applique `src/core/rules.js` et fait jouer les bots.
Il a besoin du dépôt complet (il importe `../src/...`).

### Installation sur la machine

```bash
git clone https://github.com/dchirez/risk-online.git
cd risk-online/server
npm install            # installe uniquement "ws"
```

Test rapide :

```bash
PORT=8080 FRONT_URL=https://dchirez.fr/risk-online/ node index.js
# → Serveur Risk en écoute sur ws://localhost:8080 (front : https://…)
```

Variables d'environnement :

| Variable | Rôle | Défaut |
|---|---|---|
| `PORT` | port d'écoute WebSocket (à ne pas exposer directement : passer par le reverse proxy) | `8080` |
| `FRONT_URL` | URL publique du site, utilisée pour fabriquer les liens d'invitation | `http://localhost:5180/` |

### Lancement permanent (systemd)

`/etc/systemd/system/risk.service` :

```ini
[Unit]
Description=Risk en ligne - serveur de parties
After=network.target

[Service]
User=www-data
WorkingDirectory=/opt/risk-online/server
Environment=PORT=8080
Environment=FRONT_URL=https://dchirez.fr/risk-online/
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now risk
sudo journalctl -u risk -f      # journal
```

(Équivalent avec pm2 : `pm2 start index.js --name risk` puis `pm2 save`.)

### Reverse proxy TLS (nginx + Let's Encrypt)

Le serveur écoute en clair sur `127.0.0.1:8080` ; nginx termine le TLS et
transmet la connexion WebSocket. Il faut un nom de domaine pointant sur la machine
(ex. `risk.skayzax.fr`).

```nginx
server {
    listen 443 ssl;
    server_name risk.skayzax.fr;

    ssl_certificate     /etc/letsencrypt/live/risk.skayzax.fr/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/risk.skayzax.fr/privkey.pem;

    location /ws {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;   # une partie dure longtemps : ne pas couper les sockets inactives
    }
}
```

Certificat : `sudo certbot --nginx -d risk.skayzax.fr`.
Le frontend vise déjà `wss://risk.skayzax.fr/ws` (`PROD_WS_URL` dans `src/config.js`).

Si la personne qui fournit le serveur utilise Caddy, c'est encore plus court
(TLS automatique) :

```
risk.skayzax.fr {
    reverse_proxy /ws 127.0.0.1:8080
}
```

### Mises à jour

```bash
cd /opt/risk-online && git pull && sudo systemctl restart risk
```

Les parties en cours sont en mémoire : un redémarrage les termine. Les joueurs
gardent leur jeton de reconnexion dans l'onglet, mais la partie elle-même n'est pas
persistée (voir `serialize` / `deserialize` dans `src/core/state.js` si besoin un jour).

---

## 3. Vérifier que tout est branché

1. Ouvrir le site GitHub Pages, créer une partie : le lien d'invitation doit
   commencer par l'URL du site et la console du serveur ne doit rien afficher d'anormal.
2. Ouvrir le lien depuis **un autre appareil** (téléphone en 4G par exemple) et
   rejoindre : le pseudo apparaît dans le lobby du créateur.
3. Démarrer : les places vides sont prises par des bots, la partie commence.

Erreurs fréquentes :

| Symptôme | Cause probable |
|---|---|
| « Connexion WebSocket impossible » | `wsUrl` faux, port fermé, ou `ws://` depuis une page HTTPS |
| « Partie introuvable » | code erroné, ou le serveur a redémarré depuis la création |
| Les joueurs sont déconnectés au bout d'une minute | le proxy coupe les connexions inactives : augmenter `proxy_read_timeout` |
| Le lien d'invitation pointe vers `localhost` | `FRONT_URL` non renseigné au lancement du serveur |
