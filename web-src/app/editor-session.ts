import type { AppContext } from "./context.js";
import type { createViewer } from "./viewer.js";
import {
  LATEX_FILE_EXTENSIONS,
  PINNED_TAB_EXTENSIONS,
  getFileExtension,
  isImageFilePath,
  isPdfFilePath,
  isTextFilePath,
} from "./files.js";
import type {
  FormatSettingsPayload,
  IndexEntry,
  IssueItem,
  IssuesStatus,
  SearchResult,
} from "./types.js";

export type EditorGroupKey = "primary" | "secondary";

export type EditorGroupState = {
  key: EditorGroupKey;
  root: HTMLElement | null;
  tabs: HTMLElement | null;
  tabsList: HTMLElement | null;
  editorHost: HTMLElement | null;
  viewer: ReturnType<typeof createViewer>;
  editor: unknown | null;
  openTabs: string[];
  currentFilePath: string | null;
  currentFileSavedContent: string | null;
  isDirty: boolean;
  viewStates: Map<string, unknown>;
  isApplyingFile: boolean;
  isComposing: boolean;
  compositionText: string;
  composingFilePath: string | null;
  pendingCompositionAction: (() => void) | null;
};

type MonacoModel = { getValue: () => string; setValue: (value: string) => void };
type MonacoModelEntry = { model: MonacoModel; savedContent: string };

type EditorSessionDeps = {
  getWorkspaceFiles: () => string[];
  getRootFilePath: () => string | null;
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
  setAutoDetectedUi: (enabled: boolean, lineNumber?: number) => void;
  setBlockPreviewActive: (active: boolean) => void;
  updateFallback: (message: string) => void;
  fileTree: {
    setSelection: (path: string, kind: "file" | "dir") => void;
    clearSelection: () => void;
    render: () => void;
    loadOpenState: () => void;
    setTreeFocus: (focus: boolean) => void;
    handleRenameResult: (payload: {
      oldPath: string;
      newPath: string;
      isDirectory: boolean;
    }) => void;
  };
  outline: {
    render: () => void;
  };
  editorTabs: {
    render: (group: EditorGroupState) => void;
  };
  buildOps: {
    updateSynctexButtonState: () => void;
    handleSaveFormatError: (error?: string) => void;
  };
  settings: {
    buildFormatSettingsPayload: () => FormatSettingsPayload;
    updateEnvStatus: (command: string, available: boolean) => void;
  };
  search: {
    handleSearchUpdate: (payload: {
      query: string;
      results?: SearchResult[];
      message?: string;
    }) => void;
  };
  getMonacoApi: () => Record<string, unknown> | null;
};

export type EditorSessionApi = {
  getEditorGroup: (key: EditorGroupKey) => EditorGroupState;
  getEditorGroups: () => EditorGroupState[];
  getActiveGroup: () => EditorGroupState;
  getActiveEditorGroupKey: () => EditorGroupKey;
  getActiveFilePath: () => string | null;
  isActiveGroup: (group: EditorGroupState) => boolean;
  forEachEditorGroup: (handler: (group: EditorGroupState) => void) => void;
  setEditorGroupEmptyState: (group: EditorGroupState, isEmpty: boolean) => void;
  isAnyGroupComposing: () => boolean;
  updateBreadcrumbs: () => void;
  updateMiniOutline: () => void;
  setActiveGroup: (key: EditorGroupKey, options?: { focusEditor?: boolean }) => void;
  setSplitViewEnabled: (enabled: boolean) => void;
  getSplitViewEnabled: () => boolean;
  cacheCurrentBuffer: (group: EditorGroupState) => void;
  addOpenTab: (group: EditorGroupState, path: string) => void;
  closeTab: (group: EditorGroupState, path: string) => void;
  scheduleAfterComposition: (group: EditorGroupState, action: () => void) => void;
  handleCompositionEnd: (group: EditorGroupState) => void;
  updateDirtyState: (path: string, content: string, savedContent?: string) => void;
  clearJumpHighlight: (group: EditorGroupState) => void;
  scheduleAutoSave: () => void;
  requestOpenFile: (path: string, groupKey: EditorGroupKey, force?: boolean) => boolean;
  jumpToFileLine: (path: string, line: number, groupKey: EditorGroupKey) => void;
  jumpToLocation: (entry: IndexEntry) => void;
  applyFormattedContent: (
    group: EditorGroupState,
    path: string,
    content: string,
    options?: { updateSaved?: boolean }
  ) => void;
  saveCurrentFile: () => Promise<boolean>;
  requestInitialOpen: () => void;
  openPendingFileIfReady: () => void;
  clearIssueHighlight: () => void;
  parseIssueDetail: (issue: IssueItem) => {
    path: string | null;
    line: number | null;
    column: number | null;
    message: string;
  };
  focusIssue: (issue: IssueItem) => void;
  handleOpenFileResult: (payload: {
    path: string;
    content?: string;
    error?: string;
    kind?: "text" | "image" | "pdf" | "unsupported";
    data?: string;
    mimeType?: string;
  }) => void;
  handleSaveResult: (payload: {
    path: string;
    ok: boolean;
    error?: string;
    content?: string;
    formatError?: string;
  }) => void;
  handleRenameResult: (payload: {
    oldPath: string;
    newPath: string;
    isDirectory: boolean;
  }) => void;
  syncWorkspaceFiles: (payload: { workspaceFiles: string[]; rootChanged: boolean }) => void;
  getDirtyPaths: () => Set<string>;
  getStoredCursorPosition: (path: string) => { line: number; column: number } | null;
  recordCursorPosition: (path: string, position: { lineNumber: number; column: number }) => void;
};

export const initEditorSession = (
  context: AppContext,
  deps: EditorSessionDeps
): EditorSessionApi => {
  const {
    editorGroups: editorGroupsRoot,
    editorTabs,
    editorTabsList,
    editorTabsSecondary,
    editorTabsListSecondary,
    editorHost,
    editorHostSecondary,
    editorSplitButton,
  } = context.dom;

  const editorGroupsRootEl =
    editorGroupsRoot instanceof HTMLElement ? editorGroupsRoot : null;
  const editorGroupPrimary =
    editorGroupsRootEl?.querySelector<HTMLElement>('[data-editor-group="primary"]') ?? null;
  const editorGroupSecondary =
    editorGroupsRootEl?.querySelector<HTMLElement>('[data-editor-group="secondary"]') ?? null;

  const editorGroups: Record<EditorGroupKey, EditorGroupState> = {
    primary: {
      key: "primary",
      root: editorGroupPrimary,
      tabs: editorTabs,
      tabsList: editorTabsList,
      editorHost,
      viewer: context.viewers.primary,
      editor: null,
      openTabs: [],
      currentFilePath: null,
      currentFileSavedContent: null,
      isDirty: false,
      viewStates: new Map(),
      isApplyingFile: false,
      isComposing: false,
      compositionText: "",
      composingFilePath: null,
      pendingCompositionAction: null,
    },
    secondary: {
      key: "secondary",
      root: editorGroupSecondary,
      tabs: editorTabsSecondary,
      tabsList: editorTabsListSecondary,
      editorHost: editorHostSecondary,
      viewer: context.viewers.secondary,
      editor: null,
      openTabs: [],
      currentFilePath: null,
      currentFileSavedContent: null,
      isDirty: false,
      viewStates: new Map(),
      isApplyingFile: false,
      isComposing: false,
      compositionText: "",
      composingFilePath: null,
      pendingCompositionAction: null,
    },
  };

  let activeEditorGroup: EditorGroupKey = "primary";
  let splitViewEnabled = false;
  const pendingOpenRequests: Array<{ path: string; group: EditorGroupKey }> = [];
  let issueDecorations: string[] = [];
  const jumpDecorations: Record<EditorGroupKey, string[]> = {
    primary: [],
    secondary: [],
  };
  let pendingReveal: { path: string; line: number; group: EditorGroupKey } | null = null;
  let pendingSave:
    | {
        path: string;
        content: string;
        resolve: (ok: boolean) => void;
        reject: (message: string) => void;
      }
    | null = null;
  let autoSaveTimer: number | null = null;
  let autoSavePending = false;
  let pendingAutoOpenPath: string | null = null;
  const lastCursorPositions = new Map<string, { line: number; column: number }>();
  const monacoModels = new Map<string, MonacoModelEntry>();
  const dirtyFiles = new Set<string>();
  let emptyEditorModel: MonacoModel | null = null;

  const getEditorGroup = (key: EditorGroupKey) => editorGroups[key];
  const getActiveGroup = () => editorGroups[activeEditorGroup];
  const getActiveEditorGroupKey = () => activeEditorGroup;
  const getActiveFilePath = () => getActiveGroup().currentFilePath;
  const getActiveEditor = () => getActiveGroup().editor;
  const isActiveGroup = (group: EditorGroupState) => group.key === activeEditorGroup;
  const getOtherGroupKey = (key: EditorGroupKey): EditorGroupKey =>
    key === "primary" ? "secondary" : "primary";
  const resolveAutoOpenGroupKey = (preferredKey: EditorGroupKey): EditorGroupKey => {
    if (!splitViewEnabled) {
      return preferredKey;
    }
    const preferred = getEditorGroup(preferredKey);
    if (preferred.openTabs.length === 0) {
      return preferredKey;
    }
    const otherKey = getOtherGroupKey(preferredKey);
    const other = getEditorGroup(otherKey);
    if (other.openTabs.length === 0) {
      return otherKey;
    }
    return preferredKey;
  };
  const findGroupKeyByPath = (path: string): EditorGroupKey | null => {
    const groups = Object.keys(editorGroups) as EditorGroupKey[];
    for (const key of groups) {
      if (editorGroups[key].openTabs.includes(path)) {
        return key;
      }
    }
    return null;
  };
  const forEachEditorGroup = (handler: (group: EditorGroupState) => void) => {
    (Object.keys(editorGroups) as EditorGroupKey[]).forEach((key) => {
      handler(editorGroups[key]);
    });
  };

  const setEditorGroupEmptyState = (group: EditorGroupState, isEmpty: boolean) => {
    if (group.root instanceof HTMLElement) {
      group.root.classList.toggle("is-empty", isEmpty);
    }
    if (!isEmpty && group.editor) {
      const editor = group.editor as { layout?: () => void };
      editor.layout?.();
    }
  };

  const isAnyGroupComposing = () =>
    Object.values(editorGroups).some((group) => group.isComposing);

  const clearIssueHighlight = () => {
    const activeGroup = getActiveGroup();
    const monacoApi = deps.getMonacoApi();
    if (!activeGroup.editor || !monacoApi || issueDecorations.length === 0) {
      return;
    }
    const editor = activeGroup.editor as {
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
    };
    issueDecorations = editor.deltaDecorations(issueDecorations, []);
  };

  const parseIssueDetail = (issue: IssueItem) => {
    const trimmed = issue.message.trim();
    const match =
      trimmed.match(/^(.+?\.tex):(\d+):(\d+):\s*(.+)$/) ??
      trimmed.match(/^(.+?\.tex):(\d+):\s*(.+)$/) ??
      trimmed.match(/^(.+?):(\d+):\s*(.+)$/);
    if (match) {
      const path = issue.path ?? match[1];
      const line = issue.line ?? Number.parseInt(match[2], 10);
      const column =
        issue.column ??
        (match.length > 4 && match[3] && /^\d+$/.test(match[3])
          ? Number.parseInt(match[3], 10)
          : null);
      let message = match.length > 4 ? match[4].trim() : match[3].trim();
      if (issue.path && issue.line) {
        const prefix = `${issue.path}:${issue.line}`;
        if (message.startsWith(prefix)) {
          message = message.slice(prefix.length).replace(/^:\s*/, "");
        }
      }
      return { path, line: Number.isFinite(line) ? line : null, column, message };
    }
    return {
      path: issue.path ?? null,
      line: issue.line ?? null,
      column: issue.column ?? null,
      message: trimmed,
    };
  };

  const focusIssue = (issue: IssueItem) => {
    const activeGroup = getActiveGroup();
    const monacoApi = deps.getMonacoApi();
    if (!activeGroup.editor || !monacoApi) {
      return;
    }
    const detail = parseIssueDetail(issue);
    if (detail.path && detail.line) {
      jumpToFileLine(detail.path, detail.line, activeEditorGroup);
      return;
    }
    if (!detail.line) {
      return;
    }
    const monacoApiAny = monacoApi as {
      Range: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
    };
    const editor = activeGroup.editor as {
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
      revealLineInCenter: (lineNumber: number) => void;
      setPosition: (position: { lineNumber: number; column: number }) => void;
      focus: () => void;
    };
    const className =
      issue.severity === "warning" ? "issue-line-warning" : "issue-line-highlight";
    issueDecorations = editor.deltaDecorations(issueDecorations, [
      {
        range: new monacoApiAny.Range(detail.line, 1, detail.line, 1),
        options: {
          isWholeLine: true,
          className,
        },
      },
    ]);
    editor.revealLineInCenter(detail.line);
    editor.setPosition({ lineNumber: detail.line, column: 1 });
    editor.focus();
  };

  const clearJumpHighlight = (group: EditorGroupState) => {
    const decorations = jumpDecorations[group.key];
    if (!group.editor || decorations.length === 0) {
      return;
    }
    const editor = group.editor as {
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
    };
    jumpDecorations[group.key] = editor.deltaDecorations(decorations, []);
  };

  const revealLine = (group: EditorGroupState, line: number) => {
    const monacoApi = deps.getMonacoApi();
    if (!group.editor || !monacoApi) {
      return;
    }
    clearJumpHighlight(group);
    const monacoApiAny = monacoApi as {
      Range: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
    };
    const editor = group.editor as {
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
      revealLineInCenter: (lineNumber: number) => void;
      setPosition: (position: { lineNumber: number; column: number }) => void;
      focus: () => void;
    };
    jumpDecorations[group.key] = editor.deltaDecorations(jumpDecorations[group.key], [
      {
        range: new monacoApiAny.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: "jump-line-highlight",
        },
      },
    ]);
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
  };

  const pickInitialFilePath = () => {
    const rootFilePath = deps.getRootFilePath();
    const workspaceFiles = deps.getWorkspaceFiles();
    if (rootFilePath && workspaceFiles.includes(rootFilePath)) {
      return rootFilePath;
    }
    const texFiles = workspaceFiles
      .filter((path) => path.toLowerCase().endsWith(".tex"))
      .sort((a, b) => a.localeCompare(b, "ja"));
    if (texFiles.length > 0) {
      return texFiles[0];
    }
    if (workspaceFiles.length > 0) {
      return workspaceFiles[0];
    }
    return null;
  };

  const requestInitialOpen = () => {
    const activeGroup = getActiveGroup();
    const workspaceFiles = deps.getWorkspaceFiles();
    const hasValidCurrent =
      activeGroup.currentFilePath !== null &&
      workspaceFiles.includes(activeGroup.currentFilePath);
    if (hasValidCurrent) {
      return;
    }
    const path = pickInitialFilePath();
    if (!path) {
      return;
    }
    if (!activeGroup.editor) {
      pendingAutoOpenPath = path;
      return;
    }
    pendingAutoOpenPath = null;
    requestOpenFile(path, activeEditorGroup);
  };

  const openPendingFileIfReady = () => {
    const activeGroup = getActiveGroup();
    if (!pendingAutoOpenPath || !activeGroup.editor) {
      return;
    }
    if (activeGroup.currentFilePath) {
      pendingAutoOpenPath = null;
      return;
    }
    const path = pendingAutoOpenPath;
    pendingAutoOpenPath = null;
    requestOpenFile(path, activeEditorGroup);
  };

  const updateBreadcrumbs = () => {
    deps.editorTabs.render(getActiveGroup());
  };

  const updateMiniOutline = () => {};

  const setActiveGroup = (
    nextKey: EditorGroupKey,
    options: { focusEditor?: boolean } = {}
  ) => {
    if (activeEditorGroup === nextKey) {
      return;
    }
    activeEditorGroup = nextKey;
    forEachEditorGroup((group) => {
      if (group.root instanceof HTMLElement) {
        group.root.classList.toggle("is-active", group.key === nextKey);
      }
    });
    updateBreadcrumbs();
    updateMiniOutline();
    deps.outline.render();
    deps.fileTree.render();
    deps.buildOps.updateSynctexButtonState();
    if (options.focusEditor) {
      const editor = getActiveEditor() as { focus?: () => void };
      editor?.focus?.();
    }
  };

  const setSplitViewEnabled = (enabled: boolean) => {
    splitViewEnabled = enabled;
    if (editorGroupsRootEl) {
      editorGroupsRootEl.dataset.split = enabled ? "true" : "false";
    }
    if (editorSplitButton instanceof HTMLElement) {
      editorSplitButton.classList.toggle("is-active", enabled);
      editorSplitButton.setAttribute("aria-pressed", enabled ? "true" : "false");
    }
    if (editorGroupSecondary instanceof HTMLElement) {
      editorGroupSecondary.setAttribute("aria-hidden", enabled ? "false" : "true");
    }
    if (!enabled && activeEditorGroup === "secondary") {
      setActiveGroup("primary", { focusEditor: false });
    }
    requestAnimationFrame(() => {
      forEachEditorGroup((group) => {
        const editor = group.editor as { layout?: () => void };
        editor?.layout?.();
      });
    });
  };

  const getSplitViewEnabled = () => splitViewEnabled;

  const getLanguageIdForPath = (path: string) => {
    const ext = getFileExtension(path);
    if (ext === "bib") {
      return "bibtex";
    }
    if (LATEX_FILE_EXTENSIONS.has(ext)) {
      return "latex";
    }
    return "plaintext";
  };

  const setEditorLanguage = (group: EditorGroupState, path: string) => {
    const monacoApi = deps.getMonacoApi();
    if (!monacoApi || !group.editor) {
      return;
    }
    if (!isTextFilePath(path)) {
      return;
    }
    const editor = group.editor as { getModel?: () => unknown };
    if (!editor.getModel) {
      return;
    }
    const model = editor.getModel();
    const monacoApiAny = monacoApi as {
      editor?: { setModelLanguage?: (model: unknown, languageId: string) => void };
    };
    const languageId = getLanguageIdForPath(path);
    if (model && monacoApiAny.editor?.setModelLanguage) {
      monacoApiAny.editor.setModelLanguage(model, languageId);
    }
  };

  const getEmptyEditorModel = () => {
    const monacoApi = deps.getMonacoApi();
    if (!monacoApi) {
      return null;
    }
    if (emptyEditorModel) {
      return emptyEditorModel;
    }
    const monacoApiAny = monacoApi as {
      editor?: { createModel?: (value: string, languageId: string) => unknown };
    };
    if (!monacoApiAny.editor?.createModel) {
      return null;
    }
    emptyEditorModel = monacoApiAny.editor.createModel("", "plaintext") as MonacoModel;
    return emptyEditorModel;
  };

  const clearEditorView = (group: EditorGroupState) => {
    if (!group.editor) {
      return;
    }
    const editor = group.editor as { setModel?: (model: unknown) => void };
    const emptyModel = getEmptyEditorModel();
    if (emptyModel && editor.setModel) {
      editor.setModel(emptyModel as unknown);
    }
  };

  const scheduleAfterComposition = (group: EditorGroupState, action: () => void) => {
    if (!group.isComposing) {
      action();
      return;
    }
    // Blur will trigger compositionend which handles recovery
    group.pendingCompositionAction = action;
    const input = group.editorHost?.querySelector<HTMLTextAreaElement>("textarea.inputarea");
    input?.blur();
  };

  const handleCompositionEnd = (group: EditorGroupState) => {
    if (!group.pendingCompositionAction) {
      return;
    }
    const action = group.pendingCompositionAction;
    group.pendingCompositionAction = null;
    requestAnimationFrame(() => {
      action();
    });
  };

  const updateDirtyState = (path: string, content: string, savedContent?: string) => {
    const entry = monacoModels.get(path);
    const groupSavedContent = Array.from(Object.values(editorGroups)).find(
      (group) => group.currentFilePath === path && group.currentFileSavedContent
    )?.currentFileSavedContent;
    const baseSaved = savedContent ?? entry?.savedContent ?? groupSavedContent ?? content;
    if (entry) {
      entry.savedContent = baseSaved;
    }
    if (content !== baseSaved) {
      dirtyFiles.add(path);
    } else {
      dirtyFiles.delete(path);
    }
    forEachEditorGroup((group) => {
      if (group.currentFilePath === path) {
        group.isDirty = dirtyFiles.has(path);
      }
    });
  };

  const storeViewState = (group: EditorGroupState, path: string) => {
    if (!group.editor) {
      return;
    }
    const editor = group.editor as { saveViewState?: () => unknown };
    if (!editor.saveViewState) {
      return;
    }
    const viewState = editor.saveViewState();
    if (viewState) {
      group.viewStates.set(path, viewState);
    }
  };

  const restoreViewState = (group: EditorGroupState, path: string) => {
    if (!group.editor) {
      return;
    }
    const viewState = group.viewStates.get(path);
    if (!viewState) {
      return;
    }
    const editor = group.editor as { restoreViewState?: (state: unknown) => void };
    editor.restoreViewState?.(viewState);
  };

  const cacheCurrentBuffer = (group: EditorGroupState) => {
    if (!group.currentFilePath || !group.editor || !isTextFilePath(group.currentFilePath)) {
      return;
    }
    const editor = group.editor as { getValue: () => string };
    const content = editor.getValue();
    updateDirtyState(group.currentFilePath, content);
    storeViewState(group, group.currentFilePath);
  };

  const addOpenTab = (group: EditorGroupState, path: string) => {
    if (!group.openTabs.includes(path)) {
      group.openTabs = [...group.openTabs, path];
    }
  };

  const closeTab = (group: EditorGroupState, path: string) => {
    const index = group.openTabs.indexOf(path);
    if (index === -1) {
      return;
    }
    if (path === group.currentFilePath && group.isComposing) {
      scheduleAfterComposition(group, () => {
        closeTab(group, path);
      });
      return;
    }
    if (path === group.currentFilePath) {
      cacheCurrentBuffer(group);
    }
    group.openTabs = group.openTabs.filter((entry) => entry !== path);
    if (path === group.currentFilePath) {
      if (group.openTabs.length > 0) {
        const nextIndex = Math.min(index, group.openTabs.length - 1);
        const nextPath = group.openTabs[nextIndex];
        requestOpenFile(nextPath, group.key, true);
      } else {
        group.currentFilePath = null;
        group.currentFileSavedContent = null;
        group.isDirty = false;
        group.viewer.hideViewer();
        clearEditorView(group);
        if (isActiveGroup(group)) {
          updateBreadcrumbs();
          updateMiniOutline();
          deps.outline.render();
          deps.fileTree.render();
        }
      }
    }
    deps.editorTabs.render(group);
  };

  const isPersistentTabPath = (path: string) => {
    const ext = getFileExtension(path);
    return PINNED_TAB_EXTENSIONS.has(ext);
  };

  const clearTemporaryTabs = (group: EditorGroupState, keepPath?: string) => {
    const nextTabs = group.openTabs.filter((entry) => {
      if (entry === keepPath) {
        return true;
      }
      if (!isPersistentTabPath(entry)) {
        return false;
      }
      if (dirtyFiles.has(entry)) {
        return false;
      }
      return true;
    });
    if (nextTabs.length === group.openTabs.length) {
      return;
    }
    group.openTabs = nextTabs;
    deps.editorTabs.render(group);
  };

  const applyViewerFile = (
    group: EditorGroupState,
    path: string,
    kind: "image" | "pdf",
    data?: string,
    mimeType?: string
  ) => {
    clearTemporaryTabs(group, path);
    group.currentFilePath = path;
    group.currentFileSavedContent = null;
    group.isDirty = false;
    dirtyFiles.delete(path);
    addOpenTab(group, path);
    deps.editorTabs.render(group);
    if (isActiveGroup(group)) {
      deps.fileTree.setSelection(path, "file");
      updateBreadcrumbs();
      updateMiniOutline();
      deps.outline.render();
      deps.fileTree.render();
    }
    deps.setBlockPreviewActive(false);
    deps.setAutoDetectedUi(false);
    if (pendingReveal && pendingReveal.path === path && pendingReveal.group === group.key) {
      pendingReveal = null;
    }
    if (kind === "image") {
      group.viewer.showImageViewer(path, data, mimeType);
    } else {
      group.viewer.showPdfViewer(path, data, mimeType);
    }
    if (isActiveGroup(group)) {
      deps.buildOps.updateSynctexButtonState();
      deps.fileTree.setTreeFocus(false);
    }
  };

  const applyUnsupportedFile = (group: EditorGroupState, path: string) => {
    clearTemporaryTabs(group, path);
    group.currentFilePath = path;
    group.currentFileSavedContent = null;
    group.isDirty = false;
    dirtyFiles.delete(path);
    addOpenTab(group, path);
    deps.editorTabs.render(group);
    if (isActiveGroup(group)) {
      deps.fileTree.setSelection(path, "file");
      updateBreadcrumbs();
      updateMiniOutline();
      deps.outline.render();
      deps.fileTree.render();
    }
    deps.setBlockPreviewActive(false);
    deps.setAutoDetectedUi(false);
    if (pendingReveal && pendingReveal.path === path && pendingReveal.group === group.key) {
      pendingReveal = null;
    }
    group.viewer.showUnsupportedViewer();
    if (isActiveGroup(group)) {
      deps.buildOps.updateSynctexButtonState();
      deps.fileTree.setTreeFocus(false);
    }
  };

  const ensureModelEntry = (path: string, content: string, savedContent?: string) => {
    const monacoApi = deps.getMonacoApi();
    if (!monacoApi) {
      return null;
    }
    const entry = monacoModels.get(path);
    if (entry) {
      const isEntryDirty = dirtyFiles.has(path);
      if (!isEntryDirty && savedContent !== undefined && entry.savedContent !== savedContent) {
        entry.model.setValue(content);
        entry.savedContent = savedContent;
        updateDirtyState(path, content, savedContent);
      }
      return entry;
    }
    const monacoApiAny = monacoApi as {
      editor?: { createModel?: (value: string, languageId: string) => unknown };
    };
    if (!monacoApiAny.editor?.createModel) {
      return null;
    }
    const model = monacoApiAny.editor.createModel(
      content,
      getLanguageIdForPath(path)
    ) as MonacoModel;
    const nextEntry = { model, savedContent: savedContent ?? content };
    monacoModels.set(path, nextEntry);
    updateDirtyState(path, content, nextEntry.savedContent);
    return nextEntry;
  };

  const applyFileContent = (
    group: EditorGroupState,
    path: string,
    content: string,
    savedContent?: string
  ) => {
    const monacoApi = deps.getMonacoApi();
    if (!group.editor || !monacoApi) {
      deps.updateFallback("エディタの準備が完了していません。");
      return;
    }
    const editor = group.editor as {
      setModel?: (model: unknown) => void;
      setValue?: (value: string) => void;
      getValue?: () => string;
      restoreViewState?: (state: unknown) => void;
      focus?: () => void;
    };
    const entry = ensureModelEntry(path, content, savedContent ?? content);
    clearTemporaryTabs(group, path);
    group.viewer.hideViewer();
    if (isActiveGroup(group)) {
      clearJumpHighlight(group);
    }
    group.isApplyingFile = true;
    if (entry && editor.setModel) {
      editor.setModel(entry.model as unknown);
    } else if (editor.setValue) {
      editor.setValue(content);
    }
    group.isApplyingFile = false;
    group.currentFilePath = path;
    group.currentFileSavedContent = entry?.savedContent ?? (savedContent ?? content);
    if (entry) {
      updateDirtyState(path, entry.model.getValue(), entry.savedContent);
    } else if (editor.getValue) {
      updateDirtyState(path, editor.getValue(), group.currentFileSavedContent ?? content);
    } else {
      updateDirtyState(path, content, group.currentFileSavedContent ?? content);
    }
    restoreViewState(group, path);
    addOpenTab(group, path);
    setEditorLanguage(group, path);
    deps.editorTabs.render(group);
    if (isActiveGroup(group)) {
      deps.fileTree.setSelection(path, "file");
      updateBreadcrumbs();
      updateMiniOutline();
      deps.outline.render();
      deps.fileTree.render();
    }
    deps.setBlockPreviewActive(false);
    deps.setAutoDetectedUi(false);
    if (pendingReveal && pendingReveal.path === path && pendingReveal.group === group.key) {
      revealLine(group, pendingReveal.line);
      pendingReveal = null;
    }
    if (isActiveGroup(group) && editor.focus) {
      editor.focus();
      deps.fileTree.setTreeFocus(false);
    }
    if (isActiveGroup(group)) {
      deps.buildOps.updateSynctexButtonState();
    }
  };

  const applyFormattedContent = (
    group: EditorGroupState,
    path: string,
    content: string,
    options?: { updateSaved?: boolean }
  ) => {
    if (!group.editor) {
      return;
    }
    const editor = group.editor as {
      getValue?: () => string;
      setValue?: (value: string) => void;
      saveViewState?: () => unknown;
      restoreViewState?: (state: unknown) => void;
    };
    const entry = monacoModels.get(path);
    const currentValue = entry?.model.getValue() ?? editor.getValue?.() ?? "";
    const viewState = editor.saveViewState?.();
    if (currentValue !== content) {
      group.isApplyingFile = true;
      if (entry?.model.setValue) {
        entry.model.setValue(content);
      } else if (editor.setValue) {
        editor.setValue(content);
      }
      group.isApplyingFile = false;
      if (viewState && editor.restoreViewState) {
        editor.restoreViewState(viewState);
      }
    }
    if (options?.updateSaved) {
      if (entry) {
        entry.savedContent = content;
      }
      if (group.currentFilePath === path) {
        group.currentFileSavedContent = content;
      }
    }
    const savedContent =
      (group.currentFilePath === path
        ? group.currentFileSavedContent
        : entry?.savedContent) ??
      entry?.savedContent ??
      content;
    updateDirtyState(path, content, savedContent);
    if (isActiveGroup(group)) {
      updateBreadcrumbs();
      deps.fileTree.render();
    }
  };

  const requestOpenFile = (path: string, groupKey: EditorGroupKey, force = false) => {
    const existingGroupKey = !force ? findGroupKeyByPath(path) : null;
    const resolvedGroupKey = force
      ? groupKey
      : existingGroupKey ?? resolveAutoOpenGroupKey(groupKey);
    const group = getEditorGroup(resolvedGroupKey);
    if (group.currentFilePath === path) {
      return false;
    }
    // Always cache buffer immediately (preserves IME composition text)
    if (!force) {
      cacheCurrentBuffer(group);
    }
    const requestEntry = { path, group: resolvedGroupKey };
    pendingOpenRequests.push(requestEntry);
    const ok = deps.postToNative({ type: "openFile", path });
    if (!ok) {
      const index = pendingOpenRequests.indexOf(requestEntry);
      if (index >= 0) {
        pendingOpenRequests.splice(index, 1);
      }
      deps.updateIssues(1, "ファイルを開けません。", "error", [
        { severity: "error", message: "ファイルを開けません。" },
      ]);
    }
    return ok;
  };

  const jumpToFileLine = (path: string, line: number, groupKey: EditorGroupKey) => {
    const group = getEditorGroup(groupKey);
    if (group.currentFilePath === path) {
      revealLine(group, line);
      return;
    }
    const requested = requestOpenFile(path, group.key);
    if (requested) {
      pendingReveal = { path, line, group: group.key };
    }
  };

  const jumpToLocation = (entry: IndexEntry) => {
    if (!entry.path || !entry.line) {
      return;
    }
    jumpToFileLine(entry.path, entry.line, activeEditorGroup);
  };

  const jumpToSearchResult = (result: SearchResult) => {
    jumpToFileLine(result.path, result.line, activeEditorGroup);
  };

  const saveCurrentFileInternal = () => {
    const activeGroup = getActiveGroup();
    const activePath = activeGroup.currentFilePath;
    if (!activePath || !activeGroup.editor || !isTextFilePath(activePath)) {
      const message = activePath
        ? "このファイル形式は編集できません。"
        : "保存するファイルが選択されていません。";
      deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
      return Promise.resolve(false);
    }
    const editor = activeGroup.editor as { getValue: () => string };
    const content = editor.getValue();
    return new Promise<boolean>((resolve, reject) => {
      pendingSave = { path: activePath as string, content, resolve, reject };
      const shouldFormat = false;
      const ok = deps.postToNative({
        type: "saveFile",
        path: activePath,
        content,
        format: shouldFormat,
        formatSource: "save",
        formatSettings: deps.settings.buildFormatSettingsPayload(),
      });
      if (!ok) {
        pendingSave = null;
        reject("ネイティブ連携が利用できません。");
      }
    });
  };

  const saveCurrentFile = () => {
    const activeGroup = getActiveGroup();
    if (!activeGroup.isComposing) {
      return saveCurrentFileInternal();
    }
    return new Promise<boolean>((resolve, reject) => {
      scheduleAfterComposition(activeGroup, () => {
        saveCurrentFileInternal().then(resolve).catch(reject);
      });
    });
  };

  const clearAutoSaveTimer = () => {
    if (autoSaveTimer) {
      window.clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }
    autoSavePending = false;
  };

  const scheduleAutoSave = () => {
    const activeGroup = getActiveGroup();
    const activePath = activeGroup.currentFilePath;
    if (!activePath || !isTextFilePath(activePath)) {
      clearAutoSaveTimer();
      return;
    }
    if (!activeGroup.isDirty) {
      clearAutoSaveTimer();
      return;
    }
    if (pendingSave) {
      autoSavePending = true;
      return;
    }
    clearAutoSaveTimer();
    autoSavePending = false;
    autoSaveTimer = window.setTimeout(() => {
      autoSaveTimer = null;
      saveCurrentFile().catch((message: string) => {
        deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
      });
    }, 400);
  };

  const handleOpenFileResult = (payload: {
    path: string;
    content?: string;
    error?: string;
    kind?: "text" | "image" | "pdf" | "unsupported";
    data?: string;
    mimeType?: string;
  }) => {
    const pendingIndex = pendingOpenRequests.findIndex((entry) => entry.path === payload.path);
    let targetGroupKey: EditorGroupKey =
      pendingIndex >= 0
        ? pendingOpenRequests.splice(pendingIndex, 1)[0].group
        : activeEditorGroup;
    if (pendingIndex < 0 && payload.path) {
      const existingGroupKey = findGroupKeyByPath(payload.path);
      if (existingGroupKey) {
        targetGroupKey = existingGroupKey;
      } else {
        targetGroupKey = resolveAutoOpenGroupKey(targetGroupKey);
      }
    }
    const targetGroup = getEditorGroup(targetGroupKey);
    if (payload.error) {
      if (
        pendingReveal &&
        pendingReveal.path === payload.path &&
        pendingReveal.group === targetGroupKey
      ) {
        pendingReveal = null;
      }
      deps.updateIssues(1, payload.error, "error", [
        { severity: "error", message: payload.error },
      ]);
      return;
    }
    const type = (payload as any).type;
    if (type === "searchResult") {
      deps.search.handleSearchUpdate(payload as any);
      return;
    }
    if (type === "env:checkResult") {
      deps.settings.updateEnvStatus((payload as any).command, (payload as any).available);
      return;
    }
    if (type === "env:installResult") {
      const { target, success, message } = payload as any;
      console.log(`Install result for ${target}: ${success} - ${message}`);
      if (!success) {
        alert(message);
      }
      return;
    }
    if (!payload.path) {
      return;
    }
    const path = payload.path;
    const kind =
      payload.kind ??
      (isPdfFilePath(path)
        ? "pdf"
        : isImageFilePath(path)
        ? "image"
        : isTextFilePath(path)
        ? "text"
        : "unsupported");
    if (kind === "image" || kind === "pdf") {
      applyViewerFile(targetGroup, path, kind, payload.data, payload.mimeType);
      return;
    }
    if (kind === "unsupported") {
      applyUnsupportedFile(targetGroup, path);
      return;
    }
    const content = payload.content ?? "";
    applyFileContent(targetGroup, path, content, content);
  };

  const handleSaveResult = (payload: {
    path: string;
    ok: boolean;
    error?: string;
    content?: string;
    formatError?: string;
  }) => {
    let savedContent: string | null = null;
    if (pendingSave && pendingSave.path === payload.path) {
      if (payload.ok) {
        if (payload.content) {
          pendingSave.content = payload.content;
        }
        savedContent = pendingSave.content;
        pendingSave.resolve(true);
      } else {
        pendingSave.reject(payload.error ?? "保存に失敗しました。");
      }
      pendingSave = null;
    }
    if (!payload.ok) {
      deps.updateIssues(1, payload.error ?? "保存に失敗しました。", "error", [
        { severity: "error", message: payload.error ?? "保存に失敗しました。" },
      ]);
      return;
    }
    const entry = monacoModels.get(payload.path);
    let resolvedSavedContent = savedContent;
    if (resolvedSavedContent === null) {
      if (payload.content) {
        resolvedSavedContent = payload.content;
      } else if (entry) {
        resolvedSavedContent = entry.model.getValue();
      }
    }
    if (resolvedSavedContent !== null) {
      if (entry) {
        entry.savedContent = resolvedSavedContent;
      }
      dirtyFiles.delete(payload.path);
    }
    const groupsWithFile = Object.values(editorGroups).filter(
      (group) => group.currentFilePath === payload.path
    );
    if (groupsWithFile.length > 0) {
      groupsWithFile.forEach((group) => {
        if (resolvedSavedContent !== null) {
          group.currentFileSavedContent = resolvedSavedContent;
        }
        if (payload.content) {
          applyFormattedContent(group, payload.path, payload.content, { updateSaved: true });
        } else if (group.editor && group.currentFileSavedContent !== null) {
          const editor = group.editor as { getValue: () => string };
          const currentValue = editor.getValue();
          updateDirtyState(payload.path, currentValue, group.currentFileSavedContent);
        } else {
          group.isDirty = false;
        }
      });
    }
    const activeGroup = getActiveGroup();
    if (activeGroup.currentFilePath !== payload.path) {
      activeGroup.isDirty = activeGroup.currentFilePath
        ? dirtyFiles.has(activeGroup.currentFilePath)
        : false;
    }
    if (autoSavePending) {
      autoSavePending = false;
      if (activeGroup.currentFilePath === payload.path && activeGroup.isDirty) {
        scheduleAutoSave();
      }
    }
    if (payload.formatError) {
      deps.buildOps.handleSaveFormatError(payload.formatError);
    }
    updateBreadcrumbs();
    deps.fileTree.render();
    forEachEditorGroup((group) => {
      if (group.openTabs.includes(payload.path)) {
        deps.editorTabs.render(group);
      }
    });
  };

  const handleRenameResult = (payload: {
    oldPath: string;
    newPath: string;
    isDirectory: boolean;
  }) => {
    const { oldPath, newPath } = payload;
    const remapPath = (path: string) => {
      if (payload.isDirectory) {
        if (path === oldPath || path.startsWith(`${oldPath}/`)) {
          return newPath + path.slice(oldPath.length);
        }
        return path;
      }
      return path === oldPath ? newPath : path;
    };
    deps.fileTree.handleRenameResult(payload);
    forEachEditorGroup((group) => {
      group.openTabs = group.openTabs.map((entry) => remapPath(entry));
      if (group.currentFilePath) {
        const nextPath = remapPath(group.currentFilePath);
        group.currentFilePath = nextPath;
      }
    });
    if (monacoModels.size > 0) {
      const updatedModels = new Map<string, MonacoModelEntry>();
      monacoModels.forEach((entry, path) => {
        updatedModels.set(remapPath(path), entry);
      });
      monacoModels.clear();
      updatedModels.forEach((entry, path) => monacoModels.set(path, entry));
    }
    forEachEditorGroup((group) => {
      if (group.viewStates.size > 0) {
        const updatedViewStates = new Map<string, unknown>();
        group.viewStates.forEach((state, path) => {
          updatedViewStates.set(remapPath(path), state);
        });
        group.viewStates.clear();
        updatedViewStates.forEach((state, path) => group.viewStates.set(path, state));
      }
    });
    if (dirtyFiles.size > 0) {
      const updatedDirty = new Set<string>();
      dirtyFiles.forEach((path) => {
        updatedDirty.add(remapPath(path));
      });
      dirtyFiles.clear();
      updatedDirty.forEach((path) => dirtyFiles.add(path));
    }
    forEachEditorGroup((group) => {
      if (group.currentFilePath) {
        group.isDirty = dirtyFiles.has(group.currentFilePath);
        setEditorLanguage(group, group.currentFilePath);
      }
      if (group.currentFilePath && !group.isDirty) {
        const entry = monacoModels.get(group.currentFilePath);
        if (entry) {
          group.currentFileSavedContent = entry.savedContent;
        } else if (group.editor) {
          const editor = group.editor as { getValue: () => string };
          group.currentFileSavedContent = editor.getValue();
        }
      }
    });
    updateBreadcrumbs();
    updateMiniOutline();
    deps.fileTree.render();
    forEachEditorGroup((group) => deps.editorTabs.render(group));
  };

  const syncWorkspaceFiles = (payload: { workspaceFiles: string[]; rootChanged: boolean }) => {
    const { workspaceFiles, rootChanged } = payload;
    if (rootChanged) {
      pendingReveal = null;
      lastCursorPositions.clear();
      deps.fileTree.clearSelection();
      forEachEditorGroup((group) => {
        group.currentFilePath = null;
        group.currentFileSavedContent = null;
        group.isDirty = false;
        group.openTabs = [];
        group.viewStates.clear();
        group.viewer.hideViewer();
        clearEditorView(group);
      });
      monacoModels.clear();
      dirtyFiles.clear();
    }
    if (monacoModels.size > 0) {
      Array.from(monacoModels.keys()).forEach((path) => {
        if (!workspaceFiles.includes(path)) {
          monacoModels.delete(path);
          dirtyFiles.delete(path);
        }
      });
    }
    forEachEditorGroup((group) => {
      if (group.viewStates.size > 0) {
        Array.from(group.viewStates.keys()).forEach((path) => {
          if (!workspaceFiles.includes(path)) {
            group.viewStates.delete(path);
          }
        });
      }
      if (group.currentFilePath && !workspaceFiles.includes(group.currentFilePath)) {
        group.currentFilePath = null;
        group.currentFileSavedContent = null;
        group.isDirty = false;
        if (isActiveGroup(group)) {
          deps.fileTree.clearSelection();
        }
      }
      if (group.openTabs.length > 0) {
        group.openTabs = group.openTabs.filter((path) => workspaceFiles.includes(path));
        if (group.currentFilePath && !group.openTabs.includes(group.currentFilePath)) {
          group.currentFilePath = null;
          group.currentFileSavedContent = null;
          group.isDirty = false;
        }
      }
      if (group.currentFilePath) {
        group.isDirty = dirtyFiles.has(group.currentFilePath);
      } else {
        group.viewer.hideViewer();
        clearEditorView(group);
      }
    });
    deps.fileTree.loadOpenState();
    deps.fileTree.render();
    updateBreadcrumbs();
    forEachEditorGroup((group) => deps.editorTabs.render(group));
    deps.outline.render();
  };

  const getDirtyPaths = () => dirtyFiles;

  const getStoredCursorPosition = (path: string) => lastCursorPositions.get(path) ?? null;

  const recordCursorPosition = (
    path: string,
    position: { lineNumber: number; column: number }
  ) => {
    lastCursorPositions.set(path, {
      line: position.lineNumber,
      column: position.column,
    });
  };

  return {
    getEditorGroup,
    getEditorGroups: () => Object.values(editorGroups),
    getActiveGroup,
    getActiveEditorGroupKey,
    getActiveFilePath,
    isActiveGroup,
    forEachEditorGroup,
    setEditorGroupEmptyState,
    isAnyGroupComposing,
    updateBreadcrumbs,
    updateMiniOutline,
    setActiveGroup,
    setSplitViewEnabled,
    getSplitViewEnabled,
    cacheCurrentBuffer,
    addOpenTab,
    closeTab,
    scheduleAfterComposition,
    handleCompositionEnd,
    updateDirtyState,
    clearJumpHighlight,
    scheduleAutoSave,
    requestOpenFile,
    jumpToFileLine,
    jumpToLocation,
    applyFormattedContent,
    saveCurrentFile,
    requestInitialOpen,
    openPendingFileIfReady,
    clearIssueHighlight,
    parseIssueDetail,
    focusIssue,
    handleOpenFileResult,
    handleSaveResult,
    handleRenameResult,
    syncWorkspaceFiles,
    getDirtyPaths,
    getStoredCursorPosition,
    recordCursorPosition,
  };
};
