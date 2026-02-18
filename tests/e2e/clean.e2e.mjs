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
const log = (message) => console.log(`[clean-e2e ${now()}] ${message}`);

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const toPosix = (value) => value.split(path.sep).join("/");

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-clean-"));
  const workspacePath = path.join(tempDir, "workspace");
  const userDataPath = path.join(tempDir, "userdata");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });
  return { tempDir, workspacePath, userDataPath };
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
          TEX64_E2E_USERDATA: userDataPath,
          TEX64_E2E_DIALOG_QUEUE: JSON.stringify({
            openWorkspace: [toPosix(workspacePath)],
          }),
        },
      });
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1660, height: 980 });
      await page.waitForSelector("body.is-ready", { timeout: 25000 });
      return { app, page };
    } catch (error) {
      lastError = error;
      if (app) {
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
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
    timeout: 30000,
  });
  await page.waitForSelector("#file-tree", { timeout: 15000 });
};

const clickSideTab = async (page, key) => {
  const alreadyActive = await page.evaluate((tabKey) => {
    const tab = document.querySelector(`button.tab[data-tab="${tabKey}"]`);
    const panel = document.querySelector(`.sidebar-panel .panel[data-panel="${tabKey}"]`);
    return Boolean(
      tab instanceof HTMLElement &&
        panel instanceof HTMLElement &&
        tab.classList.contains("is-active") &&
        panel.classList.contains("is-active")
    );
  }, key);
  if (!alreadyActive) {
    await page.evaluate((tabKey) => {
      const button = document.querySelector(`button.tab[data-tab="${tabKey}"]`);
      if (button instanceof HTMLButtonElement) {
        button.click();
      }
    }, key);
  }
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

const fileExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const waitForCondition = async (predicate, timeoutMs, label) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await pause(120);
  }
  throw new Error(`timeout: ${label}`);
};

const runCleanAction = async (page, selector, expected) => {
  await openSettingsPage(page, "build");
  let dialogMessage = "";
  const handled = new Promise((resolve) => {
    page.once("dialog", async (dialog) => {
      dialogMessage = dialog.message();
      await dialog.accept();
      resolve();
    });
  });
  await page.click(selector);
  await handled;
  assert.ok(
    dialogMessage.includes(expected),
    `unexpected clean confirm text: ${dialogMessage}`
  );
};

const run = async () => {
  const { tempDir, workspacePath, userDataPath } = await createWorkspaceCopy();
  const settingsPath = path.join(workspacePath, ".tex64", "settings.json");
  const cleanProfileId = "e2e-clean-profile";
  const outA = path.join(workspacePath, "build-clean-a");
  const outB = path.join(workspacePath, "build-clean-b");
  const outPdf = path.join(outB, "main.pdf");
  const outAux = path.join(outB, "main.aux");
  let app;

  try {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify(
        {
          buildProfiles: [
            {
              id: cleanProfileId,
              name: "e2e-clean",
              outDir: "build-clean-a",
              extraArgs: "-outdir=build-clean-b",
            },
          ],
          buildProfileId: cleanProfileId,
        },
        null,
        2
      ),
      "utf8"
    );
    log(`workspace copy: ${workspacePath}`);

    ({ app } = await launchApp({ workspacePath, userDataPath }));
    const page = await app.firstWindow();

    await openWorkspaceViaLauncher(page);
    await waitForWorkspaceReady(page);

    log("[1/5] load profile (outDir + extraArgs -outdir)");
    await openSettingsPage(page, "build");
    await page.selectOption("#settings-build-profile", cleanProfileId);
    await pause(220);

    log("[2/5] prepare aux/pdf artifacts in extraArgs outDir");
    await fs.rm(outA, { recursive: true, force: true });
    await fs.rm(outB, { recursive: true, force: true });
    await fs.mkdir(outB, { recursive: true });
    await fs.writeFile(outPdf, "%PDF-1.4\n% tex64 e2e clean\n", "utf8");
    await fs.writeFile(outAux, "\\relax\n", "utf8");
    await waitForCondition(async () => await fileExists(outPdf), 10000, "prepared pdf in outDir B");
    assert.equal(
      await fileExists(path.join(outA, "main.pdf")),
      false,
      "profile outDir should be ignored when extraArgs has -outdir"
    );

    log("[3/5] clean (-c) removes aux and keeps pdf");
    await waitForCondition(async () => await fileExists(outAux), 30000, "aux exists before clean");
    await runCleanAction(page, "#settings-build-clean", "clean を実行します");
    await waitForCondition(
      async () => (await fileExists(outPdf)) && !(await fileExists(outAux)),
      40000,
      "clean result"
    );

    log("[4/5] clean -C removes pdf");
    await runCleanAction(page, "#settings-build-clean-all", "clean -C を実行します");
    await waitForCondition(async () => !(await fileExists(outPdf)), 40000, "clean -C removed pdf");

    log("[5/5] invalid outDir is rejected in clean/deep clean");
    await openSettingsPage(page, "build");
    await page.selectOption("#settings-build-profile", cleanProfileId);
    await pause(180);
    await page.fill("#settings-build-outdir", "/tmp/tex64-e2e-invalid-clean-outdir");
    await page.fill("#settings-build-extra-args", "");
    await page.locator("#settings-build-extra-args").blur();
    await pause(500);
    const rootAux = path.join(workspacePath, "main.aux");
    const rootPdf = path.join(workspacePath, "main.pdf");
    await fs.writeFile(rootAux, "\\relax\n", "utf8");
    await fs.writeFile(rootPdf, "%PDF-1.4\n% clean invalid outdir sentinel\n", "utf8");

    await runCleanAction(page, "#settings-build-clean", "clean を実行します");
    await waitForCondition(
      async () => (await fileExists(rootAux)) && (await fileExists(rootPdf)),
      10000,
      "invalid outDir should prevent clean execution"
    );

    await runCleanAction(page, "#settings-build-clean-all", "clean -C を実行します");
    await waitForCondition(
      async () => (await fileExists(rootAux)) && (await fileExists(rootPdf)),
      10000,
      "invalid outDir should prevent deep clean execution"
    );

    log("clean e2e passed");
  } finally {
    if (app) {
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
