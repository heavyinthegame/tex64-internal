import type { EditorSessionApi } from "./editor-session.js";

type InlineInsertText = string | { snippet: string };

type InlineSuggestion = {
  text: string;
  insertText: InlineInsertText;
};

export type InlineCompletionController = {
  applyGhostCompletionConfig: (config: { debounceMs: number; maxChars: number }) => void;
  registerInlineCompletionProvider: (monaco: {
    languages?: {
      registerInlineCompletionsProvider?: (
        languageId: string,
        provider: {
          provideInlineCompletions: (
            model: { getLineContent: (lineNumber: number) => string },
            position: { lineNumber: number; column: number },
            context?: { triggerKind?: number },
            token?: unknown
          ) =>
            | { items: Array<{ insertText: InlineInsertText; range?: unknown }>; dispose?: () => void }
            | Promise<{
                items: Array<{ insertText: InlineInsertText; range?: unknown }>;
                dispose?: () => void;
              }>;
          freeInlineCompletions?: (completions: unknown) => void;
        }
      ) => void;
      InlineCompletionTriggerKind?: { Automatic?: number };
    };
    Range?: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
  }) => void;
  recordInlineEdit: () => void;
};

export const createInlineCompletionController = (deps: {
  editorSession: EditorSessionApi;
  getGhostCompletionEnabled: () => boolean;
  getGhostCompletionConfig: () => { debounceMs: number; maxChars: number };
  requestApiCompletion?: (payload: {
    prompt: string;
    prefix: string;
    maxOutputTokens: number;
    temperature: number;
    topP: number;
    topK: number;
    timeoutMs: number;
  }) => Promise<{ text?: string } | null>;
}): InlineCompletionController => {
  let inlineCompletionRegistered = false;
  let lastInlineEditAt = 0;
  let lastApiRequestAt = 0;
  let apiInFlightKey: string | null = null;
  let apiInFlightPromise: Promise<InlineSuggestion | null> | null = null;
  const apiRequestTimestamps: number[] = [];
  const inlineCache = new Map<string, { suggestion: InlineSuggestion; ts: number }>();
  const apiCache = new Map<string, { text: string; ts: number }>();
  const apiNegativeCache = new Map<string, number>();
  const inlineConfig = {
    debounceMs: 120,
    minPrefix: 1,
    maxChars: 140,
    cacheTtlMs: 30_000,
    maxCacheEntries: 200,
  };
  const apiConfig = {
    enabled: true,
    minPrefix: 10,
    idleMs: 550,
    cooldownMs: 3000,
    maxPerMinute: 12,
    timeoutMs: 3500,
    cacheTtlMs: 120_000,
    negativeCacheTtlMs: 10_000,
    maxCacheEntries: 120,
    maxOutputTokens: 80,
    temperature: 0.2,
    topP: 0.9,
    topK: 40,
    contextBeforeLines: 16,
    contextAfterLines: 6,
  };

  const clampInlineNumber = (value: number, min: number, max: number, fallback: number) => {
    if (!Number.isFinite(value)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(value)));
  };

  const applyGhostCompletionConfig = (config: { debounceMs: number; maxChars: number }) => {
    inlineConfig.debounceMs = clampInlineNumber(
      config.debounceMs,
      0,
      2000,
      inlineConfig.debounceMs
    );
    inlineConfig.maxChars = clampInlineNumber(
      config.maxChars,
      20,
      400,
      inlineConfig.maxChars
    );
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

  const hasUnescapedPercent = (value: string) => {
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

  const normalizeSlashLikeCommands = (value: string) =>
    value.replace(/[¥＼]/g, "\\");

  const toPlainSuggestion = (text: string): InlineSuggestion => ({
    text,
    insertText: text,
  });

  const toSnippetSuggestion = (text: string, snippet: string): InlineSuggestion => ({
    text,
    insertText: { snippet },
  });

  const getInlineCacheKey = (prefix: string, suffix: string, line: number, column: number) =>
    `${line}:${column}:${prefix}||${suffix}`;

  const getInlineCache = (key: string) => {
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

  const setInlineCache = (key: string, suggestion: InlineSuggestion) => {
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

  const getApiCache = (key: string) => {
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

  const setApiCache = (key: string, text: string) => {
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

  const hasRecentApiNegative = (key: string) => {
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

  const setApiNegative = (key: string) => {
    apiNegativeCache.set(key, Date.now());
  };

  const cleanupApiTimestamps = () => {
    const cutoff = Date.now() - 60_000;
    while (apiRequestTimestamps.length > 0 && apiRequestTimestamps[0] < cutoff) {
      apiRequestTimestamps.shift();
    }
  };

  const isTypingCommandToken = (normalizedPrefix: string) =>
    /\\[A-Za-z]+$/.test(normalizedPrefix);

  const isSafeSuffixForInlineInsert = (suffix: string) => {
    if (!suffix.trim()) {
      return true;
    }
    return /^[\s)\]}>,.;:!?'"`~-]*$/.test(suffix);
  };

  const canRequestApiCompletion = (prefix: string, suffix: string) => {
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

  const buildApiPrompt = (
    model: {
      getLineContent: (lineNumber: number) => string;
      getLineCount?: () => number;
    },
    position: { lineNumber: number; column: number }
  ) => {
    const lineNumber = position.lineNumber;
    const columnIndex = Math.max(position.column - 1, 0);
    const line = model.getLineContent(lineNumber);
    const linePrefix = line.slice(0, columnIndex);
    const lineSuffix = line.slice(columnIndex);
    const totalLinesRaw = model.getLineCount?.();
    const totalLines =
      typeof totalLinesRaw === "number" && Number.isFinite(totalLinesRaw) && totalLinesRaw > 0
        ? Math.round(totalLinesRaw)
        : lineNumber;
    const startLine = Math.max(1, lineNumber - apiConfig.contextBeforeLines);
    const endLine = Math.min(totalLines, lineNumber + apiConfig.contextAfterLines);
    const contextLines: string[] = [];
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

  const extractApiText = (raw: unknown, linePrefix: string): string | null => {
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

  const requestApiCompletion = async (prompt: string, linePrefix: string): Promise<string | null> => {
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

  const pickCommandTemplate = (partial: string) => {
    if (!partial || partial.length < inlineConfig.minPrefix) {
      return null;
    }
    const lower = partial.toLowerCase();
    return commandTemplates.find((command) => command.name.startsWith(lower)) ?? null;
  };

  const pickEnvironment = (partial: string) => {
    if (!partial) {
      return null;
    }
    const lower = partial.toLowerCase();
    return environmentNames.find((env) => env.startsWith(lower)) ?? null;
  };

  const buildInlineSuggestion = (
    model: { getLineContent: (lineNumber: number) => string },
    position: { lineNumber: number; column: number }
  ): InlineSuggestion | null => {
    const line = model.getLineContent(position.lineNumber);
    const columnIndex = Math.max(position.column - 1, 0);
    const linePrefix = line.slice(0, columnIndex);
    const normalizedLinePrefix = normalizeSlashLikeCommands(linePrefix);
    const lineSuffix = line.slice(columnIndex);
    const allowAutoClosedBraceSuffix =
      lineSuffix === "}" && /\\begin\{[A-Za-z*]*$/.test(normalizedLinePrefix);
    if (lineSuffix.trim().length > 0 && !allowAutoClosedBraceSuffix) {
      return null;
    }
    if (hasUnescapedPercent(linePrefix)) {
      return null;
    }

    const beginClosedMatch = normalizedLinePrefix.match(/\\begin\{([A-Za-z*]+)\}\s*$/);
    if (beginClosedMatch) {
      const env = beginClosedMatch[1];
      const indent = normalizedLinePrefix.match(/^\s*/)?.[0] ?? "";
      return toSnippetSuggestion(
        `\n${indent}\\end{${env}}`,
        `\n${indent}$0\n${indent}\\end{${env}}`
      );
    }

    const beginPartialMatch = normalizedLinePrefix.match(/\\begin\{([A-Za-z*]*)$/);
    if (beginPartialMatch) {
      const partial = beginPartialMatch[1] ?? "";
      if (partial.length >= 1) {
        const env = pickEnvironment(partial);
        if (env && env.length > partial.length) {
          return toPlainSuggestion(`${env.slice(partial.length)}}`);
        }
      }
    }

    const braceMatch = normalizedLinePrefix.match(
      /\\(section|subsection|subsubsection|paragraph|subparagraph|caption|label|ref|eqref|cite|citep|citet)\{[^}]*$/
    );
    if (braceMatch) {
      return toPlainSuggestion("}");
    }

    const commandMatch = normalizedLinePrefix.match(/\\([A-Za-z]{1,})$/);
    if (commandMatch) {
      const partial = commandMatch[1] ?? "";
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
    const group = deps.editorSession.getActiveGroup();
    const editorAny = group.editor as { getSelection?: () => any } | null;
    const selection = editorAny?.getSelection?.();
    if (!selection || typeof selection !== "object") {
      return false;
    }
    const startLine =
      selection.startLineNumber ?? selection.selectionStartLineNumber ?? selection.positionLineNumber;
    const startColumn =
      selection.startColumn ?? selection.selectionStartColumn ?? selection.positionColumn;
    const endLine =
      selection.endLineNumber ?? selection.positionLineNumber ?? selection.selectionStartLineNumber;
    const endColumn =
      selection.endColumn ?? selection.positionColumn ?? selection.selectionStartColumn;
    if (
      typeof startLine !== "number" ||
      typeof startColumn !== "number" ||
      typeof endLine !== "number" ||
      typeof endColumn !== "number"
    ) {
      return false;
    }
    return startLine !== endLine || startColumn !== endColumn;
  };

  const registerInlineCompletionProvider = (monaco: {
    languages?: {
      registerInlineCompletionsProvider?: (
        languageId: string,
        provider: {
          provideInlineCompletions: (
            model: { getLineContent: (lineNumber: number) => string },
            position: { lineNumber: number; column: number },
            context?: { triggerKind?: number },
            token?: unknown
          ) =>
            | { items: Array<{ insertText: InlineInsertText; range?: unknown }>; dispose?: () => void }
            | Promise<{
                items: Array<{ insertText: InlineInsertText; range?: unknown }>;
                dispose?: () => void;
              }>;
          freeInlineCompletions?: (completions: unknown) => void;
        }
      ) => void;
      InlineCompletionTriggerKind?: { Automatic?: number };
    };
    Range?: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
  }) => {
    if (inlineCompletionRegistered || !monaco.languages?.registerInlineCompletionsProvider) {
      return;
    }

    monaco.languages.registerInlineCompletionsProvider("latex", {
      provideInlineCompletions: async (model, position, context) => {
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
          if (
            context?.triggerKind ===
            monaco.languages?.InlineCompletionTriggerKind?.Automatic
          ) {
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
          } else if (canRequestApiCompletion(prefix, suffix)) {
            const prompt = buildApiPrompt(model, position);
            const requestKey = cacheKey;
            if (apiInFlightKey === requestKey && apiInFlightPromise) {
              suggestion = await apiInFlightPromise;
            } else {
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
          ? new monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column
            )
          : undefined;
        return { items: [{ insertText: suggestion.insertText, range }] };
      },
      freeInlineCompletions: () => {},
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
