/**
 * Construit src/core/maps/middle_earth.js : la Terre du Milieu, dans le même
 * format que la carte du monde (polygones, étiquettes, adjacences, régions).
 *
 *   cd tools && node build-middle-earth.mjs
 *
 * Il n'existe pas de données géographiques pour la Terre du Milieu : chaque
 * territoire est défini par UN point (relevé sur la carte de référence, en
 * pixels d'une image 926×792). Les territoires sont découpés automatiquement
 * en cellules (diagramme de Voronoï) dont les frontières sont ondulées de
 * façon déterministe, puis rognées par la côte et les mers intérieures.
 * Les chaînes de montagnes sont des frontières infranchissables : l'adjacence
 * est supprimée et la crête est dessinée sur la carte.
 */
import { writeFileSync } from 'node:fs';
import { Delaunay } from 'd3-delaunay';
import polygonClipping from 'polygon-clipping';
import polylabel from 'polylabel';

const IMG_W = 926;
const IMG_H = 792;
const WIDTH = 2000;
const S = WIDTH / IMG_W; // facteur image → carte
const HEIGHT = Math.round(IMG_H * S);
const WOBBLE_AMP = 9; // amplitude d'ondulation des frontières (unités carte)
const WOBBLE_STEP = 45; // longueur de segment avant subdivision

/** Bonus d'une région selon son nombre de territoires (même règle pour toutes les cartes). */
const bonusFor = (n) => Math.max(2, Math.round(n * 0.55));

// ═══════════════════════════ Régions ═══════════════════════════
const REGIONS = {
  ER: { name: 'Eriador', color: '#a9c95a', label: [80, 330] },
  AR: { name: 'Arnor et Angmar', color: '#d6603f', label: [330, 18] },
  RN: { name: 'Erebor et Val', color: '#7d5a6b', label: [760, 18] },
  MK: { name: 'Forêt Noire', color: '#3f7a3a', label: [560, 18] },
  RV: { name: 'Rhovanion', color: '#c99a4e', label: [895, 340] },
  RH: { name: 'Rhûn', color: '#a3a55a', label: [895, 240] },
  RO: { name: 'Rohan', color: '#3fa3a8', label: [120, 470] },
  GO: { name: 'Gondor', color: '#7d4a3a', label: [230, 610] },
  MO: { name: 'Mordor', color: '#6e6e6e', label: [895, 520] },
  HA: { name: 'Harad', color: '#e2c04a', label: [330, 720] },
};

// ═══════════════════════════ Territoires (point en pixels image) ═══════════════════════════
const T = [];
const t = (id, name, region, x, y) => T.push({ id, name, region, seed: [x, y] });

// Eriador
t('forlindon', 'Forlindon', 'ER', 75, 135);
t('lune_valley', 'Vallée de la Lune', 'ER', 215, 80);
t('evendim_hills', 'Collines d’Evendim', 'ER', 215, 130);
t('tower_hills', 'Collines des Tours', 'ER', 195, 195);
t('mithlond', 'Mithlond', 'ER', 130, 188);
t('shire', 'La Comté', 'ER', 210, 255);
t('harlindon', 'Harlindon', 'ER', 105, 275);
// Arnor et Angmar
t('mount_gram', 'Mont Gram', 'AR', 285, 50);
t('carn_dum', 'Carn Dûm', 'AR', 365, 45);
t('eastern_angmar', 'Angmar oriental', 'AR', 445, 65);
t('grey_mountains', 'Monts Gris', 'AR', 585, 65);
t('angmar', 'Angmar', 'AR', 410, 105);
t('borderlands', 'Marches', 'AR', 305, 120);
t('north_downs', 'Hauts du Nord', 'AR', 285, 165);
t('weather_hills', 'Collines du Temps', 'AR', 345, 190);
t('fornost', 'Fornost', 'AR', 268, 205);
t('old_forest', 'Vieille Forêt', 'AR', 320, 235);
t('buckland', 'Pays de Bouc', 'AR', 268, 262);
t('south_downs', 'Hauts du Sud', 'AR', 280, 292);
t('rhudaur', 'Rhudaur', 'AR', 430, 200);
t('trollshaws', 'Landes des Trolls', 'AR', 385, 155);
// Erebor et Val
t('withered_heath', 'Lande Desséchée', 'RN', 620, 100);
t('erebor', 'Erebor', 'RN', 672, 122);
t('esgaroth', 'Esgaroth', 'RN', 655, 182);
t('iron_hills', 'Collines de Fer', 'RN', 725, 140);
// Forêt Noire
t('thranduil', 'Halles de Thranduil', 'MK', 590, 150);
t('north_mirkwood', 'Forêt Noire du Nord', 'MK', 588, 205);
t('eastern_mirkwood', 'Forêt Noire de l’Est', 'MK', 637, 240);
t('dol_guldur', 'Dol Guldur', 'MK', 568, 272);
t('south_mirkwood', 'Forêt Noire du Sud', 'MK', 602, 305);
// Rhovanion
t('carrock', 'Carrock', 'RV', 478, 120);
t('gladden_fields', 'Champs aux Iris', 'RV', 502, 168);
t('lorien', 'Lórien', 'RV', 470, 262);
t('anduin_valley', 'Vallée de l’Anduin', 'RV', 522, 262);
t('wold', 'Le Wold', 'RV', 600, 358);
t('emyn_muil', 'Emyn Muil', 'RV', 700, 322);
t('brown_lands', 'Terres Brunes', 'RV', 700, 385);
t('dead_marshes', 'Marais des Morts', 'RV', 620, 410);
// Rhûn
t('rhun_plains', 'Plaines de Rhûn', 'RH', 815, 212);
t('dorwinion', 'Dorwinion', 'RH', 705, 275);
t('rhun_hills', 'Collines de Rhûn', 'RH', 748, 318);
t('lest', 'Lest', 'RH', 778, 362);
t('mistrand', 'Mistrand', 'RH', 828, 350);
t('mattaram', 'Mattaram', 'RH', 770, 395);
// Rohan
t('minhiriath', 'Minhiriath', 'RO', 215, 318);
t('enedwaith', 'Enedwaith', 'RO', 268, 362);
t('dunland', 'Pays de Dun', 'RO', 332, 325);
t('eregion', 'Eregion', 'RO', 372, 298);
t('moria', 'Moria', 'RO', 418, 328);
t('fangorn', 'Fangorn', 'RO', 445, 345);
t('westfold', 'Ouestfolde', 'RO', 345, 395);
t('gap_of_rohan', 'Trouée du Rohan', 'RO', 420, 395);
t('dunharrow', 'Dunharrow', 'RO', 335, 432);
t('helms_deep', 'Gouffre de Helm', 'RO', 405, 432);
t('edoras', 'Edoras', 'RO', 470, 435);
t('eastemnet', 'Estemnet', 'RO', 505, 358);
// Gondor
t('druwaith_iaur', 'Drúwaith Iaur', 'GO', 255, 488);
t('anfalas', 'Anfalas', 'GO', 340, 505);
t('vale_of_erech', 'Val d’Erech', 'GO', 382, 486);
t('lamedon', 'Lamedon', 'GO', 442, 496);
t('belfalas', 'Belfalas', 'GO', 468, 516);
t('dol_amroth', 'Dol Amroth', 'GO', 420, 545);
t('lebennin', 'Lebennin', 'GO', 535, 520);
t('pelargir', 'Pelargir', 'GO', 508, 548);
t('lossarnach', 'Lossarnach', 'GO', 532, 482);
t('minas_tirith', 'Minas Tirith', 'GO', 578, 470);
t('ithilien', 'Ithilien', 'GO', 615, 505);
// Mordor
t('udun', 'Udûn', 'MO', 660, 455);
t('minas_morgul', 'Minas Morgul', 'MO', 650, 500);
t('mount_doom', 'Montagne du Destin', 'MO', 716, 470);
t('barad_dur', 'Barad-dûr', 'MO', 778, 455);
t('nurn', 'Nurn', 'MO', 748, 505);
t('gorgoroth', 'Gorgoroth', 'MO', 712, 565);
// Harad
t('harondor', 'Harondor', 'HA', 600, 598);
t('east_harondor', 'Harondor oriental', 'HA', 650, 628);
t('harad', 'Harad', 'HA', 645, 678);
t('near_harad', 'Proche Harad', 'HA', 738, 655);
t('umbar', 'Umbar', 'HA', 528, 682);
t('deep_harad', 'Harad profond', 'HA', 535, 742);
t('khand', 'Khand', 'HA', 838, 700);

// ═══════════════════════════ Côte, mers intérieures, zones infranchissables (pixels image) ═══════════════════════════
const LAND = [
  [40, 120], [60, 60], [140, 35], [880, 35], [885, 100], [890, 200], [892, 300], [888, 420], [880, 430], [880, 600], [926, 620], [926, 792],
  [430, 792], [470, 745], [500, 720], [470, 690], [500, 660], [530, 648], [562, 622], [578, 588], [540, 575], [480, 576], [430, 572],
  [395, 556], [410, 541], [378, 541], [340, 546], [295, 541], [255, 522], [230, 500], [200, 470], [185, 430], [200, 395], [215, 355],
  [180, 322], [150, 330], [120, 302], [95, 292], [80, 262], [110, 242], [150, 236], [160, 216], [140, 206], [120, 216], [100, 240],
  [70, 232], [45, 190], [35, 150],
];
const LAKES = [
  { name: 'Mer de Rhûn', ring: [[780, 255], [820, 240], [852, 270], [852, 320], [826, 332], [800, 322], [784, 292]] },
  { name: 'Mer de Núrnen', ring: [[735, 527], [775, 522], [792, 546], [770, 562], [740, 556]] },
];
/** Bandes infranchissables (décor + étiquette), hors terrain de jeu. */
const ZONES = [
  { name: 'FORODWAITH · INFRANCHISSABLE', ring: [[0, 0], [926, 0], [926, 34], [0, 34]], label: [463, 22] },
  { name: 'TERRES DE L’EST · INFRANCHISSABLES', ring: [[881, 34], [926, 34], [926, 619], [881, 600], [889, 420]], label: [905, 470] },
];
const OCEAN_LABELS = [
  ['BELEGAER', 110, 560],
  ['BAIE DE BELFALAS', 330, 655],
  ['MER DE RHÛN', 816, 286],
  ['NÚRNEN', 762, 542],
];

/** Frontières coupées par une chaîne de montagnes (aucune adjacence, crête dessinée). */
const BLOCKED = [
  ['forlindon', 'evendim_hills'], ['forlindon', 'tower_hills'],
  ['trollshaws', 'carrock'], ['rhudaur', 'carrock'], ['rhudaur', 'gladden_fields'], ['angmar', 'carrock'], ['eastern_angmar', 'carrock'],
  ['eregion', 'lorien'], ['eregion', 'gladden_fields'], ['moria', 'gladden_fields'], ['rhudaur', 'lorien'],
  ['eastern_angmar', 'thranduil'], ['grey_mountains', 'thranduil'], ['grey_mountains', 'north_mirkwood'],
  ['westfold', 'anfalas'], ['westfold', 'vale_of_erech'], ['druwaith_iaur', 'westfold'], ['gap_of_rohan', 'anfalas'],
  ['dunharrow', 'lamedon'], ['helms_deep', 'lamedon'], ['helms_deep', 'vale_of_erech'], ['helms_deep', 'lossarnach'],
  ['edoras', 'lossarnach'], ['edoras', 'lamedon'], ['edoras', 'belfalas'],
  ['minas_tirith', 'udun'], ['ithilien', 'udun'], ['ithilien', 'gorgoroth'], ['ithilien', 'mount_doom'], ['minas_tirith', 'minas_morgul'],
  ['lebennin', 'minas_morgul'], ['harondor', 'minas_morgul'],
  ['emyn_muil', 'barad_dur'], ['emyn_muil', 'mount_doom'], ['brown_lands', 'barad_dur'], ['mattaram', 'barad_dur'], ['mattaram', 'mount_doom'],
  ['dead_marshes', 'mount_doom'], ['dead_marshes', 'barad_dur'], ['emyn_muil', 'udun'],
  ['brown_lands', 'mount_doom'], ['brown_lands', 'udun'], ['mistrand', 'barad_dur'],
  ['khand', 'gorgoroth'], ['near_harad', 'gorgoroth'], ['near_harad', 'nurn'], ['east_harondor', 'minas_morgul'], ['east_harondor', 'gorgoroth'],
  ['harad', 'gorgoroth'], ['harondor', 'gorgoroth'],
];
/** Liaisons ajoutées (mer, cols) — dessinées en pointillés. */
const ROUTES = [
  ['umbar', 'dol_amroth'],
  ['forlindon', 'harlindon'],
];

// ═══════════════════════════ Géométrie ═══════════════════════════

const P = ([x, y]) => [x * S, y * S];
const round = (v) => Math.round(v * 10) / 10;
const land = polygonClipping.difference([LAND.map(P)], ...LAKES.map((l) => [l.ring.map(P)]));

const seeds = T.map((x) => P(x.seed));
const delaunay = Delaunay.from(seeds);
const voronoi = delaunay.voronoi([0, 0, WIDTH, HEIGHT]);

/** Ondulation déterministe d'une arête : identique pour les deux cellules qui la partagent. */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
function noise(seed, i) {
  const h = hash(`${seed}:${i}`);
  return (h % 2000) / 1000 - 1; // [-1, 1)
}
function wobble(a, b) {
  const key = [a, b].map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).sort().join('|');
  const [p, q] = key.startsWith(`${a[0].toFixed(2)},${a[1].toFixed(2)}`) ? [a, b] : [b, a]; // orientation canonique
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const len = Math.hypot(dx, dy);
  const n = Math.max(1, Math.round(len / WOBBLE_STEP));
  const nx = -dy / len;
  const ny = dx / len;
  const pts = [];
  for (let i = 1; i < n; i++) {
    const tt = i / n;
    const amp = WOBBLE_AMP * Math.sin(Math.PI * tt) * noise(key, i);
    pts.push([p[0] + dx * tt + nx * amp, p[1] + dy * tt + ny * amp]);
  }
  return p === a ? pts : pts.reverse(); // remis dans le sens de parcours de la cellule
}

/** Cellule Voronoï aux frontières ondulées, rognée par la terre. */
function buildCell(i) {
  const cell = voronoi.cellPolygon(i);
  if (!cell) throw new Error(`Pas de cellule pour ${T[i].id}`);
  const ring = [];
  for (let k = 0; k < cell.length - 1; k++) {
    const a = cell[k];
    const b = cell[k + 1];
    ring.push(a, ...wobble(a, b));
  }
  const clipped = polygonClipping.intersection([ring], land);
  if (!clipped.length) throw new Error(`Territoire hors terre : ${T[i].id}`);
  return clipped.map((poly) => poly.map((r) => r.map(([x, y]) => [round(x), round(y)])));
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

const polysById = {};
for (let i = 0; i < T.length; i++) polysById[T[i].id] = buildCell(i);

// ═══════════════════════════ Adjacences ═══════════════════════════
// Deux territoires sont voisins si leurs contours se longent sur au moins
// MIN_BORDER pixels. On mesure par PROXIMITÉ et non par sommets identiques :
// le rognage des cellules sur la côte décale légèrement les points d'un côté à
// l'autre d'une même frontière, ce qui faisait manquer de vraies frontières.
const SAMPLE_STEP = 2; // pas d'échantillonnage du contour (px)
const TOUCH_TOL = 2.5; // deux points plus proches que ça sont sur la même frontière
const MIN_BORDER = 12; // en deçà, simple contact de coin : pas une frontière jouable

/** Contour d'un territoire, rééchantillonné à pas régulier. */
function outlinePoints(id) {
  const pts = [];
  for (const poly of polysById[id]) for (const ring of poly) {
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      const d = Math.hypot(x2 - x1, y2 - y1);
      const n = Math.max(1, Math.ceil(d / SAMPLE_STEP));
      for (let k = 0; k < n; k++) pts.push([x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n]);
    }
  }
  return pts;
}
const outlines = Object.fromEntries(T.map((t) => [t.id, outlinePoints(t.id)]));

// Index spatial des points de contour, pour ne comparer que le voisinage immédiat
const cellOf = (x, y) => `${Math.floor(x / TOUCH_TOL)}:${Math.floor(y / TOUCH_TOL)}`;
const grid = new Map();
for (const t of T) for (const [x, y] of outlines[t.id]) {
  const k = cellOf(x, y);
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push({ id: t.id, x, y });
}
/** Territoires (hors `self`) ayant un point de contour à moins de TOUCH_TOL de (x, y). */
function touchingAt(x, y, self) {
  const cx = Math.floor(x / TOUCH_TOL);
  const cy = Math.floor(y / TOUCH_TOL);
  const out = new Set();
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    for (const q of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
      if (q.id !== self && Math.hypot(q.x - x, q.y - y) <= TOUCH_TOL) out.add(q.id);
    }
  }
  return out;
}

// Longueur de frontière commune ≈ (points de contact comptés des deux côtés / 2) × pas
const shared = new Map();
for (const t of T) for (const [x, y] of outlines[t.id]) for (const other of touchingAt(x, y, t.id)) {
  const k = [t.id, other].sort().join('|');
  shared.set(k, (shared.get(k) ?? 0) + 1);
}
const borderLength = new Map([...shared].map(([k, n]) => [k, (n / 2) * SAMPLE_STEP]));

const neighbors = Object.fromEntries(T.map((x) => [x.id, new Set()]));
const blockedSet = new Set(BLOCKED.map(([a, b]) => [a, b].sort().join('|')));
const ridgePairs = [];
for (const [k, len] of borderLength) {
  if (len < MIN_BORDER) continue;
  const [a, b] = k.split('|');
  if (blockedSet.has(k)) {
    ridgePairs.push([a, b]);
    continue;
  }
  neighbors[a].add(b);
  neighbors[b].add(a);
}
const tooShort = [...borderLength].filter(([k, len]) => len > 0 && len < MIN_BORDER);
if (tooShort.length) console.log(`Contacts de coin ignorés (< ${MIN_BORDER} px) : ${tooShort.map(([k, l]) => `${k} ${l.toFixed(0)}px`).join(', ')}`);
const unusedBlocks = [...blockedSet].filter((k) => !ridgePairs.some(([a, b]) => `${a}|${b}` === k));
if (unusedBlocks.length) console.warn('⚠ Blocages sans frontière commune :', unusedBlocks.join(' '));
for (const [a, b] of ROUTES) {
  if (!neighbors[a] || !neighbors[b]) throw new Error(`Route invalide ${a}-${b}`);
  neighbors[a].add(b);
  neighbors[b].add(a);
}

// ═══════════════════════════ Crêtes de montagnes ═══════════════════════════
// Points du contour de A longeant celui de B (même tolérance que les adjacences),
// groupés en polylignes consécutives.
function ridgeFor(a, b) {
  const lines = [];
  for (const poly of polysById[a]) {
    const ring = poly[0];
    let run = [];
    const flush = () => {
      if (run.length >= 2) lines.push(run);
      run = [];
    };
    for (const p of ring) {
      if (touchingAt(p[0], p[1], a).has(b)) run.push(p);
      else flush();
    }
    flush();
  }
  return lines;
}
const ridges = ridgePairs.flatMap(([a, b]) => ridgeFor(a, b));

// ═══════════════════════════ Sortie ═══════════════════════════

const territories = {};
for (const terr of T) {
  const polys = polysById[terr.id];
  const biggest = polys.reduce((best, p) => (ringArea(p[0]) > ringArea(best[0]) ? p : best), polys[0]);
  const pole = polylabel(biggest, 0.5);
  territories[terr.id] = {
    name: terr.name,
    continent: terr.region,
    label: [round(pole[0]), round(pole[1])],
    r: round(pole.distance),
    neighbors: [...neighbors[terr.id]].sort(),
    polys,
  };
}
const continents = {};
for (const [id, r] of Object.entries(REGIONS)) {
  const ids = T.filter((x) => x.region === id).map((x) => x.id);
  const union = polygonClipping.union(...ids.map((tid) => polysById[tid]));
  continents[id] = {
    name: r.name,
    bonus: bonusFor(ids.length),
    color: r.color,
    label: P(r.label).map(round),
    polys: union.map((poly) => poly.map((ring) => ring.map(([x, y]) => [round(x), round(y)]))),
  };
}

console.log(`${T.length} territoires, carte ${WIDTH}×${HEIGHT}, ${ridges.length} crêtes`);
for (const [id, c] of Object.entries(continents)) console.log(`  ${id} ${c.name.padEnd(18)} ${T.filter((x) => x.region === id).length} territoires → +${c.bonus}`);
console.log('\nAdjacences :');
for (const terr of T) console.log(`  ${terr.id.padEnd(18)} → ${territories[terr.id].neighbors.join(', ')}`);
const isolated = T.filter((x) => territories[x.id].neighbors.length === 0);
if (isolated.length) throw new Error(`Territoires isolés : ${isolated.map((x) => x.id).join(', ')}`);
// Connexité
const seen = new Set([T[0].id]);
const stack = [T[0].id];
while (stack.length) for (const n of territories[stack.pop()].neighbors) if (!seen.has(n)) { seen.add(n); stack.push(n); }
if (seen.size !== T.length) throw new Error(`Graphe non connexe : ${T.length - seen.size} territoire(s) inaccessibles : ${T.filter((x) => !seen.has(x.id)).map((x) => x.id).join(', ')}`);

const data = {
  width: WIDTH,
  height: HEIGHT,
  wrap: false,
  continents,
  territories,
  seaRoutes: ROUTES,
  // Paires qui partagent une frontière mais qu'une chaîne de montagnes rend
  // infranchissable : l'audit de test s'en sert pour distinguer un mur voulu
  // d'une adjacence oubliée.
  blockedPairs: ridgePairs,
  ridges: ridges.map((line) => line.map(([x, y]) => [round(x), round(y)])),
  zones: ZONES.map((z) => ({ name: z.name, label: P(z.label).map(round), ring: z.ring.map(P).map(([x, y]) => [round(x), round(y)]) })),
  oceanLabels: OCEAN_LABELS.map(([name, x, y]) => ({ name, pos: P([x, y]).map(round) })),
};
const header = `/**
 * DONNÉES GÉNÉRÉES — ne pas éditer à la main : \`cd tools && node build-middle-earth.mjs\`.
 * Terre du Milieu : ${T.length} territoires, ${Object.keys(REGIONS).length} régions, carte ${WIDTH}×${HEIGHT}, sans bouclage.
 */
export const MAP_DATA = `;
const out = header + JSON.stringify(data) + ';\n';
writeFileSync(new URL('../src/core/maps/middle_earth.js', import.meta.url), out);
console.log(`\n→ src/core/maps/middle_earth.js (${Math.round(out.length / 1024)} Ko)`);
