// main.js — processus principal.
// Il detient la connexion Aurora et le moteur ; la fenetre ne fait qu'afficher.
//
// Mode mono-avion (tick/buildRow) : passe par la macro %SELTFC%, qui suit
// l'avion selectionne dans Aurora.
//
// Mode balayage (scanLoop/scanOnce) : interroge chaque avion par son indicatif
// explicite (#TRPOS;CALLSIGN, #FP;CALLSIGN, #TRPATHA;CALLSIGN). On avait cru
// au debut du projet qu'Aurora rejetait tout indicatif explicite (d'ou la
// macro %SELTFC%) — reteste en session, ca fonctionne en realite pour ces
// commandes sur un avion non selectionne. Seul #TRPOS;%SELTFC% pose un
// probleme a part : il fait fermer la socket quand rien n'est selectionne
// (voir le commentaire dans tick()).

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { AuroraClient } = require("./aurora-client");
const { evaluate, fixesFromRoute, DB } = require("./loa-engine");

const POLL_MS = 1500;       // detection du changement de selection
const REFRESH_MS = 6000;    // rafraichissement de l'avion courant
const ATC_MS = 30000;       // liste des ATC en ligne
const BACKOFF_MAX = 6;      // echecs consecutifs avant temporisation maximale
const RECONNECT_MS = 4000;

const TR_REFRESH_MS = 15000;      // rafraichissement de la liste des trafics visibles
const FP_TTL_MS = 5 * 60 * 1000;  // duree de vie du cache plan de vol/route par indicatif
const SCAN_PAUSE_MS = 500;        // pause entre deux tours de balayage complets

let win = null;
let aurora = null;
let myStation = null;
let onlineATC = [];
let lastCallsign = null;
let lastRefresh = 0;
let lastAnnounced;
let busy = false;
let failures = 0;
let wanted = false;         // l'utilisateur veut-il etre connecte
let timers = [];
let reconnectTimer = null;

// --- balayage global (mode alternatif au mono-avion) ------------------------
// L'utilisateur peut basculer entre "je regarde l'avion selectionne" (mode
// historique) et "je surveille en continu tout ce que j'assume, et je ne vois
// que les ecarts". Les deux modes sont mutuellement exclusifs et partagent la
// meme socket Aurora sequentielle — jamais de requetes en parallele.

let scanMode = false;
let scanStop = true;
let scanRunning = false;
const trafficCache = new Map(); // indicatif -> { fp, path, fpAt }
let trList = [];
let trFetchedAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- fenetre de debug ---------------------------------------------------------
// Journal en anneau des echanges TCP et des decisions du moteur, independant du
// bandeau d'erreur (qui lui est throttle a 4s pour ne pas spammer l'utilisateur).

const DEBUG_MAX = 2000;
let debugWin = null;
let debugLog = [];

function debugPush(dir, tag, text) {
  const entry = { t: Date.now(), dir, tag, text };
  debugLog.push(entry);
  if (debugLog.length > DEBUG_MAX) debugLog.shift();
  if (debugWin && !debugWin.isDestroyed()) debugWin.webContents.send("debug:entry", entry);
}

function createDebugWindow() {
  if (debugWin && !debugWin.isDestroyed()) {
    debugWin.show();
    debugWin.focus();
    return;
  }
  debugWin = new BrowserWindow({
    width: 760, height: 500, minWidth: 420, minHeight: 240,
    parent: win || undefined,
    backgroundColor: "#16181b",
    title: "Debug — Assistant LoA",
    webPreferences: {
      preload: path.join(__dirname, "debug-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  debugWin.loadFile("debug.html");
  debugWin.webContents.once("did-finish-load", () => {
    debugWin.webContents.send("debug:backlog", debugLog);
  });
  debugWin.on("closed", () => { debugWin = null; });
}

// Consultation manuelle : fonctionne sans Aurora, aucune dependance a `aurora`
// ou `myStation` — l'utilisateur fournit lui-meme dep/arr/secteur.
let manuelWin = null;

function createManuelWindow() {
  if (manuelWin && !manuelWin.isDestroyed()) {
    manuelWin.show();
    manuelWin.focus();
    return;
  }
  manuelWin = new BrowserWindow({
    width: 640, height: 560, minWidth: 480, minHeight: 400,
    parent: win || undefined,
    backgroundColor: "#16181b",
    title: "Consultation manuelle — Assistant LoA",
    webPreferences: {
      preload: path.join(__dirname, "manuel-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  manuelWin.loadFile("manuel.html");
  manuelWin.on("closed", () => { manuelWin = null; });
}

function createWindow() {
  win = new BrowserWindow({
    width: 940, height: 580, minWidth: 660, minHeight: 320,
    frame: false,
    backgroundColor: "#16181b",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile("index.html");
  win.on("closed", () => { win = null; });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

let lastReport = 0;
function report(message) {
  console.error("[loa]", message);
  if (Date.now() - lastReport < 4000) return;
  lastReport = Date.now();
  send("trouble", { message });
}

// --- connexion --------------------------------------------------------------

async function connect() {
  if (aurora) return;
  wanted = true;
  send("status", { state: "connecting" });

  debugPush("info", "app", "Connexion demandee");

  aurora = new AuroraClient();
  aurora.on("socket-error", (e) => { report(`Socket : ${e.message}`); debugPush("err", "socket", e.message); });
  aurora.on("server-error", (line) => { console.error("[aurora]", line); debugPush("err", "tcp", line); });
  aurora.on("message", ({ raw }) => debugPush("in", "tcp", raw));
  aurora.on("send", (command) => debugPush("out", "tcp", command));
  aurora.on("disconnected", onDisconnected);

  try {
    await aurora.connect();
  } catch (e) {
    aurora = null;
    debugPush("err", "app", `Connexion refusee : ${e.message}`);
    send("status", {
      state: "error",
      message: "Aurora ne repond pas sur 127.0.0.1:1130. Active 3rd Party Software Access dans F7 > Other.",
    });
    return;
  }

  const me = await aurora.request("#CONN").catch(() => null);
  myStation = me && me.callsign ? me.callsign : null;

  if (!myStation) {
    send("status", { state: "error", message: "Aurora repond mais aucune position ATC n'est connectee." });
    return disconnect();
  }

  await refreshATC();
  failures = 0;
  debugPush("info", "app", `Connecte, station ${myStation}`);
  send("status", { state: "connected", station: myStation });
  if (scanMode) startScan(); else startTimers();
}

// Fermeture inattendue : on retente, au lieu de declarer forfait.
function onDisconnected() {
  stopTimers();
  stopScan();
  aurora = null;
  debugPush("info", "app", "Deconnecte");
  if (!wanted) return send("status", { state: "idle" });

  send("status", { state: "connecting", message: "Connexion perdue, nouvelle tentative..." });
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { if (wanted) connect(); }, RECONNECT_MS);
}

function disconnect() {
  wanted = false;
  clearTimeout(reconnectTimer);
  stopTimers();
  stopScan();
  if (aurora) { try { aurora.disconnect(); } catch {} }
  aurora = null;
  myStation = null;
  onlineATC = [];
  lastCallsign = null;
  lastAnnounced = undefined;
  debugPush("info", "app", "Deconnexion demandee");
  send("status", { state: "idle" });
}

// --- boucle -----------------------------------------------------------------

function startTimers() {
  stopTimers();
  timers = [
    setInterval(() => tick(false), POLL_MS),
    setInterval(() => tick(true), REFRESH_MS),
    setInterval(refreshATC, ATC_MS),
  ];
}

function stopTimers() {
  timers.forEach(clearInterval);
  timers = [];
  busy = false;
}

// --- boucle de balayage ------------------------------------------------------

function startScan() {
  scanStop = false;
  trafficCache.clear();
  trList = [];
  trFetchedAt = 0;
  scanLoop();
}

function stopScan() {
  scanStop = true;
}

async function scanLoop() {
  if (scanRunning) return; // deja en cours, ne pas empiler un second tour
  scanRunning = true;
  try {
    while (!scanStop && aurora) {
      await scanOnce();
      await sleep(SCAN_PAUSE_MS);
    }
  } finally {
    scanRunning = false;
  }
}

async function scanOnce() {
  if (Date.now() - trFetchedAt > TR_REFRESH_MS) {
    const list = await aurora.request("#TR").catch((e) => {
      debugPush("err", "engine", `#TR refuse : ${e.message}`);
      return null;
    });
    if (Array.isArray(list)) {
      trList = list;
      trFetchedAt = Date.now();
      for (const cs of [...trafficCache.keys()]) {
        if (!trList.includes(cs)) trafficCache.delete(cs); // plus visible : hors cache
      }
    }
  }

  const flagged = [];

  for (const callsign of trList) {
    if (scanStop || !aurora) break;

    let entry = trafficCache.get(callsign);
    if (!entry || Date.now() - entry.fpAt > FP_TTL_MS) {
      // #FP et #TRPATHA changent rarement : mis en cache, pas redemandes a
      // chaque tour (contrairement a #TRPOS, sondee systematiquement).
      const [fpRes, pathRes] = await Promise.allSettled([
        aurora.request(`#FP;${callsign}`),
        aurora.request(`#TRPATHA;${callsign}`),
      ]);
      if (fpRes.status !== "fulfilled") {
        debugPush("err", "engine", `${callsign} : #FP refuse en balayage (${fpRes.reason.message})`);
        continue;
      }
      const fp = fpRes.value;
      const routePath = pathRes.status === "fulfilled"
        ? pathRes.value.path
        : fixesFromRoute(fp.route).map((fix) => ({ fix, eto: null }));
      entry = { fp, path: routePath, fpAt: Date.now() };
      trafficCache.set(callsign, entry);
    }

    const pos = await aurora.request(`#TRPOS;${callsign}`).catch((e) => {
      debugPush("err", "engine", `${callsign} : #TRPOS refuse en balayage (${e.message})`);
      return null;
    });
    if (!pos || pos.assumedBy !== myStation) continue; // pas a moi : ignore mais reste en cache

    const result = evaluate({ myStation, fp: entry.fp, pos, path: entry.path, onlineATC });
    const hasGap = result.matched && (
      result.labelCheck === "mismatch" ||
      result.labelCheck === "empty" ||
      result.warnings.length > 0
    );
    if (hasGap) {
      flagged.push({ ...result, at: Date.now() });
      // Une ligne resume par avion en ecart, pas la trace complete etape par
      // etape (deja bruyante pour un seul avion, ca noierait le journal
      // multiplie par tous les avions assumes a chaque tour).
      debugPush("info", "engine", `${callsign} : ecart (${result.labelCheck || "avertissement"}) — ${result.ref}`);
    }
  }

  send("scanRows", { rows: flagged });
}

function setScanMode(active) {
  if (scanMode === active) return;
  scanMode = active;
  if (aurora) {
    if (scanMode) { stopTimers(); startScan(); }
    else { stopScan(); startTimers(); }
  }
  debugPush("info", "app", `Mode balayage ${scanMode ? "active" : "desactive"}`);
  send("scanMode", { active: scanMode });
}

async function refreshATC() {
  if (!aurora) return;
  const list = await aurora.request("#ATC").catch(() => null);
  if (Array.isArray(list)) onlineATC = list;
  send("atc", { count: Array.isArray(list) ? list.length : null });
}

function announceSelection(callsign) {
  if (callsign === lastAnnounced) return;
  lastAnnounced = callsign;
  send("selection", { callsign });
}

async function tick(force) {
  if (!aurora || busy) return;

  // Temporisation apres echecs repetes : on espace les tentatives au lieu de
  // marteler une commande qui ne passe pas.
  if (!force && failures > 0 &&
      Date.now() - lastRefresh < POLL_MS * Math.min(failures, BACKOFF_MAX)) return;

  busy = true;
  let callsign = null;

  try {
    // #TRPOS;%SELTFC% fait fermer la connexion cote Aurora quand rien n'est
    // selectionne (constate en session, jamais documente ailleurs). On
    // verifie d'abord avec #SELTFC seul, qui lui ne casse rien, avant de
    // s'en servir — #TRPOS;%SELTFC% devient alors sans risque puisqu'on
    // vient de confirmer qu'un avion est selectionne.
    const sel = await aurora.request("#SELTFC");
    callsign = sel && sel.callsign;
    failures = 0;

    if (!callsign) return announceSelection(null);

    const isNew = callsign !== lastCallsign;
    if (!isNew && !force) return;
    if (!isNew && Date.now() - lastRefresh < REFRESH_MS) return;

    announceSelection(callsign);
    const pos = await aurora.request("#TRPOS;%SELTFC%");
    const row = await buildRow(callsign, pos);

    lastCallsign = callsign;
    lastRefresh = Date.now();
    send("row", { row, mode: isNew ? "push" : "update" });
  } catch (e) {
    failures += 1;
    lastRefresh = Date.now();
    if (!callsign) {
      // Aucun avion selectionne : Aurora ignore la commande. Cas normal.
      announceSelection(null);
    } else {
      lastCallsign = null; // pour que la passe suivante retente
      report(`Lecture de ${callsign} impossible : ${e.message}`);
      debugPush("err", "engine", `${callsign} : ${e.message}`);
    }
  } finally {
    busy = false;
  }
}

async function buildRow(expectedCallsign, knownPos) {
  const [fpRes, pathRes] = await Promise.allSettled([
    aurora.request("#FP;%SELTFC%"),
    aurora.request("#TRPATHA;%SELTFC%"), // points survoles + restants : necessaire pour matcher un COP deja franchi
  ]);

  if (fpRes.status === "rejected") throw new Error(`#FP : ${fpRes.reason.message}`);
  const fp = fpRes.value;

  // La selection a pu changer entre la scrutation et la lecture.
  if (fp.callsign && fp.callsign !== expectedCallsign) {
    throw new Error(`selection changee (${expectedCallsign} -> ${fp.callsign})`);
  }

  let path;
  let degraded = null;
  if (pathRes.status === "fulfilled") {
    path = pathRes.value.path;
  } else {
    path = fixesFromRoute(fp.route).map((fix) => ({ fix, eto: null }));
    degraded = "Route issue du plan de vol (#TRPATHA indisponible) - points survoles inclus";
    report(`#TRPATHA refuse : ${pathRes.reason.message}`);
    debugPush("err", "engine", `${expectedCallsign} : #TRPATHA refuse (${pathRes.reason.message}), repli sur le plan de vol`);
  }

  const result = evaluate({ myStation, fp, pos: knownPos, path, onlineATC });
  if (degraded) result.conditions = [...(result.conditions || []), degraded];

  const fixList = path.map((p) => p.fix).join(" ") || "(vide)";
  debugPush(
    "info",
    "engine",
    result.matched
      ? `${expectedCallsign} ${fp.dep}->${fp.arr} : regle ${result.ruleId} (${result.ref}), COP ${result.transferPoint} — route [${fixList}]`
      : `${expectedCallsign} ${fp.dep}->${fp.arr} : Aucun COP — route [${fixList}]`
  );
  // Detail de la decision : classification, candidats consideres, exception
  // retenue. Une ligne par etape, prefixee du callsign pour s'y retrouver
  // quand plusieurs avions defilent dans le log.
  for (const line of result.trace || []) {
    debugPush("info", "engine", `${expectedCallsign} : ${line}`);
  }

  return { ...result, at: Date.now() };
}

// --- IPC --------------------------------------------------------------------

ipcMain.on("connect", connect);
ipcMain.on("disconnect", disconnect);
ipcMain.on("scan:toggle", () => setScanMode(!scanMode));

ipcMain.on("manuel:open", createManuelWindow);
ipcMain.handle("manuel:evaluate", (_e, { dep, arr, waypoint, sector }) => {
  const mySector = sector === "LFMM_E" ? "LFMM_E_CTR" : "LFMM_W_CTR";
  const fp = {
    callsign: "MANUEL",
    dep: (dep || "").toUpperCase(),
    arr: (arr || "").toUpperCase(),
    aircraft: "?",
    wake: "?",
    cruiseLevel: null, // pas de RFL reel en mode manuel : niveau decrit en general
  };
  const path = waypoint ? [{ fix: waypoint.toUpperCase(), eto: null }] : [];
  return evaluate({ myStation: mySector, fp, pos: {}, path, onlineATC: [] });
});

ipcMain.on("window", (_e, action) => {
  if (!win) return;
  if (action === "minimize") win.minimize();
  if (action === "maximize") win.isMaximized() ? win.unmaximize() : win.maximize();
  if (action === "close") win.close();
  if (action === "pin") {
    const pinned = !win.isAlwaysOnTop();
    win.setAlwaysOnTop(pinned);
    send("pinned", { pinned });
  }
});

ipcMain.on("debug:open", createDebugWindow);
ipcMain.on("debug:clear", () => { debugLog = []; });

// Chargement des fichiers LOA (loa/*.json) : jamais silencieux, meme si le
// reste de l'app fonctionne avec les fichiers valides restants.
(DB.errors || []).forEach((e) => { console.error("[loa]", e); debugPush("err", "app", e); });
(DB.warnings || []).forEach((w) => { console.warn("[loa]", w); debugPush("info", "app", w); });
debugPush("info", "app", `LOA chargees : ${(DB.sources || []).join(", ") || "aucune"} (${DB.rules.length} regles)`);

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { wanted = false; stopTimers(); app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
