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
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "70", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "25", 10);
const modKey = process.platform === "darwin" ? "Meta" : "Control";

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[editor-layout-e2e ${now()}] ${message}`);
};

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const toPosix = (value) => value.split(path.sep).join("/");

const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv5kAAAAASUVORK5CYII=";

const createWorkspaceScenario = async (workspacePath) => {
  await fs.mkdir(path.join(workspacePath, "sections"), { recursive: true });
  await fs.mkdir(path.join(workspacePath, "assets"), { recursive: true });
  await fs.mkdir(path.join(workspacePath, "docs"), { recursive: true });

  await fs.writeFile(
    path.join(workspacePath, "main.tex"),
    [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\input{sections/intro}",
      "\\input{sections/chapter}",
      "\\input{sections/issue}",
      "\\end{document}",
      "",
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(workspacePath, "sections", "intro.tex"),
    [
      "\\section{Intro Section}",
      "\\label{sec:intro}",
      "NEEDLE_INTRO_123",
      "intro body",
      "",
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(workspacePath, "sections", "chapter.tex"),
    ["\\section{Chapter Section}", "chapter body", ""].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(workspacePath, "sections", "issue.tex"),
    ["\\section{Issue Section}", "issue body", ""].join("\n"),
    "utf8"
  );
  await fs.writeFile(path.join(workspacePath, "notes.tex"), "notes\n", "utf8");
  await fs.writeFile(path.join(workspacePath, "binary.bin"), "binary", "utf8");
  await fs.writeFile(
    path.join(workspacePath, "assets", "pixel.png"),
    Buffer.from(tinyPngBase64, "base64")
  );
  await fs.copyFile(
    path.join(repoRoot, "tests", "e2e", "fixtures", "synctex-precision", "main.pdf"),
    path.join(workspacePath, "docs", "sample.pdf")
  );
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

const waitForPathContains = async (filePath, needle, timeoutMs = 10000) => {
  await waitForCondition(
    async () => {
      const text = await fs.readFile(filePath, "utf8").catch(() => "");
      return text.includes(needle);
    },
    timeoutMs,
    `timed out waiting for ${filePath} to include: ${needle}`
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
      TEX64_E2E_USERDATA: userDataPath,
      TEX64_E2E_DIALOG_QUEUE: JSON.stringify({
        openWorkspace: [toPosix(workspacePath)],
      }),
    },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1620, height: 980 });
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

const clickSideTab = async (page, key) => {
  await page.click(`button.tab[data-tab="${key}"]`);
  await page.waitForSelector(`.sidebar-panel .panel.is-active[data-panel="${key}"]`, {
    timeout: 10000,
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

const openSidebarContextMenu = async (page) => {
  await page.click('.sidebar .tab-group:not(.secondary) .tab[data-tab="files"]', {
    button: "right",
  });
  await waitForContextMenuOpen(page, true);
};

const readContextMenuEntries = async (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("#context-menu-panel .context-menu-item")).map((node) => {
      const raw = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      const plain = raw.replace(/^✓\s*/, "");
      return {
        raw,
        plain,
        checked: /^✓\s*/.test(raw),
        disabled: node instanceof HTMLButtonElement ? node.disabled : false,
      };
    })
  );

const clickContextMenuItemByPlainLabel = async (page, plainLabel) => {
  const result = await page.evaluate((targetLabel) => {
    const items = Array.from(
      document.querySelectorAll("#context-menu-panel .context-menu-item")
    );
    const target = items.find((node) => {
      const raw = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      const plain = raw.replace(/^✓\s*/, "");
      return plain === targetLabel;
    });
    if (!(target instanceof HTMLButtonElement)) {
      return "missing";
    }
    if (target.disabled) {
      return "disabled";
    }
    target.click();
    return "clicked";
  }, plainLabel);
  return result;
};

const setSidebarTabVisible = async (page, plainLabel, expectedVisible) => {
  await openSidebarContextMenu(page);
  const entries = await readContextMenuEntries(page);
  const entry = entries.find((item) => item.plain === plainLabel);
  assert.ok(entry, `sidebar context menu item missing: ${plainLabel}`);
  if (entry.checked === expectedVisible) {
    await page.keyboard.press("Escape");
    await waitForContextMenuOpen(page, false);
    return;
  }
  const clickResult = await clickContextMenuItemByPlainLabel(page, plainLabel);
  assert.equal(clickResult, "clicked", `failed to toggle sidebar tab: ${plainLabel}`);
};

const readVisiblePrimaryTabKeys = async (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.sidebar .tab-group:not(.secondary) .tab[data-tab]'))
      .filter((tab) => !tab.classList.contains("is-hidden"))
      .map((tab) => tab.getAttribute("data-tab"))
      .filter((value) => typeof value === "string")
  );

const readSidebarStorage = async (page) =>
  page.evaluate(() => {
    const raw = localStorage.getItem("tex64.sidebar.primaryTabs") ?? "[]";
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  });

const readSidebarPanelWidth = async (page) =>
  page.evaluate(() => {
    const fromVar = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--sidebar-panel-width")
    );
    if (Number.isFinite(fromVar) && fromVar > 0) {
      return fromVar;
    }
    const panel = document.querySelector(".sidebar-panel");
    return panel instanceof HTMLElement ? panel.getBoundingClientRect().width : 0;
  });

const dragHandleToX = async (page, handleSelector, targetX) => {
  const rect = await page.locator(handleSelector).boundingBox();
  if (!rect) {
    throw new Error(`cannot resolve handle geometry: ${handleSelector}`);
  }
  const startX = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(targetX, y, { steps: 10 });
  await page.mouse.up();
};

const dragElementToElement = async (page, sourceSelector, targetSelector) => {
  const sourceRect = await page.locator(sourceSelector).boundingBox();
  const targetRect = await page.locator(targetSelector).boundingBox();
  if (!sourceRect || !targetRect) {
    throw new Error(`cannot resolve drag geometry: ${sourceSelector} -> ${targetSelector}`);
  }
  await page.mouse.move(sourceRect.x + sourceRect.width / 2, sourceRect.y + sourceRect.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetRect.x + targetRect.width / 2, targetRect.y + targetRect.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
};

const setActiveEditorGroup = async (page, key) => {
  const selector = `#editor-groups [data-editor-group="${key}"] .editor-surface`;
  await page.waitForSelector(selector, { timeout: 10000 });
  await page.click(selector, { position: { x: 30, y: 30 } });
  await page.waitForFunction(
    (groupKey) => {
      const group = document.querySelector(`#editor-groups [data-editor-group="${groupKey}"]`);
      return group instanceof HTMLElement && group.classList.contains("is-active");
    },
    key,
    { timeout: 8000 }
  );
};

const readSplitRatio = async (page) =>
  page.evaluate(() => {
    const splitter = document.getElementById("editor-splitter");
    if (splitter instanceof HTMLElement) {
      const value = Number.parseFloat(splitter.getAttribute("aria-valuenow") ?? "");
      if (Number.isFinite(value)) {
        return value / 100;
      }
    }
    const root = document.getElementById("editor-groups");
    if (!(root instanceof HTMLElement)) {
      return null;
    }
    const raw = getComputedStyle(root).getPropertyValue("--split-primary").trim();
    const parsed = Number.parseFloat(raw.replace("fr", ""));
    return Number.isFinite(parsed) ? parsed : null;
  });

const waitForTabState = async (page, selector, expected = true, timeout = 10000) => {
  await page.waitForFunction(
    ({ nodeSelector, shouldExist }) => Boolean(document.querySelector(nodeSelector)) === shouldExist,
    { nodeSelector: selector, shouldExist: expected },
    { timeout }
  );
};

const waitForViewerMode = async (page, selector, mode, timeout = 10000) => {
  await page.waitForFunction(
    ({ nodeSelector, expectedMode }) => {
      const node = document.querySelector(nodeSelector);
      return (
        node instanceof HTMLElement &&
        node.dataset.view === expectedMode &&
        node.classList.contains("is-visible")
      );
    },
    { nodeSelector: selector, expectedMode: mode },
    { timeout }
  );
};

const waitForTabDirtyState = async (page, selector, expectedDirty, timeout = 10000) => {
  await page.waitForFunction(
    ({ nodeSelector, expected }) => {
      const node = document.querySelector(nodeSelector);
      return node instanceof HTMLElement && node.classList.contains("is-dirty") === expected;
    },
    { nodeSelector: selector, expected: expectedDirty },
    { timeout }
  );
};

const waitForBuildIdle = async (page, timeout = 40000) => {
  await page.waitForFunction(
    () => {
      const button = document.getElementById("build-button");
      return button instanceof HTMLButtonElement && !button.classList.contains("is-busy");
    },
    undefined,
    { timeout }
  );
};

const clickBuildAndWait = async (page) => {
  await page.click("#build-button");
  await waitForBuildIdle(page);
};

const readTabCountByPath = async (page, relativePath) =>
  page.evaluate((targetPath) => {
    const primary = document.querySelectorAll(
      `#editor-tabs-list .editor-tab[data-path="${targetPath}"]`
    ).length;
    const secondary = document.querySelectorAll(
      `#editor-tabs-list-secondary .editor-tab[data-path="${targetPath}"]`
    ).length;
    return { primary, secondary, total: primary + secondary };
  }, relativePath);

const waitForSecondaryCursorLine = async (page, expectedLine, timeout = 12000) => {
  await page.waitForFunction(
    (line) => {
      const monacoApi = window.monaco?.editor;
      const editors = monacoApi?.getEditors ? monacoApi.getEditors() : [];
      for (const editor of editors) {
        const node = typeof editor.getDomNode === "function" ? editor.getDomNode() : null;
        if (!node || !node.closest('[data-editor-group="secondary"]')) {
          continue;
        }
        const position =
          typeof editor.getPosition === "function" ? editor.getPosition() : null;
        return position?.lineNumber === line;
      }
      return false;
    },
    expectedLine,
    { timeout }
  );
};

const run = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-editor-layout-"));
  const workspacePath = path.join(tempDir, "workspace");
  const userDataPath = path.join(tempDir, "userdata");
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });
  await createWorkspaceScenario(workspacePath);

  let app = null;
  let storedSplitRatio = null;
  try {
    log("[1/9] launch + workspace open from launcher");
    {
      const launched = await launchApp({ userDataPath, workspacePath });
      app = launched.app;
      const page = launched.page;
      await waitForLauncherVisible(page);
      await page.keyboard.press("Enter");
      await waitForWorkspaceOpened(page, path.basename(workspacePath));

      log("[2/9] sidebar visibility menu + at-least-one guard + storage");
      await openSidebarContextMenu(page);
      const menuEntries = await readContextMenuEntries(page);
      const expectedPrimary = [
        "ファイル",
        "検索",
        "アウトライン",
        "ブロック",
        "AI",
        "エラー",
        "プロジェクト",
      ];
      expectedPrimary.forEach((label) => {
        assert.ok(
          menuEntries.some((entry) => entry.plain === label),
          `sidebar context menu missing: ${label}`
        );
      });
      await page.keyboard.press("Escape");
      await waitForContextMenuOpen(page, false);

      await setSidebarTabVisible(page, "検索", false);
      await setSidebarTabVisible(page, "アウトライン", false);
      await setSidebarTabVisible(page, "ブロック", false);
      await setSidebarTabVisible(page, "AI", false);
      await setSidebarTabVisible(page, "エラー", false);
      await setSidebarTabVisible(page, "プロジェクト", false);
      const visibleOnlyFiles = await readVisiblePrimaryTabKeys(page);
      assert.deepEqual(visibleOnlyFiles, ["files"], "only files tab should remain visible");

      await openSidebarContextMenu(page);
      const onlyFilesEntries = await readContextMenuEntries(page);
      const filesEntry = onlyFilesEntries.find((entry) => entry.plain === "ファイル");
      assert.ok(filesEntry, "files entry should exist");
      assert.equal(filesEntry.disabled, true, "last visible tab should be non-hideable");
      await page.keyboard.press("Escape");
      await waitForContextMenuOpen(page, false);

      await setSidebarTabVisible(page, "検索", true);
      const storedTabs = await readSidebarStorage(page);
      assert.ok(Array.isArray(storedTabs), "sidebar visibility should be stored in localStorage");

      log("[3/9] sidebar resizer clamps to min/max");
      const viewportWidth = await page.evaluate(() => window.innerWidth);
      await dragHandleToX(page, "#resizer", 30);
      const minWidth = await readSidebarPanelWidth(page);
      assert.ok(minWidth >= 239, `sidebar width should clamp to min >= 240, got ${minWidth}`);

      await dragHandleToX(page, "#resizer", viewportWidth - 8);
      const maxWidthObserved = await readSidebarPanelWidth(page);
      const maxExpected = Math.max(240, viewportWidth - 52 - 320);
      assert.ok(
        maxWidthObserved <= maxExpected + 2,
        `sidebar width should clamp to max <= ${maxExpected}, got ${maxWidthObserved}`
      );

      log("[4/9] split on/off + ratio persist");
      await page.click("#editor-split-button");
      await page.waitForSelector('#editor-groups[data-split="true"]', { timeout: 10000 });
      const groupsRect = await page.locator("#editor-groups").boundingBox();
      assert.ok(groupsRect, "editor groups geometry should be available");
      const targetSplitX = groupsRect.x + groupsRect.width * 0.72;
      await dragHandleToX(page, "#editor-splitter", targetSplitX);
      storedSplitRatio = await page.evaluate(() => {
        const raw = localStorage.getItem("tex64.editorSplitRatio");
        const parsed = raw ? Number.parseFloat(raw) : Number.NaN;
        return Number.isFinite(parsed) ? parsed : null;
      });
      assert.ok(
        typeof storedSplitRatio === "number" && storedSplitRatio > 0.5 && storedSplitRatio < 0.9,
        `split ratio should be persisted to localStorage, got ${storedSplitRatio}`
      );
      await page.click("#editor-split-button");
      await page.waitForSelector('#editor-groups[data-split="false"]', { timeout: 10000 });

      await app.close();
      app = null;
    }

    log("[5/9] reopen + verify persisted sidebar/split state");
    {
      const relaunched = await launchApp({ userDataPath, workspacePath });
      app = relaunched.app;
      const page = relaunched.page;
      await waitForLauncherVisible(page);
      await page.keyboard.press("Enter");
      await waitForWorkspaceOpened(page, path.basename(workspacePath));

      await waitForCondition(
        async () =>
          page.$eval('button.tab[data-tab="outline"]', (node) =>
            node.classList.contains("is-hidden")
          ),
        10000,
        "outline tab hidden state should persist"
      );
      await page.click("#editor-split-button");
      await page.waitForSelector('#editor-groups[data-split="true"]', { timeout: 10000 });
      const restoredRatio = await readSplitRatio(page);
      assert.ok(typeof restoredRatio === "number", "restored split ratio should be readable");
      assert.ok(
        Math.abs(restoredRatio - storedSplitRatio) <= 0.08,
        `split ratio should restore close to stored value. expected=${storedSplitRatio}, actual=${restoredRatio}`
      );

      await setSidebarTabVisible(page, "検索", true);
      await setSidebarTabVisible(page, "アウトライン", true);
      await setSidebarTabVisible(page, "ブロック", true);
      await setSidebarTabVisible(page, "AI", true);
      await setSidebarTabVisible(page, "エラー", true);
      await setSidebarTabVisible(page, "プロジェクト", true);

      log("[6/9] tabs per group + drag&drop + close + existing-group reuse");
      await clickSideTab(page, "files");
      await ensureFolderOpen(page, "sections");
      await ensureFolderOpen(page, "assets");
      await ensureFolderOpen(page, "docs");

      await setActiveEditorGroup(page, "secondary");
      await clickFileTreePath(page, "notes.tex", "file");
      await waitForTabState(
        page,
        '#editor-tabs-list-secondary .editor-tab.is-active[data-path="notes.tex"]',
        true
      );

      await setActiveEditorGroup(page, "primary");
      await clickFileTreePath(page, "sections/intro.tex", "file");
      await waitForTabState(
        page,
        '#editor-tabs-list .editor-tab.is-active[data-path="sections/intro.tex"]',
        true
      );
      await clickFileTreePath(page, "sections/chapter.tex", "file");
      await waitForTabState(
        page,
        '#editor-tabs-list .editor-tab.is-active[data-path="sections/chapter.tex"]',
        true
      );

      await dragElementToElement(
        page,
        '#editor-tabs-list .editor-tab[data-path="sections/chapter.tex"]',
        "#editor-tabs-secondary"
      );
      await waitForTabState(
        page,
        '#editor-tabs-list .editor-tab[data-path="sections/chapter.tex"]',
        false
      );
      await waitForTabState(
        page,
        '#editor-tabs-list-secondary .editor-tab[data-path="sections/chapter.tex"]',
        true
      );

      await page.click(
        '#editor-tabs-list-secondary .editor-tab[data-path="sections/chapter.tex"] .editor-tab-close'
      );
      await waitForTabState(
        page,
        '#editor-tabs-list-secondary .editor-tab[data-path="sections/chapter.tex"]',
        false
      );

      await setActiveEditorGroup(page, "secondary");
      await clickFileTreePath(page, "sections/intro.tex", "file");
      await pause(120);
      const introTabs = await readTabCountByPath(page, "sections/intro.tex");
      assert.equal(introTabs.total, 1, "same file should be reused without duplicate tab");
      assert.equal(introTabs.primary, 1, "intro tab should remain in primary group");
      assert.equal(introTabs.secondary, 0, "intro tab should not duplicate into secondary group");

      log("[7/9] file-kind viewer behavior + dirty/autosave/beforeunload");
      await setActiveEditorGroup(page, "primary");
      await clickFileTreePath(page, "assets/pixel.png", "file");
      await waitForViewerMode(page, "#editor-viewer", "image", 10000);

      await clickFileTreePath(page, "binary.bin", "file");
      await waitForViewerMode(page, "#editor-viewer", "unsupported", 10000);
      const unsupportedText = await page.textContent("#editor-viewer-message");
      assert.ok(
        (unsupportedText ?? "").includes("非対応ファイル"),
        "unsupported viewer message should be shown"
      );

      await clickFileTreePath(page, "docs/sample.pdf", "file");
      await waitForCondition(
        async () => {
          const primaryPdf = await page.$eval(
            "#editor-viewer",
            (node) => node instanceof HTMLElement && node.dataset.view === "pdf"
          );
          if (primaryPdf) {
            return true;
          }
          return page.$eval(
            "#editor-viewer-secondary",
            (node) => node instanceof HTMLElement && node.dataset.view === "pdf"
          );
        },
        12000,
        "pdf viewer should be shown in one of editor groups"
      );

      await clickFileTreePath(page, "sections/intro.tex", "file");
      await page.click("#editor .monaco-editor", { position: { x: 120, y: 90 } });
      const autoSaveToken = `AUTO_${Date.now()}`;
      await page.keyboard.type(` ${autoSaveToken}`, { delay: 0 });
      await waitForTabDirtyState(
        page,
        '#editor-tabs-list .editor-tab[data-path="sections/intro.tex"]',
        true,
        8000
      );
      await waitForPathContains(path.join(workspacePath, "sections", "intro.tex"), autoSaveToken, 12000);
      await waitForTabDirtyState(
        page,
        '#editor-tabs-list .editor-tab[data-path="sections/intro.tex"]',
        false,
        12000
      );

      const explicitToken = `SAVE_${Date.now()}`;
      await page.keyboard.type(` ${explicitToken}`, { delay: 0 });
      await page.keyboard.press(`${modKey}+S`);
      await waitForPathContains(path.join(workspacePath, "sections", "intro.tex"), explicitToken, 12000);

      const unloadToken = `UNLOAD_${Date.now()}`;
      await page.keyboard.type(` ${unloadToken}`, { delay: 0 });
      const prevented = await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      });
      assert.equal(prevented, true, "beforeunload should be blocked when dirty exists");
      await page.keyboard.press(`${modKey}+S`);
      await waitForTabDirtyState(
        page,
        '#editor-tabs-list .editor-tab[data-path="sections/intro.tex"]',
        false,
        12000
      );

      log("[8/9] search/outline jump opens secondary without stealing primary focus");
      await clickSideTab(page, "search");
      await page.fill("#search-input", "NEEDLE_INTRO_123");
      await page.click("#search-button");
      await page.waitForSelector("#search-results .search-match-item", { timeout: 15000 });
      await setActiveEditorGroup(page, "primary");
      await page.click("#search-results .search-match-item");
      await waitForTabState(
        page,
        '#editor-tabs-list-secondary .editor-tab.is-active[data-path="sections/intro.tex"]',
        true,
        12000
      );
      await page.waitForSelector('#editor-groups[data-split="true"]', { timeout: 10000 });
      const primaryActiveAfterSearch = await page.$eval(
        '#editor-groups [data-editor-group="primary"]',
        (node) => node instanceof HTMLElement && node.classList.contains("is-active")
      );
      assert.equal(
        primaryActiveAfterSearch,
        true,
        "search jump should not steal active group from primary"
      );

      await clickSideTab(page, "outline");
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll("#outline-sections .outline-item")).some((node) =>
            (node.textContent ?? "").includes("Intro Section")
          ),
        undefined,
        { timeout: 15000 }
      );
      await setActiveEditorGroup(page, "primary");
      const clickedOutline = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll("#outline-sections .outline-item"));
        const target = items.find((node) => (node.textContent ?? "").includes("Intro Section"));
        if (!(target instanceof HTMLElement)) {
          return false;
        }
        target.click();
        return true;
      });
      assert.equal(clickedOutline, true, "outline target should exist");
      await waitForTabState(
        page,
        '#editor-tabs-list-secondary .editor-tab.is-active[data-path="sections/intro.tex"]',
        true,
        12000
      );
      const primaryActiveAfterOutline = await page.$eval(
        '#editor-groups [data-editor-group="primary"]',
        (node) => node instanceof HTMLElement && node.classList.contains("is-active")
      );
      assert.equal(
        primaryActiveAfterOutline,
        true,
        "outline jump should not steal active group from primary"
      );

      log("[9/9] issues jump opens in active group");
      await clickSideTab(page, "files");
      await setActiveEditorGroup(page, "secondary");
      await clickFileTreePath(page, "sections/issue.tex", "file");
      await waitForTabState(
        page,
        '#editor-tabs-list-secondary .editor-tab.is-active[data-path="sections/issue.tex"]',
        true,
        12000
      );
      await page.click("#editor-secondary .monaco-editor", { position: { x: 120, y: 90 } });
      const issueToken = `ISSUE_${Date.now()}`;
      await page.keyboard.type(`\n\\undefinedcommand${issueToken}\n`, { delay: 0 });
      await waitForPathContains(path.join(workspacePath, "sections", "issue.tex"), issueToken, 12000);

      await clickBuildAndWait(page);
      await clickSideTab(page, "issues");
      await page.waitForSelector("#issues-list .issue-item", { timeout: 20000 });
      await setActiveEditorGroup(page, "secondary");
      const clickedIssue = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll("#issues-list .issue-item"));
        const target = items.find((item) => {
          return item instanceof HTMLButtonElement && !item.disabled;
        });
        if (!(target instanceof HTMLButtonElement)) {
          return { ok: false, expectedLine: null };
        }
        const locationText = (target.querySelector(".issue-location")?.textContent ?? "").trim();
        const lineMatch = locationText.match(/:(\d+)(?::\d+)?$/);
        const expectedLine =
          lineMatch && lineMatch[1] ? Number.parseInt(lineMatch[1], 10) : null;
        target.click();
        return { ok: true, expectedLine };
      });
      assert.equal(clickedIssue.ok, true, "clickable issue row should exist");
      const groupStateAfterIssue = await page.evaluate(() => {
        const primary = document.querySelector('#editor-groups [data-editor-group="primary"]');
        const secondary = document.querySelector('#editor-groups [data-editor-group="secondary"]');
        const groups = document.getElementById("editor-groups");
        return {
          split: groups instanceof HTMLElement ? groups.dataset.split : null,
          primaryActive:
            primary instanceof HTMLElement ? primary.classList.contains("is-active") : false,
          secondaryActive:
            secondary instanceof HTMLElement ? secondary.classList.contains("is-active") : false,
        };
      });
      assert.equal(
        groupStateAfterIssue.secondaryActive,
        true,
        `issue jump should keep secondary active: ${JSON.stringify(groupStateAfterIssue)}`
      );
      if (typeof clickedIssue.expectedLine === "number" && Number.isFinite(clickedIssue.expectedLine)) {
        await waitForSecondaryCursorLine(page, clickedIssue.expectedLine, 12000);
      }

      await waitForCondition(
        async () =>
          page.$eval(
            "#editor-tabs-list .editor-tab.is-dirty, #editor-tabs-list-secondary .editor-tab.is-dirty",
            () => false
          ).catch(() => true),
        5000
      );

      log("editor layout + tabs e2e passed");
    }
  } finally {
    if (app) {
      await app.close().catch(() => {});
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
  console.error("[editor-layout-e2e] failed:", error);
  process.exitCode = 1;
});
