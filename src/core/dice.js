/**
 * Générateur aléatoire de la partie + résolution des combats.
 *
 * Le RNG est stocké DANS l'état de partie (`state.rng`) afin que :
 *  - l'hôte (navigateur du créateur ou serveur) soit la seule source de hasard,
 *  - une partie soit rejouable à l'identique à partir de sa clé (tests, débogage).
 *
 * État : rng = { k: [8 mots de 32 bits], i: nombre de mots déjà consommés }.
 * Flux : ChaCha20 en mode compteur (random.js). La clé de 256 bits est tirée du
 * générateur cryptographique pour une vraie partie, ou dérivée d'une graine
 * numérique pour les tests. Sans la clé, les dés et les mélanges sont
 * imprévisibles, même pour qui observe toute la partie depuis le début.
 * La clé ne quitte jamais l'hôte : redactStateFor supprime `rng` avant envoi.
 *
 * Toutes les fonctions ici sont pures : elles reçoivent un rng et renvoient le
 * nouveau rng avec le résultat.
 */
import { chacha20Block, secureRandomWords } from './random.js';

/**
 * Nouveau générateur.
 *  - sans argument : clé cryptographique de 256 bits (partie réelle) ;
 *  - avec une graine numérique : clé dérivée, suite reproductible (tests, rejeu).
 */
export function createRng(seed) {
  if (seed === undefined || seed === null) return { k: secureRandomWords(8), i: 0 };
  return { k: expandSeed(seed), i: 0 };
}

/** Étale une graine 32 bits sur une clé de 8 mots (splitmix32). Réservé aux tests. */
function expandSeed(seed) {
  let x = Number(seed) >>> 0;
  const key = [];
  for (let j = 0; j < 8; j++) {
    x = (x + 0x9e3779b9) >>> 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    key.push((z ^ (z >>> 16)) >>> 0);
  }
  return key;
}

/** Vrai si `rng` est au format actuel (clé ChaCha20). Les anciennes sauvegardes {seed,count} sont migrées par l'hôte. */
export function isValidRng(rng) {
  return !!rng && Array.isArray(rng.k) && rng.k.length === 8 && Number.isInteger(rng.i) && rng.i >= 0;
}

// Un bloc ChaCha20 fournit 16 mots : on garde le dernier bloc calculé pour les
// appels suivants (pure mémoïsation, sans effet sur les résultats).
let lastBlock = { k: null, index: -1, words: null };

function wordAt(rng) {
  if (!isValidRng(rng)) throw new Error('Générateur aléatoire invalide');
  const index = Math.floor(rng.i / 16);
  if (lastBlock.k !== rng.k || lastBlock.index !== index) {
    // Compteur 64 bits : mot bas dans le compteur, mot haut dans le nonce
    const words = chacha20Block(rng.k, index >>> 0, [Math.floor(index / 4294967296) >>> 0, 0, 0]);
    lastBlock = { k: rng.k, index, words };
  }
  return lastBlock.words[rng.i % 16];
}

/** Renvoie [nombre dans [0,1), nouveau rng]. */
export function nextFloat(rng) {
  const value = wordAt(rng) / 4294967296;
  return [value, { k: rng.k, i: rng.i + 1 }];
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
