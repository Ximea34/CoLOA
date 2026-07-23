// loa-loader.js — charge et fusionne tous les documents LOA d'un dossier
// (un fichier par FIR/ACC : loa/lfmm.json, loa/lfbb.json, ...).
//
// Aucun acces reseau ici, seulement le systeme de fichiers — meme contrainte
// que loa-engine.js, qui doit rester testable sans Electron.
//
// Regles de fusion :
//   - id de regle : prefixe automatique par le nom du fichier (ex. "lfbb:acc-xxx"),
//     pour ne pas imposer une unicite globale entre documents rediges independamment.
//   - stations : le fichier marque "meta": {"primary": true} (notre propre LOA)
//     est toujours fusionne en premier, avant les autres tries par ordre
//     alphabetique. En cas de collision, c'est donc toujours lui qui fait
//     autorite — jamais un fichier externe qui gagnerait par hasard de tri.
//     Toute collision (meme id de station, valeurs differentes entre deux
//     fichiers) est signalee dans "warnings" — jamais fusionnee en silence.
//   - JSON invalide : le fichier fautif est ignore, l'erreur est signalee dans
//     "errors". Un seul fichier corrompu ne doit pas faire tomber les autres.

const fs = require("fs");
const path = require("path");

function loadAll(dir) {
  const result = { meta: [], stations: {}, rules: [], sources: [], errors: [], warnings: [] };

  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch (e) {
    result.errors.push(`Dossier LOA introuvable (${dir}) : ${e.message}`);
    return result;
  }

  // Premiere passe : parser chaque fichier isolement, pour qu'un JSON invalide
  // n'empeche pas de lire les autres ni de determiner qui est prioritaire.
  const parsed = [];
  for (const file of files) {
    const fileKey = path.basename(file, ".json");
    const full = path.join(dir, file);
    try {
      // Node ne retire pas le BOM UTF-8 tout seul ; frequent sur des fichiers
      // enregistres avec le Bloc-notes ou d'autres editeurs Windows.
      let raw = fs.readFileSync(full, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      parsed.push({ fileKey, doc: JSON.parse(raw) });
    } catch (e) {
      result.errors.push(`${file} : JSON invalide — ${e.message}`);
    }
  }

  // Tri stable : le(s) fichier(s) primary passent devant, l'ordre
  // alphabetique des autres est conserve.
  parsed.sort((a, b) => (b.doc.meta?.primary ? 1 : 0) - (a.doc.meta?.primary ? 1 : 0));

  const stationSource = {}; // id de station -> fichier dont la valeur est conservee

  for (const { fileKey, doc } of parsed) {
    result.sources.push(fileKey);
    if (doc.meta) result.meta.push({ file: fileKey, ...doc.meta });

    for (const [id, station] of Object.entries(doc.stations || {})) {
      if (!(id in result.stations)) {
        result.stations[id] = station;
        stationSource[id] = fileKey;
      } else if (JSON.stringify(result.stations[id]) !== JSON.stringify(station)) {
        result.warnings.push(
          `Station "${id}" definie differemment dans ${fileKey} — valeur de "${stationSource[id]}" conservee.`
        );
      }
      // Valeurs identiques dans deux fichiers : reference partagee normale, pas un conflit.
    }

    for (const rule of doc.rules || []) {
      result.rules.push({ ...rule, id: `${fileKey}:${rule.id}`, source: fileKey });
    }
  }

  return result;
}

module.exports = { loadAll };
