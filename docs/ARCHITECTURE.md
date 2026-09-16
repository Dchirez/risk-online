# Architecture — Risk en ligne

## Vue d'ensemble

```
┌────────────────────────── navigateur (GitHub Pages) ──────────────────────────┐
│  src/ui/            interface : écrans, carte SVG, panneaux, chat             │
│      │  actions / états                                                        │
│  src/net/client.js  GameClient  ── interface d'adaptateur ──┐                  │
│                                                            │                  │
│  src/net/adapters.js   LocalAdapter   BroadcastAdapter   WebSocketAdapter     │
│                            │               │                   │              │
│  src/net/hostRuntime.js  ──┴───────────────┘                   │ (demain)     │
│      LocalHostRuntime : héberge GameHost dans l'onglet créateur │              │
└────────────────────────────────────────────────────────────────┼──────────────┘
                                                                 │ JSON / WebSocket
┌──────────────────────────── serveur Node (à venir) ────────────┼──────────────┐
│  server/index.js  : 1 GameHost par partie + routage des sockets ▼             │
│  src/net/host.js  : GameHost (validation, bots, chat, reconnexion)            │
│  src/core/*       : règles, état, IA — EXACTEMENT les mêmes fichiers          │
└───────────────────────────────────────────────────────────────────────────────┘
```

Trois couches strictement séparées :

| Couche | Dossier | Dépendances | Testable sans |
|---|---|---|---|
| **Logique de jeu pure** | `src/core/` | aucune (ni DOM, ni Node) | navigateur, réseau |
| **Hôte / protocole** | `src/net/host.js`, `protocol.js` | `core` | navigateur (timers injectables) |
| **Transport** | `src/net/adapters.js`, `hostRuntime.js`, `client.js` | `protocol` | logique de jeu |
| **Interface** | `src/ui/` | `core` (lecture), `client` | hôte réel (un `LocalAdapter` suffit) |

## `src/core` — logique pure

- **`map.js`** : catalogue des cartes (`MAP_CATALOG`) et construction d'un objet
  carte (`getMap(id)`, `mapOf(state)`) : territoires, continents, adjacences
  (symétrisées et vérifiées), `territoriesOf`, `areAdjacent`, chemins SVG,
  silhouettes pour les cartes à jouer, `territoryAt(x, y)` (clic). Une partie
  porte `state.mapId` ; le cœur ne connaît aucune carte « globale », donc des
  parties sur des cartes différentes coexistent sur un même serveur.
- **`maps/world.js`** : données générées par `tools/build-map.mjs` à partir de
  Natural Earth 1:50m (domaine public) : contours réels fusionnés par territoire,
  projection de Miller sur 2400 unités de large, point d'étiquette (pôle
  d'inaccessibilité), adjacences calculées par contact des contours + routes
  maritimes déclarées à la main. La carte boucle horizontalement (Alaska ↔ Kamtchatka).
- **`maps/middle_earth.js`** : données générées par `tools/build-middle-earth.mjs`.
  Chaque territoire est un point relevé sur la carte de référence ; les cellules
  de Voronoï sont ondulées de façon déterministe puis rognées par la côte et les
  mers intérieures ; les chaînes de montagnes coupent l'adjacence (liste `BLOCKED`)
  et sont exportées comme crêtes à dessiner (`ridges`). Carte non bouclée, avec des
  zones infranchissables décoratives (`zones`).
- Bonus de continent, même règle pour toutes les cartes : `max(2, round(n × 0,55))`.
- **`dice.js`** : RNG déterministe (mulberry32) stocké dans l'état → même graine,
  même partie ; `resolveCombat` compare les dés par paires, égalité au défenseur.
- **`cards.js`** : paquet (42 + 2 jokers), `isValidSet`, `findValidSets`,
  `exchangeBonus` (4, 6, 8, 10, 12, 15, +5…).
- **`state.js`** : structure `GameState` (JSON pur, sérialisable), helpers de
  lecture (`computeReinforcements`, `continentsOwned`, `connectedOwned`…) et
  **`redactStateFor`** qui produit la vue envoyée à chaque joueur (cartes des
  autres masquées).
- **`rules.js`** : le **seul** moyen de modifier l'état.
  `validateAction(state, action) → null | message` et
  `applyAction(state, action) → { state, events }`. Pas d'effet de bord :
  l'état d'entrée n'est jamais muté. `possibleMoves` résume les coups légaux.
- **`bot.js`** : `decideBotAction(state, playerId) → action`. Heuristiques
  (frontières menacées, continents presque acquis, attaque en supériorité,
  regroupement vers la frontière). Toujours une action légale, sinon `END_PHASE`.

### Cycle d'un tour

```
setup (placement initial, 3 troupes / joueur / tour, territoires distribués au hasard)
  └─► reinforce  : renforts = max(3, territoires/3) + continents ; échange obligatoire si ≥ 5 cartes
        └─► attack : ATTACK (1-3 dés) → conquête → OCCUPY ; élimination = récupération des cartes
              └─► fortify : FORTIFY (1 déplacement en chaîne) ou END_PHASE
                    └─► pioche 1 carte si conquête → joueur vivant suivant
                        (au plus UNE carte par tour : verrou `turn.cardDrawn`,
                         et l'élimination d'un joueur n'en rapporte qu'une seule)
```

## `src/net` — hôte et transport

### `GameHost` (`host.js`) — l'autorité

Une instance par partie. Entrées : `addClient(id)`, `handleMessage(id, msg)`,
`handleDisconnect(id)`. Sortie : `sendTo(clientId, msg)` injecté au constructeur.
Responsabilités :

1. lobby (pseudos uniques, créateur = premier arrivé, bots de complément) ;
2. validation + application des actions (identité issue de la connexion) ;
3. diffusion : `events` (ce qui vient de se passer) puis `state` (vue redactée par joueur) ;
4. bots : `scheduleBot()` après chaque changement, joue avec un délai configurable ;
5. chat : parsing `@`/`#`, filtrage des privés, historique ;
6. présence : heartbeat, déconnexion → bot après 15 s, reconnexion par jeton.

Il n'utilise que `setTimeout`/`clearTimeout` (injectables) : il tourne à
l'identique dans un onglet et dans Node.

### Adaptateurs (`adapters.js`) — interface unique

```js
adapter.connect(): Promise<void>
adapter.send(message)
adapter.onMessage(cb) / adapter.onClose(cb)
adapter.close()
```

| Adaptateur | Aujourd'hui | Rôle |
|---|---|---|
| `LocalAdapter` | ✅ | même onglet que l'hôte (créateur, joueurs hot-seat, debug) |
| `BroadcastAdapter` | ✅ | autre onglet du même navigateur (teste le lien d'invitation) |
| `WebSocketAdapter` | ✅ code prêt | serveur distant — activer via `src/config.js` (`wsUrl`) |

`GameClient` (`client.js`) est le seul objet que l'UI manipule : `join`, `create`,
`sendAction` (promesse résolue au prochain état, rejetée sur `error` corrélée par `seq`),
`sendChat`, `lobby`, événements `state | events | chat | player | error | close`.

### Brancher le serveur WebSocket (plus tard)

1. `server/index.js` (brouillon fourni) : une `Map<gameId, GameHost>` ; à chaque
   socket un `clientId` ; `create` → nouveau `GameHost` ; `join` → routage vers
   le bon hôte ; `socket.on('message')` → `host.handleMessage` ;
   `socket.on('close')` → `host.handleDisconnect`.
2. Dans `src/config.js` : `wsUrl: 'wss://…'`. Rien d'autre ne change.
3. Persistance / reprise après redémarrage : optionnelle, l'état est du JSON
   (`serialize` / `deserialize` dans `state.js`).

## `src/ui` — interface

- `app.js` : écrans (accueil → lobby → partie), gestion des `GameClient`
  (plusieurs par onglet en hot-seat, bascule automatique sur le joueur actif),
  interactions carte, modales, attaque totale, placement auto.
- `mapView.js` : SVG construit une fois — le monde est dessiné trois fois côte à
  côte (x = −W, 0, +W) et la fenêtre de vue (viewBox) est ramenée modulo W : on
  peut faire défiler la carte à l'infini, à plat, comme un carrousel. Zoom à la
  molette / pincement, déplacement au glisser, clic résolu par
  `territoryAt`. Les pastilles (troupes, nom) sont contre-mises à l'échelle
  pour rester lisibles ; le nom n'apparaît que s'il tient dans le territoire.
  `update(state, highlights)` à chaque état.
- `panels.js` : en-tête, phase & actions, joueurs, cartes, journal ;
  `computeHighlights` traduit la sélection en surbrillances.
- `chat.js` : rendu des messages (mentions colorées, privés, système), boutons
  d'insertion `@pseudo`.
- Mode spectateur : une connexion sans siège (`GameHost.onSpectate`). Côté cœur,
  rien ne change : `redactStateFor(state, null)` masque toutes les mains, et
  `computeHighlights` / `onTerritoryClick` ne réagissent déjà qu'au joueur actif.
- `rules.js` : panneau d'aide contextuel (règles de la phase en cours, règles
  générales), fermable, état mémorisé dans le navigateur.
- `diceView.js` : animation des dés sur le plateau à chaque événement `COMBAT`
  (roulement, valeurs réelles de l'hôte, paires gagnantes/perdantes), ancrée près
  du territoire attaqué via `mapView.toScreen`. Purement décoratif.

L'UI ne calcule jamais de règles : elle lit `possibleMoves` / `validateAction`
pour guider l'utilisateur et laisse l'hôte trancher.

## Mode de test sans serveur

- **Solo + bots** : créer une partie, démarrer → les places vides sont des bots.
- **Hot-seat** : « + Joueur local » dans le lobby → plusieurs humains dans le
  même onglet, bascule automatique (« suivre le tour »).
- **Multi-onglets** : ouvrir le lien d'invitation dans un autre onglet du même
  navigateur → vrai trafic de messages via `BroadcastChannel`, reconnexion par
  jeton après rafraîchissement, remplacement par un bot si l'onglet est fermé.
- **Console** : `window.risk.app.runtime.host.state` (onglet hôte) ;
  `window.risk.app.clients[0].state`.
- **Tests** : `npm test` — règles, dés, cartes, chat, parties complètes bots vs bots.

## Limites connues (mode sans serveur)

- Si l'onglet créateur est fermé ou rafraîchi, la partie est perdue (l'hôte
  vit dans cet onglet). Le serveur résoudra ce point.
- Les onglets en arrière-plan ralentissent les timers : les bots peuvent
  jouer plus lentement si l'onglet hôte n'est pas visible.
