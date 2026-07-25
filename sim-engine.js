// sim-engine.js — geometrie pure pour le simulateur de trafic (aucun IPC/
// Aurora ici, comme aman-engine.js). Sert a extrapoler la position d'un
// avion simule a partir de son dernier point connu, cap et vitesse, et a
// piloter les modes de navigation automatique (procedure, ILS) en reutilisant
// la geometrie deja construite pour le moteur AMAN.

const { resolveTransition, nearestPointIndex, advancePastPoints } = require("./aman-engine");
const { toDeg, bearingRad, destinationPoint, projectOnAxis } = require("./geo");

// Position actuelle d'un avion simule : extrapolee en une seule fois depuis
// son dernier point connu (pas de petits pas cumules, pas d'erreur qui
// s'accumule) — vol rectiligne a cap/vitesse constants entre deux edits.
// "scale" accelere le temps ecoule (x1 par defaut) pour les tests, sans
// changer la vitesse affichee de l'avion.
function currentSimPos(entry, atMs, scale = 1) {
  const elapsedH = ((atMs - entry.updatedAt) / 3600000) * scale;
  if (elapsedH <= 0) return { lat: entry.lat, lon: entry.lon };
  const distanceNm = entry.groundSpeed * elapsedH;
  return destinationPoint(entry.lat, entry.lon, entry.track, distanceNm);
}

// Mode "procedure" : recalcule le cap vers le prochain point de la
// transition assignee (porte/piste memorisees sur l'avion simule), vitesse
// alignee sur celle configuree pour ce tronçon — pilote automatique simple,
// pas de simulation de virage (changement de cap instantane a chaque tick).
// Renvoie null si la transition n'est pas resolvable (config/porte inconnue).
function navigateProcedure(entry, config, pos) {
  const points = resolveTransition(config, entry.runwayConfig, entry.gate);
  if (!points) return null;
  const startIdx = typeof entry.navIndex === "number" ? entry.navIndex : nearestPointIndex(points, pos);
  // pos n'a pas de cap ici (c'est justement ce qu'on calcule) : advancePastPoints
  // degrade donc naturellement en avancement purement positionnel, cible =
  // posIndex+1, comme souhaite pour un pilote automatique point-a-point.
  const { posIndex, targetIndex } = advancePastPoints(points, startIdx, pos);
  const target = points[targetIndex];
  const trackDeg = (toDeg(bearingRad(pos.lat, pos.lon, target.lat, target.lon)) + 360) % 360;
  return { track: trackDeg, groundSpeed: target.speedKt, navIndex: posIndex };
}

// Capture l'ILS : projette la position actuelle sur l'axe final (IF -> seuil)
// prolonge et y "teleporte" l'avion (intercepte instantanement), cap fixe sur
// l'axe. Pas de simulation d'interception progressive — sert a tester la
// suite (AMAN en guidage/etabli) sans attendre une convergence realiste.
function captureIls(entry, config, pos) {
  const points = resolveTransition(config, entry.runwayConfig, entry.gate);
  if (!points || points.length < 3) return null;
  const ifPoint = points[points.length - 3];
  const thrPoint = points[points.length - 1];
  const axisBearingRad = bearingRad(ifPoint.lat, ifPoint.lon, thrPoint.lat, thrPoint.lon);
  const axisBearingDeg = toDeg(axisBearingRad);

  const proj = projectOnAxis(ifPoint, axisBearingRad, pos);
  const snapped = destinationPoint(ifPoint.lat, ifPoint.lon, axisBearingDeg, proj.along);
  return { lat: snapped.lat, lon: snapped.lon, track: (axisBearingDeg + 360) % 360, groundSpeed: thrPoint.speedKt };
}

module.exports = { destinationPoint, currentSimPos, navigateProcedure, captureIls };
