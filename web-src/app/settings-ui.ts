import type { AppContext } from "./context.js";
import type { EnvRegistryApi } from "./env-registry-ui.js";
import type {
  EditorFormatSettings,
  FormatSettingsPayload,
  AppSettingsSnapshot,
  BuildProfile,
} from "./types.js";
import {
  buildFormatSettingsPayload as buildFormatSettingsPayloadFromSettings,
  defaultEditorFormatSettings,
  normalizeEditorFormatSettings,
  normalizeVerbatimInput,
} from "./settings-format.js";
import {
  clampNumber,
  loadGhostCompletionConfig,
  saveGhostCompletionConfig,
} from "./settings-completion.js";
import { createEnvStatusManager } from "./settings-env.js";
import { initBuildProfilesUi } from "./settings-build-profiles.js";

type SettingsUiDeps = {
  envRegistry: EnvRegistryApi;
  getWorkspaceRootKey: () => string | null;
  getBuildProfiles: () => BuildProfile[];
  getBuildProfileId: () => string | null;
  postToNative: (
    payload: { type: string; [key: string]: unknown },
    silent?: boolean
  ) => boolean;
  onGhostCompletionChange?: (enabled: boolean) => void;
  onGhostCompletionConfigChange?: (config: { debounceMs: number; maxChars: number }) => void;
};

export type SettingsUiApi = {
  getEditorAlignEnvEnabled: () => boolean;
  getAutoSynctexOnBuildEnabled: () => boolean;
  getReverseSynctexEnabled: () => boolean;
  getPdfViewerMode: () => "window" | "tab";
  getGhostCompletionEnabled: () => boolean;
  getGhostCompletionConfig: () => { debounceMs: number; maxChars: number };
  buildFormatSettingsPayload: () => FormatSettingsPayload;
  getSettingsSnapshot: () => AppSettingsSnapshot;
  applySettingsPatch: (patch: Partial<AppSettingsSnapshot>) => AppSettingsSnapshot;
  checkEnvironmentStatus: () => void;
  updateEnvStatus: (command: string, available: boolean) => void;
  refreshCompileEngine: () => void;
  openSettingsPage: (pageId: string | null) => void;
  loadStartupSettings: () => void;
  loadWorkspaceSettings: () => void;
};

export const initSettingsUi = (
  context: AppContext,
  deps: SettingsUiDeps
): SettingsUiApi => {
  const {
    settingsPanel,
    settingsNav,
    settingsNavItems,
    settingsPages,
    settingsPageItems,
    settingsBackButtons,
    settingsCompileEngineSelect,
    settingsEnvRefresh,
    editorAlignEnvToggle,
    editorFormatIndentSelect,
    editorFormatBeginEndToggle,
    editorFormatDocumentNoIndentToggle,
    editorFormatAlignMathToggle,
    editorFormatAlignTableToggle,
    editorFormatBlankLinesSelect,
    editorFormatVerbatimInput,
    editorFormatVerbatimAdd,
    editorFormatVerbatimHint,
    editorFormatVerbatimList,
    editorAutoSynctexBuildToggle,
    editorReverseSynctexToggle,
    editorGhostCompletionToggle,
    editorGhostCompletionDebounce,
    editorGhostCompletionMaxChars,
    editorPdfWindowToggle,
  } = context.dom;

  let activeSettingsPage: string | null = null;
  let editorAlignEnvEnabled = true;
  let editorFormatSettings: EditorFormatSettings = {
    ...defaultEditorFormatSettings,
  };
  let autoSynctexOnBuildEnabled = true;
  let reverseSynctexEnabled = true;
  let ghostCompletionEnabled = true;
  let ghostCompletionDebounceMs = 120;
  let ghostCompletionMaxChars = 140;
  let pdfViewerMode: "window" | "tab" = "window";

  const compileEngineKey = "tex64.compileEngine";
  const editorAutoSynctexOnBuildKey = "tex64.editor.autoSynctexOnBuild";
  const editorReverseSynctexKey = "tex64.editor.reverseSynctex";
  const editorGhostCompletionKey = "tex64.editor.ghostCompletion";
  const editorGhostCompletionDebounceKey = "tex64.editor.ghostCompletion.debounceMs";
  const editorGhostCompletionMaxCharsKey = "tex64.editor.ghostCompletion.maxChars";
  const editorAutoSynctexOnPdfOpenKey = "tex64.editor.autoSynctexOnPdfOpen";
  const editorPdfViewerModeKey = "tex64.editor.pdfViewerMode";
  const editorAlignEnvKey = "tex64.editor.alignEnv";
  const editorFormatSettingsKey = "tex64.editor.formatSettings";
  const ghostCompletionDebounceRange = { min: 0, max: 2000 };
  const ghostCompletionMaxCharsRange = { min: 20, max: 400 };
  const texEngineCommands = new Set(["lualatex", "pdflatex", "xelatex", "uplatex"]);
  const envCheckTargets = [
    "lualatex",
    "pdflatex",
    "xelatex",
    "uplatex",
    "latexmk",
    "latexindent",
    "synctex",
    "chktex",
  ];
  const envDisplayTargets = ["lualatex", "latexmk", "latexindent", "synctex", "chktex"];
  const envManager = createEnvStatusManager({
    postToNative: deps.postToNative,
    envCheckTargets,
    envDisplayTargets,
    texEngineCommands,
  });
  const { checkEnvironmentStatus, updateEnvStatus } = envManager;

  const updateEngineUI = () => {
    if (!(settingsCompileEngineSelect instanceof HTMLSelectElement)) {
      return;
    }
    const savedEngine = localStorage.getItem(compileEngineKey) || "lualatex";
    const hasOption = Array.from(settingsCompileEngineSelect.options).some(
      (option) => option.value === savedEngine
    );
    settingsCompileEngineSelect.value = hasOption ? savedEngine : "lualatex";
  };

  const buildFormatSettingsPayload = (): FormatSettingsPayload =>
    buildFormatSettingsPayloadFromSettings(editorFormatSettings, deps.envRegistry);

  const envBtns = Array.from(document.querySelectorAll<HTMLButtonElement>(".env-btn"));
  envBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.target;
      if (!target) {
        return;
      }

      btn.textContent = "インストール中...";
      btn.disabled = true;
      deps.postToNative({ type: "env:install", target });
    });
  });

  if (settingsCompileEngineSelect instanceof HTMLSelectElement) {
    settingsCompileEngineSelect.addEventListener("change", () => {
      if (settingsCompileEngineSelect.value) {
        localStorage.setItem(compileEngineKey, settingsCompileEngineSelect.value);
      }
    });
  }

  const updateSettingsToggle = (element: HTMLElement | null, enabled: boolean) => {
    if (element instanceof HTMLInputElement) {
      element.checked = enabled;
    }
  };

  const setEditorFormatVerbatimHint = (message: string) => {
    if (editorFormatVerbatimHint instanceof HTMLElement) {
      editorFormatVerbatimHint.textContent = message;
    }
  };

  const renderEditorFormatVerbatimList = () => {
    if (!(editorFormatVerbatimList instanceof HTMLElement)) {
      return;
    }
    editorFormatVerbatimList.innerHTML = "";
    const entries = Array.from(new Set(editorFormatSettings.customVerbatim)).sort((a, b) =>
      a.localeCompare(b, "ja")
    );
    entries.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "env-registry-row";
      row.dataset.verbatimName = entry;

      const spacer = document.createElement("div");
      spacer.className = "env-registry-spacer";
      row.appendChild(spacer);

      const label = document.createElement("div");
      label.className = "env-registry-label";

      const name = document.createElement("span");
      name.className = "env-registry-name";
      name.textContent = entry;
      label.appendChild(name);

      const flag = document.createElement("span");
      flag.className = "env-registry-flag is-custom";
      flag.textContent = "custom";
      label.appendChild(flag);

      row.appendChild(label);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "panel-button ghost env-registry-remove";
      remove.textContent = "削除";
      remove.dataset.verbatimAction = "remove";
      remove.dataset.verbatimName = entry;
      row.appendChild(remove);

      editorFormatVerbatimList.appendChild(row);
    });
  };

  const updateEditorFormatSettingsUI = () => {
    if (editorFormatIndentSelect instanceof HTMLSelectElement) {
      editorFormatIndentSelect.value = editorFormatSettings.indentStyle;
    }
    if (editorFormatBlankLinesSelect instanceof HTMLSelectElement) {
      editorFormatBlankLinesSelect.value = editorFormatSettings.blankLines;
    }
    updateSettingsToggle(
      editorFormatBeginEndToggle,
      editorFormatSettings.beginEndOnOwnLine
    );
    updateSettingsToggle(
      editorFormatDocumentNoIndentToggle,
      editorFormatSettings.documentNoIndent
    );
    updateSettingsToggle(
      editorFormatAlignMathToggle,
      editorFormatSettings.alignMathDelims
    );
    updateSettingsToggle(
      editorFormatAlignTableToggle,
      editorFormatSettings.alignTableDelims
    );
    renderEditorFormatVerbatimList();
  };

  const updateEditorAlignEnvUI = () => {
    if (editorAlignEnvToggle instanceof HTMLInputElement) {
      editorAlignEnvToggle.checked = editorAlignEnvEnabled;
    }
  };

  const updateEditorAutoSynctexBuildUI = () => {
    if (editorAutoSynctexBuildToggle instanceof HTMLInputElement) {
      editorAutoSynctexBuildToggle.checked = autoSynctexOnBuildEnabled;
    }
  };

  const updateEditorReverseSynctexUI = () => {
    if (editorReverseSynctexToggle instanceof HTMLInputElement) {
      editorReverseSynctexToggle.checked = reverseSynctexEnabled;
    }
  };

  const updateEditorGhostCompletionUI = () => {
    if (editorGhostCompletionToggle instanceof HTMLInputElement) {
      editorGhostCompletionToggle.checked = ghostCompletionEnabled;
    }
    const configItems = Array.from(
      document.querySelectorAll<HTMLElement>("[data-ghost-config]")
    );
    configItems.forEach((item) => {
      item.classList.toggle("is-disabled", !ghostCompletionEnabled);
      item.setAttribute("aria-disabled", ghostCompletionEnabled ? "false" : "true");
    });
    if (editorGhostCompletionDebounce instanceof HTMLInputElement) {
      editorGhostCompletionDebounce.disabled = !ghostCompletionEnabled;
    }
    if (editorGhostCompletionMaxChars instanceof HTMLInputElement) {
      editorGhostCompletionMaxChars.disabled = !ghostCompletionEnabled;
    }
  };

  const updateEditorGhostCompletionConfigUI = () => {
    if (editorGhostCompletionDebounce instanceof HTMLInputElement) {
      editorGhostCompletionDebounce.value = String(ghostCompletionDebounceMs);
    }
    if (editorGhostCompletionMaxChars instanceof HTMLInputElement) {
      editorGhostCompletionMaxChars.value = String(ghostCompletionMaxChars);
    }
    updateEditorGhostCompletionUI();
  };

  const updateEditorPdfViewerModeUI = () => {
    if (editorPdfWindowToggle instanceof HTMLInputElement) {
      editorPdfWindowToggle.checked = pdfViewerMode === "window";
    }
  };

  const buildProfilesUi = initBuildProfilesUi(context, {
    getWorkspaceRootKey: deps.getWorkspaceRootKey,
    getBuildProfiles: deps.getBuildProfiles,
    getBuildProfileId: deps.getBuildProfileId,
    postToNative: deps.postToNative,
  });

  const setSettingsPage = (pageId: string | null) => {
    activeSettingsPage = pageId;
    const hasPage = !!pageId;
    if (settingsNav instanceof HTMLElement) {
      settingsNav.classList.toggle("is-hidden", hasPage);
      settingsNav.setAttribute("aria-hidden", hasPage ? "true" : "false");
    }
    if (settingsPages instanceof HTMLElement) {
      settingsPages.classList.toggle("is-hidden", !hasPage);
      settingsPages.setAttribute("aria-hidden", hasPage ? "false" : "true");
    }
    settingsPageItems.forEach((page) => {
      const isActive = hasPage && page.dataset.settingsPage === pageId;
      page.classList.toggle("is-hidden", !isActive);
      page.classList.toggle("is-active", isActive);
      page.setAttribute("aria-hidden", isActive ? "false" : "true");
    });
    if (settingsPanel instanceof HTMLElement) {
      settingsPanel.scrollTop = 0;
    }
    if (pageId === "runtime") {
      checkEnvironmentStatus();
    }
  };

  const loadEditorAlignEnvState = () => {
    const stored = localStorage.getItem(editorAlignEnvKey);
    if (stored !== null) {
      editorAlignEnvEnabled = stored !== "false";
      updateEditorAlignEnvUI();
      return;
    }
    const workspaceRootKey = deps.getWorkspaceRootKey();
    if (workspaceRootKey) {
      const legacyKey = `tex64.project.alignEnv.${workspaceRootKey}`;
      const legacy = localStorage.getItem(legacyKey);
      if (legacy !== null) {
        editorAlignEnvEnabled = legacy !== "false";
        localStorage.setItem(
          editorAlignEnvKey,
          editorAlignEnvEnabled ? "true" : "false"
        );
        updateEditorAlignEnvUI();
        return;
      }
    }
    editorAlignEnvEnabled = true;
    updateEditorAlignEnvUI();
  };

  const loadEditorFormatSettings = () => {
    const stored = localStorage.getItem(editorFormatSettingsKey);
    if (stored !== null) {
      try {
        editorFormatSettings = normalizeEditorFormatSettings(JSON.parse(stored));
      } catch {
        editorFormatSettings = { ...defaultEditorFormatSettings };
      }
    } else {
      editorFormatSettings = { ...defaultEditorFormatSettings };
    }
    updateEditorFormatSettingsUI();
  };

  const loadEditorAutoSynctexBuildState = () => {
    const stored = localStorage.getItem(editorAutoSynctexOnBuildKey);
    if (stored !== null) {
      autoSynctexOnBuildEnabled = stored !== "false";
    } else {
      const legacy = localStorage.getItem(editorAutoSynctexOnPdfOpenKey);
      autoSynctexOnBuildEnabled = legacy !== null ? legacy !== "false" : true;
      if (legacy !== null) {
        localStorage.setItem(
          editorAutoSynctexOnBuildKey,
          autoSynctexOnBuildEnabled ? "true" : "false"
        );
      }
    }
    updateEditorAutoSynctexBuildUI();
  };

  const loadEditorReverseSynctexState = () => {
    const stored = localStorage.getItem(editorReverseSynctexKey);
    if (stored !== null) {
      reverseSynctexEnabled = stored !== "false";
    } else {
      reverseSynctexEnabled = true;
    }
    updateEditorReverseSynctexUI();
  };

  const loadEditorGhostCompletionState = () => {
    const stored = localStorage.getItem(editorGhostCompletionKey);
    if (stored !== null) {
      ghostCompletionEnabled = stored !== "false";
    } else {
      ghostCompletionEnabled = true;
    }
    updateEditorGhostCompletionUI();
  };

  const loadEditorGhostCompletionConfig = () => {
    const config = loadGhostCompletionConfig({
      debounceKey: editorGhostCompletionDebounceKey,
      maxCharsKey: editorGhostCompletionMaxCharsKey,
      debounceRange: ghostCompletionDebounceRange,
      maxCharsRange: ghostCompletionMaxCharsRange,
      defaults: { debounceMs: 120, maxChars: 140 },
    });
    ghostCompletionDebounceMs = config.debounceMs;
    ghostCompletionMaxChars = config.maxChars;
    updateEditorGhostCompletionConfigUI();
  };

  const loadEditorPdfViewerModeState = () => {
    const stored = localStorage.getItem(editorPdfViewerModeKey);
    if (stored === "tab" || stored === "window") {
      pdfViewerMode = stored;
    } else {
      pdfViewerMode = "window";
    }
    updateEditorPdfViewerModeUI();
  };

  const saveEditorAlignEnvState = () => {
    localStorage.setItem(
      editorAlignEnvKey,
      editorAlignEnvEnabled ? "true" : "false"
    );
  };

  const saveEditorFormatSettings = () => {
    try {
      localStorage.setItem(
        editorFormatSettingsKey,
        JSON.stringify(editorFormatSettings)
      );
    } catch {
      // ignore storage failures
    }
  };

  const saveEditorAutoSynctexBuildState = () => {
    localStorage.setItem(
      editorAutoSynctexOnBuildKey,
      autoSynctexOnBuildEnabled ? "true" : "false"
    );
  };

  const saveEditorReverseSynctexState = () => {
    localStorage.setItem(
      editorReverseSynctexKey,
      reverseSynctexEnabled ? "true" : "false"
    );
  };

  const saveEditorGhostCompletionState = () => {
    localStorage.setItem(
      editorGhostCompletionKey,
      ghostCompletionEnabled ? "true" : "false"
    );
  };

  const saveEditorGhostCompletionConfig = () => {
    saveGhostCompletionConfig({
      debounceKey: editorGhostCompletionDebounceKey,
      maxCharsKey: editorGhostCompletionMaxCharsKey,
      debounceMs: ghostCompletionDebounceMs,
      maxChars: ghostCompletionMaxChars,
    });
  };

  const saveEditorPdfViewerModeState = () => {
    localStorage.setItem(editorPdfViewerModeKey, pdfViewerMode);
  };

  const setCompileEngine = (engine: string) => {
    if (!engine || !texEngineCommands.has(engine)) {
      return;
    }
    localStorage.setItem(compileEngineKey, engine);
    updateEngineUI();
  };

  const setEditorAlignEnvEnabled = (enabled: boolean) => {
    editorAlignEnvEnabled = Boolean(enabled);
    saveEditorAlignEnvState();
    updateEditorAlignEnvUI();
  };

  const toggleEditorAlignEnv = () => {
    editorAlignEnvEnabled = !editorAlignEnvEnabled;
    saveEditorAlignEnvState();
    updateEditorAlignEnvUI();
  };

  const setEditorFormatSettings = (next: Partial<EditorFormatSettings>) => {
    editorFormatSettings = normalizeEditorFormatSettings({
      ...editorFormatSettings,
      ...next,
    });
    saveEditorFormatSettings();
    updateEditorFormatSettingsUI();
  };

  const addEditorFormatVerbatim = (value: string) => {
    const name = normalizeVerbatimInput(value);
    if (!name) {
      setEditorFormatVerbatimHint("環境名が空です。");
      return;
    }
    if (editorFormatSettings.customVerbatim.includes(name)) {
      setEditorFormatVerbatimHint("既に登録されています。");
      return;
    }
    setEditorFormatSettings({
      customVerbatim: editorFormatSettings.customVerbatim.concat(name),
    });
    setEditorFormatVerbatimHint(`${name} を追加しました。`);
  };

  const removeEditorFormatVerbatim = (value: string) => {
    const name = normalizeVerbatimInput(value);
    if (!name) {
      return;
    }
    const next = editorFormatSettings.customVerbatim.filter(
      (entry) => normalizeVerbatimInput(entry) !== name
    );
    if (next.length === editorFormatSettings.customVerbatim.length) {
      return;
    }
    setEditorFormatSettings({ customVerbatim: next });
    setEditorFormatVerbatimHint(`${name} を削除しました。`);
  };

  const handleEditorFormatVerbatimListClick = (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (!target) {
      return;
    }
    if (target.dataset.verbatimAction !== "remove") {
      return;
    }
    const name = target.dataset.verbatimName;
    if (!name) {
      return;
    }
    removeEditorFormatVerbatim(name);
  };

  const toggleEditorAutoSynctexBuild = () => {
    autoSynctexOnBuildEnabled = !autoSynctexOnBuildEnabled;
    saveEditorAutoSynctexBuildState();
    updateEditorAutoSynctexBuildUI();
  };

  const setEditorAutoSynctexBuildEnabled = (enabled: boolean) => {
    autoSynctexOnBuildEnabled = Boolean(enabled);
    saveEditorAutoSynctexBuildState();
    updateEditorAutoSynctexBuildUI();
  };

  const toggleEditorReverseSynctex = () => {
    reverseSynctexEnabled = !reverseSynctexEnabled;
    saveEditorReverseSynctexState();
    updateEditorReverseSynctexUI();
  };

  const setEditorReverseSynctexEnabled = (enabled: boolean) => {
    reverseSynctexEnabled = Boolean(enabled);
    saveEditorReverseSynctexState();
    updateEditorReverseSynctexUI();
  };

  const toggleEditorGhostCompletion = () => {
    ghostCompletionEnabled = !ghostCompletionEnabled;
    saveEditorGhostCompletionState();
    updateEditorGhostCompletionUI();
    deps.onGhostCompletionChange?.(ghostCompletionEnabled);
  };

  const setGhostCompletionEnabled = (enabled: boolean) => {
    ghostCompletionEnabled = Boolean(enabled);
    saveEditorGhostCompletionState();
    updateEditorGhostCompletionUI();
    deps.onGhostCompletionChange?.(ghostCompletionEnabled);
  };

  const setGhostCompletionConfig = (next: { debounceMs?: number; maxChars?: number }) => {
    const debounce = clampNumber(
      typeof next.debounceMs === "number" ? next.debounceMs : ghostCompletionDebounceMs,
      ghostCompletionDebounceRange.min,
      ghostCompletionDebounceRange.max,
      ghostCompletionDebounceMs
    );
    const maxChars = clampNumber(
      typeof next.maxChars === "number" ? next.maxChars : ghostCompletionMaxChars,
      ghostCompletionMaxCharsRange.min,
      ghostCompletionMaxCharsRange.max,
      ghostCompletionMaxChars
    );
    ghostCompletionDebounceMs = debounce;
    ghostCompletionMaxChars = maxChars;
    saveEditorGhostCompletionConfig();
    updateEditorGhostCompletionConfigUI();
    deps.onGhostCompletionConfigChange?.({
      debounceMs: ghostCompletionDebounceMs,
      maxChars: ghostCompletionMaxChars,
    });
  };

  const setPdfViewerMode = (mode: "window" | "tab") => {
    pdfViewerMode = mode;
    saveEditorPdfViewerModeState();
    updateEditorPdfViewerModeUI();
  };

  const loadStartupSettings = () => {
    loadEditorAutoSynctexBuildState();
    loadEditorReverseSynctexState();
    loadEditorGhostCompletionState();
    loadEditorGhostCompletionConfig();
    loadEditorPdfViewerModeState();
  };

  const loadWorkspaceSettings = () => {
    loadStartupSettings();
    loadEditorAlignEnvState();
    loadEditorFormatSettings();
    buildProfilesUi.render();
  };

  const getSettingsSnapshot = (): AppSettingsSnapshot => ({
    compileEngine: localStorage.getItem(compileEngineKey) || "lualatex",
    autoSynctexOnBuild: autoSynctexOnBuildEnabled,
    reverseSynctexEnabled,
    pdfViewerMode,
    ghostCompletionEnabled,
    ghostCompletionDebounceMs,
    ghostCompletionMaxChars,
    alignEnv: editorAlignEnvEnabled,
    formatSettings: {
      ...editorFormatSettings,
      customVerbatim: [...editorFormatSettings.customVerbatim],
    },
  });

  const applySettingsPatch = (patch: Partial<AppSettingsSnapshot>): AppSettingsSnapshot => {
    if (!patch || typeof patch !== "object") {
      return getSettingsSnapshot();
    }
    if (typeof patch.compileEngine === "string") {
      setCompileEngine(patch.compileEngine);
    }
    if (typeof patch.autoSynctexOnBuild === "boolean") {
      setEditorAutoSynctexBuildEnabled(patch.autoSynctexOnBuild);
    }
    if (typeof patch.reverseSynctexEnabled === "boolean") {
      setEditorReverseSynctexEnabled(patch.reverseSynctexEnabled);
    }
    if (typeof patch.ghostCompletionEnabled === "boolean") {
      setGhostCompletionEnabled(patch.ghostCompletionEnabled);
    }
    if (typeof patch.ghostCompletionDebounceMs === "number") {
      setGhostCompletionConfig({ debounceMs: patch.ghostCompletionDebounceMs });
    }
    if (typeof patch.ghostCompletionMaxChars === "number") {
      setGhostCompletionConfig({ maxChars: patch.ghostCompletionMaxChars });
    }
    if (patch.pdfViewerMode === "window" || patch.pdfViewerMode === "tab") {
      setPdfViewerMode(patch.pdfViewerMode);
    }
    if (typeof patch.alignEnv === "boolean") {
      setEditorAlignEnvEnabled(patch.alignEnv);
    }
    if (patch.formatSettings && typeof patch.formatSettings === "object") {
      setEditorFormatSettings(patch.formatSettings);
    }
    return getSettingsSnapshot();
  };

  setSettingsPage(activeSettingsPage);
  updateEngineUI();

  if (settingsNavItems.length > 0) {
    settingsNavItems.forEach((button) => {
      button.addEventListener("click", () => {
        const target = button.dataset.settingsTarget;
        if (!target) {
          return;
        }
        setSettingsPage(target);
      });
    });
  }

  if (settingsBackButtons.length > 0) {
    settingsBackButtons.forEach((button) => {
      button.addEventListener("click", () => {
        setSettingsPage(null);
      });
    });
  }

  if (editorFormatIndentSelect instanceof HTMLSelectElement) {
    editorFormatIndentSelect.addEventListener("change", () => {
      const value = editorFormatIndentSelect.value;
      if (value === "spaces-2" || value === "spaces-4" || value === "tab") {
        setEditorFormatSettings({ indentStyle: value });
      }
    });
  }

  if (editorFormatBlankLinesSelect instanceof HTMLSelectElement) {
    editorFormatBlankLinesSelect.addEventListener("change", () => {
      const value = editorFormatBlankLinesSelect.value;
      if (value === "preserve" || value === "condense" || value === "remove") {
        setEditorFormatSettings({ blankLines: value });
      }
    });
  }

  if (editorFormatBeginEndToggle instanceof HTMLInputElement) {
    editorFormatBeginEndToggle.addEventListener("change", () => {
      setEditorFormatSettings({
        beginEndOnOwnLine: editorFormatBeginEndToggle.checked,
      });
    });
  }

  if (editorFormatDocumentNoIndentToggle instanceof HTMLInputElement) {
    editorFormatDocumentNoIndentToggle.addEventListener("change", () => {
      setEditorFormatSettings({
        documentNoIndent: editorFormatDocumentNoIndentToggle.checked,
      });
    });
  }

  if (editorFormatAlignMathToggle instanceof HTMLInputElement) {
    editorFormatAlignMathToggle.addEventListener("change", () => {
      setEditorFormatSettings({
        alignMathDelims: editorFormatAlignMathToggle.checked,
      });
    });
  }

  if (editorFormatAlignTableToggle instanceof HTMLInputElement) {
    editorFormatAlignTableToggle.addEventListener("change", () => {
      setEditorFormatSettings({
        alignTableDelims: editorFormatAlignTableToggle.checked,
      });
    });
  }

  if (editorFormatVerbatimAdd instanceof HTMLButtonElement) {
    editorFormatVerbatimAdd.addEventListener("click", () => {
      if (!(editorFormatVerbatimInput instanceof HTMLInputElement)) {
        return;
      }
      addEditorFormatVerbatim(editorFormatVerbatimInput.value);
      editorFormatVerbatimInput.value = "";
      editorFormatVerbatimInput.focus();
      editorFormatVerbatimInput.select();
    });
  }

  if (editorFormatVerbatimInput instanceof HTMLInputElement) {
    editorFormatVerbatimInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      editorFormatVerbatimAdd?.dispatchEvent(new MouseEvent("click"));
    });
  }

  if (editorFormatVerbatimList instanceof HTMLElement) {
    editorFormatVerbatimList.addEventListener("click", handleEditorFormatVerbatimListClick);
  }

  if (editorAlignEnvToggle instanceof HTMLInputElement) {
    editorAlignEnvToggle.addEventListener("change", () => {
      toggleEditorAlignEnv();
    });
  }

  if (editorAutoSynctexBuildToggle instanceof HTMLInputElement) {
    editorAutoSynctexBuildToggle.addEventListener("change", () => {
      toggleEditorAutoSynctexBuild();
    });
  }

  if (editorReverseSynctexToggle instanceof HTMLInputElement) {
    editorReverseSynctexToggle.addEventListener("change", () => {
      toggleEditorReverseSynctex();
    });
  }

  if (editorGhostCompletionToggle instanceof HTMLInputElement) {
    editorGhostCompletionToggle.addEventListener("change", () => {
      toggleEditorGhostCompletion();
    });
  }

  if (editorGhostCompletionDebounce instanceof HTMLInputElement) {
    editorGhostCompletionDebounce.addEventListener("change", () => {
      setGhostCompletionConfig({
        debounceMs: editorGhostCompletionDebounce.valueAsNumber,
      });
    });
  }

  if (editorGhostCompletionMaxChars instanceof HTMLInputElement) {
    editorGhostCompletionMaxChars.addEventListener("change", () => {
      setGhostCompletionConfig({
        maxChars: editorGhostCompletionMaxChars.valueAsNumber,
      });
    });
  }

  if (editorPdfWindowToggle instanceof HTMLInputElement) {
    editorPdfWindowToggle.addEventListener("change", () => {
      setPdfViewerMode(editorPdfWindowToggle.checked ? "window" : "tab");
    });
  }

  if (settingsEnvRefresh instanceof HTMLButtonElement) {
    settingsEnvRefresh.addEventListener("click", () => {
      checkEnvironmentStatus();
    });
  }

  return {
    getEditorAlignEnvEnabled: () => editorAlignEnvEnabled,
    getAutoSynctexOnBuildEnabled: () => autoSynctexOnBuildEnabled,
    getReverseSynctexEnabled: () => reverseSynctexEnabled,
    getPdfViewerMode: () => pdfViewerMode,
    getGhostCompletionEnabled: () => ghostCompletionEnabled,
    getGhostCompletionConfig: () => ({
      debounceMs: ghostCompletionDebounceMs,
      maxChars: ghostCompletionMaxChars,
    }),
    buildFormatSettingsPayload,
    getSettingsSnapshot,
    applySettingsPatch,
    checkEnvironmentStatus,
    updateEnvStatus,
    refreshCompileEngine: updateEngineUI,
    openSettingsPage: (pageId) => setSettingsPage(pageId),
    loadStartupSettings,
    loadWorkspaceSettings,
  };
};
