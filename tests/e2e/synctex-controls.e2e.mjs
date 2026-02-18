import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

const defaultFixtureWorkspace = path.join(
  repoRoot,
  "tests",
  "e2e",
  "fixtures",
  "synctex-precision"
);
const sourceWorkspace =
  process.env.E2E_SYNCTEX_SOURCE_WORKSPACE && process.env.E2E_SYNCTEX_SOURCE_WORKSPACE.trim()
    ? path.isAbsolute(process.env.E2E_SYNCTEX_SOURCE_WORKSPACE.trim())
      ? process.env.E2E_SYNCTEX_SOURCE_WORKSPACE.trim()
      : path.join(repoRoot, process.env.E2E_SYNCTEX_SOURCE_WORKSPACE.trim())
    : defaultFixtureWorkspace;

const keepWorkspace = process.env.E2E_KEEP_WORKSPACE === "1";
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "100", 10);
const modKey = process.platform === "darwin" ? "Meta" : "Control";

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => console.log(`[synctex-controls-e2e ${now()}] ${message}`);
const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const createWorkspaceCopy = async (workspaceSourcePath = sourceWorkspace) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-synctex-controls-"));
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(workspaceSourcePath, workspacePath, { recursive: true });
  return { tempDir, workspacePath };
};

const injectCommentLine = async (workspacePath) => {
  const mainPath = path.join(workspacePath, "main.tex");
  let content = await fs.readFile(mainPath, "utf8");
  if (!content.includes("% CH9_COMMENT_LINE")) {
    content = content.replace("\\maketitle\n\n", "\\maketitle\n% CH9_COMMENT_LINE\n\n");
    await fs.writeFile(mainPath, content, "utf8");
  }
};

const cleanupBuildArtifacts = async (workspacePath) => {
  const staleExtensions = new Set([
    ".aux",
    ".bbl",
    ".blg",
    ".fdb_latexmk",
    ".fls",
    ".lof",
    ".log",
    ".lot",
    ".nav",
    ".out",
    ".pdf",
    ".snm",
    ".synctex.gz",
    ".toc",
  ]);
  const skipDirs = new Set([".git", ".tex64", "node_modules", "build", "tmp"]);
  const stack = [workspacePath];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          stack.push(entryPath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!staleExtensions.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      await fs.rm(entryPath, { force: true });
    }
  }
};

const postToBridge = async (page, payload) => {
  await page.evaluate((value) => {
    window.tex64Bridge.postMessage(value);
  }, payload);
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector("body.is-ready", { timeout: 20000 });
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
    timeout: 30000,
  });
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
    if (!Array.isArray(window.__synctexControlsIncoming)) {
      window.__synctexControlsIncoming = [];
    }
    if (!Array.isArray(window.__synctexControlsOutgoing)) {
      window.__synctexControlsOutgoing = [];
    }
    if (!Array.isArray(window.__synctexControlsViewerMessages)) {
      window.__synctexControlsViewerMessages = [];
    }
    if (window.__synctexControlsIncomingInstalled !== true) {
      window.__synctexControlsIncomingInstalled = true;
      window.tex64Bridge.onMessage((message) => {
        const requestId =
          message?.payload && typeof message.payload === "object"
            ? message.payload.requestId
            : message?.requestId;
        window.__synctexControlsIncoming.push({
          type: message?.type ?? null,
          requestId: typeof requestId === "string" ? requestId : null,
          payload: message?.payload ?? null,
          at: Date.now(),
        });
      });
    }
    if (window.__synctexControlsOutgoingInstalled !== true) {
      window.__synctexControlsOutgoingInstalled = true;
      const bridge = window.tex64Bridge;
      if (bridge && typeof bridge.postMessage === "function") {
        const originalPostMessage = bridge.postMessage.bind(bridge);
        bridge.postMessage = (...args) => {
          const payload = args[0];
          const requestId =
            payload && typeof payload === "object" ? payload.requestId : null;
          window.__synctexControlsOutgoing.push({
            type: payload?.type ?? null,
            requestId: typeof requestId === "string" ? requestId : null,
            payload: payload ?? null,
            at: Date.now(),
          });
          return originalPostMessage(...args);
        };
      }
    }
    if (window.__synctexControlsViewerInstalled !== true) {
      window.__synctexControlsViewerInstalled = true;
      window.addEventListener("message", (event) => {
        const data = event?.data;
        if (!data || data.source !== "tex64-pdf") {
          return;
        }
        const payload = data.payload;
        window.__synctexControlsViewerMessages.push({
          type: payload?.type ?? null,
          payload: payload?.payload ?? null,
          at: Date.now(),
        });
      });
    }
  });
};

const clearIncomingMessages = async (page, type = null) => {
  await page.evaluate((expectedType) => {
    if (!Array.isArray(window.__synctexControlsIncoming)) {
      return;
    }
    if (!expectedType) {
      window.__synctexControlsIncoming.length = 0;
      return;
    }
    window.__synctexControlsIncoming = window.__synctexControlsIncoming.filter(
      (item) => item?.type !== expectedType
    );
  }, type);
};

const clearOutgoingMessages = async (page, type = null) => {
  await page.evaluate((expectedType) => {
    if (!Array.isArray(window.__synctexControlsOutgoing)) {
      return;
    }
    if (!expectedType) {
      window.__synctexControlsOutgoing.length = 0;
      return;
    }
    window.__synctexControlsOutgoing = window.__synctexControlsOutgoing.filter(
      (item) => item?.type !== expectedType
    );
  }, type);
};

const clearViewerMessages = async (page, type = null) => {
  await page.evaluate((expectedType) => {
    if (!Array.isArray(window.__synctexControlsViewerMessages)) {
      return;
    }
    if (!expectedType) {
      window.__synctexControlsViewerMessages.length = 0;
      return;
    }
    window.__synctexControlsViewerMessages = window.__synctexControlsViewerMessages.filter(
      (item) => item?.type !== expectedType
    );
  }, type);
};

const waitForMessage = async ({
  page,
  channel,
  type,
  timeoutMs = 20000,
  predicate = () => true,
}) => {
  const sourceKey =
    channel === "incoming"
      ? "incoming"
      : channel === "outgoing"
      ? "outgoing"
      : "viewer";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const item = await page.evaluate(
      ({ key, expectedType }) => {
        const source =
          key === "incoming"
            ? window.__synctexControlsIncoming
            : key === "outgoing"
            ? window.__synctexControlsOutgoing
            : window.__synctexControlsViewerMessages;
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
      { key: sourceKey, expectedType: type }
    );
    if (item && predicate(item)) {
      return item;
    }
    await page.waitForTimeout(20);
  }
  throw new Error(`Timed out waiting for ${channel} message: ${type}`);
};

const getMessageCount = async (page, channel, type) => {
  const sourceKey =
    channel === "incoming"
      ? "incoming"
      : channel === "outgoing"
      ? "outgoing"
      : "viewer";
  return page.evaluate(
    ({ key, expectedType }) => {
      const source =
        key === "incoming"
          ? window.__synctexControlsIncoming
          : key === "outgoing"
          ? window.__synctexControlsOutgoing
          : window.__synctexControlsViewerMessages;
      if (!Array.isArray(source)) {
        return 0;
      }
      return source.filter((item) => item?.type === expectedType).length;
    },
    { key: sourceKey, expectedType: type }
  );
};

const clickSideTab = async (page, key) => {
  await page.click(`button.tab[data-tab="${key}"]`);
  await page.waitForSelector(`.sidebar-panel .panel.is-active[data-panel="${key}"]`, {
    timeout: 10000,
  });
};

const openBuildSettingsPage = async (page) => {
  await clickSideTab(page, "settings");
  await page.evaluate(() => {
    const button = document.querySelector(
      '#settings-nav .settings-nav-item[data-settings-target="build"]'
    );
    if (button instanceof HTMLButtonElement) {
      button.click();
    }
  });
  await page.waitForSelector(
    '#settings-pages .settings-page.is-active[data-settings-page="build"]',
    { timeout: 10000 }
  );
};

const setCheckbox = async (page, id, expectedChecked) => {
  const changed = await page.evaluate(
    ({ targetId, nextChecked }) => {
      const input = document.getElementById(targetId);
      if (!(input instanceof HTMLInputElement)) {
        return false;
      }
      if (input.checked !== nextChecked) {
        input.click();
      }
      return input.checked === nextChecked;
    },
    { targetId: id, nextChecked: expectedChecked }
  );
  assert.ok(changed, `failed to set checkbox: ${id}`);
};

const setPdfViewerMode = async (page, mode) => {
  const shouldWindow = mode === "window";
  await openBuildSettingsPage(page);
  await setCheckbox(page, "editor-pdf-window", shouldWindow);
  await pause(120);
};

const setAutoSynctexOnBuild = async (page, enabled) => {
  await openBuildSettingsPage(page);
  await setCheckbox(page, "editor-auto-synctex-build", enabled);
  await pause(120);
};

const setReverseSynctex = async (page, enabled) => {
  await openBuildSettingsPage(page);
  await setCheckbox(page, "editor-reverse-synctex", enabled);
  await pause(120);
};

const ensureFolderOpen = async (page, relativePath) => {
  const detailsSelector = `#file-tree details.file-folder[data-path="${relativePath}"]`;
  await page.waitForSelector(detailsSelector, { timeout: 12000 });
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
    { timeout: 10000 }
  );
};

const ensureFolderPathOpen = async (page, relativePath) => {
  const segments = relativePath.split("/").filter(Boolean);
  let cursor = "";
  for (const segment of segments) {
    cursor = cursor ? `${cursor}/${segment}` : segment;
    await ensureFolderOpen(page, cursor);
  }
};

const clickFileTreeFile = async (page, relativePath) => {
  const selector = `#file-tree button.file-item[data-path="${relativePath}"]`;
  await page.waitForSelector(selector, { timeout: 12000 });
  await page.click(selector);
  await page.waitForSelector(`#editor-tabs-list .editor-tab.is-active[data-path="${relativePath}"]`, {
    timeout: 12000,
  });
};

const setEditorCursor = async (page, lineNumber, column = 1) => {
  const ok = await page.evaluate(
    ({ line, col }) => {
      const editors = window.monaco?.editor?.getEditors?.() ?? [];
      const focused =
        editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
        editors[0];
      const model = focused?.getModel?.();
      if (!focused || !model) {
        return false;
      }
      const clampedLine = Math.min(Math.max(1, line), model.getLineCount());
      const maxColumn = model.getLineMaxColumn(clampedLine);
      const clampedColumn = Math.min(Math.max(1, col), maxColumn);
      focused.setPosition({ lineNumber: clampedLine, column: clampedColumn });
      focused.revealPositionInCenterIfOutsideViewport?.({
        lineNumber: clampedLine,
        column: clampedColumn,
      });
      focused.focus();
      return true;
    },
    { line: lineNumber, col: column }
  );
  assert.equal(ok, true, "failed to set editor cursor");
};

const clickSynctexButton = async (page) => {
  await page.waitForSelector("#synctex-button", { timeout: 10000 });
  await page.click("#synctex-button");
};

const dispatchDeepLink = async (page, { targetPath, line, column = 1 }) => {
  await page.evaluate(
    ({ pathValue, lineValue, columnValue }) => {
      const anchor = document.createElement("a");
      anchor.href = `tex64://view-on-pdf?path=${encodeURIComponent(pathValue)}&line=${lineValue}&column=${columnValue}`;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    },
    { pathValue: targetPath, lineValue: line, columnValue: column }
  );
};

const dispatchDeepLinksRapidly = async (page, links) => {
  await page.evaluate((items) => {
    items.forEach((item) => {
      const anchor = document.createElement("a");
      anchor.href = `tex64://view-on-pdf?path=${encodeURIComponent(item.path)}&line=${item.line}&column=${item.column}`;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    });
  }, links);
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
    return isVisible("editor-viewer-pdf-secondary")
      ? "#editor-viewer-pdf-secondary"
      : "#editor-viewer-pdf";
  });
  const frame = await (await page.$(selector))?.contentFrame();
  if (!frame) {
    throw new Error("tab pdf viewer frame not found");
  }
  return frame;
};

const waitForViewerLoaded = async (targetPage, timeout = 30000) => {
  await targetPage.waitForFunction(
    () => {
      const state = window.__tex64PdfViewer?.state;
      return (
        Boolean(state?.doc) &&
        Number.isFinite(state?.pageCount) &&
        state.pageCount > 0 &&
        typeof state.path === "string"
      );
    },
    undefined,
    { timeout }
  );
};

const waitViewerSynced = async (targetPage, forwardPayload, timeout = 25000) => {
  await targetPage.waitForFunction(
    (payload) => {
      const state = window.__tex64PdfViewer?.state;
      if (!state || !state.lastSync) {
        return false;
      }
      const last = state.lastSync;
      if (!Number.isFinite(last.page) || !Number.isFinite(payload.page)) {
        return false;
      }
      if (last.page !== payload.page) {
        return false;
      }
      const dx = Math.abs(Number(last.x) - Number(payload.x));
      const dy = Math.abs(Number(last.y) - Number(payload.y));
      return dx < 0.5 && dy < 0.5;
    },
    {
      page: forwardPayload?.page ?? Number.NaN,
      x: forwardPayload?.x ?? Number.NaN,
      y: forwardPayload?.y ?? Number.NaN,
    },
    { timeout }
  );
};

const triggerReverseFromMarker = async (targetPage) => {
  return targetPage.evaluate(() => {
    const marker = document.querySelector(".pdf-sync-marker");
    if (!(marker instanceof HTMLElement)) {
      return { ok: false, reason: "marker-missing" };
    }
    const rect = marker.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const target = document.elementFromPoint(centerX, centerY);
    if (!(target instanceof Element)) {
      return { ok: false, reason: "target-missing" };
    }
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: centerX,
      clientY: centerY,
      button: 0,
      buttons: 1,
      metaKey: true,
      ctrlKey: true,
    });
    target.dispatchEvent(event);
    return { ok: true };
  });
};

const triggerReverseAtPageRatio = async (targetPage, xRatio, yRatio) => {
  return targetPage.evaluate(
    ({ x, y }) => {
      const pageEl = document.querySelector("#pdf-pages .page");
      if (!(pageEl instanceof HTMLElement)) {
        return { ok: false, reason: "page-missing" };
      }
      const rect = pageEl.getBoundingClientRect();
      const clickX = rect.left + rect.width * x;
      const clickY = rect.top + rect.height * y;
      const target = document.elementFromPoint(clickX, clickY);
      if (!(target instanceof Element)) {
        return { ok: false, reason: "target-missing" };
      }
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: clickX,
        clientY: clickY,
        button: 0,
        buttons: 1,
        metaKey: true,
        ctrlKey: true,
      });
      target.dispatchEvent(event);
      return { ok: true };
    },
    { x: xRatio, y: yRatio }
  );
};

const clickViewerPageForReverse = async (targetPage, xRatio, yRatio) => {
  const point = await targetPage.evaluate(
    ({ x, y }) => {
      const pageEl = document.querySelector("#pdf-pages .page");
      if (!(pageEl instanceof HTMLElement)) {
        return null;
      }
      const rect = pageEl.getBoundingClientRect();
      return {
        x: Math.min(Math.max(18, rect.width * x), Math.max(18, rect.width - 18)),
        y: Math.min(Math.max(18, rect.height * y), Math.max(18, rect.height - 18)),
      };
    },
    { x: xRatio, y: yRatio }
  );
  assert.ok(point, "reverse click point not found");
  await targetPage.click("#pdf-pages .page", {
    position: point,
    modifiers: [modKey],
  });
  return point;
};

const readEditorState = async (page) => {
  return page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const focused =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0] ?? null;
    const model = focused?.getModel?.();
    const position = focused?.getPosition?.();
    const modelPath = model?.uri?.path ?? model?.uri?.fsPath ?? "";
    const activeTab = document.querySelector("#editor-tabs-list .editor-tab.is-active");
    return {
      modelPath,
      line: Number(position?.lineNumber) || null,
      column: Number(position?.column) || null,
      activeTabPath: activeTab instanceof HTMLElement ? activeTab.dataset.path ?? null : null,
    };
  });
};

const readIssuesState = async (page) => {
  return page.evaluate(() => {
    const list = document.getElementById("issues-list");
    const tab = document.getElementById("issues-tab");
    const messages =
      list instanceof HTMLElement
        ? Array.from(list.querySelectorAll(".issue-message")).map((node) =>
            (node.textContent ?? "").trim()
          )
        : [];
    return {
      issueCount: messages.filter(Boolean).length,
      messages,
      tabAlert: tab instanceof HTMLElement ? tab.classList.contains("is-alert") : false,
    };
  });
};

const run = async () => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  let electronApp;

  try {
    await injectCommentLine(workspacePath);
    await cleanupBuildArtifacts(workspacePath);

    electronApp = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      env: { ...process.env },
    });

    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1680, height: 980 });

    await initCollectors(page);
    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);

    await setPdfViewerMode(page, "tab");
    await setAutoSynctexOnBuild(page, false);
    await setReverseSynctex(page, true);
    await clickSideTab(page, "files");

    log("[1/10] baseline build");
    await page.click("#build-button");
    await waitForBuildIdle(page);

    log("[2/10] manual SyncTeX button trigger");
    await clickSideTab(page, "files");
    await clickFileTreeFile(page, "main.tex");
    await setEditorCursor(page, 12, 1);
    await clearIncomingMessages(page, "synctex:forwardResult");
    await clickSynctexButton(page);
    const manualForwardResult = await waitForMessage({
      page,
      channel: "incoming",
      type: "synctex:forwardResult",
      timeoutMs: 30000,
      predicate: (message) =>
        message?.payload?.ok === true && typeof message?.requestId === "string",
    });
    assert.equal(manualForwardResult?.payload?.ok, true, "manual forward should succeed");
    assert.ok(
      typeof manualForwardResult?.requestId === "string",
      "manual forward should carry requestId"
    );

    log("[3/10] short cache hit on repeated manual SyncTeX");
    await clearIncomingMessages(page, "synctex:forwardResult");
    await clickSynctexButton(page);
    const cachedForwardResult = await waitForMessage({
      page,
      channel: "incoming",
      type: "synctex:forwardResult",
      timeoutMs: 30000,
      predicate: (message) =>
        message?.payload?.ok === true && typeof message?.requestId === "string",
    });
    assert.equal(cachedForwardResult?.payload?.ok, true, "cached forward should succeed");
    assert.equal(cachedForwardResult?.payload?.cached, true, "expected cached forward result");

    log("[4/10] in-flight duplicate suppression on rapid button clicks");
    await clearIncomingMessages(page, "synctex:forwardResult");
    await page.evaluate(() => {
      const button = document.getElementById("synctex-button");
      if (!(button instanceof HTMLButtonElement)) {
        return;
      }
      for (let index = 0; index < 5; index += 1) {
        button.click();
      }
    });
    const dedupResult = await waitForMessage({
      page,
      channel: "incoming",
      type: "synctex:forwardResult",
      timeoutMs: 30000,
      predicate: (message) => message?.payload?.ok === true,
    });
    assert.equal(dedupResult?.payload?.ok, true, "dedup forward should complete");
    await pause(250);
    const dedupExtraCount = await getMessageCount(page, "incoming", "synctex:forwardResult");
    assert.equal(dedupExtraCount, 0, "duplicate in-flight forwards should be suppressed");

    log("[5/10] comment-line assist fallback");
    await clickFileTreeFile(page, "main.tex");
    await setEditorCursor(page, 9, 1);
    await clearIncomingMessages(page, "synctex:forwardResult");
    await clickSynctexButton(page);
    const commentForwardResult = await waitForMessage({
      page,
      channel: "incoming",
      type: "synctex:forwardResult",
      timeoutMs: 30000,
      predicate: (message) =>
        message?.payload?.ok === true &&
        typeof message?.requestId === "string" &&
        message?.payload?.fallback === true,
    });
    assert.equal(commentForwardResult?.payload?.ok, true, "comment-line forward should succeed");
    assert.equal(
      commentForwardResult?.payload?.fallback,
      true,
      "comment-line forward should use fallback assist"
    );

    log("[6/10] deep link trigger (tex64://view-on-pdf)");
    await clearIncomingMessages(page, "synctex:forwardResult");
    await dispatchDeepLink(page, { targetPath: "main.tex", line: 12, column: 1 });
    const deepLinkResult = await waitForMessage({
      page,
      channel: "incoming",
      type: "synctex:forwardResult",
      timeoutMs: 30000,
      predicate: (message) =>
        message?.payload?.ok === true &&
        (message?.requestId === null || typeof message?.requestId === "undefined"),
    });
    assert.equal(deepLinkResult?.payload?.ok, true, "deep-link forward should succeed");
    assert.equal(
      deepLinkResult?.requestId ?? null,
      null,
      "deep-link forward result should not include requestId"
    );

    log("[7/10] stale forward discard on rapid deep links");
    await clearIncomingMessages(page, "synctex:forwardResult");
    await dispatchDeepLinksRapidly(page, [
      { path: "main.tex", line: 9, column: 1 },
      { path: "main.tex", line: 16, column: 1 },
    ]);
    const rapidResult = await waitForMessage({
      page,
      channel: "incoming",
      type: "synctex:forwardResult",
      timeoutMs: 30000,
      predicate: (message) =>
        message?.payload?.ok === true &&
        (message?.requestId === null || typeof message?.requestId === "undefined"),
    });
    assert.equal(rapidResult?.payload?.ok, true, "latest rapid deep-link forward should succeed");
    await pause(1400);
    const staleExtraCount = await getMessageCount(page, "incoming", "synctex:forwardResult");
    assert.equal(staleExtraCount, 0, "stale forward results should be discarded");

    log("[8/10] auto-forward after build success");
    await setAutoSynctexOnBuild(page, true);
    await clearIncomingMessages(page, "synctex:forwardResult");
    await page.click("#build-button");
    await waitForBuildIdle(page);
    const autoForwardResult = await waitForMessage({
      page,
      channel: "incoming",
      type: "synctex:forwardResult",
      timeoutMs: 30000,
      predicate: (message) =>
        message?.payload?.ok === true && typeof message?.requestId === "string",
    });
    assert.equal(autoForwardResult?.payload?.ok, true, "auto-build forward should succeed");
    await setAutoSynctexOnBuild(page, false);

    log("[9/10] reverse success and reverse toggle OFF behavior");
    await clickSideTab(page, "files");
    await clickFileTreeFile(page, "main.tex");
    await setEditorCursor(page, 12, 1);
    await clearIncomingMessages(page, "synctex:forwardResult");
    await clickSynctexButton(page);
    const reversePrepResultEnvelope = await waitForMessage({
      page,
      channel: "incoming",
      type: "synctex:forwardResult",
      timeoutMs: 30000,
      predicate: (message) => message?.payload?.ok === true,
    });
    const reversePrepResult = reversePrepResultEnvelope?.payload ?? null;
    assert.equal(reversePrepResult?.ok, true, "reverse prep forward should succeed");

    const viewerFrame = await getVisibleTabViewerFrame(page);
    await waitForViewerLoaded(viewerFrame);
    await waitViewerSynced(viewerFrame, reversePrepResult);
    await viewerFrame.waitForSelector(".pdf-sync-marker", { timeout: 15000 });

    await clearViewerMessages(page, "reverse");
    await clearIncomingMessages(page, "synctex:reverseResult");
    await clickViewerPageForReverse(viewerFrame, 0.35, 0.25);

    const reverseResult = await waitForMessage({
      page,
      channel: "incoming",
      type: "synctex:reverseResult",
      timeoutMs: 30000,
      predicate: (message) => message?.payload?.ok === true,
    });
    assert.equal(reverseResult?.payload?.ok, true, "reverse should succeed");
    const expectedPath = String(reverseResult?.payload?.path ?? "");
    const expectedLine = Number(reverseResult?.payload?.line ?? Number.NaN);
    await page.waitForFunction(
      ({ pathValue, lineValue }) => {
        const normalize = (value) => String(value ?? "").replace(/\\\\/g, "/");
        const activeTab = document.querySelector("#editor-tabs-list .editor-tab.is-active");
        const activePath = activeTab instanceof HTMLElement ? activeTab.dataset.path ?? "" : "";
        if (normalize(activePath) !== normalize(pathValue)) {
          return false;
        }
        const editors = window.monaco?.editor?.getEditors?.() ?? [];
        const focused =
          editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
          editors[0];
        const position = focused?.getPosition?.();
        if (!position || !Number.isFinite(Number(position.lineNumber))) {
          return false;
        }
        const lineDiff = Math.abs(Number(position.lineNumber) - Number(lineValue));
        return lineDiff <= 2;
      },
      { pathValue: expectedPath, lineValue: expectedLine },
      { timeout: 10000 }
    );

    await setReverseSynctex(page, false);
    await clickSideTab(page, "files");
    await clearViewerMessages(page, "reverse");
    await clearIncomingMessages(page, "synctex:reverseResult");
    await clickViewerPageForReverse(viewerFrame, 0.35, 0.25);
    await pause(1200);
    const reverseOffResult = await getMessageCount(page, "incoming", "synctex:reverseResult");
    assert.equal(reverseOffResult, 0, "reverse result must not arrive when reverse toggle is OFF");

    log("[10/10] reverse failure should surface in Issues");
    await setReverseSynctex(page, true);
    await fs.rm(path.join(workspacePath, "main.synctex.gz"), { force: true });
    await fs.rm(path.join(workspacePath, "main.pdf"), { force: true });
    await pause(80);
    await clearViewerMessages(page, "reverse");
    await clearIncomingMessages(page, "synctex:reverseResult");
    await clickViewerPageForReverse(viewerFrame, 0.92, 0.92);
    const reverseFailureResult = await waitForMessage({
      page,
      channel: "incoming",
      type: "synctex:reverseResult",
      timeoutMs: 30000,
      predicate: (message) => message?.payload?.ok === false,
    });
    assert.equal(reverseFailureResult?.payload?.ok, false, "reverse failure should return ok=false");
    const expectedFailureText =
      typeof reverseFailureResult?.payload?.error === "string"
        ? reverseFailureResult.payload.error.trim()
        : "";

    await page.waitForFunction(
      (expectedText) => {
        const list = document.getElementById("issues-list");
        if (!(list instanceof HTMLElement)) {
          return false;
        }
        const texts = Array.from(list.querySelectorAll(".issue-message")).map((node) =>
          (node.textContent ?? "").trim()
        );
        if (!expectedText) {
          return texts.length > 0;
        }
        return texts.some((text) => text.includes(expectedText));
      },
      expectedFailureText,
      { timeout: 10000 }
    );
    const issuesState = await readIssuesState(page);
    assert.ok(issuesState.issueCount > 0, "reverse failure should populate issues");

    const finalEditorState = await readEditorState(page);
    assert.ok(finalEditorState, "final editor state should be readable");

    log("chapter 9 synctex controls e2e completed");
  } finally {
    if (electronApp) {
      await electronApp.close().catch(() => {});
    }
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true });
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
