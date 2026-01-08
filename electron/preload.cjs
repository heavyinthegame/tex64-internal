const { contextBridge, ipcRenderer } = require("electron");

let postMessageHandler = (payload) => {
  ipcRenderer.send("tex64", payload);
};

const isE2E = process.env.TEX180_E2E === "1";

const messageHandlers = new Set();
const pendingMessages = [];

const dispatchMessage = (message) => {
  if (messageHandlers.size === 0) {
    pendingMessages.push(message);
    return;
  }
  messageHandlers.forEach((handler) => {
    try {
      handler(message);
    } catch (error) {
      console.error("tex64Bridge handler error:", error);
    }
  });
};

ipcRenderer.on("tex64:message", (_event, message) => {
  dispatchMessage(message);
});

const bridgeApi = {
  onMessage: (handler) => {
    if (typeof handler !== "function") {
      return () => {};
    }
    messageHandlers.add(handler);
    if (pendingMessages.length > 0) {
      const backlog = pendingMessages.splice(0, pendingMessages.length);
      backlog.forEach((message) => handler(message));
    }
    return () => {
      messageHandlers.delete(handler);
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
  globalThis.tex64Bridge = bridgeApi;
} else {
  contextBridge.exposeInMainWorld("tex64Bridge", bridgeApi);
}
