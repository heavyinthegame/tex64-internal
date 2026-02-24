import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

const sourceWorkspace = path.join(repoRoot, "test-workspace");
const keepWorkspace = process.env.E2E_KEEP_WORKSPACE === "1";
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "50", 10);
const typeDelayMs = Number.parseInt(process.env.E2E_TYPE_DELAY_MS ?? "8", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "8", 10);
const selectAllShortcut = process.platform === "darwin" ? "Meta+A" : "Control+A";
const dumpLatex = process.env.E2E_FAMOUS_DUMP_LATEX === "1";

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[math-wysiwyg-famous-formulas-next50-e2e ${now()}] ${message}`);
};

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const normalizeLatex = (value) => String(value ?? "").replace(/\s+/g, "");

const CANONICAL_SYMBOL_MAP = [
  ["π", "\\pi"],
  ["θ", "\\theta"],
  ["α", "\\alpha"],
  ["β", "\\beta"],
  ["γ", "\\gamma"],
  ["δ", "\\delta"],
  ["λ", "\\lambda"],
  ["μ", "\\mu"],
  ["ρ", "\\rho"],
  ["σ", "\\sigma"],
  ["ω", "\\omega"],
  ["κ", "\\kappa"],
  ["ε", "\\varepsilon"],
  ["η", "\\eta"],
  ["ν", "\\nu"],
  ["φ", "\\phi"],
  ["ϕ", "\\phi"],
  ["ψ", "\\psi"],
  ["ℏ", "\\hbar"],
  ["∇", "\\nabla"],
  ["∂", "\\partial"],
  ["Δ", "\\Delta"],
  ["Λ", "\\Lambda"],
  ["∞", "\\infty"],
  ["Σ", "\\Sigma"],
  ["∫", "\\int"],
  ["∮", "\\oint"],
  ["⋯", "\\cdots"],
  ["√", "\\sqrt"],
  ["→", "\\to"],
  ["×", "\\times"],
  ["·", "\\cdot"],
  ["≤", "\\le"],
  ["≥", "\\ge"],
  ["±", "\\pm"],
  ["≈", "\\approx"],
  ["ℱ", "\\mathcalF"],
];

const canonicalizeFormula = (value) => {
  let text = String(value ?? "");
  CANONICAL_SYMBOL_MAP.forEach(([from, to]) => {
    text = text.split(from).join(to);
  });
  text = text
    .replace(/\s+/g, "")
    .replace(/\\left|\\right/g, "")
    .replace(/\\leq/g, "\\le")
    .replace(/\\geq/g, "\\ge")
    .replace(/\\varphi/g, "\\phi")
    .replace(/\\surd/g, "\\sqrt")
    .replace(/\\thickapprox/g, "\\approx")
    .replace(/\\lbrace/g, "{")
    .replace(/\\rbrace/g, "}")
    .replace(/\\\&/g, "&")
    .replace(/\\prime/g, "'")
    .replace(/\^\{'\}/g, "'")
    .replace(/\^'/g, "'")
    .replace(/\\cos/g, "cos")
    .replace(/\\sin/g, "sin")
    .replace(/\\tan/g, "tan")
    .replace(/\\log/g, "log")
    .replace(/\\ln/g, "ln")
    .replace(/\\exp/g, "exp")
    .replace(/\^\{([A-Za-z0-9]+)\}/g, "^$1")
    .replace(/_\{([A-Za-z0-9]+)\}/g, "_$1")
    .replace(/\^\{\\([A-Za-z]+)\}/g, "^\\$1")
    .replace(/_\{\\([A-Za-z]+)\}/g, "_\\$1")
    .replace(/\^\{\(([^{}]*)\)\}/g, "^($1)");
  return text;
};

const expectedFormulaCandidates = (formula) => {
  const expected = formula.expected ?? formula.input;
  const source = Array.isArray(expected) ? expected : [expected];
  return source.map((value) => canonicalizeFormula(value));
};

const evaluateFormulaMatch = (formula, actualLatex) => {
  const actual = canonicalizeFormula(actualLatex);
  const expected = expectedFormulaCandidates(formula);
  const matched = expected.includes(actual);
  return { matched, actual, expected };
};

const cleanupStaleElectron = () => {
  try {
    execSync(
      `pkill -9 -f "${path.join(
        repoRoot,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
      )}"`,
      { stdio: "ignore" }
    );
  } catch {
    // no stale process
  }
};

const errorMessageIncludes = (error, needle) => {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(needle)) return true;
  const cause = error?.cause;
  if (cause && cause !== error) {
    return errorMessageIncludes(cause, needle);
  }
  return false;
};

const isTransientElectronError = (error) =>
  [
    "Target page, context or browser has been closed",
    "Target closed",
    "Process failed to launch",
    "Browser has been closed",
  ].some((needle) => errorMessageIncludes(error, needle));

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tex64-e2e-math-wysiwyg-famous-formulas-next50-")
  );
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  return { tempDir, workspacePath };
};

const postToBridge = async (page, payload) => {
  await page.evaluate((value) => {
    window.tex64Bridge.postMessage(value);
  }, payload);
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector("body.is-ready", { timeout: 15000 });
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
    timeout: 20000,
  });
};

const openSideTab = async (page, key) => {
  await page.click(`button.tab[data-tab="${key}"]`);
  await page.waitForSelector(`.sidebar-panel .panel.is-active[data-panel="${key}"]`, {
    timeout: 12000,
  });
  await pause(50);
};

const openFile = async (page, filePath) => {
  await postToBridge(page, { type: "openFile", path: filePath });
  await page.waitForSelector(`#editor-tabs-list .editor-tab.is-active[data-path="${filePath}"]`, {
    timeout: 20000,
  });
};

const waitForMathFieldReady = async (page) => {
  await page.waitForFunction(
    () => {
      const field = document.getElementById("block-math-input");
      return Boolean(
        field &&
          field.tagName.toLowerCase() === "math-field" &&
          typeof field.getValue === "function" &&
          field.shadowRoot
      );
    },
    undefined,
    { timeout: 20000 }
  );
};

const focusMathField = async (page) => {
  const field = page.locator("#block-math-input");
  await field.waitFor({ state: "visible", timeout: 10000 });
  await field.click({ timeout: 4000 });
  await page.waitForFunction(() => {
    const active = document.activeElement;
    return active?.id === "block-math-input" || active?.closest?.("#block-math-input");
  });
  await pause(30);
};

const getMathFieldLatex = async (page) =>
  page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    if (field && typeof field.getValue === "function") {
      try {
        return String(field.getValue("latex") ?? "");
      } catch {
        return "";
      }
    }
    return "";
  });

const clearMathField = async (page) => {
  await page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    if (!field || typeof field.setValue !== "function") {
      return;
    }
    try {
      field.setValue("");
    } catch {
      // ignore and fallback to keyboard clear
    }
  });
  if (!normalizeLatex(await getMathFieldLatex(page))) {
    return;
  }
  await focusMathField(page);
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press(selectAllShortcut);
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Delete");
    await pause(20);
    if (!normalizeLatex(await getMathFieldLatex(page))) {
      return;
    }
  }
  assert.equal(normalizeLatex(await getMathFieldLatex(page)), "", "failed to clear math-field");
};

const typeIntoMathField = async (page, formula) => {
  const actions = Array.isArray(formula?.actions)
    ? formula.actions
    : [String(formula?.input ?? formula ?? "")];
  await focusMathField(page);
  for (const action of actions) {
    if (typeof action === "string") {
      for (const char of action) {
        await page.keyboard.insertText(char);
        if (typeDelayMs > 0) {
          await pause(typeDelayMs);
        }
      }
      continue;
    }
    if (action && typeof action.key === "string") {
      await page.keyboard.press(action.key);
      await pause(Math.max(20, typeDelayMs));
    }
  }
  await pause(80);
  if (normalizeLatex(await getMathFieldLatex(page)).length > 0) {
    return;
  }
  const field = page.locator("#block-math-input");
  await field.click({ timeout: 4000 });
  await field.pressSequentially(value, { delay: typeDelayMs });
  await pause(80);
};

const setAutoSuggestOff = async (page) => {
  const offButton = page.locator('[data-wysiwyg-auto="off"]');
  if ((await offButton.count()) <= 0) {
    return;
  }
  const visible = await offButton.first().isVisible().catch(() => false);
  if (!visible) {
    return;
  }
  await offButton.first().click();
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-wysiwyg-auto="off"]');
    return (
      button instanceof HTMLButtonElement &&
      button.getAttribute("aria-pressed") === "true" &&
      button.classList.contains("is-active")
    );
  });
};

const getRenderSnapshot = async (page) =>
  page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    if (!(field instanceof HTMLElement) || field.tagName.toLowerCase() !== "math-field") {
      return null;
    }
    const root = field.shadowRoot;
    if (!(root instanceof ShadowRoot)) {
      return null;
    }
    const visibleRoot = root.querySelector(".ML__latex") ?? root;
    const rawText = (visibleRoot.textContent ?? "").replace(/\s+/g, " ").trim();
    const placeholderCount = root.querySelectorAll(
      ".ML__placeholder, .ML__prompt, .ML__editablePromptBox"
    ).length;
    const errorCount = root.querySelectorAll(".ML__error").length;
    return { rawText, placeholderCount, errorCount };
  });

const assertRenderStable = async (page, label) => {
  const snapshot = await getRenderSnapshot(page);
  assert.ok(snapshot, `${label}: render snapshot is unavailable`);
  assert.equal(snapshot.errorCount, 0, `${label}: render has MathLive error node(s)`);
  assert.equal(snapshot.placeholderCount, 0, `${label}: unresolved placeholder remains`);
  assert.ok(!snapshot.rawText.includes("\\"), `${label}: render still shows raw LaTeX slash`);
};

const assertSemanticTokens = (actualLatex, checks, label) => {
  assert.ok(Array.isArray(checks) && checks.length > 0, `${label}: semantic checks are not configured`);
  checks.forEach((group, index) => {
    const alternatives = Array.isArray(group) ? group : [group];
    const matched = alternatives.some((token) => actualLatex.includes(normalizeLatex(token)));
    assert.ok(
      matched,
      `${label}: semantic token check ${index + 1} failed [${alternatives.join(" | ")}]\nactual=${actualLatex}`
    );
  });
};

const waitForDiffModalState = async (page, open) => {
  await page.waitForFunction(
    (shouldOpen) => {
      const modal = document.getElementById("diff-modal");
      if (!(modal instanceof HTMLElement)) return false;
      return modal.classList.contains("is-open") === shouldOpen;
    },
    open,
    { timeout: 10000 }
  );
};

const waitForBlockMode = async (page, mode) => {
  await page.waitForFunction(
    (expectedMode) => {
      const toggle = document.getElementById("block-mode-toggle");
      if (!(toggle instanceof HTMLButtonElement)) return false;
      return toggle.dataset.blockMode === expectedMode;
    },
    mode,
    { timeout: 10000 }
  );
};

const setBlockMode = async (page, mode) => {
  const current = await page.evaluate(() => {
    const toggle = document.getElementById("block-mode-toggle");
    if (!(toggle instanceof HTMLButtonElement)) return null;
    return toggle.dataset.blockMode ?? null;
  });
  if (current !== mode) {
    await page.click("#block-mode-toggle");
  }
  await waitForBlockMode(page, mode);
};

const setInsertMode = async (page, mode) => {
  await page.click("#block-format-button");
  await page.waitForFunction(() => {
    const menu = document.getElementById("block-format-menu");
    return Boolean(menu instanceof HTMLElement && menu.classList.contains("is-open"));
  });
  await page.click(`.block-format-option[data-format="${mode}"]`);
  await page.waitForFunction(
    (expected) => {
      const option = document.querySelector(`.block-format-option[data-format="${expected}"]`);
      return Boolean(option instanceof HTMLElement && option.classList.contains("is-active"));
    },
    mode,
    { timeout: 5000 }
  );
  await pause(30);
};

const setEditorCursor = async (page, lineNumber, column) => {
  const ok = await page.evaluate(
    ({ targetLine, targetColumn }) => {
      const editors = window.monaco?.editor?.getEditors?.() ?? [];
      const active =
        editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
        editors[0];
      if (!active) return false;
      active.setPosition?.({ lineNumber: targetLine, column: targetColumn });
      active.revealPositionInCenterIfOutsideViewport?.({ lineNumber: targetLine, column: targetColumn });
      active.focus?.();
      return true;
    },
    { targetLine: lineNumber, targetColumn: column }
  );
  assert.equal(ok, true, `failed to set cursor at ${lineNumber}:${column}`);
};

const readActiveEditorValue = async (page) =>
  page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    return String(active?.getModel?.()?.getValue?.() ?? "");
  });

const waitForEditorValueChange = async (page, previousValue, timeout = 4000) => {
  try {
    await page.waitForFunction(
      (before) => {
        const editors = window.monaco?.editor?.getEditors?.() ?? [];
        const active =
          editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
          editors[0];
        const current = String(active?.getModel?.()?.getValue?.() ?? "");
        return current !== String(before ?? "");
      },
      previousValue,
      { timeout }
    );
  } catch {
    // keep deterministic assertion on token insertion below
  }
};

const countOccurrences = (text, needle) => {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (index >= 0) {
    index = text.indexOf(needle, index);
    if (index < 0) break;
    count += 1;
    index += needle.length;
  }
  return count;
};

const assertSnippetTokensInserted = (beforeContent, afterContent, tokens, label) => {
  if (!Array.isArray(tokens) || tokens.length === 0) return;
  tokens.forEach((tokenGroup) => {
    const alternatives = (Array.isArray(tokenGroup) ? tokenGroup : [tokenGroup])
      .map((token) => String(token ?? ""))
      .filter(Boolean);
    assert.ok(alternatives.length > 0, `${label}: invalid snippet token alternatives`);
    const inserted = alternatives.some((token) => {
      const beforeCount = countOccurrences(beforeContent, token);
      const afterCount = countOccurrences(afterContent, token);
      return afterCount > beforeCount;
    });
    assert.ok(
      inserted,
      `${label}: snippet token insertion check failed token=${alternatives.join(" | ")}`
    );
  });
};

const NEXT_50_FORMULAS = [
  {
    name: "Fourier series expansion",
    input: "f(x)=a0/2+Σ(n=1→∞)(an cos(nx)+bn sin(nx))",
    checks: [["\\Sigma", "Σ"], ["cos"], ["sin"], ["\\infty", "∞"]],
  },
  {
    name: "Parseval identity",
    input: "(1/π)∫(-π→π)|f(x)|^2dx=a0^2/2+Σ(n=1→∞)(an^2+bn^2)",
    checks: [["\\int", "∫"], ["\\Sigma", "Σ"], ["|f(x)|^2", "\\left|f(x)\\right|^2"], ["a0^2/2"]],
  },
  {
    name: "Cauchy-Schwarz inequality",
    input: "(u·v)^2≤(u·u)(v·v)",
    checks: [["\\cdot", "·"], ["\\le", "≤"], ["(u·u)", "(u\\cdotu)"], ["(v·v)", "(v\\cdotv)"]],
  },
  {
    name: "Holder inequality",
    input: "∫|fg|dx ≤ (∫|f|^p dx)^(1/p) (∫|g|^q dx)^(1/q)",
    checks: [["\\int", "∫"], ["\\le", "≤"], ["1/p"], ["1/q"]],
  },
  {
    name: "Minkowski inequality",
    input: "(∫|f+g|^p dx)^(1/p) ≤ (∫|f|^p dx)^(1/p) + (∫|g|^p dx)^(1/p)",
    checks: [["\\int", "∫"], ["\\le", "≤"], ["|f+g|", "\\left|f+g\\right|"], ["1/p"]],
  },
  {
    name: "Jensen inequality",
    input: "φ(E[X])≤E[φ(X)]",
    checks: [["\\phi", "\\varphi", "φ"], ["E[X]"], ["\\le", "≤"]],
  },
  {
    name: "AM-GM inequality",
    input: "(x1+x2+⋯+xn)/n≥(x1x2⋯xn)^(1/n)",
    checks: [["\\ge", "≥"], ["1/n"], ["x1x2"], ["xn"]],
  },
  {
    name: "Green theorem",
    input: "∮C(Pdx+Qdy)=∫∫D(∂Q/∂x-∂P/∂y)dA",
    checks: [["\\oint", "∮"], ["\\int", "∫"], ["\\partial", "∂"], ["dA"]],
  },
  {
    name: "Stokes theorem",
    input: "∮∂S F·dr=∫∫S(∇×F)·n dS",
    checks: [["\\oint", "∮"], ["\\nabla", "∇"], ["\\times", "×"], ["dS"]],
  },
  {
    name: "Divergence theorem",
    input: "∫∫∫V ∇·F dV=∫∫∂V F·n dS",
    checks: [["\\int", "∫"], ["\\nabla", "∇"], ["\\cdot", "·"], ["dV"]],
  },
  {
    name: "Cauchy integral formula",
    input: "f(a)=(1/(2πi))∮C f(z)/(z-a)dz",
    checks: [["1/(2\\pii)", "1/(2πi)"], ["\\oint", "∮"], ["f(z)/(z-a)"]],
  },
  {
    name: "Residue theorem",
    input: "∮C f(z)dz=2πiΣk Res(f,zk)",
    checks: [["\\oint", "∮"], ["2\\pii", "2πi"], ["\\Sigma", "Σ"], ["Res"]],
  },
  {
    name: "Laplace transform",
    input: "F(s) = ∫(0→∞) f(t) e^(-st) dt",
    checks: [["\\int", "∫"], ["\\infty", "∞"], ["e^{(-st)", "e^(-st)"], ["F(s)"]],
  },
  {
    name: "Inverse Laplace transform",
    input: "f(t) = (1/(2πi)) ∫(γ-i∞→γ+i∞) e^(st) F(s) ds",
    checks: [["1/(2\\pii)", "1/(2πi)"], ["\\infty", "∞"], ["e^{(st)", "e^(st)"], ["F(s)"]],
  },
  {
    name: "Fourier transform",
    input: "F(ω) = ∫(-∞→∞) f(t) e^(-iωt) dt",
    checks: [["\\omega", "ω"], ["\\int", "∫"], ["\\infty", "∞"], ["-i\\omega", "-iω"], ["dt"]],
  },
  {
    name: "Inverse Fourier transform",
    input: "f(t) = (1/(2π)) ∫(-∞→∞) F(ω) e^(iωt) dω",
    checks: [["1/(2\\pi)", "1/(2π)"], ["\\omega", "ω"], ["\\int", "∫"], ["i\\omega", "iω"], ["d\\omega", "dω"]],
  },
  {
    name: "Convolution theorem",
    input: "ℱ{f*g}=ℱ{f}ℱ{g}",
    checks: [["ℱ"], ["f*g"], ["\\lbracef\\rbrace", "{f}"], ["\\lbraceg\\rbrace", "{g}"]],
  },
  {
    name: "Heat equation",
    input: "∂u/∂t=κ∂^2u/∂x^2",
    checks: [["\\partial", "∂"], ["\\kappa", "κ"], ["\\partial^2u/\\partialx^2", "∂^2u/∂x^2"]],
  },
  {
    name: "Wave equation",
    input: "∂^2u/∂t^2=c^2∂^2u/∂x^2",
    checks: [["\\partial^2u/\\partialt^2", "∂^2u/∂t^2"], ["c^2"], ["\\partial^2u/\\partialx^2", "∂^2u/∂x^2"]],
  },
  {
    name: "Poisson equation",
    input: "∇^2φ=-ρ/ε0",
    checks: [["\\nabla^2", "∇^2"], ["\\phi", "\\varphi", "φ"], ["\\rho", "ρ"], ["\\varepsilon0", "ε0"]],
  },
  {
    name: "Continuity equation",
    input: "∂ρ/∂t+∇·(ρv)=0",
    checks: [["\\partial\\rho/\\partialt", "∂ρ/∂t"], ["\\nabla", "∇"], ["\\cdot", "·"], ["=0"]],
  },
  {
    name: "Navier-Stokes incompressible",
    input: "ρ(∂v/∂t+v·∇v)=-∇p+μ∇^2v+f",
    checks: [["\\rho", "ρ"], ["\\partialv/\\partialt", "∂v/∂t"], ["\\mu", "μ"], ["\\nabla^2v", "∇^2v"]],
  },
  {
    name: "Maxwell-Faraday law",
    input: "∇×E=-∂B/∂t",
    checks: [["\\nabla", "∇"], ["\\times", "×"], ["\\partialB/\\partialt", "∂B/∂t"]],
  },
  {
    name: "Maxwell-Ampere law",
    input: "∇×H=J+∂D/∂t",
    checks: [["\\nabla", "∇"], ["\\times", "×"], ["\\partialD/\\partialt", "∂D/∂t"]],
  },
  {
    name: "Lorentz force law",
    input: "F=q(E+v×B)",
    checks: [["F=q"], ["E+v"], ["\\times", "×"], ["B"]],
  },
  {
    name: "Euler-Lagrange equation",
    input: "d/dt(∂L/∂q)-∂L/∂q0=0",
    checks: [["d/dt"], ["\\partialL/\\partialq", "∂L/∂q"], ["\\partialL/\\partialq0", "∂L/∂q0"], ["=0"]],
  },
  {
    name: "Hamilton equations",
    input: "qdot=∂H/∂p,pdot=-∂H/∂q",
    checks: [["qdot"], ["\\partialH/\\partialp", "∂H/∂p"], ["pdot"], ["-\\partialH/\\partialq", "-∂H/∂q"]],
  },
  {
    name: "Action principle",
    input: "δ∫(t1→t2)Ldt=0",
    checks: [["\\delta", "δ"], ["\\int", "∫"], ["t1"], ["t2"]],
  },
  {
    name: "Partition function",
    input: "Z=Σi e^(-βEi)",
    checks: [["Z="], ["\\Sigma", "Σ"], ["\\beta", "β"], ["Ei"]],
  },
  {
    name: "Boltzmann distribution",
    input: "Pi=e^(-βEi)/Z",
    actions: ["Pi=e^(-βEi)", { key: "ArrowRight" }, "/Z"],
    checks: [["Pi="], ["\\beta", "β"], ["Ei"], ["/Z"]],
  },
  {
    name: "Gibbs entropy",
    input: "S=-kBΣi Pi lnPi",
    checks: [["S=-kB"], ["\\Sigma", "Σ"], ["Pi"], ["lnPi"]],
  },
  {
    name: "Black-Scholes PDE",
    input: "∂V/∂t+(1/2)σ^2S^2∂^2V/∂S^2+rS∂V/∂S-rV=0",
    checks: [["\\partialV/\\partialt", "∂V/∂t"], ["\\sigma^2", "σ^2"], ["\\partial^2V/\\partialS^2", "∂^2V/∂S^2"], ["rV"]],
  },
  {
    name: "Logistic growth ODE",
    input: "dN/dt=rN(1-N/K)",
    checks: [["dN/dt"], ["rN"], ["1-N/K"]],
  },
  {
    name: "Lotka-Volterra system",
    input: "dx/dt=αx-βxy,dy/dt=δxy-γy",
    checks: [["dx/dt"], ["\\alpha", "α"], ["\\beta", "β"], ["\\delta", "δ"], ["\\gamma", "γ"]],
  },
  {
    name: "SIR epidemic system",
    input: "dS/dt=-βSI,dI/dt=βSI-γI,dR/dt=γI",
    checks: [["dS/dt"], ["dI/dt"], ["dR/dt"], ["\\beta", "β"], ["\\gamma", "γ"]],
  },
  {
    name: "KL divergence",
    input: "DKL(P||Q)=Σx P(x)log(P(x)/Q(x))",
    checks: [["DKL(P||Q)"], ["\\Sigma", "Σ"], ["P(x)/Q(x)"], ["log"]],
  },
  {
    name: "Cross entropy",
    input: "H(P,Q)=-Σx P(x)logQ(x)",
    checks: [["H(P,Q)"], ["\\Sigma", "Σ"], ["logQ(x)"]],
  },
  {
    name: "Softmax function",
    input: "softmax(zi)=e^(zi)/(Σj e^(zj))",
    actions: [
      "softmax(zi)=e^(zi)",
      { key: "ArrowRight" },
      "/(",
      "Σj e^(zj)",
      { key: "ArrowRight" },
      ")",
    ],
    checks: [["softmax"], ["e^{(zi)", "e^(zi)", "e^{zi}"], ["\\Sigma", "Σ"], ["e^{(zj)", "e^(zj)", "e^{zj}"]],
  },
  {
    name: "Gradient descent update",
    input: "θ(t+1)=θt-η∇J(θt)",
    checks: [["\\theta", "θ"], ["\\eta", "η"], ["\\nabla", "∇"], ["J(θt)", "J(\\theta t)"]],
  },
  {
    name: "Normal equations",
    input: "θ=M^(-1)b",
    actions: ["θ=M^(-1)", { key: "ArrowRight" }, "b"],
    checks: [["\\theta", "θ"], ["M^{(-1)", "M^(-1)", "M^{-1}"], ["b"]],
  },
  {
    name: "Align linear system",
    input: "x+y&=4",
    mode: "align",
    checks: [["x+y"], ["4"], ["\\&=", "&="]],
    snippetTokens: [
      ["\\begin{align*}", "\\begin{align}"],
      ["\\end{align*}", "\\end{align}"],
      "x+y",
    ],
  },
  {
    name: "Align elimination steps",
    input: "2x+y&=5",
    mode: "align",
    checks: [["2x+y"], ["5"], ["\\&=", "&="]],
    snippetTokens: ["2x+y"],
  },
  {
    name: "Align trig derivation",
    input: "sin2x&=2sinx cosx",
    mode: "align",
    checks: [["sin2x"], ["2sinxcosx", "2sinxcosx"], ["\\&=", "&="]],
    snippetTokens: ["sin2x"],
  },
  {
    name: "Align thermodynamic differentials",
    input: "dU&=TdS-pdV",
    mode: "align",
    checks: [["dU"], ["TdS"], ["pdV"], ["\\&=", "&="]],
    snippetTokens: ["dU"],
  },
  {
    name: "Align probability decomposition",
    input: "P(A)&=P(A|B)P(B)+P(A|Bc)P(Bc)",
    mode: "align",
    checks: [["P(A|B)"], ["P(A|Bc)"], ["P(Bc)"], ["\\&=", "&="]],
    snippetTokens: ["P(A|B)", "P(A|Bc)"],
  },
  {
    name: "Gather reaction-diffusion with IC",
    input: "∂u/∂t=Δu+f(u)",
    mode: "gather",
    checks: [["\\partialu/\\partialt", "∂u/∂t"], ["\\Delta", "Δ"], ["f(u)"]],
    snippetTokens: [
      ["\\begin{gather*}", "\\begin{gather}"],
      ["\\end{gather*}", "\\end{gather}"],
    ],
  },
  {
    name: "Gather coupled oscillators",
    input: "d^2x/dt^2+ω1^2x=0",
    mode: "gather",
    checks: [["d^2x/dt^2"], ["\\omega1", "ω1"], ["=0"]],
  },
  {
    name: "Align Maxwell pair",
    input: "∇×E&=-∂B/∂t",
    mode: "align",
    checks: [["\\nabla", "∇"], ["\\times", "×"], ["\\partialB/\\partialt", "∂B/∂t"], ["\\&=", "&="]],
  },
  {
    name: "Align stress-energy conservation",
    input: "∇μTμν&=0",
    mode: "align",
    checks: [["\\nabla", "∇"], ["T\\mu\\nu", "Tμν"], ["=0"], ["\\&=", "&="]],
  },
  {
    name: "Align KKT stationarity and feasibility",
    input: "∇f(x)+λ∇g(x)&=0",
    mode: "align",
    checks: [["\\nabla", "∇"], ["\\lambda", "λ"], ["g(x)"], ["\\&=", "&="], ["=0"]],
  },
];

const runOnce = async () => {
  const from = Math.max(1, Number.parseInt(process.env.E2E_FAMOUS_NEXT_FROM ?? "1", 10) || 1);
  const toInput =
    Number.parseInt(process.env.E2E_FAMOUS_NEXT_TO ?? String(NEXT_50_FORMULAS.length), 10) ||
    NEXT_50_FORMULAS.length;
  const to = Math.min(NEXT_50_FORMULAS.length, Math.max(from, toInput));
  const formulas = NEXT_50_FORMULAS.slice(from - 1, to);
  assert.equal(NEXT_50_FORMULAS.length, 50, "next famous formula dataset must contain 50 entries");

  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const userDataPath = path.join(tempDir, "user-data");
  let electronApp;
  let currentInsertMode = "inline";
  const canonicalMismatches = [];

  try {
    log(`workspace copy ${workspacePath}`);
    log(`formula range ${from}-${to} / total ${NEXT_50_FORMULAS.length}`);
    await fs.mkdir(userDataPath, { recursive: true });
    cleanupStaleElectron();
    electronApp = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      slowMo: Number.isFinite(slowMoMs) ? Math.max(0, slowMoMs) : 0,
      env: {
        ...process.env,
        TEX64_E2E: "1",
        TEX64_E2E_HEADLESS: "1",
        TEX64_E2E_USERDATA: userDataPath,
      },
    });

    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1600, height: 980 });
    page.on("dialog", async (dialog) => {
      log(`dialog intercepted: ${dialog.type()} ${dialog.message()}`);
      try {
        await dialog.dismiss();
      } catch {
        // ignore protocol races during shutdown
      }
    });

    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);
    await page.waitForFunction(() => Boolean(window.MathLive?.convertLatexToMarkup), undefined, {
      timeout: 20000,
    });

    await openFile(page, "sections/blocks.tex");
    await openSideTab(page, "blocks");
    await waitForMathFieldReady(page);
    await setBlockMode(page, "insert");
    await setAutoSuggestOff(page);
    await setEditorCursor(page, 34, 1);

    for (const [index, formula] of formulas.entries()) {
      const seq = from + index;
      const label = `[${seq}/${NEXT_50_FORMULAS.length}] ${formula.name}`;
      const mode = formula.mode ?? "inline";
      if (mode !== currentInsertMode) {
        await setInsertMode(page, mode);
        currentInsertMode = mode;
      }
      log(`${label}: typing (${mode})`);

      await clearMathField(page);
      await typeIntoMathField(page, formula);

      const rawLatex = await getMathFieldLatex(page);
      const actualLatex = normalizeLatex(rawLatex);
      const minLength = Math.max(2, Math.floor(normalizeLatex(formula.input).length * 0.6));
      assert.ok(actualLatex.length >= minLength, `${label}: latex too short\nactual=${actualLatex}`);
      assert.ok(!actualLatex.includes("#?"), `${label}: unresolved placeholder remains\nactual=${actualLatex}`);
      assertSemanticTokens(actualLatex, formula.checks, label);
      const match = evaluateFormulaMatch(formula, rawLatex);
      if (!match.matched) {
        canonicalMismatches.push(
          `${label}\nexpected=${match.expected.join(" | ")}\nactual=${match.actual}\nraw=${actualLatex}`
        );
      }
      if (dumpLatex) {
        log(`${label}: latex=${actualLatex}`);
      }
      await assertRenderStable(page, label);

      const beforeContent = await readActiveEditorValue(page);
      await page.click("#block-insert-button");
      await waitForDiffModalState(page, true);
      await page.click("#diff-modal-submit");
      await waitForDiffModalState(page, false);
      await waitForEditorValueChange(page, beforeContent);
      await pause(40);
      const afterContent = await readActiveEditorValue(page);
      assertSnippetTokensInserted(beforeContent, afterContent, formula.snippetTokens ?? [], label);
      log(`${label}: passed`);
    }

    log("math-wysiwyg famous formulas next50 e2e passed");
    assert.equal(
      canonicalMismatches.length,
      0,
      `canonical expression mismatch(s): ${canonicalMismatches.length}\n\n${canonicalMismatches.join("\n\n")}`
    );
  } finally {
    if (electronApp) {
      try {
        await Promise.race([
          electronApp.close(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("electronApp.close timeout")), 5000)
          ),
        ]);
      } catch (closeError) {
        log(`close fallback: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
        try {
          electronApp.process()?.kill("SIGKILL");
        } catch {
          // ignore force kill failure
        }
      }
    }
    cleanupStaleElectron();
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true });
      log("workspace copy removed");
    } else {
      log(`workspace copy kept ${tempDir}`);
    }
  }
};

const run = async () => {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      if (attempt > 1) {
        log(`retry attempt ${attempt}/3 after transient failure`);
      }
      await runOnce();
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= 3 || !isTransientElectronError(error)) {
        throw error;
      }
      log(
        `transient electron failure detected; retrying (${attempt}/3): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      await pause(250);
    }
  }
  throw lastError ?? new Error("math-wysiwyg famous formulas next50 e2e failed");
};

run().catch((error) => {
  console.error("[math-wysiwyg-famous-formulas-next50-e2e] FAILED");
  console.error(error);
  process.exitCode = 1;
});
