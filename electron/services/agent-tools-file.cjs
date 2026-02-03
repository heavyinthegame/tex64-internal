const path = require("path");
const fsp = require("fs/promises");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { normalizeRelativePath } = require("./workspace.cjs");
const {
  isBlockedPath,
  isTextExtension,
  normalizeEncoding,
  normalizePath,
  wantsBase64,
} = require("./agent-policy.cjs");

const DEFAULT_MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;

const readFileFromDisk = async (resolvedPath, { forceBase64 = false } = {}) => {
  const buffer = await fsp.readFile(resolvedPath);
  if (forceBase64) {
    return {
      content: buffer.toString("base64"),
      encoding: "base64",
      binary: true,
      size: buffer.length,
    };
  }
  if (buffer.length === 0) {
    return { content: "", encoding: "utf8", binary: false, size: 0 };
  }
  const hasNullByte = buffer.includes(0);
  if (hasNullByte) {
    return {
      content: buffer.toString("base64"),
      encoding: "base64",
      binary: true,
      size: buffer.length,
    };
  }
  return {
    content: buffer.toString("utf8"),
    encoding: "utf8",
    binary: false,
    size: buffer.length,
  };
};

const runShellCommand = (
  command,
  { cwd, env, timeoutMs, maxOutputBytes = DEFAULT_MAX_COMMAND_OUTPUT_BYTES } = {}
) =>
  new Promise((resolve) => {
    const outputLimit =
      Number.isFinite(maxOutputBytes) && maxOutputBytes > 0
        ? maxOutputBytes
        : Number.POSITIVE_INFINITY;
    const sanitizedEnv = {};
    if (env && typeof env === "object") {
      Object.entries(env).forEach(([key, value]) => {
        if (typeof value === "string") {
          sanitizedEnv[key] = value;
        }
      });
    }
    const proc = spawn(command, {
      cwd,
      env: { ...process.env, ...sanitizedEnv },
      shell: true,
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let totalBytes = 0;
    let timedOut = false;

    const appendChunk = (target, chunk) => {
      if (!chunk) {
        return target;
      }
      const text = chunk.toString("utf8");
      if (!Number.isFinite(outputLimit)) {
        totalBytes += Buffer.byteLength(text);
        return target + text;
      }
      const remaining = outputLimit - totalBytes;
      if (remaining <= 0) {
        truncated = true;
        return target;
      }
      const buffer = Buffer.from(text, "utf8");
      if (buffer.length <= remaining) {
        totalBytes += buffer.length;
        return target + text;
      }
      truncated = true;
      totalBytes += remaining;
      return target + buffer.slice(0, remaining).toString("utf8");
    };

    const timer =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            proc.kill("SIGKILL");
          }, timeoutMs)
        : null;

    proc.stdout?.on("data", (chunk) => {
      stdout = appendChunk(stdout, chunk);
    });
    proc.stderr?.on("data", (chunk) => {
      stderr = appendChunk(stderr, chunk);
    });
    proc.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        exitCode: null,
        signal: null,
        stdout,
        stderr: stderr || error?.message || "command error",
        truncated,
        timedOut,
      });
    });
    proc.on("close", (code, signal) => {
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        truncated,
        timedOut,
      });
    });
  });

const replaceOnceWithCount = (text, search, replace) => {
  const index = text.indexOf(search);
  if (index === -1) {
    return { text, count: 0 };
  }
  return {
    text: text.slice(0, index) + replace + text.slice(index + search.length),
    count: 1,
  };
};

const replaceAllWithCount = (text, search, replace) => {
  let index = text.indexOf(search);
  if (index === -1) {
    return { text, count: 0 };
  }
  let result = "";
  let lastIndex = 0;
  let count = 0;
  while (index !== -1) {
    result += text.slice(lastIndex, index) + replace;
    lastIndex = index + search.length;
    count += 1;
    index = text.indexOf(search, lastIndex);
  }
  result += text.slice(lastIndex);
  return { text: result, count };
};

const handleListFiles = async (service, args, policy) => {
  const directory = normalizePath(args.directory);
  const rootPath = service.workspace.getRootPath();
  if (!rootPath) {
    return { error: "ワークスペースが選択されていません。" };
  }
  if (directory && isBlockedPath(directory, policy)) {
    return { error: "対象パスは読み取り禁止です。" };
  }
  let basePath = "";
  try {
    basePath = service.workspace.resolvePath(directory);
  } catch {
    return { error: "ディレクトリが見つかりません。" };
  }
  const baseStat = await fsp.stat(basePath).catch(() => null);
  if (!baseStat || !baseStat.isDirectory()) {
    return { error: "ディレクトリが見つかりません。" };
  }
  const results = [];
  const maxEntries = 5000;
  let count = 0;
  const walk = async (dirPath) => {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (count >= maxEntries) {
        return;
      }
      const absPath = path.join(dirPath, entry.name);
      const relPath = normalizeRelativePath(path.relative(rootPath, absPath));
      if (isBlockedPath(relPath, policy)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      results.push(relPath);
      count += 1;
    }
  };
  await walk(basePath);
  return { files: results.sort((a, b) => a.localeCompare(b, "ja")) };
};

const handleReadFile = async (service, args, policy, conversationId) => {
  const targetPath = normalizePath(args.path);
  if (!targetPath) {
    return { error: "path が空です。" };
  }
  if (isBlockedPath(targetPath, policy)) {
    return { error: "対象パスは読み取り禁止です。" };
  }
  const useBase64 = wantsBase64(args);
  if (!isTextExtension(targetPath, policy) && !useBase64) {
    return {
      error:
        "テキストファイルのみ読み取れます。バイナリは encoding: base64 を指定してください。",
    };
  }
  const snapshot = service.getContextSnapshot(conversationId, targetPath);
  if (snapshot && snapshot.content) {
    if (snapshot.contentLength > policy.maxFileBytes) {
      return { error: "ファイルが大きすぎます。" };
    }
    if (useBase64) {
      return {
        content: Buffer.from(snapshot.content, "utf8").toString("base64"),
        encoding: "base64",
        binary: true,
        partial: snapshot.truncated,
        source: "buffer",
      };
    }
    return {
      content: snapshot.content,
      partial: snapshot.truncated,
      source: "buffer",
    };
  }
  const resolved = service.workspace.resolvePath(targetPath);
  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat || !stat.isFile()) {
    return { error: "ファイルが見つかりません。" };
  }
  if (stat.size > policy.maxFileBytes) {
    return { error: "ファイルが大きすぎます。" };
  }
  const result = await readFileFromDisk(resolved, { forceBase64: useBase64 });
  const response = { content: result.content };
  if (result.binary) {
    response.encoding = "base64";
    response.binary = true;
    response.size = result.size;
  }
  return response;
};

const handleReadFiles = async (service, args, policy, conversationId) => {
  const paths = Array.isArray(args.paths) ? args.paths : [];
  if (paths.length === 0) {
    return { error: "paths が空です。" };
  }
  if (paths.length > policy.maxReadFiles) {
    return { error: `一度に読み取れるファイルは${policy.maxReadFiles}個までです。` };
  }
  const useBase64 = wantsBase64(args);
  const results = {};
  for (const p of paths) {
    const targetPath = normalizePath(p);
    if (
      !targetPath ||
      isBlockedPath(targetPath, policy) ||
      (!isTextExtension(targetPath, policy) && !useBase64)
    ) {
      results[p] = {
        error: useBase64
          ? "読み取り不可"
          : "テキストのみ読み取り可能です。バイナリは encoding: base64 を指定してください。",
      };
      continue;
    }
    try {
      const snapshot = service.getContextSnapshot(conversationId, targetPath);
      if (snapshot && snapshot.content) {
        if (snapshot.contentLength > policy.maxFileBytes) {
          results[p] = { error: "ファイルが大きすぎます。" };
        } else {
          if (useBase64) {
            results[p] = {
              content: Buffer.from(snapshot.content, "utf8").toString("base64"),
              encoding: "base64",
              binary: true,
              partial: snapshot.truncated,
              source: "buffer",
            };
          } else {
            results[p] = {
              content: snapshot.content,
              partial: snapshot.truncated,
              source: "buffer",
            };
          }
        }
        continue;
      }
      const resolved = service.workspace.resolvePath(targetPath);
      const stat = await fsp.stat(resolved).catch(() => null);
      if (!stat || !stat.isFile() || stat.size > policy.maxFileBytes) {
        results[p] = { error: "ファイルが見つからないか大きすぎます" };
        continue;
      }
      const result = await readFileFromDisk(resolved, { forceBase64: useBase64 });
      results[p] = { content: result.content };
      if (result.binary) {
        results[p].encoding = "base64";
        results[p].binary = true;
        results[p].size = result.size;
      }
    } catch {
      results[p] = { error: "読み取りエラー" };
    }
  }
  return { files: results };
};

const handleRunCommand = async (service, args) => {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) {
    return { error: "command が空です。" };
  }
  const rootPath = service.workspace.getRootPath();
  if (!rootPath) {
    return { error: "ワークスペースが選択されていません。" };
  }
  let cwd = rootPath;
  if (typeof args.cwd === "string" && args.cwd.trim()) {
    try {
      cwd = service.workspace.resolvePath(normalizePath(args.cwd));
    } catch {
      return { error: "cwd が不正です。" };
    }
  }
  const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : null;
  const maxOutputBytes = Number.isFinite(args.maxOutputBytes)
    ? args.maxOutputBytes
    : DEFAULT_MAX_COMMAND_OUTPUT_BYTES;
  const result = await runShellCommand(command, {
    cwd,
    env: args.env,
    timeoutMs,
    maxOutputBytes,
  });
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
    timedOut: result.timedOut,
  };
};

const handleProposeWrite = async (service, args, policy, conversationId) => {
  const targetPath = normalizePath(args.path);
  const content = typeof args.content === "string" ? args.content : "";
  const summary = typeof args.summary === "string" ? args.summary : "";
  const encoding = normalizeEncoding(args.encoding);
  const binaryWrite = encoding === "base64";
  if (!targetPath) {
    return { error: "path が空です。" };
  }
  if (isBlockedPath(targetPath, policy)) {
    return { error: "対象パスは書き込み禁止です。" };
  }
  if (!isTextExtension(targetPath, policy) && !binaryWrite) {
    return {
      error:
        "テキストファイルのみ書き込み可能です。バイナリは encoding: base64 を指定してください。",
    };
  }
  let contentBytes = Buffer.byteLength(content, "utf8");
  if (binaryWrite) {
    try {
      contentBytes = Buffer.from(content, "base64").length;
    } catch {
      return { error: "base64 の内容が不正です。" };
    }
  }
  if (contentBytes > policy.maxFileBytes) {
    return { error: "内容が大きすぎます。" };
  }
  let originalContent = "";
  let isNewFile = true;
  let isBinary = binaryWrite;
  const snapshot = service.getContextSnapshot(conversationId, targetPath);
  if (snapshot && snapshot.content) {
    if (snapshot.contentLength > policy.maxFileBytes) {
      return { error: "ファイルが大きすぎます。" };
    }
    originalContent = binaryWrite
      ? Buffer.from(snapshot.content, "utf8").toString("base64")
      : snapshot.content;
    isNewFile = false;
  } else {
    try {
      const resolved = service.workspace.resolvePath(targetPath);
      const result = await readFileFromDisk(resolved, { forceBase64: binaryWrite });
      originalContent = result.content;
      isBinary = isBinary || result.binary;
      isNewFile = false;
    } catch {
      originalContent = "";
      isNewFile = true;
    }
  }
  const id =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const proposal = {
    id,
    type: "write",
    path: targetPath,
    content,
    originalContent,
    encoding: binaryWrite ? "base64" : undefined,
    isBinary,
    summary,
    isNewFile,
    conversationId,
  };
  service.proposals.set(id, proposal);
  service.sendToRenderer("agent:proposal", { proposal });
  if (service.agentOptions.autoApply) {
    await service.applyProposal(id);
  }
  return { status: "proposed", proposalId: id };
};

const handleProposePatch = async (service, args, policy, conversationId) => {
  const summaryPrefix = typeof args.summary === "string" ? args.summary.trim() : "";
  const editsArg = Array.isArray(args.edits) ? args.edits : null;
  const normalizedEdits = [];

  if (editsArg && editsArg.length === 0) {
    return { error: "edits が空です。" };
  }

  if (editsArg && editsArg.length > 0) {
    for (const edit of editsArg) {
      const targetPath = normalizePath(edit?.path);
      const search = typeof edit?.search === "string" ? edit.search : "";
      const replace = typeof edit?.replace === "string" ? edit.replace : "";
      const replaceAll = edit?.replaceAll === true;
      if (!targetPath || !search) {
        return { error: "edits の各項目に path と search は必須です。" };
      }
      normalizedEdits.push({ path: targetPath, search, replace, replaceAll });
    }
  } else {
    const targetPath = normalizePath(args.path);
    const search = typeof args.search === "string" ? args.search : "";
    const replace = typeof args.replace === "string" ? args.replace : "";
    const replaceAll = args.replaceAll === true;
    if (!targetPath || !search) {
      return { error: "path と search は必須です。" };
    }
    normalizedEdits.push({ path: targetPath, search, replace, replaceAll });
  }

  const editsByPath = new Map();
  for (const edit of normalizedEdits) {
    if (isBlockedPath(edit.path, policy)) {
      return { error: "対象パスは編集禁止です。" };
    }
    if (!isTextExtension(edit.path, policy)) {
      return { error: "テキストファイルのみ編集可能です。" };
    }
    if (!editsByPath.has(edit.path)) {
      editsByPath.set(edit.path, []);
    }
    editsByPath.get(edit.path).push(edit);
  }

  const fileCount = editsByPath.size;
  const preparedProposals = [];

  const buildSummary = (path, edits, appliedCount) => {
    if (summaryPrefix && fileCount === 1) {
      return summaryPrefix;
    }
    let base = "";
    if (edits.length === 1) {
      const searchPreview = edits[0].search.slice(0, 20);
      const replacePreview = edits[0].replace.slice(0, 20);
      base = `"${searchPreview}..." → "${replacePreview}..." (${appliedCount}箇所)`;
    } else {
      base = `${edits.length}件の置換（${appliedCount}箇所）`;
    }
    if (!summaryPrefix) {
      return base;
    }
    return `${summaryPrefix} (${path}: ${base})`;
  };

  for (const [targetPath, edits] of editsByPath.entries()) {
    let originalContent = "";
    const snapshot = service.getContextSnapshot(conversationId, targetPath);
    if (snapshot && snapshot.content) {
      if (snapshot.contentLength > policy.maxFileBytes) {
        return { error: "ファイルが大きすぎます。" };
      }
      originalContent = snapshot.content;
    } else {
      try {
        const resolved = service.workspace.resolvePath(targetPath);
        const result = await readFileFromDisk(resolved);
        if (result.binary) {
          return { error: "バイナリファイルのため部分編集できません。" };
        }
        originalContent = result.content;
      } catch {
        return { error: "ファイルが見つかりません。" };
      }
    }
    let updatedContent = originalContent;
    let appliedCount = 0;
    for (const edit of edits) {
      const result = edit.replaceAll
        ? replaceAllWithCount(updatedContent, edit.search, edit.replace)
        : replaceOnceWithCount(updatedContent, edit.search, edit.replace);
      if (result.count === 0) {
        return { error: `${targetPath} に検索文字列が見つかりません。` };
      }
      updatedContent = result.text;
      appliedCount += result.count;
    }
    if (appliedCount === 0 || updatedContent === originalContent) {
      return { error: "変更がありません。" };
    }
    if (updatedContent.length > policy.maxFileBytes) {
      return { error: "内容が大きすぎます。" };
    }
    preparedProposals.push({
      path: targetPath,
      edits,
      originalContent,
      updatedContent,
      appliedCount,
    });
  }

  const proposals = [];
  for (const prepared of preparedProposals) {
    const id =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const proposal = {
      id,
      type: "patch",
      path: prepared.path,
      content: prepared.updatedContent,
      originalContent: prepared.originalContent,
      summary: buildSummary(prepared.path, prepared.edits, prepared.appliedCount),
      isNewFile: false,
      conversationId,
    };
    service.proposals.set(id, proposal);
    service.sendToRenderer("agent:proposal", { proposal });
    proposals.push({
      proposalId: id,
      path: prepared.path,
      appliedCount: prepared.appliedCount,
    });
  }

  if (service.agentOptions.autoApply) {
    for (const entry of proposals) {
      await service.applyProposal(entry.proposalId);
    }
  }

  return {
    status: "proposed",
    proposalIds: proposals.map((proposal) => proposal.proposalId),
    files: proposals,
  };
};

const handleProposeDelete = async (service, args, policy, conversationId) => {
  const targetPath = normalizePath(args.path);
  const summary = typeof args.summary === "string" ? args.summary : "ファイル削除";
  if (!targetPath) {
    return { error: "path が空です。" };
  }
  if (isBlockedPath(targetPath, policy)) {
    return { error: "対象パスは削除禁止です。" };
  }
  const resolved = service.workspace.resolvePath(targetPath);
  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat || !stat.isFile()) {
    return { error: "ファイルが見つかりません。" };
  }
  let originalContent = "";
  let isBinary = false;
  const snapshot = service.getContextSnapshot(conversationId, targetPath);
  if (snapshot && snapshot.content) {
    if (snapshot.contentLength > policy.maxFileBytes) {
      return { error: "ファイルが大きすぎます。" };
    }
    originalContent = snapshot.content;
  } else {
    try {
      const result = await readFileFromDisk(resolved);
      originalContent = result.content;
      isBinary = result.binary;
    } catch {
      originalContent = "";
    }
  }
  const id =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const proposal = {
    id,
    type: "delete",
    path: targetPath,
    content: "",
    originalContent,
    isBinary,
    summary,
    isNewFile: false,
    conversationId,
  };
  service.proposals.set(id, proposal);
  service.sendToRenderer("agent:proposal", { proposal });
  return { status: "proposed", proposalId: id };
};

const handleProposeRename = async (service, args, policy, conversationId) => {
  const oldPath = normalizePath(args.oldPath);
  const newPath = normalizePath(args.newPath);
  const summary = typeof args.summary === "string" ? args.summary : `${oldPath} → ${newPath}`;
  if (!oldPath || !newPath) {
    return { error: "oldPath と newPath は必須です。" };
  }
  if (isBlockedPath(oldPath, policy) || isBlockedPath(newPath, policy)) {
    return { error: "対象パスは操作禁止です。" };
  }
  const resolved = service.workspace.resolvePath(oldPath);
  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat || !stat.isFile()) {
    return { error: "ファイルが見つかりません。" };
  }
  let originalContent = "";
  let isBinary = false;
  const snapshot = service.getContextSnapshot(conversationId, oldPath);
  if (snapshot && snapshot.content) {
    if (snapshot.contentLength > policy.maxFileBytes) {
      return { error: "ファイルが大きすぎます。" };
    }
    originalContent = snapshot.content;
  } else {
    try {
      const result = await readFileFromDisk(resolved);
      originalContent = result.content;
      isBinary = result.binary;
    } catch {
      originalContent = "";
    }
  }
  const id =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const proposal = {
    id,
    type: "rename",
    path: newPath,
    oldPath,
    content: originalContent,
    originalContent,
    isBinary,
    summary,
    isNewFile: false,
    conversationId,
  };
  service.proposals.set(id, proposal);
  service.sendToRenderer("agent:proposal", { proposal });
  return { status: "proposed", proposalId: id };
};

const handleProposeCreateDirectory = async (service, args, policy, conversationId) => {
  const targetPath = normalizePath(args.path);
  const summary = typeof args.summary === "string" ? args.summary : "ディレクトリ作成";
  if (!targetPath) {
    return { error: "path が空です。" };
  }
  if (isBlockedPath(targetPath, policy)) {
    return { error: "対象パスは作成禁止です。" };
  }
  const id =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const proposal = {
    id,
    type: "mkdir",
    path: targetPath,
    content: "",
    originalContent: "",
    summary,
    isNewFile: true,
    conversationId,
  };
  service.proposals.set(id, proposal);
  service.sendToRenderer("agent:proposal", { proposal });
  if (service.agentOptions.autoApply) {
    await service.applyProposal(id);
  }
  return { status: "proposed", proposalId: id };
};

module.exports = {
  DEFAULT_MAX_COMMAND_OUTPUT_BYTES,
  handleListFiles,
  handleProposeCreateDirectory,
  handleProposeDelete,
  handleProposePatch,
  handleProposeRename,
  handleProposeWrite,
  handleReadFile,
  handleReadFiles,
  handleRunCommand,
  readFileFromDisk,
  replaceAllWithCount,
  replaceOnceWithCount,
  runShellCommand,
};
