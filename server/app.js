/**
 * Serveur WebSocket du Risk en ligne, sous forme de fonction démarrable
 * (`startServer`) : index.js la lance avec la configuration d'environnement, les
 * tests la lancent sur un port libre avec un dossier temporaire.
 *
 * Il ne contient AUCUNE règle de jeu : il route les messages vers la bonne partie
 * (GameHost, src/net/host.js) et s'occupe de la persistance et de la protection
 * réseau.
 *
 * Défenses (chacune couverte par test/server.security.test.js) :
 *  - aucun message ne peut faire planter le processus : tout est enveloppé,
 *    y compris un JSON valide mais inattendu (`null`, un nombre, un tableau),
 *    et chaque socket a son gestionnaire d'erreur ;
 *  - taille maximale d'un message (maxPayload), messages texte uniquement ;
 *  - limitation de débit par connexion (seau à jetons), chat plus serré encore,
 *    fermeture des connexions qui insistent ;
 *  - nombre maximal de parties simultanées ;
 *  - réglages de création filtrés : un client ne choisit jamais la graine des dés ;
 *  - origine du navigateur vérifiée (une page tierce ne peut pas ouvrir de
 *    connexion depuis le navigateur de ses visiteurs) ;
 *  - sauvegardes relues avec prudence (nom de fichier et code validés).
 */
import './crypto-polyfill.js';
import { WebSocketServer } from 'ws';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { GameHost } from '../src/net/host.js';
import { C2S, S2C, ERROR_CODES, generateGameCode, randomId, sanitizeCreateSettings } from '../src/net/protocol.js';

export const DEFAULTS = Object.freeze({
  port: 8080,
  frontUrl: 'http://localhost:5180/',
  retentionMs: 96 * 3600 * 1000, // 4 jours sans aucun humain → supprimée
  emptyLobbyMs: 3600 * 1000, // salon vide depuis 1 h → supprimé
  sweepMs: 10 * 60 * 1000,
  saveDebounceMs: 300,
  maxGames: 500,
  /** Un message de jeu fait quelques centaines d'octets ; 32 Ko laisse une large marge. */
  maxPayload: 32 * 1024,
  allowedOrigins: [],
  rate: Object.freeze({
    perSec: 30, // messages par seconde en régime continu (l'« attaque totale » en envoie ~6/s)
    burst: 60,
    chatPerSec: 1, // un message de chat par seconde en régime continu…
    chatBurst: 8, // …avec une petite rafale autorisée
    maxViolations: 40, // au-delà, la connexion est fermée
  }),
});

const SAVE_FILE_REGEX = /^[A-Z0-9]{6}\.json$/;

/** Seau à jetons : `capacity` d'avance, recharge `perSec` par seconde. */
function tokenBucket(capacity, perSec) {
  let tokens = capacity;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + ((now - last) / 1000) * perSec);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

/**
 * Origines de navigateur autorisées : celle du site (et sa variante www/sans www),
 * localhost pour le développement, plus ALLOWED_ORIGINS. Une connexion SANS en-tête
 * Origin vient d'un programme et non d'un navigateur : elle est acceptée (hors
 * navigateur, l'en-tête se falsifie de toute façon, la vérification ne protège
 * que les visiteurs d'une page tierce).
 */
export function makeOriginCheck(frontUrl, extra = []) {
  const allowed = new Set(extra.map((o) => String(o).trim()).filter(Boolean));
  try {
    const u = new URL(frontUrl);
    allowed.add(u.origin);
    const alt = u.hostname.startsWith('www.') ? u.hostname.slice(4) : `www.${u.hostname}`;
    allowed.add(`${u.protocol}//${alt}${u.port ? `:${u.port}` : ''}`);
  } catch {
    /* FRONT_URL invalide : seules les origines explicites et localhost passent */
  }
  return (origin) => {
    if (!origin) return true;
    if (allowed.has(origin)) return true;
    try {
      const host = new URL(origin).hostname;
      return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    } catch {
      return false;
    }
  };
}

/**
 * Démarre le serveur.
 * @param {object} [options]  voir DEFAULTS ; `dataDir` est obligatoire ; `log` = console par défaut
 * @returns {Promise<{ port:number, wss:WebSocketServer, games:Map<string,GameHost>, flush():void, close():Promise<void> }>}
 */
export function startServer(options = {}) {
  const opt = { ...DEFAULTS, ...options, rate: { ...DEFAULTS.rate, ...(options.rate ?? {}) } };
  if (!opt.dataDir) throw new Error('startServer : dataDir est obligatoire');
  const log = opt.log ?? console;
  const gamesDir = join(opt.dataDir, 'games');
  const isAllowedOrigin = makeOriginCheck(opt.frontUrl, opt.allowedOrigins);

  /** @type {Map<string, GameHost>} */
  const games = new Map();
  /** @type {Map<string, import('ws').WebSocket>} clientId → socket */
  const sockets = new Map();
  const saveTimers = new Map();

  function sendTo(clientId, message) {
    const ws = sockets.get(clientId);
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  // ─────────────────────────── Persistance ───────────────────────────

  mkdirSync(gamesDir, { recursive: true });
  const gameFile = (id) => join(gamesDir, `${id}.json`);

  function saveNow(host) {
    saveTimers.delete(host.gameId);
    if (host.closed) return;
    try {
      const tmp = `${gameFile(host.gameId)}.tmp`;
      writeFileSync(tmp, JSON.stringify(host.serialize()));
      renameSync(tmp, gameFile(host.gameId)); // écriture atomique
    } catch (e) {
      log.error(`[persist] échec de sauvegarde ${host.gameId} :`, e.message);
    }
  }

  function scheduleSave(host) {
    if (saveTimers.has(host.gameId)) return;
    saveTimers.set(host.gameId, setTimeout(() => saveNow(host), opt.saveDebounceMs));
  }

  function removeGame(id, reason) {
    const host = games.get(id);
    if (host) host.close();
    games.delete(id);
    clearTimeout(saveTimers.get(id));
    saveTimers.delete(id);
    try {
      if (existsSync(gameFile(id))) unlinkSync(gameFile(id));
    } catch (e) {
      log.error(`[persist] suppression ${id} :`, e.message);
    }
    log.log(`[games] ${id} supprimée (${reason})`);
  }

  function track(host) {
    games.set(host.gameId, host);
    host.onDirty = () => {
      if (host.state.status === 'finished') {
        // Partie terminée : supprimée tout de suite (après que l'état final soit parti aux clients)
        setTimeout(() => removeGame(host.gameId, 'terminée'), 1000);
        return;
      }
      scheduleSave(host);
    };
    return host;
  }

  function loadGames() {
    let n = 0;
    for (const file of readdirSync(gamesDir)) {
      if (!SAVE_FILE_REGEX.test(file)) continue; // ni .tmp, ni noms exotiques
      try {
        const snapshot = JSON.parse(readFileSync(join(gamesDir, file), 'utf8'));
        if (snapshot?.gameId !== file.slice(0, 6)) throw new Error('code différent du nom de fichier');
        if (snapshot.state?.status === 'finished') {
          unlinkSync(join(gamesDir, file));
          continue;
        }
        track(GameHost.restore(snapshot, { sendTo }));
        n++;
      } catch (e) {
        log.error(`[persist] fichier ignoré ${file} :`, e.message);
      }
    }
    return n;
  }

  function sweep() {
    const now = Date.now();
    for (const [id, host] of games) {
      if (host.state.status === 'finished') removeGame(id, 'terminée');
      else if (host.state.status === 'lobby' && host.state.players.length === 0 && now - host.lastActivity > opt.emptyLobbyMs) removeGame(id, 'salon vide');
      else if (!host.hasConnectedHuman() && now - host.lastActivity > opt.retentionMs) removeGame(id, `inactive depuis ${Math.round(opt.retentionMs / 3600000)} h`);
    }
  }

  function createGame(rawSettings) {
    let gameId = generateGameCode();
    while (games.has(gameId)) gameId = generateGameCode();
    // Seuls maxPlayers, botDelayMs et mapId passent, bornés : jamais `seed` ni `id`.
    const settings = sanitizeCreateSettings(rawSettings);
    return track(new GameHost({ gameId, settings, inviteUrl: `${opt.frontUrl}?game=${gameId}`, sendTo }));
  }

  // ─────────────────────────── Connexions ───────────────────────────

  let refusedOrigins = 0;
  function onConnection(ws) {
    const clientId = randomId('ws');
    sockets.set(clientId, ws);
    /** @type {GameHost|null} */
    let host = null;
    const allowAny = tokenBucket(opt.rate.burst, opt.rate.perSec);
    const allowChat = tokenBucket(opt.rate.chatBurst, opt.rate.chatPerSec);
    let violations = 0;
    let lastWarning = 0;

    const error = (code, message) => sendTo(clientId, { type: S2C.ERROR, code, message });

    function throttled(what) {
      violations++;
      const now = Date.now();
      if (now - lastWarning > 1000) {
        lastWarning = now;
        error(ERROR_CODES.RATE_LIMITED, `Trop de ${what} : ralentissez.`);
      }
      if (violations > opt.rate.maxViolations) ws.close(1008, 'Trop de messages');
    }

    function handle(raw, isBinary) {
      if (!allowAny()) return throttled('messages');
      if (isBinary) return error(ERROR_CODES.BAD_MESSAGE, 'Messages texte uniquement');
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return error(ERROR_CODES.BAD_MESSAGE, 'JSON invalide');
      }
      // JSON valide ne veut pas dire objet : `null`, `5` ou `[]` faisaient planter le serveur.
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
        return error(ERROR_CODES.BAD_MESSAGE, 'Message invalide');
      }
      if ((msg.type === C2S.CHAT || msg.type === C2S.COMMAND) && !allowChat()) return throttled('messages de chat');

      // Routage : create / join / spectate ici, le reste par l'hôte de la partie.
      if (!host) {
        if (msg.type === C2S.CREATE) {
          if (games.size >= opt.maxGames) return error(ERROR_CODES.SERVER_FULL, 'Serveur complet : trop de parties en cours, réessayez plus tard.');
          host = createGame(msg.settings);
          host.addClient(clientId);
          return host.handleMessage(clientId, { type: C2S.JOIN, playerName: msg.playerName });
        }
        if (msg.type === C2S.JOIN || msg.type === C2S.SPECTATE) {
          const found = typeof msg.gameId === 'string' ? games.get(msg.gameId.toUpperCase()) : null;
          if (!found) return error(ERROR_CODES.GAME_NOT_FOUND, 'Partie introuvable (code erroné, partie terminée ou expirée)');
          host = found;
          host.addClient(clientId);
          return host.handleMessage(clientId, msg);
        }
        if (msg.type === C2S.PING) return sendTo(clientId, { type: S2C.PONG });
        return error(ERROR_CODES.BAD_MESSAGE, 'Rejoignez une partie d’abord');
      }
      host.handleMessage(clientId, msg);
    }

    ws.on('message', (raw, isBinary) => {
      try {
        handle(raw, isBinary);
      } catch (e) {
        // Filet de sécurité : une erreur de programmation ne doit jamais couper tout le monde
        log.error('[ws] message non traité :', e);
        error(ERROR_CODES.BAD_MESSAGE, 'Message non traité');
      }
    });
    // Trame invalide, message trop gros… : sans ce gestionnaire, Node arrête le processus.
    ws.on('error', (e) => log.warn?.(`[ws] ${clientId} :`, e.message));
    ws.on('close', () => {
      sockets.delete(clientId);
      try {
        host?.handleDisconnect(clientId);
      } catch (e) {
        log.error('[ws] déconnexion non traitée :', e);
      }
    });
  }

  // ─────────────────────────── Démarrage ───────────────────────────

  const restored = loadGames();
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({
      port: opt.port,
      maxPayload: opt.maxPayload,
      verifyClient: ({ origin }) => {
        const ok = isAllowedOrigin(origin);
        if (!ok && refusedOrigins++ < 20) log.warn?.(`[ws] origine refusée : ${origin} (voir ALLOWED_ORIGINS)`);
        return ok;
      },
    });
    const onStartError = (e) => reject(e);
    wss.once('error', onStartError);
    wss.on('connection', onConnection);
    wss.once('listening', () => {
      wss.off('error', onStartError);
      wss.on('error', (e) => log.error('[ws] erreur du serveur :', e.message));
      const sweepTimer = setInterval(sweep, opt.sweepMs);
      sweepTimer.unref?.();
      const port = wss.address().port;
      log.log(`Serveur Risk en écoute sur ws://localhost:${port} (front : ${opt.frontUrl})`);
      log.log(`Sauvegardes : ${gamesDir} — ${restored} partie(s) rechargée(s), conservation ${Math.round(opt.retentionMs / 3600000)} h, ${opt.maxGames} parties max`);

      /** Écrit immédiatement les sauvegardes en attente. */
      const flush = () => {
        for (const host of games.values()) if (saveTimers.has(host.gameId)) saveNow(host);
      };
      resolve({
        port,
        wss,
        games,
        flush,
        sweep,
        close: () =>
          new Promise((done) => {
            clearInterval(sweepTimer);
            flush();
            for (const t of saveTimers.values()) clearTimeout(t);
            for (const host of games.values()) host.close();
            for (const ws of wss.clients) ws.terminate();
            wss.close(() => done());
          }),
      });
    });
  });
}
