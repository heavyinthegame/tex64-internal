import { LATEX_FILE_EXTENSIONS, PINNED_TAB_EXTENSIONS, getFileExtension, isImageFilePath, isPdfFilePath, isTextFilePath, } from "./files.js";
export const initEditorSession = (context, deps) => {
    var _a, _b;
    const { editorGroups: editorGroupsRoot, editorTabs, editorTabsList, editorTabsSecondary, editorTabsListSecondary, editorHost, editorHostSecondary, editorSplitButton, } = context.dom;
    const editorGroupsRootEl = editorGroupsRoot instanceof HTMLElement ? editorGroupsRoot : null;
    const editorGroupPrimary = (_a = editorGroupsRootEl === null || editorGroupsRootEl === void 0 ? void 0 : editorGroupsRootEl.querySelector('[data-editor-group="primary"]')) !== null && _a !== void 0 ? _a : null;
    const editorGroupSecondary = (_b = editorGroupsRootEl === null || editorGroupsRootEl === void 0 ? void 0 : editorGroupsRootEl.querySelector('[data-editor-group="secondary"]')) !== null && _b !== void 0 ? _b : null;
    const editorGroups = {
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
    let activeEditorGroup = "primary";
    let splitViewEnabled = false;
    const pendingOpenRequests = [];
    let issueDecorations = [];
    const jumpDecorations = {
        primary: [],
        secondary: [],
    };
    let pendingReveal = null;
    let pendingSave = null;
    let autoSaveTimer = null;
    let autoSavePending = false;
    let pendingAutoOpenPath = null;
    const lastCursorPositions = new Map();
    const monacoModels = new Map();
    const dirtyFiles = new Set();
    let emptyEditorModel = null;
    const getEditorGroup = (key) => editorGroups[key];
    const getActiveGroup = () => editorGroups[activeEditorGroup];
    const getActiveEditorGroupKey = () => activeEditorGroup;
    const getActiveFilePath = () => getActiveGroup().currentFilePath;
    const getActiveEditor = () => getActiveGroup().editor;
    const isActiveGroup = (group) => group.key === activeEditorGroup;
    const getOtherGroupKey = (key) => key === "primary" ? "secondary" : "primary";
    const resolveAutoOpenGroupKey = (preferredKey) => {
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
    const findGroupKeyByPath = (path) => {
        const groups = Object.keys(editorGroups);
        for (const key of groups) {
            if (editorGroups[key].openTabs.includes(path)) {
                return key;
            }
        }
        return null;
    };
    const forEachEditorGroup = (handler) => {
        Object.keys(editorGroups).forEach((key) => {
            handler(editorGroups[key]);
        });
    };
    const setEditorGroupEmptyState = (group, isEmpty) => {
        var _a;
        if (group.root instanceof HTMLElement) {
            group.root.classList.toggle("is-empty", isEmpty);
        }
        if (!isEmpty && group.editor) {
            const editor = group.editor;
            (_a = editor.layout) === null || _a === void 0 ? void 0 : _a.call(editor);
        }
    };
    const isAnyGroupComposing = () => Object.values(editorGroups).some((group) => group.isComposing);
    const clearIssueHighlight = () => {
        const activeGroup = getActiveGroup();
        const monacoApi = deps.getMonacoApi();
        if (!activeGroup.editor || !monacoApi || issueDecorations.length === 0) {
            return;
        }
        const editor = activeGroup.editor;
        issueDecorations = editor.deltaDecorations(issueDecorations, []);
    };
    const parseIssueDetail = (issue) => {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const trimmed = issue.message.trim();
        const match = (_b = (_a = trimmed.match(/^(.+?\.tex):(\d+):(\d+):\s*(.+)$/)) !== null && _a !== void 0 ? _a : trimmed.match(/^(.+?\.tex):(\d+):\s*(.+)$/)) !== null && _b !== void 0 ? _b : trimmed.match(/^(.+?):(\d+):\s*(.+)$/);
        if (match) {
            const path = (_c = issue.path) !== null && _c !== void 0 ? _c : match[1];
            const line = (_d = issue.line) !== null && _d !== void 0 ? _d : Number.parseInt(match[2], 10);
            const column = (_e = issue.column) !== null && _e !== void 0 ? _e : (match.length > 4 && match[3] && /^\d+$/.test(match[3])
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
            path: (_f = issue.path) !== null && _f !== void 0 ? _f : null,
            line: (_g = issue.line) !== null && _g !== void 0 ? _g : null,
            column: (_h = issue.column) !== null && _h !== void 0 ? _h : null,
            message: trimmed,
        };
    };
    const focusIssue = (issue) => {
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
        const monacoApiAny = monacoApi;
        const editor = activeGroup.editor;
        const className = issue.severity === "warning" ? "issue-line-warning" : "issue-line-highlight";
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
    const clearJumpHighlight = (group) => {
        const decorations = jumpDecorations[group.key];
        if (!group.editor || decorations.length === 0) {
            return;
        }
        const editor = group.editor;
        jumpDecorations[group.key] = editor.deltaDecorations(decorations, []);
    };
    const revealLine = (group, line) => {
        const monacoApi = deps.getMonacoApi();
        if (!group.editor || !monacoApi) {
            return;
        }
        clearJumpHighlight(group);
        const monacoApiAny = monacoApi;
        const editor = group.editor;
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
        const hasValidCurrent = activeGroup.currentFilePath !== null &&
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
    const updateMiniOutline = () => { };
    const setActiveGroup = (nextKey, options = {}) => {
        var _a;
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
            const editor = getActiveEditor();
            (_a = editor === null || editor === void 0 ? void 0 : editor.focus) === null || _a === void 0 ? void 0 : _a.call(editor);
        }
    };
    const setSplitViewEnabled = (enabled) => {
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
                var _a;
                const editor = group.editor;
                (_a = editor === null || editor === void 0 ? void 0 : editor.layout) === null || _a === void 0 ? void 0 : _a.call(editor);
            });
        });
    };
    const getSplitViewEnabled = () => splitViewEnabled;
    const getLanguageIdForPath = (path) => {
        const ext = getFileExtension(path);
        if (ext === "bib") {
            return "bibtex";
        }
        if (LATEX_FILE_EXTENSIONS.has(ext)) {
            return "latex";
        }
        return "plaintext";
    };
    const setEditorLanguage = (group, path) => {
        var _a;
        const monacoApi = deps.getMonacoApi();
        if (!monacoApi || !group.editor) {
            return;
        }
        if (!isTextFilePath(path)) {
            return;
        }
        const editor = group.editor;
        if (!editor.getModel) {
            return;
        }
        const model = editor.getModel();
        const monacoApiAny = monacoApi;
        const languageId = getLanguageIdForPath(path);
        if (model && ((_a = monacoApiAny.editor) === null || _a === void 0 ? void 0 : _a.setModelLanguage)) {
            monacoApiAny.editor.setModelLanguage(model, languageId);
        }
    };
    const getEmptyEditorModel = () => {
        var _a;
        const monacoApi = deps.getMonacoApi();
        if (!monacoApi) {
            return null;
        }
        if (emptyEditorModel) {
            return emptyEditorModel;
        }
        const monacoApiAny = monacoApi;
        if (!((_a = monacoApiAny.editor) === null || _a === void 0 ? void 0 : _a.createModel)) {
            return null;
        }
        emptyEditorModel = monacoApiAny.editor.createModel("", "plaintext");
        return emptyEditorModel;
    };
    const clearEditorView = (group) => {
        if (!group.editor) {
            return;
        }
        const editor = group.editor;
        const emptyModel = getEmptyEditorModel();
        if (emptyModel && editor.setModel) {
            editor.setModel(emptyModel);
        }
    };
    const scheduleAfterComposition = (group, action) => {
        var _a;
        if (!group.isComposing) {
            action();
            return;
        }
        // Blur will trigger compositionend which handles recovery
        group.pendingCompositionAction = action;
        const input = (_a = group.editorHost) === null || _a === void 0 ? void 0 : _a.querySelector("textarea.inputarea");
        input === null || input === void 0 ? void 0 : input.blur();
    };
    const handleCompositionEnd = (group) => {
        if (!group.pendingCompositionAction) {
            return;
        }
        const action = group.pendingCompositionAction;
        group.pendingCompositionAction = null;
        requestAnimationFrame(() => {
            action();
        });
    };
    const updateDirtyState = (path, content, savedContent) => {
        var _a, _b, _c;
        const entry = monacoModels.get(path);
        const groupSavedContent = (_a = Array.from(Object.values(editorGroups)).find((group) => group.currentFilePath === path && group.currentFileSavedContent)) === null || _a === void 0 ? void 0 : _a.currentFileSavedContent;
        const baseSaved = (_c = (_b = savedContent !== null && savedContent !== void 0 ? savedContent : entry === null || entry === void 0 ? void 0 : entry.savedContent) !== null && _b !== void 0 ? _b : groupSavedContent) !== null && _c !== void 0 ? _c : content;
        if (entry) {
            entry.savedContent = baseSaved;
        }
        if (content !== baseSaved) {
            dirtyFiles.add(path);
        }
        else {
            dirtyFiles.delete(path);
        }
        forEachEditorGroup((group) => {
            if (group.currentFilePath === path) {
                group.isDirty = dirtyFiles.has(path);
            }
        });
    };
    const storeViewState = (group, path) => {
        if (!group.editor) {
            return;
        }
        const editor = group.editor;
        if (!editor.saveViewState) {
            return;
        }
        const viewState = editor.saveViewState();
        if (viewState) {
            group.viewStates.set(path, viewState);
        }
    };
    const restoreViewState = (group, path) => {
        var _a;
        if (!group.editor) {
            return;
        }
        const viewState = group.viewStates.get(path);
        if (!viewState) {
            return;
        }
        const editor = group.editor;
        (_a = editor.restoreViewState) === null || _a === void 0 ? void 0 : _a.call(editor, viewState);
    };
    const cacheCurrentBuffer = (group) => {
        if (!group.currentFilePath || !group.editor || !isTextFilePath(group.currentFilePath)) {
            return;
        }
        const editor = group.editor;
        const content = editor.getValue();
        updateDirtyState(group.currentFilePath, content);
        storeViewState(group, group.currentFilePath);
    };
    const addOpenTab = (group, path) => {
        if (!group.openTabs.includes(path)) {
            group.openTabs = [...group.openTabs, path];
        }
    };
    const closeTab = (group, path) => {
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
            }
            else {
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
    const isPersistentTabPath = (path) => {
        const ext = getFileExtension(path);
        return PINNED_TAB_EXTENSIONS.has(ext);
    };
    const clearTemporaryTabs = (group, keepPath) => {
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
    const applyViewerFile = (group, path, kind, data, mimeType) => {
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
        }
        else {
            group.viewer.showPdfViewer(path, data, mimeType);
        }
        if (isActiveGroup(group)) {
            deps.buildOps.updateSynctexButtonState();
            deps.fileTree.setTreeFocus(false);
        }
    };
    const applyUnsupportedFile = (group, path) => {
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
    const ensureModelEntry = (path, content, savedContent) => {
        var _a;
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
        const monacoApiAny = monacoApi;
        if (!((_a = monacoApiAny.editor) === null || _a === void 0 ? void 0 : _a.createModel)) {
            return null;
        }
        const model = monacoApiAny.editor.createModel(content, getLanguageIdForPath(path));
        const nextEntry = { model, savedContent: savedContent !== null && savedContent !== void 0 ? savedContent : content };
        monacoModels.set(path, nextEntry);
        updateDirtyState(path, content, nextEntry.savedContent);
        return nextEntry;
    };
    const applyFileContent = (group, path, content, savedContent) => {
        var _a, _b, _c;
        const monacoApi = deps.getMonacoApi();
        if (!group.editor || !monacoApi) {
            deps.updateFallback("エディタの準備が完了していません。");
            return;
        }
        const editor = group.editor;
        const entry = ensureModelEntry(path, content, savedContent !== null && savedContent !== void 0 ? savedContent : content);
        clearTemporaryTabs(group, path);
        group.viewer.hideViewer();
        if (isActiveGroup(group)) {
            clearJumpHighlight(group);
        }
        group.isApplyingFile = true;
        if (entry && editor.setModel) {
            editor.setModel(entry.model);
        }
        else if (editor.setValue) {
            editor.setValue(content);
        }
        group.isApplyingFile = false;
        group.currentFilePath = path;
        group.currentFileSavedContent = (_a = entry === null || entry === void 0 ? void 0 : entry.savedContent) !== null && _a !== void 0 ? _a : (savedContent !== null && savedContent !== void 0 ? savedContent : content);
        if (entry) {
            updateDirtyState(path, entry.model.getValue(), entry.savedContent);
        }
        else if (editor.getValue) {
            updateDirtyState(path, editor.getValue(), (_b = group.currentFileSavedContent) !== null && _b !== void 0 ? _b : content);
        }
        else {
            updateDirtyState(path, content, (_c = group.currentFileSavedContent) !== null && _c !== void 0 ? _c : content);
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
    const applyFormattedContent = (group, path, content, options) => {
        var _a, _b, _c, _d, _e, _f;
        if (!group.editor) {
            return;
        }
        const editor = group.editor;
        const entry = monacoModels.get(path);
        const currentValue = (_c = (_a = entry === null || entry === void 0 ? void 0 : entry.model.getValue()) !== null && _a !== void 0 ? _a : (_b = editor.getValue) === null || _b === void 0 ? void 0 : _b.call(editor)) !== null && _c !== void 0 ? _c : "";
        const viewState = (_d = editor.saveViewState) === null || _d === void 0 ? void 0 : _d.call(editor);
        if (currentValue !== content) {
            group.isApplyingFile = true;
            if (entry === null || entry === void 0 ? void 0 : entry.model.setValue) {
                entry.model.setValue(content);
            }
            else if (editor.setValue) {
                editor.setValue(content);
            }
            group.isApplyingFile = false;
            if (viewState && editor.restoreViewState) {
                editor.restoreViewState(viewState);
            }
        }
        if (options === null || options === void 0 ? void 0 : options.updateSaved) {
            if (entry) {
                entry.savedContent = content;
            }
            if (group.currentFilePath === path) {
                group.currentFileSavedContent = content;
            }
        }
        const savedContent = (_f = (_e = (group.currentFilePath === path
            ? group.currentFileSavedContent
            : entry === null || entry === void 0 ? void 0 : entry.savedContent)) !== null && _e !== void 0 ? _e : entry === null || entry === void 0 ? void 0 : entry.savedContent) !== null && _f !== void 0 ? _f : content;
        updateDirtyState(path, content, savedContent);
        if (isActiveGroup(group)) {
            updateBreadcrumbs();
            deps.fileTree.render();
        }
    };
    const requestOpenFile = (path, groupKey, force = false) => {
        const existingGroupKey = !force ? findGroupKeyByPath(path) : null;
        const resolvedGroupKey = force
            ? groupKey
            : existingGroupKey !== null && existingGroupKey !== void 0 ? existingGroupKey : resolveAutoOpenGroupKey(groupKey);
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
    const jumpToFileLine = (path, line, groupKey) => {
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
    const jumpToLocation = (entry) => {
        if (!entry.path || !entry.line) {
            return;
        }
        jumpToFileLine(entry.path, entry.line, activeEditorGroup);
    };
    const jumpToSearchResult = (result) => {
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
        const editor = activeGroup.editor;
        const content = editor.getValue();
        return new Promise((resolve, reject) => {
            pendingSave = { path: activePath, content, resolve, reject };
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
        return new Promise((resolve, reject) => {
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
            saveCurrentFile().catch((message) => {
                deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
            });
        }, 400);
    };
    const handleOpenFileResult = (payload) => {
        var _a, _b;
        const pendingIndex = pendingOpenRequests.findIndex((entry) => entry.path === payload.path);
        let targetGroupKey = pendingIndex >= 0
            ? pendingOpenRequests.splice(pendingIndex, 1)[0].group
            : activeEditorGroup;
        if (pendingIndex < 0 && payload.path) {
            const existingGroupKey = findGroupKeyByPath(payload.path);
            if (existingGroupKey) {
                targetGroupKey = existingGroupKey;
            }
            else {
                targetGroupKey = resolveAutoOpenGroupKey(targetGroupKey);
            }
        }
        const targetGroup = getEditorGroup(targetGroupKey);
        if (payload.error) {
            if (pendingReveal &&
                pendingReveal.path === payload.path &&
                pendingReveal.group === targetGroupKey) {
                pendingReveal = null;
            }
            deps.updateIssues(1, payload.error, "error", [
                { severity: "error", message: payload.error },
            ]);
            return;
        }
        const type = payload.type;
        if (type === "searchResult") {
            deps.search.handleSearchUpdate(payload);
            return;
        }
        if (type === "env:checkResult") {
            deps.settings.updateEnvStatus(payload.command, payload.available);
            return;
        }
        if (type === "env:installResult") {
            const { target, success, message } = payload;
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
        const kind = (_a = payload.kind) !== null && _a !== void 0 ? _a : (isPdfFilePath(path)
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
        const content = (_b = payload.content) !== null && _b !== void 0 ? _b : "";
        applyFileContent(targetGroup, path, content, content);
    };
    const handleSaveResult = (payload) => {
        var _a, _b, _c;
        let savedContent = null;
        if (pendingSave && pendingSave.path === payload.path) {
            if (payload.ok) {
                if (payload.content) {
                    pendingSave.content = payload.content;
                }
                savedContent = pendingSave.content;
                pendingSave.resolve(true);
            }
            else {
                pendingSave.reject((_a = payload.error) !== null && _a !== void 0 ? _a : "保存に失敗しました。");
            }
            pendingSave = null;
        }
        if (!payload.ok) {
            deps.updateIssues(1, (_b = payload.error) !== null && _b !== void 0 ? _b : "保存に失敗しました。", "error", [
                { severity: "error", message: (_c = payload.error) !== null && _c !== void 0 ? _c : "保存に失敗しました。" },
            ]);
            return;
        }
        const entry = monacoModels.get(payload.path);
        let resolvedSavedContent = savedContent;
        if (resolvedSavedContent === null) {
            if (payload.content) {
                resolvedSavedContent = payload.content;
            }
            else if (entry) {
                resolvedSavedContent = entry.model.getValue();
            }
        }
        if (resolvedSavedContent !== null) {
            if (entry) {
                entry.savedContent = resolvedSavedContent;
            }
            dirtyFiles.delete(payload.path);
        }
        const groupsWithFile = Object.values(editorGroups).filter((group) => group.currentFilePath === payload.path);
        if (groupsWithFile.length > 0) {
            groupsWithFile.forEach((group) => {
                if (resolvedSavedContent !== null) {
                    group.currentFileSavedContent = resolvedSavedContent;
                }
                if (payload.content) {
                    applyFormattedContent(group, payload.path, payload.content, { updateSaved: true });
                }
                else if (group.editor && group.currentFileSavedContent !== null) {
                    const editor = group.editor;
                    const currentValue = editor.getValue();
                    updateDirtyState(payload.path, currentValue, group.currentFileSavedContent);
                }
                else {
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
    const handleRenameResult = (payload) => {
        const { oldPath, newPath } = payload;
        const remapPath = (path) => {
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
            const updatedModels = new Map();
            monacoModels.forEach((entry, path) => {
                updatedModels.set(remapPath(path), entry);
            });
            monacoModels.clear();
            updatedModels.forEach((entry, path) => monacoModels.set(path, entry));
        }
        forEachEditorGroup((group) => {
            if (group.viewStates.size > 0) {
                const updatedViewStates = new Map();
                group.viewStates.forEach((state, path) => {
                    updatedViewStates.set(remapPath(path), state);
                });
                group.viewStates.clear();
                updatedViewStates.forEach((state, path) => group.viewStates.set(path, state));
            }
        });
        if (dirtyFiles.size > 0) {
            const updatedDirty = new Set();
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
                }
                else if (group.editor) {
                    const editor = group.editor;
                    group.currentFileSavedContent = editor.getValue();
                }
            }
        });
        updateBreadcrumbs();
        updateMiniOutline();
        deps.fileTree.render();
        forEachEditorGroup((group) => deps.editorTabs.render(group));
    };
    const syncWorkspaceFiles = (payload) => {
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
            }
            else {
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
    const getStoredCursorPosition = (path) => { var _a; return (_a = lastCursorPositions.get(path)) !== null && _a !== void 0 ? _a : null; };
    const recordCursorPosition = (path, position) => {
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
