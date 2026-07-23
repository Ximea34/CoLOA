process.env.NO_PATH = "1";
require("./mock-aurora");
const { AuroraClient } = require("./aurora-client");
const { evaluate, fixesFromRoute } = require("./loa-engine");

(async () => {
  const a = new AuroraClient();
  a.on("socket-error", () => {});
  await a.connect();
  const myStation = (await a.request("#CONN")).callsign;
  const onlineATC = await a.request("#ATC").catch(() => []);
  const pos = await a.request("#TRPOS;%SELTFC%");

  const [fpRes, pathRes] = await Promise.allSettled([
    a.request(`#FP;${pos.callsign}`),
    a.request(`#TRPATHA;${pos.callsign}`),
  ]);

  console.log("#FP      :", fpRes.status);
  console.log("#TRPATHA :", pathRes.status, pathRes.reason ? "-> " + pathRes.reason.message : "");

  const fp = fpRes.value;
  const path = fixesFromRoute(fp.route).map((fix) => ({ fix, eto: null }));
  console.log("repli    :", path.map(p => p.fix).join(" "));

  const r = evaluate({ myStation, fp, pos, path, onlineATC });
  console.log("\nLIGNE PRODUITE");
  console.log("  " + r.callsign + "  " + r.route + "  RFL " + r.rfl);
  console.log("  XFL   :", r.transferLevel);
  console.log("  POINT :", r.transferPoint, r.eto ? "ETO " + r.eto : "(pas d'ETO)");
  console.log("  NEXT  :", r.nextStation);
  console.log("  " + r.ref);
  a.disconnect(); process.exit(0);
})().catch(e => { console.error("EXCEPTION", e.message); process.exit(1); });
