import { getMathFieldSelectionRange } from "../../app/blocks/math-input-utils.js";
import { buildOperatorCandidates, buildWordCandidates } from "./math-wysiwyg-candidates.js";
import { getKeyByLatex, normalizeLatexKey } from "./math-wysiwyg-keymap.js";
import {
  getInternalSelectionRanges,
  indexToOffsetInRange,
  offsetToIndexInRange,
  resolveScopeRange,
  setSelectionRange,
} from "./math-wysiwyg-selection.js";
import {
  findContainingEnvironmentAtCursor,
  hasEnvironmentInContext,
  isCursorInsideEnvironmentBody,
  readNativeMathfieldEnvironmentContext,
} from "./math-wysiwyg-environment-context.js";
import {
  SLASH_COMMAND_CANDIDATE_LIMIT,
  SLASH_COMMAND_HINT_SET,
  applySlashCommandHint,
  buildSlashCommandFallbackCandidates,
  dedupeCandidatesByLatex,
  normalizeSlashCommandToken,
} from "./math-wysiwyg-slash-commands.js";
import {
  AUTO_REPLACE_OPERATORS,
  findAutoReplaceCorrection,
  findOperatorToken,
  findSlashCommandToken,
  findWordToken,
  isCommandToken,
  isWordToken,
} from "./math-wysiwyg-token-matching.js";
import {
  getMathfieldInternalModel,
  getMathfieldModeAtOffset,
  isMathfieldSelectionPlaceholder,
  setMathfieldMode,
} from "../mathfield-private-adapter.js";
import type { TokenIndexMatch } from "./math-wysiwyg-token-matching.js";
import type { Candidate } from "./math-wysiwyg-triggers.js";
import type { MathKey } from "../../app/types.js";

export type MathWysiwygApi = {
  attach: (mathfield: HTMLElement) => void;
  detach: () => void;
  handleKeydown: (event: KeyboardEvent) => boolean;
  setComposing: (value: boolean) => void;
  close: () => void;
  openExplicitSuggestions: () => boolean;
  updateConfig: (config: Partial<MathWysiwygConfig>) => void;
  getWordCandidates: (token: string) => MathWysiwygWordCandidate[];
  openCustomCandidates: (candidates: CustomCandidate[], options?: { selectedIndex?: number }) => void;
};

export type MathWysiwygWordCandidate = {
  id: string;
  key: MathKey;
  label: string;
  hint: string;
  displayLatex?: string;
};

type MathWysiwygDeps = {
  container: HTMLElement | null;
  insertKey: (key: MathKey) => void;
  autoSuggest?: boolean;
  enabledPacks?: string[];
  mruStorageKey?: string;
  getMruStorageKey?: () => string;
};

type MathWysiwygConfig = {
  autoSuggest: boolean;
  enabledPacks: string[];
};

type TokenMatch = {
  token: string;
  range: { start: number; end: number };
  kind: "word" | "operator" | "command" | "slash-command";
};

type SuggestOptions = {
  explicit?: boolean;
};

type CustomCandidate = {
  id: string;
  label: string;
  hint: string;
  displayLatex?: string;
  apply: (mathfield: any) => void;
};

const toLiteralInsertKey = (key: MathKey): MathKey => ({
  label: key.label ?? key.latex,
  latex: key.latex,
  fallback: key.fallback,
  displayLatex: key.displayLatex,
  hint: key.hint,
});

const AUTO_WORD_MIN_LENGTH = 3;
const AUTO_COMMAND_MIN_LENGTH = 2;
const AUTO_WORD_ALLOWLIST = new Set([
  "bb",
  "bf",
  "bm",
  "ds",
  "ge",
  "gg",
  "in",
  "ip",
  "it",
  "le",
  "ll",
  "ln",
  "mp",
  "mu",
  "ne",
  "ni",
  "nu",
  "op",
  "or",
  "pi",
  "pm",
  "rm",
  "sf",
  "to",
  "tr",
  "tt",
  "xi",
]);
const AUTO_CONTAINS_MIN_LENGTH = 4;
const EXPLICIT_WORD_MIN_LENGTH = 1;
const EXPLICIT_SUFFIX_MIN_LENGTH = 6;
const DEFAULT_MRU_STORAGE_KEY = "tex64.math-wysiwyg.mru";
const MAX_MRU_ENTRIES = 200;
const PLACEHOLDER_TOKEN_REGEX = /\\placeholder(?:\[[^\]]*\])?\{(?:[^{}]|\\.)*\}/g;
const INTERTEXT_TEMPLATE_RE = /^\\(?:intertext|shortintertext)\{#\?\}$/;
const AUX_COMMAND_TEMPLATE_RE =
  /^\\(?:label|tag\*?|eqref|ref|pageref|autoref|intertext|shortintertext)\{#\?\}$/;
const AUX_COMMAND_BARE_RE = /^\\(?:notag|nonumber)$/;
const MATRIX_LIKE_ENV_NAMES = new Set([
  "matrix",
  "pmatrix",
  "bmatrix",
  "Bmatrix",
  "vmatrix",
  "Vmatrix",
  "smallmatrix",
  "cases",
  "dcases",
  "rcases",
  "aligned",
]);
const AUX_COMMAND_BLOCKED_ENV_NAMES = new Set([
  "matrix",
  "pmatrix",
  "bmatrix",
  "Bmatrix",
  "vmatrix",
  "Vmatrix",
  "smallmatrix",
  "cases",
  "dcases",
  "rcases",
  "array",
]);

type MruEntry = {
  count: number;
  lastUsedAt: number;
  latex?: string;
  label?: string;
  hint?: string;
  displayLatex?: string;
};

export const initMathWysiwyg = (deps: MathWysiwygDeps): MathWysiwygApi => {
  let autoSuggest = deps.autoSuggest ?? true;
  let enabledPacks = new Set(deps.enabledPacks ?? []);
  let mathfield: HTMLElement | null = null;
  let eventController: AbortController | null = null;
  let composing = false;
  let active = false;
  let explicitSession = false;
  let forcedTextMode = false;
  let holdTextModeUntil = 0;
  let selectedIndex = 0;
  let currentRange: { start: number; end: number } | null = null;
  let currentTokenMatch: TokenMatch | null = null;
  let currentCandidates: Candidate[] = [];
  let suppressNextUpdate = false;
  let lastInputTime = 0;
  let editAnchorOffset: number | null = null;
  let explicitSessionPrefixLatex: string | null = null;
  let mutationSessionId = 0;
  const resolveMruStorageKey = () =>
    deps.getMruStorageKey?.() ?? deps.mruStorageKey ?? DEFAULT_MRU_STORAGE_KEY;
  let mruStorageKey = resolveMruStorageKey();
  const mru = new Map<string, MruEntry>();
  let mruSaveTimer: number | null = null;
  let mruSaveKey: string | null = null;

  const panel = document.createElement("div");
  panel.className = "math-wysiwyg-panel";
  panel.setAttribute("role", "listbox");
  panel.setAttribute("aria-hidden", "true");

  let panelHost: HTMLElement | null = null;

  const enqueueMicrotaskSafe = (task: () => void) => {
    if (typeof queueMicrotask === "function") {
      queueMicrotask(task);
      return;
    }
    Promise.resolve().then(task);
  };

  const resetCandidateState = () => {
    currentCandidates = [];
    currentRange = null;
    currentTokenMatch = null;
    selectedIndex = 0;
  };

  const beginMutationSession = () => {
    mutationSessionId += 1;
    return mutationSessionId;
  };

  const finalizeMutationSession = (
    sessionId: number,
    options?: {
      focusTarget?: any;
      reopenExplicitSession?: boolean;
      clearCandidates?: boolean;
    }
  ) => {
    enqueueMicrotaskSafe(() => {
      if (sessionId !== mutationSessionId) {
        return;
      }
      suppressNextUpdate = false;
      if (options?.clearCandidates !== false) {
        resetCandidateState();
      }
      if (options?.reopenExplicitSession) {
        explicitSession = true;
        refresh({ explicit: true });
      } else if (autoSuggest) {
        refresh();
      }
      if (typeof options?.focusTarget?.focus === "function") {
        options.focusTarget.focus();
      }
    });
  };

  const loadMru = (key: string) => {
    if (typeof localStorage === "undefined") {
      return;
    }
    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as Record<string, MruEntry>;
      Object.entries(parsed).forEach(([key, entry]) => {
        if (!entry || typeof entry !== "object") return;
        const count = Number(entry.count);
        const lastUsedAt = Number(entry.lastUsedAt);
        if (!Number.isFinite(count) || !Number.isFinite(lastUsedAt)) return;
        const latex = typeof entry.latex === "string" ? entry.latex : undefined;
        const label = typeof entry.label === "string" ? entry.label : undefined;
        const hint = typeof entry.hint === "string" ? entry.hint : undefined;
        const displayLatex =
          typeof entry.displayLatex === "string" ? entry.displayLatex : undefined;
        mru.set(key, { count, lastUsedAt, latex, label, hint, displayLatex });
      });
    } catch {
      // ignore storage errors
    }
  };

  const saveMru = (key: string) => {
    if (typeof localStorage === "undefined") {
      return;
    }
    try {
      const payload: Record<string, MruEntry> = {};
      mru.forEach((entry, id) => {
        payload[id] = entry;
      });
      localStorage.setItem(key, JSON.stringify(payload));
    } catch {
      // ignore storage errors
    }
  };

  const scheduleMruSave = () => {
    if (typeof localStorage === "undefined") {
      return;
    }
    if (mruSaveTimer !== null) {
      return;
    }
    mruSaveKey = mruStorageKey;
    mruSaveTimer = window.setTimeout(() => {
      const keyToSave = mruSaveKey ?? mruStorageKey;
      mruSaveTimer = null;
      mruSaveKey = null;
      saveMru(keyToSave);
    }, 150);
  };

  const flushMruSave = () => {
    if (typeof localStorage === "undefined") {
      return;
    }
    if (mruSaveTimer === null) {
      return;
    }
    window.clearTimeout(mruSaveTimer);
    const keyToSave = mruSaveKey ?? mruStorageKey;
    mruSaveTimer = null;
    mruSaveKey = null;
    saveMru(keyToSave);
  };

  const ensureMruStorageKey = () => {
    const nextKey = resolveMruStorageKey();
    if (!nextKey || nextKey === mruStorageKey) {
      return;
    }
    flushMruSave();
    mru.clear();
    mruStorageKey = nextKey;
    loadMru(mruStorageKey);
  };

  const recordMru = (candidate: Candidate) => {
    const candidateId = candidate.id;
    if (!candidateId) {
      return;
    }
    ensureMruStorageKey();
    const entry = mru.get(candidateId) ?? { count: 0, lastUsedAt: 0 };
    entry.count += 1;
    entry.lastUsedAt = Date.now();
    if (!candidate.apply) {
      const latex = normalizeLatexKey(candidate.key.latex);
      if (latex) {
        entry.latex = latex;
        entry.label = candidate.label;
        entry.hint = candidate.hint;
        entry.displayLatex = candidate.displayLatex;
      }
    }
    mru.set(candidateId, entry);
    if (mru.size > MAX_MRU_ENTRIES) {
      const sorted = Array.from(mru.entries()).sort((a, b) => {
        const aScore = a[1].lastUsedAt;
        const bScore = b[1].lastUsedAt;
        return aScore - bScore;
      });
      const trimCount = mru.size - MAX_MRU_ENTRIES;
      for (let i = 0; i < trimCount; i += 1) {
        const key = sorted[i]?.[0];
        if (key) {
          mru.delete(key);
        }
      }
    }
    scheduleMruSave();
  };

  const applyMruRanking = (items: Candidate[]) => {
    ensureMruStorageKey();
    if (mru.size === 0 || items.length <= 1) {
      return items;
    }
    const ranked = items.map((item, index) => {
      const entry = mru.get(item.id);
      return {
        item,
        index,
        count: entry?.count ?? 0,
        lastUsedAt: entry?.lastUsedAt ?? 0,
      };
    });
    ranked.sort((a, b) => {
      if (a.count !== b.count) {
        return b.count - a.count;
      }
      if (a.lastUsedAt !== b.lastUsedAt) {
        return b.lastUsedAt - a.lastUsedAt;
      }
      return a.index - b.index;
    });
    return ranked.map((entry) => entry.item);
  };

  const buildRecentCandidates = (limit = 8) => {
    ensureMruStorageKey();
    const entries = Array.from(mru.entries())
      .map(([id, entry]) => ({ id, entry }))
      .filter(
        (item) =>
          !!item.entry &&
          typeof item.entry.latex === "string" &&
          typeof item.entry.label === "string" &&
          typeof item.entry.hint === "string"
      )
      .sort((a, b) => {
        const timeDiff = (b.entry.lastUsedAt ?? 0) - (a.entry.lastUsedAt ?? 0);
        if (timeDiff !== 0) return timeDiff;
        return (b.entry.count ?? 0) - (a.entry.count ?? 0);
      })
      .slice(0, Math.max(0, limit));

    return entries.map(({ id, entry }, index) => {
      const latex = entry.latex ?? "";
      const label = entry.label ?? latex;
      const hint = entry.hint ?? label;
      const displayLatex = entry.displayLatex ?? latex;
      return {
        id,
        key: getKeyByLatex(latex, label, displayLatex),
        label,
        hint,
        displayLatex,
        priority: 240 - index,
      } satisfies Candidate;
    });
  };

  const buildQuickCandidates = () => {
    // A short, stable set for discoverability when the user hasn't typed a token yet.
    const tokens = [
      "frac",
      "sqrt",
      "sum",
      "int",
      "lim",
      "cases",
      "pmatrix",
      "aligned",
      "text",
      "bb",
      "defeq",
      "to",
    ];
    const results: Candidate[] = [];
    const seen = new Set<string>();
    tokens.forEach((token) => {
      const candidates = buildWordCandidates(token, {
        allowContains: false,
        allowContainsMinLength: 99,
        allowedPacks: undefined,
      });
      const takeCount = token === "int" || token === "sum" ? 2 : 1;
      candidates.slice(0, takeCount).forEach((candidate) => {
        if (seen.has(candidate.id)) return;
        seen.add(candidate.id);
        results.push(candidate);
      });
    });
    return results;
  };

  const readMathfieldLatex = (
    mathfieldApi: any,
    ...args: [number, number, "latex"] | ["latex"]
  ): string | null => {
    if (typeof mathfieldApi?.getValue !== "function") {
      return null;
    }
    try {
      const value = mathfieldApi.getValue(...args);
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  };

  const findScopedSlashCommandMatch = (
    mathfieldApi: any,
    cursorOffset: number
  ): TokenMatch | null => {
    const beforeCursor = readMathfieldLatex(mathfieldApi, 0, cursorOffset, "latex");
    if (typeof beforeCursor !== "string") {
      return null;
    }
    const match = /\/\/([A-Za-z*]*)$/.exec(beforeCursor);
    if (!match) {
      return null;
    }
    const token = match[1] ?? "";
    const endIndex = beforeCursor.length;
    const startIndex = endIndex - token.length - 2;
    if (startIndex < 0) {
      return null;
    }
    const startOffset = indexToOffsetInRange(
      mathfieldApi,
      0,
      cursorOffset,
      startIndex,
      "floor"
    );
    if (!Number.isFinite(startOffset) || startOffset < 0) {
      return null;
    }
    return {
      token,
      range: { start: startOffset, end: cursorOffset },
      kind: "slash-command",
    };
  };

  const findLiteralPlaceholderRange = (
    mathfieldApi: any,
    anchorOffset: number
  ): { start: number; end: number } | null => {
    const lastOffset =
      typeof mathfieldApi?.lastOffset === "number" && mathfieldApi.lastOffset > 0
        ? mathfieldApi.lastOffset
        : null;
    if (lastOffset === null) {
      return null;
    }
    const latex = readMathfieldLatex(mathfieldApi, 0, lastOffset, "latex");
    if (!latex || !latex.includes("\\placeholder")) {
      return null;
    }
    const anchorIndex = offsetToIndexInRange(mathfieldApi, 0, anchorOffset);
    const regex = new RegExp(PLACEHOLDER_TOKEN_REGEX.source, "g");
    const matches: Array<{ startIndex: number; endIndex: number }> = [];
    let match: RegExpExecArray | null = regex.exec(latex);
    while (match) {
      const startIndex = match.index;
      const endIndex = startIndex + match[0].length;
      matches.push({ startIndex, endIndex });
      match = regex.exec(latex);
    }
    if (matches.length === 0) {
      return null;
    }
    const preferred =
      matches.find((item) => item.startIndex >= anchorIndex) ?? matches[0];
    const start = indexToOffsetInRange(mathfieldApi, 0, lastOffset, preferred.startIndex, "floor");
    const end = indexToOffsetInRange(mathfieldApi, 0, lastOffset, preferred.endIndex, "ceil");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return null;
    }
    return { start, end };
  };

  const buildMatrixOpCandidates = () => {
    if (!mathfield) {
      return [] as Candidate[];
    }
    const mf = mathfield as any;
    const selection = getMathFieldSelectionRange(mf);
    const cursorOffset = resolveCursorOffset(mf, selection);
    const nativeContext = readNativeMathfieldEnvironmentContext(mf, cursorOffset);
    const inMatrixByContext = hasEnvironmentInContext(nativeContext, MATRIX_LIKE_ENV_NAMES);
    const latex = inMatrixByContext ? null : readMathfieldLatex(mf, "latex");
    const cursorIndex =
      !inMatrixByContext && latex
        ? offsetToIndexInRange(mf, 0, cursorOffset)
        : -1;
    const inMatrix =
      inMatrixByContext ||
      (!!latex &&
        cursorIndex >= 0 &&
        isCursorInsideEnvironmentBody(latex, cursorIndex, MATRIX_LIKE_ENV_NAMES));
    if (!inMatrix || typeof mf.executeCommand !== "function") {
      return [] as Candidate[];
    }
    const applyCommand = (command: string) => (target: any) => {
      if (typeof target.executeCommand !== "function") {
        return;
      }
      try {
        const ok = Boolean(target.executeCommand(command));
        if (ok) {
          target.dispatchEvent?.(new Event("input", { bubbles: true }));
        }
      } catch {
        // ignore
      }
    };
    const makeOp = (
      id: string,
      label: string,
      hint: string,
      displayLatex: string,
      command: string,
      priority: number
    ) =>
      ({
        id,
        key: getKeyByLatex(label, label, displayLatex),
        label,
        hint,
        displayLatex,
        priority,
        apply: applyCommand(command),
      }) satisfies Candidate;

    return [
      makeOp(
        "matrix-op:add-row",
        "+row",
        "行を追加",
        "\\begin{matrix}a\\\\b\\end{matrix}",
        "addRowAfter",
        260
      ),
      makeOp(
        "matrix-op:add-col",
        "+col",
        "列を追加",
        "\\begin{matrix}a&b\\end{matrix}",
        "addColumnAfter",
        258
      ),
      makeOp(
        "matrix-op:remove-row",
        "-row",
        "行を削除",
        "\\begin{matrix}a\\\\b\\end{matrix}",
        "removeRow",
        256
      ),
      makeOp(
        "matrix-op:remove-col",
        "-col",
        "列を削除",
        "\\begin{matrix}a&b\\end{matrix}",
        "removeColumn",
        254
      ),
    ];
  };

  const isCursorInBlockedAuxEnvironment = (mathfieldApi: any, cursorOffset: number) => {
    const nativeContext = readNativeMathfieldEnvironmentContext(mathfieldApi, cursorOffset);
    if (hasEnvironmentInContext(nativeContext, AUX_COMMAND_BLOCKED_ENV_NAMES)) {
      return true;
    }
    const latex = readMathfieldLatex(mathfieldApi, "latex");
    if (!latex) {
      return false;
    }
    const cursorIndex = offsetToIndexInRange(mathfieldApi, 0, cursorOffset);
    return isCursorInsideEnvironmentBody(latex, cursorIndex, AUX_COMMAND_BLOCKED_ENV_NAMES);
  };

  const insertAuxCommandOutsideBlockedContext = (
    mathfieldApi: any,
    insertedLatex: string,
    cursorOffset: number
  ) => {
    const sourceLatex = readMathfieldLatex(mathfieldApi, "latex");
    if (typeof sourceLatex !== "string") {
      return false;
    }
    const normalized = normalizeLatexKey(insertedLatex).replace(/#\?/g, "");
    if (!normalized.startsWith("\\")) {
      return false;
    }

    let insertionIndex = sourceLatex.length;
    const cursorIndex =
      typeof cursorOffset === "number" && Number.isFinite(cursorOffset)
        ? offsetToIndexInRange(mathfieldApi, 0, cursorOffset)
        : -1;
    if (cursorIndex >= 0) {
      const blockedEnv = findContainingEnvironmentAtCursor(
        sourceLatex,
        cursorIndex,
        AUX_COMMAND_BLOCKED_ENV_NAMES
      );
      if (blockedEnv) {
        insertionIndex = blockedEnv.endEnd;
      }
    }

    const before = sourceLatex.slice(0, insertionIndex);
    const after = sourceLatex.slice(insertionIndex);
    const leadingSpacer = before.length === 0 || /\s$/.test(before) ? "" : " ";
    const trailingSpacer = after.length === 0 || /^\s/.test(after) ? "" : " ";
    const insertedChunk = `${leadingSpacer}${normalized}${trailingSpacer}`;
    const insertionStartIndex = before.length + leadingSpacer.length;
    const sourceLastOffset =
      typeof mathfieldApi.lastOffset === "number" && mathfieldApi.lastOffset > 0
        ? mathfieldApi.lastOffset
        : sourceLatex.length;
    const insertionOffset = indexToOffsetInRange(
      mathfieldApi,
      0,
      sourceLastOffset,
      insertionIndex,
      "floor"
    );
    if (!Number.isFinite(insertionOffset) || insertionOffset < 0) {
      return false;
    }
    setSelectionRange(mathfieldApi, insertionOffset, insertionOffset);

    const insertOptions = {
      selectionMode: "after",
      focus: true,
      feedback: false,
      format: "latex",
    };
    let inserted = false;
    if (typeof mathfieldApi.executeCommand === "function") {
      const beforeValue = readMathfieldLatex(mathfieldApi, "latex");
      try {
        const ok = mathfieldApi.executeCommand("insert", insertedChunk, insertOptions);
        const afterValue = readMathfieldLatex(mathfieldApi, "latex");
        const changed =
          typeof beforeValue === "string" &&
          typeof afterValue === "string" &&
          afterValue !== beforeValue;
        inserted = ok !== false || changed;
      } catch {
        inserted = false;
      }
    }
    if (!inserted && typeof mathfieldApi.insert === "function") {
      const beforeValue = readMathfieldLatex(mathfieldApi, "latex");
      try {
        mathfieldApi.insert(insertedChunk, insertOptions);
        const afterValue = readMathfieldLatex(mathfieldApi, "latex");
        inserted =
          typeof beforeValue === "string" && typeof afterValue === "string"
            ? afterValue !== beforeValue
            : true;
      } catch {
        inserted = false;
      }
    }
    if (!inserted) {
      return false;
    }

    const nextLatex = readMathfieldLatex(mathfieldApi, "latex");
    if (typeof nextLatex === "string") {
      const searchStart = Math.max(0, insertionStartIndex - 1);
      let commandIndex = nextLatex.indexOf(normalized, searchStart);
      if (commandIndex < 0) {
        commandIndex = nextLatex.lastIndexOf(normalized);
      }
      if (commandIndex >= 0) {
        let selectionStartIndex = commandIndex + normalized.length;
        let selectionEndIndex = selectionStartIndex;
        const braceStart = normalized.indexOf("{");
        if (braceStart >= 0) {
          const braceEnd = normalized.indexOf("}", braceStart + 1);
          if (braceEnd >= braceStart + 1) {
            selectionStartIndex = commandIndex + braceStart + 1;
            selectionEndIndex = commandIndex + braceEnd;
          }
        }
        const lastOffset =
          typeof mathfieldApi.lastOffset === "number" && mathfieldApi.lastOffset > 0
            ? mathfieldApi.lastOffset
            : nextLatex.length;
        const startOffset = indexToOffsetInRange(
          mathfieldApi,
          0,
          lastOffset,
          selectionStartIndex,
          "floor"
        );
        const endOffset = indexToOffsetInRange(
          mathfieldApi,
          0,
          lastOffset,
          selectionEndIndex,
          "ceil"
        );
        if (
          Number.isFinite(startOffset) &&
          Number.isFinite(endOffset) &&
          startOffset >= 0 &&
          endOffset >= startOffset
        ) {
          setSelectionRange(mathfieldApi, startOffset, endOffset);
        }
      }
    }

    if (/^\\(?:shortintertext|intertext)\{/.test(normalized)) {
      try {
        setMathfieldMode(mathfieldApi, "text");
        forcedTextMode = true;
        holdTextModeUntil = nowMs() + 200;
      } catch {
        // ignore mode switch failures
      }
    }

    try {
      mathfieldApi.dispatchEvent?.(new Event("input", { bubbles: true }));
    } catch {
      // ignore dispatch failures
    }
    return true;
  };

  const buildExplicitFallbackCandidates = () => {
    const matrixOps = buildMatrixOpCandidates();
    const recent = buildRecentCandidates(matrixOps.length > 0 ? 6 : 8);
    const quick = buildQuickCandidates();
    const seen = new Set<string>();
    const results: Candidate[] = [];
    const pushAll = (items: Candidate[]) => {
      items.forEach((item) => {
        if (seen.has(item.id)) return;
        seen.add(item.id);
        results.push(item);
      });
    };
    pushAll(matrixOps);
    pushAll(recent);
    pushAll(quick);
    return results.slice(0, 14);
  };

  loadMru(mruStorageKey);

  const resolvePanelHost = () => {
    if (panelHost && panelHost.isConnected) {
      return panelHost;
    }
    if (!deps.container) {
      return null;
    }
    const host =
      (deps.container.closest(".panel-body.blocks-panel") as HTMLElement | null) ??
      (deps.container.closest(".panel-body") as HTMLElement | null) ??
      deps.container;
    panelHost = host;
    return host;
  };

  const positionPanelNearCaret = () => {
    if (!deps.container || !active) {
      return;
    }
    const host = resolvePanelHost();
    if (!host) {
      return;
    }
    const hostRect = host.getBoundingClientRect();
    const containerRect = deps.container.getBoundingClientRect();
    const margin = 8;
    const offset = 20;
    const maxWidth = Math.max(160, hostRect.width - margin * 2);

    panel.style.position = "absolute";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.maxWidth = `${maxWidth}px`;

    let left = margin;
    let top = Math.round(containerRect.bottom - hostRect.top + offset);

    panel.style.left = `${left}px`;
    panel.style.top = `${Math.max(margin, top)}px`;

    const panelRect = panel.getBoundingClientRect();
    if (panelRect.width > 0 && hostRect.width > 0) {
      const maxLeft = Math.max(margin, hostRect.width - panelRect.width - margin);
      left = Math.min(Math.max(margin, left), maxLeft);
      panel.style.left = `${left}px`;
    }

    if (panelRect.height > 0 && hostRect.height > 0) {
      const maxTop = Math.max(margin, hostRect.height - panelRect.height - margin);
      const wouldOverflowBottom =
        panelRect.bottom > hostRect.bottom - margin && panelRect.height < hostRect.height;
      if (wouldOverflowBottom) {
        const aboveTop = Math.round(containerRect.top - hostRect.top - panelRect.height - offset);
        if (aboveTop >= margin) {
          panel.style.top = `${aboveTop}px`;
          return;
        }
      }
      top = Math.min(Math.max(margin, top), maxTop);
      panel.style.top = `${top}px`;
    }
  };

  const ensurePanel = () => {
    const host = resolvePanelHost();
    if (!host) {
      return;
    }
    if (!panel.isConnected) {
      host.appendChild(panel);
    }
  };

  const setPanelVisible = (visible: boolean) => {
    active = visible;
    if (!visible) {
      explicitSession = false;
      explicitSessionPrefixLatex = null;
    }
    panel.setAttribute("aria-hidden", visible ? "false" : "true");
    deps.container?.classList.toggle("has-wysiwyg-suggestions", visible);
    if (!visible) {
      panel.textContent = "";
      panel.style.removeProperty("left");
      panel.style.removeProperty("top");
      panel.style.removeProperty("right");
      panel.style.removeProperty("bottom");
      panel.style.removeProperty("max-width");
    }
  };

  const renderCandidate = (candidate: Candidate, index: number) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "math-wysiwyg-item";
    button.setAttribute("role", "option");
    const isActive = index === selectedIndex;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");

    const symbol = document.createElement("span");
    symbol.className = "math-wysiwyg-symbol";
    const MathLiveGlobal = (window as any).MathLive;
    if (candidate.displayLatex && MathLiveGlobal?.convertLatexToMarkup) {
      try {
        const latexToRender = `\\displaystyle ${candidate.displayLatex}`;
        symbol.innerHTML = MathLiveGlobal.convertLatexToMarkup(latexToRender);
      } catch {
        symbol.textContent = candidate.label;
      }
    } else {
      symbol.textContent = candidate.label;
    }

    const label = document.createElement("span");
    label.className = "math-wysiwyg-label";
    label.textContent = candidate.hint;

    button.appendChild(symbol);
    button.appendChild(label);

    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
    });
    button.addEventListener("click", () => {
      applyCandidate(index);
    });

    return button;
  };

  const renderPanel = () => {
    if (!active) {
      return;
    }
    panel.textContent = "";
    currentCandidates.forEach((candidate, index) => {
      panel.appendChild(renderCandidate(candidate, index));
    });
    positionPanelNearCaret();
    scrollActiveIntoView();
  };

  const scrollActiveIntoView = () => {
    if (!active) {
      return;
    }
    const activeItem = panel.querySelector(".math-wysiwyg-item.is-active") as
      | HTMLElement
      | null;
    if (!activeItem) {
      return;
    }
    try {
      activeItem.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch {
      // ignore
    }
  };

  const updateCandidates = (tokenMatch: TokenMatch | null, options: SuggestOptions = {}) => {
    const explicit = options.explicit ?? false;
    if (!tokenMatch) {
      if (explicit) {
        currentCandidates = buildExplicitFallbackCandidates();
        currentRange = null;
        currentTokenMatch = null;
        selectedIndex = 0;
        if (currentCandidates.length === 0) {
          setPanelVisible(false);
          return;
        }
        ensurePanel();
        setPanelVisible(true);
        renderPanel();
        return;
      }
      currentCandidates = [];
      currentRange = null;
      currentTokenMatch = null;
      selectedIndex = 0;
      setPanelVisible(false);
      return;
    }
    const allowedPacks = explicit ? undefined : enabledPacks.size > 0 ? enabledPacks : undefined;
    if (
      tokenMatch.kind === "word" ||
      tokenMatch.kind === "command" ||
      tokenMatch.kind === "slash-command"
    ) {
      const normalized = tokenMatch.token.toLowerCase();
      const minLength =
        tokenMatch.kind === "slash-command"
          ? 0
          : explicit
          ? EXPLICIT_WORD_MIN_LENGTH
          : tokenMatch.kind === "command"
          ? AUTO_COMMAND_MIN_LENGTH
          : isCommandToken(tokenMatch.token)
          ? AUTO_COMMAND_MIN_LENGTH
          : AUTO_WORD_ALLOWLIST.has(normalized)
          ? 2
          : AUTO_WORD_MIN_LENGTH;
      if (tokenMatch.token.length < minLength) {
        currentCandidates = [];
        currentRange = null;
        currentTokenMatch = null;
        selectedIndex = 0;
        setPanelVisible(false);
        return;
      }
    }

    let effectiveMatch = tokenMatch;
    let nextCandidates: Candidate[] = [];
    if (tokenMatch.kind === "operator") {
      nextCandidates = buildOperatorCandidates(tokenMatch.token);
    } else if (tokenMatch.kind === "slash-command") {
      const slashToken = normalizeSlashCommandToken(tokenMatch.token);
      if (!slashToken) {
        nextCandidates = buildSlashCommandFallbackCandidates();
      } else {
        const rawCandidates = buildWordCandidates(slashToken, {
          allowContainsMinLength: explicit ? 1 : AUTO_CONTAINS_MIN_LENGTH,
          allowedPacks,
          dedupeByLatex: !explicit,
        });
        const preferred = rawCandidates.filter((candidate) =>
          SLASH_COMMAND_HINT_SET.has(candidate.hint.toLowerCase())
        );
        const exact = rawCandidates.filter(
          (candidate) => normalizeSlashCommandToken(candidate.hint) === slashToken
        );
        const merged = preferred.length > 0
          ? [...exact, ...preferred, ...rawCandidates]
          : [...exact, ...rawCandidates];
        nextCandidates = dedupeCandidatesByLatex(merged)
          .slice(0, SLASH_COMMAND_CANDIDATE_LIMIT)
          .map(applySlashCommandHint);
      }
    } else {
      nextCandidates = buildWordCandidates(tokenMatch.token, {
        allowContainsMinLength: explicit ? 2 : AUTO_CONTAINS_MIN_LENGTH,
        allowedPacks,
        dedupeByLatex: !explicit,
      });
    }

    const allowSuffixRescue =
      explicit &&
      tokenMatch.kind === "word" &&
      tokenMatch.token.length >= EXPLICIT_SUFFIX_MIN_LENGTH;
    if (allowSuffixRescue && nextCandidates.length === 0) {
      const minSuffixLength = 2;
      for (
        let dropPrefix = 1;
        dropPrefix <= tokenMatch.token.length - minSuffixLength;
        dropPrefix += 1
      ) {
        const suffix = tokenMatch.token.slice(dropPrefix);
        const suffixCandidates = buildWordCandidates(suffix, {
          allowContainsMinLength: explicit ? 2 : AUTO_CONTAINS_MIN_LENGTH,
          allowedPacks,
          dedupeByLatex: !explicit,
        });
        if (suffixCandidates.length === 0) {
          continue;
        }
        effectiveMatch = {
          ...tokenMatch,
          token: suffix,
          range: {
            start: tokenMatch.range.start + dropPrefix,
            end: tokenMatch.range.end,
          },
        };
        nextCandidates = suffixCandidates;
        break;
      }
    }

    if (nextCandidates.length === 0) {
      currentCandidates = [];
      currentRange = null;
      currentTokenMatch = null;
      setPanelVisible(false);
      return;
    }

    nextCandidates = applyMruRanking(nextCandidates);

    const sameList =
      currentCandidates.length === nextCandidates.length &&
      currentCandidates.every((item, idx) => item.id === nextCandidates[idx].id);

    currentCandidates = nextCandidates;
    currentRange = effectiveMatch.range;
    currentTokenMatch = effectiveMatch;
    if (!sameList) {
      selectedIndex = 0;
    } else {
      selectedIndex = Math.max(0, Math.min(selectedIndex, currentCandidates.length - 1));
    }

    ensurePanel();
    setPanelVisible(true);
    renderPanel();
  };

  const getWordCandidates = (token: string): MathWysiwygWordCandidate[] => {
    const normalized = token.trim();
    if (!normalized) {
      return [];
    }
    const allowedPacks = enabledPacks.size > 0 ? enabledPacks : undefined;
    return buildWordCandidates(normalized, { allowedPacks }).map((candidate) => ({
      id: candidate.id,
      key: candidate.key,
      label: candidate.label,
      hint: candidate.hint,
      displayLatex: candidate.displayLatex,
    }));
  };

  const openCustomCandidates = (
    candidates: CustomCandidate[],
    options?: { selectedIndex?: number }
  ) => {
    if (!candidates || candidates.length === 0) {
      return;
    }
    const mapped: Candidate[] = candidates.map((candidate, index) => ({
      id: candidate.id,
      key: getKeyByLatex(candidate.label, candidate.label, candidate.displayLatex),
      label: candidate.label,
      hint: candidate.hint,
      displayLatex: candidate.displayLatex,
      priority: 100 - index,
      apply: candidate.apply,
    }));
    currentCandidates = mapped;
    currentRange = null;
    currentTokenMatch = null;
    selectedIndex = Math.max(
      0,
      Math.min(options?.selectedIndex ?? 0, currentCandidates.length - 1)
    );
    ensurePanel();
    setPanelVisible(true);
    renderPanel();
  };

  const getModeAtOffset = (
    mathfieldApi: any,
    offset: number
  ): "math" | "text" | "latex" | null => {
    if (offset < 0) {
      return null;
    }
    if (typeof mathfieldApi?.getElementInfo === "function") {
      try {
        const info = mathfieldApi.getElementInfo(offset);
        const mode = info?.mode ?? null;
        if (mode === "math" || mode === "text" || mode === "latex") {
          return mode;
        }
      } catch {
        // ignore
      }
    }
    return getMathfieldModeAtOffset(mathfieldApi, offset);
  };

  const nowMs = () =>
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();

  const clearEditAnchor = () => {
    editAnchorOffset = null;
  };

  const resolveAnalysisRange = (
    mathfieldApi: any,
    cursorOffset: number
  ): { start: number; end: number } => {
    const scopeRange = resolveScopeRange(mathfieldApi, cursorOffset);
    if (editAnchorOffset === null) {
      return scopeRange;
    }
    if (!Number.isFinite(editAnchorOffset)) {
      clearEditAnchor();
      return scopeRange;
    }
    const anchor = Math.max(scopeRange.start, Math.min(scopeRange.end, editAnchorOffset));
    if (cursorOffset < anchor) {
      clearEditAnchor();
      return scopeRange;
    }
    // One-way input model: analyze only the active edit buffer.
    // Keep delimiter-only lookbehind (`//`, `\`) to preserve command triggers
    // when the anchor was moved to just after the delimiter.
    let start = anchor;
    if (anchor > scopeRange.start) {
      const lookbehindStart = Math.max(scopeRange.start, anchor - 2);
      const lookbehind = readMathfieldLatex(mathfieldApi, lookbehindStart, anchor, "latex") ?? "";
      if (lookbehind.endsWith("//")) {
        start = Math.max(scopeRange.start, anchor - 2);
      } else if (lookbehind.endsWith("\\")) {
        start = Math.max(scopeRange.start, anchor - 1);
      }
    }
    return { start, end: scopeRange.end };
  };

  const resolveCursorOffset = (
    mathfieldApi: any,
    selection: { start: number; end: number }
  ) => {
    const start = Number(selection.start);
    const end = Number(selection.end);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      return Math.max(0, Math.max(start, end));
    }
    if (Number.isFinite(end)) {
      return Math.max(0, end);
    }
    if (Number.isFinite(start)) {
      return Math.max(0, start);
    }
    const position = Number(mathfieldApi?.position);
    if (Number.isFinite(position)) {
      return Math.max(0, position);
    }
    return 0;
  };

  const syncMathfieldMode = (mathfieldApi: any, cursorOffset: number) => {
    const currentMode =
      typeof mathfieldApi?.mode === "string"
        ? (mathfieldApi.mode as "math" | "text" | "latex")
        : null;
    if (!currentMode || currentMode === "latex") {
      forcedTextMode = false;
      return;
    }

    // If the user changed modes manually while we were forcing, stop managing it.
    if (forcedTextMode && currentMode !== "text") {
      forcedTextMode = false;
    }

    const modeAtCursor =
      getModeAtOffset(mathfieldApi, cursorOffset) ??
      getModeAtOffset(mathfieldApi, cursorOffset - 1);
    const wantsText = modeAtCursor === "text";

    const setMode = (nextMode: "math" | "text") => setMathfieldMode(mathfieldApi, nextMode);

    if (wantsText) {
      if (currentMode !== "text") {
        if (setMode("text")) {
          forcedTextMode = true;
        }
      }
      return;
    }

    if (forcedTextMode && currentMode === "text") {
      if (nowMs() < holdTextModeUntil) {
        return;
      }
      setMode("math");
      forcedTextMode = false;
    }
  };

  const isInSuppressedTextContext = (mathfieldApi: any, cursorOffset: number) => {
    const mode =
      typeof mathfieldApi?.mode === "string"
        ? (mathfieldApi.mode as "math" | "text" | "latex")
        : null;
    if (mode === "text") {
      return true;
    }
    const modeAtCursor =
      getModeAtOffset(mathfieldApi, cursorOffset) ??
      getModeAtOffset(mathfieldApi, cursorOffset - 1);
    if (modeAtCursor === "text") {
      return true;
    }
    const latex = readMathfieldLatex(mathfieldApi, "latex");
    if (!latex) {
      return false;
    }
    const cursorIndex = offsetToIndexInRange(mathfieldApi, 0, cursorOffset);
    if (cursorIndex <= 0) {
      return false;
    }
    const textLikeCommands = new Set([
      "text",
      "operatorname",
      "operatorname*",
      "mathrm",
      "mathbf",
      "mathit",
      "mathsf",
      "mathtt",
      "mathcal",
      "mathfrak",
      "mathscr",
      "mathbb",
      "mathds",
      "bm",
      "textrm",
      "textsf",
      "texttt",
      "textit",
      "textbf",
      "mbox",
    ]);
    let depth = 0;
    const stack: number[] = [];
    const isLetter = (ch: string) => /[A-Za-z]/.test(ch);
    const isEscapedAtLiteral = (text: string, index: number) => {
      let slashCount = 0;
      for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
        slashCount += 1;
      }
      return slashCount % 2 === 1;
    };

    for (let i = 0; i < latex.length && i < cursorIndex; i += 1) {
      const ch = latex[i];
      if (ch === "\\") {
        let j = i + 1;
        if (j >= cursorIndex) {
          break;
        }
        let command = "";
        if (isLetter(latex[j] ?? "")) {
          const start = j;
          while (j < cursorIndex && isLetter(latex[j] ?? "")) {
            j += 1;
          }
          command = latex.slice(start, j);
        } else {
          command = latex[j] ?? "";
          j += 1;
        }
        if (command === "lbrace") {
          depth += 1;
          i = Math.max(i, j - 1);
          continue;
        }
        if (command === "rbrace") {
          depth = Math.max(0, depth - 1);
          while (stack.length > 0 && (stack[stack.length - 1] ?? 0) > depth) {
            stack.pop();
          }
          i = Math.max(i, j - 1);
          continue;
        }
        let normalizedCommand = command;
        let k = j;
        while (k < cursorIndex && latex[k] === " ") {
          k += 1;
        }
        if (
          k < cursorIndex &&
          latex[k] === "*" &&
          textLikeCommands.has(`${command}*`)
        ) {
          normalizedCommand = `${command}*`;
          k += 1;
          while (k < cursorIndex && latex[k] === " ") {
            k += 1;
          }
        }
        if (textLikeCommands.has(normalizedCommand)) {
          if (latex[k] === "{") {
            stack.push(depth + 1);
          } else if (
            k < cursorIndex &&
            latex.startsWith("\\lbrace", k) &&
            !isEscapedAtLiteral(latex, k)
          ) {
            depth += 1;
            stack.push(depth);
            i = Math.max(i, k + "\\lbrace".length - 1);
            continue;
          }
        }
        i = Math.max(i, j - 1);
        continue;
      }
      if (ch === "{") {
        depth += 1;
        continue;
      }
      if (ch === "}") {
        depth = Math.max(0, depth - 1);
        while (stack.length > 0 && (stack[stack.length - 1] ?? 0) > depth) {
          stack.pop();
        }
      }
    }
    return stack.length > 0;
  };

  // Fallback guard for text-like wrappers when the mode/range APIs miss context transitions.
  const isInSuppressedTextLiteralContext = (rawValue: string, cursorIndex: number) => {
    if (!rawValue || cursorIndex <= 0) {
      return false;
    }
    const beforeCursor = rawValue.slice(0, Math.max(0, cursorIndex));
    const normalizedBeforeCursor = beforeCursor
      .replace(/\\lbrace/g, "{")
      .replace(/\\rbrace/g, "}");
    const textLikeRe =
      /\\(?:text|operatorname\*?|mathrm|mathbf|mathit|mathsf|mathtt|mathcal|mathfrak|mathscr|mathbb|mathds|bm|textrm|textsf|texttt|textit|textbf|mbox)\s*\{[^{}]*$/;
    const textLikeClosedAtCursorRe =
      /\\(?:text|operatorname\*?|mathrm|mathbf|mathit|mathsf|mathtt|mathcal|mathfrak|mathscr|mathbb|mathds|bm|textrm|textsf|texttt|textit|textbf|mbox)\s*\{[^{}]*\}$/;
    return (
      textLikeRe.test(normalizedBeforeCursor) ||
      textLikeClosedAtCursorRe.test(normalizedBeforeCursor)
    );
  };

  const refresh = (options: SuggestOptions = {}) => {
    try {
      if (!mathfield || composing) {
        return;
      }
      if (suppressNextUpdate) {
        suppressNextUpdate = false;
        if (!options.explicit) {
          return;
        }
      }
      const mathfieldApi = mathfield as any;
      if (typeof mathfieldApi.getValue !== "function") {
        updateCandidates(null, options);
        return;
      }
      const selection = getMathFieldSelectionRange(mathfieldApi);
      const selectionRanges =
        selection.start !== selection.end ? getInternalSelectionRanges(mathfieldApi) : [];
      const cursorOffset = resolveCursorOffset(mathfieldApi, selection);
      if (!options.explicit && editAnchorOffset === null) {
        // IME-like behavior: only analyze tokens while an active edit session exists.
        updateCandidates(null, options);
        return;
      }
      const mode =
        typeof mathfieldApi.mode === "string"
          ? (mathfieldApi.mode as "math" | "text" | "latex")
          : null;
      if (mode === "text" && !options.explicit) {
        // Avoid noisy suggestions while typing inside \\text{...} and similar text-mode segments.
        updateCandidates(null, options);
        return;
      }
      const isPlaceholderSelection =
        selection.start !== selection.end &&
        selectionRanges.some(
          (range) => cursorOffset >= range.start && cursorOffset <= range.end
        );
      if (selection.start !== selection.end && !isPlaceholderSelection) {
        const selectionLength = Math.abs(selection.end - selection.start);
        const now =
          typeof performance !== "undefined" && typeof performance.now === "function"
            ? performance.now()
            : Date.now();
        if (selectionLength > 1 && now - lastInputTime > 120) {
          updateCandidates(null, options);
          return;
        }
      }
      const analysisRange = resolveAnalysisRange(mathfieldApi, cursorOffset);
      const rawValue = readMathfieldLatex(
        mathfieldApi,
        analysisRange.start,
        analysisRange.end,
        "latex"
      );
      if (typeof rawValue !== "string") {
        updateCandidates(null, options);
        return;
      }
      const cursorIndex = offsetToIndexInRange(mathfieldApi, analysisRange.start, cursorOffset);
      const fullRawValue = readMathfieldLatex(mathfieldApi, "latex");
      const globalCursorIndex = offsetToIndexInRange(mathfieldApi, 0, cursorOffset);
      const inSuppressedTextContext =
        isInSuppressedTextContext(mathfieldApi, cursorOffset) ||
        isInSuppressedTextLiteralContext(rawValue, cursorIndex) ||
        isInSuppressedTextLiteralContext(fullRawValue, globalCursorIndex);
      if (inSuppressedTextContext) {
        updateCandidates(null, options);
        return;
      }
      const toOffsetMatch = (match: TokenIndexMatch | null): TokenMatch | null => {
        if (!match) {
          return null;
        }
        const startOffset = indexToOffsetInRange(
          mathfieldApi,
          analysisRange.start,
          analysisRange.end,
          match.range.start,
          "floor"
        );
        const endOffset = indexToOffsetInRange(
          mathfieldApi,
          analysisRange.start,
          analysisRange.end,
          match.range.end,
          "ceil"
        );
        return { token: match.token, range: { start: startOffset, end: endOffset }, kind: match.kind };
      };
      const operatorCorrectionMatch = toOffsetMatch(findAutoReplaceCorrection(rawValue, cursorIndex));
      if (
        operatorCorrectionMatch &&
        !options.explicit &&
        autoSuggest &&
        AUTO_REPLACE_OPERATORS.has(operatorCorrectionMatch.token)
      ) {
        const candidates = buildOperatorCandidates(operatorCorrectionMatch.token);
        const candidate = candidates[0];
        if (candidate) {
          const mutationId = beginMutationSession();
          suppressNextUpdate = true;
          setPanelVisible(false);
          setSelectionRange(
            mathfieldApi,
            operatorCorrectionMatch.range.start,
            operatorCorrectionMatch.range.end
          );
          deps.insertKey(candidate.key);
          finalizeMutationSession(mutationId);
          return;
        }
      }

      const slashCommandMatch =
        findScopedSlashCommandMatch(mathfieldApi, cursorOffset) ??
        toOffsetMatch(findSlashCommandToken(rawValue, cursorIndex));
      if (slashCommandMatch) {
        updateCandidates(slashCommandMatch, { explicit: true });
        return;
      }

      const operatorMatch = toOffsetMatch(findOperatorToken(rawValue, cursorIndex));
      if (operatorMatch) {
        if (!options.explicit && autoSuggest && AUTO_REPLACE_OPERATORS.has(operatorMatch.token)) {
          if (inSuppressedTextContext) {
            updateCandidates(null, options);
            return;
          }
          const candidates = buildOperatorCandidates(operatorMatch.token);
          const candidate = candidates[0];
          if (candidate) {
            const mutationId = beginMutationSession();
            suppressNextUpdate = true;
            setPanelVisible(false);
            setSelectionRange(mathfieldApi, operatorMatch.range.start, operatorMatch.range.end);
            deps.insertKey(candidate.key);
            finalizeMutationSession(mutationId);
            return;
          }
        }
        // Only show operator suggestions on explicit/manual trigger.
        if (options.explicit) {
          updateCandidates(operatorMatch, options);
        } else {
          updateCandidates(null, options);
        }
        return;
      }
      const wordMatch = toOffsetMatch(findWordToken(rawValue, cursorIndex));
      if (!options.explicit && wordMatch) {
        const normalized = wordMatch.token.toLowerCase();
        const minLength =
          wordMatch.kind === "command"
            ? AUTO_COMMAND_MIN_LENGTH
            : AUTO_WORD_ALLOWLIST.has(normalized)
            ? 2
            : AUTO_WORD_MIN_LENGTH;
        if (wordMatch.token.length >= minLength && inSuppressedTextContext) {
          updateCandidates(null, options);
          return;
        }
      }
      updateCandidates(wordMatch, options);
    } catch {
      updateCandidates(null, options);
    }
  };

  const close = () => {
    beginMutationSession();
    suppressNextUpdate = false;
    explicitSessionPrefixLatex = null;
    clearEditAnchor();
    updateCandidates(null);
  };

  const openExplicitSuggestions = () => {
    if (!mathfield || composing) {
      return false;
    }
    const mathfieldApi = mathfield as any;
    const selection = getMathFieldSelectionRange(mathfieldApi);
    const cursorOffset = resolveCursorOffset(mathfieldApi, selection);
    let sessionAnchor = cursorOffset;
    const shouldCarryTypedPrefix = active && currentCandidates.length > 0;
    if (shouldCarryTypedPrefix) {
      const beforeCursor = readMathfieldLatex(mathfieldApi, 0, cursorOffset, "latex");
      if (typeof beforeCursor === "string" && beforeCursor.length > 0) {
        const trailingPatternList = [
          /\/\/[A-Za-z*]*$/,
          /\\[A-Za-z]*$/,
          /[A-Za-z0-9]{1,32}$/,
          /[+\-*/=<>:;,!?.]{1,8}$/,
        ];
        for (const pattern of trailingPatternList) {
          const match = pattern.exec(beforeCursor);
          if (!match || typeof match[0] !== "string") {
            continue;
          }
          const startIndex = beforeCursor.length - match[0].length;
          const anchorOffset = indexToOffsetInRange(
            mathfieldApi,
            0,
            cursorOffset,
            startIndex,
            "floor"
          );
          if (Number.isFinite(anchorOffset) && anchorOffset >= 0) {
            sessionAnchor = Math.max(0, Math.min(cursorOffset, anchorOffset));
            break;
          }
        }
      }
    }
    editAnchorOffset = sessionAnchor;
    explicitSession = true;
    explicitSessionPrefixLatex = readMathfieldLatex(mathfieldApi, 0, sessionAnchor, "latex");
    refresh({ explicit: true });
    return active;
  };

  const updateConfig = (config: Partial<MathWysiwygConfig>) => {
    if (typeof config.autoSuggest === "boolean") {
      autoSuggest = config.autoSuggest;
    }
    if (Array.isArray(config.enabledPacks)) {
      enabledPacks = new Set(config.enabledPacks);
    }
    if (!autoSuggest && active && !explicitSession) {
      updateCandidates(null);
      return;
    }
    if (autoSuggest && mathfield && !composing) {
      refresh();
    }
  };

  const applyCandidate = (index: number) => {
    if (!mathfield || index < 0 || index >= currentCandidates.length) {
      return;
    }
    clearEditAnchor();
    const candidate = currentCandidates[index];
    // A candidate commit finalizes the current session. Re-open only after new user input.
    const wasExplicitSession = explicitSession;
    const explicitSessionPrefix = explicitSessionPrefixLatex;
    const shouldKeepExplicitSession = false;
    explicitSession = false;
    recordMru(candidate);
    const mathfieldApi = mathfield as any;
    if (typeof mathfieldApi.focus === "function") {
      mathfieldApi.focus();
    }
    const selection = getMathFieldSelectionRange(mathfieldApi);
    const cursorOffset = resolveCursorOffset(mathfieldApi, selection);
    const insertionAnchorStart = currentRange ? currentRange.start : cursorOffset;
    const startMutation = () => {
      const sessionId = beginMutationSession();
      suppressNextUpdate = true;
      setPanelVisible(false);
      return sessionId;
    };
    const settleMutation = (
      sessionId: number,
      options?: { focus?: boolean; clearCandidates?: boolean }
    ) => {
      finalizeMutationSession(sessionId, {
        focusTarget: options?.focus ? mathfieldApi : null,
        reopenExplicitSession: shouldKeepExplicitSession,
        clearCandidates: options?.clearCandidates,
      });
    };
    const clearTriggerRange = () => {
      if (typeof mathfieldApi.executeCommand !== "function") {
        return;
      }
      const deleteBackwardChars = (count: number) => {
        if (!Number.isFinite(count) || count <= 0) {
          return false;
        }
        for (let i = 0; i < count; i += 1) {
          try {
            mathfieldApi.executeCommand("deleteBackward");
          } catch {
            return i > 0;
          }
        }
        return true;
      };
      const tokenSuffixFromMatch = (match: TokenMatch | null) => {
        if (!match) {
          return "";
        }
        if (match.kind === "command") {
          return `\\${match.token}`;
        }
        if (match.kind === "slash-command") {
          return `//${match.token}`;
        }
        return match.token;
      };
      const clearSuffixFromBuffer = (source: string, suffix: string) => {
        if (!source || !suffix || !source.endsWith(suffix)) {
          return false;
        }
        return deleteBackwardChars(suffix.length);
      };

      const beforeCursor = readMathfieldLatex(mathfieldApi, 0, cursorOffset, "latex") ?? "";
      const expectedSuffix = tokenSuffixFromMatch(currentTokenMatch);
      if (clearSuffixFromBuffer(beforeCursor, expectedSuffix)) {
        return;
      }

      if (wasExplicitSession) {
        let explicitBuffer = beforeCursor;
        if (explicitSessionPrefix && beforeCursor.startsWith(explicitSessionPrefix)) {
          explicitBuffer = beforeCursor.slice(explicitSessionPrefix.length);
        } else if (explicitSessionPrefix) {
          const relaxedPrefix = explicitSessionPrefix.replace(/\s+$/, "");
          if (relaxedPrefix && beforeCursor.startsWith(relaxedPrefix)) {
            explicitBuffer = beforeCursor.slice(relaxedPrefix.length);
          }
        }
        const trailingToken =
          /(\\?[A-Za-z*]+)$/.exec(explicitBuffer)?.[1] ??
          /(\/\/[A-Za-z*]*)$/.exec(explicitBuffer)?.[1] ??
          /([+\-*/=<>:;,!?.]+)$/.exec(explicitBuffer)?.[1] ??
          "";
        if (trailingToken && deleteBackwardChars(trailingToken.length)) {
          return;
        }
      }

      if (!currentRange) {
        return;
      }

      const rangeContainsCursor =
        cursorOffset >= currentRange.start && cursorOffset <= currentRange.end + 1;
      const rangeText =
        readMathfieldLatex(mathfieldApi, currentRange.start, currentRange.end, "latex") ?? "";
      if (rangeContainsCursor && clearSuffixFromBuffer(beforeCursor, rangeText)) {
        return;
      }

      // Last-resort local clear. Never issue a blind range delete, which can erase
      // surrounding structure when range mapping drifts in placeholder-heavy trees.
      const fallbackToken =
        /(\\?[A-Za-z*]+)$/.exec(beforeCursor)?.[1] ??
        /(\/\/[A-Za-z*]*)$/.exec(beforeCursor)?.[1] ??
        /([+\-*/=<>:;,!?.]+)$/.exec(beforeCursor)?.[1] ??
        "";
      if (fallbackToken) {
        deleteBackwardChars(fallbackToken.length);
      }
    };
    const insertedLatex =
      typeof candidate.key.latex === "string" ? normalizeLatexKey(candidate.key.latex) : "";
    const isAuxCommandCandidate =
      AUX_COMMAND_TEMPLATE_RE.test(insertedLatex) ||
      AUX_COMMAND_BARE_RE.test(insertedLatex) ||
      INTERTEXT_TEMPLATE_RE.test(insertedLatex);
    const shouldHoistAuxCommand =
      isAuxCommandCandidate && isCursorInBlockedAuxEnvironment(mathfieldApi, cursorOffset);

    if (INTERTEXT_TEMPLATE_RE.test(insertedLatex)) {
      const mutationId = startMutation();
      clearTriggerRange();
      const commandLatex = insertedLatex.startsWith("\\shortintertext")
        ? "\\shortintertext{}"
        : "\\intertext{}";
      if (shouldHoistAuxCommand) {
        insertAuxCommandOutsideBlockedContext(mathfieldApi, commandLatex, cursorOffset);
        settleMutation(mutationId, { focus: true });
        return;
      }
      deps.insertKey(
        toLiteralInsertKey(getKeyByLatex(commandLatex, commandLatex, commandLatex))
      );
      const currentSelection = getMathFieldSelectionRange(mathfieldApi);
      const cursorAtInsert = resolveCursorOffset(mathfieldApi, currentSelection);
      const targetOffset = Math.max(0, cursorAtInsert - 1);
      setSelectionRange(mathfieldApi, targetOffset, targetOffset);
      try {
        setMathfieldMode(mathfieldApi, "text");
        forcedTextMode = true;
        holdTextModeUntil = nowMs() + 200;
      } catch {
        // ignore mode switch failures
      }
      settleMutation(mutationId, { focus: true });
      return;
    }

    // Treat `\text{#?}` as a mode entry action rather than inserting a placeholder.
    // This avoids a MathLive edge case where a text-mode placeholder at the very beginning
    // gets replaced as math text (dropping the `\text{...}` wrapper).
    if (insertedLatex === "\\text{#?}") {
      const mutationId = startMutation();
      clearTriggerRange();
      try {
        setMathfieldMode(mathfieldApi, "text");
        try {
          mathfieldApi.mode = "text";
        } catch {
          // ignore
        }
        forcedTextMode = true;
        holdTextModeUntil = nowMs() + 200;
      } catch {
        // ignore mode switch failures
      }
      settleMutation(mutationId, { focus: true });
      return;
    }
    if (candidate.apply) {
      const mutationId = startMutation();
      if (currentRange) {
        setSelectionRange(mathfieldApi, currentRange.start, currentRange.end);
      }
      candidate.apply(mathfieldApi);
      settleMutation(mutationId);
      return;
    }
    const mutationId = startMutation();
    clearTriggerRange();
    if (
      shouldHoistAuxCommand &&
      insertAuxCommandOutsideBlockedContext(mathfieldApi, insertedLatex, cursorOffset)
    ) {
      settleMutation(mutationId, { focus: true });
      return;
    }
    const insertionKey = toLiteralInsertKey(candidate.key);
    deps.insertKey(insertionKey);
    const hasPlaceholderTemplate =
      typeof insertionKey.latex === "string" && insertionKey.latex.includes("#?");
    if (hasPlaceholderTemplate) {
      const inserted = normalizeLatexKey(insertionKey.latex);
      const isAuxCommandTemplate = AUX_COMMAND_TEMPLATE_RE.test(inserted);
      try {
        if (isAuxCommandTemplate) {
          const ranges = getInternalSelectionRanges(mathfieldApi);
          const literalTarget =
            findLiteralPlaceholderRange(mathfieldApi, insertionAnchorStart) ??
            findLiteralPlaceholderRange(mathfieldApi, 0);
          const lastRange = ranges.length > 0 ? ranges[ranges.length - 1] : null;
          const target = literalTarget ?? lastRange;
          if (target) {
            setSelectionRange(mathfieldApi, target.start, target.end);
            const shouldForceText =
              inserted.startsWith("\\text{") || inserted.startsWith("\\operatorname{");
            if (shouldForceText) {
              try {
                setMathfieldMode(mathfieldApi, "text");
                forcedTextMode = true;
                holdTextModeUntil = nowMs() + 200;
              } catch {
                // ignore mode switch failures
              }
            } else {
              syncMathfieldMode(mathfieldApi, target.end);
            }
          }
        } else {
          // For normal templates, trust MathLive's insertion selection first.
          // Force-selection by literal range can break matrix/cell contexts.
          const insertedSelection = getMathFieldSelectionRange(mathfieldApi);
          if (insertedSelection.start !== insertedSelection.end) {
            syncMathfieldMode(mathfieldApi, insertedSelection.end);
          } else {
            const ranges = getInternalSelectionRanges(mathfieldApi);
            const target =
              ranges.find((range) => range.start >= insertionAnchorStart) ?? ranges[0] ?? null;
            if (target) {
              setSelectionRange(mathfieldApi, target.start, target.end);
              syncMathfieldMode(mathfieldApi, target.end);
            }
          }
        }
      } catch {
        // ignore placeholder positioning failures
      }

      const settledRange = getMathFieldSelectionRange(mathfieldApi);
      if (
        settledRange.start === settledRange.end &&
        typeof mathfieldApi.executeCommand === "function"
      ) {
        try {
          const moved = Boolean(mathfieldApi.executeCommand("moveToNextPlaceholder"));
          if (moved) {
            const movedRange = getMathFieldSelectionRange(mathfieldApi);
            if (movedRange.start !== movedRange.end) {
              setSelectionRange(mathfieldApi, movedRange.start, movedRange.end);
              syncMathfieldMode(mathfieldApi, movedRange.end);
            }
          }
        } catch {
          // ignore placeholder fallback move failures
        }
      }
    } else {
      const settled = getMathFieldSelectionRange(mathfieldApi);
      if (settled.start !== settled.end) {
        const collapseTo = Math.max(settled.start, settled.end);
        setSelectionRange(mathfieldApi, collapseTo, collapseTo);
      }
    }
    if (typeof mathfieldApi.focus === "function") {
      mathfieldApi.focus();
    }
    settleMutation(mutationId, { focus: true });
  };

  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key === "Tab") {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return false;
      }
      event.preventDefault();
      if (active && currentCandidates.length > 0) {
        if (event.shiftKey) {
          selectedIndex =
            (selectedIndex - 1 + currentCandidates.length) % currentCandidates.length;
        } else {
          selectedIndex = (selectedIndex + 1) % currentCandidates.length;
        }
        renderPanel();
      }
      return true;
    }
    if (!active) {
      return false;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectedIndex = (selectedIndex + 1) % currentCandidates.length;
      renderPanel();
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      selectedIndex =
        (selectedIndex - 1 + currentCandidates.length) % currentCandidates.length;
      renderPanel();
      return true;
    }
    if (event.key === "Enter") {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return false;
      }
      event.preventDefault();
      applyCandidate(selectedIndex);
      return true;
    }
    if (event.key === " " || event.key === "Spacebar") {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return false;
      }
      event.preventDefault();
      refresh(explicitSession ? { explicit: true } : undefined);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      updateCandidates(null);
      return true;
    }
    if (!autoSuggest && !explicitSession) {
      if (
        event.key !== "Shift" &&
        event.key !== "Control" &&
        event.key !== "Alt" &&
        event.key !== "Meta"
      ) {
        updateCandidates(null);
      }
    }
    return false;
  };

  const attach = (target: HTMLElement) => {
    if (mathfield === target) {
      return;
    }
    detach();
    mathfield = target;
    eventController = new AbortController();
    const { signal } = eventController;
    const mathfieldApi = mathfield as any;

    mathfield.addEventListener(
      "input",
      () => {
        lastInputTime =
          typeof performance !== "undefined" && typeof performance.now === "function"
            ? performance.now()
            : Date.now();
        if (autoSuggest || explicitSession) {
          refresh(explicitSession ? { explicit: true } : undefined);
        }
      },
      { signal }
    );
    const handleEditAnchorKeydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const selection = getMathFieldSelectionRange(mathfieldApi);
      const selectionStart = Math.min(selection.start, selection.end);
      const selectionEnd = Math.max(selection.start, selection.end);
      const cursorOffset = resolveCursorOffset(mathfieldApi, {
        start: selectionStart,
        end: selectionEnd,
      });
      const key = event.key;

      if (
        key === "Escape" ||
        key === "Enter" ||
        key === "Tab" ||
        key === "Home" ||
        key === "End" ||
        key === "PageUp" ||
        key === "PageDown" ||
        key.startsWith("Arrow")
      ) {
        clearEditAnchor();
        return;
      }

      if (key === "Backspace") {
        if (selectionStart !== selectionEnd) {
          editAnchorOffset = selectionStart;
          return;
        }
        if (editAnchorOffset !== null && cursorOffset <= editAnchorOffset) {
          clearEditAnchor();
        }
        return;
      }

      if (key === "Delete") {
        if (selectionStart !== selectionEnd) {
          editAnchorOffset = selectionStart;
        }
        return;
      }

      const isSpace = key === " " || key === "Spacebar";
      const isPrintable = (typeof key === "string" && key.length === 1) || isSpace;
      if (!isPrintable) {
        return;
      }
      if (isSpace) {
        clearEditAnchor();
        return;
      }
      if (selectionStart !== selectionEnd) {
        editAnchorOffset = selectionStart;
        return;
      }
      if (
        editAnchorOffset === null ||
        cursorOffset < editAnchorOffset ||
        nowMs() - lastInputTime > 600
      ) {
        editAnchorOffset = cursorOffset;
      }
    };
    const handleModeKeydown = (event: KeyboardEvent) => {
      if (event.isComposing) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (typeof mathfieldApi?.mode === "string" && mathfieldApi.mode === "latex") {
        return;
      }
      const key = event.key;
      const isPrintable =
        (typeof key === "string" && key.length === 1) || key === " " || key === "Spacebar";
      if (!isPrintable) {
        return;
      }
      const selection = getMathFieldSelectionRange(mathfieldApi);
      const cursorOffset = resolveCursorOffset(mathfieldApi, selection);
      const cursorMode =
        getModeAtOffset(mathfieldApi, cursorOffset) ??
        getModeAtOffset(mathfieldApi, cursorOffset - 1);

      const internalModel = getMathfieldInternalModel(mathfieldApi);
      if (!internalModel) {
        return;
      }
      if (cursorMode === "text") {
        try {
          setMathfieldMode(mathfieldApi, "text");
          forcedTextMode = true;
          if (isMathfieldSelectionPlaceholder(mathfieldApi)) {
            holdTextModeUntil = nowMs() + 200;
          }
        } catch {
          // ignore
        }
      } else if (forcedTextMode && cursorMode === "math") {
        if (nowMs() < holdTextModeUntil) {
          try {
            setMathfieldMode(mathfieldApi, "text");
          } catch {
            // ignore
          }
          return;
        }
        try {
          setMathfieldMode(mathfieldApi, "math");
          forcedTextMode = false;
        } catch {
          // ignore
        }
      }
    };

    mathfield.addEventListener("keydown", handleEditAnchorKeydown, { signal, capture: true });
    mathfield.addEventListener("keydown", handleModeKeydown, { signal, capture: true });
    const shadowRoot = (mathfield as { shadowRoot?: ShadowRoot }).shadowRoot;
    if (shadowRoot) {
      shadowRoot.addEventListener("keydown", handleEditAnchorKeydown, { signal, capture: true });
      shadowRoot.addEventListener("keydown", handleModeKeydown, { signal, capture: true });
    }
    mathfield.addEventListener(
      "keyup",
      (event) => {
        // When the panel is open, ArrowUp/ArrowDown are used for navigating candidates.
        // Don't refresh the candidate list on keyup in that case, or we'll close/replace it.
        if (active && event.key.startsWith("Arrow")) {
          return;
        }
        if (
          event.key.startsWith("Arrow") ||
          event.key === "Backspace" ||
          event.key === "Delete"
        ) {
          if (autoSuggest || explicitSession) {
            refresh(explicitSession ? { explicit: true } : undefined);
          }
        }
      },
      { signal }
    );
    mathfield.addEventListener(
      "focus",
      () => {
        if (autoSuggest || explicitSession) {
          refresh(explicitSession ? { explicit: true } : undefined);
        }
      },
      { signal }
    );
    mathfield.addEventListener(
      "selection-change",
      () => {
        if (editAnchorOffset !== null && nowMs() - lastInputTime > 120) {
          const selection = getMathFieldSelectionRange(mathfieldApi);
          const cursorOffset = resolveCursorOffset(mathfieldApi, selection);
          const scopeRange = resolveScopeRange(mathfieldApi, cursorOffset);
          if (
            selection.start !== selection.end ||
            cursorOffset < editAnchorOffset ||
            editAnchorOffset < scopeRange.start ||
            editAnchorOffset > scopeRange.end
          ) {
            clearEditAnchor();
          }
        }
        if (autoSuggest || explicitSession) {
          refresh(explicitSession ? { explicit: true } : undefined);
        }
      },
      { signal }
    );

    mathfield.addEventListener(
      "blur",
      () => {
        clearEditAnchor();
        updateCandidates(null);
      },
      { signal }
    );

    if ((autoSuggest || explicitSession) && typeof mathfieldApi.getValue === "function") {
      refresh(explicitSession ? { explicit: true } : undefined);
    }
  };

  const detach = () => {
    eventController?.abort();
    eventController = null;
    beginMutationSession();
    suppressNextUpdate = false;
    explicitSessionPrefixLatex = null;
    clearEditAnchor();
    if (!mathfield) {
      return;
    }
    mathfield = null;
    updateCandidates(null);
  };

  const setComposing = (value: boolean) => {
    composing = value;
    if (composing) {
      beginMutationSession();
      suppressNextUpdate = false;
      explicitSessionPrefixLatex = null;
      clearEditAnchor();
      updateCandidates(null);
    } else if (autoSuggest || explicitSession) {
      refresh(explicitSession ? { explicit: true } : undefined);
    }
  };

  return {
    attach,
    detach,
    handleKeydown,
    setComposing,
    close,
    openExplicitSuggestions,
    updateConfig,
    getWordCandidates,
    openCustomCandidates,
  };
};
