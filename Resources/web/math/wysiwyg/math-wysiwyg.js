import { getMathFieldSelectionRange } from "../../app/blocks/math-input-utils.js";
import { buildOperatorCandidates, buildWordCandidates } from "./math-wysiwyg-candidates.js";
import { getKeyByLatex, normalizeLatexKey } from "./math-wysiwyg-keymap.js";
import { getInternalSelectionRanges, indexToOffsetInRange, offsetToIndexInRange, resolveScopeRange, setSelectionRange, } from "./math-wysiwyg-selection.js";
import { findContainingEnvironmentAtCursor, hasEnvironmentInContext, isCursorInsideEnvironmentBody, readNativeMathfieldEnvironmentContext, } from "./math-wysiwyg-environment-context.js";
import { SLASH_COMMAND_CANDIDATE_LIMIT, SLASH_COMMAND_HINT_SET, applySlashCommandHint, buildSlashCommandFallbackCandidates, dedupeCandidatesByLatex, normalizeSlashCommandToken, } from "./math-wysiwyg-slash-commands.js";
import { AUTO_REPLACE_OPERATORS, findAutoReplaceCorrection, findOperatorToken, findSlashCommandToken, findWordToken, isCommandToken, } from "./math-wysiwyg-token-matching.js";
import { getMathfieldInternalModel, getMathfieldModeAtOffset, isMathfieldSelectionPlaceholder, setMathfieldMode, } from "../mathfield-private-adapter.js";
const toLiteralInsertKey = (key) => {
    var _a;
    return ({
        label: (_a = key.label) !== null && _a !== void 0 ? _a : key.latex,
        latex: key.latex,
        fallback: key.fallback,
        displayLatex: key.displayLatex,
        hint: key.hint,
    });
};
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
const AUX_COMMAND_TEMPLATE_RE = /^\\(?:label|tag\*?|eqref|ref|pageref|autoref|intertext|shortintertext)\{#\?\}$/;
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
export const initMathWysiwyg = (deps) => {
    var _a, _b;
    let autoSuggest = (_a = deps.autoSuggest) !== null && _a !== void 0 ? _a : true;
    let enabledPacks = new Set((_b = deps.enabledPacks) !== null && _b !== void 0 ? _b : []);
    let mathfield = null;
    let eventController = null;
    let composing = false;
    let active = false;
    let explicitSession = false;
    let forcedTextMode = false;
    let holdTextModeUntil = 0;
    let selectedIndex = 0;
    let currentRange = null;
    let currentTokenMatch = null;
    let currentCandidates = [];
    let suppressNextUpdate = false;
    let lastInputTime = 0;
    let editAnchorOffset = null;
    let explicitSessionPrefixLatex = null;
    let mutationSessionId = 0;
    const resolveMruStorageKey = () => { var _a, _b, _c; return (_c = (_b = (_a = deps.getMruStorageKey) === null || _a === void 0 ? void 0 : _a.call(deps)) !== null && _b !== void 0 ? _b : deps.mruStorageKey) !== null && _c !== void 0 ? _c : DEFAULT_MRU_STORAGE_KEY; };
    let mruStorageKey = resolveMruStorageKey();
    const mru = new Map();
    let mruSaveTimer = null;
    let mruSaveKey = null;
    const panel = document.createElement("div");
    panel.className = "math-wysiwyg-panel";
    panel.setAttribute("role", "listbox");
    panel.setAttribute("aria-hidden", "true");
    let panelHost = null;
    const enqueueMicrotaskSafe = (task) => {
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
    const finalizeMutationSession = (sessionId, options) => {
        enqueueMicrotaskSafe(() => {
            var _a;
            if (sessionId !== mutationSessionId) {
                return;
            }
            suppressNextUpdate = false;
            if ((options === null || options === void 0 ? void 0 : options.clearCandidates) !== false) {
                resetCandidateState();
            }
            if (options === null || options === void 0 ? void 0 : options.reopenExplicitSession) {
                explicitSession = true;
                refresh({ explicit: true });
            }
            else if (autoSuggest) {
                refresh();
            }
            if (typeof ((_a = options === null || options === void 0 ? void 0 : options.focusTarget) === null || _a === void 0 ? void 0 : _a.focus) === "function") {
                options.focusTarget.focus();
            }
        });
    };
    const loadMru = (key) => {
        if (typeof localStorage === "undefined") {
            return;
        }
        try {
            const raw = localStorage.getItem(key);
            if (!raw) {
                return;
            }
            const parsed = JSON.parse(raw);
            Object.entries(parsed).forEach(([key, entry]) => {
                if (!entry || typeof entry !== "object")
                    return;
                const count = Number(entry.count);
                const lastUsedAt = Number(entry.lastUsedAt);
                if (!Number.isFinite(count) || !Number.isFinite(lastUsedAt))
                    return;
                const latex = typeof entry.latex === "string" ? entry.latex : undefined;
                const label = typeof entry.label === "string" ? entry.label : undefined;
                const hint = typeof entry.hint === "string" ? entry.hint : undefined;
                const displayLatex = typeof entry.displayLatex === "string" ? entry.displayLatex : undefined;
                mru.set(key, { count, lastUsedAt, latex, label, hint, displayLatex });
            });
        }
        catch {
            // ignore storage errors
        }
    };
    const saveMru = (key) => {
        if (typeof localStorage === "undefined") {
            return;
        }
        try {
            const payload = {};
            mru.forEach((entry, id) => {
                payload[id] = entry;
            });
            localStorage.setItem(key, JSON.stringify(payload));
        }
        catch {
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
            const keyToSave = mruSaveKey !== null && mruSaveKey !== void 0 ? mruSaveKey : mruStorageKey;
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
        const keyToSave = mruSaveKey !== null && mruSaveKey !== void 0 ? mruSaveKey : mruStorageKey;
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
    const recordMru = (candidate) => {
        var _a, _b;
        const candidateId = candidate.id;
        if (!candidateId) {
            return;
        }
        ensureMruStorageKey();
        const entry = (_a = mru.get(candidateId)) !== null && _a !== void 0 ? _a : { count: 0, lastUsedAt: 0 };
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
                const key = (_b = sorted[i]) === null || _b === void 0 ? void 0 : _b[0];
                if (key) {
                    mru.delete(key);
                }
            }
        }
        scheduleMruSave();
    };
    const applyMruRanking = (items) => {
        ensureMruStorageKey();
        if (mru.size === 0 || items.length <= 1) {
            return items;
        }
        const ranked = items.map((item, index) => {
            var _a, _b;
            const entry = mru.get(item.id);
            return {
                item,
                index,
                count: (_a = entry === null || entry === void 0 ? void 0 : entry.count) !== null && _a !== void 0 ? _a : 0,
                lastUsedAt: (_b = entry === null || entry === void 0 ? void 0 : entry.lastUsedAt) !== null && _b !== void 0 ? _b : 0,
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
            .filter((item) => !!item.entry &&
            typeof item.entry.latex === "string" &&
            typeof item.entry.label === "string" &&
            typeof item.entry.hint === "string")
            .sort((a, b) => {
            var _a, _b, _c, _d;
            const timeDiff = ((_a = b.entry.lastUsedAt) !== null && _a !== void 0 ? _a : 0) - ((_b = a.entry.lastUsedAt) !== null && _b !== void 0 ? _b : 0);
            if (timeDiff !== 0)
                return timeDiff;
            return ((_c = b.entry.count) !== null && _c !== void 0 ? _c : 0) - ((_d = a.entry.count) !== null && _d !== void 0 ? _d : 0);
        })
            .slice(0, Math.max(0, limit));
        return entries.map(({ id, entry }, index) => {
            var _a, _b, _c, _d;
            const latex = (_a = entry.latex) !== null && _a !== void 0 ? _a : "";
            const label = (_b = entry.label) !== null && _b !== void 0 ? _b : latex;
            const hint = (_c = entry.hint) !== null && _c !== void 0 ? _c : label;
            const displayLatex = (_d = entry.displayLatex) !== null && _d !== void 0 ? _d : latex;
            return {
                id,
                key: getKeyByLatex(latex, label, displayLatex),
                label,
                hint,
                displayLatex,
                priority: 240 - index,
            };
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
        const results = [];
        const seen = new Set();
        tokens.forEach((token) => {
            const candidates = buildWordCandidates(token, {
                allowContains: false,
                allowContainsMinLength: 99,
                allowedPacks: undefined,
            });
            const takeCount = token === "int" || token === "sum" ? 2 : 1;
            candidates.slice(0, takeCount).forEach((candidate) => {
                if (seen.has(candidate.id))
                    return;
                seen.add(candidate.id);
                results.push(candidate);
            });
        });
        return results;
    };
    const readMathfieldLatex = (mathfieldApi, ...args) => {
        if (typeof (mathfieldApi === null || mathfieldApi === void 0 ? void 0 : mathfieldApi.getValue) !== "function") {
            return null;
        }
        try {
            const value = mathfieldApi.getValue(...args);
            return typeof value === "string" ? value : null;
        }
        catch {
            return null;
        }
    };
    const findScopedSlashCommandMatch = (mathfieldApi, cursorOffset) => {
        var _a;
        const beforeCursor = readMathfieldLatex(mathfieldApi, 0, cursorOffset, "latex");
        if (typeof beforeCursor !== "string") {
            return null;
        }
        const match = /\/\/([A-Za-z*]*)$/.exec(beforeCursor);
        if (!match) {
            return null;
        }
        const token = (_a = match[1]) !== null && _a !== void 0 ? _a : "";
        const endIndex = beforeCursor.length;
        const startIndex = endIndex - token.length - 2;
        if (startIndex < 0) {
            return null;
        }
        const startOffset = indexToOffsetInRange(mathfieldApi, 0, cursorOffset, startIndex, "floor");
        if (!Number.isFinite(startOffset) || startOffset < 0) {
            return null;
        }
        return {
            token,
            range: { start: startOffset, end: cursorOffset },
            kind: "slash-command",
        };
    };
    const findLiteralPlaceholderRange = (mathfieldApi, anchorOffset) => {
        var _a;
        const lastOffset = typeof (mathfieldApi === null || mathfieldApi === void 0 ? void 0 : mathfieldApi.lastOffset) === "number" && mathfieldApi.lastOffset > 0
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
        const matches = [];
        let match = regex.exec(latex);
        while (match) {
            const startIndex = match.index;
            const endIndex = startIndex + match[0].length;
            matches.push({ startIndex, endIndex });
            match = regex.exec(latex);
        }
        if (matches.length === 0) {
            return null;
        }
        const preferred = (_a = matches.find((item) => item.startIndex >= anchorIndex)) !== null && _a !== void 0 ? _a : matches[0];
        const start = indexToOffsetInRange(mathfieldApi, 0, lastOffset, preferred.startIndex, "floor");
        const end = indexToOffsetInRange(mathfieldApi, 0, lastOffset, preferred.endIndex, "ceil");
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
            return null;
        }
        return { start, end };
    };
    const buildMatrixOpCandidates = () => {
        if (!mathfield) {
            return [];
        }
        const mf = mathfield;
        const selection = getMathFieldSelectionRange(mf);
        const cursorOffset = resolveCursorOffset(mf, selection);
        const nativeContext = readNativeMathfieldEnvironmentContext(mf, cursorOffset);
        const inMatrixByContext = hasEnvironmentInContext(nativeContext, MATRIX_LIKE_ENV_NAMES);
        const latex = inMatrixByContext ? null : readMathfieldLatex(mf, "latex");
        const cursorIndex = !inMatrixByContext && latex
            ? offsetToIndexInRange(mf, 0, cursorOffset)
            : -1;
        const inMatrix = inMatrixByContext ||
            (!!latex &&
                cursorIndex >= 0 &&
                isCursorInsideEnvironmentBody(latex, cursorIndex, MATRIX_LIKE_ENV_NAMES));
        if (!inMatrix || typeof mf.executeCommand !== "function") {
            return [];
        }
        const applyCommand = (command) => (target) => {
            var _a;
            if (typeof target.executeCommand !== "function") {
                return;
            }
            try {
                const ok = Boolean(target.executeCommand(command));
                if (ok) {
                    (_a = target.dispatchEvent) === null || _a === void 0 ? void 0 : _a.call(target, new Event("input", { bubbles: true }));
                }
            }
            catch {
                // ignore
            }
        };
        const makeOp = (id, label, hint, displayLatex, command, priority) => ({
            id,
            key: getKeyByLatex(label, label, displayLatex),
            label,
            hint,
            displayLatex,
            priority,
            apply: applyCommand(command),
        });
        return [
            makeOp("matrix-op:add-row", "+row", "行を追加", "\\begin{matrix}a\\\\b\\end{matrix}", "addRowAfter", 260),
            makeOp("matrix-op:add-col", "+col", "列を追加", "\\begin{matrix}a&b\\end{matrix}", "addColumnAfter", 258),
            makeOp("matrix-op:remove-row", "-row", "行を削除", "\\begin{matrix}a\\\\b\\end{matrix}", "removeRow", 256),
            makeOp("matrix-op:remove-col", "-col", "列を削除", "\\begin{matrix}a&b\\end{matrix}", "removeColumn", 254),
        ];
    };
    const isCursorInBlockedAuxEnvironment = (mathfieldApi, cursorOffset) => {
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
    const insertAuxCommandOutsideBlockedContext = (mathfieldApi, insertedLatex, cursorOffset) => {
        var _a;
        const sourceLatex = readMathfieldLatex(mathfieldApi, "latex");
        if (typeof sourceLatex !== "string") {
            return false;
        }
        const normalized = normalizeLatexKey(insertedLatex).replace(/#\?/g, "");
        if (!normalized.startsWith("\\")) {
            return false;
        }
        let insertionIndex = sourceLatex.length;
        const cursorIndex = typeof cursorOffset === "number" && Number.isFinite(cursorOffset)
            ? offsetToIndexInRange(mathfieldApi, 0, cursorOffset)
            : -1;
        if (cursorIndex >= 0) {
            const blockedEnv = findContainingEnvironmentAtCursor(sourceLatex, cursorIndex, AUX_COMMAND_BLOCKED_ENV_NAMES);
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
        const sourceLastOffset = typeof mathfieldApi.lastOffset === "number" && mathfieldApi.lastOffset > 0
            ? mathfieldApi.lastOffset
            : sourceLatex.length;
        const insertionOffset = indexToOffsetInRange(mathfieldApi, 0, sourceLastOffset, insertionIndex, "floor");
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
                const changed = typeof beforeValue === "string" &&
                    typeof afterValue === "string" &&
                    afterValue !== beforeValue;
                inserted = ok !== false || changed;
            }
            catch {
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
            }
            catch {
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
                const lastOffset = typeof mathfieldApi.lastOffset === "number" && mathfieldApi.lastOffset > 0
                    ? mathfieldApi.lastOffset
                    : nextLatex.length;
                const startOffset = indexToOffsetInRange(mathfieldApi, 0, lastOffset, selectionStartIndex, "floor");
                const endOffset = indexToOffsetInRange(mathfieldApi, 0, lastOffset, selectionEndIndex, "ceil");
                if (Number.isFinite(startOffset) &&
                    Number.isFinite(endOffset) &&
                    startOffset >= 0 &&
                    endOffset >= startOffset) {
                    setSelectionRange(mathfieldApi, startOffset, endOffset);
                }
            }
        }
        if (/^\\(?:shortintertext|intertext)\{/.test(normalized)) {
            try {
                setMathfieldMode(mathfieldApi, "text");
                forcedTextMode = true;
                holdTextModeUntil = nowMs() + 200;
            }
            catch {
                // ignore mode switch failures
            }
        }
        try {
            (_a = mathfieldApi.dispatchEvent) === null || _a === void 0 ? void 0 : _a.call(mathfieldApi, new Event("input", { bubbles: true }));
        }
        catch {
            // ignore dispatch failures
        }
        return true;
    };
    const buildExplicitFallbackCandidates = () => {
        const matrixOps = buildMatrixOpCandidates();
        const recent = buildRecentCandidates(matrixOps.length > 0 ? 6 : 8);
        const quick = buildQuickCandidates();
        const seen = new Set();
        const results = [];
        const pushAll = (items) => {
            items.forEach((item) => {
                if (seen.has(item.id))
                    return;
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
        var _a, _b;
        if (panelHost && panelHost.isConnected) {
            return panelHost;
        }
        if (!deps.container) {
            return null;
        }
        const host = (_b = (_a = deps.container.closest(".panel-body.blocks-panel")) !== null && _a !== void 0 ? _a : deps.container.closest(".panel-body")) !== null && _b !== void 0 ? _b : deps.container;
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
            const wouldOverflowBottom = panelRect.bottom > hostRect.bottom - margin && panelRect.height < hostRect.height;
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
    const setPanelVisible = (visible) => {
        var _a;
        active = visible;
        if (!visible) {
            explicitSession = false;
            explicitSessionPrefixLatex = null;
        }
        panel.setAttribute("aria-hidden", visible ? "false" : "true");
        (_a = deps.container) === null || _a === void 0 ? void 0 : _a.classList.toggle("has-wysiwyg-suggestions", visible);
        if (!visible) {
            panel.textContent = "";
            panel.style.removeProperty("left");
            panel.style.removeProperty("top");
            panel.style.removeProperty("right");
            panel.style.removeProperty("bottom");
            panel.style.removeProperty("max-width");
        }
    };
    const renderCandidate = (candidate, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "math-wysiwyg-item";
        button.setAttribute("role", "option");
        const isActive = index === selectedIndex;
        button.classList.toggle("is-active", isActive);
        button.setAttribute("aria-selected", isActive ? "true" : "false");
        const symbol = document.createElement("span");
        symbol.className = "math-wysiwyg-symbol";
        const MathLiveGlobal = window.MathLive;
        if (candidate.displayLatex && (MathLiveGlobal === null || MathLiveGlobal === void 0 ? void 0 : MathLiveGlobal.convertLatexToMarkup)) {
            try {
                const latexToRender = `\\displaystyle ${candidate.displayLatex}`;
                symbol.innerHTML = MathLiveGlobal.convertLatexToMarkup(latexToRender);
            }
            catch {
                symbol.textContent = candidate.label;
            }
        }
        else {
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
        const activeItem = panel.querySelector(".math-wysiwyg-item.is-active");
        if (!activeItem) {
            return;
        }
        try {
            activeItem.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
        catch {
            // ignore
        }
    };
    const updateCandidates = (tokenMatch, options = {}) => {
        var _a;
        const explicit = (_a = options.explicit) !== null && _a !== void 0 ? _a : false;
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
        if (tokenMatch.kind === "word" ||
            tokenMatch.kind === "command" ||
            tokenMatch.kind === "slash-command") {
            const normalized = tokenMatch.token.toLowerCase();
            const minLength = tokenMatch.kind === "slash-command"
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
        let nextCandidates = [];
        if (tokenMatch.kind === "operator") {
            nextCandidates = buildOperatorCandidates(tokenMatch.token);
        }
        else if (tokenMatch.kind === "slash-command") {
            const slashToken = normalizeSlashCommandToken(tokenMatch.token);
            if (!slashToken) {
                nextCandidates = buildSlashCommandFallbackCandidates();
            }
            else {
                const rawCandidates = buildWordCandidates(slashToken, {
                    allowContainsMinLength: explicit ? 1 : AUTO_CONTAINS_MIN_LENGTH,
                    allowedPacks,
                    dedupeByLatex: !explicit,
                });
                const preferred = rawCandidates.filter((candidate) => SLASH_COMMAND_HINT_SET.has(candidate.hint.toLowerCase()));
                const exact = rawCandidates.filter((candidate) => normalizeSlashCommandToken(candidate.hint) === slashToken);
                const merged = preferred.length > 0
                    ? [...exact, ...preferred, ...rawCandidates]
                    : [...exact, ...rawCandidates];
                nextCandidates = dedupeCandidatesByLatex(merged)
                    .slice(0, SLASH_COMMAND_CANDIDATE_LIMIT)
                    .map(applySlashCommandHint);
            }
        }
        else {
            nextCandidates = buildWordCandidates(tokenMatch.token, {
                allowContainsMinLength: explicit ? 2 : AUTO_CONTAINS_MIN_LENGTH,
                allowedPacks,
                dedupeByLatex: !explicit,
            });
        }
        const allowSuffixRescue = explicit &&
            tokenMatch.kind === "word" &&
            tokenMatch.token.length >= EXPLICIT_SUFFIX_MIN_LENGTH;
        if (allowSuffixRescue && nextCandidates.length === 0) {
            const minSuffixLength = 2;
            for (let dropPrefix = 1; dropPrefix <= tokenMatch.token.length - minSuffixLength; dropPrefix += 1) {
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
        const sameList = currentCandidates.length === nextCandidates.length &&
            currentCandidates.every((item, idx) => item.id === nextCandidates[idx].id);
        currentCandidates = nextCandidates;
        currentRange = effectiveMatch.range;
        currentTokenMatch = effectiveMatch;
        if (!sameList) {
            selectedIndex = 0;
        }
        else {
            selectedIndex = Math.max(0, Math.min(selectedIndex, currentCandidates.length - 1));
        }
        ensurePanel();
        setPanelVisible(true);
        renderPanel();
    };
    const getWordCandidates = (token) => {
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
    const openCustomCandidates = (candidates, options) => {
        var _a;
        if (!candidates || candidates.length === 0) {
            return;
        }
        const mapped = candidates.map((candidate, index) => ({
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
        selectedIndex = Math.max(0, Math.min((_a = options === null || options === void 0 ? void 0 : options.selectedIndex) !== null && _a !== void 0 ? _a : 0, currentCandidates.length - 1));
        ensurePanel();
        setPanelVisible(true);
        renderPanel();
    };
    const getModeAtOffset = (mathfieldApi, offset) => {
        var _a;
        if (offset < 0) {
            return null;
        }
        if (typeof (mathfieldApi === null || mathfieldApi === void 0 ? void 0 : mathfieldApi.getElementInfo) === "function") {
            try {
                const info = mathfieldApi.getElementInfo(offset);
                const mode = (_a = info === null || info === void 0 ? void 0 : info.mode) !== null && _a !== void 0 ? _a : null;
                if (mode === "math" || mode === "text" || mode === "latex") {
                    return mode;
                }
            }
            catch {
                // ignore
            }
        }
        return getMathfieldModeAtOffset(mathfieldApi, offset);
    };
    const nowMs = () => typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    const clearEditAnchor = () => {
        editAnchorOffset = null;
    };
    const resolveAnalysisRange = (mathfieldApi, cursorOffset) => {
        var _a;
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
            const lookbehind = (_a = readMathfieldLatex(mathfieldApi, lookbehindStart, anchor, "latex")) !== null && _a !== void 0 ? _a : "";
            if (lookbehind.endsWith("//")) {
                start = Math.max(scopeRange.start, anchor - 2);
            }
            else if (lookbehind.endsWith("\\")) {
                start = Math.max(scopeRange.start, anchor - 1);
            }
        }
        return { start, end: scopeRange.end };
    };
    const resolveCursorOffset = (mathfieldApi, selection) => {
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
        const position = Number(mathfieldApi === null || mathfieldApi === void 0 ? void 0 : mathfieldApi.position);
        if (Number.isFinite(position)) {
            return Math.max(0, position);
        }
        return 0;
    };
    const syncMathfieldMode = (mathfieldApi, cursorOffset) => {
        var _a;
        const currentMode = typeof (mathfieldApi === null || mathfieldApi === void 0 ? void 0 : mathfieldApi.mode) === "string"
            ? mathfieldApi.mode
            : null;
        if (!currentMode || currentMode === "latex") {
            forcedTextMode = false;
            return;
        }
        // If the user changed modes manually while we were forcing, stop managing it.
        if (forcedTextMode && currentMode !== "text") {
            forcedTextMode = false;
        }
        const modeAtCursor = (_a = getModeAtOffset(mathfieldApi, cursorOffset)) !== null && _a !== void 0 ? _a : getModeAtOffset(mathfieldApi, cursorOffset - 1);
        const wantsText = modeAtCursor === "text";
        const setMode = (nextMode) => setMathfieldMode(mathfieldApi, nextMode);
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
    const isInSuppressedTextContext = (mathfieldApi, cursorOffset) => {
        var _a, _b, _c, _d, _e, _f;
        const mode = typeof (mathfieldApi === null || mathfieldApi === void 0 ? void 0 : mathfieldApi.mode) === "string"
            ? mathfieldApi.mode
            : null;
        if (mode === "text") {
            return true;
        }
        const modeAtCursor = (_a = getModeAtOffset(mathfieldApi, cursorOffset)) !== null && _a !== void 0 ? _a : getModeAtOffset(mathfieldApi, cursorOffset - 1);
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
        const stack = [];
        const isLetter = (ch) => /[A-Za-z]/.test(ch);
        const isEscapedAtLiteral = (text, index) => {
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
                if (isLetter((_b = latex[j]) !== null && _b !== void 0 ? _b : "")) {
                    const start = j;
                    while (j < cursorIndex && isLetter((_c = latex[j]) !== null && _c !== void 0 ? _c : "")) {
                        j += 1;
                    }
                    command = latex.slice(start, j);
                }
                else {
                    command = (_d = latex[j]) !== null && _d !== void 0 ? _d : "";
                    j += 1;
                }
                if (command === "lbrace") {
                    depth += 1;
                    i = Math.max(i, j - 1);
                    continue;
                }
                if (command === "rbrace") {
                    depth = Math.max(0, depth - 1);
                    while (stack.length > 0 && ((_e = stack[stack.length - 1]) !== null && _e !== void 0 ? _e : 0) > depth) {
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
                if (k < cursorIndex &&
                    latex[k] === "*" &&
                    textLikeCommands.has(`${command}*`)) {
                    normalizedCommand = `${command}*`;
                    k += 1;
                    while (k < cursorIndex && latex[k] === " ") {
                        k += 1;
                    }
                }
                if (textLikeCommands.has(normalizedCommand)) {
                    if (latex[k] === "{") {
                        stack.push(depth + 1);
                    }
                    else if (k < cursorIndex &&
                        latex.startsWith("\\lbrace", k) &&
                        !isEscapedAtLiteral(latex, k)) {
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
                while (stack.length > 0 && ((_f = stack[stack.length - 1]) !== null && _f !== void 0 ? _f : 0) > depth) {
                    stack.pop();
                }
            }
        }
        return stack.length > 0;
    };
    // Fallback guard for text-like wrappers when the mode/range APIs miss context transitions.
    const isInSuppressedTextLiteralContext = (rawValue, cursorIndex) => {
        if (!rawValue || cursorIndex <= 0) {
            return false;
        }
        const beforeCursor = rawValue.slice(0, Math.max(0, cursorIndex));
        const normalizedBeforeCursor = beforeCursor
            .replace(/\\lbrace/g, "{")
            .replace(/\\rbrace/g, "}");
        const textLikeRe = /\\(?:text|operatorname\*?|mathrm|mathbf|mathit|mathsf|mathtt|mathcal|mathfrak|mathscr|mathbb|mathds|bm|textrm|textsf|texttt|textit|textbf|mbox)\s*\{[^{}]*$/;
        const textLikeClosedAtCursorRe = /\\(?:text|operatorname\*?|mathrm|mathbf|mathit|mathsf|mathtt|mathcal|mathfrak|mathscr|mathbb|mathds|bm|textrm|textsf|texttt|textit|textbf|mbox)\s*\{[^{}]*\}$/;
        return (textLikeRe.test(normalizedBeforeCursor) ||
            textLikeClosedAtCursorRe.test(normalizedBeforeCursor));
    };
    const refresh = (options = {}) => {
        var _a;
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
            const mathfieldApi = mathfield;
            if (typeof mathfieldApi.getValue !== "function") {
                updateCandidates(null, options);
                return;
            }
            const selection = getMathFieldSelectionRange(mathfieldApi);
            const selectionRanges = selection.start !== selection.end ? getInternalSelectionRanges(mathfieldApi) : [];
            const cursorOffset = resolveCursorOffset(mathfieldApi, selection);
            if (!options.explicit && editAnchorOffset === null) {
                // IME-like behavior: only analyze tokens while an active edit session exists.
                updateCandidates(null, options);
                return;
            }
            const mode = typeof mathfieldApi.mode === "string"
                ? mathfieldApi.mode
                : null;
            if (mode === "text" && !options.explicit) {
                // Avoid noisy suggestions while typing inside \\text{...} and similar text-mode segments.
                updateCandidates(null, options);
                return;
            }
            const isPlaceholderSelection = selection.start !== selection.end &&
                selectionRanges.some((range) => cursorOffset >= range.start && cursorOffset <= range.end);
            if (selection.start !== selection.end && !isPlaceholderSelection) {
                const selectionLength = Math.abs(selection.end - selection.start);
                const now = typeof performance !== "undefined" && typeof performance.now === "function"
                    ? performance.now()
                    : Date.now();
                if (selectionLength > 1 && now - lastInputTime > 120) {
                    updateCandidates(null, options);
                    return;
                }
            }
            const analysisRange = resolveAnalysisRange(mathfieldApi, cursorOffset);
            const rawValue = readMathfieldLatex(mathfieldApi, analysisRange.start, analysisRange.end, "latex");
            if (typeof rawValue !== "string") {
                updateCandidates(null, options);
                return;
            }
            const cursorIndex = offsetToIndexInRange(mathfieldApi, analysisRange.start, cursorOffset);
            const fullRawValue = readMathfieldLatex(mathfieldApi, "latex");
            const globalCursorIndex = offsetToIndexInRange(mathfieldApi, 0, cursorOffset);
            const inSuppressedTextContext = isInSuppressedTextContext(mathfieldApi, cursorOffset) ||
                isInSuppressedTextLiteralContext(rawValue, cursorIndex) ||
                isInSuppressedTextLiteralContext(fullRawValue, globalCursorIndex);
            if (inSuppressedTextContext) {
                updateCandidates(null, options);
                return;
            }
            const toOffsetMatch = (match) => {
                if (!match) {
                    return null;
                }
                const startOffset = indexToOffsetInRange(mathfieldApi, analysisRange.start, analysisRange.end, match.range.start, "floor");
                const endOffset = indexToOffsetInRange(mathfieldApi, analysisRange.start, analysisRange.end, match.range.end, "ceil");
                return { token: match.token, range: { start: startOffset, end: endOffset }, kind: match.kind };
            };
            const operatorCorrectionMatch = toOffsetMatch(findAutoReplaceCorrection(rawValue, cursorIndex));
            if (operatorCorrectionMatch &&
                !options.explicit &&
                autoSuggest &&
                AUTO_REPLACE_OPERATORS.has(operatorCorrectionMatch.token)) {
                const candidates = buildOperatorCandidates(operatorCorrectionMatch.token);
                const candidate = candidates[0];
                if (candidate) {
                    const mutationId = beginMutationSession();
                    suppressNextUpdate = true;
                    setPanelVisible(false);
                    setSelectionRange(mathfieldApi, operatorCorrectionMatch.range.start, operatorCorrectionMatch.range.end);
                    deps.insertKey(candidate.key);
                    finalizeMutationSession(mutationId);
                    return;
                }
            }
            const slashCommandMatch = (_a = findScopedSlashCommandMatch(mathfieldApi, cursorOffset)) !== null && _a !== void 0 ? _a : toOffsetMatch(findSlashCommandToken(rawValue, cursorIndex));
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
                }
                else {
                    updateCandidates(null, options);
                }
                return;
            }
            const wordMatch = toOffsetMatch(findWordToken(rawValue, cursorIndex));
            if (!options.explicit && wordMatch) {
                const normalized = wordMatch.token.toLowerCase();
                const minLength = wordMatch.kind === "command"
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
        }
        catch {
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
        const mathfieldApi = mathfield;
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
                    const anchorOffset = indexToOffsetInRange(mathfieldApi, 0, cursorOffset, startIndex, "floor");
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
    const updateConfig = (config) => {
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
    const applyCandidate = (index) => {
        var _a, _b, _c;
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
        const mathfieldApi = mathfield;
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
        const settleMutation = (sessionId, options) => {
            finalizeMutationSession(sessionId, {
                focusTarget: (options === null || options === void 0 ? void 0 : options.focus) ? mathfieldApi : null,
                reopenExplicitSession: shouldKeepExplicitSession,
                clearCandidates: options === null || options === void 0 ? void 0 : options.clearCandidates,
            });
        };
        const clearTriggerRange = () => {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
            if (typeof mathfieldApi.executeCommand !== "function") {
                return;
            }
            const deleteBackwardChars = (count) => {
                if (!Number.isFinite(count) || count <= 0) {
                    return false;
                }
                for (let i = 0; i < count; i += 1) {
                    try {
                        mathfieldApi.executeCommand("deleteBackward");
                    }
                    catch {
                        return i > 0;
                    }
                }
                return true;
            };
            const tokenSuffixFromMatch = (match) => {
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
            const clearSuffixFromBuffer = (source, suffix) => {
                if (!source || !suffix || !source.endsWith(suffix)) {
                    return false;
                }
                return deleteBackwardChars(suffix.length);
            };
            const beforeCursor = (_a = readMathfieldLatex(mathfieldApi, 0, cursorOffset, "latex")) !== null && _a !== void 0 ? _a : "";
            const expectedSuffix = tokenSuffixFromMatch(currentTokenMatch);
            if (clearSuffixFromBuffer(beforeCursor, expectedSuffix)) {
                return;
            }
            if (wasExplicitSession) {
                let explicitBuffer = beforeCursor;
                if (explicitSessionPrefix && beforeCursor.startsWith(explicitSessionPrefix)) {
                    explicitBuffer = beforeCursor.slice(explicitSessionPrefix.length);
                }
                else if (explicitSessionPrefix) {
                    const relaxedPrefix = explicitSessionPrefix.replace(/\s+$/, "");
                    if (relaxedPrefix && beforeCursor.startsWith(relaxedPrefix)) {
                        explicitBuffer = beforeCursor.slice(relaxedPrefix.length);
                    }
                }
                const trailingToken = (_g = (_e = (_c = (_b = /(\\?[A-Za-z*]+)$/.exec(explicitBuffer)) === null || _b === void 0 ? void 0 : _b[1]) !== null && _c !== void 0 ? _c : (_d = /(\/\/[A-Za-z*]*)$/.exec(explicitBuffer)) === null || _d === void 0 ? void 0 : _d[1]) !== null && _e !== void 0 ? _e : (_f = /([+\-*/=<>:;,!?.]+)$/.exec(explicitBuffer)) === null || _f === void 0 ? void 0 : _f[1]) !== null && _g !== void 0 ? _g : "";
                if (trailingToken && deleteBackwardChars(trailingToken.length)) {
                    return;
                }
            }
            if (!currentRange) {
                return;
            }
            const rangeContainsCursor = cursorOffset >= currentRange.start && cursorOffset <= currentRange.end + 1;
            const rangeText = (_h = readMathfieldLatex(mathfieldApi, currentRange.start, currentRange.end, "latex")) !== null && _h !== void 0 ? _h : "";
            if (rangeContainsCursor && clearSuffixFromBuffer(beforeCursor, rangeText)) {
                return;
            }
            // Last-resort local clear. Never issue a blind range delete, which can erase
            // surrounding structure when range mapping drifts in placeholder-heavy trees.
            const fallbackToken = (_p = (_m = (_k = (_j = /(\\?[A-Za-z*]+)$/.exec(beforeCursor)) === null || _j === void 0 ? void 0 : _j[1]) !== null && _k !== void 0 ? _k : (_l = /(\/\/[A-Za-z*]*)$/.exec(beforeCursor)) === null || _l === void 0 ? void 0 : _l[1]) !== null && _m !== void 0 ? _m : (_o = /([+\-*/=<>:;,!?.]+)$/.exec(beforeCursor)) === null || _o === void 0 ? void 0 : _o[1]) !== null && _p !== void 0 ? _p : "";
            if (fallbackToken) {
                deleteBackwardChars(fallbackToken.length);
            }
        };
        const insertedLatex = typeof candidate.key.latex === "string" ? normalizeLatexKey(candidate.key.latex) : "";
        const isAuxCommandCandidate = AUX_COMMAND_TEMPLATE_RE.test(insertedLatex) ||
            AUX_COMMAND_BARE_RE.test(insertedLatex) ||
            INTERTEXT_TEMPLATE_RE.test(insertedLatex);
        const shouldHoistAuxCommand = isAuxCommandCandidate && isCursorInBlockedAuxEnvironment(mathfieldApi, cursorOffset);
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
            deps.insertKey(toLiteralInsertKey(getKeyByLatex(commandLatex, commandLatex, commandLatex)));
            const currentSelection = getMathFieldSelectionRange(mathfieldApi);
            const cursorAtInsert = resolveCursorOffset(mathfieldApi, currentSelection);
            const targetOffset = Math.max(0, cursorAtInsert - 1);
            setSelectionRange(mathfieldApi, targetOffset, targetOffset);
            try {
                setMathfieldMode(mathfieldApi, "text");
                forcedTextMode = true;
                holdTextModeUntil = nowMs() + 200;
            }
            catch {
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
                }
                catch {
                    // ignore
                }
                forcedTextMode = true;
                holdTextModeUntil = nowMs() + 200;
            }
            catch {
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
        if (shouldHoistAuxCommand &&
            insertAuxCommandOutsideBlockedContext(mathfieldApi, insertedLatex, cursorOffset)) {
            settleMutation(mutationId, { focus: true });
            return;
        }
        const insertionKey = toLiteralInsertKey(candidate.key);
        deps.insertKey(insertionKey);
        const hasPlaceholderTemplate = typeof insertionKey.latex === "string" && insertionKey.latex.includes("#?");
        if (hasPlaceholderTemplate) {
            const inserted = normalizeLatexKey(insertionKey.latex);
            const isAuxCommandTemplate = AUX_COMMAND_TEMPLATE_RE.test(inserted);
            try {
                if (isAuxCommandTemplate) {
                    const ranges = getInternalSelectionRanges(mathfieldApi);
                    const literalTarget = (_a = findLiteralPlaceholderRange(mathfieldApi, insertionAnchorStart)) !== null && _a !== void 0 ? _a : findLiteralPlaceholderRange(mathfieldApi, 0);
                    const lastRange = ranges.length > 0 ? ranges[ranges.length - 1] : null;
                    const target = literalTarget !== null && literalTarget !== void 0 ? literalTarget : lastRange;
                    if (target) {
                        setSelectionRange(mathfieldApi, target.start, target.end);
                        const shouldForceText = inserted.startsWith("\\text{") || inserted.startsWith("\\operatorname{");
                        if (shouldForceText) {
                            try {
                                setMathfieldMode(mathfieldApi, "text");
                                forcedTextMode = true;
                                holdTextModeUntil = nowMs() + 200;
                            }
                            catch {
                                // ignore mode switch failures
                            }
                        }
                        else {
                            syncMathfieldMode(mathfieldApi, target.end);
                        }
                    }
                }
                else {
                    // For normal templates, trust MathLive's insertion selection first.
                    // Force-selection by literal range can break matrix/cell contexts.
                    const insertedSelection = getMathFieldSelectionRange(mathfieldApi);
                    if (insertedSelection.start !== insertedSelection.end) {
                        syncMathfieldMode(mathfieldApi, insertedSelection.end);
                    }
                    else {
                        const ranges = getInternalSelectionRanges(mathfieldApi);
                        const target = (_c = (_b = ranges.find((range) => range.start >= insertionAnchorStart)) !== null && _b !== void 0 ? _b : ranges[0]) !== null && _c !== void 0 ? _c : null;
                        if (target) {
                            setSelectionRange(mathfieldApi, target.start, target.end);
                            syncMathfieldMode(mathfieldApi, target.end);
                        }
                    }
                }
            }
            catch {
                // ignore placeholder positioning failures
            }
            const settledRange = getMathFieldSelectionRange(mathfieldApi);
            if (settledRange.start === settledRange.end &&
                typeof mathfieldApi.executeCommand === "function") {
                try {
                    const moved = Boolean(mathfieldApi.executeCommand("moveToNextPlaceholder"));
                    if (moved) {
                        const movedRange = getMathFieldSelectionRange(mathfieldApi);
                        if (movedRange.start !== movedRange.end) {
                            setSelectionRange(mathfieldApi, movedRange.start, movedRange.end);
                            syncMathfieldMode(mathfieldApi, movedRange.end);
                        }
                    }
                }
                catch {
                    // ignore placeholder fallback move failures
                }
            }
        }
        else {
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
    const handleKeydown = (event) => {
        if (event.key === "Tab") {
            if (event.metaKey || event.ctrlKey || event.altKey) {
                return false;
            }
            event.preventDefault();
            if (active && currentCandidates.length > 0) {
                if (event.shiftKey) {
                    selectedIndex =
                        (selectedIndex - 1 + currentCandidates.length) % currentCandidates.length;
                }
                else {
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
            if (event.key !== "Shift" &&
                event.key !== "Control" &&
                event.key !== "Alt" &&
                event.key !== "Meta") {
                updateCandidates(null);
            }
        }
        return false;
    };
    const attach = (target) => {
        if (mathfield === target) {
            return;
        }
        detach();
        mathfield = target;
        eventController = new AbortController();
        const { signal } = eventController;
        const mathfieldApi = mathfield;
        mathfield.addEventListener("input", () => {
            lastInputTime =
                typeof performance !== "undefined" && typeof performance.now === "function"
                    ? performance.now()
                    : Date.now();
            if (autoSuggest || explicitSession) {
                refresh(explicitSession ? { explicit: true } : undefined);
            }
        }, { signal });
        const handleEditAnchorKeydown = (event) => {
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
            if (key === "Escape" ||
                key === "Enter" ||
                key === "Tab" ||
                key === "Home" ||
                key === "End" ||
                key === "PageUp" ||
                key === "PageDown" ||
                key.startsWith("Arrow")) {
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
            if (editAnchorOffset === null ||
                cursorOffset < editAnchorOffset ||
                nowMs() - lastInputTime > 600) {
                editAnchorOffset = cursorOffset;
            }
        };
        const handleModeKeydown = (event) => {
            var _a;
            if (event.isComposing) {
                return;
            }
            if (event.metaKey || event.ctrlKey || event.altKey) {
                return;
            }
            if (typeof (mathfieldApi === null || mathfieldApi === void 0 ? void 0 : mathfieldApi.mode) === "string" && mathfieldApi.mode === "latex") {
                return;
            }
            const key = event.key;
            const isPrintable = (typeof key === "string" && key.length === 1) || key === " " || key === "Spacebar";
            if (!isPrintable) {
                return;
            }
            const selection = getMathFieldSelectionRange(mathfieldApi);
            const cursorOffset = resolveCursorOffset(mathfieldApi, selection);
            const cursorMode = (_a = getModeAtOffset(mathfieldApi, cursorOffset)) !== null && _a !== void 0 ? _a : getModeAtOffset(mathfieldApi, cursorOffset - 1);
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
                }
                catch {
                    // ignore
                }
            }
            else if (forcedTextMode && cursorMode === "math") {
                if (nowMs() < holdTextModeUntil) {
                    try {
                        setMathfieldMode(mathfieldApi, "text");
                    }
                    catch {
                        // ignore
                    }
                    return;
                }
                try {
                    setMathfieldMode(mathfieldApi, "math");
                    forcedTextMode = false;
                }
                catch {
                    // ignore
                }
            }
        };
        mathfield.addEventListener("keydown", handleEditAnchorKeydown, { signal, capture: true });
        mathfield.addEventListener("keydown", handleModeKeydown, { signal, capture: true });
        const shadowRoot = mathfield.shadowRoot;
        if (shadowRoot) {
            shadowRoot.addEventListener("keydown", handleEditAnchorKeydown, { signal, capture: true });
            shadowRoot.addEventListener("keydown", handleModeKeydown, { signal, capture: true });
        }
        mathfield.addEventListener("keyup", (event) => {
            // When the panel is open, ArrowUp/ArrowDown are used for navigating candidates.
            // Don't refresh the candidate list on keyup in that case, or we'll close/replace it.
            if (active && event.key.startsWith("Arrow")) {
                return;
            }
            if (event.key.startsWith("Arrow") ||
                event.key === "Backspace" ||
                event.key === "Delete") {
                if (autoSuggest || explicitSession) {
                    refresh(explicitSession ? { explicit: true } : undefined);
                }
            }
        }, { signal });
        mathfield.addEventListener("focus", () => {
            if (autoSuggest || explicitSession) {
                refresh(explicitSession ? { explicit: true } : undefined);
            }
        }, { signal });
        mathfield.addEventListener("selection-change", () => {
            if (editAnchorOffset !== null && nowMs() - lastInputTime > 120) {
                const selection = getMathFieldSelectionRange(mathfieldApi);
                const cursorOffset = resolveCursorOffset(mathfieldApi, selection);
                const scopeRange = resolveScopeRange(mathfieldApi, cursorOffset);
                if (selection.start !== selection.end ||
                    cursorOffset < editAnchorOffset ||
                    editAnchorOffset < scopeRange.start ||
                    editAnchorOffset > scopeRange.end) {
                    clearEditAnchor();
                }
            }
            if (autoSuggest || explicitSession) {
                refresh(explicitSession ? { explicit: true } : undefined);
            }
        }, { signal });
        mathfield.addEventListener("blur", () => {
            clearEditAnchor();
            updateCandidates(null);
        }, { signal });
        if ((autoSuggest || explicitSession) && typeof mathfieldApi.getValue === "function") {
            refresh(explicitSession ? { explicit: true } : undefined);
        }
    };
    const detach = () => {
        eventController === null || eventController === void 0 ? void 0 : eventController.abort();
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
    const setComposing = (value) => {
        composing = value;
        if (composing) {
            beginMutationSession();
            suppressNextUpdate = false;
            explicitSessionPrefixLatex = null;
            clearEditAnchor();
            updateCandidates(null);
        }
        else if (autoSuggest || explicitSession) {
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
