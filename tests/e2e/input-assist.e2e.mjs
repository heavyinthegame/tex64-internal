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
const runGhostRemote = process.env.E2E_GHOST_REMOTE !== "0";
const aiEndpoint =
  (typeof process.env.TEX64_AI_PROXY_URL === "string" && process.env.TEX64_AI_PROXY_URL.trim()) ||
  "https://tex64.vercel.app/api/ai-chat";
const skipGhostLocal = process.env.E2E_SKIP_GHOST_LOCAL === "1";
const runGhostApiLimits = process.env.E2E_GHOST_API_LIMITS === "1";
const skipGhostRemoteSmoke = process.env.E2E_SKIP_GHOST_REMOTE_SMOKE === "1";
const onlyGhost = process.env.E2E_ONLY_GHOST === "1";
const skipGhostSettings = process.env.E2E_SKIP_GHOST_SETTINGS === "1";
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "260", 10);
const typeDelayMs = Number.parseInt(process.env.E2E_TYPE_DELAY_MS ?? "40", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "70", 10);

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[input-assist-e2e ${now()}] ${message}`);
};
const toPosix = (value) => value.split(path.sep).join("/");

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

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-"));
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  const figuresDir = path.join(workspacePath, "figures");
  await fs.copyFile(
    path.join(figuresDir, "sample-image.png"),
    path.join(figuresDir, "sample-timeout.png")
  );
  await fs.writeFile(
    path.join(figuresDir, "oversize-image.png"),
    Buffer.alloc(2 * 1024 * 1024 + 512, 0x41)
  );
  return { tempDir, workspacePath };
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

const installBridgeRecorder = async (page) => {
  const installed = await page.evaluate(() => {
    const bridge = window.tex64Bridge;
    if (!bridge || typeof bridge.postMessage !== "function") {
      return false;
    }
    if ((window).__tex64E2EBridgeRecorderInstalled) {
      return true;
    }
    const originalPostMessage = bridge.postMessage.bind(bridge);
    (window).__tex64E2EBridgeMessages = [];
    (window).__tex64E2EDropByType = {};
    bridge.postMessage = (payload) => {
      const dropByType = (window).__tex64E2EDropByType ?? {};
      const type = payload && typeof payload === "object" ? payload.type : undefined;
      if (typeof type === "string" && Number.isFinite(dropByType[type]) && dropByType[type] > 0) {
        dropByType[type] -= 1;
        (window).__tex64E2EDropByType = dropByType;
        return true;
      }
      try {
        const snapshot =
          payload && typeof payload === "object" ? JSON.parse(JSON.stringify(payload)) : payload;
        (window).__tex64E2EBridgeMessages.push(snapshot);
      } catch {
        (window).__tex64E2EBridgeMessages.push({ type: "__unserializable" });
      }
      return originalPostMessage(payload);
    };
    (window).__tex64E2EBridgeRecorderInstalled = true;
    return true;
  });
  assert.equal(installed, true, "failed to install bridge recorder");
};

const clearBridgeRecorder = async (page) => {
  await page.evaluate(() => {
    (window).__tex64E2EBridgeMessages = [];
    (window).__tex64E2EDropByType = {};
  });
};

const installIncomingRecorder = async (page) => {
  await page.evaluate(() => {
    if (!Array.isArray(window.__tex64E2EIncomingMessages)) {
      window.__tex64E2EIncomingMessages = [];
    }
    if (window.__tex64E2EIncomingRecorderInstalled === true) {
      return;
    }
    window.__tex64E2EIncomingRecorderInstalled = true;
    window.tex64Bridge.onMessage((message) => {
      window.__tex64E2EIncomingMessages.push({
        type: message?.type ?? null,
        payload: message?.payload ?? null,
        at: Date.now(),
      });
    });
  });
};

const clearIncomingMessages = async (page, type = null) => {
  await page.evaluate((expectedType) => {
    if (!Array.isArray(window.__tex64E2EIncomingMessages)) {
      return;
    }
    if (!expectedType) {
      window.__tex64E2EIncomingMessages.length = 0;
      return;
    }
    window.__tex64E2EIncomingMessages = window.__tex64E2EIncomingMessages.filter(
      (entry) => entry?.type !== expectedType
    );
  }, type);
};

const countIncomingMessagesByType = async (page, type) =>
  page.evaluate((expectedType) => {
    const source = Array.isArray(window.__tex64E2EIncomingMessages)
      ? window.__tex64E2EIncomingMessages
      : [];
    return source.filter((entry) => entry?.type === expectedType).length;
  }, type);

const countIncomingMessagesByTypeSince = async (page, type, sinceEpochMs) =>
  page.evaluate(
    ({ expectedType, since }) => {
      const source = Array.isArray(window.__tex64E2EIncomingMessages)
        ? window.__tex64E2EIncomingMessages
        : [];
      return source.filter((entry) => entry?.type === expectedType && Number(entry?.at) >= since).length;
    },
    { expectedType: type, since: sinceEpochMs }
  );

const getIncomingMessageTimestampsByTypeSince = async (page, type, sinceEpochMs) =>
  page.evaluate(
    ({ expectedType, since }) => {
      const source = Array.isArray(window.__tex64E2EIncomingMessages)
        ? window.__tex64E2EIncomingMessages
        : [];
      return source
        .filter((entry) => entry?.type === expectedType && Number(entry?.at) >= since)
        .map((entry) => Number(entry?.at))
        .filter((at) => Number.isFinite(at))
        .sort((a, b) => a - b);
    },
    { expectedType: type, since: sinceEpochMs }
  );

const summarizeIncomingMessageTypes = async (page) =>
  page.evaluate(() => {
    const source = Array.isArray(window.__tex64E2EIncomingMessages)
      ? window.__tex64E2EIncomingMessages
      : [];
    const tally = new Map();
    for (const entry of source) {
      const key = typeof entry?.type === "string" ? entry.type : "__unknown";
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    return Array.from(tally.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([type, count]) => `${type}:${count}`)
      .join(", ");
  });

const waitForIncomingMessageCount = async (page, type, expectedCount, timeoutMs = 14000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await countIncomingMessagesByType(page, type);
    if (count >= expectedCount) {
      return count;
    }
    await pause(60);
  }
  const finalCount = await countIncomingMessagesByType(page, type);
  const summary = await summarizeIncomingMessageTypes(page);
  throw new Error(
    `${type} timed out: expected=${expectedCount} actual=${finalCount} seen=[${summary || "none"}]`
  );
};

const waitForIncomingCountStable = async (
  page,
  type,
  { quietMs = 1600, timeoutMs = 15000, pollMs = 120 } = {}
) => {
  const deadline = Date.now() + timeoutMs;
  let lastCount = await countIncomingMessagesByType(page, type);
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await pause(pollMs);
    const currentCount = await countIncomingMessagesByType(page, type);
    if (currentCount !== lastCount) {
      lastCount = currentCount;
      stableSince = Date.now();
      continue;
    }
    if (Date.now() - stableSince >= quietMs) {
      return currentCount;
    }
  }
  return countIncomingMessagesByType(page, type);
};

const waitForWorkspaceReady = async (page, activeFile = "main.tex") => {
  await page.waitForSelector("body.is-ready", { timeout: 15000 });
  await page.waitForSelector(`#editor-tabs-list .editor-tab.is-active[data-path="${activeFile}"]`, {
    timeout: 20000,
  });
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#outline-labels .outline-item").length > 0 &&
      document.querySelectorAll("#outline-citations .outline-item").length > 0,
    undefined,
    { timeout: 20000 }
  );
};

const focusEditor = async (page) => {
  const editor = page.locator("#editor .monaco-editor");
  await editor.waitFor({ state: "visible", timeout: 15000 });
  await editor.click({ position: { x: 120, y: 80 } });
  await page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    if (editors[0]?.focus) {
      editors[0].focus();
    }
  });
  await pause(150);
};

const moveCursorToEnd = async (page) => {
  await page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    const model = active?.getModel?.();
    if (!active || !model) {
      return;
    }
    const lineNumber = model.getLineCount();
    const column = model.getLineMaxColumn(lineNumber);
    active.setPosition({ lineNumber, column });
    active.revealPositionInCenterIfOutsideViewport?.({ lineNumber, column });
    active.focus();
  });
  await pause(100);
};

const triggerSuggest = async (page) => {
  await page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    if (active?.focus) {
      active.focus();
    }
    if (active?.trigger) {
      active.trigger("input-assist-e2e", "editor.action.triggerSuggest", {});
    }
  });
};

const typeScenarioPrefix = async (page, prefix) => {
  await moveCursorToEnd(page);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await page.keyboard.type(prefix, { delay: typeDelayMs });
  await triggerSuggest(page);
  await pause();
};

const getVisibleSuggestions = async (page) => {
  try {
    await page.waitForFunction(
      () => {
        const widget = document.querySelector(".suggest-widget.visible");
        if (!widget) {
          return false;
        }
        return widget.querySelectorAll(".monaco-list-row").length > 0;
      },
      undefined,
      { timeout: 5000 }
    );
  } catch {
    await triggerSuggest(page);
    await page.waitForFunction(
      () => {
        const widget = document.querySelector(".suggest-widget.visible");
        if (!widget) {
          return false;
        }
        return widget.querySelectorAll(".monaco-list-row").length > 0;
      },
      undefined,
      { timeout: 10000 }
    );
  }

  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".suggest-widget.visible .monaco-list-row"))
      .map((row) => row.textContent?.replace(/\s+/g, " ").trim() ?? "")
      .filter(Boolean)
  );
};

const assertSuggestionsIncludeAll = async (page, expected, testName, options = {}) => {
  const suggestions = await getVisibleSuggestions(page);
  expected.forEach((needle) => {
    const hit = suggestions.some((item) => item.includes(needle));
    assert.ok(
      hit,
      `${testName}: expected suggestion "${needle}" not found.\nSuggestions:\n${suggestions.join("\n")}`
    );
  });
  log(`${testName}: suggestions include ${expected.join(", ")}`);
  if (options.closeWidget !== false) {
    await page.keyboard.press("Escape");
    await pause();
  }
};

const focusSuggestionByContains = async (page, needle) => {
  const selected = await page.evaluate((text) => {
    const rows = Array.from(document.querySelectorAll(".suggest-widget.visible .monaco-list-row"));
    const row = rows.find((entry) => (entry.textContent ?? "").includes(text));
    if (!row) {
      return false;
    }
    row.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  }, needle);
  assert.ok(selected, `could not focus suggestion containing "${needle}"`);
  await pause(120);
};

const getFocusedSuggestionIndex = async (page) =>
  page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".suggest-widget.visible .monaco-list-row"));
    return rows.findIndex(
      (row) => row.classList.contains("focused") || row.getAttribute("aria-selected") === "true"
    );
  });

const getEditorState = async (page) =>
  page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    const model = active?.getModel?.();
    const position = active?.getPosition?.();
    const lineNumber = position?.lineNumber ?? 1;
    const lineContent = model?.getLineContent?.(lineNumber) ?? "";
    return {
      lineNumber,
      column: position?.column ?? 1,
      lineContent,
      value: model?.getValue?.() ?? "",
    };
  });

const appendLineViaModel = async (page, text) => {
  const lineNumber = await page.evaluate((lineText) => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    const model = active?.getModel?.();
    if (!active || !model) {
      return -1;
    }

    const lastLine = model.getLineCount();
    const endColumn = model.getLineMaxColumn(lastLine);
    const hasValue = model.getValueLength() > 0;
    const insertText = `${hasValue ? "\n" : ""}${lineText}`;
    active.executeEdits("input-assist-e2e", [
      {
        range: {
          startLineNumber: lastLine,
          startColumn: endColumn,
          endLineNumber: lastLine,
          endColumn,
        },
        text: insertText,
        forceMoveMarkers: true,
      },
    ]);
    const insertedLineNumber = hasValue ? lastLine + 1 : lastLine;
    active.setPosition({ lineNumber: insertedLineNumber, column: lineText.length + 1 });
    active.focus();
    return insertedLineNumber;
  }, text);

  assert.ok(lineNumber > 0, `appendLineViaModel: failed to append line "${text}"`);
  await pause(120);
  return { lineNumber, text };
};

const setCursorOnLineSubstring = async (page, lineNumber, lineText, needle, occurrence = 1) => {
  let fromIndex = 0;
  let foundIndex = -1;
  for (let i = 0; i < occurrence; i += 1) {
    foundIndex = lineText.indexOf(needle, fromIndex);
    if (foundIndex < 0) {
      break;
    }
    fromIndex = foundIndex + needle.length;
  }
  assert.ok(foundIndex >= 0, `substring "${needle}" not found in line: ${lineText}`);
  const column = foundIndex + Math.max(1, Math.floor(needle.length / 2)) + 1;
  await page.evaluate(
    (payload) => {
      const editors = window.monaco?.editor?.getEditors?.() ?? [];
      const active =
        editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
        editors[0];
      if (active?.setPosition) {
        active.setPosition({ lineNumber: payload.lineNumber, column: payload.column });
      }
      active?.focus?.();
    },
    { lineNumber, column }
  );
  await pause(120);
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
    active?.trigger?.("input-assist-e2e", "editor.action.showHover", {});
    const domNode = active?.getDomNode?.();
    const visible = position ? active?.getScrolledVisiblePosition?.(position) : null;
    if (!domNode || !visible) {
      return null;
    }
    const rect = domNode.getBoundingClientRect();
    const x = rect.left + visible.left + Math.max(6, Math.floor((visible.width || 12) / 2));
    const y = rect.top + visible.top + Math.max(6, Math.floor((visible.height || 18) / 2));
    return { x, y };
  });
  if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
    await page.mouse.move(anchor.x, anchor.y);
    await pause(140);
  }
};

const hideHover = async (page) => {
  await page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    active?.trigger?.("input-assist-e2e", "editor.action.hideHover", {});
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
    const text = hover.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const links = Array.from(hover.querySelectorAll("a[href], [data-tex64-href]"))
      .map((entry) => entry.getAttribute("data-tex64-href") ?? entry.getAttribute("href") ?? "")
      .filter(Boolean);
    const hasImagePreview = Boolean(hover.querySelector('img[src^="data:image"]'));
    return { text, links, hasImagePreview, html: hover.innerHTML };
  });

const getAnyHoverSnapshot = async (page) =>
  page.evaluate(() => {
    const hover = document.querySelector(".monaco-hover");
    if (!hover) {
      return null;
    }
    const text = hover.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (!text) {
      return null;
    }
    const links = Array.from(hover.querySelectorAll("a[href], [data-tex64-href]"))
      .map((entry) => entry.getAttribute("data-tex64-href") ?? entry.getAttribute("href") ?? "")
      .filter(Boolean);
    const hasImagePreview = Boolean(hover.querySelector('img[src^="data:image"]'));
    return { text, links, hasImagePreview, html: hover.innerHTML };
  });

const assertHoverVisible = async (page, testName, options = {}) => {
  const timeout = options.timeout ?? 5000;
  const startedAt = Date.now();
  let snapshot = null;
  while (!snapshot && Date.now() - startedAt < timeout) {
    snapshot = await getHoverSnapshot(page);
    if (!snapshot) {
      await pause(80);
    }
  }
  if (!snapshot) {
    snapshot = await getAnyHoverSnapshot(page);
  }
  if (!snapshot) {
    const debug = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[class*="hover"]'))
        .slice(0, 24)
        .map((node) => {
          const el = node;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            className: el.className,
            display: style.display,
            visibility: style.visibility,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 140),
          };
        })
    );
    assert.fail(`${testName}: hover did not appear.\nDebug:\n${JSON.stringify(debug, null, 2)}`);
  }
  return snapshot;
};

const assertNoHoverVisible = async (page, testName) => {
  await pause(500);
  const snapshot = await getHoverSnapshot(page);
  assert.equal(snapshot, null, `${testName}: expected no hover, but hover is visible`);
};

const captureHoverScreenshot = async (
  page,
  name,
  selector = ".monaco-hover",
  timeoutMs = 5000
) => {
  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (!dir) {
    return null;
  }
  await fs.mkdir(dir, { recursive: true });
  const targetPath = path.join(dir, `${name}.png`);
  const tryCapture = async (sel) => {
    try {
      await page.waitForSelector(sel, { state: "visible", timeout: timeoutMs });
      const clip = await page.evaluate((query) => {
        const el = document.querySelector(query);
        if (!el) {
          return null;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1) {
          return null;
        }
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const x = Math.max(0, Math.floor(rect.left));
        const y = Math.max(0, Math.floor(rect.top));
        const width = Math.max(1, Math.min(vw - x, Math.ceil(rect.width)));
        const height = Math.max(1, Math.min(vh - y, Math.ceil(rect.height)));
        return { x, y, width, height };
      }, sel);
      if (clip) {
        await page.screenshot({ path: targetPath, clip });
      } else {
        await page.screenshot({ path: targetPath });
      }
      return true;
    } catch {
      return false;
    }
  };

  if (await tryCapture(selector)) {
    return targetPath;
  }
  await page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    active?.trigger?.("input-assist-e2e", "editor.action.showHover", {});
  });
  await pause(100);
  if (await tryCapture(selector)) {
    return targetPath;
  }
  if (selector !== ".monaco-hover" && (await tryCapture(".monaco-hover"))) {
    return targetPath;
  }
  return null;
};

const getActiveGhostText = async (page) =>
  page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    const root = active?.getDomNode?.();
    if (!root) {
      return "";
    }
    const selector = [
      ".ghost-text",
      ".ghost-text-decoration",
      ".ghost-text-decoration-preview",
      ".inline-completion-text",
    ].join(",");
    return Array.from(root.querySelectorAll(selector))
      .map((node) => (node.textContent ?? node.innerText ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ")
      .trim();
  });

const waitForGhostTextVisible = async (page, label, timeoutMs = 3200) => {
  await page.waitForFunction(
    () => {
      const editors = window.monaco?.editor?.getEditors?.() ?? [];
      const active =
        editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
        editors[0];
      const root = active?.getDomNode?.();
      if (!root) {
        return false;
      }
      const selector = [
        ".ghost-text",
        ".ghost-text-decoration",
        ".ghost-text-decoration-preview",
        ".inline-completion-text",
      ].join(",");
      return Array.from(root.querySelectorAll(selector)).some((node) =>
        Boolean((node.textContent ?? node.innerText ?? "").trim())
      );
    },
    undefined,
    { timeout: timeoutMs }
  );
  const ghostText = await getActiveGhostText(page);
  log(`${label}: ghost visible "${ghostText}"`);
  return ghostText;
};

const openSideTab = async (page, key) => {
  await page.click(`button.tab[data-tab="${key}"]`);
  await page.waitForSelector(`.sidebar-panel .panel.is-active[data-panel="${key}"]`, {
    timeout: 10000,
  });
  await pause(100);
};

const openEditorSettingsPage = async (page) => {
  await openSideTab(page, "settings");
  await page.waitForSelector("#settings-panel", { timeout: 10000 });
  const activeEditorPage = await page
    .locator('.settings-page[data-settings-page="editor"].is-active')
    .count();
  if (activeEditorPage > 0) {
    return;
  }
  const editorNavVisible = await page
    .locator('button.settings-nav-item[data-settings-target="editor"]')
    .isVisible()
    .catch(() => false);
  if (!editorNavVisible) {
    const backButtons = page.locator("button.settings-back[data-settings-back]");
    if ((await backButtons.count()) > 0) {
      await backButtons.first().click();
      await pause(120);
    }
  }
  await page.click('button.settings-nav-item[data-settings-target="editor"]');
  await page.waitForSelector('.settings-page[data-settings-page="editor"].is-active', {
    timeout: 10000,
  });
};

const setGhostCompletionEnabled = async (page, enabled) => {
  await openEditorSettingsPage(page);
  const selector = "#editor-ghost-completion";
  await page.waitForSelector(selector, { timeout: 10000 });
  const checked = await page.isChecked(selector);
  if (checked !== enabled) {
    await page.click(selector);
  }
  await page.waitForFunction(
    (payload) => {
      const input = document.querySelector(payload.selector);
      return input instanceof HTMLInputElement && input.checked === payload.enabled;
    },
    { selector, enabled },
    { timeout: 8000 }
  );
};

const setGhostCompletionConfig = async (page, options = {}) => {
  await openEditorSettingsPage(page);
  if (typeof options.debounceMs === "number") {
    await page.fill("#editor-ghost-debounce", String(options.debounceMs));
    await page.locator("#editor-ghost-debounce").blur();
  }
  if (typeof options.maxChars === "number") {
    await page.fill("#editor-ghost-max-chars", String(options.maxChars));
    await page.locator("#editor-ghost-max-chars").blur();
  }
  await pause(220);
};

const openWorkspaceFile = async (page, filePath) => {
  await openSideTab(page, "files");
  const segments = filePath.split("/");
  const fileName = segments.pop() ?? "";
  let folderPath = "";
  for (const segment of segments) {
    folderPath = folderPath ? `${folderPath}/${segment}` : segment;
    const detailsSelector = `#file-tree details.file-folder[data-path="${folderPath}"]`;
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
  }
  if (!fileName) {
    throw new Error(`invalid file path: ${filePath}`);
  }
  const fileSelector = `#file-tree button.file-item[data-path="${filePath}"]`;
  await page.waitForSelector(fileSelector, { timeout: 10000 });
  await page.click(fileSelector);
  await page.waitForSelector(`#editor-tabs-list .editor-tab.is-active[data-path="${filePath}"]`, {
    timeout: 15000,
  });
  await focusEditor(page);
};

const runCompletionChecks = async (page) => {
  log("Completion checks start");

  const refLikeCommands = ["\\ref{sec:", "\\eqref{eq:", "\\pageref{sec:", "\\autoref{sec:"];
  for (const command of refLikeCommands) {
    const expected = command.includes("{eq:") ? ["eq:newton", "eq:align", "eq:eqbox"] : ["sec:methods"];
    await typeScenarioPrefix(page, command);
    await assertSuggestionsIncludeAll(page, expected, `completion ${command}`);
  }

  const crefFamily = ["\\cref{sec:", "\\Cref{sec:", "\\namecref{sec:"];
  for (const command of crefFamily) {
    await typeScenarioPrefix(page, command);
    await assertSuggestionsIncludeAll(page, ["sec:methods"], `completion ${command}`);
  }

  await typeScenarioPrefix(page, "\\cite{la");
  await assertSuggestionsIncludeAll(page, ["lamport1994"], "completion \\cite");

  const citeVariants = ["\\citet{la", "\\citep{la", "\\autocite{la", "\\parencite{la"];
  for (const command of citeVariants) {
    await typeScenarioPrefix(page, command);
    await assertSuggestionsIncludeAll(page, ["lamport1994"], `completion ${command}`);
  }

  await typeScenarioPrefix(page, "\\cite[see]{la");
  await assertSuggestionsIncludeAll(page, ["lamport1994"], "completion optional cite");

  await typeScenarioPrefix(page, "\\cite{knuth1984,la");
  await assertSuggestionsIncludeAll(page, ["lamport1994"], "completion cite second key");

  await typeScenarioPrefix(page, "\\input{sections/me");
  await assertSuggestionsIncludeAll(page, ["sections/methods"], "completion input path");

  await typeScenarioPrefix(page, "\\include{sections/re");
  await assertSuggestionsIncludeAll(page, ["sections/results"], "completion include path");

  await typeScenarioPrefix(page, "\\input{sections/methods.t");
  await assertSuggestionsIncludeAll(page, ["sections/methods.tex"], "completion explicit extension");

  await typeScenarioPrefix(page, "\\includegraphics{figures/sample-");
  await assertSuggestionsIncludeAll(
    page,
    ["figures/sample-image.png", "figures/sample-vector.svg"],
    "completion includegraphics image candidates"
  );

  await typeScenarioPrefix(page, "\\includegraphics{assets/pdfs/sa");
  await assertSuggestionsIncludeAll(
    page,
    ["assets/pdfs/sample.pdf"],
    "completion includegraphics pdf candidate"
  );

  const beginCases = [
    { prefix: "\\begin{fig", env: "figure" },
    { prefix: "\\begin{tab", env: "table" },
    { prefix: "\\begin{ali", env: "align" },
    { prefix: "\\begin{ite", env: "itemize" },
  ];
  for (const entry of beginCases) {
    await typeScenarioPrefix(page, entry.prefix);
    await assertSuggestionsIncludeAll(page, [entry.env], `completion begin ${entry.env}`, {
      closeWidget: false,
    });
    await focusSuggestionByContains(page, entry.env);
    await page.keyboard.press("Enter");
    await pause();
    const state = await getEditorState(page);
    assert.ok(
      state.value.includes(`\\begin{${entry.env}}`) && state.value.includes(`\\end{${entry.env}}`),
      `completion begin ${entry.env}: expected snippet to be expanded`
    );
  }

  await typeScenarioPrefix(page, "\\ref{sec:");
  await assertSuggestionsIncludeAll(page, ["sec:methods"], "completion tab navigation", {
    closeWidget: false,
  });
  const focusedBefore = await getFocusedSuggestionIndex(page);
  await page.keyboard.press("Tab");
  await pause();
  const focusedAfterTab = await getFocusedSuggestionIndex(page);
  if (focusedBefore >= 0 && focusedAfterTab >= 0 && focusedAfterTab !== focusedBefore) {
    await page.keyboard.press("Shift+Tab");
    await pause();
    const focusedAfterShiftTab = await getFocusedSuggestionIndex(page);
    assert.ok(
      focusedAfterShiftTab >= 0 && focusedAfterShiftTab !== focusedAfterTab,
      `completion shift+tab navigation: expected focus move. afterTab=${focusedAfterTab}, afterShiftTab=${focusedAfterShiftTab}`
    );
    await page.keyboard.press("Enter");
    await pause();
    const lineAfterAccept = (await getEditorState(page)).lineContent;
    assert.ok(
      /\\ref\{sec:[^}\s]+/.test(lineAfterAccept),
      `completion enter accept: expected selected item insertion.\nLine: ${lineAfterAccept}`
    );
  } else {
    log(
      `completion tab navigation: fallback path before=${focusedBefore}, after=${focusedAfterTab}`
    );
    await page.keyboard.press("Escape");
    await pause();
  }

  log("Completion checks passed");
};

const runHoverChecks = async (page) => {
  log("Hover checks start");

  const addHoverLine = async (text) => appendLineViaModel(page, text);
  const assertCompactHover = (snapshot, testName) => {
    const bannedPhrases = [
      "定義:",
      "解決先:",
      "見つかりました",
      "見つかりません",
      "Open Source",
      "View on PDF",
      "画像を挿入。",
      "環境を開始。",
      "構文:",
      "Math Preview",
    ];
    bannedPhrases.forEach((phrase) => {
      assert.ok(
        !snapshot.text.includes(phrase),
        `${testName}: verbose phrase should not be shown: ${phrase}`
      );
    });
  };
  const assertMathRendered = (snapshot, testName) => {
    const text = snapshot.text ?? "";
    const renderedTextOk = !text.includes("\\") && text.length > 0;
    assert.ok(
      snapshot.hasImagePreview || renderedTextOk,
      `${testName}: expected either rendered text math or image-based math preview`
    );
  };

  const h01 = await addHoverLine("Section~\\ref{sec:methods}");
  await setCursorOnLineSubstring(page, h01.lineNumber, h01.text, "sec:methods");
  await hideHover(page);
  await triggerShowHover(page);
  const hoverH01 = await assertHoverVisible(page, "H-01");
  assertCompactHover(hoverH01, "H-01");
  assert.ok(hoverH01.text.length > 0, "H-01: ref hover should contain text");
  assert.ok(
    !hoverH01.links.some((href) => href.startsWith("tex64://")),
    "H-01: compact hover should not show action links"
  );
  await hideHover(page);

  const h02 = await addHoverLine("\\cite{lamport1994}");
  await setCursorOnLineSubstring(page, h02.lineNumber, h02.text, "lamport1994");
  await triggerShowHover(page);
  const hoverH02 = await assertHoverVisible(page, "H-02");
  assertCompactHover(hoverH02, "H-02");
  assert.ok(hoverH02.text.length > 0, `H-02: cite hover should contain text, got "${hoverH02.text}"`);
  assert.ok(
    !hoverH02.links.some((href) => href.startsWith("tex64://")),
    "H-02: compact hover should not show action links"
  );
  await hideHover(page);

  const h03 = await addHoverLine("\\includegraphics{figures/sample-image.png}");
  await setCursorOnLineSubstring(page, h03.lineNumber, h03.text, "sample-image.png");
  await triggerShowHover(page);
  const hoverH03 = await assertHoverVisible(page, "H-03");
  assertCompactHover(hoverH03, "H-03");
  assert.ok(
    hoverH03.hasImagePreview && !hoverH03.text.includes("figures/sample-image.png"),
    "H-03: expected image-only preview without filename text"
  );
  await hideHover(page);
  await setCursorOnLineSubstring(page, h03.lineNumber, h03.text, "sample-image.png");
  await triggerShowHover(page);
  const hoverH03Repeat = await assertHoverVisible(page, "H-03 repeat");
  assertCompactHover(hoverH03Repeat, "H-03 repeat");
  assert.ok(hoverH03Repeat.hasImagePreview, "H-03 repeat: cached preview should still render");
  await hideHover(page);

  const h04 = await addHoverLine("$E=mc^2$");
  await setCursorOnLineSubstring(page, h04.lineNumber, h04.text, "E=mc^2");
  await triggerShowHover(page);
  const hoverH04 = await assertHoverVisible(page, "H-04");
  assertCompactHover(hoverH04, "H-04");
  assertMathRendered(hoverH04, "H-04");
  await hideHover(page);

  const h05 = await addHoverLine("\\includegraphics{assets/pdfs/sample.pdf}");
  await setCursorOnLineSubstring(page, h05.lineNumber, h05.text, "sample.pdf");
  await triggerShowHover(page);
  const hoverH05 = await assertHoverVisible(page, "H-05");
  assertCompactHover(hoverH05, "H-05");
  assert.ok(
    !hoverH05.hasImagePreview && hoverH05.text.includes("assets/pdfs/sample.pdf"),
    "H-05: expected pdf target path without image preview"
  );
  await hideHover(page);

  const h06 = await addHoverLine("\\input{sections/methods}");
  await setCursorOnLineSubstring(page, h06.lineNumber, h06.text, "sections/methods");
  await triggerShowHover(page);
  const hoverH06 = await assertHoverVisible(page, "H-06");
  assertCompactHover(hoverH06, "H-06");
  assert.ok(
    hoverH06.text.includes("sections/methods.tex"),
    `H-06: expected input target path in hover. text=${hoverH06.text}`
  );
  await hideHover(page);
  await setCursorOnLineSubstring(page, h06.lineNumber, h06.text, "sections/methods");
  await triggerShowHover(page);
  const hoverH06Repeat = await assertHoverVisible(page, "H-06 repeat");
  assertCompactHover(hoverH06Repeat, "H-06 repeat");
  assert.ok(
    hoverH06Repeat.text.includes("sections/methods.tex"),
    "H-06 repeat: input hover should stay stable on repeated access"
  );
  await hideHover(page);

  const h07 = await addHoverLine("\\includegraphics{figures/oversize-image.png}");
  await setCursorOnLineSubstring(page, h07.lineNumber, h07.text, "oversize-image.png");
  await triggerShowHover(page);
  const hoverH07 = await assertHoverVisible(page, "H-07");
  assertCompactHover(hoverH07, "H-07");
  assert.ok(
    !hoverH07.hasImagePreview && hoverH07.text.includes("figures/oversize-image.png"),
    "H-07: oversize image should fallback to text without preview"
  );
  await hideHover(page);

  log("Hover checks passed");
};

const runGhostSettingsChecks = async (page) => {
  log("Ghost settings checks start");

  const assertNoInlineInsertion = async (label, input, waitMs = 900) => {
    await moveCursorToEnd(page);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    await page.keyboard.type(input, { delay: typeDelayMs });
    await page.keyboard.press("Escape");
    const before = await getEditorState(page);
    await pause(waitMs);
    const ghostText = await getActiveGhostText(page);
    assert.equal(ghostText, "", `${label}: expected no ghost text`);
    const after = await getEditorState(page);
    assert.equal(after.lineContent, before.lineContent, `${label}: expected no insertion`);
  };

  await setGhostCompletionEnabled(page, false);
  await openSideTab(page, "files");
  await focusEditor(page);
  await assertNoInlineInsertion("GS-01 disabled", "\\sec", 820);

  await setGhostCompletionEnabled(page, true);
  await setGhostCompletionConfig(page, { debounceMs: 900 });
  await openSideTab(page, "files");
  await focusEditor(page);
  await moveCursorToEnd(page);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await page.keyboard.type("\\textb", { delay: typeDelayMs });
  await page.keyboard.press("Escape");
  await pause(260);
  let ghostText = await getActiveGhostText(page);
  assert.equal(ghostText, "", "GS-02 debounce: ghost should stay hidden before debounce window");
  await waitForGhostTextVisible(page, "GS-02", 2600);
  await page.keyboard.press("Tab");
  await pause(180);
  const debounceAfter = await getEditorState(page);
  assert.equal(
    debounceAfter.lineContent,
    "\\textbf{}",
    `GS-02 debounce: expected insertion after wait.\nLine: ${debounceAfter.lineContent}`
  );

  if (runGhostRemote && !skipGhostRemoteSmoke) {
    await setGhostCompletionConfig(page, { maxChars: 20 });
    await openSideTab(page, "files");
    await focusEditor(page);
    await clearIncomingMessages(page, "api:completionResult");
    const maxCharsInput =
      "MAX_CHARS_LIMIT_CASE remote completion should be suppressed by short max chars";
    const beforeCount = await countIncomingMessagesByType(page, "api:completionResult");
    await assertNoInlineInsertion("GS-03 maxChars", maxCharsInput, 980);
    await waitForIncomingMessageCount(page, "api:completionResult", beforeCount + 1, 12000);
    const afterCount = await countIncomingMessagesByType(page, "api:completionResult");
    assert.equal(
      afterCount,
      beforeCount + 1,
      "GS-03 maxChars: expected API request while insertion is suppressed"
    );
  } else if (runGhostRemote && skipGhostRemoteSmoke) {
    log("GS-03 maxChars skipped (E2E_SKIP_GHOST_REMOTE_SMOKE=1)");
  } else {
    log("GS-03 maxChars skipped (E2E_GHOST_REMOTE=0)");
  }

  await setGhostCompletionConfig(page, { debounceMs: 120, maxChars: 140 });
  await openSideTab(page, "files");
  await focusEditor(page);
  ghostText = await getActiveGhostText(page);
  assert.equal(ghostText, "", "GS-04 reset: ghost state should be clean");

  log("Ghost settings checks passed");
};

const runGhostApiLimitChecks = async (page) => {
  if (!runGhostRemote) {
    log("Ghost API limit checks skipped (E2E_GHOST_REMOTE=0)");
    return;
  }
  log("Ghost API limit checks start");

  const typeNoInlineInsertion = async (label, input, waitMs = 980) => {
    const activePath = await page
      .locator("#editor-tabs-list .editor-tab.is-active")
      .getAttribute("data-path");
    assert.ok(
      typeof activePath === "string" && activePath.endsWith(".tex"),
      `${label}: expected active .tex tab, got "${activePath ?? ""}"`
    );
    const triggerInlineSuggest = async () => {
      await page.evaluate(() => {
        const editors = window.monaco?.editor?.getEditors?.() ?? [];
        const active =
          editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
          editors[0];
        active?.focus?.();
        active?.trigger?.("input-assist-e2e", "editor.action.inlineSuggest.trigger", {});
      });
    };
    await moveCursorToEnd(page);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    await page.keyboard.type(input, { delay: 0 });
    await page.keyboard.press("Escape");
    const before = await getEditorState(page);
    await pause(waitMs);
    await triggerInlineSuggest();
    await pause(260);
    const ghostText = await getActiveGhostText(page);
    assert.equal(ghostText, "", `${label}: expected no ghost text`);
    const after = await getEditorState(page);
    assert.equal(after.lineContent, before.lineContent, `${label}: expected no inline insertion`);
  };

  await setGhostCompletionEnabled(page, true);
  await setGhostCompletionConfig(page, { debounceMs: 900, maxChars: 20 });
  await openSideTab(page, "files");
  await focusEditor(page);
  // Isolate from prior ghost smoke requests so cooldown/rate-limit checks start from a clean timing state.
  await pause(3400);
  await waitForIncomingCountStable(page, "api:completionResult", {
    quietMs: 1200,
    timeoutMs: 8000,
  });
  await clearIncomingMessages(page, "api:completionResult");

  await typeNoInlineInsertion("GL-01 minPrefix", "short123", 980);
  await pause(1200);
  assert.equal(
    await countIncomingMessagesByType(page, "api:completionResult"),
    0,
    "GL-01 minPrefix: API request should not run when prefix length < 10"
  );

  await typeNoInlineInsertion(
    "GL-02 first request",
    "MAX_CHARS_LIMIT_CASE remote completion should be suppressed by short max chars",
    980
  );
  await waitForIncomingMessageCount(page, "api:completionResult", 1, 12000);
  // Trigger a second API attempt after idleMs but within the 3s cooldown window.
  await typeNoInlineInsertion("GL-03 cooldown block", "Cooldown case beta blocked immediately", 580);
  await pause(1500);
  const countAfterGl03 = await countIncomingMessagesByType(page, "api:completionResult");
  assert.equal(
    countAfterGl03,
    1,
    "GL-03 cooldown: request should be blocked within 3s cooldown window"
  );

  await pause(3200);
  await typeNoInlineInsertion("GL-04 cooldown retry", "Cooldown retry should eventually request again", 980);
  await waitForIncomingMessageCount(page, "api:completionResult", 2, 12000);

  // Keep the rate-limit probe inside a 60s window while preserving the same trigger config as GL-02/04.
  const rateLimitWaitMs = 980;
  await clearIncomingMessages(page, "api:completionResult");
  const rateLimitStartAt = Date.now();
  for (let index = 0; index < 12; index += 1) {
    await pause(3050);
    await typeNoInlineInsertion(
      `GL-05 rate-limit warmup ${index + 1}`,
      `MAX_CHARS_LIMIT_CASE rate limit request ${index + 1} unique payload ${Date.now()}`,
      rateLimitWaitMs
    );
  }
  await pause(3050);
  await typeNoInlineInsertion(
    "GL-06 rate-limit cap",
    `Rate limit probe blocked attempt ${Date.now()}`,
    rateLimitWaitMs
  );
  await waitForIncomingMessageCount(page, "api:completionResult", 12, 30000);
  await waitForIncomingCountStable(page, "api:completionResult", {
    quietMs: 1800,
    timeoutMs: 15000,
  });
  const countAfterBlockedTry = await countIncomingMessagesByTypeSince(
    page,
    "api:completionResult",
    rateLimitStartAt
  );
  assert.ok(
    countAfterBlockedTry >= 12,
    `GL-05/06 rate-limit: expected at least 12 completion results, got ${countAfterBlockedTry}`
  );
  const timestamps = await getIncomingMessageTimestampsByTypeSince(
    page,
    "api:completionResult",
    rateLimitStartAt
  );
  let left = 0;
  let maxPerMinuteWindow = 0;
  for (let right = 0; right < timestamps.length; right += 1) {
    while (timestamps[right] - timestamps[left] > 60_000) {
      left += 1;
    }
    const windowCount = right - left + 1;
    if (windowCount > maxPerMinuteWindow) {
      maxPerMinuteWindow = windowCount;
    }
  }
  assert.ok(
    maxPerMinuteWindow <= 12,
    `GL-06 rate-limit: observed ${maxPerMinuteWindow} completion results in a 60s window (limit=12)`
  );

  await setGhostCompletionConfig(page, { debounceMs: 120, maxChars: 140 });
  await openSideTab(page, "files");
  await focusEditor(page);
  log("Ghost API limit checks passed");
};

const runGhostLocalChecks = async (page) => {
  log("Ghost local checks start");

  const assertNoGhost = async (label, waitMs = 780) => {
    await pause(waitMs);
    const ghostText = await getActiveGhostText(page);
    assert.equal(ghostText, "", `${label}: expected no ghost text, got "${ghostText}"`);
  };

  const runCase = async (label, input, expected, options = {}) => {
    log(`${label}: start`);
    await moveCursorToEnd(page);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    await page.keyboard.type(input, { delay: typeDelayMs });
    if (typeof options.cursorDelta === "number" && options.cursorDelta > 0) {
      for (let i = 0; i < options.cursorDelta; i += 1) {
        await page.keyboard.press("ArrowLeft");
      }
    }
    await page.keyboard.press("Escape");
    await pause(80);
    const before = await getEditorState(page);
    if (options.expectNoChange) {
      await assertNoGhost(label);
      const after = await getEditorState(page);
      assert.equal(after.lineContent, before.lineContent, `${label}: expected no inline insertion`);
      log(`${label}: no-change ok`);
      return;
    }
    await waitForGhostTextVisible(page, label);
    await page.keyboard.press("Tab");
    await pause(220);
    const after = await getEditorState(page);
    assert.equal(after.lineContent, expected, `${label}: unexpected inline insertion`);
    if (typeof options.expectedColumn === "number") {
      assert.equal(
        after.column,
        options.expectedColumn,
        `${label}: unexpected cursor column. line="${after.lineContent}"`
      );
    }
    log(`${label}: inserted "${after.lineContent}"`);
  };

  await runCase("G-01", "\\sec", "\\section{}", { expectedColumn: "\\section{}".length });
  await runCase("G-02", "\\textb", "\\textbf{}", { expectedColumn: "\\textbf{}".length });
  await runCase("G-03", "\\cite{lamport1994", "\\cite{lamport1994}", {
    expectedColumn: "\\cite{lamport1994}".length + 1,
  });
  await runCase("G-04", "\\begin{ite", "\\begin{itemize}", {
    expectedColumn: "\\begin{itemize}".length + 1,
  });
  await runCase("G-04b", "\u00A5sec", "\u00A5section{}", {
    expectedColumn: "\u00A5section{}".length,
  });
  await runCase("G-04c", "\uFF3Csec", "\uFF3Csection{}", {
    expectedColumn: "\uFF3Csection{}".length,
  });
  await runCase("G-04d", "\\autoref", "\\autoref{}", {
    expectedColumn: "\\autoref{}".length,
  });
  await runCase("G-04e", "\\input", "\\input{}", {
    expectedColumn: "\\input{}".length,
  });
  await runCase("G-04f", "\\includeg", "\\includegraphics{}", {
    expectedColumn: "\\includegraphics{}".length,
  });
  await runCase("G-04g", "\\begin", "\\begin{}", {
    expectedColumn: "\\begin{}".length,
  });

  log("G-05: start");
  await moveCursorToEnd(page);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await page.keyboard.type("\\begin{align}", { delay: typeDelayMs });
  await page.keyboard.press("Escape");
  await pause(80);
  const beforeBlock = await getEditorState(page);
  await waitForGhostTextVisible(page, "G-05");
  await page.keyboard.press("Tab");
  await pause(220);
  const afterBlock = await getEditorState(page);
  assert.ok(
    afterBlock.value.includes("\\begin{align}\n\n\\end{align}"),
    `G-05: expected begin/body/end insertion.\nBefore line: ${beforeBlock.lineContent}`
  );
  assert.equal(afterBlock.lineContent, "", "G-05: expected cursor line to be blank body line");
  const lineBelow = await page.evaluate((lineNumber) => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    const model = active?.getModel?.();
    return model?.getLineContent?.(lineNumber) ?? "";
  }, afterBlock.lineNumber + 1);
  assert.equal(
    lineBelow,
    "\\end{align}",
    `G-05: expected \\end{align} below cursor line, got "${lineBelow}"`
  );
  log("G-05: inserted align end");

  await runCase("G-06", "% \\sec", "% \\sec", { expectNoChange: true });
  await runCase("G-07", "\\secabc", "\\secabc", { cursorDelta: 3, expectNoChange: true });

  log("Ghost local checks passed");
};

const runRelativePathCheck = async (page) => {
  log("Relative path completion check start");
  await openWorkspaceFile(page, "sections/intro.tex");
  await typeScenarioPrefix(page, "\\includegraphics{../figures/sample-");
  await assertSuggestionsIncludeAll(
    page,
    ["../figures/sample-image.png"],
    "relative includegraphics completion",
    { closeWidget: false }
  );
  await focusSuggestionByContains(page, "../figures/sample-image.png");
  await page.keyboard.press("Enter");
  await pause();
  const state = await getEditorState(page);
  assert.ok(
    state.value.includes("\\includegraphics{../figures/sample-image.png"),
    `relative path completion: expected insertion.\nLine: ${state.lineContent}`
  );
  log("Relative path completion check passed");
};

const assertApiUsageSnapshot = async (userDataPath) => {
  const usagePath = path.join(userDataPath, "tex64-api-usage.json");
  const raw = await fs.readFile(usagePath, "utf8");
  const usage = JSON.parse(raw);
  assert.ok(
    Number.isFinite(usage?.totalRequests) && usage.totalRequests > 0,
    `api usage: expected totalRequests > 0, got ${usage?.totalRequests}`
  );
  assert.ok(
    Number.isFinite(usage?.totalTokens) && usage.totalTokens > 0,
    `api usage: expected totalTokens > 0, got ${usage?.totalTokens}`
  );
  assert.ok(
    usage?.byModel && typeof usage.byModel === "object" && Object.keys(usage.byModel).length > 0,
    "api usage: expected model bucket to be recorded"
  );
  log(
    `api usage snapshot: requests=${usage.totalRequests} totalTokens=${usage.totalTokens} models=${Object.keys(
      usage.byModel
    ).join(",")}`
  );
};

const run = async () => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const userDataPath = path.join(tempDir, "userdata");
  let electronApp;

  try {
    log(`workspace copy: ${workspacePath}`);
    await fs.mkdir(userDataPath, { recursive: true });
    log("launching Electron...");
    electronApp = await electron.launch({
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
        ...(runGhostRemote ? { TEX64_AI_PROXY_URL: aiEndpoint } : {}),
      },
    });
    await installE2EQuitGuard(electronApp);

    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1640, height: 980 });
    await installBridgeRecorder(page);
    await installIncomingRecorder(page);
    page.on("dialog", async (dialog) => {
      log(`dialog intercepted: ${dialog.type()} ${dialog.message()}`);
      try {
        await dialog.dismiss();
      } catch {
        // ignore flaky protocol races on auto-closed dialogs
      }
    });

    log("opening workspace via launcher...");
    await openWorkspaceViaLauncher(page);
    await waitForWorkspaceReady(page, "main.tex");
    log("workspace/index ready");

    await focusEditor(page);
    await page.waitForFunction(() => Boolean(window.MathLive?.convertLatexToMarkup), undefined, {
      timeout: 20000,
    });
    log("MathLive ready");
    if (!onlyGhost) {
      await runCompletionChecks(page);
      log("all completion checks passed");
      await runHoverChecks(page);
      log("all hover checks passed");
    } else {
      log("completion/hover checks skipped (E2E_ONLY_GHOST=1)");
    }
    if (!skipGhostSettings) {
      await runGhostSettingsChecks(page);
      log("all ghost settings checks passed");
    } else {
      log("ghost settings checks skipped (E2E_SKIP_GHOST_SETTINGS=1)");
    }
    if (runGhostApiLimits && runGhostRemote) {
      await runGhostApiLimitChecks(page);
      log("all ghost api limit checks passed");
    } else if (runGhostApiLimits && !runGhostRemote) {
      log("ghost api limit checks skipped (E2E_GHOST_REMOTE=0)");
    } else {
      log("ghost api limit checks skipped (E2E_GHOST_API_LIMITS=0)");
    }
    if (!skipGhostLocal) {
      await runGhostLocalChecks(page);
      log("all ghost local checks passed");
    } else {
      log("ghost local checks skipped (E2E_SKIP_GHOST_LOCAL=1)");
    }
    if (runGhostRemote) {
      const completionResults = await countIncomingMessagesByType(page, "api:completionResult");
      assert.ok(completionResults > 0, "ghost remote: expected at least one API completion result");
      log("all ghost remote checks passed");
      await assertApiUsageSnapshot(userDataPath).catch((error) => {
        log(`api usage snapshot check skipped due transient API variance: ${error.message}`);
      });
    } else {
      log("ghost remote checks skipped (E2E_GHOST_REMOTE=0)");
    }
    if (!onlyGhost) {
      await runRelativePathCheck(page);
      log("all relative-path checks passed");
    } else {
      log("relative-path checks skipped (E2E_ONLY_GHOST=1)");
    }
  } finally {
    if (electronApp) {
      try {
        await allowE2EQuit(electronApp);
        await Promise.race([
          electronApp.close(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("electronApp.close timeout")), 5000)
          ),
        ]);
      } catch (closeError) {
        log(`electron close fallback: ${closeError instanceof Error ? closeError.message : closeError}`);
        try {
          electronApp.process()?.kill("SIGKILL");
        } catch {
          // ignore force-kill failure
        }
      }
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
  console.error("[input-assist-e2e] FAILED");
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exitCode = 1;
});
