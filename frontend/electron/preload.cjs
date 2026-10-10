const { contextBridge, ipcRenderer } = require("electron");


contextBridge.exposeInMainWorld("notetaker", {
  config: () => ipcRenderer.invoke("config:get"),
  notify: (payload) => ipcRenderer.invoke("notification:show", payload),
  exportPdf: (options) => ipcRenderer.invoke("export:pdf", options),
  exportText: (options) => ipcRenderer.invoke("export:text", options),
  setCaptureState: (state) => ipcRenderer.send("capture:state", state),
  setDisplayAwake: (enabled) => ipcRenderer.send("display-awake:set", enabled),
  getLaunchAtLogin: () => ipcRenderer.invoke("login:get"),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke("login:set", enabled),
});
