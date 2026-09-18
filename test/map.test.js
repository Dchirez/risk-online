/**
 * Audit géométrique des cartes : les adjacences DÉCLARÉES doivent correspondre à
 * la géométrie réellement dessinée.
 *
 * Bug historique (carte Terre du Milieu) : l'adjacence était détectée en cherchant
 * des sommets strictement identiques entre deux contours. Le rognage des cellules
 * sur la côte décalait ces sommets de quelques dixièmes de pixel, si bien que 43
 * frontières bien visibles n'étaient pas jouables : on voyait deux territoires
 * côte à côte, sans montagne, et l'attaque était refusée.
 *
 * Ces tests mesurent la longueur de frontière commune par proximité et vérifient
 * qu'aucune vraie frontière n'est oubliée, dans les deux sens.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAP_CATALOG, getMap } from '../src/core/map.js';

const SAMPLE_STEP = 2; // pas d'échantillonnage du contour (unités carte)
const TOUCH_TOL = 3; // deux points plus proches que ça sont sur la même frontière
/** Au-delà, c'est une vraie frontière : elle doit être jouable ou barrée par une montagne. */
const REAL_BORDER = 24;
/**
 * Deux territoires déclarés voisins doivent au moins se frôler. Tolérance large :
 * la simplification des contours, appliquée à chaque territoire séparément, peut
 * ouvrir quelques pixels entre deux côtes pourtant mitoyennes.
 */
const NEAR_TOL = 8;

/** Contour d'un territoire, rééchantillonné à pas régulier. */
function outlinePoints(data, id) {
  const pts = [];
  for (const poly of data.territories[id].polys) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        const d = Math.hypot(x2 - x1, y2 - y1);
        const n = Math.max(1, Math.ceil(d / SAMPLE_STEP));
        for (let k = 0; k < n; k++) pts.push([x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n]);
      }
    }
  }
  return pts;
}

/** Longueur approximative de frontière commune pour chaque paire de territoires. */
function borderLengths(data) {
  const ids = Object.keys(data.territories);
  const outlines = Object.fromEntries(ids.map((id) => [id, outlinePoints(data, id)]));
  const grid = new Map();
  for (const id of ids) {
    for (const [x, y] of outlines[id]) {
      const k = `${Math.floor(x / TOUCH_TOL)}:${Math.floor(y / TOUCH_TOL)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push({ id, x, y });
    }
  }
  const shared = new Map();
  for (const id of ids) {
    for (const [x, y] of outlines[id]) {
      const cx = Math.floor(x / TOUCH_TOL);
      const cy = Math.floor(y / TOUCH_TOL);
      const near = new Set();
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          for (const q of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
            if (q.id !== id && Math.hypot(q.x - x, q.y - y) <= TOUCH_TOL) near.add(q.id);
          }
        }
      for (const other of near) {
        const k = [id, other].sort().join('|');
        shared.set(k, (shared.get(k) ?? 0) + 1);
      }
    }
  }
  return new Map([...shared].map(([k, n]) => [k, (n / 2) * SAMPLE_STEP]));
}

const pairKey = (a, b) => [a, b].sort().join('|');

/** Paires de territoires dont les contours passent à moins de `tol` l'un de l'autre. */
function closePairs(data, tol) {
  const ids = Object.keys(data.territories);
  const grid = new Map();
  for (const id of ids) {
    for (const [x, y] of outlinePoints(data, id)) {
      const k = `${Math.floor(x / tol)}:${Math.floor(y / tol)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push({ id, x, y });
    }
  }
  const out = new Set();
  for (const bucket of grid.values()) {
    for (const p of bucket) {
      const cx = Math.floor(p.x / tol);
      const cy = Math.floor(p.y / tol);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          for (const q of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
            if (q.id !== p.id && Math.hypot(q.x - p.x, q.y - p.y) <= tol) out.add(pairKey(p.id, q.id));
          }
        }
    }
  }
  return out;
}

for (const entry of MAP_CATALOG) {
  const map = getMap(entry.id);
  const data = entry.data;

  test(`carte ${entry.id} : toute frontière visible est jouable ou barrée par une montagne`, () => {
    const lengths = borderLengths(data);
    const declared = new Set();
    for (const id of map.TERRITORY_IDS) for (const n of map.TERRITORIES[id].neighbors) declared.add(pairKey(id, n));
    // Paires volontairement séparées par une chaîne infranchissable
    const blocked = new Set((data.blockedPairs ?? []).map(([a, b]) => pairKey(a, b)));

    const missing = [];
    for (const [k, len] of lengths) {
      if (len < REAL_BORDER) continue; // contact de coin
      if (declared.has(k) || blocked.has(k)) continue;
      missing.push(`${k} (${len.toFixed(0)} px)`);
    }
    assert.deepEqual(
      missing,
      [],
      `frontières bien visibles mais ni attaquables ni barrées par une montagne :\n  ${missing.join('\n  ')}`,
    );
  });

  test(`carte ${entry.id} : toute adjacence déclarée est mitoyenne ou une liaison maritime`, () => {
    const close = closePairs(data, NEAR_TOL);
    const routes = new Set((data.seaRoutes ?? []).map(([a, b]) => pairKey(a, b)));
    const bogus = [];
    for (const id of map.TERRITORY_IDS) {
      for (const n of map.TERRITORIES[id].neighbors) {
        const k = pairKey(id, n);
        if (routes.has(k) || close.has(k)) continue; // mitoyens, ou reliés par la mer (pointillés)
        if (!bogus.includes(k)) bogus.push(k);
      }
    }
    assert.deepEqual(bogus, [], `voisins qui ne se touchent pas et sans liaison maritime déclarée : ${bogus.join(', ')}`);
  });

  test(`carte ${entry.id} : graphe connexe, aucun territoire isolé`, () => {
    const ids = map.TERRITORY_IDS;
    for (const id of ids) {
      assert.ok(map.TERRITORIES[id].neighbors.length >= 1, `${id} n’a aucun voisin : territoire injouable`);
    }
    const seen = new Set([ids[0]]);
    const stack = [ids[0]];
    while (stack.length) {
      for (const n of map.TERRITORIES[stack.pop()].neighbors) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
    assert.equal(seen.size, ids.length, 'tous les territoires doivent être atteignables');
  });
}
