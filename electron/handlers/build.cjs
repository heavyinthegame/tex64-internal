const createBuildHandlers = (deps) => {
  const {
    fs,
    path,
    buildService,
    formatterService,
    workspace,
    pdfWindowManager,
    synctexService,
    sendBuildState,
    sendIssues,
    sendBuildLog,
    sendToRenderer,
    ensureWorkspace,
    updateWorkspaceIfNeeded,
    handleOpenFile,
    state,
    delay,
  } = deps;

  const resolveWorkspacePathFromRoot = (rootPath, targetPath) => {
    if (!targetPath || typeof targetPath !== "string") {
      return null;
    }
    return path.isAbsolute(targetPath) ? targetPath : path.join(rootPath, targetPath);
  };

  const resolveWorkspaceRelativePath = (rootPath, targetPath) => {
    if (!rootPath || !targetPath || typeof targetPath !== "string") {
      return null;
    }
    if (!path.isAbsolute(targetPath)) {
      return targetPath;
    }
    const relative = path.relative(rootPath, targetPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return null;
    }
    return relative;
  };

  const resolveSynctexWorkspacePath = (rootPath, targetPath) => {
    if (!rootPath || !targetPath || typeof targetPath !== "string") {
      return null;
    }
    const absolutePath = path.isAbsolute(targetPath) ? targetPath : path.join(rootPath, targetPath);
    const workspaceRelative = resolveWorkspaceRelativePath(rootPath, absolutePath);
    if (workspaceRelative) {
      return path.resolve(rootPath, workspaceRelative);
    }
    const fallback = resolveSynctexExternalTexPath(rootPath, absolutePath);
    if (fallback) {
      return fallback;
    }
    return null;
  };

  const isWorkspaceSynctexPathSame = (rootPath, leftPath, rightPath) => {
    const leftResolved = resolveSynctexWorkspacePath(rootPath, leftPath);
    const rightResolved = resolveSynctexWorkspacePath(rootPath, rightPath);
    if (!leftResolved || !rightResolved) {
      return false;
    }
    const normalize = (inputPath) => {
      if (!inputPath || typeof inputPath !== "string") {
        return null;
      }
      let normalized = path.normalize(path.resolve(inputPath));
      try {
        if (typeof fs.realpathSync.native === "function") {
          normalized = fs.realpathSync.native(normalized);
        } else {
          normalized = fs.realpathSync(normalized);
        }
      } catch {
        // Keep resolved path when realpath cannot be resolved.
      }
      normalized = path.normalize(normalized);
      if (process.platform === "win32") {
        return normalized.toLowerCase();
      }
      return normalized;
    };
    return normalize(leftResolved) === normalize(rightResolved);
  };

  let workspaceTexFileCache = [];
  let workspaceTexCacheRoot = null;
  const workspaceTexIgnoreDirs = new Set([".git", "node_modules", ".tex64"]);
  let synctexForwardGeneration = 0;
  const synctexForwardResultCache = new Map();

  const collectWorkspaceTexFiles = (rootPath) => {
    if (!rootPath || typeof rootPath !== "string") {
      return [];
    }
    if (workspaceTexCacheRoot === rootPath) {
      return workspaceTexFileCache;
    }
    const files = [];
    const stack = [rootPath];
    while (stack.length > 0) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (workspaceTexIgnoreDirs.has(entry.name) || entry.name.startsWith(".")) {
            continue;
          }
          stack.push(path.join(current, entry.name));
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        if (!entry.name.toLowerCase().endsWith(".tex")) {
          continue;
        }
        files.push(path.join(current, entry.name));
      }
    }
    workspaceTexCacheRoot = rootPath;
    workspaceTexFileCache = files;
    return files;
  };

  const resolveSynctexExternalTexPath = (rootPath, targetPath) => {
    if (!rootPath || !targetPath || typeof targetPath !== "string") {
      return null;
    }
    if (!path.isAbsolute(targetPath) || !targetPath.toLowerCase().endsWith(".tex")) {
      return null;
    }
    const normalizedTarget = path.normalize(targetPath);
    const targetSegments = normalizedTarget.split(path.sep).filter(Boolean);
    const targetBasename = path.basename(normalizedTarget);
    const texFiles = collectWorkspaceTexFiles(rootPath);
    const matches = texFiles.filter(
      (candidatePath) => path.basename(candidatePath) === targetBasename
    );
    if (matches.length === 0) {
      return null;
    }
    if (matches.length === 1) {
      return matches[0];
    }
    let best = null;
    let bestScore = -1;
    let isAmbiguous = false;
    for (const candidate of matches) {
      const candidateSegments = path.normalize(candidate).split(path.sep).filter(Boolean);
      const maxLength = Math.min(candidateSegments.length, targetSegments.length);
      let score = 0;
      for (let index = 1; index <= maxLength; index += 1) {
        if (candidateSegments[candidateSegments.length - index] !== targetSegments[targetSegments.length - index]) {
          break;
        }
        score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
        isAmbiguous = false;
        continue;
      }
      if (score === bestScore) {
        isAmbiguous = true;
      }
    }
    if (!best || isAmbiguous) {
      return null;
    }
    return best;
  };

  const isSkippableSynctexLine = (sourcePath, lineNumber) => {
    if (!Number.isFinite(lineNumber) || lineNumber < 1) {
      return false;
    }
    try {
      const content = fs.readFileSync(sourcePath, "utf8");
      const lines = content.split(/\r?\n/);
      const line = lines[lineNumber - 1];
      if (typeof line !== "string") {
        return false;
      }
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("%")) {
        return true;
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
      return false;
    } catch {
      return false;
    }
  };

  const readMtimeMs = (targetPath) => {
    if (!targetPath || typeof targetPath !== "string") {
      return 0;
    }
    try {
      const stats = fs.statSync(targetPath);
      const value = Number(stats?.mtimeMs);
      if (Number.isFinite(value) && value >= 0) {
        return value;
      }
      return 0;
    } catch {
      return 0;
    }
  };

  const buildSynctexForwardCacheKey = ({ sourcePath, pdfPath, line, column }) =>
    `${sourcePath}::${pdfPath}::${Math.floor(line)}:${Math.floor(column)}`;

  const pruneSynctexForwardCache = (now = Date.now()) => {
    const maxAgeMs = 8000;
    for (const [key, entry] of synctexForwardResultCache.entries()) {
      if (!entry || now - entry.timestamp > maxAgeMs) {
        synctexForwardResultCache.delete(key);
      }
    }
    const maxEntries = 160;
    if (synctexForwardResultCache.size <= maxEntries) {
      return;
    }
    const entries = Array.from(synctexForwardResultCache.entries()).sort(
      (left, right) => (left[1]?.timestamp ?? 0) - (right[1]?.timestamp ?? 0)
    );
    while (synctexForwardResultCache.size > maxEntries && entries.length > 0) {
      const oldest = entries.shift();
      if (!oldest) {
        break;
      }
      synctexForwardResultCache.delete(oldest[0]);
    }
  };

  const getCachedSynctexForwardResult = ({
    sourcePath,
    pdfPath,
    line,
    column,
  }) => {
    const now = Date.now();
    pruneSynctexForwardCache(now);
    const key = buildSynctexForwardCacheKey({ sourcePath, pdfPath, line, column });
    const entry = synctexForwardResultCache.get(key);
    if (!entry) {
      return null;
    }
    if (now - entry.timestamp > 1200) {
      synctexForwardResultCache.delete(key);
      return null;
    }
    const pdfMtimeMs = readMtimeMs(pdfPath);
    const sourceMtimeMs = readMtimeMs(sourcePath);
    if (entry.pdfMtimeMs !== pdfMtimeMs || entry.sourceMtimeMs !== sourceMtimeMs) {
      synctexForwardResultCache.delete(key);
      return null;
    }
    return {
      ok: true,
      page: entry.page,
      x: entry.x,
      y: entry.y,
      fallback: entry.fallback === true,
      cached: true,
    };
  };

  const setCachedSynctexForwardResult = ({
    sourcePath,
    pdfPath,
    line,
    column,
    result,
  }) => {
    if (!result || result.ok !== true) {
      return;
    }
    if (
      !Number.isFinite(result.page) ||
      !Number.isFinite(result.x) ||
      !Number.isFinite(result.y)
    ) {
      return;
    }
    const key = buildSynctexForwardCacheKey({ sourcePath, pdfPath, line, column });
    synctexForwardResultCache.set(key, {
      timestamp: Date.now(),
      page: result.page,
      x: result.x,
      y: result.y,
      fallback: result.fallback === true,
      pdfMtimeMs: readMtimeMs(pdfPath),
      sourceMtimeMs: readMtimeMs(sourcePath),
    });
    pruneSynctexForwardCache();
  };

  const resolveBuildProfile = async () => {
    const settings = await workspace.loadSettings().catch(() => null);
    const activeId = typeof settings?.buildProfileId === "string" ? settings.buildProfileId.trim() : "";
    if (!activeId) {
      return null;
    }
    const profiles = Array.isArray(settings?.buildProfiles) ? settings.buildProfiles : [];
    const selected = profiles.find(
      (profile) => profile && typeof profile === "object" && profile.id === activeId
    );
    if (!selected) {
      return null;
    }
    const outDir =
      typeof selected.outDir === "string" && selected.outDir.trim() ? selected.outDir.trim() : null;
    const extraArgs =
      typeof selected.extraArgs === "string" && selected.extraArgs.trim()
        ? selected.extraArgs.trim()
        : null;
    return { outDir, extraArgs };
  };

  const normalizeBuildProfile = (value) => {
    if (!value || typeof value !== "object") {
      return null;
    }
    const outDir =
      typeof value.outDir === "string" && value.outDir.trim() ? value.outDir.trim() : null;
    const extraArgs =
      typeof value.extraArgs === "string" && value.extraArgs.trim() ? value.extraArgs.trim() : null;
    return { outDir, extraArgs };
  };

  const handleBuild = async (mainFile, options = {}) => {
    const buildMessage = "ビルド中...";
    sendBuildState("building", buildMessage);
    sendIssues(0, buildMessage, "info", []);
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendBuildState("idle", "キャンセル");
      sendIssues(0, "ビルドをキャンセルしました。", "info", []);
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
    const rootInfo = await workspace.rootInfo().catch(() => null);
    const requestedFile = mainFile && mainFile.trim() ? mainFile.trim() : null;
    let targetFile = rootInfo?.path || "main.tex";
    if (requestedFile && requestedFile.endsWith(".tex")) {
      const magicRoot = await workspace.resolveTexRootFromMagic(requestedFile).catch(() => null);
      if (magicRoot) {
        targetFile = magicRoot;
      } else if (!rootInfo?.path) {
        targetFile = requestedFile;
      }
    } else if (requestedFile && !rootInfo?.path) {
      targetFile = requestedFile;
    }
    if (options.format && typeof targetFile === "string" && targetFile.endsWith(".tex")) {
      const formatResult = await formatterService
        .formatFile(rootPath, targetFile, options.formatSettings)
        .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
      if (!formatResult.ok && !state.formatWarningShown) {
        state.formatWarningShown = true;
        sendIssues(1, formatResult.error ?? "整形に失敗しました。", "info", [
          { severity: "warning", message: formatResult.error ?? "整形に失敗しました。", line: null },
        ]);
      }
    }
    const buildProfile = await resolveBuildProfile().catch(() => null);
    const result = await buildService.build(rootPath, targetFile, options.engine, buildProfile);
    if (result.kind === "busy") {
      sendBuildState("building", buildMessage);
      sendIssues(0, "すでにビルド中です。", "info", []);
      return;
    }
    sendBuildLog(result.log ?? null);
    if (result.kind === "success") {
      if (fs.existsSync(result.pdfPath)) {
        state.lastBuildPdfPath = result.pdfPath;
        const viewerMode = options.pdfViewerMode === "tab" ? "tab" : "window";
        if (viewerMode === "tab") {
          const relativePdfPath = resolveWorkspaceRelativePath(rootPath, result.pdfPath);
          if (relativePdfPath) {
            await handleOpenFile(relativePdfPath);
          } else {
            pdfWindowManager.show(result.pdfPath);
          }
        } else {
          pdfWindowManager.show(result.pdfPath);
        }
        sendBuildState("success", result.summary);
        // Keep writing flow calm: clear issues and build log on each successful build.
        sendIssues(0, result.summary, "success", []);
        sendBuildLog(null);
        return;
      }
      sendBuildState("failed", "PDFが見つかりません。");
      sendIssues(1, "PDFが見つかりません。", "error", [
        { severity: "error", message: "PDFが見つかりません。", line: null },
      ]);
      return;
    }
    if (result.kind === "failure") {
      const errorIssues = result.issues.filter((issue) => issue.severity === "error");
      const displayIssues = errorIssues.length > 0 ? errorIssues : result.issues;
      const count = Math.max(displayIssues.length, 1);
      const summaryText = displayIssues[0]?.message ?? result.summary;
      sendBuildState("failed", result.summary);
      sendIssues(count, summaryText, "error", displayIssues);
    }
  };

  const handleClean = async (mainFile, options = {}) => {
    const message = "clean 中...";
    sendIssues(0, message, "info", []);
    sendBuildLog(null);
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "ワークスペースが選択されていません。", "error", [
        { severity: "error", message: "ワークスペースが選択されていません。", line: null },
      ]);
      return;
    }
    await updateWorkspaceIfNeeded(rootPath);
    const rootInfo = await workspace.rootInfo().catch(() => null);
    const requestedFile = mainFile && mainFile.trim() ? mainFile.trim() : null;
    let targetFile = rootInfo?.path || "main.tex";
    if (requestedFile && requestedFile.endsWith(".tex")) {
      const magicRoot = await workspace.resolveTexRootFromMagic(requestedFile).catch(() => null);
      if (magicRoot) {
        targetFile = magicRoot;
      } else if (!rootInfo?.path) {
        targetFile = requestedFile;
      }
    } else if (requestedFile && !rootInfo?.path) {
      targetFile = requestedFile;
    }
    const buildProfile =
      normalizeBuildProfile(options?.buildProfile) ??
      (await resolveBuildProfile().catch(() => null));
    const deep = options.deep === true;
    const result = await buildService.clean(rootPath, targetFile, { deep }, buildProfile);
    if (result.kind === "busy") {
      sendIssues(0, "すでに処理中です。", "info", []);
      return;
    }
    sendBuildLog(result.log ?? null);
    if (result.kind === "success") {
      sendIssues(0, result.summary ?? "clean 完了", "success", []);
      return;
    }
    if (result.kind === "failure") {
      const count = Math.max(result.issues.length, 1);
      const summaryText = result.issues[0]?.message ?? result.summary;
      sendIssues(count, summaryText, "error", result.issues);
    }
  };

  const handleSynctexForward = async (message) => {
    const generation = ++synctexForwardGeneration;
    const isStaleRequest = () => generation !== synctexForwardGeneration;
    const requestId =
      typeof message?.requestId === "string" && message.requestId.trim()
        ? message.requestId
        : null;
    const withRequestId = (payload) =>
      requestId ? { ...payload, requestId } : { ...payload };
    const forwardSource =
      typeof message?.source === "string" && message.source.trim()
        ? message.source.trim()
        : "other";
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendToRenderer("synctex:forwardResult", withRequestId({
        ok: false,
        error: "ワークスペースが選択されていません。",
      }));
      return;
    }
    const sourcePath = resolveWorkspacePathFromRoot(rootPath, message.path);
    const pdfPath =
      resolveWorkspacePathFromRoot(rootPath, message.pdfPath) || state.lastBuildPdfPath;
    if (!sourcePath) {
      sendToRenderer("synctex:forwardResult", withRequestId({
        ok: false,
        error: "対象のTeXファイルが選択されていません。",
      }));
      return;
    }
    if (!sourcePath.toLowerCase().endsWith(".tex")) {
      sendToRenderer("synctex:forwardResult", withRequestId({
        ok: false,
        error: "SyncTeX は TeX ファイルのみ対応しています。",
      }));
      return;
    }
    if (!pdfPath) {
      sendToRenderer("synctex:forwardResult", withRequestId({
        ok: false,
        error: "PDFがまだ生成されていません。",
      }));
      return;
    }
    const line = Number.parseInt(message.line, 10);
    const column = Number.parseInt(message.column, 10);
    const targetLine = Number.isFinite(line) ? line : 1;
    const targetColumn = Number.isFinite(column) ? column : 1;
    const viewerMode = message.pdfViewerMode === "tab" ? "tab" : "window";
    const allowFallback = message.fallbackToTop !== false;
    if (isStaleRequest()) {
      return;
    }
    const cached = getCachedSynctexForwardResult({
      sourcePath,
      pdfPath,
      line: targetLine,
      column: targetColumn,
    });
    if (cached) {
      if (viewerMode === "window") {
        pdfWindowManager.show(pdfPath, { reload: false });
        pdfWindowManager.queueSync({ page: cached.page, x: cached.x, y: cached.y });
      }
      synctexService.registerForwardHint({
        pdfPath,
        page: cached.page,
        x: cached.x,
        y: cached.y,
        sourcePath,
        line: targetLine,
        column: targetColumn,
      });
      const relativePdfPath = resolveWorkspaceRelativePath(rootPath, pdfPath);
      sendToRenderer("synctex:forwardResult", withRequestId({
        ok: true,
        page: cached.page,
        x: cached.x,
        y: cached.y,
        fallback: cached.fallback === true,
        cached: true,
        pdfPath: relativePdfPath,
      }));
      return;
    }
    const isRetryableSynctexError = (error) =>
      typeof error === "string" &&
      (error.includes("位置情報") || error.includes("解析に失敗"));
    const attachRoundtripProbe = async (forwardResult, forwardLine) => {
      if (!forwardResult || forwardResult.ok !== true) {
        return forwardResult;
      }
      let reverseProbe = null;
      try {
        reverseProbe = await synctexService.reverse({
          page: forwardResult.page,
          x: forwardResult.x,
          y: forwardResult.y,
          pdfPath,
          refineLines: 0,
          bypassHint: true,
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
      const sameSourcePath = isWorkspaceSynctexPathSame(rootPath, reverseProbe.path, sourcePath);
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
    const isLowQualityForwardResult = (forwardResult, expectedLine = targetLine) => {
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

    const runForward = async (forwardLine, forwardColumn) => {
      if (isStaleRequest()) {
        return { ok: false, cancelled: true, error: "stale" };
      }
      let result = await synctexService.forward({
        sourcePath,
        line: Number.isFinite(forwardLine) ? forwardLine : 1,
        column: Number.isFinite(forwardColumn) ? forwardColumn : 1,
        pdfPath,
        hintLine: targetLine,
        hintColumn: targetColumn,
        registerHint: false,
      });
      if (isStaleRequest()) {
        return { ok: false, cancelled: true, error: "stale" };
      }
      if (result.ok) {
        result = await attachRoundtripProbe(result, forwardLine);
      }
      if (isStaleRequest()) {
        return { ok: false, cancelled: true, error: "stale" };
      }
      if (result.ok || !isRetryableSynctexError(result.error)) {
        return result;
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (isStaleRequest()) {
          return { ok: false, cancelled: true, error: "stale" };
        }
        await delay(200);
        if (isStaleRequest()) {
          return { ok: false, cancelled: true, error: "stale" };
        }
        result = await synctexService.forward({
          sourcePath,
          line: Number.isFinite(forwardLine) ? forwardLine : 1,
          column: Number.isFinite(forwardColumn) ? forwardColumn : 1,
          pdfPath,
          hintLine: targetLine,
          hintColumn: targetColumn,
          registerHint: false,
        });
        if (isStaleRequest()) {
          return { ok: false, cancelled: true, error: "stale" };
        }
        if (result.ok) {
          result = await attachRoundtripProbe(result, forwardLine);
        }
        if (isStaleRequest()) {
          return { ok: false, cancelled: true, error: "stale" };
        }
        if (result.ok || !isRetryableSynctexError(result.error)) {
          break;
        }
      }
      return result;
    };

    const preferBacktrack = isSkippableSynctexLine(sourcePath, targetLine);
    let result = preferBacktrack
      ? { ok: false, error: "skip" }
      : await runForward(targetLine, column);
    let bestLowQualitySuccess =
      result.ok && isLowQualityForwardResult(result, targetLine)
        ? {
            result,
            offset: 0,
            matchDiff: getForwardTargetDiff(result, targetLine),
          }
        : null;
    if (preferBacktrack || (!result.ok && isRetryableSynctexError(result.error))) {
      const maxBacktrack = forwardSource === "manual" ? 120 : 160;
      for (let offset = 1; offset <= maxBacktrack; offset += 1) {
        if (isStaleRequest()) {
          return;
        }
        const candidateLine = targetLine - offset;
        if (candidateLine < 1) {
          break;
        }
        const candidate = await runForward(candidateLine, column);
        if (candidate.ok) {
          const candidateLowQuality = isLowQualityForwardResult(candidate, targetLine);
          if (!candidateLowQuality) {
            candidate.fallback = true;
            result = candidate;
            break;
          }
          const candidateMatchDiff = getForwardTargetDiff(candidate, targetLine);
          const candidateScore = {
            result: { ...candidate, fallback: true },
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
        if (!isRetryableSynctexError(candidate.error)) {
          result = candidate;
          break;
        }
      }
    }
    if ((result.ok && isLowQualityForwardResult(result, targetLine)) || !result.ok) {
      const maxForwardScan = 12;
      for (let offset = 1; offset <= maxForwardScan; offset += 1) {
        if (isStaleRequest()) {
          return;
        }
        const candidateLine = targetLine + offset;
        const candidate = await runForward(candidateLine, column);
        if (candidate.ok && !isLowQualityForwardResult(candidate, targetLine)) {
          result = { ...candidate, fallback: true };
          break;
        }
      }
    }
    if (
      ((result.ok && isLowQualityForwardResult(result, targetLine)) || !result.ok) &&
      bestLowQualitySuccess?.result?.ok
    ) {
      result = bestLowQualitySuccess.result;
    }
    if (result.ok) {
      const exactDiff = getForwardTargetDiff(result, targetLine);
      if (Number.isFinite(exactDiff) && exactDiff > 0) {
        const maxExactScan = 12;
        outerExactScan: for (let offset = 1; offset <= maxExactScan; offset += 1) {
          if (isStaleRequest()) {
            return;
          }
          const candidateLine = targetLine - offset;
          if (candidateLine >= 1) {
            const candidate = await runForward(candidateLine, column);
            if (candidate.ok && getForwardTargetDiff(candidate, targetLine) === 0) {
              result = { ...candidate, fallback: true };
              break outerExactScan;
            }
          }
          const forwardLine = targetLine + offset;
          const forwardCandidate = await runForward(forwardLine, column);
          if (forwardCandidate.ok && getForwardTargetDiff(forwardCandidate, targetLine) === 0) {
            result = { ...forwardCandidate, fallback: true };
            break outerExactScan;
          }
        }
      }
    }
    if (!result.ok && allowFallback) {
      const fallbackResult = await runForward(1, 1);
      if (fallbackResult.ok) {
        fallbackResult.fallback = true;
      }
      result = fallbackResult;
    }
    if (isStaleRequest() || result?.cancelled === true) {
      return;
    }
    if (!result.ok) {
      sendToRenderer("synctex:forwardResult", withRequestId(result));
      return;
    }
    if (
      Number.isFinite(result.page) &&
      Number.isFinite(result.x) &&
      Number.isFinite(result.y)
    ) {
      synctexService.registerForwardHint({
        pdfPath,
        page: result.page,
        x: result.x,
        y: result.y,
        sourcePath,
        line: targetLine,
        column: targetColumn,
      });
    }
    setCachedSynctexForwardResult({
      sourcePath,
      pdfPath,
      line: targetLine,
      column: targetColumn,
      result,
    });
    if (viewerMode === "window") {
      pdfWindowManager.show(pdfPath, { reload: false });
      pdfWindowManager.queueSync({ page: result.page, x: result.x, y: result.y });
    }
    const relativePdfPath = resolveWorkspaceRelativePath(rootPath, pdfPath);
    sendToRenderer("synctex:forwardResult", withRequestId({
      ok: true,
      page: result.page,
      x: result.x,
      y: result.y,
      fallback: result.fallback === true,
      pdfPath: relativePdfPath,
    }));
  };

  const handleSynctexReverse = async (message) => {
    const requestId =
      typeof message?.requestId === "string" && message.requestId.trim()
        ? message.requestId
        : null;
    const withRequestId = (payload) =>
      requestId ? { ...payload, requestId } : { ...payload };
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendToRenderer("synctex:reverseResult", withRequestId({
        ok: false,
        error: "ワークスペースが選択されていません。",
      }));
      return;
    }

    const pdfPath =
      resolveWorkspacePathFromRoot(rootPath, message.pdfPath) ||
      resolveWorkspacePathFromRoot(rootPath, message.path) ||
      state.lastBuildPdfPath;
    if (!pdfPath) {
      sendToRenderer("synctex:reverseResult", withRequestId({
        ok: false,
        error: "PDFがまだ生成されていません。",
      }));
      return;
    }

    const page = Number.parseInt(message.page, 10);
    const x = Number.parseFloat(message.x);
    const y = Number.parseFloat(message.y);
    if (!Number.isFinite(page) || !Number.isFinite(x) || !Number.isFinite(y)) {
      sendToRenderer("synctex:reverseResult", withRequestId({
        ok: false,
        error: "SyncTeX の座標が不正です。",
      }));
      return;
    }

    const parsedRefineLines = Number.parseInt(message.refineLines, 10);
    const refineLines =
      Number.isFinite(parsedRefineLines) && parsedRefineLines >= 0
        ? parsedRefineLines
        : undefined;
    const allowExpandedOffsets =
      message.allowExpandedOffsets === true;
    const bypassHint = message.bypassHint === true;

    let result;
    try {
      result = await synctexService.reverse({
        page,
        x,
        y,
        pdfPath,
        refineLines,
        allowExpandedOffsets,
        bypassHint,
      });
    } catch (_error) {
      sendToRenderer("synctex:reverseResult", withRequestId({
        ok: false,
        error: "SyncTeX の解析に失敗しました。",
      }));
      return;
    }

    if (!result?.ok) {
      sendToRenderer("synctex:reverseResult", withRequestId(result));
      return;
    }

    const resolvedSourcePath = (() => {
      const workspaceResolved = resolveSynctexWorkspacePath(rootPath, result.path);
      if (!workspaceResolved) {
        return null;
      }
      const normalized = resolveWorkspaceRelativePath(rootPath, workspaceResolved);
      if (normalized) {
        return normalized;
      }
      return null;
    })();
    if (!resolvedSourcePath) {
      sendToRenderer("synctex:reverseResult", withRequestId({
        ok: false,
        error: "SyncTeX の参照先がワークスペース外です。",
      }));
      return;
    }

    sendToRenderer("synctex:reverseResult", withRequestId({
      ok: true,
      path: resolvedSourcePath,
      line: result.line,
      column: result.column ?? 1,
      confidence: result.confidence === true,
      scoreGap: Number.isFinite(result.scoreGap) ? result.scoreGap : null,
      distance: Number.isFinite(result.distance) ? result.distance : null,
      hinted: result.hinted === true,
      hintCandidateCount:
        Number.isFinite(result.hintCandidateCount) && result.hintCandidateCount >= 0
          ? result.hintCandidateCount
          : null,
      hintPreview: Array.isArray(result.hintPreview) ? result.hintPreview : null,
      pdfPath: resolveWorkspaceRelativePath(rootPath, pdfPath),
    }));
  };

  return { handleBuild, handleClean, handleSynctexForward, handleSynctexReverse };
};

module.exports = { createBuildHandlers };
