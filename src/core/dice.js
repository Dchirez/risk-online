/**
 * Générateur pseudo-aléatoire déterministe (mulberry32) + résolution des combats.
 *
 * Le RNG est stocké DANS l'état de partie (`state.rng`) afin que :
 *  - l'hôte (local aujourd'hui, serveur demain) soit la seule source de hasard,
 *  - une partie soit rejouable à partir de sa graine (tests, replays, debug).
 *
 * Toutes les fonctions ici sont pures : elles reçoivent un objet rng { seed, count }
 * et renvoient le nouvel objet rng avec le résultat.
 */

export function createRng(seed = Date.now() >>> 0) {
  return { seed: seed >>> 0, count: 0 };
}

/** Une itération mulberry32 sur un entier 32 bits. */
function mulberry32(a) {
  let t = (a += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Renvoie [nombre dans [0,1), nouveau rng]. */
export function nextFloat(rng) {
  const value = mulberry32((rng.seed + rng.count * 0x9e3779b9) >>> 0);
  return [value, { seed: rng.seed, count: rng.count + 1 }];
}

/** Entier dans [min, max] inclus. */
export function nextInt(rng, min, max) {
  const [f, r] = nextFloat(rng);
  return [min + Math.floor(f * (max - min + 1)), r];
}

/** Mélange de Fisher-Yates déterministe. Renvoie [copie mélangée, rng]. */
export function shuffle(rng, array) {
  const a = array.slice();
  let r = rng;
  for (let i = a.length - 1; i > 0; i--) {
    let j;
    [j, r] = nextInt(r, 0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return [a, r];
}

/** Lance n dés à 6 faces, triés par ordre décroissant. */
export function rollDice(rng, n) {
  const rolls = [];
  let r = rng;
  for (let i = 0; i < n; i++) {
    let v;
    [v, r] = nextInt(r, 1, 6);
    rolls.push(v);
  }
  rolls.sort((a, b) => b - a);
  return [rolls, r];
}

/**
 * Résout un assaut (un seul jet) selon les règles classiques :
 * on compare les dés deux à deux, le défenseur gagne les égalités.
 *
 * @returns {[{attackerDice:number[], defenderDice:number[], attackerLosses:number, defenderLosses:number}, rng]}
 */
export function resolveCombat(rng, attackerDiceCount, defenderDiceCount) {
  let r = rng;
  let attackerDice, defenderDice;
  [attackerDice, r] = rollDice(r, attackerDiceCount);
  [defenderDice, r] = rollDice(r, defenderDiceCount);
  let attackerLosses = 0;
  let defenderLosses = 0;
  const pairs = Math.min(attackerDice.length, defenderDice.length);
  for (let i = 0; i < pairs; i++) {
    if (attackerDice[i] > defenderDice[i]) defenderLosses++;
    else attackerLosses++;
  }
  return [{ attackerDice, defenderDice, attackerLosses, defenderLosses }, r];
}
