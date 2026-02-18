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
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "80", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "35", 10);
const modKey = process.platform === "darwin" ? "Meta" : "Control";
const selectAllKey = process.platform === "darwin" ? "Meta+A" : "Control+A";

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => console.log(`[viewer-ops-e2e ${now()}] ${message}`);

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const toPosix = (value) => value.split(path.sep).join("/");

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-viewer-ops-"));
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
  await page.setViewportSize({ width: 1680, height: 980 });
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
  await page.waitForSelector("#file-tree", { timeout: 20000 });
};

const clickSideTab = async (page, key) => {
  await page.click(`button.tab[data-tab="${key}"]`);
  await page.waitForSelector(`.sidebar-panel .panel.is-active[data-panel="${key}"]`, {
    timeout: 10000,
  });
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
};

const waitForAnyViewerMode = async (page, mode, timeout = 12000) => {
  await page.waitForFunction(
    (expectedMode) => {
      const matches = (id) => {
        const node = document.getElementById(id);
        return (
          node instanceof HTMLElement &&
          node.classList.contains("is-visible") &&
          node.dataset.view === expectedMode
        );
      };
      return matches("editor-viewer") || matches("editor-viewer-secondary");
    },
    mode,
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

const closeAuxWindows = async (app, mainPage) => {
  for (const win of app.windows()) {
    if (win !== mainPage) {
      await win.close().catch(() => {});
    }
  }
};

const setPdfViewerModeViaSettings = async (page, mode) => {
  const shouldWindow = mode === "window";
  await clickSideTab(page, "settings");
  await page.evaluate(() => {
    const button = document.querySelector(
      '#settings-nav .settings-nav-item[data-settings-target="build"]'
    );
    if (button instanceof HTMLButtonElement) {
      button.click();
    }
  });
  await page.waitForSelector('#settings-pages .settings-page.is-active[data-settings-page="build"]', {
    timeout: 10000,
  });
  await page.waitForSelector("#editor-pdf-window", { timeout: 10000 });
  const current = await page.isChecked("#editor-pdf-window");
  if (current !== shouldWindow) {
    await page.click('label[for="editor-pdf-window"]');
  }
  await page.waitForFunction(
    ({ checked, key, value }) => {
      const input = document.getElementById("editor-pdf-window");
      if (!(input instanceof HTMLInputElement) || input.checked !== checked) {
        return false;
      }
      return localStorage.getItem(key) === value;
    },
    {
      checked: shouldWindow,
      key: "tex64.editor.pdfViewerMode",
      value: shouldWindow ? "window" : "tab",
    },
    { timeout: 10000 }
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

const installMainCollectors = async (page) => {
  await page.evaluate(() => {
    if (!Array.isArray(window.__viewerOpsBridgeMessages)) {
      window.__viewerOpsBridgeMessages = [];
    }
    if (!Array.isArray(window.__viewerOpsWindowMessages)) {
      window.__viewerOpsWindowMessages = [];
    }
    if (window.__viewerOpsCollectorsInstalled === true) {
      return;
    }
    window.__viewerOpsCollectorsInstalled = true;
    window.tex64Bridge.onMessage((message) => {
      let snapshot = null;
      try {
        snapshot = JSON.parse(JSON.stringify(message));
      } catch {
        snapshot = { type: "__unserializable" };
      }
      window.__viewerOpsBridgeMessages.push(snapshot);
    });
    window.addEventListener("message", (event) => {
      const data = event?.data;
      if (!data || data.source !== "tex64-pdf") {
        return;
      }
      const payload = data.payload;
      window.__viewerOpsWindowMessages.push({
        source: data.source,
        type: payload?.type ?? null,
        payload: payload?.payload ?? null,
        at: Date.now(),
      });
    });
  });
};

const clearMainBridgeMessages = async (page, type = null) => {
  await page.evaluate((targetType) => {
    if (!Array.isArray(window.__viewerOpsBridgeMessages)) {
      return;
    }
    if (!targetType) {
      window.__viewerOpsBridgeMessages.length = 0;
      return;
    }
    window.__viewerOpsBridgeMessages = window.__viewerOpsBridgeMessages.filter(
      (item) => item?.type !== targetType
    );
  }, type);
};

const clearMainWindowMessages = async (page, type = null) => {
  await page.evaluate((targetType) => {
    if (!Array.isArray(window.__viewerOpsWindowMessages)) {
      return;
    }
    if (!targetType) {
      window.__viewerOpsWindowMessages.length = 0;
      return;
    }
    window.__viewerOpsWindowMessages = window.__viewerOpsWindowMessages.filter(
      (item) => item?.type !== targetType
    );
  }, type);
};

const pullBridgeMessage = async (page, type = null) =>
  page.evaluate((expectedType) => {
    const messages = window.__viewerOpsBridgeMessages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return null;
    }
    const index =
      expectedType && typeof expectedType === "string"
        ? messages.findIndex((item) => item?.type === expectedType)
        : 0;
    if (index < 0) {
      return null;
    }
    const item = messages[index];
    messages.splice(index, 1);
    return item;
  }, type);

const pullWindowMessage = async (page, type = null) =>
  page.evaluate((expectedType) => {
    const messages = window.__viewerOpsWindowMessages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return null;
    }
    const index =
      expectedType && typeof expectedType === "string"
        ? messages.findIndex((item) => item?.type === expectedType)
        : 0;
    if (index < 0) {
      return null;
    }
    const item = messages[index];
    messages.splice(index, 1);
    return item;
  }, type);

const waitForMessage = async (
  puller,
  type,
  timeoutMs,
  predicate = () => true,
  label = "message"
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await puller(type);
    if (message && predicate(message)) {
      return message;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}: ${type ?? "any"}`);
};

const installFrameInboundCollector = async (frame) => {
  await frame.evaluate(() => {
    if (!Array.isArray(window.__viewerOpsInboundMessages)) {
      window.__viewerOpsInboundMessages = [];
    }
    if (window.__viewerOpsInboundInstalled === true) {
      return;
    }
    window.__viewerOpsInboundInstalled = true;
    window.addEventListener("message", (event) => {
      const data = event?.data;
      if (!data || data.source !== "tex64-pdf") {
        return;
      }
      const payload = data.payload;
      window.__viewerOpsInboundMessages.push({
        source: data.source,
        type: payload?.type ?? null,
        payload: payload?.payload ?? null,
        at: Date.now(),
      });
    });
  });
};

const clearFrameInboundMessages = async (frame, type = null) => {
  await frame.evaluate((targetType) => {
    if (!Array.isArray(window.__viewerOpsInboundMessages)) {
      return;
    }
    if (!targetType) {
      window.__viewerOpsInboundMessages.length = 0;
      return;
    }
    window.__viewerOpsInboundMessages = window.__viewerOpsInboundMessages.filter(
      (item) => item?.type !== targetType
    );
  }, type);
};

const pullFrameInboundMessage = async (frame, type = null) =>
  frame.evaluate((expectedType) => {
    const messages = window.__viewerOpsInboundMessages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return null;
    }
    const index =
      expectedType && typeof expectedType === "string"
        ? messages.findIndex((item) => item?.type === expectedType)
        : 0;
    if (index < 0) {
      return null;
    }
    const item = messages[index];
    messages.splice(index, 1);
    return item;
  }, type);

const setEditorCursor = async (page, lineNumber, column = 1) => {
  const ok = await page.evaluate(
    ({ line, col }) => {
      const editors = window.monaco?.editor?.getEditors?.() ?? [];
      const primary = editors.find((editor) => {
        const node = typeof editor.getDomNode === "function" ? editor.getDomNode() : null;
        return node && node.closest('[data-editor-group="primary"]');
      });
      const editor = primary ?? editors[0];
      const model = editor?.getModel?.();
      if (!editor || !model) {
        return false;
      }
      const clampedLine = Math.min(Math.max(1, line), model.getLineCount());
      const maxColumn = model.getLineMaxColumn(clampedLine);
      const clampedColumn = Math.min(Math.max(1, col), maxColumn);
      editor.setPosition({ lineNumber: clampedLine, column: clampedColumn });
      editor.revealPositionInCenterIfOutsideViewport?.({
        lineNumber: clampedLine,
        column: clampedColumn,
      });
      editor.focus();
      return true;
    },
    { line: lineNumber, col: column }
  );
  assert.equal(ok, true, "failed to set editor cursor");
};

const triggerSyncAndWaitForward = async (page) => {
  await clearMainBridgeMessages(page, "synctex:forwardResult");
  await page.click("#synctex-button");
  const envelope = await waitForMessage(
    (type) => pullBridgeMessage(page, type),
    "synctex:forwardResult",
    30000,
    (message) => message?.payload?.ok === true,
    "bridge"
  );
  return envelope.payload;
};

const ensureSidebarVisible = async (frame) => {
  const visible = await frame.evaluate(() => {
    const sidebar = document.getElementById("pdf-sidebar");
    return sidebar instanceof HTMLElement && !sidebar.classList.contains("is-hidden");
  });
  if (!visible) {
    await frame.click("#pdf-sidebar-toggle");
  }
  await frame.waitForFunction(
    () => {
      const sidebar = document.getElementById("pdf-sidebar");
      return sidebar instanceof HTMLElement && !sidebar.classList.contains("is-hidden");
    },
    undefined,
    { timeout: 8000 }
  );
};

const verifyViewerControls = async (frame) => {
  await frame.waitForSelector("#pdf-page-input", { timeout: 20000 });
  const pageCount = await frame.evaluate(() => window.__tex64PdfViewer?.state?.pageCount ?? 0);
  assert.ok(pageCount >= 1, `invalid page count: ${pageCount}`);

  if (pageCount >= 2) {
    await frame.click("#pdf-page-input");
    await frame.press("#pdf-page-input", selectAllKey);
    await frame.type("#pdf-page-input", "1");
    await frame.press("#pdf-page-input", "Tab");
    await frame.waitForFunction(
      () => window.__tex64PdfViewer?.pdfViewer?.currentPageNumber === 1,
      undefined,
      { timeout: 12000 }
    );

    await frame.click("#pdf-next");
    await frame.waitForFunction(
      () => window.__tex64PdfViewer?.pdfViewer?.currentPageNumber === 2,
      undefined,
      { timeout: 12000 }
    );
    await frame.click("#pdf-prev");
    await frame.waitForFunction(
      () => window.__tex64PdfViewer?.pdfViewer?.currentPageNumber === 1,
      undefined,
      { timeout: 12000 }
    );
    await frame.click("#pdf-page-input");
    await frame.press("#pdf-page-input", selectAllKey);
    await frame.type("#pdf-page-input", "2");
    await frame.press("#pdf-page-input", "Tab");
    await frame.waitForFunction(
      () => window.__tex64PdfViewer?.pdfViewer?.currentPageNumber === 2,
      undefined,
      { timeout: 12000 }
    );
  }

  const readScale = async () =>
    frame.evaluate(
      () => window.__tex64PdfViewer?.pdfViewer?.currentScale ?? window.__tex64PdfViewer?.state?.scale ?? 0
    );

  const zoomBefore = await readScale();
  await frame.click("#pdf-zoom-in");
  await frame.waitForFunction(
    (before) => {
      const current = window.__tex64PdfViewer?.pdfViewer?.currentScale ?? 0;
      return Number.isFinite(current) && current > before + 0.01;
    },
    zoomBefore,
    { timeout: 12000 }
  );
  const zoomAfterIn = await readScale();
  await frame.click("#pdf-zoom-out");
  await frame.waitForFunction(
    (before) => {
      const current = window.__tex64PdfViewer?.pdfViewer?.currentScale ?? 0;
      return Number.isFinite(current) && current < before - 0.01;
    },
    zoomAfterIn,
    { timeout: 12000 }
  );

  const wheelScaleBefore = await readScale();
  await frame.evaluate(() => {
    const scroll = document.getElementById("pdf-scroll");
    if (!(scroll instanceof HTMLElement)) {
      return;
    }
    const rect = scroll.getBoundingClientRect();
    scroll.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: -180,
        ctrlKey: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      })
    );
  });
  await frame.waitForFunction(
    (before) => {
      const current = window.__tex64PdfViewer?.pdfViewer?.currentScale ?? 0;
      return Number.isFinite(current) && Math.abs(current - before) > 0.01;
    },
    wheelScaleBefore,
    { timeout: 12000 }
  );

  const pinchScaleBefore = await readScale();
  await frame.evaluate(() => {
    const scroll = document.getElementById("pdf-scroll");
    if (!(scroll instanceof HTMLElement)) {
      return;
    }
    const dispatchTouch = (type, touches) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", {
        configurable: true,
        value: touches,
      });
      scroll.dispatchEvent(event);
    };
    dispatchTouch("touchstart", [
      { clientX: 120, clientY: 120 },
      { clientX: 220, clientY: 120 },
    ]);
    dispatchTouch("touchmove", [
      { clientX: 110, clientY: 120 },
      { clientX: 280, clientY: 120 },
    ]);
    dispatchTouch("touchend", []);
  });
  await frame.waitForFunction(
    (before) => {
      const current = window.__tex64PdfViewer?.pdfViewer?.currentScale ?? 0;
      return Number.isFinite(current) && Math.abs(current - before) > 0.01;
    },
    pinchScaleBefore,
    { timeout: 12000 }
  );

  await frame.click("#pdf-fit-width");
  await frame.waitForFunction(
    () => window.__tex64PdfViewer?.state?.scaleMode === "fit-width",
    undefined,
    { timeout: 10000 }
  );
  await frame.click("#pdf-fit-page");
  await frame.waitForFunction(
    () => window.__tex64PdfViewer?.state?.scaleMode === "fit-page",
    undefined,
    { timeout: 10000 }
  );

  const rotationBefore = await frame.evaluate(() => window.__tex64PdfViewer?.state?.rotation ?? 0);
  await frame.click("#pdf-rotate-right");
  await frame.waitForFunction(
    (expected) => (window.__tex64PdfViewer?.state?.rotation ?? 0) === expected,
    (rotationBefore + 90 + 360) % 360,
    { timeout: 10000 }
  );
  await frame.click("#pdf-rotate-left");
  await frame.waitForFunction(
    (expected) => (window.__tex64PdfViewer?.state?.rotation ?? 0) === expected,
    rotationBefore,
    { timeout: 10000 }
  );

  const findProbeInstalled = await frame.evaluate(() => {
    const bus = window.__tex64PdfViewer?.pdfViewer?.eventBus;
    if (!bus) {
      return false;
    }
    if (window.__viewerOpsFindProbeInstalled !== true) {
      window.__viewerOpsFindProbeInstalled = true;
      window.__viewerOpsFindProbe = [];
      const originalDispatch = bus.dispatch.bind(bus);
      bus.dispatch = (type, payload) => {
        if (type === "find") {
          window.__viewerOpsFindProbe.push({
            query: typeof payload?.query === "string" ? payload.query : null,
            findPrevious: payload?.findPrevious === true,
          });
        }
        return originalDispatch(type, payload);
      };
    }
    window.__viewerOpsFindProbe.length = 0;
    return true;
  });
  assert.equal(findProbeInstalled, true, "failed to install find probe");
  await frame.fill("#pdf-search-input", "tex64");
  await frame.click("#pdf-search-next");
  await frame.click("#pdf-search-prev");
  const findCalls = await frame.evaluate(() => window.__viewerOpsFindProbe.slice());
  assert.ok(
    findCalls.some((item) => item?.query === "tex64" && item?.findPrevious === false),
    `search next dispatch not observed: ${JSON.stringify(findCalls)}`
  );
  assert.ok(
    findCalls.some((item) => item?.query === "tex64" && item?.findPrevious === true),
    `search prev dispatch not observed: ${JSON.stringify(findCalls)}`
  );

  await ensureSidebarVisible(frame);
  await frame.click("#pdf-tab-thumbs");
  await frame.waitForFunction(
    () => {
      const state = window.__tex64PdfViewer?.state;
      const thumbs = document.getElementById("pdf-thumbnails");
      return (
        state?.sidebarTab === "thumbs" &&
        thumbs instanceof HTMLElement &&
        thumbs.classList.contains("is-active")
      );
    },
    undefined,
    { timeout: 10000 }
  );
  await frame.click("#pdf-tab-outline");
  await frame.waitForFunction(
    () => {
      const state = window.__tex64PdfViewer?.state;
      const outline = document.getElementById("pdf-outline");
      return (
        state?.sidebarTab === "outline" &&
        outline instanceof HTMLElement &&
        outline.classList.contains("is-active")
      );
    },
    undefined,
    { timeout: 10000 }
  );

  const invertedInitially = await frame.evaluate(() => document.body.classList.contains("is-inverted"));
  if (!invertedInitially) {
    await frame.click("#pdf-invert");
  }
  await frame.waitForFunction(() => document.body.classList.contains("is-inverted"), undefined, {
    timeout: 8000,
  });
  const storedInvert = await frame.evaluate(() => localStorage.getItem("tex64.pdf.invert"));
  assert.equal(storedInvert, "true", "invert state should be persisted to localStorage");

  const actionProbeInstalled = await frame.evaluate(() => {
    if (window.__viewerOpsActionProbeInstalled !== true) {
      window.__viewerOpsActionProbeInstalled = true;
      window.__viewerOpsActionProbe = { printCount: 0, downloadCount: 0 };
      const originalPrint = window.print.bind(window);
      window.print = () => {
        window.__viewerOpsActionProbe.printCount += 1;
      };
      const originalAnchorClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function (...args) {
        if (this instanceof HTMLAnchorElement && this.hasAttribute("download")) {
          window.__viewerOpsActionProbe.downloadCount += 1;
        }
        return originalAnchorClick.apply(this, args);
      };
      window.__viewerOpsOriginalPrint = originalPrint;
    }
    window.__viewerOpsActionProbe.printCount = 0;
    window.__viewerOpsActionProbe.downloadCount = 0;
    return true;
  });
  assert.equal(actionProbeInstalled, true, "failed to install viewer action probes");

  await frame.click("#pdf-download");
  await frame.click("#pdf-print");
  const actionProbe = await frame.evaluate(() => window.__viewerOpsActionProbe);
  assert.ok(actionProbe?.downloadCount >= 1, "download action was not triggered");
  assert.ok(actionProbe?.printCount >= 1, "print action was not triggered");

  const reloadUrlBefore = await frame.evaluate(() => window.__tex64PdfViewer?.state?.url ?? null);
  await frame.click("#pdf-reload");
  await frame.waitForFunction(
    (before) => {
      const url = window.__tex64PdfViewer?.state?.url;
      return typeof url === "string" && url !== before && /[?&]t=/.test(url);
    },
    reloadUrlBefore,
    { timeout: 15000 }
  );
};

const run = async () => {
  const { tempDir, workspacePath, userDataPath } = await createWorkspaceCopy();
  let app;
  try {
    log("launch app and open workspace via launcher");
    const launched = await launchApp({ workspacePath, userDataPath });
    app = launched.app;
    const page = launched.page;

    await installMainCollectors(page);
    await openWorkspaceViaLauncher(page);
    await waitForWorkspaceReady(page);
    await clickSideTab(page, "files");

    log("[1/5] tab viewer: image/PDF + iframe communication");
    await setPdfViewerModeViaSettings(page, "tab");
    await clickSideTab(page, "files");

    await ensureFolderPathOpen(page, "cases/viewer");
    await clickFileTreeFile(page, "cases/viewer/sample.png");
    await waitForAnyViewerMode(page, "image", 12000);
    const imageSrc = await page.evaluate(() => {
      const candidates = [
        { rootId: "editor-viewer", imageId: "editor-viewer-image" },
        { rootId: "editor-viewer-secondary", imageId: "editor-viewer-image-secondary" },
      ];
      for (const candidate of candidates) {
        const root = document.getElementById(candidate.rootId);
        if (!(root instanceof HTMLElement) || root.dataset.view !== "image") {
          continue;
        }
        const image = document.getElementById(candidate.imageId);
        if (image instanceof HTMLImageElement) {
          return image.src ?? "";
        }
      }
      return "";
    });
    assert.ok(imageSrc.startsWith("blob:"), `image viewer did not load blob url: ${imageSrc}`);

    await clearMainWindowMessages(page);
    await clickFileTreeFile(page, "main.pdf");
    await waitForAnyViewerMode(page, "pdf", 15000);
    const readyMessage = await waitForMessage(
      (type) => pullWindowMessage(page, type),
      "ready",
      15000,
      (item) => item?.source === "tex64-pdf",
      "window message"
    );
    assert.equal(readyMessage.source, "tex64-pdf");

    let tabFrame = await getVisibleTabViewerFrame(page);
    await waitForViewerLoaded(tabFrame);

    await installFrameInboundCollector(tabFrame);
    await clearFrameInboundMessages(tabFrame);
    await ensureFolderPathOpen(page, "assets/pdfs");
    await clickFileTreeFile(page, "assets/pdfs/sample.pdf");
    tabFrame = await getVisibleTabViewerFrame(page);
    await waitForViewerLoaded(tabFrame);
    const openEnvelope = await waitForMessage(
      (type) => pullFrameInboundMessage(tabFrame, type),
      "open",
      15000,
      (item) => item?.source === "tex64-pdf",
      "frame inbound message"
    );
    assert.equal(openEnvelope.source, "tex64-pdf");
    assert.ok(
      String(openEnvelope.payload?.path ?? "").includes("assets/pdfs/sample.pdf"),
      `open payload path mismatch: ${JSON.stringify(openEnvelope.payload)}`
    );

    await clickFileTreeFile(page, "main.pdf");
    tabFrame = await getVisibleTabViewerFrame(page);
    await waitForViewerLoaded(tabFrame);

    log("[2/5] tab viewer: sync + reverse + parent-child messaging");
    await clickFileTreeFile(page, "main.tex");
    await page.click("#editor .monaco-editor", { position: { x: 120, y: 90 } });
    await setEditorCursor(page, 24, 1);

    await clearMainBridgeMessages(page);
    await page.click("#build-button");
    await waitForBuildIdle(page, 180000);

    const forwardBootstrap = await triggerSyncAndWaitForward(page);
    assert.ok(
      forwardBootstrap?.ok === true,
      `unexpected forward payload: ${JSON.stringify(forwardBootstrap)}`
    );

    tabFrame = await getVisibleTabViewerFrame(page);
    await waitForViewerLoaded(tabFrame);
    await tabFrame.waitForSelector("#pdf-pages .page", { timeout: 25000 });
    await installFrameInboundCollector(tabFrame);
    await clearFrameInboundMessages(tabFrame, "sync");
    await clickFileTreeFile(page, "main.tex");
    await page.click("#editor .monaco-editor", { position: { x: 120, y: 90 } });
    await setEditorCursor(page, 26, 1);

    const forwardPayload = await triggerSyncAndWaitForward(page);
    assert.ok(forwardPayload?.ok === true, `unexpected forward payload: ${JSON.stringify(forwardPayload)}`);
    assert.ok(Number.isFinite(forwardPayload?.page), "forward payload page is invalid");
    assert.ok(Number.isFinite(forwardPayload?.x), "forward payload x is invalid");
    assert.ok(Number.isFinite(forwardPayload?.y), "forward payload y is invalid");
    const tabReversePoint = await tabFrame.evaluate(() => {
      const pageEl = document.querySelector("#pdf-pages .page");
      if (!(pageEl instanceof HTMLElement)) {
        return null;
      }
      const rect = pageEl.getBoundingClientRect();
      return {
        x: Math.min(Math.max(18, rect.width * 0.35), Math.max(18, rect.width - 18)),
        y: Math.min(Math.max(18, rect.height * 0.25), Math.max(18, rect.height - 18)),
      };
    });
    assert.ok(tabReversePoint, "tab reverse click point not found");

    await clearMainWindowMessages(page, "reverse");
    await clearMainBridgeMessages(page, "synctex:reverseResult");
    await tabFrame.click("#pdf-pages .page", {
      position: tabReversePoint,
      modifiers: [modKey],
    });
    const reverseMessageViaClick = await waitForMessage(
      (type) => pullWindowMessage(page, type),
      "reverse",
      15000,
      (item) => item?.source === "tex64-pdf",
      "window message"
    );
    assert.equal(reverseMessageViaClick.source, "tex64-pdf");
    const reverseResultViaClick = await waitForMessage(
      (type) => pullBridgeMessage(page, type),
      "synctex:reverseResult",
      30000,
      (item) => item?.payload?.ok === true,
      "bridge"
    );
    assert.equal(reverseResultViaClick.payload.ok, true);
    assert.ok(typeof reverseResultViaClick.payload.path === "string");
    assert.ok(Number.isFinite(reverseResultViaClick.payload.line));

    await clearMainWindowMessages(page, "reverse");
    await clearMainBridgeMessages(page, "synctex:reverseResult");
    await tabFrame.click("#pdf-pages .page", {
      position: tabReversePoint,
      button: "right",
    });
    await tabFrame.waitForSelector(".pdf-context-menu .pdf-context-menu-item", { timeout: 10000 });
    await tabFrame.click(".pdf-context-menu .pdf-context-menu-item");
    const reverseMessageViaMenu = await waitForMessage(
      (type) => pullWindowMessage(page, type),
      "reverse",
      15000,
      (item) => item?.source === "tex64-pdf",
      "window message"
    );
    assert.equal(reverseMessageViaMenu.source, "tex64-pdf");
    const reverseResultViaMenu = await waitForMessage(
      (type) => pullBridgeMessage(page, type),
      "synctex:reverseResult",
      30000,
      (item) => item?.payload?.ok === true,
      "bridge"
    );
    assert.equal(reverseResultViaMenu.payload.ok, true);

    log("[3/5] window mode: dedicated window open/sync");
    await setPdfViewerModeViaSettings(page, "window");
    await clickSideTab(page, "files");
    await clickFileTreeFile(page, "main.tex");
    await page.click("#editor .monaco-editor", { position: { x: 120, y: 90 } });
    await setEditorCursor(page, 32, 1);

    await closeAuxWindows(app, page);
    await clearMainBridgeMessages(page, "synctex:forwardResult");
    const waitWindow = app.waitForEvent("window", { timeout: 25000 }).catch(() => null);
    const windowForward1 = await triggerSyncAndWaitForward(page);

    let pdfWindow = app.windows().find((win) => win !== page) ?? null;
    if (!pdfWindow) {
      pdfWindow = await waitWindow;
    }
    assert.ok(pdfWindow, "pdf window was not opened");
    await pdfWindow.waitForLoadState("domcontentloaded");
    await pdfWindow.waitForSelector("#pdf-prev", { timeout: 20000 });
    await waitForViewerLoaded(pdfWindow);
    await waitViewerSynced(pdfWindow, windowForward1);

    const firstWindowPath = await pdfWindow.evaluate(
      () => window.__tex64PdfViewer?.state?.path ?? null
    );
    assert.ok(
      typeof firstWindowPath === "string" && firstWindowPath.endsWith("main.pdf"),
      `unexpected window pdf path: ${firstWindowPath}`
    );

    log("[4/5] window mode: all viewer controls");
    await verifyViewerControls(pdfWindow);

    log("[5/5] window mode: reverse sync");
    await setEditorCursor(page, 42, 1);
    const windowForward2 = await triggerSyncAndWaitForward(page);
    await waitViewerSynced(pdfWindow, windowForward2);

    await clearMainBridgeMessages(page, "synctex:reverseResult");
    const windowReversePoint = await pdfWindow.evaluate(() => {
      const pageEl = document.querySelector("#pdf-pages .page");
      if (!(pageEl instanceof HTMLElement)) {
        return null;
      }
      const rect = pageEl.getBoundingClientRect();
      return {
        x: Math.min(Math.max(18, rect.width * 0.35), Math.max(18, rect.width - 18)),
        y: Math.min(Math.max(18, rect.height * 0.25), Math.max(18, rect.height - 18)),
      };
    });
    assert.ok(windowReversePoint, "window reverse click point not found");
    await pdfWindow.click("#pdf-pages .page", {
      position: windowReversePoint,
      modifiers: [modKey],
    });
    const reverseResultWindow = await waitForMessage(
      (type) => pullBridgeMessage(page, type),
      "synctex:reverseResult",
      30000,
      (item) => item?.payload?.ok === true,
      "bridge"
    );
    assert.equal(reverseResultWindow.payload.ok, true);
    assert.ok(typeof reverseResultWindow.payload.path === "string");
    assert.ok(Number.isFinite(reverseResultWindow.payload.line));

    log("viewer e2e completed");
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
  console.error(error);
  process.exitCode = 1;
});
