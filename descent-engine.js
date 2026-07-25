// descent-engine.js — estimation geometrique pure du temps restant jusqu'a
// un point cible (COP) et du moment ou un trafic doit debuter sa descente
// pour y tenir son niveau de transfert (XFL). Aucune connaissance d'Aurora
// ni des regles LOA : recoit une liste de points DEJA resolus (nom +
// coordonnees, dans l'ordre de la route restante, direct actif deja pris
// en compte) — voir loa-engine.js pour cette resolution.

const { haversineNm } = require("./geo");

const NM_PER_1000FT_3TO1 = 3; // regle des 3:1 (~pente 3 deg), standard controle

// points : [{ name, lat, lon }, ...] du premier point vise jusqu'au COP
// inclus (position actuelle fournie a part). Vide = COP non atteignable
// avec les points connus (direct hors plan, point absent du referentiel...).
function computeDescentPlan({ lat, lon, altitude, groundSpeed, targetFl, points }, trace) {
  if (!points || !points.length) {
    trace?.push("Descente : aucun point exploitable jusqu'au COP — calcul impossible");
    return null;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    trace?.push("Descente : position actuelle inconnue — calcul impossible");
    return null;
  }
  if (!Number.isFinite(groundSpeed) || groundSpeed <= 0) {
    trace?.push("Descente : vitesse sol inconnue ou nulle — calcul impossible");
    return null;
  }
  if (!Number.isFinite(altitude)) {
    trace?.push("Descente : altitude actuelle inconnue — calcul impossible");
    return null;
  }
  if (!Number.isFinite(targetFl)) {
    trace?.push("Descente : XFL requis non defini — calcul impossible");
    return null;
  }

  let distanceNm = 0;
  let from = { lat, lon };
  for (const p of points) {
    distanceNm += haversineNm(from.lat, from.lon, p.lat, p.lon);
    from = p;
  }
  const etaSeconds = (distanceNm / groundSpeed) * 3600;

  const targetAltitudeFt = targetFl * 100;
  const altitudeToLoseFt = altitude - targetAltitudeFt;

  if (altitudeToLoseFt <= 0) {
    trace?.push(
      `Descente : altitude actuelle (${Math.round(altitude)}ft) deja a/sous le XFL requis (FL${targetFl}) — rien a prevoir`
    );
    return { status: "none", distanceNm, etaSeconds };
  }

  const descentDistanceNm = (altitudeToLoseFt / 1000) * NM_PER_1000FT_3TO1;
  const distanceBeforeTodNm = distanceNm - descentDistanceNm;
  const secondsBeforeTod = (distanceBeforeTodNm / groundSpeed) * 3600;

  trace?.push(
    `Descente : ${distanceNm.toFixed(1)}nm jusqu'au COP, ${Math.round(altitudeToLoseFt)}ft a perdre pour FL${targetFl}` +
    ` -> ${descentDistanceNm.toFixed(1)}nm necessaires (regle 3:1)`
  );

  if (secondsBeforeTod < 0) {
    const lateSeconds = -secondsBeforeTod;
    trace?.push(`Descente : EN RETARD de ${Math.round(lateSeconds / 60)} min sur le point de descente ideal`);
    return { status: "late", lateSeconds, distanceNm, etaSeconds };
  }

  trace?.push(`Descente : a debuter dans ${Math.round(secondsBeforeTod / 60)} min`);
  return { status: "tod", todInSeconds: secondsBeforeTod, distanceNm, etaSeconds };
}

module.exports = { computeDescentPlan, NM_PER_1000FT_3TO1 };
