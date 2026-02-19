export const createInlineCompletionController = (deps) => {
    let inlineCompletionRegistered = false;
    let lastInlineEditAt = 0;
    let lastApiRequestAt = 0;
    let apiInFlightKey = null;
    let apiInFlightPromise = null;
    const apiRequestTimestamps = [];
    const inlineCache = new Map();
    const apiCache = new Map();
    const apiNegativeCache = new Map();
    const inlineConfig = {
        debounceMs: 120,
        minPrefix: 1,
        maxChars: 140,
        cacheTtlMs: 30000,
        maxCacheEntries: 200,
    };
    const apiConfig = {
        enabled: true,
        minPrefix: 10,
        idleMs: 550,
        cooldownMs: 3000,
        maxPerMinute: 8,
        timeoutMs: 3500,
        cacheTtlMs: 120000,
        negativeCacheTtlMs: 10000,
        maxCacheEntries: 120,
        maxOutputTokens: 48,
        temperature: 0.2,
        topP: 0.9,
        topK: 40,
        contextBeforeLines: 10,
        contextAfterLines: 4,
    };
    const clampInlineNumber = (value, min, max, fallback) => {
        if (!Number.isFinite(value)) {
            return fallback;
        }
        return Math.min(max, Math.max(min, Math.round(value)));
    };
    const applyGhostCompletionConfig = (config) => {
        inlineConfig.debounceMs = clampInlineNumber(config.debounceMs, 0, 2000, inlineConfig.debounceMs);
        inlineConfig.maxChars = clampInlineNumber(config.maxChars, 20, 400, inlineConfig.maxChars);
    };
    applyGhostCompletionConfig(deps.getGhostCompletionConfig());
    const commandTemplates = [
        { name: "section", suffix: "{}" },
        { name: "subsection", suffix: "{}" },
        { name: "subsubsection", suffix: "{}" },
        { name: "paragraph", suffix: "{}" },
        { name: "subparagraph", suffix: "{}" },
        { name: "label", suffix: "{}" },
        { name: "ref", suffix: "{}" },
        { name: "eqref", suffix: "{}" },
        { name: "pageref", suffix: "{}" },
        { name: "autoref", suffix: "{}" },
        { name: "cref", suffix: "{}" },
        { name: "namecref", suffix: "{}" },
        { name: "cite", suffix: "{}" },
        { name: "citep", suffix: "{}" },
        { name: "citet", suffix: "{}" },
        { name: "autocite", suffix: "{}" },
        { name: "parencite", suffix: "{}" },
        { name: "input", suffix: "{}" },
        { name: "include", suffix: "{}" },
        { name: "includegraphics", suffix: "{}" },
        { name: "begin", suffix: "{}" },
        { name: "emph", suffix: "{}" },
        { name: "textbf", suffix: "{}" },
        { name: "textit", suffix: "{}" },
        { name: "item", suffix: " " },
    ];
    const environmentNames = [
        "itemize",
        "enumerate",
        "description",
        "figure",
        "table",
        "equation",
        "align",
        "align*",
        "eqnarray",
        "theorem",
        "lemma",
        "corollary",
        "definition",
        "remark",
        "proof",
        "abstract",
        "quote",
        "center",
        "verbatim",
        "tabular",
        "tabularx",
        "tikzpicture",
    ];
    const hasUnescapedPercent = (value) => {
        for (let i = 0; i < value.length; i += 1) {
            if (value[i] === "%") {
                const prev = value[i - 1];
                if (prev !== "\\") {
                    return true;
                }
            }
        }
        return false;
    };
    const normalizeSlashLikeCommands = (value) => value.replace(/[¥＼]/g, "\\");
    const toPlainSuggestion = (text) => ({
        text,
        insertText: text,
    });
    const toSnippetSuggestion = (text, snippet) => ({
        text,
        insertText: { snippet },
    });
    const getInlineCacheKey = (prefix, suffix, line, column) => `${line}:${column}:${prefix}||${suffix}`;
    const getInlineCache = (key) => {
        const hit = inlineCache.get(key);
        if (!hit) {
            return null;
        }
        if (Date.now() - hit.ts > inlineConfig.cacheTtlMs) {
            inlineCache.delete(key);
            return null;
        }
        return hit.suggestion;
    };
    const setInlineCache = (key, suggestion) => {
        inlineCache.delete(key);
        inlineCache.set(key, { suggestion, ts: Date.now() });
        if (inlineCache.size <= inlineConfig.maxCacheEntries) {
            return;
        }
        const oldestKey = inlineCache.keys().next().value;
        if (typeof oldestKey === "string") {
            inlineCache.delete(oldestKey);
        }
    };
    const getApiCache = (key) => {
        const hit = apiCache.get(key);
        if (!hit) {
            return null;
        }
        if (Date.now() - hit.ts > apiConfig.cacheTtlMs) {
            apiCache.delete(key);
            return null;
        }
        return hit.text;
    };
    const setApiCache = (key, text) => {
        apiCache.delete(key);
        apiCache.set(key, { text, ts: Date.now() });
        if (apiCache.size <= apiConfig.maxCacheEntries) {
            return;
        }
        const oldestKey = apiCache.keys().next().value;
        if (typeof oldestKey === "string") {
            apiCache.delete(oldestKey);
        }
    };
    const hasRecentApiNegative = (key) => {
        const ts = apiNegativeCache.get(key);
        if (!ts) {
            return false;
        }
        if (Date.now() - ts > apiConfig.negativeCacheTtlMs) {
            apiNegativeCache.delete(key);
            return false;
        }
        return true;
    };
    const setApiNegative = (key) => {
        apiNegativeCache.set(key, Date.now());
    };
    const cleanupApiTimestamps = () => {
        const cutoff = Date.now() - 60000;
        while (apiRequestTimestamps.length > 0 && apiRequestTimestamps[0] < cutoff) {
            apiRequestTimestamps.shift();
        }
    };
    const isTypingCommandToken = (normalizedPrefix) => /\\[A-Za-z]+$/.test(normalizedPrefix);
    const isSafeSuffixForInlineInsert = (suffix) => {
        if (!suffix.trim()) {
            return true;
        }
        return /^[\s)\]}>,.;:!?'"`~-]*$/.test(suffix);
    };
    const canRequestApiCompletion = (prefix, suffix) => {
        if (!apiConfig.enabled) {
            return false;
        }
        if (!deps.requestApiCompletion) {
            return false;
        }
        if (!deps.getGhostCompletionEnabled()) {
            return false;
        }
        const normalizedPrefix = normalizeSlashLikeCommands(prefix);
        const trimmedPrefix = normalizedPrefix.trim();
        if (isTypingCommandToken(normalizedPrefix)) {
            return false;
        }
        if (hasUnescapedPercent(prefix)) {
            return false;
        }
        if (trimmedPrefix.length < apiConfig.minPrefix) {
            return false;
        }
        if (!isSafeSuffixForInlineInsert(suffix)) {
            return false;
        }
        if (Date.now() - lastInlineEditAt < apiConfig.idleMs) {
            return false;
        }
        if (Date.now() - lastApiRequestAt < apiConfig.cooldownMs) {
            return false;
        }
        cleanupApiTimestamps();
        if (apiRequestTimestamps.length >= apiConfig.maxPerMinute) {
            return false;
        }
        return true;
    };
    const buildApiPrompt = (model, position) => {
        var _a;
        const lineNumber = position.lineNumber;
        const columnIndex = Math.max(position.column - 1, 0);
        const line = model.getLineContent(lineNumber);
        const linePrefix = line.slice(0, columnIndex);
        const lineSuffix = line.slice(columnIndex);
        const totalLinesRaw = (_a = model.getLineCount) === null || _a === void 0 ? void 0 : _a.call(model);
        const totalLines = typeof totalLinesRaw === "number" && Number.isFinite(totalLinesRaw) && totalLinesRaw > 0
            ? Math.round(totalLinesRaw)
            : lineNumber;
        const startLine = Math.max(1, lineNumber - apiConfig.contextBeforeLines);
        const endLine = Math.min(totalLines, lineNumber + apiConfig.contextAfterLines);
        const contextLines = [];
        for (let i = startLine; i <= endLine; i += 1) {
            const line = model.getLineContent(i);
            contextLines.push(`${i}: ${line}`);
        }
        return [
            "You are assisting with in-editor LaTeX continuation.",
            "Continue text at <CURSOR> so the user can keep writing immediately.",
            "Return ONLY inserted text. No markdown. No explanation.",
            "Keep style, terminology, and notation consistent.",
            "Prefer valid, compile-safe LaTeX (balanced braces, coherent command usage).",
            "When possible, complete the current thought before starting a new one.",
            "If confidence is low, return empty.",
            "",
            "[Context]",
            ...contextLines,
            "",
            "[Cursor]",
            `${linePrefix}<CURSOR>${lineSuffix}`,
        ].join("\n");
    };
    const extractApiText = (raw, linePrefix) => {
        if (typeof raw !== "string") {
            return null;
        }
        let text = raw.trim();
        if (!text) {
            return null;
        }
        if (text.startsWith("```")) {
            const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*?)```/);
            if (fence && fence[1]) {
                text = fence[1].trim();
            }
        }
        text = text.replace(/<CURSOR>/g, "");
        const newlineIndex = text.indexOf("\n");
        if (newlineIndex >= 0) {
            text = text.slice(0, newlineIndex).trimEnd();
        }
        if (text.startsWith(linePrefix)) {
            text = text.slice(linePrefix.length);
        }
        return text.trimEnd() || null;
    };
    const requestApiCompletion = async (prompt, linePrefix) => {
        if (!deps.requestApiCompletion) {
            return null;
        }
        const result = await deps.requestApiCompletion({
            prompt,
            prefix: linePrefix,
            maxOutputTokens: apiConfig.maxOutputTokens,
            temperature: apiConfig.temperature,
            topP: apiConfig.topP,
            topK: apiConfig.topK,
            timeoutMs: apiConfig.timeoutMs,
        });
        if (!result || typeof result.text !== "string") {
            return null;
        }
        return extractApiText(result.text, linePrefix);
    };
    const pickCommandTemplate = (partial) => {
        var _a;
        if (!partial || partial.length < inlineConfig.minPrefix) {
            return null;
        }
        const lower = partial.toLowerCase();
        return (_a = commandTemplates.find((command) => command.name.startsWith(lower))) !== null && _a !== void 0 ? _a : null;
    };
    const pickEnvironment = (partial) => {
        var _a;
        if (!partial) {
            return null;
        }
        const lower = partial.toLowerCase();
        return (_a = environmentNames.find((env) => env.startsWith(lower))) !== null && _a !== void 0 ? _a : null;
    };
    const buildInlineSuggestion = (model, position) => {
        var _a, _b, _c, _d;
        const line = model.getLineContent(position.lineNumber);
        const columnIndex = Math.max(position.column - 1, 0);
        const linePrefix = line.slice(0, columnIndex);
        const normalizedLinePrefix = normalizeSlashLikeCommands(linePrefix);
        const lineSuffix = line.slice(columnIndex);
        const allowAutoClosedBraceSuffix = lineSuffix === "}" && /\\begin\{[A-Za-z*]*$/.test(normalizedLinePrefix);
        if (lineSuffix.trim().length > 0 && !allowAutoClosedBraceSuffix) {
            return null;
        }
        if (hasUnescapedPercent(linePrefix)) {
            return null;
        }
        const beginClosedMatch = normalizedLinePrefix.match(/\\begin\{([A-Za-z*]+)\}\s*$/);
        if (beginClosedMatch) {
            const env = beginClosedMatch[1];
            const indent = (_b = (_a = normalizedLinePrefix.match(/^\s*/)) === null || _a === void 0 ? void 0 : _a[0]) !== null && _b !== void 0 ? _b : "";
            return toSnippetSuggestion(`\n${indent}\\end{${env}}`, `\n${indent}$0\n${indent}\\end{${env}}`);
        }
        const beginPartialMatch = normalizedLinePrefix.match(/\\begin\{([A-Za-z*]*)$/);
        if (beginPartialMatch) {
            const partial = (_c = beginPartialMatch[1]) !== null && _c !== void 0 ? _c : "";
            if (partial.length >= 1) {
                const env = pickEnvironment(partial);
                if (env && env.length > partial.length) {
                    return toPlainSuggestion(`${env.slice(partial.length)}}`);
                }
            }
        }
        const braceMatch = normalizedLinePrefix.match(/\\(section|subsection|subsubsection|paragraph|subparagraph|caption|label|ref|eqref|cite|citep|citet)\{[^}]*$/);
        if (braceMatch) {
            return toPlainSuggestion("}");
        }
        const commandMatch = normalizedLinePrefix.match(/\\([A-Za-z]{1,})$/);
        if (commandMatch) {
            const partial = (_d = commandMatch[1]) !== null && _d !== void 0 ? _d : "";
            const template = pickCommandTemplate(partial);
            if (template && template.name.length >= partial.length) {
                const rest = template.name.slice(partial.length);
                if (template.suffix === "{}") {
                    return toSnippetSuggestion(`${rest}{}`, `${rest}{$0}`);
                }
                return toPlainSuggestion(`${rest}${template.suffix}`);
            }
        }
        return null;
    };
    const hasActiveSelection = () => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        const group = deps.editorSession.getActiveGroup();
        const editorAny = group.editor;
        const selection = (_a = editorAny === null || editorAny === void 0 ? void 0 : editorAny.getSelection) === null || _a === void 0 ? void 0 : _a.call(editorAny);
        if (!selection || typeof selection !== "object") {
            return false;
        }
        const startLine = (_c = (_b = selection.startLineNumber) !== null && _b !== void 0 ? _b : selection.selectionStartLineNumber) !== null && _c !== void 0 ? _c : selection.positionLineNumber;
        const startColumn = (_e = (_d = selection.startColumn) !== null && _d !== void 0 ? _d : selection.selectionStartColumn) !== null && _e !== void 0 ? _e : selection.positionColumn;
        const endLine = (_g = (_f = selection.endLineNumber) !== null && _f !== void 0 ? _f : selection.positionLineNumber) !== null && _g !== void 0 ? _g : selection.selectionStartLineNumber;
        const endColumn = (_j = (_h = selection.endColumn) !== null && _h !== void 0 ? _h : selection.positionColumn) !== null && _j !== void 0 ? _j : selection.selectionStartColumn;
        if (typeof startLine !== "number" ||
            typeof startColumn !== "number" ||
            typeof endLine !== "number" ||
            typeof endColumn !== "number") {
            return false;
        }
        return startLine !== endLine || startColumn !== endColumn;
    };
    const registerInlineCompletionProvider = (monaco) => {
        var _a;
        if (inlineCompletionRegistered || !((_a = monaco.languages) === null || _a === void 0 ? void 0 : _a.registerInlineCompletionsProvider)) {
            return;
        }
        monaco.languages.registerInlineCompletionsProvider("latex", {
            provideInlineCompletions: async (model, position, context) => {
                var _a, _b;
                if (!deps.getGhostCompletionEnabled()) {
                    return { items: [] };
                }
                if (deps.editorSession.isAnyGroupComposing()) {
                    return { items: [] };
                }
                if (hasActiveSelection()) {
                    return { items: [] };
                }
                if (Date.now() - lastInlineEditAt < inlineConfig.debounceMs) {
                    if ((context === null || context === void 0 ? void 0 : context.triggerKind) ===
                        ((_b = (_a = monaco.languages) === null || _a === void 0 ? void 0 : _a.InlineCompletionTriggerKind) === null || _b === void 0 ? void 0 : _b.Automatic)) {
                        return { items: [] };
                    }
                }
                const activePath = deps.editorSession.getActiveFilePath();
                if (!activePath || !activePath.endsWith(".tex")) {
                    return { items: [] };
                }
                const line = model.getLineContent(position.lineNumber);
                const prefix = line.slice(0, Math.max(position.column - 1, 0));
                const suffix = line.slice(Math.max(position.column - 1, 0));
                const cacheKey = getInlineCacheKey(prefix, suffix, position.lineNumber, position.column);
                const cached = getInlineCache(cacheKey);
                let suggestion = cached;
                if (!suggestion) {
                    suggestion = buildInlineSuggestion(model, position);
                    if (suggestion) {
                        setInlineCache(cacheKey, suggestion);
                    }
                }
                if (!suggestion) {
                    if (hasRecentApiNegative(cacheKey)) {
                        return { items: [] };
                    }
                    const apiCached = getApiCache(cacheKey);
                    if (apiCached) {
                        suggestion = toPlainSuggestion(apiCached);
                    }
                    else if (canRequestApiCompletion(prefix, suffix)) {
                        const prompt = buildApiPrompt(model, position);
                        const requestKey = cacheKey;
                        if (apiInFlightKey === requestKey && apiInFlightPromise) {
                            suggestion = await apiInFlightPromise;
                        }
                        else {
                            apiInFlightKey = requestKey;
                            apiInFlightPromise = (async () => {
                                lastApiRequestAt = Date.now();
                                apiRequestTimestamps.push(lastApiRequestAt);
                                const result = await requestApiCompletion(prompt, prefix);
                                apiInFlightKey = null;
                                apiInFlightPromise = null;
                                if (!result) {
                                    setApiNegative(requestKey);
                                    return null;
                                }
                                setApiCache(requestKey, result);
                                return toPlainSuggestion(result);
                            })();
                            suggestion = await apiInFlightPromise;
                        }
                    }
                }
                if (!suggestion || suggestion.text.length > inlineConfig.maxChars) {
                    return { items: [] };
                }
                const currentLine = model.getLineContent(position.lineNumber);
                const currentPrefix = currentLine.slice(0, Math.max(position.column - 1, 0));
                if (currentPrefix !== prefix) {
                    return { items: [] };
                }
                const range = monaco.Range
                    ? new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column)
                    : undefined;
                return { items: [{ insertText: suggestion.insertText, range }] };
            },
            freeInlineCompletions: () => { },
        });
        inlineCompletionRegistered = true;
    };
    return {
        applyGhostCompletionConfig,
        registerInlineCompletionProvider,
        recordInlineEdit: () => {
            lastInlineEditAt = Date.now();
        },
    };
};
