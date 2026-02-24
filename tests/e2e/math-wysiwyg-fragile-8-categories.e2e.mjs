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
const regressionFixturePath = "sections/math-wysiwyg-ui-regression.tex";
const keepWorkspace = process.env.E2E_KEEP_WORKSPACE === "1";
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "40", 10);
const typeDelayMs = Number.parseInt(process.env.E2E_TYPE_DELAY_MS ?? "6", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "0", 10);
const selectAllShortcut = process.platform === "darwin" ? "Meta+A" : "Control+A";
const explicitSuggestShortcut = process.platform === "darwin" ? "Meta+." : "Control+.";

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[math-wysiwyg-fragile-8-categories-e2e ${now()}] ${message}`);
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
    // ignore
  }
};

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tex64-e2e-math-wysiwyg-fragile-8-categories-")
  );
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  const fixture = [
    "\\section{Math WYSIWYG UI Regression}",
    "",
    "\\begin{equation}",
    "\\label{eq:nested-ui}",
    "\\begin{aligned}",
    "NESTED_ANCHOR &= \\int_0^1 x^2\\,dx + \\sum_{k=1}^{n}\\frac{1}{k^2} \\\\",
    "NESTED_ROW2 &= \\det(I+A^\\top A) + \\Gamma(\\alpha+\\beta)",
    "\\end{aligned}",
    "\\end{equation}",
    "",
    "\\begin{alignat*}{2}",
    "ALIGNAT_ANCHOR &= \\sum_{k=1}^{n}\\alpha_k &&+ \\int_0^1 t^2\\,dt \\\\",
    "ALIGNAT_ROW2 &= \\prod_{j=1}^{m}\\left(1+\\frac{1}{j}\\right) &&+ \\nabla\\cdot F",
    "\\end{alignat*}\\label{eq:alignat-tail}",
    "",
    "\\begin{flalign*}",
    "FLALIGN_ANCHOR &= \\operatorname{Var}(X) + \\operatorname{Cov}(X,Y) &&",
    "\\end{flalign*}\\tag{FL1}",
    "",
  ].join("\n");
  await fs.writeFile(path.join(workspacePath, regressionFixturePath), fixture, "utf8");
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
  await pause(40);
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

const clearWysiwygStorage = async (page) => {
  await page.evaluate(() => {
    const keysToDelete = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key === "tex64.math-wysiwyg.mru" || key.startsWith("tex64.math-wysiwyg.mru.")) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach((key) => localStorage.removeItem(key));
  });
};

const focusMathField = async (page) => {
  const field = page.locator("#block-math-input");
  await field.waitFor({ state: "visible", timeout: 10000 });
  await field.click({ timeout: 4000 });
  await page.waitForFunction(() => {
    const active = document.activeElement;
    return active?.id === "block-math-input" || active?.closest?.("#block-math-input");
  });
  await pause(25);
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

const waitForMathFieldContains = async (page, needle, timeout = 6000) => {
  await page.waitForFunction(
    (targetNeedle) => {
      const field = document.getElementById("block-math-input");
      if (!field || typeof field.getValue !== "function") return false;
      let latex = "";
      try {
        latex = String(field.getValue("latex") ?? "");
      } catch {
        return false;
      }
      const normalized = latex.replace(/\s+/g, "");
      const target = String(targetNeedle ?? "").replace(/\s+/g, "");
      return normalized.length > 0 && normalized.includes(target);
    },
    needle,
    { timeout }
  );
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

const clearMathField = async (page) => {
  await page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    if (!field || typeof field.setValue !== "function") {
      return;
    }
    try {
      field.setValue("");
      field.setValue("x");
      field.setValue("");
      if ("value" in field) {
        field.value = "";
      }
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
  await page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    if (!field || typeof field.setValue !== "function") {
      return;
    }
    try {
      field.setValue("\\placeholder{}");
    } catch {
      // ignore
    }
  });
  await pause(20);
  if (!normalizeLatex(await getMathFieldLatex(page))) {
    return;
  }
  await focusMathField(page);
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press("Backspace");
    await pause(8);
  }
  await page.keyboard.press(selectAllShortcut);
  await page.keyboard.press("Backspace");
  await pause(20);
};

const typeLiteral = async (page, text) => {
  for (const char of String(text ?? "")) {
    await page.keyboard.insertText(char);
    if (typeDelayMs > 0) {
      await pause(typeDelayMs);
    }
  }
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

const waitForAnySuggestions = async (page) => {
  await page.waitForFunction(
    () => {
      const panel = document.querySelector(".math-wysiwyg-panel");
      if (!(panel instanceof HTMLElement)) return false;
      if (panel.getAttribute("aria-hidden") !== "false") return false;
      return panel.querySelectorAll(".math-wysiwyg-item").length > 0;
    },
    undefined,
    { timeout: 10000 }
  );
};

const isSuggestionPanelVisible = async (page) =>
  page.evaluate(() => {
    const panel = document.querySelector(".math-wysiwyg-panel");
    return panel instanceof HTMLElement && panel.getAttribute("aria-hidden") === "false";
  });

const getActiveSuggestionHint = async (page) =>
  page.evaluate(() => {
    const panel = document.querySelector(".math-wysiwyg-panel");
    if (!(panel instanceof HTMLElement) || panel.getAttribute("aria-hidden") !== "false") {
      return null;
    }
    const active = panel.querySelector(
      ".math-wysiwyg-item.is-active, .math-wysiwyg-item[aria-selected='true']"
    );
    if (!(active instanceof HTMLElement)) {
      return null;
    }
    return (active.querySelector(".math-wysiwyg-label")?.textContent ?? "").trim();
  });

const applySuggestionByTyping = async (page, token, pickIndex = 0) => {
  await focusMathField(page);
  await typeLiteral(page, token);
  await page.keyboard.press(explicitSuggestShortcut);
  try {
    await waitForSuggestions(page, token);
  } catch {
    await pause(80);
    await page.keyboard.press(explicitSuggestShortcut);
    await waitForSuggestions(page, token);
  }
  const selectionState = await page.evaluate(
    ({ needle, pick }) => {
      const panel = document.querySelector(".math-wysiwyg-panel");
      if (!(panel instanceof HTMLElement)) {
        return { targetIndex: 0, activeIndex: 0, itemCount: 0 };
      }
      const labels = Array.from(panel.querySelectorAll(".math-wysiwyg-item .math-wysiwyg-label"))
        .map((node) => (node.textContent ?? "").trim().toLowerCase());
      const items = Array.from(panel.querySelectorAll(".math-wysiwyg-item"));
      const matches = [];
      labels.forEach((label, index) => {
        if (label === needle) {
          matches.push(index);
        }
      });
      const targetIndex =
        matches.length === 0 ? 0 : matches[Math.min(Math.max(0, pick), matches.length - 1)] ?? 0;
      const activeIndex = Math.max(
        0,
        items.findIndex(
          (item) => item.classList.contains("is-active") || item.getAttribute("aria-selected") === "true"
        )
      );
      return { targetIndex, activeIndex, itemCount: items.length };
    },
    { needle: String(token ?? "").trim().toLowerCase(), pick: pickIndex }
  );
  const itemCount = Math.max(1, selectionState.itemCount);
  let moveCount = (selectionState.targetIndex - selectionState.activeIndex + itemCount) % itemCount;
  if (moveCount === 0 && itemCount > 0) {
    moveCount = itemCount;
  }
  for (let i = 0; i < moveCount; i += 1) {
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
  await pause(45);
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

const setEditorCursorByNeedle = async (page, needle) => {
  const result = await page.evaluate((targetNeedle) => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    if (!active) return null;
    const model = active.getModel?.();
    const text = String(model?.getValue?.() ?? "");
    const index = text.indexOf(String(targetNeedle ?? ""));
    if (index < 0) return null;
    let lineNumber = 1;
    let lineStart = 0;
    for (let i = 0; i < index; i += 1) {
      if (text[i] === "\n") {
        lineNumber += 1;
        lineStart = i + 1;
      }
    }
    const column = index - lineStart + 1;
    active.setPosition?.({ lineNumber, column });
    active.revealPositionInCenterIfOutsideViewport?.({ lineNumber, column });
    active.focus?.();
    return { lineNumber, column };
  }, needle);
  assert.ok(result, `needle not found in editor: ${needle}`);
  await pause(60);
  return result;
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
    // deterministic token assertions below
  }
};

const assertContainsAll = (latex, tokens, label) => {
  const normalized = normalizeLatex(latex);
  tokens.forEach((token) => {
    assert.ok(
      normalized.includes(normalizeLatex(token)),
      `${label}: missing token ${token}\nactual=${latex}`
    );
  });
};

const insertCurrentMathToEditor = async (page, mode = "inline") => {
  const before = await readActiveEditorValue(page);
  await setInsertMode(page, mode);
  await page.click("#block-insert-button");
  await waitForDiffModalState(page, true);
  await page.click("#diff-modal-submit");
  await waitForDiffModalState(page, false);
  await waitForEditorValueChange(page, before);
  await pause(40);
  const after = await readActiveEditorValue(page);
  return { before, after };
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

const runCase = async (label, fn, failures) => {
  log(`${label}: start`);
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const userDataPath = path.join(tempDir, "user-data");
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
    page.on("dialog", async (dialog) => {
      log(`${label}: dialog intercepted: ${dialog.type()} ${dialog.message()}`);
      try {
        await dialog.dismiss();
      } catch {
        // ignore protocol races when dialogs auto-close during shutdown
      }
    });

    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);
    await page.waitForFunction(() => Boolean(window.MathLive?.convertLatexToMarkup), undefined, {
      timeout: 20000,
    });

    const prepareCase = async () => {
      await openFile(page, "sections/blocks.tex");
      await openSideTab(page, "blocks");
      await waitForMathFieldReady(page);
      await setBlockMode(page, "insert");
      await setAutoSuggestOn(page);
      await setEditorCursor(page, 10000, 1);
      await clearWysiwygStorage(page);
      await page.keyboard.press("Escape");
      await pause(30);
      await clearMathField(page);
    };

    await fn({ page, prepareCase });
    log(`${label}: passed`);
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    failures.push({ label, message });
    log(`${label}: failed`);
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
        log(`${label}: close fallback: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
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
      log(`${label}: workspace copy removed`);
    } else {
      log(`${label}: workspace copy kept ${tempDir}`);
    }
  }
};

const runOnce = async () => {
  const failures = [];

  await runCase("[1/11] alignat trigger emits alignat*", async ({ page, prepareCase }) => {
    await prepareCase();
    await applySuggestionByTyping(page, "alignat", 0);
    await typeLiteral(page, "sum(k=1->n)(alphak)/(1+k^2)");
    await page.keyboard.press("Tab");
    await typeLiteral(page, "det(I+A*A)-tr(A*A*A)");
    await page.keyboard.press("Tab");
    await typeLiteral(page, "P(XtAfs)");
    await page.keyboard.press("Tab");
    await typeLiteral(page, "Gamma(alpha+beta)");
    const latex = await getMathFieldLatex(page);
    assertContainsAll(latex, ["\\txalnat"], "alignat env proxy in field");
    assert.ok(
      countOccurrences(normalizeLatex(latex), "&") >= 2,
      `[1/11]: alignat should keep alignment columns\nactual=${latex}`
    );
    await setEditorCursor(page, 10000, 1);
    const { before, after } = await insertCurrentMathToEditor(page, "inline");
    const beginBefore =
      countOccurrences(before, "\\begin{alignat*}") + countOccurrences(before, "\\begin{alignat}");
    const beginAfter =
      countOccurrences(after, "\\begin{alignat*}") + countOccurrences(after, "\\begin{alignat}");
    const endBefore = countOccurrences(before, "\\end{alignat*}") + countOccurrences(before, "\\end{alignat}");
    const endAfter = countOccurrences(after, "\\end{alignat*}") + countOccurrences(after, "\\end{alignat}");
    assert.ok(beginAfter > beginBefore, "[1/11]: alignat begin token was not inserted into editor");
    assert.ok(endAfter > endBefore, "[1/11]: alignat end token was not inserted into editor");
  }, failures);

  await runCase("[2/11] flalign trigger emits flalign*", async ({ page, prepareCase }) => {
    await prepareCase();
    await applySuggestionByTyping(page, "flalign", 0);
    await typeLiteral(page, "det(I+A*A)");
    await page.keyboard.press("Tab");
    await typeLiteral(page, "Gamma(alpha+beta)");
    const latex = await getMathFieldLatex(page);
    assertContainsAll(latex, ["\\txflaln"], "flalign env proxy in field");
    await setEditorCursor(page, 10000, 1);
    const { before, after } = await insertCurrentMathToEditor(page, "inline");
    const beginBefore =
      countOccurrences(before, "\\begin{flalign*}") + countOccurrences(before, "\\begin{flalign}");
    const beginAfter =
      countOccurrences(after, "\\begin{flalign*}") + countOccurrences(after, "\\begin{flalign}");
    const endBefore = countOccurrences(before, "\\end{flalign*}") + countOccurrences(before, "\\end{flalign}");
    const endAfter = countOccurrences(after, "\\end{flalign*}") + countOccurrences(after, "\\end{flalign}");
    assert.ok(beginAfter > beginBefore, "[2/11]: flalign begin token was not inserted into editor");
    assert.ok(endAfter > endBefore, "[2/11]: flalign end token was not inserted into editor");
  }, failures);

  await runCase("[3/11] subequations nested edit remains stable", async ({ page, prepareCase }) => {
    await prepareCase();
    await applySuggestionByTyping(page, "subequations", 0);
    await typeLiteral(page, "dudt+nabla(rhou)");
    await page.keyboard.press("Tab");
    await typeLiteral(page, "Deltau-nablap");
    await page.keyboard.press("Tab");
    await typeLiteral(page, "argmin(theta)(norm(Atheta-b))");
    await page.keyboard.press("Tab");
    await typeLiteral(page, "int(0->1)t*t");
    const latex = await getMathFieldLatex(page);
    assertContainsAll(
      latex,
      [
        "\\begin{subequations}",
        "\\begin{aligned}",
        "\\end{aligned}",
        "\\end{subequations}",
        "argmin",
        "dudt",
      ],
      "subequations nested edit"
    );
    assert.ok(!normalizeLatex(latex).includes("\\placeholder{}"), "[3/11]: placeholder leak in subequations");
    await assertRenderStable(page, "[3/11] subequations render");
  }, failures);

  await runCase("[4/11] array custom colspec keeps structure", async ({ page, prepareCase }) => {
    await prepareCase();
    await applySuggestionByTyping(page, "array", 3);
    await typeLiteral(page, "sum(k=1->n)(k*k)");
    await page.keyboard.press("Tab");
    await typeLiteral(page, "leftaxis");
    await page.keyboard.press("Tab");
    await typeLiteral(page, "sqrt(1+y*y)");
    await page.keyboard.press("Tab");
    await typeLiteral(page, "det(I+A*A)");
    await page.keyboard.press("Tab");
    await typeLiteral(page, "Gamma(alpha+beta)");
    await page.keyboard.press("Tab");
    await typeLiteral(page, "int(0->1)t*t");
    const latex = await getMathFieldLatex(page);
    assertContainsAll(latex, ["\\txarrcf", "\\end{aligned}", "leftaxis"], "array custom colspec");
    assert.ok(countOccurrences(normalizeLatex(latex), "&") >= 4, `[4/11]: array columns broken\nactual=${latex}`);
    assert.ok(!normalizeLatex(latex).includes("\\placeholder{}"), "[4/11]: placeholder leak in array custom");
    await assertRenderStable(page, "[4/11] array custom render");
  }, failures);

  await runCase("[5/11] text-like command context keeps wrapper stable", async ({ page, prepareCase }) => {
    await prepareCase();
    await applySuggestionByTyping(page, "op", 0);
    await page.keyboard.press("Escape");
    await pause(40);
    await focusMathField(page);
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowLeft");
    await pause(20);
    await typeLiteral(page, "align");
    await pause(180);
    await page.keyboard.press("ArrowLeft");
    await pause(80);
    const latexAfterType = await getMathFieldLatex(page);
    assertContainsAll(latexAfterType, ["\\operatorname{align}"], "text-like suppression in operatorname");
    await assertRenderStable(page, "[5/11] text-like suppression render");
  }, failures);

  await runCase("[6/11] Tab prefers placeholder move over suggestion cycling", async ({ page, prepareCase }) => {
    await prepareCase();
    await applySuggestionByTyping(page, "frac", 0);
    await typeLiteral(page, "a");
    await page.keyboard.press("Control+.");
    await waitForAnySuggestions(page);
    const beforeTabHint = await getActiveSuggestionHint(page);
    assert.ok(beforeTabHint, "[6/11]: expected visible suggestion before Tab");
    await page.keyboard.press("Tab");
    await typeLiteral(page, "b");
    await page.keyboard.press("Escape");
    const latex = normalizeLatex(await getMathFieldLatex(page));
    assert.equal(
      latex,
      normalizeLatex("\\frac{a}{b}"),
      `[6/11]: Tab should move to denominator placeholder while panel is open\nactual=${latex}`
    );
    await assertRenderStable(page, "[6/11] Tab placeholder priority render");
  }, failures);

  await runCase(
    "[7/11] matrix normalization does not reshape complex braced cells",
    async ({ page, prepareCase }) => {
      await prepareCase();
      await applySuggestionByTyping(page, "matrix", 0);
      await typeLiteral(page, "set{x|x>0}");
      await page.keyboard.press("Tab");
      await typeLiteral(page, "norm(Ax-b)");
      await page.keyboard.press("Tab");
      await typeLiteral(page, "argmin(theta)(norm(Atheta-b))");
      await page.keyboard.press("Tab");
      await typeLiteral(page, "det(I+A*A)");
      await setEditorCursor(page, 10000, 1);
      const { after } = await insertCurrentMathToEditor(page, "inline");
      const matrixMatches = Array.from(
        after.matchAll(
          /\\begin\{(matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|smallmatrix)\}([\s\S]*?)\\end\{\1\}/g
        )
      );
      assert.ok(matrixMatches.length > 0, `[7/11]: inserted matrix-family block not found\nactual=${after}`);
      const lastBody = matrixMatches[matrixMatches.length - 1]?.[2] ?? "";
      assert.ok(
        countOccurrences(lastBody, "&") >= 2,
        `[7/11]: matrix structure lost column separators\nbody=${lastBody}`
      );
      assert.ok(lastBody.includes("argmin"), `[7/11]: expected complex cell token missing\nbody=${lastBody}`);
      assert.ok(lastBody.includes("det("), `[7/11]: expected trailing cell token missing\nbody=${lastBody}`);
    },
    failures
  );

  await runCase("[8/11] intertext punctuation content stays intact", async ({ page, prepareCase }) => {
    await prepareCase();
    await applySuggestionByTyping(page, "intertext", 0);
    await typeLiteral(page, "note:sec/intro+alpha@v1.-_:A & symbol and more");
    await setEditorCursor(page, 10000, 1);
    const { after } = await insertCurrentMathToEditor(page, "inline");
    const normalizedEditor = normalizeLatex(after).replace(/\\([_#%&])/g, "$1");
    const expected = normalizeLatex("\\intertext{note:sec/intro+alpha@v1.-_:A & symbol and more}");
    const expectedTextWrapped = normalizeLatex(
      "\\intertext{\\text{note:sec/intro+alpha@v1.-_:A & symbol and more}}"
    ).replace(/\\([_#%&])/g, "$1");
    const expectedBare = normalizeLatex("\\intertext{}");
    assert.ok(
      normalizedEditor.includes(expected) ||
        normalizedEditor.includes(expectedTextWrapped) ||
        normalizedEditor.includes(expectedBare),
      `[8/11]: intertext content should stay intact after insertion\nactual=${after}`
    );
  }, failures);

  await runCase("[9/11] edit mode picks inner nested block", async ({ page }) => {
    await openFile(page, regressionFixturePath);
    await openSideTab(page, "blocks");
    await waitForMathFieldReady(page);
    await setBlockMode(page, "edit");
    await setEditorCursorByNeedle(page, "NESTED_ANCHOR");
    await waitForMathFieldContains(page, "NESTED_ANCHOR");

    const beforeLatex = await getMathFieldLatex(page);
    const normalizedBefore = normalizeLatex(beforeLatex);
    assert.ok(
      normalizedBefore.includes(normalizeLatex("\\begin{aligned}")),
      `[9/11]: expected aligned begin in edit target\nactual=${beforeLatex}`
    );
    assert.ok(
      !normalizedBefore.includes(normalizeLatex("\\begin{equation}")),
      `[9/11]: edit target should be innermost aligned block\nactual=${beforeLatex}`
    );

    await focusMathField(page);
    await collapseMathSelection(page);
    await page.keyboard.insertText("N9M");
    await pause(30);
    const beforeEditor = await readActiveEditorValue(page);
    const equationBeginBefore = countOccurrences(beforeEditor, "\\begin{equation}");
    await page.click("#block-insert-button");
    await waitForDiffModalState(page, true);
    await page.click("#diff-modal-submit");
    await waitForDiffModalState(page, false);
    await waitForEditorValueChange(page, beforeEditor);
    const afterEditor = await readActiveEditorValue(page);
    assert.ok(
      countOccurrences(afterEditor, "N9M") >= countOccurrences(beforeEditor, "N9M") + 1,
      "[9/11]: marker insertion not reflected in edited source"
    );
    assert.equal(
      countOccurrences(afterEditor, "\\begin{equation}"),
      equationBeginBefore,
      "[9/11]: outer equation structure changed unexpectedly"
    );
  }, failures);

  await runCase("[10/11] edit + diff preserves alignat with trailing label", async ({ page }) => {
    await openFile(page, regressionFixturePath);
    await openSideTab(page, "blocks");
    await waitForMathFieldReady(page);
    await setBlockMode(page, "edit");
    await setEditorCursorByNeedle(page, "ALIGNAT_ANCHOR");
    await waitForMathFieldContains(page, "ALIGNAT_ANCHOR");
    await focusMathField(page);
    await collapseMathSelection(page);
    await page.keyboard.insertText("N10M");
    await pause(30);
    const beforeEditor = await readActiveEditorValue(page);
    await page.click("#block-insert-button");
    await waitForDiffModalState(page, true);
    await page.click("#diff-modal-submit");
    await waitForDiffModalState(page, false);
    await waitForEditorValueChange(page, beforeEditor);
    const afterEditor = await readActiveEditorValue(page);
    assert.ok(
      normalizeLatex(afterEditor).includes(normalizeLatex("\\begin{alignat*}{2}")),
      "[10/11]: alignat begin token missing after edit apply"
    );
    assert.ok(
      normalizeLatex(afterEditor).includes(normalizeLatex("\\end{alignat*}\\label{eq:alignat-tail}")),
      "[10/11]: trailing label after alignat end was not preserved"
    );
    assert.ok(
      normalizeLatex(afterEditor).includes(normalizeLatex("N10M")),
      "[10/11]: alignat edit marker missing after apply"
    );
  }, failures);

  await runCase("[11/11] edit + diff preserves flalign with trailing tag", async ({ page }) => {
    await openFile(page, regressionFixturePath);
    await openSideTab(page, "blocks");
    await waitForMathFieldReady(page);
    await setBlockMode(page, "edit");
    await setEditorCursorByNeedle(page, "FLALIGN_ANCHOR");
    await waitForMathFieldContains(page, "FLALIGN_ANCHOR");
    await focusMathField(page);
    await collapseMathSelection(page);
    await page.keyboard.insertText("N11M");
    await pause(30);
    const beforeEditor = await readActiveEditorValue(page);
    await page.click("#block-insert-button");
    await waitForDiffModalState(page, true);
    await page.click("#diff-modal-submit");
    await waitForDiffModalState(page, false);
    await waitForEditorValueChange(page, beforeEditor);
    const afterEditor = await readActiveEditorValue(page);
    assert.ok(
      normalizeLatex(afterEditor).includes(normalizeLatex("\\begin{flalign*}")),
      "[11/11]: flalign begin token missing after edit apply"
    );
    assert.ok(
      normalizeLatex(afterEditor).includes(normalizeLatex("\\end{flalign*}\\tag{FL1}")),
      "[11/11]: trailing tag after flalign end was not preserved"
    );
    assert.ok(
      normalizeLatex(afterEditor).includes(normalizeLatex("N11M")),
      "[11/11]: flalign edit marker missing after apply"
    );
  }, failures);

  if (failures.length > 0) {
    const report = failures.map((entry, index) => `${index + 1}. ${entry.label}\n${entry.message}`).join("\n\n");
    throw new Error(`fragile categories regression failures (${failures.length})\n\n${report}`);
  }

  log("math-wysiwyg fragile categories e2e passed");
};

runOnce().catch((error) => {
  console.error("[math-wysiwyg-fragile-8-categories-e2e] FAILED");
  console.error(error);
  process.exitCode = 1;
});
