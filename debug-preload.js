// debug-preload.js — pont contextBridge pour la fenetre de debug.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("debugApi", {
  onBacklog: (cb) => ipcRenderer.on("debug:backlog", (_e, entries) => cb(entries)),
  onEntry: (cb) => ipcRenderer.on("debug:entry", (_e, entry) => cb(entry)),
  clear: () => ipcRenderer.send("debug:clear"),
});
