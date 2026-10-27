const { contextBridge, ipcRenderer } = require("electron");


contextBridge.exposeInMainWorld("notetaker", {
  setMeetingDetection: (enabled) => ipcRenderer.invoke("meeting:detection:set", enabled),
  activateMeetingCapture: () => ipcRenderer.invoke("meeting:capture:activate"),
  onMeetingDetection: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("meeting:detection", listener);
    return () => ipcRenderer.removeListener("meeting:detection", listener);
  },
  saveGitLabToken: (token) => ipcRenderer.invoke("gitlab:token", token),
  openGitLab: (url) => ipcRenderer.invoke("gitlab:open", url),
  config: () => ipcRenderer.invoke("config:get"),
  onNotificationOpen: (callback) => {
    const listener = (_event, target) => callback(target);
    ipcRenderer.on("notification:open", listener);
    return () => ipcRenderer.removeListener("notification:open", listener);
  },
  notify: (payload) => ipcRenderer.invoke("notification:show", payload),
  exportPdf: (options) => ipcRenderer.invoke("export:pdf", options),
  exportText: (options) => ipcRenderer.invoke("export:text", options),
  setCaptureState: (state) => ipcRenderer.send("capture:state", state),
  setTrayState: (state) => ipcRenderer.send("tray:state", state),
  onTrayCommand: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on("tray:command", listener);
    return () => ipcRenderer.removeListener("tray:command", listener);
  },
  setDisplayAwake: (enabled) => ipcRenderer.send("display-awake:set", enabled),
  getLaunchAtLogin: () => ipcRenderer.invoke("login:get"),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke("login:set", enabled),
});
