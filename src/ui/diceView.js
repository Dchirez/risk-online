/**
 * Animation des dés sur le plateau : à chaque combat, les dés de l'attaquant
 * (rouges) et du défenseur (blancs) roulent près du territoire attaqué, se
 * figent sur les valeurs réelles envoyées par l'hôte, puis les paires sont
 * comparées (dé gagnant surligné, dé perdant assombri) avant de disparaître.
 *
 * Purement décoratif : les valeurs viennent de l'événement COMBAT, jamais du client.
 */
import { TERRITORIES } from '../core/map.js';
import { getPlayer, playerHex } from '../core/state.js';

const ROLL_MS = 650; // durée du roulement
const QUICK_ROLL_MS = 260; // quand les combats s'enchaînent (attaque totale)
const HOLD_MS = 1600; // temps d'affichage du résultat
const TICK_MS = 70; // changement de face pendant le roulement

// Pips à afficher pour chaque valeur (indices 0..8 sur une grille 3×3)
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

export class DiceOverlay {
  /**
   * @param {HTMLElement} container  élément positionné (le conteneur de la carte)
   * @param {import('./mapView.js').MapView} mapView
   */
  constructor(container, mapView) {
    this.container = container;
    this.mapView = mapView;
    this.el = document.createElement('div');
    this.el.className = 'dice-overlay';
    this.el.hidden = true;
    container.appendChild(this.el);
    this.timers = [];
    this.lastShown = 0;
  }

  clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** Affiche et anime un combat. */
  show(combat, state) {
    const now = Date.now();
    const quick = now - this.lastShown < ROLL_MS + 200;
    this.lastShown = now;
    this.clearTimers();

    const attacker = getPlayer(state, combat.attackerId);
    const defender = getPlayer(state, combat.defenderId);
    this.el.innerHTML = `
      <div class="dice-group att">
        <div class="dice-label" style="color:${playerHex(attacker)}">${esc(attacker?.name ?? '?')} ⚔</div>
        <div class="dice-row">${combat.attackerDice.map(() => dieHtml('att')).join('')}</div>
        <div class="dice-loss"></div>
      </div>
      <div class="dice-vs">contre</div>
      <div class="dice-group def">
        <div class="dice-label" style="color:${playerHex(defender)}">🛡 ${esc(defender?.name ?? '?')}</div>
        <div class="dice-row">${combat.defenderDice.map(() => dieHtml('def')).join('')}</div>
        <div class="dice-loss"></div>
      </div>
      <div class="dice-place">${esc(TERRITORIES[combat.to]?.name ?? '')}</div>`;
    this.position(combat.to);
    this.el.hidden = false;
    this.el.className = 'dice-overlay rolling';

    const attDice = [...this.el.querySelectorAll('.att .die')];
    const defDice = [...this.el.querySelectorAll('.def .die')];
    const all = [...attDice, ...defDice];

    // Roulement : faces aléatoires et rotations, puis valeurs réelles
    const rollMs = quick ? QUICK_ROLL_MS : ROLL_MS;
    const start = now;
    const tick = () => {
      if (Date.now() - start >= rollMs) return settle();
      for (const d of all) {
        setFace(d, 1 + Math.floor(Math.random() * 6));
        d.style.transform = `rotate(${Math.round(Math.random() * 360)}deg) translate(${rand(-4, 4)}px, ${rand(-6, 2)}px)`;
      }
      this.timers.push(setTimeout(tick, TICK_MS));
    };
    const settle = () => {
      this.el.className = 'dice-overlay settled';
      attDice.forEach((d, i) => {
        setFace(d, combat.attackerDice[i]);
        d.style.transform = `rotate(${rand(-8, 8)}deg)`;
      });
      defDice.forEach((d, i) => {
        setFace(d, combat.defenderDice[i]);
        d.style.transform = `rotate(${rand(-8, 8)}deg)`;
      });
      // Comparaison des paires (le défenseur gagne les égalités)
      const pairs = Math.min(attDice.length, defDice.length);
      for (let i = 0; i < pairs; i++) {
        const attWins = combat.attackerDice[i] > combat.defenderDice[i];
        attDice[i].classList.add(attWins ? 'win' : 'lose');
        defDice[i].classList.add(attWins ? 'lose' : 'win');
      }
      this.el.querySelector('.att .dice-loss').textContent = combat.attackerLosses ? `−${combat.attackerLosses}` : '';
      this.el.querySelector('.def .dice-loss').textContent = combat.defenderLosses ? `−${combat.defenderLosses}` : '';
      if (combat.conquered) this.el.querySelector('.dice-place').textContent += ' — conquis !';
      this.timers.push(setTimeout(() => this.hide(), HOLD_MS));
    };
    tick();
  }

  /** Place la boîte de dés près du territoire visé (ou au centre s'il est hors écran). */
  position(territoryId) {
    const pos = TERRITORIES[territoryId]?.pos;
    const screen = pos && this.mapView.toScreen(pos.x, pos.y);
    const cw = this.container.clientWidth;
    const ch = this.container.clientHeight;
    let x = cw / 2;
    let y = ch / 2;
    if (screen && screen.x > 0 && screen.x < cw && screen.y > 0 && screen.y < ch) {
      x = screen.x;
      y = screen.y - 40;
    }
    // Garde la boîte dans le cadre
    x = Math.max(150, Math.min(cw - 150, x));
    y = Math.max(70, Math.min(ch - 60, y));
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
  }

  hide() {
    this.el.className = 'dice-overlay fading';
    this.timers.push(setTimeout(() => (this.el.hidden = true), 400));
  }
}

function dieHtml(kind) {
  return `<span class="die ${kind}">${Array.from({ length: 9 }, () => '<i></i>').join('')}</span>`;
}
function setFace(die, value) {
  const on = new Set(PIPS[value] ?? []);
  die.querySelectorAll('i').forEach((pip, i) => pip.classList.toggle('on', on.has(i)));
  die.dataset.value = value;
}
const rand = (a, b) => (a + Math.random() * (b - a)).toFixed(1);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
