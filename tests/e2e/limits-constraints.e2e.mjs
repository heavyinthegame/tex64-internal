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
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "80", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "15", 10);

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => console.log(`[limits-constraints-e2e ${now()}] ${message}`);

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
  await page.setViewportSize({ width: 1660, height: 980 });
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

const waitForWorkspaceOpened = async (page, workspaceName, timeout = 25000) => {
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
    { timeout }
  );
  await page.waitForSelector("#editor-tabs-list .editor-tab.is-active", { timeout });
};

const openWorkspaceViaLauncher = async (page, workspaceName) => {
  await waitForLauncherVisible(page, 20000);
  await page.waitForSelector("#launcher-open", { timeout: 10000 });
  await page.click("#launcher-open");
  await waitForWorkspaceOpened(page, workspaceName);
};

const openSideTab = async (page, key) => {
  await page.click(`button.tab[data-tab="${key}"]`);
  await page.waitForSelector(`.sidebar-panel .panel.is-active[data-panel="${key}"]`, {
    timeout: 12000,
  });
  await pause(80);
};

const focusEditor = async (page) => {
  await page.waitForSelector("#editor .monaco-editor", { timeout: 15000 });
  await page.click("#editor .monaco-editor", { position: { x: 120, y: 90 } });
  await pause(80);
};

const initIncomingRecorder = async (page) => {
  await page.evaluate(() => {
    if (!Array.isArray(window.__limitsConstraintsIncoming)) {
      window.__limitsConstraintsIncoming = [];
    }
    if (window.__limitsConstraintsIncomingInstalled === true) {
      return;
    }
    window.__limitsConstraintsIncomingInstalled = true;
    window.tex64Bridge.onMessage((message) => {
      window.__limitsConstraintsIncoming.push({
        type: message?.type ?? null,
        payload: message?.payload ?? null,
        at: Date.now(),
      });
    });
  });
};

const clearIncomingMessages = async (page, type = null) => {
  await page.evaluate((expectedType) => {
    if (!Array.isArray(window.__limitsConstraintsIncoming)) {
      return;
    }
    if (!expectedType) {
      window.__limitsConstraintsIncoming.length = 0;
      return;
    }
    window.__limitsConstraintsIncoming = window.__limitsConstraintsIncoming.filter(
      (entry) => entry?.type !== expectedType
    );
  }, type);
};

const waitForIncomingMessage = async ({
  page,
  type,
  timeoutMs = 20000,
  predicate = () => true,
}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const item = await page.evaluate((expectedType) => {
      const source = window.__limitsConstraintsIncoming;
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
    }, type);
    if (item && predicate(item)) {
      return item;
    }
    await pause(30);
  }
  throw new Error(`timed out waiting for incoming message: ${type}`);
};

const setCursorOnLineSubstring = async (page, needle) => {
  const cursor = await page.evaluate((token) => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    const model = active?.getModel?.();
    if (!active || !model) {
      return null;
    }
    const lineCount = model.getLineCount();
    for (let lineNumber = 1; lineNumber <= lineCount; lineNumber += 1) {
      const lineText = model.getLineContent(lineNumber);
      const index = lineText.indexOf(token);
      if (index < 0) {
        continue;
      }
      const column = index + Math.max(1, Math.floor(token.length / 2)) + 1;
      active.setPosition({ lineNumber, column });
      active.revealPositionInCenterIfOutsideViewport?.({ lineNumber, column });
      active.focus();
      return { lineNumber, column };
    }
    return null;
  }, needle);
  assert.ok(cursor, `failed to locate token in active model: ${needle}`);
  await pause(100);
};

const triggerShowHover = async (page) => {
  const anchor = await page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    const position = active?.getPosition?.();
    if (position && active?.revealPositionInCenterIfOutsideViewport) {
      active.revealPositionInCenterIfOutsideViewport(position);
    }
    active?.trigger?.("limits-constraints-e2e", "editor.action.showHover", {});
    const domNode = active?.getDomNode?.();
    const visible = position ? active?.getScrolledVisiblePosition?.(position) : null;
    if (!domNode || !visible) {
      return null;
    }
    const rect = domNode.getBoundingClientRect();
    return {
      x: rect.left + visible.left + Math.max(6, Math.floor((visible.width || 12) / 2)),
      y: rect.top + visible.top + Math.max(6, Math.floor((visible.height || 18) / 2)),
    };
  });
  if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
    await page.mouse.move(anchor.x, anchor.y);
  }
  await pause(160);
};

const hideHover = async (page) => {
  await page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    active?.trigger?.("limits-constraints-e2e", "editor.action.hideHover", {});
  });
  await pause(100);
};

const getHoverSnapshot = async (page) =>
  page.evaluate(() => {
    const hover = document.querySelector(".monaco-hover");
    if (!hover) {
      return null;
    }
    const style = window.getComputedStyle(hover);
    const rect = hover.getBoundingClientRect();
    const visible = style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
    if (!visible) {
      return null;
    }
    const text = (hover.textContent ?? "").replace(/\s+/g, " ").trim();
    const hasImagePreview = Boolean(hover.querySelector('img[src^="data:image"]'));
    return { text, hasImagePreview };
  });

const waitForHoverVisible = async (page, timeoutMs = 6000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await getHoverSnapshot(page);
    if (snapshot) {
      return snapshot;
    }
    await pause(60);
  }
  throw new Error("hover did not appear");
};

const writeLargeWorkspace = async (workspacePath) => {
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.writeFile(
    path.join(workspacePath, "main.tex"),
    [
      "\\documentclass{article}",
      "\\begin{document}",
      "workspace enumeration cap test",
      "\\end{document}",
      "",
    ].join("\n"),
    "utf8"
  );
  const batch = [];
  const flush = async () => {
    if (batch.length === 0) {
      return;
    }
    await Promise.all(batch.splice(0, batch.length));
  };
  for (let index = 0; index < 5105; index += 1) {
    const fileName = `bulk-${String(index).padStart(4, "0")}.tex`;
    batch.push(fs.writeFile(path.join(workspacePath, fileName), `bulk ${index}\n`, "utf8"));
    if (batch.length >= 220) {
      await flush();
    }
  }
  await flush();
};

const writeExcerptWorkspace = async (workspacePath) => {
  await fs.mkdir(path.join(workspacePath, "sections"), { recursive: true });
  await fs.mkdir(path.join(workspacePath, "figures"), { recursive: true });
  await fs.writeFile(
    path.join(workspacePath, "main.tex"),
    [
      "\\documentclass{article}",
      "\\usepackage{graphicx}",
      "\\begin{document}",
      "\\input{sections/huge}",
      "\\includegraphics{figures/oversize-image.png}",
      "\\end{document}",
      "",
    ].join("\n"),
    "utf8"
  );
  const longTail = "X".repeat(220);
  const lines = Array.from(
    { length: 240 },
    (_, index) => `Huge excerpt line ${String(index + 1).padStart(3, "0")}: ${longTail}`
  );
  await fs.writeFile(path.join(workspacePath, "sections", "huge.tex"), `${lines.join("\n")}\n`, "utf8");
  await fs.writeFile(
    path.join(workspacePath, "figures", "oversize-image.png"),
    Buffer.alloc(2 * 1024 * 1024 + 2048, 0x61)
  );
};

const runWorkspaceEnumerationScenario = async ({ workspacePath, userDataPath }) => {
  log("[1/2] workspace listing cap (5000)");
  let app = null;
  try {
    ({ app } = await launchApp({ userDataPath, workspacePath }));
    const page = await app.firstWindow();
    await openWorkspaceViaLauncher(page, path.basename(workspacePath));
    await openSideTab(page, "files");
    await page.waitForFunction(
      (expected) => document.querySelectorAll("#file-tree button.file-item").length === expected,
      5000,
      { timeout: 80000 }
    );
    const fileCount = await page.locator("#file-tree button.file-item").count();
    assert.equal(fileCount, 5000, "file tree item count should be capped at 5000");
  } finally {
    if (app) {
      await closeElectron(app).catch(() => {});
    }
  }
};

const runExcerptPreviewScenario = async ({ workspacePath, userDataPath }) => {
  log("[2/2] excerpt 12KB truncation + preview 2MB fallback");
  let app = null;
  try {
    ({ app } = await launchApp({ userDataPath, workspacePath }));
    const page = await app.firstWindow();
    await initIncomingRecorder(page);
    await openWorkspaceViaLauncher(page, path.basename(workspacePath));
    await openSideTab(page, "files");
    await focusEditor(page);

    await clearIncomingMessages(page, "file:excerptResult");
    await setCursorOnLineSubstring(page, "sections/huge");
    await triggerShowHover(page);
    const excerptMessage = await waitForIncomingMessage({
      page,
      type: "file:excerptResult",
      timeoutMs: 20000,
      predicate: (entry) =>
        entry?.payload?.ok === true && String(entry?.payload?.path ?? "").includes("sections/huge"),
    });
    assert.equal(excerptMessage?.payload?.ok, true, "excerpt request should succeed");
    const excerptText = Array.isArray(excerptMessage?.payload?.lines)
      ? excerptMessage.payload.lines.join("\n")
      : "";
    assert.ok(
      Buffer.byteLength(excerptText, "utf8") <= 12_000,
      "excerpt payload must be clipped to 12KB"
    );
    await hideHover(page);

    await setCursorOnLineSubstring(page, "oversize-image.png");
    await triggerShowHover(page);
    const previewHover = await waitForHoverVisible(page, 7000);
    assert.equal(
      previewHover.hasImagePreview,
      false,
      "oversize image preview should fallback to text (no data image)"
    );
    assert.ok(
      previewHover.text.includes("figures/oversize-image.png"),
      "oversize image fallback should include target path text"
    );
    await hideHover(page);
  } finally {
    if (app) {
      await closeElectron(app).catch(() => {});
    }
  }
};

const run = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-limits-constraints-"));
  const workspaceEnumeration = path.join(tempDir, "workspace-enumeration");
  const workspaceExcerpt = path.join(tempDir, "workspace-excerpt");
  const userDataEnumeration = path.join(tempDir, "userdata-enumeration");
  const userDataExcerpt = path.join(tempDir, "userdata-excerpt");

  await fs.mkdir(userDataEnumeration, { recursive: true });
  await fs.mkdir(userDataExcerpt, { recursive: true });
  await writeLargeWorkspace(workspaceEnumeration);
  await writeExcerptWorkspace(workspaceExcerpt);

  try {
    await runWorkspaceEnumerationScenario({
      workspacePath: workspaceEnumeration,
      userDataPath: userDataEnumeration,
    });
    await runExcerptPreviewScenario({
      workspacePath: workspaceExcerpt,
      userDataPath: userDataExcerpt,
    });
    log("limits constraints e2e passed");
  } finally {
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
  console.error("[limits-constraints-e2e] failed:", error);
  process.exitCode = 1;
});
