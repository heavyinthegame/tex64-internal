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
const saveShortcut = process.platform === "darwin" ? "Meta+S" : "Control+S";

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => console.log(`[formatter-e2e ${now()}] ${message}`);

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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-formatter-"));
  const workspacePath = path.join(tempDir, "workspace");
  const userDataPath = path.join(tempDir, "userdata");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });
  return { tempDir, workspacePath, userDataPath };
};

const launchApp = async ({ workspacePath, userDataPath, extraEnv = {} }) => {
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
          ...extraEnv,
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
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
    timeout: 30000,
  });
  await page.waitForSelector("#file-tree", { timeout: 15000 });
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

const ensureFolderOpen = async (page, relativePath) => {
  const detailsSelector = `#file-tree details.file-folder[data-path="${relativePath}"]`;
  await page.waitForSelector(detailsSelector, { timeout: 10000 });
  const isOpen = await page.$eval(
    detailsSelector,
    (node) => node instanceof HTMLDetailsElement && node.open
  );
  if (!isOpen) {
    await page.click(`${detailsSelector} > summary`);
  }
  await page.waitForFunction(
    (selector) => {
      const node = document.querySelector(selector);
      return node instanceof HTMLDetailsElement && node.open;
    },
    detailsSelector,
    { timeout: 8000 }
  );
};

const ensureFolderPathOpen = async (page, relativePath) => {
  const segments = relativePath.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    await ensureFolderOpen(page, current);
  }
};

const clickFileTreeFile = async (page, relativePath) => {
  const selector = `#file-tree button.file-item[data-path="${relativePath}"]`;
  await page.waitForSelector(selector, { timeout: 12000 });
  await page.click(selector);
};

const setCheckbox = async (page, selector, expected) => {
  const checked = await page.isChecked(selector);
  if (checked !== expected) {
    const id = selector.startsWith("#") ? selector.slice(1) : null;
    if (id) {
      await page.click(`label[for="${id}"]`);
    } else {
      await page.click(selector);
    }
  }
  await page.waitForFunction(
    ({ nodeSelector, value }) => {
      const input = document.querySelector(nodeSelector);
      return input instanceof HTMLInputElement && input.checked === value;
    },
    { nodeSelector: selector, value: expected },
    { timeout: 8000 }
  );
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

const waitForFilePredicate = async (filePath, predicate, timeout = 12000, label = "file predicate") => {
  await waitForCondition(
    async () => {
      const content = await fs.readFile(filePath, "utf8").catch(() => "");
      return predicate(content);
    },
    timeout,
    label
  );
};

const waitForIssueContains = async (page, needle, timeout = 25000) => {
  const target = needle.toLowerCase();
  await page.waitForFunction(
    (value) => {
      const rows = Array.from(document.querySelectorAll("#issues-list .issue-message"));
      return rows.some((row) => (row.textContent ?? "").toLowerCase().includes(value));
    },
    target,
    { timeout }
  );
};

const run = async () => {
  const { tempDir, workspacePath, userDataPath } = await createWorkspaceCopy();
  const blankTarget = path.join(workspacePath, "cases", "format", "format-blanklines.tex");
  const verbatimTarget = path.join(
    workspacePath,
    "cases",
    "format",
    "format-verbatim-custom.tex"
  );

  let app;
  try {
    log(`workspace copy: ${workspacePath}`);
    ({ app } = await launchApp({
      workspacePath,
      userDataPath,
      extraEnv: { TEX64_E2E_FORCE_MISSING_TOOLS: "latexindent" },
    }));

    const page = await app.firstWindow();
    await openWorkspaceViaLauncher(page);
    await waitForWorkspaceReady(page);

    log("[1/4] configure formatter settings via UI");
    await openSettingsPage(page, "format");
    await page.selectOption("#editor-format-indent", "spaces-4");
    await setCheckbox(page, "#editor-format-document-noindent", false);
    await page.selectOption("#editor-format-blank-lines", "remove");
    await page.fill("#editor-format-verbatim-input", "myverbatim");
    await page.click("#editor-format-verbatim-add");
    await page.waitForSelector('#editor-format-verbatim-list [data-verbatim-name="myverbatim"]', {
      timeout: 10000,
    });

    log("[2/4] save-time formatting");
    await clickSideTab(page, "files");
    await ensureFolderPathOpen(page, "cases/format");
    await clickFileTreeFile(page, "cases/format/format-indent.tex");
    await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="cases/format/format-indent.tex"]', {
      timeout: 10000,
    });
    await page.click("#editor", { position: { x: 36, y: 36 } });
    await pause(140);
    await page.keyboard.press(saveShortcut);
    await pause(280);

    log("[3/4] manual formatting + blank line/custom verbatim behavior");
    await ensureFolderPathOpen(page, "cases/format");
    await clickFileTreeFile(page, "cases/format/format-blanklines.tex");
    await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="cases/format/format-blanklines.tex"]', {
      timeout: 10000,
    });
    await page.click("#format-button");
    await waitForFilePredicate(
      blankTarget,
      (content) => !content.includes("\\\\\n\n") && content.includes("d &= e + f"),
      20000,
      "manual format removed blank lines in math env"
    );

    await ensureFolderPathOpen(page, "cases/format");
    await clickFileTreeFile(page, "cases/format/format-verbatim-custom.tex");
    await page.waitForSelector(
      '#editor-tabs-list .editor-tab.is-active[data-path="cases/format/format-verbatim-custom.tex"]',
      { timeout: 10000 }
    );
    await page.click("#format-button");
    await waitForFilePredicate(
      verbatimTarget,
      (content) => content.includes("\n\\item should not reformat\n"),
      20000,
      "custom verbatim should keep inner block untouched"
    );

    log("[4/4] latexindent-missing warning attaches open-runtime action");
    await clickSideTab(page, "issues");
    await waitForIssueContains(page, "latexindent", 30000);
    await page.waitForSelector('#issues-list .issue-item[data-action="open-runtime"]', {
      timeout: 30000,
    });
    await page.click('#issues-list .issue-item[data-action="open-runtime"]');
    await page.waitForSelector(
      '.panel.is-active[data-panel="settings"] .settings-page[data-settings-page="runtime"].is-active',
      { timeout: 12000 }
    );

    log("formatter e2e passed");
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
