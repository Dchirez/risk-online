/**
 * Cartes territoire : création du paquet, validation des combinaisons,
 * calcul du bonus d'échange. Module pur.
 *
 * Paquet classique : 42 cartes territoire (14 infanterie, 14 cavalerie,
 * 14 artillerie) + 2 jokers.
 */
import { TERRITORY_IDS } from './map.js';
import { shuffle } from './dice.js';

export const SYMBOLS = ['infantry', 'cavalry', 'artillery'];
export const SYMBOL_LABELS = {
  infantry: 'Infanterie',
  cavalry: 'Cavalerie',
  artillery: 'Artillerie',
  joker: 'Joker',
};

/** Crée le paquet mélangé. Renvoie [deck, rng]. */
export function createDeck(rng) {
  const cards = TERRITORY_IDS.map((territory, i) => ({
    id: `c_${territory}`,
    territory,
    symbol: SYMBOLS[i % 3],
  }));
  cards.push({ id: 'c_joker_1', territory: null, symbol: 'joker' });
  cards.push({ id: 'c_joker_2', territory: null, symbol: 'joker' });
  return shuffle(rng, cards);
}

/**
 * Une combinaison est valide si (jokers exclus) les 3 symboles sont identiques
 * ou tous différents. Un joker remplace n'importe quel symbole.
 */
export function isValidSet(cards) {
  if (!Array.isArray(cards) || cards.length !== 3) return false;
  const symbols = cards.map((c) => c.symbol).filter((s) => s !== 'joker');
  if (symbols.length <= 1) return true; // 2 jokers, ou 1 joker + 1 carte... (3 cartes dont ≥2 jokers)
  const uniq = new Set(symbols);
  if (symbols.length === 2) return true; // 1 joker : complète toujours une combinaison
  return uniq.size === 1 || uniq.size === 3;
}

/** Toutes les combinaisons valides possibles dans une main (liste de triplets). */
export function findValidSets(hand) {
  const sets = [];
  for (let i = 0; i < hand.length; i++)
    for (let j = i + 1; j < hand.length; j++)
      for (let k = j + 1; k < hand.length; k++) {
        const s = [hand[i], hand[j], hand[k]];
        if (isValidSet(s)) sets.push(s);
      }
  return sets;
}

/**
 * Bonus de troupes pour le n-ième échange de la partie (n commence à 0) :
 * 4, 6, 8, 10, 12, 15, puis +5 à chaque fois.
 */
export function exchangeBonus(exchangeIndex) {
  const table = [4, 6, 8, 10, 12, 15];
  if (exchangeIndex < table.length) return table[exchangeIndex];
  return 15 + 5 * (exchangeIndex - table.length + 1);
}
