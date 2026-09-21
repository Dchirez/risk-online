# Sécurité — Risk en ligne

Ce document décrit le modèle de menace, les failles trouvées lors de l'audit du
21/09/2026 (toutes démontrées par une attaque réelle avant correction), les
défenses en place et les risques qui restent.

## Modèle de menace

- **Le serveur est l'autorité.** Tout client est supposé hostile : il peut forger
  n'importe quel message JSON, dans n'importe quel ordre, à n'importe quel débit.
- **Ce qu'on protège** : l'équité (dés, cartes, coups), la confidentialité (mains
  des autres, messages privés, jetons), la disponibilité du serveur, et les places
  des joueurs.
- **Hors périmètre** : en mode sans serveur (onglets du même navigateur), l'hôte
  tourne dans l'onglet du créateur, qui a donc tout pouvoir sur sa partie. Seul le
  mode serveur (`wss://risk.skayzax.fr/ws`) est protégé.

## Failles trouvées et corrigées

| # | Gravité | Faille | Démonstration avant correction |
|---|---|---|---|
| 1 | Critique | Un message de 4 octets, `null`, faisait planter le serveur | Processus arrêté (`TypeError` sur `msg.type`), tous les joueurs déconnectés, répétable en boucle |
| 2 | Critique | Nombre de troupes envoyé en texte (`count: "5"`) | 4 troupes + "5" → **"45" troupes** (concaténation de chaînes) |
| 3 | Haute | Graine des dés = heure de création, générateur mulberry32 | Graine retrouvée en **5,5 s** à partir de la seule répartition publique des territoires → paquet de cartes entier et tous les dés futurs connus |
| 4 | Haute | Graine et code de partie choisis par le client à la création | `settings: { seed, id }` repris tels quels |
| 5 | Haute | Jetons de reconnexion, codes et identifiants issus de `Math.random` | Sorties entièrement dérivées de `Math.random`, dont l'état se reconstitue depuis des identifiants visibles de tous ; jeton de 41 bits |
| 6 | Haute | Actions d'hôte acceptées par le canal des coups | Un joueur non créateur ajoutait un **joueur fantôme** (partie bloquée à son tour) et **démarrait la partie** lui-même |
| 7 | Moyenne | Reprise de place par pseudo | Pendant une coupure, un inconnu tapant « Alice » prenait sa place **et invalidait son jeton** : la vraie Alice était refusée |
| 8 | Moyenne | Aucune limite de débit, de taille de message ni de nombre de parties | Messages jusqu'à 100 Mo (défaut de `ws`), inondation libre |
| 9 | Basse | Joueur homonyme d'un spectateur | Messages `#privés` pouvant arriver au mauvais destinataire |
| 10 | Basse | Identifiants en tableau (`["alaska"]`) et réglages mal typés (`"6"`, `6.5`) | Acceptés par conversion implicite |
| 11 | Basse | Mentions `@constructor`, `@toString` | Affichées « @Object » (recherche dans un objet ordinaire) |

## Défenses en place

**Validation stricte (moteur de règles).** Chaque champ d'une action doit avoir le
type exact attendu : entier JavaScript réel, identifiant de territoire en texte
et propre à la carte (`Object.hasOwn`), jamais de conversion implicite. Seuls six
types d'action sont acceptés d'un client (`PLACE_TROOPS`, `EXCHANGE_CARDS`,
`ATTACK`, `OCCUPY`, `END_PHASE`, `FORTIFY`) ; l'identité vient de la connexion.

**Aléa cryptographique.** Les dés et mélanges utilisent ChaCha20 en mode compteur
(vérifié contre le vecteur officiel de la RFC 8439), avec une clé de 256 bits
tirée de `crypto.getRandomValues`. La clé ne quitte jamais l'hôte. Jetons de
reconnexion de 128 bits, codes de partie tirés uniformément, identifiants
aléatoires : tout vient du générateur cryptographique, qui échoue fermé plutôt que
de retomber sur `Math.random`. Le serveur Node 18 installe `globalThis.crypto`
au démarrage (`server/crypto-polyfill.js`).

**Réglages filtrés.** À la création, seuls `maxPlayers` (entier 5 à 7),
`botDelayMs` (0 à 5000) et `mapId` (catalogue) sont retenus. Le code de partie est
imposé par le serveur.

**Places protégées.** Le jeton d'origine prime toujours. Une reprise par pseudo
reçoit un jeton distinct, révoqué dès que le vrai joueur revient ; l'intrus est
délogé et prévenu (`SEAT_TAKEN`). Pseudos uniques entre joueurs et spectateurs.

**Confidentialité.** Chaque client reçoit une vue redactée : ni les mains des
autres, ni le paquet, ni la défausse, ni la clé des dés, ni les jetons d'autrui,
ni les messages privés qui ne lui sont pas destinés (y compris dans l'historique
renvoyé à la reconnexion).

**Serveur.** Aucun message ne peut faire tomber le processus (JSON inattendu
filtré, gestionnaire d'erreur sur chaque socket, filet de sécurité autour du
traitement). Messages texte uniquement, 32 Ko maximum. Débit limité par connexion
(seau à jetons : 30 messages/s, rafale de 60 ; chat 1/s, rafale de 8), connexion
coupée après 40 dépassements. 500 parties simultanées au plus. Origine de
navigateur vérifiée (le site, sa variante www, localhost, et `ALLOWED_ORIGINS`).
Sauvegardes relues avec prudence (nom de fichier et code validés, jamais de chemin).

**Affichage.** Le chat échappe tout le texte libre ; les pseudos sont limités à
`[A-Za-z0-9_-]{2,16}` ; les recherches par pseudo passent par des `Map`.

## Tests

| Fichier | Contenu |
|---|---|
| `test/security.test.js` | 28 tests : usurpation, actions d'hôte, 44 messages malformés, confusion de types, clés de prototype, **fuzzing de 4 000 messages hostiles avec vérification des invariants à chaque pas**, confidentialité de tout le trafic reçu par un adversaire et un spectateur, injection HTML dans le chat, jetons et codes (entropie, uniformité, indépendance de `Math.random`), vol de place, privilèges, ChaCha20, équité des dés (khi-deux sur 60 000 lancers), sauvegardes |
| `test/server.security.test.js` | 10 tests avec de vraies connexions WebSocket : charges utiles piégées dont `null`, message binaire et géant, inondation, anti-spam du chat, filtrage des réglages, graine imposée, plafond de parties, une connexion = une partie, origines, sauvegardes piégées |

Chaque test de faille corrigée rappelle la faille d'origine dans son intitulé.
Les tests serveur nécessitent `cd server && npm install` ; sans cela, ils sont
ignorés et le signalent.

## Risques résiduels et recommandations

- **Reprise par pseudo.** Voulue pour qu'un joueur change d'appareil. Pendant une
  coupure, un inconnu connaissant le lien et le pseudo peut occuper la place
  jusqu'au retour du vrai joueur, qui la récupère avec son jeton. Si ce risque
  devient gênant, on pourra exiger l'accord du créateur pour une reprise sans jeton.
- **Énumération des codes de partie.** 30 bits, et la limite de débit est par
  connexion. Derrière nginx, toutes les connexions semblent venir de 127.0.0.1,
  donc la limitation par adresse IP se fait au niveau du proxy :

  ```nginx
  limit_conn_zone $binary_remote_addr zone=risk_conn:10m;
  limit_req_zone  $binary_remote_addr zone=risk_req:10m rate=5r/s;
  location /ws {
      limit_conn risk_conn 10;
      limit_req  zone=risk_req burst=20 nodelay;
      # … configuration existante …
  }
  ```

  L'impact reste limité : regarder une partie, ou rejoindre un salon ouvert.
- **Jeton dans `localStorage`.** Une injection de script le volerait. Le chat est
  échappé et les pseudos sont restreints, ce que les tests vérifient ; toute
  nouvelle zone d'affichage de texte libre devra suivre la même règle.
- **Mode sans serveur.** Le créateur héberge la partie dans son onglet et peut
  donc tricher. À réserver aux essais entre proches.
