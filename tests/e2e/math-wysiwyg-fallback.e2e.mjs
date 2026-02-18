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

const mathliveScriptPath = path.join(repoRoot, "Resources", "web", "mathlive", "mathlive.min.js");
const mathliveScriptBackupPath = `${mathliveScriptPath}.e2e-bak`;

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[math-wysiwyg-fallback-e2e ${now()}] ${message}`);
};

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
};

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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-math-wysiwyg-fallback-"));
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
  await page.waitForSelector("body.is-ready", { timeout: 20000 });
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

const openFile = async (page, filePath) => {
  await postToBridge(page, { type: "openFile", path: filePath });
  await page.waitForSelector(`#editor-tabs-list .editor-tab.is-active[data-path="${filePath}"]`, {
    timeout: 20000,
  });
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
  await pause(60);
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

const ensureMathliveUnavailable = async () => {
  await fs.access(mathliveScriptPath);
  try {
    await fs.rm(mathliveScriptBackupPath, { force: true });
  } catch {
    // ignore
  }
  await fs.rename(mathliveScriptPath, mathliveScriptBackupPath);
};

const restoreMathliveScript = async () => {
  try {
    await fs.access(mathliveScriptBackupPath);
  } catch {
    return;
  }
  try {
    await fs.rm(mathliveScriptPath, { force: true });
  } catch {
    // ignore
  }
  await fs.rename(mathliveScriptBackupPath, mathliveScriptPath);
};

const run = async () => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const userDataPath = path.join(tempDir, "user-data");
  let electronApp;

  try {
    log(`workspace copy: ${workspacePath}`);
    await fs.mkdir(userDataPath, { recursive: true });
    await ensureMathliveUnavailable();
    log("mathlive script temporarily disabled");
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
      log(`dialog intercepted: ${dialog.type()} ${dialog.message()}`);
      try {
        await dialog.dismiss();
      } catch {
        // ignore protocol races
      }
    });
    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);

    await openFile(page, "sections/blocks.tex");
    await openSideTab(page, "blocks");

    await page.waitForFunction(
      () => {
        const input = document.getElementById("block-math-input");
        return input instanceof HTMLTextAreaElement;
      },
      undefined,
      { timeout: 25000 }
    );

    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll("#block-math-input-container div"))
          .map((node) => node.textContent ?? "")
          .some((text) => text.includes("MathLive unavailable") || text.includes("MathLive loading")),
      undefined,
      { timeout: 25000 }
    );

    await setEditorCursor(page, 34, 1);
    const input = page.locator("#block-math-input");
    await input.click();
    await page.keyboard.type("fallbackx^2+1", { delay: typeDelayMs });
    await page.click("#block-insert-button");
    await waitForDiffModalState(page, true);
    await page.click("#diff-modal-submit");
    await waitForDiffModalState(page, false);

    const editorText = await readActiveEditorValue(page);
    assert.ok(editorText.includes("fallbackx^2+1"), "fallback input was not inserted");
    assert.ok(editorText.includes("$fallbackx^2+1$"), "fallback insert was not wrapped as inline math");
    await waitForTabDirtyState(page, "sections/blocks.tex", true);
    await saveActiveFileViaBridge(page, "sections/blocks.tex");
    await waitForTabDirtyState(page, "sections/blocks.tex", false);

    log("math-wysiwyg fallback e2e passed");
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
          // ignore force-kill failure
        }
      }
    }
    cleanupStaleElectron();
    await restoreMathliveScript();
    log("mathlive script restored");
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true });
      log("workspace copy removed");
    } else {
      log(`workspace copy kept ${tempDir}`);
    }
  }
};

run().catch((error) => {
  console.error("[math-wysiwyg-fallback-e2e] FAILED");
  console.error(error);
  process.exitCode = 1;
});
