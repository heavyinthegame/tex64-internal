const path = require("path");
const fsp = require("fs/promises");
const crypto = require("crypto");
const { normalizeRelativePath } = require("./workspace.cjs");
const { AGENT_TOOL_DECLARATIONS } = require("./agent-tools.cjs");
const { requestGemini } = require("./agent-llm.cjs");
const {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_READ_FILES,
  buildAgentPolicy,
  clampNumber,
  formatByteLimit,
  isBlockedPath,
  isTextExtension,
  normalizeExtensionList,
  normalizePath,
  normalizeStringList,
} = require("./agent-policy.cjs");
const {
  DEFAULT_LATEX_SYMBOL_EXTENSIONS,
  renameBibEntryKey,
  renameLatexInText,
} = require("./agent-latex.cjs");
const {
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
} = require("./agent-tools-file.cjs");
const { handleSearchFiles } = require("./agent-tools-search.cjs");
const TOOL_STATUS_LABELS = {
  list_files: "構成把握中",
  get_project_structure: "構成把握中",
  get_index: "構造解析中",
  read_file: "ファイル確認中",
  read_files: "ファイル確認中",
  search_files: "検索中",
  run_build: "ビルド検証中",
  run_command: "コマンド実行中",
  rename_latex_symbol: "シンボルリネーム中",
  get_app_settings: "設定取得中",
  set_app_settings: "設定更新中",
  propose_write: "変更案作成中",
  propose_patch: "変更案作成中",
  propose_delete: "変更案作成中",
  propose_rename: "変更案作成中",
  propose_create_directory: "変更案作成中",
};
const MAX_USER_INLINE_DATA_BYTES = 5 * 1024 * 1024;
const MAX_USER_INLINE_DATA_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_APPLY_UNDO_ENTRIES = 40;
const DEFAULT_CHAT_MODEL = "gemini-3-flash-preview";
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const REQUEST_HISTORY_MAX_MESSAGES = 24;
const REQUEST_HISTORY_MAX_CHARS = 64_000;
const BASE64_DATA_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const parseNumber = (value, fallback = 0) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
};
const parseInteger = (value, fallback = 0) => Math.round(parseNumber(value, fallback));

const resolveResponseModel = (response) => {
  if (!response || typeof response !== "object") {
    return "";
  }
  const candidates = [
    response.resolvedModel,
    response.modelVersion,
    response.model,
    response.output?.model,
    response.usage?.model,
    response.usageMetadata?.model,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
};

const buildSystemPrompt = (context, rootPath, policy, options) => {
  const activeFilePath = context?.activeFilePath ?? "";
  const activeFileContent =
    typeof context?.activeFileContent === "string" ? context.activeFileContent : "";
  const activeFileIsDirty = Boolean(context?.activeFileIsDirty);
  const activeFileContentTruncated = Boolean(context?.activeFileContentTruncated);
  const activeFileContentLength =
    typeof context?.activeFileContentLength === "number" ? context.activeFileContentLength : null;
  const openFiles = Array.isArray(context?.openFiles) ? context.openFiles : [];
  const openFileLabel = openFiles.length
    ? openFiles
        .map((entry) => {
          const dirty = entry.isDirty ? " *" : "";
          const active = entry.isActive ? " (active)" : "";
          return `${entry.path}${dirty}${active}`;
        })
        .join(", ")
    : "";
  const dirtyOpenCount = openFiles.filter((entry) => entry.isDirty).length;
  const blockedList = policy?.blockedTopLevel ? Array.from(policy.blockedTopLevel) : [];
  const allowedList = policy?.allowedTopLevel ? Array.from(policy.allowedTopLevel) : [];
  const blockedLabel = blockedList.length > 0 ? blockedList.join(" / ") : "(なし)";
  const allowedLabel = allowedList.length > 0 ? allowedList.join(" / ") : "";
  const fileSizeLabel = formatByteLimit(policy?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
  const readFilesLimit = policy?.maxReadFiles ?? DEFAULT_MAX_READ_FILES;
  const contextControls =
    context?.contextControls && typeof context.contextControls === "object"
      ? context.contextControls
      : null;
  const includeSelection =
    contextControls && typeof contextControls.includeSelection === "boolean"
      ? contextControls.includeSelection
      : false;
  const includeOpenFiles =
    contextControls && typeof contextControls.includeOpenFiles === "boolean"
      ? contextControls.includeOpenFiles
      : true;
  const includeIssues =
    contextControls && typeof contextControls.includeIssues === "boolean"
      ? contextControls.includeIssues
      : true;
  const explicitContextPaths = Array.isArray(context?.explicitContextPaths)
    ? context.explicitContextPaths.filter((entry) => typeof entry === "string" && entry.trim())
    : [];

  const lines = [
    "あなたは TeX64 に統合されたAIアシスタントです。",
    "LaTeXプロジェクトの編集を支援します。",
    "",
    "## 利用可能なツール",
    "- list_files: ファイル一覧を取得",
    "- read_file: ファイルを読み取り",
    "- read_files: 複数ファイルを一括読み取り（効率的）",
    "- search_files: テキスト検索",
    "- get_project_structure: プロジェクト構造をツリー形式で取得",
    "- get_index: ラベル/参照/引用/セクションのインデックス取得",
    "- rename_latex_symbol: LaTeXのラベル/参照/引用キーを一括リネーム",
    "- run_build: ビルド検証を実行",
    "- run_command: ターミナルコマンドを実行",
    "- get_app_settings: アプリ設定を取得",
    "- set_app_settings: アプリ設定を更新",
    "- propose_write: ファイル作成/上書きを提案",
    "- propose_patch: 部分編集を提案（複数ファイル/複数箇所対応）",
    "- propose_delete: ファイル削除を提案",
    "- propose_rename: ファイルのリネーム/移動を提案",
    "- propose_create_directory: ディレクトリ作成を提案",
    "",
    "## 必須ルール",
    "- 目的は、ユーザーの論文執筆を自律的に前進させること。各ターンで完成に近づく提案を行う",
    "- 変更は重要度で判断し、重大な不整合・ビルド失敗・論旨破綻に直結しない軽微な気になる点は無理に直さない",
    "- 闇雲に変更せず、ユーザーとの対話・明示指示・現在の文脈から必要性を見極めてツール呼び出しと変更提案を行う",
    "- 検証が必要なタスクでは run_build を使って確認する（ユーザー依頼がある場合は必ず実行）",
    "- 変更は全て propose_* で提案する（適用はユーザー承認、または autoApply 有効時に自動）",
    "- 1回の応答で、関連するまとまった変更（複数ファイル/複数箇所）を提案してよい",
    "- 変更前に必ず read_file / read_files で現状を確認する（アクティブファイルのスナップショットが提供されている場合はそれを利用してよい）",
    "- 必要ならツール呼び出しを複数回繰り返してよい（1回で終える必要はない）",
    "- エラー修正や検証では run_build / read_file / propose_patch を反復し、解決に向けて段階的に進める",
    "- ユーザーの執筆意図が明確な場合は、必要な範囲で本文を自律的に書き進める提案を優先する",
    "- ユーザー入力には画像添付（inlineData）が含まれる場合がある。内容を読み取り、提案に反映する",
    options?.allowRunCommand === true
      ? "- run_command は許可設定中（allowRunCommand=true）のため実行可能"
      : "- run_command は無効（allowRunCommand=false）。利用せず他ツールで対応する",
    `- ブロック対象: ${blockedLabel}${allowedLabel ? `（許可: ${allowedLabel}）` : ""}`,
    Number.isFinite(readFilesLimit)
      ? `- read_files は最大${readFilesLimit}件まで`
      : "- read_files は無制限",
    fileSizeLabel === "無制限"
      ? "- ファイルサイズ制限なし"
      : `- 1ファイル最大${fileSizeLabel}まで読み書き可能`,
    "- バイナリファイルは read_file/read_files の encoding: base64 で取得できる",
    "- 大きな変更は propose_patch で部分編集を優先する",
    "",
    "## 出力ルール",
    "- 最終応答には方針と次の提案を必ず含める",
    "## ワークスペース",
    `- Root: ${rootPath}`,
    `- Active file: ${activeFilePath || "(none)"}`,
    `- Context controls: selection=${includeSelection ? "on" : "off"}, openFiles=${
      includeOpenFiles ? "on" : "off"
    }, issues=${includeIssues ? "on" : "off"}`,
  ];

  if (explicitContextPaths.length > 0) {
    lines.push(`- User referenced files: ${explicitContextPaths.join(", ")}`);
  }

  if (openFileLabel) {
    lines.push(`- Open files: ${openFileLabel}`);
    if (dirtyOpenCount > 0) {
      lines.push(`- Unsaved buffers: ${dirtyOpenCount}件（read_file は開いている未保存内容を優先）`);
    }
  }

  if (activeFileContent) {
    lines.push(`- Active file status: ${activeFileIsDirty ? "未保存の変更あり" : "保存済み"}`);
    if (activeFileContentTruncated) {
      const fullLength = activeFileContentLength ?? activeFileContent.length;
      lines.push(`- Active file note: 先頭${activeFileContent.length}文字のみ（全${fullLength}文字）`);
    }
    lines.push("", "## Active file snapshot", "```", activeFileContent, "```");
  }

  const activeSelection =
    context?.activeSelection && typeof context.activeSelection === "object"
      ? context.activeSelection
      : null;
  if (activeSelection && typeof activeSelection.text === "string" && activeSelection.text) {
    const pathLabel =
      typeof activeSelection.path === "string" && activeSelection.path.trim()
        ? activeSelection.path.trim()
        : "(unknown)";
    const startLine =
      typeof activeSelection.startLine === "number" ? activeSelection.startLine : null;
    const startColumn =
      typeof activeSelection.startColumn === "number" ? activeSelection.startColumn : null;
    const endLine = typeof activeSelection.endLine === "number" ? activeSelection.endLine : null;
    const endColumn =
      typeof activeSelection.endColumn === "number" ? activeSelection.endColumn : null;
    const rangeLabel =
      startLine && startColumn && endLine && endColumn
        ? `${startLine}:${startColumn}-${endLine}:${endColumn}`
        : "(range unknown)";
    lines.push("", "## Active selection", `- File: ${pathLabel}`, `- Range: ${rangeLabel}`);
    if (activeSelection.truncated) {
      const fullLength =
        typeof activeSelection.textLength === "number"
          ? activeSelection.textLength
          : activeSelection.text.length;
      lines.push(`- Selection note: 先頭${activeSelection.text.length}文字のみ（全${fullLength}文字）`);
    }
    lines.push("```", activeSelection.text, "```");
  } else if (context?.activeSelectionRequested === true) {
    lines.push("", "## Active selection", "- Selection requested but no active selection was found.");
  }

  const openSnapshots = Array.isArray(context?.openFileSnapshots)
    ? context.openFileSnapshots
    : [];
  if (openSnapshots.length > 0) {
    const seenPaths = new Set();
    const usableSnapshots = openSnapshots.filter((snapshot) => {
      if (!snapshot || typeof snapshot.path !== "string" || typeof snapshot.content !== "string") {
        return false;
      }
      if (snapshot.path === activeFilePath) {
        return false;
      }
      if (seenPaths.has(snapshot.path)) {
        return false;
      }
      seenPaths.add(snapshot.path);
      return true;
    });
    if (usableSnapshots.length > 0) {
      lines.push("", "## Open file snapshots");
      usableSnapshots.forEach((snapshot) => {
        const dirtyLabel = snapshot.isDirty ? " (未保存)" : "";
        lines.push(`### ${snapshot.path}${dirtyLabel}`);
        if (snapshot.truncated) {
          const fullLength =
            typeof snapshot.contentLength === "number"
              ? snapshot.contentLength
              : snapshot.content.length;
          lines.push(`- Snapshot note: 先頭${snapshot.content.length}文字のみ（全${fullLength}文字）`);
        }
        lines.push("```", snapshot.content, "```");
      });
    }
  }

  const recentIssues = Array.isArray(context?.recentIssues) ? context.recentIssues : [];
  const recentIssueSummary =
    typeof context?.recentIssueSummary === "string" ? context.recentIssueSummary : "";
  const recentIssueStatus =
    typeof context?.recentIssueStatus === "string" ? context.recentIssueStatus : "";
  const recentIssuesUpdatedAt =
    typeof context?.recentIssuesUpdatedAt === "string" ? context.recentIssuesUpdatedAt : "";
  if (recentIssues.length > 0) {
    lines.push("", "## Recent issues");
    if (recentIssueSummary) {
      lines.push(`- Summary: ${recentIssueSummary}${recentIssueStatus ? ` (${recentIssueStatus})` : ""}`);
    }
    if (recentIssuesUpdatedAt) {
      lines.push(`- Updated: ${recentIssuesUpdatedAt}`);
    }
    recentIssues.forEach((issue) => {
      if (!issue || typeof issue.message !== "string") {
        return;
      }
      const location = issue.path
        ? `${issue.path}${issue.line ? `:${issue.line}` : ""}`
        : issue.line
        ? `line ${issue.line}`
        : "location unknown";
      const severity = issue.severity || "error";
      const resolution =
        typeof issue.resolution === "string" && issue.resolution.trim()
          ? ` / fix: ${issue.resolution.trim()}`
          : "";
      lines.push(`- [${severity}] ${issue.message} (${location})${resolution}`);
    });
  }

  lines.push("", "必要に応じてファイルを読み、変更は提案してください。");
  return lines.join("\n");
};

const decodeBase64Strict = (value) => {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, "") : "";
  if (normalized.length % 4 !== 0) {
    return null;
  }
  if (!BASE64_DATA_PATTERN.test(normalized)) {
    return null;
  }
  const buffer = Buffer.from(normalized, "base64");
  const noPadNormalized = normalized.replace(/=+$/g, "");
  const noPadEncoded = buffer.toString("base64").replace(/=+$/g, "");
  if (noPadNormalized !== noPadEncoded) {
    return null;
  }
  return { normalized, byteLength: buffer.length };
};

const normalizeUserMessageParts = (message, parts) => {
  const normalized = [];
  let hasTextPart = false;
  let totalInlineBytes = 0;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const text = typeof part?.text === "string" ? part.text : "";
      if (text.trim()) {
        normalized.push({ text });
        hasTextPart = true;
      }
      const mimeType =
        typeof part?.inlineData?.mimeType === "string" ? part.inlineData.mimeType.trim() : "";
      const dataRaw = typeof part?.inlineData?.data === "string" ? part.inlineData.data : "";
      const decoded = decodeBase64Strict(dataRaw);
      if (!decoded) {
        continue;
      }
      if (decoded.byteLength > MAX_USER_INLINE_DATA_BYTES) {
        continue;
      }
      if (totalInlineBytes + decoded.byteLength > MAX_USER_INLINE_DATA_TOTAL_BYTES) {
        continue;
      }
      if (mimeType.startsWith("image/")) {
        totalInlineBytes += decoded.byteLength;
        normalized.push({
          inlineData: {
            mimeType,
            data: decoded.normalized,
          },
        });
      }
    }
  }
  const normalizedMessage = typeof message === "string" ? message : "";
  if (!hasTextPart && normalizedMessage.trim()) {
    normalized.unshift({ text: normalizedMessage });
  }
  return normalized.length > 0 ? normalized : null;
};

class AgentService {
  constructor({
    workspace,
    searchService,
    ensureUserSettings,
    sendToRenderer,
    updateWorkspaceIfNeeded,
    requestIndex,
    buildService,
    sendBuildState,
    sendBuildLog,
    sendIssues,
    indexerService,
    apiUsageService,
    requestAiChat,
  }) {
    this.workspace = workspace;
    this.searchService = searchService;
    this.ensureUserSettings = ensureUserSettings;
    this.sendToRenderer = sendToRenderer;
    this.updateWorkspaceIfNeeded = updateWorkspaceIfNeeded;
    this.requestIndex = requestIndex;
    this.buildService = buildService;
    this.sendBuildState = sendBuildState;
    this.sendBuildLog = sendBuildLog;
    this.sendIssues = sendIssues;
    this.indexerService = indexerService;
    this.apiUsageService = apiUsageService;
    this.requestAiChat = typeof requestAiChat === "function" ? requestAiChat : null;
    this.conversations = new Map();
    this.proposals = new Map();
    this.contextByConversation = new Map();
    this.runningControllers = new Map();
    this.agentPolicy = buildAgentPolicy();
    this.agentOptions = {
      maxIterations: DEFAULT_MAX_ITERATIONS,
      stream: true,
      autoApply: false,
      autoBuild: false,
      allowRunCommand: false,
    };
    this.autoBuildInProgress = false;
    this.pendingSettingsRequests = new Map();
    this.applyUndoStack = [];
  }

  sendStatus(state, message, conversationId) {
    this.sendToRenderer("agent:status", { state, message, conversationId });
  }

  buildConversation(conversationId) {
    if (!this.conversations.has(conversationId)) {
      this.conversations.set(conversationId, []);
    }
    return this.conversations.get(conversationId);
  }

  clearConversation(conversationId) {
    this.conversations.set(conversationId, []);
    this.contextByConversation.delete(conversationId);
  }

  abort(conversationId) {
    const targetConversationId =
      typeof conversationId === "string" && conversationId.trim()
        ? conversationId.trim()
        : "";
    if (targetConversationId) {
      const entry = this.runningControllers.get(targetConversationId);
      if (entry?.controller) {
        entry.controller.abort();
      }
      this.runningControllers.delete(targetConversationId);
      return;
    }
    this.runningControllers.forEach((entry) => {
      entry?.controller?.abort?.();
    });
    this.runningControllers.clear();
  }

  startConversationRun(conversationId) {
    const normalizedConversationId =
      typeof conversationId === "string" && conversationId.trim()
        ? conversationId.trim()
        : "default";
    const existing = this.runningControllers.get(normalizedConversationId);
    existing?.controller?.abort?.();
    const token =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const controller = new AbortController();
    this.runningControllers.set(normalizedConversationId, { controller, token });
    return { conversationId: normalizedConversationId, controller, token };
  }

  isRunCurrent(conversationId, token) {
    const current = this.runningControllers.get(conversationId);
    return Boolean(current && current.token === token);
  }

  finishConversationRun(conversationId, token) {
    if (!this.isRunCurrent(conversationId, token)) {
      return;
    }
    this.runningControllers.delete(conversationId);
  }

  resolveAgentPolicy(settings) {
    const policy = buildAgentPolicy(settings);
    this.agentPolicy = policy;
    return policy;
  }

  resolveAgentOptions(settings) {
    const options = {
      maxIterations: clampNumber(
        settings?.maxIterations,
        DEFAULT_MAX_ITERATIONS,
        { min: 1, max: 30 }
      ),
      stream: settings?.stream !== false,
      autoApply: settings?.autoApply === true,
      autoBuild: settings?.autoBuild === true,
      allowRunCommand: settings?.allowRunCommand === true,
    };
    this.agentOptions = options;
    return options;
  }

  setContext(conversationId, context) {
    if (!conversationId) {
      return;
    }
    this.contextByConversation.set(conversationId, context ?? {});
  }

  requestAppSettings(action, payload) {
    const requestId =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSettingsRequests.delete(requestId);
        resolve({ error: "設定の取得に失敗しました。" });
      }, 3000);
      this.pendingSettingsRequests.set(requestId, { resolve, timer });
      this.sendToRenderer("settings:request", {
        requestId,
        action,
        ...payload,
      });
    });
  }

  handleSettingsResponse(payload) {
    const requestId = payload?.requestId;
    if (!requestId || !this.pendingSettingsRequests.has(requestId)) {
      return;
    }
    const entry = this.pendingSettingsRequests.get(requestId);
    this.pendingSettingsRequests.delete(requestId);
    if (entry?.timer) {
      clearTimeout(entry.timer);
    }
    entry?.resolve?.(payload);
  }

  async maybeAutoBuild(proposal) {
    if (!this.agentOptions.autoBuild || this.autoBuildInProgress) {
      return;
    }
    const pathValue = proposal?.path ?? "";
    if (!/\.(tex|bib|sty|cls|ltx|dtx)$/i.test(pathValue)) {
      return;
    }
    this.autoBuildInProgress = true;
    try {
      await this.executeToolCall(
        { name: "run_build", args: {} },
        proposal?.conversationId ?? "default"
      );
    } finally {
      this.autoBuildInProgress = false;
    }
  }

  getContextSnapshot(conversationId, targetPath) {
    if (!targetPath) {
      return null;
    }
    const context = this.contextByConversation.get(conversationId);
    if (!context || !targetPath) {
      return null;
    }
    if (context.activeFilePath === targetPath && typeof context.activeFileContent === "string") {
      return {
        path: targetPath,
        content: context.activeFileContent,
        isDirty: Boolean(context.activeFileIsDirty),
        truncated: Boolean(context.activeFileContentTruncated),
        contentLength:
          typeof context.activeFileContentLength === "number"
            ? context.activeFileContentLength
            : context.activeFileContent.length,
      };
    }
    const snapshots = Array.isArray(context.openFileSnapshots)
      ? context.openFileSnapshots
      : [];
    const match = snapshots.find((entry) => entry.path === targetPath);
    if (!match || typeof match.content !== "string") {
      return null;
    }
    return {
      path: match.path,
      content: match.content,
      isDirty: Boolean(match.isDirty),
      truncated: Boolean(match.truncated),
      contentLength:
        typeof match.contentLength === "number" ? match.contentLength : match.content.length,
    };
  }

  hashBuffer(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
  }

  hashUtf8(value) {
    return this.hashBuffer(Buffer.from(value ?? "", "utf8"));
  }

  hashProposalContent(proposal) {
    if (!proposal) {
      return null;
    }
    if (proposal.encoding === "base64") {
      const decoded = decodeBase64Strict(proposal.content);
      if (!decoded) {
        return null;
      }
      return this.hashBuffer(Buffer.from(decoded.normalized, "base64"));
    }
    if (typeof proposal.content !== "string") {
      return null;
    }
    return this.hashUtf8(proposal.content);
  }

  async readCurrentFileState(relativePath) {
    const resolved = this.workspace.resolvePath(relativePath);
    const stat = await fsp.stat(resolved).catch(() => null);
    if (!stat) {
      return { exists: false, isFile: false, resolved, buffer: null };
    }
    if (!stat.isFile()) {
      return { exists: true, isFile: false, resolved, buffer: null };
    }
    const buffer = await fsp.readFile(resolved);
    return { exists: true, isFile: true, resolved, buffer };
  }

  async validateProposalBeforeApply(proposal) {
    const type = proposal?.type || "write";
    if (type === "mkdir") {
      const resolved = this.workspace.resolvePath(proposal.path);
      const stat = await fsp.stat(resolved).catch(() => null);
      if (stat && !stat.isDirectory()) {
        return {
          ok: false,
          conflict: true,
          error: "同名のファイルが存在するためディレクトリを作成できません。",
        };
      }
      return { ok: true, targetState: { exists: Boolean(stat), isDirectory: Boolean(stat?.isDirectory?.()) } };
    }

    const targetPath = type === "rename" ? proposal.oldPath : proposal.path;
    if (!targetPath || typeof targetPath !== "string") {
      return { ok: false, conflict: false, error: "提案の対象パスが不正です。" };
    }

    const state = await this.readCurrentFileState(targetPath);
    if (proposal.isNewFile === true && (type === "write" || type === "patch")) {
      if (state.exists) {
        return {
          ok: false,
          conflict: true,
          error: "新規作成予定のファイルが既に存在します。再提案してください。",
        };
      }
      return { ok: true, targetState: state };
    }

    if (!state.exists) {
      return {
        ok: false,
        conflict: true,
        error: "適用前に対象ファイルが削除または移動されました。再提案してください。",
      };
    }

    if (!state.isFile) {
      return {
        ok: false,
        conflict: true,
        error: "対象パスがファイルではありません。再提案してください。",
      };
    }

    const expectedHash =
      typeof proposal.baseContentHash === "string" ? proposal.baseContentHash.trim() : "";
    if (expectedHash && state.buffer) {
      const currentHash = this.hashBuffer(state.buffer);
      if (currentHash !== expectedHash) {
        return {
          ok: false,
          conflict: true,
          error: "適用前にファイル内容が変更されました。差分を確認して再提案してください。",
        };
      }
    }

    if (type === "rename") {
      const newState = await this.readCurrentFileState(proposal.path);
      if (newState.exists) {
        return {
          ok: false,
          conflict: true,
          error: "移動先に同名ファイルが存在します。別名で再提案してください。",
        };
      }
    }

    return { ok: true, targetState: state };
  }

  pushUndoEntry(entry) {
    if (!entry) {
      return;
    }
    this.applyUndoStack.push(entry);
    if (this.applyUndoStack.length > MAX_APPLY_UNDO_ENTRIES) {
      this.applyUndoStack.splice(0, this.applyUndoStack.length - MAX_APPLY_UNDO_ENTRIES);
    }
  }

  async undoLastApply(conversationId) {
    const targetConversationId =
      typeof conversationId === "string" && conversationId.trim()
        ? conversationId.trim()
        : "";
    let targetIndex = -1;
    for (let i = this.applyUndoStack.length - 1; i >= 0; i -= 1) {
      const entry = this.applyUndoStack[i];
      if (!targetConversationId || entry.conversationId === targetConversationId) {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex < 0) {
      this.sendToRenderer("agent:undoResult", {
        ok: false,
        message: "取り消せる操作がありません。",
        conversationId: targetConversationId || undefined,
      });
      return;
    }

    const entry = this.applyUndoStack.splice(targetIndex, 1)[0];
    const rootPath = this.workspace.getRootPath();
    if (!rootPath) {
      this.applyUndoStack.push(entry);
      this.sendToRenderer("agent:undoResult", {
        ok: false,
        message: "ワークスペースが選択されていません。",
        conversationId: targetConversationId || entry.conversationId,
      });
      return;
    }

    try {
      if (entry.type === "write") {
        const resolved = this.workspace.resolvePath(entry.path);
        if (entry.existed && Buffer.isBuffer(entry.previousBuffer)) {
          await fsp.mkdir(path.dirname(resolved), { recursive: true });
          await fsp.writeFile(resolved, entry.previousBuffer);
          if (entry.wasBinary !== true) {
            this.sendToRenderer("agent:applyContent", {
              path: entry.path,
              content: entry.previousBuffer.toString("utf8"),
              updateSaved: true,
            });
          }
        } else {
          await fsp.unlink(resolved).catch((error) => {
            if (error?.code !== "ENOENT") {
              throw error;
            }
          });
        }
      } else if (entry.type === "delete") {
        const resolved = this.workspace.resolvePath(entry.path);
        await fsp.mkdir(path.dirname(resolved), { recursive: true });
        await fsp.writeFile(resolved, entry.previousBuffer);
        if (entry.wasBinary !== true) {
          this.sendToRenderer("agent:applyContent", {
            path: entry.path,
            content: entry.previousBuffer.toString("utf8"),
            updateSaved: true,
          });
        }
      } else if (entry.type === "rename") {
        const fromResolved = this.workspace.resolvePath(entry.newPath);
        const toResolved = this.workspace.resolvePath(entry.oldPath);
        const fromStat = await fsp.stat(fromResolved).catch(() => null);
        if (!fromStat || !fromStat.isFile()) {
          throw new Error("移動先ファイルが見つからないため取り消せません。");
        }
        const toStat = await fsp.stat(toResolved).catch(() => null);
        if (toStat) {
          throw new Error("元のパスに既存ファイルがあるため取り消せません。");
        }
        await fsp.mkdir(path.dirname(toResolved), { recursive: true });
        await fsp.rename(fromResolved, toResolved);
        this.sendToRenderer("renameResult", {
          oldPath: entry.newPath,
          newPath: entry.oldPath,
          isDirectory: false,
        });
      } else if (entry.type === "mkdir") {
        const resolved = this.workspace.resolvePath(entry.path);
        const stat = await fsp.stat(resolved).catch(() => null);
        if (stat && stat.isDirectory()) {
          const childEntries = await fsp.readdir(resolved).catch(() => []);
          if (childEntries.length > 0) {
            throw new Error("ディレクトリ内にファイルがあるため取り消せません。");
          }
          await fsp.rmdir(resolved);
        }
      } else {
        throw new Error("未対応の取り消し操作です。");
      }

      await this.updateWorkspaceIfNeeded(rootPath, true);
      this.requestIndex(rootPath);
      this.sendToRenderer("agent:undoResult", {
        ok: true,
        path: entry.path,
        conversationId: targetConversationId || entry.conversationId,
      });
    } catch (error) {
      this.applyUndoStack.push(entry);
      this.sendToRenderer("agent:undoResult", {
        ok: false,
        message: error?.message ?? "取り消しに失敗しました。",
        conversationId: targetConversationId || entry.conversationId,
      });
    }
  }

  async applyProposal(proposalId) {
    const proposal = this.proposals.get(proposalId);
    const rootPath = this.workspace.getRootPath();
    if (!proposal) {
      this.sendToRenderer("agent:applyResult", {
        proposalId,
        ok: false,
        error: "提案が見つかりません。",
      });
      return;
    }
    if (!rootPath) {
      this.sendToRenderer("agent:applyResult", {
        proposalId,
        ok: false,
        error: "ワークスペースが選択されていません。",
      });
      return;
    }
    try {
      const type = proposal.type || "write";
      const validation = await this.validateProposalBeforeApply(proposal);
      if (!validation.ok) {
        this.sendToRenderer("agent:applyResult", {
          proposalId,
          ok: false,
          conflict: validation.conflict === true,
          error: validation.error || "適用前チェックに失敗しました。",
        });
        return;
      }
      let undoEntry = null;

      if (type === "delete") {
        const resolved = this.workspace.resolvePath(proposal.path);
        const currentState = validation.targetState;
        if (!currentState?.buffer) {
          throw new Error("削除前の内容を取得できませんでした。");
        }
        undoEntry = {
          type: "delete",
          conversationId: proposal.conversationId || "default",
          path: proposal.path,
          previousBuffer: currentState.buffer,
          wasBinary: Boolean(proposal.isBinary),
        };
        if (typeof this.workspace.moveToInternalTrash === "function") {
          await this.workspace.moveToInternalTrash(resolved);
        } else {
          await fsp.unlink(resolved);
        }
      } else if (type === "rename") {
        const oldResolved = this.workspace.resolvePath(proposal.oldPath);
        const newResolved = this.workspace.resolvePath(proposal.path);
        undoEntry = {
          type: "rename",
          conversationId: proposal.conversationId || "default",
          oldPath: proposal.oldPath,
          newPath: proposal.path,
          path: proposal.path,
        };
        await fsp.mkdir(path.dirname(newResolved), { recursive: true });
        await fsp.rename(oldResolved, newResolved);
        this.sendToRenderer("renameResult", {
          oldPath: proposal.oldPath,
          newPath: proposal.path,
          isDirectory: false,
        });
      } else if (type === "mkdir") {
        const resolved = this.workspace.resolvePath(proposal.path);
        undoEntry = {
          type: "mkdir",
          conversationId: proposal.conversationId || "default",
          path: proposal.path,
        };
        await fsp.mkdir(resolved, { recursive: true });
      } else {
        // write or patch
        const resolved = this.workspace.resolvePath(proposal.path);
        const currentState = validation.targetState;
        const existedBefore = Boolean(currentState?.exists && currentState?.isFile);
        const previousBuffer = existedBefore ? currentState.buffer : null;
        const wasBinary = existedBefore ? Boolean(previousBuffer?.includes?.(0)) : false;
        const nextHash = this.hashProposalContent(proposal);
        if (nextHash && typeof proposal.baseContentHash === "string" && nextHash === proposal.baseContentHash) {
          this.sendToRenderer("agent:applyResult", {
            proposalId,
            ok: false,
            error: "変更内容がありません。",
          });
          return;
        }
        undoEntry = {
          type: "write",
          conversationId: proposal.conversationId || "default",
          path: proposal.path,
          existed: existedBefore,
          previousBuffer,
          wasBinary,
        };
        await fsp.mkdir(path.dirname(resolved), { recursive: true });
        if (proposal.encoding === "base64") {
          const decoded = decodeBase64Strict(proposal.content);
          if (!decoded) {
            throw new Error("base64 の内容が不正です。");
          }
          const buffer = Buffer.from(decoded.normalized, "base64");
          await fsp.writeFile(resolved, buffer);
        } else {
          await this.workspace.writeFile(proposal.path, proposal.content);
          this.sendToRenderer("agent:applyContent", {
            path: proposal.path,
            content: proposal.content,
            updateSaved: true,
          });
        }
      }

      this.pushUndoEntry(undoEntry);
      await this.updateWorkspaceIfNeeded(rootPath, true);
      this.requestIndex(rootPath);
      this.proposals.delete(proposalId);
      this.sendToRenderer("agent:applyResult", { proposalId, ok: true });
      await this.maybeAutoBuild(proposal);
    } catch (error) {
      this.sendToRenderer("agent:applyResult", {
        proposalId,
        ok: false,
        error: error?.message ?? "操作に失敗しました。",
      });
    }
  }

  buildProgressMessage(label) {
    if (!label) {
      return "思考中...";
    }
    return `思考中: ${label}`;
  }

  buildPlatformUsageFromQuota(quota, plan, source = "chat") {
    if (!quota || typeof quota !== "object") {
      return null;
    }
    const limitTokens = Math.max(0, parseInteger(quota.limitTokens, 0));
    const usedTokens = Math.max(0, parseInteger(quota.usedTokens, 0));
    const maxRemainingTokens = Math.max(0, limitTokens - usedTokens);
    const rawRemainingTokens = parseNumber(quota.remainingTokens, Number.NaN);
    const normalizedRemainingTokens = Number.isFinite(rawRemainingTokens)
      ? Math.max(0, Math.round(rawRemainingTokens))
      : maxRemainingTokens;
    return {
      source,
      usage: {
        authenticated: true,
        plan: typeof plan === "string" && plan ? plan : null,
        period: null,
        summary: {
          limitTokens,
          usedTokens,
          remainingTokens: Math.min(normalizedRemainingTokens, maxRemainingTokens),
          usedRequests: Math.max(0, parseInteger(quota.usedRequests, 0)),
          remainingRequests: Math.max(0, parseInteger(quota.remainingRequests, 0)),
          periodStart:
            typeof quota.periodStart === "string" ? quota.periodStart : null,
          periodEnd: typeof quota.periodEnd === "string" ? quota.periodEnd : null,
        },
        byFeature: null,
        errorCode: null,
        message: null,
        fetchedAt: Date.now(),
      },
    };
  }

  extractUsageMetadata(response) {
    if (!response || typeof response !== "object") {
      return null;
    }
    const usage = response.usageMetadata ?? response.usage ?? null;
    if (!usage || typeof usage !== "object") {
      return null;
    }
    const promptTokenCount = parseInteger(
      usage.promptTokenCount ??
        usage.promptTokens ??
        usage.inputTokenCount ??
        usage.inputTokens ??
        usage.input_tokens,
      0
    );
    const candidatesTokenCount = parseInteger(
      usage.candidatesTokenCount ??
        usage.outputTokenCount ??
        usage.outputTokens ??
        usage.output_tokens,
      0
    );
    const totalTokenCount = parseInteger(
      usage.totalTokenCount ??
        usage.totalTokens ??
        usage.quotaConsumedTokens ??
        promptTokenCount + candidatesTokenCount,
      promptTokenCount + candidatesTokenCount
    );
    return {
      promptTokenCount: Math.max(0, promptTokenCount),
      candidatesTokenCount: Math.max(0, candidatesTokenCount),
      totalTokenCount: Math.max(0, totalTokenCount),
    };
  }

  normalizeModelCandidate(response) {
    if (!response || typeof response !== "object") {
      return null;
    }
    const directCandidate = response?.candidates?.[0]?.content ?? null;
    if (directCandidate && Array.isArray(directCandidate.parts)) {
      return directCandidate;
    }
    const output = response.output && typeof response.output === "object" ? response.output : {};
    if (Array.isArray(output.parts) && output.parts.length > 0) {
      return { role: "model", parts: output.parts };
    }
    const text =
      typeof output.text === "string"
        ? output.text
        : typeof response.text === "string"
        ? response.text
        : "";
    if (text.trim()) {
      return { role: "model", parts: [{ text }] };
    }
    return null;
  }

  async executeToolCall(toolCall, conversationId) {
    try {
      const name = toolCall?.name ?? "";
      let args = toolCall?.args ?? {};
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      if (!args || typeof args !== "object") {
        args = {};
      }
      const policy = this.agentPolicy ?? buildAgentPolicy();
      const clip = (value, max = 60) => {
        const text = typeof value === "string" ? value.trim() : "";
        if (!text) return "";
        return text.length > max ? `${text.slice(0, max)}…` : text;
      };
      const statusLabel = TOOL_STATUS_LABELS[name];
      if (statusLabel) {
        let detail = statusLabel;
        if (name === "read_file") {
          const targetPath = normalizePath(args.path);
          if (targetPath) detail = `${statusLabel}: ${targetPath}`;
        } else if (name === "read_files") {
          const paths = normalizeStringList(args.paths).slice(0, 3);
          if (paths.length > 0) {
            const suffix = normalizeStringList(args.paths).length > 3 ? "…" : "";
            detail = `${statusLabel}: ${paths.join(", ")}${suffix}`;
          }
        } else if (name === "search_files") {
          const query = clip(args.query, 48);
          if (query) detail = `${statusLabel}: ${query}`;
        } else if (name === "list_files") {
          const directory = normalizePath(args.directory);
          if (directory) detail = `${statusLabel}: ${directory}`;
        } else if (name === "get_index") {
          const kinds = normalizeStringList(args.kinds).slice(0, 4);
          const query = clip(args.query, 32);
          if (kinds.length > 0 || query) {
            const parts = [];
            if (kinds.length > 0) parts.push(kinds.join(", "));
            if (query) parts.push(`q=${query}`);
            detail = `${statusLabel}: ${parts.join(" ")}`;
          }
        } else if (name === "rename_latex_symbol") {
          const from = clip(args.from, 24);
          const to = clip(args.to, 24);
          if (from && to) detail = `${statusLabel}: ${from} → ${to}`;
        } else if (name === "run_build") {
          const mainFile = clip(args.mainFile, 64);
          const engine = clip(args.engine, 16);
          if (mainFile || engine) {
            detail = `${statusLabel}: ${[mainFile, engine].filter(Boolean).join(" ")}`;
          }
        } else if (name === "run_command") {
          const command = clip(args.command, 64);
          if (command) detail = `${statusLabel}: ${command}`;
        } else if (
          name === "propose_write" ||
          name === "propose_patch" ||
          name === "propose_delete" ||
          name === "propose_rename" ||
          name === "propose_create_directory"
        ) {
          const targetPath = clip(args.path, 80);
          if (targetPath) detail = `${statusLabel}: ${targetPath}`;
        }
        this.sendStatus("running", this.buildProgressMessage(detail), conversationId);
      }

      if (name === "list_files") {
        return handleListFiles(this, args, policy);
      }

      if (name === "read_file") {
        return handleReadFile(this, args, policy, conversationId);
      }

      if (name === "read_files") {
        return handleReadFiles(this, args, policy, conversationId);
      }

      if (name === "search_files") {
        return handleSearchFiles(this, args, policy, conversationId);
      }

      if (name === "get_project_structure") {
        const maxDepth = typeof args.maxDepth === "number" ? args.maxDepth : 3;
        const rootPath = this.workspace.getRootPath();
        if (!rootPath) {
          return { error: "ワークスペースが選択されていません。" };
        }
        const buildTree = async (dir, depth) => {
          if (depth > maxDepth) return null;
          const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
          entries.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name, "ja");
          });
          const result = [];
          for (const entry of entries) {
            const absPath = path.join(dir, entry.name);
            const relPath = normalizeRelativePath(path.relative(rootPath, absPath));
            const top = relPath.split("/")[0];
            if (policy.blockedTopLevel.has(top) && !policy.allowedTopLevel.has(top)) {
              continue;
            }
            if (entry.isDirectory()) {
              const children = await buildTree(absPath, depth + 1);
              result.push({
                name: entry.name,
                path: relPath,
                type: "dir",
                children: children || [],
              });
            } else {
              result.push({ name: entry.name, path: relPath, type: "file" });
            }
          }
          return result;
        };
        const tree = await buildTree(rootPath, 1);
        return { structure: tree };
      }

      if (name === "get_index") {
        const rootPath = this.workspace.getRootPath();
        if (!rootPath) {
          return { error: "ワークスペースが選択されていません。" };
        }
        if (!this.indexerService) {
          return { error: "インデクサが利用できません。" };
        }
        const limit =
          typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : 200;
        const query =
          typeof args.query === "string" && args.query.trim() ? args.query.trim().toLowerCase() : "";
        const kinds = Array.isArray(args.kinds)
          ? args.kinds.filter((kind) => typeof kind === "string")
          : [];
        const snapshot = await this.indexerService.buildIndex(rootPath);
        const filterSymbols = (items, keyField) => {
          let result = items;
          if (query) {
            result = result.filter((entry) =>
              String(entry[keyField] ?? "").toLowerCase().includes(query)
            );
          }
          if (Number.isFinite(limit)) {
            result = result.slice(0, Math.max(0, limit));
          }
          return result;
        };
        const includeAll = kinds.length === 0;
        const data = {};
        if (includeAll || kinds.includes("labels")) {
          data.labels = filterSymbols(snapshot.labels, "key");
        }
        if (includeAll || kinds.includes("references")) {
          data.references = filterSymbols(snapshot.references, "key");
        }
        if (includeAll || kinds.includes("citations")) {
          data.citations = filterSymbols(snapshot.citations, "key");
        }
        if (includeAll || kinds.includes("sections")) {
          data.sections = filterSymbols(snapshot.sections, "title");
        }
        if (includeAll || kinds.includes("figures")) {
          data.figures = filterSymbols(snapshot.figures, "key");
        }
        if (includeAll || kinds.includes("tables")) {
          data.tables = filterSymbols(snapshot.tables, "key");
        }
        if (includeAll || kinds.includes("todos")) {
          data.todos = filterSymbols(snapshot.todos, "key");
        }
        return { index: data };
      }

      if (name === "get_app_settings") {
        const keys = Array.isArray(args.keys)
          ? args.keys.filter((entry) => typeof entry === "string")
          : [];
        const response = await this.requestAppSettings("get", { keys });
        if (response?.error) {
          return { error: response.error };
        }
        const settings = response?.settings ?? response?.payload?.settings ?? null;
        if (!settings) {
          return { error: "設定が取得できませんでした。" };
        }
        if (keys.length === 0) {
          return { settings };
        }
        const filtered = {};
        keys.forEach((key) => {
          if (Object.prototype.hasOwnProperty.call(settings, key)) {
            filtered[key] = settings[key];
          }
        });
        return { settings: filtered };
      }

      if (name === "set_app_settings") {
        const patch =
          args?.settings && typeof args.settings === "object" ? args.settings : null;
        if (!patch) {
          return { error: "settings が空です。" };
        }
        const response = await this.requestAppSettings("set", { settings: patch });
        if (response?.error) {
          return { error: response.error };
        }
        const settings = response?.settings ?? response?.payload?.settings ?? null;
        if (!settings) {
          return { error: "設定が更新できませんでした。" };
        }
        return { settings };
      }

      if (name === "run_build") {
        if (!this.buildService) {
          return { error: "ビルド機能が利用できません。" };
        }
        const rootPath = this.workspace.getRootPath();
        if (!rootPath) {
          return { error: "ワークスペースが選択されていません。" };
        }
        const requestedMain = typeof args.mainFile === "string" ? args.mainFile.trim() : "";
        const requestedEngine = typeof args.engine === "string" ? args.engine.trim() : "";
        const rootInfo = await this.workspace.rootInfo().catch(() => null);
        const requestedFile = requestedMain && requestedMain.trim() ? requestedMain.trim() : null;
        let targetFile = rootInfo?.path || "main.tex";
        if (requestedFile && requestedFile.endsWith(".tex")) {
          const magicRoot = await this.workspace
            .resolveTexRootFromMagic(requestedFile)
            .catch(() => null);
          if (magicRoot) {
            targetFile = magicRoot;
          } else if (!rootInfo?.path) {
            targetFile = requestedFile;
          }
        } else if (requestedFile && !rootInfo?.path) {
          targetFile = requestedFile;
        }
        this.sendBuildState?.("building", "AIがビルド中...");
        this.sendIssues?.(0, "AIがビルド中...", "info", []);
        const settings = await this.workspace.loadSettings().catch(() => null);
        const activeId =
          typeof settings?.buildProfileId === "string" ? settings.buildProfileId.trim() : "";
        const profiles = Array.isArray(settings?.buildProfiles) ? settings.buildProfiles : [];
        const selected = activeId
          ? profiles.find(
              (profile) => profile && typeof profile === "object" && profile.id === activeId
            )
          : null;
        const buildProfile = selected
          ? {
              outDir:
                typeof selected.outDir === "string" && selected.outDir.trim()
                  ? selected.outDir.trim()
                  : null,
              extraArgs:
                typeof selected.extraArgs === "string" && selected.extraArgs.trim()
                  ? selected.extraArgs.trim()
                  : null,
            }
          : null;
        const result = await this.buildService.build(
          rootPath,
          targetFile,
          requestedEngine || "lualatex",
          buildProfile
        );
        if (result.kind === "busy") {
          this.sendBuildState?.("building", "すでにビルド中です。");
          this.sendIssues?.(0, "すでにビルド中です。", "info", []);
          return { status: "busy", summary: "すでにビルド中です。" };
        }
        if (result.log) {
          this.sendBuildLog?.(result.log);
        }
        if (result.kind === "cancelled") {
          this.sendBuildState?.("idle", result.summary ?? "ビルドをキャンセルしました。");
          this.sendIssues?.(0, result.summary ?? "ビルドをキャンセルしました。", "info", []);
          return { status: "cancelled", summary: result.summary ?? "ビルドをキャンセルしました。" };
        }
        if (result.kind === "success") {
          const warningIssues = result.issues.filter(
            (issue) => issue.severity === "warning"
          );
          if (warningIssues.length > 0) {
            const summaryText = warningIssues[0]?.message ?? result.summary;
            this.sendIssues?.(warningIssues.length, summaryText, "info", warningIssues);
          } else {
            this.sendIssues?.(0, result.summary, "success", []);
          }
          this.sendBuildState?.("success", result.summary);
          return {
            status: "success",
            summary: result.summary,
            issues: result.issues,
            pdfPath: result.pdfPath ?? null,
          };
        }
        if (result.kind === "failure") {
          const count = Math.max(result.issues.length, 1);
          const summaryText = result.issues[0]?.message ?? result.summary;
          this.sendBuildState?.("failed", result.summary);
          this.sendIssues?.(count, summaryText, "error", result.issues);
          return { status: "failure", summary: result.summary, issues: result.issues };
        }
        return { status: "unknown", summary: "ビルド結果が不明です。" };
      }

      if (name === "run_command") {
        return handleRunCommand(this, args);
      }

      if (name === "rename_latex_symbol") {
        const from = typeof args.from === "string" ? args.from.trim() : "";
        const to = typeof args.to === "string" ? args.to.trim() : "";
        if (!from || !to) {
          return { error: "from と to は必須です。" };
        }
        if (from === to) {
          return { error: "from と to が同じです。" };
        }
        const invalidPattern = /[\s,{}]/;
        if (invalidPattern.test(from) || invalidPattern.test(to)) {
          return { error: "from/to に空白や区切り文字は使えません。" };
        }
        const kinds = normalizeStringList(args.kinds).map((entry) => entry.toLowerCase());
        const renameLabels =
          kinds.length === 0 || kinds.includes("label") || kinds.includes("ref");
        const renameCites =
          kinds.length === 0 || kinds.includes("cite") || kinds.includes("citation");
        if (!renameLabels && !renameCites) {
          return { error: "kinds が不正です。" };
        }
        const extOverride = normalizeExtensionList(args.extensions);
        const targetExtensions =
          extOverride.size > 0
            ? extOverride
            : new Set(DEFAULT_LATEX_SYMBOL_EXTENSIONS);
        if (!renameCites && extOverride.size === 0) {
          targetExtensions.delete("bib");
        }
        let fileList = [];
        try {
          fileList = await this.workspace.listFiles();
        } catch {
          return { error: "ファイル一覧の取得に失敗しました。" };
        }

        const preparedProposals = [];
        const skipped = [];

        for (const targetPath of fileList) {
          if (!targetPath) {
            continue;
          }
          if (isBlockedPath(targetPath, policy)) {
            skipped.push({ path: targetPath, reason: "blocked" });
            continue;
          }
          const ext = path.extname(targetPath).toLowerCase().replace(/^\./, "");
          if (!targetExtensions.has(ext)) {
            continue;
          }
          if (!isTextExtension(targetPath, policy)) {
            skipped.push({ path: targetPath, reason: "non_text" });
            continue;
          }

          let originalContent = "";
          const snapshot = this.getContextSnapshot(conversationId, targetPath);
          if (snapshot && typeof snapshot.content === "string") {
            if (snapshot.truncated && snapshot.isDirty) {
              return {
                error:
                  `${targetPath} は未保存の変更があり、スナップショットが省略されています。` +
                  "保存してから再実行してください。",
              };
            }
            if (!snapshot.truncated) {
              originalContent = snapshot.content;
            }
          }

          if (!originalContent) {
            let resolved = "";
            try {
              resolved = this.workspace.resolvePath(targetPath);
            } catch {
              continue;
            }
            const stat = await fsp.stat(resolved).catch(() => null);
            if (!stat || !stat.isFile()) {
              continue;
            }
            if (stat.size > policy.maxFileBytes) {
              skipped.push({ path: targetPath, reason: "too_large" });
              continue;
            }
            const result = await readFileFromDisk(resolved);
            if (result.binary) {
              skipped.push({ path: targetPath, reason: "binary" });
              continue;
            }
            originalContent = result.content;
          }

          let updatedContent = originalContent;
          let appliedCount = 0;

          if (ext === "bib") {
            if (renameCites) {
              const result = renameBibEntryKey(updatedContent, from, to);
              updatedContent = result.text;
              appliedCount += result.count;
            }
          } else {
            const result = renameLatexInText(updatedContent, {
              from,
              to,
              renameLabels,
              renameCites,
            });
            updatedContent = result.text;
            appliedCount += result.count;
          }

          if (appliedCount === 0 || updatedContent === originalContent) {
            continue;
          }
          if (updatedContent.length > policy.maxFileBytes) {
            skipped.push({ path: targetPath, reason: "too_large" });
            continue;
          }
          preparedProposals.push({
            path: targetPath,
            originalContent,
            updatedContent,
            appliedCount,
          });
        }

        if (preparedProposals.length === 0) {
          return { error: "一致するシンボルが見つかりません。" };
        }

        const proposals = [];
        const summaryBase =
          renameLabels && renameCites
            ? "シンボルリネーム"
            : renameLabels
            ? "ラベルリネーム"
            : "引用キーリネーム";

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
            summary: `${summaryBase}: ${from} → ${to} (${prepared.appliedCount}箇所)`,
            isNewFile: false,
            conversationId,
          };
          this.proposals.set(id, proposal);
          this.sendToRenderer("agent:proposal", { proposal });
          proposals.push({
            proposalId: id,
            path: prepared.path,
            appliedCount: prepared.appliedCount,
          });
        }

        if (this.agentOptions.autoApply) {
          for (const entry of proposals) {
            await this.applyProposal(entry.proposalId);
          }
        }

        return {
          status: "proposed",
          proposalIds: proposals.map((proposal) => proposal.proposalId),
          files: proposals,
          skipped,
        };
      }

      if (name === "propose_write") {
        return handleProposeWrite(this, args, policy, conversationId);
      }

      if (name === "propose_patch") {
        return handleProposePatch(this, args, policy, conversationId);
      }

      if (name === "propose_delete") {
        return handleProposeDelete(this, args, policy, conversationId);
      }

      if (name === "propose_rename") {
        return handleProposeRename(this, args, policy, conversationId);
      }

      if (name === "propose_create_directory") {
        return handleProposeCreateDirectory(this, args, policy, conversationId);
      }

      return { error: `unknown tool: ${name}` };
    } catch (error) {
      return { error: error?.message ?? "tool error" };
    }
  }

  resolveChatModel(settings) {
    const configured = typeof settings?.model === "string" ? settings.model.trim() : "";
    return configured || DEFAULT_CHAT_MODEL;
  }

  resolveMaxOutputTokens(settings) {
    return clampNumber(
      settings?.maxOutputTokens,
      DEFAULT_MAX_OUTPUT_TOKENS,
      { min: 64, max: 4096 }
    );
  }

  estimateRequestPartSize(part) {
    if (!part || typeof part !== "object") {
      return 0;
    }
    if (typeof part.text === "string") {
      return part.text.length;
    }
    if (part.inlineData && typeof part.inlineData === "object") {
      const data = typeof part.inlineData.data === "string" ? part.inlineData.data : "";
      // base64 payloads dominate cost; approximate bytes for budgeting.
      return Math.round(data.length * 0.75);
    }
    if (part.functionCall && typeof part.functionCall === "object") {
      return JSON.stringify(part.functionCall).length;
    }
    if (part.functionResponse && typeof part.functionResponse === "object") {
      return JSON.stringify(part.functionResponse).length;
    }
    return 0;
  }

  estimateRequestMessageSize(message) {
    if (!message || typeof message !== "object") {
      return 0;
    }
    const parts = Array.isArray(message.parts) ? message.parts : [];
    return parts.reduce((sum, part) => sum + this.estimateRequestPartSize(part), 0);
  }

  sanitizeMessageForRequest(message, { includeInlineData = false } = {}) {
    if (!message || typeof message !== "object") {
      return null;
    }
    const role =
      typeof message.role === "string" && message.role.trim()
        ? message.role.trim()
        : "user";
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const normalizedParts = [];
    parts.forEach((part) => {
      if (!part || typeof part !== "object") {
        return;
      }
      if (typeof part.text === "string" && part.text.length > 0) {
        normalizedParts.push({ text: part.text });
        return;
      }
      if (part.functionCall && typeof part.functionCall === "object") {
        const callPart = { functionCall: part.functionCall };
        if (typeof part.thoughtSignature === "string" && part.thoughtSignature) {
          callPart.thoughtSignature = part.thoughtSignature;
        }
        if (part.thought === true) {
          callPart.thought = true;
        }
        normalizedParts.push(callPart);
        return;
      }
      if (part.functionResponse && typeof part.functionResponse === "object") {
        normalizedParts.push({ functionResponse: part.functionResponse });
        return;
      }
      if (includeInlineData && part.inlineData && typeof part.inlineData === "object") {
        const mimeType =
          typeof part.inlineData.mimeType === "string" ? part.inlineData.mimeType : "";
        const data = typeof part.inlineData.data === "string" ? part.inlineData.data : "";
        if (mimeType && data) {
          normalizedParts.push({ inlineData: { mimeType, data } });
        }
      }
    });
    if (normalizedParts.length === 0) {
      return null;
    }
    return { role, parts: normalizedParts };
  }

  buildRequestContents(conversation, iteration, settings) {
    const source = Array.isArray(conversation) ? conversation : [];
    if (source.length === 0) {
      return [];
    }
    const maxMessages = clampNumber(
      settings?.maxConversationMessages,
      REQUEST_HISTORY_MAX_MESSAGES,
      { min: 6, max: 80 }
    );
    const maxChars = clampNumber(
      settings?.maxConversationChars,
      REQUEST_HISTORY_MAX_CHARS,
      { min: 8_000, max: 200_000 }
    );
    const startIndex = Math.max(0, source.length - maxMessages);
    const windowed = source.slice(startIndex);
    const latestIndex = windowed.length - 1;
    const shouldKeepInlineData = iteration === 0;
    const entries = [];
    let totalChars = 0;
    windowed.forEach((message, index) => {
      const includeInlineData =
        shouldKeepInlineData && index === latestIndex && message?.role === "user";
      const normalized = this.sanitizeMessageForRequest(message, { includeInlineData });
      if (!normalized) {
        return;
      }
      const size = this.estimateRequestMessageSize(normalized);
      entries.push({ message: normalized, size });
      totalChars += size;
    });
    while (entries.length > 1 && totalChars > maxChars) {
      const removed = entries.shift();
      totalChars -= removed?.size ?? 0;
    }
    while (entries.length > 1 && entries[0]?.message?.role === "tool") {
      const removed = entries.shift();
      totalChars -= removed?.size ?? 0;
    }
    return entries.map((entry) => entry.message);
  }

  async run({ message, parts, context, conversationId = "default" }) {
    const targetConversationId =
      typeof conversationId === "string" && conversationId.trim()
        ? conversationId.trim()
        : "default";
    const rootPath = this.workspace.getRootPath();
    if (!rootPath) {
      this.sendToRenderer("agent:error", {
        message: "ワークスペースが選択されていません。",
        conversationId: targetConversationId,
      });
      this.sendStatus("error", "ワークスペースが未選択です。", targetConversationId);
      return;
    }

    this.sendStatus("running", this.buildProgressMessage("準備中"), targetConversationId);
    const settings = await this.ensureUserSettings().getAgentSettings();
    const chatModel = this.resolveChatModel(settings);
    const maxOutputTokens = this.resolveMaxOutputTokens(settings);
    const policy = this.resolveAgentPolicy(settings);
    const options = this.resolveAgentOptions(settings);
    this.contextByConversation.set(targetConversationId, context ?? {});
    const proxyUrl = (
      typeof process.env.TEX64_AI_PROXY_URL === "string"
        ? process.env.TEX64_AI_PROXY_URL.trim()
        : ""
    ).trim();
    const resolvedProxyUrl = proxyUrl || "https://tex64.vercel.app/api/ai-chat";

    const userParts = normalizeUserMessageParts(message, parts);
    if (!userParts) {
      this.sendToRenderer("agent:error", {
        message: "入力が空です。",
        conversationId: targetConversationId,
      });
      this.sendStatus("error", "入力が空です。", targetConversationId);
      return;
    }

    const conversation = this.buildConversation(targetConversationId);
    conversation.push({ role: "user", parts: userParts });

    const systemPrompt = buildSystemPrompt(context, rootPath, policy, options);
    const functionDeclarations =
      options.allowRunCommand === true
        ? AGENT_TOOL_DECLARATIONS
        : AGENT_TOOL_DECLARATIONS.filter((entry) => entry?.name !== "run_command");
    const tools = [{ functionDeclarations }];
    const generationConfig = {
      temperature: settings.temperature ?? 0.2,
      maxOutputTokens,
    };

    this.sendStatus("running", this.buildProgressMessage("文脈整理中"), targetConversationId);
    const run = this.startConversationRun(targetConversationId);

    const isCurrentRun = () => this.isRunCurrent(targetConversationId, run.token);
    const callAiChat = async (payload, signal, onDelta) => {
      if (this.requestAiChat) {
        return this.requestAiChat(
          {
            ...payload,
            stream: Boolean(onDelta),
          },
          { signal, onDelta }
        );
      }
      return requestGemini({
        proxyUrl: resolvedProxyUrl,
        model: payload.model,
        contents: payload.contents,
        systemInstruction: payload.systemInstruction,
        tools: payload.tools,
        toolConfig: payload.toolConfig,
        generationConfig: payload.generationConfig,
        signal,
        onDelta,
      });
    };

    try {
      for (let i = 0; i < options.maxIterations; i += 1) {
        if (!isCurrentRun()) {
          return;
        }
        try {
          const thinkingLabel = i === 0 ? "方針検討中" : "追加検討中";
          this.sendStatus("running", this.buildProgressMessage(thinkingLabel), targetConversationId);
          const handleDelta =
            options.stream === true
              ? (text) => {
                  if (text) {
                    this.sendToRenderer("agent:messageDelta", {
                      text,
                      conversationId: targetConversationId,
                    });
                  }
                }
              : null;
          const requestContents = this.buildRequestContents(conversation, i, settings);
          if (!Array.isArray(requestContents) || requestContents.length === 0) {
            throw new Error("送信可能な会話コンテキストがありません。");
          }
          const response = await callAiChat(
            {
              model: chatModel,
              contents: requestContents,
              systemInstruction: { parts: [{ text: systemPrompt }] },
              tools,
              toolConfig: { functionCallingConfig: { mode: "AUTO" } },
              generationConfig,
            },
            run.controller.signal,
            handleDelta
          );

          try {
            const usage = this.extractUsageMetadata(response);
            if (usage && this.apiUsageService) {
              const snapshot = await this.apiUsageService.recordUsage({
                model: resolveResponseModel(response) || "unknown",
                promptTokens: usage.promptTokenCount,
                outputTokens: usage.candidatesTokenCount,
                totalTokens: usage.totalTokenCount,
                source: "agent",
              });
              if (snapshot) {
                this.sendToRenderer("api:usage", { snapshot });
              }
            }
            const platformUsage = this.buildPlatformUsageFromQuota(
              response?.quota ?? response?.output?.quota ?? null,
              response?.plan ?? null,
              "chat"
            );
            if (platformUsage) {
              this.sendToRenderer("platform:usage", platformUsage);
            }
          } catch {
            // ignore usage recording failures
          }

          const candidate = this.normalizeModelCandidate(response);
          const parts = candidate?.parts ?? [];
          const functionCalls = parts.filter((part) => part.functionCall);
          const textParts = parts
            .map((part) => part.text)
            .filter((text) => typeof text === "string" && text.trim().length > 0);

          if (candidate) {
            conversation.push(candidate);
          }

          if (functionCalls.length > 0) {
            for (const part of functionCalls) {
              const call = part.functionCall;
              const toolName = call?.name ?? "";
              const result = await this.executeToolCall(call, targetConversationId);
              if (!isCurrentRun()) {
                return;
              }
              this.sendToRenderer("agent:tool", {
                name: toolName,
                summary: result?.error ?? "ok",
                conversationId: targetConversationId,
              });
              conversation.push({
                role: "tool",
                parts: [
                  {
                    functionResponse: {
                      name: toolName,
                      response: result,
                    },
                  },
                ],
              });
            }
            continue;
          }

          if (textParts.length > 0) {
            const text = textParts.join("\n");
            if (!isCurrentRun()) {
              return;
            }
            this.sendStatus("running", this.buildProgressMessage("回答整形中"), targetConversationId);
            this.sendToRenderer("agent:message", { text, conversationId: targetConversationId });
            this.sendStatus("idle", "待機中", targetConversationId);
            return;
          }

          if (!isCurrentRun()) {
            return;
          }
          this.sendToRenderer("agent:message", {
            text: "応答が空でした。",
            conversationId: targetConversationId,
          });
          this.sendStatus("idle", "待機中", targetConversationId);
          return;
        } catch (error) {
          if (error?.name === "AbortError") {
            if (this.isRunCurrent(targetConversationId, run.token)) {
              this.sendStatus("idle", "中断しました。", targetConversationId);
            }
            return;
          }
          this.sendToRenderer("agent:error", {
            message: error?.message ?? "AIの呼び出しに失敗しました。",
            conversationId: targetConversationId,
          });
          this.sendStatus("error", "AIエラー", targetConversationId);
          return;
        }
      }

      if (isCurrentRun()) {
        this.sendToRenderer("agent:message", {
          text: "上限回数に達したため停止しました。",
          conversationId: targetConversationId,
        });
        this.sendStatus("idle", "待機中", targetConversationId);
      }
    } finally {
      this.finishConversationRun(targetConversationId, run.token);
    }
  }
}

module.exports = {
  AgentService,
};
