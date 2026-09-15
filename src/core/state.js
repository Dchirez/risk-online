/**
 * État de partie : structure de données sérialisable (JSON pur) + helpers de
 * lecture. Aucune mutation ici : les transitions sont dans rules.js.
 *
 * ┌─ GameState ─────────────────────────────────────────────────────────────┐
 * │ id            : code de partie (ex. "K7Q2ZP")                             │
 * │ version       : entier incrémenté à chaque transition (sync réseau)      │
 * │ status        : 'lobby' | 'setup' | 'playing' | 'finished'               │
 * │ settings      : { maxPlayers, botDelayMs }                               │
 * │ players[]     : { id, name, color, type:'human'|'bot', connected,        │
 * │                   controlledByBot, alive, cards[], cardCount }           │
 * │ territories   : { [tid]: { owner: playerId|null, troops } }              │
 * │ turn          : { playerId, phase, reinforcements, conquered,            │
 * │                   pendingOccupy, mustExchange, attacks }                 │
 * │ cards         : { deck[], discard[], exchanges }                         │
 * │ setup         : { remaining: { [playerId]: n } }  (phase de placement)   │
 * │ turnNumber, winner, rng: { seed, count }, log[]                          │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Phases : 'setup' (placement initial) → 'reinforce' → 'attack' → 'fortify'
 */
import { TERRITORY_IDS, TERRITORIES, CONTINENTS, territoriesOf } from './map.js';
import { createRng } from './dice.js';

export const PHASES = ['setup', 'reinforce', 'attack', 'fortify'];
export const PHASE_LABELS = {
  setup: 'Placement initial',
  reinforce: 'Renfort',
  attack: 'Attaque',
  fortify: 'Déplacement',
};

export const PLAYER_COLORS = [
  { id: 'red', hex: '#e74c3c', name: 'Rouge' },
  { id: 'blue', hex: '#3498db', name: 'Bleu' },
  { id: 'green', hex: '#2ecc71', name: 'Vert' },
  { id: 'yellow', hex: '#f1c40f', name: 'Jaune' },
  { id: 'purple', hex: '#9b59b6', name: 'Violet' },
  { id: 'orange', hex: '#e67e22', name: 'Orange' },
  { id: 'cyan', hex: '#1abc9c', name: 'Turquoise' },
];

export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 7;

/**
 * Troupes de départ par joueur : une par territoire reçu + un supplément qui
 * décroît avec le nombre de joueurs (calibré sur la règle classique :
 * 42 territoires → 25/20/18 troupes à 5/6/7 joueurs).
 */
export function initialTroops(playerCount) {
  return Math.ceil(TERRITORY_IDS.length / playerCount) + Math.round(80 / playerCount);
}

/** Nombre de troupes placées par joueur et par tour pendant la phase de placement initial. */
export const SETUP_BATCH = 3;

export function createPlayer({ id, name, type = 'human', colorIndex = 0 }) {
  return {
    id,
    name,
    color: PLAYER_COLORS[colorIndex % PLAYER_COLORS.length].id,
    type, // 'human' | 'bot'
    connected: type === 'bot' ? true : false,
    controlledByBot: type === 'bot', // vrai aussi quand un humain déconnecté est remplacé
    alive: true,
    cards: [], // cartes en main (masquées aux autres joueurs par redactStateFor)
    cardCount: 0,
  };
}

/** État de lobby (avant démarrage). */
export function createLobbyState({ id, maxPlayers = 6, seed, botDelayMs = 700 }) {
  return {
    id,
    version: 0,
    status: 'lobby',
    settings: { maxPlayers, botDelayMs },
    players: [],
    territories: {},
    turn: null,
    cards: { deck: [], discard: [], exchanges: 0 },
    setup: null,
    turnNumber: 0,
    winner: null,
    rng: createRng(seed),
    log: [],
  };
}

/** Copie profonde (l'état est du JSON pur). */
export function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

export function serialize(state) {
  return JSON.stringify(state);
}
export function deserialize(json) {
  return JSON.parse(json);
}

// ───────────────────────── Helpers de lecture ─────────────────────────

export function getPlayer(state, playerId) {
  return state.players.find((p) => p.id === playerId) ?? null;
}

export function activePlayer(state) {
  return state.turn ? getPlayer(state, state.turn.playerId) : null;
}

export function playerHex(player) {
  return PLAYER_COLORS.find((c) => c.id === player?.color)?.hex ?? '#888';
}

export function ownedTerritories(state, playerId) {
  return TERRITORY_IDS.filter((t) => state.territories[t]?.owner === playerId);
}

export function continentsOwned(state, playerId) {
  return Object.keys(CONTINENTS).filter((c) =>
    territoriesOf(c).every((t) => state.territories[t]?.owner === playerId),
  );
}

/** Renforts de début de tour : max(3, territoires/3) + bonus continents. */
export function computeReinforcements(state, playerId) {
  const n = ownedTerritories(state, playerId).length;
  const base = Math.max(3, Math.floor(n / 3));
  const bonus = continentsOwned(state, playerId).reduce((s, c) => s + CONTINENTS[c].bonus, 0);
  return { base, bonus, total: base + bonus };
}

/** Voisins ennemis d'un territoire (pour l'IA et l'UI). */
export function enemyNeighbors(state, tid) {
  const owner = state.territories[tid].owner;
  return TERRITORIES[tid].neighbors.filter((n) => state.territories[n].owner !== owner);
}

/**
 * Territoires atteignables depuis `from` en ne traversant que des territoires
 * du même propriétaire (règle de déplacement "en chaîne").
 */
export function connectedOwned(state, from) {
  const owner = state.territories[from].owner;
  const seen = new Set([from]);
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop();
    for (const n of TERRITORIES[cur].neighbors) {
      if (!seen.has(n) && state.territories[n].owner === owner) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  seen.delete(from);
  return [...seen];
}

export function alivePlayers(state) {
  return state.players.filter((p) => p.alive);
}

/**
 * Vue de l'état destinée à UN joueur : les cartes des autres sont masquées
 * (seul `cardCount` reste), le paquet et la défausse aussi.
 * C'est cette vue que l'hôte envoie sur le réseau.
 */
export function redactStateFor(state, playerId) {
  const s = cloneState(state);
  for (const p of s.players) {
    if (p.id !== playerId) p.cards = [];
  }
  s.cards = { deckCount: state.cards.deck.length, discardCount: state.cards.discard.length, exchanges: state.cards.exchanges };
  delete s.rng;
  return s;
}
