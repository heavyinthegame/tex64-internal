const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tex180Bridge", {
  postMessage: (payload) => {
    ipcRenderer.send("tex180", payload);
  },
  onMessage: (handler) => {
    if (typeof handler !== "function") {
      return () => {};
    }
    const listener = (_event, message) => {
      handler(message);
    };
    ipcRenderer.on("tex180:message", listener);
    return () => {
      ipcRenderer.removeListener("tex180:message", listener);
    };
  },
});
