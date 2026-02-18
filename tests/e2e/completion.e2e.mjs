import assert from "node:assert/strict";
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
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "500", 10);
const typeDelayMs = Number.parseInt(process.env.E2E_TYPE_DELAY_MS ?? "95", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "120", 10);

const saveShortcut = process.platform === "darwin" ? "Meta+S" : "Control+S";
const lineEndShortcut = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[completion-e2e ${now()}] ${message}`);
};

const toPosix = (value) => value.split(path.sep).join("/");

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-"));
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  return { tempDir, workspacePath };
};

const waitForLauncherVisible = async (page, timeout = 15000) => {
  await page.waitForFunction(
    () => {
      const launcher = document.getElementById("launcher");
      return Boolean(
        launcher &&
          launcher.classList.contains("is-visible") &&
          launcher.getAttribute("aria-hidden") === "false" &&
          document.body.classList.contains("has-launcher")
      );
    },
    undefined,
    { timeout }
  );
};

const openWorkspaceViaLauncher = async (page) => {
  await waitForLauncherVisible(page, 20000);
  await page.waitForSelector("#launcher-open", { timeout: 10000 });
  await page.click("#launcher-open");
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector("body.is-ready", { timeout: 15000 });
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
    timeout: 20000,
  });
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#outline-labels .outline-item").length > 0 &&
      document.querySelectorAll("#outline-citations .outline-item").length > 0,
    undefined,
    { timeout: 20000 }
  );
};

const focusEditor = async (page) => {
  const editor = page.locator("#editor .monaco-editor");
  await editor.waitFor({ state: "visible", timeout: 15000 });
  await editor.click({ position: { x: 120, y: 80 } });
  await page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    if (editors[0]?.focus) {
      editors[0].focus();
    }
  });
  await pause(250);
};

const moveCursorToEnd = async (page) => {
  await page.keyboard.press(lineEndShortcut);
  await pause();
};

const triggerSuggest = async (page) => {
  await page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    if (active?.focus) {
      active.focus();
    }
    if (active?.trigger) {
      active.trigger("completion-e2e", "editor.action.triggerSuggest", {});
    }
  });
};

const typeScenarioPrefix = async (page, prefix) => {
  await moveCursorToEnd(page);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await page.keyboard.type(prefix, { delay: typeDelayMs });
  await triggerSuggest(page);
  await pause();
};

const getVisibleSuggestions = async (page) => {
  try {
    await page.waitForFunction(
      () => {
        const widget = document.querySelector(".suggest-widget.visible");
        if (!widget) {
          return false;
        }
        return widget.querySelectorAll(".monaco-list-row").length > 0;
      },
      undefined,
      { timeout: 4000 }
    );
  } catch {
    await triggerSuggest(page);
    await page.waitForFunction(
      () => {
        const widget = document.querySelector(".suggest-widget.visible");
        if (!widget) {
          return false;
        }
        return widget.querySelectorAll(".monaco-list-row").length > 0;
      },
      undefined,
      { timeout: 10000 }
    );
  }

  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".suggest-widget.visible .monaco-list-row"));
    return rows
      .map((row) => row.textContent?.replace(/\s+/g, " ").trim() ?? "")
      .filter((text) => text.length > 0);
  });
};

const assertSuggestionContains = async (page, expected, testName, options = {}) => {
  const closeWidget = options.closeWidget !== false;
  const suggestions = await getVisibleSuggestions(page);
  const hit = suggestions.some((value) => value.includes(expected));
  assert.ok(
    hit,
    `${testName}: expected suggestion \"${expected}\" not found.\nSuggestions:\n${suggestions.join("\n")}`
  );
  log(`${testName}: found \"${expected}\"`);
  if (closeWidget) {
    await page.keyboard.press("Escape");
    await pause();
  }
};

const getFocusedSuggestion = async (page) =>
  page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".suggest-widget.visible .monaco-list-row"));
    const index = rows.findIndex(
      (row) => row.classList.contains("focused") || row.getAttribute("aria-selected") === "true"
    );
    if (index < 0) {
      return null;
    }
    const text = rows[index]?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    return { index, text };
  });

const getActiveLineContent = async (page) =>
  page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    const model = active?.getModel?.();
    const position = active?.getPosition?.();
    if (!model || !position) {
      return null;
    }
    if (typeof model.getLineContent !== "function") {
      return null;
    }
    return model.getLineContent(position.lineNumber);
  });

const acceptFirstSuggestion = async (page) => {
  await page.keyboard.press("Enter");
  await pause();
};

const saveCurrentFile = async (page) => {
  await page.keyboard.press(saveShortcut);
  await pause(900);
};

const run = async () => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const workspaceMainTex = path.join(workspacePath, "main.tex");
  const userDataPath = path.join(tempDir, "userdata");
  let electronApp;

  try {
    log(`workspace copy: ${workspacePath}`);
    await fs.mkdir(userDataPath, { recursive: true });
    log("launching Electron...");
    electronApp = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      slowMo: Number.isFinite(slowMoMs) ? Math.max(0, slowMoMs) : 0,
      env: {
        ...process.env,
        TEX64_E2E: "1",
        TEX64_E2E_USERDATA: userDataPath,
        TEX64_E2E_DIALOG_QUEUE: JSON.stringify({
          openWorkspace: [toPosix(workspacePath)],
        }),
      },
    });

    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1600, height: 980 });

    log("opening workspace via launcher...");
    await openWorkspaceViaLauncher(page);
    await waitForWorkspaceReady(page);
    log("workspace and index are ready");

    await focusEditor(page);

    log("[1/6] completion: \\ref + tab navigation + enter accept");
    await typeScenarioPrefix(page, "\\ref{sec:");
    await assertSuggestionContains(page, "sec:methods", "ref completion", { closeWidget: false });
    const focusedBeforeTab = await getFocusedSuggestion(page);
    await page.keyboard.press("Tab");
    await pause();
    const focusedAfterTab = await getFocusedSuggestion(page);
    assert.ok(
      focusedBeforeTab &&
        focusedAfterTab &&
        Number.isFinite(focusedBeforeTab.index) &&
        Number.isFinite(focusedAfterTab.index) &&
        focusedAfterTab.index !== focusedBeforeTab.index,
      `tab navigation: expected focused suggestion to move.\nBefore: ${JSON.stringify(
        focusedBeforeTab
      )}\nAfter: ${JSON.stringify(focusedAfterTab)}`
    );
    log("tab navigation: moved focus to next suggestion");
    await acceptFirstSuggestion(page);
    const acceptedRefLine = await getActiveLineContent(page);
    assert.ok(
      typeof acceptedRefLine === "string" && /\\ref\{sec:[^}\s]+/.test(acceptedRefLine),
      `enter accept: expected selected ref suggestion to be inserted.\nLine: ${acceptedRefLine ?? ""}`
    );
    log("enter accept: selected suggestion inserted");

    log("[2/6] completion: \\cite with optional arg");
    await typeScenarioPrefix(page, "\\cite[see]{la");
    await assertSuggestionContains(page, "lamport1994", "cite completion");

    log("[3/6] completion: \\input path");
    await typeScenarioPrefix(page, "\\input{sections/me");
    await assertSuggestionContains(page, "sections/methods", "input path completion");

    log("[4/6] completion: \\include path");
    await typeScenarioPrefix(page, "\\include{sections/re");
    await assertSuggestionContains(page, "sections/results", "include path completion");

    log("[5/6] completion: \\includegraphics path");
    await typeScenarioPrefix(page, "\\includegraphics{figures/sample-");
    await assertSuggestionContains(
      page,
      "figures/sample-image.png",
      "includegraphics path completion"
    );

    log("[6/6] completion: \\begin snippet");
    await moveCursorToEnd(page);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    await page.keyboard.type("% E2E_BEGIN_SNIPPET", { delay: typeDelayMs });
    await page.keyboard.press("Enter");
    await page.keyboard.type("\\begin{fig", { delay: typeDelayMs });
    await assertSuggestionContains(page, "figure", "begin snippet completion", {
      closeWidget: false,
    });
    await acceptFirstSuggestion(page);
    await saveCurrentFile(page);

    const savedText = await fs.readFile(workspaceMainTex, "utf8");
    assert.ok(
      savedText.includes("% E2E_BEGIN_SNIPPET") &&
        savedText.includes("\\begin{figure}") &&
        savedText.includes("\\end{figure}"),
      "begin snippet completion: expected expanded figure environment was not saved"
    );

    log("all completion checks passed");
  } finally {
    if (electronApp) {
      await electronApp.close();
    }
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true });
      log("temporary workspace removed");
    } else {
      log(`temporary workspace kept: ${tempDir}`);
    }
  }
};

run().catch((error) => {
  console.error("[completion-e2e] FAILED");
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exitCode = 1;
});
