/**
 * Panneaux de partie : en-tête (barre du haut) et bandeau du bas — phase & actions,
 * joueurs, cartes, journal — disposés côte à côte.
 * Rendu par template string (simple, sans framework) + délégation d'événements.
 */
import { mapOf } from '../core/map.js';
import { PHASE_LABELS, playerHex, computeReinforcements, continentsOwned, ownedTerritories, getPlayer } from '../core/state.js';
import { findValidSets, SYMBOL_LABELS } from '../core/cards.js';
import { possibleMoves } from '../core/rules.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** Icônes vectorielles des rôles de carte (viewBox 0 0 40 40), dessinées au premier plan. */
const SYMBOL_ICON = {
  // Fantassin : casque, buste, fusil en bandoulière
  infantry: `<circle cx="20" cy="10" r="5.5"/><path d="M10 38V25c0-6 4-9 10-9s10 3 10 9v13z"/><path d="M7 35 31 11" stroke-width="2.6" stroke-linecap="round" class="stroke"/>`,
  // Cavalier : tête de cheval (profil)
  cavalry: `<path d="M9 37h23v-4c0-6-2-10-6-13l-1-9-5 3-3-6-3 5c-5 2-7 8-4 13l-1 11z"/><circle cx="23" cy="17" r="1.6" class="eye"/>`,
  // Artillerie : canon sur roue
  artillery: `<path d="M9 23 28 6l5 5-19 17z"/><circle cx="13" cy="30" r="7"/><circle cx="13" cy="30" r="2.4" class="eye"/><path d="M13 23v14M6 30h14" stroke-width="1.6" class="stroke"/>`,
  // Joker : étoile
  joker: `<path d="M20 3l5 11 12 1.3-9 8 2.6 12L20 29.4 9.4 35.3 12 23.3l-9-8L15 14z"/>`,
};
/** Carte de la partie en cours de rendu (mise à jour à chaque render). */
let map = null;
const tname = (id) => map?.TERRITORIES[id]?.name ?? id;

export class PanelsView {
  /**
   * @param {HTMLElement} headerEl   barre du haut (code de partie, lien, quitter)
   * @param {HTMLElement} panelsEl   bandeau du bas (panneaux côte à côte)
   * @param {object} h  handlers : endPhase, attack(from,to,dice), blitz, exchange(ids), setPlaceCount(v),
   *                     setDice(v), clearSelection, copyLink, leave, toggleCard(id), mention(name), autoPlace
   */
  constructor(headerEl, panelsEl, h) {
    this.headerEl = headerEl;
    this.panelsEl = panelsEl;
    this.h = h;
    for (const container of [headerEl, panelsEl]) container.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const { act, arg } = b.dataset;
      switch (act) {
        case 'end-phase': return h.endPhase();
        case 'attack': return h.attack();
        case 'blitz': return h.blitz();
        case 'exchange': return h.exchange();
        case 'place-count': return h.setPlaceCount(arg === 'all' ? 'all' : Number(arg));
        case 'dice': return h.setDice(Number(arg));
        case 'clear': return h.clearSelection();
        case 'copy': return h.copyLink();
        case 'leave': return h.leave();
        case 'card': return h.toggleCard(arg);
        case 'mention': return h.mention(arg);
        case 'auto-place': return h.autoPlace();
        case 'occupy': return h.openOccupy();
      }
    });
  }

  render(state, ui) {
    const me = getPlayer(state, ui.client.playerId);
    const active = state.turn ? getPlayer(state, state.turn.playerId) : null;
    const myTurn = !!(active && me && active.id === me.id);
    map = mapOf(state);
    this.headerEl.innerHTML = this.header(state, ui);
    this.panelsEl.innerHTML = [
      state.status === 'finished' ? this.gameOver(state) : '',
      this.phasePanel(state, ui, me, active, myTurn),
      this.playersPanel(state, me, active),
      me ? this.cardsPanel(state, ui, me, myTurn) : '',
      this.logPanel(state),
    ].join('');
  }

  header(state, ui) {
    const spec = ui.client.isSpectator ? '<span class="tag spectator" title="Vous regardez la partie sans y jouer">👁 Spectateur</span>' : '';
    return `<strong>Partie ${esc(state.id)}</strong> <span class="muted small">· tour ${state.turnNumber}</span>${spec}
      <button class="btn small" data-act="copy" title="${esc(ui.client.inviteUrl ?? '')}">Lien d’invitation</button>
      <button class="btn small" data-act="leave">Quitter</button>`;
  }

  gameOver(state) {
    const w = getPlayer(state, state.winner);
    return `<div class="panel gameover"><div class="big" style="color:${playerHex(w)}">🏆 ${esc(w?.name ?? '?')}</div>a conquis le monde en ${state.turnNumber} tours.</div>`;
  }

  phasePanel(state, ui, me, active, myTurn) {
    if (!state.turn) return '';
    const turn = state.turn;
    const phase = turn.phase;
    const steps = ['reinforce', 'attack', 'fortify']
      .map((p) => `<span class="${phase === p ? 'on' : ''}">${PHASE_LABELS[p]}</span>`)
      .join('');
    const who = myTurn
      ? '<span style="color:var(--accent)">À vous de jouer</span>'
      : `Tour de <b style="color:${playerHex(active)}">${esc(active.name)}</b>${active.controlledByBot ? ' <span class="tag bot">bot</span>' : ''}`;
    let body = '';

    if (phase === 'setup') {
      body = `<div class="hint">Placement initial : chaque joueur pose jusqu’à 3 troupes par tour sur ses territoires.</div>
        <div class="row">Troupes à placer : <span class="big">${turn.reinforcements}</span>
        ${myTurn ? '<button class="btn small" data-act="auto-place">Placer automatiquement</button>' : ''}</div>
        ${myTurn ? '<div class="hint">Cliquez sur l’un de vos territoires (surlignés).</div>' : ''}`;
    } else if (phase === 'reinforce' || (phase === 'attack' && turn.reinforcements > 0)) {
      const d = turn.reinforcementDetail;
      const detail = d ? `<div class="hint">${d.base} (territoires) + ${d.bonus} (continents)${state.cards.exchanges ? '' : ''}</div>` : '';
      body = `<div class="row">Renforts à placer : <span class="big">${turn.reinforcements}</span></div>${detail}
        ${turn.mustExchange ? '<div class="error small">Vous avez 5 cartes ou plus : échangez une combinaison avant de placer.</div>' : ''}
        ${myTurn && turn.reinforcements > 0 ? `<div class="row">Par clic :
          <span class="seg">${[1, 3, 5, 'all'].map((v) => `<button data-act="place-count" data-arg="${v}" class="${ui.placeCount === v ? 'on' : ''}">${v === 'all' ? 'tout' : v}</button>`).join('')}</span>
          <button class="btn small" data-act="auto-place" title="Répartit sur vos frontières les plus exposées">Auto</button></div>` : ''}
        ${myTurn && turn.reinforcements === 0 && phase === 'reinforce' ? '<button class="btn primary block" data-act="end-phase">Passer à l’attaque →</button>' : ''}`;
    } else if (phase === 'attack') {
      body = this.attackBody(state, ui, myTurn);
    } else if (phase === 'fortify') {
      body = `<div class="hint">Déplacez des troupes d’un territoire vers un autre relié par vos territoires (un seul déplacement), ou passez.</div>
        ${myTurn ? `${ui.sel.from ? `<div class="row">Depuis <b>${esc(tname(ui.sel.from))}</b> → cliquez une destination verte. <button class="btn small" data-act="clear">Annuler</button></div>` : '<div class="hint">Cliquez sur le territoire de départ (≥ 2 troupes).</div>'}
        <button class="btn primary block" data-act="end-phase">Terminer mon tour</button>` : ''}`;
    }

    return `<div class="panel phase ${myTurn ? 'active-turn' : ''}">
      <div class="phase-title">${who}</div>
      <div class="phase-steps">${steps}</div>
      ${body}</div>`;
  }

  attackBody(state, ui, myTurn) {
    const turn = state.turn;
    let html = '';
    if (turn.mustExchange) html += '<div class="error small">6 cartes ou plus : échangez une combinaison pour continuer.</div>';
    if (turn.pendingOccupy && myTurn) {
      const o = turn.pendingOccupy;
      html += `<div class="row">Conquête de <b>${esc(tname(o.to))}</b> ! <button class="btn primary" data-act="occupy">Déplacer des troupes (${o.min}–${o.max})</button></div>`;
    }
    if (ui.lastCombat) html += this.diceRow(state, ui.lastCombat);
    if (myTurn && !turn.pendingOccupy && !turn.mustExchange) {
      const from = ui.sel.from;
      const to = ui.sel.to;
      if (!from) html += '<div class="hint">Cliquez sur l’un de vos territoires (≥ 2 troupes), puis sur une cible rouge.</div>';
      else if (!to) html += `<div class="row">Attaquer depuis <b>${esc(tname(from))}</b> (${state.territories[from].troops}) → choisissez une cible rouge. <button class="btn small" data-act="clear">Annuler</button></div>`;
      else {
        const maxDice = Math.min(3, state.territories[from].troops - 1);
        const dice = Math.min(ui.dice, maxDice);
        html += `<div class="row"><b>${esc(tname(from))}</b> (${state.territories[from].troops}) ⚔ <b>${esc(tname(to))}</b> (${state.territories[to].troops})</div>
          <div class="row">Dés : <span class="seg">${[1, 2, 3].map((d) => `<button data-act="dice" data-arg="${d}" class="${dice === d ? 'on' : ''}" ${d > maxDice ? 'disabled' : ''}>${d}</button>`).join('')}</span>
          <button class="btn primary" data-act="attack" ${maxDice < 1 ? 'disabled' : ''}>Attaquer</button>
          <button class="btn ${ui.blitz ? 'danger' : ''}" data-act="blitz" title="Enchaîne les assauts jusqu’à la conquête ou l’épuisement">${ui.blitz ? 'Stop' : 'Attaque totale'}</button>
          <button class="btn small" data-act="clear">✕</button></div>`;
      }
      html += '<button class="btn block" data-act="end-phase" style="margin-top:8px">Terminer les attaques →</button>';
    }
    return html;
  }

  diceRow(state, c) {
    const a = getPlayer(state, c.attackerId);
    const d = getPlayer(state, c.defenderId);
    return `<div class="dice" title="${esc(tname(c.from))} → ${esc(tname(c.to))}">
      ${c.attackerDice.map((v) => `<span class="die att">${v}</span>`).join('')}<span class="vs">vs</span>
      ${c.defenderDice.map((v) => `<span class="die def">${v}</span>`).join('')}
      <span class="small muted">— <b style="color:${playerHex(a)}">${esc(a?.name)}</b> −${c.attackerLosses}, <b style="color:${playerHex(d)}">${esc(d?.name)}</b> −${c.defenderLosses}${c.conquered ? ' · conquis !' : ''}</span></div>`;
  }

  playersPanel(state, me, active) {
    const items = state.players
      .map((p) => {
        const owned = ownedTerritories(state, p.id);
        const troops = owned.reduce((s, t) => s + state.territories[t].troops, 0);
        const conts = continentsOwned(state, p.id).map((c) => map.CONTINENTS[c].short).join(', ');
        const tags = [];
        if (p.type === 'bot') tags.push('<span class="tag bot" title="Bot">🤖</span>');
        else if (!p.connected) tags.push(`<span class="tag off" title="Déconnecté${p.controlledByBot ? ' — remplacé par un bot' : ''}">⚠</span>`);
        if (!p.alive) tags.push('<span class="tag dead" title="Éliminé">☠</span>');
        const cls = [p.id === active?.id ? 'active' : '', p.alive ? '' : 'dead', p.id === me?.id ? 'me' : ''].join(' ');
        const tip = `${owned.length} territoires · ${troops} troupes · ${p.cardCount} cartes${conts ? ` · ${conts}` : ''}`;
        return `<li class="${cls}" title="${esc(tip)}"><span class="dot" style="background:${playerHex(p)}"></span>
          <span class="pname" data-act="mention" data-arg="${esc(p.name)}">${esc(p.name)} ${tags.join('')}</span>
          <span class="stats">${owned.length} · ${troops} · 🃏${p.cardCount}</span></li>`;
      })
      .join('');
    // Spectateurs : joignables dans le chat (@pseudo, #pseudo) mais hors de la partie
    const specs = (state.spectators ?? [])
      .map((s) => `<li class="spectator"><span class="dot spectator-dot">👁</span>
        <span class="pname" data-act="mention" data-arg="${esc(s.name)}">${esc(s.name)}</span>
        <span class="stats muted">spectateur</span></li>`)
      .join('');
    return `<div class="panel"><h3>Joueurs <span class="muted" style="text-transform:none;letter-spacing:0">(territoires · troupes · cartes)</span></h3>
      <ul class="players">${items}${specs}</ul></div>`;
  }

  cardsPanel(state, ui, me, myTurn) {
    const sets = findValidSets(me.cards);
    const selected = [...ui.selectedCards];
    const selCards = selected.map((id) => me.cards.find((c) => c.id === id)).filter(Boolean);
    const canExchange = myTurn && selCards.length === 3 && sets.some((s) => s.every((c) => selected.includes(c.id)));
    const phaseOk = state.turn && (state.turn.phase === 'reinforce' || (state.turn.phase === 'attack' && me.cards.length >= 6));
    const cards = me.cards
      .map((c) => {
        const owned = c.territory && state.territories[c.territory].owner === me.id;
        // Fond : silhouette du territoire dans la couleur de son continent ; premier plan : icône du rôle
        const bg = c.territory
          ? (() => {
              const s = map.territorySilhouette(c.territory);
              return `<svg class="card-bg" viewBox="${s.viewBox}" preserveAspectRatio="xMidYMid meet"><path d="${s.d}" fill="${map.CONTINENTS[map.TERRITORIES[c.territory].continent].color}"/></svg>`;
            })()
          : '';
        return `<div class="card sym-${c.symbol} ${ui.selectedCards.has(c.id) ? 'sel' : ''}" data-act="card" data-arg="${c.id}"
            title="${esc(c.territory ? tname(c.territory) : 'Joker')} — ${SYMBOL_LABELS[c.symbol]}${owned ? ' (territoire possédé : +2 troupes)' : ''}">
          ${bg}
          <span class="card-sym">${SYMBOL_LABELS[c.symbol]}</span>
          <svg class="card-icon" viewBox="0 0 40 40">${SYMBOL_ICON[c.symbol]}</svg>
          <span class="card-name">${c.territory ? esc(tname(c.territory)) : 'Joker'}${owned ? ' <b>+2</b>' : ''}</span></div>`;
      })
      .join('');
    const next = state.cards.exchanges;
    return `<div class="panel"><h3>Mes cartes (${me.cards.length})</h3>
      ${me.cards.length ? `<div class="cards">${cards}</div>` : '<div class="hint">Conquérez au moins un territoire dans un tour pour piocher une carte.</div>'}
      ${me.cards.length >= 3 ? `<div class="row"><button class="btn small primary" data-act="exchange" ${canExchange && phaseOk ? '' : 'disabled'}>Échanger (+${[4, 6, 8, 10, 12, 15][next] ?? 15 + 5 * (next - 5)} troupes)</button>
        <span class="hint">${sets.length ? `${sets.length} combinaison(s) possible(s)` : 'Aucune combinaison valide'}</span></div>` : ''}
    </div>`;
  }

  logPanel(state) {
    const name = (id) => {
      const p = getPlayer(state, id);
      return p ? `<b style="color:${playerHex(p)}">${esc(p.name)}</b>` : '?';
    };
    const lines = state.log.slice(-25).map((e) => {
      switch (e.type) {
        case 'GAME_STARTED': return 'La partie commence.';
        case 'TURN_STARTED': return e.phase === 'setup' ? `${name(e.playerId)} place ses troupes.` : `Tour de ${name(e.playerId)} — ${e.reinforcements} renforts.`;
        case 'TROOPS_PLACED': return `${name(e.playerId)} place ${e.count} sur ${esc(tname(e.territory))}.`;
        case 'CARDS_EXCHANGED': return `${name(e.playerId)} échange 3 cartes : +${e.bonus}${e.territoryBonus ? ` (+2 sur ${esc(tname(e.territoryBonus))})` : ''}.`;
        case 'PHASE_CHANGED': return `${name(e.playerId)} → ${PHASE_LABELS[e.phase]}.`;
        case 'COMBAT': return `${name(e.attackerId)} attaque ${esc(tname(e.to))} depuis ${esc(tname(e.from))} : [${e.attackerDice}] vs [${e.defenderDice}] → −${e.attackerLosses} / −${e.defenderLosses}`;
        case 'TERRITORY_CONQUERED': return `⚑ ${name(e.playerId)} conquiert ${esc(tname(e.territory))} !`;
        case 'OCCUPIED': return `${name(e.playerId)} déplace ${e.count} troupes vers ${esc(tname(e.to))}.`;
        case 'PLAYER_ELIMINATED': return `☠ ${name(e.playerId)} est éliminé par ${name(e.by)}.`;
        case 'CARD_DRAWN': return `${name(e.playerId)} pioche une carte.`;
        case 'FORTIFIED': return `${name(e.playerId)} déplace ${e.count} troupes de ${esc(tname(e.from))} vers ${esc(tname(e.to))}.`;
        case 'GAME_OVER': return `🏆 ${name(e.winner)} remporte la partie !`;
        case 'PLAYER_JOINED': return `${name(e.playerId)} rejoint la partie.`;
        case 'PLAYER_LEFT': return 'Un joueur quitte la partie.';
        default: return e.type;
      }
    });
    return `<div class="panel log-panel"><h3>Journal</h3><ul class="log">${lines.reverse().map((l) => `<li>${l}</li>`).join('')}</ul></div>`;
  }
}

/** Ensembles de surbrillance pour la carte à partir de l'état et de la sélection. */
export function computeHighlights(state, ui) {
  const hl = { selected: ui.sel.from ?? null, targets: new Set(), reachable: new Set(), placeable: new Set(), dimOthers: false };
  const me = ui.client.playerId;
  if (!state.turn || state.turn.playerId !== me) return hl;
  const moves = possibleMoves(state, me);
  if (moves.canPlace.length) for (const t of moves.canPlace) hl.placeable.add(t);
  if (state.turn.phase === 'attack' && ui.sel.from) {
    for (const m of moves.attacks) if (m.from === ui.sel.from) hl.targets.add(m.to);
    hl.dimOthers = true;
  }
  if (state.turn.phase === 'fortify' && ui.sel.from) {
    for (const m of moves.fortifies) if (m.from === ui.sel.from) hl.reachable.add(m.to);
    hl.dimOthers = true;
  }
  return hl;
}

export { computeReinforcements };
