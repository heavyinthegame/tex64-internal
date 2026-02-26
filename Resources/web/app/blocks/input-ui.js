import { reconstructionBlock } from "./context.js";
import { PLACEHOLDER_LATEX, applyScriptToText, applyTemplateToText, getMathFieldSelectionRange, indexToOffset, offsetToIndex, } from "./math-input-utils.js";
import { initMathWysiwyg, } from "../../math/wysiwyg/math-wysiwyg.js";
import { DEFAULT_WYSIWYG_PACKS } from "../../math/wysiwyg/math-wysiwyg-packs.js";
import { closeMathfieldInternalMenu } from "../../math/mathfield-private-adapter.js";
import { readMathFieldValue, setSelectionRange, writeMathFieldValue, } from "./input-ui-math-field.js";
import { normalizeLegacyEnvMarkers, normalizeMatrixSyntax, shouldWrapAligned, stripEmptyAlignedRows, unwrapAligned, wrapAligned, } from "./input-ui-latex-format.js";
import { getFormatLabel, getFormatShortLabel, loadMathInsertSettings, saveMathDisplayWrap, saveMathInlineWrap, saveMathInsertMode, } from "./input-ui-settings.js";
import { ensureMathWysiwygPacks, loadMathWysiwygSettings, saveMathWysiwygAutoSuggest, saveMathWysiwygPacks, } from "./math-wysiwyg-settings.js";
export const initBlockInputUi = (context, deps) => {
    const { blockMathInputContainer, blockSettingsButton, blockCaptureButton, blockSettingsModal, blockSettingsClose, blockSettingsBackButtons, blockSettingsPages, blockSettingsMenuItems, blockSettingsInlineOptions, blockSettingsDisplayOptions, blockFormatButton, blockFormatMenu, blockFormatOptions, blocksPanelBody, } = context.dom;
    const normalizeMathValueForOutput = (value) => {
        const resolved = mathFieldWrapped ? unwrapAligned(value).value : value;
        return normalizeMatrixSyntax(normalizeLegacyEnvMarkers(resolved));
    };
    const prepareMathValueForField = (value) => {
        if (!value) {
            return { value, wrapped: false };
        }
        const normalizedLegacy = normalizeLegacyEnvMarkers(value);
        const wrapped = shouldWrapAligned(normalizedLegacy);
        const withAlignedWrapper = wrapped ? wrapAligned(normalizedLegacy) : normalizedLegacy;
        return { value: withAlignedWrapper, wrapped };
    };
    let activeBlockType = "math";
    let mathInput = null;
    let mathInputFallback = null;
    let currentMathValue = "";
    let mathFieldWrapped = false;
    let mathKeyboardVisibilityHandler = () => { };
    let mathWysiwygApi = null;
    let globalWysiwygKeydownBound = false;
    const attachedMathInputListeners = new WeakSet();
    const TEXTAREA_MATHFIELD_SHIM = Symbol("tex64.textarea-mathfield-shim");
    let mathInsertMode = "inline";
    let mathInlineWrap = "inline-dollar";
    let mathDisplayWrap = "display-bracket";
    let blockSettingsOpen = false;
    let activeBlockSettingsPage = "menu";
    let formatMenuOpen = false;
    const defaultWysiwygSettings = {
        autoSuggest: true,
        enabledPacks: [...DEFAULT_WYSIWYG_PACKS],
    };
    let mathWysiwygSettings = loadMathWysiwygSettings(defaultWysiwygSettings);
    const wysiwygAutoOptions = Array.from(document.querySelectorAll("[data-wysiwyg-auto]"));
    const wysiwygPackOptions = Array.from(document.querySelectorAll("[data-wysiwyg-pack]"));
    const STYLE_WRAPPER_TEMPLATE_RE = /^\\(?:mathbb|mathcal|mathfrak|mathsf|mathrm|mathbf|mathit|mathtt|operatorname)\{#\?\}$/;
    const isPlainBackslashInput = (event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) {
            return false;
        }
        if (event.key === "\\" || event.key === "¥") {
            return true;
        }
        return (event.code === "Backslash" || event.code === "IntlYen" || event.code === "IntlRo");
    };
    const blockDirectLatexCommandInput = (event) => {
        if (!isPlainBackslashInput(event)) {
            return false;
        }
        const tagged = event;
        if (tagged.__tex64BackslashHandled) {
            return true;
        }
        tagged.__tex64BackslashHandled = true;
        event.preventDefault();
        event.stopImmediatePropagation();
        const opened = Boolean(mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.openExplicitSuggestions());
        if (!opened) {
            mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.close();
        }
        return true;
    };
    const setFormatMenuOpen = (open) => {
        formatMenuOpen = open;
        if (blockFormatMenu instanceof HTMLElement) {
            blockFormatMenu.classList.toggle("is-open", open);
            blockFormatMenu.setAttribute("aria-hidden", open ? "false" : "true");
        }
        if (blockFormatButton instanceof HTMLElement) {
            blockFormatButton.setAttribute("aria-expanded", open ? "true" : "false");
        }
    };
    const setMathInsertMode = (value) => {
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
    const setMathInlineWrap = (value) => {
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
    const setMathDisplayWrap = (value) => {
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
        mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.updateConfig({
            autoSuggest: mathWysiwygSettings.autoSuggest,
            enabledPacks: mathWysiwygSettings.enabledPacks,
        });
    };
    const setMathWysiwygAutoSuggest = (value) => {
        mathWysiwygSettings = {
            ...mathWysiwygSettings,
            autoSuggest: value,
        };
        saveMathWysiwygAutoSuggest(value);
        applyMathWysiwygSettings();
    };
    const toggleMathWysiwygPack = (packId) => {
        const next = new Set(mathWysiwygSettings.enabledPacks);
        if (next.has(packId)) {
            next.delete(packId);
        }
        else {
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
    const setMathKeyboardVisibilityHandler = (handler) => {
        mathKeyboardVisibilityHandler = handler;
    };
    const setActiveBlockType = (type) => {
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
    const decorateTextareaAsMathfield = (textarea) => {
        const shimmed = textarea;
        if (shimmed[TEXTAREA_MATHFIELD_SHIM]) {
            return;
        }
        Object.defineProperty(shimmed, TEXTAREA_MATHFIELD_SHIM, {
            value: true,
            configurable: false,
            writable: false,
            enumerable: false,
        });
        const clamp = (value) => {
            const length = textarea.value.length;
            if (!Number.isFinite(value)) {
                return length;
            }
            return Math.max(0, Math.min(length, Math.trunc(value)));
        };
        const readSelectionStart = () => typeof textarea.selectionStart === "number" ? textarea.selectionStart : textarea.value.length;
        const readSelectionEnd = () => typeof textarea.selectionEnd === "number" ? textarea.selectionEnd : textarea.value.length;
        const setSelection = (start, end) => {
            const safeStart = clamp(start);
            const safeEnd = clamp(end);
            textarea.setSelectionRange(safeStart, safeEnd);
        };
        if (typeof shimmed.getValue !== "function") {
            Object.defineProperty(shimmed, "getValue", {
                configurable: true,
                value: (...args) => {
                    if (args.length === 1 && args[0] === "latex") {
                        return textarea.value;
                    }
                    if (args.length >= 3 &&
                        typeof args[0] === "number" &&
                        typeof args[1] === "number" &&
                        args[2] === "latex") {
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
            set: (value) => {
                if (Array.isArray(value) && value.length >= 2) {
                    const start = Number(value[0]);
                    const end = Number(value[1]);
                    if (Number.isFinite(start) && Number.isFinite(end)) {
                        setSelection(start, end);
                    }
                    return;
                }
                if (value &&
                    typeof value === "object" &&
                    "ranges" in value &&
                    Array.isArray(value.ranges)) {
                    const first = value.ranges[0];
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
            set: (value) => {
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
    const setMathInputElement = (element) => {
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
        const resolvedValue = mathInput instanceof HTMLTextAreaElement
            ? { value: currentMathValue, wrapped: false }
            : prepareMathValueForField(currentMathValue);
        if (mathInput instanceof HTMLTextAreaElement) {
            mathInput.value = resolvedValue.value;
            attachMathInputListener();
            return;
        }
        mathFieldWrapped = resolvedValue.wrapped;
        writeMathFieldValue(mathInput, resolvedValue.value);
    };
    const setMathInputFallback = (value) => {
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
            const rawValue = readMathFieldValue(mathInput);
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
        const value = mathInput.value;
        return typeof value === "string" ? normalizeLegacyEnvMarkers(value) : "";
    };
    const setMathInputValue = (value) => {
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
        writeMathFieldValue(mathInput, preparedValue.value);
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
            mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.attach(inputElement);
        }
        inputElement.addEventListener("input", () => {
            if (inputElement instanceof HTMLTextAreaElement) {
                mathFieldWrapped = false;
                currentMathValue = inputElement.value;
                return;
            }
            mathFieldWrapped = false;
            const value = inputElement.value;
            currentMathValue = typeof value === "string" ? value : "";
        });
        if (inputElement instanceof HTMLTextAreaElement) {
            const textArea = inputElement;
            textArea.addEventListener("keydown", (event) => {
                if (mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.handleKeydown(event)) {
                    event.stopImmediatePropagation();
                    return;
                }
                if (blockDirectLatexCommandInput(event)) {
                    return;
                }
                if (event.isComposing) {
                    return;
                }
                const isSuggestShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && event.key === ".";
                if (isSuggestShortcut) {
                    const opened = Boolean(mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.openExplicitSuggestions());
                    if (opened) {
                        event.preventDefault();
                        event.stopImmediatePropagation();
                    }
                    return;
                }
                if (event.key === "Escape") {
                    mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.close();
                    return;
                }
            });
            textArea.addEventListener("focus", () => {
                mathKeyboardVisibilityHandler();
                textArea.classList.add("is-focused");
            });
            textArea.addEventListener("blur", () => {
                textArea.classList.remove("is-focused");
                mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.close();
            });
            textArea.addEventListener("compositionstart", (event) => {
                event.stopPropagation();
                mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.setComposing(true);
            });
            textArea.addEventListener("compositionend", (event) => {
                event.stopPropagation();
                mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.setComposing(false);
            });
            textArea.addEventListener("click", () => {
                // Keep fallback suggestions in sync with caret movement.
            });
            textArea.addEventListener("keyup", () => {
                // Auto updates are handled by math-wysiwyg listeners attached above.
            });
        }
    };
    const attachMathFieldEvents = (mathfield) => {
        const closeMathFieldMenu = () => {
            if (closeMathfieldInternalMenu(mathfield)) {
                return;
            }
            const executeCommand = mathfield
                .executeCommand;
            if (typeof executeCommand === "function") {
                const menuElement = document.querySelector("menu.ui-menu-container");
                if (menuElement) {
                    executeCommand.call(mathfield, "toggleContextMenu");
                }
            }
        };
        const closeWysiwygSuggestions = () => {
            mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.close();
        };
        const readMathFieldLatex = (target, ...args) => {
            if (typeof target.getValue !== "function") {
                return null;
            }
            try {
                const value = target.getValue(...args);
                return typeof value === "string" ? value : null;
            }
            catch {
                return null;
            }
        };
        const syncMathFieldValue = () => {
            const rawValue = normalizeLegacyEnvMarkers(readMathFieldValue(mathfield));
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
        const applyStructuredInput = (key) => {
            var _a;
            if (key !== "^" && key !== "_") {
                return false;
            }
            const mathfieldApi = mathfield;
            const insertValue = key === "^" ? `^{${PLACEHOLDER_LATEX}}` : `_{${PLACEHOLDER_LATEX}}`;
            const insertOptions = {
                selectionMode: "placeholder",
                focus: true,
                feedback: false,
                format: "latex",
            };
            try {
                (_a = mathfieldApi.focus) === null || _a === void 0 ? void 0 : _a.call(mathfieldApi);
                if (typeof mathfieldApi.insert === "function") {
                    mathfieldApi.insert(insertValue, insertOptions);
                    if (typeof mathfieldApi.executeCommand === "function") {
                        try {
                            mathfieldApi.executeCommand("moveToPreviousPlaceholder");
                        }
                        catch {
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
                    const changed = typeof beforeValue === "string" &&
                        typeof afterValue === "string" &&
                        afterValue !== beforeValue;
                    if (ok !== false || changed) {
                        mathfield.dispatchEvent(new Event("input", { bubbles: true }));
                        return true;
                    }
                }
            }
            catch {
                // ignore
            }
            return false;
        };
        const tryWrapSelectionWithFraction = () => {
            var _a;
            const mathfieldApi = mathfield;
            if (typeof mathfieldApi.getValue !== "function") {
                return false;
            }
            const selection = getMathFieldSelectionRange(mathfieldApi);
            if (selection.start === selection.end) {
                return false;
            }
            const selectedLatex = readMathFieldLatex(mathfieldApi, selection.start, selection.end, "latex");
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
            (_a = mathfieldApi.focus) === null || _a === void 0 ? void 0 : _a.call(mathfieldApi);
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
        const findMatrixEnvironment = (latex, cursorIndex) => {
            const tokenRegex = /\\(begin|end)\{([A-Za-z*]+)\}/g;
            const stack = [];
            let match = null;
            let found = null;
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
        const splitRows = (body) => {
            const isEscapedAt = (text, index) => {
                let count = 0;
                for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
                    count += 1;
                }
                return count % 2 === 1;
            };
            const readEnvironmentTokenAt = (text, index) => {
                if (text[index] !== "\\") {
                    return null;
                }
                const match = /^\\(begin|end)\{([A-Za-z*]+)\}/.exec(text.slice(index));
                if (!match) {
                    return null;
                }
                return {
                    kind: match[1],
                    name: match[2],
                    length: match[0].length,
                };
            };
            const state = {
                braceDepth: 0,
                bracketDepth: 0,
                envStack: [],
            };
            const isTopLevel = () => state.braceDepth === 0 &&
                state.bracketDepth === 0 &&
                state.envStack.length === 0;
            const consumeStructuralToken = (text, index) => {
                const envToken = readEnvironmentTokenAt(text, index);
                if (envToken) {
                    if (envToken.kind === "begin") {
                        state.envStack.push(envToken.name);
                    }
                    else {
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
                }
                else if (ch === "}" && !isEscapedAt(text, index)) {
                    state.braceDepth = Math.max(0, state.braceDepth - 1);
                }
                else if (ch === "[" && !isEscapedAt(text, index)) {
                    state.bracketDepth += 1;
                }
                else if (ch === "]" && !isEscapedAt(text, index)) {
                    state.bracketDepth = Math.max(0, state.bracketDepth - 1);
                }
                return index;
            };
            const rows = [];
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
        const splitCells = (rowText) => {
            const isEscapedAt = (text, index) => {
                let count = 0;
                for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
                    count += 1;
                }
                return count % 2 === 1;
            };
            const readEnvironmentTokenAt = (text, index) => {
                if (text[index] !== "\\") {
                    return null;
                }
                const match = /^\\(begin|end)\{([A-Za-z*]+)\}/.exec(text.slice(index));
                if (!match) {
                    return null;
                }
                return {
                    kind: match[1],
                    name: match[2],
                    length: match[0].length,
                };
            };
            const state = {
                braceDepth: 0,
                bracketDepth: 0,
                envStack: [],
            };
            const isTopLevel = () => state.braceDepth === 0 &&
                state.bracketDepth === 0 &&
                state.envStack.length === 0;
            const consumeStructuralToken = (text, index) => {
                const envToken = readEnvironmentTokenAt(text, index);
                if (envToken) {
                    if (envToken.kind === "begin") {
                        state.envStack.push(envToken.name);
                    }
                    else {
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
                }
                else if (ch === "}" && !isEscapedAt(text, index)) {
                    state.braceDepth = Math.max(0, state.braceDepth - 1);
                }
                else if (ch === "[" && !isEscapedAt(text, index)) {
                    state.bracketDepth += 1;
                }
                else if (ch === "]" && !isEscapedAt(text, index)) {
                    state.bracketDepth = Math.max(0, state.bracketDepth - 1);
                }
                return index;
            };
            const cells = [];
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
        const rebuildMatrixBody = (rows, selectionTarget) => {
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
        const tryApplyMatrixEdit = (mode) => {
            var _a;
            const mathfieldApi = mathfield;
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
            let rowIndex = parsedRows.findIndex((row) => cursorInBody >= row.start && cursorInBody <= row.end);
            if (rowIndex < 0) {
                rowIndex = Math.max(0, parsedRows.length - 1);
            }
            const row = parsedRows[rowIndex];
            const cursorInRow = cursorInBody - row.start;
            let colIndex = row.cells.findIndex((cell) => cursorInRow >= cell.start && cursorInRow <= cell.end);
            if (colIndex < 0) {
                colIndex = Math.max(0, row.cells.length - 1);
            }
            const colCount = Math.max(1, ...parsedRows.map((entry) => Math.max(1, entry.cells.length)));
            let nextRows = parsedRows.map((entry) => entry.cells.map((cell) => cell.text));
            let selectionTarget = null;
            if (mode === "row") {
                const newRow = Array.from({ length: colCount }, () => PLACEHOLDER_LATEX);
                const insertAt = Math.min(rowIndex + 1, nextRows.length);
                nextRows = [
                    ...nextRows.slice(0, insertAt),
                    newRow,
                    ...nextRows.slice(insertAt),
                ];
                selectionTarget = { row: insertAt, col: 0 };
            }
            else {
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
            (_a = mathfieldApi.focus) === null || _a === void 0 ? void 0 : _a.call(mathfieldApi);
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
                    const changed = typeof beforeValue === "string" &&
                        typeof afterValue === "string" &&
                        afterValue !== beforeValue;
                    replaced = ok !== false || changed;
                }
                catch {
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
        const stripPlaceholderAndWhitespace = (value) => value.replace(/\\placeholder\{\}/g, "").replace(/\s+/g, "");
        const extractSingleEnvironmentInner = (value) => {
            const match = value.match(/^\\begin\{([A-Za-z*]+)\}([\s\S]*)\\end\{\1\}$/);
            return match ? match[2] : value;
        };
        const isRowInsertionStable = (before, after) => {
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
            const mathfieldApi = mathfield;
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
            const applyCommand = (command) => (mf) => {
                var _a;
                if (typeof mf.executeCommand !== "function") {
                    return;
                }
                try {
                    const ok = Boolean(mf.executeCommand(command));
                    if (ok) {
                        (_a = mf.dispatchEvent) === null || _a === void 0 ? void 0 : _a.call(mf, new Event("input", { bubbles: true }));
                    }
                }
                catch {
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
        const handleMathFieldKeydown = (event) => {
            var _a;
            if (event.isComposing) {
                return;
            }
            if (mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.handleKeydown(event)) {
                event.stopImmediatePropagation();
                return;
            }
            if (blockDirectLatexCommandInput(event)) {
                return;
            }
            if (event.key === "/" &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.altKey &&
                !event.shiftKey) {
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
                const mathfieldApi = mathfield;
                if (!event.metaKey && !event.ctrlKey) {
                    let handled = tryInsertMatrixRow();
                    if (!handled && typeof mathfieldApi.executeCommand === "function") {
                        const before = readMathFieldLatex(mathfieldApi, "latex");
                        try {
                            const ok = mathfieldApi.executeCommand("addRowAfter");
                            const after = readMathFieldLatex(mathfieldApi, "latex");
                            const changed = typeof before === "string" &&
                                typeof after === "string" &&
                                after !== before;
                            if (ok !== false || changed) {
                                handled = changed
                                    ? isRowInsertionStable(before !== null && before !== void 0 ? before : "", after !== null && after !== void 0 ? after : "")
                                    : Boolean(ok);
                                if (!handled) {
                                    try {
                                        mathfieldApi.executeCommand("undo");
                                    }
                                    catch {
                                        // ignore undo failure
                                    }
                                }
                            }
                        }
                        catch {
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
                                }
                                catch {
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
                                }
                                catch {
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
                }
                else {
                    let handled = false;
                    if (typeof mathfieldApi.executeCommand === "function") {
                        const before = readMathFieldLatex(mathfieldApi, "latex");
                        try {
                            const ok = mathfieldApi.executeCommand("addColumnAfter");
                            const after = readMathFieldLatex(mathfieldApi, "latex");
                            const changed = typeof before === "string" &&
                                typeof after === "string" &&
                                after !== before;
                            if (ok !== false || changed) {
                                handled = changed ? true : Boolean(ok);
                            }
                        }
                        catch {
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
                    (_a = deps.onMathFieldSubmit) === null || _a === void 0 ? void 0 : _a.call(deps);
                    return;
                }
            }
            if (event.defaultPrevented) {
                return;
            }
        };
        mathfield.addEventListener("keydown", handleMathFieldKeydown, { capture: true });
        const shadowRoot = mathfield.shadowRoot;
        if (shadowRoot) {
            shadowRoot.addEventListener("keydown", handleMathFieldKeydown, { capture: true });
        }
        // When the suggestion panel is open, intercept keydown at the document capture phase.
        // This keeps navigation keys for the panel even when other parts of the app listen to keys.
        if (!globalWysiwygKeydownBound) {
            globalWysiwygKeydownBound = true;
            document.addEventListener("keydown", (event) => {
                if (!mathWysiwygApi) {
                    return;
                }
                if (mathWysiwygApi.handleKeydown(event)) {
                    event.stopImmediatePropagation();
                }
            }, { capture: true });
        }
        mathfield.addEventListener("keydown", (e) => {
            if (mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.handleKeydown(e)) {
                return;
            }
            if (blockDirectLatexCommandInput(e)) {
                return;
            }
            if (e.isComposing) {
                return;
            }
            if (!e.metaKey && !e.altKey && e.ctrlKey && e.key === ".") {
                const opened = Boolean(mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.openExplicitSuggestions());
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
            mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.setComposing(true);
        });
        mathfield.addEventListener("compositionend", (e) => {
            e.stopPropagation();
            mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.setComposing(false);
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
        mathWysiwygApi === null || mathWysiwygApi === void 0 ? void 0 : mathWysiwygApi.attach(mathfield);
    };
    const buildMathSnippet = (formula) => {
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
    const getBlockDraft = () => {
        const formula = getMathInputValue();
        const normalizedFormula = normalizeMathValueForOutput(formula);
        const snippet = buildMathSnippet(normalizedFormula);
        if (!snippet.trim()) {
            return null;
        }
        return { snippet, content: { formula: normalizedFormula.trim() } };
    };
    const resolveInsertValue = (key, isTextArea, options) => {
        const source = isTextArea && key.fallback ? key.fallback : key.latex;
        if (!isTextArea && (options === null || options === void 0 ? void 0 : options.preserveTemplateMarkers)) {
            return source;
        }
        const placeholder = isTextArea ? "" : PLACEHOLDER_LATEX;
        return source.replace(/#\?/g, placeholder);
    };
    const insertMathKey = (key) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
        if (!mathInput) {
            return;
        }
        const isTextArea = mathInput instanceof HTMLTextAreaElement;
        const placeholder = isTextArea ? "" : PLACEHOLDER_LATEX;
        const scriptKind = key.scriptKind;
        const templateKind = key.templateKind;
        if (mathInput instanceof HTMLTextAreaElement) {
            const textArea = mathInput;
            const start = (_a = textArea.selectionStart) !== null && _a !== void 0 ? _a : textArea.value.length;
            const end = (_b = textArea.selectionEnd) !== null && _b !== void 0 ? _b : textArea.value.length;
            const selection = { start, end };
            if (scriptKind) {
                const result = applyScriptToText(textArea.value, selection, scriptKind, {
                    placeholder,
                    base: (_c = key.scriptBase) !== null && _c !== void 0 ? _c : null,
                    subValue: scriptKind === "sub"
                        ? (_d = key.scriptValue) !== null && _d !== void 0 ? _d : null
                        : (_e = key.scriptSubValue) !== null && _e !== void 0 ? _e : null,
                    supValue: scriptKind === "sup"
                        ? (_f = key.scriptValue) !== null && _f !== void 0 ? _f : null
                        : (_g = key.scriptSupValue) !== null && _g !== void 0 ? _g : null,
                });
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
        const mathField = mathInput;
        (_h = mathField.focus) === null || _h === void 0 ? void 0 : _h.call(mathField);
        const applyMathFieldTextEdit = (next) => {
            writeMathFieldValue(mathField, next.text);
            const startOffset = indexToOffset(mathField, next.selectionStart);
            const endOffset = indexToOffset(mathField, next.selectionEnd);
            setSelectionRange(mathField, startOffset, endOffset);
            mathInput.dispatchEvent(new Event("input", { bubbles: true }));
        };
        if ((scriptKind || templateKind) &&
            typeof mathField.getValue === "function") {
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
                        base: (_j = key.scriptBase) !== null && _j !== void 0 ? _j : null,
                        subValue: scriptKind === "sub"
                            ? (_k = key.scriptValue) !== null && _k !== void 0 ? _k : null
                            : (_l = key.scriptSubValue) !== null && _l !== void 0 ? _l : null,
                        supValue: scriptKind === "sup"
                            ? (_m = key.scriptValue) !== null && _m !== void 0 ? _m : null
                            : (_o = key.scriptSupValue) !== null && _o !== void 0 ? _o : null,
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
        if (!scriptKind &&
            !templateKind &&
            typeof mathField.getValue === "function" &&
            STYLE_WRAPPER_TEMPLATE_RE.test(key.latex)) {
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
                const nextText = rawValue.slice(0, selectionIndex.start) +
                    replacement +
                    rawValue.slice(selectionIndex.end);
                writeMathFieldValue(mathField, nextText);
                const slotPrefix = (_p = key.latex.split("#?")[0]) !== null && _p !== void 0 ? _p : "";
                const slotStartIndex = selectionIndex.start + slotPrefix.length;
                const slotEndIndex = slotStartIndex + seed.length;
                const slotStartOffset = indexToOffset(mathField, slotStartIndex);
                const slotEndOffset = indexToOffset(mathField, slotEndIndex);
                if (selectedText.length === 0) {
                    setSelectionRange(mathField, slotStartOffset, slotEndOffset);
                }
                else {
                    setSelectionRange(mathField, slotEndOffset, slotEndOffset);
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
        const hasTemplateMarkers = typeof key.latex === "string" && key.latex.includes("#?");
        const insertOptions = {
            selectionMode: hasTemplateMarkers ? "placeholder" : "after",
            focus: true,
            feedback: false,
            format: "latex",
        };
        if (typeof mathField.executeCommand === "function") {
            const beforeValue = typeof mathField.getValue === "function" ? readMathFieldValue(mathField) : null;
            try {
                const ok = mathField.executeCommand("insert", insertValue, insertOptions);
                const afterValue = typeof mathField.getValue === "function" ? readMathFieldValue(mathField) : null;
                const changed = typeof beforeValue === "string" &&
                    typeof afterValue === "string" &&
                    afterValue !== beforeValue;
                if (ok !== false || changed) {
                    mathInput.dispatchEvent(new Event("input", { bubbles: true }));
                    updateMathPreview();
                    return;
                }
            }
            catch (e) {
                console.warn("executeCommand failed:", e);
            }
        }
        if (typeof mathField.insert === "function") {
            const beforeValue = typeof mathField.getValue === "function" ? readMathFieldValue(mathField) : null;
            try {
                mathField.insert(insertValue, insertOptions);
                const afterValue = typeof mathField.getValue === "function" ? readMathFieldValue(mathField) : null;
                if (typeof beforeValue === "string" &&
                    typeof afterValue === "string" &&
                    afterValue === beforeValue) {
                    throw new Error("insert() completed without content change");
                }
                mathInput.dispatchEvent(new Event("input", { bubbles: true }));
                updateMathPreview();
                return;
            }
            catch {
                // ignore and continue fallback
            }
        }
        console.warn("mathfield insertion failed; skipping unsafe fallback append", key.latex, fallbackInsertValue);
    };
    mathWysiwygApi = initMathWysiwyg({
        container: blockMathInputContainer instanceof HTMLElement ? blockMathInputContainer : null,
        insertKey: (key) => insertMathKey(key),
        autoSuggest: mathWysiwygSettings.autoSuggest,
        enabledPacks: mathWysiwygSettings.enabledPacks,
        getMruStorageKey: () => {
            var _a;
            const rootKey = (_a = deps.getWorkspaceRootKey) === null || _a === void 0 ? void 0 : _a.call(deps);
            return rootKey ? `tex64.math-wysiwyg.mru.${rootKey}` : "tex64.math-wysiwyg.mru";
        },
    });
    const setBlockSettingsPage = (page) => {
        activeBlockSettingsPage = page;
        if (Array.isArray(blockSettingsPages)) {
            blockSettingsPages.forEach((view) => {
                const isActive = view.dataset.blockSettingsPage === page;
                view.classList.toggle("is-active", isActive);
            });
        }
    };
    const setBlockSettingsOpen = (open) => {
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
            var _a;
            (_a = deps.onMathCaptureRequest) === null || _a === void 0 ? void 0 : _a.call(deps);
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
                }
                else if (target === "suggestions") {
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
                const next = option.dataset.inlineFormat;
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
                const next = option.dataset.displayFormat;
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
                }
                else if (value === "off") {
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
            var _a;
            const target = (_a = event.target) === null || _a === void 0 ? void 0 : _a.closest(".block-format-option");
            if (!target) {
                return;
            }
            const nextFormat = target.dataset.format;
            if (!nextFormat) {
                return;
            }
            setMathInsertMode(nextFormat);
            setFormatMenuOpen(false);
        });
    }
    document.addEventListener("click", (event) => {
        if (!formatMenuOpen) {
            return;
        }
        const target = event.target;
        if ((blockFormatButton === null || blockFormatButton === void 0 ? void 0 : blockFormatButton.contains(target)) || (blockFormatMenu === null || blockFormatMenu === void 0 ? void 0 : blockFormatMenu.contains(target))) {
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
