import type { BridgeWindow, IssueItem, IssuesStatus } from "./types.js";

type BridgeSenderDeps = {
  bridgeWindow: BridgeWindow;
  isE2E: boolean;
  updateIssues: (
    count: number,
    summary: string,
    status: IssuesStatus,
    issues: IssueItem[]
  ) => void;
};

export type PostToNative = (
  payload: { type: string; [key: string]: unknown },
  silent?: boolean
) => boolean;

export const initBridgeSender = (deps: BridgeSenderDeps): PostToNative => {
  const pending: Array<{ payload: { type: string; [key: string]: unknown } }> = [];
  let retryTimer: number | null = null;

  const tryFlush = () => {
    const handler =
      deps.bridgeWindow.tex64Bridge ?? deps.bridgeWindow.webkit?.messageHandlers?.tex64;
    if (!handler || typeof handler.postMessage !== "function") {
      return false;
    }
    while (pending.length > 0) {
      const entry = pending.shift();
      if (entry) {
        handler.postMessage(entry.payload);
      }
    }
    return true;
  };

  const scheduleRetry = () => {
    if (retryTimer !== null) {
      return;
    }
    retryTimer = window.setInterval(() => {
      if (tryFlush()) {
        if (retryTimer !== null) {
          window.clearInterval(retryTimer);
          retryTimer = null;
        }
      }
    }, 50);
  };

  return (payload, silent = false) => {
    if (deps.isE2E) {
      const log = (window as { __tex64PostMessages?: unknown }).__tex64PostMessages;
      if (Array.isArray(log)) {
        log.push(payload);
      }
    }
    const handler =
      deps.bridgeWindow.tex64Bridge ?? deps.bridgeWindow.webkit?.messageHandlers?.tex64;
    if (!handler || typeof handler.postMessage !== "function") {
      if (deps.isE2E) {
        pending.push({ payload });
        scheduleRetry();
        return true;
      }
      if (!silent) {
        deps.updateIssues(1, "ネイティブ連携が利用できません。", "error", [
          { severity: "error", message: "ネイティブ連携が利用できません。" },
        ]);
      }
      return false;
    }
    handler.postMessage(payload);
    return true;
  };
};
