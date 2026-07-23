// shell-preload.js — pont contextBridge pour la fenetre de base.
// Connexion Aurora et Debug sont centralises ici ; les modules (docked ou
// non) n'en ont plus besoin dans leur propre UI.
//
// Aucun require("path")/require("url") ici : Electron sandbox les scripts de
// preload par defaut, et seul un sous-ensemble limite de modules Node y est
// autorise (path/url n'en font pas partie) — un require interdit fait
// echouer tout le script silencieusement, empechant contextBridge de
// s'executer. La resolution des chemins de module se fait donc cote main.js
// (acces Node complet), relayee ici par un simple IPC.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shell", {
  connect: () => ipcRenderer.send("connect"),
  disconnect: () => ipcRenderer.send("disconnect"),
  openDebug: () => ipcRenderer.send("debug:open"),
  undock: (id) => ipcRenderer.send("module:undock", id),
  onStatus: (cb) => ipcRenderer.on("status", (_e, data) => cb(data)),
  onRedock: (cb) => ipcRenderer.on("module:redock", (_e, data) => cb(data)),
  moduleInfo: (id) => ipcRenderer.invoke("module:info", id),
});
