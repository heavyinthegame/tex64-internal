import { reconstructionBlock } from "./context.js";
import type { AppContext } from "../context.js";
import type { BlockContent, BlockType, MathKey } from "../types.js";
import type { BlockContext } from "./types.js";
import {
  PLACEHOLDER_LATEX,
  applyScriptToText,
  applyTemplateToText,
  getMathFieldSelectionRange,
  indexToOffset,
  offsetToIndex,
} from "./math-input-utils.js";
import {
  initMathWysiwyg,
  type MathWysiwygApi,
} from "../../math/wysiwyg/math-wysiwyg.js";
import { DEFAULT_WYSIWYG_PACKS } from "../../math/wysiwyg/math-wysiwyg-packs.js";
import { closeMathfieldInternalMenu } from "../../math/mathfield-private-adapter.js";
import {
  readMathFieldValue,
  setSelectionRange,
  type MathFieldPlaceholderApi,
  writeMathFieldValue,
} from "./input-ui-math-field.js";
import {
  normalizeLegacyEnvMarkers,
  normalizeMatrixSyntax,
  shouldWrapAligned,
  stripEmptyAlignedRows,
  unwrapAligned,
  wrapAligned,
} from "./input-ui-latex-format.js";
import {
  getFormatLabel,
  getFormatShortLabel,
  loadMathInsertSettings,
  saveMathDisplayWrap,
  saveMathInlineWrap,
  saveMathInsertMode,
  type MathDisplayWrap,
  type MathInlineWrap,
  type MathInsertMode,
} from "./input-ui-settings.js";
import {
  ensureMathWysiwygPacks,
  loadMathWysiwygSettings,
  saveMathWysiwygAutoSuggest,
  saveMathWysiwygPacks,
} from "./math-wysiwyg-settings.js";

export type BlockInputApi = {
  getActiveBlockType: () => BlockType;
  setActiveBlockType: (type: BlockType) => void;
  setMathKeyboardVisibilityHandler: (handler: () => void) => void;
  getMathInputValue: () => string;
  setMathInputValue: (value: string) => void;
  getBlockDraft: () => { snippet: string; content: BlockContent } | null;
  insertMathKey: (key: MathKey) => void;
  setMathInputElement: (element: HTMLElement | null) => void;
  setMathInputFallback: (value: string | null) => void;
  getMathInputFallback: () => string | null;
  isMathInputFocused: () => boolean;
  attachMathInputListener: () => void;
  attachMathFieldEvents: (mathfield: HTMLElement) => void;
  updateMathPreview: () => void;
};

type BlockInputDeps = {
  getActiveBlockContext: () => BlockContext | null;
  getWorkspaceRootKey?: () => string | null;
  onMathFieldSubmit?: () => void;
  onMathCaptureRequest?: () => void;
};

export const initBlockInputUi = (
  context: AppContext,
  deps: BlockInputDeps
): BlockInputApi => {
  const {
    blockMathInputContainer,
    blockSettingsButton,
    blockCaptureButton,
    blockSettingsModal,
    blockSettingsClose,
    blockSettingsBackButtons,
    blockSettingsPages,
    blockSettingsMenuItems,
    blockSettingsInlineOptions,
    blockSettingsDisplayOptions,
    blockFormatButton,
    blockFormatMenu,
    blockFormatOptions,
    blocksPanelBody,
  } = context.dom;

  type BlockSettingsPage = "menu" | "insert-format" | "suggestions";

  const normalizeMathValueForOutput = (value: string) => {
    const resolved = mathFieldWrapped ? unwrapAligned(value).value : value;
    return normalizeMatrixSyntax(normalizeLegacyEnvMarkers(resolved));
  };

  const prepareMathValueForField = (value: string) => {
    if (!value) {
      return { value, wrapped: false };
    }
    const normalizedLegacy = normalizeLegacyEnvMarkers(value);
    const wrapped = shouldWrapAligned(normalizedLegacy);
    const withAlignedWrapper = wrapped ? wrapAligned(normalizedLegacy) : normalizedLegacy;
    return { value: withAlignedWrapper, wrapped };
  };

  let activeBlockType: BlockType = "math";
  let mathInput: HTMLElement | null = null;
  let mathInputFallback: string | null = null;
  let currentMathValue = "";
  let mathFieldWrapped = false;
  let mathKeyboardVisibilityHandler = () => {};
  let mathWysiwygApi: MathWysiwygApi | null = null;
  let globalWysiwygKeydownBound = false;
  const attachedMathInputListeners = new WeakSet<HTMLElement>();
  const TEXTAREA_MATHFIELD_SHIM = Symbol("tex64.textarea-mathfield-shim");
  let mathInsertMode: MathInsertMode = "inline";
  let mathInlineWrap: MathInlineWrap = "inline-dollar";
  let mathDisplayWrap: MathDisplayWrap = "display-bracket";
  let blockSettingsOpen = false;
  let activeBlockSettingsPage: BlockSettingsPage = "menu";
  let formatMenuOpen = false;
  const defaultWysiwygSettings = {
    autoSuggest: true,
    enabledPacks: [...DEFAULT_WYSIWYG_PACKS],
  };
  let mathWysiwygSettings = loadMathWysiwygSettings(defaultWysiwygSettings);
  const wysiwygAutoOptions = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-wysiwyg-auto]")
  );
  const wysiwygPackOptions = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-wysiwyg-pack]")
  );
  const STYLE_WRAPPER_TEMPLATE_RE =
    /^\\(?:mathbb|mathcal|mathfrak|mathsf|mathrm|mathbf|mathit|mathtt|operatorname)\{#\?\}$/;
  type BackslashHandledEvent = KeyboardEvent & { __tex64BackslashHandled?: boolean };
  const isPlainBackslashInput = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return false;
    }
    if (event.key === "\\" || event.key === "¥") {
      return true;
    }
    return (
      event.code === "Backslash" || event.code === "IntlYen" || event.code === "IntlRo"
    );
  };
  const blockDirectLatexCommandInput = (event: KeyboardEvent) => {
    if (!isPlainBackslashInput(event)) {
      return false;
    }
    const tagged = event as BackslashHandledEvent;
    if (tagged.__tex64BackslashHandled) {
      return true;
    }
    tagged.__tex64BackslashHandled = true;
    event.preventDefault();
    event.stopImmediatePropagation();
    const opened = Boolean(mathWysiwygApi?.openExplicitSuggestions());
    if (!opened) {
      mathWysiwygApi?.close();
    }
    return true;
  };

  const setFormatMenuOpen = (open: boolean) => {
    formatMenuOpen = open;
    if (blockFormatMenu instanceof HTMLElement) {
      blockFormatMenu.classList.toggle("is-open", open);
      blockFormatMenu.setAttribute("aria-hidden", open ? "false" : "true");
    }
    if (blockFormatButton instanceof HTMLElement) {
      blockFormatButton.setAttribute("aria-expanded", open ? "true" : "false");
    }
  };

  const setMathInsertMode = (value: MathInsertMode) => {
    mathInsertMode = value;
    if (blockFormatButton instanceof HTMLElement) {
      const fullLabel = getFormatLabel(value);
      blockFormatButton.textContent = getFormatShortLabel(value);
      blockFormatButton.setAttribute("title", fullLabel);
      blockFormatButton.setAttribute("aria-label", `挿入形式: ${fullLabel}`);
    }
    if (Array.isArray(blockFormatOptions)) {
      blockFormatOptions.forEach((option) => {
        const isActive = option.dataset.format === value;
        option.classList.toggle("is-active", isActive);
        option.setAttribute("aria-selected", isActive ? "true" : "false");
      });
    }
    saveMathInsertMode(value);
  };

  const setMathInlineWrap = (value: MathInlineWrap) => {
    mathInlineWrap = value;
    if (Array.isArray(blockSettingsInlineOptions)) {
      blockSettingsInlineOptions.forEach((option) => {
        const isActive = option.dataset.inlineFormat === value;
        option.classList.toggle("is-active", isActive);
        option.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
    }
    saveMathInlineWrap(value);
  };

  const setMathDisplayWrap = (value: MathDisplayWrap) => {
    mathDisplayWrap = value;
    if (Array.isArray(blockSettingsDisplayOptions)) {
      blockSettingsDisplayOptions.forEach((option) => {
        const isActive = option.dataset.displayFormat === value;
        option.classList.toggle("is-active", isActive);
        option.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
    }
    saveMathDisplayWrap(value);
  };

  const applyMathInsertSettings = () => {
    const resolved = loadMathInsertSettings({
      mode: mathInsertMode,
      inlineWrap: mathInlineWrap,
      displayWrap: mathDisplayWrap,
    });
    setMathInsertMode(resolved.mode);
    setMathInlineWrap(resolved.inlineWrap);
    setMathDisplayWrap(resolved.displayWrap);
  };

  const applyMathWysiwygSettings = () => {
    mathWysiwygSettings = {
      ...mathWysiwygSettings,
      enabledPacks: ensureMathWysiwygPacks(mathWysiwygSettings.enabledPacks),
    };
    const enabledPacks = new Set(mathWysiwygSettings.enabledPacks);
    if (Array.isArray(wysiwygAutoOptions)) {
      wysiwygAutoOptions.forEach((button) => {
        const isAuto = button.dataset.wysiwygAuto === "on";
        const isActive = isAuto === mathWysiwygSettings.autoSuggest;
        button.classList.toggle("is-active", isActive);
        button.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
    }
    if (Array.isArray(wysiwygPackOptions)) {
      wysiwygPackOptions.forEach((button) => {
        const packId = button.dataset.wysiwygPack;
        if (!packId) {
          return;
        }
        const isActive = enabledPacks.has(packId);
        button.classList.toggle("is-active", isActive);
        button.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
    }
    mathWysiwygApi?.updateConfig({
      autoSuggest: mathWysiwygSettings.autoSuggest,
      enabledPacks: mathWysiwygSettings.enabledPacks,
    });
  };

  const setMathWysiwygAutoSuggest = (value: boolean) => {
    mathWysiwygSettings = {
      ...mathWysiwygSettings,
      autoSuggest: value,
    };
    saveMathWysiwygAutoSuggest(value);
    applyMathWysiwygSettings();
  };

  const toggleMathWysiwygPack = (packId: string) => {
    const next = new Set(mathWysiwygSettings.enabledPacks);
    if (next.has(packId)) {
      next.delete(packId);
    } else {
      next.add(packId);
    }
    const normalized = ensureMathWysiwygPacks(Array.from(next));
    mathWysiwygSettings = {
      ...mathWysiwygSettings,
      enabledPacks: normalized,
    };
    saveMathWysiwygPacks(normalized);
    applyMathWysiwygSettings();
  };

  const updateMathPreview = () => {
    // preview disabled
  };

  const setMathKeyboardVisibilityHandler = (handler: () => void) => {
    mathKeyboardVisibilityHandler = handler;
  };

  const setActiveBlockType = (type: BlockType) => {
    mathKeyboardVisibilityHandler();
    activeBlockType = type;
    updateMathPreview();
  };

  const isMathInputFocused = () => {
    if (!mathInput) {
      return false;
    }
    if (document.activeElement === mathInput) {
      return true;
    }
    if (mathInput.classList.contains("is-focused")) {
      return true;
    }
    if (typeof mathInput.matches === "function" && mathInput.matches(":focus-within")) {
      return true;
    }
    return false;
  };

  const decorateTextareaAsMathfield = (textarea: HTMLTextAreaElement) => {
    const shimmed = textarea as HTMLTextAreaElement & {
      [TEXTAREA_MATHFIELD_SHIM]?: boolean;
      getValue?: (...args: unknown[]) => string;
      mode?: "math";
      position?: number;
      lastOffset?: number;
      selection?: unknown;
    };
    if (shimmed[TEXTAREA_MATHFIELD_SHIM]) {
      return;
    }
    Object.defineProperty(shimmed, TEXTAREA_MATHFIELD_SHIM, {
      value: true,
      configurable: false,
      writable: false,
      enumerable: false,
    });

    const clamp = (value: number) => {
      const length = textarea.value.length;
      if (!Number.isFinite(value)) {
        return length;
      }
      return Math.max(0, Math.min(length, Math.trunc(value)));
    };
    const readSelectionStart = () =>
      typeof textarea.selectionStart === "number" ? textarea.selectionStart : textarea.value.length;
    const readSelectionEnd = () =>
      typeof textarea.selectionEnd === "number" ? textarea.selectionEnd : textarea.value.length;
    const setSelection = (start: number, end: number) => {
      const safeStart = clamp(start);
      const safeEnd = clamp(end);
      textarea.setSelectionRange(safeStart, safeEnd);
    };

    if (typeof shimmed.getValue !== "function") {
      Object.defineProperty(shimmed, "getValue", {
        configurable: true,
        value: (...args: unknown[]) => {
          if (args.length === 1 && args[0] === "latex") {
            return textarea.value;
          }
          if (
            args.length >= 3 &&
            typeof args[0] === "number" &&
            typeof args[1] === "number" &&
            args[2] === "latex"
          ) {
            const start = clamp(args[0]);
            const end = clamp(args[1]);
            return textarea.value.slice(Math.min(start, end), Math.max(start, end));
          }
          return textarea.value;
        },
      });
    }

    Object.defineProperty(shimmed, "selection", {
      configurable: true,
      get: () => [readSelectionStart(), readSelectionEnd()],
      set: (value: unknown) => {
        if (Array.isArray(value) && value.length >= 2) {
          const start = Number(value[0]);
          const end = Number(value[1]);
          if (Number.isFinite(start) && Number.isFinite(end)) {
            setSelection(start, end);
          }
          return;
        }
        if (
          value &&
          typeof value === "object" &&
          "ranges" in value &&
          Array.isArray((value as { ranges?: unknown }).ranges)
        ) {
          const first = (value as { ranges: unknown[] }).ranges[0];
          if (Array.isArray(first) && first.length >= 2) {
            const start = Number(first[0]);
            const end = Number(first[1]);
            if (Number.isFinite(start) && Number.isFinite(end)) {
              setSelection(start, end);
            }
          }
        }
      },
    });

    Object.defineProperty(shimmed, "position", {
      configurable: true,
      get: () => readSelectionEnd(),
      set: (value: number) => {
        setSelection(value, value);
      },
    });

    Object.defineProperty(shimmed, "lastOffset", {
      configurable: true,
      get: () => textarea.value.length,
    });

    Object.defineProperty(shimmed, "mode", {
      configurable: true,
      get: () => "math",
      set: () => {
        // Keep textarea fallback in math mode for token detection consistency.
      },
    });
  };

  const setMathInputElement = (element: HTMLElement | null) => {
    mathInput = element;
    mathFieldWrapped = false;
    if (!mathInput) {
      return;
    }
    if (mathInput instanceof HTMLTextAreaElement) {
      decorateTextareaAsMathfield(mathInput);
    }
    if (!currentMathValue) {
      if (mathInput instanceof HTMLTextAreaElement) {
        attachMathInputListener();
      }
      return;
    }
    const resolvedValue =
      mathInput instanceof HTMLTextAreaElement
        ? { value: currentMathValue, wrapped: false }
        : prepareMathValueForField(currentMathValue);
    if (mathInput instanceof HTMLTextAreaElement) {
      mathInput.value = resolvedValue.value;
      attachMathInputListener();
      return;
    }
    mathFieldWrapped = resolvedValue.wrapped;
    writeMathFieldValue(
      mathInput as { setValue?: (value: string) => void; value?: string },
      resolvedValue.value
    );
  };

  const setMathInputFallback = (value: string | null) => {
    mathInputFallback = typeof value === "string" ? value : null;
  };

  const getMathInputFallback = () => mathInputFallback;

  const getMathInputValue = () => {
    if (mathInputFallback !== null) {
      return normalizeMathValueForOutput(mathInputFallback);
    }
    if (!mathInput) {
      return "";
    }
    if (mathInput instanceof HTMLElement && mathInput.tagName.toLowerCase() === "math-field") {
      const rawValue = readMathFieldValue(
        mathInput as { getValue?: (format?: string) => unknown; value?: unknown }
      );
      const normalizedValue = normalizeLegacyEnvMarkers(rawValue);
      if (mathFieldWrapped) {
        const { value: unwrapped, didUnwrap } = unwrapAligned(normalizedValue);
        if (didUnwrap) {
          currentMathValue = unwrapped;
          return unwrapped;
        }
        mathFieldWrapped = false;
      }
      currentMathValue = normalizedValue;
      return normalizedValue;
    }

    if (mathInput instanceof HTMLTextAreaElement) {
      mathFieldWrapped = false;
      currentMathValue = normalizeLegacyEnvMarkers(mathInput.value);
      return currentMathValue;
    }
    mathFieldWrapped = false;
    const value = (mathInput as { value?: string }).value;
    return typeof value === "string" ? normalizeLegacyEnvMarkers(value) : "";
  };

  const setMathInputValue = (value: string) => {
    if (!mathInput) {
      currentMathValue = value;
      mathFieldWrapped = false;
      return;
    }
    if (mathInput instanceof HTMLTextAreaElement) {
      mathFieldWrapped = false;
      currentMathValue = value;
      mathInput.value = value;
      return;
    }
    const preparedValue = prepareMathValueForField(value);
    mathFieldWrapped = preparedValue.wrapped;
    currentMathValue = value;
    writeMathFieldValue(
      mathInput as { setValue?: (value: string) => void; value?: string },
      preparedValue.value
    );
  };

  const attachMathInputListener = () => {
    if (!mathInput) {
      return;
    }
    if (mathInput instanceof HTMLElement && mathInput.tagName.toLowerCase() === "math-field") {
      return;
    }
    const inputElement = mathInput;
    if (attachedMathInputListeners.has(inputElement)) {
      return;
    }
    attachedMathInputListeners.add(inputElement);

    if (inputElement instanceof HTMLTextAreaElement) {
      decorateTextareaAsMathfield(inputElement);
      mathWysiwygApi?.attach(inputElement);
    }

    inputElement.addEventListener("input", () => {
      if (inputElement instanceof HTMLTextAreaElement) {
        mathFieldWrapped = false;
        currentMathValue = inputElement.value;
        return;
      }
      mathFieldWrapped = false;
      const value = (inputElement as { value?: string }).value;
      currentMathValue = typeof value === "string" ? value : "";
    });

    if (inputElement instanceof HTMLTextAreaElement) {
      const textArea = inputElement;
      textArea.addEventListener("keydown", (event: KeyboardEvent) => {
        if (mathWysiwygApi?.handleKeydown(event)) {
          event.stopImmediatePropagation();
          return;
        }
        if (blockDirectLatexCommandInput(event)) {
          return;
        }
        if (event.isComposing) {
          return;
        }
        const isSuggestShortcut =
          (event.ctrlKey || event.metaKey) && !event.altKey && event.key === ".";
        if (isSuggestShortcut) {
          const opened = Boolean(mathWysiwygApi?.openExplicitSuggestions());
          if (opened) {
            event.preventDefault();
            event.stopImmediatePropagation();
          }
          return;
        }
        if (event.key === "Escape") {
          mathWysiwygApi?.close();
          return;
        }
      });
      textArea.addEventListener("focus", () => {
        mathKeyboardVisibilityHandler();
        textArea.classList.add("is-focused");
      });
      textArea.addEventListener("blur", () => {
        textArea.classList.remove("is-focused");
        mathWysiwygApi?.close();
      });
      textArea.addEventListener("compositionstart", (event) => {
        event.stopPropagation();
        mathWysiwygApi?.setComposing(true);
      });
      textArea.addEventListener("compositionend", (event) => {
        event.stopPropagation();
        mathWysiwygApi?.setComposing(false);
      });
      textArea.addEventListener("click", () => {
        // Keep fallback suggestions in sync with caret movement.
      });
      textArea.addEventListener("keyup", () => {
        // Auto updates are handled by math-wysiwyg listeners attached above.
      });
    }
  };

  const attachMathFieldEvents = (mathfield: HTMLElement) => {
    const closeMathFieldMenu = () => {
      if (closeMathfieldInternalMenu(mathfield)) {
        return;
      }
      const executeCommand = (mathfield as { executeCommand?: (command: string) => void })
        .executeCommand;
      if (typeof executeCommand === "function") {
        const menuElement = document.querySelector("menu.ui-menu-container");
        if (menuElement) {
          executeCommand.call(mathfield, "toggleContextMenu");
        }
      }
    };

    const closeWysiwygSuggestions = () => {
      mathWysiwygApi?.close();
    };

    const readMathFieldLatex = (
      target: { getValue?: (...args: unknown[]) => unknown },
      ...args: unknown[]
    ) => {
      if (typeof target.getValue !== "function") {
        return null;
      }
      try {
        const value = target.getValue(...args);
        return typeof value === "string" ? value : null;
      } catch {
        return null;
      }
    };

    const syncMathFieldValue = () => {
      const rawValue = normalizeLegacyEnvMarkers(
        readMathFieldValue(
          mathfield as { getValue?: (format?: string) => unknown; value?: unknown }
        )
      );
      if (mathFieldWrapped) {
        const { value: unwrapped, didUnwrap } = unwrapAligned(rawValue);
        if (didUnwrap) {
          const trimmed = stripEmptyAlignedRows(unwrapped);
          currentMathValue = normalizeLegacyEnvMarkers(unwrapped);
          if (trimmed !== unwrapped) {
            currentMathValue = normalizeLegacyEnvMarkers(trimmed);
          }
          return;
        }
        mathFieldWrapped = false;
      }
      mathFieldWrapped = shouldWrapAligned(rawValue);
      currentMathValue = normalizeLegacyEnvMarkers(rawValue);
    };
    mathfield.addEventListener("input", syncMathFieldValue);
    mathfield.addEventListener("change", syncMathFieldValue);

    const applyStructuredInput = (key: string) => {
      if (key !== "^" && key !== "_") {
        return false;
      }
      const mathfieldApi = mathfield as {
        insert?: (value: string, options?: Record<string, unknown>) => boolean;
        executeCommand?: (selector: string, ...args: unknown[]) => boolean;
        getValue?: (...args: unknown[]) => unknown;
        focus?: () => void;
      };

      const insertValue =
        key === "^" ? `^{${PLACEHOLDER_LATEX}}` : `_{${PLACEHOLDER_LATEX}}`;
      const insertOptions = {
        selectionMode: "placeholder",
        focus: true,
        feedback: false,
        format: "latex" as const,
      };

      try {
        mathfieldApi.focus?.();
        if (typeof mathfieldApi.insert === "function") {
          mathfieldApi.insert(insertValue, insertOptions);
          if (typeof mathfieldApi.executeCommand === "function") {
            try {
              mathfieldApi.executeCommand("moveToPreviousPlaceholder");
            } catch {
              // ignore
            }
          }
          mathfield.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        }
        if (typeof mathfieldApi.executeCommand === "function") {
          const beforeValue = readMathFieldLatex(mathfieldApi, "latex");
          const ok = mathfieldApi.executeCommand("insert", insertValue, insertOptions);
          const afterValue = readMathFieldLatex(mathfieldApi, "latex");
          const changed =
            typeof beforeValue === "string" &&
            typeof afterValue === "string" &&
            afterValue !== beforeValue;
          if (ok !== false || changed) {
            mathfield.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
          }
        }
      } catch {
        // ignore
      }
      return false;
    };

    const tryWrapSelectionWithFraction = () => {
      const mathfieldApi = mathfield as {
        getValue?: (...args: unknown[]) => unknown;
        executeCommand?: (command: string, ...args: unknown[]) => boolean;
        insert?: (value: string, options?: Record<string, unknown>) => void;
        focus?: () => void;
      };
      if (typeof mathfieldApi.getValue !== "function") {
        return false;
      }
      const selection = getMathFieldSelectionRange(mathfieldApi);
      if (selection.start === selection.end) {
        return false;
      }
      const selectedLatex = readMathFieldLatex(
        mathfieldApi,
        selection.start,
        selection.end,
        "latex"
      );
      if (!selectedLatex) {
        return false;
      }
      const insertLatex = `\\frac{${selectedLatex}}{${PLACEHOLDER_LATEX}}`;
      let inserted = false;
      if (typeof mathfieldApi.executeCommand === "function") {
        const beforeValue = readMathFieldLatex(mathfieldApi, "latex");
        try {
          const ok = mathfieldApi.executeCommand("insert", insertLatex, {
              selectionMode: "placeholder",
              focus: true,
              feedback: false,
              format: "latex",
            });
          const afterValue = readMathFieldLatex(mathfieldApi, "latex");
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
        mathfieldApi.insert(insertLatex, {
          selectionMode: "placeholder",
          focus: true,
          feedback: false,
          format: "latex",
        });
        inserted = true;
      }
      if (!inserted) {
        return false;
      }
      mathfieldApi.focus?.();
      mathfield.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    };

    const MATRIX_ENV_NAMES = new Set([
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
    ]);

    const findMatrixEnvironment = (latex: string, cursorIndex: number) => {
      const tokenRegex = /\\(begin|end)\{([A-Za-z*]+)\}/g;
      const stack: Array<{
        name: string;
        start: number;
        bodyStart: number;
        beginToken: string;
      }> = [];
      let match: RegExpExecArray | null = null;
      let found: {
        name: string;
        start: number;
        end: number;
        bodyStart: number;
        bodyEnd: number;
        beginToken: string;
        endToken: string;
      } | null = null;
      while ((match = tokenRegex.exec(latex))) {
        const kind = match[1];
        const name = match[2];
        const tokenStart = match.index;
        const tokenText = match[0];
        if (kind === "begin") {
          stack.push({
            name,
            start: tokenStart,
            bodyStart: tokenStart + tokenText.length,
            beginToken: tokenText,
          });
          continue;
        }
        for (let i = stack.length - 1; i >= 0; i -= 1) {
          if (stack[i].name !== name) {
            continue;
          }
          const entry = stack.splice(i, 1)[0];
          const base = name.replace(/\*$/, "");
          const bodyEnd = tokenStart;
          if (cursorIndex >= entry.bodyStart && cursorIndex <= bodyEnd) {
            if (MATRIX_ENV_NAMES.has(base)) {
              if (!found || entry.bodyStart >= found.bodyStart) {
                found = {
                  name,
                  start: entry.start,
                  end: tokenStart + tokenText.length,
                  bodyStart: entry.bodyStart,
                  bodyEnd,
                  beginToken: entry.beginToken,
                  endToken: tokenText,
                };
              }
            }
          }
          break;
        }
      }
      return found;
    };

    const splitRows = (body: string) => {
      const isEscapedAt = (text: string, index: number) => {
        let count = 0;
        for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
          count += 1;
        }
        return count % 2 === 1;
      };
      const readEnvironmentTokenAt = (text: string, index: number) => {
        if (text[index] !== "\\") {
          return null;
        }
        const match = /^\\(begin|end)\{([A-Za-z*]+)\}/.exec(text.slice(index));
        if (!match) {
          return null;
        }
        return {
          kind: match[1] as "begin" | "end",
          name: match[2],
          length: match[0].length,
        };
      };
      const state = {
        braceDepth: 0,
        bracketDepth: 0,
        envStack: [] as string[],
      };
      const isTopLevel = () =>
        state.braceDepth === 0 &&
        state.bracketDepth === 0 &&
        state.envStack.length === 0;
      const consumeStructuralToken = (text: string, index: number) => {
        const envToken = readEnvironmentTokenAt(text, index);
        if (envToken) {
          if (envToken.kind === "begin") {
            state.envStack.push(envToken.name);
          } else {
            for (let i = state.envStack.length - 1; i >= 0; i -= 1) {
              if (state.envStack[i] !== envToken.name) {
                continue;
              }
              state.envStack.splice(i, 1);
              break;
            }
          }
          return index + envToken.length - 1;
        }
        const ch = text[index];
        if (ch === "{" && !isEscapedAt(text, index)) {
          state.braceDepth += 1;
        } else if (ch === "}" && !isEscapedAt(text, index)) {
          state.braceDepth = Math.max(0, state.braceDepth - 1);
        } else if (ch === "[" && !isEscapedAt(text, index)) {
          state.bracketDepth += 1;
        } else if (ch === "]" && !isEscapedAt(text, index)) {
          state.bracketDepth = Math.max(0, state.bracketDepth - 1);
        }
        return index;
      };

      const rows: Array<{ text: string; start: number; end: number }> = [];
      let rowStart = 0;
      for (let i = 0; i < body.length; i += 1) {
        const ch = body[i];
        if (ch === "\\" && body[i + 1] === "\\" && !isEscapedAt(body, i) && isTopLevel()) {
          rows.push({ text: body.slice(rowStart, i), start: rowStart, end: i });
          i += 1;
          rowStart = i + 1;
          continue;
        }
        i = consumeStructuralToken(body, i);
      }
      rows.push({ text: body.slice(rowStart), start: rowStart, end: body.length });
      return rows;
    };

    const splitCells = (rowText: string) => {
      const isEscapedAt = (text: string, index: number) => {
        let count = 0;
        for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
          count += 1;
        }
        return count % 2 === 1;
      };
      const readEnvironmentTokenAt = (text: string, index: number) => {
        if (text[index] !== "\\") {
          return null;
        }
        const match = /^\\(begin|end)\{([A-Za-z*]+)\}/.exec(text.slice(index));
        if (!match) {
          return null;
        }
        return {
          kind: match[1] as "begin" | "end",
          name: match[2],
          length: match[0].length,
        };
      };
      const state = {
        braceDepth: 0,
        bracketDepth: 0,
        envStack: [] as string[],
      };
      const isTopLevel = () =>
        state.braceDepth === 0 &&
        state.bracketDepth === 0 &&
        state.envStack.length === 0;
      const consumeStructuralToken = (text: string, index: number) => {
        const envToken = readEnvironmentTokenAt(text, index);
        if (envToken) {
          if (envToken.kind === "begin") {
            state.envStack.push(envToken.name);
          } else {
            for (let i = state.envStack.length - 1; i >= 0; i -= 1) {
              if (state.envStack[i] !== envToken.name) {
                continue;
              }
              state.envStack.splice(i, 1);
              break;
            }
          }
          return index + envToken.length - 1;
        }
        const ch = text[index];
        if (ch === "{" && !isEscapedAt(text, index)) {
          state.braceDepth += 1;
        } else if (ch === "}" && !isEscapedAt(text, index)) {
          state.braceDepth = Math.max(0, state.braceDepth - 1);
        } else if (ch === "[" && !isEscapedAt(text, index)) {
          state.bracketDepth += 1;
        } else if (ch === "]" && !isEscapedAt(text, index)) {
          state.bracketDepth = Math.max(0, state.bracketDepth - 1);
        }
        return index;
      };

      const cells: Array<{ text: string; start: number; end: number }> = [];
      let cellStart = 0;
      for (let i = 0; i < rowText.length; i += 1) {
        const ch = rowText[i];
        if (ch === "&" && !isEscapedAt(rowText, i) && isTopLevel()) {
          cells.push({ text: rowText.slice(cellStart, i), start: cellStart, end: i });
          cellStart = i + 1;
          continue;
        }
        i = consumeStructuralToken(rowText, i);
      }
      cells.push({ text: rowText.slice(cellStart), start: cellStart, end: rowText.length });
      return cells;
    };

    const rebuildMatrixBody = (
      rows: Array<Array<string>>,
      selectionTarget: { row: number; col: number } | null
    ) => {
      let body = "";
      let selectionIndex = 0;
      rows.forEach((cells, rowIndex) => {
        if (rowIndex > 0) {
          body += "\\\\";
        }
        let rowOffset = body.length;
        cells.forEach((cell, colIndex) => {
          if (colIndex > 0) {
            body += "&";
          }
          if (selectionTarget && rowIndex === selectionTarget.row && colIndex === selectionTarget.col) {
            selectionIndex = rowOffset + body.length - rowOffset;
          }
          body += cell;
        });
      });
      if (selectionTarget) {
        const targetRow = rows[selectionTarget.row];
        if (targetRow) {
          let cursor = 0;
          for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
            if (rowIndex > 0) {
              cursor += 2;
            }
            const cells = rows[rowIndex];
            for (let colIndex = 0; colIndex < cells.length; colIndex += 1) {
              if (colIndex > 0) {
                cursor += 1;
              }
              if (rowIndex === selectionTarget.row && colIndex === selectionTarget.col) {
                selectionIndex = cursor;
                return { body, selectionIndex };
              }
              cursor += cells[colIndex].length;
            }
          }
        }
      }
      return { body, selectionIndex: 0 };
    };

    const tryApplyMatrixEdit = (mode: "row" | "column") => {
      const mathfieldApi = mathfield as {
        getValue?: (format?: string) => unknown;
        executeCommand?: (command: string, ...args: unknown[]) => boolean;
        insert?: (value: string, options?: Record<string, unknown>) => void;
        focus?: () => void;
      };
      if (typeof mathfieldApi.getValue !== "function") {
        return false;
      }
      const selection = getMathFieldSelectionRange(mathfieldApi);
      if (selection.start !== selection.end) {
        return false;
      }
      const latex = readMathFieldLatex(mathfieldApi, "latex");
      if (!latex) {
        return false;
      }
      const cursorIndex = offsetToIndex(mathfieldApi, selection.end);
      const env = findMatrixEnvironment(latex, cursorIndex);
      if (!env) {
        return false;
      }
      const body = latex.slice(env.bodyStart, env.bodyEnd);
      const rows = splitRows(body);
      if (rows.length === 0) {
        return false;
      }
      const parsedRows = rows.map((row) => ({
        ...row,
        cells: splitCells(row.text),
      }));
      const cursorInBody = Math.max(0, cursorIndex - env.bodyStart);
      let rowIndex = parsedRows.findIndex(
        (row) => cursorInBody >= row.start && cursorInBody <= row.end
      );
      if (rowIndex < 0) {
        rowIndex = Math.max(0, parsedRows.length - 1);
      }
      const row = parsedRows[rowIndex];
      const cursorInRow = cursorInBody - row.start;
      let colIndex = row.cells.findIndex(
        (cell) => cursorInRow >= cell.start && cursorInRow <= cell.end
      );
      if (colIndex < 0) {
        colIndex = Math.max(0, row.cells.length - 1);
      }

      const colCount = Math.max(
        1,
        ...parsedRows.map((entry) => Math.max(1, entry.cells.length))
      );

      let nextRows: Array<Array<string>> = parsedRows.map((entry) =>
        entry.cells.map((cell) => cell.text)
      );

      let selectionTarget: { row: number; col: number } | null = null;
      if (mode === "row") {
        const newRow = Array.from({ length: colCount }, () => PLACEHOLDER_LATEX);
        const insertAt = Math.min(rowIndex + 1, nextRows.length);
        nextRows = [
          ...nextRows.slice(0, insertAt),
          newRow,
          ...nextRows.slice(insertAt),
        ];
        selectionTarget = { row: insertAt, col: 0 };
      } else {
        const insertAt = Math.min(colIndex + 1, colCount);
        nextRows = nextRows.map((cells, index) => {
          const normalized = [...cells];
          while (normalized.length < colCount) {
            normalized.push("");
          }
          normalized.splice(insertAt, 0, PLACEHOLDER_LATEX);
          return normalized;
        });
        selectionTarget = { row: rowIndex, col: insertAt };
      }

      const { body: nextBody, selectionIndex } = rebuildMatrixBody(nextRows, selectionTarget);
      const nextLatex = `${env.beginToken}${nextBody}${env.endToken}`;
      const startOffset = indexToOffset(mathfieldApi, env.start);
      const endOffset = indexToOffset(mathfieldApi, env.end);
      setSelectionRange(mathfieldApi, startOffset, endOffset);

      mathfieldApi.focus?.();
      let replaced = false;
      if (typeof mathfieldApi.executeCommand === "function") {
        const beforeValue = readMathFieldLatex(mathfieldApi, "latex");
        try {
          const ok = mathfieldApi.executeCommand("insert", nextLatex, {
            selectionMode: "after",
            focus: true,
            feedback: false,
            format: "latex",
          });
          const afterValue = readMathFieldLatex(mathfieldApi, "latex");
          const changed =
            typeof beforeValue === "string" &&
            typeof afterValue === "string" &&
            afterValue !== beforeValue;
          replaced = ok !== false || changed;
        } catch {
          replaced = false;
        }
      }
      if (!replaced && typeof mathfieldApi.insert === "function") {
        mathfieldApi.insert(nextLatex, {
          selectionMode: "after",
          focus: true,
          feedback: false,
          format: "latex",
        });
        replaced = true;
      }
      if (!replaced) {
        return false;
      }
      if (Number.isFinite(selectionIndex)) {
        const nextSelection = env.start + env.beginToken.length + selectionIndex;
        const nextOffset = indexToOffset(mathfieldApi, nextSelection);
        setSelectionRange(mathfieldApi, nextOffset, nextOffset);
      }
      mathfield.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    };

    const tryInsertMatrixRow = () => tryApplyMatrixEdit("row");
    const tryInsertMatrixColumn = () => tryApplyMatrixEdit("column");

    const stripPlaceholderAndWhitespace = (value: string) =>
      value.replace(/\\placeholder\{\}/g, "").replace(/\s+/g, "");

    const extractSingleEnvironmentInner = (value: string) => {
      const match = value.match(/^\\begin\{([A-Za-z*]+)\}([\s\S]*)\\end\{\1\}$/);
      return match ? match[2] : value;
    };

    const isRowInsertionStable = (before: string, after: string) => {
      const beforeCore = stripPlaceholderAndWhitespace(extractSingleEnvironmentInner(before));
      const afterCore = stripPlaceholderAndWhitespace(extractSingleEnvironmentInner(after));
      if (!beforeCore) {
        return afterCore.length > 0;
      }
      return afterCore.includes(beforeCore);
    };

    const openMatrixOpsPalette = () => {
      if (!mathWysiwygApi) {
        return false;
      }
      const mathfieldApi = mathfield as {
        executeCommand?: (command: string, ...args: unknown[]) => boolean;
        getValue?: (format?: string) => unknown;
      };
      if (typeof mathfieldApi.getValue !== "function") {
        return false;
      }
      const selection = getMathFieldSelectionRange(mathfieldApi);
      const latex = readMathFieldLatex(mathfieldApi, "latex");
      if (!latex) {
        return false;
      }
      const cursorIndex = offsetToIndex(mathfieldApi, selection.end);
      const env = findMatrixEnvironment(latex, cursorIndex);
      if (!env) {
        return false;
      }
      const applyCommand = (command: string) => (mf: any) => {
        if (typeof mf.executeCommand !== "function") {
          return;
        }
        try {
          const ok = Boolean(mf.executeCommand(command));
          if (ok) {
            mf.dispatchEvent?.(new Event("input", { bubbles: true }));
          }
        } catch {
          // ignore
        }
      };
      mathWysiwygApi.openCustomCandidates([
        { id: "matrix-op:add-row", label: "+row", hint: "行を追加", apply: applyCommand("addRowAfter") },
        { id: "matrix-op:add-col", label: "+col", hint: "列を追加", apply: applyCommand("addColumnAfter") },
        { id: "matrix-op:remove-row", label: "-row", hint: "行を削除", apply: applyCommand("removeRow") },
        { id: "matrix-op:remove-col", label: "-col", hint: "列を削除", apply: applyCommand("removeColumn") },
      ]);
      return true;
    };

    const handleMathFieldKeydown = (event: KeyboardEvent) => {
      if (event.isComposing) {
        return;
      }
      if (mathWysiwygApi?.handleKeydown(event)) {
        event.stopImmediatePropagation();
        return;
      }
      if (blockDirectLatexCommandInput(event)) {
        return;
      }
      if (
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!tryWrapSelectionWithFraction()) {
          insertMathKey({ label: "/", latex: "/" });
          mathfield.dispatchEvent(new Event("input", { bubbles: true }));
        }
        closeWysiwygSuggestions();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
        const mathfieldApi = mathfield as {
          executeCommand?: (command: string, ...args: unknown[]) => boolean;
          getValue?: (format?: string) => unknown;
          insert?: (value: string, options?: Record<string, unknown>) => void;
        };
        if (!event.metaKey && !event.ctrlKey) {
          let handled = tryInsertMatrixRow();
          if (!handled && typeof mathfieldApi.executeCommand === "function") {
            const before = readMathFieldLatex(mathfieldApi, "latex");
            try {
              const ok = mathfieldApi.executeCommand("addRowAfter");
              const after = readMathFieldLatex(mathfieldApi, "latex");
              const changed =
                typeof before === "string" &&
                typeof after === "string" &&
                after !== before;
              if (ok !== false || changed) {
                handled = changed
                  ? isRowInsertionStable(before ?? "", after ?? "")
                  : Boolean(ok);
                if (!handled) {
                  try {
                    mathfieldApi.executeCommand("undo");
                  } catch {
                    // ignore undo failure
                  }
                }
              }
            } catch {
              handled = false;
            }
          }
          if (!handled) {
            const rawValue = readMathFieldLatex(mathfieldApi, "latex");
            if (typeof rawValue === "string" && shouldWrapAligned(rawValue)) {
              if (typeof mathfieldApi.executeCommand === "function") {
                try {
                  const ok = mathfieldApi.executeCommand("insert", "\\\\", {
                    selectionMode: "after",
                    focus: true,
                    feedback: false,
                    format: "latex",
                  });
                  handled = ok !== false;
                } catch {
                  handled = false;
                }
              }
              if (!handled && typeof mathfieldApi.insert === "function") {
                const before = readMathFieldLatex(mathfieldApi, "latex");
                try {
                  mathfieldApi.insert("\\\\", {
                    selectionMode: "after",
                    focus: true,
                    feedback: false,
                    format: "latex",
                  });
                  const after = readMathFieldLatex(mathfieldApi, "latex");
                  handled =
                    typeof before === "string" && typeof after === "string"
                      ? after !== before
                      : true;
                } catch {
                  handled = false;
                }
              }
            }
          }
          if (handled) {
            event.preventDefault();
            event.stopImmediatePropagation();
            closeWysiwygSuggestions();
            mathfield.dispatchEvent(new Event("input", { bubbles: true }));
            return;
          }
        } else {
          let handled = false;
          if (typeof mathfieldApi.executeCommand === "function") {
            const before = readMathFieldLatex(mathfieldApi, "latex");
            try {
              const ok = mathfieldApi.executeCommand("addColumnAfter");
              const after = readMathFieldLatex(mathfieldApi, "latex");
              const changed =
                typeof before === "string" &&
                typeof after === "string" &&
                after !== before;
              if (ok !== false || changed) {
                handled = changed ? true : Boolean(ok);
              }
            } catch {
              handled = false;
            }
          }
          if (!handled) {
            handled = tryInsertMatrixColumn();
          }
          if (handled) {
            event.preventDefault();
            event.stopImmediatePropagation();
            closeWysiwygSuggestions();
            mathfield.dispatchEvent(new Event("input", { bubbles: true }));
            return;
          }

          event.preventDefault();
          event.stopImmediatePropagation();
          closeWysiwygSuggestions();
          deps.onMathFieldSubmit?.();
          return;
        }
      }
      if (event.defaultPrevented) {
        return;
      }
    };

    mathfield.addEventListener("keydown", handleMathFieldKeydown, { capture: true });
    const shadowRoot = (mathfield as { shadowRoot?: ShadowRoot }).shadowRoot;
    if (shadowRoot) {
      shadowRoot.addEventListener("keydown", handleMathFieldKeydown, { capture: true });
    }

    // When the suggestion panel is open, intercept keydown at the document capture phase.
    // This keeps navigation keys for the panel even when other parts of the app listen to keys.
    if (!globalWysiwygKeydownBound) {
      globalWysiwygKeydownBound = true;
      document.addEventListener(
        "keydown",
        (event: KeyboardEvent) => {
          if (!mathWysiwygApi) {
            return;
          }
          if (mathWysiwygApi.handleKeydown(event)) {
            event.stopImmediatePropagation();
          }
        },
        { capture: true }
      );
    }

    mathfield.addEventListener("keydown", (e: KeyboardEvent) => {
      if (mathWysiwygApi?.handleKeydown(e)) {
        return;
      }
      if (blockDirectLatexCommandInput(e)) {
        return;
      }
      if (e.isComposing) {
        return;
      }

      if (!e.metaKey && !e.altKey && e.ctrlKey && e.key === ".") {
        const opened = Boolean(mathWysiwygApi?.openExplicitSuggestions());
        const fallbackOpened = opened ? false : openMatrixOpsPalette();
        if (opened || fallbackOpened) {
          e.preventDefault();
        }
        return;
      }
      if (e.key === "Escape") {
        closeWysiwygSuggestions();
        mathfield.blur();
        return;
      }
    });

    mathfield.addEventListener("focus", () => {
      mathKeyboardVisibilityHandler();
      mathfield.classList.add("is-focused");
    });

    mathfield.addEventListener("blur", () => {
      mathfield.classList.remove("is-focused");
      closeWysiwygSuggestions();
    });

    mathfield.addEventListener("compositionstart", (e) => {
      e.stopPropagation();
      mathWysiwygApi?.setComposing(true);
    });
    mathfield.addEventListener("compositionend", (e) => {
      e.stopPropagation();
      mathWysiwygApi?.setComposing(false);
    });

    mathfield.addEventListener("pointerdown", () => {
      // Keep suggestions in sync with caret movement.
    });

    mathfield.addEventListener("selection-change", () => {
      // Handled by the MathWysiwyg auto-suggest listener.
    });

    mathfield.addEventListener("move-out", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    mathWysiwygApi?.attach(mathfield);
  };

  const buildMathSnippet = (formula: string) => {
    const context = deps.getActiveBlockContext();
    if (context) {
      return reconstructionBlock(context, formula);
    }

    const trimmed = formula.trim();
    if (!trimmed) {
      return "";
    }

    if (trimmed.startsWith("$") && trimmed.endsWith("$")) {
      return trimmed;
    }
    if (trimmed.startsWith("\\(") && trimmed.endsWith("\\)")) {
      return trimmed;
    }
    if (trimmed.startsWith("\\[") && trimmed.endsWith("\\]")) {
      return trimmed;
    }
    if (trimmed.startsWith("$$") && trimmed.endsWith("$$")) {
      return trimmed;
    }
    if (trimmed.startsWith("\\begin{")) {
      return trimmed;
    }

    switch (mathInsertMode) {
      case "inline":
        if (mathInlineWrap === "inline-paren") {
          return ["\\(", trimmed, "\\)"].join("");
        }
        return `$${trimmed}$`;
      case "display":
        if (mathDisplayWrap === "display-dollar") {
          return `$$${trimmed}$$`;
        }
        return `\\[${trimmed}\\]`;
      case "align":
        return ["\\begin{align*}", trimmed, "\\end{align*}"].join("\n");
      case "gather":
        return ["\\begin{gather*}", trimmed, "\\end{gather*}"].join("\n");
      case "none":
        return trimmed;
      default:
        return `$${trimmed}$`;
    }
  };

  const getBlockDraft = (): { snippet: string; content: BlockContent } | null => {
    const formula = getMathInputValue();
    const normalizedFormula = normalizeMathValueForOutput(formula);
    const snippet = buildMathSnippet(normalizedFormula);
    if (!snippet.trim()) {
      return null;
    }
    return { snippet, content: { formula: normalizedFormula.trim() } };
  };

  const resolveInsertValue = (
    key: MathKey,
    isTextArea: boolean,
    options?: { preserveTemplateMarkers?: boolean }
  ) => {
    const source = isTextArea && key.fallback ? key.fallback : key.latex;
    if (!isTextArea && options?.preserveTemplateMarkers) {
      return source;
    }
    const placeholder = isTextArea ? "" : PLACEHOLDER_LATEX;
    return source.replace(/#\?/g, placeholder);
  };

  const insertMathKey = (key: MathKey) => {
    if (!mathInput) {
      return;
    }
    const isTextArea = mathInput instanceof HTMLTextAreaElement;
    const placeholder = isTextArea ? "" : PLACEHOLDER_LATEX;

    const scriptKind = key.scriptKind;
    const templateKind = key.templateKind;

    if (mathInput instanceof HTMLTextAreaElement) {
      const textArea = mathInput;
      const start = textArea.selectionStart ?? textArea.value.length;
      const end = textArea.selectionEnd ?? textArea.value.length;
      const selection = { start, end };

      if (scriptKind) {
        const result = applyScriptToText(
          textArea.value,
          selection,
          scriptKind,
          {
            placeholder,
            base: key.scriptBase ?? null,
            subValue:
              scriptKind === "sub"
                ? key.scriptValue ?? null
                : key.scriptSubValue ?? null,
            supValue:
              scriptKind === "sup"
                ? key.scriptValue ?? null
                : key.scriptSupValue ?? null,
          }
        );
        textArea.value = result.text;
        textArea.setSelectionRange(result.selectionStart, result.selectionEnd);
        textArea.focus();
        textArea.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }

      if (templateKind) {
        const result = applyTemplateToText(textArea.value, selection, key.latex, {
          placeholder,
          baseMode: templateKind,
          baseIndex: key.templateTarget,
          baseSeparator: key.templateSeparator,
          baseScope: key.templateScope,
        });
        textArea.value = result.text;
        textArea.setSelectionRange(result.selectionStart, result.selectionEnd);
        textArea.focus();
        textArea.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }

      const insertValue = resolveInsertValue(key, true);
      if (!insertValue) {
        return;
      }
      textArea.value =
        textArea.value.slice(0, start) + insertValue + textArea.value.slice(end);
      const nextPos = start + insertValue.length;
      textArea.setSelectionRange(nextPos, nextPos);
      textArea.focus();
      textArea.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    const mathField = mathInput as {
      getValue?: (format?: string) => unknown;
      setValue?: (value: string) => void;
      value?: string;
      insert?: (value: string, options?: Record<string, unknown>) => void;
      executeCommand?: (...args: unknown[]) => boolean;
      focus?: () => void;
      select?: (start: number, end: number) => void;
      setSelection?: (start: number, end: number) => void;
      selection?: unknown;
      position?: number;
    };

    mathField.focus?.();

    const applyMathFieldTextEdit = (next: {
      text: string;
      selectionStart: number;
      selectionEnd: number;
    }) => {
      writeMathFieldValue(mathField, next.text);

      const startOffset = indexToOffset(mathField, next.selectionStart);
      const endOffset = indexToOffset(mathField, next.selectionEnd);
      setSelectionRange(mathField as MathFieldPlaceholderApi, startOffset, endOffset);
      mathInput.dispatchEvent(new Event("input", { bubbles: true }));
    };

    if (
      (scriptKind || templateKind) &&
      typeof mathField.getValue === "function"
    ) {
      const rawValue = readMathFieldValue(mathField);
      if (typeof rawValue === "string") {
        const selectionOffset = getMathFieldSelectionRange(mathField);
        const selectionIndex = {
          start: offsetToIndex(mathField, selectionOffset.start),
          end: offsetToIndex(mathField, selectionOffset.end),
        };

        if (scriptKind) {
          const result = applyScriptToText(rawValue, selectionIndex, scriptKind, {
            placeholder,
            base: key.scriptBase ?? null,
            subValue:
              scriptKind === "sub"
                ? key.scriptValue ?? null
                : key.scriptSubValue ?? null,
            supValue:
              scriptKind === "sup"
                ? key.scriptValue ?? null
                : key.scriptSupValue ?? null,
          });
          applyMathFieldTextEdit(result);
          return;
        }

        if (templateKind) {
          const result = applyTemplateToText(rawValue, selectionIndex, key.latex, {
            placeholder,
            baseMode: templateKind,
            baseIndex: key.templateTarget,
            baseSeparator: key.templateSeparator,
            baseScope: key.templateScope,
          });
          applyMathFieldTextEdit(result);
          return;
        }
      }
    }

    if (
      !scriptKind &&
      !templateKind &&
      typeof mathField.getValue === "function" &&
      STYLE_WRAPPER_TEMPLATE_RE.test(key.latex)
    ) {
      const rawValue = readMathFieldValue(mathField);
      if (typeof rawValue === "string") {
        const selectionOffset = getMathFieldSelectionRange(mathField);
        const selectionIndex = {
          start: offsetToIndex(mathField, selectionOffset.start),
          end: offsetToIndex(mathField, selectionOffset.end),
        };
        const selectedText = rawValue.slice(selectionIndex.start, selectionIndex.end);
        const seed = selectedText.length > 0 ? selectedText : "\\,";
        const replacement = key.latex.replace(/#\?/g, seed);
        const nextText =
          rawValue.slice(0, selectionIndex.start) +
          replacement +
          rawValue.slice(selectionIndex.end);
        writeMathFieldValue(mathField, nextText);

        const slotPrefix = key.latex.split("#?")[0] ?? "";
        const slotStartIndex = selectionIndex.start + slotPrefix.length;
        const slotEndIndex = slotStartIndex + seed.length;
        const slotStartOffset = indexToOffset(mathField, slotStartIndex);
        const slotEndOffset = indexToOffset(mathField, slotEndIndex);
        if (selectedText.length === 0) {
          setSelectionRange(
            mathField as MathFieldPlaceholderApi,
            slotStartOffset,
            slotEndOffset
          );
        } else {
          setSelectionRange(
            mathField as MathFieldPlaceholderApi,
            slotEndOffset,
            slotEndOffset
          );
        }
        mathInput.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
    }

    const insertValue = resolveInsertValue(key, false, {
      preserveTemplateMarkers: true,
    });
    const fallbackInsertValue = resolveInsertValue(key, false);
    if (!insertValue && !fallbackInsertValue) {
      return;
    }

    const hasTemplateMarkers =
      typeof key.latex === "string" && key.latex.includes("#?");
    const insertOptions = {
      selectionMode: hasTemplateMarkers ? "placeholder" : "after",
      focus: true,
      feedback: false,
      format: "latex" as const,
    };

    if (typeof mathField.executeCommand === "function") {
      const beforeValue =
        typeof mathField.getValue === "function" ? readMathFieldValue(mathField) : null;
      try {
        const ok = mathField.executeCommand("insert", insertValue, insertOptions);
        const afterValue =
          typeof mathField.getValue === "function" ? readMathFieldValue(mathField) : null;
        const changed =
          typeof beforeValue === "string" &&
          typeof afterValue === "string" &&
          afterValue !== beforeValue;
        if (ok !== false || changed) {
          mathInput.dispatchEvent(new Event("input", { bubbles: true }));
          updateMathPreview();
          return;
        }
      } catch (e) {
        console.warn("executeCommand failed:", e);
      }
    }

    if (typeof mathField.insert === "function") {
      const beforeValue =
        typeof mathField.getValue === "function" ? readMathFieldValue(mathField) : null;
      try {
        mathField.insert(insertValue, insertOptions);
        const afterValue =
          typeof mathField.getValue === "function" ? readMathFieldValue(mathField) : null;
        if (
          typeof beforeValue === "string" &&
          typeof afterValue === "string" &&
          afterValue === beforeValue
        ) {
          throw new Error("insert() completed without content change");
        }
        mathInput.dispatchEvent(new Event("input", { bubbles: true }));
        updateMathPreview();
        return;
      } catch {
        // ignore and continue fallback
      }
    }

    console.warn(
      "mathfield insertion failed; skipping unsafe fallback append",
      key.latex,
      fallbackInsertValue
    );
  };

  mathWysiwygApi = initMathWysiwyg({
    container: blockMathInputContainer instanceof HTMLElement ? blockMathInputContainer : null,
    insertKey: (key) => insertMathKey(key),
    autoSuggest: mathWysiwygSettings.autoSuggest,
    enabledPacks: mathWysiwygSettings.enabledPacks,
    getMruStorageKey: () => {
      const rootKey = deps.getWorkspaceRootKey?.();
      return rootKey ? `tex64.math-wysiwyg.mru.${rootKey}` : "tex64.math-wysiwyg.mru";
    },
  });

  const setBlockSettingsPage = (page: BlockSettingsPage) => {
    activeBlockSettingsPage = page;
    if (Array.isArray(blockSettingsPages)) {
      blockSettingsPages.forEach((view) => {
        const isActive = view.dataset.blockSettingsPage === page;
        view.classList.toggle("is-active", isActive);
      });
    }
  };

  const setBlockSettingsOpen = (open: boolean) => {
    blockSettingsOpen = open;
    if (blockSettingsModal instanceof HTMLElement) {
      blockSettingsModal.classList.toggle("is-open", open);
      blockSettingsModal.setAttribute("aria-hidden", open ? "false" : "true");
    }
    if (blockSettingsButton instanceof HTMLElement) {
      blockSettingsButton.setAttribute("aria-expanded", open ? "true" : "false");
    }
    if (open) {
      setBlockSettingsPage("menu");
    }
  };

  if (blockSettingsButton instanceof HTMLButtonElement) {
    blockSettingsButton.addEventListener("click", () => {
      setBlockSettingsOpen(!blockSettingsOpen);
    });
  }

  if (blockCaptureButton instanceof HTMLButtonElement) {
    blockCaptureButton.addEventListener("click", () => {
      deps.onMathCaptureRequest?.();
    });
  }

  if (blockSettingsClose instanceof HTMLButtonElement) {
    blockSettingsClose.addEventListener("click", () => {
      setBlockSettingsOpen(false);
    });
  }

  if (blockSettingsModal instanceof HTMLElement) {
    blockSettingsModal.addEventListener("click", (event) => {
      if (event.target === blockSettingsModal) {
        setBlockSettingsOpen(false);
      }
    });
  }

  if (Array.isArray(blockSettingsMenuItems)) {
    blockSettingsMenuItems.forEach((item) => {
      item.addEventListener("click", () => {
        const target = item.dataset.blockSettingsTarget;
        if (target === "insert-format") {
          setBlockSettingsPage("insert-format");
        } else if (target === "suggestions") {
          setBlockSettingsPage("suggestions");
        }
      });
    });
  }

  if (Array.isArray(blockSettingsBackButtons)) {
    blockSettingsBackButtons.forEach((button) => {
      button.addEventListener("click", () => {
        setBlockSettingsPage("menu");
      });
    });
  }

  if (Array.isArray(blockSettingsInlineOptions)) {
    blockSettingsInlineOptions.forEach((option) => {
      option.addEventListener("click", () => {
        const next = option.dataset.inlineFormat as MathInlineWrap | undefined;
        if (!next) {
          return;
        }
        setMathInlineWrap(next);
      });
    });
  }

  if (Array.isArray(blockSettingsDisplayOptions)) {
    blockSettingsDisplayOptions.forEach((option) => {
      option.addEventListener("click", () => {
        const next = option.dataset.displayFormat as MathDisplayWrap | undefined;
        if (!next) {
          return;
        }
        setMathDisplayWrap(next);
      });
    });
  }

  if (Array.isArray(wysiwygAutoOptions)) {
    wysiwygAutoOptions.forEach((option) => {
      option.addEventListener("click", () => {
        const value = option.dataset.wysiwygAuto;
        if (value === "on") {
          setMathWysiwygAutoSuggest(true);
        } else if (value === "off") {
          setMathWysiwygAutoSuggest(false);
        }
      });
    });
  }

  if (Array.isArray(wysiwygPackOptions)) {
    wysiwygPackOptions.forEach((option) => {
      option.addEventListener("click", () => {
        const packId = option.dataset.wysiwygPack;
        if (!packId) {
          return;
        }
        toggleMathWysiwygPack(packId);
      });
    });
  }

  if (blockFormatButton instanceof HTMLButtonElement) {
    blockFormatButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setFormatMenuOpen(!formatMenuOpen);
    });
  }

  if (blockFormatMenu instanceof HTMLElement) {
    blockFormatMenu.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(
        ".block-format-option"
      );
      if (!target) {
        return;
      }
      const nextFormat = target.dataset.format;
      if (!nextFormat) {
        return;
      }
      setMathInsertMode(nextFormat as MathInsertMode);
      setFormatMenuOpen(false);
    });
  }

  document.addEventListener("click", (event) => {
    if (!formatMenuOpen) {
      return;
    }
    const target = event.target as Node;
    if (blockFormatButton?.contains(target) || blockFormatMenu?.contains(target)) {
      return;
    }
    setFormatMenuOpen(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    if (blockSettingsOpen) {
      setBlockSettingsOpen(false);
      return;
    }
    if (formatMenuOpen) {
      setFormatMenuOpen(false);
    }
  });

  applyMathInsertSettings();
  applyMathWysiwygSettings();

  return {
    getActiveBlockType: () => activeBlockType,
    setActiveBlockType,
    setMathKeyboardVisibilityHandler,
    getMathInputValue,
    setMathInputValue,
    getBlockDraft,
    insertMathKey,
    setMathInputElement,
    setMathInputFallback,
    getMathInputFallback,
    isMathInputFocused,
    attachMathInputListener,
    attachMathFieldEvents,
    updateMathPreview,
  };
};
