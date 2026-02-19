import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

const keepWorkspace = process.env.E2E_KEEP_WORKSPACE === "1";
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "220", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "45", 10);

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[workspace-model-e2e ${now()}] ${message}`);
};

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const allowE2EQuit = async (app) => {
  if (!app) {
    return;
  }
  await app
    .evaluate(() => {
      global.__tex64E2EAllowQuit = true;
    })
    .catch(() => {});
};

const installE2EQuitGuard = async (app) => {
  if (!app) {
    return;
  }
  await app
    .evaluate(({ app: electronApp }) => {
      if (global.__tex64E2EQuitGuardInstalled === true) {
        return;
      }
      global.__tex64E2EQuitGuardInstalled = true;
      global.__tex64E2EAllowQuit = false;
      electronApp.on("before-quit", (event) => {
        if (global.__tex64E2EAllowQuit !== true) {
          event.preventDefault();
        }
      });
      process.on("SIGTERM", () => {
        if (global.__tex64E2EAllowQuit === true) {
          process.exit(0);
        }
      });
    })
    .catch(() => {});
};

const closeElectron = async (app) => {
  if (!app) {
    return;
  }
  await allowE2EQuit(app);
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("electronApp.close timeout")), 6000)
      ),
    ]);
  } catch (error) {
    log(`close fallback: ${error instanceof Error ? error.message : String(error)}`);
    try {
      app.process()?.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
};

const toPosix = (value) => value.split(path.sep).join("/");

const createWorkspaceScenario = async (workspacePath) => {
  await fs.mkdir(path.join(workspacePath, "sections"), { recursive: true });
  await fs.writeFile(
    path.join(workspacePath, "main.tex"),
    [
      "\\documentclass{article}",
      "\\begin{document}",
      "Main root document.",
      "\\input{sections/child}",
      "\\end{document}",
      "",
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(workspacePath, "paper.tex"),
    [
      "\\documentclass{article}",
      "\\begin{document}",
      "Manual root candidate.",
      "\\end{document}",
      "",
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(workspacePath, "sections", "child.tex"),
    [
      "%!TEX root = ../main",
      "This child is built via magic root.",
      "",
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(workspacePath, "sections", "loop-a.tex"),
    [
      "%!TEX root = loop-b",
      "loop-a",
      "",
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(workspacePath, "sections", "loop-b.tex"),
    [
      "%!TEX root = loop-a",
      "loop-b",
      "",
    ].join("\n"),
    "utf8"
  );
};

const readWorkspaceSettings = async (workspacePath) => {
  const settingsFile = path.join(workspacePath, ".tex64", "settings.json");
  const raw = await fs.readFile(settingsFile, "utf8").catch(() => "{}");
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  return parsed && typeof parsed === "object" ? parsed : {};
};

const waitForSettings = async (workspacePath, predicate, timeoutMs = 10000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const settings = await readWorkspaceSettings(workspacePath);
    if (predicate(settings)) {
      return settings;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("timed out waiting for workspace settings");
};

const launchApp = async ({ userDataPath, workspacePath }) => {
  const app = await electron.launch({
    args: ["."],
    cwd: repoRoot,
    slowMo: Number.isFinite(slowMoMs) ? Math.max(0, slowMoMs) : 0,
    env: {
      ...process.env,
      TEX64_E2E: "1",
        TEX64_E2E_HEADLESS: "1",
      TEX64_E2E_USERDATA: userDataPath,
      TEX64_E2E_DIALOG_QUEUE: JSON.stringify({
        openWorkspace: [toPosix(workspacePath)],
      }),
    },
  });
  await installE2EQuitGuard(app);
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1600, height: 980 });
  await page.waitForSelector("body.is-ready", { timeout: 20000 });
  return { app, page };
};

const waitForLauncherVisible = async (page, timeout = 15000) => {
  await page.waitForFunction(
    () => {
      const launcher = document.getElementById("launcher");
      return Boolean(
        launcher &&
          launcher.classList.contains("is-visible") &&
          launcher.getAttribute("aria-hidden") === "false"
      );
    },
    undefined,
    { timeout }
  );
};

const waitForWorkspaceOpened = async (page, rootName) => {
  await page.waitForFunction(
    (name) => {
      const launcher = document.getElementById("launcher");
      const label = document.getElementById("workspace-label");
      return Boolean(
        launcher &&
          !launcher.classList.contains("is-visible") &&
          launcher.getAttribute("aria-hidden") === "true" &&
          label &&
          (label.textContent ?? "").trim() === name
      );
    },
    rootName,
    { timeout: 25000 }
  );
  await page.waitForSelector("#editor-tabs-list .editor-tab.is-active", {
    timeout: 25000,
  });
};

const openProjectTab = async (page) => {
  await page.click('button.tab[data-tab="project"]');
  await page.waitForSelector('.sidebar-panel .panel.is-active[data-panel="project"]', {
    timeout: 10000,
  });
};

const waitForRootSelectorState = async (page, { value, autoButtonText }, timeout = 15000) => {
  await page.waitForFunction(
    ({ expectedValue, expectedButtonText }) => {
      const select = document.getElementById("settings-root-select");
      const autoButton = document.getElementById("settings-root-auto");
      if (!(select instanceof HTMLSelectElement) || !(autoButton instanceof HTMLButtonElement)) {
        return false;
      }
      return (
        select.value === expectedValue &&
        (autoButton.textContent ?? "").trim() === expectedButtonText
      );
    },
    { expectedValue: value, expectedButtonText: autoButtonText },
    { timeout }
  );
};

const setRootFromProjectUi = async (page, relativePath) => {
  const selected = await page.selectOption("#settings-root-select", relativePath);
  assert.ok(selected.includes(relativePath), `failed to select root file: ${relativePath}`);
};

const waitForBuildIdle = async (page, timeout = 60000) => {
  await page.waitForFunction(
    () => {
      const button = document.getElementById("build-button");
      return button instanceof HTMLButtonElement && !button.classList.contains("is-busy");
    },
    undefined,
    { timeout }
  );
};

const runBuild = async (page) => {
  await page.click("#build-button");
  await waitForBuildIdle(page);
  await pause(120);
};

const countIssueBySeverity = async (page, severity) =>
  page.evaluate(
    (value) =>
      Array.from(document.querySelectorAll("#issues-list .issue-item")).filter(
        (item) => item instanceof HTMLElement && item.dataset.severity === value
      ).length,
    severity
  );

const run = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-workspace-model-"));
  const workspacePath = path.join(tempDir, "workspace");
  const userDataPath = path.join(tempDir, "userdata");
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });
  await createWorkspaceScenario(workspacePath);

  let app = null;
  try {
    log("opening workspace from launcher");
    ({ app } = await launchApp({ userDataPath, workspacePath }));
    const page = await app.firstWindow();
    await waitForLauncherVisible(page);
    await page.keyboard.press("Enter");
    await waitForWorkspaceOpened(page, path.basename(workspacePath));

    log("[1/5] auto root detects main.tex");
    await openProjectTab(page);
    await waitForRootSelectorState(page, {
      value: "main.tex",
      autoButtonText: "再検出",
    });

    log("[2/5] manual root selection persists settings");
    await setRootFromProjectUi(page, "paper.tex");
    await waitForRootSelectorState(page, {
      value: "paper.tex",
      autoButtonText: "自動に戻す",
    });
    await waitForSettings(
      workspacePath,
      (settings) => settings.rootFile === "paper.tex",
      12000
    );

    log("[3/5] detect root clears manual override");
    await page.click("#settings-root-auto");
    await waitForRootSelectorState(page, {
      value: "main.tex",
      autoButtonText: "再検出",
    });
    await waitForSettings(
      workspacePath,
      (settings) => !Object.prototype.hasOwnProperty.call(settings, "rootFile"),
      12000
    );

    log("[4/5] %!TEX root resolves relative path without extension");
    await setRootFromProjectUi(page, "sections/child.tex");
    await waitForRootSelectorState(page, {
      value: "sections/child.tex",
      autoButtonText: "自動に戻す",
    });
    await runBuild(page);
    const childBuildErrorCount = await countIssueBySeverity(page, "error");
    assert.equal(
      childBuildErrorCount,
      0,
      "building child.tex should succeed by following %!TEX root to main.tex"
    );

    log("[5/5] %!TEX root loop does not resolve and build fails");
    await setRootFromProjectUi(page, "sections/loop-a.tex");
    await waitForRootSelectorState(page, {
      value: "sections/loop-a.tex",
      autoButtonText: "自動に戻す",
    });
    await runBuild(page);
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll("#issues-list .issue-item")).some(
          (item) => item instanceof HTMLElement && item.dataset.severity === "error"
        ),
      undefined,
      { timeout: 20000 }
    );
    const loopBuildErrorCount = await countIssueBySeverity(page, "error");
    assert.ok(loopBuildErrorCount >= 1, "loop root build should report at least one error");

    log("workspace model root e2e passed");
  } finally {
    if (app) {
      await closeElectron(app).catch(() => {});
    }
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true });
      log("temporary workspace removed");
    } else {
      log(`temporary workspace kept: ${tempDir}`);
    }
  }
};

const isTransientElectronError = (error) => {
  const message = error?.message ?? String(error);
  return (
    message.includes("Target page, context or browser has been closed") ||
    message.includes("Target closed") ||
    message.includes("Process failed to launch")
  );
};

const runWithRetry = async () => {
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await run();
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientElectronError(error) || attempt >= 5) {
        throw error;
      }
      log(`transient error detected, retrying (${attempt}/5)`);
      await pause(320);
    }
  }
  throw lastError;
};

runWithRetry().catch((error) => {
  console.error("[workspace-model-e2e] failed:", error);
  process.exitCode = 1;
});
