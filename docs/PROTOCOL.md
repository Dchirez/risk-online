# Protocole client ⇄ serveur (contrat d'interface)

Tous les messages sont des objets JSON `{ "type": "...", ... }` échangés sur une
connexion persistante (WebSocket demain ; BroadcastChannel / appel direct
aujourd'hui). Les constantes sont dans `src/net/protocol.js` (`C2S`, `S2C`,
`ERROR_CODES`), partagées par le client et l'hôte.

**Principe clé : le serveur est l'autorité.** Le client n'envoie que des
*intentions* (`action`) ; l'hôte valide avec `rules.validateAction`, applique
avec `rules.applyAction`, puis renvoie l'état complet (vue redactée) à chacun.
L'identité du joueur est déduite de la connexion, jamais du contenu du message.

## 1. Client → serveur (`C2S`)

| type      | Champs                                                    | Quand                                   |
|-----------|-----------------------------------------------------------|-----------------------------------------|
| `create`  | `playerName`, `settings: { maxPlayers (5-7), botDelayMs }` | Créer une partie (le serveur génère le code) |
| `join`    | `gameId`, `playerName`, `token?`                          | Rejoindre ; avec `token` = reconnexion   |
| `lobby`   | `op: 'start' \| 'addBot' \| 'kick' \| 'settings'`, + champs | Réservé au créateur (`isOwner`)        |
| `action`  | `action: { type, ... }`, `seq`                            | Coup de jeu (voir §3)                    |
| `chat`    | `text` (≤ 500 caractères)                                 | Message de chat (mentions/privé parsés côté hôte) |
| `command` | `name`, `args: [...]`                                     | Commande `/name args` tapée dans le chat : `bot`, `humain`, `passer`, `delai`, `kick`, `sync`, `ping`. Réponse par un message `chat` système privé (`from: null`, `to: [moi]`). |
| `ping`    | —                                                         | Toutes les 5 s (heartbeat)               |
| `leave`   | —                                                         | Quitter proprement                       |

Détails `lobby` :
- `kick` : `playerId`
- `settings` : `maxPlayers?`, `botDelayMs?`

## 2. Serveur → client (`S2C`)

| type           | Champs                                                       |
|----------------|--------------------------------------------------------------|
| `welcome`      | `playerId`, `token`, `gameId`, `inviteUrl`, `isOwner`        |
| `state`        | `state` — vue **redactée** pour ce joueur (voir §4)          |
| `events`       | `events: [...]`, `version` — événements produits par la dernière action (dés, conquêtes…) |
| `chat`         | `message` (voir §5)                                          |
| `chat_history` | `messages: [...]` — à la connexion, filtré pour ce joueur    |
| `player`       | `op: 'joined' \| 'left' \| 'disconnected' \| 'reconnected' \| 'bot_takeover'`, `playerId` |
| `error`        | `code`, `message`, `seq?` (corrélé à l'`action` refusée)     |
| `pong`         | —                                                            |

Codes d'erreur : `GAME_NOT_FOUND`, `GAME_FULL`, `NAME_TAKEN`, `INVALID_NAME`,
`NOT_OWNER`, `ILLEGAL_ACTION`, `BAD_MESSAGE`.

## 3. Actions de jeu (`action.action`)

Le champ `playerId` est **ajouté par l'hôte** à partir de la connexion.

```jsonc
{ "type": "PLACE_TROOPS", "territory": "alaska", "count": 3 }   // placement initial / renforts
{ "type": "EXCHANGE_CARDS", "cardIds": ["c_alaska", "c_peru", "c_joker_1"] }
{ "type": "END_PHASE" }                                          // renfort→attaque→déplacement→fin de tour
{ "type": "ATTACK", "from": "alaska", "to": "kamchatka", "dice": 3 }
{ "type": "OCCUPY", "count": 5 }                                 // après conquête : total de troupes envoyées
{ "type": "FORTIFY", "from": "peru", "to": "brazil", "count": 4 } // termine le tour
```

Exemple d'échange complet :

```jsonc
// client
{ "type": "action", "seq": 12, "action": { "type": "ATTACK", "from": "alaska", "to": "kamchatka", "dice": 3 } }
// serveur (à tous les joueurs)
{ "type": "events", "version": 87, "events": [
  { "type": "COMBAT", "attackerId": "p_1", "defenderId": "p_4", "from": "alaska", "to": "kamchatka",
    "attackerDice": [6,4,2], "defenderDice": [5,2], "attackerLosses": 0, "defenderLosses": 2, "conquered": true },
  { "type": "TERRITORY_CONQUERED", "playerId": "p_1", "from": "alaska", "territory": "kamchatka", "defenderId": "p_4", "moved": 3 }
] }
{ "type": "state", "state": { ... } }
// ou, si l'action est refusée (uniquement à l'émetteur)
{ "type": "error", "code": "ILLEGAL_ACTION", "message": "Territoires non adjacents", "seq": 12 }
```

Événements possibles : `GAME_STARTED`, `TURN_STARTED`, `TROOPS_PLACED`,
`CARDS_EXCHANGED`, `PHASE_CHANGED`, `COMBAT`, `TERRITORY_CONQUERED`, `OCCUPIED`,
`PLAYER_ELIMINATED`, `CARD_DRAWN`, `FORTIFIED`, `GAME_OVER`, `PLAYER_JOINED`, `PLAYER_LEFT`.

## 4. Vue d'état envoyée (`state`)

`redactStateFor(state, playerId)` (src/core/state.js) :
- `players[i].cards` n'est rempli que pour le destinataire ; les autres n'ont que `cardCount` ;
- `cards` devient `{ deckCount, discardCount, exchanges }` ;
- `rng` est supprimé (le hasard reste côté hôte).

Structure complète : voir l'en-tête de `src/core/state.js`.

## 5. Chat, mentions, messages privés

```jsonc
{
  "id": "m_ab12", "ts": 1757930000000,
  "kind": "public" | "private" | "system",
  "from": "p_1", "fromName": "Alice",
  "text": "#Bob on attaque @Carol ?",
  "mentions": ["p_3"],          // ids des @pseudo reconnus
  "to": ["p_2"]                 // ids des #pseudo (privé) — vide si public
}
```

- `@pseudo` → mention : message public, le destinataire le voit surligné.
- `#pseudo` → privé : l'hôte ne l'envoie **qu'à** l'expéditeur et aux destinataires
  (`canSeeChat`). Plusieurs `#pseudo` = petit groupe privé.
- Pseudos : `^[A-Za-z0-9_-]{2,16}$`, insensibles à la casse, sans espace.
- L'historique est conservé par l'hôte pendant toute la partie et renvoyé
  (filtré) à chaque (re)connexion via `chat_history`.

## 6. Déconnexions

- Sans `ping` pendant 75 s, ou sur `leave` / fermeture de socket, le client est
  considéré déconnecté : `player{op:'disconnected'}`, `players[i].connected=false`.
- 15 s plus tard (`TAKEOVER_DELAY_MS`), un bot prend le contrôle
  (`controlledByBot=true`, `player{op:'bot_takeover'}`) : la partie ne bloque jamais.
- Le joueur peut revenir à tout moment avec son `token` (`join` + `token`) :
  il reprend la main, `player{op:'reconnected'}`.
- Dans le lobby, une déconnexion libère simplement la place.
- **Pause** : quand plus aucun humain n'est connecté, l'hôte ne fait plus jouer les
  bots (message système « Partie en pause »). Au retour d'un joueur, la partie
  reprend (« Reprise de la partie ») et les remplacements par des bots sont réarmés.
- **Persistance (serveur)** : `GameHost.serialize()` / `GameHost.restore()` —
  instantané JSON (état, jetons, chat) écrit à chaque changement via le hook
  `onDirty`, rechargé au démarrage. Partie terminée supprimée aussitôt, partie
  sans présence humaine supprimée après 96 h.

### Reprise de place sans jeton

Si un `join` arrive **sans jeton valide** alors que la partie a commencé, l'hôte
cherche un joueur humain portant le même pseudo (insensible à la casse) dont la
connexion est perdue (onglet fermé, remplacé par un bot…). S'il existe, la place
lui est rendue : nouveau jeton, `welcome`, `player{op:'reconnected'}`, et le bot
rend la main. Sinon : `error{code:'NAME_TAKEN'}` (pseudo déjà connecté) ou
`error{code:'GAME_FULL'}` (partie commencée, aucun siège de ce nom).
