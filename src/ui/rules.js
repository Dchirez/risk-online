/**
 * Panneau d'aide contextuel : explique les règles de la phase en cours (placement,
 * renfort, attaque, déplacement) ou ce qu'on peut faire quand ce n'est pas son tour.
 * Fermable ; l'état ouvert/fermé est mémorisé dans le navigateur.
 */
import { mapOf } from '../core/map.js';
import { PHASE_LABELS, computeReinforcements, getPlayer, playerHex } from '../core/state.js';

const STORAGE_KEY = 'risk.rules.closed';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class RulesPanel {
  /**
   * @param {HTMLElement} el         conteneur (aside) du panneau
   * @param {HTMLElement} toggleBtn  bouton d'ouverture dans la barre du haut
   */
  constructor(el, toggleBtn) {
    this.el = el;
    this.toggle = toggleBtn;
    this.open = localStorage.getItem(STORAGE_KEY) !== '1';
    this.lastKey = null;
    toggleBtn.addEventListener('click', () => this.setOpen(!this.open));
    el.addEventListener('click', (e) => {
      if (e.target.closest('.rules-close')) this.setOpen(false);
    });
    this.applyVisibility();
  }

  setOpen(open) {
    this.open = open;
    try {
      localStorage.setItem(STORAGE_KEY, open ? '0' : '1');
    } catch {
      /* stockage indisponible */
    }
    this.applyVisibility();
  }

  applyVisibility() {
    this.el.hidden = !this.open;
    this.toggle.classList.toggle('active', this.open);
  }

  /** Met à jour le contenu selon l'état et le joueur courant. */
  update(state, me) {
    if (!state) return;
    const active = state.turn ? getPlayer(state, state.turn.playerId) : null;
    const myTurn = !!(active && me && active.id === me.id);
    const phase = state.turn?.phase ?? state.status;
    const key = `${state.status}|${phase}|${myTurn}|${me?.alive}|${state.turn?.mustExchange}|${!!state.turn?.pendingOccupy}`;
    if (key === this.lastKey) return; // évite de re-rendre à chaque coup
    this.lastKey = key;

    let title;
    let body;
    if (state.status === 'finished') {
      const w = getPlayer(state, state.winner);
      title = 'Partie terminée';
      body = `<p><b style="color:${playerHex(w)}">${esc(w?.name ?? '?')}</b> a conquis le monde. Pour rejouer, créez une nouvelle partie depuis l’accueil.</p>`;
    } else if (me && !me.alive) {
      title = 'Vous êtes éliminé·e';
      body = `<p>Vous n’avez plus de territoire. Vous pouvez rester pour regarder la fin de la partie et discuter dans le chat.</p>`;
    } else if (!myTurn) {
      title = `Tour de ${esc(active?.name ?? '?')} — ${PHASE_LABELS[phase] ?? ''}`;
      body = waitingText(state, active);
    } else {
      title = `À vous : ${PHASE_LABELS[phase] ?? phase}`;
      body = phaseText(state, me);
    }

    this.el.innerHTML = `
      <div class="rules-head"><strong>📜 ${title}</strong><button class="rules-close" title="Fermer">✕</button></div>
      <div class="rules-body">${body}</div>
      <details class="rules-general"><summary>Rappel des règles générales</summary>${generalText(mapOf(state))}</details>
      <div class="rules-foot">Tapez <code>/aide</code> dans le chat pour les commandes.</div>`;
  }
}

function waitingText(state, active) {
  const who = active?.controlledByBot ? 'Un bot joue ce tour.' : 'Le joueur réfléchit.';
  return `<p>${who} En attendant :</p>
    <ul>
      <li>Surveillez vos frontières : les pastilles colorées indiquent le propriétaire, le chiffre le nombre de troupes.</li>
      <li>Discutez dans le chat : <code>@pseudo</code> interpelle un joueur, <code>#pseudo</code> envoie un message privé (alliances, trahisons…).</li>
      <li>Molette pour zoomer, glisser pour déplacer la carte, qui boucle horizontalement.</li>
    </ul>`;
}

function phaseText(state, me) {
  const turn = state.turn;
  switch (turn.phase) {
    case 'setup':
      return `<p>Les territoires ont été distribués au hasard. Chacun place ses troupes de départ à tour de rôle, <b>3 par tour</b>.</p>
        <ul>
          <li>Cliquez sur un de vos territoires (surlignés) pour y ajouter 1 troupe.</li>
          <li>« Placer automatiquement » répartit vos troupes sur vos frontières.</li>
          <li>Il vous reste <b>${turn.reinforcements}</b> troupe(s) à placer ce tour.</li>
        </ul>
        <p class="muted">Conseil : renforcez les territoires qui touchent l’ennemi et ceux d’un continent que vous pouvez finir.</p>`;
    case 'reinforce': {
      const d = turn.reinforcementDetail ?? computeReinforcements(state, me.id);
      const mustEx = turn.mustExchange ? `<p class="warn">Vous avez 5 cartes ou plus : <b>l’échange est obligatoire</b> avant de placer.</p>` : '';
      return `${mustEx}<p>Vous recevez des renforts au début de votre tour :</p>
        <ul>
          <li><b>${d.base}</b> pour vos territoires (le plus grand de 3 et territoires ÷ 3).</li>
          <li><b>${d.bonus}</b> de bonus de continent(s) entier(s).</li>
          <li>Cartes : 3 symboles identiques ou 3 différents (le joker remplace n’importe lequel) → 4, 6, 8, 10, 12, 15 troupes puis +5 à chaque échange. +2 sur un territoire de la combinaison que vous possédez.</li>
        </ul>
        <p>Cliquez sur vos territoires pour placer (réglez 1 / 3 / 5 / tout par clic). Reste : <b>${turn.reinforcements}</b>. Puis « Passer à l’attaque ».</p>`;
    }
    case 'attack': {
      const occ = turn.pendingOccupy
        ? `<p class="warn">Territoire conquis ! Choisissez combien de troupes y entrent (au moins autant que de dés lancés).</p>`
        : '';
      const mustEx = turn.mustExchange ? `<p class="warn">6 cartes ou plus après une élimination : échangez avant de continuer.</p>` : '';
      return `${occ}${mustEx}<p>Attaquez autant de fois que vous voulez, ou pas du tout.</p>
        <ul>
          <li>Cliquez sur un de vos territoires ayant <b>au moins 2 troupes</b>, puis sur un voisin ennemi (en rouge).</li>
          <li>Vous lancez 1 à 3 dés (jamais plus que troupes − 1) ; le défenseur 1 ou 2 dés (selon ses troupes).</li>
          <li>Les dés sont triés et comparés deux à deux : le plus haut gagne, <b>l’égalité profite au défenseur</b>. Chaque comparaison perdue coûte une troupe.</li>
          <li>« Attaque totale » enchaîne les jets jusqu’à la conquête ou l’épuisement.</li>
          <li>Territoire à 0 → conquis : vous y déplacez au moins autant de troupes que de dés lancés.</li>
          <li>Au moins une conquête dans le tour = <b>1 carte</b> à la fin du tour.</li>
          <li>Éliminer un joueur vous donne ses cartes (6 ou plus → échange immédiat).</li>
        </ul>
        <p>« Terminer les attaques » passe au déplacement.</p>`;
    }
    case 'fortify':
      return `<p>Fin de tour : <b>un seul</b> mouvement de troupes.</p>
        <ul>
          <li>Cliquez sur un territoire de départ (≥ 2 troupes) puis sur la destination (en vert) : elle doit être reliée par une chaîne de vos territoires.</li>
          <li>Laissez toujours au moins 1 troupe derrière vous.</li>
          <li>Ou « Passer » pour terminer sans déplacer.</li>
        </ul>
        <p class="muted">Conseil : ramenez les troupes de l’intérieur vers vos frontières menacées.</p>`;
    default:
      return '';
  }
}

function generalText(map) {
  const conts = Object.values(map.CONTINENTS)
    .map((c) => `<li><span class="dot" style="background:${c.color}"></span>${esc(c.name)} : <b>+${c.bonus}</b></li>`)
    .join('');
  return `<ul>
      <li><b>But</b> : conquérir tous les territoires. Le dernier joueur en vie gagne.</li>
      <li><b>Tour</b> : renfort → attaque → déplacement. Les bots jouent seuls ; un humain déconnecté est remplacé par un bot après 15 s et peut revenir avec son pseudo.</li>
      <li><b>Bonus de continent</b> (continent entier au début de votre tour) :</li>
    </ul>
    <ul class="rules-continents">${conts}</ul>
    <ul>
      <li><b>Carte « ${esc(map.name)} »</b> : ${map.wrap ? 'elle boucle horizontalement (les deux bords se touchent) ; ' : ''}les pointillés sont des liaisons maritimes${map.RIDGES.length ? ', les crêtes ▲▲▲ des montagnes infranchissables' : ''}.</li>
    </ul>`;
}
