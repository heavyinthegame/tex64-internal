import { buildFormatSettingsPayload as buildFormatSettingsPayloadFromSettings, defaultEditorFormatSettings, normalizeEditorFormatSettings, normalizeVerbatimInput, } from "./settings-format.js";
import { clampNumber, loadGhostCompletionConfig, saveGhostCompletionConfig, } from "./settings-completion.js";
import { createEnvStatusManager } from "./settings-env.js";
import { initBuildProfilesUi } from "./settings-build-profiles.js";
import { TEX64_LINKS } from "./platform-links.js";
export const initSettingsUi = (context, deps) => {
    const { settingsPanel, settingsNav, settingsNavItems, settingsPages, settingsPageItems, settingsBackButtons, settingsCompileEngineSelect, settingsEnvRefresh, editorAlignEnvToggle, editorFormatIndentSelect, editorFormatBeginEndToggle, editorFormatDocumentNoIndentToggle, editorFormatAlignMathToggle, editorFormatAlignTableToggle, editorFormatBlankLinesSelect, editorFormatVerbatimInput, editorFormatVerbatimAdd, editorFormatVerbatimHint, editorFormatVerbatimList, editorAutoSynctexBuildToggle, editorReverseSynctexToggle, editorGhostCompletionToggle, editorGhostCompletionDebounce, editorGhostCompletionMaxChars, editorPdfWindowToggle, settingsUpdateCurrent, settingsUpdateLatest, settingsUpdateStatus, settingsUpdateProgress, settingsUpdateProgressFill, settingsUpdateCheck, settingsUpdateDownload, settingsUpdateInstall, settingsUpdateOpen, settingsFeedbackCategory, settingsFeedbackMessage, settingsFeedbackEmail, settingsFeedbackSend, settingsFeedbackStatus, settingsLinkTerms, settingsLinkPrivacy, settingsLinkCommercial, settingsLinkRefund, settingsLinkSupport, settingsLinkContact, settingsLinkReleases, } = context.dom;
    let activeSettingsPage = null;
    let editorAlignEnvEnabled = true;
    let editorFormatSettings = {
        ...defaultEditorFormatSettings,
    };
    let autoSynctexOnBuildEnabled = true;
    let reverseSynctexEnabled = true;
    let ghostCompletionEnabled = true;
    let ghostCompletionDebounceMs = 120;
    let ghostCompletionMaxChars = 140;
    let pdfViewerMode = "window";
    let platformUpdate = null;
    let platformUpdateStatus = null;
    let feedbackPending = false;
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
    ];
    const envDisplayTargets = ["lualatex", "latexmk", "latexindent", "synctex"];
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
        const hasOption = Array.from(settingsCompileEngineSelect.options).some((option) => option.value === savedEngine);
        settingsCompileEngineSelect.value = hasOption ? savedEngine : "lualatex";
    };
    const buildFormatSettingsPayload = () => buildFormatSettingsPayloadFromSettings(editorFormatSettings, deps.envRegistry);
    const envBtns = Array.from(document.querySelectorAll(".env-btn"));
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
    const updateSettingsToggle = (element, enabled) => {
        if (element instanceof HTMLInputElement) {
            element.checked = enabled;
        }
    };
    const setEditorFormatVerbatimHint = (message) => {
        if (editorFormatVerbatimHint instanceof HTMLElement) {
            editorFormatVerbatimHint.textContent = message;
        }
    };
    const renderEditorFormatVerbatimList = () => {
        if (!(editorFormatVerbatimList instanceof HTMLElement)) {
            return;
        }
        editorFormatVerbatimList.innerHTML = "";
        const entries = Array.from(new Set(editorFormatSettings.customVerbatim)).sort((a, b) => a.localeCompare(b, "ja"));
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
        updateSettingsToggle(editorFormatBeginEndToggle, editorFormatSettings.beginEndOnOwnLine);
        updateSettingsToggle(editorFormatDocumentNoIndentToggle, editorFormatSettings.documentNoIndent);
        updateSettingsToggle(editorFormatAlignMathToggle, editorFormatSettings.alignMathDelims);
        updateSettingsToggle(editorFormatAlignTableToggle, editorFormatSettings.alignTableDelims);
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
        const configItems = Array.from(document.querySelectorAll("[data-ghost-config]"));
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
    const setSettingsPage = (pageId) => {
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
            deps.postToNative({ type: "update:status:get" }, true);
            deps.postToNative({ type: "update:check", force: false }, true);
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
                localStorage.setItem(editorAlignEnvKey, editorAlignEnvEnabled ? "true" : "false");
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
            }
            catch {
                editorFormatSettings = { ...defaultEditorFormatSettings };
            }
        }
        else {
            editorFormatSettings = { ...defaultEditorFormatSettings };
        }
        updateEditorFormatSettingsUI();
    };
    const loadEditorAutoSynctexBuildState = () => {
        const stored = localStorage.getItem(editorAutoSynctexOnBuildKey);
        if (stored !== null) {
            autoSynctexOnBuildEnabled = stored !== "false";
        }
        else {
            const legacy = localStorage.getItem(editorAutoSynctexOnPdfOpenKey);
            autoSynctexOnBuildEnabled = legacy !== null ? legacy !== "false" : true;
            if (legacy !== null) {
                localStorage.setItem(editorAutoSynctexOnBuildKey, autoSynctexOnBuildEnabled ? "true" : "false");
            }
        }
        updateEditorAutoSynctexBuildUI();
    };
    const loadEditorReverseSynctexState = () => {
        const stored = localStorage.getItem(editorReverseSynctexKey);
        if (stored !== null) {
            reverseSynctexEnabled = stored !== "false";
        }
        else {
            reverseSynctexEnabled = true;
        }
        updateEditorReverseSynctexUI();
    };
    const loadEditorGhostCompletionState = () => {
        const stored = localStorage.getItem(editorGhostCompletionKey);
        if (stored !== null) {
            ghostCompletionEnabled = stored !== "false";
        }
        else {
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
        }
        else {
            pdfViewerMode = "window";
        }
        updateEditorPdfViewerModeUI();
    };
    const saveEditorAlignEnvState = () => {
        localStorage.setItem(editorAlignEnvKey, editorAlignEnvEnabled ? "true" : "false");
    };
    const saveEditorFormatSettings = () => {
        try {
            localStorage.setItem(editorFormatSettingsKey, JSON.stringify(editorFormatSettings));
        }
        catch {
            // ignore storage failures
        }
    };
    const saveEditorAutoSynctexBuildState = () => {
        localStorage.setItem(editorAutoSynctexOnBuildKey, autoSynctexOnBuildEnabled ? "true" : "false");
    };
    const saveEditorReverseSynctexState = () => {
        localStorage.setItem(editorReverseSynctexKey, reverseSynctexEnabled ? "true" : "false");
    };
    const saveEditorGhostCompletionState = () => {
        localStorage.setItem(editorGhostCompletionKey, ghostCompletionEnabled ? "true" : "false");
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
    const setCompileEngine = (engine) => {
        if (!engine || !texEngineCommands.has(engine)) {
            return;
        }
        localStorage.setItem(compileEngineKey, engine);
        updateEngineUI();
    };
    const openExternalUrl = (url) => {
        const normalized = typeof url === "string" ? url.trim() : "";
        if (!/^https?:\/\//i.test(normalized)) {
            return;
        }
        deps.postToNative({ type: "shell:openExternal", url: normalized }, true);
    };
    const formatBytes = (value) => {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            return "0 B";
        }
        if (value < 1024) {
            return `${Math.round(value)} B`;
        }
        if (value < 1024 * 1024) {
            return `${(value / 1024).toFixed(1)} KB`;
        }
        if (value < 1024 * 1024 * 1024) {
            return `${(value / (1024 * 1024)).toFixed(1)} MB`;
        }
        return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    };
    const resolveUpdateStatusText = () => {
        var _a, _b, _c, _d, _e, _f;
        const phase = (_a = platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.phase) !== null && _a !== void 0 ? _a : "idle";
        const latest = (_c = (_b = platformUpdate === null || platformUpdate === void 0 ? void 0 : platformUpdate.latestVersion) !== null && _b !== void 0 ? _b : platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.latestVersion) !== null && _c !== void 0 ? _c : null;
        if ((platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.message) && platformUpdateStatus.message.trim()) {
            return platformUpdateStatus.message.trim();
        }
        if (phase === "checking") {
            return "更新を確認しています。";
        }
        if (phase === "up-to-date") {
            return latest ? `最新バージョン ${latest} です。` : "最新状態です。";
        }
        if (phase === "available") {
            return latest ? `新しいバージョン ${latest} を利用できます。` : "新しいバージョンを利用できます。";
        }
        if (phase === "downloading") {
            const transferred = formatBytes((_d = platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.transferredBytes) !== null && _d !== void 0 ? _d : 0);
            const total = formatBytes((_e = platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.totalBytes) !== null && _e !== void 0 ? _e : 0);
            return `更新をダウンロード中です（${transferred} / ${total}）。`;
        }
        if (phase === "downloaded") {
            return "ダウンロード完了。適用ボタンでインストーラを起動できます。";
        }
        if (phase === "installing") {
            return "インストーラを起動しました。画面の手順に沿って更新してください。";
        }
        if (phase === "error") {
            const message = (_f = platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.error) === null || _f === void 0 ? void 0 : _f.message;
            return message && message.trim()
                ? message.trim()
                : "アップデート処理に失敗しました。";
        }
        return "更新確認待ちです。";
    };
    const updatePlatformUpdateUi = () => {
        var _a, _b, _c, _d, _e, _f, _g;
        const currentVersion = (_b = (_a = platformUpdate === null || platformUpdate === void 0 ? void 0 : platformUpdate.currentVersion) !== null && _a !== void 0 ? _a : platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.currentVersion) !== null && _b !== void 0 ? _b : "-";
        const latestVersion = (_d = (_c = platformUpdate === null || platformUpdate === void 0 ? void 0 : platformUpdate.latestVersion) !== null && _c !== void 0 ? _c : platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.latestVersion) !== null && _d !== void 0 ? _d : "-";
        if (settingsUpdateCurrent instanceof HTMLElement) {
            settingsUpdateCurrent.textContent = currentVersion;
        }
        if (settingsUpdateLatest instanceof HTMLElement) {
            settingsUpdateLatest.textContent = latestVersion;
        }
        const statusText = resolveUpdateStatusText();
        if (settingsUpdateStatus instanceof HTMLElement) {
            settingsUpdateStatus.textContent = statusText;
            const phase = (_e = platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.phase) !== null && _e !== void 0 ? _e : "idle";
            settingsUpdateStatus.classList.toggle("is-error", phase === "error");
            settingsUpdateStatus.classList.toggle("is-success", phase === "downloaded");
        }
        const progress = typeof (platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.progressPercent) === "number" &&
            Number.isFinite(platformUpdateStatus.progressPercent)
            ? Math.max(0, Math.min(100, platformUpdateStatus.progressPercent))
            : 0;
        const showProgress = ((_f = platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.phase) !== null && _f !== void 0 ? _f : "") === "downloading";
        if (settingsUpdateProgress instanceof HTMLElement) {
            settingsUpdateProgress.classList.toggle("is-hidden", !showProgress);
            settingsUpdateProgress.setAttribute("aria-hidden", showProgress ? "false" : "true");
        }
        if (settingsUpdateProgressFill instanceof HTMLElement) {
            settingsUpdateProgressFill.style.width = `${progress}%`;
        }
        const phase = (_g = platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.phase) !== null && _g !== void 0 ? _g : "idle";
        const hasUpdate = Boolean(platformUpdate === null || platformUpdate === void 0 ? void 0 : platformUpdate.hasUpdate);
        const hasDownloadedInstaller = Boolean(platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.downloadedPath);
        if (settingsUpdateCheck instanceof HTMLButtonElement) {
            settingsUpdateCheck.disabled = phase === "checking" || phase === "downloading";
        }
        if (settingsUpdateDownload instanceof HTMLButtonElement) {
            settingsUpdateDownload.disabled =
                !hasUpdate || phase === "checking" || phase === "downloading";
        }
        if (settingsUpdateInstall instanceof HTMLButtonElement) {
            settingsUpdateInstall.disabled =
                phase === "checking" ||
                    phase === "downloading" ||
                    (!hasDownloadedInstaller && phase !== "downloaded");
        }
        if (settingsUpdateOpen instanceof HTMLButtonElement) {
            settingsUpdateOpen.disabled = false;
        }
    };
    const handlePlatformUpdate = (payload) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
        platformUpdate = (_a = payload === null || payload === void 0 ? void 0 : payload.update) !== null && _a !== void 0 ? _a : null;
        if (platformUpdateStatus) {
            platformUpdateStatus = {
                ...platformUpdateStatus,
                latestVersion: (_c = (_b = platformUpdate === null || platformUpdate === void 0 ? void 0 : platformUpdate.latestVersion) !== null && _b !== void 0 ? _b : platformUpdateStatus.latestVersion) !== null && _c !== void 0 ? _c : null,
                currentVersion: (_e = (_d = platformUpdate === null || platformUpdate === void 0 ? void 0 : platformUpdate.currentVersion) !== null && _d !== void 0 ? _d : platformUpdateStatus.currentVersion) !== null && _e !== void 0 ? _e : null,
            };
        }
        if ((_f = payload === null || payload === void 0 ? void 0 : payload.error) === null || _f === void 0 ? void 0 : _f.message) {
            platformUpdateStatus = {
                phase: "error",
                mode: (_g = platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.mode) !== null && _g !== void 0 ? _g : null,
                message: payload.error.message,
                progressPercent: null,
                transferredBytes: null,
                totalBytes: null,
                downloadedPath: (_h = platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.downloadedPath) !== null && _h !== void 0 ? _h : null,
                currentVersion: (_k = (_j = platformUpdate === null || platformUpdate === void 0 ? void 0 : platformUpdate.currentVersion) !== null && _j !== void 0 ? _j : platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.currentVersion) !== null && _k !== void 0 ? _k : null,
                latestVersion: (_m = (_l = platformUpdate === null || platformUpdate === void 0 ? void 0 : platformUpdate.latestVersion) !== null && _l !== void 0 ? _l : platformUpdateStatus === null || platformUpdateStatus === void 0 ? void 0 : platformUpdateStatus.latestVersion) !== null && _m !== void 0 ? _m : null,
                checkedAt: (_o = platformUpdate === null || platformUpdate === void 0 ? void 0 : platformUpdate.checkedAt) !== null && _o !== void 0 ? _o : Date.now(),
                updatedAt: Date.now(),
                error: {
                    code: (_p = payload.error.code) !== null && _p !== void 0 ? _p : null,
                    message: payload.error.message,
                },
            };
        }
        updatePlatformUpdateUi();
    };
    const handlePlatformUpdateStatus = (payload) => {
        var _a;
        const status = (_a = payload === null || payload === void 0 ? void 0 : payload.status) !== null && _a !== void 0 ? _a : null;
        if (!status) {
            return;
        }
        platformUpdateStatus = {
            ...status,
            updatedAt: typeof status.updatedAt === "number" && Number.isFinite(status.updatedAt)
                ? status.updatedAt
                : Date.now(),
        };
        updatePlatformUpdateUi();
    };
    const setFeedbackStatus = (message, tone = "neutral") => {
        if (!(settingsFeedbackStatus instanceof HTMLElement)) {
            return;
        }
        settingsFeedbackStatus.textContent = message;
        settingsFeedbackStatus.classList.toggle("is-hidden", message.trim().length === 0);
        settingsFeedbackStatus.classList.toggle("is-success", tone === "success");
        settingsFeedbackStatus.classList.toggle("is-error", tone === "error");
    };
    const updateFeedbackSendState = () => {
        if (!(settingsFeedbackSend instanceof HTMLButtonElement)) {
            return;
        }
        settingsFeedbackSend.disabled = feedbackPending;
        settingsFeedbackSend.textContent = feedbackPending ? "送信中..." : "送信";
    };
    const sendFeedback = () => {
        if (!(settingsFeedbackMessage instanceof HTMLTextAreaElement)) {
            return;
        }
        const message = settingsFeedbackMessage.value.trim();
        if (!message) {
            setFeedbackStatus("フィードバック内容を入力してください。", "error");
            settingsFeedbackMessage.focus();
            return;
        }
        const rawCategory = settingsFeedbackCategory instanceof HTMLSelectElement
            ? settingsFeedbackCategory.value
            : "";
        const category = rawCategory === "bug" || rawCategory === "idea" || rawCategory === "other"
            ? rawCategory
            : "other";
        const contactEmail = settingsFeedbackEmail instanceof HTMLInputElement
            ? settingsFeedbackEmail.value.trim()
            : "";
        if (contactEmail &&
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
            setFeedbackStatus("連絡先メールアドレスの形式を確認してください。", "error");
            settingsFeedbackEmail.focus();
            return;
        }
        feedbackPending = true;
        updateFeedbackSendState();
        setFeedbackStatus("フィードバックを送信しています...");
        const posted = deps.postToNative({
            type: "feedback:send",
            category,
            message,
            contactEmail: contactEmail || undefined,
        }, true);
        if (!posted) {
            feedbackPending = false;
            updateFeedbackSendState();
            setFeedbackStatus("フィードバック送信を開始できませんでした。", "error");
        }
    };
    const handlePlatformFeedback = (payload) => {
        var _a;
        feedbackPending = false;
        updateFeedbackSendState();
        if (payload === null || payload === void 0 ? void 0 : payload.ok) {
            if (settingsFeedbackMessage instanceof HTMLTextAreaElement) {
                settingsFeedbackMessage.value = "";
            }
            const suffix = payload.feedbackId ? ` (ID: ${payload.feedbackId})` : "";
            setFeedbackStatus(`フィードバックを送信しました${suffix}`, "success");
            return;
        }
        const message = ((_a = payload === null || payload === void 0 ? void 0 : payload.error) === null || _a === void 0 ? void 0 : _a.message) && payload.error.message.trim()
            ? payload.error.message.trim()
            : "フィードバック送信に失敗しました。";
        setFeedbackStatus(message, "error");
    };
    const setEditorAlignEnvEnabled = (enabled) => {
        editorAlignEnvEnabled = Boolean(enabled);
        saveEditorAlignEnvState();
        updateEditorAlignEnvUI();
    };
    const toggleEditorAlignEnv = () => {
        editorAlignEnvEnabled = !editorAlignEnvEnabled;
        saveEditorAlignEnvState();
        updateEditorAlignEnvUI();
    };
    const setEditorFormatSettings = (next) => {
        editorFormatSettings = normalizeEditorFormatSettings({
            ...editorFormatSettings,
            ...next,
        });
        saveEditorFormatSettings();
        updateEditorFormatSettingsUI();
    };
    const addEditorFormatVerbatim = (value) => {
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
    const removeEditorFormatVerbatim = (value) => {
        const name = normalizeVerbatimInput(value);
        if (!name) {
            return;
        }
        const next = editorFormatSettings.customVerbatim.filter((entry) => normalizeVerbatimInput(entry) !== name);
        if (next.length === editorFormatSettings.customVerbatim.length) {
            return;
        }
        setEditorFormatSettings({ customVerbatim: next });
        setEditorFormatVerbatimHint(`${name} を削除しました。`);
    };
    const handleEditorFormatVerbatimListClick = (event) => {
        const target = event.target;
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
    const setEditorAutoSynctexBuildEnabled = (enabled) => {
        autoSynctexOnBuildEnabled = Boolean(enabled);
        saveEditorAutoSynctexBuildState();
        updateEditorAutoSynctexBuildUI();
    };
    const toggleEditorReverseSynctex = () => {
        reverseSynctexEnabled = !reverseSynctexEnabled;
        saveEditorReverseSynctexState();
        updateEditorReverseSynctexUI();
    };
    const setEditorReverseSynctexEnabled = (enabled) => {
        reverseSynctexEnabled = Boolean(enabled);
        saveEditorReverseSynctexState();
        updateEditorReverseSynctexUI();
    };
    const toggleEditorGhostCompletion = () => {
        var _a;
        ghostCompletionEnabled = !ghostCompletionEnabled;
        saveEditorGhostCompletionState();
        updateEditorGhostCompletionUI();
        (_a = deps.onGhostCompletionChange) === null || _a === void 0 ? void 0 : _a.call(deps, ghostCompletionEnabled);
    };
    const setGhostCompletionEnabled = (enabled) => {
        var _a;
        ghostCompletionEnabled = Boolean(enabled);
        saveEditorGhostCompletionState();
        updateEditorGhostCompletionUI();
        (_a = deps.onGhostCompletionChange) === null || _a === void 0 ? void 0 : _a.call(deps, ghostCompletionEnabled);
    };
    const setGhostCompletionConfig = (next) => {
        var _a;
        const debounce = clampNumber(typeof next.debounceMs === "number" ? next.debounceMs : ghostCompletionDebounceMs, ghostCompletionDebounceRange.min, ghostCompletionDebounceRange.max, ghostCompletionDebounceMs);
        const maxChars = clampNumber(typeof next.maxChars === "number" ? next.maxChars : ghostCompletionMaxChars, ghostCompletionMaxCharsRange.min, ghostCompletionMaxCharsRange.max, ghostCompletionMaxChars);
        ghostCompletionDebounceMs = debounce;
        ghostCompletionMaxChars = maxChars;
        saveEditorGhostCompletionConfig();
        updateEditorGhostCompletionConfigUI();
        (_a = deps.onGhostCompletionConfigChange) === null || _a === void 0 ? void 0 : _a.call(deps, {
            debounceMs: ghostCompletionDebounceMs,
            maxChars: ghostCompletionMaxChars,
        });
    };
    const setPdfViewerMode = (mode) => {
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
    const getSettingsSnapshot = () => ({
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
    const applySettingsPatch = (patch) => {
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
            editorFormatVerbatimAdd === null || editorFormatVerbatimAdd === void 0 ? void 0 : editorFormatVerbatimAdd.dispatchEvent(new MouseEvent("click"));
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
    if (settingsUpdateCheck instanceof HTMLButtonElement) {
        settingsUpdateCheck.addEventListener("click", () => {
            deps.postToNative({ type: "update:check", force: true }, true);
        });
    }
    if (settingsUpdateDownload instanceof HTMLButtonElement) {
        settingsUpdateDownload.addEventListener("click", () => {
            deps.postToNative({ type: "update:download" }, true);
        });
    }
    if (settingsUpdateInstall instanceof HTMLButtonElement) {
        settingsUpdateInstall.addEventListener("click", () => {
            deps.postToNative({ type: "update:install" }, true);
        });
    }
    if (settingsUpdateOpen instanceof HTMLButtonElement) {
        settingsUpdateOpen.addEventListener("click", () => {
            var _a, _b;
            const fallbackUrl = (_b = (_a = platformUpdate === null || platformUpdate === void 0 ? void 0 : platformUpdate.artifactUrl) !== null && _a !== void 0 ? _a : platformUpdate === null || platformUpdate === void 0 ? void 0 : platformUpdate.notesUrl) !== null && _b !== void 0 ? _b : TEX64_LINKS.download;
            openExternalUrl(fallbackUrl);
        });
    }
    const settingsLinkEntries = [
        { button: settingsLinkTerms, url: TEX64_LINKS.legalTerms },
        { button: settingsLinkPrivacy, url: TEX64_LINKS.legalPrivacy },
        { button: settingsLinkCommercial, url: TEX64_LINKS.legalCommercial },
        { button: settingsLinkRefund, url: TEX64_LINKS.legalRefund },
        { button: settingsLinkSupport, url: TEX64_LINKS.support },
        { button: settingsLinkContact, url: TEX64_LINKS.contact },
        { button: settingsLinkReleases, url: TEX64_LINKS.releases },
    ];
    settingsLinkEntries.forEach((entry) => {
        if (!(entry.button instanceof HTMLButtonElement)) {
            return;
        }
        entry.button.addEventListener("click", () => {
            openExternalUrl(entry.url);
        });
    });
    if (settingsFeedbackSend instanceof HTMLButtonElement) {
        settingsFeedbackSend.addEventListener("click", () => {
            sendFeedback();
        });
    }
    if (settingsFeedbackMessage instanceof HTMLTextAreaElement) {
        settingsFeedbackMessage.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                sendFeedback();
            }
        });
    }
    updateFeedbackSendState();
    setFeedbackStatus("");
    updatePlatformUpdateUi();
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
        handlePlatformFeedback,
        handlePlatformUpdate,
        handlePlatformUpdateStatus,
        openSettingsPage: (pageId) => setSettingsPage(pageId),
        loadStartupSettings,
        loadWorkspaceSettings,
    };
};
