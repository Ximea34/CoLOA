// preload.js — expose une surface minimale a la fenetre.
// Aucun acces direct a Node depuis le rendu : contextIsolation reste active.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("loa", {
  connect: () => ipcRenderer.send("connect"),
  disconnect: () => ipcRenderer.send("disconnect"),
  window: (action) => ipcRenderer.send("window", action),
  openDebug: () => ipcRenderer.send("debug:open"),
  onStatus: (cb) => ipcRenderer.on("status", (_e, data) => cb(data)),
  onRow: (cb) => ipcRenderer.on("row", (_e, data) => cb(data)),
  onAtc: (cb) => ipcRenderer.on("atc", (_e, data) => cb(data)),
  onSelection: (cb) => ipcRenderer.on("selection", (_e, data) => cb(data)),
  onTrouble: (cb) => ipcRenderer.on("trouble", (_e, data) => cb(data)),
});
