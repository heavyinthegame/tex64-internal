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
const addColumnShortcut = process.platform === "darwin" ? "Meta+Enter" : "Control+Enter";
const dumpLatex = process.env.E2E_FAMOUS_DUMP_LATEX === "1";
const editAfterInsert = process.env.E2E_EDIT_AFTER_INSERT === "1";

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[math-wysiwyg-structural-breakage-probes-e2e ${now()}] ${message}`);
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
    path.join(os.tmpdir(), "tex64-e2e-math-wysiwyg-structural-breakage-probes-")
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
      if (typeof field.executeCommand === "function") {
        try {
          field.executeCommand("deleteAll");
        } catch {
          // ignore
        }
      }
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

const getSuggestionState = async (page) =>
  page.evaluate(() => {
    const panel = document.querySelector(".math-wysiwyg-panel");
    if (!(panel instanceof HTMLElement)) return null;
    const items = Array.from(panel.querySelectorAll(".math-wysiwyg-item"));
    if (items.length === 0) return null;
    const labels = items.map((item) =>
      (item.querySelector(".math-wysiwyg-label")?.textContent ?? "").trim().toLowerCase()
    );
    const activeIndex = items.findIndex((item) => item.classList.contains("is-active"));
    return { labels, activeIndex };
  });

const selectSuggestionByLabel = async (page, token, pickIndex = 0) => {
  const expected = String(token ?? "").trim().toLowerCase();
  const initial = await getSuggestionState(page);
  assert.ok(initial && Array.isArray(initial.labels) && initial.labels.length > 0, "suggestion panel is empty");
  const matches = initial.labels
    .map((label, index) => ({ label, index }))
    .filter((entry) => entry.label === expected);
  assert.ok(matches.length > 0, `no suggestion matches label=${expected}`);
  const matchIndex = Math.min(Math.max(0, pickIndex), matches.length - 1);
  const target = matches[matchIndex].index;
  let safety = initial.labels.length + 3;
  while (safety > 0) {
    const state = await getSuggestionState(page);
    if (!state) break;
    if (state.activeIndex === target) {
      return;
    }
    await page.keyboard.press("ArrowDown");
    await pause(Math.max(20, typeDelayMs));
    safety -= 1;
  }
  const final = await getSuggestionState(page);
  assert.equal(final?.activeIndex, target, `failed to select suggestion label=${expected}`);
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
  await selectSuggestionByLabel(page, token, pickIndex);
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

const assertRenderStable = async (page, label, options = {}) => {
  const allowRawSlash = options.allowRawSlash === true;
  const snapshot = await getRenderSnapshot(page);
  assert.ok(snapshot, `${label}: render snapshot is unavailable`);
  assert.equal(snapshot.errorCount, 0, `${label}: render has MathLive error node(s)`);
  assert.equal(snapshot.placeholderCount, 0, `${label}: unresolved placeholder remains`);
  if (!allowRawSlash) {
    assert.ok(!snapshot.rawText.includes("\\"), `${label}: render still shows raw LaTeX slash`);
  }
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
    const breaks = (actualLatex.match(/\\\\/g) ?? []).length;
    assert.ok(
      breaks >= formula.minLineBreaks,
      `${label}: expected >= ${formula.minLineBreaks} row separators, actual=${breaks}\nactual=${actualLatex}`
    );
  }
  if (Number.isFinite(formula?.minAmpersands)) {
    const ampersands = (actualLatex.match(/&/g) ?? []).length;
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

const STRUCTURAL_BREAKAGE_CASES = [
  {
    name: "matrix add-row with long nested operators",
    input: "matrix-row-add",
    actions: [
      { suggest: "matrix", pickIndex: 0 },
      "(Σ(k=1→n)(-1)^k/k)/(1+α^2)",
      { key: "Tab" },
      "∫(0→1)exp(-x^2)dx+β",
      { key: "Tab" },
      "∇·F+∂ρ/∂t",
      { key: "Tab" },
      "det(A+λI)-tr(A)",
      { key: "Enter" },
      "Γ(α+β)/(Γ(α)Γ(β))",
      { key: "Tab" },
      "lim(m→∞)(1+1/m)^m",
    ],
    checks: [
      ["\\begin{matrix}"],
      ["\\end{matrix}"],
      ["\\Sigma", "Σ"],
      ["\\Gamma", "Γ"],
      ["\\partial", "∂"],
      ["det("],
    ],
    minLineBreaks: 2,
    minAmpersands: 3,
    snippetTokens: [["\\begin{matrix}"], ["\\end{matrix}"], ["\\Gamma", "Γ"]],
  },
  {
    name: "matrix add-column with complex cells",
    input: "matrix-column-add",
    actions: [
      { suggest: "matrix", pickIndex: 0 },
      "argmax(p)H(p)",
      { key: "Tab" },
      "Σ(i=1→n)xi^2",
      { key: "Tab" },
      "∫(0→π)sinx dx",
      { key: "Tab" },
      "Re(z)+Im(z)",
      { key: "Shift+Tab" },
      { key: "Shift+Tab" },
      { key: "Shift+Tab" },
      { key: addColumnShortcut },
      "(a+b+c)^3/(1+a^2+b^2)",
      { key: "Tab" },
      "∂^2u/∂x^2+∂^2u/∂y^2",
    ],
    checks: [
      ["\\begin{matrix}"],
      ["\\end{matrix}"],
      ["argmax"],
      ["\\partial^2u", "∂^2u"],
      ["\\Sigma", "Σ"],
      ["Re(z)"],
    ],
    minLineBreaks: 1,
    minAmpersands: 4,
    snippetTokens: [["\\begin{matrix}"], ["\\end{matrix}"], ["argmax"]],
  },
  {
    name: "pmatrix long spectral system",
    input: "pmatrix-long",
    actions: [
      { suggest: "pmatrix", pickIndex: 0 },
      "Σ(k=1→n)ak/(1+λ^2)",
      { key: "Tab" },
      "∫(0→1)x^2exp(-x)dx",
      { key: "Tab" },
      "lim(r→∞)(1+1/r)^r",
      { key: "Tab" },
      "∇·(ρv)+∂ρ/∂t",
    ],
    checks: [["\\begin{pmatrix}"], ["\\end{pmatrix}"], ["\\Sigma", "Σ"], ["\\partial", "∂"]],
    snippetTokens: [["\\begin{pmatrix}"], ["\\end{pmatrix}"], ["\\Sigma", "Σ"]],
  },
  {
    name: "bmatrix with nested brace and stats",
    input: "bmatrix-brace",
    actions: [
      { suggest: "bmatrix", pickIndex: 0 },
      { suggest: "brace", pickIndex: 0 },
      "x∈R|x≥0",
      { key: "Tab" },
      "∫(0→1)f(x)dx",
      { key: "Tab" },
      "Σ(j=1→m)aj",
      { key: "Tab" },
      "Var(X)+Cov(X,Y)",
    ],
    checks: [
      ["\\begin{bmatrix}"],
      ["\\end{bmatrix}"],
      ["\\left\\{"],
      ["\\right\\}"],
      ["Var(X)"],
      ["Cov(X,Y)"],
    ],
    snippetTokens: [["\\begin{bmatrix}"], ["\\end{bmatrix}"], ["\\left\\{"]],
  },
  {
    name: "Bmatrix long coupled terms",
    input: "Bmatrix-long",
    actions: [
      { suggest: "Bmatrix", pickIndex: 0 },
      "∂u/∂t+Δu+u^3",
      { key: "Tab" },
      "∫(0→∞)e^(-st)f(t)dt",
      { key: "Tab" },
      "Γ(α+β)/(Γ(α)Γ(β))",
      { key: "Tab" },
      "argmin(θ)L(θ)+β||θ||^2",
    ],
    checks: [
      ["\\begin{Bmatrix}", "\\begin{bmatrix}"],
      ["\\end{Bmatrix}", "\\end{bmatrix}"],
      ["\\partial", "∂"],
      ["\\Gamma", "Γ"],
      ["argmin"],
    ],
    snippetTokens: [["\\begin{Bmatrix}", "\\begin{bmatrix}"], ["\\end{Bmatrix}", "\\end{bmatrix}"]],
  },
  {
    name: "vmatrix long determinant-like",
    input: "vmatrix-long",
    actions: [
      { suggest: "vmatrix", pickIndex: 0 },
      "det(A+λI)",
      { key: "Tab" },
      "tr(B^TB)",
      { key: "Tab" },
      "Σ(i=1→n)(xi-μ)^2",
      { key: "Tab" },
      "∂^2u/∂x^2+∂^2u/∂y^2",
    ],
    checks: [["\\begin{vmatrix}"], ["\\end{vmatrix}"], ["det("], ["tr("], ["\\partial^2u", "∂^2u"]],
    snippetTokens: [["\\begin{vmatrix}"], ["\\end{vmatrix}"], ["det("]],
  },
  {
    name: "Vmatrix long norm-like",
    input: "Vmatrix-long",
    actions: [
      { suggest: "Vmatrix", pickIndex: 0 },
      "||x||^2+||y||^2",
      { key: "Tab" },
      "∇×F+∇·F",
      { key: "Tab" },
      "lim(n→∞)Σ(k=1→n)1/k",
      { key: "Tab" },
      "exp(iωt)+cos(ωt)",
    ],
    checks: [
      ["\\begin{Vmatrix}", "\\begin{vmatrix}"],
      ["\\end{Vmatrix}", "\\end{vmatrix}"],
      ["\\nabla", "∇"],
      ["\\omega", "ω"],
      ["\\Sigma", "Σ"],
    ],
    snippetTokens: [["\\begin{Vmatrix}", "\\begin{vmatrix}"], ["\\end{Vmatrix}", "\\end{vmatrix}"]],
  },
  {
    name: "smallmatrix dense operators",
    input: "smallmatrix-dense",
    actions: [
      { suggest: "smallmatrix", pickIndex: 0 },
      "E[X|Y]",
      { key: "Tab" },
      "P(A|B)",
      { key: "Tab" },
      "∂f/∂x",
      { key: "Tab" },
      "∫(0→1)g(x)dx",
    ],
    checks: [["\\begin{smallmatrix}"], ["\\end{smallmatrix}"], ["E[X|Y]"], ["\\partial", "∂"], ["\\int", "∫"]],
    snippetTokens: [["\\begin{smallmatrix}"], ["\\end{smallmatrix}"]],
  },
  {
    name: "cases long nonlinear conditions",
    input: "cases-long",
    actions: [
      { suggest: "cases", pickIndex: 0 },
      "x^3+αx",
      { key: "Tab" },
      "x>0",
      { key: "Tab" },
      "-x^3+βx",
      { key: "Tab" },
      "x≤0",
    ],
    checks: [["\\begin{cases}"], ["\\end{cases}"], ["x>0"], ["x\\le0", "x≤0"], ["\\alpha", "α"], ["\\beta", "β"]],
    snippetTokens: [["\\begin{cases}"], ["\\end{cases}"], ["x\\le", "x≤"]],
  },
  {
    name: "dcases long conditional integrals",
    input: "dcases-long",
    actions: [
      { suggest: "dcases", pickIndex: 0 },
      "∫(0→x)t^2dt",
      { key: "Tab" },
      "x≥0",
      { key: "Tab" },
      "-∫(x→0)t^2dt",
      { key: "Tab" },
      "x<0",
    ],
    checks: [
      ["\\begin{dcases}", "\\begin{cases}"],
      ["\\end{dcases}", "\\end{cases}"],
      ["\\int", "∫"],
      ["x\\ge0", "x≥0"],
    ],
    snippetTokens: [["\\begin{dcases}", "\\begin{cases}"], ["\\end{dcases}", "\\end{cases}"]],
  },
  {
    name: "rcases long boundary constraints",
    input: "rcases-long",
    actions: [
      { suggest: "rcases", pickIndex: 0 },
      "u(x,t)",
      { key: "Tab" },
      "x∈Ω",
      { key: "Tab" },
      "∂u/∂n",
      { key: "Tab" },
      "x∈∂Ω",
    ],
    checks: [
      ["\\begin{rcases}", "\\begin{cases}"],
      ["\\end{rcases}", "\\end{cases}"],
      ["\\partialu/\\partialn", "∂u/∂n"],
      ["\\Omega", "Ω"],
    ],
    snippetTokens: [["\\begin{rcases}", "\\begin{cases}"], ["\\end{rcases}", "\\end{cases}"]],
  },
  {
    name: "aligned suggestion long PDE pair",
    input: "aligned-long",
    actions: [
      { suggest: "aligned", pickIndex: 0 },
      "∂u/∂t+∇·(uv)",
      { key: "Tab" },
      "0",
      { key: "Tab" },
      "∂v/∂t-Δv",
      { key: "Tab" },
      "f(v)",
    ],
    checks: [["\\begin{aligned}"], ["\\end{aligned}"], ["\\&=", "&="], ["\\partial", "∂"], ["\\Delta", "Δ"]],
    snippetTokens: [["\\begin{aligned}"], ["\\end{aligned}"], ["\\partial", "∂"]],
  },
  {
    name: "array cc dense operators",
    input: "array-cc-long",
    actions: [
      { suggest: "array", pickIndex: 0 },
      "∂u/∂t",
      { key: "Tab" },
      "Δu+f",
      { key: "Tab" },
      "u(0,x)",
      { key: "Tab" },
      "u0(x)",
    ],
    checks: [["\\begin{array}{cc}"], ["\\end{array}"], ["\\partial", "∂"], ["\\Delta", "Δ"], ["&"]],
    snippetTokens: [["\\begin{array}{cc}"], ["\\end{array}"]],
    minLineBreaks: 1,
    minAmpersands: 2,
  },
  {
    name: "array ccc long mixed cells",
    input: "array-ccc-long",
    actions: [
      { suggest: "array", pickIndex: 1 },
      "x1",
      { key: "Tab" },
      "x2",
      { key: "Tab" },
      "x3",
      { key: "Tab" },
      "∫(0→1)x^2dx",
      { key: "Tab" },
      "Σ(k=1→n)k^(-1)",
      { key: "Tab" },
      "lim(r→∞)(1+1/r)^r",
    ],
    checks: [["\\begin{array}{ccc}"], ["\\end{array}"], ["\\int", "∫"], ["\\Sigma", "Σ"], ["\\infty", "∞"]],
    snippetTokens: [["\\begin{array}{ccc}"], ["\\end{array}"], ["\\Sigma", "Σ"]],
    minLineBreaks: 1,
    minAmpersands: 4,
  },
  {
    name: "array rcl aligned equations",
    input: "array-rcl-long",
    actions: [
      { suggest: "array", pickIndex: 2 },
      "∇·E",
      { key: "Tab" },
      "ρ/ε0",
      { key: "Tab" },
      "∇×B",
      { key: "Tab" },
      "μ0J+μ0ε0∂E/∂t",
    ],
    checks: [
      ["\\begin{array}{rcl}"],
      ["\\end{array}"],
      ["\\nabla", "∇"],
      ["\\partialE/\\partialt", "∂E/∂t"],
      ["\\&=\\&", "&=&"],
    ],
    snippetTokens: [["\\begin{array}{rcl}"], ["\\end{array}"], ["\\nabla", "∇"]],
    minLineBreaks: 1,
    minAmpersands: 4,
  },
  {
    name: "middle delimiter long pair",
    input: "middle-long",
    actions: [{ suggest: "middle", pickIndex: 0 }, "Σ(k=1→n)ak", { key: "Tab" }, "∫(0→1)x^2dx"],
    checks: [["\\left("], ["\\middle|", "\\middle{|}"], ["\\right)"], ["\\Sigma", "Σ"], ["\\int", "∫"]],
    snippetTokens: [["\\middle|", "\\middle{|}"], ["\\left("], ["\\right)"]],
  },
  {
    name: "brace delimiter long expression",
    input: "brace-long",
    actions: [{ suggest: "brace", pickIndex: 0 }, "argmin(θ)L(θ)+β||θ||^2"],
    checks: [["\\left\\{"], ["\\right\\}"], ["argmin"], ["\\theta", "θ"], ["\\beta", "β"]],
    snippetTokens: [["\\left\\{"], ["\\right\\}"], ["argmin"]],
  },
  {
    name: "operatorname long with trailing term",
    input: "operatorname-long",
    actions: [{ suggest: "op", pickIndex: 0 }, "Var", { key: "ArrowRight" }, "(X|Y)=E(X^2)-E(X)^2"],
    checks: [["\\operatorname{Var}", "\\operatorname{}Var"], ["E(X^2)"], ["(X|Y)"]],
    snippetTokens: [["\\operatorname{", "\\operatorname{}"], ["E(X^2)"]],
  },
  {
    name: "align mode long single-line identity",
    input: "align-mode-long",
    mode: "align",
    actions: ["F(s)&=∫(0→∞)e^(-st)f(t)dt+(s+1)^(-1)(f(0)+G(s))"],
    checks: [["\\int", "∫"], ["\\&=", "&="], ["F(s)"], ["G(s)"]],
    snippetTokens: [["\\begin{align*}", "\\begin{align}"], ["\\end{align*}", "\\end{align}"], ["F(s)"]],
  },
  {
    name: "gather mode long single-line PDE",
    input: "gather-mode-long",
    mode: "gather",
    actions: ["∂u/∂t-Δu+βu=f(x,t),u(0,x)=u0(x),u|Γ=0"],
    checks: [["\\partial", "∂"], ["\\Delta", "Δ"], ["u0(x)"], ["\\Gamma", "Γ"]],
    snippetTokens: [["\\begin{gather*}", "\\begin{gather}"], ["\\end{gather*}", "\\end{gather}"], ["u0(x)"]],
  },
  {
    name: "matrix escaped ampersand with add-column",
    input: "matrix-escaped-amp-addcol",
    actions: [
      { suggest: "matrix", pickIndex: 0 },
      "A\\&B+C",
      { key: "Tab" },
      "x+y",
      { key: "Tab" },
      "m+n",
      { key: "Tab" },
      "p+q",
      { key: "Shift+Tab" },
      { key: "Shift+Tab" },
      { key: "Shift+Tab" },
      { key: addColumnShortcut },
      "z+w",
    ],
    checks: [["\\begin{matrix}"], ["\\end{matrix}"], ["\\&"], ["A\\&B+C", "A\\backslash\\&B+C"], ["z+w"]],
    snippetTokens: [["\\begin{matrix}"], ["\\end{matrix}"], ["\\&"], ["z+w"]],
    minAmpersands: 5,
    allowRawSlash: true,
  },
  {
    name: "matrix shift-tab roundtrip integrity",
    input: "matrix-shifttab-roundtrip",
    actions: [
      { suggest: "matrix", pickIndex: 0 },
      "q11",
      { key: "Tab" },
      "q12",
      { key: "Shift+Tab" },
      "q11x",
      { key: "Tab" },
      { key: "Tab" },
      "q21",
      { key: "Tab" },
      "q22",
    ],
    checks: [["\\begin{matrix}"], ["\\end{matrix}"], ["q11x"], ["q12"], ["q21"], ["q22"]],
    snippetTokens: [["\\begin{matrix}"], ["\\end{matrix}"], ["q11x"]],
  },
];

const runOnce = async () => {
  const from = Math.max(1, Number.parseInt(process.env.E2E_STRUCTURAL_FROM ?? "1", 10) || 1);
  const toInput =
    Number.parseInt(process.env.E2E_STRUCTURAL_TO ?? String(STRUCTURAL_BREAKAGE_CASES.length), 10) ||
    STRUCTURAL_BREAKAGE_CASES.length;
  const to = Math.min(STRUCTURAL_BREAKAGE_CASES.length, Math.max(from, toInput));
  const formulas = STRUCTURAL_BREAKAGE_CASES.slice(from - 1, to);
  assert.ok(
    STRUCTURAL_BREAKAGE_CASES.length >= 20,
    "structural breakage dataset must contain at least 20 entries"
  );

  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const userDataPath = path.join(tempDir, "user-data");
  let electronApp;
  let currentInsertMode = "inline";

  try {
    log(`workspace copy ${workspacePath}`);
    log(`formula range ${from}-${to} / total ${STRUCTURAL_BREAKAGE_CASES.length}`);
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
      const label = `[${seq}/${STRUCTURAL_BREAKAGE_CASES.length}] ${formula.name}`;
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
      await assertRenderStable(page, label, { allowRawSlash: formula.allowRawSlash === true });

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

    log("math-wysiwyg structural breakage probes e2e passed");
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
  throw lastError ?? new Error("math-wysiwyg structural breakage probes e2e failed");
};

run().catch((error) => {
  console.error("[math-wysiwyg-structural-breakage-probes-e2e] FAILED");
  console.error(error);
  process.exitCode = 1;
});
