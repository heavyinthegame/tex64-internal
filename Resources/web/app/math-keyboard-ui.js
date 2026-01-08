import { mathKeyboardFixedKeys, mathKeyboardSets } from "./math-keyboard.js";
export const initMathKeyboard = (context, deps) => {
    const { mathKeyboardDock, mathKeyboardGrid, mathKeyboardFixedGrid, mathKeyboardShiftButton, mathKeyboardTabs, } = context.dom;
    let activeTab = "analysis";
    let shiftHeld = false;
    let shiftLocked = false;
    let mathLiveReady = false;
    let mathLiveCheckScheduled = false;
    let mathKeyboardNeedsRerender = false;
    const normalizeMathKeyboardTab = (tab) => {
        if (tab === "analysis" ||
            tab === "algebra" ||
            tab === "sets" ||
            tab === "logic" ||
            tab === "arrows" ||
            tab === "greek") {
            return tab;
        }
        return "analysis";
    };
    const isMathKeyboardShiftActive = () => shiftHeld || shiftLocked;
    const markMathLiveReady = () => {
        if (mathLiveReady) {
            return;
        }
        mathLiveReady = true;
        mathLiveCheckScheduled = false;
        if (mathKeyboardNeedsRerender) {
            renderMathKeyboard(activeTab);
            renderMathKeyboardFixed();
            mathKeyboardNeedsRerender = false;
        }
    };
    const ensureMathLiveReady = () => {
        if (mathLiveReady || mathLiveCheckScheduled) {
            return;
        }
        mathLiveCheckScheduled = true;
        const check = () => {
            if (mathLiveReady) {
                return;
            }
            const MathLiveGlobal = window.MathLive;
            if (MathLiveGlobal === null || MathLiveGlobal === void 0 ? void 0 : MathLiveGlobal.convertLatexToMarkup) {
                markMathLiveReady();
                return;
            }
            setTimeout(check, 120);
        };
        check();
        window.addEventListener("mathlive-ready", markMathLiveReady, { once: true });
    };
    const resolveMathKey = (key, shiftActive) => {
        var _a, _b, _c, _d;
        if (!shiftActive) {
            return key;
        }
        const hasShift = key.shiftLabel || key.shiftLatex || key.shiftFallback || key.shiftDisplayLatex;
        if (!hasShift) {
            return key;
        }
        return {
            label: (_a = key.shiftLabel) !== null && _a !== void 0 ? _a : key.label,
            latex: (_b = key.shiftLatex) !== null && _b !== void 0 ? _b : key.latex,
            fallback: (_c = key.shiftFallback) !== null && _c !== void 0 ? _c : key.fallback,
            displayLatex: (_d = key.shiftDisplayLatex) !== null && _d !== void 0 ? _d : key.displayLatex,
        };
    };
    const buildMathKeyDisplayLatex = (key) => {
        var _a, _b;
        const source = (_b = (_a = key.displayLatex) !== null && _a !== void 0 ? _a : key.latex) !== null && _b !== void 0 ? _b : key.fallback;
        if (!source) {
            return null;
        }
        const placeholders = ["x", "y", "z", "a", "b", "c"];
        let index = 0;
        return source.replace(/#\?/g, () => {
            var _a;
            const value = (_a = placeholders[index]) !== null && _a !== void 0 ? _a : "x";
            index += 1;
            return value;
        });
    };
    const renderMathKeyLabel = (button, key) => {
        const MathLiveGlobal = window.MathLive;
        const displayLatex = buildMathKeyDisplayLatex(key);
        if (displayLatex && (MathLiveGlobal === null || MathLiveGlobal === void 0 ? void 0 : MathLiveGlobal.convertLatexToMarkup)) {
            try {
                const latexToRender = `\\displaystyle ${displayLatex}`;
                const wrapper = document.createElement("span");
                wrapper.className = "math-keyboard-math";
                wrapper.innerHTML = MathLiveGlobal.convertLatexToMarkup(latexToRender);
                button.textContent = "";
                button.appendChild(wrapper);
                button.classList.add("has-math");
                button.setAttribute("aria-label", key.label);
                return;
            }
            catch (error) {
                console.warn("MathLive render failed:", error);
            }
        }
        if (displayLatex) {
            mathKeyboardNeedsRerender = true;
            ensureMathLiveReady();
        }
        button.classList.remove("has-math");
        button.textContent = key.label;
        button.removeAttribute("aria-label");
    };
    const renderMathKeyboardKeys = (target, keys) => {
        if (!(target instanceof HTMLElement)) {
            return;
        }
        const shiftActive = isMathKeyboardShiftActive();
        target.innerHTML = "";
        keys.forEach((key) => {
            const resolved = resolveMathKey(key, shiftActive);
            const button = document.createElement("button");
            button.type = "button";
            button.className = "math-keyboard-key";
            renderMathKeyLabel(button, resolved);
            if (!button.classList.contains("has-math")) {
                const labelLength = Array.from(resolved.label).length;
                if (labelLength > 4) {
                    button.classList.add("is-compact");
                }
                if (labelLength > 7) {
                    button.classList.add("is-tiny");
                }
            }
            button.addEventListener("mousedown", (event) => {
                event.preventDefault();
            });
            button.addEventListener("click", () => {
                deps.onInsertKey(resolved);
            });
            target.appendChild(button);
        });
    };
    const renderMathKeyboardFixed = () => {
        renderMathKeyboardKeys(mathKeyboardFixedGrid, mathKeyboardFixedKeys);
    };
    const updateMathKeyboardShiftState = () => {
        const isActive = isMathKeyboardShiftActive();
        if (mathKeyboardShiftButton instanceof HTMLButtonElement) {
            mathKeyboardShiftButton.classList.toggle("is-active", isActive);
            mathKeyboardShiftButton.setAttribute("aria-pressed", isActive ? "true" : "false");
        }
        if (mathKeyboardDock instanceof HTMLElement && mathKeyboardDock.classList.contains("is-open")) {
            renderMathKeyboard(activeTab);
            renderMathKeyboardFixed();
        }
    };
    const updateMathKeyboardVisibility = () => {
        if (!(mathKeyboardDock instanceof HTMLElement)) {
            return;
        }
        const shouldShow = deps.getActiveTab() === "blocks" && deps.getActiveBlockType() === "math";
        mathKeyboardDock.classList.toggle("is-open", shouldShow);
        mathKeyboardDock.setAttribute("aria-hidden", shouldShow ? "false" : "true");
        if (!shouldShow) {
            return;
        }
        if (mathKeyboardGrid instanceof HTMLElement && mathKeyboardGrid.childElementCount === 0) {
            renderMathKeyboard(activeTab);
        }
        if (mathKeyboardFixedGrid instanceof HTMLElement &&
            mathKeyboardFixedGrid.childElementCount === 0) {
            renderMathKeyboardFixed();
        }
        updateMathKeyboardShiftState();
    };
    const renderMathKeyboard = (tab) => {
        var _a;
        const keys = (_a = mathKeyboardSets[tab]) !== null && _a !== void 0 ? _a : [];
        renderMathKeyboardKeys(mathKeyboardGrid, keys);
    };
    const setMathKeyboardTab = (tab) => {
        activeTab = tab;
        mathKeyboardTabs.forEach((button) => {
            const isActive = button.dataset.mathTab === tab;
            button.classList.toggle("is-active", isActive);
            button.setAttribute("aria-selected", isActive ? "true" : "false");
        });
        renderMathKeyboard(tab);
    };
    mathKeyboardTabs.forEach((button) => {
        button.addEventListener("click", () => {
            setMathKeyboardTab(normalizeMathKeyboardTab(button.dataset.mathTab));
        });
    });
    if (mathKeyboardShiftButton instanceof HTMLButtonElement) {
        mathKeyboardShiftButton.addEventListener("click", () => {
            shiftLocked = !shiftLocked;
            updateMathKeyboardShiftState();
        });
    }
    window.addEventListener("blur", () => {
        if (shiftHeld) {
            shiftHeld = false;
            updateMathKeyboardShiftState();
        }
    });
    window.addEventListener("keydown", (event) => {
        if (event.key === "Shift" && !shiftHeld) {
            shiftHeld = true;
            updateMathKeyboardShiftState();
        }
    }, true);
    window.addEventListener("keyup", (event) => {
        if (event.key === "Shift" && shiftHeld) {
            shiftHeld = false;
            updateMathKeyboardShiftState();
        }
    }, true);
    return {
        setTab: setMathKeyboardTab,
        updateVisibility: updateMathKeyboardVisibility,
        markMathLiveReady,
        ensureMathLiveReady,
    };
};
