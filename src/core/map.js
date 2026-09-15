/**
 * Carte du monde : 80 territoires, 6 continents, adjacences, géométrie.
 *
 * Module PUR (aucune dépendance DOM) : utilisé par les règles, l'IA, l'hôte
 * (futur serveur Node) et l'interface.
 *
 * Les données géométriques (contours réels issus de Natural Earth, projection
 * de Miller, largeur 2400) sont générées dans mapData.js par tools/build-map.mjs.
 * La carte boucle horizontalement : x = 0 et x = width désignent le même méridien,
 * ce qui relie l'Alaska et le Kamtchatka par le bord.
 */
import { MAP_DATA } from './mapData.js';

export const MAP_VIEWBOX = { width: MAP_DATA.width, height: MAP_DATA.height };

const SHORT = { NA: 'Am. du Nord', SA: 'Am. du Sud', EU: 'Europe', AF: 'Afrique', AS: 'Asie', OC: 'Océanie' };

/** @type {Record<string,{id:string,name:string,short:string,bonus:number,color:string,label:{x:number,y:number}}>} */
export const CONTINENTS = {};
for (const [id, c] of Object.entries(MAP_DATA.continents)) {
  CONTINENTS[id] = { id, name: c.name, short: SHORT[id] ?? c.name, bonus: c.bonus, color: c.color, label: { x: c.label[0], y: c.label[1] } };
}

/** @type {Record<string,{id:string,name:string,continent:string,pos:{x:number,y:number},labelRadius:number,neighbors:string[]}>} */
export const TERRITORIES = {};
for (const [id, t] of Object.entries(MAP_DATA.territories)) {
  TERRITORIES[id] = { id, name: t.name, continent: t.continent, pos: { x: t.label[0], y: t.label[1] }, labelRadius: t.r, neighbors: [...t.neighbors] };
}
// Vérification d'intégrité (symétrie des adjacences)
for (const t of Object.values(TERRITORIES)) {
  for (const n of t.neighbors) {
    if (!TERRITORIES[n]) throw new Error(`Voisin inconnu: ${n} (depuis ${t.id})`);
    if (!TERRITORIES[n].neighbors.includes(t.id)) TERRITORIES[n].neighbors.push(t.id);
  }
}

export const TERRITORY_IDS = Object.freeze(Object.keys(TERRITORIES));
export const SEA_ROUTES = MAP_DATA.seaRoutes;
export const OCEAN_LABELS = MAP_DATA.oceanLabels;

/** Liste des territoires d'un continent. */
export function territoriesOf(continentId) {
  return TERRITORY_IDS.filter((id) => TERRITORIES[id].continent === continentId);
}

export function areAdjacent(a, b) {
  return TERRITORIES[a]?.neighbors.includes(b) ?? false;
}

/** Liste des arêtes uniques [a, b] (a < b). */
export function edges() {
  const out = [];
  for (const t of Object.values(TERRITORIES)) {
    for (const n of t.neighbors) if (t.id < n) out.push([t.id, n]);
  }
  return out;
}

// ───────────────────────────── Géométrie (rendu et clic) ─────────────────────────────

const pathCache = new Map();
function polysToPath(polys) {
  return polys.map((poly) => poly.map((ring) => 'M' + ring.map(([x, y]) => `${x} ${y}`).join('L') + 'Z').join('')).join('');
}

/** Chemin SVG (attribut d) d'un territoire. */
export function territoryPath(id) {
  if (!pathCache.has(id)) pathCache.set(id, polysToPath(MAP_DATA.territories[id].polys));
  return pathCache.get(id);
}

/** Chemin SVG du contour d'un continent (union de ses territoires). */
export function continentPath(id) {
  const key = `continent:${id}`;
  if (!pathCache.has(key)) pathCache.set(key, polysToPath(MAP_DATA.continents[id].polys));
  return pathCache.get(key);
}

function ringBBox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}
function ringArea(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s / 2);
}

/**
 * Silhouette d'un territoire pour les cartes : son plus grand polygone et les
 * îles proches (celles dont la boîte englobante touche la sienne élargie de 30 %),
 * ce qui évite qu'un îlot lointain ou un morceau de l'autre côté de la couture
 * n'écrase le dessin. Renvoie { d, viewBox } prêt pour un <svg>.
 */
export function territorySilhouette(id) {
  const key = `silhouette:${id}`;
  if (pathCache.has(key)) return pathCache.get(key);
  const polys = MAP_DATA.territories[id].polys;
  const main = polys.reduce((best, p) => (ringArea(p[0]) > ringArea(best[0]) ? p : best), polys[0]);
  const mb = ringBBox(main[0]);
  const padX = (mb.maxX - mb.minX) * 0.3 + 4;
  const padY = (mb.maxY - mb.minY) * 0.3 + 4;
  const kept = polys.filter((p) => {
    const b = ringBBox(p[0]);
    return b.maxX >= mb.minX - padX && b.minX <= mb.maxX + padX && b.maxY >= mb.minY - padY && b.minY <= mb.maxY + padY;
  });
  const all = kept.reduce((acc, p) => {
    const b = ringBBox(p[0]);
    return { minX: Math.min(acc.minX, b.minX), minY: Math.min(acc.minY, b.minY), maxX: Math.max(acc.maxX, b.maxX), maxY: Math.max(acc.maxY, b.maxY) };
  }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  const m = 2;
  const out = { d: polysToPath(kept), viewBox: `${all.minX - m} ${all.minY - m} ${all.maxX - all.minX + 2 * m} ${all.maxY - all.minY + 2 * m}` };
  pathCache.set(key, out);
  return out;
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Territoire contenant le point (x, y) en unités carte, ou null.
 * x est ramené modulo la largeur (carte bouclée). Règle pair-impair (trous inclus).
 */
export function territoryAt(x, y) {
  const W = MAP_DATA.width;
  const px = ((x % W) + W) % W;
  for (const [id, t] of Object.entries(MAP_DATA.territories)) {
    for (const poly of t.polys) {
      let inside = false;
      for (const ring of poly) if (pointInRing(px, y, ring)) inside = !inside;
      if (inside) return id;
    }
  }
  return null;
}
