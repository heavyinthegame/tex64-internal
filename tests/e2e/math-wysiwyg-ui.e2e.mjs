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
const verboseDebug = process.env.E2E_DEBUG === "1";
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "120", 10);
const typeDelayMs = Number.parseInt(process.env.E2E_TYPE_DELAY_MS ?? "30", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "0", 10);
const isMac = process.platform === "darwin";
const selectAllShortcut = isMac ? "Meta+A" : "Control+A";
const explicitSuggestShortcut = isMac ? "Meta+." : "Control+.";

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[math-wysiwyg-ui-e2e ${now()}] ${message}`);
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-math-wysiwyg-ui-"));
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

const getMathFieldState = async (page) =>
  page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    if (!field || typeof field.getValue !== "function") {
      return null;
    }
    const api = /** @type {any} */ (field);
    return {
      latex: String(api.getValue("latex") ?? ""),
      selection: api.selection ?? null,
      position: typeof api.position === "number" ? api.position : null,
      environmentContext:
        typeof api.getEnvironmentContext === "function" ? api.getEnvironmentContext() : null,
    };
  });

const clearMathField = async (page) => {
  await focusMathField(page);
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press(selectAllShortcut);
    await page.keyboard.press("Backspace");
    await pause(40);
    const current = normalizeLatex(await getMathFieldLatex(page));
    if (!current) return;
  }
  assert.equal(normalizeLatex(await getMathFieldLatex(page)), "", "failed to clear math-field");
};

const waitForSuggestions = async (page, expectedHint = "") => {
  const needle = String(expectedHint ?? "").trim().toLowerCase();
  await page.waitForFunction(
    (hint) => {
      const panel = document.querySelector(".math-wysiwyg-panel");
      if (!(panel instanceof HTMLElement)) return false;
      if (panel.getAttribute("aria-hidden") !== "false") return false;
      const items = Array.from(panel.querySelectorAll(".math-wysiwyg-item"));
      if (items.length === 0) return false;
      if (!hint) return true;
      return items.some((item) => {
        const label = (item.querySelector(".math-wysiwyg-label")?.textContent ?? "")
          .trim()
          .toLowerCase();
        return label === hint;
      });
    },
    needle,
    { timeout: 10000 }
  );
};

const getSuggestionSnapshot = async (page) =>
  page.evaluate(() => {
    const panel = document.querySelector(".math-wysiwyg-panel");
    if (!(panel instanceof HTMLElement)) {
      return { visible: false, items: [] };
    }
    const visible = panel.getAttribute("aria-hidden") === "false";
    const items = Array.from(panel.querySelectorAll(".math-wysiwyg-item")).map((item) => ({
      hint: (item.querySelector(".math-wysiwyg-label")?.textContent ?? "").trim(),
      text: (item.textContent ?? "").replace(/\\s+/g, " ").trim(),
    }));
    return { visible, items };
  });

const getActiveSuggestionState = async (page) =>
  page.evaluate(() => {
    const panel = document.querySelector(".math-wysiwyg-panel");
    if (!(panel instanceof HTMLElement)) {
      return { visible: false, count: 0, activeIndex: -1 };
    }
    const visible = panel.getAttribute("aria-hidden") === "false";
    const items = Array.from(panel.querySelectorAll(".math-wysiwyg-item"));
    const activeIndex = items.findIndex((item) => item.classList.contains("is-active"));
    return { visible, count: items.length, activeIndex };
  });

const waitForSuggestionsClosed = async (page, timeout = 5000) => {
  await page.waitForFunction(
    () => {
      const panel = document.querySelector(".math-wysiwyg-panel");
      if (!(panel instanceof HTMLElement)) return true;
      return panel.getAttribute("aria-hidden") !== "false";
    },
    undefined,
    { timeout }
  );
};

const normalizeCandidateLabel = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const moveToSuggestion = async (
  page,
  options = /** @type {{ pickIndex?: number; targetLabel?: string }} */ ({})
) => {
  const pickIndex = Number.isFinite(options.pickIndex) ? Math.max(0, options.pickIndex) : 0;
  let targetIndex = pickIndex;
  if (options.targetLabel) {
    const target = normalizeCandidateLabel(options.targetLabel);
    const labels = await page.evaluate(() => {
      const panel = document.querySelector(".math-wysiwyg-panel");
      if (!(panel instanceof HTMLElement)) {
        return [];
      }
      return Array.from(panel.querySelectorAll(".math-wysiwyg-item .math-wysiwyg-label")).map(
        (node) => (node.textContent ?? "").replace(/\s+/g, " ").trim()
      );
    });
    targetIndex = labels.findIndex((label) => normalizeCandidateLabel(label) === target);
    if (targetIndex < 0) {
      throw new Error(
        `target label not found: ${options.targetLabel} (labels=${JSON.stringify(labels)})`
      );
    }
  }
  for (let i = 0; i < targetIndex; i += 1) {
    await page.keyboard.press("ArrowDown");
    await pause(30);
  }
};

const applySuggestionByTyping = async (
  page,
  token,
  options = /** @type {{ pickIndex?: number; expectedHint?: string; keepCursor?: boolean; targetLabel?: string }} */ ({})
) => {
  const expectedHint = options.expectedHint ?? token.replace(/^\/\/+/, "");
  if (!options.keepCursor) {
    await focusMathField(page);
  }
  await page.keyboard.type(token, { delay: typeDelayMs });
  try {
    await waitForSuggestions(page, expectedHint);
  } catch {
    if (verboseDebug) {
      const debugState = await getMathFieldState(page);
      const debugPanel = await getSuggestionSnapshot(page);
      log(
        `[debug] suggestion miss token=${token} hint=${expectedHint} state=${JSON.stringify(
          debugState
        )} panel=${JSON.stringify(debugPanel)}`
      );
    }
    await page.keyboard.press(explicitSuggestShortcut);
    await waitForSuggestions(page, expectedHint);
  }
  await moveToSuggestion(page, { pickIndex: options.pickIndex, targetLabel: options.targetLabel });
  if (verboseDebug && token === "sum") {
    const beforeApply = await getMathFieldState(page);
    log(`[debug] before sum apply: ${JSON.stringify(beforeApply)}`);
  }
  await page.keyboard.press("Enter");
  try {
    await waitForSuggestionsClosed(page, 1200);
  } catch {
    await page.keyboard.press("Escape");
    await waitForSuggestionsClosed(page, 5000);
  }
  if (verboseDebug && token === "sum") {
    const afterApply = await getMathFieldState(page);
    log(`[debug] after sum apply: ${JSON.stringify(afterApply)}`);
  }
  await pause(60);
};

const applySuggestionViaExplicitSession = async (
  page,
  token,
  options = /** @type {{ expectedHint?: string; pickIndex?: number; keepCursor?: boolean; targetLabel?: string }} */ ({})
) => {
  const expectedHint = options.expectedHint ?? token;
  if (!options.keepCursor) {
    await focusMathField(page);
  }
  await page.keyboard.press("Backslash");
  try {
    await waitForSuggestions(page);
  } catch {
    await page.keyboard.press(explicitSuggestShortcut);
    await waitForSuggestions(page);
  }
  await page.keyboard.type(token, { delay: typeDelayMs });
  await waitForSuggestions(page, expectedHint);
  await moveToSuggestion(page, { pickIndex: options.pickIndex, targetLabel: options.targetLabel });
  if (verboseDebug) {
    const state = await getMathFieldState(page);
    log(`[debug] explicit before apply token=${token} state=${JSON.stringify(state)}`);
  }
  await page.keyboard.press("Enter");
  await waitForSuggestionsClosed(page, 5000);
  if (verboseDebug) {
    const state = await getMathFieldState(page);
    log(`[debug] explicit commit token=${token} state=${JSON.stringify(state)}`);
  }
  await pause(60);
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

const getAudioFeedbackConfig = async (page) =>
  page.evaluate(() => {
    const stringify = (value) => {
      if (value === null) return "null";
      if (value === undefined) return "undefined";
      if (typeof value === "string") return value;
      if (typeof value === "boolean") return value ? "true" : "false";
      return String(value);
    };

    const mathfieldElement =
      window.MathLive?.MathfieldElement ?? window.MathfieldElement ?? null;
    const mathVirtualKeyboard = window.mathVirtualKeyboard ?? null;

    return {
      global: {
        soundsDirectory: stringify(mathfieldElement?.soundsDirectory),
        keypressSound: stringify(mathfieldElement?.keypressSound),
        plonkSound: stringify(mathfieldElement?.plonkSound),
        keypressVibration: stringify(mathfieldElement?.keypressVibration),
      },
      virtualKeyboard: {
        exists: Boolean(mathVirtualKeyboard),
        keypressSound: stringify(mathVirtualKeyboard?.keypressSound),
        plonkSound: stringify(mathVirtualKeyboard?.plonkSound),
        keypressVibration: stringify(mathVirtualKeyboard?.keypressVibration),
      },
    };
  });

const assertRenderHealthy = async (page, label, { allowPlaceholder = true } = {}) => {
  const snapshot = await getRenderSnapshot(page);
  assert.ok(snapshot, `${label}: render snapshot unavailable`);
  assert.equal(snapshot.errorCount, 0, `${label}: render has MathLive error node(s)`);
  if (!allowPlaceholder) {
    assert.equal(snapshot.placeholderCount, 0, `${label}: unresolved placeholder remains`);
  }
  assert.ok(!snapshot.rawText.includes("\\"), `${label}: raw LaTeX leaked in render (${snapshot.rawText})`);
};

const COMPLEX_FORMULA_ENVIRONMENTS = ["pmatrix", "bmatrix", "vmatrix", "cases", "dcases"];

const COMPLEX_FORMULA_PROFILES = [
  [
    { token: "frac", values: ["a", "b"], expect: "frac" },
    { token: "binom", values: ["c", "d"], expect: "binom" },
    { token: "frac", values: ["e", "f"], expect: "frac" },
    { token: "binom", values: ["g", "h"], expect: "binom" },
  ],
  [
    { token: "binom", values: ["i", "j"], expect: "binom" },
    { token: "frac", values: ["k", "l"], expect: "frac" },
    { token: "binom", values: ["m", "n"], expect: "binom" },
    { token: "frac", values: ["o", "p"], expect: "frac" },
  ],
  [
    { token: "frac", values: ["q", "r"], expect: "frac" },
    { token: "frac", values: ["s", "t"], expect: "frac" },
    { token: "binom", values: ["u", "v"], expect: "binom" },
    { token: "binom", values: ["w", "x"], expect: "binom" },
  ],
  [
    { token: "binom", values: ["y", "z"], expect: "binom" },
    { token: "binom", values: ["a", "c"], expect: "binom" },
    { token: "frac", values: ["d", "g"], expect: "frac" },
    { token: "frac", values: ["h", "i"], expect: "frac" },
  ],
  [
    { token: "frac", values: ["j", "k"], expect: "frac" },
    { token: "binom", values: ["l", "m"], expect: "binom" },
    { token: "binom", values: ["n", "o"], expect: "binom" },
    { token: "frac", values: ["p", "q"], expect: "frac" },
  ],
  [
    { token: "binom", values: ["r", "s"], expect: "binom" },
    { token: "frac", values: ["t", "u"], expect: "frac" },
    { token: "frac", values: ["v", "w"], expect: "frac" },
    { token: "binom", values: ["x", "y"], expect: "binom" },
  ],
  [
    { token: "frac", values: ["z", "a"], expect: "frac" },
    { token: "binom", values: ["b", "d"], expect: "binom" },
    { token: "frac", values: ["e", "h"], expect: "frac" },
    { token: "binom", values: ["i", "j"], expect: "binom" },
  ],
  [
    { token: "binom", values: ["k", "l"], expect: "binom" },
    { token: "frac", values: ["m", "n"], expect: "frac" },
    { token: "binom", values: ["o", "p"], expect: "binom" },
    { token: "frac", values: ["q", "r"], expect: "frac" },
  ],
  [
    { token: "frac", values: ["s", "t"], expect: "frac" },
    { token: "frac", values: ["u", "v"], expect: "frac" },
    { token: "binom", values: ["w", "x"], expect: "binom" },
    { token: "binom", values: ["y", "z"], expect: "binom" },
  ],
  [
    { token: "binom", values: ["a", "b"], expect: "binom" },
    { token: "binom", values: ["c", "d"], expect: "binom" },
    { token: "frac", values: ["e", "f"], expect: "frac" },
    { token: "frac", values: ["g", "h"], expect: "frac" },
  ],
];

const fillPlaceholderTemplateFromSuggestion = async (
  page,
  step,
  options = /** @type {{ moveNext?: boolean; caseLabel?: string; cellIndex?: number }} */ ({})
) => {
  const moveNext = options.moveNext ?? true;
  try {
    await applySuggestionViaExplicitSession(page, step.token, {
      expectedHint: step.expectedHint ?? step.token,
      pickIndex: Number.isFinite(step.pickIndex) ? step.pickIndex : 0,
      targetLabel: step.targetLabel,
      keepCursor: true,
    });
  } catch (error) {
    const prefix =
      options.caseLabel || Number.isFinite(options.cellIndex)
        ? `${options.caseLabel ?? "complex"} cell=${(options.cellIndex ?? -1) + 1}`
        : "complex";
    throw new Error(
      `${prefix}: suggestion apply failed token=${step.token} pickIndex=${String(
        step.pickIndex ?? 0
      )} hint=${step.expectedHint ?? step.token}: ${String(error)}`
    );
  }
  const values = Array.isArray(step.values) ? step.values : [];
  for (let i = 0; i < values.length; i += 1) {
    await page.keyboard.type(String(values[i] ?? ""), { delay: typeDelayMs });
    await pause(40);
    if (i < values.length - 1) {
      await moveToNextPlaceholder(page);
      await pause(40);
    }
  }
  if (moveNext && values.length > 0) {
    await moveToNextPlaceholder(page);
    await pause(40);
  }
};

const runComplexPlaceholderFormula = async (page, entry, total) => {
  const { envToken, profile, index } = entry;
  const caseLabel = `complex ${index + 1}/${total} ${envToken}-p${entry.profileIndex + 1}`;
  await clearMathField(page);
  await applySuggestionViaExplicitSession(page, envToken, { expectedHint: envToken });
  for (let cellIndex = 0; cellIndex < profile.length; cellIndex += 1) {
    const step = profile[cellIndex];
    await fillPlaceholderTemplateFromSuggestion(page, step, {
      moveNext: cellIndex < profile.length - 1,
      caseLabel,
      cellIndex,
    });
  }

  const latex = normalizeLatex(await getMathFieldLatex(page));
  const beginTag = `\\begin{${envToken}}`;
  const endTag = `\\end{${envToken}}`;
  const beginPos = latex.indexOf(beginTag);
  const endPos = latex.indexOf(endTag);

  assert.ok(beginPos >= 0 && endPos > beginPos, `${caseLabel}: environment wrapper missing (${latex})`);
  const body = latex.slice(beginPos, endPos + endTag.length);
  assert.ok(body.includes("&"), `${caseLabel}: column separator missing (${latex})`);
  assert.ok(body.includes("\\\\"), `${caseLabel}: row separator missing (${latex})`);

  for (const step of profile) {
    if (!step.expect) continue;
    assert.ok(latex.includes(step.expect), `${caseLabel}: missing ${step.expect} (${latex})`);
  }
  await assertRenderHealthy(page, caseLabel, { allowPlaceholder: false });
};

const insertCommandSuggestion = async (
  page,
  token,
  options = /** @type {{ expectedHint?: string; pickIndex?: number }} */ ({})
) => {
  await applySuggestionViaExplicitSession(page, token, {
    expectedHint: options.expectedHint ?? token,
    pickIndex: options.pickIndex,
    keepCursor: true,
  });
};

const typeMathText = async (page, text) => {
  await page.keyboard.type(String(text ?? ""), { delay: typeDelayMs });
  await pause(40);
};

const moveCursorLeft = async (page, count) => {
  const steps = Math.max(0, Math.floor(count));
  for (let i = 0; i < steps; i += 1) {
    await page.keyboard.press("ArrowLeft");
  }
  await pause(40);
};

const moveToNextPlaceholder = async (page) => {
  await page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    const api = /** @type {{ executeCommand?: (command: string) => boolean | void } | null } */ (field);
    const executeCommand = api?.executeCommand;
    if (typeof executeCommand === "function") {
      executeCommand.call(field, "moveToNextPlaceholder");
    }
  });
  await pause(40);
};

const RISKY_FORMULA_SCENARIOS = [
  {
    id: "matrix-sum-pi-frac-sqrt",
    expected: ["\\begin{pmatrix}", "\\sum", "\\pi", "\\frac", "\\sqrt"],
    build: async (page) => {
      await insertCommandSuggestion(page, "pmatrix");
      await insertCommandSuggestion(page, "sum");
      await typeMathText(page, "_{i}^{n}");
      await moveToNextPlaceholder(page);
      await pause(30);
      await insertCommandSuggestion(page, "pi");
      await typeMathText(page, "_{k}^{r}");
      await moveToNextPlaceholder(page);
      await pause(30);
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "frac", values: ["a", "b"] },
        { moveNext: true }
      );
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "sqrt", values: ["x"] },
        { moveNext: false }
      );
    },
  },
  {
    id: "cases-frac-lim-derivative",
    expected: ["\\begin{cases}", "\\frac", "\\lim"],
    build: async (page) => {
      await insertCommandSuggestion(page, "cases");
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "frac", values: ["1", "x"] },
        { moveNext: true }
      );
      await typeMathText(page, "x!=0");
      await moveToNextPlaceholder(page);
      await pause(30);
      await insertCommandSuggestion(page, "lim");
      await typeMathText(page, "_h");
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "frac", values: ["f(x+h)-f(x)", "h"] },
        { moveNext: true }
      );
      await typeMathText(page, "x=0");
    },
  },
  {
    id: "frac-sum-binom-prod",
    expected: ["\\sum", "\\binom", "\\prod", "\\frac"],
    build: async (page) => {
      await insertCommandSuggestion(page, "sum");
      await typeMathText(page, "_{i=1}^{n}");
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "binom", values: ["n", "i"] },
        { moveNext: false }
      );
      await typeMathText(page, "+");
      await insertCommandSuggestion(page, "prod");
      await typeMathText(page, "_{j=1}^{m}");
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "frac", values: ["1", "j"] },
        { moveNext: false }
      );
    },
  },
  {
    id: "sqrt-frac-sqrt",
    expected: ["\\sqrt", "\\frac"],
    build: async (page) => {
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "sqrt", values: ["1+x"] },
        { moveNext: false }
      );
      await typeMathText(page, "+");
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "frac", values: ["1+u", "1-v"] },
        { moveNext: false }
      );
      await typeMathText(page, "+");
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "sqrt", values: ["1-y"] },
        { moveNext: false }
      );
    },
  },
  {
    id: "inner-frac-sqrt",
    expected: ["\\langle", "\\frac", "\\sqrt"],
    build: async (page) => {
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "inner", values: [] },
        { moveNext: false }
      );
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "frac", values: ["a+b", "c+d"] },
        { moveNext: true }
      );
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "sqrt", values: ["x^2+y^2"] },
        { moveNext: false }
      );
    },
  },
  {
    id: "int-partial-derivative",
    expected: ["\\int", "\\frac", "\\partial"],
    build: async (page) => {
      await insertCommandSuggestion(page, "int");
      await typeMathText(page, "f");
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "frac", values: [] },
        { moveNext: false }
      );
      await insertCommandSuggestion(page, "partial");
      await typeMathText(page, "^2f");
      await moveToNextPlaceholder(page);
      await pause(30);
      await insertCommandSuggestion(page, "partial");
      await typeMathText(page, "x^2");
    },
  },
  {
    id: "lim-sum-frac",
    expected: ["\\lim", "\\sum", "\\frac", "\\infty"],
    build: async (page) => {
      await insertCommandSuggestion(page, "lim");
      await typeMathText(page, "_{n");
      await insertCommandSuggestion(page, "infty");
      await typeMathText(page, "}");
      await insertCommandSuggestion(page, "sum");
      await typeMathText(page, "_{k=1}^{n}");
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "frac", values: ["1", "k^2"] },
        { moveNext: false }
      );
    },
  },
  {
    id: "binom-script-chain",
    expected: ["\\binom"],
    build: async (page) => {
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "binom", values: ["n", "k"] },
        { moveNext: false }
      );
      await typeMathText(page, "_{i}^{j}");
    },
  },
  {
    id: "aligned-frac-sum",
    expected: ["\\begin{aligned}", "\\frac", "\\sum"],
    build: async (page) => {
      await insertCommandSuggestion(page, "aligned");
      await typeMathText(page, "a");
      await moveToNextPlaceholder(page);
      await pause(30);
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "frac", values: ["1", "x"] },
        { moveNext: true }
      );
      await typeMathText(page, "b");
      await moveToNextPlaceholder(page);
      await pause(30);
      await insertCommandSuggestion(page, "sum");
      await typeMathText(page, "_{i}^{n}x_i");
    },
  },
  {
    id: "aligned-pi-frac-sqrt-sum",
    expected: ["\\begin{aligned}", "\\frac", "\\sqrt", "\\sum"],
    build: async (page) => {
      await insertCommandSuggestion(page, "aligned");
      await typeMathText(page, "p_{i}^{n}");
      await moveToNextPlaceholder(page);
      await pause(30);
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "frac", values: ["a_i", "b_i"] },
        { moveNext: true }
      );
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "sqrt", values: ["x"] },
        { moveNext: true }
      );
      await insertCommandSuggestion(page, "sum");
      await typeMathText(page, "_{j}y_j");
    },
  },
  {
    id: "eval-and-derivative-frac",
    expected: ["\\left.", "\\right|", "\\frac"],
    build: async (page) => {
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "eval", values: ["f(x)", "x=0"] },
        { moveNext: false }
      );
      await typeMathText(page, "+");
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "frac", values: ["d", "dx"] },
        { moveNext: false }
      );
    },
  },
  {
    id: "sum-prod-frac-sqrt",
    expected: ["\\sum", "\\prod", "\\frac", "\\sqrt"],
    build: async (page) => {
      await insertCommandSuggestion(page, "sum");
      await typeMathText(page, "_{i}^{n}");
      await typeMathText(page, "+");
      await insertCommandSuggestion(page, "prod");
      await typeMathText(page, "_{j}^{m}");
      await typeMathText(page, "+");
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "frac", values: ["a", "b"] },
        { moveNext: false }
      );
      await typeMathText(page, "+");
      await fillPlaceholderTemplateFromSuggestion(
        page,
        { token: "sqrt", values: ["x"] },
        { moveNext: false }
      );
    },
  },
];

const runRiskyFormulaScenario = async (page, scenario, index, total) => {
  const prefix = `risky ${index + 1}/${total} ${scenario.id}`;
  await clearMathField(page);
  await scenario.build(page);
  const latex = normalizeLatex(await getMathFieldLatex(page));
  scenario.expected.forEach((snippet) => {
    assert.ok(
      latex.includes(normalizeLatex(snippet)),
      `${prefix} new-input missing ${snippet}: ${latex}`
    );
  });
  await assertRenderHealthy(page, `${prefix} new-input`, { allowPlaceholder: false });

  const moveCount = Math.max(10, Math.min(40, Math.floor(latex.length / 3)));
  await focusMathField(page);
  await moveCursorLeft(page, moveCount);
  await fillPlaceholderTemplateFromSuggestion(
    page,
    { token: "frac", values: ["u", "v"] },
    { moveNext: false, caseLabel: prefix }
  );

  const editedLatex = normalizeLatex(await getMathFieldLatex(page));
  scenario.expected.forEach((snippet) => {
    assert.ok(
      editedLatex.includes(normalizeLatex(snippet)),
      `${prefix} mid-edit missing ${snippet}: ${editedLatex}`
    );
  });
  assert.ok(
    editedLatex.includes("\\frac"),
    `${prefix} mid-edit missing inserted frac: ${editedLatex}`
  );
  await assertRenderHealthy(page, `${prefix} mid-edit`, { allowPlaceholder: false });
};

const MULTILAYER_ENVIRONMENTS = [
  "aligned",
  "matrix",
  "pmatrix",
  "bmatrix",
  "Bmatrix",
  "vmatrix",
  "Vmatrix",
  "smallmatrix",
  "cases",
  "dcases",
];

const MULTILAYER_CELL_PROFILES = [
  [
    { mode: "command", token: "int", suffix: "_{i}^{n}", expect: "\\int" },
    { mode: "command", token: "lim", suffix: "_{j}", expect: "\\lim" },
    { mode: "template", token: "frac", values: ["a", "b"], expect: "\\frac" },
    { mode: "template", token: "sqrt", values: ["x"], expect: "\\sqrt" },
  ],
  [
    { mode: "command", token: "int", suffix: "_{0}^{1}", expect: "\\int" },
    { mode: "command", token: "pi", suffix: "_{k}^{r}", expect: "\\pi" },
    { mode: "template", token: "binom", values: ["n", "k"], expect: "\\binom" },
    { mode: "template", token: "frac", values: ["u", "v"], expect: "\\frac" },
  ],
  [
    { mode: "command", token: "lim", suffix: "_{n}", expect: "\\lim" },
    { mode: "command", token: "alpha", suffix: "_{i}", expect: "\\alpha" },
    { mode: "command", token: "beta", suffix: "^{2}", expect: "\\beta" },
    { mode: "command", token: "gamma", suffix: "_{t}", expect: "\\gamma" },
  ],
  [
    { mode: "command", token: "max", suffix: "_{x}", expect: "\\max" },
    { mode: "command", token: "min", suffix: "_{y}", expect: "\\min" },
    { mode: "command", token: "log", suffix: "_{b}", expect: "\\log" },
    { mode: "template", token: "frac", values: ["p", "q"], expect: "\\frac" },
  ],
  [
    { mode: "command", token: "alpha", suffix: "_{x}", expect: "\\alpha" },
    { mode: "command", token: "beta", suffix: "_{y}", expect: "\\beta" },
    { mode: "template", token: "sqrt", values: ["z"], expect: "\\sqrt" },
    { mode: "template", token: "binom", values: ["r", "s"], expect: "\\binom" },
  ],
];

const applyMultilayerCellSpec = async (
  page,
  spec,
  options = /** @type {{ moveNext?: boolean; caseLabel?: string; cellIndex?: number }} */ ({})
) => {
  const moveNext = options.moveNext ?? true;
  if (spec.mode === "template") {
    await fillPlaceholderTemplateFromSuggestion(
      page,
      {
        token: spec.token,
        values: Array.isArray(spec.values) ? spec.values : [],
        expectedHint: spec.expectedHint,
        pickIndex: spec.pickIndex,
      },
      {
        moveNext,
        caseLabel: options.caseLabel,
        cellIndex: options.cellIndex,
      }
    );
    return;
  }
  if (spec.mode === "command") {
    await insertCommandSuggestion(page, spec.token, {
      expectedHint: spec.expectedHint ?? spec.token,
      pickIndex: spec.pickIndex,
    });
    if (spec.suffix) {
      await typeMathText(page, spec.suffix);
    }
    if (moveNext) {
      await moveToNextPlaceholder(page);
      await pause(30);
    }
    return;
  }
  if (spec.mode === "text") {
    await typeMathText(page, spec.text ?? "");
    if (moveNext) {
      await moveToNextPlaceholder(page);
      await pause(30);
    }
  }
};

const runMultilayerVarietyScenario = async (page, scenario, index, total) => {
  const label = `variety ${index + 1}/${total} ${scenario.envToken}-p${scenario.profileIndex + 1}`;
  await clearMathField(page);
  await applySuggestionViaExplicitSession(page, scenario.envToken, {
    expectedHint: scenario.envToken,
  });
  const profile = scenario.profile;
  for (let i = 0; i < profile.length; i += 1) {
    await applyMultilayerCellSpec(page, profile[i], {
      moveNext: i < profile.length - 1,
      caseLabel: label,
      cellIndex: i,
    });
  }

  const latex = normalizeLatex(await getMathFieldLatex(page));
  const beginCandidates = [
    `\\begin{${scenario.envToken}}`,
    `\\begin{${scenario.envToken.toLowerCase()}}`,
  ];
  const endCandidates = [
    `\\end{${scenario.envToken}}`,
    `\\end{${scenario.envToken.toLowerCase()}}`,
  ];
  const beginTag = beginCandidates.find((candidate) => latex.includes(candidate)) ?? null;
  const endTag = endCandidates.find((candidate) => latex.includes(candidate)) ?? null;
  const beginPos = beginTag ? latex.indexOf(beginTag) : -1;
  const endPos = endTag ? latex.indexOf(endTag) : -1;
  assert.ok(beginPos >= 0 && endPos > beginPos, `${label}: wrapper missing (${latex})`);
  assert.ok(latex.includes("&"), `${label}: column separator missing (${latex})`);
  assert.ok(latex.includes("\\\\"), `${label}: row separator missing (${latex})`);

  profile.forEach((spec) => {
    const expected = spec.expect;
    if (!expected) return;
    assert.ok(latex.includes(normalizeLatex(expected)), `${label}: missing ${expected} (${latex})`);
  });
  await assertRenderHealthy(page, label, { allowPlaceholder: false });
};

const PRACTICAL_MASS_ENVIRONMENTS = [...MULTILAYER_ENVIRONMENTS];

const PRACTICAL_COMMAND_LIBRARY = [
  { token: "alpha", expect: "\\alpha" },
  { token: "beta", expect: "\\beta" },
  { token: "gamma", expect: "\\gamma" },
  { token: "delta", expect: "\\delta" },
  { token: "theta", expect: "\\theta" },
  { token: "mu", expect: "\\mu" },
  { token: "rho", expect: "\\rho" },
  { token: "xi", expect: "\\xi" },
  { token: "lim", expect: "\\lim" },
  { token: "int", expect: "\\int" },
];

const PRACTICAL_SUFFIX_LIBRARY = [
  "_{i}",
  "^{2}",
  "_{k}^{m}",
  "_{t}",
  "_{n}",
];

const PRACTICAL_SYMBOLS = [
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
];

const practicalSymbolAt = (index) =>
  PRACTICAL_SYMBOLS[((index % PRACTICAL_SYMBOLS.length) + PRACTICAL_SYMBOLS.length) % PRACTICAL_SYMBOLS.length];

const buildPracticalMassProfiles = () => {
  const profileCount = 20;
  const profiles = [];
  for (let profileIndex = 0; profileIndex < profileCount; profileIndex += 1) {
    const profile = [];
    for (let cellIndex = 0; cellIndex < 4; cellIndex += 1) {
      const seed = profileIndex * 11 + cellIndex * 7;
      const modePicker = (profileIndex + cellIndex) % 4;
      if (modePicker === 0) {
        const command =
          PRACTICAL_COMMAND_LIBRARY[(profileIndex * 3 + cellIndex) % PRACTICAL_COMMAND_LIBRARY.length];
        const suffix =
          PRACTICAL_SUFFIX_LIBRARY[(profileIndex + cellIndex * 2) % PRACTICAL_SUFFIX_LIBRARY.length];
        profile.push({
          mode: "command",
          token: command.token,
          suffix,
          expect: command.expect,
        });
        continue;
      }
      if (modePicker === 1) {
        profile.push({
          mode: "template",
          token: "frac",
          values: [
            `${practicalSymbolAt(seed)}+${practicalSymbolAt(seed + 1)}`,
            practicalSymbolAt(seed + 2),
          ],
          expect: "\\frac",
        });
        continue;
      }
      if (modePicker === 2) {
        profile.push({
          mode: "template",
          token: "binom",
          values: [practicalSymbolAt(seed + 3), practicalSymbolAt(seed + 4)],
          expect: "\\binom",
        });
        continue;
      }
      profile.push({
        mode: "template",
        token: "sqrt",
        values: [`${practicalSymbolAt(seed)}^2+${practicalSymbolAt(seed + 1)}^2`],
        expect: "\\sqrt",
      });
    }
    profiles.push(profile);
  }
  return profiles;
};

const PRACTICAL_MASS_PROFILES = buildPracticalMassProfiles();

const runPracticalMassScenario = async (page, scenario, index, total) => {
  const label = `practical ${index + 1}/${total} ${scenario.envToken}-p${scenario.profileIndex + 1}`;
  await clearMathField(page);
  await applySuggestionViaExplicitSession(page, scenario.envToken, {
    expectedHint: scenario.envToken,
  });
  const profile = scenario.profile;
  for (let i = 0; i < profile.length; i += 1) {
    await applyMultilayerCellSpec(page, profile[i], {
      moveNext: i < profile.length - 1,
      caseLabel: label,
      cellIndex: i,
    });
  }

  let latex = normalizeLatex(await getMathFieldLatex(page));
  const beginCandidates = [
    `\\begin{${scenario.envToken}}`,
    `\\begin{${scenario.envToken.toLowerCase()}}`,
  ];
  const endCandidates = [
    `\\end{${scenario.envToken}}`,
    `\\end{${scenario.envToken.toLowerCase()}}`,
  ];
  const beginTag = beginCandidates.find((candidate) => latex.includes(candidate)) ?? null;
  const endTag = endCandidates.find((candidate) => latex.includes(candidate)) ?? null;
  const beginPos = beginTag ? latex.indexOf(beginTag) : -1;
  const endPos = endTag ? latex.indexOf(endTag) : -1;
  assert.ok(beginPos >= 0 && endPos > beginPos, `${label}: wrapper missing (${latex})`);
  assert.ok(latex.includes("&"), `${label}: column separator missing (${latex})`);
  assert.ok(latex.includes("\\\\"), `${label}: row separator missing (${latex})`);
  profile.forEach((spec) => {
    if (!spec.expect) return;
    assert.ok(latex.includes(normalizeLatex(spec.expect)), `${label}: missing ${spec.expect} (${latex})`);
  });
  await assertRenderHealthy(page, `${label} new-input`, { allowPlaceholder: false });

  if (index % 5 === 0) {
    await focusMathField(page);
    await moveCursorLeft(page, Math.max(12, Math.min(50, Math.floor(latex.length / 4))));
    await fillPlaceholderTemplateFromSuggestion(
      page,
      { token: "frac", values: ["u", "v"] },
      { moveNext: false, caseLabel: label }
    );
    latex = normalizeLatex(await getMathFieldLatex(page));
    assert.ok(latex.includes("\\frac"), `${label}: mid-edit frac missing (${latex})`);
    const beginStill = beginTag ? latex.includes(beginTag) : beginCandidates.some((candidate) => latex.includes(candidate));
    const endStill = endTag ? latex.includes(endTag) : endCandidates.some((candidate) => latex.includes(candidate));
    assert.ok(beginStill && endStill, `${label}: wrapper lost after mid-edit (${latex})`);
    await assertRenderHealthy(page, `${label} mid-edit`, { allowPlaceholder: false });
  }
};

const runCase = async (label, test) => {
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

    await test(page);
    log(`${label}: passed`);
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

const run = async () => {
  await runCase("[1/17] mathlive audio feedback is disabled", async (page) => {
    const config = await getAudioFeedbackConfig(page);
    assert.equal(config.global.soundsDirectory, "null", `soundsDirectory: ${JSON.stringify(config)}`);
    assert.equal(config.global.keypressVibration, "false", `keypressVibration: ${JSON.stringify(config)}`);
    assert.ok(
      ["null", "[object Object]"].includes(config.global.keypressSound),
      `keypressSound: ${JSON.stringify(config)}`
    );
    assert.ok(["null", "undefined"].includes(config.global.plonkSound), `plonkSound: ${JSON.stringify(config)}`);
    if (config.virtualKeyboard.exists) {
      assert.equal(
        config.virtualKeyboard.keypressSound,
        "null",
        `vk.keypressSound: ${JSON.stringify(config)}`
      );
      assert.equal(
        config.virtualKeyboard.plonkSound,
        "null",
        `vk.plonkSound: ${JSON.stringify(config)}`
      );
      assert.equal(
        config.virtualKeyboard.keypressVibration,
        "false",
        `vk.keypressVibration: ${JSON.stringify(config)}`
      );
    }
  });

  await runCase("[2/17] typed token after existing command is isolated", async (page) => {
    await applySuggestionByTyping(page, "sin", { expectedHint: "sin" });
    await applySuggestionByTyping(page, "sum", { expectedHint: "sum", keepCursor: true });

    const latex = normalizeLatex(await getMathFieldLatex(page));
    assert.ok(latex.includes("\\sin"), `sin should remain: ${latex}`);
    assert.ok(latex.includes("\\sum"), `sum should be inserted as command: ${latex}`);
    assert.ok(!latex.includes("\\sinsum"), `typed token must not merge with existing command: ${latex}`);
    await assertRenderHealthy(page, "isolated token after command render", { allowPlaceholder: true });
  });

  await runCase("[3/17] matrix cell accepts sigma suggestion", async (page) => {
    await applySuggestionByTyping(page, "pmatrix", { expectedHint: "pmatrix" });
    if (verboseDebug) {
      const afterPmatrix = await getMathFieldState(page);
      log(`[debug] after pmatrix: ${JSON.stringify(afterPmatrix)}`);
    }
    await applySuggestionByTyping(page, "sum", { expectedHint: "sum", keepCursor: true });

    const latex = normalizeLatex(await getMathFieldLatex(page));
    const begin = latex.indexOf("\\begin{pmatrix}");
    const end = latex.indexOf("\\end{pmatrix}");
    const sum = latex.indexOf("\\sum");

    assert.ok(begin >= 0 && end > begin, `matrix wrapper missing: ${latex}`);
    assert.ok(sum > begin && sum < end, `sum should stay inside matrix cell: ${latex}`);
    await assertRenderHealthy(page, "matrix sum render", { allowPlaceholder: true });
  });

  await runCase("[4/17] matrix cell keeps sum placeholders stable", async (page) => {
    await applySuggestionByTyping(page, "pmatrix", { expectedHint: "pmatrix" });
    await applySuggestionByTyping(page, "sum", {
      expectedHint: "sum",
      pickIndex: 1,
      keepCursor: true,
    });

    const latex = normalizeLatex(await getMathFieldLatex(page));
    const begin = latex.indexOf("\\begin{pmatrix}");
    const end = latex.indexOf("\\end{pmatrix}");
    const sum = latex.indexOf("\\sum_");
    assert.ok(begin >= 0 && end > begin, `matrix wrapper missing: ${latex}`);
    assert.ok(sum > begin && sum < end, `sum with placeholders must stay in matrix cell: ${latex}`);
    await assertRenderHealthy(page, "matrix sum placeholders render", { allowPlaceholder: true });
  });

  await runCase("[5/17] matrix cell keeps pi placeholders stable", async (page) => {
    await applySuggestionByTyping(page, "pmatrix", { expectedHint: "pmatrix" });
    await applySuggestionByTyping(page, "pi", {
      expectedHint: "pi",
      pickIndex: 1,
      keepCursor: true,
    });

    const latex = normalizeLatex(await getMathFieldLatex(page));
    const begin = latex.indexOf("\\begin{pmatrix}");
    const end = latex.indexOf("\\end{pmatrix}");
    const pi = latex.indexOf("\\pi_");
    assert.ok(begin >= 0 && end > begin, `matrix wrapper missing: ${latex}`);
    assert.ok(pi > begin && pi < end, `pi with placeholders must stay in matrix cell: ${latex}`);
    await assertRenderHealthy(page, "matrix pi placeholders render", { allowPlaceholder: true });
  });

  await runCase("[6/17] //label in matrix hoists outside matrix", async (page) => {
    await applySuggestionByTyping(page, "pmatrix", { expectedHint: "pmatrix" });
    await page.keyboard.type("a", { delay: typeDelayMs });
    await pause(60);

    await applySuggestionByTyping(page, "//label", {
      expectedHint: "//label",
      keepCursor: true,
    });

    const latex = normalizeLatex(await getMathFieldLatex(page));
    const matrixEnd = latex.indexOf("\\end{pmatrix}");
    const labelPos = latex.indexOf("\\label{");

    assert.ok(matrixEnd >= 0, `matrix end missing: ${latex}`);
    assert.ok(labelPos > matrixEnd, `label should be hoisted after matrix: ${latex}`);
    await assertRenderHealthy(page, "matrix label render", { allowPlaceholder: true });
  });

  await runCase("[7/17] fraction placeholders resolve via UI typing + placeholder command", async (page) => {
    await applySuggestionByTyping(page, "frac", { expectedHint: "frac" });
    await page.keyboard.type("a", { delay: typeDelayMs });
    await moveToNextPlaceholder(page);
    await pause(60);
    await page.keyboard.type("b", { delay: typeDelayMs });

    const latex = normalizeLatex(await getMathFieldLatex(page));
    assert.ok(latex.includes("\\frac{a}{b}"), `fraction should resolve both placeholders: ${latex}`);
    await assertRenderHealthy(page, "fraction placeholder render", { allowPlaceholder: false });
  });

  await runCase("[8/17] alpha commit must not reopen stale alpha suggestion", async (page) => {
    await applySuggestionByTyping(page, "alpha", { expectedHint: "alpha" });
    await pause(220);
    const panelAfterCommit = await getSuggestionSnapshot(page);
    assert.equal(
      panelAfterCommit.visible,
      false,
      `suggestion panel reopened after commit: ${JSON.stringify(panelAfterCommit)}`
    );
    await assertRenderHealthy(page, "alpha commit render", { allowPlaceholder: true });
  });

  await runCase("[9/17] sum placeholder keeps \\sum when committing alpha", async (page) => {
    await applySuggestionByTyping(page, "sum", {
      expectedHint: "sum",
      pickIndex: 1,
      keepCursor: true,
    });
    await applySuggestionByTyping(page, "alpha", {
      expectedHint: "alpha",
      keepCursor: true,
    });

    const latex = normalizeLatex(await getMathFieldLatex(page));
    assert.ok(latex.includes("\\sum"), `sum should remain after alpha commit: ${latex}`);
    assert.ok(latex.includes("\\alpha"), `alpha should be committed into placeholder: ${latex}`);
    await assertRenderHealthy(page, "sum placeholder alpha commit render", { allowPlaceholder: true });
  });

  await runCase(
    "[10/17] sum placeholder typing must suggest alpha from local edit buffer only",
    async (page) => {
      await applySuggestionByTyping(page, "sum", {
        expectedHint: "sum",
        pickIndex: 1,
        keepCursor: true,
      });
      await page.keyboard.type("i", { delay: typeDelayMs });
      await moveToNextPlaceholder(page);
      await pause(60);
      await page.keyboard.type("alph", { delay: typeDelayMs });

      await waitForSuggestions(page, "alpha");
      const snapshot = await getSuggestionSnapshot(page);
      const hints = snapshot.items.map((item) => normalizeCandidateLabel(item.hint));
      assert.ok(hints.includes("alpha"), `alpha hint missing in placeholder session: ${JSON.stringify(snapshot)}`);
      assert.ok(!hints.includes("sum"), `sum hint leaked from existing context: ${JSON.stringify(snapshot)}`);

      const activeState = await getActiveSuggestionState(page);
      const activeHint =
        activeState.activeIndex >= 0 ? hints[activeState.activeIndex] ?? "" : "";
      assert.notEqual(
        activeHint,
        "sum",
        `active candidate should not bind to existing sigma context: ${JSON.stringify({
          activeState,
          hints,
        })}`
      );

      await page.keyboard.press("Enter");
      await waitForSuggestionsClosed(page, 5000);
      const latex = normalizeLatex(await getMathFieldLatex(page));
      assert.ok(latex.includes("\\sum"), `sum should remain after local alpha commit: ${latex}`);
      assert.ok(latex.includes("\\alpha"), `alpha should commit into current placeholder: ${latex}`);
      await assertRenderHealthy(page, "sum local alpha suggestion render", {
        allowPlaceholder: true,
      });
    }
  );

  await runCase("[11/17] Tab is candidate-only and never moves placeholders", async (page) => {
    await page.keyboard.type("sum", { delay: typeDelayMs });
    await waitForSuggestions(page, "sum");

    const initial = await getActiveSuggestionState(page);
    assert.equal(initial.visible, true, `suggestions must be visible: ${JSON.stringify(initial)}`);
    assert.ok(initial.count > 1, `sum should expose multiple candidates: ${JSON.stringify(initial)}`);
    const initialIndex = initial.activeIndex < 0 ? 0 : initial.activeIndex;

    await page.keyboard.press("Tab");
    await pause(60);
    const afterTab = await getActiveSuggestionState(page);
    assert.equal(
      afterTab.activeIndex,
      (initialIndex + 1) % initial.count,
      `Tab should advance candidate index: before=${JSON.stringify(initial)} after=${JSON.stringify(afterTab)}`
    );

    await page.keyboard.press("Shift+Tab");
    await pause(60);
    const afterShiftTab = await getActiveSuggestionState(page);
    assert.equal(
      afterShiftTab.activeIndex,
      initialIndex,
      `Shift+Tab should reverse candidate index: before=${JSON.stringify(afterTab)} after=${JSON.stringify(afterShiftTab)}`
    );

    await page.keyboard.press("Enter");
    await waitForSuggestionsClosed(page, 5000);

    await clearMathField(page);
    await applySuggestionByTyping(page, "frac", { expectedHint: "frac" });
    await page.keyboard.type("a", { delay: typeDelayMs });
    await page.keyboard.press("Escape");
    await waitForSuggestionsClosed(page, 5000);

    const beforeTab = await getMathFieldState(page);
    await page.keyboard.press("Tab");
    await pause(80);
    const afterPlaceholderTab = await getMathFieldState(page);

    assert.ok(beforeTab, "math-field state missing before Tab");
    assert.ok(afterPlaceholderTab, "math-field state missing after Tab");
    assert.equal(
      normalizeLatex(afterPlaceholderTab?.latex ?? ""),
      normalizeLatex(beforeTab?.latex ?? ""),
      `Tab must not rewrite formula while no candidate is active`
    );
    assert.equal(
      afterPlaceholderTab?.position ?? null,
      beforeTab?.position ?? null,
      `Tab must not move placeholder focus when suggestion panel is closed`
    );
    assert.equal(
      JSON.stringify(afterPlaceholderTab?.selection ?? null),
      JSON.stringify(beforeTab?.selection ?? null),
      `Tab must keep selection stable when suggestion panel is closed`
    );

    await assertRenderHealthy(page, "tab candidate-only behavior render", { allowPlaceholder: true });
  });

  await runCase("[12/17] Enter adds matrix row without structure break", async (page) => {
    await applySuggestionByTyping(page, "pmatrix", { expectedHint: "pmatrix" });
    await page.keyboard.type("a", { delay: typeDelayMs });
    await page.keyboard.press("Enter");
    await pause(80);
    await page.keyboard.type("b", { delay: typeDelayMs });

    const latex = normalizeLatex(await getMathFieldLatex(page));
    const begin = latex.indexOf("\\begin{pmatrix}");
    const end = latex.indexOf("\\end{pmatrix}");
    const rowBreak = latex.indexOf("\\\\");
    const matrixBodyStart = begin >= 0 ? begin + "\\begin{pmatrix}".length : 0;
    const aPos = latex.indexOf("a", matrixBodyStart);
    const bPos = rowBreak >= 0 ? latex.indexOf("b", rowBreak + 2) : -1;

    assert.ok(begin >= 0 && end > begin, `matrix wrapper missing: ${latex}`);
    assert.ok(rowBreak > begin && rowBreak < end, `matrix row break missing: ${latex}`);
    assert.ok(aPos > begin && aPos < rowBreak, `first row text should stay before row break: ${latex}`);
    assert.ok(bPos > rowBreak && bPos < end, `second row text should stay after row break: ${latex}`);
    await assertRenderHealthy(page, "matrix enter row render", { allowPlaceholder: true });
  });

  await runCase("[13/17] rapid explicit commits stay stable", async (page) => {
    await applySuggestionViaExplicitSession(page, "alpha", { expectedHint: "alpha" });
    await pause(40);
    await applySuggestionViaExplicitSession(page, "beta", {
      expectedHint: "beta",
      keepCursor: true,
    });
    await pause(220);

    const latex = normalizeLatex(await getMathFieldLatex(page));
    assert.ok(latex.includes("\\alpha"), `alpha missing after rapid commits: ${latex}`);
    assert.ok(latex.includes("\\beta"), `beta missing after rapid commits: ${latex}`);

    const panelAfter = await getSuggestionSnapshot(page);
    assert.equal(
      panelAfter.visible,
      false,
      `panel should stay closed after rapid commits: ${JSON.stringify(panelAfter)}`
    );
    await assertRenderHealthy(page, "rapid explicit commit render", { allowPlaceholder: true });
  });

  await runCase("[14/17] 50 complex placeholder-heavy formulas via UI flows", async (page) => {
    const scenarios = [];
    COMPLEX_FORMULA_ENVIRONMENTS.forEach((envToken) => {
      COMPLEX_FORMULA_PROFILES.forEach((profile, profileIndex) => {
        scenarios.push({
          envToken,
          profile,
          profileIndex,
          index: scenarios.length,
        });
      });
    });
    assert.equal(scenarios.length, 50, `expected 50 scenarios, got ${scenarios.length}`);

    for (let i = 0; i < scenarios.length; i += 1) {
      await runComplexPlaceholderFormula(page, scenarios[i], scenarios.length);
      if (verboseDebug && (i + 1) % 10 === 0) {
        log(`[debug] complex placeholder scenarios completed ${i + 1}/${scenarios.length}`);
      }
    }
  });

  await runCase("[15/17] 12 risky formulas: new input + mid-edit insertion", async (page) => {
    assert.equal(
      RISKY_FORMULA_SCENARIOS.length,
      12,
      `expected 12 risky scenarios, got ${RISKY_FORMULA_SCENARIOS.length}`
    );
    for (let i = 0; i < RISKY_FORMULA_SCENARIOS.length; i += 1) {
      await runRiskyFormulaScenario(
        page,
        RISKY_FORMULA_SCENARIOS[i],
        i,
        RISKY_FORMULA_SCENARIOS.length
      );
      if (verboseDebug) {
        log(`[debug] risky formulas completed ${i + 1}/${RISKY_FORMULA_SCENARIOS.length}`);
      }
    }
  });

  await runCase("[16/17] 50 multilayer variety formulas across many environments", async (page) => {
    const scenarios = [];
    MULTILAYER_ENVIRONMENTS.forEach((envToken) => {
      MULTILAYER_CELL_PROFILES.forEach((profile, profileIndex) => {
        scenarios.push({
          envToken,
          profile,
          profileIndex,
          index: scenarios.length,
        });
      });
    });
    assert.equal(scenarios.length, 50, `expected 50 variety scenarios, got ${scenarios.length}`);
    for (let i = 0; i < scenarios.length; i += 1) {
      await runMultilayerVarietyScenario(page, scenarios[i], i, scenarios.length);
      if (verboseDebug && (i + 1) % 10 === 0) {
        log(`[debug] multilayer variety scenarios completed ${i + 1}/${scenarios.length}`);
      }
    }
  });

  await runCase("[17/17] 200 practical mass formulas across wide environments", async (page) => {
    const scenarios = [];
    PRACTICAL_MASS_ENVIRONMENTS.forEach((envToken) => {
      PRACTICAL_MASS_PROFILES.forEach((profile, profileIndex) => {
        scenarios.push({
          envToken,
          profile,
          profileIndex,
          index: scenarios.length,
        });
      });
    });
    assert.equal(scenarios.length, 200, `expected 200 practical scenarios, got ${scenarios.length}`);
    for (let i = 0; i < scenarios.length; i += 1) {
      await runPracticalMassScenario(page, scenarios[i], i, scenarios.length);
      if (verboseDebug && (i + 1) % 20 === 0) {
        log(`[debug] practical mass scenarios completed ${i + 1}/${scenarios.length}`);
      }
    }
  });

  log("math-wysiwyg ui e2e passed");
};

run().catch((error) => {
  console.error("[math-wysiwyg-ui-e2e] FAILED");
  console.error(error);
  process.exitCode = 1;
});
