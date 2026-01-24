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
      if (!trimmed) {
        return true;
      }
      return trimmed.startsWith("%");
    } catch {
      return false;
    }
  };

  const toTexPath = (value) => value.replace(/\\/g, "/");

  const PARTIAL_DIR = path.join(".tex64", "preview");
  const PARTIAL_MAIN_FILE = "partial.tex";
  const PARTIAL_MAIN_RELATIVE = path.join(PARTIAL_DIR, PARTIAL_MAIN_FILE);

  const toTexDir = (value) => {
    const normalized = toTexPath(value);
    if (!normalized || normalized === ".") {
      return "./";
    }
    return normalized.endsWith("/") ? normalized : `${normalized}/`;
  };

  const stripLineComment = (line) => {
    const idx = line.indexOf("%");
    if (idx === -1) {
      return line;
    }
    for (let i = idx; i < line.length; i += 1) {
      if (line[i] !== "%") {
        continue;
      }
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && line[j] === "\\"; j -= 1) {
        backslashes += 1;
      }
      if (backslashes % 2 === 0) {
        return line.slice(0, i);
      }
    }
    return line;
  };

  const BEGIN_DOCUMENT_PATTERN = new RegExp(String.raw`\\begin\s*\{document\}`);
  const END_DOCUMENT_PATTERN = new RegExp(String.raw`\\end\s*\{document\}`);
  const DOCUMENTCLASS_PATTERN = new RegExp(String.raw`\\documentclass\b`);
  const INCLUDE_PATTERN = new RegExp(String.raw`\\include\s*\{([^}]+)\}`);
  const INCLUDEONLY_LINE_PATTERN = new RegExp(
    String.raw`^[ \t]*\\includeonly.*$`,
    "gm"
  );

  const findDocumentLineIndex = (lines, pattern) => {
    for (let i = 0; i < lines.length; i += 1) {
      if (pattern.test(stripLineComment(lines[i]))) {
        return i;
      }
    }
    return null;
  };

  const normalizeTexPath = (value) => {
    if (!value || typeof value !== "string") {
      return "";
    }
    return toTexPath(value).replace(/^\.\//, "");
  };

  const ensureIncludeOutputDirs = (rootPath, includeTargets) => {
    if (!Array.isArray(includeTargets) || includeTargets.length === 0) {
      return;
    }
    const previewDir = path.join(rootPath, PARTIAL_DIR);
    includeTargets.forEach((entry) => {
      const normalized = normalizeTexPath(entry);
      if (!normalized) {
        return;
      }
      const outputDir = path.normalize(path.dirname(normalized));
      if (!outputDir || outputDir === "." || path.isAbsolute(outputDir)) {
        return;
      }
      if (outputDir.startsWith("..")) {
        return;
      }
      fs.mkdirSync(path.join(previewDir, outputDir), { recursive: true });
    });
  };

  const PARTIAL_MAIN_RELATIVE_TEX = normalizeTexPath(PARTIAL_MAIN_RELATIVE);

  const normalizeIncludeTarget = (value) =>
    normalizeTexPath(value).replace(/\.tex$/i, "");

  const extractIncludeTargets = (content) => {
    const lines = content.split(/\r?\n/);
    const targets = [];
    for (const line of lines) {
      const cleaned = stripLineComment(line);
      const match = cleaned.match(INCLUDE_PATTERN);
      if (match && match[1]) {
        targets.push(match[1].trim());
      }
    }
    return targets;
  };

  const injectIncludeOnly = (content, includeTarget) => {
    const lines = content.split(/\r?\n/);
    const beginIndex = findDocumentLineIndex(lines, BEGIN_DOCUMENT_PATTERN);
    if (beginIndex === null) {
      return null;
    }
    const preamble = lines.slice(0, beginIndex).join("\n");
    const rest = lines.slice(beginIndex).join("\n");
    const preambleFiltered = preamble.replace(INCLUDEONLY_LINE_PATTERN, "");
    const trimmed = preambleFiltered.trimEnd();
    return `${trimmed}\n\\includeonly{${includeTarget}}\n${rest}`;
  };

  const extractPreamble = (content) => {
    const lines = content.split(/\r?\n/);
    const beginIndex = findDocumentLineIndex(lines, BEGIN_DOCUMENT_PATTERN);
    if (beginIndex === null) {
      return content;
    }
    return lines.slice(0, beginIndex).join("\n");
  };

  const buildPartialFile = (rootPath, targetFile, partial) => {
    const mainFilePath = resolveWorkspacePathFromRoot(rootPath, targetFile);
    if (!mainFilePath) {
      return { ok: false, error: "メインTeXが見つかりません。" };
    }
    let mainContent = "";
    try {
      mainContent = fs.readFileSync(mainFilePath, "utf8");
    } catch (error) {
      return { ok: false, error: "メインTeXの読み込みに失敗しました。" };
    }
    const rootFileRelative =
      resolveWorkspaceRelativePath(rootPath, targetFile) ?? targetFile ?? null;
    const rootDir = rootFileRelative ? path.dirname(rootFileRelative) : ".";
    const activeRelative =
      resolveWorkspaceRelativePath(rootPath, partial.path) ?? partial.path ?? null;
    const activeRelativeToRoot =
      activeRelative && rootDir ? path.relative(rootDir, activeRelative) : activeRelative;
    const includeTargets = extractIncludeTargets(mainContent);
    const normalizedActive = normalizeIncludeTarget(activeRelative ?? "");
    const normalizedActiveToRoot = normalizeIncludeTarget(activeRelativeToRoot ?? "");
    const normalizedActiveBase = normalizeIncludeTarget(
      activeRelative ? path.basename(activeRelative) : ""
    );
    const includeTarget = includeTargets.find((entry) => {
      const normalizedEntry = normalizeIncludeTarget(entry);
      if (!normalizedEntry) {
        return false;
      }
      return (
        normalizedEntry === normalizedActive ||
        normalizedEntry === normalizedActiveToRoot ||
        normalizedEntry === normalizedActiveBase
      );
    });
    if (includeTarget) {
      const injected = injectIncludeOnly(mainContent, includeTarget);
      if (injected) {
        const previewDir = path.join(rootPath, PARTIAL_DIR);
        fs.mkdirSync(previewDir, { recursive: true });
        ensureIncludeOutputDirs(rootPath, includeTargets);
        const partialPath = path.join(rootPath, PARTIAL_MAIN_RELATIVE);
        fs.writeFileSync(partialPath, injected, "utf8");
        return {
          ok: true,
          partialFile: PARTIAL_MAIN_RELATIVE,
          mode: "include",
        };
      }
    }

    const preamble = extractPreamble(mainContent);
    const preambleLines = preamble ? preamble.split(/\r?\n/) : [];
    const sourcePath = activeRelative ?? null;
    const sourceDir = sourcePath ? path.dirname(sourcePath) : null;
    const extraPaths = new Set(["./"]);
    if (sourceDir && sourceDir !== "." && sourceDir !== "") {
      extraPaths.add(toTexDir(sourceDir));
    }
    const extraPathList = Array.from(extraPaths)
      .map((entry) => `{${toTexDir(entry)}}`)
      .join("");
    const extraLines =
      extraPathList.length > 0
        ? [
            "% tex64 partial build context",
            "\\makeatletter",
            `\\def\\tex64@extra@path{${extraPathList}}`,
            "\\@ifundefined{input@path}{\\def\\input@path{\\tex64@extra@path}}{\\edef\\input@path{\\input@path\\tex64@extra@path}}",
            "\\@ifundefined{Ginput@path}{}{\\edef\\Ginput@path{\\Ginput@path\\tex64@extra@path}}",
            "\\makeatother",
          ]
        : [];
    const extraPreambleLines =
      typeof partial.preamble === "string" && partial.preamble.trim()
        ? partial.preamble
            .split(/\r?\n/)
            .filter(
              (line) =>
                !DOCUMENTCLASS_PATTERN.test(line) &&
                !BEGIN_DOCUMENT_PATTERN.test(line) &&
                !END_DOCUMENT_PATTERN.test(line)
            )
        : [];
    const snippetLines =
      typeof partial.content === "string" && partial.content.length > 0
        ? partial.content.split(/\r?\n/)
        : [];
    const lines = [
      ...preambleLines,
      ...extraLines,
      ...extraPreambleLines,
      "\\begin{document}",
      ...snippetLines,
      "\\end{document}",
    ];
    const prefixLineCount =
      preambleLines.length + extraLines.length + extraPreambleLines.length + 1;
    const previewDir = path.join(rootPath, PARTIAL_DIR);
    fs.mkdirSync(previewDir, { recursive: true });
    const partialPath = path.join(rootPath, PARTIAL_MAIN_RELATIVE);
    fs.writeFileSync(partialPath, lines.join("\n"), "utf8");
    return {
      ok: true,
      partialFile: PARTIAL_MAIN_RELATIVE,
      mode: "section",
      prefixLineCount,
      contextStartLine: Number.isFinite(partial.startLine) ? partial.startLine : 1,
      sourcePath,
    };
  };

  const handleBuild = async (mainFile, options = {}) => {
    const partial =
      options.partial &&
      typeof options.partial === "object" &&
      typeof options.partial.path === "string" &&
      typeof options.partial.content === "string"
        ? options.partial
        : null;
    const buildMessage = partial ? "部分ビルド中..." : "ビルド中...";
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
    const targetFile =
      (mainFile && mainFile.trim() ? mainFile : null) ||
      rootInfo?.path ||
      "main.tex";
    if (!partial && options.format && typeof targetFile === "string" && targetFile.endsWith(".tex")) {
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
    let buildTargetFile = targetFile;
    let partialMeta = null;
    if (partial) {
      const partialResult = buildPartialFile(rootPath, targetFile, partial);
      if (!partialResult.ok) {
        sendBuildState("failed", partialResult.error);
        sendIssues(1, partialResult.error, "error", [
          { severity: "error", message: partialResult.error, line: null },
        ]);
        return;
      }
      buildTargetFile = partialResult.partialFile;
      partialMeta = partialResult;
    }
    const result = await buildService.build(rootPath, buildTargetFile, options.engine);
    if (result.kind === "busy") {
      sendBuildState("building", buildMessage);
      sendIssues(0, "すでにビルド中です。", "info", []);
      return;
    }
    if (partialMeta && partialMeta.mode === "section" && Array.isArray(result.issues)) {
      result.issues = result.issues.map((issue) => {
        if (!issue || !Number.isFinite(issue.line)) {
          return issue;
        }
        const issuePath = normalizeTexPath(issue.path);
        if (issuePath && issuePath !== PARTIAL_MAIN_RELATIVE_TEX) {
          return issue;
        }
        const snippetLine = issue.line - partialMeta.prefixLineCount;
        if (!Number.isFinite(snippetLine) || snippetLine < 1) {
          return issue;
        }
        const mappedLine = partialMeta.contextStartLine + snippetLine - 1;
        if (!Number.isFinite(mappedLine) || mappedLine < 1) {
          return issue;
        }
        return {
          ...issue,
          path: partialMeta.sourcePath ?? issue.path,
          line: mappedLine,
        };
      });
    }
    sendBuildLog(result.log ?? null);
    if (result.kind === "success") {
      const warningIssues = result.issues.filter((issue) => issue.severity === "warning");
      const warningCount = warningIssues.length;
      const summaryText = warningIssues[0]?.message ?? result.summary;
      if (fs.existsSync(result.pdfPath)) {
        if (!partialMeta) {
          state.lastBuildPdfPath = result.pdfPath;
        }
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
        const summaryMessage = partialMeta ? "部分ビルド成功" : result.summary;
        sendBuildState("success", summaryMessage);
        if (warningCount > 0) {
          sendIssues(warningCount, summaryText, "info", warningIssues);
        } else {
          sendIssues(0, summaryMessage, "success", []);
        }
        return;
      }
      sendBuildState("failed", "PDFが見つかりません。");
      sendIssues(1, "PDFが見つかりません。", "error", [
        { severity: "error", message: "PDFが見つかりません。", line: null },
      ]);
      return;
    }
    if (result.kind === "failure") {
      const count = Math.max(result.issues.length, 1);
      const summaryText = result.issues[0]?.message ?? result.summary;
      sendBuildState("failed", result.summary);
      sendIssues(count, summaryText, "error", result.issues);
    }
  };

  const handleSynctexForward = async (message) => {
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendToRenderer("synctex:forwardResult", {
        ok: false,
        error: "ワークスペースが選択されていません。",
      });
      return;
    }
    const sourcePath = resolveWorkspacePathFromRoot(rootPath, message.path);
    const pdfPath =
      resolveWorkspacePathFromRoot(rootPath, message.pdfPath) || state.lastBuildPdfPath;
    if (!sourcePath) {
      sendToRenderer("synctex:forwardResult", {
        ok: false,
        error: "対象のTeXファイルが選択されていません。",
      });
      return;
    }
    if (!pdfPath) {
      sendToRenderer("synctex:forwardResult", {
        ok: false,
        error: "PDFがまだ生成されていません。",
      });
      return;
    }
    const line = Number.parseInt(message.line, 10);
    const column = Number.parseInt(message.column, 10);
    const viewerMode = message.pdfViewerMode === "tab" ? "tab" : "window";
    const allowFallback = message.fallbackToTop !== false;
    const isRetryableSynctexError = (error) =>
      typeof error === "string" &&
      (error.includes("位置情報") || error.includes("解析に失敗"));

    const runForward = async (forwardLine, forwardColumn) => {
      let result = await synctexService.forward({
        sourcePath,
        line: Number.isFinite(forwardLine) ? forwardLine : 1,
        column: Number.isFinite(forwardColumn) ? forwardColumn : 1,
        pdfPath,
      });
      if (result.ok || !isRetryableSynctexError(result.error)) {
        return result;
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await delay(200);
        result = await synctexService.forward({
          sourcePath,
          line: Number.isFinite(forwardLine) ? forwardLine : 1,
          column: Number.isFinite(forwardColumn) ? forwardColumn : 1,
          pdfPath,
        });
        if (result.ok || !isRetryableSynctexError(result.error)) {
          break;
        }
      }
      return result;
    };

    const targetLine = Number.isFinite(line) ? line : 1;
    const preferBacktrack = isSkippableSynctexLine(sourcePath, targetLine);
    let result = preferBacktrack
      ? { ok: false, error: "skip" }
      : await runForward(targetLine, column);
    if (!result.ok && (preferBacktrack || isRetryableSynctexError(result.error))) {
      const maxBacktrack = 160;
      for (let offset = 1; offset <= maxBacktrack; offset += 1) {
        const candidateLine = targetLine - offset;
        if (candidateLine < 1) {
          break;
        }
        const candidate = await runForward(candidateLine, column);
        if (candidate.ok) {
          candidate.fallback = true;
          result = candidate;
          break;
        }
        if (!isRetryableSynctexError(candidate.error)) {
          result = candidate;
          break;
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
    if (!result.ok) {
      sendToRenderer("synctex:forwardResult", result);
      return;
    }
    if (viewerMode === "window") {
      pdfWindowManager.show(pdfPath, { reload: false });
      pdfWindowManager.queueSync({ page: result.page, x: result.x, y: result.y });
    }
    const relativePdfPath = resolveWorkspaceRelativePath(rootPath, pdfPath);
    sendToRenderer("synctex:forwardResult", {
      ok: true,
      page: result.page,
      x: result.x,
      y: result.y,
      fallback: result.fallback === true,
      pdfPath: relativePdfPath,
    });
  };

  return { handleBuild, handleSynctexForward };
};

module.exports = { createBuildHandlers };
