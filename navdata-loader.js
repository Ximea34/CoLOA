// navdata-loader.js — charge les referentiels de points nommes (fixes RNAV,
// VOR, NDB) utilises pour calculer une distance reelle a partir des noms de
// points d'une route (voir descent-engine.js / loa-engine.js). Sert aussi
// bien aux COP de la LOA (souvent des VOR/NDB, ex. MTL, STP) qu'aux points
// intermediaires d'une STAR.
//
// Format commun aux 3 fichiers (STAR/France.fix, France.vor, France.ndb),
// une ligne par point : IDENT;[FREQ;]LAT;LON;... — le nombre et l'ordre des
// champs varie legerement d'un fichier a l'autre (les VOR/NDB ont une
// frequence en plus), donc on repere LAT/LON par leur FORME (hemisphere +
// chiffres) plutot que par leur position de colonne.
//
// Format de coordonnee : "N045.10.28.240" = hemisphere + degres.minutes.secondes.
// Le point sert a la fois de separateur DMS et de decimale des secondes,
// d'ou le rejoin des morceaux au-dela du 2e avant de parser les secondes.

const fs = require("fs");
const path = require("path");

function parseDms(token) {
  const hemi = token[0];
  const sign = hemi === "S" || hemi === "W" ? -1 : 1;
  const parts = token.slice(1).split(".");
  if (parts.length < 2) return null;
  const deg = Number(parts[0]);
  const min = Number(parts[1]);
  const sec = parts.length > 2 ? Number(parts.slice(2).join(".")) : 0;
  if (!Number.isFinite(deg) || !Number.isFinite(min) || !Number.isFinite(sec)) return null;
  return sign * (deg + min / 60 + sec / 3600);
}

function parseNavFile(text) {
  const points = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;

    const parts = line.split(";").map((s) => s.trim());
    const ident = parts[0];
    if (!ident || !/^[A-Z0-9]+$/.test(ident)) continue;

    // Cherche a partir du 2e champ (jamais l'identifiant lui-meme, meme si
    // un ident theorique ressemblait a "N123...").
    const rest = parts.slice(1);
    const latTok = rest.find((p) => /^[NS]\d/.test(p));
    const lonTok = rest.find((p) => /^[EW]\d/.test(p));
    if (!latTok || !lonTok) continue;

    const lat = parseDms(latTok);
    const lon = parseDms(lonTok);
    if (lat === null || lon === null) continue;

    if (!points.has(ident)) points.set(ident, { lat, lon });
  }
  return points;
}

// Fusionne fix/vor/ndb en un seul referentiel nom -> {lat, lon}. Un fichier
// absent (ex. anciens dossiers STAR sans .vor/.ndb) est simplement ignore,
// pas une erreur — le referentiel se degrade proprement, moins de points
// resolubles plutot qu'un crash.
function loadNavPoints(dir) {
  const points = new Map();
  for (const file of ["France.fix", "France.vor", "France.ndb"]) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, file), "utf8");
    } catch {
      continue;
    }
    for (const [ident, coord] of parseNavFile(text)) {
      if (!points.has(ident)) points.set(ident, coord);
    }
  }
  return points;
}

module.exports = { loadNavPoints, parseDms, parseNavFile };
