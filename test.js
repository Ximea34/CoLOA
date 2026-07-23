const { evaluate } = require("./loa-engine");

const onlineATC = [
  { station: "LFMM_W_CTR", freq: "132.365" },
  { station: "LFMM_E_CTR", freq: "127.905" },
  { station: "LFML_APP", freq: "121.430" },
];

const cases = [
  {
    title: "SIA0542 — donnee reelle Aurora (LEBL->LIPE, croisiere FL340)",
    myStation: "LFMM_W_CTR",
    fp: { callsign: "SIA0542", dep: "LEBL", arr: "LIPE", aircraft: "A359", wake: "H", cruiseLevel: "F340" },
    pos: { altitude: 34007, verticalSpeed: -96, assumedBy: null },
    path: "STP:0643 RAPED:0645 PIGOS:0648 EKSID:0650 NOSTA:0650 NOPMU:0652 KALMO:0701 OLNUK:0706 NIGSO:0707",
  },
  {
    title: "VOE8569 — donnee reelle Aurora (LFLL->LIPZ, hors LOA attendu)",
    myStation: "LFMM_W_CTR",
    fp: { callsign: "VOE8569", dep: "LFLL", arr: "LIPZ", aircraft: "A320", wake: "M", cruiseLevel: "F330" },
    pos: { altitude: 18035, verticalSpeed: 2256 },
    path: "RISOR:0641 LAMDO:0642 GEMLA:0643 VANAS:0646 MEDAM:0648 NITAM:0650 MOGBO:0652 ASTIG:0657 RIPDU:0711 BOA:0716 SUKOM:0718",
  },
  {
    title: "Test exception ARR — meme COP, destination LIMG",
    myStation: "LFMM_W_CTR",
    fp: { callsign: "AZA123", dep: "LEBL", arr: "LIMG", aircraft: "A320", wake: "M", cruiseLevel: "F340" },
    pos: { altitude: 34000, verticalSpeed: 0 },
    path: "STP:0643 PIGOS:0648 NOSTA:0650",
  },
  {
    title: "Test parite non conforme — MAXIR-LUSOL, RFL impair mais pair exige",
    myStation: "LFMM_W_CTR",
    fp: { callsign: "SWR55", dep: "LFPG", arr: "LSZH", aircraft: "A220", wake: "M", cruiseLevel: "F310" },
    pos: { altitude: 31000, verticalSpeed: 0 },
    path: "MAXIR:0700 LUSOL:0705",
  },
  {
    title: "Test arrivee APP — LFML via MTL",
    myStation: "LFMM_W_CTR",
    fp: { callsign: "AFR7712", dep: "LFPO", arr: "LFML", aircraft: "A320", wake: "M", cruiseLevel: "F340" },
    pos: { altitude: 28000, verticalSpeed: -1800 },
    path: "MEN:0630 MTL:0641 ORDIF:0645",
  },
  {
    title: "Test top-down — LFLL_APP hors ligne",
    myStation: "LFMM_W_CTR",
    fp: { callsign: "EZY84DK", dep: "LFML", arr: "LFLL", aircraft: "A320", wake: "M", cruiseLevel: "F280" },
    pos: { altitude: 22000, verticalSpeed: -2000 },
    path: "ARBON:0655 LL103:0700",
  },
];

for (const c of cases) {
  const path = c.path.split(" ").map((p) => {
    const [fix, eto] = p.split(":");
    return { fix, eto };
  });
  const r = evaluate({ myStation: c.myStation, fp: c.fp, pos: c.pos, path, onlineATC });

  console.log("=".repeat(70));
  console.log(c.title);
  console.log("-".repeat(70));
  if (!r.matched) {
    console.log(`${r.callsign}  ${r.route}`);
    console.log(`  ${r.message}`);
    console.log(`  ${r.hint}`);
    console.log(`  Route restante : ${r.remaining.join(" ")}`);
  } else {
    console.log(`${r.callsign}  ${r.aircraft}  ${r.route}   RFL ${r.rfl}`);
    console.log(`  XFL          : ${r.transferLevel}`);
    console.log(`  Point        : ${r.transferPoint}${r.eto ? "  ETO " + r.eto : ""}`);
    console.log(`  Suivant      : ${r.nextStation}`);
    if (r.conditions.length) console.log(`  Conditions   : ${r.conditions.join(" | ")}`);
    if (r.warnings.length) console.log(`  ATTENTION    : ${r.warnings.join(" | ")}`);
    console.log(`  Reference    : ${r.ref} (${r.ruleId})`);
    if (r.alternatives.length) console.log(`  Autres COP   : ${r.alternatives.join(", ")}`);
  }
  console.log("");
}
