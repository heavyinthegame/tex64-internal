export const initBuildOpsUi = (context, deps) => {
    const { buildButton, formatButton, synctexButton, buildTarget, issuesLog, issuesLogContent } = context.dom;
    let formatInFlight = false;
    let formatPending = false;
    let formatWarningShown = false;
    let currentBuildLog = null;
    const setText = (element, text) => {
        if (element) {
            element.textContent = text;
        }
    };
    const updateBuildTarget = () => {
        var _a;
        const activePath = deps.getActiveFilePath();
        const target = (_a = deps.getRootFilePath()) !== null && _a !== void 0 ? _a : (activePath && activePath.endsWith(".tex") ? activePath : null);
        setText(buildTarget, target !== null && target !== void 0 ? target : "--");
    };
    const updateSynctexButtonState = () => {
        if (!(synctexButton instanceof HTMLButtonElement)) {
            return;
        }
        synctexButton.disabled = true;
        synctexButton.style.display = "none";
    };
    const handleBuildLog = (log) => {
        currentBuildLog = log;
        if (issuesLogContent instanceof HTMLElement) {
            issuesLogContent.textContent = log !== null && log !== void 0 ? log : "";
        }
        if (issuesLog instanceof HTMLElement) {
            issuesLog.classList.toggle("is-hidden", !log);
            if (!log) {
                issuesLog.removeAttribute("open");
            }
        }
    };
    const requestSynctexForward = (overridePath, options = {}) => {
        var _a, _b, _c, _d, _e;
        const activeGroup = deps.getActiveGroup();
        const targetPath = overridePath !== null && overridePath !== void 0 ? overridePath : activeGroup.currentFilePath;
        if (!targetPath || !targetPath.endsWith(".tex")) {
            deps.updateIssues(1, "SyncTeX は .tex ファイルでのみ利用できます。", "info", [
                { severity: "warning", message: "SyncTeX は .tex ファイルでのみ利用できます。" },
            ]);
            return;
        }
        const editor = activeGroup.editor;
        const position = activeGroup.currentFilePath === targetPath ? (_a = editor === null || editor === void 0 ? void 0 : editor.getPosition) === null || _a === void 0 ? void 0 : _a.call(editor) : null;
        const storedPosition = deps.getStoredCursorPosition(targetPath);
        const line = (_c = (_b = position === null || position === void 0 ? void 0 : position.lineNumber) !== null && _b !== void 0 ? _b : storedPosition === null || storedPosition === void 0 ? void 0 : storedPosition.line) !== null && _c !== void 0 ? _c : 1;
        const column = (_e = (_d = position === null || position === void 0 ? void 0 : position.column) !== null && _d !== void 0 ? _d : storedPosition === null || storedPosition === void 0 ? void 0 : storedPosition.column) !== null && _e !== void 0 ? _e : 1;
        deps.postToNative({
            type: "synctex:forward",
            path: targetPath,
            line,
            column,
            fallbackToTop: options.fallbackToTop === true,
            pdfViewerMode: deps.settings.getPdfViewerMode(),
        });
    };
    const setBuildState = (state, message) => {
        var _a, _b;
        if (buildButton instanceof HTMLButtonElement) {
            const isBusy = state === "building";
            buildButton.disabled = isBusy;
            buildButton.classList.toggle("is-busy", isBusy);
            buildButton.setAttribute("aria-busy", isBusy ? "true" : "false");
            buildButton.setAttribute("aria-label", isBusy ? "ビルド中" : "ビルド");
        }
        if (state === "success") {
            const targetPath = (_b = (_a = deps.getLastBuildMainFile()) !== null && _a !== void 0 ? _a : deps.getRootFilePath()) !== null && _b !== void 0 ? _b : deps.getActiveFilePath();
            if (deps.settings.getAutoSynctexOnBuildEnabled() &&
                targetPath &&
                targetPath.endsWith(".tex")) {
                requestSynctexForward(targetPath, { fallbackToTop: true });
            }
        }
        if (state === "failed") {
            deps.setPendingBuildIssuesFocus(true);
        }
        else if (state !== "building") {
            deps.setPendingBuildIssuesFocus(false);
        }
        if (message && state === "building") {
            deps.updateIssues(0, message, "info", []);
        }
    };
    const startBuild = () => {
        var _a, _b;
        deps.cacheCurrentBuffer(deps.getActiveGroup());
        const mainFile = (_a = deps.getRootFilePath()) !== null && _a !== void 0 ? _a : (deps.getActiveFilePath() && ((_b = deps.getActiveFilePath()) === null || _b === void 0 ? void 0 : _b.endsWith(".tex"))
            ? deps.getActiveFilePath()
            : undefined);
        deps.setLastBuildMainFile(mainFile !== null && mainFile !== void 0 ? mainFile : null);
        const engine = localStorage.getItem("tex180.compileEngine") || "lualatex";
        const payload = { type: "build" };
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
    const requestFormatCurrentFile = (source) => {
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
        const editor = activeGroup.editor;
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
    const handleSaveFormatError = (formatError) => {
        if (formatError && !formatWarningShown) {
            formatWarningShown = true;
            deps.updateIssues(1, formatError, "info", [
                { severity: "warning", message: formatError },
            ]);
        }
    };
    const handleFormatResult = (payload) => {
        var _a, _b, _c;
        formatInFlight = false;
        if (!payload.ok) {
            if (!formatWarningShown) {
                formatWarningShown = true;
                deps.updateIssues(1, (_a = payload.error) !== null && _a !== void 0 ? _a : "整形に失敗しました。", "info", [
                    { severity: "warning", message: (_b = payload.error) !== null && _b !== void 0 ? _b : "整形に失敗しました。" },
                ]);
            }
        }
        else if (typeof payload.content === "string") {
            const groupsWithFile = deps
                .getEditorGroups()
                .filter((group) => group.currentFilePath === payload.path);
            if (groupsWithFile.length > 0) {
                groupsWithFile.forEach((group) => {
                    deps.applyFormattedContent(group, payload.path, payload.content, {
                        updateSaved: false,
                    });
                    deps.renderEditorTabs(group);
                });
            }
            const activeGroup = deps.getActiveGroup();
            if (activeGroup.currentFilePath === payload.path && activeGroup.isDirty) {
                deps.saveCurrentFile().catch((message) => {
                    deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
                });
            }
        }
        if (formatPending) {
            formatPending = false;
            requestFormatCurrentFile((_c = payload.source) !== null && _c !== void 0 ? _c : "auto");
        }
    };
    const handleSynctexForwardResult = (payload) => {
        var _a, _b, _c, _d;
        if (!payload) {
            return;
        }
        if (payload.ok) {
            if (deps.settings.getPdfViewerMode() === "tab" && typeof payload.page === "number") {
                const activeGroup = deps.getActiveGroup();
                if (payload.pdfPath && activeGroup.viewer.getViewerMode() !== "pdf") {
                    deps.requestOpenFile(payload.pdfPath, deps.getActiveEditorGroupKey());
                }
                activeGroup.viewer.syncPdf({
                    page: payload.page,
                    x: (_a = payload.x) !== null && _a !== void 0 ? _a : 0,
                    y: (_b = payload.y) !== null && _b !== void 0 ? _b : 0,
                });
            }
            return;
        }
        deps.updateIssues(1, (_c = payload.error) !== null && _c !== void 0 ? _c : "SyncTeX に失敗しました。", "error", [
            { severity: "error", message: (_d = payload.error) !== null && _d !== void 0 ? _d : "SyncTeX に失敗しました。" },
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
                        .catch((message) => {
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
        updateBuildTarget,
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
