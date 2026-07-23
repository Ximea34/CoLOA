// aman-renderer.js — formulaire + timeline AMAN.
// Interroge aman:compute a la demande (bouton) puis toutes les 8s tant que la
// fenetre reste ouverte sur les memes parametres.

const el = (id) => document.getElementById(id);
const form = el("form");
const result = el("result");
const runwaySelect = el("runwayConfig");
const timeToggle = el("timeToggle");

let useLocal = false;
let lastParams = null;
let lastResult = null;
let refreshTimer = null;
let connected = false;

// Connexion Aurora : memes canaux IPC que la fenetre Assistant LoA — l'AMAN
// peut etre lance seul depuis l'ecran de lancement, sans jamais ouvrir
// l'autre fenetre, donc il lui faut son propre controle de connexion.
el("connect").addEventListener("click", () => {
  connected ? window.aman.disconnect() : window.aman.connect();
});

window.aman.onStatus((s) => {
  connected = s.state === "connected";
  el("connect").textContent = connected ? "Déconnecter" : "Connect to Aurora";
  el("connect").dataset.on = String(connected);
  el("dot").dataset.state = s.state;
  const labels = { idle: "Hors ligne", connecting: "Connexion…", connected: "Connecté", error: "Erreur" };
  el("state").textContent = labels[s.state] || s.state;
});

timeToggle.addEventListener("click", () => {
  useLocal = !useLocal;
  timeToggle.textContent = useLocal ? "Local" : "UTC";
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
  result.innerHTML = "";
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = text;
  result.append(p);
}

// L'ETO/STA Aurora est en HHMM UTC. En mode local, on ne convertit que
// l'affichage — jamais la donnee elle-meme.
function formatTime(hhmm) {
  if (!hhmm) return "—";
  if (!useLocal) return `${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}Z`;
  const h = Number(hhmm.slice(0, 2));
  const m = Number(hhmm.slice(2, 4));
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatTtl(sec) {
  const sign = sec > 0 ? "+" : sec < 0 ? "−" : "";
  const abs = Math.abs(sec);
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  return `${sign}${m}:${String(s).padStart(2, "0")}`;
}

function cell(text) {
  const c = document.createElement("span");
  c.textContent = text;
  return c;
}

function render(r) {
  result.innerHTML = "";

  if (r.error) {
    showEmpty(r.error);
    return;
  }

  const anyAircraft = (r.gates || []).some((g) => g.sequence.length);
  if (!anyAircraft) {
    showEmpty("Aucun trafic assumé en approche pour l'instant sur cette porte/config.");
    return;
  }

  r.gates.forEach((g) => {
    if (!g.sequence.length) return;

    const section = document.createElement("div");
    section.className = "gate";

    const h = document.createElement("div");
    h.className = "gate-title";
    h.textContent = `Porte ${g.gate}`;
    section.append(h);

    const table = document.createElement("div");
    table.className = "gate-table";

    const head = document.createElement("div");
    head.className = "gate-row gate-head";
    ["#", "Indicatif", "WTC", "ETO", "STA", "TTL/TTG"].forEach((t) => head.append(cell(t)));
    table.append(head);

    g.sequence.forEach((ac) => {
      const row = document.createElement("div");
      row.className = "gate-row";
      row.dataset.status = ac.status;
      row.append(
        cell(ac.position),
        cell(ac.callsign),
        cell(ac.wake),
        cell(formatTime(ac.eto)),
        cell(formatTime(ac.sta)),
        cell(formatTtl(ac.ttlSeconds))
      );
      table.append(row);
    });

    section.append(table);
    result.append(section);
  });
}
