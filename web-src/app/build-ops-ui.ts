import type { AppContext } from "./context.js";
import type {
  BuildState,
  FormatSettingsPayload,
  IssueItem,
  IssuesStatus,
} from "./types.js";

type EditorGroupKey = "primary" | "secondary";

type EditorGroupState = {
  key: EditorGroupKey;
  root: HTMLElement | null;
  tabs: HTMLElement | null;
  tabsList: HTMLElement | null;
  editorHost: HTMLElement | null;
  currentFilePath: string | null;
  currentFileSavedContent: string | null;
  editor: unknown | null;
  openTabs: string[];
  viewer: {
    getViewerMode: () => string;
    syncPdf: (payload: { page: number; x: number; y: number }) => void;
  };
  isDirty: boolean;
  viewStates: Map<string, unknown>;
  isApplyingFile: boolean;
  isComposing: boolean;
  compositionText: string;
  composingFilePath: string | null;
  pendingCompositionAction: (() => void) | null;
};

type BuildOpsDeps = {
  getActiveGroup: () => EditorGroupState;
  getActiveEditorGroupKey: () => EditorGroupKey;
  getActiveFilePath: () => string | null;
  getRootFilePath: () => string | null;
  getLastBuildMainFile: () => string | null;
  setLastBuildMainFile: (path: string | null) => void;
  getStoredCursorPosition: (path: string) => { line: number; column: number } | null;
  cacheCurrentBuffer: (group: EditorGroupState) => void;
  saveCurrentFile: () => Promise<boolean>;
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
  setPendingBuildIssuesFocus: (value: boolean) => void;
  applyFormattedContent: (
    group: EditorGroupState,
    path: string,
    content: string,
    options?: { updateSaved?: boolean }
  ) => void;
  getEditorGroups: () => EditorGroupState[];
  renderEditorTabs: (group: EditorGroupState) => void;
  requestOpenFile: (
    path: string,
    groupKey: EditorGroupKey,
    force?: boolean
  ) => boolean;
  getSplitViewEnabled: () => boolean;
  settings: {
    getPdfViewerMode: () => "window" | "tab";
    getAutoSynctexOnBuildEnabled: () => boolean;
    buildFormatSettingsPayload: () => FormatSettingsPayload;
  };
};

export type BuildOpsApi = {
  updateSynctexButtonState: () => void;
  setBuildState: (state: BuildState, message?: string) => void;
  startBuild: () => void;
  requestFormatCurrentFile: (source: string) => void;
  handleFormatResult: (payload: {
    path: string;
    ok: boolean;
    content?: string;
    error?: string;
    source?: string;
  }) => void;
  handleSaveFormatError: (formatError?: string) => void;
  handleBuildLog: (log: string | null) => void;
  requestSynctexForward: (
    overridePath?: string | null,
    options?: { fallbackToTop?: boolean }
  ) => void;
  handleSynctexForwardResult: (payload: {
    ok?: boolean;
    error?: string;
    page?: number;
    x?: number;
    y?: number;
    pdfPath?: string | null;
  }) => void;
  setupActionButtons: () => void;
};

export const initBuildOpsUi = (
  context: AppContext,
  deps: BuildOpsDeps
): BuildOpsApi => {
  const { buildButton, formatButton, synctexButton, issuesLog, issuesLogContent } = context.dom;

  let formatInFlight = false;
  let formatPending = false;
  let formatWarningShown = false;
  let currentBuildLog: string | null = null;

  const resolvePdfTargetGroupKey = (
    preferredKey: EditorGroupKey,
    pdfPath?: string | null
  ): EditorGroupKey => {
    if (pdfPath) {
      const existing = deps
        .getEditorGroups()
        .find((group) => group.openTabs.includes(pdfPath));
      if (existing) {
        return existing.key;
      }
    }
    if (!deps.getSplitViewEnabled()) {
      return preferredKey;
    }
    const groups = deps.getEditorGroups();
    const preferred = groups.find((group) => group.key === preferredKey);
    if (!preferred) {
      return preferredKey;
    }
    if (preferred.openTabs.length === 0) {
      return preferred.key;
    }
    const other = groups.find((group) => group.key !== preferred.key);
    if (other && other.openTabs.length === 0) {
      return other.key;
    }
    return preferred.key;
  };

  const updateSynctexButtonState = () => {
    if (!(synctexButton instanceof HTMLButtonElement)) {
      return;
    }
    synctexButton.disabled = true;
    synctexButton.style.display = "none";
  };

  const handleBuildLog = (log: string | null) => {
    currentBuildLog = log;
    if (issuesLogContent instanceof HTMLElement) {
      issuesLogContent.textContent = log ?? "";
    }
    if (issuesLog instanceof HTMLElement) {
      issuesLog.classList.toggle("is-hidden", !log);
      if (!log) {
        issuesLog.removeAttribute("open");
      }
    }
  };

  const requestSynctexForward = (
    overridePath?: string | null,
    options: { fallbackToTop?: boolean } = {}
  ) => {
    const activeGroup = deps.getActiveGroup();
    const targetPath = overridePath ?? activeGroup.currentFilePath;
    if (!targetPath || !targetPath.endsWith(".tex")) {
      deps.updateIssues(1, "SyncTeX は .tex ファイルでのみ利用できます。", "info", [
        { severity: "warning", message: "SyncTeX は .tex ファイルでのみ利用できます。" },
      ]);
      return;
    }
    const editor = activeGroup.editor as {
      getPosition?: () => { lineNumber: number; column: number };
    };
    const position =
      activeGroup.currentFilePath === targetPath ? editor?.getPosition?.() : null;
    const storedPosition = deps.getStoredCursorPosition(targetPath);
    const line = position?.lineNumber ?? storedPosition?.line ?? 1;
    const column = position?.column ?? storedPosition?.column ?? 1;
    deps.postToNative({
      type: "synctex:forward",
      path: targetPath,
      line,
      column,
      fallbackToTop: options.fallbackToTop === true,
      pdfViewerMode: deps.settings.getPdfViewerMode(),
    });
  };

  const setBuildState = (state: BuildState, message?: string) => {
    if (buildButton instanceof HTMLButtonElement) {
      const isBusy = state === "building";
      buildButton.disabled = isBusy;
      buildButton.classList.toggle("is-busy", isBusy);
      buildButton.setAttribute("aria-busy", isBusy ? "true" : "false");
      buildButton.setAttribute("aria-label", isBusy ? "ビルド中" : "ビルド");
    }
    if (state === "success") {
      const targetPath =
        deps.getLastBuildMainFile() ?? deps.getRootFilePath() ?? deps.getActiveFilePath();
      if (
        deps.settings.getAutoSynctexOnBuildEnabled() &&
        targetPath &&
        targetPath.endsWith(".tex")
      ) {
        requestSynctexForward(targetPath, { fallbackToTop: true });
      }
    }
    if (state === "failed") {
      deps.setPendingBuildIssuesFocus(true);
    } else if (state !== "building") {
      deps.setPendingBuildIssuesFocus(false);
    }
    if (message && state === "building") {
      deps.updateIssues(0, message, "info", []);
    }
  };

  const startBuild = () => {
    deps.cacheCurrentBuffer(deps.getActiveGroup());

    const mainFile =
      deps.getRootFilePath() ??
      (deps.getActiveFilePath() && deps.getActiveFilePath()?.endsWith(".tex")
        ? deps.getActiveFilePath()
        : undefined);

    deps.setLastBuildMainFile(mainFile ?? null);

    const engine = localStorage.getItem("tex64.compileEngine") || "lualatex";

    const payload: {
      type: string;
      mainFile?: string;
      format?: boolean;
      formatSettings?: FormatSettingsPayload;
      engine?: string;
      pdfViewerMode?: "window" | "tab";
    } = { type: "build" };
    if (mainFile) {
      payload.mainFile = mainFile;
    }
    if (engine) {
      payload.engine = engine;
    }
    payload.pdfViewerMode = deps.settings.getPdfViewerMode();
    payload.formatSettings = deps.settings.buildFormatSettingsPayload();

    if (deps.postToNative(payload)) {
      setBuildState("building");
      handleBuildLog(null);
      deps.updateIssues(0, "ビルドを開始します。", "info", []);
    }
  };

  const requestFormatCurrentFile = (source: string) => {
    const activeGroup = deps.getActiveGroup();
    const activePath = activeGroup.currentFilePath;
    if (!activePath || !activePath.toLowerCase().endsWith(".tex")) {
      return;
    }
    if (!activeGroup.editor) {
      return;
    }
    if (formatInFlight) {
      formatPending = true;
      return;
    }
    const editor = activeGroup.editor as { getValue: () => string };
    const content = editor.getValue();
    formatInFlight = true;
    const ok = deps.postToNative({
      type: "formatFile",
      path: activePath,
      content,
      source,
      formatSettings: deps.settings.buildFormatSettingsPayload(),
    });
    if (!ok) {
      formatInFlight = false;
      formatPending = false;
      if (!formatWarningShown) {
        formatWarningShown = true;
        deps.updateIssues(1, "整形のリクエストに失敗しました。", "info", [
          { severity: "warning", message: "整形のリクエストに失敗しました。" },
        ]);
      }
    }
  };

  const handleSaveFormatError = (formatError?: string) => {
    if (formatError && !formatWarningShown) {
      formatWarningShown = true;
      deps.updateIssues(1, formatError, "info", [
        { severity: "warning", message: formatError },
      ]);
    }
  };

  const handleFormatResult = (payload: {
    path: string;
    ok: boolean;
    content?: string;
    error?: string;
    source?: string;
  }) => {
    formatInFlight = false;
    if (!payload.ok) {
      if (!formatWarningShown) {
        formatWarningShown = true;
        deps.updateIssues(1, payload.error ?? "整形に失敗しました。", "info", [
          { severity: "warning", message: payload.error ?? "整形に失敗しました。" },
        ]);
      }
    } else if (typeof payload.content === "string") {
      const groupsWithFile = deps
        .getEditorGroups()
        .filter((group) => group.currentFilePath === payload.path);
      if (groupsWithFile.length > 0) {
        groupsWithFile.forEach((group) => {
          deps.applyFormattedContent(group, payload.path, payload.content as string, {
            updateSaved: false,
          });
          deps.renderEditorTabs(group);
        });
      }
      const activeGroup = deps.getActiveGroup();
      if (activeGroup.currentFilePath === payload.path && activeGroup.isDirty) {
        deps.saveCurrentFile().catch((message: string) => {
          deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
        });
      }
    }
    if (formatPending) {
      formatPending = false;
      requestFormatCurrentFile(payload.source ?? "auto");
    }
  };

  const handleSynctexForwardResult = (payload: {
    ok?: boolean;
    error?: string;
    page?: number;
    x?: number;
    y?: number;
    pdfPath?: string | null;
  }) => {
    if (!payload) {
      return;
    }
    if (payload.ok) {
      if (deps.settings.getPdfViewerMode() === "tab" && typeof payload.page === "number") {
        const targetKey = resolvePdfTargetGroupKey(
          deps.getActiveEditorGroupKey(),
          payload.pdfPath
        );
        const targetGroup =
          deps.getEditorGroups().find((group) => group.key === targetKey) ??
          deps.getActiveGroup();
        if (payload.pdfPath && targetGroup.viewer.getViewerMode() !== "pdf") {
          deps.requestOpenFile(payload.pdfPath, targetKey);
        }
        targetGroup.viewer.syncPdf({
          page: payload.page,
          x: payload.x ?? 0,
          y: payload.y ?? 0,
        });
      }
      return;
    }
    deps.updateIssues(1, payload.error ?? "SyncTeX に失敗しました。", "error", [
      { severity: "error", message: payload.error ?? "SyncTeX に失敗しました。" },
    ]);
  };

  const setupActionButtons = () => {
    if (buildButton instanceof HTMLButtonElement) {
      buildButton.addEventListener("click", () => {
        if (buildButton.disabled) {
          return;
        }
        const activeGroup = deps.getActiveGroup();
        if (activeGroup.isDirty && activeGroup.currentFilePath) {
          deps
            .saveCurrentFile()
            .then((ok) => {
              if (ok) {
                startBuild();
              }
            })
            .catch((message: string) => {
              deps.updateIssues(1, message, "error", [
                { severity: "error", message },
              ]);
            });
          return;
        }
        startBuild();
      });
    }

    if (formatButton instanceof HTMLButtonElement) {
      formatButton.addEventListener("click", () => {
        requestFormatCurrentFile("manual");
      });
    }
  };

  return {
    updateSynctexButtonState,
    setBuildState,
    startBuild,
    requestFormatCurrentFile,
    handleFormatResult,
    handleSaveFormatError,
    handleBuildLog,
    requestSynctexForward,
    handleSynctexForwardResult,
    setupActionButtons,
  };
};
