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
  "synctex-element-matrix"
);
const sourceWorkspace =
  process.env.E2E_SYNCTEX_SOURCE_WORKSPACE && process.env.E2E_SYNCTEX_SOURCE_WORKSPACE.trim()
    ? path.isAbsolute(process.env.E2E_SYNCTEX_SOURCE_WORKSPACE.trim())
      ? process.env.E2E_SYNCTEX_SOURCE_WORKSPACE.trim()
      : path.join(repoRoot, process.env.E2E_SYNCTEX_SOURCE_WORKSPACE.trim())
    : defaultFixtureWorkspace;

const keepWorkspace = process.env.E2E_KEEP_WORKSPACE === "1";
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "100", 10);
const debugCaseId = (process.env.E2E_SYNCTEX_DEBUG_CASE ?? "").trim();

const requiredCategoriesDefault = [
  "section",
  "text",
  "math",
  "ref",
  "list",
  "theorem",
  "proof",
  "table",
  "figure",
  "code",
  "url",
  "footnote",
  "cite",
  "appendix",
].join(",");

const markerOnlyCaseIds = new Set(["figure.box"]);
const reverseTextClickXRatioByCase = Object.freeze({
  "appendix.section": 0.1,
  "appendix.text": 0.3,
  "cite.bibitem": 0.2,
  "cite.inline": 0.12,
  "code.inline": 0.1,
  "code.verbatim": 0.1,
  "figure.caption": 0.05,
  "footnote.anchor": 0.1,
  "list.description": 0.1,
  "list.enumerate": 0.1,
  "list.itemize": 0.1,
  "math.align_second": 0.5,
  "math.equation": 0.5,
  "math.inline": 0.1,
  "proof.body": 0.1,
  "ref.cross": 0.35,
  "section.heading": 0.1,
  "section.subheading": 0.1,
  "table.caption": 0.12,
  "table.header": 0.1,
  "table.row": 0.2,
  "text.paragraph": 0.1,
  "theorem.body": 0.12,
  "url.inline": 0.1,
});
const reverseLineToleranceByCase = Object.freeze({
  "cite.bibitem": 1,
  "math.align_second": 1,
  "math.equation": 1,
});
const reverseTextClickPageByCase = Object.freeze({
  "appendix.section": 2,
  "appendix.text": 2,
  "cite.bibitem": 2,
  "figure.caption": 2,
});
const reverseTextAnchorsByCase = Object.freeze({
  "appendix.section": ["Appendix Coverage"],
  "appendix.text": ["Appendix text remains bidirectional."],
  "cite.bibitem": [". 2026.", "2026.", "Reference Entry"],
  "cite.inline": ["A citation appears here [1]."],
  "code.inline": ["const answer = 42;"],
  "code.verbatim": ["const meaning = 42;"],
  "figure.caption": ["Figure 1: Caption text for the figure target."],
  "footnote.anchor": ["A sentence with a footnote marker"],
  "list.description": ["Description entry with stable wording."],
  "list.enumerate": ["Enumerate entry with stable wording."],
  "list.itemize": ["Itemize entry with stable wording."],
  "math.align_second": ["(3)", "+ 2"],
  "math.equation": ["(1)", "mc"],
  "math.inline": ["This line includes inline math"],
  "proof.body": ["A positive value multiplied by itself stays positive."],
  "ref.cross": ["Equation 1."],
  "section.heading": ["Section Heading Coverage"],
  "section.subheading": ["Display Math Coverage"],
  "table.caption": ["Table 1: Caption text for the table target."],
  "table.header": ["Name", "Value"],
  "table.row": ["alpha"],
  "text.paragraph": ["This paragraph validates plain prose mapping."],
  "theorem.body": ["Theorem 1.", "If"],
  "url.inline": ["https://example.com/tex64/", "synctex"],
});

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => console.log(`[synctex-ui-matrix-e2e ${now()}] ${message}`);
const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const readIntEnv = (name, fallback) => {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
};

const readFloatEnv = (name, fallback) => {
  const value = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(value) ? value : fallback;
};

const createWorkspaceCopy = async (workspaceSourcePath = sourceWorkspace) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-synctex-ui-matrix-"));
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
    if (typeof window.__synctexUiMatrixMessages === "undefined") {
      window.__synctexUiMatrixMessages = [];
    }
    if (window.__synctexUiMatrixInstalled !== true) {
      window.__synctexUiMatrixInstalled = true;
      window.tex64Bridge.onMessage((message) => {
        const requestId =
          message?.payload && typeof message.payload === "object"
            ? message.payload.requestId
            : message?.requestId;
        window.__synctexUiMatrixMessages.push({
          type: message?.type,
          requestId,
          payload: message?.payload ?? null,
          at: Date.now(),
        });
      });
    }
    if (typeof window.__synctexUiMatrixPostedMessages === "undefined") {
      window.__synctexUiMatrixPostedMessages = [];
    }
    if (window.__synctexUiMatrixPostInstalled !== true) {
      window.__synctexUiMatrixPostInstalled = true;
      const bridge = window.tex64Bridge;
      if (bridge && typeof bridge.postMessage === "function") {
        const originalPostMessage = bridge.postMessage.bind(bridge);
        bridge.postMessage = (...args) => {
          const payload = args[0];
          const requestId =
            payload && typeof payload === "object" ? payload.requestId : null;
          window.__synctexUiMatrixPostedMessages.push({
            type: payload?.type ?? null,
            requestId: typeof requestId === "string" ? requestId : null,
            payload: payload ?? null,
            at: Date.now(),
          });
          return originalPostMessage(...args);
        };
      }
    }
    if (typeof window.__synctexUiMatrixViewerMessages === "undefined") {
      window.__synctexUiMatrixViewerMessages = [];
    }
    if (window.__synctexUiMatrixViewerInstalled !== true) {
      window.__synctexUiMatrixViewerInstalled = true;
      window.addEventListener("message", (event) => {
        const data = event?.data;
        if (!data || data.source !== "tex64-pdf") {
          return;
        }
        const payload = data.payload;
        if (!payload || typeof payload.type !== "string") {
          return;
        }
        window.__synctexUiMatrixViewerMessages.push({
          type: payload.type,
          payload: payload.payload ?? null,
          at: Date.now(),
        });
      });
    }
  });
};

const clearBridgeMessages = async (page, type = null) => {
  await page.evaluate((targetType) => {
    if (!Array.isArray(window.__synctexUiMatrixMessages)) {
      return;
    }
    if (!targetType) {
      window.__synctexUiMatrixMessages.length = 0;
      return;
    }
    window.__synctexUiMatrixMessages = window.__synctexUiMatrixMessages.filter(
      (item) => item?.type !== targetType
    );
  }, type);
};

const clearPostedMessages = async (page, type = null) => {
  await page.evaluate((targetType) => {
    if (!Array.isArray(window.__synctexUiMatrixPostedMessages)) {
      return;
    }
    if (!targetType) {
      window.__synctexUiMatrixPostedMessages.length = 0;
      return;
    }
    window.__synctexUiMatrixPostedMessages = window.__synctexUiMatrixPostedMessages.filter(
      (item) => item?.type !== targetType
    );
  }, type);
};

const waitForBridgeMessage = async (page, type, timeoutMs = 25000, expectedRequestId = null) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await page.evaluate((params) => {
      const messages = window.__synctexUiMatrixMessages;
      if (!Array.isArray(messages) || messages.length === 0) {
        return null;
      }
      const index = messages.findIndex((item) => {
        if (item?.type !== params.type) {
          return false;
        }
        if (!params.requestId) {
          return true;
        }
        return item?.requestId === params.requestId;
      });
      if (index === -1) {
        return null;
      }
      const item = messages[index];
      messages.splice(index, 1);
      return { type: item.type, requestId: item.requestId ?? null, payload: item.payload };
    }, { type, requestId: expectedRequestId });
    if (message && message.type === type) {
      return message;
    }
    await page.waitForTimeout(15);
  }
  throw new Error(
    expectedRequestId
      ? `Timed out waiting for bridge message: ${type} requestId=${expectedRequestId}`
      : `Timed out waiting for bridge message: ${type}`
  );
};

const waitForPostedMessage = async (
  page,
  type,
  timeoutMs = 8000,
  expectedSource = null
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await page.evaluate((params) => {
      const messages = window.__synctexUiMatrixPostedMessages;
      if (!Array.isArray(messages) || messages.length === 0) {
        return null;
      }
      const index = messages.findIndex((item) => {
        if (item?.type !== params.type) {
          return false;
        }
        if (!params.source) {
          return true;
        }
        const source =
          item?.payload && typeof item.payload === "object" ? item.payload.source : null;
        return source === params.source;
      });
      if (index === -1) {
        return null;
      }
      const item = messages[index];
      messages.splice(index, 1);
      return {
        type: item.type,
        requestId: typeof item.requestId === "string" ? item.requestId : null,
        payload: item.payload,
      };
    }, { type, source: expectedSource });
    if (message && message.type === type) {
      return message;
    }
    await page.waitForTimeout(15);
  }
  throw new Error(`Timed out waiting for posted message: ${type}`);
};

const clearViewerMessages = async (page, type = null) => {
  await page.evaluate((targetType) => {
    if (!Array.isArray(window.__synctexUiMatrixViewerMessages)) {
      return;
    }
    if (!targetType) {
      window.__synctexUiMatrixViewerMessages.length = 0;
      return;
    }
    window.__synctexUiMatrixViewerMessages = window.__synctexUiMatrixViewerMessages.filter(
      (item) => item?.type !== targetType
    );
  }, type);
};

const waitForViewerMessage = async (page, type, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await page.evaluate((expectedType) => {
      const queue = window.__synctexUiMatrixViewerMessages;
      if (!Array.isArray(queue) || queue.length === 0) {
        return null;
      }
      const index = queue.findIndex((item) => item?.type === expectedType);
      if (index === -1) {
        return null;
      }
      const hit = queue[index];
      queue.splice(index, 1);
      return hit?.payload ?? null;
    }, type);
    if (message) {
      return message;
    }
    await page.waitForTimeout(15);
  }
  throw new Error(`Timed out waiting for viewer message: ${type}`);
};

const collectTexFiles = async (workspacePath) => {
  const stack = [workspacePath];
  const skipDirs = new Set([".git", ".tex64", "node_modules", "build", "tmp"]);
  const files = [];
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
      if (path.extname(entry.name).toLowerCase() !== ".tex") {
        continue;
      }
      files.push(entryPath);
    }
  }
  files.sort((left, right) => left.localeCompare(right));
  return files;
};

const findFirstContentLine = (lines, startIndex, direction) => {
  for (let index = startIndex; index >= 0 && index < lines.length; index += direction) {
    const candidate = lines[index] ?? "";
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.startsWith("%")) {
      continue;
    }
    return index;
  }
  return null;
};

const findColumn = (lineText) => {
  if (typeof lineText !== "string" || lineText.length === 0) {
    return 1;
  }
  const firstNonSpace = lineText.search(/\S/);
  return firstNonSpace >= 0 ? firstNonSpace + 1 : 1;
};

const collectTaggedCases = async (workspacePath) => {
  const markerPattern = /%+\s*SYNC_CASE:\s*([A-Za-z0-9][A-Za-z0-9_.-]*)/;
  const sourceFiles = await collectTexFiles(workspacePath);
  const cases = [];
  const seenIds = new Set();

  for (const sourcePath of sourceFiles) {
    const rawSource = await fs.readFile(sourcePath, "utf8");
    const lines = rawSource.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const lineText = lines[index] ?? "";
      const markerMatch = lineText.match(markerPattern);
      if (!markerMatch) {
        continue;
      }
      const id = markerMatch[1];
      if (seenIds.has(id)) {
        throw new Error(`duplicate SYNC_CASE id: ${id}`);
      }
      seenIds.add(id);

      const markerIndex = markerMatch.index ?? lineText.length;
      const visibleSource = lineText.slice(0, markerIndex);
      let targetLineIndex = index;
      let targetLineText = visibleSource;
      if (!visibleSource.trim()) {
        const nextIndex = findFirstContentLine(lines, index + 1, 1);
        if (nextIndex !== null) {
          targetLineIndex = nextIndex;
          targetLineText = lines[nextIndex];
        } else {
          const prevIndex = findFirstContentLine(lines, index - 1, -1);
          if (prevIndex !== null) {
            targetLineIndex = prevIndex;
            targetLineText = lines[prevIndex];
          }
        }
      }

      const lineNumber = targetLineIndex + 1;
      const category = id.includes(".") ? id.slice(0, id.indexOf(".")) : id;
      cases.push({
        id,
        category,
        sourcePath,
        relativePath: path.relative(workspacePath, sourcePath).split(path.sep).join("/"),
        lineNumber,
        column: findColumn(targetLineText),
        markerLine: index + 1,
      });
    }
  }

  cases.sort((left, right) => left.id.localeCompare(right.id));
  return cases;
};

const parseRequiredCategories = () => {
  const raw = process.env.E2E_SYNCTEX_REQUIRED_CATEGORIES ?? requiredCategoriesDefault;
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
};

const parseModes = () => {
  const allowed = new Set(["tab", "window"]);
  const raw = (process.env.E2E_SYNCTEX_MODES ?? "tab,window")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const modes = raw.filter((value) => allowed.has(value));
  if (modes.length === 0) {
    return ["tab", "window"];
  }
  return Array.from(new Set(modes));
};

const filterCases = (cases) => {
  const filterPattern = (process.env.E2E_SYNCTEX_CASE_FILTER ?? "").trim();
  const caseLimit = readIntEnv("E2E_SYNCTEX_CASE_LIMIT", 0);

  let filtered = cases;
  if (filterPattern) {
    const pattern = new RegExp(filterPattern);
    filtered = filtered.filter((item) => pattern.test(item.id));
  }
  if (caseLimit > 0) {
    filtered = filtered.slice(0, caseLimit);
  }
  return filtered;
};

const hasTextAnchor = (caseId) => Array.isArray(reverseTextAnchorsByCase[caseId]);
const resolveCaseLineTolerance = (caseId, defaultTolerance) => {
  const override = Number(reverseLineToleranceByCase[caseId]);
  if (Number.isFinite(override) && override >= 0) {
    return Math.floor(override);
  }
  return defaultTolerance;
};

const validateReverseClickCoverage = (cases, requiredCategories, enforceCategoryCoverage = true) => {
  const missingCaseAnchors = cases
    .filter((item) => !markerOnlyCaseIds.has(item.id))
    .filter((item) => !hasTextAnchor(item.id))
    .map((item) => item.id)
    .sort((left, right) => left.localeCompare(right));
  assert.strictEqual(
    missingCaseAnchors.length,
    0,
    `text anchor not configured for cases: ${missingCaseAnchors.join(", ")}`
  );

  if (!enforceCategoryCoverage) {
    return;
  }

  const categoriesWithTextClick = new Set(
    cases.filter((item) => hasTextAnchor(item.id)).map((item) => item.category)
  );
  const missingCategoryCoverage = requiredCategories
    .filter((category) => !categoriesWithTextClick.has(category))
    .sort((left, right) => left.localeCompare(right));
  assert.strictEqual(
    missingCategoryCoverage.length,
    0,
    `no text-click coverage for categories: ${missingCategoryCoverage.join(", ")}`
  );
};

const setRuntimeToggles = async (page, mode) => {
  await page.evaluate((viewerMode) => {
    const clickIfDifferent = (id, expectedChecked) => {
      const input = document.getElementById(id);
      if (!(input instanceof HTMLInputElement)) {
        return false;
      }
      if (input.checked !== expectedChecked) {
        input.click();
      }
      return input.checked === expectedChecked;
    };
    clickIfDifferent("editor-auto-synctex-build", false);
    clickIfDifferent("editor-reverse-synctex", true);
    clickIfDifferent("editor-pdf-window", viewerMode === "window");
  }, mode);
  await pause(150);
};

const focusEditor = async (page) => {
  await page.waitForSelector("#editor .monaco-editor", { timeout: 15000 });
  await page.click("#editor .monaco-editor", { position: { x: 140, y: 92 } });
  await page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    active?.focus?.();
  });
  await pause(80);
};

const resolveEditorClickPoint = async (page, lineNumber, column) => {
  return page.evaluate((payload) => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    if (!active?.getModel || !active?.getDomNode) {
      return { ok: false, reason: "editor-missing" };
    }
    const model = active.getModel();
    const maxLine = model?.getLineCount?.() ?? 1;
    const safeLine = Math.max(1, Math.min(maxLine, Number(payload.lineNumber) || 1));
    const maxColumn = model?.getLineMaxColumn?.(safeLine) ?? 1;
    const safeColumn = Math.max(1, Math.min(maxColumn, Number(payload.column) || 1));

    active.revealPositionInCenterIfOutsideViewport?.({ lineNumber: safeLine, column: safeColumn });
    active.focus?.();

    const domNode = active.getDomNode();
    const rect = domNode?.getBoundingClientRect?.();
    const visible = active.getScrolledVisiblePosition?.({ lineNumber: safeLine, column: safeColumn });
    if (!rect || !visible) {
      return { ok: false, reason: "position-not-visible" };
    }

    return {
      ok: true,
      lineNumber: safeLine,
      column: safeColumn,
      x: rect.left + visible.left + 6,
      y: rect.top + visible.top + Math.max(4, visible.height / 2),
    };
  }, { lineNumber, column });
};

const getEditorCursor = async (page) => {
  return page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    const position = active?.getPosition?.();
    if (!position) {
      return null;
    }
    return {
      lineNumber: Number(position.lineNumber) || 0,
      column: Number(position.column) || 0,
    };
  });
};

const readEditorJumpState = async (page, expectedPath, expectedLine) => {
  return page.evaluate((payload) => {
    const normalizePath = (value) =>
      String(value ?? "")
        .replace(/\\/g, "/")
        .replace(/\/+/g, "/");
    const expectedNormalized = normalizePath(payload.expectedPath).replace(/^\/+/, "");
    const expectedTail = expectedNormalized ? `/${expectedNormalized}` : "";

    const activeTabs = Array.from(
      document.querySelectorAll("#editor-tabs-list .editor-tab.is-active")
    );
    const activeTab = activeTabs.find((tab) => tab instanceof HTMLElement) ?? null;
    const activePath =
      activeTab instanceof HTMLElement ? activeTab.dataset.path ?? null : null;
    const activePathMatch = activePath === payload.expectedPath;

    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const resolveModelPath = (editor) => {
      const model = editor?.getModel?.();
      const uri = model?.uri;
      if (!uri) {
        return "";
      }
      const fsPath = typeof uri.fsPath === "string" ? uri.fsPath : "";
      const uriPath = typeof uri.path === "string" ? uri.path : "";
      return fsPath || uriPath || "";
    };

    let matchedEditor = null;
    let matchedModelPath = "";
    for (const editor of editors) {
      const modelPath = normalizePath(resolveModelPath(editor));
      if (!modelPath) {
        continue;
      }
      if (
        modelPath === expectedNormalized ||
        (expectedTail && modelPath.endsWith(expectedTail))
      ) {
        matchedEditor = editor;
        matchedModelPath = modelPath;
        break;
      }
    }
    if (!matchedEditor) {
      matchedEditor =
        editors.find(
          (editor) =>
            typeof editor.hasTextFocus === "function" && editor.hasTextFocus()
        ) ?? editors[0] ?? null;
      matchedModelPath = normalizePath(resolveModelPath(matchedEditor));
    }

    const position = matchedEditor?.getPosition?.();
    const cursorLine =
      position && Number.isFinite(Number(position.lineNumber))
        ? Number(position.lineNumber)
        : null;
    const lineDiff =
      Number.isFinite(cursorLine) && Number.isFinite(Number(payload.expectedLine))
        ? Math.abs(cursorLine - Number(payload.expectedLine))
        : null;

    return {
      activePath,
      activePathMatch,
      modelPath: matchedModelPath || null,
      modelPathMatch:
        matchedModelPath === expectedNormalized ||
        (Boolean(expectedTail) && matchedModelPath.endsWith(expectedTail)),
      cursorLine,
      lineDiff,
    };
  }, { expectedPath, expectedLine });
};

const formatEditorJumpState = (state) => {
  if (!state || typeof state !== "object") {
    return "state=missing";
  }
  const activePath = state.activePath ?? "null";
  const modelPath = state.modelPath ?? "null";
  const cursorLine = Number.isFinite(state.cursorLine) ? state.cursorLine : "null";
  const lineDiff = Number.isFinite(state.lineDiff) ? state.lineDiff : "null";
  return `activePath=${activePath} modelPath=${modelPath} cursorLine=${cursorLine} lineDiff=${lineDiff}`;
};

const waitForEditorJump = async (
  page,
  expectedPath,
  expectedLine,
  lineTolerance,
  timeoutMs = 8000
) => {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await readEditorJumpState(page, expectedPath, expectedLine);
    const lineDiff = Number(lastState?.lineDiff);
    if (
      lastState?.activePathMatch === true &&
      Number.isFinite(lineDiff) &&
      lineDiff <= lineTolerance
    ) {
      return lastState;
    }
    await page.waitForTimeout(30);
  }
  const detail = formatEditorJumpState(lastState);
  throw new Error(`editor jump mismatch: ${detail}`);
};

const openFileAndClickSource = async (page, filePath, lineNumber, column) => {
  await postToBridge(page, { type: "openFile", path: filePath });
  await page.waitForSelector(`#editor-tabs-list .editor-tab.is-active[data-path="${filePath}"]`, {
    timeout: 15000,
  });
  await focusEditor(page);

  let point = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = await resolveEditorClickPoint(page, lineNumber, column);
    if (candidate?.ok === true) {
      point = candidate;
      break;
    }
    await pause(40);
  }
  assert.ok(point?.ok === true, "failed to resolve Monaco click point");

  let moved = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.mouse.click(point.x, point.y, { button: "left" });
    await pause(60);
    const cursor = await getEditorCursor(page);
    if (cursor && cursor.lineNumber === point.lineNumber) {
      moved = true;
      break;
    }
    await focusEditor(page);
    await pause(40);
  }
  if (!moved) {
    await page.evaluate((payload) => {
      const editors = window.monaco?.editor?.getEditors?.() ?? [];
      const active =
        editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
        editors[0];
      if (!active) {
        return;
      }
      active.setPosition?.({ lineNumber: payload.lineNumber, column: payload.column });
      active.revealPositionInCenterIfOutsideViewport?.({
        lineNumber: payload.lineNumber,
        column: payload.column,
      });
      active.focus?.();
    }, { lineNumber: point.lineNumber, column: point.column });
    await pause(50);
    const fallbackCursor = await getEditorCursor(page);
    moved = Boolean(fallbackCursor && fallbackCursor.lineNumber === point.lineNumber);
  }
  assert.ok(moved, "failed to move cursor via Monaco click");
};

const triggerForwardViaUi = async (page) => {
  await clearBridgeMessages(page, "synctex:forwardResult");
  await clearPostedMessages(page, "synctex:forward");
  let clicked = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.click("#synctex-button", { timeout: 6000 });
      clicked = true;
      break;
    } catch {
      const fallbackClicked = await page
        .evaluate(() => {
          const button = document.getElementById("synctex-button");
          if (!(button instanceof HTMLButtonElement)) {
            return false;
          }
          if (button.disabled) {
            return false;
          }
          button.click();
          return true;
        })
        .catch(() => false);
      if (fallbackClicked) {
        clicked = true;
        break;
      }
      await pause(80);
    }
  }
  assert.ok(clicked, "failed to trigger synctex button");
  const forwardRequest = await waitForPostedMessage(
    page,
    "synctex:forward",
    8000,
    "manual"
  ).catch(() => null);
  const expectedRequestId =
    typeof forwardRequest?.requestId === "string" && forwardRequest.requestId
      ? forwardRequest.requestId
      : null;
  return waitForBridgeMessage(page, "synctex:forwardResult", 30000, expectedRequestId);
};

const closeAuxWindows = async (app, mainPage) => {
  for (const win of app.windows()) {
    if (win !== mainPage) {
      await win.close().catch(() => {});
    }
  }
};

const getSyncedTabViewerFrame = async (page, forwardPayload) => {
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

  const selectors = ["#editor-viewer-pdf-secondary", "#editor-viewer-pdf"];
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    let fallbackFrame = null;
    for (const selector of selectors) {
      const handle = await page.$(selector);
      const frame = await handle?.contentFrame();
      if (!frame) {
        continue;
      }
      const state = await frame
        .evaluate((payload) => {
          const state = window.__tex64PdfViewer?.state;
          if (!state || !state.lastSync) {
            return { match: false, hasMarker: false };
          }
          const marker = document.querySelector(".pdf-sync-marker");
          const last = state.lastSync;
          if (last.page !== payload.page) {
            return { match: false, hasMarker: marker instanceof HTMLElement };
          }
          const dx = Math.abs(Number(last.x) - Number(payload.x));
          const dy = Math.abs(Number(last.y) - Number(payload.y));
          const match = dx < 0.5 && dy < 0.5;
          return {
            match,
            hasMarker: marker instanceof HTMLElement,
          };
        }, { page: forwardPayload.page, x: forwardPayload.x, y: forwardPayload.y })
        .catch(() => ({ match: false, hasMarker: false }));
      if (state.match && state.hasMarker) {
        return frame;
      }
      if (state.match && !fallbackFrame) {
        fallbackFrame = frame;
      }
    }
    if (fallbackFrame) {
      return fallbackFrame;
    }
    await page.waitForTimeout(30);
  }
  throw new Error("synced tab viewer frame not found");
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
};

const clickViewerMarkerForReverse = async (targetViewer) => {
  const marker = targetViewer.locator(".pdf-sync-marker").first();
  const markerCount = await marker.count().catch(() => 0);
  if (markerCount < 1) {
    return targetViewer.evaluate(() => {
      const state = window.__tex64PdfViewer?.state;
      const sync = state?.lastSync;
      const syncDebug = state?.lastSyncDebug;
      const pageNumber = Number.parseInt(String(sync?.page ?? ""), 10);
      const viewX = Number(syncDebug?.viewX);
      const viewY = Number(syncDebug?.viewY);
      if (!Number.isFinite(pageNumber) || !Number.isFinite(viewX) || !Number.isFinite(viewY)) {
        return { ok: false, reason: "marker-missing" };
      }
      const pageEl = document.querySelector(`.page[data-page-number="${pageNumber}"]`);
      if (!(pageEl instanceof HTMLElement)) {
        return { ok: false, reason: "marker-missing" };
      }
      const rect = pageEl.getBoundingClientRect();
      const clientLeft = Number(pageEl.clientLeft);
      const clientTop = Number(pageEl.clientTop);
      const borderLeft = Number.parseFloat(
        window.getComputedStyle(pageEl).borderLeftWidth ?? "0"
      );
      const borderTop = Number.parseFloat(
        window.getComputedStyle(pageEl).borderTopWidth ?? "0"
      );
      const offsetLeft =
        Number.isFinite(clientLeft) && clientLeft > 0
          ? clientLeft
          : Number.isFinite(borderLeft)
            ? borderLeft
            : 0;
      const offsetTop =
        Number.isFinite(clientTop) && clientTop > 0
          ? clientTop
          : Number.isFinite(borderTop)
            ? borderTop
            : 0;
      const x = rect.left + offsetLeft + viewX;
      const y = rect.top + offsetTop + viewY;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, reason: "marker-missing" };
      }
      const target =
        pageEl.querySelector(".canvasWrapper canvas") ??
        pageEl.querySelector("canvas") ??
        pageEl;
      if (!(target instanceof Element)) {
        return { ok: false, reason: "marker-missing" };
      }
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: 1,
        metaKey: true,
        ctrlKey: true,
      });
      target.dispatchEvent(event);
      return { ok: true, reason: "marker-fallback" };
    });
  }
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  try {
    const box = await marker.boundingBox();
    const position =
      box && Number.isFinite(box.width) && Number.isFinite(box.height)
        ? { x: box.width / 2, y: box.height / 2 }
        : undefined;
    await marker.click({
      button: "left",
      modifiers: [modifier],
      force: true,
      timeout: 4000,
      position,
    });
    return { ok: true };
  } catch (lastError) {
    const errorText =
      lastError && typeof lastError.message === "string" && lastError.message
        ? lastError.message.split("\n")[0]
        : "click-failed";
    return { ok: false, reason: `marker-click-failed:${errorText}` };
  }
};

const clickViewerTextAnchorForReverse = async (targetViewer, item, forwardPayload) => {
  const tokens = reverseTextAnchorsByCase[item.id];
  if (!Array.isArray(tokens) || tokens.length < 1) {
    return { ok: false, reason: "text-anchor-not-configured" };
  }
  const xRatio =
    Number.isFinite(reverseTextClickXRatioByCase[item.id]) &&
    reverseTextClickXRatioByCase[item.id] > 0 &&
    reverseTextClickXRatioByCase[item.id] <= 1
      ? reverseTextClickXRatioByCase[item.id]
      : 0.12;
  const pageHintOverride = Number.isFinite(reverseTextClickPageByCase[item.id])
    ? reverseTextClickPageByCase[item.id]
    : null;
  if (Number.isFinite(pageHintOverride)) {
    await targetViewer
      .evaluate((payload) => {
        const pageNumber = Number(payload.pageNumber);
        if (!Number.isFinite(pageNumber) || pageNumber < 1) {
          return;
        }
        const viewer = window.__tex64PdfViewer?.pdfViewer;
        if (viewer && typeof viewer.scrollPageIntoView === "function") {
          viewer.scrollPageIntoView({ pageNumber });
        }
      }, { pageNumber: pageHintOverride })
      .catch(() => {});
    await targetViewer
      .waitForFunction(
        (payload) => {
          const pageNumber = Number(payload.pageNumber);
          const pageEl = document.querySelector(`.page[data-page-number="${pageNumber}"]`);
          if (!(pageEl instanceof HTMLElement)) {
            return false;
          }
          return pageEl.querySelectorAll(".textLayer span").length > 0;
        },
        { pageNumber: pageHintOverride },
        { timeout: 2500 }
      )
      .catch(() => {});
  }
  return targetViewer.evaluate((payload) => {
    const normalize = (value) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    const normalizeLoose = (value) => normalize(value).replace(/[^a-z0-9]+/g, "");
    const preparedTokens = (payload.tokens ?? [])
      .map((value) => ({
        raw: String(value ?? ""),
        normalized: normalize(value),
        loose: normalizeLoose(value),
      }))
      .filter((value) => value.normalized.length > 0);
    if (preparedTokens.length < 1) {
      return { ok: false, reason: "text-anchor-empty" };
    }
    const forward = payload.forward ?? null;
    const forwardPage = Number.parseInt(forward?.page, 10);
    const hasForwardPoint =
      Number.isFinite(forwardPage) &&
      Number.isFinite(Number(forward?.x)) &&
      Number.isFinite(Number(forward?.y));

    const pages = Array.from(document.querySelectorAll(".page")).filter(
      (node) => node instanceof HTMLElement
    );
    if (pages.length < 1) {
      return { ok: false, reason: "page-missing" };
    }

    const overridePage = Number.parseInt(payload.pageHintOverride, 10);
    const hintedPage = Number.isFinite(overridePage) ? overridePage : forwardPage;
    const hintedPages = Number.isFinite(hintedPage)
      ? pages.filter(
          (pageEl) =>
            Number.parseInt(pageEl.getAttribute("data-page-number") ?? "", 10) === hintedPage
        )
      : [];
    const searchRoots = hintedPages.length > 0 ? [hintedPages, pages] : [pages];

    const resolvePageContentOffset = (pageEl) => {
      const clientLeft = Number(pageEl.clientLeft);
      const clientTop = Number(pageEl.clientTop);
      if (
        Number.isFinite(clientLeft) &&
        Number.isFinite(clientTop) &&
        (clientLeft > 0 || clientTop > 0)
      ) {
        return { left: clientLeft, top: clientTop };
      }
      const style = window.getComputedStyle(pageEl);
      const borderLeft = Number.parseFloat(style.borderLeftWidth ?? "0");
      const borderTop = Number.parseFloat(style.borderTopWidth ?? "0");
      return {
        left: Number.isFinite(borderLeft) ? borderLeft : 0,
        top: Number.isFinite(borderTop) ? borderTop : 0,
      };
    };

    const resolveViewportScale = (pageView) => {
      const pageDiv = pageView?.div;
      const viewportWidth = Number(pageView?.viewport?.width);
      const viewportHeight = Number(pageView?.viewport?.height);
      const contentWidth =
        pageDiv instanceof HTMLElement && Number.isFinite(pageDiv.clientWidth)
          ? pageDiv.clientWidth
          : Number.NaN;
      const contentHeight =
        pageDiv instanceof HTMLElement && Number.isFinite(pageDiv.clientHeight)
          ? pageDiv.clientHeight
          : Number.NaN;
      const scaleX =
        Number.isFinite(contentWidth) &&
        contentWidth > 0 &&
        Number.isFinite(viewportWidth) &&
        viewportWidth > 0
          ? contentWidth / viewportWidth
          : 1;
      const scaleY =
        Number.isFinite(contentHeight) &&
        contentHeight > 0 &&
        Number.isFinite(viewportHeight) &&
        viewportHeight > 0
          ? contentHeight / viewportHeight
          : 1;
      return {
        x: Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1,
        y: Number.isFinite(scaleY) && scaleY > 0 ? scaleY : 1,
      };
    };

    const resolvePdfDistance = (entry) => {
      if (!hasForwardPoint) {
        return Number.POSITIVE_INFINITY;
      }
      if (entry.pageNumber !== forwardPage) {
        return Number.POSITIVE_INFINITY;
      }
      const pageViewer = window.__tex64PdfViewer?.pdfViewer;
      if (!pageViewer || typeof pageViewer.getPageView !== "function") {
        return Number.POSITIVE_INFINITY;
      }
      const pageView = pageViewer.getPageView(entry.pageNumber - 1);
      if (!pageView?.viewport || !(entry.pageEl instanceof HTMLElement)) {
        return Number.POSITIVE_INFINITY;
      }

      const pageRect = entry.pageEl.getBoundingClientRect();
      const spanRect = entry.span.getBoundingClientRect();
      const centerX = spanRect.left + Math.max(1, spanRect.width * 0.5);
      const centerY = spanRect.top + Math.max(1, spanRect.height * 0.5);
      const contentOffset = resolvePageContentOffset(entry.pageEl);
      const viewportScale = resolveViewportScale(pageView);
      const rawContentX = centerX - pageRect.left - contentOffset.left;
      const rawContentY = centerY - pageRect.top - contentOffset.top;
      if (!Number.isFinite(rawContentX) || !Number.isFinite(rawContentY)) {
        return Number.POSITIVE_INFINITY;
      }
      const viewX = rawContentX / viewportScale.x;
      const viewY = rawContentY / viewportScale.y;
      if (!Number.isFinite(viewX) || !Number.isFinite(viewY)) {
        return Number.POSITIVE_INFINITY;
      }
      const [pdfX, pdfY] = pageView.viewport.convertToPdfPoint(viewX, viewY);
      if (!Number.isFinite(pdfX) || !Number.isFinite(pdfY)) {
        return Number.POSITIVE_INFINITY;
      }
      return Math.hypot(pdfX - Number(forward.x), pdfY - Number(forward.y));
    };

    const resolveTokenMatch = (entry) => {
      for (const token of preparedTokens) {
        if (entry.normalized === token.normalized) {
          return { token, rank: 0 };
        }
        if (entry.normalized.includes(token.normalized)) {
          return { token, rank: 1 };
        }
        if (token.loose.length >= 4 && entry.loose.includes(token.loose)) {
          return { token, rank: 2 };
        }
      }
      return null;
    };

    const collectCandidates = (targetPages) => {
      const spans = [];
      for (const pageEl of targetPages) {
        const pageNumber =
          Number.parseInt(pageEl.getAttribute("data-page-number") ?? "", 10) || null;
        const textSpans = Array.from(pageEl.querySelectorAll(".textLayer span")).filter(
          (node) => node instanceof HTMLElement
        );
        for (const span of textSpans) {
          const text = (span.textContent ?? "").replace(/\s+/g, " ").trim();
          if (!text) {
            continue;
          }
          const normalized = normalize(text);
          const loose = normalizeLoose(text);
          spans.push({ span, pageEl, text, normalized, loose, pageNumber });
        }
      }
      if (spans.length < 1) {
        return null;
      }
      const matched = spans
        .map((entry) => {
          const tokenMatch = resolveTokenMatch(entry);
          if (!tokenMatch) {
            return null;
          }
          return {
            entry,
            token: tokenMatch.token,
            tokenRank: tokenMatch.rank,
            pdfDistance: resolvePdfDistance(entry),
          };
        })
        .filter(Boolean);
      if (matched.length > 0) {
        matched.sort((left, right) => {
          if (left.tokenRank !== right.tokenRank) {
            return left.tokenRank - right.tokenRank;
          }
          const leftDist = Number.isFinite(left.pdfDistance)
            ? left.pdfDistance
            : Number.POSITIVE_INFINITY;
          const rightDist = Number.isFinite(right.pdfDistance)
            ? right.pdfDistance
            : Number.POSITIVE_INFINITY;
          if (leftDist !== rightDist) {
            return leftDist - rightDist;
          }
          return left.entry.text.localeCompare(right.entry.text);
        });
        return matched[0];
      }
      if (!hasForwardPoint) {
        return null;
      }
      const nearest = spans
        .map((entry) => ({
          entry,
          token: { raw: "(nearest)" },
          tokenRank: 9,
          pdfDistance: resolvePdfDistance(entry),
        }))
        .filter((value) => Number.isFinite(value.pdfDistance))
        .sort((left, right) => left.pdfDistance - right.pdfDistance);
      return nearest[0] ?? null;
    };

    let hit = null;
    for (const targetPages of searchRoots) {
      hit = collectCandidates(targetPages);
      if (hit) {
        break;
      }
    }
    if (!hit) {
      return {
        ok: false,
        reason: `text-anchor-not-found:${preparedTokens.map((token) => token.raw).join("|")}`,
      };
    }

    const rect = hit.entry.span.getBoundingClientRect();
    if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) {
      return { ok: false, reason: "text-anchor-rect-invalid" };
    }
    const xRatio = Number(payload.xRatio);
    const resolvedXRatio =
      Number.isFinite(xRatio) && xRatio > 0 && xRatio <= 1 ? xRatio : 0.12;
    const x = rect.left + Math.max(1, rect.width * resolvedXRatio);
    const y = rect.top + Math.max(1, rect.height * 0.5);
    const target = document.elementFromPoint(x, y);
    const dispatchTarget = target instanceof Element ? target : hit.entry.span;

    const clickEvent = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
      metaKey: true,
      ctrlKey: true,
    });
    dispatchTarget.dispatchEvent(clickEvent);

    return {
      ok: true,
      reason: null,
      token: hit.token.raw,
      text: hit.entry.text,
      page: hit.entry.pageNumber,
      pdfDistance: Number.isFinite(hit.pdfDistance) ? hit.pdfDistance : null,
      x,
      y,
    };
  }, {
    tokens,
    forward: forwardPayload ?? null,
    xRatio,
    pageHintOverride,
  });
};

const clickViewerTargetForReverse = async (targetViewer, item, forwardPayload) => {
  if (hasTextAnchor(item.id)) {
    const textClick = await clickViewerTextAnchorForReverse(targetViewer, item, forwardPayload);
    if (textClick?.ok === true) {
      return { ...textClick, method: "text" };
    }
    return {
      ok: false,
      reason: `text-click-failed:${textClick?.reason ?? "unknown"}`,
    };
  }
  const markerClick = await clickViewerMarkerForReverse(targetViewer);
  return markerClick?.ok ? { ...markerClick, method: "marker" } : markerClick;
};

const readMarkerSnapshot = async (targetViewer) => {
  return targetViewer.evaluate(() => {
    const marker = document.querySelector(".pdf-sync-marker");
    if (!(marker instanceof HTMLElement)) {
      return { present: false };
    }
    const rect = marker.getBoundingClientRect();
    const parent = marker.parentElement;
    return {
      present: true,
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      pageNumber:
        parent instanceof HTMLElement
          ? Number.parseInt(parent.getAttribute("data-page-number") ?? "", 10) || null
          : null,
    };
  });
};

const readViewerDebugState = async (targetViewer) => {
  return targetViewer
    .evaluate(() => {
      const state = window.__tex64PdfViewer?.state;
      return {
        lastSyncDebug: state?.lastSyncDebug ?? null,
        lastReverseDebug: state?.lastReverseDebug ?? null,
      };
    })
    .catch(() => ({ lastSyncDebug: null, lastReverseDebug: null }));
};

const dispatchViewerMarkerReverseFallback = async (targetViewer) => {
  return targetViewer.evaluate(() => {
    const marker = document.querySelector(".pdf-sync-marker");
    const state = window.__tex64PdfViewer?.state;
    const getBorderOffset = (pageEl) => {
      if (!(pageEl instanceof HTMLElement)) {
        return { left: 0, top: 0 };
      }
      const clientLeft = Number(pageEl.clientLeft);
      const clientTop = Number(pageEl.clientTop);
      const borderLeft = Number.parseFloat(
        window.getComputedStyle(pageEl).borderLeftWidth ?? "0"
      );
      const borderTop = Number.parseFloat(
        window.getComputedStyle(pageEl).borderTopWidth ?? "0"
      );
      return {
        left:
          Number.isFinite(clientLeft) && clientLeft > 0
            ? clientLeft
            : Number.isFinite(borderLeft)
              ? borderLeft
              : 0,
        top:
          Number.isFinite(clientTop) && clientTop > 0
            ? clientTop
            : Number.isFinite(borderTop)
              ? borderTop
              : 0,
      };
    };
    let x = Number.NaN;
    let y = Number.NaN;
    let preferredTarget = null;
    if (marker instanceof HTMLElement) {
      const markerPageEl = marker.closest(".page");
      const markerLeft = Number.parseFloat(marker.style.left ?? "");
      const markerTop = Number.parseFloat(marker.style.top ?? "");
      if (
        markerPageEl instanceof HTMLElement &&
        Number.isFinite(markerLeft) &&
        Number.isFinite(markerTop)
      ) {
        const rect = markerPageEl.getBoundingClientRect();
        const offset = getBorderOffset(markerPageEl);
        x = rect.left + offset.left + markerLeft;
        y = rect.top + offset.top + markerTop;
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        const rect = marker.getBoundingClientRect();
        x = rect.left + rect.width / 2;
        y = rect.top + rect.height / 2;
      }
    } else {
      const sync = state?.lastSync;
      const syncDebug = state?.lastSyncDebug;
      const syncPage = Number.parseInt(String(sync?.page ?? ""), 10);
      const syncViewX = Number(syncDebug?.viewX);
      const syncViewY = Number(syncDebug?.viewY);
      if (Number.isFinite(syncPage) && Number.isFinite(syncViewX) && Number.isFinite(syncViewY)) {
        const fallbackPage = document.querySelector(
          `.page[data-page-number="${syncPage}"]`
        );
        if (fallbackPage instanceof HTMLElement) {
          const rect = fallbackPage.getBoundingClientRect();
          const offset = getBorderOffset(fallbackPage);
          x = rect.left + offset.left + syncViewX;
          y = rect.top + offset.top + syncViewY;
          preferredTarget =
            fallbackPage.querySelector(".canvasWrapper canvas") ??
            fallbackPage.querySelector("canvas") ??
            fallbackPage;
        }
      }
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, reason: marker instanceof HTMLElement ? "marker-point-invalid" : "marker-missing" };
    }
    const target =
      preferredTarget instanceof Element ? preferredTarget : document.elementFromPoint(x, y);
    if (!(target instanceof Element)) {
      return { ok: false, reason: "target-missing" };
    }
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
      metaKey: true,
      ctrlKey: true,
    });
    target.dispatchEvent(event);
    return {
      ok: true,
      markerPresent: marker instanceof HTMLElement,
    };
  });
};

const runUiCaseRound = async ({
  app,
  mainPage,
  mode,
  item,
  timeoutMs,
  lineTolerance,
  coordTolerance,
}) => {
  const debugThisCase = debugCaseId !== "" && debugCaseId === item.id;
  const caseLineTolerance = resolveCaseLineTolerance(item.id, lineTolerance);
  await openFileAndClickSource(mainPage, item.relativePath, item.lineNumber, item.column);
  const hadPdfWindow = app.windows().some((win) => win !== mainPage);
  const waitWindow =
    mode === "window" && !hadPdfWindow
      ? app.waitForEvent("window", { timeout: 20000 }).catch(() => null)
      : null;

  const forwardEnvelope = await triggerForwardViaUi(mainPage);
  const forwardResult = forwardEnvelope?.payload ?? null;
  if (debugThisCase) {
    log(`debug ${item.id} forward=${JSON.stringify(forwardResult)}`);
  }
  if (!forwardResult || forwardResult.ok !== true) {
    return {
      ...item,
      mode,
      forwardOk: false,
      reverseOk: false,
      pass: false,
      exact: false,
      reason: forwardResult?.error ?? "forward failed",
    };
  }

  let viewerPage = null;
  if (mode === "tab") {
    viewerPage = await getSyncedTabViewerFrame(mainPage, forwardResult);
  } else {
    let pdfWindow = app.windows().find((win) => win !== mainPage) ?? null;
    if (!pdfWindow && waitWindow) {
      pdfWindow = await waitWindow;
    }
    if (!pdfWindow) {
      return {
        ...item,
        mode,
        forwardOk: true,
        reverseOk: false,
        pass: false,
        exact: false,
        reason: "pdf window not found",
      };
    }
    await pdfWindow.waitForLoadState("domcontentloaded");
    viewerPage = pdfWindow;
  }

  try {
    await waitViewerSynced(viewerPage, forwardResult);
    if (debugThisCase) {
      const markerSnapshot = await readMarkerSnapshot(viewerPage);
      log(`debug ${item.id} marker=${JSON.stringify(markerSnapshot)}`);
    }
  } catch {
    const markerSnapshot = await readMarkerSnapshot(viewerPage).catch(() => null);
    const viewerDebug = await readViewerDebugState(viewerPage).catch(() => ({
      lastSyncDebug: null,
      lastReverseDebug: null,
    }));
    const uiModeState = await mainPage
      .evaluate(() => {
        const windowToggle = document.getElementById("editor-pdf-window");
        const splitToggle = document.getElementById("editor-split-toggle");
        return {
          windowModeChecked:
            windowToggle instanceof HTMLInputElement ? windowToggle.checked : null,
          splitEnabled:
            splitToggle instanceof HTMLInputElement ? splitToggle.checked : null,
        };
      })
      .catch(() => null);
    if (debugThisCase) {
      log(`debug ${item.id} sync-timeout marker=${JSON.stringify(markerSnapshot)}`);
      log(`debug ${item.id} sync-timeout viewerDebug=${JSON.stringify(viewerDebug)}`);
      log(`debug ${item.id} sync-timeout uiMode=${JSON.stringify(uiModeState)}`);
    }
    return {
      ...item,
      mode,
      forwardOk: true,
      reverseOk: false,
      pass: false,
      exact: false,
      reason: `viewer sync timeout marker=${JSON.stringify(markerSnapshot)} sync=${JSON.stringify(
        viewerDebug.lastSyncDebug
      )} ui=${JSON.stringify(uiModeState)}`,
    };
  }

  if (mode === "tab") {
    await clearViewerMessages(mainPage, "reverse");
    await clearBridgeMessages(mainPage, "synctex:reverseResult");
    const probeReverseRequestPromise = waitForViewerMessage(
      mainPage,
      "reverse",
      Math.min(timeoutMs, 6000)
    ).catch(() => null);
    const probeDispatch = await dispatchViewerMarkerReverseFallback(viewerPage);
    if (!probeDispatch?.ok) {
      return {
        ...item,
        mode,
        forwardOk: true,
        reverseOk: false,
        pass: false,
        exact: false,
        reason: `viewer coordinate probe failed: ${probeDispatch?.reason ?? "unknown"}`,
      };
    }
    const probeReverseRequest = await probeReverseRequestPromise;
    const probePage = Number.parseInt(probeReverseRequest?.page, 10);
    const probeX = Number.parseFloat(probeReverseRequest?.x);
    const probeY = Number.parseFloat(probeReverseRequest?.y);
    const probePageMatch = Number.isFinite(probePage) && probePage === forwardResult.page;
    const probeDx =
      Number.isFinite(probeX) && Number.isFinite(forwardResult.x)
        ? Math.abs(probeX - forwardResult.x)
        : Number.POSITIVE_INFINITY;
    const probeDy =
      Number.isFinite(probeY) && Number.isFinite(forwardResult.y)
        ? Math.abs(probeY - forwardResult.y)
        : Number.POSITIVE_INFINITY;
    const probeCoordOk =
      probePageMatch &&
      Number.isFinite(probeDx) &&
      Number.isFinite(probeDy) &&
      probeDx <= coordTolerance &&
      probeDy <= coordTolerance;
    if (!probeCoordOk) {
      const requestSummary = probeReverseRequest
        ? `page=${probePage} x=${probeX} y=${probeY} dx=${probeDx} dy=${probeDy}`
        : "probe reverse request missing";
      const viewerDebug = await readViewerDebugState(viewerPage);
      if (debugThisCase) {
        log(`debug ${item.id} viewerDebug=${JSON.stringify(viewerDebug)}`);
      }
      return {
        ...item,
        mode,
        forwardOk: true,
        reverseOk: false,
        pass: false,
        exact: false,
        reason: `viewer coordinate mismatch: ${requestSummary} sync=${JSON.stringify(
          viewerDebug.lastSyncDebug
        )} reverse=${JSON.stringify(viewerDebug.lastReverseDebug)}`,
      };
    }
    if (debugThisCase) {
      log(
        `debug ${item.id} reverseProbe=page:${probePage} x:${probeX} y:${probeY} dx:${probeDx} dy:${probeDy}`
      );
    }
    await waitForBridgeMessage(
      mainPage,
      "synctex:reverseResult",
      Math.min(timeoutMs, 3000)
    ).catch(() => null);
  }

  await clearBridgeMessages(mainPage, "synctex:reverseResult");
  if (mode === "tab") {
    await clearViewerMessages(mainPage, "reverse");
  }
  if (mode === "tab") {
    await clearViewerMessages(mainPage, "reverse");
  }
  const clickResult = await clickViewerTargetForReverse(viewerPage, item, forwardResult);
  if (!clickResult?.ok) {
    return {
      ...item,
      mode,
      forwardOk: true,
      reverseOk: false,
      pass: false,
      exact: false,
      reason: clickResult?.reason ?? "reverse click failed",
    };
  }
  if (debugThisCase) {
    log(
      `debug ${item.id} reverseClickMethod=${clickResult.method ?? "unknown"} token=${clickResult.token ?? "n/a"}`
    );
    const viewerDebug = await readViewerDebugState(viewerPage);
    log(`debug ${item.id} viewerDebug=${JSON.stringify(viewerDebug)}`);
  }
  if (debugThisCase) {
    const reverseRequest = await waitForViewerMessage(
      mainPage,
      "reverse",
      Math.min(timeoutMs, 2000)
    ).catch(() => null);
    log(`debug ${item.id} reverseRequest=${JSON.stringify(reverseRequest)}`);
  }

  let reverseEnvelope = null;
  try {
    reverseEnvelope = await waitForBridgeMessage(mainPage, "synctex:reverseResult", 400);
  } catch {
    reverseEnvelope = null;
  }
  if (!reverseEnvelope) {
    const fallbackClick = await dispatchViewerMarkerReverseFallback(viewerPage);
    if (!fallbackClick?.ok) {
      return {
        ...item,
        mode,
        forwardOk: true,
        reverseOk: false,
        pass: false,
        exact: false,
        reason: fallbackClick?.reason ?? "reverse fallback failed",
      };
    }
    try {
      reverseEnvelope = await waitForBridgeMessage(mainPage, "synctex:reverseResult", timeoutMs);
      log(`mode=${mode} fallback reverse dispatch recovered: ${item.id}`);
    } catch {
      reverseEnvelope = null;
    }
  }
  const reverseResult = reverseEnvelope?.payload ?? null;
  if (debugThisCase) {
    log(`debug ${item.id} reverseResult=${JSON.stringify(reverseResult)}`);
  }
  if (!reverseResult || reverseResult.ok !== true) {
    let reverseReason = "reverse failed or timed out";
    if (reverseResult) {
      if (typeof reverseResult.error === "string" && reverseResult.error.trim()) {
        reverseReason = reverseResult.error.trim();
      } else {
        try {
          reverseReason = `reverse-not-ok:${JSON.stringify(reverseResult)}`;
        } catch {
          reverseReason = "reverse-not-ok";
        }
      }
    }
    return {
      ...item,
      mode,
      forwardOk: true,
      reverseOk: false,
      pass: false,
      exact: false,
      reason: reverseReason,
      reverseClickMethod: clickResult.method ?? null,
      reverseClickToken: clickResult.token ?? null,
      reverseClickText: clickResult.text ?? null,
      reverseClickPage: clickResult.page ?? null,
      reverseClickPdfDistance: clickResult.pdfDistance ?? null,
    };
  }

  let editorJumpState = null;
  try {
    editorJumpState = await waitForEditorJump(
      mainPage,
      item.relativePath,
      item.lineNumber,
      caseLineTolerance,
      Math.min(timeoutMs, 8000)
    );
  } catch (error) {
    const fallbackState = await readEditorJumpState(
      mainPage,
      item.relativePath,
      item.lineNumber
    ).catch(() => null);
    return {
      ...item,
      mode,
      forwardOk: true,
      reverseOk: true,
      pass: false,
      exact: false,
      reason:
        error instanceof Error
          ? error.message
          : `editor jump mismatch: ${formatEditorJumpState(fallbackState)}`,
      reversePath: reverseResult?.path ?? null,
      reverseLine: Number.isFinite(reverseResult?.line) ? reverseResult.line : null,
      reverseClickMethod: clickResult.method ?? null,
      reverseClickToken: clickResult.token ?? null,
      reverseClickText: clickResult.text ?? null,
      reverseClickPage: clickResult.page ?? null,
      reverseClickPdfDistance: clickResult.pdfDistance ?? null,
      uiActivePath: fallbackState?.activePath ?? null,
      uiCursorLine: fallbackState?.cursorLine ?? null,
      uiLineDiff: fallbackState?.lineDiff ?? null,
    };
  }
  if (debugThisCase) {
    log(`debug ${item.id} editorJump=${JSON.stringify(editorJumpState)}`);
  }

  const samePath = reverseResult.path === item.relativePath;
  const lineDiff =
    Number.isFinite(reverseResult.line) && Number.isFinite(item.lineNumber)
      ? Math.abs(reverseResult.line - item.lineNumber)
      : Number.POSITIVE_INFINITY;
  const uiLineDiff = Number(editorJumpState?.lineDiff);
  const uiJumpOk =
    editorJumpState?.activePathMatch === true &&
    Number.isFinite(uiLineDiff) &&
    uiLineDiff <= caseLineTolerance;
  const pass = samePath && lineDiff <= caseLineTolerance && uiJumpOk;
  const exact = pass && lineDiff === 0 && uiLineDiff === 0;

  return {
    ...item,
    mode,
    forwardOk: true,
    reverseOk: true,
    pass,
    exact,
    samePath,
    lineDiff,
    reverseLine: reverseResult.line ?? null,
    lineToleranceUsed: caseLineTolerance,
    uiJumpOk,
    reverseClickMethod: clickResult.method ?? null,
    reverseClickToken: clickResult.token ?? null,
    reverseClickText: clickResult.text ?? null,
    reverseClickPage: clickResult.page ?? null,
    reverseClickPdfDistance: clickResult.pdfDistance ?? null,
    uiActivePath: editorJumpState?.activePath ?? null,
    uiCursorLine: editorJumpState?.cursorLine ?? null,
    uiLineDiff: Number.isFinite(uiLineDiff) ? uiLineDiff : null,
  };
};

const runMode = async ({
  app,
  mainPage,
  mode,
  cases,
  timeoutMs,
  lineTolerance,
  coordTolerance,
  maxAttempts,
}) => {
  await closeAuxWindows(app, mainPage);
  await setRuntimeToggles(mainPage, mode);
  await clearBridgeMessages(mainPage);

  const results = [];
  for (const item of cases) {
    log(`mode=${mode} case=${item.id}`);
    let lastResult = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      lastResult = await runUiCaseRound({
        app,
        mainPage,
        mode,
        item,
        timeoutMs,
        lineTolerance,
        coordTolerance,
      });
      if (lastResult.pass === true) {
        if (attempt > 1) {
          log(`mode=${mode} retry recovered: ${item.id}`);
        }
        break;
      }
      if (attempt < maxAttempts) {
        await pause(120);
      }
    }
    results.push({
      ...lastResult,
      attempts: lastResult?.pass ? undefined : maxAttempts,
    });
  }
  return results;
};

const run = async () => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  let electronApp;

  const timeoutMs = readIntEnv("E2E_SYNCTEX_BRIDGE_TIMEOUT_MS", 30000);
  const lineTolerance = readIntEnv("E2E_SYNCTEX_LINE_TOLERANCE", 0);
  const minPassRate = readFloatEnv("E2E_SYNCTEX_MIN_PASS", 1);
  const minExactRate = readFloatEnv("E2E_SYNCTEX_MIN_EXACT", 1);
  const maxAttempts = Math.max(1, readIntEnv("E2E_SYNCTEX_MAX_ATTEMPTS", 3));
  const coordTolerance = readFloatEnv("E2E_SYNCTEX_COORD_TOLERANCE", 2.0);
  const requiredCategories = parseRequiredCategories();
  const modes = parseModes();
  const enforceCategories = process.env.E2E_SYNCTEX_ENFORCE_CATEGORIES !== "0";
  const hasCaseFilter = (process.env.E2E_SYNCTEX_CASE_FILTER ?? "").trim().length > 0;
  const enforceTextCoverage =
    process.env.E2E_SYNCTEX_ENFORCE_TEXT_COVERAGE === "0"
      ? false
      : !hasCaseFilter;

  try {
    await cleanupBuildArtifacts(workspacePath);
    const discoveredCases = await collectTaggedCases(workspacePath);
    const cases = filterCases(discoveredCases);
    assert.ok(cases.length > 0, "no SYNC_CASE markers found");
    validateReverseClickCoverage(cases, requiredCategories, enforceTextCoverage);
    const discoveredCategories = new Set(cases.map((item) => item.category));
    if (enforceCategories) {
      for (const category of requiredCategories) {
        assert.ok(
          discoveredCategories.has(category),
          `required category not covered by SYNC_CASE markers: ${category}`
        );
      }
    }
    log(
      `cases=${cases.length} categories=${Array.from(discoveredCategories)
        .sort((left, right) => left.localeCompare(right))
        .join(",")}`
    );
    log(`workspace copy: ${workspacePath}`);

    electronApp = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      env: { ...process.env, TEX64_E2E_HEADLESS: "1" },
    });
    const mainPage = await electronApp.firstWindow();
    await mainPage.setViewportSize({ width: 1680, height: 980 });
    await initBridgeCollector(mainPage);

    await postToBridge(mainPage, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(mainPage);
    await postToBridge(mainPage, { type: "build" });
    await waitForBuildIdle(mainPage);
    await pause(220);

    const allResults = [];
    for (const mode of modes) {
      log(`run mode=${mode}`);
      const modeResults = await runMode({
        app: electronApp,
        mainPage,
        mode,
        cases,
        timeoutMs,
        lineTolerance,
        coordTolerance,
        maxAttempts,
      });
      allResults.push(...modeResults);

      const total = modeResults.length;
      const forwardFailCount = modeResults.filter((item) => item.forwardOk === false).length;
      const reverseFailCount = modeResults.filter(
        (item) => item.forwardOk === true && item.reverseOk === false
      ).length;
      const passCount = modeResults.filter((item) => item.pass === true).length;
      const exactCount = modeResults.filter((item) => item.exact === true).length;
      const passRate = total > 0 ? passCount / total : 0;
      const strictCases = modeResults.filter(
        (item) => resolveCaseLineTolerance(item.id, lineTolerance) === 0
      );
      const strictExactCount = strictCases.filter((item) => item.exact === true).length;
      const strictTotal = strictCases.length;
      const exactRate = strictTotal > 0 ? strictExactCount / strictTotal : 1;
      const reverseClickMethodCounts = modeResults.reduce((acc, item) => {
        const method = item.reverseClickMethod ?? "unknown";
        acc[method] = (acc[method] ?? 0) + 1;
        return acc;
      }, {});

      log(
        `mode=${mode} total=${total} pass=${passCount} exact=${exactCount} ` +
          `forwardFail=${forwardFailCount} reverseFail=${reverseFailCount}`
      );
      log(
        `mode=${mode} rates: pass=${passRate.toFixed(4)} exact=${exactRate.toFixed(
          4
        )} (strict ${strictExactCount}/${strictTotal})`
      );
      log(
        `mode=${mode} reverseClickMethods=${Object.entries(reverseClickMethodCounts)
          .sort((left, right) => left[0].localeCompare(right[0]))
          .map(([method, count]) => `${method}:${count}`)
          .join(",")}`
      );

      const failed = modeResults.filter((item) => item.pass !== true);
      if (failed.length > 0) {
        log(`mode=${mode} failed (${failed.length}):`);
        failed.slice(0, 60).forEach((item) => {
          const reason = item.reason ?? `lineDiff=${item.lineDiff}`;
          const clickMeta = `click=${item.reverseClickMethod ?? "unknown"} token=${
            item.reverseClickToken ?? "n/a"
          }`;
          const clickPage = Number.isFinite(item.reverseClickPage)
            ? `page=${item.reverseClickPage}`
            : "page=n/a";
          const pdfDistance = Number.isFinite(item.reverseClickPdfDistance)
            ? `dist=${item.reverseClickPdfDistance.toFixed(2)}`
            : "dist=n/a";
          const reverseMeta = `reverse=${item.reversePath ?? "n/a"}:${item.reverseLine ?? "n/a"}`;
          log(
            `- ${item.id} ${item.relativePath}:${item.lineNumber} ${reason} ${reverseMeta} ${clickMeta} ${clickPage} ${pdfDistance}`
          );
        });
      }

      assert.strictEqual(forwardFailCount, 0, `mode=${mode} forward failures detected`);
      assert.strictEqual(reverseFailCount, 0, `mode=${mode} reverse failures detected`);
      assert.ok(
        passRate >= minPassRate,
        `mode=${mode} passRate ${passRate.toFixed(4)} < ${minPassRate.toFixed(4)}`
      );
      assert.ok(
        exactRate >= minExactRate,
        `mode=${mode} exactRate ${exactRate.toFixed(4)} < ${minExactRate.toFixed(
          4
        )} (strict ${strictExactCount}/${strictTotal})`
      );
      assert.strictEqual(failed.length, 0, `mode=${mode} has non-pass cases (${failed.length})`);
    }

    const total = allResults.length;
    const totalExact = allResults.filter((item) => item.exact === true).length;
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
