/**
 * Carte interactive SVG, construite pour UNE carte du catalogue (objet `map`
 * de src/core/map.js) : contours, zoom à la molette, déplacement à la souris
 * ou au doigt.
 *
 *  - Carte bouclée (monde) : le monde est dessiné trois fois côte à côte
 *    (x = 0, W, 2W) et la fenêtre de vue est ramenée modulo la largeur, comme un
 *    carrousel à plat. Les copies sont de vrais nœuds DOM (les instances <use>
 *    n'héritent pas des feuilles de style dans Chrome) : chaque mise à jour est
 *    appliquée à toutes.
 *  - Carte non bouclée (Terre du Milieu) : une seule copie, la vue est bornée.
 *
 * Interactions : le SVG n'écoute que les événements de pointeur ; le territoire
 * visé est retrouvé par test point-dans-polygone (map.territoryAt).
 *
 * Mise en évidence (classes CSS sur .territory et .badge) :
 *   selected  : territoire choisi (attaquant / origine du déplacement)
 *   target    : cible d'attaque possible
 *   reachable : destination de déplacement possible
 *   placeable : peut recevoir des renforts
 *   dim       : hors contexte (atténué)
 */
import { playerHex } from '../core/state.js';

const NS = 'http://www.w3.org/2000/svg';
const BADGE_R = 13;
const DRAG_THRESHOLD = 4; // px avant de considérer un glissement
const OCEAN = '#d8c48f';

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

export class MapView {
  /**
   * @param {HTMLElement} container
   * @param {(territoryId:string)=>void} onClick
   * @param {object} map  objet carte (src/core/map.js → getMap)
   */
  constructor(container, onClick, map) {
    this.container = container;
    this.onClick = onClick;
    this.map = map;
    this.W = map.width;
    this.H = map.height;
    this.minViewW = this.W / 10; // zoom maximal
    this.maxViewW = map.wrap ? 2 * this.W : this.W; // zoom minimal
    this.view = { x: 0, y: 0, w: this.W }; // fenêtre de vue en unités carte (h dérivée du conteneur)
    this.hover = null;
    this.badgeScale = 1;

    const svg = el('svg', { class: 'worldmap', role: 'img', 'aria-label': `Carte : ${map.name}` });
    this.svg = svg;
    // Fenêtre x ∈ [0, W) et largeur ≤ 2W : les copies 0, W et 2W couvrent toujours l'écran
    const offsets = map.wrap ? [0, this.W, 2 * this.W] : [0];
    /** @type {Array<Record<string,{g:Element,shape:Element,title:Element,badge:Element,body:Element,troops:Element,name:Element}>>} */
    this.copies = offsets.map((dx) => this.buildWorld(el('g', { transform: `translate(${dx} 0)` }, svg)));

    container.innerHTML = '';
    container.appendChild(svg);
    container.appendChild(this.buildControls());
    this.bindPointer();
    // Le conteneur n'a pas de taille tant que l'écran de jeu est caché : on recadre au premier vrai dimensionnement
    this.fitted = false;
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.fitted && container.clientWidth > 50) {
        this.fitted = true;
        this.fit();
      } else this.applyView();
    });
    this.resizeObserver.observe(container);
    this.fit();
  }

  /** Détache la vue (changement de carte). */
  destroy() {
    this.resizeObserver.disconnect();
    this.container.innerHTML = '';
  }

  /** Applique fn à l'élément `key` du territoire `id` dans toutes les copies. */
  each(id, key, fn) {
    for (const nodes of this.copies) fn(nodes[id][key]);
  }

  // ─────────────────────────── Construction ───────────────────────────

  buildWorld(world) {
    const { map, W, H } = this;
    const nodes = {};
    el('rect', { x: 0, y: 0, width: W, height: H, class: 'ocean', fill: OCEAN }, world);

    // Zones infranchissables (décor)
    for (const z of map.ZONES) {
      el('path', { d: 'M' + z.ring.map(([x, y]) => `${x} ${y}`).join('L') + 'Z', class: 'zone' }, world);
      const t = el('text', { x: z.label[0], y: z.label[1], class: 'zone-label' }, world);
      t.textContent = z.name;
    }
    for (const o of map.OCEAN_LABELS) {
      const t = el('text', { x: o.pos[0], y: o.pos[1], class: 'ocean-label' }, world);
      t.textContent = o.name;
    }

    // Halo coloré autour de chaque continent (dessiné sous les territoires)
    const halos = el('g', { class: 'continents' }, world);
    for (const c of Object.values(map.CONTINENTS)) {
      el('path', { d: map.continentPath(c.id), class: 'continent-halo', stroke: c.color }, halos);
    }

    // Routes maritimes (pointillés) ; une liaison qui traverse le bord est tracée vers la copie voisine
    const routes = el('g', { class: 'sea-routes' }, world);
    for (const [a, b] of map.SEA_ROUTES) {
      const pa = map.TERRITORIES[a].pos;
      const pb = map.TERRITORIES[b].pos;
      if (map.wrap && Math.abs(pa.x - pb.x) > W / 2) {
        const [west, east] = pa.x < pb.x ? [pa, pb] : [pb, pa];
        el('line', { x1: west.x, y1: west.y, x2: east.x - W, y2: east.y, class: 'sea-route' }, routes);
        el('line', { x1: east.x, y1: east.y, x2: west.x + W, y2: west.y, class: 'sea-route' }, routes);
      } else {
        el('line', { x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y, class: 'sea-route' }, routes);
      }
    }

    // Territoires (formes) puis crêtes, puis badges (au-dessus de tout)
    const shapes = el('g', { class: 'territories' }, world);
    for (const id of map.TERRITORY_IDS) {
      const t = map.TERRITORIES[id];
      const g = el('g', { class: 'territory', 'data-id': id }, shapes);
      // Le territoire garde la couleur de son continent ; le propriétaire se lit sur la pastille
      const shape = el('path', { d: map.territoryPath(id), class: 'shape', fill: map.CONTINENTS[t.continent].color }, g);
      // Calque de teinte par-dessus la forme : coloré par CSS selon l'état (sélection, cible, destination…)
      el('path', { d: map.territoryPath(id), class: 'overlay' }, g);
      const title = el('title', {}, g);
      nodes[id] = { g, shape, title };
    }

    // Chaînes de montagnes infranchissables : rangée de triangles le long de la crête
    const ridges = el('g', { class: 'ridges' }, world);
    for (const line of map.RIDGES) this.buildRidge(ridges, line);

    const badges = el('g', { class: 'badges' }, world);
    for (const id of map.TERRITORY_IDS) {
      const t = map.TERRITORIES[id];
      const badge = el('g', { class: 'badge territory', 'data-id': id, transform: `translate(${t.pos.x} ${t.pos.y})` }, badges);
      el('circle', { class: 'ring', r: BADGE_R + 5 }, badge);
      const body = el('circle', { class: 'body', r: BADGE_R, fill: '#8a8a8a' }, badge);
      const troops = el('text', { class: 'troops' }, badge);
      const name = el('text', { class: 'name', y: BADGE_R + 11 }, badge);
      name.textContent = t.name;
      Object.assign(nodes[id], { badge, body, troops, name });
    }

    // Médaillons de bonus des continents, entourés d'une couronne de lauriers
    const crowns = el('g', { class: 'crowns' }, world);
    for (const c of Object.values(map.CONTINENTS)) {
      const g = el('g', { class: 'crown', transform: `translate(${c.label.x} ${c.label.y})` }, crowns);
      el('circle', { r: 24, fill: c.color, 'fill-opacity': 0.35, stroke: c.color, 'stroke-width': 2 }, g);
      this.buildLaurel(g, 34);
      const bonus = el('text', { y: 8, class: 'crown-bonus' }, g);
      bonus.textContent = `+${c.bonus}`;
      const label = el('text', { y: 60, class: 'crown-name' }, g);
      label.textContent = c.name;
    }
    return nodes;
  }

  /** Crête de montagnes : triangles alternés le long d'une polyligne. */
  buildRidge(parent, line) {
    const step = 22;
    const pts = [];
    // Rééchantillonnage à intervalle régulier
    let carry = 0;
    for (let i = 0; i < line.length - 1; i++) {
      const [x1, y1] = line[i];
      const [x2, y2] = line[i + 1];
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len === 0) continue;
      let d = carry;
      while (d <= len) {
        const tt = d / len;
        pts.push({ x: x1 + (x2 - x1) * tt, y: y1 + (y2 - y1) * tt, ang: Math.atan2(y2 - y1, x2 - x1) });
        d += step;
      }
      carry = d - len;
    }
    pts.forEach((p, i) => {
      const h = i % 2 === 0 ? 14 : 10; // hauteur alternée
      const w = h * 0.8;
      // Triangle "debout" (pointe vers le haut de l'écran), légèrement décalé de part et d'autre de la crête
      const off = (i % 2 === 0 ? -1 : 1) * 4;
      const ox = -Math.sin(p.ang) * off;
      const oy = Math.cos(p.ang) * off;
      const cx = p.x + ox;
      const cy = p.y + oy;
      el('path', { d: `M${cx - w} ${cy + h * 0.45}L${cx} ${cy - h * 0.55}L${cx + w} ${cy + h * 0.45}Z`, class: 'ridge' }, parent);
      el('path', { d: `M${cx} ${cy - h * 0.55}L${cx + w * 0.35} ${cy - h * 0.15}L${cx} ${cy - h * 0.05}Z`, class: 'ridge-snow' }, parent);
    });
  }

  /** Couronne de lauriers : deux branches courbes garnies de feuilles, ouvertes vers le haut. */
  buildLaurel(parent, R) {
    const g = el('g', { class: 'laurel' }, parent);
    const rad = (deg) => (deg * Math.PI) / 180;
    for (const side of [-1, 1]) {
      const a0 = 90 + side * 8;
      const a1 = 90 + side * 160;
      const p = (a, r = R) => `${(r * Math.cos(rad(a))).toFixed(1)} ${(r * Math.sin(rad(a))).toFixed(1)}`;
      el('path', { d: `M${p(a0)} A${R} ${R} 0 0 ${side > 0 ? 0 : 1} ${p(a1)}`, class: 'laurel-branch' }, g);
      for (let i = 0; i < 9; i++) {
        const a = a0 + side * (12 + i * 16);
        const inner = i % 2 === 0;
        const r = R + (inner ? -4 : 4);
        const x = r * Math.cos(rad(a));
        const y = r * Math.sin(rad(a));
        const tilt = a + (inner ? -side * 25 : side * 25);
        el('ellipse', { cx: 0, cy: 0, rx: 2.6, ry: 7, transform: `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${tilt.toFixed(0)})` }, g);
      }
    }
  }

  buildControls() {
    const div = document.createElement('div');
    div.className = 'map-controls';
    const help = this.map.wrap ? 'molette : zoom · glisser : déplacer · la carte boucle' : 'molette : zoom · glisser : déplacer · ▲▲ montagnes infranchissables';
    div.innerHTML = `<button title="Zoom avant" data-zoom="in">+</button><button title="Zoom arrière" data-zoom="out">−</button><button title="Vue d’ensemble" data-zoom="fit">⤢</button>
      <span class="map-help">${help}</span>`;
    div.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.zoom === 'fit') this.fit();
      else this.zoomAt(b.dataset.zoom === 'in' ? 1.5 : 1 / 1.5);
    });
    div.addEventListener('pointerdown', (e) => e.stopPropagation());
    return div;
  }

  // ─────────────────────────── Vue (zoom / pan / boucle) ───────────────────────────

  get scale() {
    return this.container.clientWidth / this.view.w; // px écran par unité carte
  }

  /** Vue d'ensemble : toute la carte visible. */
  fit() {
    const cw = this.container.clientWidth || 1;
    const ch = this.container.clientHeight || 1;
    const wForHeight = (this.H * cw) / ch;
    this.view = { x: 0, y: 0, w: this.map.wrap ? Math.min(this.maxViewW, Math.max(this.W, wForHeight)) : Math.max(this.W, wForHeight) };
    this.applyView();
  }

  /** Applique la fenêtre de vue au viewBox : boucle x (carte bouclée) ou borne x, borne y. */
  applyView() {
    const cw = this.container.clientWidth || 1;
    const ch = this.container.clientHeight || 1;
    const v = this.view;
    const { W, H } = this;
    if (this.map.wrap) {
      v.w = Math.max(this.minViewW, Math.min(this.maxViewW, v.w));
      v.x = ((v.x % W) + W) % W;
    } else {
      // Non bouclée : on peut dézoomer jusqu'à voir toute la carte (bandes vides autorisées)
      v.w = Math.max(this.minViewW, Math.min(Math.max(W, (H * cw) / ch), v.w));
      if (v.w >= W) v.x = (W - v.w) / 2;
      else v.x = Math.max(0, Math.min(W - v.w, v.x));
    }
    const h = v.w * (ch / cw);
    if (h >= H) v.y = (H - h) / 2;
    else v.y = Math.max(0, Math.min(H - h, v.y));
    this.svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${h}`);
    this.updateBadgeScale();
  }

  /** Les badges gardent une taille lisible à l'écran quel que soit le zoom. */
  updateBadgeScale() {
    const k = this.scale;
    const s = Math.max(0.55, Math.min(2.2, 0.9 / k));
    this.badgeScale = s;
    const namePx = 10 * s * k; // hauteur du nom à l'écran
    for (const id of this.map.TERRITORY_IDS) {
      const t = this.map.TERRITORIES[id];
      const transform = `translate(${t.pos.x} ${t.pos.y}) scale(${s.toFixed(3)})`;
      const show = (t.labelRadius * k > 22 || k > 1.2) && namePx >= 6;
      this.each(id, 'badge', (b) => b.setAttribute('transform', transform));
      this.each(id, 'name', (n) => (n.style.display = show ? '' : 'none'));
    }
  }

  /** Convertit un point carte en position écran (px, relative au conteneur), copie visible choisie. */
  toScreen(x, y) {
    const k = this.scale;
    let px = x;
    if (this.map.wrap) {
      while (px < this.view.x) px += this.W;
      while (px - this.W >= this.view.x) px -= this.W;
    }
    return { x: (px - this.view.x) * k, y: (y - this.view.y) * k };
  }

  /** Convertit une position écran (clientX/Y) en unités carte. */
  toMap(clientX, clientY) {
    const r = this.container.getBoundingClientRect();
    const k = this.scale;
    return { x: this.view.x + (clientX - r.left) / k, y: this.view.y + (clientY - r.top) / k };
  }

  zoomAt(factor, clientX, clientY) {
    const r = this.container.getBoundingClientRect();
    const cx = clientX ?? r.left + r.width / 2;
    const cy = clientY ?? r.top + r.height / 2;
    const before = this.toMap(cx, cy);
    this.view.w = Math.max(this.minViewW, Math.min(this.maxViewW, this.view.w / factor));
    const k = this.container.clientWidth / this.view.w;
    this.view.x = before.x - (cx - r.left) / k;
    this.view.y = before.y - (cy - r.top) / k;
    this.applyView();
  }

  bindPointer() {
    const svg = this.svg;
    const pointers = new Map();
    let drag = null;
    let pinch = null;

    svg.addEventListener('pointerdown', (e) => {
      svg.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) drag = { startX: e.clientX, startY: e.clientY, viewX: this.view.x, viewY: this.view.y, moved: false };
      else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), w: this.view.w };
        drag = null;
      }
    });
    svg.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        this.view.w = pinch.w * (pinch.dist / dist);
        this.applyView();
        return;
      }
      if (drag) {
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) drag.moved = true;
        if (drag.moved) {
          const k = this.scale;
          this.view.x = drag.viewX - dx / k;
          this.view.y = drag.viewY - dy / k;
          this.applyView();
        }
        return;
      }
      const p = this.toMap(e.clientX, e.clientY);
      this.setHover(this.map.territoryAt(p.x, p.y));
    });
    const end = (e) => {
      const wasDrag = drag?.moved;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0) {
        if (drag && !wasDrag) {
          const p = this.toMap(e.clientX, e.clientY);
          const id = this.map.territoryAt(p.x, p.y);
          if (id) this.onClick(id);
        }
        drag = null;
      }
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('pointerleave', () => this.setHover(null));
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomAt(Math.pow(1.0015, -e.deltaY), e.clientX, e.clientY);
    }, { passive: false });
    svg.addEventListener('dblclick', (e) => this.zoomAt(1.8, e.clientX, e.clientY));
  }

  setHover(id) {
    if (id === this.hover) return;
    if (this.hover) for (const key of ['g', 'badge']) this.each(this.hover, key, (e) => e.classList.remove('hover'));
    this.hover = id;
    if (id) for (const key of ['g', 'badge']) this.each(id, key, (e) => e.classList.add('hover'));
    this.svg.style.cursor = id ? 'pointer' : 'grab';
  }

  /** Centre la vue sur un territoire. */
  centerOn(id) {
    const t = this.map.TERRITORIES[id];
    const ch = this.container.clientHeight || 1;
    const cw = this.container.clientWidth || 1;
    this.view.x = t.pos.x - this.view.w / 2;
    this.view.y = t.pos.y - (this.view.w * (ch / cw)) / 2;
    this.applyView();
  }

  // ─────────────────────────── Mise à jour ───────────────────────────

  /**
   * @param {object} state  état (vue joueur)
   * @param {object} hl     { selected, targets:Set, reachable:Set, placeable:Set, dimOthers:boolean }
   */
  update(state, hl = {}) {
    const byId = Object.fromEntries(state.players.map((p) => [p.id, p]));
    const anyHighlight = hl.selected || hl.targets?.size || hl.reachable?.size;
    for (const id of this.map.TERRITORY_IDS) {
      const terr = state.territories[id];
      const owner = terr ? byId[terr.owner] : null;
      const fill = owner ? playerHex(owner) : '#8a8a8a';
      const troops = terr ? String(terr.troops) : '';
      const title = `${this.map.TERRITORIES[id].name} — ${owner ? owner.name : 'libre'} — ${terr?.troops ?? 0} troupe(s)`;
      const cls = ['territory'];
      if (hl.selected === id) cls.push('selected');
      else if (hl.targets?.has(id)) cls.push('target');
      else if (hl.reachable?.has(id)) cls.push('reachable');
      else if (hl.placeable?.has(id)) cls.push('placeable');
      else if (anyHighlight && hl.dimOthers) cls.push('dim');
      if (this.hover === id) cls.push('hover');
      const className = cls.join(' ');
      for (const nodes of this.copies) {
        const n = nodes[id];
        n.body.setAttribute('fill', fill);
        n.troops.textContent = troops;
        n.title.textContent = title;
        n.g.setAttribute('class', className);
        n.badge.setAttribute('class', 'badge ' + className);
      }
    }
  }

  /** Petit flash visuel sur un territoire (combat, conquête). */
  flash(id) {
    if (!this.map.TERRITORIES[id]) return;
    this.each(id, 'badge', (b) => {
      b.classList.remove('flash');
      void b.getBoundingClientRect();
      b.classList.add('flash');
    });
  }
}
