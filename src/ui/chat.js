/**
 * Vue du chat : historique, mentions @pseudo (mise en évidence), messages privés
 * #pseudo (fond violet, visibles seulement par les intéressés), messages système.
 * Le filtrage de visibilité est fait par l'hôte : ici on n'affiche que ce qu'on reçoit.
 */
import { playerHex } from '../core/state.js';

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class ChatView {
  /**
   * @param {HTMLElement} container
   * @param {(text:string)=>void} onSend
   */
  constructor(container, onSend) {
    this.container = container;
    this.onSend = onSend;
    container.innerHTML = `
      <div class="chat-head"><strong>Chat</strong><span class="muted">@pseudo = mention · #pseudo = message privé</span></div>
      <div class="chat-list"></div>
      <div class="chat-suggest"></div>
      <form class="chat-form">
        <input type="text" maxlength="500" placeholder="Votre message…" autocomplete="off" />
        <button class="btn small primary" type="submit">Envoyer</button>
      </form>`;
    this.list = container.querySelector('.chat-list');
    this.suggest = container.querySelector('.chat-suggest');
    this.input = container.querySelector('input');
    container.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.input.value.trim();
      if (!text) return;
      this.onSend(text);
      this.input.value = '';
    });
    this.suggest.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      this.insert(b.dataset.insert);
    });
  }

  /** Insère "@pseudo " ou "#pseudo " dans le champ de saisie. */
  insert(token) {
    const v = this.input.value;
    this.input.value = (v && !v.endsWith(' ') ? v + ' ' : v) + token + ' ';
    this.input.focus();
  }

  /**
   * @param {object[]} messages   messages visibles par le joueur courant
   * @param {object[]} players    joueurs (pour les couleurs)
   * @param {string} meId
   */
  render(messages, players, meId) {
    const byId = Object.fromEntries(players.map((p) => [p.id, p]));
    const byName = Object.fromEntries(players.map((p) => [p.name.toLowerCase(), p]));
    const atBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;

    this.list.innerHTML = messages
      .map((m) => {
        const time = new Date(m.ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        if (m.kind === 'system') return `<div class="msg system"><span class="time">${time}</span>${escapeHtml(m.text)}</div>`;
        const from = byId[m.from];
        const color = from ? playerHex(from) : '#aaa';
        const cls = ['msg'];
        if (m.kind === 'private') cls.push('private');
        if (m.mentions.includes(meId) && m.from !== meId) cls.push('mentions-me');
        // Mise en évidence des @pseudo / #pseudo connus
        const html = escapeHtml(m.text).replace(/(^|[^A-Za-z0-9_])([@#])([A-Za-z0-9_\-]{2,16})/g, (all, pre, sym, name) => {
          const p = byName[name.toLowerCase()];
          if (!p) return all;
          return `${pre}<span class="mention" style="color:${playerHex(p)}">${sym}${escapeHtml(p.name)}</span>`;
        });
        const lock = m.kind === 'private' ? `<span class="lock" title="Message privé">🔒 privé</span>` : '';
        const toNames = m.kind === 'private' ? ` <span class="muted small">→ ${m.to.map((id) => escapeHtml(byId[id]?.name ?? '?')).join(', ')}</span>` : '';
        return `<div class="${cls.join(' ')}"><span class="time">${time}</span>${lock}<span class="who" style="color:${color}">${escapeHtml(m.fromName)}</span>${toNames} : ${html}</div>`;
      })
      .join('');
    if (atBottom) this.list.scrollTop = this.list.scrollHeight;

    // Boutons d'insertion rapide (autres joueurs humains ou bots)
    this.suggest.innerHTML = players
      .filter((p) => p.id !== meId)
      .map((p) => `<button class="btn small" type="button" data-insert="@${escapeHtml(p.name)}" style="border-color:${playerHex(p)}">@${escapeHtml(p.name)}</button>`)
      .join('');
  }
}
