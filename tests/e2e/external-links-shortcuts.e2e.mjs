import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const sourceWorkspace = path.join(__dirname, "fixtures", "synctex-precision");

const keepWorkspace = process.env.E2E_KEEP_WORKSPACE === "1";
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "120", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "30", 10);
const modKey = process.platform === "darwin" ? "Meta" : "Control";

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => console.log(`[external-links-e2e ${now()}] ${message}`);

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
    log(`close fallback: ${error instanceof Error ? error.message : String(error)}`);
    try {
      app.process()?.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
};

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-external-links-"));
  const workspacePath = path.join(tempDir, "workspace");
  const userDataPath = path.join(tempDir, "userdata");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });
  return { tempDir, workspacePath, userDataPath };
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

const initCollectors = async (page) => {
  await page.evaluate(() => {
    if (!Array.isArray(window.__externalLinksIncoming)) {
      window.__externalLinksIncoming = [];
    }
    if (!Array.isArray(window.__externalLinksOutgoing)) {
      window.__externalLinksOutgoing = [];
    }
    if (window.__externalLinksIncomingInstalled !== true) {
      window.__externalLinksIncomingInstalled = true;
      window.tex64Bridge.onMessage((message) => {
        const requestId =
          message?.payload && typeof message.payload === "object"
            ? message.payload.requestId
            : message?.requestId;
        window.__externalLinksIncoming.push({
          type: message?.type ?? null,
          requestId: typeof requestId === "string" ? requestId : null,
          payload: message?.payload ?? null,
          at: Date.now(),
        });
      });
    }
    if (window.__externalLinksOutgoingInstalled !== true) {
      window.__externalLinksOutgoingInstalled = true;
      const bridge = window.tex64Bridge;
      if (bridge && typeof bridge.postMessage === "function") {
        const originalPostMessage = bridge.postMessage.bind(bridge);
        bridge.postMessage = (...args) => {
          const payload = args[0];
          const requestId =
            payload && typeof payload === "object" ? payload.requestId : null;
          window.__externalLinksOutgoing.push({
            type: payload?.type ?? null,
            requestId: typeof requestId === "string" ? requestId : null,
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
        key === "incoming" ? window.__externalLinksIncoming : window.__externalLinksOutgoing;
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
          key === "incoming" ? window.__externalLinksIncoming : window.__externalLinksOutgoing;
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

const dispatchDeepLink = async (page, href) => {
  await page.evaluate((value) => {
    const anchor = document.createElement("a");
    anchor.href = value;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, href);
};

const waitForEditorLocation = async (page, relativePath, line, column) => {
  await page.waitForFunction(
    ({ expectedPath, expectedLine, expectedColumn }) => {
      const normalize = (value) => String(value ?? "").replace(/\\\\/g, "/");
      const expected = normalize(expectedPath);
      const activeTab = document.querySelector("#editor-tabs-list .editor-tab.is-active");
      const activePath =
        activeTab instanceof HTMLElement ? normalize(activeTab.dataset.path ?? "") : "";
      const editors = window.monaco?.editor?.getEditors?.() ?? [];
      const focused =
        editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
        editors[0] ??
        null;
      const model = focused?.getModel?.();
      const position = focused?.getPosition?.();
      const modelPath = normalize(model?.uri?.path ?? model?.uri?.fsPath ?? "");
      const matchesPath =
        activePath === expected ||
        modelPath === expected ||
        modelPath.endsWith(`/${expected}`) ||
        modelPath.endsWith(expected);
      return Boolean(
        matchesPath &&
          Number(position?.lineNumber) === expectedLine &&
          Number(position?.column) === expectedColumn
      );
    },
    { expectedPath: relativePath, expectedLine: line, expectedColumn: column },
    { timeout: 25000 }
  );
};

const run = async () => {
  const { tempDir, workspacePath, userDataPath } = await createWorkspaceCopy();
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
      },
    });
    await installE2EQuitGuard(app);

    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1660, height: 980 });
    await initCollectors(page);

    await postToBridge(page, {
      type: "openRecentProject",
      path: toPosix(workspacePath),
    });
    await waitForWorkspaceReady(page);

    log("[1/4] baseline build for SyncTeX deep link");
    await page.click("#build-button");
    await waitForBuildIdle(page);

    log("[2/4] tex64://open-source opens source at line+column");
    await dispatchDeepLink(
      page,
      `tex64://open-source?path=${encodeURIComponent("sections/overview.tex")}&line=10&column=12`
    );
    await waitForEditorLocation(page, "sections/overview.tex", 10, 12);

    log("[3/4] tex64://view-on-pdf triggers forward SyncTeX");
    await clearMessages(page, "incoming", "synctex:forwardResult");
    await dispatchDeepLink(
      page,
      `tex64://view-on-pdf?path=${encodeURIComponent("main.tex")}&line=13&column=1`
    );
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

    log("[4/4] Cmd/Ctrl+B triggers build");
    await clearMessages(page, "incoming", "setBuildState");
    await page.click("#main-content", { position: { x: 120, y: 80 } }).catch(() => {});
    await page.keyboard.press(`${modKey}+B`);
    const buildState = await waitForMessage({
      page,
      channel: "incoming",
      type: "setBuildState",
      timeoutMs: 30000,
      predicate: (message) => message?.payload?.state === "building",
    });
    assert.ok(buildState, "keyboard shortcut should trigger build state update");
    await waitForBuildStarted(page, 30000);
    await waitForBuildIdle(page);

    log("external links + shortcut e2e passed");
  } finally {
    if (app) {
      await closeElectron(app).catch(() => {});
    }
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
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
  console.error("[external-links-e2e] failed:", error);
  process.exitCode = 1;
});
