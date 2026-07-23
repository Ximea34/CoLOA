// launcher-preload.js — pont contextBridge pour l'ecran de lancement.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("launcher", {
  openLoa: () => ipcRenderer.send("launch:loa"),
  openAman: () => ipcRenderer.send("launch:aman"),
});
