/**
 * Aléa cryptographique du jeu. Module pur (navigateur et Node).
 *
 * Deux usages, deux besoins :
 *  - secureRandomBytes / secureRandomWords : aléa IMPRÉVISIBLE tiré du générateur
 *    cryptographique de la plateforme (`crypto.getRandomValues`). Sert aux jetons
 *    de reconnexion, aux codes de partie, aux identifiants et à la clé des dés.
 *    Disponible dans tous les navigateurs et dans Node ≥ 19 ; le serveur Node 18
 *    installe `globalThis.crypto` au démarrage (server/crypto-polyfill.js).
 *    Échoue FERMÉ : jamais de repli silencieux sur Math.random.
 *  - chacha20Block : bloc du chiffrement ChaCha20 (RFC 8439), utilisé en mode
 *    compteur comme générateur de la partie (dice.js). Reproductible à partir de
 *    sa clé, mais impossible à prédire sans elle, même en observant tous les dés.
 *
 * Pourquoi pas Math.random ni un petit générateur rapide : leurs sorties se
 * devinent. Avec l'ancienne graine « heure de création » + mulberry32, la graine
 * se retrouvait en quelques secondes à partir de la seule répartition publique
 * des territoires, et avec elle tout le paquet de cartes et tous les dés futurs.
 */

function platformCrypto() {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('Générateur aléatoire cryptographique indisponible (crypto.getRandomValues)');
  }
  return c;
}

/** `n` octets aléatoires imprévisibles. */
export function secureRandomBytes(n) {
  return platformCrypto().getRandomValues(new Uint8Array(n));
}

/** `n` entiers non signés 32 bits aléatoires imprévisibles. */
export function secureRandomWords(n) {
  return Array.from(platformCrypto().getRandomValues(new Uint32Array(n)));
}

const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;

function quarterRound(s, a, b, c, d) {
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 7);
}

/**
 * Bloc ChaCha20 (RFC 8439 §2.3) : 16 mots de 32 bits.
 * @param {number[]} key      8 mots (clé de 256 bits)
 * @param {number}   counter  compteur de bloc (32 bits)
 * @param {number[]} nonce    3 mots
 */
export function chacha20Block(key, counter, nonce = [0, 0, 0]) {
  const init = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574, ...key, counter >>> 0, ...nonce];
  const s = init.slice();
  for (let i = 0; i < 10; i++) {
    // Tours « colonne » puis tours « diagonale »
    quarterRound(s, 0, 4, 8, 12); quarterRound(s, 1, 5, 9, 13); quarterRound(s, 2, 6, 10, 14); quarterRound(s, 3, 7, 11, 15);
    quarterRound(s, 0, 5, 10, 15); quarterRound(s, 1, 6, 11, 12); quarterRound(s, 2, 7, 8, 13); quarterRound(s, 3, 4, 9, 14);
  }
  return s.map((v, i) => (v + init[i]) >>> 0);
}
