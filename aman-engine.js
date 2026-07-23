// aman-engine.js — sequencement des arrivees (AMAN).
//
// L'ETA au seuil est calculee geometriquement (Haversine) le long de la
// transition configuree (porte -> seuil), pas a partir des ETO Aurora
// (#TRPATHA ne couvre pas l'approche : aucun avion n'a sa STAR/transition
// dans son plan de vol depose une fois proche du terrain).
//
// Guidage radar : modele mixte, pas de zones a configurer manuellement.
// - Avant la porte (ligne perpendiculaire au 1er tronçon, GATE_LINE_HALF_NM de
//   chaque cote) : toujours la methode transition, la porte reste la cible.
// - Apres la porte : on surveille l'ecart lateral au tronçon en cours
//   (DEVIATION_NM pendant DEVIATION_MS soutenues). Pas d'ecart -> transition
//   inchangee. Ecart confirme -> guidage : on projette le cap actuel de
//   l'avion sur la perpendiculaire a l'axe final centree sur l'IF (base +
//   interception), plutot que de sommer des tronçons qu'il ne suit plus.
// - Si le cap ne croise pas cette ligne (avion qui s'eloigne, remise de gaz,
//   avion oublie), repli sur la methode transition — recalculee a chaque
//   cycle a partir de la position reelle, donc s'auto-corrige des que le cap
//   redevient exploitable.
//
// Aucun acces reseau ni Aurora ici : recoit "traffic" deja resolu (fp, path,
// pos), comme evaluate() recoit deja fp/path/pos pour le moteur LOA.

const path = require("path");
const { loadRawStars } = require("./star-loader");

const RAW_STARS = loadRawStars(path.join(__dirname, "STAR"));
const EARTH_RADIUS_NM = 3440.065;
const GATE_LINE_HALF_NM = 25;    // demi-longueur de la perpendiculaire de porte, de chaque cote
const DEVIATION_NM = 0.75;       // ecart de trajectoire declenchant le guidage
const DEVIATION_MS = 8000;       // duree cumulee au-dela du seuil avant bascule
const PERP_HALF_LEN_NM = 50;     // longueur de la perpendiculaire a l'axe final, de chaque cote de l'IF

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

function bearingRad(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1), φ2 = toRad(lat2), Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return Math.atan2(y, x);
}

// Projection plane locale centree sur un point de reference (NM est/nord) —
// approximation suffisante a l'echelle d'une zone de guidage (quelques
// dizaines de NM), coherente avec l'approximation deja utilisee pour les
// distances (haversineNm).
function localXY(ref, p) {
  return {
    x: (p.lon - ref.lon) * 60 * Math.cos(toRad(ref.lat)),
    y: (p.lat - ref.lat) * 60,
  };
}

// Position de l'avion projetee sur l'axe ref->suivant, dans le plan local
// centre sur ref : along = distance le long de l'axe (positif = au-dela de
// ref), cross = ecart lateral (NM, signe). Sert a la fois pour verifier le
// franchissement de la porte et l'ecart lateral au tronçon en cours.
function projectOnAxis(ref, axisBearingRad, pos) {
  const p = localXY(ref, pos);
  const dir = { x: Math.sin(axisBearingRad), y: Math.cos(axisBearingRad) };
  return {
    along: p.x * dir.x + p.y * dir.y,
    cross: p.x * dir.y - p.y * dir.x,
  };
}

// Cherche ou le cap actuel de l'avion croise la perpendiculaire a l'axe
// final, centree sur l'IF (longueur PERP_HALF_LEN_NM de chaque cote).
// Renvoie null si le cap ne croise pas la ligne devant l'avion (route qui
// s'eloigne ou quasi parallele) ou si le croisement tombe hors de la ligne —
// dans ce cas l'appelant retombe sur la methode porte/transition.
function projectTrackToLine(pos, trackDeg, ifPoint, axisBearingRad) {
  const p0 = localXY(ifPoint, pos);
  const dirRad = toRad(trackDeg);
  const dir = { x: Math.sin(dirRad), y: Math.cos(dirRad) };
  const perp = { x: Math.cos(axisBearingRad), y: -Math.sin(axisBearingRad) };

  // p0 + t*dir = s*perp  (t = distance parcourue au cap actuel, s = position
  // signee sur la perpendiculaire, l'IF etant a s=0)
  const a1 = dir.x, b1 = -perp.x, c1 = -p0.x;
  const a2 = dir.y, b2 = -perp.y, c2 = -p0.y;
  const det = a1 * b2 - b1 * a2;
  if (Math.abs(det) < 1e-9) return null; // cap parallele a la perpendiculaire

  const t = (c1 * b2 - b1 * c2) / det;
  const s = (a1 * c2 - c1 * a2) / det;
  if (t < 0 || Math.abs(s) > PERP_HALF_LEN_NM) return null;

  return { crossingNm: t, baseLegNm: Math.abs(s) };
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
    if (points.length < 3) continue; // il faut au moins IF/FAF/seuil pour situer l'IF — garde-fou

    const gatePoint = points[0];
    const gateAxisBearingRad = bearingRad(gatePoint.lat, gatePoint.lon, points[1].lat, points[1].lon);

    const ifIndex = points.length - 3;
    const ifPoint = points[ifIndex];
    const thrPoint = points[points.length - 1];
    const finalAxisBearingRad = bearingRad(ifPoint.lat, ifPoint.lon, thrPoint.lat, thrPoint.lon);

    const trace = [`porte=${gate} transition=[${points.map((p) => p.name).join(" > ")}]`];

    // Methode porte/transition : toujours calculee, sert de base et de repli
    // si le guidage n'est pas retenu plus bas.
    const stateKey = `${runwayConfig}|${gate}`;
    const prev = pointStates?.[ac.callsign];
    const fromMemory = prev && prev.key === stateKey;
    const startIndex = fromMemory ? prev.index : nearestPointIndex(points, ac.pos);
    trace.push(`index initial (${fromMemory ? "memoire" : "point le plus proche"}) = ${startIndex} (${points[startIndex].name})`);

    let index = advanceIndex(points, startIndex, ac.pos);
    if (index !== startIndex) {
      trace.push(`avance par franchissement de zone : ${startIndex} (${points[startIndex].name}) -> ${index} (${points[index].name})`);
    }

    let mode = "procedure";
    let etaOffset = etaSecondsFromNow(points, index, ac.pos, trace);
    let currentPoint = points[index].name;
    let deviationSince = fromMemory ? prev.deviationSince : null;

    // Porte franchie ? Perpendiculaire au 1er tronçon (porte -> point
    // suivant), fiable seulement dans une bande de GATE_LINE_HALF_NM de
    // chaque cote — au-dela, ecart lateral trop important pour conclure,
    // on reste prudent (pas franchie).
    const gateProj = projectOnAxis(gatePoint, gateAxisBearingRad, ac.pos);
    const passedGate = gateProj.along > 0 && Math.abs(gateProj.cross) <= GATE_LINE_HALF_NM;
    trace.push(`porte ${passedGate ? "franchie" : "pas franchie"} (long=${gateProj.along.toFixed(1)}NM, lat=${gateProj.cross.toFixed(1)}NM)`);

    if (!passedGate) {
      deviationSince = null;
    } else if (index < points.length - 1) {
      const xtrackNm = projectOnAxis(points[index], bearingRad(points[index].lat, points[index].lon, points[index + 1].lat, points[index + 1].lon), ac.pos).cross;
      trace.push(`ecart trajectoire = ${xtrackNm.toFixed(2)}NM (seuil ${DEVIATION_NM}NM)`);

      if (Math.abs(xtrackNm) <= DEVIATION_NM) {
        deviationSince = null;
      } else {
        if (!deviationSince) deviationSince = now ?? Date.now();
        const elapsedMs = (now ?? Date.now()) - deviationSince;
        trace.push(`hors trajectoire depuis ${(elapsedMs / 1000).toFixed(0)}s (seuil ${DEVIATION_MS / 1000}s)`);

        if (elapsedMs >= DEVIATION_MS) {
          if (typeof ac.pos.track !== "number") {
            trace.push("guidage : cap indisponible, methode transition conservee");
          } else {
            const crossing = projectTrackToLine(ac.pos, ac.pos.track, ifPoint, finalAxisBearingRad);
            if (!crossing) {
              trace.push(`guidage : cap ${ac.pos.track}° ne croise pas la perpendiculaire — methode transition conservee`);
            } else {
              const realSpeed = ac.pos.groundSpeed > 30 ? ac.pos.groundSpeed : ifPoint.speedKt;
              const leg1Sec = (crossing.crossingNm / realSpeed) * 3600;
              const leg2Sec = (crossing.baseLegNm / ifPoint.speedKt) * 3600;
              trace.push(
                `guidage : cap ${ac.pos.track}° croise la perpendiculaire a ${crossing.crossingNm.toFixed(1)}NM ` +
                `(${leg1Sec.toFixed(0)}s @ ${realSpeed.toFixed(0)}kt), puis ${crossing.baseLegNm.toFixed(1)}NM ` +
                `jusqu'a l'IF (${leg2Sec.toFixed(0)}s @ ${ifPoint.speedKt}kt)`
              );
              const legsFromIF = etaSecondsFromNow(points, ifIndex, { lat: ifPoint.lat, lon: ifPoint.lon, groundSpeed: 0 }, trace);
              mode = "guidage";
              etaOffset = leg1Sec + leg2Sec + legsFromIF;
              currentPoint = ifPoint.name;
            }
          }
        }
      }
    }

    nextStates[ac.callsign] = { key: stateKey, index, deviationSince };

    const etaSec = nowSeconds + etaOffset;
    trace.push(`ETA totale = ${etaOffset.toFixed(0)}s -> ${secondsToHhmm(etaSec)}`);

    candidates.push({
      callsign: ac.callsign,
      wake: ac.fp.wake || "M",
      gate,
      currentPoint,
      mode,
      etaSec,
      trace,
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
    };
  });

  // Vue par porte, avant fusion sur la piste : chaque avion reste dans la
  // colonne de sa propre porte, triee par ETA. Pas de cascade de separation
  // ici (le moteur ne modelise pas d'attente/hippodrome par porte, juste un
  // flux continu vers le seuil) — seule la sequence fusionnee ci-dessus a
  // une vraie STA/TTL. Sert a l'affichage "avant fusion" de la frise AMAN.
  const byGate = new Map();
  for (const ac of candidates) {
    if (!byGate.has(ac.gate)) byGate.set(ac.gate, []);
    byGate.get(ac.gate).push(ac);
  }
  const gateLanes = [...byGate.entries()].map(([gate, list]) => ({
    gate,
    sequence: list.map((ac, i) => ({
      position: i + 1,
      callsign: ac.callsign,
      wake: ac.wake,
      currentPoint: ac.currentPoint,
      mode: ac.mode,
      eta: secondsToHhmm(ac.etaSec),
      etaSeconds: ac.etaSec,
    })),
  }));

  return { airport, runwayConfig, sequence, gates: gateLanes, pointStates: nextStates, error: null };
}

module.exports = {
  computeSequence, gatesFor, haversineNm, projectTrackToLine, secondsToHhmm,
  resolveTransition, nearestPointIndex, advanceIndex, bearingRad, projectOnAxis,
  toDeg: (rad) => (rad * 180) / Math.PI,
};
