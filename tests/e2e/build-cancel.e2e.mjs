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
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "220", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "0", 10);

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => console.log(`[build-cancel-e2e ${now()}] ${message}`);

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const toPosix = (value) => value.split(path.sep).join("/");

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

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-build-cancel-"));
  const workspacePath = path.join(tempDir, "workspace");
  const userDataPath = path.join(tempDir, "userdata");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });
  return { tempDir, workspacePath, userDataPath };
};

const writeSlowBuildFixture = async (workspacePath) => {
  const filePath = path.join(workspacePath, "slow-cancel.tex");
  const content = [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\newcount\\loopcounter",
    "\\loopcounter=0",
    "\\loop\\ifnum\\loopcounter<2000000000\\advance\\loopcounter by 1\\repeat",
    "cancel test",
    "\\end{document}",
    "",
  ].join("\n");
  await fs.writeFile(filePath, content, "utf8");
};

const launchApp = async ({ workspacePath, userDataPath }) => {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    let app = null;
    try {
      app = await electron.launch({
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
      await page.setViewportSize({ width: 1660, height: 980 });
      await page.waitForSelector("body.is-ready", { timeout: 25000 });
      return { app, page };
    } catch (error) {
      lastError = error;
      if (app) {
        await allowE2EQuit(app);
        await app.close().catch(() => {});
      }
      if (attempt < 5) {
        await pause(320);
      }
    }
  }
  throw lastError;
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
  await page.waitForSelector("body.is-ready", { timeout: 20000 });
  await page.waitForSelector("#editor-tabs-list .editor-tab.is-active", {
    timeout: 30000,
  });
  await page.waitForSelector("#file-tree", { timeout: 15000, state: "attached" });
};

const clickSideTab = async (page, key) => {
  await page.click(`button.tab[data-tab="${key}"]`);
  await page.waitForSelector(`.sidebar-panel .panel.is-active[data-panel="${key}"]`, {
    timeout: 10000,
  });
};

const openSettingsPage = async (page, pageId) => {
  await clickSideTab(page, "settings");
  await page.waitForSelector("#settings-panel", { timeout: 10000 });

  const alreadyOpen = await page
    .locator(`.settings-page[data-settings-page="${pageId}"].is-active`)
    .count();
  if (alreadyOpen > 0) {
    return;
  }

  const navSelector = `button.settings-nav-item[data-settings-target="${pageId}"]`;
  const navVisible = await page.locator(navSelector).isVisible().catch(() => false);
  if (!navVisible) {
    const backButtons = page.locator("button.settings-back[data-settings-back]");
    if ((await backButtons.count()) > 0) {
      await backButtons.first().click();
      await pause(120);
    }
  }

  await page.evaluate((selector) => {
    const button = document.querySelector(selector);
    if (button instanceof HTMLButtonElement) {
      button.click();
    }
  }, navSelector);

  await page.waitForSelector(`.settings-page[data-settings-page="${pageId}"].is-active`, {
    timeout: 10000,
  });
};

const setRootFileFromProjectPanel = async (page, relativePath) => {
  await clickSideTab(page, "project");
  await page.waitForSelector("#settings-root-select", { timeout: 12000 });
  await page.waitForFunction(
    (value) => {
      const select = document.getElementById("settings-root-select");
      return (
        select instanceof HTMLSelectElement &&
        Array.from(select.options).some((option) => option.value === value)
      );
    },
    relativePath,
    { timeout: 15000 }
  );
  const selected = await page.selectOption("#settings-root-select", relativePath);
  assert.ok(selected.includes(relativePath), `failed to set root file: ${relativePath}`);
  await pause(450);
};

const waitForBuildStarted = async (page, timeout = 20000) => {
  await page.waitForFunction(
    () => {
      const button = document.getElementById("build-button");
      return button instanceof HTMLButtonElement && button.classList.contains("is-busy");
    },
    undefined,
    { timeout }
  );
};

const waitForBuildIdle = async (page, timeout = 120000) => {
  await page.waitForFunction(
    () => {
      const button = document.getElementById("build-button");
      return button instanceof HTMLButtonElement && !button.classList.contains("is-busy");
    },
    undefined,
    { timeout }
  );
};

const initCollectors = async (page) => {
  await page.evaluate(() => {
    if (!Array.isArray(window.__buildCancelIncoming)) {
      window.__buildCancelIncoming = [];
    }
    if (!Array.isArray(window.__buildCancelOutgoing)) {
      window.__buildCancelOutgoing = [];
    }
    if (window.__buildCancelIncomingInstalled !== true) {
      window.__buildCancelIncomingInstalled = true;
      window.tex64Bridge.onMessage((message) => {
        window.__buildCancelIncoming.push({
          type: message?.type ?? null,
          payload: message?.payload ?? null,
          at: Date.now(),
        });
      });
    }
    if (window.__buildCancelOutgoingInstalled !== true) {
      window.__buildCancelOutgoingInstalled = true;
      const bridge = window.tex64Bridge;
      if (bridge && typeof bridge.postMessage === "function") {
        const originalPostMessage = bridge.postMessage.bind(bridge);
        bridge.postMessage = (...args) => {
          const payload = args[0];
          window.__buildCancelOutgoing.push({
            type: payload?.type ?? null,
            payload: payload ?? null,
            at: Date.now(),
          });
          return originalPostMessage(...args);
        };
      }
    }
  });
};

const clearMessages = async (page, channel, type = null) => {
  await page.evaluate(
    ({ key, expectedType }) => {
      const source =
        key === "incoming" ? window.__buildCancelIncoming : window.__buildCancelOutgoing;
      if (!Array.isArray(source)) {
        return;
      }
      if (!expectedType) {
        source.length = 0;
        return;
      }
      const filtered = source.filter((entry) => entry?.type !== expectedType);
      source.length = 0;
      source.push(...filtered);
    },
    { key: channel, expectedType: type }
  );
};

const waitForMessage = async ({
  page,
  channel,
  type,
  timeoutMs = 20000,
  predicate = () => true,
}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const item = await page.evaluate(
      ({ key, expectedType }) => {
        const source =
          key === "incoming" ? window.__buildCancelIncoming : window.__buildCancelOutgoing;
        if (!Array.isArray(source) || source.length === 0) {
          return null;
        }
        const index = source.findIndex((entry) => entry?.type === expectedType);
        if (index < 0) {
          return null;
        }
        const value = source[index];
        source.splice(index, 1);
        return value;
      },
      { key: channel, expectedType: type }
    );
    if (item && predicate(item)) {
      return item;
    }
    await page.waitForTimeout(20);
  }
  throw new Error(`Timed out waiting for ${channel} message: ${type}`);
};

const fileExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const run = async () => {
  const { tempDir, workspacePath, userDataPath } = await createWorkspaceCopy();
  const slowPdfPath = path.join(workspacePath, "slow-cancel.pdf");
  let app;

  try {
    log(`workspace copy: ${workspacePath}`);
    await writeSlowBuildFixture(workspacePath);

    ({ app } = await launchApp({ workspacePath, userDataPath }));
    const page = await app.firstWindow();
    await initCollectors(page);

    await openWorkspaceViaLauncher(page);
    await waitForWorkspaceReady(page);

    log("[1/3] configure slow root + engine");
    await setRootFileFromProjectPanel(page, "slow-cancel.tex");
    await openSettingsPage(page, "build");
    await page.selectOption("#settings-compile-engine", "lualatex");
    await pause(180);

    log("[2/3] start build then cancel via build button");
    await clearMessages(page, "incoming", "setBuildState");
    await clearMessages(page, "incoming", "updateIssues");
    await clickSideTab(page, "files");
    await page.click("#build-button");
    await waitForBuildStarted(page, 30000);
    await page.waitForFunction(() => {
      const button = document.getElementById("build-button");
      return button instanceof HTMLButtonElement && button.getAttribute("aria-label") === "キャンセル";
    });
    await page.click("#build-button");
    await waitForMessage({
      page,
      channel: "incoming",
      type: "setBuildState",
      timeoutMs: 30000,
      predicate: (message) => {
        const payload = message?.payload ?? {};
        return payload?.state === "idle" && String(payload?.message ?? "").includes("キャンセル");
      },
    });
    await waitForBuildIdle(page, 30000);

    log("[3/3] verify cancel summary and no generated pdf");
    await waitForMessage({
      page,
      channel: "incoming",
      type: "updateIssues",
      timeoutMs: 30000,
      predicate: (message) => String(message?.payload?.summary ?? "").includes("キャンセルしました"),
    });
    assert.equal(
      await fileExists(slowPdfPath),
      false,
      "cancelled build should not finish pdf generation"
    );

    log("build cancel e2e passed");
  } finally {
    if (app) {
      await allowE2EQuit(app);
      await app.close().catch(() => {});
    }
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      log("workspace copy removed");
    } else {
      log(`workspace copy kept: ${tempDir}`);
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
  console.error(error);
  process.exitCode = 1;
});
