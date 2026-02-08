import type { BridgeWindow, IssueItem, IssuesStatus } from "./types.js";

type BridgeSenderDeps = {
  bridgeWindow: BridgeWindow;
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
  return (payload, silent = false) => {
    const handler =
      deps.bridgeWindow.tex64Bridge ?? deps.bridgeWindow.webkit?.messageHandlers?.tex64;
    if (!handler || typeof handler.postMessage !== "function") {
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
