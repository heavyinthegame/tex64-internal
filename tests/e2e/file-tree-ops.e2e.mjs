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
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "60", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "30", 10);
const modKey = process.platform === "darwin" ? "Meta" : "Control";

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[file-tree-e2e ${now()}] ${message}`);
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
  await fs.mkdir(path.join(workspacePath, "ops"), { recursive: true });
  await fs.mkdir(path.join(workspacePath, "dest"), { recursive: true });
  await fs.mkdir(path.join(workspacePath, "deep", "inner"), { recursive: true });

  await fs.writeFile(
    path.join(workspacePath, "main.tex"),
    [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\input{ops/root-target}",
      "\\end{document}",
      "",
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(path.join(workspacePath, "ops", "source.tex"), "source\n", "utf8");
  await fs.writeFile(path.join(workspacePath, "ops", "move-me.tex"), "move-me\n", "utf8");
  await fs.writeFile(path.join(workspacePath, "ops", "dirty.tex"), "dirty\n", "utf8");
  await fs.writeFile(path.join(workspacePath, "ops", "root-target.tex"), "root-target\n", "utf8");
  await fs.writeFile(path.join(workspacePath, "deep", "inner", "leaf.tex"), "leaf\n", "utf8");
};

const exists = async (targetPath) =>
  fs
    .access(targetPath)
    .then(() => true)
    .catch(() => false);

const waitForPathState = async (targetPath, expected, timeoutMs = 10000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = await exists(targetPath);
    if (current === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`timed out waiting for path state: ${targetPath} expected=${expected}`);
};

const waitForCondition = async (fn, timeoutMs = 10000, message = "condition timeout") => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(message);
};

const waitForSettings = async (workspacePath, predicate, timeoutMs = 10000) => {
  const settingsPath = path.join(workspacePath, ".tex64", "settings.json");
  await waitForCondition(
    async () => {
      const raw = await fs.readFile(settingsPath, "utf8").catch(() => "{}");
      let parsed = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = {};
      }
      return predicate(parsed && typeof parsed === "object" ? parsed : {});
    },
    timeoutMs,
    "timed out waiting for settings update"
  );
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

const waitForLauncherVisible = async (page) => {
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
    { timeout: 15000 }
  );
};

const waitForWorkspaceOpened = async (page, workspaceName) => {
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
    workspaceName,
    { timeout: 25000 }
  );
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
    timeout: 25000,
  });
};

const clickFileTreePath = async (page, relativePath, type = "file") => {
  const selector =
    type === "file"
      ? `#file-tree button.file-item[data-path="${relativePath}"]`
      : `#file-tree details.file-folder[data-path="${relativePath}"] > summary`;
  await page.waitForSelector(selector, { timeout: 10000 });
  await page.click(selector);
};

const ensureFolderOpen = async (page, relativePath) => {
  const detailsSelector = `#file-tree details.file-folder[data-path="${relativePath}"]`;
  await page.waitForSelector(detailsSelector, { timeout: 10000 });
  const isOpen = await page.$eval(
    detailsSelector,
    (node) => node instanceof HTMLDetailsElement && node.open
  );
  if (!isOpen) {
    await clickFileTreePath(page, relativePath, "dir");
  }
  await page.waitForFunction(
    (value) => {
      const node = document.querySelector(
        `#file-tree details.file-folder[data-path="${value}"]`
      );
      return node instanceof HTMLDetailsElement && node.open;
    },
    relativePath,
    { timeout: 8000 }
  );
};

const rightClickFileTreePath = async (page, relativePath, type = "file") => {
  const selector =
    type === "file"
      ? `#file-tree button.file-item[data-path="${relativePath}"]`
      : `#file-tree details.file-folder[data-path="${relativePath}"] > summary`;
  await page.waitForSelector(selector, { timeout: 10000 });
  await page.click(selector, { button: "right" });
  await page.waitForFunction(
    () => {
      const menu = document.getElementById("context-menu");
      return Boolean(menu && menu.classList.contains("is-open"));
    },
    undefined,
    { timeout: 8000 }
  );
};

const readContextMenuLabels = async (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("#context-menu-panel .context-menu-item")).map((node) =>
      (node.textContent ?? "").replace(/\s+/g, " ").trim()
    )
  );

const clickContextMenuItem = async (page, label) => {
  const clicked = await page.evaluate((targetLabel) => {
    const items = Array.from(
      document.querySelectorAll("#context-menu-panel .context-menu-item")
    );
    const target = items.find((node) =>
      (node.textContent ?? "").replace(/\s+/g, " ").trim().startsWith(targetLabel)
    );
    if (!target) {
      return false;
    }
    target.click();
    return true;
  }, label);
  assert.equal(clicked, true, `context menu item not found: ${label}`);
};

const waitForContextMenuOpen = async (page, expectedOpen, timeout = 8000) => {
  await page.waitForFunction(
    (open) => {
      const menu = document.getElementById("context-menu");
      if (!(menu instanceof HTMLElement)) {
        return false;
      }
      return menu.classList.contains("is-open") === open;
    },
    expectedOpen,
    { timeout }
  );
};

const selectTreePathForShortcut = async (page, relativePath, type = "file") => {
  await rightClickFileTreePath(page, relativePath, type);
  await page.keyboard.press("Escape");
  await waitForContextMenuOpen(page, false);
  await page.focus("#file-tree");
};

const pressTreeShortcut = async (page, shortcut) => {
  await page.focus("#file-tree");
  await page.keyboard.press(shortcut);
};

const waitForModalOpen = async (page, modalId, open = true, timeout = 8000) => {
  await page.waitForFunction(
    ({ id, expectedOpen }) => {
      const modal = document.getElementById(id);
      if (!(modal instanceof HTMLElement)) {
        return false;
      }
      const isOpen = modal.classList.contains("is-open");
      const aria = modal.getAttribute("aria-hidden");
      return isOpen === expectedOpen && aria === (expectedOpen ? "false" : "true");
    },
    { id: modalId, expectedOpen: open },
    { timeout }
  );
};

const createFromModal = async (page, value) => {
  await waitForModalOpen(page, "create-modal", true);
  await page.fill("#create-modal-input", value);
  await page.click("#create-modal-submit");
  await waitForModalOpen(page, "create-modal", false);
};

const renameFromModal = async (page, value, close = true) => {
  await waitForModalOpen(page, "rename-modal", true);
  await page.fill("#rename-modal-input", value);
  await page.click("#rename-modal-submit");
  if (close) {
    await waitForModalOpen(page, "rename-modal", false);
  }
};

const installBridgeCollector = async (page) => {
  await page.evaluate(() => {
    if (typeof window.__e2eBridgeUnsub === "function") {
      try {
        window.__e2eBridgeUnsub();
      } catch {}
    }
    window.__e2eBridgeMessages = [];
    const bridge = window.tex64Bridge;
    if (!bridge?.onMessage) {
      window.__e2eBridgeUnsub = null;
      return;
    }
    window.__e2eBridgeUnsub = bridge.onMessage((message) => {
      window.__e2eBridgeMessages.push(message);
    });
  });
};

const waitForBridgeMessage = async (page, type, predicate, timeoutMs = 10000) =>
  page.waitForFunction(
    ({ expectedType, expectedPredicateSource }) => {
      const messages = Array.isArray(window.__e2eBridgeMessages)
        ? window.__e2eBridgeMessages
        : [];
      let predicateFn = null;
      if (typeof expectedPredicateSource === "string" && expectedPredicateSource.length > 0) {
        predicateFn = new Function("payload", expectedPredicateSource);
      }
      return messages.some((entry) => {
        if (!entry || entry.type !== expectedType) {
          return false;
        }
        if (!predicateFn) {
          return true;
        }
        try {
          return Boolean(predicateFn(entry.payload));
        } catch {
          return false;
        }
      });
    },
    {
      expectedType: type,
      expectedPredicateSource: predicate ? `return (${predicate})(payload);` : "",
    },
    { timeout: timeoutMs }
  );

const openProjectTab = async (page) => {
  await page.click('button.tab[data-tab="project"]');
  await page.waitForSelector('.sidebar-panel .panel.is-active[data-panel="project"]', {
    timeout: 10000,
  });
};

const setRootFile = async (page, relativePath) => {
  const selected = await page.selectOption("#settings-root-select", relativePath);
  assert.ok(selected.includes(relativePath), `setRootFile failed: ${relativePath}`);
};

const readRenameHelp = async (page) => {
  const text = await page.locator("#rename-modal-help").first().textContent();
  return (text ?? "").trim();
};

const readIssueMessages = async (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("#issues-list .issue-message")).map((node) =>
      (node.textContent ?? "").trim()
    )
  );

const waitForIssueContains = async (page, needle, timeout = 10000) => {
  const lowerNeedle = needle.toLowerCase();
  await page.waitForFunction(
    (value) =>
      Array.from(document.querySelectorAll("#issues-list .issue-message")).some((node) =>
        (node.textContent ?? "").toLowerCase().includes(value)
      ),
    lowerNeedle,
    { timeout }
  );
};

const waitForTreeDirtyState = async (page, relativePath, expectedDirty, timeout = 10000) => {
  await page.waitForFunction(
    ({ path, expected }) => {
      const node = document.querySelector(`#file-tree button.file-item[data-path="${path}"]`);
      return node instanceof HTMLElement && node.classList.contains("is-dirty") === expected;
    },
    { path: relativePath, expected: expectedDirty },
    { timeout }
  );
};

const dragFileToFolder = async (page, sourcePath, folderPath) => {
  const sourceSelector = `#file-tree button.file-item[data-path="${sourcePath}"]`;
  const targetSelector = `#file-tree details.file-folder[data-path="${folderPath}"] > summary`;
  await page.waitForSelector(sourceSelector, { timeout: 10000 });
  await page.waitForSelector(targetSelector, { timeout: 10000 });

  const sourceRect = await page.locator(sourceSelector).boundingBox();
  const targetRect = await page.locator(targetSelector).boundingBox();
  if (!sourceRect || !targetRect) {
    throw new Error(`cannot resolve drag geometry: ${sourcePath} -> ${folderPath}`);
  }
  await page.mouse.move(sourceRect.x + sourceRect.width / 2, sourceRect.y + sourceRect.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetRect.x + targetRect.width / 2, targetRect.y + targetRect.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
};

const run = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-file-tree-"));
  const workspacePath = path.join(tempDir, "workspace");
  const userDataPath = path.join(tempDir, "userdata");
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });
  await createWorkspaceScenario(workspacePath);

  let app = null;
  try {
    log("[1/10] open workspace from launcher");
    const firstLaunch = await launchApp({ userDataPath, workspacePath });
    app = firstLaunch.app;
    const page = firstLaunch.page;
    await installBridgeCollector(page);
    await waitForLauncherVisible(page);
    await page.keyboard.press("Enter");
    await waitForWorkspaceOpened(page, path.basename(workspacePath));

    log("[2/10] tree open-state persistence (localStorage + reopen)");
    await clickFileTreePath(page, "deep/inner", "dir");
    const openStateContainsInner = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((entry) => entry.startsWith("tex64.tree."));
      if (!key) return false;
      const raw = localStorage.getItem(key) ?? "[]";
      let parsed = [];
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = [];
      }
      return Array.isArray(parsed) && parsed.includes("deep/inner");
    });
    assert.equal(openStateContainsInner, true, "tree open-state should include deep/inner");
    await closeElectron(app);
    app = null;

    const secondLaunch = await launchApp({ userDataPath, workspacePath });
    app = secondLaunch.app;
    const reopenedPage = secondLaunch.page;
    await installBridgeCollector(reopenedPage);
    await waitForLauncherVisible(reopenedPage);
    await reopenedPage.keyboard.press("Enter");
    await waitForWorkspaceOpened(reopenedPage, path.basename(workspacePath));
    await reopenedPage.waitForFunction(
      () => {
        const details = document.querySelector('details.file-folder[data-path="deep/inner"]');
        return details instanceof HTMLDetailsElement && details.open === true;
      },
      undefined,
      { timeout: 12000 }
    );
    await ensureFolderOpen(reopenedPage, "ops");
    await ensureFolderOpen(reopenedPage, "dest");

    log("[3/10] context menu labels + Finder/Terminal actions");
    await rightClickFileTreePath(reopenedPage, "ops/source.tex", "file");
    const fileMenuLabels = await readContextMenuLabels(reopenedPage);
    [
      "開く",
      "新しいファイル...",
      "新しいフォルダー...",
      "Finderで表示",
      "ターミナルで開く",
      "名前の変更...",
      "削除",
    ].forEach((label) => {
      assert.ok(
        fileMenuLabels.some((entry) => entry.startsWith(label)),
        `file context menu missing: ${label}`
      );
    });
    await clickContextMenuItem(reopenedPage, "Finderで表示");
    await waitForBridgeMessage(
      reopenedPage,
      "e2e:externalAction",
      "(payload) => payload && payload.kind === 'revealInFinder' && payload.path === 'ops/source.tex'"
    );

    await rightClickFileTreePath(reopenedPage, "ops", "dir");
    const folderMenuLabels = await readContextMenuLabels(reopenedPage);
    [
      "新しいファイル...",
      "新しいフォルダー...",
      "Finderで表示",
      "ターミナルで開く",
      "名前の変更...",
      "削除",
    ].forEach((label) => {
      assert.ok(
        folderMenuLabels.some((entry) => entry.startsWith(label)),
        `folder context menu missing: ${label}`
      );
    });
    await clickContextMenuItem(reopenedPage, "ターミナルで開く");
    await waitForBridgeMessage(
      reopenedPage,
      "e2e:externalAction",
      "(payload) => payload && payload.kind === 'openInTerminal' && payload.path === 'ops'"
    );

    log("[4/10] create file/folder via context menu modal");
    await rightClickFileTreePath(reopenedPage, "ops", "dir");
    await clickContextMenuItem(reopenedPage, "新しいファイル...");
    await createFromModal(reopenedPage, "created.tex");
    await waitForPathState(path.join(workspacePath, "ops", "created.tex"), true);

    await rightClickFileTreePath(reopenedPage, "ops", "dir");
    await clickContextMenuItem(reopenedPage, "新しいフォルダー...");
    await createFromModal(reopenedPage, "newdir");
    await waitForPathState(path.join(workspacePath, "ops", "newdir"), true);

    log("[5/10] rename validation + rename success");
    await rightClickFileTreePath(reopenedPage, "ops/created.tex", "file");
    await clickContextMenuItem(reopenedPage, "名前の変更...");
    await renameFromModal(reopenedPage, "bad/name.tex", false);
    assert.equal(await readRenameHelp(reopenedPage), "名前に / は使えません。");
    await renameFromModal(reopenedPage, "renamed.tex", true);
    await waitForPathState(path.join(workspacePath, "ops", "created.tex"), false);
    await waitForPathState(path.join(workspacePath, "ops", "renamed.tex"), true);
    await pressTreeShortcut(reopenedPage, `${modKey}+Z`);
    await waitForPathState(path.join(workspacePath, "ops", "renamed.tex"), true);
    await waitForPathState(path.join(workspacePath, "ops", "newdir"), true);

    log("[6/10] move via drag&drop + copy via shortcut");
    await dragFileToFolder(reopenedPage, "ops/renamed.tex", "dest");
    await waitForPathState(path.join(workspacePath, "ops", "renamed.tex"), false, 12000);
    await waitForPathState(path.join(workspacePath, "dest", "renamed.tex"), true, 12000);

    await selectTreePathForShortcut(reopenedPage, "dest/renamed.tex", "file");
    await pressTreeShortcut(reopenedPage, `${modKey}+C`);
    await selectTreePathForShortcut(reopenedPage, "ops/source.tex", "file");
    await pressTreeShortcut(reopenedPage, `${modKey}+V`);
    await waitForPathState(path.join(workspacePath, "ops", "renamed.tex"), true, 12000);
    await waitForPathState(path.join(workspacePath, "dest", "renamed.tex"), true, 12000);

    log("[7/10] cut+paste move and undo move");
    await selectTreePathForShortcut(reopenedPage, "ops/move-me.tex", "file");
    await pressTreeShortcut(reopenedPage, `${modKey}+X`);
    await selectTreePathForShortcut(reopenedPage, "dest/renamed.tex", "file");
    await pressTreeShortcut(reopenedPage, `${modKey}+V`);
    await waitForPathState(path.join(workspacePath, "ops", "move-me.tex"), false, 12000);
    await waitForPathState(path.join(workspacePath, "dest", "move-me.tex"), true, 12000);
    await pressTreeShortcut(reopenedPage, `${modKey}+Z`);
    await waitForPathState(path.join(workspacePath, "ops", "move-me.tex"), true, 12000);
    await waitForPathState(path.join(workspacePath, "dest", "move-me.tex"), false, 12000);
    await selectTreePathForShortcut(reopenedPage, "ops/move-me.tex", "file");
    await pressTreeShortcut(reopenedPage, `${modKey}+C`);
    await selectTreePathForShortcut(reopenedPage, "dest/renamed.tex", "file");
    await pressTreeShortcut(reopenedPage, `${modKey}+V`);
    await waitForPathState(path.join(workspacePath, "dest", "move-me.tex"), true, 12000);
    await pressTreeShortcut(reopenedPage, `${modKey}+Z`);
    await waitForPathState(path.join(workspacePath, "dest", "move-me.tex"), true, 12000);

    log("[8/10] delete to internal trash and undo delete");
    await rightClickFileTreePath(reopenedPage, "ops/source.tex", "file");
    await clickContextMenuItem(reopenedPage, "削除");
    await waitForPathState(path.join(workspacePath, "ops", "source.tex"), false, 12000);
    const trashDir = path.join(workspacePath, ".tex64", ".trash");
    await waitForCondition(
      async () => {
        const entries = await fs.readdir(trashDir).catch(() => []);
        return entries.some((entry) => entry.endsWith("-source.tex"));
      },
      12000,
      "source.tex should be moved to .tex64/.trash"
    );
    await pressTreeShortcut(reopenedPage, `${modKey}+Z`);
    await waitForPathState(path.join(workspacePath, "ops", "source.tex"), true, 12000);

    log("[9/10] manual root delete+undo restores root setting");
    await openProjectTab(reopenedPage);
    await setRootFile(reopenedPage, "ops/root-target.tex");
    await waitForSettings(
      workspacePath,
      (settings) => settings.rootFile === "ops/root-target.tex",
      12000
    );
    await reopenedPage.click('button.tab[data-tab="files"]');
    await rightClickFileTreePath(reopenedPage, "ops/root-target.tex", "file");
    await clickContextMenuItem(reopenedPage, "削除");
    await waitForPathState(path.join(workspacePath, "ops", "root-target.tex"), false, 12000);
    await waitForSettings(
      workspacePath,
      (settings) => !Object.prototype.hasOwnProperty.call(settings, "rootFile"),
      12000
    );
    await pressTreeShortcut(reopenedPage, `${modKey}+Z`);
    await waitForPathState(path.join(workspacePath, "ops", "root-target.tex"), true, 12000);
    await waitForSettings(
      workspacePath,
      (settings) => settings.rootFile === "ops/root-target.tex",
      12000
    );

    log("[10/10] safety guards on dirty file (rename/move/delete blocked)");
    await clickFileTreePath(reopenedPage, "ops/dirty.tex", "file");
    await reopenedPage.click("#editor .monaco-editor", { position: { x: 120, y: 90 } });
    await reopenedPage.keyboard.type("X", { delay: 0 });

    await rightClickFileTreePath(reopenedPage, "ops/dirty.tex", "file");
    await clickContextMenuItem(reopenedPage, "名前の変更...");
    await renameFromModal(reopenedPage, "dirty-renamed.tex", false);
    assert.equal(
      await readRenameHelp(reopenedPage),
      "未保存の変更があります。保存してから名前を変更してください。"
    );
    await reopenedPage.click("#rename-modal-cancel");
    await waitForModalOpen(reopenedPage, "rename-modal", false);
    await waitForPathState(path.join(workspacePath, "ops", "dirty.tex"), true);
    await waitForPathState(path.join(workspacePath, "ops", "dirty-renamed.tex"), false);

    await reopenedPage.click("#editor .monaco-editor", { position: { x: 120, y: 90 } });
    await reopenedPage.keyboard.type("Y", { delay: 0 });
    await dragFileToFolder(reopenedPage, "ops/dirty.tex", "dest");
    await waitForIssueContains(reopenedPage, "未保存の変更があります。移動前に保存してください。", 12000);
    await waitForPathState(path.join(workspacePath, "ops", "dirty.tex"), true);
    await waitForPathState(path.join(workspacePath, "dest", "dirty.tex"), false);

    await reopenedPage.click("#editor .monaco-editor", { position: { x: 120, y: 90 } });
    await reopenedPage.keyboard.type("Z", { delay: 0 });
    await rightClickFileTreePath(reopenedPage, "ops/dirty.tex", "file");
    await clickContextMenuItem(reopenedPage, "削除");
    await waitForIssueContains(reopenedPage, "未保存の変更があります。削除前に保存してください。", 12000);
    await waitForPathState(path.join(workspacePath, "ops", "dirty.tex"), true);

    const issueMessages = await readIssueMessages(reopenedPage);
    assert.ok(
      issueMessages.some((text) => text.includes("未保存の変更があります。")),
      "dirty guard issue messages should be present"
    );

    await reopenedPage.click("#editor .monaco-editor", { position: { x: 120, y: 90 } });
    await reopenedPage.keyboard.press(`${modKey}+S`);
    await waitForTreeDirtyState(reopenedPage, "ops/dirty.tex", false, 12000);

    log("file-tree ops e2e passed");
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
  console.error("[file-tree-e2e] failed:", error);
  process.exitCode = 1;
});
