// shell-renderer.js — fenetre de base : connexion Aurora, Debug, et gestion
// des modules en onglets (dockes ici en <webview>, ou detaches en fenetre a
// part via main.js). Fermer un onglet ne fait que retirer le <webview> —
// aucun redemarrage du processus.

const el = (id) => document.getElementById(id);
const tabStrip = el("tabStrip");
const content = el("content");
const emptyContent = el("emptyContent");

const LABELS = { loa: "Assistant LoA", aman: "AMAN", manuel: "Manuel", sim: "Simulateur" };

let connected = false;
const openModules = new Map(); // id -> { webview, tab }
let activeId = null;

el("connect").addEventListener("click", () => {
  connected ? window.shell.disconnect() : window.shell.connect();
});
el("debugOpen").addEventListener("click", () => window.shell.openDebug());

window.shell.onStatus((s) => {
  connected = s.state === "connected";
  el("connect").textContent = connected ? "Déconnecter" : "Connect to Aurora";
  el("connect").dataset.on = String(connected);
  el("station").textContent = s.station ? `Station ${s.station}` : "";
});

window.shell.onRedock(({ id }) => openModule(id));

document.querySelectorAll(".module-btn").forEach((btn) => {
  btn.addEventListener("click", () => openModule(btn.dataset.module));
});

async function openModule(id) {
  if (openModules.has(id)) {
    activate(id);
    return;
  }

  const { src, preload } = await window.shell.moduleInfo(id);
  if (openModules.has(id)) { activate(id); return; } // ouverture concurrente pendant l'attente

  const webview = document.createElement("webview");
  webview.setAttribute("src", src);
  webview.setAttribute("preload", preload);
  webview.className = "module-view";
  content.append(webview);

  const tab = document.createElement("div");
  tab.className = "tab";
  tab.innerHTML = `
    <span class="tab-label">${LABELS[id]}</span>
    <button class="tab-detach" title="Détacher dans sa propre fenêtre">⇱</button>
    <button class="tab-close" title="Fermer">×</button>
  `;
  tab.querySelector(".tab-label").addEventListener("click", () => activate(id));
  tab.querySelector(".tab-detach").addEventListener("click", (e) => { e.stopPropagation(); detach(id); });
  tab.querySelector(".tab-close").addEventListener("click", (e) => { e.stopPropagation(); close(id); });
  tabStrip.append(tab);

  openModules.set(id, { webview, tab });
  activate(id);
}

function activate(id) {
  activeId = id;
  emptyContent.hidden = true;
  for (const [otherId, m] of openModules) {
    m.webview.classList.toggle("active", otherId === id);
    m.tab.classList.toggle("active", otherId === id);
  }
}

function close(id) {
  const m = openModules.get(id);
  if (!m) return;
  m.webview.remove();
  m.tab.remove();
  openModules.delete(id);
  if (activeId === id) {
    const next = [...openModules.keys()][0] || null;
    if (next) activate(next);
    else { activeId = null; emptyContent.hidden = false; }
  }
}

// Detacher : demande a main.js d'ouvrir le module dans une vraie fenetre,
// puis retire l'onglet docke local — le module continue de vivre, juste
// ailleurs. Un clic sur "Rattacher" dans cette fenetre-la redemandera un
// onglet ici via onRedock.
function detach(id) {
  window.shell.undock(id);
  close(id);
}
