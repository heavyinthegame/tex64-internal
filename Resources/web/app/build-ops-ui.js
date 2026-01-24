export const initBuildOpsUi = (context, deps) => {
    const { buildButton, partialBuildButton, formatButton, synctexButton, issuesLog, issuesLogContent, } = context.dom;
    let formatInFlight = false;
    let formatPending = false;
    let formatWarningShown = false;
    let currentBuildLog = null;
    let lastBuildMode = "full";
    const formatPreviewRequests = new Map();
    const formatPreviewIgnore = new Set();
    const SECTION_LEVELS = {
        part: 0,
        chapter: 1,
        section: 2,
        subsection: 3,
        subsubsection: 4,
        paragraph: 5,
        subparagraph: 6,
    };
    const SECTION_PATTERN = new RegExp(`^\\s*\\\\(${Object.keys(SECTION_LEVELS).join("|")})\\*?\\b`);
    const stripLineComment = (line) => {
        const idx = line.indexOf("%");
        if (idx === -1) {
            return line;
        }
        for (let i = idx; i < line.length; i += 1) {
            if (line[i] !== "%") {
                continue;
            }
            let backslashes = 0;
            for (let j = i - 1; j >= 0 && line[j] === "\\"; j -= 1) {
                backslashes += 1;
            }
            if (backslashes % 2 === 0) {
                return line.slice(0, i);
            }
        }
        return line;
    };
    const normalizeCommandLine = (line) => stripLineComment(line).replace(/\s+/g, "");
    const resolveDocumentParts = (lines) => {
        let beginDocLine = null;
        let endDocLine = null;
        for (let i = 0; i < lines.length; i += 1) {
            const normalized = normalizeCommandLine(lines[i]);
            if (normalized.includes("\\begin{document}")) {
                beginDocLine = i + 1;
                break;
            }
        }
        for (let i = lines.length - 1; i >= 0; i -= 1) {
            const normalized = normalizeCommandLine(lines[i]);
            if (normalized.includes("\\end{document}")) {
                endDocLine = i + 1;
                break;
            }
        }
        const bodyStartLine = beginDocLine ? Math.min(beginDocLine + 1, lines.length) : 1;
        const bodyEndLine = endDocLine ? Math.max(1, endDocLine - 1) : lines.length;
        const safeBodyStartLine = Math.min(bodyStartLine, Math.max(lines.length, 1));
        const safeBodyEndLine = Math.max(bodyEndLine, safeBodyStartLine);
        const preambleLines = beginDocLine && beginDocLine > 1
            ? lines
                .slice(0, beginDocLine - 1)
                .filter((entry) => !normalizeCommandLine(entry).includes("\\documentclass"))
            : [];
        return {
            bodyStartLine: safeBodyStartLine,
            bodyEndLine: safeBodyEndLine,
            preambleLines,
        };
    };
    const resolveSectionLevel = (line) => {
        var _a;
        const match = stripLineComment(line).match(SECTION_PATTERN);
        if (!match) {
            return null;
        }
        return (_a = SECTION_LEVELS[match[1]]) !== null && _a !== void 0 ? _a : null;
    };
    const resolveSectionRange = (lines, cursorLine, bodyStartLine, bodyEndLine) => {
        const sectionStarts = [];
        for (let lineNumber = bodyStartLine; lineNumber <= bodyEndLine; lineNumber += 1) {
            const level = resolveSectionLevel(lines[lineNumber - 1]);
            if (typeof level === "number") {
                sectionStarts.push({ lineNumber, level });
            }
        }
        if (sectionStarts.length === 0) {
            return { startLine: bodyStartLine, endLine: bodyEndLine };
        }
        const topLevel = Math.min(...sectionStarts.map((entry) => entry.level));
        const topSections = sectionStarts.filter((entry) => entry.level === topLevel);
        const clampedCursor = Math.min(Math.max(cursorLine, bodyStartLine), bodyEndLine);
        let startLine = bodyStartLine;
        for (const entry of topSections) {
            if (entry.lineNumber <= clampedCursor) {
                startLine = entry.lineNumber;
            }
            else {
                break;
            }
        }
        let endLine = bodyEndLine;
        for (const entry of topSections) {
            if (entry.lineNumber > startLine) {
                endLine = entry.lineNumber - 1;
                break;
            }
        }
        if (endLine < startLine) {
            endLine = startLine;
        }
        return { startLine, endLine };
    };
    const isEnvMissingMessage = (message) => {
        const lower = message.toLowerCase();
        const hasMissing = message.includes("見つかりません") || lower.includes("not found");
        return hasMissing && lower.includes("synctex");
    };
    const resolvePdfSyncGroup = (pdfPath) => {
        var _a;
        if (!pdfPath) {
            return null;
        }
        return ((_a = deps.getEditorGroups().find((group) => group.openTabs.includes(pdfPath))) !== null && _a !== void 0 ? _a : null);
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
        const isBusy = state === "building";
        if (buildButton instanceof HTMLButtonElement) {
            buildButton.disabled = isBusy;
            buildButton.classList.toggle("is-busy", isBusy);
            buildButton.setAttribute("aria-busy", isBusy ? "true" : "false");
            buildButton.setAttribute("aria-label", isBusy ? "ビルド中" : "ビルド");
        }
        if (partialBuildButton instanceof HTMLButtonElement) {
            partialBuildButton.disabled = isBusy;
            partialBuildButton.setAttribute("aria-busy", isBusy ? "true" : "false");
        }
        if (state === "success") {
            if (lastBuildMode === "full") {
                const targetPath = (_b = (_a = deps.getLastBuildMainFile()) !== null && _a !== void 0 ? _a : deps.getRootFilePath()) !== null && _b !== void 0 ? _b : deps.getActiveFilePath();
                if (deps.settings.getAutoSynctexOnBuildEnabled() &&
                    targetPath &&
                    targetPath.endsWith(".tex")) {
                    requestSynctexForward(targetPath, { fallbackToTop: true });
                }
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
    const resolveSectionBuildPayload = () => {
        var _a, _b, _c, _d;
        const activeGroup = deps.getActiveGroup();
        const activePath = activeGroup.currentFilePath;
        if (!activePath || !activePath.toLowerCase().endsWith(".tex")) {
            return null;
        }
        const editor = activeGroup.editor;
        const model = (_a = editor === null || editor === void 0 ? void 0 : editor.getModel) === null || _a === void 0 ? void 0 : _a.call(editor);
        if (!(model === null || model === void 0 ? void 0 : model.getLineCount) || !(model === null || model === void 0 ? void 0 : model.getLineContent)) {
            return null;
        }
        const lineCount = model.getLineCount();
        const lines = [];
        for (let lineNumber = 1; lineNumber <= lineCount; lineNumber += 1) {
            lines.push(model.getLineContent(lineNumber));
        }
        const { bodyStartLine, bodyEndLine, preambleLines } = resolveDocumentParts(lines);
        const position = activeGroup.currentFilePath === activePath ? (_b = editor === null || editor === void 0 ? void 0 : editor.getPosition) === null || _b === void 0 ? void 0 : _b.call(editor) : null;
        const storedPosition = deps.getStoredCursorPosition(activePath);
        const cursorLine = (_d = (_c = position === null || position === void 0 ? void 0 : position.lineNumber) !== null && _c !== void 0 ? _c : storedPosition === null || storedPosition === void 0 ? void 0 : storedPosition.line) !== null && _d !== void 0 ? _d : bodyStartLine;
        const { startLine, endLine } = resolveSectionRange(lines, cursorLine, bodyStartLine, bodyEndLine);
        const isRootFile = deps.getRootFilePath() === activePath;
        const extraPreamble = !isRootFile && preambleLines.length > 0 ? preambleLines.join("\n") : undefined;
        return {
            path: activePath,
            startLine,
            endLine,
            content: lines.slice(startLine - 1, endLine).join("\n"),
            preamble: extraPreamble,
        };
    };
    const notifyPartialBuildUnavailable = (message) => {
        deps.updateIssues(1, message, "info", [{ severity: "warning", message }]);
    };
    const requestPartialBuild = () => {
        const activePath = deps.getActiveFilePath();
        if (!activePath || !activePath.toLowerCase().endsWith(".tex")) {
            notifyPartialBuildUnavailable("部分ビルドは .tex ファイルでのみ利用できます。");
            return;
        }
        const partial = resolveSectionBuildPayload();
        if (!partial) {
            notifyPartialBuildUnavailable("部分ビルドに必要な情報を取得できませんでした。");
            return;
        }
        startPartialBuild(partial);
    };
    const startBuild = () => {
        var _a, _b;
        deps.cacheCurrentBuffer(deps.getActiveGroup());
        const mainFile = (_a = deps.getRootFilePath()) !== null && _a !== void 0 ? _a : (deps.getActiveFilePath() && ((_b = deps.getActiveFilePath()) === null || _b === void 0 ? void 0 : _b.endsWith(".tex"))
            ? deps.getActiveFilePath()
            : undefined);
        deps.setLastBuildMainFile(mainFile !== null && mainFile !== void 0 ? mainFile : null);
        lastBuildMode = "full";
        const engine = localStorage.getItem("tex64.compileEngine") || "lualatex";
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
    const startPartialBuild = (partial) => {
        var _a, _b;
        deps.cacheCurrentBuffer(deps.getActiveGroup());
        const mainFile = (_a = deps.getRootFilePath()) !== null && _a !== void 0 ? _a : (deps.getActiveFilePath() && ((_b = deps.getActiveFilePath()) === null || _b === void 0 ? void 0 : _b.endsWith(".tex"))
            ? deps.getActiveFilePath()
            : undefined);
        deps.setLastBuildMainFile(mainFile !== null && mainFile !== void 0 ? mainFile : null);
        lastBuildMode = "partial";
        const engine = localStorage.getItem("tex64.compileEngine") || "lualatex";
        const payload = { type: "build" };
        if (mainFile) {
            payload.mainFile = mainFile;
        }
        if (engine) {
            payload.engine = engine;
        }
        payload.pdfViewerMode = deps.settings.getPdfViewerMode();
        payload.formatSettings = deps.settings.buildFormatSettingsPayload();
        payload.partial = partial;
        if (deps.postToNative(payload)) {
            setBuildState("building");
            handleBuildLog(null);
            deps.updateIssues(0, "章/節の部分ビルドを開始します。", "info", []);
        }
        else {
            lastBuildMode = "full";
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
    const requestFormatPreview = (payload) => new Promise((resolve) => {
        var _a;
        const source = (_a = payload.source) !== null && _a !== void 0 ? _a : `blockInsertPreview:${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const ok = deps.postToNative({
            type: "formatFile",
            path: payload.path,
            content: payload.content,
            source,
            formatSettings: deps.settings.buildFormatSettingsPayload(),
        }, true);
        if (!ok) {
            resolve({
                path: payload.path,
                ok: false,
                error: "整形のリクエストに失敗しました。",
                source,
            });
            return;
        }
        const timeoutId = window.setTimeout(() => {
            formatPreviewRequests.delete(source);
            formatPreviewIgnore.add(source);
            window.setTimeout(() => formatPreviewIgnore.delete(source), 30000);
            resolve({
                path: payload.path,
                ok: false,
                error: "整形がタイムアウトしました。",
                source,
            });
        }, 15000);
        formatPreviewRequests.set(source, { resolve, timeoutId });
    });
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
        if (payload.source && formatPreviewRequests.has(payload.source)) {
            const pending = formatPreviewRequests.get(payload.source);
            if (pending) {
                window.clearTimeout(pending.timeoutId);
                formatPreviewRequests.delete(payload.source);
                pending.resolve(payload);
            }
            return;
        }
        if (payload.source && formatPreviewIgnore.has(payload.source)) {
            formatPreviewIgnore.delete(payload.source);
            return;
        }
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
        var _a, _b, _c, _d, _e, _f;
        if (!payload) {
            return;
        }
        if (payload.ok) {
            if (deps.settings.getPdfViewerMode() === "tab" && typeof payload.page === "number") {
                const pdfPath = (_a = payload.pdfPath) !== null && _a !== void 0 ? _a : null;
                const openedGroup = (_c = (_b = resolvePdfSyncGroup(pdfPath)) !== null && _b !== void 0 ? _b : deps.getEditorGroups().find((group) => group.key === "secondary")) !== null && _c !== void 0 ? _c : deps.getActiveGroup();
                const hasPdfTab = pdfPath ? openedGroup.openTabs.includes(pdfPath) : false;
                if (openedGroup.key === "secondary" && hasPdfTab && !deps.getSplitViewEnabled()) {
                    deps.setSplitViewEnabled(true);
                }
                if (pdfPath && hasPdfTab) {
                    if (openedGroup.currentFilePath !== pdfPath) {
                        deps.requestOpenFile(pdfPath, openedGroup.key, true);
                    }
                }
                openedGroup.viewer.syncPdf({
                    page: payload.page,
                    x: (_d = payload.x) !== null && _d !== void 0 ? _d : 0,
                    y: (_e = payload.y) !== null && _e !== void 0 ? _e : 0,
                });
            }
            return;
        }
        const errorMessage = (_f = payload.error) !== null && _f !== void 0 ? _f : "SyncTeX に失敗しました。";
        const issue = { severity: "error", message: errorMessage };
        if (isEnvMissingMessage(errorMessage)) {
            issue.action = "open-runtime";
        }
        deps.updateIssues(1, errorMessage, "error", [issue]);
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
        if (partialBuildButton instanceof HTMLButtonElement) {
            partialBuildButton.addEventListener("click", () => {
                if (partialBuildButton.disabled) {
                    return;
                }
                const activeGroup = deps.getActiveGroup();
                if (activeGroup.isDirty && activeGroup.currentFilePath) {
                    deps
                        .saveCurrentFile()
                        .then((ok) => {
                        if (ok) {
                            requestPartialBuild();
                        }
                    })
                        .catch((message) => {
                        deps.updateIssues(1, message, "error", [
                            { severity: "error", message },
                        ]);
                    });
                    return;
                }
                requestPartialBuild();
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
        requestFormatPreview,
        handleFormatResult,
        handleSaveFormatError,
        handleBuildLog,
        requestSynctexForward,
        handleSynctexForwardResult,
        setupActionButtons,
    };
};
