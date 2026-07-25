// sim-renderer.js — carte de placement + formulaire d'edition du simulateur.
// Carte simple (pas de tuiles) : projection locale centree sur les points de
// la config chargee, aucune dependance internet.

const el = (id) => document.getElementById(id);
const loadForm = el("loadForm");
const runwaySelect = el("runwayConfig");
const svg = el("map");
const mapEmpty = el("mapEmpty");
const acForm = el("acForm");
const listEl = el("list");

const SIZE = 600;
let projection = null; // { toXY, toLatLon }
let currentAirport = null;
let editingCallsign = null; // null = mode "ajout"
let refreshTimer = null;
let activeTab = "placement";
let debugRefreshTimer = null;
let debugSelected = null; // indicatif suivi dans l'onglet Debug ETA

const mode = new URLSearchParams(location.search).get("mode") || "undocked";
if (mode !== "docked") {
  el("dock").hidden = false;
  el("dock").addEventListener("click", () => window.sim.dock());
}

el("airport").addEventListener("change", loadRunwayConfigs);

el("timeScale").addEventListener("change", () => {
  window.sim.setTimeScale(Number(el("timeScale").value));
});

document.querySelectorAll(".sim-tab").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".sim-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  el("placementPanel").hidden = tab !== "placement";
  el("debugPanel").hidden = tab !== "debug";

  clearInterval(refreshTimer);
  clearInterval(debugRefreshTimer);
  clearDebugOverlay();
  clearPlacementMarkers(); // efface les marqueurs de l'autre onglet, sinon ils restent figes a l'ecran

  if (tab === "placement") {
    if (projection) { refreshTimer = setInterval(refreshList, 2000); refreshList(); }
  } else {
    if (projection) { debugRefreshTimer = setInterval(refreshDebug, 2000); refreshDebug(); }
  }
}

async function loadRunwayConfigs() {
  const airport = el("airport").value.trim().toUpperCase();
  runwaySelect.innerHTML = "";
  if (!airport) { runwaySelect.append(new Option("—", "")); return; }
  const { transitions } = await window.sim.getPoints(airport);
  const configs = Object.keys(transitions || {});
  if (!configs.length) { runwaySelect.append(new Option("aucune config connue", "")); return; }
  configs.forEach((c) => runwaySelect.append(new Option(c, c)));
}

loadForm.addEventListener("submit", (e) => {
  e.preventDefault();
  loadAirport();
});

async function loadAirport() {
  const airport = el("airport").value.trim().toUpperCase();
  const runwayConfig = runwaySelect.value;
  if (!airport) return;

  const { points, transitions } = await window.sim.getPoints(airport);
  const names = Object.keys(points || {});
  if (!names.length) {
    mapEmpty.hidden = false;
    mapEmpty.textContent = `Aucun point configure pour ${airport}.`;
    svg.innerHTML = "";
    return;
  }

  currentAirport = airport;
  projection = buildProjection(names.map((n) => points[n]));
  drawReference(points, transitions);
  mapEmpty.hidden = true;

  const gates = runwayConfig ? await window.sim.getGates(airport, runwayConfig) : [];
  const gateSelect = el("acGate");
  gateSelect.innerHTML = "";
  gates.forEach((g) => gateSelect.append(new Option(g, g)));

  switchTab(activeTab);
}

function buildProjection(points) {
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const latMin = Math.min(...lats), latMax = Math.max(...lats);
  const lonMin = Math.min(...lons), lonMax = Math.max(...lons);
  const centerLat = (latMin + latMax) / 2;
  const centerLon = (lonMin + lonMax) / 2;
  const cos = Math.cos((centerLat * Math.PI) / 180);

  const latSpanNm = (latMax - latMin) * 60 || 10;
  const lonSpanNm = (lonMax - lonMin) * 60 * cos || 10;
  const maxSpanNm = Math.max(latSpanNm, lonSpanNm) * 1.3; // marge
  const scale = SIZE / maxSpanNm; // px / NM

  function toXY(lat, lon) {
    const dLatNm = (lat - centerLat) * 60;
    const dLonNm = (lon - centerLon) * 60 * cos;
    return { x: SIZE / 2 + dLonNm * scale, y: SIZE / 2 - dLatNm * scale };
  }
  function toLatLon(x, y) {
    const dLonNm = (x - SIZE / 2) / scale;
    const dLatNm = (SIZE / 2 - y) / scale;
    return { lat: centerLat + dLatNm / 60, lon: centerLon + dLonNm / (60 * cos) };
  }
  return { toXY, toLatLon };
}

function drawReference(points, transitions) {
  svg.innerHTML = "";
  const ns = "http://www.w3.org/2000/svg";

  // Grille (repere visuel, pas de graduation precise necessaire ici).
  for (let i = 0; i <= SIZE; i += SIZE / 10) {
    const h = document.createElementNS(ns, "line");
    h.setAttribute("class", "grid-line");
    h.setAttribute("x1", 0); h.setAttribute("x2", SIZE); h.setAttribute("y1", i); h.setAttribute("y2", i);
    svg.append(h);
    const v = document.createElementNS(ns, "line");
    v.setAttribute("class", "grid-line");
    v.setAttribute("x1", i); v.setAttribute("x2", i); v.setAttribute("y1", 0); v.setAttribute("y2", SIZE);
    svg.append(v);
  }

  // Lignes des transitions (porte -> ... -> seuil), pour se reperer visuellement.
  for (const gates of Object.values(transitions || {})) {
    for (const names of Object.values(gates)) {
      const coords = names.map((n) => points[n]).filter(Boolean).map((p) => projection.toXY(p.lat, p.lon));
      if (coords.length < 2) continue;
      const poly = document.createElementNS(ns, "polyline");
      poly.setAttribute("class", "ref-line");
      poly.setAttribute("points", coords.map((c) => `${c.x},${c.y}`).join(" "));
      svg.append(poly);
    }
  }

  // Points nommes (portes, IF, seuils...).
  for (const [name, p] of Object.entries(points)) {
    const { x, y } = projection.toXY(p.lat, p.lon);
    const g = document.createElementNS(ns, "g");
    g.setAttribute("class", "ref-point");
    const c = document.createElementNS(ns, "circle");
    c.setAttribute("cx", x); c.setAttribute("cy", y); c.setAttribute("r", 3);
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", x + 5); t.setAttribute("y", y - 5);
    t.textContent = name;
    g.append(c, t);
    svg.append(g);
  }

  svg.addEventListener("click", onMapClick);
}

function onMapClick(e) {
  if (activeTab !== "placement") return; // pas de placement en mode debug
  if (e.target.closest(".ac-marker")) return; // gere par le marqueur lui-meme
  if (!projection) return;
  const rect = svg.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * SIZE;
  const y = ((e.clientY - rect.top) / rect.height) * SIZE;
  const { lat, lon } = projection.toLatLon(x, y);
  openForm(null, { lat, lon });
}

function openForm(callsign, defaults) {
  editingCallsign = callsign;
  acForm.hidden = false;
  el("acFormTitle").textContent = callsign ? `Modifier ${callsign}` : "Nouvel avion";
  el("acCallsign").value = defaults?.callsign || "";
  el("acCallsign").disabled = !!callsign; // pas de renommage, plus simple
  el("acDep").value = defaults?.dep || "";
  el("acArr").value = defaults?.arr || currentAirport || "";
  el("acWake").value = defaults?.wake || "M";
  if (defaults?.gate) el("acGate").value = defaults.gate;
  el("acTrack").value = defaults?.track ?? 0;
  el("acSpeed").value = defaults?.groundSpeed ?? 220;
  el("acAlt").value = defaults?.altitude ?? 4000;
  el("acSave").textContent = callsign ? "Enregistrer" : "Ajouter";
  el("acDelete").hidden = !callsign;
  acForm.dataset.lat = defaults?.lat;
  acForm.dataset.lon = defaults?.lon;

  // Le pilotage automatique (procedure/ILS) n'a de sens que sur un avion deja
  // place — pas dans le formulaire d'ajout, ou la porte n'est pas encore
  // enregistree cote main.js.
  el("acNav").hidden = !callsign;
  el("acNavMode").textContent = NAV_LABELS[defaults?.navMode] || "manuel";
}

const NAV_LABELS = { manual: "manuel", procedure: "suit la procédure", ils: "établi sur l'ILS" };

el("acCancel").addEventListener("click", () => { acForm.hidden = true; });

acForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const patch = {
    dep: el("acDep").value.trim().toUpperCase(),
    arr: el("acArr").value.trim().toUpperCase(),
    wake: el("acWake").value,
    gate: el("acGate").value,
    runwayConfig: runwaySelect.value,
    track: Number(el("acTrack").value) || 0,
    groundSpeed: Number(el("acSpeed").value) || 0,
    altitude: Number(el("acAlt").value) || 0,
  };

  if (editingCallsign) {
    await window.sim.update(editingCallsign, patch);
  } else {
    const callsign = el("acCallsign").value.trim().toUpperCase();
    if (!callsign) return;
    await window.sim.add({ ...patch, callsign, lat: Number(acForm.dataset.lat), lon: Number(acForm.dataset.lon) });
  }
  acForm.hidden = true;
  refreshList();
});

el("acDelete").addEventListener("click", async () => {
  if (!editingCallsign) return;
  await window.sim.remove(editingCallsign);
  acForm.hidden = true;
  refreshList();
});

el("acFollow").addEventListener("click", async () => {
  if (!editingCallsign) return;
  await window.sim.followProcedure(editingCallsign);
  acForm.hidden = true;
  refreshList();
});

el("acIls").addEventListener("click", async () => {
  if (!editingCallsign) return;
  await window.sim.captureIls(editingCallsign);
  acForm.hidden = true;
  refreshList();
});

async function refreshList() {
  if (!projection) return;
  const list = await window.sim.list();

  svg.querySelectorAll(".ac-marker").forEach((n) => n.remove());
  const ns = "http://www.w3.org/2000/svg";
  for (const ac of list) {
    const { x, y } = projection.toXY(ac.lat, ac.lon);
    const g = document.createElementNS(ns, "g");
    g.setAttribute("class", "ac-marker");
    g.setAttribute("transform", `translate(${x},${y})`);
    const tri = document.createElementNS(ns, "polygon");
    tri.setAttribute("points", "0,-7 5,6 -5,6");
    tri.setAttribute("transform", `rotate(${ac.track})`);
    const label = document.createElementNS(ns, "text");
    label.setAttribute("x", 8); label.setAttribute("y", 4);
    label.textContent = ac.callsign;
    g.append(tri, label);
    g.addEventListener("click", (e) => { e.stopPropagation(); openForm(ac.callsign, ac); });
    svg.append(g);
  }

  if (!list.length) {
    listEl.innerHTML = "";
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Aucun avion simulé.";
    listEl.append(p);
    return;
  }

  listEl.innerHTML = "";
  list.forEach((ac) => {
    const row = document.createElement("div");
    row.className = "sim-ac-row";
    row.innerHTML = `
      <span class="cs">${ac.callsign}</span>
      <span class="meta">${ac.dep || "?"} → ${ac.arr || "?"} · ${ac.wake} · porte ${ac.gate}</span>
      <span class="meta">${ac.track.toFixed(0)}° · ${ac.groundSpeed}kt · ${ac.altitude}ft</span>
      <span class="meta">${NAV_LABELS[ac.navMode] || "manuel"}</span>
    `;
    row.addEventListener("click", () => openForm(ac.callsign, ac));
    listEl.append(row);
  });
}

// --- onglet Debug ETA --------------------------------------------------------
// Montre, pour un avion suivi par l'AMAN (reel ou simule), la transition
// qui lui est assignee, le point vise, et — en guidage — la projection de
// cap utilisee pour le calcul, en plus de la trace textuelle deja loguee
// dans la fenetre Debug generale.

const debugAcSelect = el("debugAcSelect");
const debugEmpty = el("debugEmpty");
const debugTrace = el("debugTrace");

debugAcSelect.addEventListener("change", () => {
  debugSelected = debugAcSelect.value || null;
  drawDebugOverlay(lastDebugSequence);
});

let lastDebugSequence = [];

async function refreshDebug() {
  if (!projection || !currentAirport) return;
  const runwayConfig = runwaySelect.value;
  if (!runwayConfig) return;
  const result = await window.sim.compute({ airport: currentAirport, runwayConfig });
  lastDebugSequence = result.sequence || [];

  const previousValue = debugAcSelect.value;
  debugAcSelect.innerHTML = "";
  debugAcSelect.append(new Option("—", ""));
  lastDebugSequence.forEach((ac) => debugAcSelect.append(new Option(`${ac.callsign} (${ac.mode})`, ac.callsign)));
  if (lastDebugSequence.some((ac) => ac.callsign === previousValue)) debugAcSelect.value = previousValue;
  else debugSelected = null;

  drawDebugOverlay(lastDebugSequence);
}

function clearDebugOverlay() {
  svg.querySelectorAll(
    ".debug-transition-line, .debug-crossing-line, .debug-target-point, .debug-ac-marker"
  ).forEach((n) => n.remove());
}

function clearPlacementMarkers() {
  svg.querySelectorAll(".ac-marker").forEach((n) => n.remove());
}

function drawDebugOverlay(sequence) {
  clearDebugOverlay();
  if (!projection) return;

  const ac = sequence.find((a) => a.callsign === debugSelected);
  if (!ac) {
    debugEmpty.hidden = false;
    debugEmpty.textContent = sequence.length
      ? "Sélectionne un avion dans la liste pour voir sa trajectoire."
      : "Aucun avion suivi par l'AMAN pour cet aéroport/config piste.";
    debugTrace.hidden = true;
    return;
  }
  debugEmpty.hidden = true;

  const ns = "http://www.w3.org/2000/svg";
  const geo = ac.geo;

  // Transition assignee, point vise mis en avant.
  const transCoords = geo.points.map((p) => projection.toXY(p.lat, p.lon));
  const transLine = document.createElementNS(ns, "polyline");
  transLine.setAttribute("class", "debug-transition-line");
  transLine.setAttribute("points", transCoords.map((c) => `${c.x},${c.y}`).join(" "));
  svg.append(transLine);

  const targetXY = transCoords[geo.index];
  const target = document.createElementNS(ns, "circle");
  target.setAttribute("class", "debug-target-point");
  target.setAttribute("data-mode", ac.mode);
  target.setAttribute("cx", targetXY.x); target.setAttribute("cy", targetXY.y); target.setAttribute("r", 5);
  svg.append(target);

  // Ligne testee pour la prochaine progression (perpendiculaire au tronçon
  // en cours) — montre precisement ce qui determine l'avancement de
  // l'index, que l'avion soit sur la procedure ou vectorise.
  if (geo.crossingLine) {
    const lineCoords = geo.crossingLine.map((p) => projection.toXY(p.lat, p.lon));
    const crossingLine = document.createElementNS(ns, "line");
    crossingLine.setAttribute("class", "debug-crossing-line");
    crossingLine.setAttribute("x1", lineCoords[0].x); crossingLine.setAttribute("y1", lineCoords[0].y);
    crossingLine.setAttribute("x2", lineCoords[1].x); crossingLine.setAttribute("y2", lineCoords[1].y);
    svg.append(crossingLine);
  }

  // Position reelle de l'avion suivi.
  const acXY = projection.toXY(geo.pos.lat, geo.pos.lon);
  const marker = document.createElementNS(ns, "g");
  marker.setAttribute("class", "debug-ac-marker");
  marker.setAttribute("transform", `translate(${acXY.x},${acXY.y})`);
  const tri = document.createElementNS(ns, "polygon");
  tri.setAttribute("points", "0,-7 5,6 -5,6");
  const label = document.createElementNS(ns, "text");
  label.setAttribute("x", 8); label.setAttribute("y", 4);
  label.textContent = ac.callsign;
  marker.append(tri, label);
  svg.append(marker);

  debugTrace.hidden = false;
  debugTrace.textContent = (ac.trace || []).join("\n");
}
