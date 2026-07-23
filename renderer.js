// renderer.js — n'a aucune connaissance du protocole ni des LOA.
// Il recoit des lignes deja evaluees et les affiche.

const el = (id) => document.getElementById(id);
const rows = el("rows");
const MAX_ROWS = 60;

let connected = false;

// --- barre de titre et etat -------------------------------------------------

el("connect").addEventListener("click", () => {
  connected ? window.loa.disconnect() : window.loa.connect();
});
el("min").addEventListener("click", () => window.loa.window("minimize"));
el("max").addEventListener("click", () => window.loa.window("maximize"));
el("close").addEventListener("click", () => window.loa.window("close"));
el("clear").addEventListener("click", () => {
  rows.innerHTML = "";
  showEmpty("Historique vidé. Sélectionne un avion dans Aurora.");
});
el("debug").addEventListener("click", () => window.loa.openDebug());

window.loa.onStatus((s) => {
  el("dot").dataset.state = s.state;
  connected = s.state === "connected";

  el("connect").textContent = connected ? "Déconnecter" : "Connect to Aurora";
  el("connect").dataset.on = String(connected);
  el("station").textContent = connected ? s.station : "";
  el("sector").textContent = connected ? s.station : "";

  const labels = {
    idle: "Hors ligne",
    connecting: "Connexion…",
    connected: "Connecté",
    error: "Erreur",
  };
  el("state").textContent = labels[s.state] || s.state;

  const banner = el("banner");
  if (s.state === "error" && s.message) {
    banner.textContent = s.message;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }

  if (connected) showEmpty("Sélectionne un avion dans Aurora.");
});

window.loa.onTrouble((d) => {
  const banner = el("banner");
  banner.textContent = d.message;
  banner.hidden = false;
});

// Une erreur dans la fenetre elle-meme ne doit pas rester invisible.
window.onerror = (msg, src, line) => {
  const banner = el("banner");
  banner.textContent = `Erreur interface : ${msg} (${src}:${line})`;
  banner.hidden = false;
};

window.loa.onSelection((d) => {
  el("sel").textContent = d.callsign ? `Sélection : ${d.callsign}` : "Aucune sélection";
});

window.loa.onAtc((d) => {
  el("atc").textContent = d.count ? `${d.count} ATC en ligne` : "Liste ATC indisponible";
});

// --- lignes -----------------------------------------------------------------

window.loa.onRow(({ row, mode }) => {
  const existing = rows.querySelector(`[data-cs="${cssEscape(row.callsign)}"]`);

  if (mode === "update" && existing) {
    existing.replaceWith(buildRow(row, false));
    return;
  }

  clearEmpty();
  rows.prepend(buildRow(row, true));
  while (rows.children.length > MAX_ROWS) rows.lastElementChild.remove();
});

function buildRow(r, fresh) {
  const node = document.createElement("div");
  node.className = "row" + (fresh ? " fresh" : "");
  node.dataset.cs = r.callsign;
  node.dataset.state = state(r);

  const line = document.createElement("div");
  line.className = "line";

  if (!r.matched) {
    line.append(
      cell("callsign", r.callsign),
      cell("xfl", "Hors LoA", true),
      cell("point", "—"),
      cell("next", "—")
    );
    node.append(line, notes([r.message], []));
    return node;
  }

  const point = cell("point", r.pointUnverified ? "— (non identifie)" : r.transferPoint, r.pointUnverified);
  if (r.eto) point.append(sub(r.eto));

  line.append(
    cell("callsign", r.callsign),
    cell("xfl", r.transferLevel, /coordination|requis|Non defini/i.test(r.transferLevel)),
    point,
    cell("next", r.nextStation)
  );

  node.append(line, notes(r.conditions, r.warnings));
  return node;
}

function state(r) {
  if (!r.matched) return "none";
  if (r.warnings && r.warnings.length) return "err";
  if (r.labelCheck === "empty" || r.pointUnverified) return "warn";
  return "ok";
}

function cell(cls, text, soft) {
  const s = document.createElement("div");
  s.className = cls;
  s.textContent = text;
  if (soft) s.dataset.soft = "true";
  return s;
}

function sub(text) {
  const s = document.createElement("span");
  s.className = "sub";
  s.textContent = text;
  return s;
}

function notes(conditions, warnings) {
  const box = document.createElement("div");
  box.className = "notes";
  const parts = [];

  (warnings || []).forEach((w) => parts.push({ text: w, cls: "bad" }));
  (conditions || []).forEach((c) => {
    const alert = /vide|indicatif|non assum/i.test(c);
    parts.push({ text: c, cls: alert ? "alert" : "" });
  });

  if (!parts.length) { box.hidden = true; return box; }

  parts.forEach((p, i) => {
    if (i) box.append(document.createTextNode("  ·  "));
    const span = document.createElement("span");
    span.className = p.cls;
    span.textContent = p.text;
    box.append(span);
  });
  return box;
}

// --- etat vide --------------------------------------------------------------

function showEmpty(text) {
  if (rows.querySelector(".row")) return;
  rows.innerHTML = "";
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = text;
  rows.append(p);
}

function clearEmpty() {
  const p = rows.querySelector(".empty");
  if (p) p.remove();
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}
