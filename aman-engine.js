// aman-engine.js — sequencement des arrivees (AMAN, v1 "Tier 1").
//
// Portee volontairement limitee (cf. plan) : sequence simple par porte (IAF
// derive des STAR existantes), IAF fixe par la route deposee (pas de
// reaffectation dynamique entre portes), separation approximee par
// categorie de turbulence de sillage (fp.wake, deja fourni par Aurora). Pas
// de meteo/vent, pas de performance avion reelle, pas de coordination
// inter-secteurs (OLDI/AMA) — hors scope v1 par choix explicite.
//
// Aucun acces reseau ni Aurora ici : recoit "traffic" deja resolu (meme
// forme que le cache de balayage), comme evaluate() recoit deja fp/path/pos.

const path = require("path");
const { loadRawStars } = require("./star-loader");

const RAW_STARS = loadRawStars(path.join(__dirname, "STAR"));

// Portes (IAF) pour un aeroport + une config piste : point final de chaque
// STAR dont la liste de pistes correspond a la config choisie, dedoublonne
// par point final (meme principe que resolveStarCop dans star-loader.js).
function gatesFor(airport, runwayConfig) {
  const gates = new Map(); // point final -> { entries: Set, starNames: Set }
  for (const star of RAW_STARS) {
    if (star.airport !== airport) continue;
    if (runwayConfig && !star.runways.includes(runwayConfig)) continue;

    const entry = star.fixes[0];
    const gate = star.fixes[star.fixes.length - 1];
    if (!entry || !gate || entry === gate) continue;

    if (!gates.has(gate)) gates.set(gate, { entries: new Set(), starNames: new Set() });
    gates.get(gate).entries.add(entry);
    gates.get(gate).starNames.add(star.name);
  }
  return gates;
}

// ETO au format Aurora "HHMM" (ex. "1425") -> secondes depuis minuit UTC.
function etoToSeconds(eto) {
  const s = String(eto).padStart(4, "0");
  const h = Number(s.slice(0, 2));
  const m = Number(s.slice(2, 4));
  return h * 3600 + m * 60;
}

function secondsToEto(totalSeconds) {
  const s = ((totalSeconds % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}${String(m).padStart(2, "0")}`;
}

function separationSeconds(config, leaderWake, followerWake) {
  const minutes =
    config?.separationMinutes?.[leaderWake]?.[followerWake] ??
    config?.defaultSeparationMinutes ??
    3;
  return minutes * 60;
}

// Statut 3 couleurs sur le TTL (Time To Lose) : vert quasi a l'heure, jaune
// retard modere, rouge retard significatif. Seuils simples pour la v1.
function statusFor(ttlSeconds) {
  if (ttlSeconds <= 30) return "ok";
  if (ttlSeconds <= 180) return "warn";
  return "err";
}

// traffic : tableau [{ callsign, fp: {arr, wake, ...}, path: [{fix, eto}] }]
// — meme forme que le cache de balayage (main.js), un indicatif = une entree.
function computeSequence({ airport, runwayConfig, traffic, config }) {
  const gates = gatesFor(airport, runwayConfig);
  if (!gates.size) {
    return {
      airport,
      runwayConfig,
      gates: [],
      error: `Aucune porte connue pour ${airport} (config ${runwayConfig || "?"}) dans les fichiers STAR.`,
    };
  }

  const perGate = new Map([...gates.keys()].map((g) => [g, []]));

  for (const ac of traffic || []) {
    if (!ac.fp || ac.fp.arr !== airport) continue;
    if (ac.fp.rules !== "I") continue; // AMAN v1 : IFR uniquement, quel que soit l'assumed
    const fixes = (ac.path || []).map((p) => (typeof p === "string" ? p : p.fix));

    for (const gate of gates.keys()) {
      const idx = fixes.indexOf(gate);
      if (idx === -1) continue;
      const eto = ac.path[idx]?.eto;
      if (!eto) continue; // pas encore d'heure estimee calculee par Aurora
      perGate.get(gate).push({ callsign: ac.callsign, wake: ac.fp.wake || "M", eto });
      break; // un avion n'est rattache qu'a UNE porte : celle de sa propre route
    }
  }

  const result = [];
  for (const [gate, list] of perGate) {
    list.sort((a, b) => etoToSeconds(a.eto) - etoToSeconds(b.eto));

    // STA en cascade : le retard d'un avion se propage aux suivants, pas
    // seulement une comparaison de paires adjacentes.
    let prevSta = null;
    let prevWake = null;
    const sequence = list.map((ac, i) => {
      const etoSec = etoToSeconds(ac.eto);
      const minSta = prevSta !== null ? prevSta + separationSeconds(config, prevWake, ac.wake) : etoSec;
      const sta = Math.max(etoSec, minSta);
      const ttlSeconds = sta - etoSec;
      prevSta = sta;
      prevWake = ac.wake;
      return {
        position: i + 1,
        callsign: ac.callsign,
        wake: ac.wake,
        eto: ac.eto,
        sta: secondsToEto(sta),
        ttlSeconds,
        status: statusFor(ttlSeconds),
      };
    });

    result.push({ gate, sequence });
  }

  return { airport, runwayConfig, gates: result, error: null };
}

module.exports = { computeSequence, gatesFor, etoToSeconds, secondsToEto };
