// pipeline-test.js — reproduit la sequence exacte de main.js, sans Electron.
// Les erreurs ne sont PAS avalees : c'est tout l'interet.

require("./mock-aurora");
const { AuroraClient } = require("./aurora-client");
const { evaluate } = require("./loa-engine");

(async () => {
  const aurora = new AuroraClient();
  aurora.on("socket-error", (e) => console.error("[socket]", e.message));

  await aurora.connect();
  console.log("[ok] connecte");

  const me = await aurora.request("#CONN");
  const myStation = me.callsign;
  console.log("[ok] #CONN ->", myStation);

  const onlineATC = await aurora.request("#ATC").catch((e) => {
    console.error("[ECHEC] #ATC :", e.message);
    return [];
  });
  console.log("[ok] #ATC ->", JSON.stringify(onlineATC));

  const pos = await aurora.request("#TRPOS;%SELTFC%");
  console.log("[ok] scrutation ->", pos.callsign, "| label", pos.altLabel, "| assume", pos.assumedBy);

  const callsign = pos.callsign;
  console.log("\n--- buildRow, sans filet ---");

  const [fp, pathRec] = await Promise.all([
    aurora.request(`#FP;${callsign}`),
    aurora.request(`#TRPATHA;${callsign}`),
  ]);
  console.log("[ok] #FP ->", fp.dep, "->", fp.arr, "| RFL", fp.cruiseLevel);
  console.log("[ok] #TRPATHA ->", pathRec.path.map((p) => p.fix).join(" "));

  const result = evaluate({ myStation, fp, pos, path: pathRec.path, onlineATC });
  console.log("\n--- resultat ---");
  console.log(JSON.stringify(result, null, 2));

  aurora.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error("\n[EXCEPTION]", e.message);
  console.error(e.stack);
  process.exit(1);
});
