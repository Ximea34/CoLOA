// main.js — processus principal.
// Il detient la connexion Aurora et le moteur ; la fenetre ne fait qu'afficher.
//
// Regle : toutes les commandes passent par la macro %SELTFC%. Cette application
// ne regarde que l'avion selectionne, et Aurora refuse les commandes portant un
// indicatif explicite ("@ERR ... Unknown command"). C'est aussi exactement ce
// que faisait la sonde, qui fonctionnait.

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { AuroraClient } = require("./aurora-client");
const { evaluate, fixesFromRoute, DB } = require("./loa-engine");

const POLL_MS = 1500;       // detection du changement de selection
const REFRESH_MS = 6000;    // rafraichissement de l'avion courant
const ATC_MS = 30000;       // liste des ATC en ligne
const BACKOFF_MAX = 6;      // echecs consecutifs avant temporisation maximale
const RECONNECT_MS = 4000;

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
  startTimers();
}

// Fermeture inattendue : on retente, au lieu de declarer forfait.
function onDisconnected() {
  stopTimers();
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
    const pos = await aurora.request("#TRPOS;%SELTFC%");
    callsign = pos && pos.callsign;
    failures = 0;

    if (!callsign) return announceSelection(null);

    const isNew = callsign !== lastCallsign;
    if (!isNew && !force) return;
    if (!isNew && Date.now() - lastRefresh < REFRESH_MS) return;

    announceSelection(callsign);
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
