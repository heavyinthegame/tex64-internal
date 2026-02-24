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
  console.log(`[math-wysiwyg-famous-formulas-e2e ${now()}] ${message}`);
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-math-wysiwyg-famous-formulas-"));
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

const typeIntoMathField = async (page, value) => {
  await focusMathField(page);
  const source = String(value ?? "");
  for (const char of source) {
    await page.keyboard.insertText(char);
    if (typeDelayMs > 0) {
      await pause(typeDelayMs);
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

const FAMOUS_FORMULAS = [
  { name: "Pythagorean theorem", input: "a^2+b^2=c^2" },
  { name: "Quadratic formula", input: "x=(-b±√(b^2-4ac))/(2a)" },
  { name: "Euler formula", input: "e^(ix) = cos x + i sin x" },
  { name: "Euler identity", input: "e^(iπ) + 1 = 0" },
  { name: "Binomial theorem", input: "(a+b)^n = Σ(k=0→n) C(n,k) a^(n-k) b^k" },
  { name: "Circle area", input: "S=πr^2" },
  { name: "Circumference", input: "C=2πr" },
  { name: "Sphere volume", input: "V=(4/3)πr^3" },
  { name: "Sphere surface area", input: "S=4πr^2" },
  { name: "Arithmetic sum", input: "Σ(k=1→n)k=n(n+1)/2" },
  { name: "Geometric sum", input: "Σ(k=0→n-1) a r^k = a(1-r^n )/(1-r)" },
  { name: "Derivative definition", input: "f'(x)=lim(h→0)(f(x+h)-f(x))/h" },
  { name: "Fundamental theorem", input: "∫(a→b)f'(x)dx=f(b)-f(a)" },
  { name: "Integration by parts", input: "∫u dv=uv-∫v du" },
  { name: "Substitution rule", input: "∫f(g(x))g'(x)dx=∫f(u)du" },
  { name: "Gaussian integral", input: "∫(-∞→∞) e^(-x^2) dx = √π" },
  { name: "Taylor expansion", input: "f(x) = Σ(n=0→∞) (f^(n)(a)/n!) (x-a)^n" },
  { name: "Exp series", input: "e^(x) = Σ(n=0→∞) x^(n) / n!" },
  { name: "De Moivre theorem", input: "(cosθ + i sinθ)^n = cos(nθ) + i sin(nθ)" },
  { name: "Trig identity", input: "sin^2x+cos^2x=1" },
  { name: "Sine addition", input: "sin(α+β)=sinα cosβ+cosα sinβ" },
  { name: "Sine rule", input: "a/sinA=b/sinB=c/sinC" },
  { name: "Cosine rule", input: "c^2=a^2+b^2-2ab cosC" },
  { name: "Heron formula", input: "S=√(s(s-a)(s-b)(s-c))" },
  { name: "Distance formula", input: "d=√((x2-x1)^2+(y2-y1)^2)" },
  { name: "Newton second law", input: "F=ma" },
  { name: "Gravitation", input: "F=Gm1m2/r^2" },
  { name: "Coulomb law", input: "F=kq1q2/r^2" },
  { name: "Ohm law", input: "V=IR" },
  { name: "Electric power", input: "P=VI" },
  { name: "Kinetic energy", input: "K=(1/2)mv^2" },
  { name: "Potential energy", input: "U=mgh" },
  { name: "Momentum", input: "p=mv" },
  { name: "Mass-energy", input: "E=mc^2" },
  { name: "Ideal gas law", input: "PV=nRT" },
  { name: "Planck relation", input: "E=hf" },
  { name: "de Broglie wavelength", input: "λ=h/p" },
  { name: "Schrodinger equation", input: "iℏ∂ψ/∂t=Hψ" },
  { name: "Uncertainty principle", input: "ΔxΔp≥ℏ/2" },
  { name: "Gauss law (Maxwell)", input: "∇·E=ρ/ε0" },
  { name: "Einstein field equation", input: "Gμν+Λgμν=(8πG/c^4)Tμν" },
  { name: "Bayes theorem", input: "P(A|B)=P(B|A)P(A)/P(B)" },
  { name: "Expectation", input: "E[X]=ΣxP(X=x)" },
  { name: "Variance", input: "Var(X)=E[(X-μ)^2]" },
  { name: "Standard deviation", input: "σ=√Var(X)" },
  { name: "Covariance", input: "Cov(X,Y)=E[(X-μX)(Y-μY)]" },
  { name: "Correlation", input: "ρ=Cov(X,Y)/(σXσY)" },
  { name: "Normal density", input: "f(x)=(1/√(2πσ^2))e^(-(x-μ)^2/(2σ^2))" },
  { name: "Logistic function", input: "σ(x)=1/(1+e^(-x))" },
  { name: "Stirling approximation", input: "n!≈√(2πn)(n/e)^n" },
];

const FAMOUS_FORMULA_CHECKS = {
  "Pythagorean theorem": [["a^2"], ["b^2"], ["c^2"]],
  "Quadratic formula": [["\\pm", "±"], ["\\surd", "\\sqrt", "√"], ["/2a", "2a"]],
  "Euler formula": [["cos"], ["sin"], ["ix", "i"]],
  "Euler identity": [["\\pi", "π"], ["+1=0"]],
  "Binomial theorem": [["\\Sigma", "\\sum", "Σ"], ["C(n,k)", "\\binom"], ["a^"]],
  "Circle area": [["\\pi", "π"], ["r^2"]],
  Circumference: [["2\\pi", "2π", "\\pi", "π"], ["r"]],
  "Sphere volume": [["4/3"], ["\\pi", "π"], ["r^3"]],
  "Sphere surface area": [["4\\pi", "4π", "\\pi", "π"], ["r^2"]],
  "Arithmetic sum": [["\\Sigma", "\\sum", "Σ"], ["n(n+1)/2"]],
  "Geometric sum": [["\\Sigma", "\\sum", "Σ"], ["1-r^n", "1-r^{n"], ["1-r"]],
  "Derivative definition": [["lim"], ["\\to", "→"], ["f^{\\prime}", "f'"]],
  "Fundamental theorem": [["∫", "\\int"], ["dx"], ["f(b)-f(a)"]],
  "Integration by parts": [["∫u", "\\intu"], ["uv-"], ["∫vdu", "\\intvdu"]],
  "Substitution rule": [["∫f(g(x))", "\\intf(g(x))"], ["g^{\\prime}", "g'"], ["du"]],
  "Gaussian integral": [
    ["\\infty", "∞"],
    ["e^{(-x^2)", "e^{-x^2}"],
    ["\\surd", "\\sqrt", "√"],
    ["\\pi", "π"],
  ],
  "Taylor expansion": [["\\Sigma", "\\sum", "Σ"], ["\\infty", "∞"], ["n!"], ["(x-a)^n", "(x-a)^{n}"]],
  "Exp series": [["\\Sigma", "\\sum", "Σ"], ["\\infty", "∞"], ["n!"]],
  "De Moivre theorem": [["cos"], ["sin"], ["\\theta", "θ"]],
  "Trig identity": [["sin^2x"], ["cos^2x"], ["=1"]],
  "Sine addition": [["sin(\\alpha+\\beta)", "sin(α+β)"], ["\\alpha", "α"], ["\\beta", "β"]],
  "Sine rule": [["sinA"], ["sinB"], ["sinC"]],
  "Cosine rule": [["2ab"], ["cosC"], ["c^2"]],
  "Heron formula": [["\\surd", "\\sqrt", "√"], ["(s-a)"], ["(s-b)"], ["(s-c)"]],
  "Distance formula": [["\\surd", "\\sqrt", "√"], ["x2-x1"], ["y2-y1"]],
  "Newton second law": [["F=ma"]],
  Gravitation: [["Gm1m2"], ["r^2"]],
  "Coulomb law": [["kq1q2"], ["r^2"]],
  "Ohm law": [["V=IR"]],
  "Electric power": [["P=VI"]],
  "Kinetic energy": [["1/2"], ["mv^2"]],
  "Potential energy": [["mgh"]],
  Momentum: [["p=mv"]],
  "Mass-energy": [["mc^2"]],
  "Ideal gas law": [["PV=nRT"]],
  "Planck relation": [["E=hf"]],
  "de Broglie wavelength": [["\\lambda", "λ"], ["h/p"]],
  "Schrodinger equation": [["\\hbar", "ℏ"], ["\\partial", "∂"], ["\\psi", "ψ"]],
  "Uncertainty principle": [["\\Delta", "Δ"], ["\\ge", "≥"], ["\\hbar/2", "ℏ/2"]],
  "Gauss law (Maxwell)": [["\\nabla", "∇"], ["\\cdotE", "·E"], ["\\varepsilon", "ε"]],
  "Einstein field equation": [["\\Lambda", "Λ"], ["\\mu\\nu", "μν"], ["c^4"], ["8\\piG", "8πG"]],
  "Bayes theorem": [["P(A|B)"], ["P(B|A)"], ["/P(B)"]],
  Expectation: [["E[X]"], ["\\Sigma", "\\sum", "Σ"], ["P(X=x)"]],
  Variance: [["Var(X)"], ["\\mu", "μ"], ["^2"]],
  "Standard deviation": [["\\sigma", "σ"], ["\\surd", "\\sqrt", "√"], ["Var(X)"]],
  Covariance: [["Cov(X,Y)"], ["\\muX", "μX"], ["\\muY", "μY"]],
  Correlation: [["\\rho", "ρ"], ["Cov(X,Y)"], ["\\sigmaX\\sigmaY", "σXσY"]],
  "Normal density": [["\\surd", "\\sqrt", "√"], ["\\sigma^2", "σ^2"], ["(x-\\mu)^2", "(x-μ)^2"]],
  "Logistic function": [["\\sigma(x)", "σ(x)"], ["1/(1+e^{(-x))", "1/(1+e^{(-x)}", "1/(1+e^(-x))"]],
  "Stirling approximation": [["\\thickapprox", "\\sim", "≈"], ["\\surd", "\\sqrt", "√"], ["(n/e)^{n}", "(n/e)^n"]],
};

const runOnce = async () => {
  const from = Math.max(1, Number.parseInt(process.env.E2E_FAMOUS_FROM ?? "1", 10) || 1);
  const toInput =
    Number.parseInt(process.env.E2E_FAMOUS_TO ?? String(FAMOUS_FORMULAS.length), 10) ||
    FAMOUS_FORMULAS.length;
  const to = Math.min(FAMOUS_FORMULAS.length, Math.max(from, toInput));
  const formulas = FAMOUS_FORMULAS.slice(from - 1, to);
  assert.equal(FAMOUS_FORMULAS.length, 50, "famous formula dataset must contain 50 entries");
  assert.equal(
    Object.keys(FAMOUS_FORMULA_CHECKS).length,
    50,
    "famous formula semantic check map must contain 50 entries"
  );

  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const userDataPath = path.join(tempDir, "user-data");
  let electronApp;
  const canonicalMismatches = [];

  try {
    log(`workspace copy ${workspacePath}`);
    log(`formula range ${from}-${to} / total ${FAMOUS_FORMULAS.length}`);
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
      const label = `[${seq}/${FAMOUS_FORMULAS.length}] ${formula.name}`;
      log(`${label}: typing`);

      await clearMathField(page);
      await typeIntoMathField(page, formula.input);

      const rawLatex = await getMathFieldLatex(page);
      const actualLatex = normalizeLatex(rawLatex);
      const minLength = Math.max(2, Math.floor(normalizeLatex(formula.input).length * 0.6));
      assert.ok(actualLatex.length >= minLength, `${label}: latex too short\nactual=${actualLatex}`);
      assert.ok(!actualLatex.includes("#?"), `${label}: unresolved placeholder remains\nactual=${actualLatex}`);
      assertSemanticTokens(actualLatex, FAMOUS_FORMULA_CHECKS[formula.name], label);
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

      await page.click("#block-insert-button");
      await waitForDiffModalState(page, true);
      await page.click("#diff-modal-submit");
      await waitForDiffModalState(page, false);
      await pause(40);
      log(`${label}: passed`);
    }

    log("math-wysiwyg famous formulas e2e passed");
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
  throw lastError ?? new Error("math-wysiwyg famous formulas e2e failed");
};

run().catch((error) => {
  console.error("[math-wysiwyg-famous-formulas-e2e] FAILED");
  console.error(error);
  process.exitCode = 1;
});
