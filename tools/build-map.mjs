/**
 * Construit src/core/maps/world.js à partir des données Natural Earth (domaine public).
 *
 *   cd tools && node build-map.mjs
 *
 * Étapes :
 *  1. lecture des GeoJSON 50m (pays entiers + États/provinces des 9 grands pays) ;
 *  2. regroupement des entités en territoires (table TERRITORIES ci-dessous) ;
 *  3. adjacences = territoires dont les contours partagent des points (+ routes maritimes) ;
 *  4. fusion des polygones (polygon-clipping), projection Miller, simplification ;
 *  5. point d'étiquette (polylabel) et contours de continents ;
 *  6. écriture d'un module JS pur, sans dépendance, utilisé par src/core/map.js.
 *
 * Sources (déjà téléchargées dans tools/cache/) :
 *  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson
 *  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_1_states_provinces.geojson
 */
import { readFileSync, writeFileSync } from 'node:fs';
import polygonClipping from 'polygon-clipping';
import polylabel from 'polylabel';
import simplify from 'simplify-js';

const WIDTH = 2400;
const LAT_MAX = 84;
const LAT_MIN = -57;
const SIMPLIFY_TOLERANCE = 1.1; // en unités carte (px à zoom 1)
const MIN_RING_AREA = 14; // îlots plus petits supprimés (px²)
const ADJ_TOLERANCE = 0.02; // degrés : points "partagés" entre contours voisins

// ═══════════════════════════ Territoires ═══════════════════════════
// members : codes ISO pays (admin-0) ou codes admin-1 "XX-YY".
// bbox [minLon, minLat, maxLon, maxLat] : ne garde que les morceaux dont le centroïde est dedans
// (sert à écarter les îles lointaines : Guyane pour la France, Svalbard, Hawaï…).
const T = [];
const t = (id, name, continent, members, bbox) => T.push({ id, name, continent, members, bbox });

// ── Amérique du Nord ──
t('alaska', 'Alaska', 'NA', ['US-AK']);
t('yukon', 'Yukon et T. N.-O.', 'NA', ['CA-YT', 'CA-NT']);
t('nunavut', 'Nunavut', 'NA', ['CA-NU']);
t('greenland', 'Groenland', 'NA', ['GRL']);
t('british_columbia', 'Colombie-Britannique', 'NA', ['CA-BC']);
t('prairies', 'Prairies', 'NA', ['CA-AB', 'CA-SK', 'CA-MB']);
t('ontario', 'Ontario', 'NA', ['CA-ON']);
t('quebec', 'Québec', 'NA', ['CA-QC', 'CA-NL', 'CA-NB', 'CA-NS', 'CA-PE']);
t('pacific_northwest', 'Nord-Ouest Pacifique', 'NA', ['US-WA', 'US-OR', 'US-ID', 'US-MT', 'US-WY']);
t('california', 'Californie', 'NA', ['US-CA', 'US-NV', 'US-UT', 'US-AZ']);
t('great_plains', 'Grandes Plaines', 'NA', ['US-ND', 'US-SD', 'US-NE', 'US-KS', 'US-CO', 'US-OK']);
t('midwest', 'Midwest', 'NA', ['US-MN', 'US-IA', 'US-MO', 'US-WI', 'US-IL', 'US-IN', 'US-MI', 'US-OH']);
t('southern_us', 'Sud des États-Unis', 'NA', ['US-TX', 'US-NM', 'US-LA', 'US-AR', 'US-MS', 'US-AL', 'US-TN', 'US-KY']);
t('eastern_us', 'Côte Est', 'NA', ['US-FL', 'US-GA', 'US-SC', 'US-NC', 'US-VA', 'US-WV', 'US-MD', 'US-DE', 'US-DC', 'US-PA', 'US-NJ', 'US-NY', 'US-CT', 'US-RI', 'US-MA', 'US-VT', 'US-NH', 'US-ME']);
t('mexico', 'Mexique', 'NA', ['MEX']);
t('central_america', 'Amérique centrale', 'NA', ['GTM', 'BLZ', 'HND', 'SLV', 'NIC', 'CRI', 'PAN']);
t('caribbean', 'Caraïbes', 'NA', ['CUB', 'HTI', 'DOM', 'JAM', 'BHS', 'PRI', 'TTO']);
// ── Amérique du Sud ──
t('venezuela', 'Venezuela et Guyanes', 'SA', ['VEN', 'GUY', 'SUR', 'FRA'], [-75, -1, -50, 13]); // FRA → seulement la Guyane
t('colombia', 'Colombie', 'SA', ['COL', 'ECU'], [-82, -6, -66, 14]);
t('peru', 'Pérou', 'SA', ['PER']);
t('amazonia', 'Amazonie', 'SA', ['BR-AM', 'BR-PA', 'BR-RR', 'BR-AP', 'BR-AC', 'BR-RO', 'BR-MT', 'BR-TO']);
t('brazil', 'Brésil', 'SA', ['BR-MA', 'BR-PI', 'BR-CE', 'BR-RN', 'BR-PB', 'BR-PE', 'BR-AL', 'BR-SE', 'BR-BA', 'BR-MG', 'BR-ES', 'BR-RJ', 'BR-SP', 'BR-PR', 'BR-SC', 'BR-RS', 'BR-GO', 'BR-DF', 'BR-MS']);
t('bolivia', 'Bolivie et Paraguay', 'SA', ['BOL', 'PRY']);
t('argentina', 'Argentine', 'SA', ['ARG', 'URY']);
t('chile', 'Chili', 'SA', ['CHL'], [-80, -60, -60, -15]);
// ── Europe ──
t('iceland', 'Islande', 'EU', ['ISL']);
t('british_isles', 'Îles Britanniques', 'EU', ['GBR', 'IRL']);
t('scandinavia', 'Scandinavie', 'EU', ['NOR', 'SWE', 'DNK'], [0, 53, 32, 72]);
t('finland_baltics', 'Finlande et Baltique', 'EU', ['FIN', 'EST', 'LVA', 'LTU']);
t('western_europe', 'France et Benelux', 'EU', ['FRA', 'BEL', 'NLD', 'LUX'], [-10, 41, 12, 54]);
t('iberia', 'Ibérie', 'EU', ['ESP', 'PRT'], [-12, 35, 5, 44]);
t('germany', 'Allemagne', 'EU', ['DEU', 'CHE', 'AUT']);
t('central_europe', 'Europe centrale', 'EU', ['POL', 'CZE', 'SVK', 'HUN']);
t('italy', 'Italie', 'EU', ['ITA', 'MLT', 'SMR', 'VAT']);
t('balkans', 'Balkans', 'EU', ['SVN', 'HRV', 'BIH', 'SRB', 'MNE', 'KOS', 'MKD', 'ALB', 'GRC', 'BGR', 'ROU', 'MDA']);
t('ukraine', 'Ukraine', 'EU', ['UKR', 'BLR', 'UA-43', 'UA-40']);
t('northern_russia', 'Russie du Nord', 'EU', ['RU-MUR', 'RU-KR', 'RU-ARK', 'RU-NEN', 'RU-KO', 'RU-VLG']);
t('moscow', 'Russie centrale', 'EU', ['RU-NGR', 'RU-PSK', 'RU-LEN', 'RU-SPE', 'RU-BRY', 'RU-SMO', 'RU-IVA', 'RU-KOS', 'RU-TVE', 'RU-YAR', 'RU-KLU', 'RU-KRS', 'RU-LIP', 'RU-MOW', 'RU-MOS', 'RU-ORL', 'RU-TUL', 'RU-BEL', 'RU-RYA', 'RU-TAM', 'RU-VLA', 'RU-VOR', 'RU-NIZ', 'RU-KIR', 'RU-ME', 'RU-CU', 'RU-MO']);
t('volga', 'Volga et Don', 'EU', ['RU-PNZ', 'RU-TA', 'RU-ULY', 'RU-UD', 'RU-SAM', 'RU-SAR', 'RU-VGG', 'RU-ROS', 'RU-AST', 'RU-KL', 'RU-KDA', 'RU-AD', 'RU-STA']);
// ── Afrique ──
t('maghreb', 'Maghreb', 'AF', ['MAR', 'DZA', 'TUN', 'SAH']);
t('libya', 'Libye', 'AF', ['LBY']);
t('egypt', 'Égypte', 'AF', ['EGY']);
t('sahel', 'Sahel', 'AF', ['MRT', 'MLI', 'NER', 'TCD']);
t('west_africa', 'Afrique de l’Ouest', 'AF', ['SEN', 'GMB', 'GNB', 'GIN', 'SLE', 'LBR', 'CIV', 'GHA', 'TGO', 'BEN', 'BFA']);
t('nigeria', 'Nigeria et Cameroun', 'AF', ['NGA', 'CMR']);
t('sudan', 'Soudan', 'AF', ['SDN', 'SDS']);
t('ethiopia', 'Corne de l’Afrique', 'AF', ['ETH', 'ERI', 'DJI', 'SOM', 'SOL']);
t('central_africa', 'Afrique centrale', 'AF', ['CAF', 'COD', 'COG', 'GAB', 'GNQ']);
t('east_africa', 'Afrique de l’Est', 'AF', ['KEN', 'UGA', 'TZA', 'RWA', 'BDI']);
t('angola', 'Angola et Zambie', 'AF', ['AGO', 'ZMB', 'MWI']);
t('southern_africa', 'Afrique australe', 'AF', ['ZA-NC', 'ZA-WC', 'ZA-NW', 'ZA-FS', 'ZA-GT', 'ZA-MP', 'ZA-LP', 'ZA-NL', 'ZA-EC', 'NAM', 'BWA', 'ZWE', 'MOZ', 'LSO', 'SWZ']);
t('madagascar', 'Madagascar', 'AF', ['MDG']);
// ── Asie ──
t('turkey', 'Turquie', 'AS', ['TUR', 'CYP', 'CYN']);
t('middle_east', 'Moyen-Orient', 'AS', ['SYR', 'LBN', 'ISR', 'PSX', 'JOR', 'IRQ']);
t('arabia', 'Arabie', 'AS', ['SAU', 'YEM', 'OMN', 'ARE', 'QAT', 'KWT', 'BHR']);
t('caucasus', 'Caucase', 'AS', ['GEO', 'ARM', 'AZE', 'RU-KC', 'RU-IN', 'RU-KB', 'RU-SE', 'RU-CE', 'RU-DA']);
t('persia', 'Perse', 'AS', ['IRN']);
t('afghanistan', 'Afghanistan', 'AS', ['AFG', 'PAK', 'KAS']);
t('central_asia', 'Asie centrale', 'AS', ['KAZ', 'UZB', 'TKM', 'KGZ', 'TJK']);
t('ural', 'Oural', 'AS', ['RU-BA', 'RU-ORE', 'RU-CHE', 'RU-KGN', 'RU-SVE', 'RU-PER', 'RU-TYU', 'RU-KHM', 'RU-YAN']);
t('western_siberia', 'Sibérie occidentale', 'AS', ['RU-OMS', 'RU-TOM', 'RU-NVS', 'RU-ALT', 'RU-AL', 'RU-KEM', 'RU-KK', 'RU-KYA', 'RU-TY']);
t('eastern_siberia', 'Sibérie orientale', 'AS', ['RU-IRK', 'RU-BU', 'RU-ZAB', 'RU-SA']);
t('far_east', 'Extrême-Orient russe', 'AS', ['RU-AMU', 'RU-YEV', 'RU-KHA', 'RU-PRI', 'RU-SAK']);
t('kamchatka', 'Kamtchatka', 'AS', ['RU-KAM', 'RU-MAG', 'RU-CHU']);
t('mongolia', 'Mongolie', 'AS', ['MNG']);
t('manchuria', 'Mandchourie', 'AS', ['CN-HL', 'CN-JL', 'CN-LN']);
t('northern_china', 'Chine du Nord', 'AS', ['CN-NM', 'CN-BJ', 'CN-TJ', 'CN-HE', 'CN-SX', 'CN-SD', 'CN-HA', 'CN-SN', 'CN-GS', 'CN-NX']);
t('xinjiang', 'Xinjiang', 'AS', ['CN-XJ']);
t('tibet', 'Tibet', 'AS', ['CN-XZ', 'CN-QH', 'NPL', 'BTN']);
t('southern_china', 'Chine du Sud', 'AS', ['CN-SC', 'CN-CQ', 'CN-YN', 'CN-GZ', 'CN-HB', 'CN-HN', 'CN-JX', 'CN-AH', 'CN-JS', 'CN-SH', 'CN-ZJ', 'CN-FJ', 'CN-GD', 'CN-GX', 'CN-HI', 'TWN', 'HKG', 'MAC']);
t('korea', 'Corée', 'AS', ['PRK', 'KOR']);
t('japan', 'Japon', 'AS', ['JPN']);
t('india', 'Inde', 'AS', ['IN-SK', 'IN-TG', 'IN-LA', 'IN-CH', 'IN-DL', 'IN-HP', 'IN-HR', 'IN-JK', 'IN-AP', 'IN-KL', 'IN-OR', 'IN-DH', 'IN-KA', 'IN-GA', 'IN-AS', 'IN-MN', 'IN-NL', 'IN-ML', 'IN-PB', 'IN-RJ', 'IN-UP', 'IN-UT', 'IN-JH', 'IN-WB', 'IN-BR', 'IN-CT', 'IN-MP', 'IN-PY', 'IN-TN', 'IN-GJ', 'IN-AR', 'IN-MZ', 'IN-TR', 'IN-MH', 'BGD', 'LKA']);
t('indochina', 'Indochine', 'AS', ['MMR', 'THA', 'LAO', 'KHM', 'VNM', 'MYS', 'SGP'], [90, 0, 108, 30]); // MYS → péninsule seulement
// ── Océanie ──
t('indonesia', 'Indonésie', 'OC', ['ID-AC', 'ID-KI', 'ID-JB', 'ID-JT', 'ID-BE', 'ID-BT', 'ID-JK', 'ID-KB', 'ID-LA', 'ID-SS', 'ID-BB', 'ID-BA', 'ID-JI', 'ID-KS', 'ID-NT', 'ID-SN', 'ID-SR', 'ID-KR', 'ID-GO', 'ID-JA', 'ID-KT', 'ID-SU', 'ID-RI', 'ID-SA', 'ID-MU', 'ID-SB', 'ID-YO', 'ID-MA', 'ID-NB', 'ID-SG', 'ID-ST', 'MYS', 'BRN', 'TLS'], [95, -12, 132, 8]); // MYS → Bornéo seulement
t('philippines', 'Philippines', 'OC', ['PHL']);
t('new_guinea', 'Nouvelle-Guinée', 'OC', ['ID-PA', 'ID-PB', 'PNG', 'SLB']);
t('western_australia', 'Australie occidentale', 'OC', ['AU-WA', 'AU-NT', 'AU-SA']);
t('eastern_australia', 'Australie orientale', 'OC', ['AU-QLD', 'AU-NSW', 'AU-VIC', 'AU-ACT', 'AU-X02~', 'AU-TAS']);
t('new_zealand', 'Nouvelle-Zélande', 'OC', ['NZL'], [160, -50, 180, -30]);

const CONTINENTS = {
  NA: { name: 'Amérique du Nord', bonus: 9, color: '#d9a92c', label: [-142, 22] },
  SA: { name: 'Amérique du Sud', bonus: 4, color: '#e8792d', label: [-28, -28] },
  EU: { name: 'Europe', bonus: 8, color: '#3d5fd0', label: [-26, 50] },
  AF: { name: 'Afrique', bonus: 7, color: '#b03aa0', label: [-4, -34] },
  AS: { name: 'Asie', bonus: 12, color: '#3fa34d', label: [152, 12] },
  OC: { name: 'Océanie', bonus: 3, color: '#6b6f78', label: [170, -44] },
};

/** Routes maritimes (adjacences ajoutées à la main). */
const SEA_ROUTES = [
  ['alaska', 'kamchatka'], // par le bord de la carte (détroit de Béring)
  ['greenland', 'iceland'],
  ['greenland', 'nunavut'],
  ['greenland', 'quebec'],
  ['iceland', 'british_isles'],
  ['iceland', 'scandinavia'],
  ['british_isles', 'western_europe'],
  ['british_isles', 'scandinavia'],
  ['scandinavia', 'germany'],
  ['scandinavia', 'central_europe'],
  ['eastern_us', 'caribbean'],
  ['mexico', 'caribbean'],
  ['caribbean', 'venezuela'],
  ['caribbean', 'central_america'],
  ['brazil', 'west_africa'],
  ['iberia', 'maghreb'],
  ['italy', 'maghreb'],
  ['italy', 'balkans'],
  ['italy', 'libya'],
  ['balkans', 'turkey'],
  ['turkey', 'egypt'],
  ['arabia', 'ethiopia'],
  ['arabia', 'persia'],
  ['madagascar', 'southern_africa'],
  ['madagascar', 'east_africa'],
  ['japan', 'korea'],
  ['japan', 'far_east'],
  ['japan', 'kamchatka'],
  ['southern_china', 'philippines'],
  ['philippines', 'indonesia'],
  ['indochina', 'indonesia'],
  ['indonesia', 'western_australia'],
  ['new_guinea', 'eastern_australia'],
  ['new_guinea', 'indonesia'],
  ['eastern_australia', 'new_zealand'],
  ['india', 'indochina'],
  ['india', 'arabia'],
  ['chile', 'argentina'],
  ['quebec', 'eastern_us'],
];
/** Adjacences terrestres détectées mais indésirables. */
const EXCLUDE = [];

const OCEAN_LABELS = [
  ['OCÉAN PACIFIQUE', -150, -8],
  ['OCÉAN ATLANTIQUE', -38, 18],
  ['OCÉAN INDIEN', 82, -28],
  ['OCÉAN ARCTIQUE', 40, 81],
  ['OCÉAN AUSTRAL', 120, -54],
];

// ═══════════════════════════ Chargement ═══════════════════════════

const admin0 = JSON.parse(readFileSync(new URL('./cache/ne_50m_admin_0.geojson', import.meta.url), 'utf8'));
const admin1 = JSON.parse(readFileSync(new URL('./cache/ne_50m_admin_1.geojson', import.meta.url), 'utf8'));

/** code → liste de polygones (chaque polygone = liste d'anneaux [lon,lat]) */
const featuresByCode = new Map();
const add = (code, geom) => {
  if (!geom) return;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  if (!featuresByCode.has(code)) featuresByCode.set(code, []);
  featuresByCode.get(code).push(...polys);
};
for (const f of admin1.features) add(f.properties.iso_3166_2, f.geometry);
const splitCountries = new Set(admin1.features.map((f) => f.properties.adm0_a3));
for (const f of admin0.features) {
  const code = f.properties.ADM0_A3;
  if (splitCountries.has(code)) continue; // découpés en admin-1
  add(code, f.geometry);
}

function centroid(ring) {
  let x = 0, y = 0;
  for (const [lon, lat] of ring) { x += lon; y += lat; }
  return [x / ring.length, y / ring.length];
}

// ═══════════════════════════ Regroupement ═══════════════════════════

const used = new Set();
for (const terr of T) {
  terr.polys = [];
  for (const code of terr.members) {
    const polys = featuresByCode.get(code);
    if (!polys) { console.warn(`⚠ code inconnu : ${code} (${terr.id})`); continue; }
    used.add(code);
    for (const poly of polys) {
      if (terr.bbox) {
        const [cx, cy] = centroid(poly[0]);
        const [a, b, c, d] = terr.bbox;
        if (cx < a || cx > c || cy < b || cy > d) continue;
      }
      terr.polys.push(poly);
    }
  }
  if (!terr.polys.length) throw new Error(`Territoire vide : ${terr.id}`);
}
const unused = [...featuresByCode.keys()].filter((c) => !used.has(c));
console.log(`Entités non utilisées (${unused.length}) : ${unused.join(' ')}`);

// ═══════════════════════════ Adjacences ═══════════════════════════

const cellOf = (lon, lat) => `${Math.round(lon / ADJ_TOLERANCE)}:${Math.round(lat / ADJ_TOLERANCE)}`;
const cellOwners = new Map(); // cellule → Set(territoire)
for (const terr of T) {
  for (const poly of terr.polys) for (const ring of poly) for (const [lon, lat] of ring) {
    // On enregistre la cellule et ses 8 voisines pour tolérer les décalages
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const key = cellOf(lon + dx * ADJ_TOLERANCE, lat + dy * ADJ_TOLERANCE);
      if (!cellOwners.has(key)) cellOwners.set(key, new Set());
      cellOwners.get(key).add(terr.id);
    }
  }
}
const adj = new Map(T.map((x) => [x.id, new Map()])); // id → (voisin → nb points partagés)
for (const owners of cellOwners.values()) {
  if (owners.size < 2) continue;
  const list = [...owners];
  for (const a of list) for (const b of list) if (a !== b) adj.get(a).set(b, (adj.get(a).get(b) ?? 0) + 1);
}
const MIN_SHARED = 3; // au moins 3 cellules communes pour éviter les contacts ponctuels
const neighbors = Object.fromEntries(T.map((x) => [x.id, new Set()]));
for (const [a, m] of adj) for (const [b, n] of m) if (n >= MIN_SHARED) { neighbors[a].add(b); neighbors[b].add(a); }
for (const [a, b] of EXCLUDE) { neighbors[a].delete(b); neighbors[b].delete(a); }
for (const [a, b] of SEA_ROUTES) {
  if (!neighbors[a] || !neighbors[b]) throw new Error(`Route maritime invalide ${a}-${b}`);
  neighbors[a].add(b); neighbors[b].add(a);
}

// ═══════════════════════════ Projection (Miller) ═══════════════════════════

const millerY = (lat) => 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * (lat * Math.PI) / 180));
const Y_TOP = millerY(LAT_MAX);
const Y_BOT = millerY(LAT_MIN);
const HEIGHT = Math.round((WIDTH * (Y_TOP - Y_BOT)) / (2 * Math.PI));
const project = ([lon, lat]) => {
  const clamped = Math.max(LAT_MIN, Math.min(LAT_MAX, lat));
  return [((lon + 180) / 360) * WIDTH, ((Y_TOP - millerY(clamped)) / (Y_TOP - Y_BOT)) * HEIGHT];
};

function ringArea(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

/** Fusionne, projette, simplifie ; renvoie [polygones projetés (anneaux [x,y]), polygones bruts fusionnés]. */
function buildShape(polys) {
  const merged = polygonClipping.union(...polys.map((p) => [p]));
  const projected = merged.map((poly) => poly.map((ring) => ring.map(project)));
  // Simplification + suppression des îlots minuscules
  const areas = projected.map((poly) => Math.abs(ringArea(poly[0])));
  const maxArea = Math.max(...areas);
  const out = [];
  projected.forEach((poly, i) => {
    if (areas[i] < MIN_RING_AREA && areas[i] !== maxArea) return;
    const rings = [];
    poly.forEach((ring, j) => {
      const pts = simplify(ring.map(([x, y]) => ({ x, y })), SIMPLIFY_TOLERANCE, true).map((p) => [round(p.x), round(p.y)]);
      if (pts.length < 4) return;
      if (j > 0 && Math.abs(ringArea(pts)) < MIN_RING_AREA) return; // trou minuscule
      rings.push(pts);
    });
    if (rings.length) out.push(rings);
  });
  return [out, merged];
}
const round = (v) => Math.round(v * 10) / 10;

const outTerritories = {};
const continentPolys = Object.fromEntries(Object.keys(CONTINENTS).map((c) => [c, []]));
let totalPoints = 0;
for (const terr of T) {
  const [shape, merged] = buildShape(terr.polys);
  continentPolys[terr.continent].push(...merged);
  // Point d'étiquette : pôle d'inaccessibilité du plus grand polygone
  const biggest = shape.reduce((best, poly) => (Math.abs(ringArea(poly[0])) > Math.abs(ringArea(best[0])) ? poly : best), shape[0]);
  const pole = polylabel(biggest, 0.5);
  const label = [round(pole[0]), round(pole[1])];
  // r = rayon du cercle inscrit : sert à décider si le nom tient dans le territoire selon le zoom
  outTerritories[terr.id] = { name: terr.name, continent: terr.continent, label, r: round(pole.distance), neighbors: [...neighbors[terr.id]].sort(), polys: shape };
  totalPoints += shape.reduce((s, poly) => s + poly.reduce((s2, r) => s2 + r.length, 0), 0);
}

const outContinents = {};
for (const [id, c] of Object.entries(CONTINENTS)) {
  const [shape] = buildShape(continentPolys[id]);
  outContinents[id] = { name: c.name, bonus: c.bonus, color: c.color, label: project(c.label).map(round), polys: shape };
}

// ═══════════════════════════ Rapport ═══════════════════════════

console.log(`\n${T.length} territoires, ${totalPoints} points, carte ${WIDTH}×${HEIGHT}`);
for (const c of Object.keys(CONTINENTS)) {
  const ids = T.filter((x) => x.continent === c).map((x) => x.id);
  console.log(`  ${c} (${ids.length}, +${CONTINENTS[c].bonus})`);
}
console.log('\nAdjacences :');
for (const terr of T) console.log(`  ${terr.id.padEnd(20)} → ${outTerritories[terr.id].neighbors.join(', ')}`);
const isolated = T.filter((x) => outTerritories[x.id].neighbors.length === 0);
if (isolated.length) throw new Error(`Territoires isolés : ${isolated.map((x) => x.id).join(', ')}`);

// ═══════════════════════════ Écriture ═══════════════════════════

const data = {
  width: WIDTH,
  height: HEIGHT,
  continents: outContinents,
  territories: outTerritories,
  seaRoutes: SEA_ROUTES,
  oceanLabels: OCEAN_LABELS.map(([name, lon, lat]) => ({ name, pos: project([lon, lat]).map(round) })),
};
const header = `/**
 * DONNÉES GÉNÉRÉES — ne pas éditer à la main : \`cd tools && node build-map.mjs\`.
 * Source : Natural Earth 1:50m (domaine public), projection de Miller, largeur ${WIDTH}.
 * Coordonnées en unités carte ; la carte boucle horizontalement (x = 0 ≡ x = ${WIDTH}).
 */
export const MAP_DATA = `;
const out = header + JSON.stringify(data) + ';\n';
writeFileSync(new URL('../src/core/maps/world.js', import.meta.url), out);
console.log(`\n→ src/core/maps/world.js (${Math.round(out.length / 1024)} Ko)`);
