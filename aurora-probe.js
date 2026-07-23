// aurora-probe.js — sonde du protocole "3rd Party Software" d'IVAO Aurora
//
// Prérequis :
//   1. Node.js LTS installé (https://nodejs.org)
//   2. Aurora lancé et connecté au réseau
//   3. PVD > Settings (F7) > Other > "3rd Party Software Access" = YES
//
// Usage : node aurora-probe.js
//
// Commandes dans le REPL :
//   go            -> interroge l'avion actuellement sélectionné dans Aurora
//   #CONN         -> ton propre callsign ATC
//   #TR           -> liste des trafics visibles
//   #ATC          -> ATC en ligne + fréquences
//   #FP;AFR123    -> plan de vol d'un callsign précis
//   quit          -> quitter

const net = require("net");
const readline = require("readline");

const HOST = "127.0.0.1";
const PORT = 1130;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "aurora> ",
});

const socket = net.createConnection({ host: HOST, port: PORT });
socket.setEncoding("ascii");

let buffer = "";

socket.on("connect", () => {
  console.log(`[OK] Connecté à Aurora sur ${HOST}:${PORT}`);
  console.log("Tape 'go' pour interroger l'avion sélectionné, ou une commande brute.\n");
  send("#CONN");
  rl.prompt();
});

// Le protocole délimite les paquets par CR/LF. On bufferise les fragments TCP.
socket.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop();
  lines.filter((l) => l.trim()).forEach((l) => handle(l.trim()));
});

socket.on("error", (err) => {
  console.error(`[ERREUR] ${err.message}`);
  console.error("Vérifie qu'Aurora tourne et que '3rd Party Software Access' est sur YES.");
  process.exit(1);
});

socket.on("close", () => {
  console.log("[INFO] Connexion fermée.");
  process.exit(0);
});

function send(cmd) {
  console.log(`>> ${cmd}`);
  socket.write(cmd + "\r\n");
}

// Affiche chaque champ numéroté pour identifier facilement la structure des réponses.
function handle(line) {
  const parts = line.split(";");
  const cmd = parts.shift();
  console.log(`\n<< ${cmd}`);
  parts.forEach((value, i) => {
    if (value !== "") console.log(`   [${i + 1}] ${value}`);
  });
  console.log("");
  rl.prompt();
}

rl.on("line", (input) => {
  const text = input.trim();
  if (!text) return rl.prompt();

  if (text === "quit") {
    socket.end();
    return;
  }

  if (text === "go") {
    // %SELTFC% est remplacé côté Aurora par le callsign de l'avion sélectionné.
    // La commande est ignorée si aucun trafic n'est sélectionné.
    ["#FP;%SELTFC%", "#TRPOS;%SELTFC%", "#TRPATHA;%SELTFC%"].forEach(send);
    return rl.prompt();
  }

  send(text);
  rl.prompt();
});
