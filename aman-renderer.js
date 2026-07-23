// aman-renderer.js — formulaire + frise chronologique (ladder) AMAN.
// Interroge aman:compute a la demande (bouton) puis toutes les 8s tant que la
// fenetre reste ouverte sur les memes parametres.

const el = (id) => document.getElementById(id);
const form = el("form");
const ladderEmpty = el("ladderEmpty");
const lanes = el("lanes");
const runwaySelect = el("runwayConfig");
const timeToggle = el("timeToggle");
const zoomInput = el("zoom");

let useLocal = false;
let lastParams = null;
let lastResult = null;
let refreshTimer = null;
let minutesVisible = Number(zoomInput.value); // fenetre de temps visible sur la frise
const LOOKBACK_MIN = 5; // marge avant "maintenant", pour garder un peu de contexte passe

// Connexion Aurora centralisee dans la fenetre de base : ici on n'affiche
// que l'etat, en lecture seule.
window.aman.onStatus((s) => {
  el("dot").dataset.state = s.state;
  const labels = { idle: "Hors ligne", connecting: "Connexion…", connected: "Connecté", error: "Erreur" };
  el("state").textContent = labels[s.state] || s.state;
});

const mode = new URLSearchParams(location.search).get("mode") || "undocked";
if (mode !== "docked") {
  el("dock").hidden = false;
  el("dock").addEventListener("click", () => window.aman.dock());
}

timeToggle.addEventListener("click", () => {
  useLocal = !useLocal;
  timeToggle.textContent = useLocal ? "Local" : "UTC";
  if (lastResult) render(lastResult);
});

zoomInput.addEventListener("input", () => {
  minutesVisible = Number(zoomInput.value);
  if (lastResult) render(lastResult);
});

el("airport").addEventListener("change", loadRunwayConfigs);
el("airport").addEventListener("blur", loadRunwayConfigs);

async function loadRunwayConfigs() {
  const airport = el("airport").value.trim().toUpperCase();
  runwaySelect.innerHTML = "";
  if (!airport) {
    runwaySelect.append(new Option("—", ""));
    return;
  }
  const { runwayConfigs } = await window.aman.getConfig(airport);
  if (!runwayConfigs || !runwayConfigs.length) {
    runwaySelect.append(new Option("aucune config connue", ""));
    return;
  }
  runwayConfigs.forEach((c) => runwaySelect.append(new Option(c, c)));
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  refresh();
});

async function refresh() {
  const airport = el("airport").value.trim().toUpperCase();
  const runwayConfig = runwaySelect.value;
  if (!airport) {
    showEmpty("Renseigne un aéroport.");
    return;
  }
  lastParams = { airport, runwayConfig };
  lastResult = await window.aman.compute(lastParams);
  render(lastResult);

  clearInterval(refreshTimer);
  refreshTimer = setInterval(async () => {
    if (!lastParams) return;
    lastResult = await window.aman.compute(lastParams);
    render(lastResult);
  }, 8000);
}

function showEmpty(text) {
  lanes.hidden = true;
  lanes.innerHTML = "";
  ladderEmpty.hidden = false;
  ladderEmpty.textContent = text;
}

// etaSeconds/staSeconds sont de vraies secondes epoch (calculees cote
// moteur) — jamais de reformatage approximatif d'une chaine HHMM ici.
function formatTime(seconds) {
  if (seconds == null) return "—";
  const d = new Date(seconds * 1000);
  return useLocal
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : `${d.toISOString().slice(11, 16)}Z`;
}

function formatDelay(ttlSeconds) {
  const m = Math.round(ttlSeconds / 60);
  if (m <= 0) return "0";
  return `+${m}`;
}

function render(r) {
  if (r.error) {
    showEmpty(r.error);
    return;
  }

  const anyAircraft = (r.sequence || []).length > 0;
  if (!anyAircraft) {
    showEmpty("Aucun trafic IFR en approche pour l'instant sur cette piste.");
    return;
  }

  ladderEmpty.hidden = true;
  lanes.hidden = false;
  lanes.innerHTML = "";

  const nowSec = Date.now() / 1000;
  const windowStart = nowSec - LOOKBACK_MIN * 60;

  const laneEls = [];
  (r.gates || []).forEach((g) => laneEls.push(buildLane(g.gate, g.sequence, "eta")));
  laneEls.push(buildLane(`Piste ${r.runwayConfig}`, r.sequence, "sta", true));
  laneEls.forEach((l) => lanes.append(l.root));

  // La hauteur n'est connue qu'une fois les colonnes dans le DOM (flex) —
  // toutes les colonnes partagent la meme hauteur, une seule mesure suffit.
  const bodyHeight = laneEls[0].body.clientHeight || 1;
  const pxPerMinute = bodyHeight / minutesVisible;
  const timeToY = (seconds) => ((seconds - windowStart) / 60) * pxPerMinute;

  laneEls.forEach((l) => fillLane(l, timeToY, bodyHeight));
}

function buildLane(title, sequence, timeField, isFinal) {
  const root = document.createElement("div");
  root.className = "lane" + (isFinal ? " lane-final" : "");

  const head = document.createElement("div");
  head.className = "lane-head";
  head.textContent = title;

  const body = document.createElement("div");
  body.className = "lane-body";

  root.append(head, body);
  return { root, body, sequence, timeField, isFinal };
}

const ROW_H = 22; // hauteur d'une etiquette + marge, pour l'empilage anti-chevauchement
const RULER_W = 46;
const LABEL_X = 62; // bord gauche des etiquettes (voir .ac-row dans aman.css)

function fillLane({ body, sequence, timeField, isFinal }, timeToY, bodyHeight) {
  const nowSec = Date.now() / 1000;
  const windowStart = nowSec - LOOKBACK_MIN * 60;

  const ruler = document.createElement("div");
  ruler.className = "ruler";
  body.append(ruler);

  // Graduations toutes les 5 minutes sur la fenetre visible.
  const firstTick = Math.ceil(windowStart / 300) * 300;
  for (let t = firstTick; t <= windowStart + minutesVisible * 60; t += 300) {
    const y = timeToY(t);
    if (y < 0 || y > bodyHeight) continue;
    const tick = document.createElement("div");
    tick.className = "tick";
    tick.style.top = `${y}px`;
    const label = document.createElement("span");
    label.className = "tick-label";
    label.textContent = formatTime(t);
    tick.append(label);
    body.append(tick);
  }

  const nowLine = document.createElement("div");
  nowLine.className = "now-line";
  nowLine.style.top = `${timeToY(nowSec)}px`;
  body.append(nowLine);

  // Empilage : les etiquettes suivent l'ordre temporel mais sont poussees
  // vers le bas si elles chevaucheraient la precedente. Le trait de rappel
  // relie chaque etiquette a sa position temporelle exacte sur la regle.
  const visible = sequence
    .map((ac) => ({ ac, timeY: timeToY(timeField === "sta" ? ac.staSeconds : ac.etaSeconds) }))
    .filter(({ timeY }) => timeY >= -10 && timeY <= bodyHeight + 10)
    .sort((a, b) => a.timeY - b.timeY);

  let prevLabelY = -Infinity;
  for (const item of visible) {
    item.labelY = Math.max(item.timeY, prevLabelY + ROW_H);
    prevLabelY = item.labelY;
  }

  for (const { ac, timeY, labelY } of visible) {
    // Point sur la regle a l'heure exacte.
    const dot = document.createElement("div");
    dot.className = "leader-dot";
    dot.style.top = `${timeY}px`;
    body.append(dot);

    // Trait de rappel incline entre la regle et l'etiquette.
    const dx = LABEL_X - RULER_W;
    const dy = labelY - timeY;
    const len = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);
    const leader = document.createElement("div");
    leader.className = "leader";
    leader.style.top = `${timeY}px`;
    leader.style.width = `${len}px`;
    leader.style.transform = `rotate(${angle}rad)`;
    body.append(leader);

    const row = document.createElement("div");
    row.className = "ac-row";
    if (ac.status) row.dataset.status = ac.status;
    row.style.top = `${labelY}px`;

    row.append(span("pos", ac.position), span("callsign", ac.callsign), span("wake", ac.wake));
    if (isFinal) {
      row.append(span("time", `${formatDelay(ac.ttlSeconds)} ${formatTime(ac.staSeconds)}`));
    } else {
      row.append(span("time", formatTime(ac.etaSeconds)));
    }
    body.append(row);
  }
}

function span(cls, text) {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}
