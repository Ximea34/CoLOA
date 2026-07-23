// aman-engine.js — sequencement des arrivees (AMAN).
//
// L'ETA au seuil est calculee geometriquement (Haversine) le long de la
// transition configuree (porte -> seuil), pas a partir des ETO Aurora
// (#TRPATHA ne couvre pas l'approche : aucun avion n'a sa STAR/transition
// dans son plan de vol depose une fois proche du terrain). Guidage radar
// (sortie de la procedure publiee) reporte a une iteration ulterieure —
// tant qu'il n'est pas gere, un avion qui devie reste rattache a sa
// transition d'origine.
//
// Aucun acces reseau ni Aurora ici : recoit "traffic" deja resolu (fp, path,
// pos), comme evaluate() recoit deja fp/path/pos pour le moteur LOA.

const path = require("path");
const { loadRawStars } = require("./star-loader");

const RAW_STARS = loadRawStars(path.join(__dirname, "STAR"));
const EARTH_RADIUS_NM = 3440.065;

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

// Determine la porte d'un avion a partir des fixes visibles dans sa route
// restante (#TRPATHA) : la porte elle-meme si presente, sinon le point
// d'entree de la STAR qui y mene. On n'a plus besoin d'un ETO reel ici —
// seule l'identite de la porte compte, le calcul du temps se fait ensuite
// geometriquement.
function matchGate(gates, fixes) {
  for (const gate of gates.keys()) {
    if (fixes.includes(gate)) return gate;
  }
  for (const [gate, info] of gates) {
    if ([...info.entries].some((entry) => fixes.includes(entry))) return gate;
  }
  return null;
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// Distance grand cercle en NM — suffisant a l'echelle d'une approche (quelques
// dizaines de NM), pas besoin d'un modele plus precis.
function haversineNm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Resout la liste de noms de points d'une transition en objets complets
// {name, lat, lon, speedKt, radiusNm} via le dictionnaire "points" partage.
function resolveTransition(config, runwayConfig, gate) {
  const names = config?.transitions?.[runwayConfig]?.[gate];
  if (!names || !names.length) return null;
  const points = names.map((name) => {
    const p = config.points?.[name];
    return p ? { name, lat: p.lat, lon: p.lon, speedKt: p.speedKt, radiusNm: p.radiusNm ?? 1.5 } : null;
  });
  return points.every(Boolean) ? points : null;
}

// Avion jamais vu : on ne suppose pas qu'il vient d'entrer sur la transition
// (il peut deja etre bien engage dedans) — on l'ancre sur le point le plus
// proche de sa position reelle, plutot que de partir systematiquement du
// premier point (ce qui fausserait l'ETA d'un avion deja proche du seuil).
function nearestPointIndex(points, pos) {
  let best = 0;
  let bestDist = Infinity;
  points.forEach((p, i) => {
    const d = haversineNm(pos.lat, pos.lon, p.lat, p.lon);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

// Avance l'index tant que la position reelle est entree dans la zone du
// point actuellement vise (cercle de rayon radiusNm) — peut avancer de
// plusieurs points d'un coup si le rafraichissement precedent est ancien.
function advanceIndex(points, index, pos) {
  let idx = index;
  while (idx < points.length - 1) {
    const d = haversineNm(pos.lat, pos.lon, points[idx].lat, points[idx].lon);
    if (d <= (points[idx].radiusNm ?? 1.5)) idx++;
    else break;
  }
  return idx;
}

// ETA au seuil (secondes depuis maintenant) : le tronçon en cours (position
// reelle -> prochain point) utilise la vitesse sol reelle ; tous les
// tronçons suivants utilisent la vitesse prevue en config pour ce tronçon.
function etaSecondsFromNow(points, index, pos) {
  const realSpeed = pos.groundSpeed > 30 ? pos.groundSpeed : points[index].speedKt;
  let seconds = (haversineNm(pos.lat, pos.lon, points[index].lat, points[index].lon) / realSpeed) * 3600;
  for (let i = index; i < points.length - 1; i++) {
    const legNm = haversineNm(points[i].lat, points[i].lon, points[i + 1].lat, points[i + 1].lon);
    seconds += (legNm / points[i + 1].speedKt) * 3600;
  }
  return seconds;
}

function secondsToHhmm(totalSeconds) {
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

// traffic : [{ callsign, fp: {arr, wake, rules}, path: [{fix}], pos: {lat,
// lon, groundSpeed, onGround} }]. pointStates : etat persiste d'un
// rafraichissement a l'autre, { [callsign]: { key, index } } — fourni par
// l'appelant (main.js), renvoye mis a jour (fonction pure, pas de mutation
// cachee : l'appelant est responsable de le conserver entre deux appels).
function computeSequence({ airport, runwayConfig, traffic, config, pointStates, now }) {
  const gates = gatesFor(airport, runwayConfig);
  if (!gates.size) {
    return {
      airport,
      runwayConfig,
      sequence: [],
      pointStates: pointStates || {},
      error: `Aucune porte connue pour ${airport} (config ${runwayConfig || "?"}) dans les fichiers STAR.`,
    };
  }

  const nowSeconds = Math.floor((now ?? Date.now()) / 1000);
  const nextStates = {};
  const candidates = [];

  for (const ac of traffic || []) {
    if (!ac.fp || ac.fp.arr !== airport) continue;
    if (ac.fp.rules !== "I") continue; // AMAN : IFR uniquement, quel que soit l'assumed
    if (!ac.pos || ac.pos.onGround) continue; // pas de position exploitable, ou deja pose
    if (typeof ac.pos.lat !== "number" || typeof ac.pos.lon !== "number") continue;

    const fixes = (ac.path || []).map((p) => (typeof p === "string" ? p : p.fix));
    const gate = matchGate(gates, fixes);
    if (!gate) continue;

    const points = resolveTransition(config, runwayConfig, gate);
    if (!points) continue; // pas de transition configuree pour cette porte/piste

    const stateKey = `${runwayConfig}|${gate}`;
    const prev = pointStates?.[ac.callsign];
    let index = prev && prev.key === stateKey ? prev.index : nearestPointIndex(points, ac.pos);
    index = advanceIndex(points, index, ac.pos);
    nextStates[ac.callsign] = { key: stateKey, index };

    const etaSec = nowSeconds + etaSecondsFromNow(points, index, ac.pos);
    candidates.push({
      callsign: ac.callsign,
      wake: ac.fp.wake || "M",
      gate,
      currentPoint: points[index].name,
      etaSec,
    });
  }

  candidates.sort((a, b) => a.etaSec - b.etaSec);

  // Cascade STA sur l'ensemble de la piste (toutes portes confondues) :
  // deux avions venant de portes differentes convergent vers le meme seuil
  // et doivent quand meme respecter une separation entre eux.
  let prevSta = null;
  let prevWake = null;
  const sequence = candidates.map((ac, i) => {
    const minSta = prevSta !== null ? prevSta + separationSeconds(config, prevWake, ac.wake) : ac.etaSec;
    const sta = Math.max(ac.etaSec, minSta);
    const ttlSeconds = sta - ac.etaSec;
    prevSta = sta;
    prevWake = ac.wake;
    return {
      position: i + 1,
      callsign: ac.callsign,
      wake: ac.wake,
      gate: ac.gate,
      currentPoint: ac.currentPoint,
      eta: secondsToHhmm(ac.etaSec),
      sta: secondsToHhmm(sta),
      ttlSeconds,
      status: statusFor(ttlSeconds),
    };
  });

  return { airport, runwayConfig, sequence, pointStates: nextStates, error: null };
}

module.exports = { computeSequence, gatesFor, haversineNm, secondsToHhmm };
