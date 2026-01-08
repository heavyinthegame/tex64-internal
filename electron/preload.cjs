const { contextBridge, ipcRenderer } = require("electron");

let postMessageHandler = (payload) => {
  ipcRenderer.send("tex180", payload);
};

const isE2E = process.env.TEX180_E2E === "1";

const bridgeApi = {
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
};

Object.defineProperty(bridgeApi, "postMessage", {
  get: () => postMessageHandler,
  set: (next) => {
    if (typeof next === "function") {
      postMessageHandler = next;
    }
  },
  enumerable: true,
});

if (isE2E) {
  globalThis.tex180Bridge = bridgeApi;
} else {
  contextBridge.exposeInMainWorld("tex180Bridge", bridgeApi);
}
