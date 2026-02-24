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

const toPosix = (value) => value.split(path.sep).join("/");

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const allowE2EQuit = async (app) => {
  if (!app) return;
  await app
    .evaluate(() => {
      global.__tex64E2EAllowQuit = true;
    })
    .catch(() => {});
};

const installE2EQuitGuard = async (app) => {
  if (!app) return;
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
    })
    .catch(() => {});
};

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-runtime-guard-"));
  const workspacePath = path.join(tempDir, "workspace");
  const userDataPath = path.join(tempDir, "userdata");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });
  return { tempDir, workspacePath, userDataPath };
};

const launchApp = async ({ workspacePath, userDataPath }) => {
  const app = await electron.launch({
    args: ["."],
    cwd: repoRoot,
    env: {
      ...process.env,
      TEX64_E2E: "1",
      TEX64_E2E_HEADLESS: "1",
      TEX64_E2E_USERDATA: userDataPath,
      TEX64_E2E_FORCE_MISSING_TOOLS: "latexmk,synctex",
      TEX64_E2E_DIALOG_QUEUE: JSON.stringify({
        openWorkspace: [toPosix(workspacePath)],
      }),
    },
  });
  await installE2EQuitGuard(app);
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1600, height: 980 });
  await page.waitForSelector("body.is-ready", { timeout: 25000 });
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

const openWorkspaceViaLauncher = async (page) => {
  await waitForLauncherVisible(page);
  await page.click("#launcher-open");
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
    timeout: 30000,
  });
};

const clickSideTab = async (page, key) => {
  await page.click(`button.tab[data-tab="${key}"]`);
  await page.waitForSelector(`.sidebar-panel .panel.is-active[data-panel="${key}"]`, {
    timeout: 10000,
  });
};

const openSettingsPage = async (page, pageId) => {
  await clickSideTab(page, "settings");
  const pageSelector = `.settings-page[data-settings-page="${pageId}"]`;
  const activeCount = await page.locator(`${pageSelector}.is-active`).count();
  if (activeCount > 0) {
    return;
  }
  await page.click(`button.settings-nav-item[data-settings-target="${pageId}"]`);
  await page.waitForSelector(`${pageSelector}.is-active`, { timeout: 10000 });
};

const installMainIpcRecorder = async (app) => {
  await app.evaluate(({ ipcMain }) => {
    if (global.__runtimeGuardMainRecorderInstalled === true) {
      return;
    }
    global.__runtimeGuardMainRecorderInstalled = true;
    global.__runtimeGuardMainMessages = [];
    ipcMain.on("tex64", (_event, message) => {
      try {
        const snapshot =
          message && typeof message === "object"
            ? JSON.parse(JSON.stringify(message))
            : message;
        global.__runtimeGuardMainMessages.push(snapshot);
      } catch {
        global.__runtimeGuardMainMessages.push({ type: "__unserializable" });
      }
    });
  });
};

const clearMainIpcRecorder = async (app) => {
  await app.evaluate(() => {
    global.__runtimeGuardMainMessages = [];
  });
};

const readMainMessages = async (app) =>
  app.evaluate(() =>
    Array.isArray(global.__runtimeGuardMainMessages)
      ? global.__runtimeGuardMainMessages
      : []
  );

const run = async () => {
  const { tempDir, workspacePath, userDataPath } = await createWorkspaceCopy();
  let app;
  try {
    const launched = await launchApp({ workspacePath, userDataPath });
    app = launched.app;
    const page = launched.page;

    await installMainIpcRecorder(app);
    await openWorkspaceViaLauncher(page);
    await waitForWorkspaceReady(page);

    await openSettingsPage(page, "runtime");
    await page.waitForFunction(() => {
      const node = document.getElementById("settings-runtime-onboarding-status");
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      const text = node.textContent || "";
      return text.includes("実行環境が不足");
    });
    const firstBuildDisabled = await page.isDisabled("#settings-runtime-run-first-build");
    assert.equal(firstBuildDisabled, true, "first-build button should be disabled when runtime is missing");

    await clearMainIpcRecorder(app);
    await clickSideTab(page, "files");
    await page.click("#build-button");

    await page.waitForFunction(() => {
      const summaryNode = document.getElementById("issues-summary");
      const list = document.getElementById("issues-list");
      const summaryText = summaryNode instanceof HTMLElement ? summaryNode.textContent || "" : "";
      const listText = list instanceof HTMLElement ? list.textContent || "" : "";
      const actionableIssue =
        list instanceof HTMLElement
          ? list.querySelector('.issue-item[data-action="open-runtime"]')
          : null;
      return (
        summaryText.includes("実行環境が不足") ||
        listText.includes("未検出です") ||
        actionableIssue instanceof HTMLElement
      );
    });

    const buildButtonState = await page.evaluate(() => {
      const button = document.getElementById("build-button");
      if (!(button instanceof HTMLElement)) {
        return { ariaBusy: null, isBusyClass: false };
      }
      return {
        ariaBusy: button.getAttribute("aria-busy"),
        isBusyClass: button.classList.contains("is-busy"),
      };
    });
    assert.equal(
      buildButtonState.isBusyClass,
      false,
      "build button should not enter busy class state on preflight block"
    );
    assert.ok(
      buildButtonState.ariaBusy === null || buildButtonState.ariaBusy === "false",
      "build button should not enter aria-busy=true state on preflight block"
    );

    const messages = await readMainMessages(app);
    const buildMessages = messages.filter((entry) => entry?.type === "build");
    assert.equal(buildMessages.length, 0, "build IPC should be blocked when runtime preflight fails");
  } finally {
    if (app) {
      await allowE2EQuit(app);
      await app.close().catch(() => {});
    }
    if (tempDir && process.env.E2E_KEEP_WORKSPACE !== "1") {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
