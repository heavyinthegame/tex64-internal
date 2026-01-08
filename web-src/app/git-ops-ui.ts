import type { AppContext } from "./context.js";
import { renderGitPanel as renderGitPanelUi } from "./git-panel-ui.js";
import type {
  GitActionResultPayload,
  GitBranchState,
  GitDiffPayload,
  GitEntry,
  GitHistoryEntry,
  GitRemoteState,
  GitRepoState,
  GitStatusPayload,
  IssuesStatus,
  IssueItem,
} from "./types.js";

type GitPreviewContext =
  | { type: "commit" }
  | { type: "restore"; hash: string; shortHash: string; message: string };

type GitOpsDeps = {
  postToNative: (
    payload: { type: string; [key: string]: unknown },
    silent?: boolean
  ) => boolean;
  updateIssues: (
    count: number,
    summary: string,
    status: IssuesStatus,
    issues: IssueItem[]
  ) => void;
  diffModal: {
    showPatchModal: (
      patch: string,
      options: {
        title: string;
        fileName: string;
        submitLabel: string;
        context: { type: "gitCommit" } | { type: "gitRestore"; hash: string };
      }
    ) => void;
  };
  getWorkspaceRootKey: () => string | null;
};

export type GitOpsApi = {
  render: () => void;
  reset: () => void;
  handleUpdate: (payload: GitStatusPayload) => void;
  handleDiff: (payload: GitDiffPayload) => void;
  handleActionResult: (payload: GitActionResultPayload) => void;
  requestStatus: () => void;
  requestInit: () => void;
  requestCommit: () => void;
  requestCommitPreview: () => void;
  requestPull: () => void;
  requestPush: () => void;
  requestSetRemote: () => void;
  requestRestore: (hash: string) => void;
  requestRestorePreview: (entry: {
    hash: string;
    shortHash: string;
    message: string;
  }) => void;
  setupActions: () => void;
};

export const initGitOpsUi = (context: AppContext, deps: GitOpsDeps): GitOpsApi => {
  const {
    gitRefreshButton,
    gitInitButton,
    gitCommitMessage,
    gitCommitButton,
    gitHistory,
    gitPullButton,
    gitPushButton,
    gitRemoteInput,
    gitRemoteSaveButton,
  } = context.dom;

  let gitEntries: GitEntry[] = [];
  let gitMessage = "履歴の状態はここに表示します。";
  let gitRepoState: GitRepoState = { ok: false };
  let gitRemoteState: GitRemoteState = { exists: false };
  let gitBranchState: GitBranchState = {};
  let gitHistoryEntries: GitHistoryEntry[] = [];
  let gitHistoryMessage = "履歴はここに表示します。";
  let gitGuideMessage: string | null = null;
  let gitPreviewContext: GitPreviewContext | null = null;
  let gitBusy = false;
  let gitBusyMessage: string | null = null;
  let gitLastAction:
    | "init"
    | "commit"
    | "commit-preview"
    | "restore"
    | "pull"
    | "push"
    | "remote"
    | "refresh"
    | null = null;

  const render = () => {
    renderGitPanelUi(context, {
      entries: gitEntries,
      message: gitMessage,
      historyEntries: gitHistoryEntries,
      historyMessage: gitHistoryMessage,
      repoState: gitRepoState,
      remoteState: gitRemoteState,
      branchState: gitBranchState,
      busy: gitBusy,
      busyMessage: gitBusyMessage,
      guideMessage: gitGuideMessage,
      workspaceRootKey: deps.getWorkspaceRootKey(),
    });
  };

  const reset = () => {
    gitEntries = [];
    gitMessage = "履歴の状態はここに表示します。";
    gitRepoState = { ok: false };
    gitRemoteState = { exists: false };
    gitBranchState = {};
    gitHistoryEntries = [];
    gitHistoryMessage = "履歴はここに表示します。";
    gitGuideMessage = null;
    gitPreviewContext = null;
    gitBusy = false;
    gitBusyMessage = null;
    gitLastAction = null;
    if (gitCommitMessage instanceof HTMLInputElement) {
      gitCommitMessage.value = "";
    }
    if (gitRemoteInput instanceof HTMLInputElement) {
      gitRemoteInput.value = "";
    }
    render();
  };

  const handleUpdate = (payload: GitStatusPayload) => {
    gitEntries = Array.isArray(payload.entries) ? payload.entries : [];
    gitRepoState = payload.repo ?? gitRepoState;
    gitRemoteState = payload.remote ?? gitRemoteState;
    gitBranchState = payload.branch ?? gitBranchState;
    gitHistoryEntries = Array.isArray(payload.history) ? payload.history : [];
    if (!gitRepoState.ok) {
      gitGuideMessage = null;
    }
    if (payload.message) {
      gitMessage = payload.message;
    } else if (!deps.getWorkspaceRootKey()) {
      gitMessage = "ワークスペースが未選択です。";
    } else if (gitRepoState.reason === "git-missing") {
      gitMessage = "履歴管理を利用できません。";
    } else if (!gitRepoState.ok) {
      gitMessage = "履歴管理がまだ有効ではありません。";
    } else if (gitEntries.length === 0) {
      gitMessage = "変更はありません。";
    }
    if (payload.historyMessage) {
      gitHistoryMessage = payload.historyMessage;
    } else if (!deps.getWorkspaceRootKey()) {
      gitHistoryMessage = "ワークスペースが未選択です。";
    } else if (gitRepoState.reason === "git-missing") {
      gitHistoryMessage = "履歴を取得できません。";
    } else if (!gitRepoState.ok) {
      gitHistoryMessage = "履歴管理がまだ有効ではありません。";
    } else if (gitHistoryEntries.length === 0) {
      gitHistoryMessage = "履歴はまだありません。";
    }
    const shouldClearCommitMessage = gitLastAction === "commit" && gitEntries.length === 0;
    gitBusy = false;
    gitBusyMessage = null;
    gitLastAction = null;
    if (shouldClearCommitMessage && gitCommitMessage instanceof HTMLInputElement) {
      gitCommitMessage.value = "";
    }
    render();
  };

  const handleDiff = (payload: GitDiffPayload) => {
    gitBusy = false;
    gitBusyMessage = null;
    gitLastAction = null;
    render();

    if (!payload.ok) {
      const message = payload.message ?? "差分を取得できませんでした。";
      deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
      gitPreviewContext = null;
      return;
    }
    const patch = payload.patch ?? "";
    if (!patch.trim()) {
      const message = payload.message ?? "変更はありません。";
      deps.updateIssues(0, message, "info", []);
      gitPreviewContext = null;
      return;
    }

    if (payload.mode === "commit") {
      gitPreviewContext = null;
      deps.diffModal.showPatchModal(patch, {
        title: "履歴に保存の確認",
        fileName: "保存予定の変更",
        submitLabel: "保存",
        context: { type: "gitCommit" },
      });
      return;
    }

    const context = gitPreviewContext?.type === "restore" ? gitPreviewContext : null;
    const shortHash = context?.shortHash ?? (payload.hash ?? "").slice(0, 7);
    const labelMessage = context?.message ? ` ${context.message}` : "";
    const fileName = shortHash ? `履歴: ${shortHash}${labelMessage}` : "履歴の変更";
    gitPreviewContext = null;
    deps.diffModal.showPatchModal(patch, {
      title: "履歴を戻す確認",
      fileName,
      submitLabel: "戻す",
      context: { type: "gitRestore", hash: payload.hash ?? context?.hash ?? "" },
    });
  };

  const handleActionResult = (payload: GitActionResultPayload) => {
    if (payload.action !== "pull" && payload.action !== "push") {
      if (payload.ok) {
        gitGuideMessage = null;
        render();
      }
      return;
    }
    if (payload.hint) {
      gitGuideMessage = payload.hint;
    } else if (payload.ok) {
      gitGuideMessage = null;
    }
    render();
  };

  const requestStatus = () => {
    if (!deps.getWorkspaceRootKey()) {
      gitEntries = [];
      gitMessage = "ワークスペースが未選択です。";
      gitHistoryEntries = [];
      gitHistoryMessage = "ワークスペースが未選択です。";
      gitGuideMessage = null;
      render();
      return;
    }
    if (gitBusy) {
      return;
    }
    gitMessage = "取得中...";
    gitHistoryMessage = "取得中...";
    gitBusy = true;
    gitBusyMessage = "状態を確認しています...";
    gitLastAction = "refresh";
    render();
    deps.postToNative({ type: "gitStatus" }, true);
  };

  const requestInit = () => {
    if (!deps.getWorkspaceRootKey() || gitBusy || gitRepoState.ok) {
      return;
    }
    gitBusy = true;
    gitBusyMessage = "履歴管理を開始しています...";
    gitLastAction = "init";
    render();
    deps.postToNative({ type: "gitInit" });
  };

  const requestCommit = () => {
    if (!deps.getWorkspaceRootKey() || gitBusy || !gitRepoState.ok || gitEntries.length === 0) {
      return;
    }
    const message =
      gitCommitMessage instanceof HTMLInputElement ? gitCommitMessage.value : "";
    gitBusy = true;
    gitBusyMessage = "履歴を保存しています...";
    gitLastAction = "commit";
    render();
    deps.postToNative({ type: "gitCommit", message });
  };

  const requestCommitPreview = () => {
    if (!deps.getWorkspaceRootKey() || gitBusy || !gitRepoState.ok || gitEntries.length === 0) {
      return;
    }
    gitBusy = true;
    gitBusyMessage = "保存前の差分を確認しています...";
    gitLastAction = "commit-preview";
    gitPreviewContext = { type: "commit" };
    render();
    deps.postToNative({ type: "gitDiff", mode: "commit" });
  };

  const requestPull = () => {
    if (
      !deps.getWorkspaceRootKey() ||
      gitBusy ||
      !gitRepoState.ok ||
      !gitRemoteState.exists ||
      gitBranchState.detached ||
      gitEntries.length > 0
    ) {
      return;
    }
    gitBusy = true;
    gitBusyMessage = "受け取り中...";
    gitLastAction = "pull";
    render();
    deps.postToNative({ type: "gitPull" });
  };

  const requestPush = () => {
    if (
      !deps.getWorkspaceRootKey() ||
      gitBusy ||
      !gitRepoState.ok ||
      !gitRemoteState.exists ||
      gitBranchState.detached ||
      gitEntries.length > 0
    ) {
      return;
    }
    gitBusy = true;
    gitBusyMessage = "送信中...";
    gitLastAction = "push";
    render();
    deps.postToNative({ type: "gitPush" });
  };

  const requestSetRemote = () => {
    if (!deps.getWorkspaceRootKey() || gitBusy || !gitRepoState.ok) {
      return;
    }
    const url = gitRemoteInput instanceof HTMLInputElement ? gitRemoteInput.value : "";
    gitBusy = true;
    gitBusyMessage = "同期先を保存しています...";
    gitLastAction = "remote";
    render();
    deps.postToNative({ type: "gitSetRemote", url });
  };

  const requestRestore = (hash: string) => {
    if (
      !deps.getWorkspaceRootKey() ||
      gitBusy ||
      !gitRepoState.ok ||
      gitEntries.length > 0 ||
      gitBranchState.detached
    ) {
      return;
    }
    const trimmed = (hash ?? "").trim();
    if (!trimmed) {
      return;
    }
    gitBusy = true;
    gitBusyMessage = "履歴を戻しています...";
    gitLastAction = "restore";
    render();
    deps.postToNative({ type: "gitRestore", hash: trimmed });
  };

  const requestRestorePreview = (entry: {
    hash: string;
    shortHash: string;
    message: string;
  }) => {
    if (
      !deps.getWorkspaceRootKey() ||
      gitBusy ||
      !gitRepoState.ok ||
      gitEntries.length > 0 ||
      gitBranchState.detached
    ) {
      return;
    }
    const hash = entry.hash.trim();
    if (!hash) {
      return;
    }
    gitBusy = true;
    gitBusyMessage = "復元内容を確認しています...";
    gitLastAction = "restore";
    gitPreviewContext = {
      type: "restore",
      hash,
      shortHash: entry.shortHash,
      message: entry.message,
    };
    render();
    deps.postToNative({ type: "gitDiff", mode: "restore", hash });
  };

  const setupActions = () => {
    if (gitRefreshButton instanceof HTMLButtonElement) {
      gitRefreshButton.addEventListener("click", () => {
        requestStatus();
      });
    }

    if (gitInitButton instanceof HTMLButtonElement) {
      gitInitButton.addEventListener("click", () => {
        requestInit();
      });
    }

    if (gitCommitButton instanceof HTMLButtonElement) {
      gitCommitButton.addEventListener("click", () => {
        requestCommitPreview();
      });
    }

    if (gitCommitMessage instanceof HTMLInputElement) {
      gitCommitMessage.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.isComposing) {
          return;
        }
        event.preventDefault();
        requestCommitPreview();
      });
    }

    if (gitPullButton instanceof HTMLButtonElement) {
      gitPullButton.addEventListener("click", () => {
        requestPull();
      });
    }

    if (gitPushButton instanceof HTMLButtonElement) {
      gitPushButton.addEventListener("click", () => {
        requestPush();
      });
    }

    if (gitRemoteSaveButton instanceof HTMLButtonElement) {
      gitRemoteSaveButton.addEventListener("click", () => {
        requestSetRemote();
      });
    }

    if (gitRemoteInput instanceof HTMLInputElement) {
      gitRemoteInput.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.isComposing) {
          return;
        }
        event.preventDefault();
        requestSetRemote();
      });
    }

    if (gitHistory instanceof HTMLElement) {
      gitHistory.addEventListener("click", (event) => {
        const target = event.target as HTMLElement | null;
        const button = target?.closest<HTMLButtonElement>(
          "button[data-git-action=\"restore\"]"
        );
        if (!button || button.disabled) {
          return;
        }
        const hash = button.dataset.hash ?? "";
        const shortHash = button.dataset.shortHash ?? hash.slice(0, 7);
        const message = button.dataset.message ?? "";
        if (!hash) {
          return;
        }
        requestRestorePreview({ hash, shortHash, message });
      });
    }
  };

  return {
    render,
    reset,
    handleUpdate,
    handleDiff,
    handleActionResult,
    requestStatus,
    requestInit,
    requestCommit,
    requestCommitPreview,
    requestPull,
    requestPush,
    requestSetRemote,
    requestRestore,
    requestRestorePreview,
    setupActions,
  };
};
