/**
 * IA basique des bots : à partir d'un état et d'un joueur, renvoie UNE action
 * légale (le même format que les actions humaines). L'hôte l'appelle en boucle
 * tant que c'est au tour du bot.
 *
 * Module pur, sans hasard propre (les décisions sont déterministes pour un état
 * donné ; le hasard des combats vient des règles). Heuristiques :
 *  - Renfort   : cartes échangées dès que possible ; troupes placées sur les
 *                frontières les plus menacées, priorité aux continents presque acquis.
 *  - Attaque   : n'attaque qu'avec un avantage numérique ; préfère finir un
 *                continent, casser celui d'un adversaire ou éliminer un joueur.
 *  - Déplacement : ramène les troupes de l'intérieur vers la frontière la plus menacée.
 */
import { TERRITORIES, CONTINENTS, territoriesOf } from './map.js';
import { ownedTerritories, enemyNeighbors, connectedOwned, getPlayer } from './state.js';
import { findValidSets } from './cards.js';
import { validateAction, possibleMoves } from './rules.js';

/** Point d'entrée : action à jouer maintenant. */
export function decideBotAction(state, playerId) {
  const action = chooseAction(state, playerId);
  // Filet de sécurité : si l'heuristique propose une action illégale, on tente une sortie propre.
  if (validateAction(state, action) === null) return action;
  const fallback = { type: 'END_PHASE', playerId };
  if (validateAction(state, fallback) === null) return fallback;
  return null; // rien à faire (ne devrait pas arriver)
}

function chooseAction(state, playerId) {
  const turn = state.turn;
  const player = getPlayer(state, playerId);

  if (turn.pendingOccupy) return decideOccupy(state, playerId);

  // Échange de cartes (obligatoire ou opportuniste en phase de renfort)
  if (turn.mustExchange || (turn.phase === 'reinforce' && player.cards.length >= 3)) {
    const set = bestSet(state, player);
    if (set) return { type: 'EXCHANGE_CARDS', playerId, cardIds: set.map((c) => c.id) };
  }

  if (turn.reinforcements > 0) return decidePlacement(state, playerId);

  if (turn.phase === 'attack') return decideAttack(state, playerId);
  if (turn.phase === 'fortify') return decideFortify(state, playerId);
  return { type: 'END_PHASE', playerId };
}

// ───────────────────────────── Évaluation ─────────────────────────────

/** Menace pesant sur un territoire : troupes ennemies adjacentes / troupes propres. */
function threat(state, tid) {
  const enemies = enemyNeighbors(state, tid);
  if (enemies.length === 0) return 0;
  const enemyTroops = enemies.reduce((s, n) => s + state.territories[n].troops, 0);
  return (enemyTroops + 1) / state.territories[tid].troops;
}

/** Part du continent déjà possédée (0..1) par un joueur. */
function continentShare(state, continentId, playerId) {
  const ts = territoriesOf(continentId);
  const owned = ts.filter((t) => state.territories[t].owner === playerId).length;
  return owned / ts.length;
}

/** Intérêt stratégique d'un territoire : continent presque acquis → valeur haute. */
function territoryValue(state, tid, playerId) {
  const c = TERRITORIES[tid].continent;
  const share = continentShare(state, c, playerId);
  return CONTINENTS[c].bonus * share * share;
}

// ───────────────────────────── Décisions ─────────────────────────────

function decideOccupy(state, playerId) {
  const { from, to, min, max } = state.turn.pendingOccupy;
  const fromThreat = enemyNeighbors(state, from).length;
  const toThreat = enemyNeighbors(state, to).length;
  let count;
  if (fromThreat === 0) count = max; // l'arrière n'a plus besoin de garnison
  else if (toThreat === 0) count = min; // le territoire conquis est sûr
  else count = Math.max(min, Math.ceil((max * toThreat) / (toThreat + fromThreat)));
  return { type: 'OCCUPY', playerId, count: Math.min(max, Math.max(min, count)) };
}

function bestSet(state, player) {
  const sets = findValidSets(player.cards);
  if (sets.length === 0) return null;
  // Préfère un triplet contenant un territoire possédé (bonus +2), puis épargne les jokers.
  const score = (set) =>
    (set.some((c) => c.territory && state.territories[c.territory]?.owner === player.id) ? 10 : 0) -
    set.filter((c) => c.symbol === 'joker').length;
  sets.sort((a, b) => score(b) - score(a));
  return sets[0];
}

function decidePlacement(state, playerId) {
  const owned = ownedTerritories(state, playerId);
  const border = owned.filter((t) => enemyNeighbors(state, t).length > 0);
  const candidates = border.length ? border : owned;
  let best = candidates[0];
  let bestScore = -Infinity;
  for (const t of candidates) {
    const s = threat(state, t) * 2 + territoryValue(state, t, playerId) + attackPotential(state, t, playerId);
    if (s > bestScore) {
      bestScore = s;
      best = t;
    }
  }
  const remaining = state.turn.reinforcements;
  // Place par paquets pour répartir sur plusieurs frontières si besoin.
  const count = remaining <= 3 ? remaining : Math.ceil(remaining / 2);
  return { type: 'PLACE_TROOPS', playerId, territory: best, count };
}

/** Potentiel offensif : plus le voisin ennemi le plus faible est faible, plus c'est intéressant. */
function attackPotential(state, tid, playerId) {
  const enemies = enemyNeighbors(state, tid);
  if (!enemies.length) return 0;
  const weakest = Math.min(...enemies.map((n) => state.territories[n].troops));
  const value = Math.max(...enemies.map((n) => territoryValue(state, n, playerId) + 1));
  return value / (weakest + 1);
}

function decideAttack(state, playerId) {
  const moves = possibleMoves(state, playerId).attacks;
  let best = null;
  let bestScore = 0;
  for (const m of moves) {
    const a = state.territories[m.from].troops - 1; // troupes engageables
    const d = state.territories[m.to].troops;
    if (a < 2 && d >= 1 && a <= d) continue; // pas d'avantage
    let score = a - d; // avantage brut
    if (a <= d) continue; // n'attaque qu'en supériorité
    const defenderId = state.territories[m.to].owner;
    score += territoryValue(state, m.to, playerId) * 2; // finir un continent
    if (continentShare(state, TERRITORIES[m.to].continent, defenderId) === 1) score += CONTINENTS[TERRITORIES[m.to].continent].bonus; // casser un continent
    if (ownedTerritories(state, defenderId).length === 1) score += 6; // éliminer (cartes)
    if (state.turn.lastAttack?.from === m.from && state.turn.lastAttack?.to === m.to) score += 1; // continuité
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  if (!best) return { type: 'END_PHASE', playerId };
  return { type: 'ATTACK', playerId, from: best.from, to: best.to, dice: best.maxDice };
}

function decideFortify(state, playerId) {
  const owned = ownedTerritories(state, playerId);
  const interior = owned.filter((t) => enemyNeighbors(state, t).length === 0 && state.territories[t].troops > 1);
  let best = null;
  let bestScore = 0;
  for (const from of interior) {
    for (const to of connectedOwned(state, from)) {
      const th = threat(state, to);
      if (th <= 0) continue;
      const score = th * (state.territories[from].troops - 1);
      if (score > bestScore) {
        bestScore = score;
        best = { from, to, count: state.territories[from].troops - 1 };
      }
    }
  }
  if (best) return { type: 'FORTIFY', playerId, ...best };
  // Sinon : rééquilibrer entre deux frontières si l'une est très chargée et l'autre très menacée
  const border = owned.filter((t) => state.territories[t].troops > 3);
  for (const from of border) {
    for (const to of connectedOwned(state, from)) {
      if (threat(state, to) > threat(state, from) * 2) {
        const count = Math.floor((state.territories[from].troops - 1) / 2);
        if (count > 0) return { type: 'FORTIFY', playerId, from, to, count };
      }
    }
  }
  return { type: 'END_PHASE', playerId };
}
