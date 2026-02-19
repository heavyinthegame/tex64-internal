import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import zlib from "node:zlib";
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
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "120", 10);
const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => console.log(`[synctex-e2e ${now()}] ${message}`);
const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
};
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-synctex-"));
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
      const name = entry.name;
      if (name.startsWith(".")) {
        continue;
      }
      const entryPath = path.join(current, name);
      if (entry.isDirectory()) {
        if (skipDirs.has(name)) {
          continue;
        }
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const ext = path.extname(name).toLowerCase();
      if (!staleExtensions.has(ext)) {
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
  await page.waitForSelector("body.is-ready", { timeout: 15000 });
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
    timeout: 20000,
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

const waitForBridgeMessage = async (
  page,
  type,
  timeoutMs = 20000,
  expectedRequestId = null
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await page.evaluate((params) => {
      const expectedType = params.type;
      const expectedRequestId = params.requestId;
      const messages = window.__synctexTestMessages;
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
    }, { type, requestId: expectedRequestId });
    if (message && message.type === type) {
      return message;
    }
    await page.waitForTimeout(15);
  }
  throw new Error(`Timed out waiting for bridge message: ${type}`);
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

const collectTexFiles = async (workspacePath) => {
  const stack = [workspacePath];
  const skipDirs = new Set([".git", ".tex64", "node_modules", "build", "tmp"]);
  const texFiles = [];
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
      if (path.extname(entry.name).toLowerCase() !== ".tex") {
        continue;
      }
      texFiles.push(entryPath);
    }
  }
  texFiles.sort((left, right) => left.localeCompare(right));
  return texFiles;
};

const fileExists = async (value) => {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
};

const realPathSafe = async (value) => {
  try {
    return await fs.realpath(value);
  } catch {
    return null;
  }
};

const collectWorkspaceFilesByExtension = async (workspacePath, extension, skipDirs = []) => {
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
        if (skipSet.has(entry.name)) {
          continue;
        }
        stack.push(entryPath);
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

const resolveSynctexInputPath = async (workspacePath, inputRaw) => {
  if (!inputRaw || typeof inputRaw !== "string") {
    return null;
  }
  const trimmed = inputRaw.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/^\\d+:/, "").trim();
  const normalizedCandidate = normalized.replace(/^"|"$/g, "").trim();
  const absoluteInput = path.isAbsolute(normalizedCandidate)
    ? path.normalize(normalizedCandidate)
    : path.resolve(workspacePath, normalizedCandidate);
  if (path.extname(absoluteInput).toLowerCase() !== ".tex") {
    return null;
  }
  if (!(await fileExists(absoluteInput))) {
    return null;
  }
  const workspaceCandidates = [path.normalize(workspacePath)];
  const workspaceReal = await realPathSafe(path.normalize(workspacePath));
  if (workspaceReal) {
    workspaceCandidates.push(path.normalize(workspaceReal));
  }
  const inputCandidates = [absoluteInput];
  const inputReal = await realPathSafe(absoluteInput);
  if (inputReal) {
    inputCandidates.push(path.normalize(inputReal));
  }
  const isInsideWorkspace = workspaceCandidates.some((workspaceRoot) =>
    inputCandidates.some((candidate) => {
      const relative = path.relative(workspaceRoot, candidate);
      return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
    })
  );
  return isInsideWorkspace ? absoluteInput : null;
};

const collectSynctexInputFiles = async (workspacePath, synctexPath) => {
  const rawSynctex = await fs.readFile(synctexPath);
  const text = zlib.gunzipSync(rawSynctex).toString("utf8");
  const included = new Set();
  const workspaceTexFiles = await collectWorkspaceFilesByExtension(workspacePath, ".tex", [
    ".git",
    ".tex64",
    "node_modules",
    "tmp",
    "build",
  ]);
  const workspaceTexByBasename = new Map();
  for (const workspaceFile of workspaceTexFiles) {
    const basename = path.basename(workspaceFile);
    const existing = workspaceTexByBasename.get(basename);
    if (existing) {
      existing.push(workspaceFile);
      continue;
    }
    workspaceTexByBasename.set(basename, [workspaceFile]);
  }
  const debug = readBoolEnv("E2E_SYNCTEX_DEBUG", false);
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.startsWith("Input:")) {
      continue;
    }
    const inputRaw = rawLine.slice("Input:".length);
    const trimmedInput = inputRaw.trim().replace(/^\\d+:/, "").trim();
    if (trimmedInput === "") {
      continue;
    }
    const workspaceFile = await resolveSynctexInputPath(workspacePath, inputRaw);
    if (!workspaceFile) {
      const absoluteInput = path.isAbsolute(trimmedInput)
        ? path.normalize(trimmedInput)
        : path.resolve(workspacePath, trimmedInput);
      const candidate = workspaceTexByBasename.get(path.basename(absoluteInput));
      if (candidate && candidate.length === 1 && candidate[0]) {
        included.add(path.normalize(candidate[0]));
        continue;
      }
      if (debug) {
        console.log(`synctex-input: skip ${trimmedInput}`);
      }
      continue;
    }
    included.add(path.normalize(workspaceFile));
  }
  const files = Array.from(included).sort((left, right) => left.localeCompare(right));
  return {
    files,
    count: files.length,
  };
};

const findPdfOutputPath = async (workspacePath) => {
  const candidates = [
    path.join(workspacePath, "main.pdf"),
    path.join(workspacePath, "build", "main.pdf"),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  const pdfFiles = await collectWorkspaceFilesByExtension(workspacePath, ".pdf", [".git", ".tex64", "node_modules", "tmp", "build"]);
  return pdfFiles[0] ?? null;
};

const findSynctexPath = async (workspacePath, pdfPath) => {
  const directCandidates = [];
  if (pdfPath) {
    directCandidates.push(`${pdfPath}.synctex.gz`);
    directCandidates.push(path.join(path.dirname(pdfPath), `${path.basename(pdfPath, path.extname(pdfPath))}.synctex.gz`));
    directCandidates.push(path.join(workspacePath, "main.synctex.gz"));
    directCandidates.push(path.join(workspacePath, "build", "main.synctex.gz"));
  } else {
    directCandidates.push(path.join(workspacePath, "main.synctex.gz"));
    directCandidates.push(path.join(workspacePath, "build", "main.synctex.gz"));
  }
  for (const candidate of directCandidates) {
    if (candidate && (await fileExists(candidate))) {
      return candidate;
    }
  }
  const synctexFiles = await collectWorkspaceFilesByExtension(workspacePath, ".synctex.gz", [
    ".git",
    ".tex64",
    "node_modules",
    "tmp",
    "build",
  ]);
  return synctexFiles[0] ?? null;
};

const collectSynctexCases = async (
  workspacePath,
  includedSourceFiles,
  { maxLinesPerFile = 0, maxTotalCases = 0, includeUnstableLines = false } = {}
) => {
  const sourceFiles = includedSourceFiles.length > 0
    ? includedSourceFiles
    : await collectTexFiles(workspacePath);
  const skipEnvironments = new Set([
    "align",
    "align*",
    "alignat",
    "aligned",
    "alignedat",
    "eqnarray",
    "equation",
    "equation*",
    "cases",
    "displaymath",
    "gather",
    "gathered",
    "multline",
    "multline*",
    "matrix",
    "pmatrix",
    "bmatrix",
    "Bmatrix",
    "smallmatrix",
    "table",
    "table*",
    "tabular",
    "tabular*",
    "verbatim",
    "verbatim*",
  ]);
  const envTokenPattern = /\\(begin|end)\{([^}]+)\}/g;
  const allCases = [];
  let skippedLines = 0;
  const fileSummaries = [];
  const fileSourceSet = new Set(sourceFiles.map((value) => path.normalize(value)));

  for (const sourcePath of Array.from(fileSourceSet)) {
    const rawSource = await fs.readFile(sourcePath, "utf8");
    const lines = rawSource.split(/\r?\n/);
    const fileCandidates = [];
    let inSkippableEnvDepth = 0;
    const hasDocumentEnv = lines.some((lineText) => {
      return typeof lineText === "string" && lineText.trim() === "\\begin{document}";
    });
    let documentStarted = !hasDocumentEnv;
    lines.forEach((lineText, index) => {
      const trimmedLine = typeof lineText === "string" ? lineText.trim() : "";
      if (!documentStarted) {
        if (trimmedLine === "\\begin{document}") {
          documentStarted = true;
        }
        skippedLines += 1;
        return;
      }
      if (trimmedLine === "\\end{document}") {
        return;
      }

      let inSkippableEnvLine = inSkippableEnvDepth > 0;
      let beginSkipEnvLine = false;
      envTokenPattern.lastIndex = 0;
      const matches = [...lineText.matchAll(envTokenPattern)];
      for (const match of matches) {
        const type = match[1];
        const envName = (match[2] ?? "").toLowerCase();
        if (!envName || !skipEnvironments.has(envName)) {
          continue;
        }
        if (type === "begin") {
          inSkippableEnvDepth += 1;
          beginSkipEnvLine = true;
          continue;
        }
        if (type === "end") {
          inSkippableEnvDepth = Math.max(0, inSkippableEnvDepth - 1);
        }
      }

      if (!includeUnstableLines && (inSkippableEnvLine || beginSkipEnvLine)) {
        skippedLines += 1;
        return;
      }
      if (isSkippableLine(lineText) || isStructuralLine(lineText) || isPureCommandLine(lineText)) {
        skippedLines += 1;
        return;
      }
      const lineNumber = index + 1;
      fileCandidates.push({
        sourcePath,
        relativePath: path.relative(workspacePath, sourcePath).split(path.sep).join("/"),
        lineNumber,
        column: findColumn(lineText),
      });
    });
    const sampled = pickEvenly(fileCandidates, maxLinesPerFile);
    fileSummaries.push({
      source: path.relative(workspacePath, sourcePath).split(path.sep).join("/"),
      candidates: fileCandidates.length,
      sampled: sampled.length,
    });
    allCases.push(...sampled);
  }

  const cases = pickEvenly(allCases, maxTotalCases);
  return {
    cases,
    skippedLines,
    totalFiles: sourceFiles.length,
    totalCandidates: allCases.length,
    fileSummaries,
    filteredBySynctex: sourceFiles.length > 0,
  };
};

const normalizeWorkspacePath = (workspacePath, targetPath) => {
  if (!targetPath || typeof targetPath !== "string") return null;
  const resolved = path.isAbsolute(targetPath)
    ? targetPath
    : path.join(workspacePath, targetPath);
  return path.normalize(resolved);
};

const normalizeForCompare = (value) =>
  typeof value === "string" ? path.normalize(value).replace(/\\/g, "/") : null;

const isUnmeasurableForwardError = (message) =>
  typeof message === "string" && message.includes("位置情報");

const runNeighborhoodReverseCheck = async ({
  page,
  basePayload,
  targetLine,
  workspacePath,
  targetPath,
  timeoutMs,
  bypassHint = false,
  refineLines = 3,
  allowExpandedOffsets = true,
}) => {
  const offsets = [-8, 0, 8];
  let successCount = 0;
  let samePathCount = 0;
  let nearLineCount = 0;
  let total = 0;
  const checks = [];

  for (const dx of offsets) {
    for (const dy of offsets) {
      const reverseRequestId = createRequestId("reverse-neigh");
      await postToBridge(page, {
        type: "synctex:reverse",
        requestId: reverseRequestId,
        page: basePayload.page,
        x: basePayload.x + dx,
        y: basePayload.y + dy,
        pdfPath: basePayload.pdfPath,
        bypassHint,
        refineLines,
        allowExpandedOffsets,
      });
      const reverseEnvelope = await waitForBridgeMessage(
        page,
        "synctex:reverseResult",
        timeoutMs,
        reverseRequestId
      );
      const reverseResult = reverseEnvelope?.payload ?? null;
      total += 1;
      if (!reverseResult || reverseResult.ok !== true) {
        checks.push({ dx, dy, ok: false });
        continue;
      }

      successCount += 1;
      const normalizedReturned = normalizeWorkspacePath(workspacePath, reverseResult.path);
      const samePath = normalizedReturned === targetPath;
      if (samePath) {
        samePathCount += 1;
      }
      const lineDistance =
        samePath && Number.isFinite(reverseResult.line)
          ? Math.abs(reverseResult.line - targetLine)
          : Number.POSITIVE_INFINITY;
      if (lineDistance <= 1) {
        nearLineCount += 1;
      }
      checks.push({
        dx,
        dy,
        ok: true,
        samePath,
        lineDistance,
      });
    }
  }

  return {
    total,
    successCount,
    samePathCount,
    nearLineCount,
    checks,
    samePathRate: successCount > 0 ? samePathCount / successCount : 0,
    nearLineRate: successCount > 0 ? nearLineCount / successCount : 0,
  };
};

const run = async () => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  let electronApp;

  const expectedTolerance = readFloatEnv("E2E_SYNCTEX_TOLERANCE", 0);
  const minPassRate = readFloatEnv("E2E_SYNCTEX_MIN_PASS", 1);
  const minExactRate = readFloatEnv("E2E_SYNCTEX_MIN_EXACT", 1);
  const maxLinesPerFile = readIntEnv("E2E_SYNCTEX_MAX_LINES_PER_FILE", 80);
  const maxTotalCases = readIntEnv("E2E_SYNCTEX_MAX_CASES", 0);
  const timeoutMs = readIntEnv("E2E_SYNCTEX_BRIDGE_TIMEOUT_MS", 20000);
  const messageTimeoutMs = Math.max(5000, timeoutMs);
  // Neighborhood checks are optional by default because click offsets near section boundaries
  // can produce deterministic one-off cross-file results even when forward/reverse base mapping is stable.
  const enableNeighborhoodCheck = readBoolEnv("E2E_SYNCTEX_NEIGHBORHOOD", false);
  const neighborhoodStride = readIntEnv("E2E_SYNCTEX_NEIGHBORHOOD_STRIDE", 12);
  const minNeighborhoodSamePathRate = readFloatEnv("E2E_SYNCTEX_NEIGHBORHOOD_MIN_SAME_PATH", 1);
  const minNeighborhoodNearLineRate = readFloatEnv("E2E_SYNCTEX_NEIGHBORHOOD_MIN_NEAR_LINE", 0.6);
  const allowUnmeasurableForward = readBoolEnv("E2E_SYNCTEX_ALLOW_UNMEASURABLE", false);
  const neighborhoodBypassHint = readBoolEnv("E2E_SYNCTEX_NEIGHBORHOOD_BYPASS_HINT", true);
  const reverseBypassHint = readBoolEnv("E2E_SYNCTEX_REVERSE_BYPASS_HINT", true);
  const reverseRefineLines = readIntEnv("E2E_SYNCTEX_REVERSE_REFINE_LINES", 3);
  const reverseAllowExpandedOffsets = readBoolEnv("E2E_SYNCTEX_REVERSE_ALLOW_EXPANDED_OFFSETS", true);
  const includeUnstableLines = readBoolEnv("E2E_SYNCTEX_INCLUDE_UNSTABLE_LINES", false);

  try {
    await cleanupBuildArtifacts(workspacePath);
    log(`workspace copy: ${workspacePath}`);
    electronApp = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      env: { ...process.env, TEX64_E2E_HEADLESS: "1" },
    });
    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1600, height: 980 });

    await initBridgeCollector(page);
    log("opening workspace");
    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);
    await postToBridge(page, { type: "build" });
    await waitForBuildIdle(page);
    await pause(250);
    const pdfPath = await findPdfOutputPath(workspacePath);
    assert.ok(pdfPath, "PDF output not found after build");
    const synctexPath = await findSynctexPath(workspacePath, pdfPath);
    assert.ok(synctexPath, "SyncTeX output not found after build");
    log(`using synctex: ${synctexPath}`);
    const { files: synctexInputFiles, count: synctexInputCount } = await collectSynctexInputFiles(
      workspacePath,
      synctexPath
    );

    const { cases, skippedLines, totalFiles, totalCandidates, filteredBySynctex } =
    await collectSynctexCases(workspacePath, synctexInputFiles, {
      maxLinesPerFile,
      maxTotalCases,
      includeUnstableLines,
    });
    log(`synctex inputs: ${synctexInputCount} files`);
    if (!filteredBySynctex) {
      log("no SyncTeX input files detected; falling back to all tex files");
    }

    assert.ok(cases.length > 0, "no synctex cases collected");
    log(
      `testing ${cases.length} lines across ${totalFiles} files ` +
        `(source lines=${totalCandidates}, skipped=${skippedLines})`
    );

    const results = [];
    let neighborhoodChecks = 0;
    let neighborhoodPathFailCount = 0;
    let neighborhoodNearLineFailCount = 0;

    for (let index = 0; index < cases.length; index += 1) {
      const item = cases[index];

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
        messageTimeoutMs,
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
          sourcePath: item.relativePath,
          line: item.lineNumber,
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

      const expectedSourcePath = normalizeWorkspacePath(workspacePath, item.sourcePath);
      const resolvedForwardPdfPath = forwardResult.pdfPath
        ? normalizeWorkspacePath(workspacePath, forwardResult.pdfPath)
        : pdfPath;
      const forwardPdfPath = resolvedForwardPdfPath || path.join(workspacePath, "main.pdf");
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
        messageTimeoutMs,
        reverseRequestId
      );
      const reverseResult = reverseEnvelope?.payload ?? null;
      const reverseOk = reverseResult?.ok === true;
      if (!reverseOk || reverseEnvelope?.requestId !== reverseRequestId) {
        results.push({
          sourcePath: item.relativePath,
          line: item.lineNumber,
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
      const samePath = reverseSourcePath === expectedSourcePath;
      const lineDiff =
        samePath && Number.isFinite(reverseResult.line)
          ? Math.abs(reverseResult.line - item.lineNumber)
          : Number.POSITIVE_INFINITY;
      const pass = Boolean(samePath && lineDiff <= expectedTolerance);
      const exact = pass && lineDiff === 0;

      const result = {
        sourcePath: item.relativePath,
        line: item.lineNumber,
        forwardOk: true,
        measurable: true,
        reverseOk,
        samePath,
        lineDiff,
        pass,
        exact,
        reverseLine: reverseResult.line ?? null,
        reverseError: null,
      };

      const shouldCheckNeighborhood =
        enableNeighborhoodCheck && neighborhoodStride > 0 && index % neighborhoodStride === 0;
      if (shouldCheckNeighborhood) {
        neighborhoodChecks += 1;
        const neighborhood = await runNeighborhoodReverseCheck({
          page,
          basePayload: {
            page: forwardResult.page,
            x: forwardResult.x,
            y: forwardResult.y,
            pdfPath: forwardPdfPath,
          },
          targetLine: item.lineNumber,
          targetPath: expectedSourcePath,
          workspacePath,
          timeoutMs: messageTimeoutMs,
          bypassHint: neighborhoodBypassHint,
          refineLines: reverseRefineLines,
          allowExpandedOffsets: reverseAllowExpandedOffsets,
        });
        result.neighborhood = neighborhood;
        if (neighborhood.samePathRate < minNeighborhoodSamePathRate) {
          neighborhoodPathFailCount += 1;
          result.pass = false;
          result.exact = false;
          result.neighborhoodFailure = `samePathRate ${neighborhood.samePathRate.toFixed(4)} < ${minNeighborhoodSamePathRate.toFixed(2)}`;
        }
        if (neighborhood.nearLineRate < minNeighborhoodNearLineRate) {
          neighborhoodNearLineFailCount += 1;
          result.pass = false;
          result.exact = false;
          result.neighborhoodFailure = `nearLineRate ${neighborhood.nearLineRate.toFixed(4)} < ${minNeighborhoodNearLineRate.toFixed(2)}`;
        }
      }

      results.push(result);
    }

    const forwardFailCount = results.filter((item) => item.forwardOk === false && item.measurable !== false).length;
    const unmeasurableForwardCount = results.filter((item) => item.forwardOk === false && item.measurable === false).length;
    const reverseFailCount = results.filter((item) => item.forwardOk && item.reverseOk === false).length;
    const neighborhoodFailureCount = results.filter((item) => item.neighborhoodFailure).length;
    const measurable = results.filter((item) => item.measurable !== false);
    const passCount = measurable.filter((item) => item.pass).length;
    const exactCount = measurable.filter((item) => item.exact).length;
    const total = measurable.length;
    const passRate = total > 0 ? passCount / total : 0;
    const exactRate = total > 0 ? exactCount / total : 0;
    const neighborhoodCheckCount = results.filter((item) => item.neighborhood).length;
    const neighborhoodPathFailRate =
      neighborhoodChecks > 0 ? neighborhoodPathFailCount / neighborhoodChecks : 0;
    const neighborhoodNearFailRate =
      neighborhoodChecks > 0 ? neighborhoodNearLineFailCount / neighborhoodChecks : 0;

    log(
      `result: total=${total} pass=${passCount} exact=${exactCount} ` +
        `forwardFail=${forwardFailCount} reverseFail=${reverseFailCount} unmeasurableForward=${unmeasurableForwardCount}`
    );
    log(`rates: pass=${passRate.toFixed(4)} exact=${exactRate.toFixed(4)}`);
    if (neighborhoodFailureCount > 0) {
      log(`neighborhood-failures=${neighborhoodFailureCount}`);
    }
    if (neighborhoodCheckCount > 0) {
      log(
        `neighborhood: checks=${neighborhoodCheckCount} ` +
          `samePathFailRate=${neighborhoodPathFailRate.toFixed(4)} ` +
          `nearLineFailRate=${neighborhoodNearFailRate.toFixed(4)}`
      );
    }

      const failed = results.filter((item) => item.pass === false);
      const failedForward = results.filter((item) => item.forwardOk === false);
      const failedUnmeasurable = results.filter((item) => item.forwardOk === false && item.measurable === false);
      const measurableResults = results.filter((item) => item.measurable !== false);
      const failedReverse = measurableResults.filter((item) => item.forwardOk && item.reverseOk === false);
      const failedNeighborhood = results.filter((item) => item.neighborhoodFailure);
      const nonExact = measurableResults.filter((item) => item.pass === true && item.exact === false);
      if (failedForward.length > 0) {
        log(`fail-forward (${failedForward.length}):`);
        failedForward.slice(0, 30).forEach((item) => {
          log(
            `- ${item.sourcePath}:${item.line} ${item.reason}`
          );
        });
      }
      if (failedReverse.length > 0) {
      log(`fail-reverse (${failedReverse.length}):`);
      failedReverse.slice(0, 30).forEach((item) => {
        log(`- ${item.sourcePath}:${item.line} ${item.reverseError}`);
      });
      }
      if (failedNeighborhood.length > 0) {
        log(`fail-neighborhood (${failedNeighborhood.length}):`);
        failedNeighborhood.slice(0, 30).forEach((item) => {
          log(
            `- ${item.sourcePath}:${item.line} ${item.neighborhoodFailure} ` +
              `(near=${item.neighborhood?.nearLineRate.toFixed(4)}, same=${item.neighborhood?.samePathRate.toFixed(4)})`
          );
        });
      }
      if (nonExact.length > 0) {
        log(`nonExact (${nonExact.length}, exactTolerance=${expectedTolerance}):`);
        nonExact.slice(0, 30).forEach((item) => {
          log(`- ${item.sourcePath}:${item.line} lineDiff=${item.lineDiff}`);
        });
      }
      const failedLineCount = failed.length;
      if (failedLineCount > 0) {
        log(`failed (${failedLineCount}):`);
        failed.slice(0, 30).forEach((item) => {
          log(`- ${item.sourcePath}:${item.line} pass=${item.pass} lineDiff=${item.lineDiff}`);
        });
      }
      if (failedUnmeasurable.length > 0) {
        log(`unmeasurable (${failedUnmeasurable.length}):`);
        failedUnmeasurable.slice(0, 30).forEach((item) => {
          log(`- ${item.sourcePath}:${item.line} reason=${item.reason}`);
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
    if (enableNeighborhoodCheck && neighborhoodCheckCount > 0) {
      assert.ok(
        neighborhoodPathFailRate <= 1 - minNeighborhoodSamePathRate,
        `neighborhood same-path failure rate ${neighborhoodPathFailRate.toFixed(4)} > ${(
          1 - minNeighborhoodSamePathRate
        ).toFixed(4)}`
      );
      assert.ok(
        neighborhoodNearFailRate <= 1 - minNeighborhoodNearLineRate,
        `neighborhood near-line failure rate ${neighborhoodNearFailRate.toFixed(4)} > ${(
          1 - minNeighborhoodNearLineRate
        ).toFixed(4)}`
      );
    }
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
