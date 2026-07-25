// manuel-renderer.js — formulaire de consultation manuelle (hors ligne).
// Pas d'avion reel : le resultat vient de evaluate() sur un plan de vol
// fabrique a la main, cote main.js.

const el = (id) => document.getElementById(id);
const form = el("form");
const result = el("result");

const mode = new URLSearchParams(location.search).get("mode") || "undocked";
if (mode !== "docked") {
  el("dock").hidden = false;
  el("dock").addEventListener("click", () => window.manuel.dock());
}

let sector = "LFMM_W";

function setSector(s) {
  sector = s;
  el("secW").classList.toggle("active", s === "LFMM_W");
  el("secE").classList.toggle("active", s === "LFMM_E");
}
el("secW").addEventListener("click", () => setSector("LFMM_W"));
el("secE").addEventListener("click", () => setSector("LFMM_E"));
setSector("LFMM_W");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const dep = el("dep").value.trim().toUpperCase();
  const arr = el("arr").value.trim().toUpperCase();
  const waypoint = el("waypoint").value.trim().toUpperCase();

  if (!dep || !arr) {
    showEmpty("Départ et arrivée sont obligatoires.");
    return;
  }

  const r = await window.manuel.evaluate({ dep, arr, waypoint, sector });
  render(r);
});

function showEmpty(text) {
  result.innerHTML = "";
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = text;
  result.append(p);
}

function fieldLine(label, value, accent) {
  const row = document.createElement("div");
  row.className = "field-line";
  const l = document.createElement("span");
  l.className = "field-label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = "field-value" + (accent ? " accent" : "");
  v.textContent = value;
  row.append(l, v);
  return row;
}

function block(title, items, bad) {
  const div = document.createElement("div");
  div.className = "block" + (bad ? " bad" : "");
  const h = document.createElement("div");
  h.className = "block-title";
  h.textContent = title;
  div.append(h);
  items.forEach((text) => {
    const p = document.createElement("p");
    p.textContent = text;
    div.append(p);
  });
  return div;
}

function render(r) {
  result.innerHTML = "";

  if (!r.matched) {
    const card = document.createElement("div");
    card.className = "card none";
    card.append(fieldLine("Résultat", r.message));
    if (r.hint) {
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = r.hint;
      card.append(hint);
    }
    result.append(card);
    return;
  }

  const card = document.createElement("div");
  card.className = "card " + (r.warnings.length ? "err" : r.pointUnverified ? "warn" : "ok");
  card.append(
    fieldLine("Règle", `${r.ruleId} (${r.ref})`),
    fieldLine("Niveau", r.transferLevel, true),
    fieldLine("Point de transfert", r.pointUnverified ? "non identifié" : (r.transferPoint || "—")),
    fieldLine("STAR", r.star || "—"),
    fieldLine("Next ATC", r.nextStation)
  );
  if (r.conditions.length) card.append(block("Conditions", r.conditions));
  if (r.warnings.length) card.append(block("Avertissements", r.warnings, true));
  if (r.alternatives.length) card.append(block("Alternatives", r.alternatives));
  result.append(card);

  const note = document.createElement("p");
  note.className = "note";
  note.textContent =
    "Mode manuel : indique uniquement la règle applicable pour ce trajet, sans vérification d'un label Aurora réel.";
  result.append(note);
}
