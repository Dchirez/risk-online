/**
 * Tests du cœur pur (règles, dés, cartes, carte, IA) — `npm test`.
 * Aucun DOM, aucun réseau : tout est déterministe grâce à la graine RNG.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMap, MAP_CATALOG } from '../src/core/map.js';

// La plupart des tests portent sur la carte du monde
const { TERRITORIES, TERRITORY_IDS, CONTINENTS, territoriesOf, areAdjacent } = getMap('world');
import { createRng, rollDice, resolveCombat, shuffle } from '../src/core/dice.js';
import { isValidSet, exchangeBonus, createDeck } from '../src/core/cards.js';
import { createLobbyState, computeReinforcements, connectedOwned, redactStateFor, initialTroops } from '../src/core/state.js';
import { applyAction, validateAction, possibleMoves } from '../src/core/rules.js';
import { decideBotAction } from '../src/core/bot.js';
import { parseChat, canSeeChat } from '../src/net/protocol.js';

// ───────────────────────────── Carte ─────────────────────────────

test('carte : 80 territoires, 6 continents, adjacences symétriques, graphe connexe', () => {
  assert.equal(TERRITORY_IDS.length, 80);
  assert.equal(Object.keys(CONTINENTS).length, 6);
  const sizes = Object.fromEntries(Object.keys(CONTINENTS).map((c) => [c, territoriesOf(c).length]));
  assert.deepEqual(sizes, { NA: 17, SA: 8, EU: 14, AF: 13, AS: 22, OC: 6 });
  for (const t of Object.values(TERRITORIES)) {
    assert.ok(t.neighbors.length >= 1, `${t.id} n’a aucun voisin`);
    assert.ok(Number.isFinite(t.pos.x) && Number.isFinite(t.pos.y));
    for (const n of t.neighbors) assert.ok(areAdjacent(n, t.id), `${t.id}↔${n} non symétrique`);
  }
  assert.ok(areAdjacent('alaska', 'kamchatka')); // par le bord de la carte
  assert.ok(areAdjacent('brazil', 'west_africa'));
  assert.ok(areAdjacent('venezuela', 'colombia'));
  assert.ok(!areAdjacent('japan', 'indochina'));
  // Tout territoire doit être atteignable depuis l'Alaska
  const seen = new Set(['alaska']);
  const stack = ['alaska'];
  while (stack.length) for (const n of TERRITORIES[stack.pop()].neighbors) if (!seen.has(n)) { seen.add(n); stack.push(n); }
  assert.equal(seen.size, 80);
});

// ───────────────────────────── Dés ─────────────────────────────

test('dés : déterministes pour une graine, triés décroissants, bornés 1..6', () => {
  const [a] = rollDice(createRng(42), 3);
  const [b] = rollDice(createRng(42), 3);
  assert.deepEqual(a, b);
  for (let seed = 0; seed < 50; seed++) {
    const [rolls] = rollDice(createRng(seed), 3);
    assert.ok(rolls.every((v) => v >= 1 && v <= 6));
    assert.ok(rolls[0] >= rolls[1] && rolls[1] >= rolls[2]);
  }
});

test('combat : pertes totales = nombre de paires comparées, égalité au défenseur', () => {
  for (let seed = 0; seed < 200; seed++) {
    const [r] = resolveCombat(createRng(seed), 3, 2);
    assert.equal(r.attackerLosses + r.defenderLosses, 2);
    // Vérification manuelle des paires
    let al = 0;
    for (let i = 0; i < 2; i++) if (r.attackerDice[i] <= r.defenderDice[i]) al++;
    assert.equal(r.attackerLosses, al);
  }
  const [r1] = resolveCombat(createRng(7), 1, 2);
  assert.equal(r1.attackerLosses + r1.defenderLosses, 1);
});

test('shuffle : permutation complète', () => {
  const [arr] = shuffle(createRng(3), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...arr].sort(), [1, 2, 3, 4, 5, 6]);
});

// ───────────────────────────── Cartes ─────────────────────────────

test('cartes : combinaisons valides et bonus progressifs', () => {
  const c = (symbol, territory = 'x') => ({ id: symbol + territory, symbol, territory });
  assert.ok(isValidSet([c('infantry'), c('infantry'), c('infantry')]));
  assert.ok(isValidSet([c('infantry'), c('cavalry'), c('artillery')]));
  assert.ok(!isValidSet([c('infantry'), c('infantry'), c('cavalry')]));
  assert.ok(isValidSet([c('infantry'), c('infantry'), c('joker')]));
  assert.ok(isValidSet([c('infantry'), c('cavalry'), c('joker')]));
  assert.equal(exchangeBonus(0), 4);
  assert.equal(exchangeBonus(5), 15);
  assert.equal(exchangeBonus(6), 20);
  assert.equal(exchangeBonus(7), 25);
  const [deck] = createDeck(createRng(1), getMap('world'));
  assert.equal(deck.length, TERRITORY_IDS.length + 2);
  assert.equal(deck.filter((c) => c.symbol === 'joker').length, 2);
});

// ───────────────────────────── Partie ─────────────────────────────

function lobbyWith(n, seed = 123, mapId = 'world') {
  let state = createLobbyState({ id: 'TEST', maxPlayers: n, seed, mapId });
  for (let i = 0; i < n; i++) {
    state = applyAction(state, { type: 'ADD_PLAYER', player: { id: `p${i}`, name: `Joueur${i}`, type: i === 0 ? 'human' : 'bot' } }).state;
  }
  return state;
}

test('lobby : 5 à 7 joueurs, pseudos uniques', () => {
  const s = lobbyWith(4);
  assert.equal(validateAction(s, { type: 'START_GAME' }), 'Il faut entre 5 et 7 joueurs');
  assert.ok(validateAction(s, { type: 'ADD_PLAYER', player: { id: 'z', name: 'joueur1' } }));
  assert.equal(validateAction(lobbyWith(5), { type: 'START_GAME' }), null);
});

test('démarrage : territoires tous distribués, troupes initiales cohérentes', () => {
  for (const n of [5, 6, 7]) {
    const { state } = applyAction(lobbyWith(n), { type: 'START_GAME' });
    assert.equal(state.status, 'setup');
    assert.equal(Object.keys(state.territories).length, TERRITORY_IDS.length);
    for (const p of state.players) {
      const owned = TERRITORY_IDS.filter((t) => state.territories[t].owner === p.id).length;
      assert.ok(owned >= Math.floor(TERRITORY_IDS.length / n));
      assert.equal(owned + state.setup.remaining[p.id], initialTroops(n, TERRITORY_IDS.length));
    }
    assert.equal(state.turn.phase, 'setup');
    assert.ok(state.turn.reinforcements >= 1 && state.turn.reinforcements <= 3);
  }
});

test('placement initial : seul le joueur actif place, sur ses territoires', () => {
  const { state } = applyAction(lobbyWith(5), { type: 'START_GAME' });
  const active = state.turn.playerId;
  const other = state.players.find((p) => p.id !== active).id;
  const mine = TERRITORY_IDS.find((t) => state.territories[t].owner === active);
  const theirs = TERRITORY_IDS.find((t) => state.territories[t].owner === other);
  assert.equal(validateAction(state, { type: 'PLACE_TROOPS', playerId: other, territory: theirs, count: 1 }), 'Ce n’est pas votre tour');
  assert.equal(validateAction(state, { type: 'PLACE_TROOPS', playerId: active, territory: theirs, count: 1 }), 'Ce territoire ne vous appartient pas');
  assert.equal(validateAction(state, { type: 'PLACE_TROOPS', playerId: active, territory: mine, count: 99 }), 'Pas assez de troupes à placer');
  const next = applyAction(state, { type: 'PLACE_TROOPS', playerId: active, territory: mine, count: state.turn.reinforcements }).state;
  assert.notEqual(next.turn.playerId, active);
});

/** Fait jouer les bots jusqu'à la fin (ou un plafond) et renvoie l'état final. */
function playOut(state, maxSteps = 20000) {
  let steps = 0;
  while (state.status !== 'finished' && steps < maxSteps) {
    const action = decideBotAction(state, state.turn.playerId);
    assert.ok(action, 'le bot doit toujours proposer une action');
    state = applyAction(state, action).state;
    steps++;
  }
  return { state, steps };
}

test('renforts : max(3, territoires/3) + continents', () => {
  const { state } = applyAction(lobbyWith(5, 9), { type: 'START_GAME' });
  const s = JSON.parse(JSON.stringify(state));
  for (const t of TERRITORY_IDS) s.territories[t] = { owner: 'p1', troops: 1 };
  for (const t of territoriesOf('OC')) s.territories[t].owner = 'p0';
  for (const t of territoriesOf('SA')) s.territories[t].owner = 'p0';
  const owned0 = territoriesOf('OC').length + territoriesOf('SA').length;
  const base0 = Math.max(3, Math.floor(owned0 / 3));
  const bonus0 = CONTINENTS.OC.bonus + CONTINENTS.SA.bonus;
  const r = computeReinforcements(s, 'p0');
  assert.deepEqual(r, { base: base0, bonus: bonus0, total: base0 + bonus0 });
  const r1 = computeReinforcements(s, 'p1');
  assert.equal(r1.base, Math.floor((TERRITORY_IDS.length - owned0) / 3));
  assert.equal(r1.bonus, CONTINENTS.NA.bonus + CONTINENTS.EU.bonus + CONTINENTS.AF.bonus + CONTINENTS.AS.bonus);
});

test('partie complète bots contre bots : se termine avec un vainqueur, invariants respectés', () => {
  for (const seed of [1, 2, 3]) {
    let { state } = applyAction(lobbyWith(6, seed), { type: 'START_GAME' });
    const res = playOut(state);
    state = res.state;
    assert.equal(state.status, 'finished', `seed ${seed} : partie non terminée après ${res.steps} coups`);
    assert.ok(state.winner);
    assert.ok(TERRITORY_IDS.every((t) => state.territories[t].owner === state.winner));
    assert.ok(TERRITORY_IDS.every((t) => state.territories[t].troops >= 1));
    assert.equal(state.players.filter((p) => p.alive).length, 1);
  }
});

test('invariants à chaque coup : troupes ≥ 1, un seul joueur actif, cartes cohérentes', () => {
  let { state } = applyAction(lobbyWith(5, 77), { type: 'START_GAME' });
  let steps = 0;
  let sawCombat = false;
  let sawExchange = false;
  while (state.status !== 'finished' && steps < 3000) {
    const action = decideBotAction(state, state.turn.playerId);
    const { state: next, events } = applyAction(state, action);
    if (events.some((e) => e.type === 'COMBAT')) sawCombat = true;
    if (events.some((e) => e.type === 'CARDS_EXCHANGED')) sawExchange = true;
    for (const t of TERRITORY_IDS) assert.ok(next.territories[t].troops >= 1, `${t} a ${next.territories[t].troops} troupes`);
    const totalCards = next.players.reduce((s, p) => s + p.cards.length, 0) + next.cards.deck.length + next.cards.discard.length;
    assert.equal(totalCards, TERRITORY_IDS.length + 2);
    assert.ok(next.version === state.version + 1);
    state = next;
    steps++;
  }
  assert.ok(sawCombat);
  assert.ok(sawExchange, 'au moins un échange de cartes en 3000 coups');
});

test('attaque : validations (adjacence, propriétaire, dés) et occupation après conquête', () => {
  let { state } = applyAction(lobbyWith(5, 5), { type: 'START_GAME' });
  // Avancer jusqu'à la phase d'attaque du premier tour
  while (state.status === 'setup' || state.turn.phase === 'reinforce') {
    state = applyAction(state, decideBotAction(state, state.turn.playerId)).state;
  }
  const me = state.turn.playerId;
  assert.equal(state.turn.phase, 'attack');
  const moves = possibleMoves(state, me);
  assert.ok(moves.attacks.length > 0);
  const m = moves.attacks[0];
  assert.equal(validateAction(state, { type: 'ATTACK', playerId: me, from: m.from, to: m.from, dice: 1 }), 'Vous ne pouvez pas attaquer votre propre territoire');
  assert.equal(validateAction(state, { type: 'ATTACK', playerId: me, from: m.from, to: m.to, dice: 9 }), 'Nombre de dés invalide');
  assert.equal(validateAction(state, { type: 'ATTACK', playerId: me, from: m.from, to: m.to, dice: m.maxDice }), null);

  // Forcer une conquête certaine : 20 troupes contre 1
  state.territories[m.from].troops = 20;
  state.territories[m.to].troops = 1;
  let conquered = false;
  for (let i = 0; i < 30 && !conquered; i++) {
    const { state: next, events } = applyAction(state, { type: 'ATTACK', playerId: me, from: m.from, to: m.to, dice: 3 });
    state = next;
    conquered = events.some((e) => e.type === 'TERRITORY_CONQUERED');
  }
  assert.ok(conquered);
  assert.equal(state.territories[m.to].owner, me);
  assert.ok(state.turn.pendingOccupy);
  assert.equal(validateAction(state, { type: 'ATTACK', playerId: me, from: m.from, to: m.to, dice: 1 }), 'Terminez d’abord l’occupation du territoire conquis');
  assert.ok(validateAction(state, { type: 'OCCUPY', playerId: me, count: 1 })); // < min (3 dés)
  assert.ok(state.territories[m.to].troops >= 1, 'le territoire conquis est occupé immédiatement');
  const max = state.turn.pendingOccupy.max;
  state = applyAction(state, { type: 'OCCUPY', playerId: me, count: max }).state;
  assert.equal(state.territories[m.from].troops, 1);
  assert.equal(state.turn.pendingOccupy, null);
  assert.ok(state.turn.conquered);
});

test('déplacement : en chaîne via ses territoires, termine le tour, pioche une carte si conquête', () => {
  let { state } = applyAction(lobbyWith(5, 11), { type: 'START_GAME' });
  while (state.status === 'setup' || state.turn.phase !== 'fortify') {
    state = applyAction(state, decideBotAction(state, state.turn.playerId)).state;
    if (state.turn?.phase === 'attack' && state.turn.reinforcements === 0 && !state.turn.pendingOccupy && !state.turn.mustExchange) {
      state = applyAction(state, { type: 'END_PHASE', playerId: state.turn.playerId }).state;
    }
  }
  const me = state.turn.playerId;
  const fm = possibleMoves(state, me).fortifies;
  if (fm.length) {
    const f = fm[0];
    assert.ok(connectedOwned(state, f.from).includes(f.to));
    const next = applyAction(state, { type: 'FORTIFY', playerId: me, ...f, count: f.max }).state;
    assert.notEqual(next.turn.playerId, me);
    assert.equal(next.territories[f.from].troops, 1);
  }
  const next = applyAction(state, { type: 'END_PHASE', playerId: me }).state;
  assert.notEqual(next.turn.playerId, me);
  assert.equal(next.turn.phase, 'reinforce');
});

test('redactStateFor masque les cartes des autres et le paquet', () => {
  let { state } = applyAction(lobbyWith(5, 2), { type: 'START_GAME' });
  state.players[0].cards.push({ id: 'c_x', symbol: 'joker', territory: null });
  state.players[1].cards.push({ id: 'c_y', symbol: 'joker', territory: null });
  const view = redactStateFor(applyAction(state, decideBotAction(state, state.turn.playerId)).state, state.players[0].id);
  assert.equal(view.players[0].cards.length, 1);
  assert.equal(view.players[1].cards.length, 0);
  assert.equal(view.players[1].cardCount, 1);
  assert.equal(view.rng, undefined);
  assert.equal(view.cards.deck, undefined);
});

// ───────────────────────────── Chat ─────────────────────────────

test('chat : mentions @ et privés #, insensibles à la casse, pseudos inconnus ignorés', () => {
  const players = [
    { id: 'a', name: 'Alice' },
    { id: 'b', name: 'Bob_42' },
    { id: 'c', name: 'Carol' },
  ];
  assert.deepEqual(parseChat('salut @alice et @Bob_42 !', players), { mentions: ['a', 'b'], privateTo: [] });
  assert.deepEqual(parseChat('#Carol on attaque Bob ?', players), { mentions: [], privateTo: ['c'] });
  assert.deepEqual(parseChat('#carol #alice plan secret @bob_42', players), { mentions: ['b'], privateTo: ['c', 'a'] });
  assert.deepEqual(parseChat('@inconnu #personne', players), { mentions: [], privateTo: [] });
  assert.deepEqual(parseChat('mail@alice.fr', players), { mentions: [], privateTo: [] }); // pas une mention
  const priv = { kind: 'private', from: 'a', to: ['c'] };
  assert.ok(canSeeChat(priv, 'a'));
  assert.ok(canSeeChat(priv, 'c'));
  assert.ok(!canSeeChat(priv, 'b'));
  assert.ok(canSeeChat({ kind: 'public', from: 'a', to: [] }, 'b'));
});

// ───────────────────────────── Autres cartes ─────────────────────────────

test('catalogue : chaque carte est cohérente (adjacences symétriques, graphe connexe, bonus = règle commune)', () => {
  for (const entry of MAP_CATALOG) {
    const m = getMap(entry.id);
    assert.ok(m.TERRITORY_IDS.length >= 40, `${entry.id} : trop peu de territoires`);
    for (const t of Object.values(m.TERRITORIES)) {
      assert.ok(t.neighbors.length >= 1, `${entry.id}/${t.id} n’a aucun voisin`);
      for (const n of t.neighbors) assert.ok(m.areAdjacent(n, t.id), `${entry.id}/${t.id}↔${n} non symétrique`);
      assert.ok(m.territoryAt(t.pos.x, t.pos.y) === t.id, `${entry.id}/${t.id} : l’étiquette n’est pas dans le territoire`);
    }
    for (const c of Object.values(m.CONTINENTS)) {
      const n = m.territoriesOf(c.id).length;
      assert.ok(n >= 1, `${entry.id}/${c.id} vide`);
      assert.equal(c.bonus, Math.max(2, Math.round(n * 0.55)), `${entry.id}/${c.id} : bonus ${c.bonus} pour ${n} territoires`);
    }
    const first = m.TERRITORY_IDS[0];
    const seen = new Set([first]);
    const stack = [first];
    while (stack.length) for (const n of m.TERRITORIES[stack.pop()].neighbors) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    assert.equal(seen.size, m.TERRITORY_IDS.length, `${entry.id} : graphe non connexe`);
  }
});

test('Terre du Milieu : montagnes infranchissables, entrées du Mordor, partie complète bots contre bots', () => {
  const m = getMap('middle_earth');
  assert.ok(!m.wrap);
  assert.ok(m.RIDGES.length > 0);
  assert.ok(!m.areAdjacent('ithilien', 'gorgoroth'));
  assert.ok(m.areAdjacent('dead_marshes', 'udun'));
  assert.ok(m.areAdjacent('ithilien', 'minas_morgul'));
  assert.ok(m.areAdjacent('khand', 'nurn'));
  assert.ok(m.areAdjacent('umbar', 'dol_amroth'));
  let { state } = applyAction(lobbyWith(6, 21, 'middle_earth'), { type: 'START_GAME' });
  assert.equal(state.mapId, 'middle_earth');
  assert.equal(Object.keys(state.territories).length, m.TERRITORY_IDS.length);
  const res = playOut(state);
  assert.equal(res.state.status, 'finished', `partie non terminée après ${res.steps} coups`);
  assert.ok(m.TERRITORY_IDS.every((t) => res.state.territories[t].owner === res.state.winner));
});

// ───────────────── Anti-boule de neige : une seule carte par tour ─────────────────

/** Amène la partie à la phase d'attaque du premier joueur. */
function toAttackPhase(seed = 5) {
  let { state } = applyAction(lobbyWith(5, seed), { type: 'START_GAME' });
  while (state.status === 'setup' || state.turn.phase === 'reinforce') {
    state = applyAction(state, decideBotAction(state, state.turn.playerId)).state;
  }
  return state;
}

test('une seule carte piochée par tour, quel que soit le nombre de conquêtes', () => {
  let state = toAttackPhase(5);
  const me = state.turn.playerId;
  const map = getMap(state.mapId);
  // On donne à l'attaquant une armée écrasante partout : il va enchaîner les conquêtes
  for (const t of map.TERRITORY_IDS) if (state.territories[t].owner === me) state.territories[t].troops = 60;
  let conquests = 0;
  let drawn = 0;
  for (let i = 0; i < 400; i++) {
    const moves = possibleMoves(state, me);
    if (state.turn.pendingOccupy) {
      state = applyAction(state, { type: 'OCCUPY', playerId: me, count: state.turn.pendingOccupy.min }).state;
      continue;
    }
    if (!moves.attacks.length) break;
    const a = moves.attacks[0];
    const { state: next, events } = applyAction(state, { type: 'ATTACK', playerId: me, from: a.from, to: a.to, dice: a.maxDice });
    state = next;
    conquests += events.filter((e) => e.type === 'TERRITORY_CONQUERED').length;
    drawn += events.filter((e) => e.type === 'CARD_DRAWN').length;
    if (state.status === 'finished') break;
  }
  assert.ok(conquests >= 5, `il faut plusieurs conquêtes pour le test (${conquests})`);
  assert.equal(drawn, 0, 'aucune carte piochée pendant la phase d’attaque');
  if (state.status !== 'finished') {
    // Fin du tour : exactement une carte, malgré les conquêtes multiples
    const before = state.players.find((p) => p.id === me).cards.length;
    while (state.turn && state.turn.playerId === me) {
      state = applyAction(state, { type: 'END_PHASE', playerId: me }).state;
    }
    assert.equal(state.players.find((p) => p.id === me).cards.length, before + 1);
  }
});

test('élimination : l’attaquant ne récupère qu’une carte, le reste va à la défausse', () => {
  let state = toAttackPhase(11);
  const map = getMap(state.mapId);
  const me = state.turn.playerId;
  const moves = possibleMoves(state, me).attacks;
  const m = moves[0];
  const victimId = state.territories[m.to].owner;
  // La victime ne garde qu'un seul territoire (celui attaqué) et tient 5 cartes
  for (const t of map.TERRITORY_IDS) if (state.territories[t].owner === victimId && t !== m.to) state.territories[t].owner = me;
  const victim = state.players.find((p) => p.id === victimId);
  victim.cards = state.cards.deck.splice(0, 5);
  state.territories[m.to].troops = 1;
  state.territories[m.from].troops = 40;

  const totalBefore = state.players.reduce((s, p) => s + p.cards.length, 0) + state.cards.deck.length + state.cards.discard.length;
  const attackerBefore = state.players.find((p) => p.id === me).cards.length;
  const discardBefore = state.cards.discard.length;
  let eliminated = false;
  for (let i = 0; i < 40 && !eliminated; i++) {
    const { state: next, events } = applyAction(state, { type: 'ATTACK', playerId: me, from: m.from, to: m.to, dice: 3 });
    state = next;
    eliminated = events.some((e) => e.type === 'PLAYER_ELIMINATED');
  }
  assert.ok(eliminated, 'la victime doit être éliminée');
  const attacker = state.players.find((p) => p.id === me);
  assert.equal(attacker.cards.length, attackerBefore + 1, 'une seule carte héritée');
  assert.equal(state.players.find((p) => p.id === victimId).cards.length, 0);
  assert.equal(state.cards.discard.length, discardBefore + 4, 'les 4 autres cartes sont défaussées');
  const totalAfter = state.players.reduce((s, p) => s + p.cards.length, 0) + state.cards.deck.length + state.cards.discard.length;
  assert.equal(totalAfter, totalBefore, 'aucune carte perdue');
});
