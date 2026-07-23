// aurora-client.js — client structuré pour le protocole 3rd party d'IVAO Aurora
//
// Usage comme module :
//   const { AuroraClient } = require("./aurora-client");
//   const aurora = new AuroraClient();
//   await aurora.connect();
//   const snap = await aurora.snapshot();   // avion sélectionné dans Aurora
//
// Usage direct (démo) :
//   node aurora-client.js
//   -> se connecte, puis affiche un résumé de l'avion sélectionné toutes les 3 s

const net = require("net");
const EventEmitter = require("events");

const HOST = "127.0.0.1";
const PORT = 1130;
const TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

// Indices vérifiés sur données réelles (2026-07-22).
// ATTENTION : la doc officielle inverse "flight type" et "flight rules".
function parseFP(f) {
  return {
    callsign: f[0],
    dep: f[1],
    arr: f[2],
    alternate: f[3],
    eobt: f[4],
    aircraft: f[5],
    wake: f[6],
    rules: f[7], // I / V / Y / Z
    flightType: f[8], // S / N / G / M / X
    equipment: f[9],
    cruiseLevel: f[10], // ex. F330
    cruiseSpeed: f[11], // ex. N0450
    endurance: f[12],
    eet: f[13],
    route: f[14],
    remarks: f[15],
  };
}

// La doc s'arrête au champ 18 ; les champs 20 et 21 sont non documentés.
// Le champ 21 est un taux vertical en ft/min (confirmé sur échantillons).
function parseTRPOS(f) {
  const num = (v) => (v === "" || v === undefined ? null : Number(v));
  return {
    callsign: f[0],
    heading: num(f[1]),
    track: num(f[2]),
    altitude: num(f[3]),
    groundSpeed: num(f[4]),
    lat: num(f[5]),
    lon: num(f[6]),
    squawkSet: f[7] || null,
    squawkLabel: f[8] || null,
    wpLabel: f[9] || null,
    altLabel: f[10] || null,
    spdLabel: f[11] || null,
    assumedBy: f[12] || null, // vide tant que le trafic n'est pas assumé
    nextStation: f[13] || null,
    onGround: f[14] === "1",
    isSelected: f[15] === "1",
    wasSelected: f[16] === "1",
    gate: f[17] || null,
    voice: f[18] || null,
    unknown20: f[19] || null,
    verticalSpeed: num(f[20]), // ft/min, > 0 montée, < 0 descente
  };
}

// Format : FIX:ETO — Aurora développe les airways en points intermédiaires.
function parseTRPATHL(f) {
  const [callsign, ...points] = f;
  return {
    callsign,
    path: points
      .filter(Boolean)
      .map((p) => {
        const [fix, eto] = p.split(":");
        return { fix, eto: eto === "-" ? null : eto };
      }),
  };
}

// Format : STATION:FREQ
function parseATC(f) {
  return f.filter(Boolean).map((entry) => {
    const [station, freq] = entry.split(":");
    return { station, freq };
  });
}

const PARSERS = {
  "#FP": parseFP,
  "#TRPOS": parseTRPOS,
  "#TRPATHL": parseTRPATHL,
  "#TRPATHA": parseTRPATHL, // meme format FIX:ETO, inclut aussi les points survoles (ETO "-")
  "#TR": (f) => f.filter(Boolean), // liste brute des indicatifs visibles
  "#ATC": parseATC,
  "#ATCT": parseATC,
  "#CONN": (f) => ({ callsign: f[0] }),
  "#SELTFC": (f) => ({ callsign: f[0] }),
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

class AuroraClient extends EventEmitter {
  constructor({ host = HOST, port = PORT } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.socket = null;
    this.buffer = "";
    this.pending = new Map(); // commande -> file de resolvers
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ host: this.host, port: this.port });
      this.socket.setEncoding("ascii");

      this.socket.once("connect", () => {
        this.emit("connected");
        resolve();
      });

      this.socket.once("error", reject);
      // 'error' est un evenement special d'EventEmitter : l'emettre sans
      // ecouteur fait planter le process. On utilise un nom neutre.
      this.socket.on("error", (e) => this.emit("socket-error", e));
      this.socket.on("close", () => this.emit("disconnected"));
      this.socket.on("data", (chunk) => this._onData(chunk));
    });
  }

  disconnect() {
    if (this.socket) this.socket.end();
  }

  _onData(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop();
    for (const line of lines) {
      if (line.trim()) this._onLine(line.trim());
    }
  }

  _onLine(line) {
    const fields = line.split(";");
    const cmd = fields.shift();

    // Message d'erreur du serveur. Sa forme est "@ERR;#CMD;ARG;raison" : le
    // premier champ nomme la commande fautive, on rejette CETTE requete et pas
    // la plus ancienne venue — sinon un refus tue une requete valide.
    if (cmd.startsWith("@") || cmd.startsWith("$") || cmd.includes("ERR")) {
      const failed = fields[0];
      const queue = this.pending.get(failed);
      if (queue && queue.length) {
        queue.shift().reject(new Error(line));
      } else {
        const any = [...this.pending.values()].find((q) => q.length);
        if (any) any.shift().reject(new Error(line));
      }
      this.emit("server-error", line);
      return;
    }

    const parser = PARSERS[cmd];
    const payload = parser ? parser(fields) : fields;
    this.emit("message", { cmd, payload, raw: line });

    const queue = this.pending.get(cmd);
    if (queue && queue.length) queue.shift().resolve(payload);
  }

  // Envoi sans attendre de réponse (ex. #LBALT, #TRTR).
  send(command) {
    this.emit("send", command);
    this.socket.write(command + "\r\n");
  }

  // Envoi avec attente de la réponse correspondante.
  request(command) {
    const key = command.split(";")[0];
    return new Promise((resolve, reject) => {
      if (!this.pending.has(key)) this.pending.set(key, []);
      const queue = this.pending.get(key);
      const entry = { resolve, reject };
      queue.push(entry);

      setTimeout(() => {
        const i = queue.indexOf(entry);
        if (i !== -1) {
          queue.splice(i, 1);
          reject(new Error(`Timeout sur ${key}`));
        }
      }, TIMEOUT_MS);

      this.send(command);
    });
  }

  // Agrège tout ce qu'il faut pour évaluer une LOA.
  // Sans argument : utilise l'avion sélectionné via la macro %SELTFC%.
  async snapshot(callsign = "%SELTFC%") {
    const [fp, pos, path] = await Promise.all([
      this.request(`#FP;${callsign}`),
      this.request(`#TRPOS;${callsign}`),
      this.request(`#TRPATHA;${callsign}`),
    ]);
    return { fp, pos, path: path.path };
  }
}

module.exports = { AuroraClient, parseFP, parseTRPOS, parseTRPATHL, parseATC };

// ---------------------------------------------------------------------------
// Démo
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    const aurora = new AuroraClient();

    try {
      await aurora.connect();
    } catch (e) {
      console.error(`[ERREUR] Connexion impossible : ${e.message}`);
      console.error("Aurora lancé ? '3rd Party Software Access' sur YES ?");
      process.exit(1);
    }

    const me = await aurora.request("#CONN");
    console.log(`[OK] Connecté. Station : ${me.callsign}\n`);
    console.log("Sélectionne un avion dans Aurora. Ctrl+C pour quitter.\n");

    setInterval(async () => {
      try {
        const { fp, pos, path } = await aurora.snapshot();
        const vs =
          pos.verticalSpeed === null
            ? "?"
            : Math.abs(pos.verticalSpeed) < 300
            ? "stable"
            : pos.verticalSpeed > 0
            ? `montée ${pos.verticalSpeed} ft/min`
            : `descente ${pos.verticalSpeed} ft/min`;

        console.log("─".repeat(64));
        console.log(`${fp.callsign}  ${fp.aircraft}/${fp.wake}  ${fp.dep} → ${fp.arr}`);
        console.log(`  ${pos.altitude} ft (${vs})  ${pos.groundSpeed} kt  cap ${pos.heading}`);
        console.log(`  Croisière déposée : ${fp.cruiseLevel}`);
        console.log(`  Assumé par : ${pos.assumedBy || "—"}   Next : ${pos.nextStation || "—"}`);
        console.log(`  Route restante : ${path.map((p) => p.fix).join(" ")}`);
      } catch (e) {
        // Aucun avion sélectionné : la macro fait ignorer la commande côté serveur.
        if (!e.message.startsWith("Timeout")) console.error(e.message);
      }
    }, 3000);
  })();
}
