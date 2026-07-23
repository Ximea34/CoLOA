// sim-preload.js — pont contextBridge pour le simulateur de trafic.
// Aucune connexion Aurora requise : place des avions fictifs pour tester
// l'AMAN quand le trafic reel est trop rare.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sim", {
  getPoints: (airport) => ipcRenderer.invoke("sim:points", airport),
  getGates: (airport, runwayConfig) => ipcRenderer.invoke("aman:gates", { airport, runwayConfig }),
  add: (ac) => ipcRenderer.invoke("sim:add", ac),
  update: (callsign, patch) => ipcRenderer.invoke("sim:update", { callsign, patch }),
  remove: (callsign) => ipcRenderer.invoke("sim:remove", callsign),
  list: () => ipcRenderer.invoke("sim:list"),
  setTimeScale: (scale) => ipcRenderer.invoke("sim:setTimeScale", scale),
  followProcedure: (callsign) => ipcRenderer.invoke("sim:followProcedure", callsign),
  captureIls: (callsign) => ipcRenderer.invoke("sim:captureIls", callsign),
  dock: () => ipcRenderer.send("module:dock", "sim"),
});
