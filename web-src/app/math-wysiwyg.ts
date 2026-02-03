import { getMathFieldSelectionRange } from "./blocks/math-input-utils.js";
import {
  buildOperatorCandidates,
  buildWordCandidates,
  OPERATOR_MAX_LENGTH,
  OPERATOR_MIN_LENGTH,
  OPERATOR_TRIGGERS,
} from "./math-wysiwyg-candidates.js";
import { getKeyByLatex } from "./math-wysiwyg-keymap.js";
import {
  getInternalSelectionRanges,
  indexToOffsetInRange,
  offsetToIndexInRange,
  resolveScopeRange,
  setSelectionRange,
} from "./math-wysiwyg-selection.js";
import type { Candidate } from "./math-wysiwyg-triggers.js";
import type { MathKey } from "./types.js";

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
};

type MathWysiwygConfig = {
  autoSuggest: boolean;
  enabledPacks: string[];
};

type TokenIndexMatch = {
  token: string;
  range: { start: number; end: number };
  kind: "word" | "operator";
};

type TokenMatch = {
  token: string;
  range: { start: number; end: number };
  kind: "word" | "operator";
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

const isWordToken = (value: string) => /^[A-Za-z]+$/.test(value);
const AUTO_WORD_MIN_LENGTH = 3;
const AUTO_CONTAINS_MIN_LENGTH = 4;
const EXPLICIT_WORD_MIN_LENGTH = 1;
const EXPLICIT_SUFFIX_MIN_LENGTH = 6;
const DEFAULT_MRU_STORAGE_KEY = "tex64.math-wysiwyg.mru";
const MAX_MRU_ENTRIES = 200;

type MruEntry = { count: number; lastUsedAt: number };

const findOperatorToken = (text: string, cursorIndex: number): TokenIndexMatch | null => {
  const maxLength = OPERATOR_MAX_LENGTH;
  const minLength = Math.max(1, OPERATOR_MIN_LENGTH);
  for (let length = maxLength; length >= minLength; length -= 1) {
    const start = cursorIndex - length;
    if (start < 0) {
      continue;
    }
    const token = text.slice(start, cursorIndex);
    if (token in OPERATOR_TRIGGERS) {
      return { token, range: { start, end: cursorIndex }, kind: "operator" };
    }
  }
  return null;
};

const findWordToken = (text: string, cursorIndex: number): TokenIndexMatch | null => {
  let start = cursorIndex;
  while (start > 0) {
    const char = text[start - 1];
    if (!/[A-Za-z]/.test(char)) {
      break;
    }
    start -= 1;
  }
  if (start === cursorIndex) {
    return null;
  }
  const token = text.slice(start, cursorIndex);
  if (!isWordToken(token)) {
    return null;
  }
  const prev = start > 0 ? text[start - 1] : "";
  if (prev === "\\") {
    return null;
  }
  return { token, range: { start, end: cursorIndex }, kind: "word" };
};

export const initMathWysiwyg = (deps: MathWysiwygDeps): MathWysiwygApi => {
  let autoSuggest = deps.autoSuggest ?? true;
  let enabledPacks = new Set(deps.enabledPacks ?? []);
  let mathfield: HTMLElement | null = null;
  let eventController: AbortController | null = null;
  let composing = false;
  let active = false;
  let explicitSession = false;
  let selectedIndex = 0;
  let currentRange: { start: number; end: number } | null = null;
  let currentCandidates: Candidate[] = [];
  let suppressNextUpdate = false;
  let lastInputTime = 0;
  const mruStorageKey = deps.mruStorageKey ?? DEFAULT_MRU_STORAGE_KEY;
  const mru = new Map<string, MruEntry>();
  let mruSaveTimer: number | null = null;

  const panel = document.createElement("div");
  panel.className = "math-wysiwyg-panel";
  panel.setAttribute("role", "listbox");
  panel.setAttribute("aria-hidden", "true");

  let panelHost: HTMLElement | null = null;

  const loadMru = () => {
    if (typeof localStorage === "undefined") {
      return;
    }
    try {
      const raw = localStorage.getItem(mruStorageKey);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as Record<string, MruEntry>;
      Object.entries(parsed).forEach(([key, entry]) => {
        if (!entry || typeof entry !== "object") return;
        const count = Number(entry.count);
        const lastUsedAt = Number(entry.lastUsedAt);
        if (!Number.isFinite(count) || !Number.isFinite(lastUsedAt)) return;
        mru.set(key, { count, lastUsedAt });
      });
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
    mruSaveTimer = window.setTimeout(() => {
      mruSaveTimer = null;
      try {
        const payload: Record<string, MruEntry> = {};
        mru.forEach((entry, key) => {
          payload[key] = entry;
        });
        localStorage.setItem(mruStorageKey, JSON.stringify(payload));
      } catch {
        // ignore storage errors
      }
    }, 150);
  };

  const recordMru = (candidateId: string) => {
    if (!candidateId) {
      return;
    }
    const entry = mru.get(candidateId) ?? { count: 0, lastUsedAt: 0 };
    entry.count += 1;
    entry.lastUsedAt = Date.now();
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

  loadMru();

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
    if (!tokenMatch) {
      currentCandidates = [];
      currentRange = null;
      selectedIndex = 0;
      setPanelVisible(false);
      return;
    }
    const explicit = options.explicit ?? false;
    const allowedPacks = enabledPacks.size > 0 ? enabledPacks : undefined;
    if (tokenMatch.kind === "word") {
      const minLength = explicit ? EXPLICIT_WORD_MIN_LENGTH : AUTO_WORD_MIN_LENGTH;
      if (tokenMatch.token.length < minLength) {
        currentCandidates = [];
        currentRange = null;
        selectedIndex = 0;
        setPanelVisible(false);
        return;
      }
    }

    let effectiveMatch = tokenMatch;
    let nextCandidates: Candidate[] =
      tokenMatch.kind === "operator"
        ? buildOperatorCandidates(tokenMatch.token)
        : buildWordCandidates(tokenMatch.token, {
            allowContainsMinLength: explicit ? 2 : AUTO_CONTAINS_MIN_LENGTH,
            allowedPacks,
          });

    const allowSuffixRescue =
      explicit && tokenMatch.kind === "word" && tokenMatch.token.length >= EXPLICIT_SUFFIX_MIN_LENGTH;
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
      setPanelVisible(false);
      return;
    }

    nextCandidates = applyMruRanking(nextCandidates);

    const sameList =
      currentCandidates.length === nextCandidates.length &&
      currentCandidates.every((item, idx) => item.id === nextCandidates[idx].id);

    currentCandidates = nextCandidates;
    currentRange = effectiveMatch.range;
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
    selectedIndex = Math.max(
      0,
      Math.min(options?.selectedIndex ?? 0, currentCandidates.length - 1)
    );
    ensurePanel();
    setPanelVisible(true);
    renderPanel();
  };

  const refresh = (options: SuggestOptions = {}) => {
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
    const cursorOffset =
      typeof mathfieldApi.position === "number" ? mathfieldApi.position : selection.end;
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
    const scopeRange = resolveScopeRange(mathfieldApi, cursorOffset);
    const rawValue = mathfieldApi.getValue(scopeRange.start, scopeRange.end, "latex");
    if (typeof rawValue !== "string") {
      updateCandidates(null, options);
      return;
    }
    const cursorIndex = offsetToIndexInRange(mathfieldApi, scopeRange.start, cursorOffset);
    const toOffsetMatch = (match: TokenIndexMatch | null): TokenMatch | null => {
      if (!match) {
        return null;
      }
      const startOffset = indexToOffsetInRange(
        mathfieldApi,
        scopeRange.start,
        scopeRange.end,
        match.range.start
      );
      const endOffset = indexToOffsetInRange(
        mathfieldApi,
        scopeRange.start,
        scopeRange.end,
        match.range.end
      );
      return { token: match.token, range: { start: startOffset, end: endOffset }, kind: match.kind };
    };
    const operatorMatch = toOffsetMatch(findOperatorToken(rawValue, cursorIndex));
    if (operatorMatch) {
      updateCandidates(operatorMatch, options);
      return;
    }
    const wordMatch = toOffsetMatch(findWordToken(rawValue, cursorIndex));
    updateCandidates(wordMatch, options);
  };

  const close = () => {
    updateCandidates(null);
  };

  const openExplicitSuggestions = () => {
    if (!mathfield || composing) {
      return false;
    }
    explicitSession = true;
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
    const candidate = currentCandidates[index];
    recordMru(candidate.id);
    const mathfieldApi = mathfield as any;
    if (typeof mathfieldApi.focus === "function") {
      mathfieldApi.focus();
    }
    if (candidate.apply) {
      suppressNextUpdate = true;
      setPanelVisible(false);
      candidate.apply(mathfieldApi);
      window.setTimeout(() => {
        suppressNextUpdate = false;
        if (autoSuggest) {
          refresh();
        }
      }, 0);
      return;
    }
    if (!currentRange) {
      return;
    }
    suppressNextUpdate = true;
    setPanelVisible(false);
    setSelectionRange(mathfieldApi, currentRange.start, currentRange.end);
    deps.insertKey(candidate.key);
    if (typeof mathfieldApi.focus === "function") {
      mathfieldApi.focus();
    }
    window.setTimeout(() => {
      suppressNextUpdate = false;
      currentCandidates = [];
      currentRange = null;
      selectedIndex = 0;
      if (autoSuggest) {
        refresh();
      }
      if (typeof mathfieldApi.focus === "function") {
        mathfieldApi.focus();
      }
    }, 0);
  };

  const handleKeydown = (event: KeyboardEvent) => {
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
      updateCandidates(null);
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
    mathfield.addEventListener(
      "keyup",
      (event) => {
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
        if (autoSuggest || explicitSession) {
          refresh(explicitSession ? { explicit: true } : undefined);
        }
      },
      { signal }
    );

    mathfield.addEventListener(
      "blur",
      () => {
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
    if (!mathfield) {
      return;
    }
    mathfield = null;
    updateCandidates(null);
  };

  const setComposing = (value: boolean) => {
    composing = value;
    if (composing) {
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
