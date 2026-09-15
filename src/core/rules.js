/**
 * Moteur de règles : la SEULE façon de faire évoluer un GameState.
 *
 *   applyAction(state, action) → { state: nouvelState, events: [...] }
 *   validateAction(state, action) → null | "message d'erreur"
 *
 * Module pur, déterministe (le hasard vient de state.rng), sans effet de bord.
 * Il tourne aujourd'hui dans le navigateur (hôte local) et tournera tel quel
 * sur le serveur Node demain.
 *
 * ── Actions de joueur ──────────────────────────────────────────────────────
 *   { type:'PLACE_TROOPS', playerId, territory, count }
 *   { type:'EXCHANGE_CARDS', playerId, cardIds:[a,b,c] }
 *   { type:'ATTACK', playerId, from, to, dice }        dice ∈ 1..3
 *   { type:'OCCUPY', playerId, count }                 après une conquête
 *   { type:'END_PHASE', playerId }                     renfort→attaque→déplacement→fin
 *   { type:'FORTIFY', playerId, from, to, count }      termine le tour
 * ── Actions d'hôte (lobby / gestion) ───────────────────────────────────────
 *   { type:'ADD_PLAYER', player:{id,name,type} }
 *   { type:'REMOVE_PLAYER', playerId }
 *   { type:'SET_CONNECTED', playerId, connected, controlledByBot }
 *   { type:'START_GAME' }
 *
 * ── Événements produits ────────────────────────────────────────────────────
 *   GAME_STARTED, TURN_STARTED, TROOPS_PLACED, CARDS_EXCHANGED, COMBAT,
 *   TERRITORY_CONQUERED, PLAYER_ELIMINATED, CARD_DRAWN, PHASE_CHANGED,
 *   FORTIFIED, GAME_OVER, PLAYER_JOINED, PLAYER_LEFT
 */
import { TERRITORY_IDS, TERRITORIES, areAdjacent } from './map.js';
import { shuffle, resolveCombat, nextInt } from './dice.js';
import { createDeck, isValidSet, exchangeBonus } from './cards.js';
import {
  cloneState,
  createPlayer,
  getPlayer,
  ownedTerritories,
  computeReinforcements,
  connectedOwned,
  alivePlayers,
  initialTroops,
  SETUP_BATCH,
  MIN_PLAYERS,
  MAX_PLAYERS,
} from './state.js';

const MAX_LOG = 80;

// ═══════════════════════════════ Validation ═══════════════════════════════

/** Renvoie null si l'action est légale, sinon un message d'erreur (français). */
export function validateAction(state, action) {
  if (!action || typeof action.type !== 'string') return 'Action invalide';
  const t = action.type;

  // ── Actions d'hôte ──
  if (t === 'ADD_PLAYER') {
    if (state.status !== 'lobby') return 'La partie a déjà commencé';
    if (state.players.length >= state.settings.maxPlayers) return 'Partie complète';
    if (!action.player?.id || !action.player?.name) return 'Joueur invalide';
    if (state.players.some((p) => p.id === action.player.id)) return 'Identifiant déjà utilisé';
    if (state.players.some((p) => p.name.toLowerCase() === action.player.name.toLowerCase()))
      return 'Pseudo déjà pris';
    return null;
  }
  if (t === 'REMOVE_PLAYER') {
    if (state.status !== 'lobby') return 'Impossible de retirer un joueur en cours de partie';
    if (!getPlayer(state, action.playerId)) return 'Joueur inconnu';
    return null;
  }
  if (t === 'SET_CONNECTED') {
    if (!getPlayer(state, action.playerId)) return 'Joueur inconnu';
    return null;
  }
  if (t === 'START_GAME') {
    if (state.status !== 'lobby') return 'Déjà démarrée';
    if (state.players.length < MIN_PLAYERS || state.players.length > MAX_PLAYERS)
      return `Il faut entre ${MIN_PLAYERS} et ${MAX_PLAYERS} joueurs`;
    return null;
  }

  // ── Actions de joueur ──
  if (state.status !== 'setup' && state.status !== 'playing') return 'La partie n’est pas en cours';
  const player = getPlayer(state, action.playerId);
  if (!player) return 'Joueur inconnu';
  if (!player.alive) return 'Joueur éliminé';
  if (state.turn.playerId !== action.playerId) return 'Ce n’est pas votre tour';
  const turn = state.turn;

  switch (t) {
    case 'PLACE_TROOPS': {
      const terr = state.territories[action.territory];
      if (!terr) return 'Territoire inconnu';
      if (terr.owner !== player.id) return 'Ce territoire ne vous appartient pas';
      const count = Number(action.count);
      if (!Number.isInteger(count) || count < 1) return 'Nombre de troupes invalide';
      if (turn.phase === 'setup') {
        if (count > turn.reinforcements) return 'Pas assez de troupes à placer';
        return null;
      }
      if (turn.phase !== 'reinforce' && turn.phase !== 'attack') return 'Placement impossible dans cette phase';
      if (turn.mustExchange) return 'Vous devez d’abord échanger des cartes (5 cartes ou plus)';
      if (count > turn.reinforcements) return 'Pas assez de renforts';
      if (turn.pendingOccupy) return 'Terminez d’abord l’occupation du territoire conquis';
      return null;
    }
    case 'EXCHANGE_CARDS': {
      if (turn.phase !== 'reinforce' && turn.phase !== 'attack') return 'Échange impossible dans cette phase';
      if (turn.phase === 'attack' && player.cards.length < 6 && !turn.mustExchange)
        return 'En phase d’attaque, l’échange n’est possible qu’avec 6 cartes ou plus';
      if (turn.pendingOccupy) return 'Terminez d’abord l’occupation du territoire conquis';
      const ids = action.cardIds;
      if (!Array.isArray(ids) || ids.length !== 3 || new Set(ids).size !== 3) return 'Sélectionnez 3 cartes différentes';
      const cards = ids.map((id) => player.cards.find((c) => c.id === id));
      if (cards.some((c) => !c)) return 'Carte non possédée';
      if (!isValidSet(cards)) return 'Combinaison invalide (3 identiques ou 3 différentes)';
      return null;
    }
    case 'END_PHASE': {
      if (turn.phase === 'setup') return 'Placez toutes vos troupes';
      if (turn.mustExchange) return 'Vous devez d’abord échanger des cartes';
      if (turn.pendingOccupy) return 'Terminez d’abord l’occupation du territoire conquis';
      if (turn.reinforcements > 0) return 'Placez d’abord tous vos renforts';
      return null;
    }
    case 'ATTACK': {
      if (turn.phase !== 'attack') return 'Vous n’êtes pas en phase d’attaque';
      if (turn.mustExchange) return 'Vous devez d’abord échanger des cartes';
      if (turn.pendingOccupy) return 'Terminez d’abord l’occupation du territoire conquis';
      if (turn.reinforcements > 0) return 'Placez d’abord vos renforts';
      const from = state.territories[action.from];
      const to = state.territories[action.to];
      if (!from || !to) return 'Territoire inconnu';
      if (from.owner !== player.id) return 'Le territoire attaquant ne vous appartient pas';
      if (to.owner === player.id) return 'Vous ne pouvez pas attaquer votre propre territoire';
      if (!areAdjacent(action.from, action.to)) return 'Territoires non adjacents';
      if (from.troops < 2) return 'Il faut au moins 2 troupes pour attaquer';
      const dice = Number(action.dice);
      if (!Number.isInteger(dice) || dice < 1 || dice > 3) return 'Nombre de dés invalide';
      if (dice > from.troops - 1) return 'Pas assez de troupes pour autant de dés';
      return null;
    }
    case 'OCCUPY': {
      if (!turn.pendingOccupy) return 'Aucune occupation en attente';
      const { min, max } = turn.pendingOccupy;
      const count = Number(action.count);
      if (!Number.isInteger(count) || count < min || count > max)
        return `Déplacez entre ${min} et ${max} troupes`;
      return null;
    }
    case 'FORTIFY': {
      if (turn.phase !== 'fortify') return 'Vous n’êtes pas en phase de déplacement';
      const from = state.territories[action.from];
      const to = state.territories[action.to];
      if (!from || !to) return 'Territoire inconnu';
      if (from.owner !== player.id || to.owner !== player.id) return 'Les deux territoires doivent vous appartenir';
      if (action.from === action.to) return 'Choisissez deux territoires différents';
      if (!connectedOwned(state, action.from).includes(action.to)) return 'Territoires non reliés par vos territoires';
      const count = Number(action.count);
      if (!Number.isInteger(count) || count < 1 || count > from.troops - 1)
        return 'Il faut laisser au moins 1 troupe sur le territoire de départ';
      return null;
    }
    default:
      return `Type d’action inconnu : ${t}`;
  }
}

// ═══════════════════════════════ Application ═══════════════════════════════

/**
 * Applique une action. Lève une erreur si elle est illégale (l'appelant
 * — l'hôte — doit valider avant, ou attraper l'exception).
 */
export function applyAction(input, action) {
  const err = validateAction(input, action);
  if (err) throw new Error(err);
  const state = cloneState(input);
  const events = [];
  const emit = (e) => events.push({ ...e, at: state.version + 1 });

  switch (action.type) {
    case 'ADD_PLAYER':
      state.players.push(
        createPlayer({
          id: action.player.id,
          name: action.player.name,
          type: action.player.type ?? 'human',
          colorIndex: firstFreeColor(state),
        }),
      );
      emit({ type: 'PLAYER_JOINED', playerId: action.player.id });
      break;
    case 'REMOVE_PLAYER':
      state.players = state.players.filter((p) => p.id !== action.playerId);
      emit({ type: 'PLAYER_LEFT', playerId: action.playerId });
      break;
    case 'SET_CONNECTED': {
      const p = getPlayer(state, action.playerId);
      if (action.connected !== undefined) p.connected = !!action.connected;
      if (action.controlledByBot !== undefined) p.controlledByBot = !!action.controlledByBot;
      break;
    }
    case 'START_GAME':
      startGame(state, emit);
      break;
    case 'PLACE_TROOPS':
      placeTroops(state, action, emit);
      break;
    case 'EXCHANGE_CARDS':
      exchangeCards(state, action, emit);
      break;
    case 'END_PHASE':
      endPhase(state, emit);
      break;
    case 'ATTACK':
      attack(state, action, emit);
      break;
    case 'OCCUPY':
      occupy(state, action, emit);
      break;
    case 'FORTIFY':
      fortify(state, action, emit);
      break;
  }

  // Compteurs de cartes visibles par tous
  for (const p of state.players) p.cardCount = p.cards.length;
  state.version += 1;
  for (const e of events) pushLog(state, e);
  return { state, events };
}

function firstFreeColor(state) {
  const used = new Set(state.players.map((p) => p.color));
  const idx = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'cyan'].findIndex((c) => !used.has(c));
  return idx < 0 ? state.players.length : idx;
}

function pushLog(state, e) {
  state.log.push(e);
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
}

// ─────────────────────────────── Démarrage ───────────────────────────────

function startGame(state, emit) {
  // Ordre de jeu aléatoire
  let r = state.rng;
  [state.players, r] = shuffle(r, state.players);

  // Distribution aléatoire des territoires (règle rapide, standard en ligne)
  let ids;
  [ids, r] = shuffle(r, TERRITORY_IDS);
  const n = state.players.length;
  ids.forEach((tid, i) => {
    state.territories[tid] = { owner: state.players[i % n].id, troops: 1 };
  });

  // Troupes restantes à placer par joueur
  const perPlayer = initialTroops(n);
  state.setup = { remaining: {} };
  for (const p of state.players) {
    const owned = ownedTerritories(state, p.id).length;
    state.setup.remaining[p.id] = perPlayer - owned;
  }

  // Paquet de cartes
  [state.cards.deck, r] = createDeck(r);
  state.rng = r;

  state.status = 'setup';
  state.turnNumber = 0;
  const first = state.players[0];
  state.turn = newTurn(first.id, 'setup', Math.min(SETUP_BATCH, state.setup.remaining[first.id]));
  emit({ type: 'GAME_STARTED', order: state.players.map((p) => p.id) });
  emit({ type: 'TURN_STARTED', playerId: first.id, phase: 'setup' });
}

function newTurn(playerId, phase, reinforcements) {
  return {
    playerId,
    phase,
    reinforcements,
    reinforcementDetail: null,
    conquered: false, // a conquis ≥1 territoire ce tour → pioche une carte
    pendingOccupy: null, // { from, to, min, moved, max } : troupes à déplacer sur le territoire conquis
    mustExchange: false,
    lastAttack: null, // { from, to } pour présélection UI/IA
  };
}

// ───────────────────────────── Placement ─────────────────────────────

function placeTroops(state, action, emit) {
  const turn = state.turn;
  state.territories[action.territory].troops += action.count;
  turn.reinforcements -= action.count;
  emit({ type: 'TROOPS_PLACED', playerId: action.playerId, territory: action.territory, count: action.count });

  if (turn.phase === 'setup') {
    state.setup.remaining[action.playerId] -= action.count;
    if (turn.reinforcements === 0) advanceSetup(state, emit);
  }
}

/** Phase de placement initial : passe au joueur suivant ayant encore des troupes, sinon démarre le jeu. */
function advanceSetup(state, emit) {
  const order = state.players;
  const remaining = state.setup.remaining;
  let idx = order.findIndex((p) => p.id === state.turn.playerId);
  for (let i = 1; i <= order.length; i++) {
    const p = order[(idx + i) % order.length];
    if (remaining[p.id] > 0) {
      state.turn = newTurn(p.id, 'setup', Math.min(SETUP_BATCH, remaining[p.id]));
      emit({ type: 'TURN_STARTED', playerId: p.id, phase: 'setup' });
      return;
    }
  }
  // Tout le monde a placé : début de la partie
  state.status = 'playing';
  state.setup = null;
  beginPlayerTurn(state, order[0].id, emit);
}

function beginPlayerTurn(state, playerId, emit) {
  state.turnNumber += 1;
  const detail = computeReinforcements(state, playerId);
  state.turn = newTurn(playerId, 'reinforce', detail.total);
  state.turn.reinforcementDetail = detail;
  const player = getPlayer(state, playerId);
  state.turn.mustExchange = player.cards.length >= 5;
  emit({ type: 'TURN_STARTED', playerId, phase: 'reinforce', reinforcements: detail.total, detail });
}

// ───────────────────────────── Cartes ─────────────────────────────

function exchangeCards(state, action, emit) {
  const player = getPlayer(state, action.playerId);
  const cards = action.cardIds.map((id) => player.cards.find((c) => c.id === id));
  player.cards = player.cards.filter((c) => !action.cardIds.includes(c.id));
  state.cards.discard.push(...cards);

  const bonus = exchangeBonus(state.cards.exchanges);
  state.cards.exchanges += 1;
  state.turn.reinforcements += bonus;

  // Bonus +2 sur UN territoire possédé figurant sur les cartes échangées
  const ownedOnCards = cards.find((c) => c.territory && state.territories[c.territory].owner === player.id);
  if (ownedOnCards) state.territories[ownedOnCards.territory].troops += 2;

  state.turn.mustExchange = player.cards.length >= 5;
  emit({
    type: 'CARDS_EXCHANGED',
    playerId: player.id,
    cardIds: action.cardIds,
    bonus,
    territoryBonus: ownedOnCards?.territory ?? null,
  });
}

function drawCard(state, player, emit) {
  if (state.cards.deck.length === 0) {
    if (state.cards.discard.length === 0) return;
    let r = state.rng;
    [state.cards.deck, r] = shuffle(r, state.cards.discard);
    state.cards.discard = [];
    state.rng = r;
  }
  const card = state.cards.deck.pop();
  player.cards.push(card);
  emit({ type: 'CARD_DRAWN', playerId: player.id });
}

// ───────────────────────────── Phases ─────────────────────────────

function endPhase(state, emit) {
  const turn = state.turn;
  if (turn.phase === 'reinforce') {
    turn.phase = 'attack';
    emit({ type: 'PHASE_CHANGED', playerId: turn.playerId, phase: 'attack' });
  } else if (turn.phase === 'attack') {
    turn.phase = 'fortify';
    emit({ type: 'PHASE_CHANGED', playerId: turn.playerId, phase: 'fortify' });
  } else if (turn.phase === 'fortify') {
    endTurn(state, emit);
  }
}

function endTurn(state, emit) {
  const turn = state.turn;
  const player = getPlayer(state, turn.playerId);
  if (turn.conquered) drawCard(state, player, emit);

  const alive = alivePlayers(state);
  if (alive.length === 1) {
    finish(state, alive[0].id, emit);
    return;
  }
  const order = state.players;
  let idx = order.findIndex((p) => p.id === turn.playerId);
  for (let i = 1; i <= order.length; i++) {
    const p = order[(idx + i) % order.length];
    if (p.alive) {
      beginPlayerTurn(state, p.id, emit);
      return;
    }
  }
}

function finish(state, winnerId, emit) {
  state.status = 'finished';
  state.winner = winnerId;
  state.turn = null;
  emit({ type: 'GAME_OVER', winner: winnerId });
}

// ───────────────────────────── Combat ─────────────────────────────

function attack(state, action, emit) {
  const turn = state.turn;
  const from = state.territories[action.from];
  const to = state.territories[action.to];
  const defenderId = to.owner;
  const defenderDice = Math.min(2, to.troops);

  let result;
  [result, state.rng] = resolveCombat(state.rng, action.dice, defenderDice);
  from.troops -= result.attackerLosses;
  to.troops -= result.defenderLosses;
  turn.lastAttack = { from: action.from, to: action.to };

  emit({
    type: 'COMBAT',
    attackerId: action.playerId,
    defenderId,
    from: action.from,
    to: action.to,
    ...result,
    conquered: to.troops === 0,
  });

  if (to.troops === 0) {
    // Conquête : le territoire change de main, l'occupation est en attente
    to.owner = action.playerId;
    turn.conquered = true;
    // Le minimum (autant de troupes que de dés) entre immédiatement : l'état
    // reste toujours valide (≥ 1 troupe partout). OCCUPY permet d'en envoyer plus.
    const movable = from.troops - 1;
    const min = Math.min(action.dice, movable);
    from.troops -= min;
    to.troops = min;
    turn.pendingOccupy = min === movable ? null : { from: action.from, to: action.to, min, moved: min, max: movable };
    emit({ type: 'TERRITORY_CONQUERED', playerId: action.playerId, from: action.from, territory: action.to, defenderId, moved: min });

    // Élimination ?
    const defender = getPlayer(state, defenderId);
    if (ownedTerritories(state, defenderId).length === 0) {
      defender.alive = false;
      const attacker = getPlayer(state, action.playerId);
      attacker.cards.push(...defender.cards);
      defender.cards = [];
      emit({ type: 'PLAYER_ELIMINATED', playerId: defenderId, by: action.playerId });
      if (attacker.cards.length >= 6) turn.mustExchange = true;
    }

    checkVictory(state, emit);
  }
}

/** `count` = total de troupes déplacées sur le territoire conquis (dont celles déjà entrées). */
function occupy(state, action, emit) {
  const { from, to, moved } = state.turn.pendingOccupy;
  const extra = action.count - moved;
  state.territories[from].troops -= extra;
  state.territories[to].troops += extra;
  state.turn.pendingOccupy = null;
  emit({ type: 'OCCUPIED', playerId: action.playerId, from, to, count: action.count });
}

function checkVictory(state, emit) {
  const alive = alivePlayers(state);
  if (alive.length === 1) finish(state, alive[0].id, emit);
}

// ───────────────────────────── Déplacement ─────────────────────────────

function fortify(state, action, emit) {
  state.territories[action.from].troops -= action.count;
  state.territories[action.to].troops += action.count;
  emit({ type: 'FORTIFIED', playerId: action.playerId, from: action.from, to: action.to, count: action.count });
  endTurn(state, emit);
}

// ═══════════════════════════ Aide : coups possibles ═══════════════════════════

/**
 * Résumé des coups possibles pour le joueur actif (utilisé par l'UI et l'IA).
 * Ne remplace pas validateAction : c'est un guide, pas une garantie.
 */
export function possibleMoves(state, playerId) {
  const out = { canPlace: [], attacks: [], fortifies: [], canEndPhase: false };
  if (!state.turn || state.turn.playerId !== playerId) return out;
  const turn = state.turn;
  const owned = ownedTerritories(state, playerId);

  if (turn.reinforcements > 0 && !turn.mustExchange && !turn.pendingOccupy) out.canPlace = owned;

  if (turn.phase === 'attack' && !turn.pendingOccupy && !turn.mustExchange && turn.reinforcements === 0) {
    for (const from of owned) {
      const troops = state.territories[from].troops;
      if (troops < 2) continue;
      for (const to of TERRITORIES[from].neighbors) {
        if (state.territories[to].owner !== playerId) {
          out.attacks.push({ from, to, maxDice: Math.min(3, troops - 1) });
        }
      }
    }
  }

  if (turn.phase === 'fortify') {
    for (const from of owned) {
      if (state.territories[from].troops < 2) continue;
      for (const to of connectedOwned(state, from)) {
        out.fortifies.push({ from, to, max: state.territories[from].troops - 1 });
      }
    }
  }

  out.canEndPhase = validateAction(state, { type: 'END_PHASE', playerId }) === null;
  return out;
}
