// aman-config-loader.js — charge le fichier de reglages AMAN d'un aeroport
// (AMAN/<ICAO>.json). Contrairement a loa-loader.js, pas de fusion
// multi-fichiers : chaque aeroport est independant, un fichier = un aeroport.

const fs = require("fs");
const path = require("path");

function loadAmanConfig(dir, airport) {
  const file = path.join(dir, `${String(airport || "").toUpperCase()}.json`);
  try {
    let raw = fs.readFileSync(file, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // BOM eventuel (Bloc-notes)
    return { config: JSON.parse(raw), error: null };
  } catch (e) {
    return {
      config: null,
      error: `Pas de configuration AMAN pour ${airport} (${file}) : ${e.message}`,
    };
  }
}

module.exports = { loadAmanConfig };
