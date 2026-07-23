// loa-engine.js — moteur de resolution des LOA de Marseille ACC
//
// evaluate({ myStation, fp, pos, path, onlineATC }) -> resultat structure
//
// Principe : on cherche le COP de la LOA le plus proche sur la route restante,
// on applique les exceptions par aerodrome de depart/arrivee, puis on resout
// la parite du niveau et la station suivante reellement en ligne.

const path = require("path");
const { loadAll } = require("./loa-loader");

const DB = loadAll(path.join(__dirname, "loa"));

// --- utilitaires -----------------------------------------------------------

// "F330" / "FL330" / "330" -> 330
function toFL(value) {
  if (value === null || value === undefined) return null;
  const m = String(value).match(/(\d{2,3})$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 600 ? Math.round(n / 100) : n;
}

function isOdd(fl) {
  return Math.round(fl / 10) % 2 === 1;
}

// Un COP peut etre "FIX" ou "FIXA-FIXB".
// Pour une paire, on exige A puis B dans l'ordre (les points intermediaires
// sont autorises), et le point de transfert affiche est B.
//
// tier 0 = correspondance complete (fix simple, ou les deux points de la paire
//          presents et dans le bon ordre)
// tier 1 = correspondance partielle (seul B present, A suppose deja survole)
// Le tier est decisif : sans lui, "TURIL-STP" capture a tort un avion dont la
// route est STP...NOSTA, simplement parce que STP arrive plus tot que NOSTA.
function matchCop(cop, fixes) {
  if (!cop.includes("-")) {
    const i = fixes.indexOf(cop);
    return i === -1 ? null : { index: i, tier: 0, transferPoint: cop, entry: null };
  }
  const [a, b] = cop.split("-");
  const ib = fixes.indexOf(b);
  if (ib === -1) return null;
  const ia = fixes.indexOf(a);
  if (ia === -1) return { index: ib, tier: 1, transferPoint: b, entry: a };
  if (ia > ib) return null; // ordre inverse : mauvais sens de traversee
  return { index: ib, tier: 0, transferPoint: b, entry: a };
}

function whenMatches(when, fp) {
  if (!when) return true;
  if (when.arr && !when.arr.includes(fp.arr)) return false;
  if (when.dep && !when.dep.includes(fp.dep)) return false;
  return true;
}

// --- resolution du niveau --------------------------------------------------

// Extrait les points d'une route deposee, en secours quand #TRPATHA echoue.
// "BODRU DCT KOTIT/N0372F180 Y42 LASUR Z42 PINED" -> BODRU KOTIT LASUR PINED
//
// Moins fiable que #TRPATHA : les airways ne sont pas developpees en points
// intermediaires, et il n'y a aucune heure estimee. Mais mieux que rien.
function fixesFromRoute(route) {
  if (!route) return [];
  return String(route)
    .split(/\s+/)
    .map((t) => t.split("/")[0].trim().toUpperCase())
    .filter(Boolean)
    .filter((t) => t !== "DCT")
    .filter((t) => !/^[A-Z]{1,2}\d{1,3}[A-Z]?$/.test(t))   // airways : Y42, Q125, UN871
    .filter((t) => !/^[A-Z]{2,5}\d[A-Z]$/.test(t))          // SID/STAR : BODRU8A, OTGI3E
    .filter((t, i, a) => a.indexOf(t) === i);
}

function resolveLevel(spec, rfl) {
  const out = { text: "", fl: null, warnings: [] };
  if (!spec) return { ...out, text: "Non defini — coordination requise" };

  if (spec.coordination) {
    return { ...out, text: "Sur coordination", coordination: true };
  }

  if (spec.fl !== undefined) {
    out.fl = spec.fl;
    out.text = `FL${spec.fl}`;
    if (spec.at) out.text += ` a ${spec.at}`;
    if (spec.trend === "descending") out.text += " (en descente)";
    if (spec.trend === "climbing") out.text += " (en montee)";
    return out;
  }

  if (spec.parity) {
    const wantOdd = spec.parity === "odd";
    const label = wantOdd ? "impair" : "pair";

    const forbidden = spec.forbidden || [];
    const ok = (fl) =>
      isOdd(fl) === wantOdd &&
      !forbidden.includes(fl) &&
      (spec.maxFl === undefined || fl <= spec.maxFl);

    if (rfl !== null && ok(rfl)) {
      out.fl = rfl;
      out.text = `FL${rfl} (RFL, niveau ${label} conforme)`;
    } else if (rfl !== null) {
      // Balayage de toute la bande utile : une fenetre autour du RFL ne suffit
      // pas quand un plafond ramene le niveau tres en dessous (ex. RFL FL200
      // avec un maximum a FL160).
      const valid = [];
      for (let fl = 50; fl <= 450; fl += 10) if (ok(fl)) valid.push(fl);
      const options = valid
        .sort((a, b) => Math.abs(a - rfl) - Math.abs(b - rfl))
        .slice(0, 2)
        .sort((a, b) => a - b);

      // Motif exact du rejet, sinon on annonce un probleme de parite alors que
      // c'est le plafond ou un niveau interdit qui bloque.
      const reasons = [];
      if (isOdd(rfl) !== wantOdd) reasons.push(`${label} exige`);
      if (spec.maxFl !== undefined && rfl > spec.maxFl) reasons.push(`plafond FL${spec.maxFl}`);
      if (forbidden.includes(rfl)) reasons.push("niveau interdit");

      out.fl = options[0] ?? null;
      out.text = options.length
        ? `Niveau ${label} requis — proposer ${options.map((f) => "FL" + f).join(" ou ")}`
        : `Niveau ${label} requis — aucun niveau conforme, coordination necessaire`;
      out.warnings.push(`RFL FL${rfl} non conforme (${reasons.join(", ") || "hors LoA"})`);
    } else {
      out.text = `Niveau ${label}`;
    }

    if (spec.maxFl !== undefined) out.text += ` — max FL${spec.maxFl}`;
    if (forbidden.length) out.text += ` — interdits : ${forbidden.map((f) => "FL" + f).join(", ")}`;
    return out;
  }

  return { ...out, text: "Non defini — coordination requise" };
}

// --- resolution de la station suivante -------------------------------------

function resolveStation(target, onlineATC, myStation) {
  const info = DB.stations[target];

  // Liste ATC indisponible (commande non supportee, parsing en echec) : on ne
  // sait rien de qui est en ligne. Annoncer UNICOM serait un faux resultat, on
  // se rabat sur la frequence de la LoA en signalant l'incertitude.
  if (!onlineATC || onlineATC.length === 0) {
    return {
      station: target,
      freq: info?.freq || "?",
      self: target === myStation,
      unverified: true,
      text: `${target} ${info?.freq || "?"} (liste ATC indisponible — frequence LoA, statut non verifie)`,
    };
  }

  const online = new Set(onlineATC.map((a) => a.station));
  const freqOf = (s) =>
    onlineATC.find((a) => a.station === s)?.freq || DB.stations[s]?.freq || "?";

  const chain = [target, ...(DB.stations[target]?.fallback || [])];
  for (const station of chain) {
    if (!online.has(station)) continue;
    if (station === myStation) {
      return {
        station,
        freq: freqOf(station),
        self: true,
        text:
          station === target
            ? "Tu es deja la station cible — pas de transfert"
            : `${target} hors ligne — tu conserves le trafic`,
      };
    }
    const relayed = station !== target;
    return {
      station,
      freq: freqOf(station),
      self: false,
      text: relayed
        ? `${station} ${freqOf(station)} (${target} hors ligne, reprise top-down)`
        : `${station} ${freqOf(station)}`,
    };
  }
  return { station: null, freq: "122.800", self: false,
           text: "Aucune station en ligne — UNICOM 122.800" };
}

// --- moteur ----------------------------------------------------------------

function evaluate({ myStation, fp, pos = {}, path = [], onlineATC = [] }) {
  const fixes = path.map((p) => (typeof p === "string" ? p : p.fix));
  const rfl = toFL(fp.cruiseLevel);
  const mySector = myStation.startsWith("LFMM_E") ? "LFMM_E" : "LFMM_W";

  const candidates = [];
  for (const rule of DB.rules) {
    if (!whenMatches(rule.when, fp)) continue;
    let matchedAny = false;
    for (const cop of rule.cop || []) {
      const m = matchCop(cop, fixes);
      if (m) { candidates.push({ rule, cop, ...m }); matchedAny = true; }
    }
    // "fallback" : la regle couvre un cas general ("toute arrivee LFMT sur
    // STAR") dont la liste de cop n'est qu'un echantillon, pas une liste
    // exhaustive. Elle ne s'applique que si AUCUNE regle n'a matche via un
    // cop reconnu POUR CETTE regle precise — jamais en remplacement d'un
    // match plus precis de la meme regle. tier 2 (pire que 0/1) la place
    // derriere un vrai match dans le meme secteur, mais le secteur reste le
    // premier critere : ma propre regle de transfert (meme en repli) passe
    // avant une regle de reception d'une autre FIR, meme si celle-ci a
    // trouve un COP reel. Sinon, recevoir un trafic via un COP d'une FIR
    // voisine masque systematiquement ce que MOI je dois en faire ensuite.
    if (!matchedAny && rule.fallback) {
      candidates.push({ rule, cop: null, tier: 2, index: Infinity, transferPoint: null, entry: null });
    }
  }

  if (!candidates.length) {
    return {
      matched: false,
      callsign: fp.callsign,
      route: `${fp.dep} → ${fp.arr}`,
      message: "Aucun COP de la LOA sur la route restante.",
      hint:
        "Verifier le range radar (#TRPATHA est tronque), un DCT hors LOA, " +
        "ou une interface non couverte (Bordeaux, Geneve, Milan, Barcelone).",
      remaining: fixes.slice(0, 8),
    };
  }

  // Ordre de priorite : regle de mon secteur > correspondance complete > COP le
  // plus proche. Sans le critere de secteur, une regle LFMM_E (ou d'une autre
  // FIR) peut capturer un avion que je gere depuis LFMM_W.
  const score = (c) => [c.rule.from === mySector ? 0 : 1, c.tier, c.index];
  candidates.sort((a, b) => {
    const [sa, ta, ia] = score(a);
    const [sb, tb, ib] = score(b);
    return sa - sb || ta - tb || ia - ib;
  });
  const best = candidates[0];
  const usedFallback = best.tier === 2;
  const rule = best.rule;

  // Exceptions d'abord, defaut ensuite. L'exception complete la regle de base
  // (ex. un plafond qui vient s'ajouter a la parite), elle ne la remplace que
  // sur les champs qu'elle precise explicitement.
  const exception = (rule.exceptions || []).find((e) => whenMatches(e.when, fp));
  const levelSpec = exception ? { ...rule.level, ...exception.level } : rule.level;
  const level = resolveLevel(levelSpec, rfl);

  const next = resolveStation(rule.to, onlineATC, myStation);

  const warnings = [...level.warnings];
  if (rule.verify) warnings.push(`Regle a verifier : ${rule.verify}`);
  if (exception && exception.verify) warnings.push("Exception issue d'une cellule PDF ambigue.");
  if (rule.from !== mySector) {
    warnings.push(`Cette regle vaut pour ${rule.from}, tu es sur ${mySector}.`);
  }

  const conditions = [];
  if (usedFallback) {
    conditions.push(
      "Aucun COP reconnu sur la route — regle appliquee via sa clause generale, point de transfert non identifie"
    );
  }
  if (exception) {
    const key = exception.when.arr ? `ARR ${fp.arr}` : `DEP ${fp.dep}`;
    conditions.push(`Exception ${key}`);
  }
  if (rule.note) conditions.push(rule.note);
  if (exception && exception.note) conditions.push(exception.note);

  // Le champ [11] de #TRPOS porte le niveau autorise inscrit dans le label
  // Aurora. Le confronter au XFL de la LoA detecte un label oublie ou errone.
  // Uniquement sur un trafic que j'assume : sur un avion pas encore a moi, le
  // label est normalement vide et le signaler serait du bruit.
  const isMine = pos.assumedBy === myStation;
  const labelFL = toFL(pos.altLabel);
  let labelCheck = null;

  if (!isMine) {
    conditions.push(
      pos.assumedBy
        ? `Trafic assume par ${pos.assumedBy} — conditions a titre indicatif`
        : "Trafic non assume — conditions anticipees"
    );
  } else if (labelFL !== null && level.fl !== null) {
    if (labelFL === level.fl) {
      labelCheck = "ok";
      conditions.push(`Label FL${labelFL} conforme au XFL`);
    } else {
      labelCheck = "mismatch";
      warnings.push(`Label Aurora FL${labelFL} != XFL LoA FL${level.fl}`);
    }
  } else if (labelFL === null && level.fl !== null && !level.coordination) {
    labelCheck = "empty";
    conditions.push(`Label vide — XFL a poser : FL${level.fl}`);
  }

  return {
    matched: true,
    callsign: fp.callsign,
    route: `${fp.dep} → ${fp.arr}`,
    aircraft: `${fp.aircraft}/${fp.wake}`,
    rfl: rfl ? `FL${rfl}` : "?",
    currentAlt: pos.altitude ?? null,
    transferLevel: level.text,
    transferPoint: best.transferPoint,
    pointUnverified: usedFallback,
    labelFL,
    labelCheck,
    entryPoint: best.entry,
    eto: path.find((p) => (p.fix || p) === best.transferPoint)?.eto || null,
    nextStation: next.text,
    conditions,
    warnings,
    ref: `§${rule.ref}`,
    ruleId: rule.id,
    alternatives: candidates.slice(1, 3).map((c) => c.cop ? `${c.cop} (${c.rule.ref})` : `regle generale (${c.rule.ref})`),
  };
}

module.exports = { evaluate, resolveLevel, matchCop, toFL, fixesFromRoute, DB };
