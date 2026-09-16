# 🎲 Risk en ligne

Le jeu de plateau Risk, jouable dans le navigateur de 5 à 7 joueurs via un lien
d'invitation. Frontend 100 % statique (GitHub Pages), logique de jeu et hôte de
partie réutilisables tels quels sur un serveur Node.

## Lancer en local

```bash
python -m http.server 5180
```

puis ouvrir <http://localhost:5180>. (Tout serveur de fichiers statiques
convient ; les modules ES exigent `http://`, pas `file://`.)

Tests du cœur de jeu :

```bash
npm test
```

## Jouer sans serveur (mode actuel)

1. Entrez un pseudo, **Créer** → un code et un lien d'invitation apparaissent.
2. Ouvrez le lien dans d'autres onglets du **même navigateur** (ou ajoutez des
   joueurs locaux / des bots).
3. **Démarrer** : les places vides sont prises par des bots.

L'hôte tourne dans l'onglet du créateur (voir `docs/ARCHITECTURE.md`). Un vrai
serveur WebSocket se branchera plus tard sans modifier l'interface :
`src/config.js` → `wsUrl`.

## Règles implémentées

- Carte du monde détaillée : 80 territoires aux contours réels (Natural Earth),
  6 continents (bonus Amérique du Nord 9, Amérique du Sud 4, Europe 8, Afrique 6,
  Asie 12, Océanie 3), défilement horizontal bouclé (Alaska ↔ Kamtchatka par le bord),
  zoom et déplacement.
- Placement initial (territoires distribués, puis 3 troupes par tour) ; troupes de
  départ proportionnelles au nombre de territoires.
- Renforts : max(3, territoires ÷ 3) + continents ; cartes échangeables
  (3 identiques ou 3 différentes, jokers), bonus 4-6-8-10-12-15 puis +5,
  +2 sur un territoire possédé figurant sur les cartes ; échange obligatoire à 5 cartes.
- Attaque : 1 à 3 dés contre 1 à 2, égalité au défenseur, occupation après
  conquête (au moins autant de troupes que de dés), élimination = récupération
  des cartes, une carte piochée par tour avec conquête.
- Déplacement de fin de tour en chaîne à travers ses territoires.
- Bots : jouent les places vides et remplacent un humain déconnecté (15 s).
- Chat : `@pseudo` mention (surlignée), `#pseudo` message privé, historique conservé.

## Structure

```
index.html, css/          interface
src/core/                 règles, carte, dés, cartes, état, IA (pur, testé)
src/net/                  protocole, hôte de partie, adaptateurs réseau, client
src/ui/                   écrans, carte SVG, panneaux, chat
server/                   brouillon du serveur WebSocket (non déployé)
tools/build-map.mjs       génère src/core/mapData.js depuis Natural Earth (cd tools && node build-map.mjs)
docs/ARCHITECTURE.md      architecture détaillée
docs/PROTOCOL.md          contrat des messages réseau
test/                     tests Node (`node --test`)
```

## Aide et commandes en partie

- Le bouton **📜 Règles** (barre du haut) ouvre un panneau fermable qui explique la
  phase en cours (placement, renfort, attaque, déplacement) et rappelle les règles
  générales et les bonus de continent.
- Dans le chat, un message commençant par `/` est une commande. `/aide` liste tout :
  `/joueurs`, `/etat`, `/lien`, `/regles`, `/sync`, `/ping` (locales), `/bot [pseudo]`,
  `/humain [pseudo]`, `/passer`, `/delai <ms>`, `/kick <pseudo>` (traitées par l'hôte,
  certaines réservées au créateur). Elles servent à débloquer une partie : joueur
  absent, tour bloqué, joueur remplacé par un bot qui revient…
- Reconnexion : le jeton est mémorisé dans le navigateur (nouvel onglet sur le même
  lien = reprise automatique). Sans jeton (autre appareil, navigateur vidé), il
  suffit de rejoindre avec **le même pseudo** : la place d'un humain déconnecté,
  même déjà jouée par un bot, est rendue.

## Déploiement

Le site est statique : publier la racine du dépôt sur GitHub Pages (Settings →
Pages → branche `main`, dossier racine), aucune étape de build. Le serveur de
parties (`server/`, Node + `ws`) se lance sur une machine externe derrière un
reverse proxy TLS, puis on renseigne son adresse `wss://` dans `src/config.js`.
Site en ligne : <https://dchirez.fr/risk-online/> (GitHub Pages, dépôt `dchirez/risk-online`).
Procédure détaillée : [docs/DEPLOIEMENT.md](docs/DEPLOIEMENT.md).
