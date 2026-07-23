// aman-preload.js — pont contextBridge pour la fenetre AMAN.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aman", {
  compute: (params) => ipcRenderer.invoke("aman:compute", params),
  getConfig: (airport) => ipcRenderer.invoke("aman:config", airport),
  dock: () => ipcRenderer.send("module:dock", "aman"),
  onStatus: (cb) => ipcRenderer.on("status", (_e, data) => cb(data)),
});
