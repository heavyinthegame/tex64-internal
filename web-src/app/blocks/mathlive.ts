import type { AppContext } from "../context.js";

type MathLiveDeps = {
  onMathFieldCreated: (mathfield: HTMLElement) => void;
  onAttachMathFieldEvents: (mathfield: HTMLElement) => void;
  onMathLiveReady: () => void;
  onEnsureMathLiveReady: () => void;
};

export type MathLiveApi = {
  setupMathField: () => Promise<void>;
};

export const initMathLive = (context: AppContext, deps: MathLiveDeps): MathLiveApi => {
  const { blockMathInputContainer } = context.dom;

  const setupMathField = async () => {
    if (!blockMathInputContainer) {
      console.error("MathLive container not found");
      return;
    }

    if (blockMathInputContainer.querySelector("math-field")) {
      return;
    }

    const MathLiveGlobal = (window as any).MathLive;
    const hasMathLive = !!MathLiveGlobal;
    const hasMathfieldElement = hasMathLive && !!MathLiveGlobal.MathfieldElement;
    const loadError = (window as any).MATHLIVE_LOAD_ERROR;

    if (!customElements.get("math-field")) {
      if (hasMathfieldElement) {
        try {
          customElements.define("math-field", MathLiveGlobal.MathfieldElement);
        } catch {
          // element may already be defined
        }
      }
    }

    if (!customElements.get("math-field")) {
      const debugInfo = `MathLive: ${hasMathLive ? "OK" : "NG"}, MathfieldElement: ${
        hasMathfieldElement ? "OK" : "NG"
      }, LoadError: ${loadError || "none"}`;
      blockMathInputContainer.textContent = `Loading... (${debugInfo})`;
      try {
        await Promise.race([
          customElements.whenDefined("math-field"),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 10000)),
        ]);
        blockMathInputContainer.textContent = "";
      } catch {
        blockMathInputContainer.innerHTML = `
          <div style="font-size:12px;">MathLiveの読み込みに失敗しました。</div>
          <div style="font-size:10px;color:#888;margin-top:4px;">${debugInfo}</div>
        `;
        blockMathInputContainer.style.color = "#ff6b6b";
        return;
      }
    }

    if (MathLiveGlobal?.convertLatexToMarkup) {
      deps.onMathLiveReady();
    } else {
      deps.onEnsureMathLiveReady();
    }

    const mathfield = document.createElement("math-field") as any;
    mathfield.id = "block-math-input";
    mathfield.className = "block-math-field";

    blockMathInputContainer.innerHTML = "";
    blockMathInputContainer.appendChild(mathfield);
    deps.onMathFieldCreated(mathfield);

    if (typeof mathfield.setOptions === "function") {
      mathfield.setOptions({
        smartMode: false,
        defaultMode: "math",
        virtualKeyboardMode: "off",
        fontsDirectory: "mathlive/fonts",
        soundsDirectory: null,
        keypressSound: null,
        plonkSound: null,
        locale: "ja",
      });
    }

    try {
      if ("menuItems" in mathfield) {
        (mathfield as { menuItems?: unknown[] }).menuItems = [];
      }
    } catch {
      // ignore menu configuration failures
    }

    const injectStyles = () => {
      if (!mathfield.shadowRoot) return;
      if (mathfield.shadowRoot.querySelector('style[data-tex180-style]')) return;

      const style = document.createElement("style");
      style.setAttribute("data-tex180-style", "true");
      style.textContent = `
        :host {
          color: var(--text, #eef3fb) !important;
          background-color: transparent !important;
        }
        .ML__field {
          color: var(--text, #eef3fb) !important;
        }
        .ML__placeholder {
          color: #8fb3d4 !important;
          opacity: 0.85;
        }
        .ML__selection {
          background: rgba(110, 195, 255, 0.7) !important;
          color: #f8fbff !important;
        }
        .ML__caret {
          background-color: var(--accent, #5bc2ff) !important;
        }
        .ML__contains-highlight {
          background: rgba(110, 195, 255, 0.25) !important;
        }
        .ML__virtual-keyboard-toggle {
          display: none !important;
        }
        button[part="virtual-keyboard-toggle"] {
          display: none !important;
        }
        .ML__container {
          justify-content: flex-start !important;
          padding-right: 2px !important;
        }
        .ML__content {
          flex: 1 1 auto !important;
          min-width: 0 !important;
        }
        .ML__toggles {
          margin-left: auto !important;
        }
        .ML__menu-toggle {
          margin-right: 0 !important;
          width: 28px !important;
          height: 28px !important;
        }
      `;
      mathfield.shadowRoot.appendChild(style);
    };

    setTimeout(() => {
      injectStyles();
    }, 0);

    deps.onAttachMathFieldEvents(mathfield);
  };

  return { setupMathField };
};
