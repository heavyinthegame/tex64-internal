import assert from "node:assert/strict";
import test from "node:test";

import { createEditorSessionFileOps } from "../../Resources/web/app/editor-session-file-ops.js";

const noop = () => {};

const ensureWindowShim = () => {
  if (!globalThis.window) {
    globalThis.window = {};
  }
  if (typeof globalThis.window.setTimeout !== "function") {
    globalThis.window.setTimeout = setTimeout;
  }
  if (typeof globalThis.window.clearTimeout !== "function") {
    globalThis.window.clearTimeout = clearTimeout;
  }
};

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const waitFor = async (predicate, timeoutMs = 1000) => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out while waiting for condition");
    }
    await flush();
  }
};

const createViewer = () => ({
  hideViewer: noop,
  showImageViewer: noop,
  showPdfViewer: noop,
  showUnsupportedViewer: noop,
});

const createGroup = (key) => ({
  key,
  root: null,
  tabs: null,
  tabsList: null,
  editorHost: null,
  viewer: createViewer(),
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
});

const createHarness = () => {
  ensureWindowShim();

  const calls = {
    postToNative: [],
    cacheCurrentBuffer: 0,
    scheduleAfterComposition: [],
  };

  const primary = createGroup("primary");
  primary.editor = {
    getValue: () => "next content",
  };
  primary.currentFilePath = "main.tex";
  primary.currentFileSavedContent = "old content";
  primary.isDirty = true;

  const secondary = createGroup("secondary");

  const editorGroups = { primary, secondary };
  const monacoModels = new Map();
  const dirtyFiles = new Set(["main.tex"]);
  const state = {
    pendingOpenRequests: [],
    pendingReveal: null,
    pendingSave: null,
    autoSaveTimer: null,
    autoSavePending: false,
  };

  const deps = {
    getMonacoApi: () => ({}),
    getWorkspaceFiles: () => ["main.tex"],
    getRootFilePath: () => "main.tex",
    postToNative: (payload) => {
      calls.postToNative.push(payload);
      return true;
    },
    updateIssues: noop,
    setAutoDetectedUi: noop,
    setBlockPreviewActive: noop,
    updateFallback: noop,
    fileTree: {
      setSelection: noop,
      clearSelection: noop,
      render: noop,
      loadOpenState: noop,
      setTreeFocus: noop,
      handleRenameResult: noop,
    },
    outline: { render: noop },
    editorTabs: { render: noop },
    buildOps: {
      updateSynctexButtonState: noop,
      handleSaveFormatError: noop,
    },
    settings: {
      buildFormatSettingsPayload: () => ({}),
      updateEnvStatus: noop,
    },
    search: {
      handleSearchUpdate: noop,
      handleRenameResult: noop,
    },
  };

  const api = createEditorSessionFileOps({
    deps,
    editorGroups,
    monacoModels,
    dirtyFiles,
    state,
    getActiveEditorGroupKey: () => "primary",
    getActiveGroup: () => primary,
    getEditorGroup: (key) => editorGroups[key],
    isActiveGroup: (group) => group.key === "primary",
    resolveAutoOpenGroupKey: (preferredKey) => preferredKey,
    findGroupKeyByPath: () => null,
    setSplitViewEnabled: noop,
    cacheCurrentBuffer: () => {
      calls.cacheCurrentBuffer += 1;
    },
    clearJumpHighlight: noop,
    clearTemporaryTabs: noop,
    addOpenTab: (group, path) => {
      if (!group.openTabs.includes(path)) {
        group.openTabs.push(path);
      }
    },
    updateDirtyState: noop,
    restoreViewState: noop,
    setEditorLanguage: noop,
    updateBreadcrumbs: noop,
    updateMiniOutline: noop,
    revealLine: noop,
    forEachEditorGroup: (handler) => {
      Object.values(editorGroups).forEach(handler);
    },
    scheduleAfterComposition: (_group, action) => {
      calls.scheduleAfterComposition.push(action);
    },
    getLanguageIdForPath: () => "latex",
  });

  return {
    api,
    calls,
    primary,
    dirtyFiles,
    state,
  };
};

test("requestOpenFile caches current buffer before opening another file", () => {
  const { api, calls, state } = createHarness();

  const ok = api.requestOpenFile("chapter-1.tex", "primary", false);

  assert.equal(ok, true);
  assert.equal(calls.cacheCurrentBuffer, 1);
  assert.equal(calls.postToNative.length, 1);
  assert.equal(calls.postToNative[0].type, "openFile");
  assert.deepEqual(state.pendingOpenRequests, [
    { path: "chapter-1.tex", group: "primary" },
  ]);
});

test("saveCurrentFile defers save request while composition is active", async () => {
  const { api, calls, primary, state } = createHarness();
  primary.isComposing = true;

  const pending = api.saveCurrentFile();

  assert.equal(calls.postToNative.length, 0);
  assert.equal(calls.scheduleAfterComposition.length, 1);

  calls.scheduleAfterComposition[0]();
  await waitFor(() => state.pendingSave !== null);

  assert.equal(calls.postToNative.length, 1);
  assert.equal(calls.postToNative[0].type, "saveFile");
  assert.equal(state.pendingSave.path, "main.tex");

  api.handleSaveResult({ path: "main.tex", ok: true });
  assert.equal(await pending, true);
});

test("saveDirtyFiles waits for composition completion before save", async () => {
  const { api, calls, primary, state, dirtyFiles } = createHarness();
  primary.isComposing = true;
  dirtyFiles.add("main.tex");

  const pending = api.saveDirtyFiles();

  assert.equal(calls.postToNative.length, 0);
  assert.equal(calls.scheduleAfterComposition.length, 1);

  calls.scheduleAfterComposition[0]();
  await waitFor(() => state.pendingSave !== null);

  assert.equal(calls.postToNative.length, 1);
  assert.equal(calls.postToNative[0].type, "saveFile");

  api.handleSaveResult({ path: "main.tex", ok: true });
  assert.equal(await pending, true);
});
