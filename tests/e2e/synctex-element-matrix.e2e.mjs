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

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => console.log(`[synctex-matrix-e2e ${now()}] ${message}`);
const createRequestId = (() => {
  let seq = 0;
  return (prefix = "req") => {
    seq += 1;
    return `${prefix}-${Date.now()}-${seq}`;
  };
})();

const readFloatEnv = (name, fallback) => {
  const value = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(value) ? value : fallback;
};

const readIntEnv = (name, fallback) => {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
};

const readBoolEnv = (name, fallback) => {
  const value = (process.env[name] ?? "").toLowerCase();
  if (value === "1" || value === "true" || value === "yes" || value === "on") {
    return true;
  }
  if (value === "0" || value === "false" || value === "no" || value === "off") {
    return false;
  }
  return fallback;
};

const createWorkspaceCopy = async (workspaceSourcePath = sourceWorkspace) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-synctex-matrix-"));
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
        if (skipDirs.has(entry.name)) {
          continue;
        }
        stack.push(entryPath);
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

const fileExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const findPdfPath = async (workspacePath) => {
  const direct = path.join(workspacePath, "main.pdf");
  if (await fileExists(direct)) {
    return direct;
  }
  const stack = [workspacePath];
  const skipDirs = new Set([".git", ".tex64", "node_modules", "tmp"]);
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
      if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".pdf") {
        return entryPath;
      }
    }
  }
  return null;
};

const normalizeWorkspacePath = (workspacePath, targetPath) => {
  if (!targetPath || typeof targetPath !== "string") {
    return null;
  }
  const resolved = path.isAbsolute(targetPath)
    ? targetPath
    : path.join(workspacePath, targetPath);
  return path.normalize(resolved);
};

const normalizeForCompare = (value) =>
  typeof value === "string" ? path.normalize(value).replace(/\\/g, "/") : null;

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
    if (typeof window.__synctexTestMessages === "undefined") {
      window.__synctexTestMessages = [];
    }
    if (window.__synctexBridgeInstalled !== true) {
      window.__synctexBridgeInstalled = true;
      window.tex64Bridge.onMessage((message) => {
        const requestId =
          message?.payload && typeof message.payload === "object"
            ? message.payload.requestId
            : message?.requestId;
        window.__synctexTestMessages.push({
          type: message?.type,
          requestId,
          payload: message?.payload ?? null,
          at: Date.now(),
        });
      });
    }
  });
};

const waitForBridgeMessage = async (page, type, timeoutMs = 20000, expectedRequestId = null) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await page.evaluate((params) => {
      const messages = window.__synctexTestMessages;
      if (!Array.isArray(messages) || messages.length === 0) {
        return null;
      }
      const index = messages.findIndex((item) => {
        if (!item || item.type !== params.type) {
          return false;
        }
        if (!params.requestId) {
          return true;
        }
        return item.requestId === params.requestId;
      });
      if (index === -1) {
        return null;
      }
      const item = messages[index];
      messages.splice(index, 1);
      return { type: item.type, requestId: item.requestId, payload: item.payload };
    }, { type, requestId: expectedRequestId });
    if (message && message.type === type) {
      return message;
    }
    await page.waitForTimeout(15);
  }
  throw new Error(`Timed out waiting for bridge message: ${type}`);
};

const findFirstContentLine = (lines, startIndex, direction) => {
  for (
    let index = startIndex;
    index >= 0 && index < lines.length;
    index += direction
  ) {
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

const isUnmeasurableForwardError = (message) =>
  typeof message === "string" && message.includes("位置情報");

const run = async () => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  let electronApp;

  const timeoutMs = readIntEnv("E2E_SYNCTEX_BRIDGE_TIMEOUT_MS", 25000);
  const lineTolerance = readIntEnv("E2E_SYNCTEX_LINE_TOLERANCE", 1);
  const minPassRate = readFloatEnv("E2E_SYNCTEX_MIN_PASS", 1);
  const minExactRate = readFloatEnv("E2E_SYNCTEX_MIN_EXACT", 0.7);
  const allowUnmeasurableForward = readBoolEnv("E2E_SYNCTEX_ALLOW_UNMEASURABLE", false);
  const reverseBypassHint = readBoolEnv("E2E_SYNCTEX_REVERSE_BYPASS_HINT", false);
  const reverseRefineLines = readIntEnv("E2E_SYNCTEX_REVERSE_REFINE_LINES", 3);
  const reverseAllowExpandedOffsets = readBoolEnv("E2E_SYNCTEX_REVERSE_ALLOW_EXPANDED_OFFSETS", false);
  const requiredCategories = parseRequiredCategories();

  try {
    await cleanupBuildArtifacts(workspacePath);
    const cases = await collectTaggedCases(workspacePath);
    assert.ok(cases.length > 0, "no SYNC_CASE markers found");

    const discoveredCategories = new Set(cases.map((item) => item.category));
    for (const category of requiredCategories) {
      assert.ok(
        discoveredCategories.has(category),
        `required category not covered by SYNC_CASE markers: ${category}`
      );
    }

    log(`workspace copy: ${workspacePath}`);
    log(
      `cases=${cases.length} categories=${Array.from(discoveredCategories)
        .sort((left, right) => left.localeCompare(right))
        .join(",")}`
    );

    electronApp = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      env: { ...process.env, TEX64_E2E_HEADLESS: "1" },
    });
    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1600, height: 980 });

    await initBridgeCollector(page);
    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);
    await postToBridge(page, { type: "build" });
    await waitForBuildIdle(page);
    await page.waitForTimeout(300);

    const pdfPath = await findPdfPath(workspacePath);
    assert.ok(pdfPath, "PDF output not found after build");
    log(`using pdf: ${pdfPath}`);

    const results = [];

    for (const item of cases) {
      const forwardRequestId = createRequestId("forward");
      await postToBridge(page, {
        type: "synctex:forward",
        requestId: forwardRequestId,
        path: item.relativePath,
        line: item.lineNumber,
        column: item.column,
        fallbackToTop: false,
      });

      const forwardEnvelope = await waitForBridgeMessage(
        page,
        "synctex:forwardResult",
        timeoutMs,
        forwardRequestId
      );
      const forwardResult = forwardEnvelope?.payload ?? null;
      if (!forwardResult || forwardResult.ok !== true || forwardEnvelope?.requestId !== forwardRequestId) {
        const reason =
          forwardEnvelope?.requestId && forwardEnvelope.requestId !== forwardRequestId
            ? "forward requestId mismatch"
            : forwardResult?.error ?? "forward failed";
        const measurable = !isUnmeasurableForwardError(reason);
        results.push({
          ...item,
          forwardOk: false,
          measurable,
          reverseOk: false,
          samePath: false,
          lineDiff: Number.POSITIVE_INFINITY,
          pass: false,
          exact: false,
          reason,
        });
        continue;
      }

      const resolvedForwardPdfPath = forwardResult.pdfPath
        ? normalizeWorkspacePath(workspacePath, forwardResult.pdfPath)
        : pdfPath;
      const expectedSourcePath = normalizeWorkspacePath(workspacePath, item.sourcePath);
      const forwardPdfPath = resolvedForwardPdfPath || pdfPath;

      const reverseRequestId = createRequestId("reverse");
      await postToBridge(page, {
        type: "synctex:reverse",
        requestId: reverseRequestId,
        page: forwardResult.page,
        x: forwardResult.x,
        y: forwardResult.y,
        pdfPath: forwardPdfPath,
        bypassHint: reverseBypassHint,
        refineLines: reverseRefineLines,
        allowExpandedOffsets: reverseAllowExpandedOffsets,
      });
      const reverseEnvelope = await waitForBridgeMessage(
        page,
        "synctex:reverseResult",
        timeoutMs,
        reverseRequestId
      );
      const reverseResult = reverseEnvelope?.payload ?? null;
      const reverseOk = reverseResult?.ok === true;
      if (!reverseOk || reverseEnvelope?.requestId !== reverseRequestId) {
        results.push({
          ...item,
          forwardOk: true,
          measurable: true,
          reverseOk: false,
          samePath: false,
          lineDiff: Number.POSITIVE_INFINITY,
          pass: false,
          exact: false,
          reverseError:
            reverseEnvelope?.requestId && reverseEnvelope.requestId !== reverseRequestId
              ? "reverse requestId mismatch"
              : reverseResult?.error ?? "reverse failed",
        });
        continue;
      }

      const reverseSourcePath = normalizeWorkspacePath(workspacePath, reverseResult.path);
      const samePath =
        normalizeForCompare(reverseSourcePath) === normalizeForCompare(expectedSourcePath);
      const lineDiff =
        samePath && Number.isFinite(reverseResult.line)
          ? Math.abs(reverseResult.line - item.lineNumber)
          : Number.POSITIVE_INFINITY;
      const pass = Boolean(samePath && lineDiff <= lineTolerance);
      const exact = pass && lineDiff === 0;

      results.push({
        ...item,
        forwardOk: true,
        measurable: true,
        reverseOk: true,
        samePath,
        lineDiff,
        pass,
        exact,
        reverseLine: reverseResult.line ?? null,
      });
    }

    const forwardFailCount = results.filter((item) => item.forwardOk === false && item.measurable !== false).length;
    const unmeasurableForwardCount = results.filter((item) => item.forwardOk === false && item.measurable === false).length;
    const reverseFailCount = results.filter((item) => item.forwardOk === true && item.reverseOk === false).length;
    const measurableResults = results.filter((item) => item.measurable !== false);
    const passCount = measurableResults.filter((item) => item.pass === true).length;
    const exactCount = measurableResults.filter((item) => item.exact === true).length;
    const total = measurableResults.length;
    const passRate = total > 0 ? passCount / total : 0;
    const exactRate = total > 0 ? exactCount / total : 0;
    const failed = measurableResults.filter((item) => item.pass === false);

    const byCategory = new Map();
    for (const item of measurableResults) {
      const bucket = byCategory.get(item.category) ?? {
        category: item.category,
        total: 0,
        pass: 0,
        exact: 0,
      };
      bucket.total += 1;
      if (item.pass) {
        bucket.pass += 1;
      }
      if (item.exact) {
        bucket.exact += 1;
      }
      byCategory.set(item.category, bucket);
    }
    const categoryRows = Array.from(byCategory.values()).sort((left, right) =>
      left.category.localeCompare(right.category)
    );

    log(
      `result: total=${total} pass=${passCount} exact=${exactCount} ` +
        `forwardFail=${forwardFailCount} reverseFail=${reverseFailCount} unmeasurableForward=${unmeasurableForwardCount}`
    );
    log(`rates: pass=${passRate.toFixed(4)} exact=${exactRate.toFixed(4)} tolerance=${lineTolerance}`);
    for (const row of categoryRows) {
      const rowPassRate = row.total > 0 ? row.pass / row.total : 0;
      const rowExactRate = row.total > 0 ? row.exact / row.total : 0;
      log(
        `category ${row.category}: total=${row.total} pass=${row.pass} exact=${row.exact} ` +
          `passRate=${rowPassRate.toFixed(4)} exactRate=${rowExactRate.toFixed(4)}`
      );
    }

    if (failed.length > 0) {
      log(`failed (${failed.length}):`);
      failed.slice(0, 60).forEach((item) => {
        const reason = item.reason || item.reverseError || "line mismatch";
        log(
          `- ${item.id} ${item.relativePath}:${item.lineNumber} marker=${item.markerLine} ` +
            `lineDiff=${item.lineDiff} reason=${reason}`
        );
      });
    }

    assert.strictEqual(forwardFailCount, 0, `SyncTeX forward failures detected (${forwardFailCount})`);
    if (!allowUnmeasurableForward) {
      assert.strictEqual(
        unmeasurableForwardCount,
        0,
        `Unmeasurable forward failures detected (${unmeasurableForwardCount})`
      );
    }
    assert.strictEqual(reverseFailCount, 0, `SyncTeX reverse failures detected (${reverseFailCount})`);
    assert.ok(passRate >= minPassRate, `passRate ${passRate.toFixed(4)} < ${minPassRate.toFixed(4)}`);
    assert.ok(exactRate >= minExactRate, `exactRate ${exactRate.toFixed(4)} < ${minExactRate.toFixed(4)}`);
    assert.strictEqual(failed.length, 0, `SyncTeX pass failures detected (${failed.length})`);
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
