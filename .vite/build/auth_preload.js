"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("chatguessrApi", {
  startAuth() {
    electron.ipcRenderer.invoke("start-auth");
  },
  setSession(session) {
    electron.ipcRenderer.send("set-session", session);
  }
});
