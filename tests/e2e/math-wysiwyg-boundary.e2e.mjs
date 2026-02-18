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
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "140", 10);
const typeDelayMs = Number.parseInt(process.env.E2E_TYPE_DELAY_MS ?? "35", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "25", 10);

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[math-wysiwyg-boundary-e2e ${now()}] ${message}`);
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-math-wysiwyg-boundary-"));
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
  await pause(70);
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
  await pause(60);
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

const waitForSuggestionVisible = async (page, hint) => {
  const expected = String(hint ?? "").trim().toLowerCase();
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

const applySuggestionByTyping = async (page, token, options = {}) => {
  const pickIndex = Number.isFinite(options.pickIndex) ? Math.max(0, options.pickIndex) : 0;
  await focusMathField(page);
  await page.keyboard.type(token, { delay: typeDelayMs });
  await waitForSuggestionVisible(page, token);
  for (let i = 0; i < pickIndex; i += 1) {
    await page.keyboard.press("ArrowDown");
    await pause(30);
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
};

const waitForIssueMessage = async (page, needle) => {
  const expected = String(needle ?? "").trim().toLowerCase();
  await page.waitForFunction(
    (messageNeedle) =>
      Array.from(document.querySelectorAll("#issues-list .issue-message")).some((node) =>
        (node.textContent ?? "").toLowerCase().includes(messageNeedle)
      ),
    expected,
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
  await pause(80);
};

const waitForMathLatexNormalized = async (page, expectedNormalized, label) => {
  await page.waitForFunction(
    (expected) => {
      const field = document.getElementById("block-math-input");
      if (!field || typeof field.getValue !== "function") return false;
      try {
        const latex = String(field.getValue("latex") ?? "").replace(/\s+/g, "");
        return latex === expected;
      } catch {
        return false;
      }
    },
    expectedNormalized,
    { timeout: 10000 }
  );
  const actual = normalizeLatex(await getMathFieldLatex(page));
  assert.equal(actual, expectedNormalized, `${label}: latex mismatch\nactual=${actual}`);
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

const readActiveEditorValue = async (page) =>
  page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    return String(active?.getModel?.()?.getValue?.() ?? "");
  });

const waitEditorContains = async (page, needle) => {
  await page.waitForFunction(
    (expected) => {
      const editors = window.monaco?.editor?.getEditors?.() ?? [];
      const active =
        editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
        editors[0];
      const text = String(active?.getModel?.()?.getValue?.() ?? "");
      return text.includes(expected);
    },
    needle,
    { timeout: 15000 }
  );
};

const waitForTabDirtyState = async (page, filePath, expectedDirty) => {
  await page.waitForFunction(
    ({ path, expected }) => {
      const selectors = [
        `#editor-tabs-list .editor-tab[data-path="${path}"]`,
        `#editor-tabs-list-secondary .editor-tab[data-path="${path}"]`,
      ];
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (!(node instanceof HTMLElement)) continue;
        return node.classList.contains("is-dirty") === expected;
      }
      return false;
    },
    { path: filePath, expected: expectedDirty },
    { timeout: 10000 }
  );
};

const saveActiveFileViaBridge = async (page, filePath) => {
  const content = await readActiveEditorValue(page);
  await postToBridge(page, {
    type: "saveFile",
    path: filePath,
    content,
    format: false,
    formatSource: "save",
  });
};

const runCase = async (label, test, options = {}) => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const userDataPath = path.join(tempDir, "user-data");
  let electronApp;

  try {
    await options.prepareWorkspace?.(workspacePath);
    log(`${label}: workspace copy ${workspacePath}`);
    await fs.mkdir(userDataPath, { recursive: true });
    cleanupStaleElectron();
    electronApp = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      slowMo: Number.isFinite(slowMoMs) ? Math.max(0, slowMoMs) : 0,
      env: {
        ...process.env,
        TEX64_E2E: "1",
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
    await test(page, { workspacePath });
    log(`${label}: passed`);
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
        log(
          `${label}: close fallback: ${closeError instanceof Error ? closeError.message : String(closeError)}`
        );
        try {
          electronApp.process()?.kill("SIGKILL");
        } catch {
          // ignore force-kill failure
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

const run = async () => {
  await runCase(
    "[1/3] non-tex blocks are rejected before diff",
    async (page) => {
      await openFile(page, "notes/block-non-tex.txt");
      await openSideTab(page, "blocks");
      await waitForMathFieldReady(page);
      await focusMathField(page);
      await page.keyboard.type("x+1", { delay: typeDelayMs });
      await page.click("#block-insert-button");
      await waitForIssueMessage(page, ".tex ファイルでのみ挿入できます");
      await waitForDiffModalState(page, false);

      await page.click("#block-mode-toggle");
      await waitForBlockMode(page, "insert");
    },
    {
      prepareWorkspace: async (workspacePath) => {
        const target = path.join(workspacePath, "notes", "block-non-tex.txt");
        await fs.writeFile(target, "Plain text for non-tex blocks test.\n", "utf8");
      },
    }
  );

  await runCase("[2/3] edit detection sync + Escape", async (page) => {
    await openFile(page, "sections/blocks.tex");
    await openSideTab(page, "blocks");
    await waitForMathFieldReady(page);

    await setEditorCursor(page, 2, 20);
    await page.click("#block-mode-toggle");
    await waitForBlockMode(page, "edit");
    await waitForMathLatexNormalized(page, "a^2+b^2=c^2", "inline detection");

    await setEditorCursor(page, 36, 5);
    await page.waitForFunction(
      () => {
        const field = document.getElementById("block-math-input");
        if (!field || typeof field.getValue !== "function") return false;
        try {
          return String(field.getValue("latex") ?? "").replace(/\s+/g, "") === "";
        } catch {
          return false;
        }
      },
      undefined,
      { timeout: 10000 }
    );

    await page.keyboard.press("Escape");
    await waitForBlockMode(page, "insert");
  });

  await runCase("[3/3] diff submit applies block insert", async (page) => {
    await openFile(page, "sections/blocks.tex");
    await openSideTab(page, "blocks");
    await waitForMathFieldReady(page);

    await setEditorCursor(page, 34, 1);
    const before = await readActiveEditorValue(page);

    await applySuggestionByTyping(page, "argmax", { pickIndex: 0 });
    await waitForMathLatexNormalized(page, "\\operatorname*{arg\\,max}", "argmax draft");

    await page.click("#block-insert-button");
    await waitForDiffModalState(page, true);
    await page.click("#diff-modal-submit");
    await waitForDiffModalState(page, false);

    await waitEditorContains(page, "\\operatorname*{arg\\,max}");
    const after = await readActiveEditorValue(page);
    assert.notEqual(after, before, "editor content did not change after diff submit");
    await waitForTabDirtyState(page, "sections/blocks.tex", true);
    await saveActiveFileViaBridge(page, "sections/blocks.tex");
    await waitForTabDirtyState(page, "sections/blocks.tex", false);
  });

  log("math-wysiwyg boundary e2e passed");
};

run().catch((error) => {
  console.error("[math-wysiwyg-boundary-e2e] FAILED");
  console.error(error);
  process.exitCode = 1;
});
