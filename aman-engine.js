// aman-engine.js — sequencement des arrivees (AMAN).
//
// L'ETA au seuil est calculee geometriquement (Haversine) le long de la
// transition configuree (porte -> seuil), pas a partir des ETO Aurora
// (#TRPATHA ne couvre pas l'approche : aucun avion n'a sa STAR/transition
// dans son plan de vol depose une fois proche du terrain).
//
// Guidage radar : un seul calcul d'ETA (somme des tronçons, vitesse reelle
// sur le tronçon en cours puis vitesse configuree), quel que soit le mode.
// Ce qui differe pendant un guidage, c'est seulement la determination du
// point vise : un avion vectorise peut couper plusieurs points de la
// transition sans jamais s'en approcher physiquement. On considere donc un
// point "franchi" des que la position a depasse sa perpendiculaire (au
// tronçon sortant), ET — si le cap est disponible — que ce cap, prolonge en
// ligne droite, passe a moins de HEADING_CORRIDOR_NM du point teste. Un
// couloir en distance (pas un angle) : un angle fixe devient bien trop
// permissif avec la distance (quelques degres suffisent a "viser" un point
// tres eloigne par pure coincidence geometrique, ex. en vent arriere, sans
// que l'avion y aille reellement). Le cap confirme une vraie progression
// (pas un simple vecteur d'espacement qui croise la ligne par hasard sans
// rien viser de plus loin) et permet de sauter plusieurs points d'un coup
// si l'avion est deja loin devant.
//
// Aucun acces reseau ni Aurora ici : recoit "traffic" deja resolu (fp, path,
// pos), comme evaluate() recoit deja fp/path/pos pour le moteur LOA.

const path = require("path");
const { loadRawStars } = require("./star-loader");
const { toRad, toDeg, haversineNm, bearingRad, destinationPoint, projectOnAxis } = require("./geo");

const RAW_STARS = loadRawStars(path.join(__dirname, "STAR"));

// Largeur du couloir aligne sur le cap actuel, pour confirmer qu'un point
// est vraiment vise (pas juste dans la bonne direction approximative). A
// ajuster selon l'observation en session reelle.
const HEADING_CORRIDOR_NM = 2;

// Ecart lateral maximum pour faire confiance au franchissement d'un point —
// au-dela, l'avion est trop loin sur le cote pour que la perpendiculaire
// signifie encore quelque chose. Applique a CHAQUE point de la transition
// (contrairement a l'ancienne verification "porte franchie", ponctuelle) :
// reste petit, sous peine de valider plusieurs points d'un coup par pure
// proximite, sans rapport avec le cap.
const LATERAL_TRUST_NM = 6;

// Ecart lateral au-dela duquel on teinte l'avion comme "hors procedure"
// dans l'affichage (frise, debug visuel) — purement informatif, n'affecte
// plus le calcul d'ETA (unique quel que soit le mode).
const DEVIATION_NM = 0.75;

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

// Resout la liste de noms de points d'une transition en objets complets
// {name, lat, lon, speedKt} via le dictionnaire "points" partage.
function resolveTransition(config, runwayConfig, gate) {
  const names = config?.transitions?.[runwayConfig]?.[gate];
  if (!names || !names.length) return null;
  const points = names.map((name) => {
    const p = config.points?.[name];
    return p ? { name, lat: p.lat, lon: p.lon, speedKt: p.speedKt } : null;
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

// Deux indices distincts, pour ne jamais rester bloque sur une cible perimee
// si le cap change :
// - posIndex : progression physique confirmee (perpendiculaire au tronçon
//   sortant, position seule, sans le cap) — ne peut jamais reculer, c'est
//   ce qui est memorise d'un cycle a l'autre (memoire fiable : l'avion ne
//   revient pas en arriere le long de la route).
// - targetIndex : cible utilisee pour CE calcul d'ETA, recalculee a partir
//   du cap ACTUEL a chaque cycle, jamais memorisee au-dela de posIndex. Si
//   le cap change (l'avion n'est plus vectorise vers un point lointain, ou
//   plus du tout), la cible redescend immediatement au cycle suivant au
//   lieu de rester bloquee sur un choix devenu obsolete.
function advancePastPoints(points, posIndex, pos, trace) {
  // 1. Avancement physique (position seule), monotone.
  let idx = posIndex;
  while (idx < points.length - 1) {
    const legBearingRad = bearingRad(points[idx].lat, points[idx].lon, points[idx + 1].lat, points[idx + 1].lon);
    const proj = projectOnAxis(points[idx], legBearingRad, pos);
    if (proj.along > 0 && Math.abs(proj.cross) <= LATERAL_TRUST_NM) idx++;
    else break;
  }
  if (trace && idx !== posIndex) {
    trace.push(`progression (position) : ${points[posIndex].name} -> ${points[idx].name}`);
  }
  const newPosIndex = idx;

  if (newPosIndex >= points.length - 1) {
    return { posIndex: newPosIndex, targetIndex: newPosIndex };
  }

  // 2. Cible de ce cycle uniquement : le cap peut la pousser plus loin que
  //    le plancher physique (avion vectorise loin devant), mais ce choix
  //    n'est jamais memorise — reevalue a chaque cycle a partir du cap du
  //    moment.
  if (typeof pos.track === "number") {
    const trackRad = toRad(pos.track);
    for (let k = points.length - 1; k > newPosIndex; k--) {
      // Le point teste doit tomber a moins de HEADING_CORRIDOR_NM de la
      // ligne droite prolongeant le cap actuel (couloir en distance, pas en
      // angle) — et etre devant, pas derriere.
      const proj = projectOnAxis(pos, trackRad, points[k]);
      if (proj.along > 0 && Math.abs(proj.cross) <= HEADING_CORRIDOR_NM) {
        if (trace) trace.push(`cap ${pos.track.toFixed(0)}° vise ${points[k].name} (ecart ${proj.cross.toFixed(1)}NM sur ${proj.along.toFixed(1)}NM) -> cible ${points[k].name}`);
        return { posIndex: newPosIndex, targetIndex: k };
      }
    }
  }

  const targetIndex = newPosIndex + 1;
  if (trace) trace.push(`cap ne confirme aucun point au-dela de ${points[newPosIndex].name} -> cible ${points[targetIndex].name}`);
  return { posIndex: newPosIndex, targetIndex };
}

// ETA au seuil (secondes depuis maintenant) : le tronçon en cours (position
// reelle -> prochain point) utilise la vitesse sol reelle ; tous les
// tronçons suivants utilisent la vitesse prevue en config pour ce tronçon.
// "trace" est optionnel : si fourni, chaque tronçon y est detaille (utilise
// par le debug AMAN pour observer le calcul en temps reel, cf. main.js).
function etaSecondsFromNow(points, index, pos, trace) {
  const realSpeed = pos.groundSpeed > 30 ? pos.groundSpeed : points[index].speedKt;
  const d0 = haversineNm(pos.lat, pos.lon, points[index].lat, points[index].lon);
  let seconds = (d0 / realSpeed) * 3600;
  if (trace) trace.push(`pos -> ${points[index].name} : ${d0.toFixed(2)}NM @ ${realSpeed.toFixed(0)}kt (reel) = ${seconds.toFixed(0)}s`);
  for (let i = index; i < points.length - 1; i++) {
    const legNm = haversineNm(points[i].lat, points[i].lon, points[i + 1].lat, points[i + 1].lon);
    const legSec = (legNm / points[i + 1].speedKt) * 3600;
    seconds += legSec;
    if (trace) trace.push(`${points[i].name} -> ${points[i + 1].name} : ${legNm.toFixed(2)}NM @ ${points[i + 1].speedKt}kt (config) = ${legSec.toFixed(0)}s`);
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
// rafraichissement a l'autre, { [callsign]: { key, posIndex } } — fourni par
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

    const trace = [`porte=${gate} transition=[${points.map((p) => p.name).join(" > ")}]`];

    const stateKey = `${runwayConfig}|${gate}`;
    const prev = pointStates?.[ac.callsign];
    const fromMemory = prev && prev.key === stateKey;
    const startPosIndex = fromMemory ? prev.posIndex : nearestPointIndex(points, ac.pos);
    trace.push(`index initial (${fromMemory ? "memoire" : "point le plus proche"}) = ${startPosIndex} (${points[startPosIndex].name})`);

    const { posIndex, targetIndex } = advancePastPoints(points, startPosIndex, ac.pos, trace);
    nextStates[ac.callsign] = { key: stateKey, posIndex };

    const etaOffset = etaSecondsFromNow(points, targetIndex, ac.pos, trace);
    const currentPoint = points[targetIndex].name;

    // Mode d'affichage uniquement (n'affecte pas le calcul, qui est
    // desormais unique) : ecart lateral au tronçon physiquement en cours
    // (posIndex, pas la cible transitoire du cap), pour teinter
    // differemment un avion qui n'est plus exactement sur la trajectoire
    // publiee.
    let mode = "procedure";
    let crossingLine = null;
    if (posIndex < points.length - 1) {
      const legBearingRad = bearingRad(points[posIndex].lat, points[posIndex].lon, points[posIndex + 1].lat, points[posIndex + 1].lon);
      const xtrackNm = projectOnAxis(points[posIndex], legBearingRad, ac.pos).cross;
      if (Math.abs(xtrackNm) > DEVIATION_NM) mode = "guidage";

      // Ligne testee pour la prochaine progression physique, pour le debug
      // visuel — montre precisement ce qui determine l'avancement du
      // plancher de position (pas la cible transitoire du cap).
      const legBearingDeg = toDeg(legBearingRad);
      crossingLine = [
        destinationPoint(points[posIndex].lat, points[posIndex].lon, legBearingDeg + 90, LATERAL_TRUST_NM),
        destinationPoint(points[posIndex].lat, points[posIndex].lon, legBearingDeg - 90, LATERAL_TRUST_NM),
      ];
    }

    const etaSec = nowSeconds + etaOffset;
    trace.push(`ETA totale = ${etaOffset.toFixed(0)}s -> ${secondsToHhmm(etaSec)}`);

    const geo = {
      pos: { lat: ac.pos.lat, lon: ac.pos.lon },
      points: points.map((p) => ({ name: p.name, lat: p.lat, lon: p.lon, speedKt: p.speedKt })),
      index: targetIndex,
      crossingLine,
    };

    candidates.push({
      callsign: ac.callsign,
      wake: ac.fp.wake || "M",
      gate,
      currentPoint,
      mode,
      etaSec,
      trace,
      geo,
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
      mode: ac.mode,
      eta: secondsToHhmm(ac.etaSec),
      etaSeconds: ac.etaSec,
      sta: secondsToHhmm(sta),
      staSeconds: sta,
      ttlSeconds,
      status: statusFor(ttlSeconds),
      trace: ac.trace,
      geo: ac.geo,
    };
  });

  // Vue par porte : mêmes avions, mêmes objets que la sequence fusionnee
  // (position dans la sequence reelle, STA apres cascade, TTL/statut) — pas
  // une deuxieme verite recalculee sans separation. Sert juste a regrouper
  // l'affichage par porte d'origine, la realite (STA/retard) est identique
  // partout ou un avion apparait.
  const byGate = new Map();
  for (const ac of sequence) {
    if (!byGate.has(ac.gate)) byGate.set(ac.gate, []);
    byGate.get(ac.gate).push(ac);
  }
  const gateLanes = [...byGate.entries()].map(([gate, list]) => ({ gate, sequence: list }));

  return { airport, runwayConfig, sequence, gates: gateLanes, pointStates: nextStates, error: null };
}

module.exports = {
  computeSequence, gatesFor, secondsToHhmm,
  resolveTransition, nearestPointIndex, advancePastPoints,
  HEADING_CORRIDOR_NM, LATERAL_TRUST_NM, DEVIATION_NM,
};
