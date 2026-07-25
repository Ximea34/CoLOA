// geo.js — geometrie pure partagee entre aman-engine.js et sim-engine.js
// (aucun acces reseau/IPC ici). Extrait pour eviter la duplication et pour
// que les deux moteurs travaillent avec les memes approximations.

const EARTH_RADIUS_NM = 3440.065;

function toRad(deg) { return (deg * Math.PI) / 180; }
function toDeg(rad) { return (rad * 180) / Math.PI; }

// Distance grand cercle en NM — suffisant a l'echelle d'une approche
// (quelques dizaines de NM), pas besoin d'un modele plus precis.
function haversineNm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingRad(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1), φ2 = toRad(lat2), Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return Math.atan2(y, x);
}

// Point d'arrivee a une distance/cap donnes depuis un point de depart —
// formule geodesique directe standard (grand cercle).
function destinationPoint(lat, lon, bearingDeg, distanceNm) {
  const δ = distanceNm / EARTH_RADIUS_NM;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(lat);
  const λ1 = toRad(lon);

  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(
    Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
  );

  return { lat: toDeg(φ2), lon: toDeg(λ2) };
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

// Position projetee sur l'axe ref->suivant, dans le plan local centre sur
// ref : along = distance le long de l'axe (positif = au-dela de ref),
// cross = ecart lateral (NM, signe).
function projectOnAxis(ref, axisBearingRad, pos) {
  const p = localXY(ref, pos);
  const dir = { x: Math.sin(axisBearingRad), y: Math.cos(axisBearingRad) };
  return {
    along: p.x * dir.x + p.y * dir.y,
    cross: p.x * dir.y - p.y * dir.x,
  };
}

module.exports = { toRad, toDeg, haversineNm, bearingRad, destinationPoint, localXY, projectOnAxis };
