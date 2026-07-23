// loa-engine.js — moteur de resolution des LOA de Marseille ACC
//
// evaluate({ myStation, fp, pos, path, onlineATC }) -> resultat structure
//
// Principe : on cherche le COP de la LOA le plus proche sur la route restante,
// on applique les exceptions par aerodrome de depart/arrivee, puis on resout
// la parite du niveau et la station suivante reellement en ligne.

const path = require("path");
const { loadAll } = require("./loa-loader");
const { loadStars, resolveStarCop } = require("./star-loader");

const DB = loadAll(path.join(__dirname, "loa"));
const STAR_DB = loadStars(path.join(__dirname, "STAR"));

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

// Fusionne le niveau d'une exception sur celui de la regle de base. Les 3
// "modes" (coordination / fl / parity) sont exclusifs entre eux dans
// resolveLevel() : si l'exception impose un mode different de celui de la
// base, il doit le remplacer entierement plutot que s'y ajouter — sinon un
// "coordination" herite de la base fait ignorer un "fl" pourtant plus precis
// fixe par l'exception (resolveLevel verifie coordination avant fl).
function mergeLevel(base, override) {
  const merged = { ...base, ...override };
  const modes = ["coordination", "fl", "parity"];
  const overrideMode = modes.find((m) => override[m] !== undefined);
  if (overrideMode) {
    for (const m of modes) {
      if (m !== overrideMode) delete merged[m];
    }
  }
  return merged;
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

// --- classification du vol : arrivee / depart / interne / transit ----------
//
// Un controleur LFMM_W_CTR se demande d'abord "quel est le role de ce vol
// pour moi ?" avant de chercher une regle — jamais l'inverse. Chercher une
// regle sur TOUTE la base (comme avant) laissait une regle de reception
// d'une autre FIR (ex. lsag-balsi, from: LSAG) ou une regle non filtree
// (ex. mmw-brusc, sans "when" du tout) remonter par coincidence de COP,
// masquant la regle interne pourtant seule pertinente pour ce controleur.

// Normalise un "from"/"myStation" en secteur Marseille ("LFMM_W"/"LFMM_E"),
// en tolerant que les fichiers LOA ecrivent le nom complet de la station
// (ex. "LFMM_W_CTR") au lieu de l'abreviation attendue par convention. Toute
// autre valeur (LSAG, DAAA_CTR, LIRR_NE_CTR...) est laissee telle quelle —
// elle ne doit jamais etre confondue avec un secteur Marseille, sinon on
// recree le bug des regles de reception d'une autre FIR qui matchaient a tort.
function sectorOf(station) {
  const s = String(station || "");
  if (s.startsWith("LFMM_W")) return "LFMM_W";
  if (s.startsWith("LFMM_E")) return "LFMM_E";
  return s;
}

// Aerodromes dont l'approche est geree par un secteur donne : derive des
// regles "acc-*" elles-memes (from: secteur, to: *_APP) plutot que code en
// dur, pour rester a jour si de nouvelles arrivees sont ajoutees a la LOA.
function computeHomeAirports(rules) {
  const bySector = new Map();
  for (const rule of rules) {
    if (!/_APP$/.test(rule.to || "")) continue;
    const sector = sectorOf(rule.from);
    if (!bySector.has(sector)) bySector.set(sector, new Set());
    const set = bySector.get(sector);
    for (const a of rule.when?.arr || []) set.add(a);
  }
  return bySector;
}

const HOME_AIRPORTS = computeHomeAirports(DB.rules);

// Regle 1 (arrivee) / Regle 3 (vol interne, traite comme une arrivee, jamais
// de phase depart separee) / Regle 2 (depart) / Regle 4 (transit, "sinon").
function classify(fp, mySector) {
  const home = HOME_AIRPORTS.get(mySector) || new Set();
  if (home.has(fp.arr)) return "arrival";
  if (home.has(fp.dep)) return "departure";
  return "transit";
}

// Regles 1 & 3 : uniquement les regles acc-* de MON secteur pour CET
// aeroport d'arrivee. Jamais une regle d'une autre FIR — structurellement
// impossible ici, contrairement a l'ancien tri global.
function arrivalCandidates(rules, mySector, fp, fixes) {
  const destRules = rules.filter(
    (rule) =>
      sectorOf(rule.from) === mySector &&
      /_APP$/.test(rule.to || "") &&
      (rule.when?.arr || []).includes(fp.arr)
  );

  const candidates = [];
  for (const rule of destRules) {
    for (const cop of rule.cop || []) {
      const m = matchCop(cop, fixes);
      if (m) candidates.push({ rule, cop, ...m });
    }
  }

  // Rien trouve litteralement : le plan de vol s'arrete au point de
  // transition (ex. LESPI) et n'atteint jamais le COP reel (ex. TALAR), qui
  // n'existe que developpe sur la STAR — jamais visible via #TRPATHA tant
  // que l'avion n'y est pas engage. On le retrouve via STAR/*.str : dernier
  // fixe connu -> point(s) final(aux) reel(s) de la STAR. Si la config piste
  // change l'issue (deux points differents), les DEUX sont retenus comme
  // candidats plutot que d'en deviner un — celui qui n'est pas choisi
  // apparait comme alternative.
  if (!candidates.length) {
    const enroute = fixes.filter((f) => f !== fp.arr);
    const lastFix = enroute[enroute.length - 1];
    for (const { cop, runways, starName } of resolveStarCop(STAR_DB, fp.arr, lastFix)) {
      const owningRule = destRules.find((r) => (r.cop || []).includes(cop));
      if (!owningRule) continue; // COP reel pas encore code dans une regle : rien a afficher de fiable
      candidates.push({
        rule: owningRule, cop, tier: 1, index: enroute.length - 1,
        transferPoint: cop, entry: lastFix,
        inferredVia: `${lastFix} → ${starName} (${runways})`,
      });
    }
  }

  // Toujours rien : repli generique si une regle de cet aeroport le prevoit.
  if (!candidates.length) {
    for (const rule of destRules) {
      if (rule.fallback) {
        candidates.push({ rule, cop: null, tier: 2, index: Infinity, transferPoint: null, entry: null });
      }
    }
  }

  candidates.sort((a, b) => a.tier - b.tier || a.index - b.index);
  return candidates;
}

// Regles 2 & 4 : recherche du COP de sortie. On ne considere QUE les regles
// sortantes de mon secteur (rule.from === mySector) — jamais une regle de
// reception d'une autre FIR — et parmi les cop trouves sur la route, on
// retient celui qui apparait le PLUS TARD dans l'ordre du plan de vol (le
// plus proche de la sortie reelle de mon espace), pas le plus proche du
// depart. D'ou l'index DESCENDANT, a l'inverse du tri des arrivees.
function exitCandidates(rules, mySector, fixes) {
  const candidates = [];
  for (const rule of rules) {
    if (sectorOf(rule.from) !== mySector) continue;
    // Les regles "to: *_APP" sont des transferts d'arrivee (Regles 1/3) —
    // jamais un COP de sortie vers un autre secteur/FIR (Regles 2/4).
    if (/_APP$/.test(rule.to || "")) continue;
    let matchedAny = false;
    for (const cop of rule.cop || []) {
      const m = matchCop(cop, fixes);
      if (m) { candidates.push({ rule, cop, ...m }); matchedAny = true; }
    }
    if (!matchedAny && rule.fallback) {
      candidates.push({ rule, cop: null, tier: 2, index: -Infinity, transferPoint: null, entry: null });
    }
  }
  candidates.sort((a, b) => a.tier - b.tier || b.index - a.index);
  return candidates;
}

// --- moteur ----------------------------------------------------------------

function evaluate({ myStation, fp, pos = {}, path = [], onlineATC = [] }) {
  const fixes = path.map((p) => (typeof p === "string" ? p : p.fix));
  const rfl = toFL(fp.cruiseLevel);
  // myStation (ex. LFMM_MM_OBS en observateur) doit rester permissif : tout
  // ce qui n'est pas explicitement LFMM_E retombe sur LFMM_W, contrairement a
  // sectorOf() qui elle reste stricte pour rule.from (jamais confondre une
  // FIR etrangere avec mon propre secteur).
  const mySector = myStation.startsWith("LFMM_E") ? "LFMM_E" : "LFMM_W";

  const kind = classify(fp, mySector);
  const candidates = kind === "arrival"
    ? arrivalCandidates(DB.rules, mySector, fp, fixes)
    : exitCandidates(DB.rules, mySector, fixes);

  // Trace de decision : jamais utilise pour decider quoi que ce soit (ca
  // resterait a lire l'etat apres coup), seulement pour que la fenetre debug
  // puisse montrer POURQUOI cette regle-la a ete retenue plutot qu'une autre.
  const trace = [
    `Classification : ${kind} (dep=${fp.dep}, arr=${fp.arr}, secteur=${mySector})`,
    `${candidates.length} candidat(s) dans le sous-ensemble "${kind}"`,
  ];
  const fmtIndex = (i) => (i === Infinity || i === -Infinity ? "n/a" : i);
  candidates.slice(0, 5).forEach((c, i) => {
    const cop = c.cop || "(regle generale, sans cop)";
    const via = c.inferredVia ? ` [inference STAR : ${c.inferredVia}]` : "";
    trace.push(
      `  ${i === 0 ? "-> retenu" : "   alternative"} : ${c.rule.id} — cop ${cop}, tier ${c.tier}, index ${fmtIndex(c.index)}${via}`
    );
  });

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
      trace,
    };
  }

  const best = candidates[0];
  const usedFallback = best.tier === 2;
  const rule = best.rule;

  // Exceptions d'abord, defaut ensuite. L'exception complete la regle de base
  // (ex. un plafond qui vient s'ajouter a la parite), elle ne la remplace que
  // sur les champs qu'elle precise explicitement.
  const exception = (rule.exceptions || []).find((e) => whenMatches(e.when, fp));
  const levelSpec = exception ? mergeLevel(rule.level, exception.level) : rule.level;
  const level = resolveLevel(levelSpec, rfl);

  if (usedFallback) trace.push("Repli : aucun cop de cette regle trouve sur la route, clause generale appliquee");
  trace.push(
    exception
      ? `Exception retenue : ${JSON.stringify(exception.when)} -> ${JSON.stringify(exception.level)}`
      : "Aucune exception applicable, niveau de base de la regle"
  );

  const next = resolveStation(rule.to, onlineATC, myStation);

  // rule.from === mySector est garanti par construction (arrivalCandidates
  // et exitCandidates ne considerent que les regles sortantes de mon
  // secteur) : plus besoin de signaler un ecart de secteur ici.
  const warnings = [...level.warnings];
  if (rule.verify) warnings.push(`Regle a verifier : ${rule.verify}`);
  if (exception && exception.verify) warnings.push("Exception issue d'une cellule PDF ambigue.");

  const conditions = [];
  if (usedFallback) {
    conditions.push(
      "Aucun COP reconnu sur la route — regle appliquee via sa clause generale, point de transfert non identifie"
    );
  }
  if (best.inferredVia) {
    conditions.push(`COP deduit via la STAR — pas encore franchi sur la route (${best.inferredVia})`);
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
    trace,
  };
}

module.exports = { evaluate, resolveLevel, matchCop, toFL, fixesFromRoute, DB };
