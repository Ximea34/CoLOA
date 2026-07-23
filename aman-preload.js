// aman-preload.js — pont contextBridge pour la fenetre AMAN.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aman", {
  compute: (params) => ipcRenderer.invoke("aman:compute", params),
  getConfig: (airport) => ipcRenderer.invoke("aman:config", airport),
  connect: () => ipcRenderer.send("connect"),
  disconnect: () => ipcRenderer.send("disconnect"),
  onStatus: (cb) => ipcRenderer.on("status", (_e, data) => cb(data)),
});
