// manuel-preload.js — pont contextBridge pour la consultation manuelle.
// Aucune connexion Aurora requise : evaluate() tourne cote main sur un plan
// de vol fabrique a la main (dep/arr/point optionnel), pas des donnees reelles.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("manuel", {
  evaluate: (params) => ipcRenderer.invoke("manuel:evaluate", params),
  dock: () => ipcRenderer.send("module:dock", "manuel"),
});
