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
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "120", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "0", 10);
const isMac = process.platform === "darwin";
const selectAllShortcut = isMac ? "Meta+A" : "Control+A";

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[math-formula-breakage ${now()}] ${message}`);
};

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const normalizeLatex = (value) => String(value ?? "").replace(/\s+/g, "");

const cleanupStaleElectron = () => {
  try {
    execSync(
      `pkill -f "${path.join(
        repoRoot,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
      )}"`,
      { stdio: "ignore" }
    );
  } catch {
    // no stale process
  }
};

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-math-breakage-"));
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
  await pause(60);
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
  await pause(50);
};

const getMathFieldLatex = async (page) =>
  page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    if (!field || typeof field.getValue !== "function") return "";
    try {
      return String(field.getValue("latex") ?? "");
    } catch {
      return "";
    }
  });

const setMathFieldLatex = async (page, value) =>
  page.evaluate((nextValue) => {
    const field = document.getElementById("block-math-input");
    if (!field) return false;
    const latex = String(nextValue ?? "");
    try {
      if (typeof field.setValue === "function") {
        try {
          field.setValue(latex, { format: "latex" });
        } catch {
          field.setValue(latex);
        }
        return true;
      }
      if ("value" in field) {
        field.value = latex;
        field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  }, value);

const clearMathField = async (page) => {
  await focusMathField(page);
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press(selectAllShortcut);
    await page.keyboard.press("Backspace");
    await pause(30);
    const current = normalizeLatex(await getMathFieldLatex(page));
    if (!current) return;
  }
  const resetByApi = await setMathFieldLatex(page, "");
  if (resetByApi) {
    await pause(40);
    if (!normalizeLatex(await getMathFieldLatex(page))) {
      return;
    }
  }
  assert.equal(normalizeLatex(await getMathFieldLatex(page)), "", "failed to clear math-field");
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
    return {
      rawText: (visibleRoot.textContent ?? "").replace(/\s+/g, " ").trim(),
      errorCount: root.querySelectorAll(".ML__error").length,
      placeholderCount: root.querySelectorAll(".ML__placeholder, .ML__prompt, .ML__editablePromptBox")
        .length,
    };
  });

// ---------------------------------------------------------------------------
// Core assertion: render is healthy after loading a formula
// ---------------------------------------------------------------------------
const assertRenderHealthy = async (page, label, { allowPlaceholder = true } = {}) => {
  const snapshot = await getRenderSnapshot(page);
  assert.ok(snapshot, `${label}: render snapshot unavailable`);
  assert.equal(snapshot.errorCount, 0, `${label}: render has MathLive error node(s)`);
  if (!allowPlaceholder) {
    assert.equal(snapshot.placeholderCount, 0, `${label}: unresolved placeholder remains`);
  }
  // Raw LaTeX commands should never leak into rendered text.
  // We allow known visual text that may legitimately contain a backslash-like
  // rendering (some MathLive builds show Unicode backslashes for unknown cmds).
  assert.ok(
    !snapshot.rawText.includes("\\"),
    `${label}: raw LaTeX leaked in render (${snapshot.rawText})`
  );
};

// ---------------------------------------------------------------------------
// Formula test cases
// ---------------------------------------------------------------------------
const FORMULA_SCENARIOS = [
  // ===== A. Basic command roundtrip =====
  {
    id: "basic-frac",
    latex: "\\frac{a}{b}",
    tokens: ["\\frac"],
  },
  {
    id: "nested-frac",
    latex: "\\frac{1}{\\frac{2}{3}}",
    tokens: ["\\frac"],
  },
  {
    id: "super-subscript",
    latex: "x_{i}^{2}",
    tokens: ["x"],
  },
  {
    id: "sqrt",
    latex: "\\sqrt{x^{2}+y^{2}}",
    tokens: ["\\sqrt"],
  },
  {
    id: "sum-limits",
    latex: "\\sum_{i=1}^{n}a_{i}",
    tokens: ["\\sum"],
  },
  {
    id: "int-limits",
    latex: "\\int_{0}^{\\infty}f(x)\\,dx",
    tokens: ["\\int", "\\infty"],
  },
  {
    id: "lim-frac",
    latex: "\\lim_{x\\to0}\\frac{\\sin x}{x}",
    tokens: ["\\lim", "\\frac", "\\sin"],
  },
  {
    id: "binom",
    latex: "\\binom{n}{k}",
    tokens: ["\\binom"],
  },
  {
    id: "greek-letters",
    latex: "\\alpha+\\beta+\\gamma",
    tokens: ["\\alpha", "\\beta", "\\gamma"],
  },

  // ===== B. Environment structures =====
  {
    id: "pmatrix",
    latex: "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}",
    tokens: ["\\begin{pmatrix}", "\\end{pmatrix}"],
  },
  {
    id: "bmatrix",
    latex: "\\begin{bmatrix}1&0\\\\0&1\\end{bmatrix}",
    tokens: ["\\begin{bmatrix}", "\\end{bmatrix}"],
  },
  {
    id: "cases",
    latex: "\\begin{cases}x&x>0\\\\-x&x\\leq0\\end{cases}",
    tokens: ["\\begin{cases}", "\\end{cases}"],
  },
  {
    id: "aligned",
    latex: "\\begin{aligned}a&=b\\\\c&=d\\end{aligned}",
    tokens: ["\\begin{aligned}", "\\end{aligned}"],
  },
  {
    id: "dcases",
    latex: "\\begin{dcases}\\frac{1}{x}&x>0\\\\0&x=0\\end{dcases}",
    tokens: ["\\begin{dcases}", "\\end{dcases}", "\\frac"],
  },
  {
    id: "vmatrix",
    latex: "\\begin{vmatrix}a&b\\\\c&d\\end{vmatrix}",
    tokens: ["\\begin{vmatrix}", "\\end{vmatrix}"],
  },
  // Bmatrix (curly braces) — less commonly tested
  {
    id: "Bmatrix",
    latex: "\\begin{Bmatrix}a&b\\\\c&d\\end{Bmatrix}",
    tokens: ["\\begin{Bmatrix}", "\\end{Bmatrix}"],
  },
  // Vmatrix (double vertical bars)
  {
    id: "Vmatrix",
    latex: "\\begin{Vmatrix}a&b\\\\c&d\\end{Vmatrix}",
    tokens: ["\\begin{Vmatrix}", "\\end{Vmatrix}"],
  },
  // smallmatrix — inline matrix, tight rendering
  {
    id: "smallmatrix",
    latex: "\\begin{smallmatrix}a&b\\\\c&d\\end{smallmatrix}",
    tokens: ["\\begin{smallmatrix}", "\\end{smallmatrix}"],
  },

  // ===== C. Nested environments (breakage-prone combos) =====
  {
    id: "nested-env",
    latex: "\\begin{pmatrix}\\frac{a}{b}&\\sqrt{c}\\\\\\sum_{i}&\\binom{n}{k}\\end{pmatrix}",
    tokens: ["\\begin{pmatrix}", "\\frac", "\\sqrt", "\\sum", "\\binom", "\\end{pmatrix}"],
  },
  // Matrix inside aligned — combo from breakage analysis K-2
  {
    id: "matrix-inside-aligned",
    latex: "\\begin{aligned}A&=\\begin{pmatrix}1&0\\\\0&1\\end{pmatrix}\\\\B&=C\\end{aligned}",
    tokens: ["\\begin{aligned}", "\\begin{pmatrix}", "\\end{pmatrix}", "\\end{aligned}"],
  },
  // Cases with fractions in both branches
  {
    id: "cases-with-fracs",
    latex: "\\begin{cases}\\frac{1}{x}&x\\neq0\\\\\\frac{0}{1}&x=0\\end{cases}",
    tokens: ["\\begin{cases}", "\\frac", "\\end{cases}"],
  },
  // Sum inside matrix cell
  {
    id: "sum-inside-matrix",
    latex: "\\begin{pmatrix}\\sum_{i=1}^{n}a_i&b\\\\c&\\prod_{j=1}^{m}d_j\\end{pmatrix}",
    tokens: ["\\begin{pmatrix}", "\\sum", "\\prod", "\\end{pmatrix}"],
  },

  // ===== D. Aux commands (breakage analysis A) =====
  {
    id: "label",
    latex: "a=b\\label{eq:1}",
    tokens: ["\\label"],
  },
  {
    id: "tag",
    latex: "a=b\\tag{1}",
    tokens: ["\\tag"],
  },
  // \tag*{} — star variant, breakage analysis A-5
  {
    id: "tag-star",
    latex: "a=b\\tag*{custom}",
    tokens: ["\\tag"],
  },
  // \notag / \nonumber — invisible markers
  {
    id: "notag",
    latex: "\\begin{aligned}a&=b\\notag\\\\c&=d\\end{aligned}",
    tokens: ["\\begin{aligned}", "\\notag", "\\end{aligned}"],
  },
  // \ref / \eqref — cross-reference commands
  {
    id: "eqref",
    latex: "x=y\\eqref{eq:1}",
    tokens: ["\\eqref"],
  },
  // Consecutive aux commands — breakage analysis K-1
  {
    id: "consecutive-aux-commands",
    latex: "a=b\\label{eq:1}\\tag{1}",
    tokens: ["\\label", "\\tag"],
  },

  // ===== E. Decorations and text =====
  {
    id: "text-in-math",
    latex: "x+\\text{hello}+y",
    tokens: ["\\text"],
  },
  {
    id: "overline-underline",
    latex: "\\overline{AB}+\\underline{CD}",
    tokens: ["\\overline", "\\underline"],
  },
  {
    id: "accents",
    latex: "\\hat{a}+\\vec{b}+\\dot{c}",
    tokens: ["\\hat", "\\vec", "\\dot"],
  },
  // \ddot, \widehat, \widetilde — more accent variants
  {
    id: "accents-wide",
    latex: "\\ddot{x}+\\widehat{AB}+\\widetilde{CD}",
    tokens: ["\\ddot", "\\widehat", "\\widetilde"],
  },
  // \overbrace / \underbrace with annotation — stacking
  {
    id: "overbrace-underbrace",
    latex: "\\overbrace{a+b+c}^{n}+\\underbrace{x+y}_{k}",
    tokens: ["\\overbrace", "\\underbrace"],
  },
  // \overset / \underset — placing above/below
  {
    id: "overset-underset",
    latex: "A\\overset{f}{\\to}B\\underset{g}{\\to}C",
    tokens: ["\\overset", "\\underset", "\\to"],
  },
  // \stackrel
  {
    id: "stackrel",
    latex: "a\\stackrel{\\text{def}}{=}b",
    tokens: ["\\stackrel"],
  },
  // \operatorname — custom operator
  {
    id: "operatorname",
    latex: "\\operatorname{argmax}_{x}f(x)",
    tokens: ["\\operatorname"],
  },

  // ===== F. Delimiters and pairing =====
  {
    id: "left-right-delimiters",
    latex: "\\left(\\frac{a}{b}\\right)",
    tokens: ["\\left(", "\\right)", "\\frac"],
  },
  // Nested left/right
  {
    id: "nested-left-right",
    latex: "\\left(\\left[\\frac{a}{b}\\right]+c\\right)",
    tokens: ["\\left(", "\\left[", "\\right]", "\\right)", "\\frac"],
  },
  // Mixed delimiters — \left[ ... \right)
  {
    id: "mixed-delimiters",
    latex: "\\left[0,1\\right)",
    tokens: ["\\left[", "\\right)"],
  },
  // \left. ... \right| — evaluation bar (risky, breakage analysis I-1)
  {
    id: "eval-bar",
    latex: "\\left.\\frac{d}{dx}f(x)\\right|_{x=0}",
    tokens: ["\\left.", "\\right|", "\\frac"],
  },

  // ===== G. Font variants =====
  {
    id: "mathbb",
    latex: "\\mathbb{R}\\times\\mathbb{Z}",
    tokens: ["\\mathbb"],
  },
  {
    id: "mathcal-mathfrak",
    latex: "\\mathcal{L}+\\mathfrak{g}",
    tokens: ["\\mathcal", "\\mathfrak"],
  },

  // ===== H. Deep nesting (performance stress, breakage analysis K-4) =====
  {
    id: "deep-frac-nesting",
    latex: "\\frac{1}{1+\\frac{1}{1+\\frac{1}{1+\\frac{1}{x}}}}",
    tokens: ["\\frac"],
  },
  // Deeply nested superscripts
  {
    id: "deep-script-nesting",
    latex: "e^{e^{e^{e^{x}}}}",
    tokens: ["e"],
  },

  // ===== I. Edge cases from breakage analysis =====
  // Empty group before script — breakage analysis I-2
  {
    id: "empty-group-script",
    latex: "{}^{2}+a_{}", // empty base, empty subscript
    tokens: ["a"],
  },
  // \substack — multi-line subscript limits
  {
    id: "substack",
    latex: "\\sum_{\\substack{i=1\\\\j=1}}^{n}a_{ij}",
    tokens: ["\\sum", "\\substack"],
  },

  // ===== J. Large operator combos =====
  {
    id: "large-operator-combo",
    latex: "\\prod_{j=1}^{m}\\sum_{i=1}^{n}a_{ij}",
    tokens: ["\\prod", "\\sum"],
  },
  {
    id: "multi-scripts",
    latex: "x_{1}^{2}+y_{2}^{3}+z_{3}^{4}",
    tokens: ["x", "y", "z"],
  },
  {
    id: "frac-chain",
    latex: "\\frac{a+b}{c+d}+\\frac{e}{f}+\\frac{g}{h+i}",
    tokens: ["\\frac"],
  },

  // ===== K. Spacing and dots =====
  // Spacing commands
  {
    id: "spacing-commands",
    latex: "a\\,b\\;c\\:d\\!e\\quad f\\qquad g",
    tokens: ["a", "g"],
  },
  // Dot variants — \cdots, \ldots, \vdots, \ddots
  {
    id: "dot-variants",
    latex: "a,b,\\ldots,z+\\cdots",
    tokens: ["\\ldots", "\\cdots"],
  },
  // \phantom — invisible spacer
  {
    id: "phantom",
    latex: "\\phantom{abc}+x",
    tokens: ["\\phantom"],
  },

  // ===== L. Complex real-world formulas =====
  // Euler's identity
  {
    id: "euler-identity",
    latex: "e^{i\\pi}+1=0",
    tokens: ["\\pi"],
  },
  // Cauchy integral formula
  {
    id: "cauchy-integral",
    latex: "f(a)=\\frac{1}{2\\pi i}\\oint_{\\gamma}\\frac{f(z)}{z-a}\\,dz",
    tokens: ["\\frac", "\\pi", "\\oint", "\\gamma"],
  },
  // Taylor series
  {
    id: "taylor-series",
    latex: "f(x)=\\sum_{n=0}^{\\infty}\\frac{f^{(n)}(a)}{n!}(x-a)^{n}",
    tokens: ["\\sum", "\\infty", "\\frac"],
  },
  // Aligned multi-line derivation with many rows
  {
    id: "aligned-multi-row",
    latex: "\\begin{aligned}(a+b)^{2}&=a^{2}+2ab+b^{2}\\\\&=a^{2}+b^{2}+2ab\\\\&\\geq2ab\\end{aligned}",
    tokens: ["\\begin{aligned}", "\\geq", "\\end{aligned}"],
  },
];

// ---------------------------------------------------------------------------
// Run a single formula scenario
// ---------------------------------------------------------------------------
const runFormulaScenario = async (page, scenario, index, total) => {
  const prefix = `[${index + 1}/${total}] ${scenario.id}`;

  // 1. Clear and set formula
  await clearMathField(page);
  const didSet = await setMathFieldLatex(page, scenario.latex);
  assert.ok(didSet, `${prefix}: setValue failed`);
  await pause(200);

  // 2. Focus to trigger any sync processing
  await focusMathField(page);
  await pause(150);

  // 3. Check render health
  await assertRenderHealthy(page, `${prefix} render`, { allowPlaceholder: true });

  // 4. Check getValue roundtrip – key tokens must be present
  const readBack = normalizeLatex(await getMathFieldLatex(page));
  for (const token of scenario.tokens) {
    const normalizedToken = normalizeLatex(token);
    assert.ok(
      readBack.includes(normalizedToken),
      `${prefix}: token "${token}" missing in getValue output (got: ${readBack})`
    );
  }

  log(`${prefix}: PASS`);
};

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------
const run = async () => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const userDataPath = path.join(tempDir, "user-data");
  /** @type {import('playwright').ElectronApplication | undefined} */
  let electronApp;

  try {
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

    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);
    await page.waitForFunction(() => Boolean(window.MathLive?.convertLatexToMarkup), undefined, {
      timeout: 20000,
    });
    await openSideTab(page, "blocks");
    await waitForMathFieldReady(page);
    await clearMathField(page);

    log(`running ${FORMULA_SCENARIOS.length} formula breakage scenarios`);

    for (let i = 0; i < FORMULA_SCENARIOS.length; i += 1) {
      const scenario = FORMULA_SCENARIOS[i];
      let lastError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await runFormulaScenario(page, scenario, i, FORMULA_SCENARIOS.length);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          // Retry once after a fresh clear
          await clearMathField(page).catch(() => {});
        }
      }
      if (lastError) {
        throw new Error(
          `FAILED at scenario ${scenario.id} (${i + 1}/${FORMULA_SCENARIOS.length}): ${String(
            lastError
          )}`
        );
      }
    }

    log(`all ${FORMULA_SCENARIOS.length} formula breakage scenarios passed`);
  } finally {
    if (electronApp) {
      try {
        await electronApp.close();
      } catch {
        try {
          electronApp.process()?.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    cleanupStaleElectron();
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
};

run().catch((error) => {
  console.error("[math-formula-breakage] FAILED");
  console.error(error);
  process.exitCode = 1;
});
