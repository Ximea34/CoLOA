// loa-cli.js — assistant LOA temps reel pour Marseille ACC
//
// Usage : node loa-cli.js
//   Selectionne un avion dans Aurora, puis appuie sur Entree ici.
//   'a' + Entree pour rafraichir la liste des ATC en ligne.
//   'q' + Entree pour quitter.

const readline = require("readline");
const { AuroraClient } = require("./aurora-client");
const { evaluate } = require("./loa-engine");

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};

(async () => {
  const aurora = new AuroraClient();

  try {
    await aurora.connect();
  } catch (e) {
    console.error(`${C.red}Connexion impossible : ${e.message}${C.reset}`);
    console.error("Aurora lance ? '3rd Party Software Access' sur YES ?");
    process.exit(1);
  }

  const me = await aurora.request("#CONN");
  const myStation = me.callsign;
  let onlineATC = await aurora.request("#ATC").catch(() => []);

  console.log(`${C.bold}Assistant LOA — ${myStation}${C.reset}`);
  console.log(`${C.dim}${onlineATC.length} ATC en ligne. Entree = interroger l'avion selectionne.${C.reset}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.on("line", async (input) => {
    const cmd = input.trim().toLowerCase();

    if (cmd === "q") return aurora.disconnect();

    if (cmd === "a") {
      onlineATC = await aurora.request("#ATC").catch(() => []);
      console.log(`${C.dim}ATC en ligne : ${onlineATC.map((a) => a.station).join(", ") || "aucun"}${C.reset}\n`);
      return;
    }

    let snap;
    try {
      snap = await aurora.snapshot();
    } catch (e) {
      console.log(`${C.yellow}Aucun avion selectionne dans Aurora.${C.reset}\n`);
      return;
    }

    const r = evaluate({ myStation, fp: snap.fp, pos: snap.pos, path: snap.path, onlineATC });

    console.log("─".repeat(58));
    if (!r.matched) {
      console.log(`${C.bold}${r.callsign}${C.reset}  ${r.route}`);
      console.log(`${C.yellow}${r.message}${C.reset}`);
      console.log(`${C.dim}${r.hint}${C.reset}`);
      console.log(`${C.dim}Route restante : ${r.remaining.join(" ")}${C.reset}\n`);
      return;
    }

    console.log(`${C.bold}${r.callsign}${C.reset}  ${r.aircraft}  ${r.route}   RFL ${r.rfl}`);
    console.log(`  ${C.bold}${C.green}XFL${C.reset}       ${C.bold}${r.transferLevel}${C.reset}`);
    console.log(`  ${C.bold}${C.cyan}POINT${C.reset}     ${r.transferPoint}${r.eto ? `   ETO ${r.eto}` : ""}`);
    console.log(`  ${C.bold}NEXT${C.reset}      ${r.nextStation}`);
    if (r.labelCheck === "ok") console.log(`  ${C.green}LABEL     FL${r.labelFL} conforme${C.reset}`);
    if (r.labelCheck === "empty") console.log(`  ${C.yellow}LABEL     vide${C.reset}`);
    if (r.labelCheck === "mismatch") console.log(`  ${C.red}${C.bold}LABEL     FL${r.labelFL} — ECART${C.reset}`);
    for (const c of r.conditions) {
      if (c.startsWith("Label")) continue;
      console.log(`  ${C.dim}·${C.reset} ${c}`);
    }
    for (const w of r.warnings) {
      if (w.startsWith("Label")) continue;
      console.log(`  ${C.red}! ${w}${C.reset}`);
    }
    console.log(`  ${C.dim}${r.ref}${C.reset}\n`);
  });

  aurora.on("disconnected", () => {
    console.log("Deconnecte.");
    process.exit(0);
  });
})();
