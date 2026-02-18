import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
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
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "80", 10);

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => console.log(`[synctex-viewer-e2e ${now()}] ${message}`);
const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const createRequestId = (() => {
  let seq = 0;
  return (prefix = "req") => {
    seq += 1;
    return `${prefix}-${Date.now()}-${seq}`;
  };
})();

const readIntEnv = (name, fallback) => {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
};

const readFloatEnv = (name, fallback) => {
  const value = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(value) ? value : fallback;
};

const createWorkspaceCopy = async (workspaceSourcePath = sourceWorkspace) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-synctex-viewer-"));
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(workspaceSourcePath, workspacePath, { recursive: true });
  return { tempDir, workspacePath };
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

const initBridgeCollector = async (page) => {
  await page.evaluate(() => {
    if (typeof window.__synctexViewerTestMessages === "undefined") {
      window.__synctexViewerTestMessages = [];
    }
    if (window.__synctexViewerBridgeInstalled !== true) {
      window.__synctexViewerBridgeInstalled = true;
      window.tex64Bridge.onMessage((message) => {
        const requestId =
          message?.payload && typeof message.payload === "object"
            ? message.payload.requestId
            : message?.requestId;
        window.__synctexViewerTestMessages.push({
          type: message?.type,
          requestId,
          payload: message?.payload ?? null,
          at: Date.now(),
        });
      });
    }
  });
};

const clearBridgeMessages = async (page, type = null) => {
  await page.evaluate((expectedType) => {
    if (!Array.isArray(window.__synctexViewerTestMessages)) {
      return;
    }
    if (!expectedType) {
      window.__synctexViewerTestMessages.length = 0;
      return;
    }
    window.__synctexViewerTestMessages = window.__synctexViewerTestMessages.filter(
      (item) => item?.type !== expectedType
    );
  }, type);
};

const waitForBridgeMessage = async (
  page,
  type,
  timeoutMs = 25000,
  expectedRequestId = null
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await page.evaluate(
      (params) => {
        const expectedType = params.type;
        const expectedRequestId = params.requestId;
        const messages = window.__synctexViewerTestMessages;
        if (!Array.isArray(messages) || messages.length === 0) {
          return null;
        }
        const index = messages.findIndex((item) => {
          if (!item || item.type !== expectedType) {
            return false;
          }
          if (!expectedRequestId) {
            return true;
          }
          return item.requestId === expectedRequestId;
        });
        if (index === -1) {
          return null;
        }
        const item = messages[index];
        messages.splice(index, 1);
        return { type: item.type, requestId: item.requestId, payload: item.payload };
      },
      { type, requestId: expectedRequestId }
    );
    if (message && message.type === type) {
      return message;
    }
    await page.waitForTimeout(15);
  }
  throw new Error(`Timed out waiting for bridge message: ${type}`);
};

const collectWorkspaceFilesByExtension = async (
  workspacePath,
  extension,
  skipDirs = []
) => {
  const stack = [workspacePath];
  const skipSet = new Set(skipDirs);
  const targets = [];
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
        if (!skipSet.has(entry.name)) {
          stack.push(entryPath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (path.extname(entry.name).toLowerCase() !== extension) {
        continue;
      }
      targets.push(entryPath);
    }
  }
  targets.sort((left, right) => left.localeCompare(right));
  return targets;
};

const fileExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const findSynctexPath = async (workspacePath) => {
  const directCandidates = [
    path.join(workspacePath, "main.synctex.gz"),
    path.join(workspacePath, "build", "main.synctex.gz"),
  ];
  for (const candidate of directCandidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  const discovered = await collectWorkspaceFilesByExtension(workspacePath, ".synctex.gz", [
    ".git",
    ".tex64",
    "node_modules",
    "tmp",
    "build",
  ]);
  return discovered[0] ?? null;
};

const collectTexFiles = async (workspacePath) => {
  return collectWorkspaceFilesByExtension(workspacePath, ".tex", [
    ".git",
    ".tex64",
    "node_modules",
    "build",
    "tmp",
  ]);
};

const collectSynctexInputFiles = async (workspacePath, synctexPath) => {
  if (!synctexPath || !(await fileExists(synctexPath))) {
    return [];
  }
  const workspaceRoot = path.normalize(workspacePath);
  const rawSynctex = await fs.readFile(synctexPath);
  const text = zlib.gunzipSync(rawSynctex).toString("utf8");
  const included = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.startsWith("Input:")) {
      continue;
    }
    const inputRaw = rawLine.slice("Input:".length).trim().replace(/^\\d+:/, "").trim();
    if (!inputRaw) {
      continue;
    }
    const normalizedInput = inputRaw.replace(/^"|"$/g, "");
    const absoluteInput = path.isAbsolute(normalizedInput)
      ? path.normalize(normalizedInput)
      : path.resolve(workspacePath, normalizedInput);
    if (path.extname(absoluteInput).toLowerCase() !== ".tex") {
      continue;
    }
    if (!(await fileExists(absoluteInput))) {
      continue;
    }
    const relative = path.relative(workspaceRoot, absoluteInput);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      continue;
    }
    included.add(path.normalize(absoluteInput));
  }
  return Array.from(included).sort((left, right) => left.localeCompare(right));
};

const isSkippableLine = (lineText) => {
  if (typeof lineText !== "string") return true;
  const trimmed = lineText.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("%")) return true;
  return false;
};

const isStructuralLine = (lineText) => {
  if (typeof lineText !== "string") {
    return false;
  }
  const trimmed = lineText.trim();
  if (!trimmed) return false;
  if (/^\\(?:begin|end|label|caption|centering|toprule|midrule|bottomrule|hline|cline)\b/.test(trimmed)) {
    return true;
  }
  if (/\\\\\s*$/.test(trimmed)) return true;
  if (/(^|[^\\])&/.test(trimmed)) return true;
  if (
    /^\\(?:input|include|subfile|import|includeonly)\b/.test(trimmed) ||
    /^\\(?:begin\{document\}|end\{document\}|documentclass|usepackage|newcommand|renewcommand|maketitle|tableofcontents|listoffigures|listoftables|appendix|bibliography|bibliographystyle|printbibliography)\b/.test(trimmed) ||
    /^\\(?:section|subsection|subsubsection|paragraph|subparagraph)\b/.test(trimmed)
  ) {
    return true;
  }
  return false;
};

const isPureCommandLine = (lineText) => {
  if (typeof lineText !== "string") return true;
  const trimmed = lineText.trim().replace(/%.*$/, "").trim();
  if (!trimmed) return true;
  return /^\\[A-Za-z@*]+(?:\*?)?(?:\s*\[[^\]]*\])?(?:\s*\{[^{}]*\})*$/.test(trimmed);
};

const findColumn = (lineText) => {
  if (typeof lineText !== "string" || !lineText.length) return 1;
  const firstNonSpace = lineText.search(/\S/);
  return firstNonSpace >= 0 ? firstNonSpace + 1 : 1;
};

const pickEvenly = (items, maxItems) => {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  if (!Number.isFinite(maxItems) || maxItems <= 0 || items.length <= maxItems) {
    return items.slice();
  }
  if (maxItems === 1) {
    return [items[Math.floor(items.length / 2)]];
  }
  const selected = [];
  const seen = new Set();
  const step = (items.length - 1) / (maxItems - 1);
  for (let index = 0; index < maxItems; index += 1) {
    const sourceIndex = Math.round(index * step);
    if (sourceIndex < 0 || sourceIndex >= items.length) {
      continue;
    }
    if (!seen.has(sourceIndex)) {
      selected.push(items[sourceIndex]);
      seen.add(sourceIndex);
    }
  }
  for (let fallback = 0; selected.length < Math.min(maxItems, items.length); fallback += 1) {
    if (!seen.has(fallback)) {
      selected.push(items[fallback]);
      seen.add(fallback);
    }
  }
  return selected;
};

const collectSynctexCases = async (
  workspacePath,
  includedSourceFiles,
  { maxLinesPerFile = 0, maxTotalCases = 0 } = {}
) => {
  const sourceFiles = includedSourceFiles.length > 0 ? includedSourceFiles : await collectTexFiles(workspacePath);
  const allCases = [];
  for (const sourcePath of sourceFiles) {
    const rawSource = await fs.readFile(sourcePath, "utf8");
    const lines = rawSource.split(/\r?\n/);
    const fileCandidates = [];
    lines.forEach((lineText, index) => {
      if (isSkippableLine(lineText) || isStructuralLine(lineText) || isPureCommandLine(lineText)) {
        return;
      }
      fileCandidates.push({
        sourcePath,
        relativePath: path.relative(workspacePath, sourcePath).split(path.sep).join("/"),
        lineNumber: index + 1,
        column: findColumn(lineText),
      });
    });
    allCases.push(...pickEvenly(fileCandidates, maxLinesPerFile));
  }
  return pickEvenly(allCases, maxTotalCases);
};

const setPdfViewerMode = async (page, mode) => {
  await page.evaluate((viewerMode) => {
    const checkbox = document.getElementById("editor-pdf-window");
    if (checkbox instanceof HTMLInputElement) {
      checkbox.checked = viewerMode === "window";
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    }
    localStorage.setItem("tex64.editor.pdfViewerMode", viewerMode);
  }, mode);
  await pause(140);
};

const closeAuxWindows = async (app, mainPage) => {
  for (const win of app.windows()) {
    if (win !== mainPage) {
      await win.close().catch(() => {});
    }
  }
};

const getVisibleTabViewerFrame = async (page) => {
  await page.waitForFunction(
    () => {
      const visible = (id) => {
        const el = document.getElementById(id);
        if (!(el instanceof HTMLIFrameElement)) return false;
        const style = window.getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden" && el.offsetParent !== null;
      };
      return visible("editor-viewer-pdf") || visible("editor-viewer-pdf-secondary");
    },
    undefined,
    { timeout: 20000 }
  );
  const selector = await page.evaluate(() => {
    const visible = (id) => {
      const el = document.getElementById(id);
      if (!(el instanceof HTMLIFrameElement)) return false;
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && el.offsetParent !== null;
    };
    return visible("editor-viewer-pdf-secondary") ? "#editor-viewer-pdf-secondary" : "#editor-viewer-pdf";
  });
  const frame = await (await page.$(selector))?.contentFrame();
  if (!frame) {
    throw new Error("tab pdf iframe not found");
  }
  return frame;
};

const waitViewerSynced = async (targetPage, forwardPayload) => {
  await targetPage.waitForFunction(
    (payload) => {
      const state = window.__tex64PdfViewer?.state;
      if (!state || !state.lastSync) {
        return false;
      }
      const last = state.lastSync;
      if (last.page !== payload.page) {
        return false;
      }
      const dx = Math.abs(Number(last.x) - Number(payload.x));
      const dy = Math.abs(Number(last.y) - Number(payload.y));
      return dx < 0.5 && dy < 0.5;
    },
    { page: forwardPayload.page, x: forwardPayload.x, y: forwardPayload.y },
    { timeout: 20000 }
  );
  await targetPage.waitForSelector(".pdf-sync-marker", { timeout: 20000 });
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
      return { ok: false, reason: "target-missing", centerX, centerY };
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

const runMode = async ({ mode, app, mainPage, cases, timeoutMs, lineTolerance }) => {
  await closeAuxWindows(app, mainPage);
  await setPdfViewerMode(mainPage, mode);
  await clearBridgeMessages(mainPage);

  const results = [];
  for (const item of cases) {
    const requestId = createRequestId(`${mode}-forward`);
    const hadPdfWindow = app.windows().some((win) => win !== mainPage);
    const waitWindow =
      mode === "window" && !hadPdfWindow
        ? app.waitForEvent("window", { timeout: 20000 }).catch(() => null)
        : null;

    await postToBridge(mainPage, {
      type: "synctex:forward",
      requestId,
      path: item.relativePath,
      line: item.lineNumber,
      column: item.column,
      fallbackToTop: false,
      pdfViewerMode: mode,
    });
    const forwardEnvelope = await waitForBridgeMessage(
      mainPage,
      "synctex:forwardResult",
      timeoutMs,
      requestId
    );
    const forwardResult = forwardEnvelope?.payload ?? null;
    if (!forwardResult || forwardResult.ok !== true) {
      results.push({
        ...item,
        mode,
        forwardOk: false,
        reverseOk: false,
        exact: false,
        reason: forwardResult?.error ?? "forward failed",
      });
      continue;
    }

    let viewerPage = null;
    if (mode === "tab") {
      viewerPage = await getVisibleTabViewerFrame(mainPage);
    } else {
      let pdfWindow = app.windows().find((win) => win !== mainPage) ?? null;
      if (!pdfWindow && waitWindow) {
        pdfWindow = await waitWindow;
      }
      if (!pdfWindow) {
        results.push({
          ...item,
          mode,
          forwardOk: true,
          reverseOk: false,
          exact: false,
          reason: "pdf window not found",
        });
        continue;
      }
      await pdfWindow.waitForLoadState("domcontentloaded");
      viewerPage = pdfWindow;
    }

    try {
      await waitViewerSynced(viewerPage, forwardResult);
    } catch {
      results.push({
        ...item,
        mode,
        forwardOk: true,
        reverseOk: false,
        exact: false,
        reason: "viewer sync marker timeout",
      });
      continue;
    }
    await clearBridgeMessages(mainPage, "synctex:reverseResult");
    const clickResult = await triggerReverseFromMarker(viewerPage);
    if (!clickResult?.ok) {
      results.push({
        ...item,
        mode,
        forwardOk: true,
        reverseOk: false,
        exact: false,
        reason: clickResult?.reason ?? "reverse trigger failed",
      });
      continue;
    }

    let reverseEnvelope = null;
    try {
      reverseEnvelope = await waitForBridgeMessage(
        mainPage,
        "synctex:reverseResult",
        timeoutMs
      );
    } catch {
      reverseEnvelope = null;
    }
    const reverseResult = reverseEnvelope?.payload ?? null;
    if (!reverseResult || reverseResult.ok !== true) {
      results.push({
        ...item,
        mode,
        forwardOk: true,
        reverseOk: false,
        exact: false,
        reason: reverseResult?.error ?? "reverse failed or timed out",
      });
      continue;
    }
    const samePath = reverseResult.path === item.relativePath;
    const lineDiff =
      Number.isFinite(reverseResult.line) && Number.isFinite(item.lineNumber)
        ? Math.abs(reverseResult.line - item.lineNumber)
        : Number.POSITIVE_INFINITY;
    const pass = samePath && lineDiff <= lineTolerance;
    const exact = samePath && lineDiff === 0;
    results.push({
      ...item,
      mode,
      forwardOk: true,
      reverseOk: true,
      samePath,
      lineDiff,
      pass,
      exact,
    });
  }
  return results;
};

const run = async () => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  let electronApp;

  const maxLinesPerFile = readIntEnv("E2E_SYNCTEX_MAX_LINES_PER_FILE", 8);
  const maxTotalCases = readIntEnv("E2E_SYNCTEX_MAX_CASES", 20);
  const timeoutMs = readIntEnv("E2E_SYNCTEX_BRIDGE_TIMEOUT_MS", 30000);
  const lineTolerance = readIntEnv("E2E_SYNCTEX_LINE_TOLERANCE", 0);
  const minPassRate = readFloatEnv("E2E_SYNCTEX_MIN_PASS", 1);
  const minExactRate = readFloatEnv("E2E_SYNCTEX_MIN_EXACT", 1);

  try {
    await cleanupBuildArtifacts(workspacePath);
    log(`workspace copy: ${workspacePath}`);
    electronApp = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      env: { ...process.env },
    });
    const mainPage = await electronApp.firstWindow();
    await mainPage.setViewportSize({ width: 1680, height: 980 });

    await initBridgeCollector(mainPage);
    await postToBridge(mainPage, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(mainPage);
    await postToBridge(mainPage, { type: "build" });
    await waitForBuildIdle(mainPage);
    await pause(220);

    const synctexPath = await findSynctexPath(workspacePath);
    assert.ok(synctexPath, "SyncTeX output not found after build");
    const synctexInputs = await collectSynctexInputFiles(workspacePath, synctexPath);
    const cases = await collectSynctexCases(workspacePath, synctexInputs, {
      maxLinesPerFile,
      maxTotalCases,
    });
    assert.ok(cases.length > 0, "no synctex cases collected for viewer-mode test");
    log(`testing ${cases.length} cases across modes: tab + window`);

    const modeResults = [];
    for (const mode of ["tab", "window"]) {
      const results = await runMode({
        mode,
        app: electronApp,
        mainPage,
        cases,
        timeoutMs,
        lineTolerance,
      });
      modeResults.push(...results);
      const forwardFailCount = results.filter((item) => item.forwardOk === false).length;
      const reverseFailCount = results.filter((item) => item.forwardOk && item.reverseOk === false).length;
      const passCount = results.filter((item) => item.pass === true).length;
      const exactCount = results.filter((item) => item.exact === true).length;
      const passRate = results.length > 0 ? passCount / results.length : 0;
      const exactRate = results.length > 0 ? exactCount / results.length : 0;
      log(
        `mode=${mode} total=${results.length} pass=${passCount} exact=${exactCount} ` +
          `forwardFail=${forwardFailCount} reverseFail=${reverseFailCount}`
      );
      log(`mode=${mode} rates: pass=${passRate.toFixed(4)} exact=${exactRate.toFixed(4)}`);

      const failed = results.filter((item) => item.pass !== true);
      if (failed.length > 0) {
        log(`mode=${mode} failed (${failed.length}):`);
        failed.slice(0, 40).forEach((item) => {
          const reason = item.reason ?? `lineDiff=${item.lineDiff}`;
          log(`- ${item.relativePath}:${item.lineNumber} ${reason}`);
        });
      }

      assert.strictEqual(forwardFailCount, 0, `mode=${mode} forward failures detected`);
      assert.strictEqual(reverseFailCount, 0, `mode=${mode} reverse failures detected`);
      assert.ok(passRate >= minPassRate, `mode=${mode} passRate ${passRate.toFixed(4)} < ${minPassRate.toFixed(4)}`);
      assert.ok(exactRate >= minExactRate, `mode=${mode} exactRate ${exactRate.toFixed(4)} < ${minExactRate.toFixed(4)}`);
      assert.strictEqual(failed.length, 0, `mode=${mode} has non-pass cases (${failed.length})`);
    }

    const total = modeResults.length;
    const totalExact = modeResults.filter((item) => item.exact === true).length;
    log(`overall exact=${totalExact}/${total}`);
  } finally {
    if (electronApp) {
      await electronApp.close();
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
