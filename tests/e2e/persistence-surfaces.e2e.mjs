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
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "120", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "0", 10);

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => console.log(`[persistence-surfaces-e2e ${now()}] ${message}`);

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
    log(
      `close fallback: ${error instanceof Error ? error.message : String(error)}`
    );
    try {
      app.process()?.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
};

const createFakeLatexindent = async (tempDir) => {
  const binDir = path.join(tempDir, "fake-bin");
  await fs.mkdir(binDir, { recursive: true });
  if (process.platform === "win32") {
    const cmdPath = path.join(binDir, "latexindent.cmd");
    await fs.writeFile(cmdPath, "@echo off\r\nexit /b 0\r\n", "utf8");
    return binDir;
  }
  const scriptPath = path.join(binDir, "latexindent");
  await fs.writeFile(scriptPath, "#!/bin/sh\nexit 0\n", "utf8");
  await fs.chmod(scriptPath, 0o755);
  return binDir;
};

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-persistence-surfaces-"));
  const workspacePath = path.join(tempDir, "workspace");
  const userDataPath = path.join(tempDir, "userdata");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });

  const docsDir = path.join(workspacePath, "docs");
  await fs.mkdir(docsDir, { recursive: true });
  await fs.copyFile(
    path.join(repoRoot, "tests", "e2e", "fixtures", "synctex-precision", "main.pdf"),
    path.join(docsDir, "persist-sample.pdf")
  );

  const fakeBinDir = await createFakeLatexindent(tempDir);
  return { tempDir, workspacePath, userDataPath, fakeBinDir };
};

const isTransientElectronError = (error) => {
  const message = error?.message ?? String(error);
  return (
    message.includes("Process failed to launch") ||
    message.includes("Target page, context or browser has been closed") ||
    message.includes("Target closed")
  );
};

const launchApp = async ({ workspacePath, userDataPath, fakeBinDir }) => {
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
          PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
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
        await closeElectron(app);
      }
      if (!isTransientElectronError(error) || attempt >= 5) {
        throw error;
      }
      log(`transient launch error; retrying (${attempt}/5)`);
      await pause(320);
    }
  }
  throw lastError;
};

const waitForCondition = async (predicate, timeoutMs, label) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await pause(100);
  }
  throw new Error(`timeout: ${label}`);
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
  await page.waitForSelector("#file-tree", { state: "attached", timeout: 15000 });
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

  const active = await page
    .locator(`.settings-page[data-settings-page="${pageId}"].is-active`)
    .count();
  if (active > 0) {
    return;
  }

  const navSelector = `button.settings-nav-item[data-settings-target="${pageId}"]`;
  const navVisible = await page.locator(navSelector).isVisible().catch(() => false);
  if (!navVisible) {
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll("button.settings-back[data-settings-back]")
      );
      const visible = buttons.find(
        (node) =>
          node instanceof HTMLButtonElement &&
          !node.disabled &&
          node.offsetParent !== null &&
          window.getComputedStyle(node).visibility !== "hidden"
      );
      if (visible instanceof HTMLButtonElement) {
        visible.click();
        return true;
      }
      return false;
    });
    if (clicked) {
      await pause(100);
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

const setCheckbox = async (page, selector, expected) => {
  const current = await page.isChecked(selector);
  if (current !== expected) {
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

const waitForStorageValue = async (page, key, expected, timeout = 10000) => {
  await page.waitForFunction(
    ({ storageKey, storageValue }) => localStorage.getItem(storageKey) === storageValue,
    { storageKey: key, storageValue: expected },
    { timeout }
  );
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

const clickFileTreeFile = async (page, relativePath) => {
  const selector = `#file-tree button.file-item[data-path="${relativePath}"]`;
  await page.waitForSelector(selector, { timeout: 12000 });
  await page.click(selector);
};

const waitForSuggestionOpen = async (page, timeout = 10000) => {
  await page.waitForFunction(
    () => {
      const panel = document.querySelector(".math-wysiwyg-panel");
      if (!(panel instanceof HTMLElement)) {
        return false;
      }
      if (panel.getAttribute("aria-hidden") !== "false") {
        return false;
      }
      return panel.querySelectorAll(".math-wysiwyg-item").length > 0;
    },
    undefined,
    { timeout }
  );
};

const getVisibleTabViewerFrame = async (page) => {
  await page.waitForFunction(
    () => {
      const isVisible = (id) => {
        const node = document.getElementById(id);
        if (!(node instanceof HTMLIFrameElement)) {
          return false;
        }
        const style = window.getComputedStyle(node);
        return style.display !== "none" && style.visibility !== "hidden" && node.offsetParent !== null;
      };
      return isVisible("editor-viewer-pdf") || isVisible("editor-viewer-pdf-secondary");
    },
    undefined,
    { timeout: 20000 }
  );
  const selector = await page.evaluate(() => {
    const isVisible = (id) => {
      const node = document.getElementById(id);
      if (!(node instanceof HTMLIFrameElement)) {
        return false;
      }
      const style = window.getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden" && node.offsetParent !== null;
    };
    if (isVisible("editor-viewer-pdf-secondary")) {
      return "#editor-viewer-pdf-secondary";
    }
    if (isVisible("editor-viewer-pdf")) {
      return "#editor-viewer-pdf";
    }
    return null;
  });
  assert.ok(selector, "no visible PDF iframe found");
  const handle = await page.$(selector);
  assert.ok(handle, "failed to get visible PDF iframe handle");
  const frame = await handle.contentFrame();
  assert.ok(frame, "failed to resolve visible PDF iframe frame");
  return frame;
};

const waitForUserSettings = async (userDataPath, workspacePath, timeout = 12000) => {
  const filePath = path.join(userDataPath, "tex64-user-settings.json");
  await waitForCondition(
    async () => {
      const raw = await fs.readFile(filePath, "utf8").catch(() => "");
      if (!raw) {
        return false;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return false;
      }
      const projects = Array.isArray(parsed?.recentProjects) ? parsed.recentProjects : [];
      const hasWorkspace = projects.some((entry) => {
        const target = typeof entry?.path === "string" ? entry.path : "";
        return target === workspacePath || target === toPosix(workspacePath);
      });
      const agent = parsed?.agent;
      return (
        hasWorkspace &&
        agent &&
        typeof agent === "object" &&
        typeof agent.temperature === "number" &&
        typeof agent.maxIterations === "number"
      );
    },
    timeout,
    "tex64-user-settings.json should include recentProjects + agent defaults"
  );
};

const run = async () => {
  const { tempDir, workspacePath, userDataPath, fakeBinDir } = await createWorkspaceCopy();
  const formatTempDir = path.join(workspacePath, ".tex64", ".format");

  let app;
  try {
    log(`workspace copy: ${workspacePath}`);
    ({ app } = await launchApp({ workspacePath, userDataPath, fakeBinDir }));
    let page = await app.firstWindow();
    await openWorkspaceViaLauncher(page);
    await waitForWorkspaceReady(page);

    log("[1/6] userData settings persistence (recentProjects + agent defaults)");
    await waitForUserSettings(userDataPath, workspacePath, 15000);

    log("[2/6] editor/build localStorage keys");
    await openSettingsPage(page, "build");
    await page.selectOption("#settings-compile-engine", "xelatex");
    await setCheckbox(page, "#editor-pdf-window", false);
    await openSettingsPage(page, "editor");
    await page.fill("#editor-ghost-debounce", "260");
    await page.fill("#editor-ghost-max-chars", "180");
    await setCheckbox(page, "#editor-auto-synctex-build", false);
    await setCheckbox(page, "#editor-reverse-synctex", false);
    await setCheckbox(page, "#editor-ghost-completion", false);
    await waitForStorageValue(page, "tex64.compileEngine", "xelatex");
    await waitForStorageValue(page, "tex64.editor.pdfViewerMode", "tab");
    await waitForStorageValue(page, "tex64.editor.autoSynctexOnBuild", "false");
    await waitForStorageValue(page, "tex64.editor.reverseSynctex", "false");
    await waitForStorageValue(page, "tex64.editor.ghostCompletion", "false");
    await waitForStorageValue(page, "tex64.editor.ghostCompletion.debounceMs", "260");
    await waitForStorageValue(page, "tex64.editor.ghostCompletion.maxChars", "180");

    log("[3/6] active tab + outline mode localStorage (with relaunch restore)");
    await clickSideTab(page, "outline");
    await page.evaluate(() => {
      const button = document.getElementById("outline-mode-project");
      if (button instanceof HTMLButtonElement) {
        button.click();
      }
    });
    await waitForStorageValue(page, "tex64.outline.mode", "project");
    await clickSideTab(page, "search");
    await waitForStorageValue(page, "tex64.activeTab", "search");

    await closeElectron(app);
    app = null;

    ({ app } = await launchApp({ workspacePath, userDataPath, fakeBinDir }));
    page = await app.firstWindow();
    await openWorkspaceViaLauncher(page);
    await waitForWorkspaceReady(page);
    await page.waitForSelector('.sidebar-panel .panel.is-active[data-panel="search"]', {
      timeout: 10000,
    });
    await waitForStorageValue(page, "tex64.activeTab", "search");

    log("[4/6] blocks localStorage keys (mode/wrap/auto/packs/mru)");
    await clickSideTab(page, "blocks");
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
      { timeout: 15000 }
    );
    await page.click("#block-math-input");
    await page.keyboard.type("sqrt", { delay: 20 });
    await page.click("#block-suggest-button");
    await waitForSuggestionOpen(page, 10000);
    await page.keyboard.press("Enter");
    await pause(250);

    await page.click("#block-settings-button");
    await page.waitForSelector('#block-settings-modal.is-open[aria-hidden="false"]', {
      timeout: 10000,
    });
    await page.click('[data-block-settings-target="insert-format"]');
    await page.waitForSelector('.block-settings-page.is-active[data-block-settings-page="insert-format"]', {
      timeout: 10000,
    });
    await page.click('button.block-settings-option[data-inline-format="inline-paren"]');
    await page.click('button.block-settings-option[data-display-format="display-bracket"]');
    await page.click('.block-settings-page.is-active .block-settings-back');
    await page.click('[data-block-settings-target="suggestions"]');
    await page.waitForSelector('.block-settings-page.is-active[data-block-settings-page="suggestions"]', {
      timeout: 10000,
    });
    await page.click('button.block-settings-option[data-wysiwyg-auto="off"]');
    await page.click('button.block-settings-option[data-wysiwyg-pack="math"]');
    await page.click("#block-settings-close");
    await page.waitForSelector('#block-settings-modal[aria-hidden="true"]', {
      timeout: 10000,
    });

    await page.click("#block-format-button");
    await page.waitForSelector('#block-format-menu[aria-hidden="false"]', { timeout: 8000 });
    await page.click('#block-format-menu .block-format-option[data-format="none"]');
    await waitForStorageValue(page, "tex64.math-insert-mode", "none");
    await waitForStorageValue(page, "tex64.math-insert-inline-wrap", "inline-paren");
    await waitForStorageValue(page, "tex64.math-insert-display-wrap", "display-bracket");
    await waitForStorageValue(page, "tex64.math-wysiwyg.autoSuggest", "false");
    const blocksStorageState = await page.evaluate(() => {
      const packsRaw = localStorage.getItem("tex64.math-wysiwyg.packs");
      let packs = [];
      try {
        packs = packsRaw ? JSON.parse(packsRaw) : [];
      } catch {
        packs = [];
      }
      const mruKeys = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (typeof key === "string" && (key === "tex64.math-wysiwyg.mru" || key.startsWith("tex64.math-wysiwyg.mru."))) {
          mruKeys.push(key);
        }
      }
      const mruEntries = mruKeys
        .map((key) => {
          const raw = localStorage.getItem(key);
          if (!raw) {
            return 0;
          }
          try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === "object" ? Object.keys(parsed).length : 0;
          } catch {
            return 0;
          }
        })
        .reduce((sum, count) => sum + count, 0);
      return {
        packs,
        hasCore: Array.isArray(packs) && packs.includes("core"),
        mruKeyCount: mruKeys.length,
        mruEntries,
      };
    });
    assert.equal(blocksStorageState.hasCore, true, "math-wysiwyg packs should include core");
    assert.ok(blocksStorageState.mruKeyCount > 0, "mru key should be stored");
    assert.ok(blocksStorageState.mruEntries > 0, "mru entries should not be empty");

    log("[5/6] PDF viewer localStorage keys (invert + sidebarTab)");
    await clickSideTab(page, "files");
    await ensureFolderOpen(page, "docs");
    await clickFileTreeFile(page, "docs/persist-sample.pdf");
    const frame = await getVisibleTabViewerFrame(page);
    await frame.waitForSelector("#pdf-pages .page[data-page-number='1']", { timeout: 25000 });
    const sidebarVisible = await frame.evaluate(
      () => window.__tex64PdfViewer?.state?.sidebarVisible === true
    );
    if (!sidebarVisible) {
      await frame.evaluate(() => {
        const button = document.getElementById("pdf-sidebar-toggle");
        if (button instanceof HTMLButtonElement) {
          button.click();
        }
      });
    }
    await frame.evaluate(() => {
      const button = document.getElementById("pdf-tab-thumbs");
      if (button instanceof HTMLButtonElement) {
        button.click();
      }
    });
    await frame.waitForFunction(
      () => window.__tex64PdfViewer?.state?.sidebarTab === "thumbs",
      undefined,
      { timeout: 8000 }
    );
    const inverted = await frame.evaluate(() => document.body.classList.contains("is-inverted"));
    if (!inverted) {
      await frame.evaluate(() => {
        const button = document.getElementById("pdf-invert");
        if (button instanceof HTMLButtonElement) {
          button.click();
        }
      });
    }
    await frame.waitForFunction(() => document.body.classList.contains("is-inverted"), undefined, {
      timeout: 8000,
    });
    const pdfStorage = await frame.evaluate(() => ({
      invert: localStorage.getItem("tex64.pdf.invert"),
      sidebarTab: localStorage.getItem("tex64.pdf.sidebarTab"),
    }));
    assert.equal(pdfStorage.invert, "true", "pdf invert should persist in localStorage");
    assert.equal(pdfStorage.sidebarTab, "thumbs", "pdf sidebarTab should persist in localStorage");

    log("[6/6] formatter temp directory persistence (.tex64/.format)");
    await clickSideTab(page, "files");
    await clickFileTreeFile(page, "main.tex");
    await page.click("#format-button");
    await waitForCondition(
      async () => {
        const stat = await fs.stat(formatTempDir).catch(() => null);
        return stat?.isDirectory?.() === true;
      },
      15000,
      ".tex64/.format directory should exist after formatting"
    );

    log("persistence surfaces e2e passed");
  } finally {
    await closeElectron(app).catch(() => {});
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      log("workspace copy removed");
    } else {
      log(`workspace copy kept: ${tempDir}`);
    }
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
