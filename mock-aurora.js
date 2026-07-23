// mock-aurora.js — rejoue les reponses reelles capturees en session.
// Sert a tester la chaine complete sans Aurora.

const net = require("net");

const FP =
  "#FP;RYR1541;LFMN;LFLL;LFML;0710;B738;M;I;S;SDE2E3FGHIRWXY;F200;N0384;0211;0044;" +
  "BODRU DCT KOTIT/N0372F180 Y42 LASUR Z42 PINED;" +
  "PBN/A1B1C1D1S1S2 DOF/260722 REG/N806SB EET/LFFF0008 LFMM0025 OPR/RYR PER/C RMK/TCAS SIMBRIEF";

const TRPOS =
  "#TRPOS;RYR1541;307;309;19598;347;44.447416;5.963411;1000;;BODRU8A 04R;130;;LFMM_W_CTR;;0;1;1;;1;;-108";

const TRPATHA = "#TRPATHA;RYR1541;BODRU:-;KOTIT:0721;LASUR:0722;PINED:0726;LFLL:0734";

const server = net.createServer((socket) => {
  socket.setEncoding("ascii");
  let buffer = "";

  socket.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();

    for (const line of lines.filter((l) => l.trim())) {
      const cmd = line.trim().split(";")[0];
      const reply =
        cmd === "#CONN" ? "#CONN;LFMM_MM_OBS"
        : cmd === "#ATC" ? "#ATC;LFMM_W_CTR:132.365;LFLL_APP:136.075"
        : cmd === "#TRPOS" ? TRPOS
        : cmd === "#FP" ? FP
        : cmd === "#TRPATHA" ? (process.env.NO_PATH ? "@ERR;#TRPATHA;RYR1541;Unknown command" : TRPATHA)
        : null;
      if (reply) socket.write(reply + "\r\n");
    }
  });
});

server.listen(1130, "127.0.0.1", () => console.log("[mock] Aurora simule sur 1130"));
module.exports = { server };
