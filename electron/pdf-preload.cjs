const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tex64Pdf", {
  postMessage: (payload) => {
    ipcRenderer.send("tex64:pdf", payload);
  },
  onMessage: (handler) => {
    if (typeof handler !== "function") {
      return () => {};
    }
    const listener = (_event, message) => {
      handler(message);
    };
    ipcRenderer.on("tex64:pdf-message", listener);
    return () => {
      ipcRenderer.removeListener("tex64:pdf-message", listener);
    };
  },
});
