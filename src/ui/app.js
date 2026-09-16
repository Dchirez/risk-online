/**
 * Point d'entrée de l'interface : écrans (accueil → lobby → partie), gestion des
 * clients (un par joueur humain de cet onglet : créateur, invités, hot-seat),
 * interactions carte / panneaux / chat.
 *
 * L'UI ne touche JAMAIS à l'état de jeu directement : elle envoie des actions
 * via GameClient et se redessine à chaque état reçu de l'hôte.
 */
import { NET } from '../config.js';
import { LocalHostRuntime } from '../net/hostRuntime.js';
import { LocalAdapter, BroadcastAdapter, WebSocketAdapter } from '../net/adapters.js';
import { GameClient } from '../net/client.js';
import { generateGameCode, isValidName } from '../net/protocol.js';
import { TERRITORIES, areAdjacent } from '../core/map.js';
import { playerHex, connectedOwned, getPlayer } from '../core/state.js';
import { decideBotAction } from '../core/bot.js';
import { MapView } from './mapView.js';
import { PanelsView, computeHighlights } from './panels.js';
import { ChatView } from './chat.js';
import { DiceOverlay } from './diceView.js';
import { RulesPanel } from './rules.js';

// ═══════════════════════════ Commandes du chat (/nom args) ═══════════════════════════

const LOCAL_COMMANDS_HELP = [
  '/aide — cette liste',
  '/joueurs — état de chaque joueur (connecté, bot, éliminé)',
  '/etat — phase, tour, version de l’état, mode réseau',
  '/lien — copie le lien d’invitation',
  '/regles — affiche ou masque le panneau des règles',
  '/sync — redemande l’état complet et le chat à l’hôte (affichage désynchronisé)',
  '/ping — vérifie que l’hôte répond',
  '/bot [pseudo] — un bot joue à votre place (ou à la place d’un joueur : créateur)',
  '/humain [pseudo] — reprendre la main après /bot ou un remplacement (joueur connecté)',
  '/passer — un bot termine le tour en cours du joueur actif (bloqué, absent), puis lui rend la main (créateur, ou votre tour)',
  '/delai <ms> — vitesse des bots, 0 à 5000 ms (créateur)',
  '/kick <pseudo> — retirer un joueur du lobby (créateur)',
];

/** Commandes locales traitées dans l'onglet ; les autres sont envoyées à l'hôte. */
function runCommand(text) {
  const ui = activeUi();
  const client = ui?.client;
  if (!client) return;
  const [rawName, ...args] = text.slice(1).trim().split(/\s+/);
  const name = (rawName ?? '').toLowerCase();
  const state = client.state;
  switch (name) {
    case 'aide':
    case 'help':
      return client.localSystem('Commandes : ' + LOCAL_COMMANDS_HELP.join(' · '));
    case 'joueurs': {
      if (!state) return;
      const lines = state.players.map((p) => {
        const flags = [p.type === 'bot' ? 'bot' : p.connected ? 'connecté' : 'déconnecté', p.controlledByBot && p.type !== 'bot' ? 'joué par un bot' : '', p.alive ? '' : 'éliminé', p.id === state.turn?.playerId ? 'à lui/elle de jouer' : ''].filter(Boolean);
        return `${p.name} (${flags.join(', ')})`;
      });
      return client.localSystem('Joueurs : ' + lines.join(' · '));
    }
    case 'etat':
      if (!state) return;
      return client.localSystem(
        `Partie ${state.id} · statut ${state.status} · tour ${state.turnNumber} · phase ${state.turn?.phase ?? '—'} · version ${state.version} · réseau ${client.adapter.constructor.name} · vous : ${client.me?.name ?? '?'}${client.isOwner ? ' (créateur)' : ''}`,
      );
    case 'lien':
      copyLink();
      return client.localSystem(`Lien d’invitation : ${client.inviteUrl ?? '(indisponible)'}`);
    case 'regles':
    case 'règles':
      app.rules.setOpen(!app.rules.open);
      return;
    default:
      return client.sendCommand(name, args);
  }
}

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const tname = (id) => TERRITORIES[id]?.name ?? id;

const app = {
  runtime: null, // LocalHostRuntime si cet onglet héberge la partie
  clients: [], // GameClient[] — un par joueur humain contrôlé depuis cet onglet
  active: 0, // index du client dont on affiche la vue
  followTurn: true, // hot-seat : basculer automatiquement sur le joueur local actif
  mapView: null,
  sidebar: null,
  chatView: null,
};

// ═══════════════════════════ Écrans ═══════════════════════════

function show(name) {
  for (const s of ['home', 'lobby', 'game']) $(`#screen-${s}`).hidden = s !== name;
}

let toastTimer = null;
function toast(message, kind = 'error') {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

function homeError(msg) {
  const e = $('#home-error');
  e.textContent = msg ?? '';
  e.hidden = !msg;
}

// ═══════════════════════════ Clients ═══════════════════════════

function newUi(client) {
  return {
    client,
    sel: { from: null, to: null },
    placeCount: 1,
    dice: 3,
    blitz: false,
    autoPlace: false,
    lastCombat: null,
    selectedCards: new Set(),
    phaseKey: null,
  };
}

const activeUi = () => app.clients[app.active]?.ui;

/** Abonne un client aux événements réseau et l'ajoute à la liste locale. */
function registerClient(client) {
  client.ui = newUi(client);
  app.clients.push(client);
  client.on('state', () => onState(client));
  client.on('events', (events) => onEvents(client, events));
  client.on('chat', () => {
    if (client === app.clients[app.active] && client.state) renderChat();
  });
  client.on('error', (e) => {
    if (client === app.clients[app.active]) toast(e.message);
  });
  client.on('close', (reason) => {
    if (reason === 'host_closed') toast('L’onglet hôte a été fermé : la partie est terminée.');
  });
  return client;
}

/**
 * Jeton de reconnexion : en localStorage pour survivre à la fermeture de l'onglet
 * (un nouvel onglet sur le même lien reprend la place automatiquement).
 * Il est associé au pseudo : deux onglets du même navigateur avec des pseudos
 * différents (tests, hot-seat) ne se volent pas leur place.
 */
const tokenKey = (gameId, name) => `risk.token.${gameId}.${String(name).toLowerCase()}`;
function saveToken(gameId, name, token) {
  if (!gameId || !name || !token) return;
  try {
    localStorage.setItem(tokenKey(gameId, name), token);
  } catch {
    /* stockage indisponible */
  }
}
function loadToken(gameId, name) {
  try {
    return localStorage.getItem(tokenKey(gameId, name)) ?? undefined;
  } catch {
    return undefined;
  }
}

async function createLocalClient(playerName) {
  const client = registerClient(new GameClient(new LocalAdapter(app.runtime)));
  await client.join({ playerName });
  saveToken(client.gameId, playerName, client.token);
  return client;
}

// ═══════════════════════════ Accueil ═══════════════════════════

function initHome() {
  const params = new URLSearchParams(location.search);
  const code = (params.get('game') ?? '').toUpperCase();
  const savedName = localStorage.getItem('risk.name') ?? '';
  $('#home-name').value = savedName;
  $('#home-code').value = code;
  $('#home-create').addEventListener('click', onCreate);
  $('#home-join').addEventListener('click', onJoin);
  $('#home-code').addEventListener('keydown', (e) => e.key === 'Enter' && onJoin());
  $('#home-name').addEventListener('keydown', (e) => e.key === 'Enter' && (code ? onJoin() : onCreate()));

  // Reconnexion automatique après un rafraîchissement ou une réouverture (jeton mémorisé)
  if (code && savedName && loadToken(code, savedName)) onJoin();
  else if (code) $('#home-name').focus();
}

function readName() {
  const name = $('#home-name').value.trim();
  if (!isValidName(name)) {
    homeError('Pseudo invalide : 2 à 16 caractères, lettres, chiffres, _ ou -.');
    return null;
  }
  localStorage.setItem('risk.name', name);
  homeError(null);
  return name;
}

async function onCreate() {
  const name = readName();
  if (!name) return;
  const maxPlayers = Number($('#home-max').value);
  try {
    if (NET.wsUrl) {
      const client = registerClient(new GameClient(new WebSocketAdapter(NET.wsUrl)));
      await client.create({ playerName: name, settings: { maxPlayers, botDelayMs: NET.botDelayMs } });
      saveToken(client.gameId, name, client.token);
    } else {
      const gameId = generateGameCode();
      const inviteUrl = `${location.origin}${location.pathname}?game=${gameId}`;
      app.runtime = new LocalHostRuntime({ gameId, settings: { maxPlayers, botDelayMs: NET.botDelayMs }, inviteUrl });
      await createLocalClient(name);
      history.replaceState(null, '', `?game=${gameId}`);
    }
  } catch (e) {
    homeError(e.message);
  }
}

async function onJoin() {
  const name = readName();
  if (!name) return;
  const code = $('#home-code').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return homeError('Code de partie invalide (6 caractères).');
  const token = loadToken(code, name);
  const adapter = NET.wsUrl ? new WebSocketAdapter(NET.wsUrl) : new BroadcastAdapter(code);
  const client = registerClient(new GameClient(adapter));
  $('#home-join').disabled = true;
  try {
    await client.join({ gameId: code, playerName: name, token });
    saveToken(code, name, client.token);
    history.replaceState(null, '', `?game=${code}`);
  } catch (e) {
    app.clients = app.clients.filter((c) => c !== client);
    client.leave();
    homeError(e.message);
  } finally {
    $('#home-join').disabled = false;
  }
}

// ═══════════════════════════ Lobby ═══════════════════════════

function initLobby() {
  const owner = () => app.clients.find((c) => c.isOwner) ?? app.clients[0];
  $('#lobby-copy').addEventListener('click', copyLink);
  $('#lobby-add-bot').addEventListener('click', () => owner().lobby('addBot'));
  $('#lobby-start').addEventListener('click', () => owner().lobby('start'));
  $('#lobby-max').addEventListener('change', (e) => owner().lobby('settings', { maxPlayers: Number(e.target.value) }));
  $('#lobby-speed').addEventListener('change', (e) => owner().lobby('settings', { botDelayMs: Number(e.target.value) }));
  $('#lobby-leave').addEventListener('click', leaveGame);
  $('#lobby-add-local').addEventListener('click', async () => {
    const name = window.prompt('Pseudo du joueur local (hot-seat) :');
    if (!name) return;
    if (!isValidName(name.trim())) return lobbyError('Pseudo invalide.');
    try {
      await createLocalClient(name.trim());
    } catch (e) {
      lobbyError(e.message);
    }
  });
  $('#lobby-players').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kick]');
    if (b) owner().lobby('kick', { playerId: b.dataset.kick });
  });
}

function lobbyError(msg) {
  const e = $('#lobby-error');
  e.textContent = msg ?? '';
  e.hidden = !msg;
  if (msg) setTimeout(() => (e.hidden = true), 3000);
}

function renderLobby(state) {
  const client = app.clients[0];
  const isOwner = app.clients.some((c) => c.isOwner);
  $('#lobby-code').textContent = state.id;
  $('#lobby-link').value = client.inviteUrl ?? '';
  $('#lobby-max').value = String(state.settings.maxPlayers);
  $('#lobby-speed').value = String(state.settings.botDelayMs);
  const localIds = new Set(app.clients.map((c) => c.playerId));
  const ownerId = app.clients.find((c) => c.isOwner)?.playerId;
  const seats = [];
  for (let i = 0; i < state.settings.maxPlayers; i++) {
    const p = state.players[i];
    if (!p) {
      seats.push('<li class="empty">Place libre — sera prise par un bot</li>');
      continue;
    }
    const tags = [];
    if (p.type === 'bot') tags.push('<span class="tag bot">bot</span>');
    if (localIds.has(p.id)) tags.push('<span class="tag">cet onglet</span>');
    if (p.id === ownerId || (state.players[0]?.id === p.id && p.type === 'human')) tags.push('<span class="tag owner">créateur</span>');
    const kick = isOwner && !localIds.has(p.id) ? `<button class="btn small" data-kick="${p.id}" title="Retirer">✕</button>` : '';
    seats.push(`<li><span class="dot" style="background:${playerHex(p)}"></span><span>${esc(p.name)}</span> ${tags.join(' ')}<span class="spacer"></span>${kick}</li>`);
  }
  $('#lobby-players').innerHTML = seats.join('');
  for (const id of ['lobby-add-bot', 'lobby-start', 'lobby-max', 'lobby-speed']) $(`#${id}`).disabled = !isOwner;
  $('#lobby-add-local').hidden = !app.runtime;
  $('#lobby-start').disabled = !isOwner || state.players.length < 1;
}

async function copyLink() {
  const url = app.clients[0]?.inviteUrl ?? location.href;
  try {
    await navigator.clipboard.writeText(url);
    if (!$('#screen-game').hidden) toast('Lien copié !', 'info');
    else $('#lobby-copy').textContent = 'Copié ✓';
  } catch {
    window.prompt('Copiez le lien :', url);
  }
}

function leaveGame() {
  for (const c of app.clients) c.leave();
  app.runtime?.close();
  location.href = location.pathname; // retour propre à l'accueil
}

// ═══════════════════════════ Partie ═══════════════════════════

function initGame() {
  app.mapView = new MapView($('#map'), onTerritoryClick);
  app.dice = new DiceOverlay($('#map'), app.mapView);
  app.chatView = new ChatView($('#chat'), (text) => (text.startsWith('/') ? runCommand(text) : activeUi()?.client.sendChat(text)));
  app.rules = new RulesPanel($('#rules'), $('#rules-toggle'));
  app.sidebar = new PanelsView($('#game-header'), $('#panels'), {
    endPhase: () => send({ type: 'END_PHASE' }),
    attack: () => {
      const ui = activeUi();
      if (ui.sel.from && ui.sel.to) send({ type: 'ATTACK', from: ui.sel.from, to: ui.sel.to, dice: currentDice(ui) });
    },
    blitz: () => {
      const ui = activeUi();
      ui.blitz = !ui.blitz;
      if (ui.blitz) blitzStep(ui);
      else renderGame();
    },
    exchange: () => {
      const ui = activeUi();
      if (ui.selectedCards.size === 3) {
        send({ type: 'EXCHANGE_CARDS', cardIds: [...ui.selectedCards] });
        ui.selectedCards.clear();
      }
    },
    setPlaceCount: (v) => {
      activeUi().placeCount = v;
      renderGame();
    },
    setDice: (v) => {
      activeUi().dice = v;
      renderGame();
    },
    clearSelection: () => {
      const ui = activeUi();
      ui.sel = { from: null, to: null };
      ui.blitz = false;
      renderGame();
    },
    copyLink,
    leave: () => window.confirm('Quitter la partie ? (un bot prendra votre place)') && leaveGame(),
    toggleCard: (id) => {
      const ui = activeUi();
      if (ui.selectedCards.has(id)) ui.selectedCards.delete(id);
      else if (ui.selectedCards.size < 3) ui.selectedCards.add(id);
      renderGame();
    },
    mention: (name) => app.chatView.insert(`@${name}`),
    autoPlace: () => {
      const ui = activeUi();
      ui.autoPlace = true;
      autoPlaceStep(ui);
    },
    openOccupy: () => openOccupyModal(activeUi()),
  });
  $('#local-switcher').addEventListener('click', (e) => {
    const b = e.target.closest('[data-switch]');
    if (b) {
      app.active = Number(b.dataset.switch);
      renderGame();
    }
  });
  $('#local-switcher').addEventListener('change', (e) => {
    if (e.target.id === 'follow-turn') app.followTurn = e.target.checked;
  });
}

function currentDice(ui) {
  const from = ui.client.state.territories[ui.sel.from];
  return Math.min(ui.dice, 3, from.troops - 1);
}

/** Envoie une action au nom du client actif ; les erreurs de règles s'affichent en toast. */
function send(action) {
  const ui = activeUi();
  return ui.client.sendAction(action).catch((e) => toast(e.message));
}

function onState(client) {
  const state = client.state;
  if (state.status === 'lobby') {
    show('lobby');
    if (client === app.clients[0] || app.clients.length === 1) renderLobby(state);
    return;
  }
  show('game');
  // Hot-seat : suivre le joueur local dont c'est le tour
  if (app.followTurn && app.clients.length > 1 && state.turn) {
    const idx = app.clients.findIndex((c) => c.playerId === state.turn.playerId);
    if (idx >= 0 && idx !== app.active) {
      app.active = idx;
      toast(`Au tour de ${getPlayer(state, state.turn.playerId)?.name}`, 'info');
    }
  }
  const ui = client.ui;
  // Nouvelle phase ou nouveau tour : on réinitialise la sélection de ce client
  const key = state.turn ? `${state.turn.playerId}:${state.turn.phase}:${state.turnNumber}` : 'end';
  if (key !== ui.phaseKey) {
    ui.phaseKey = key;
    ui.sel = { from: null, to: null };
    ui.blitz = false;
    ui.autoPlace = false;
    if (!state.turn || state.turn.phase !== 'attack') ui.lastCombat = null;
  }
  if (client === app.clients[app.active]) {
    renderGame();
    if (ui.blitz) setTimeout(() => blitzStep(ui), 160);
    if (ui.autoPlace) setTimeout(() => autoPlaceStep(ui), 120);
  }
}

function onEvents(client, events) {
  const ui = client.ui;
  for (const e of events) {
    if (e.type === 'COMBAT') {
      ui.lastCombat = e;
      if (client === app.clients[app.active]) {
        app.mapView.flash(e.to);
        app.dice.show(e, client.state);
      }
    }
    if (e.type === 'TERRITORY_CONQUERED' && client === app.clients[app.active]) app.mapView.flash(e.territory);
    if (e.type === 'PLAYER_ELIMINATED' && e.playerId === client.playerId && client === app.clients[app.active]) toast('Vous avez été éliminé. Vous pouvez continuer à regarder et discuter.');
    if (e.type === 'GAME_OVER' && client === app.clients[app.active]) {
      const w = getPlayer(client.state, e.winner);
      toast(`🏆 ${w?.name ?? '?'} remporte la partie !`, 'info');
    }
  }
}

function renderGame() {
  const ui = activeUi();
  if (!ui?.client.state) return;
  const state = ui.client.state;
  sanitizeSelection(ui, state);
  app.sidebar.render(state, ui);
  app.mapView.update(state, computeHighlights(state, ui));
  app.rules.update(state, ui.client.me);
  renderChat();
  renderSwitcher();
}

function renderChat() {
  const ui = activeUi();
  app.chatView.render(ui.client.chat, ui.client.state.players, ui.client.playerId);
}

function renderSwitcher() {
  const el = $('#local-switcher');
  if (app.clients.length < 2) return (el.hidden = true);
  el.hidden = false;
  const state = activeUi().client.state;
  el.innerHTML =
    '<span class="muted">Joueurs de cet onglet :</span>' +
    app.clients
      .map((c, i) => {
        const p = getPlayer(state, c.playerId);
        const turn = state.turn?.playerId === c.playerId ? ' ●' : '';
        return `<button class="btn small ${i === app.active ? 'active' : ''}" data-switch="${i}" style="border-color:${playerHex(p)}">${esc(p?.name ?? '?')}${turn}</button>`;
      })
      .join('') +
    `<label class="small" style="margin-left:auto"><input type="checkbox" id="follow-turn" ${app.followTurn ? 'checked' : ''}/> suivre le tour</label>`;
}

/** Invalide une sélection devenue incohérente (territoire perdu, phase changée…). */
function sanitizeSelection(ui, state) {
  const me = ui.client.playerId;
  const { from, to } = ui.sel;
  if (from && (state.territories[from]?.owner !== me || state.territories[from].troops < 2)) ui.sel = { from: null, to: null };
  if (to && state.territories[to]?.owner === me) ui.sel.to = null;
}

// ─────────────────────────── Interactions carte ───────────────────────────

function onTerritoryClick(tid) {
  const ui = activeUi();
  if (!ui?.client.state) return;
  const state = ui.client.state;
  const me = ui.client.playerId;
  const terr = state.territories[tid];
  if (!state.turn || state.turn.playerId !== me) {
    const owner = getPlayer(state, terr.owner);
    return toast(`${tname(tid)} — ${owner?.name ?? '?'} — ${terr.troops} troupe(s)`, 'info');
  }
  const turn = state.turn;
  const mine = terr.owner === me;

  if (turn.pendingOccupy) return openOccupyModal(ui);
  if (turn.mustExchange) return toast('Échangez d’abord une combinaison de cartes.');

  // Placement (initial, renforts, ou renforts issus d'un échange en phase d'attaque)
  if (turn.reinforcements > 0) {
    if (!mine) return toast('Vous ne pouvez renforcer que vos territoires.');
    const count = ui.placeCount === 'all' ? turn.reinforcements : Math.min(ui.placeCount, turn.reinforcements);
    return send({ type: 'PLACE_TROOPS', territory: tid, count });
  }

  if (turn.phase === 'attack') {
    if (mine) {
      if (terr.troops < 2) return toast('Il faut au moins 2 troupes pour attaquer.');
      ui.sel = { from: tid, to: null };
      ui.blitz = false;
    } else if (ui.sel.from && areAdjacent(ui.sel.from, tid)) {
      ui.sel.to = tid;
    } else {
      return toast(ui.sel.from ? 'Cible non adjacente.' : 'Sélectionnez d’abord un de vos territoires.');
    }
    return renderGame();
  }

  if (turn.phase === 'fortify') {
    if (!ui.sel.from) {
      if (!mine) return toast('Choisissez un de vos territoires.');
      if (terr.troops < 2) return toast('Il faut au moins 2 troupes pour en déplacer.');
      ui.sel.from = tid;
    } else if (tid === ui.sel.from) {
      ui.sel.from = null;
    } else if (mine && connectedOwned(state, ui.sel.from).includes(tid)) {
      return openFortifyModal(ui, ui.sel.from, tid);
    } else if (mine && terr.troops >= 2) {
      ui.sel.from = tid;
    } else {
      return toast('Destination non reliée par vos territoires.');
    }
    return renderGame();
  }
}

/** Attaque totale : enchaîne les assauts tant que c'est possible et utile. */
function blitzStep(ui) {
  if (!ui.blitz) return;
  const state = ui.client.state;
  const me = ui.client.playerId;
  const { from, to } = ui.sel;
  const ok =
    state.turn && state.turn.playerId === me && state.turn.phase === 'attack' && !state.turn.pendingOccupy && !state.turn.mustExchange &&
    from && to && state.territories[from].owner === me && state.territories[to].owner !== me && state.territories[from].troops >= 2;
  if (!ok) {
    ui.blitz = false;
    renderGame();
    if (state.turn?.pendingOccupy) openOccupyModal(ui);
    return;
  }
  send({ type: 'ATTACK', from, to, dice: Math.min(3, state.territories[from].troops - 1) });
}

/** Placement automatique : réutilise l'heuristique de l'IA, un paquet à la fois. */
function autoPlaceStep(ui) {
  if (!ui.autoPlace) return;
  const state = ui.client.state;
  if (!state.turn || state.turn.playerId !== ui.client.playerId || state.turn.reinforcements === 0) {
    ui.autoPlace = false;
    return;
  }
  const action = decideBotAction(state, ui.client.playerId);
  if (action?.type !== 'PLACE_TROOPS') {
    ui.autoPlace = false;
    return;
  }
  send({ type: 'PLACE_TROOPS', territory: action.territory, count: action.count });
}

// ─────────────────────────── Modales ───────────────────────────

function openModal(html, onConfirm) {
  const m = $('#modal');
  m.innerHTML = `<div class="box">${html}<div class="actions"><button class="btn" data-cancel>Annuler</button><button class="btn primary" data-ok>Valider</button></div></div>`;
  m.hidden = false;
  const range = m.querySelector('input[type=range]');
  const out = m.querySelector('[data-out]');
  if (range && out) range.addEventListener('input', () => (out.textContent = range.value));
  m.querySelector('[data-cancel]').onclick = () => (m.hidden = true);
  m.querySelector('[data-ok]').onclick = () => {
    m.hidden = true;
    onConfirm(range ? Number(range.value) : null);
  };
}

function openOccupyModal(ui) {
  const o = ui.client.state.turn?.pendingOccupy;
  if (!o) return;
  openModal(
    `<h2>Occupation de ${esc(tname(o.to))}</h2>
     <p class="muted">Combien de troupes au total envoyer depuis ${esc(tname(o.from))} ? (minimum ${o.min} : le nombre de dés lancés)</p>
     <input type="range" min="${o.min}" max="${o.max}" value="${o.max}" /><div class="big" style="text-align:center"><span data-out>${o.max}</span> troupes</div>`,
    (count) => send({ type: 'OCCUPY', count }),
  );
}

function openFortifyModal(ui, from, to) {
  const max = ui.client.state.territories[from].troops - 1;
  openModal(
    `<h2>Déplacement</h2><p class="muted">${esc(tname(from))} → ${esc(tname(to))}. Ce déplacement termine votre tour.</p>
     <input type="range" min="1" max="${max}" value="${max}" /><div class="big" style="text-align:center"><span data-out>${max}</span> troupes</div>`,
    (count) => {
      ui.sel = { from: null, to: null };
      send({ type: 'FORTIFY', from, to, count });
    },
  );
}

// ═══════════════════════════ Démarrage ═══════════════════════════

initHome();
initLobby();
initGame();
show('home');

// Accès debug depuis la console : window.risk.app.runtime.host.state, etc.
window.risk = { app };
