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
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "0", 10);
const selectAllShortcut = process.platform === "darwin" ? "Meta+A" : "Control+A";
const dumpLatex = process.env.E2E_ULTRA_COMPLEX_30_DUMP_LATEX === "1";
const editAfterInsert = process.env.E2E_EDIT_AFTER_INSERT === "1";

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[math-wysiwyg-ultra-complex-30-e2e ${now()}] ${message}`);
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
    path.join(os.tmpdir(), "tex64-e2e-math-wysiwyg-ultra-complex-30-")
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

const collapseMathSelection = async (page) => {
  await page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    if (!field) return;
    const mathfieldApi = field;
    let position =
      typeof mathfieldApi.position === "number" && Number.isFinite(mathfieldApi.position)
        ? mathfieldApi.position
        : null;
    if (Array.isArray(mathfieldApi.selection) && mathfieldApi.selection.length >= 2) {
      const end = Number(mathfieldApi.selection[1]);
      if (Number.isFinite(end)) {
        position = end;
      }
    }
    if (position === null) return;
    try {
      if (typeof mathfieldApi.setSelectionRange === "function") {
        mathfieldApi.setSelectionRange(position, position);
        return;
      }
      if (typeof mathfieldApi.setSelection === "function") {
        mathfieldApi.setSelection(position, position);
        return;
      }
      mathfieldApi.selection = [position, position];
    } catch {
      // ignore selection collapse failures
    }
  });
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

const waitForSuggestions = async (page, token) => {
  const expected = String(token ?? "").trim().toLowerCase();
  await page.waitForFunction(
    (needle) => {
      const panel = document.querySelector(".math-wysiwyg-panel");
      if (!(panel instanceof HTMLElement)) return false;
      if (panel.getAttribute("aria-hidden") !== "false") return false;
      const items = Array.from(panel.querySelectorAll(".math-wysiwyg-item"));
      if (items.length === 0) return false;
      return items.some((item) => {
        const label = (item.querySelector(".math-wysiwyg-label")?.textContent ?? "")
          .trim()
          .toLowerCase();
        return label === needle;
      });
    },
    expected,
    { timeout: 10000 }
  );
};

const applySuggestionByTyping = async (page, token, pickIndex = 0) => {
  await focusMathField(page);
  for (const char of String(token ?? "")) {
    await page.keyboard.insertText(char);
    if (typeDelayMs > 0) {
      await pause(typeDelayMs);
    }
  }
  await waitForSuggestions(page, token);
  for (let i = 0; i < pickIndex; i += 1) {
    await page.keyboard.press("ArrowDown");
    await pause(Math.max(20, typeDelayMs));
  }
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => {
      const panel = document.querySelector(".math-wysiwyg-panel");
      if (!(panel instanceof HTMLElement)) return true;
      return panel.getAttribute("aria-hidden") !== "false";
    },
    undefined,
    { timeout: 5000 }
  );
  await pause(70);
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
    if (action && typeof action.suggest === "string") {
      await applySuggestionByTyping(page, action.suggest, action.pickIndex ?? 0);
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
  const fallbackText = actions.filter((action) => typeof action === "string").join("");
  await field.pressSequentially(fallbackText, { delay: typeDelayMs });
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

const setAutoSuggestOn = async (page) => {
  const onButton = page.locator('[data-wysiwyg-auto="on"]');
  if ((await onButton.count()) <= 0) {
    return;
  }
  const visible = await onButton.first().isVisible().catch(() => false);
  if (!visible) {
    return;
  }
  await onButton.first().click();
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-wysiwyg-auto="on"]');
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

const assertStructuralCounts = (actualLatex, formula, label) => {
  if (Number.isFinite(formula?.minLineBreaks)) {
    const breaks = countOccurrences(actualLatex, "\\\\");
    assert.ok(
      breaks >= formula.minLineBreaks,
      `${label}: expected >= ${formula.minLineBreaks} row separators, actual=${breaks}\nactual=${actualLatex}`
    );
  }
  if (Number.isFinite(formula?.minAmpersands)) {
    const ampersands = countOccurrences(actualLatex, "&");
    assert.ok(
      ampersands >= formula.minAmpersands,
      `${label}: expected >= ${formula.minAmpersands} ampersands, actual=${ampersands}\nactual=${actualLatex}`
    );
  }
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

const clickDiffModalSubmit = async (page) => {
  const clicked = await page.evaluate(() => {
    const button = document.querySelector("#diff-modal-submit");
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  });
  assert.equal(clicked, true, "failed to click #diff-modal-submit");
};

const firstDiffOffset = (beforeContent, afterContent) => {
  const before = String(beforeContent ?? "");
  const after = String(afterContent ?? "");
  const limit = Math.min(before.length, after.length);
  let index = 0;
  while (index < limit && before[index] === after[index]) {
    index += 1;
  }
  return index;
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

const setEditorCursorByOffset = async (page, offset) => {
  const ok = await page.evaluate((targetOffset) => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    if (!active) return false;
    const model = active.getModel?.();
    if (!model || typeof model.getPositionAt !== "function") return false;
    const content = String(model.getValue?.() ?? "");
    const parsed = Number.isFinite(targetOffset) ? targetOffset : Number.parseInt(String(targetOffset), 10);
    const clamped = Math.max(0, Math.min(content.length, Number.isFinite(parsed) ? parsed : 0));
    const position = model.getPositionAt(clamped);
    if (!position) return false;
    active.setPosition?.(position);
    active.revealPositionInCenterIfOutsideViewport?.(position);
    active.focus?.();
    return true;
  }, offset);
  assert.equal(ok, true, `failed to set cursor at offset ${offset}`);
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

const runEditRoundtrip = async (page, label, seq, formula, mode, editCursorOffset) => {
  if (!editAfterInsert) {
    return;
  }
  if (Number.isFinite(editCursorOffset)) {
    await setEditorCursorByOffset(page, editCursorOffset);
  }
  await setBlockMode(page, "edit");
  await focusMathField(page);
  await collapseMathSelection(page);
  const marker = `ED${String(seq).padStart(3, "0")}`;
  await page.keyboard.insertText(marker);
  await pause(Math.max(20, typeDelayMs));
  const editedLatex = normalizeLatex(await getMathFieldLatex(page));
  assert.ok(
    editedLatex.includes(normalizeLatex(marker)),
    `${label}: edit marker not reflected in mathfield\nactual=${editedLatex}`
  );
  await assertRenderStable(page, `${label} [edit]`, {
    allowRawSlash: formula.allowRawSlash === true,
  });
  const beforeEditContent = await readActiveEditorValue(page);
  await page.click("#block-insert-button");
  await waitForDiffModalState(page, true);
  await clickDiffModalSubmit(page);
  await waitForDiffModalState(page, false);
  await waitForEditorValueChange(page, beforeEditContent);
  await pause(30);
  const afterEditContent = await readActiveEditorValue(page);
  const normalizedAfterEdit = normalizeLatex(afterEditContent);
  assert.ok(
    normalizedAfterEdit.includes(normalizeLatex(marker)),
    `${label}: editor content missing edit marker\nactual=${normalizedAfterEdit}`
  );
  await setBlockMode(page, "insert");
  await setInsertMode(page, mode);
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

const ENVIRONMENT_TEMPLATES = [
  { token: "matrix", begin: "\\begin{matrix}", end: "\\end{matrix}" },
  { token: "pmatrix", begin: "\\begin{pmatrix}", end: "\\end{pmatrix}" },
  { token: "bmatrix", begin: "\\begin{bmatrix}", end: "\\end{bmatrix}" },
  {
    token: "Bmatrix",
    begin: ["\\begin{Bmatrix}", "\\begin{bmatrix}"],
    end: ["\\end{Bmatrix}", "\\end{bmatrix}"],
  },
  { token: "vmatrix", begin: "\\begin{vmatrix}", end: "\\end{vmatrix}" },
  {
    token: "Vmatrix",
    begin: ["\\begin{Vmatrix}", "\\begin{vmatrix}"],
    end: ["\\end{Vmatrix}", "\\end{vmatrix}"],
  },
  { token: "smallmatrix", begin: "\\begin{smallmatrix}", end: "\\end{smallmatrix}" },
  { token: "cases", begin: "\\begin{cases}", end: "\\end{cases}" },
  {
    token: "dcases",
    begin: ["\\begin{dcases}", "\\begin{cases}"],
    end: ["\\end{dcases}", "\\end{cases}"],
  },
  {
    token: "rcases",
    begin: ["\\begin{rcases}", "\\begin{cases}"],
    end: ["\\end{rcases}", "\\end{cases}"],
  },
];

const ULTRA_COMPLEX_TEMPLATE_SETS = [
  {
    id: "nested-fractional-coupling",
    mode: "inline",
    cells: [
      "((Σ(k=1→n)(α_kx^k))/(1+∫(0→1)t^2dt))^(1/2)",
      "lim(m→∞)(Π(j=1→m)(1+β/j)e^(-β))",
      "∂u/∂t+∇·(ρu)-Δu+λu",
      "argmin(θ)(||Aθ-b||^2+μ||θ||_1)",
    ],
    checks: [
      ["\\Sigma", "Σ"],
      ["\\int", "∫"],
      ["\\Pi", "Π"],
      ["\\partial", "∂"],
      ["\\nabla", "∇"],
      ["argmin"],
      ["\\mu", "μ"],
      ["\\infty", "∞"],
    ],
    snippetToken: ["argmin"],
  },
  {
    id: "operator-theoretic-chain",
    mode: "align",
    cells: [
      "det(I+A^TA)-tr((A^TA)^2)+log(1+||A||^2)",
      "sup_(x∈Ω)inf_(y∈Γ)(Φ(x,y)+Ψ(x,y))",
      "⊕(i=1→r)(V_i⊗W_i)→Hom(V,W)",
      "Re(z)^2+Im(z)^2=|z|^2,z∈ℂ",
    ],
    checks: [
      ["det("],
      ["tr("],
      ["sup"],
      ["inf"],
      ["⊕", "\\oplus"],
      ["⊗", "\\otimes"],
      ["\\to", "→"],
      ["Re(z)"],
      ["Im(z)"],
    ],
    snippetToken: ["det("],
  },
  {
    id: "stochastic-singular-flow",
    mode: "gather",
    cells: [
      "P(X_t∈A|F_s)=∫_A p(t,s;x,y)dy",
      "E(e^(τX))=Σ(r=0→∞)(τ^r/r!)E(X^r)",
      "f(x)=((x^2sin(1/x),x≠0),(0,x=0))",
      "Γ(α+β)=∫(0→∞)t^(α+β-1)e^(-t)dt",
    ],
    checks: [
      ["P("],
      ["\\int", "∫"],
      ["\\Sigma", "Σ"],
      ["\\Gamma", "Γ"],
      ["\\alpha", "α"],
      ["\\beta", "β"],
      ["\\infty", "∞"],
    ],
    snippetToken: ["\\Gamma", "Γ"],
  },
];

const buildTemplateActions = (token, cells) => [
  { suggest: token, pickIndex: 0 },
  cells[0],
  { key: "Tab" },
  cells[1],
  { key: "Tab" },
  cells[2],
  { key: "Tab" },
  cells[3],
];

const asAlternatives = (value) => (Array.isArray(value) ? value : [value]);

const ULTRA_COMPLEX_30_CASES = ENVIRONMENT_TEMPLATES.flatMap((env) =>
  ULTRA_COMPLEX_TEMPLATE_SETS.map((set, index) => {
    const mode = set.mode ?? "inline";
    return {
      name: `${env.token} ${set.id}`,
      mode,
      input: `${env.token}:${set.cells.join("|")}`,
      actions: buildTemplateActions(env.token, set.cells),
      checks: [asAlternatives(env.begin), asAlternatives(env.end), ["\\\\"], ...set.checks],
      snippetTokens: [asAlternatives(env.begin), asAlternatives(env.end), set.snippetToken],
      minLineBreaks: 1,
      minAmpersands: 2,
      order: index + 1,
    };
  })
);

const runOnce = async () => {
  const from = Math.max(1, Number.parseInt(process.env.E2E_ULTRA30_FROM ?? "1", 10) || 1);
  const toInput =
    Number.parseInt(process.env.E2E_ULTRA30_TO ?? String(ULTRA_COMPLEX_30_CASES.length), 10) ||
    ULTRA_COMPLEX_30_CASES.length;
  const to = Math.min(ULTRA_COMPLEX_30_CASES.length, Math.max(from, toInput));
  const formulas = ULTRA_COMPLEX_30_CASES.slice(from - 1, to);
  assert.equal(ULTRA_COMPLEX_30_CASES.length, 30, "ultra complex dataset must contain 30 entries");

  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const userDataPath = path.join(tempDir, "user-data");
  let electronApp;
  let currentInsertMode = "inline";

  try {
    log(`workspace copy ${workspacePath}`);
    log(`formula range ${from}-${to} / total ${ULTRA_COMPLEX_30_CASES.length}`);
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
    await setAutoSuggestOn(page);
    await setEditorCursor(page, 34, 1);

    for (const [index, formula] of formulas.entries()) {
      const seq = from + index;
      const label = `[${seq}/${ULTRA_COMPLEX_30_CASES.length}] ${formula.name}`;
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
      assertStructuralCounts(actualLatex, formula, label);
      if (dumpLatex) {
        log(`${label}: latex=${actualLatex}`);
      }
      await assertRenderStable(page, label);

      const beforeContent = await readActiveEditorValue(page);
      await page.click("#block-insert-button");
      await waitForDiffModalState(page, true);
      await clickDiffModalSubmit(page);
      await waitForDiffModalState(page, false);
      await waitForEditorValueChange(page, beforeContent);
      await pause(40);
      const afterContent = await readActiveEditorValue(page);
      assertSnippetTokensInserted(beforeContent, afterContent, formula.snippetTokens ?? [], label);
      const editCursorOffset = firstDiffOffset(beforeContent, afterContent);
      await runEditRoundtrip(page, label, seq, formula, mode, editCursorOffset);
      currentInsertMode = mode;
      log(`${label}: passed`);
    }

    log("math-wysiwyg ultra complex 30 e2e passed");
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
  throw lastError ?? new Error("math-wysiwyg ultra complex 30 e2e failed");
};

run().catch((error) => {
  console.error("[math-wysiwyg-ultra-complex-30-e2e] FAILED");
  console.error(error);
  process.exitCode = 1;
});
