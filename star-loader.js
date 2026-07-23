// star-loader.js — extrait, pour chaque aeroport, la correspondance entre le
// point d'entree d'une STAR (celui visible sur le plan de vol / #TRPATHA) et
// son point final (l'IAF que la LOA utilise reellement comme COP).
//
// Source : STAR/*.str, un fichier par aeroport. Format texte structure (pas
// un PDF), plusieurs sections (INAs, FNAs, APIs, HLDs, STRs) — seule la
// section STRs nous interesse. Chaque STAR y est une ligne d'entete
// "AEROPORT;PISTES;NOM;lat;lon;;" suivie de ses points, dans l'ordre, jusqu'a
// la STAR suivante. Le premier point est l'entree (celui du plan de vol), le
// dernier est le COP reel.

const fs = require("fs");
const path = require("path");

function parseStarFile(text) {
  const stars = [];
  let current = null;
  let inStrs = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("//")) {
      if (/\bSTRs\b/.test(line)) inStrs = true;
      continue;
    }
    if (!inStrs) continue;

    const parts = line.split(";").map((s) => s.trim());
    if (parts.length < 2) continue;

    // Entete de STAR : "AEROPORT;PISTES;NOM;lat;lon;;" — le champ 1 est un
    // code OACI, different du champ 2 (les pistes). Un point de STAR repete
    // toujours son propre nom deux fois ("FIX;FIX;").
    if (parts[0] !== parts[1] && /^[A-Z]{4}$/.test(parts[0])) {
      if (current && current.fixes.length) stars.push(current);
      current = { airport: parts[0], runways: parts[1], name: parts[2] || "", fixes: [] };
    } else if (current && parts[0] && parts[0] === parts[1]) {
      current.fixes.push(parts[0]);
    }
    // Une coordonnee brute (pas de nom repete) ne devrait pas apparaitre
    // dans la section STRs ; si c'est le cas on l'ignore silencieusement.
  }
  if (current && current.fixes.length) stars.push(current);
  return stars;
}

// Lit tous les STAR/*.str et retourne la liste brute de STAR parsees, tous
// aeroports confondus : [{ airport, runways, name, fixes }]. Base commune a
// loadStars() (correspondance entree->COP pour l'inference LOA) et a
// loadRawStars() (portes/IAF par config piste pour l'AMAN) — un seul endroit
// qui lit le disque et parse.
function readAllStars(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".str"));
  } catch {
    return [];
  }

  const stars = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, file), "utf8");
    } catch {
      continue;
    }
    stars.push(...parseStarFile(text));
  }
  return stars;
}

// Map "AEROPORT|POINT_ENTREE" -> [{ cop, runways, starName }]. Dedoublonne
// par cop : si deux configs de piste menent au meme point final, une seule
// entree (les listes de pistes sont juste concatenees a titre indicatif).
function loadStars(dir) {
  const map = new Map();

  for (const star of readAllStars(dir)) {
    const entry = star.fixes[0];
    const cop = star.fixes[star.fixes.length - 1];
    if (!entry || !cop || entry === cop) continue;

    const key = `${star.airport}|${entry}`;
    if (!map.has(key)) map.set(key, []);
    const list = map.get(key);

    const existing = list.find((e) => e.cop === cop);
    if (existing) {
      if (!existing.runways.includes(star.runways)) existing.runways += `, ${star.runways}`;
    } else {
      list.push({ cop, runways: star.runways, starName: star.name });
    }
  }
  return map;
}

function resolveStarCop(starDb, airport, entryFix) {
  if (!entryFix) return [];
  return starDb.get(`${airport}|${entryFix}`) || [];
}

// Liste brute (non reduite a une map) pour l'AMAN : besoin du detail complet
// par config piste, pas seulement de la correspondance entree->COP.
function loadRawStars(dir) {
  return readAllStars(dir);
}

module.exports = { loadStars, resolveStarCop, loadRawStars, parseStarFile };
