/**
 * Cartes du jeu : catalogue, construction d'un objet "carte" à partir des
 * données générées (src/core/maps/*.js), géométrie pour le rendu et le clic.
 *
 * Module PUR (aucune dépendance DOM) : utilisé par les règles, l'IA, l'hôte
 * (serveur Node) et l'interface. Une partie porte l'identifiant de sa carte
 * (`state.mapId`) ; toutes les fonctions du cœur récupèrent la carte via
 * `mapOf(state)`. Plusieurs parties sur des cartes différentes peuvent donc
 * coexister sur un même serveur.
 *
 * Objet carte (voir buildMap) :
 *   id, name, description, width, height, wrap (bouclage horizontal),
 *   CONTINENTS { id → { id, name, short, bonus, color, label:{x,y} } }
 *   TERRITORIES { id → { id, name, continent, pos:{x,y}, labelRadius, neighbors[] } }
 *   TERRITORY_IDS, SEA_ROUTES, OCEAN_LABELS, RIDGES (crêtes infranchissables), ZONES
 *   territoriesOf(c), areAdjacent(a,b), edges(), territoryPath(id), continentPath(id),
 *   territorySilhouette(id), territoryAt(x,y)
 */
import { MAP_DATA as WORLD } from './maps/world.js';
import { MAP_DATA as MIDDLE_EARTH } from './maps/middle_earth.js';

export const DEFAULT_MAP_ID = 'world';

/** Catalogue des cartes proposées à la création d'une partie. */
export const MAP_CATALOG = [
  {
    id: 'world',
    name: 'Monde',
    description: '80 territoires, 6 continents. Contours réels, carte bouclée (Alaska ↔ Kamtchatka).',
    data: WORLD,
    short: { NA: 'Am. du Nord', SA: 'Am. du Sud', EU: 'Europe', AF: 'Afrique', AS: 'Asie', OC: 'Océanie' },
  },
  {
    id: 'middle_earth',
    name: 'Terre du Milieu',
    description: '80 territoires, 10 régions. Chaînes de montagnes infranchissables, Mordor à trois entrées.',
    data: MIDDLE_EARTH,
    short: { AR: 'Arnor', RN: 'Erebor', MK: 'Forêt Noire' },
  },
];

const cache = new Map();

/** Carte par identifiant (construite une fois, puis mise en cache). */
export function getMap(id = DEFAULT_MAP_ID) {
  if (!cache.has(id)) {
    const entry = MAP_CATALOG.find((m) => m.id === id);
    if (!entry) throw new Error(`Carte inconnue : ${id}`);
    cache.set(id, buildMap(entry));
  }
  return cache.get(id);
}

/** Carte d'une partie (état de jeu). */
export function mapOf(state) {
  return getMap(state?.mapId ?? DEFAULT_MAP_ID);
}

// ═══════════════════════════ Construction ═══════════════════════════

function buildMap(entry) {
  const data = entry.data;
  const CONTINENTS = {};
  for (const [id, c] of Object.entries(data.continents)) {
    CONTINENTS[id] = { id, name: c.name, short: entry.short?.[id] ?? c.name, bonus: c.bonus, color: c.color, label: { x: c.label[0], y: c.label[1] } };
  }
  const TERRITORIES = {};
  for (const [id, t] of Object.entries(data.territories)) {
    TERRITORIES[id] = { id, name: t.name, continent: t.continent, pos: { x: t.label[0], y: t.label[1] }, labelRadius: t.r, neighbors: [...t.neighbors] };
  }
  // Vérification d'intégrité (symétrie des adjacences)
  for (const t of Object.values(TERRITORIES)) {
    for (const n of t.neighbors) {
      if (!TERRITORIES[n]) throw new Error(`Voisin inconnu: ${n} (depuis ${t.id})`);
      if (!TERRITORIES[n].neighbors.includes(t.id)) TERRITORIES[n].neighbors.push(t.id);
    }
  }
  const TERRITORY_IDS = Object.freeze(Object.keys(TERRITORIES));
  const pathCache = new Map();

  const map = {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    width: data.width,
    height: data.height,
    wrap: data.wrap !== false,
    CONTINENTS,
    TERRITORIES,
    TERRITORY_IDS,
    SEA_ROUTES: data.seaRoutes ?? [],
    OCEAN_LABELS: data.oceanLabels ?? [],
    RIDGES: data.ridges ?? [],
    ZONES: data.zones ?? [],

    /** Liste des territoires d'un continent. */
    territoriesOf: (continentId) => TERRITORY_IDS.filter((id) => TERRITORIES[id].continent === continentId),
    areAdjacent: (a, b) => TERRITORIES[a]?.neighbors.includes(b) ?? false,
    /** Arêtes uniques [a, b] (a < b). */
    edges() {
      const out = [];
      for (const t of Object.values(TERRITORIES)) for (const n of t.neighbors) if (t.id < n) out.push([t.id, n]);
      return out;
    },
    /** Chemin SVG (attribut d) d'un territoire. */
    territoryPath(id) {
      if (!pathCache.has(id)) pathCache.set(id, polysToPath(data.territories[id].polys));
      return pathCache.get(id);
    },
    /** Chemin SVG du contour d'un continent (union de ses territoires). */
    continentPath(id) {
      const key = `continent:${id}`;
      if (!pathCache.has(key)) pathCache.set(key, polysToPath(data.continents[id].polys));
      return pathCache.get(key);
    },
    /**
     * Silhouette d'un territoire pour les cartes : son plus grand polygone et les
     * îles proches (boîte englobante élargie de 30 %), pour éviter qu'un îlot lointain
     * ou un morceau de l'autre côté de la couture n'écrase le dessin. Renvoie { d, viewBox }.
     */
    territorySilhouette(id) {
      const key = `silhouette:${id}`;
      if (pathCache.has(key)) return pathCache.get(key);
      const polys = data.territories[id].polys;
      const main = polys.reduce((best, p) => (ringArea(p[0]) > ringArea(best[0]) ? p : best), polys[0]);
      const mb = ringBBox(main[0]);
      const padX = (mb.maxX - mb.minX) * 0.3 + 4;
      const padY = (mb.maxY - mb.minY) * 0.3 + 4;
      const kept = polys.filter((p) => {
        const b = ringBBox(p[0]);
        return b.maxX >= mb.minX - padX && b.minX <= mb.maxX + padX && b.maxY >= mb.minY - padY && b.minY <= mb.maxY + padY;
      });
      const all = kept.reduce(
        (acc, p) => {
          const b = ringBBox(p[0]);
          return { minX: Math.min(acc.minX, b.minX), minY: Math.min(acc.minY, b.minY), maxX: Math.max(acc.maxX, b.maxX), maxY: Math.max(acc.maxY, b.maxY) };
        },
        { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
      );
      const m = 2;
      const out = { d: polysToPath(kept), viewBox: `${all.minX - m} ${all.minY - m} ${all.maxX - all.minX + 2 * m} ${all.maxY - all.minY + 2 * m}` };
      pathCache.set(key, out);
      return out;
    },
    /**
     * Territoire contenant le point (x, y) en unités carte, ou null.
     * Sur une carte bouclée, x est ramené modulo la largeur. Règle pair-impair (trous inclus).
     */
    territoryAt(x, y) {
      const W = data.width;
      const px = map.wrap ? ((x % W) + W) % W : x;
      for (const [id, t] of Object.entries(data.territories)) {
        for (const poly of t.polys) {
          let inside = false;
          for (const ring of poly) if (pointInRing(px, y, ring)) inside = !inside;
          if (inside) return id;
        }
      }
      return null;
    },
  };
  return map;
}

// ───────────────────────────── Géométrie ─────────────────────────────

function polysToPath(polys) {
  return polys.map((poly) => poly.map((ring) => 'M' + ring.map(([x, y]) => `${x} ${y}`).join('L') + 'Z').join('')).join('');
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

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
