#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { SynctexService } = require("../electron/services/synctex.cjs");

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  ".tex64",
  "node_modules",
  "Resources",
  "dist",
  "tmp",
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toPositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const toNonNegativeInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const normalizePath = (targetPath) => {
  if (!targetPath || typeof targetPath !== "string") {
    return null;
  }
  const resolved = path.resolve(targetPath);
  try {
    if (fs.realpathSync.native) {
      return fs.realpathSync.native(resolved);
    }
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
};

const pathsEqual = (a, b) => {
  const normA = normalizePath(a);
  const normB = normalizePath(b);
  if (!normA || !normB) {
    return false;
  }
  if (process.platform === "win32") {
    return normA.toLowerCase() === normB.toLowerCase();
  }
  return normA === normB;
};

const isRetryableSynctexError = (error) =>
  typeof error === "string" &&
  (error.includes("位置情報") || error.includes("解析に失敗"));

const getForwardTargetDiff = (forwardResult, expectedLine) => {
  if (!forwardResult || forwardResult.ok !== true || !Number.isFinite(expectedLine)) {
    return Number.POSITIVE_INFINITY;
  }
  if (forwardResult.roundtripSameSourcePath === false) {
    return Number.POSITIVE_INFINITY;
  }
  if (
    forwardResult.roundtripSameSourcePath === true &&
    Number.isFinite(forwardResult.roundtripLine)
  ) {
    return Math.abs(forwardResult.roundtripLine - expectedLine);
  }
  if (forwardResult.sameSourcePath === true && Number.isFinite(forwardResult.matchedLine)) {
    return Math.abs(forwardResult.matchedLine - expectedLine);
  }
  return Number.POSITIVE_INFINITY;
};

const isLowQualityForwardResult = (forwardResult, expectedLine = null) => {
  if (!forwardResult || forwardResult.ok !== true) {
    return false;
  }
  const targetDiff = getForwardTargetDiff(forwardResult, expectedLine);
  if (Number.isFinite(targetDiff)) {
    return targetDiff > 1;
  }
  if (forwardResult.roundtripSameSourcePath === false) {
    return true;
  }
  if (Number.isFinite(forwardResult.roundtripDiff)) {
    return forwardResult.roundtripDiff > 1;
  }
  if (forwardResult.sameSourcePath === false) {
    return true;
  }
  if (Number.isFinite(forwardResult.matchDiff)) {
    return forwardResult.matchDiff > 1;
  }
  return false;
};

const isSkippableLine = (lineText) => {
  if (typeof lineText !== "string") {
    return false;
  }
  const trimmed = lineText.trim();
  if (!trimmed) {
    return true;
  }
  return trimmed.startsWith("%");
};

const findColumn = (lineText) => {
  if (typeof lineText !== "string" || lineText.length === 0) {
    return 1;
  }
  const index = lineText.search(/\S/);
  return index >= 0 ? index + 1 : 1;
};

const parseArgs = (argv) => {
  const options = {
    workspace: path.resolve(process.cwd(), "test-workspace"),
    pdf: null,
    main: "main.tex",
    sources: [],
    sourceDirs: [],
    includeSkippable: false,
    includeStructural: false,
    maxCases: 0,
    repeat: 1,
    retryAttempts: 3,
    retryDelayMs: 200,
    backtrackMax: 160,
    fallbackToTop: true,
    lineTolerance: 1,
    strict: false,
    minPassRate: null,
    minExactRate: null,
    maxForwardFailRate: null,
    maxReverseFailRate: null,
    maxFallbackRate: null,
    build: false,
    buildEngine: "lualatex",
    jsonOut: null,
    printFailures: 25,
    progressEvery: 50,
    probeBypassHint: true,
  };

  const args = [...argv];
  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      continue;
    }
    if (token === "--workspace") {
      options.workspace = path.resolve(args.shift() ?? options.workspace);
      continue;
    }
    if (token === "--pdf") {
      options.pdf = args.shift() ?? options.pdf;
      continue;
    }
    if (token === "--main") {
      options.main = args.shift() ?? options.main;
      continue;
    }
    if (token === "--source") {
      const next = args.shift();
      if (next) {
        options.sources.push(next);
      }
      continue;
    }
    if (token === "--source-dir") {
      const next = args.shift();
      if (next) {
        options.sourceDirs.push(next);
      }
      continue;
    }
    if (token === "--include-skippable") {
      options.includeSkippable = true;
      continue;
    }
    if (token === "--include-structural-lines") {
      options.includeStructural = true;
      continue;
    }
    if (token === "--max-cases") {
      options.maxCases = Math.max(0, toNonNegativeInt(args.shift(), options.maxCases));
      continue;
    }
    if (token === "--repeat") {
      options.repeat = Math.max(1, toPositiveInt(args.shift(), options.repeat));
      continue;
    }
    if (token === "--retry-attempts") {
      options.retryAttempts = Math.max(1, toPositiveInt(args.shift(), options.retryAttempts));
      continue;
    }
    if (token === "--retry-delay-ms") {
      options.retryDelayMs = Math.max(0, toNonNegativeInt(args.shift(), options.retryDelayMs));
      continue;
    }
    if (token === "--backtrack-max") {
      options.backtrackMax = Math.max(0, toNonNegativeInt(args.shift(), options.backtrackMax));
      continue;
    }
    if (token === "--no-fallback-to-top") {
      options.fallbackToTop = false;
      continue;
    }
    if (token === "--line-tolerance") {
      options.lineTolerance = Math.max(0, toNonNegativeInt(args.shift(), options.lineTolerance));
      continue;
    }
    if (token === "--strict") {
      options.strict = true;
      continue;
    }
    if (token === "--min-pass-rate") {
      options.minPassRate = toNumber(args.shift(), options.minPassRate);
      continue;
    }
    if (token === "--min-exact-rate") {
      options.minExactRate = toNumber(args.shift(), options.minExactRate);
      continue;
    }
    if (token === "--max-forward-fail-rate") {
      options.maxForwardFailRate = toNumber(args.shift(), options.maxForwardFailRate);
      continue;
    }
    if (token === "--max-reverse-fail-rate") {
      options.maxReverseFailRate = toNumber(args.shift(), options.maxReverseFailRate);
      continue;
    }
    if (token === "--max-fallback-rate") {
      options.maxFallbackRate = toNumber(args.shift(), options.maxFallbackRate);
      continue;
    }
    if (token === "--build") {
      options.build = true;
      continue;
    }
    if (token === "--build-engine") {
      options.buildEngine = args.shift() ?? options.buildEngine;
      continue;
    }
    if (token === "--json-out") {
      options.jsonOut = args.shift() ?? options.jsonOut;
      continue;
    }
    if (token === "--print-failures") {
      options.printFailures = Math.max(0, toNonNegativeInt(args.shift(), options.printFailures));
      continue;
    }
    if (token === "--progress-every") {
      options.progressEvery = Math.max(0, toNonNegativeInt(args.shift(), options.progressEvery));
      continue;
    }
    if (token === "--probe-with-hint") {
      options.probeBypassHint = false;
      continue;
    }
    if (token === "--help" || token === "-h") {
      printHelpAndExit(0);
    }
    console.error(`[synctex-bench] unknown option: ${token}`);
    printHelpAndExit(1);
  }

  if (options.strict) {
    if (options.minPassRate === null) {
      options.minPassRate = 0.995;
    }
    if (options.minExactRate === null) {
      options.minExactRate = 0.75;
    }
    if (options.maxForwardFailRate === null) {
      options.maxForwardFailRate = 0.01;
    }
    if (options.maxReverseFailRate === null) {
      options.maxReverseFailRate = 0.01;
    }
    if (options.maxFallbackRate === null) {
      options.maxFallbackRate = 0.05;
    }
  }

  return options;
};

const printHelpAndExit = (statusCode) => {
  const help = `
Usage:
  node scripts/synctex-forward-bench.cjs [options]

Options:
  --workspace <path>          Workspace root (default: ./test-workspace)
  --pdf <path>                PDF path (workspace-relative or absolute)
  --main <path>               Main TeX for --build (default: main.tex)
  --source <path>             TeX source to test (repeatable). If omitted, all .tex are tested.
  --source-dir <path>         Directory to test recursively (repeatable).
  --include-skippable         Include empty/comment lines as targets.
  --include-structural-lines  Include preamble and \\input/\\include lines.
  --max-cases <n>             Limit tested line count (0 = no limit)
  --repeat <n>                Repeat benchmark runs
  --retry-attempts <n>        Forward retry attempts on retryable errors (default: 3)
  --retry-delay-ms <n>        Delay between retries in ms (default: 200)
  --backtrack-max <n>         Max lines to backtrack (default: 160)
  --no-fallback-to-top        Disable top-line fallback
  --line-tolerance <n>        Allowed round-trip line delta (default: 1)
  --build                     Run latexmk before each run
  --build-engine <engine>     Build engine flag: lualatex|pdflatex|xelatex|uplatex
  --strict                    Enable quality gate defaults
  --min-pass-rate <0..1>      Gate: minimum pass rate
  --min-exact-rate <0..1>     Gate: minimum exact rate
  --max-forward-fail-rate <0..1> Gate: max forward fail rate
  --max-reverse-fail-rate <0..1> Gate: max reverse fail rate
  --max-fallback-rate <0..1>  Gate: max fallback rate
  --json-out <path>           Write detailed JSON result
  --print-failures <n>        Print first n failed cases (default: 25)
  --progress-every <n>        Progress log interval by case count (default: 50)
  --probe-with-hint           Use forward hint cache in quality probes (default: off)
`;
  process.stdout.write(help.trimStart());
  process.stdout.write("\n");
  process.exit(statusCode);
};

const runCommand = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd, env: process.env });
    let output = "";
    proc.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    proc.on("error", (error) => reject(error));
    proc.on("close", (code) => resolve({ status: code ?? 1, output }));
  });

const resolvePdfPath = (workspacePath, configuredPdf) => {
  if (configuredPdf) {
    const target = path.isAbsolute(configuredPdf)
      ? configuredPdf
      : path.join(workspacePath, configuredPdf);
    if (fs.existsSync(target)) {
      return target;
    }
    return null;
  }
  const candidates = [
    path.join(workspacePath, "main.pdf"),
    path.join(workspacePath, "build", "main.pdf"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

const collectTexFiles = (workspacePath, configuredSources, configuredSourceDirs) => {
  const collectFromDir = (baseDir) => {
    const collected = [];
    const walk = (dirPath) => {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const name = entry.name;
        const fullPath = path.join(dirPath, name);
        if (entry.isDirectory()) {
          if (DEFAULT_IGNORED_DIRS.has(name)) {
            continue;
          }
          walk(fullPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        if (name.endsWith(".tex")) {
          collected.push(fullPath);
        }
      }
    };
    walk(baseDir);
    return collected;
  };

  if (configuredSources.length > 0) {
    return configuredSources
      .map((source) => (path.isAbsolute(source) ? source : path.join(workspacePath, source)))
      .filter((target) => target.endsWith(".tex") && fs.existsSync(target))
      .sort();
  }
  if (configuredSourceDirs.length > 0) {
    const all = [];
    for (const sourceDir of configuredSourceDirs) {
      const fullDir = path.isAbsolute(sourceDir)
        ? sourceDir
        : path.join(workspacePath, sourceDir);
      if (!fs.existsSync(fullDir) || !fs.statSync(fullDir).isDirectory()) {
        continue;
      }
      all.push(...collectFromDir(fullDir));
    }
    return Array.from(new Set(all)).sort();
  }
  return collectFromDir(workspacePath).sort();
};

const isStructuralLine = (lineText) => {
  if (typeof lineText !== "string") {
    return false;
  }
  const trimmed = lineText.trim();
  if (!trimmed) {
    return false;
  }
  if (
    /^\\(?:begin|end|label|caption|centering|toprule|midrule|bottomrule|hline|cline)\b/.test(
      trimmed
    )
  ) {
    return true;
  }
  if (/\\\\\s*$/.test(trimmed)) {
    return true;
  }
  if (/(^|[^\\])&/.test(trimmed)) {
    return true;
  }
  if (
    /^\\(?:input|include|subfile|import|includeonly)\b/.test(trimmed) ||
    /^\\(?:begin\{document\}|end\{document\}|maketitle|tableofcontents|listoffigures|listoftables|appendix|bibliography|bibliographystyle|printbibliography)\b/.test(
      trimmed
    )
  ) {
    return true;
  }
  return false;
};

const runBuild = async (workspacePath, mainFile, engine) => {
  const engineFlagMap = {
    lualatex: "-lualatex",
    pdflatex: "-pdf",
    xelatex: "-xelatex",
    uplatex: "-pdfdvi",
  };
  const engineFlag = engineFlagMap[engine] ?? engineFlagMap.lualatex;
  const mainPath = path.isAbsolute(mainFile) ? mainFile : path.join(workspacePath, mainFile);
  if (!fs.existsSync(mainPath)) {
    return { ok: false, error: `main file not found: ${mainPath}` };
  }
  const relativeMain = path.relative(workspacePath, mainPath);
  const args = [
    "-g",
    engineFlag,
    "-synctex=1",
    "-interaction=nonstopmode",
    "-halt-on-error",
    "-file-line-error",
    relativeMain,
  ];
  let result;
  try {
    result = await runCommand("latexmk", args, workspacePath);
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
  if (result.status !== 0) {
    return { ok: false, error: "latexmk failed", log: result.output };
  }
  return { ok: true, log: result.output };
};

const executeForwardLikeApp = async (service, payload, options) => {
  const { sourcePath, targetLine, targetColumn, lineText, pdfPath } = payload;
  const attachRoundtripProbe = async (forwardResult, forwardLine) => {
    if (!forwardResult || forwardResult.ok !== true) {
      return forwardResult;
    }
    let reverseProbe = null;
    try {
      reverseProbe = await service.reverse({
        page: forwardResult.page,
        x: forwardResult.x,
        y: forwardResult.y,
        pdfPath,
        refineLines: 0,
        bypassHint: options.probeBypassHint,
        allowExpandedOffsets: false,
      });
    } catch {
      reverseProbe = null;
    }
    if (!reverseProbe?.ok) {
      return {
        ...forwardResult,
        roundtripSameSourcePath: false,
        roundtripDiff: Number.POSITIVE_INFINITY,
      };
    }
    const sameSourcePath = pathsEqual(reverseProbe.path, sourcePath);
    const roundtripDiff =
      sameSourcePath &&
      Number.isFinite(reverseProbe.line) &&
      Number.isFinite(forwardLine)
        ? Math.abs(reverseProbe.line - forwardLine)
        : Number.POSITIVE_INFINITY;
    return {
      ...forwardResult,
      roundtripPath: reverseProbe.path,
      roundtripLine: reverseProbe.line,
      roundtripSameSourcePath: sameSourcePath,
      roundtripDiff,
    };
  };
  const runForward = async (line, column) => {
    let attempts = 0;
    let retries = 0;
    let result = null;
    for (let attempt = 0; attempt < options.retryAttempts; attempt += 1) {
      if (attempt > 0) {
        retries += 1;
        await sleep(options.retryDelayMs);
      }
      attempts += 1;
      result = await service.forward({
        sourcePath,
        line: Number.isFinite(line) ? line : 1,
        column: Number.isFinite(column) ? column : 1,
        pdfPath,
        hintLine: targetLine,
        hintColumn: Number.isFinite(targetColumn) ? targetColumn : 1,
      });
      if (result.ok) {
        result = await attachRoundtripProbe(result, line);
      }
      if (result.ok || !isRetryableSynctexError(result.error)) {
        break;
      }
    }
    return { result, attempts, retries };
  };

  const preferBacktrack = isSkippableLine(lineText);
  let attempts = 0;
  let retries = 0;
  let mode = "direct";
  let usedLine = targetLine;
  let backtrackOffset = 0;
  let result = null;

  if (!preferBacktrack) {
    const direct = await runForward(targetLine, targetColumn);
    attempts += direct.attempts;
    retries += direct.retries;
    result = direct.result;
  } else {
    result = { ok: false, error: "skip" };
    mode = "skip-direct";
  }

  let bestLowQualitySuccess =
    result.ok && isLowQualityForwardResult(result, targetLine)
      ? {
          result,
          offset: 0,
          matchDiff: getForwardTargetDiff(result, targetLine),
        }
      : null;
  if (
    preferBacktrack ||
    (!result.ok && isRetryableSynctexError(result.error)) ||
    isLowQualityForwardResult(result, targetLine)
  ) {
    for (let offset = 1; offset <= options.backtrackMax; offset += 1) {
      const candidateLine = targetLine - offset;
      if (candidateLine < 1) {
        break;
      }
      const candidate = await runForward(candidateLine, targetColumn);
      attempts += candidate.attempts;
      retries += candidate.retries;
      if (candidate.result.ok) {
        const candidateLowQuality = isLowQualityForwardResult(
          candidate.result,
          targetLine
        );
        if (!candidateLowQuality) {
          result = { ...candidate.result, fallback: true };
          usedLine = candidateLine;
          mode = "backtrack";
          backtrackOffset = offset;
          break;
        }
        const candidateMatchDiff = getForwardTargetDiff(
          candidate.result,
          targetLine
        );
        const candidateScore = {
          result: { ...candidate.result, fallback: true },
          offset,
          matchDiff: candidateMatchDiff,
        };
        if (!bestLowQualitySuccess) {
          bestLowQualitySuccess = candidateScore;
          continue;
        }
        const currentSamePath = bestLowQualitySuccess.result.sameSourcePath === true;
        const nextSamePath = candidateScore.result.sameSourcePath === true;
        if (nextSamePath && !currentSamePath) {
          bestLowQualitySuccess = candidateScore;
          continue;
        }
        if (nextSamePath === currentSamePath) {
          if (candidateScore.matchDiff < bestLowQualitySuccess.matchDiff) {
            bestLowQualitySuccess = candidateScore;
            continue;
          }
          if (
            candidateScore.matchDiff === bestLowQualitySuccess.matchDiff &&
            candidateScore.offset < bestLowQualitySuccess.offset
          ) {
            bestLowQualitySuccess = candidateScore;
          }
        }
        continue;
      }
      if (!isRetryableSynctexError(candidate.result.error)) {
        result = candidate.result;
        usedLine = candidateLine;
        mode = "backtrack-stop";
        backtrackOffset = offset;
        break;
      }
    }
  }

  if ((result.ok && isLowQualityForwardResult(result, targetLine)) || !result.ok) {
    const maxForwardScan = 12;
    for (let offset = 1; offset <= maxForwardScan; offset += 1) {
      const candidateLine = targetLine + offset;
      const candidate = await runForward(candidateLine, targetColumn);
      attempts += candidate.attempts;
      retries += candidate.retries;
      if (
        candidate.result.ok &&
        !isLowQualityForwardResult(candidate.result, targetLine)
      ) {
        result = { ...candidate.result, fallback: true };
        usedLine = candidateLine;
        mode = "forward-scan";
        backtrackOffset = -offset;
        break;
      }
    }
  }

  if (
    ((result.ok && isLowQualityForwardResult(result, targetLine)) || !result.ok) &&
    bestLowQualitySuccess?.result?.ok
  ) {
    result = bestLowQualitySuccess.result;
    if (bestLowQualitySuccess.offset > 0) {
      usedLine = targetLine - bestLowQualitySuccess.offset;
      mode = "backtrack";
      backtrackOffset = bestLowQualitySuccess.offset;
    }
  }

  if (!result.ok && options.fallbackToTop) {
    const top = await runForward(1, 1);
    attempts += top.attempts;
    retries += top.retries;
    usedLine = 1;
    mode = "top-fallback";
    if (top.result.ok) {
      result = { ...top.result, fallback: true };
    } else {
      result = top.result;
    }
  }

  return {
    result,
    mode,
    usedLine,
    backtrackOffset,
    attempts,
    retries,
    preferBacktrack,
  };
};

const safeRate = (numerator, denominator) =>
  denominator > 0 ? numerator / denominator : 0;

const buildSummary = (cases) => {
  const total = cases.length;
  const forwardFailed = cases.filter((item) => !item.forwardOk).length;
  const reverseFailed = cases.filter((item) => item.forwardOk && !item.reverseOk).length;
  const roundtripOk = cases.filter((item) => item.pass).length;
  const exact = cases.filter((item) => item.exact).length;
  const fallbackUsed = cases.filter((item) => item.fallbackUsed).length;
  const backtrackUsed = cases.filter((item) => item.mode === "backtrack").length;
  const topFallbackUsed = cases.filter((item) => item.mode === "top-fallback").length;
  const wrongFile = cases.filter((item) => item.reverseOk && !item.sameFile).length;
  const totalAttempts = cases.reduce((acc, item) => acc + item.attempts, 0);
  const totalRetries = cases.reduce((acc, item) => acc + item.retries, 0);

  return {
    total,
    forwardFailed,
    reverseFailed,
    roundtripOk,
    exact,
    wrongFile,
    fallbackUsed,
    backtrackUsed,
    topFallbackUsed,
    totalAttempts,
    totalRetries,
    passRate: safeRate(roundtripOk, total),
    exactRate: safeRate(exact, total),
    forwardFailRate: safeRate(forwardFailed, total),
    reverseFailRate: safeRate(reverseFailed, total),
    fallbackRate: safeRate(fallbackUsed, total),
  };
};

const evaluateGate = (summary, options) => {
  const failures = [];
  const assertMin = (value, threshold, label) => {
    if (threshold === null || threshold === undefined) {
      return;
    }
    if (value < threshold) {
      failures.push(`${label}: ${value.toFixed(4)} < ${threshold.toFixed(4)}`);
    }
  };
  const assertMax = (value, threshold, label) => {
    if (threshold === null || threshold === undefined) {
      return;
    }
    if (value > threshold) {
      failures.push(`${label}: ${value.toFixed(4)} > ${threshold.toFixed(4)}`);
    }
  };
  assertMin(summary.passRate, options.minPassRate, "passRate");
  assertMin(summary.exactRate, options.minExactRate, "exactRate");
  assertMax(summary.forwardFailRate, options.maxForwardFailRate, "forwardFailRate");
  assertMax(summary.reverseFailRate, options.maxReverseFailRate, "reverseFailRate");
  assertMax(summary.fallbackRate, options.maxFallbackRate, "fallbackRate");
  return failures;
};

const printRunSummary = (runIndex, summary) => {
  const head = `[run ${runIndex}]`;
  console.log(
    `${head} total=${summary.total} pass=${summary.roundtripOk} exact=${summary.exact} ` +
      `forwardFail=${summary.forwardFailed} reverseFail=${summary.reverseFailed} ` +
      `fallback=${summary.fallbackUsed}`
  );
  console.log(
    `${head} rates pass=${summary.passRate.toFixed(4)} exact=${summary.exactRate.toFixed(
      4
    )} ` +
      `forwardFail=${summary.forwardFailRate.toFixed(4)} reverseFail=${summary.reverseFailRate.toFixed(
        4
      )} fallback=${summary.fallbackRate.toFixed(4)}`
  );
};

const printFailures = (cases, limit, workspacePath) => {
  if (limit <= 0) {
    return;
  }
  const failed = cases.filter((item) => !item.pass);
  if (failed.length === 0) {
    return;
  }
  console.log(`[failures] showing first ${Math.min(limit, failed.length)} of ${failed.length}`);
  for (const item of failed.slice(0, limit)) {
    const relative = path.relative(workspacePath, item.sourcePath);
    const detail =
      item.forwardOk && item.reverseOk
        ? `reverse=${item.reversePath}:${item.reverseLine} diff=${item.lineDiff}`
        : !item.forwardOk
        ? `forwardError=${item.forwardError}`
        : `reverseError=${item.reverseError}`;
    console.log(
      `  - ${relative}:${item.targetLine}:${item.targetColumn} mode=${item.mode} ` +
        `usedLine=${item.usedLine} ${detail}`
    );
  }
};

const runSingleBenchmark = async ({ runIndex, options, workspacePath, pdfPath, cases }) => {
  const service = new SynctexService();
  const results = [];

  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];
    const progressEvery = options.progressEvery;
    if (progressEvery > 0 && index > 0 && index % progressEvery === 0) {
      console.log(`[run ${runIndex}] progress ${index}/${cases.length}`);
    }
    const forwardLike = await executeForwardLikeApp(
      service,
      {
        sourcePath: item.sourcePath,
        targetLine: item.lineNumber,
        targetColumn: item.column,
        lineText: item.lineText,
        pdfPath,
      },
      options
    );

    const forwardOk = forwardLike.result?.ok === true;
    if (!forwardOk) {
      results.push({
        sourcePath: item.sourcePath,
        targetLine: item.lineNumber,
        targetColumn: item.column,
        usedLine: forwardLike.usedLine,
        mode: forwardLike.mode,
        attempts: forwardLike.attempts,
        retries: forwardLike.retries,
        fallbackUsed: forwardLike.result?.fallback === true || forwardLike.mode === "top-fallback",
        forwardOk: false,
        forwardError: forwardLike.result?.error ?? "unknown forward error",
        reverseOk: false,
        reverseError: null,
        reversePath: null,
        reverseLine: null,
        lineDiff: null,
        sameFile: false,
        pass: false,
        exact: false,
      });
      continue;
    }

    let reverseResult;
    try {
      reverseResult = await service.reverse({
        page: forwardLike.result.page,
        x: forwardLike.result.x,
        y: forwardLike.result.y,
        pdfPath,
        bypassHint: options.probeBypassHint,
      });
    } catch (error) {
      reverseResult = { ok: false, error: error?.message ?? String(error) };
    }
    const reverseOk = reverseResult?.ok === true;
    const sameFile = reverseOk && pathsEqual(reverseResult.path, item.sourcePath);
    const lineDiff =
      reverseOk && Number.isFinite(reverseResult.line)
        ? Math.abs(reverseResult.line - item.lineNumber)
        : null;
    const pass = Boolean(reverseOk && sameFile && lineDiff !== null && lineDiff <= options.lineTolerance);
    const exact = Boolean(reverseOk && sameFile && lineDiff === 0);

    results.push({
      sourcePath: item.sourcePath,
      targetLine: item.lineNumber,
      targetColumn: item.column,
      usedLine: forwardLike.usedLine,
      mode: forwardLike.mode,
      attempts: forwardLike.attempts,
      retries: forwardLike.retries,
      fallbackUsed: forwardLike.result?.fallback === true || forwardLike.mode === "top-fallback",
      forwardOk: true,
      forwardError: null,
      reverseOk,
      reverseError: reverseOk ? null : reverseResult?.error ?? "unknown reverse error",
      reversePath: reverseOk ? reverseResult.path : null,
      reverseLine: reverseOk ? reverseResult.line : null,
      lineDiff,
      sameFile,
      pass,
      exact,
      confidence: reverseOk ? reverseResult.confidence === true : false,
      scoreGap: reverseOk && Number.isFinite(reverseResult.scoreGap) ? reverseResult.scoreGap : null,
      distance: reverseOk && Number.isFinite(reverseResult.distance) ? reverseResult.distance : null,
    });
  }

  const summary = buildSummary(results);
  return { summary, cases: results };
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const workspacePath = options.workspace;
  if (!fs.existsSync(workspacePath)) {
    throw new Error(`workspace not found: ${workspacePath}`);
  }

  const pdfPath = resolvePdfPath(workspacePath, options.pdf);
  if (!pdfPath) {
    throw new Error("pdf not found. specify --pdf or build once to create main.pdf.");
  }

  const sourceFiles = collectTexFiles(workspacePath, options.sources, options.sourceDirs);
  if (sourceFiles.length === 0) {
    throw new Error("no .tex files found.");
  }

  const sourceLines = [];
  for (const sourcePath of sourceFiles) {
    const raw = fs.readFileSync(sourcePath, "utf8");
    const lines = raw.split(/\r?\n/);
    const beginDocIndex = lines.findIndex((line) => /\\begin\{document\}/.test(line));
    lines.forEach((lineText, index) => {
      const inPreamble = beginDocIndex >= 0 && index < beginDocIndex;
      const structural = inPreamble || isStructuralLine(lineText);
      sourceLines.push({
        sourcePath,
        lineNumber: index + 1,
        lineText,
        column: findColumn(lineText),
        structural,
      });
    });
  }

  const candidateCases = sourceLines.filter((item) => {
    if (!options.includeSkippable && isSkippableLine(item.lineText)) {
      return false;
    }
    if (!options.includeStructural && item.structural) {
      return false;
    }
    return true;
  });
  const cases =
    options.maxCases > 0 ? candidateCases.slice(0, options.maxCases) : candidateCases;
  if (cases.length === 0) {
    throw new Error("no candidate lines to test.");
  }

  console.log(`[synctex-bench] workspace=${workspacePath}`);
  console.log(`[synctex-bench] pdf=${pdfPath}`);
  console.log(
    `[synctex-bench] sources=${sourceFiles.length} candidates=${cases.length} repeat=${options.repeat}`
  );

  const runs = [];
  let hasGateFailure = false;
  for (let runIndex = 1; runIndex <= options.repeat; runIndex += 1) {
    if (options.build) {
      console.log(`[run ${runIndex}] build start`);
      const buildResult = await runBuild(workspacePath, options.main, options.buildEngine);
      if (!buildResult.ok) {
        console.error(`[run ${runIndex}] build failed: ${buildResult.error}`);
        if (buildResult.log) {
          console.error(buildResult.log);
        }
        process.exit(1);
      }
      console.log(`[run ${runIndex}] build done`);
    }
    const benchmark = await runSingleBenchmark({
      runIndex,
      options,
      workspacePath,
      pdfPath,
      cases,
    });
    printRunSummary(runIndex, benchmark.summary);
    printFailures(benchmark.cases, options.printFailures, workspacePath);
    const gateFailures = evaluateGate(benchmark.summary, options);
    if (gateFailures.length > 0) {
      hasGateFailure = true;
      console.error(`[run ${runIndex}] gate failed`);
      gateFailures.forEach((item) => console.error(`  - ${item}`));
    }
    runs.push({
      runIndex,
      summary: benchmark.summary,
      gateFailures,
      cases: benchmark.cases,
    });
  }

  const aggregate = {
    runs: runs.length,
    averagePassRate: safeRate(runs.reduce((acc, run) => acc + run.summary.passRate, 0), runs.length),
    averageExactRate: safeRate(runs.reduce((acc, run) => acc + run.summary.exactRate, 0), runs.length),
    worstPassRate: runs.reduce(
      (acc, run) => Math.min(acc, run.summary.passRate),
      Number.POSITIVE_INFINITY
    ),
    worstExactRate: runs.reduce(
      (acc, run) => Math.min(acc, run.summary.exactRate),
      Number.POSITIVE_INFINITY
    ),
  };

  console.log(
    `[aggregate] avgPass=${aggregate.averagePassRate.toFixed(4)} avgExact=${aggregate.averageExactRate.toFixed(
      4
    )} worstPass=${aggregate.worstPassRate.toFixed(4)} worstExact=${aggregate.worstExactRate.toFixed(4)}`
  );

  if (options.jsonOut) {
    const jsonPath = path.isAbsolute(options.jsonOut)
      ? options.jsonOut
      : path.join(workspacePath, options.jsonOut);
    const payload = {
      generatedAt: new Date().toISOString(),
      options: {
        ...options,
        workspace: workspacePath,
        pdf: pdfPath,
      },
      sourceFiles: sourceFiles.map((sourcePath) => path.relative(workspacePath, sourcePath)),
      runs,
      aggregate,
    };
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`[synctex-bench] wrote ${jsonPath}`);
  }

  if (hasGateFailure) {
    process.exit(1);
  }
};

main().catch((error) => {
  console.error(`[synctex-bench] ${error?.message ?? String(error)}`);
  process.exit(1);
});
