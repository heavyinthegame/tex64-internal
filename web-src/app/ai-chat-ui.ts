import type { AppContext } from "./context.js";
import type {
  AgentProposal,
  AgentSettings,
  AgentStatusState,
  AgentUiState,
  IssueItem,
  IssuesStatus,
  PlatformAiAccessSnapshot,
  PlatformAuthSnapshot,
  PlatformUsageSnapshot,
  PlatformUpdateSnapshot,
} from "./types.js";
import { getIssueResolution } from "./issue-resolution.js";
import type { DiffContext } from "./diff-modal.js";
import {
  createChat as createChatState,
  ensureChat as ensureChatState,
  getChat as getChatState,
  type ChatMessage,
  type ChatState,
} from "./ai-chat-state.js";
import { createMessageElement, updateMessageElement } from "./ai-chat-message.js";
import { createProposalCard } from "./ai-chat-proposal.js";
import { TEX64_LINKS } from "./platform-links.js";

type AiChatDeps = {
  postToNative: (payload: { type: string; [key: string]: unknown }, silent?: boolean) => boolean;
  getActiveFilePath: () => string | null;
  getActiveFileSnapshot?: () => { path: string; content: string; isDirty: boolean } | null;
  getActiveCursorPosition?: () => { lineNumber: number; column: number } | null;
  getActiveSelectionSnapshot?: () => {
    path: string;
    text: string;
    isDirty: boolean;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  } | null;
  getOpenFileSnapshots?: (options?: { maxFiles?: number; maxChars?: number }) => {
    files: Array<{ path: string; isDirty: boolean; isActive: boolean }>;
    snapshots: Array<{ path: string; content: string; isDirty: boolean; truncated: boolean; contentLength: number }>;
  };
  getRecentIssuesSnapshot?: () => {
    count: number; summary: string; status: IssuesStatus; issues: IssueItem[]; updatedAt: number;
  } | null;
  showDiffModal?: (original: string, modified: string, lineOffset?: number, options?: { title?: string; fileName?: string; submitLabel?: string }) => void;
  setDiffContext?: (context: DiffContext) => void;
};

export type AiChatApi = {
  handleSettings: (settings: AgentSettings) => void;
  handleState: (state: AgentUiState) => void;
  handleStatus: (state: AgentStatusState, message?: string, conversationId?: string) => void;
  handleMessage: (text: string, conversationId?: string) => void;
  handleMessageDelta: (text: string, conversationId?: string) => void;
  handleTool: (payload: { name: string; summary?: string; conversationId?: string }) => void;
  handleProposal: (proposal: AgentProposal) => void;
  handleApplyResult: (payload: { proposalId: string; ok: boolean; error?: string; conflict?: boolean }) => void;
  handleUndoResult: (payload: { ok: boolean; message?: string; path?: string; conversationId?: string }) => void;
  handleError: (message: string, conversationId?: string) => void;
  refreshContextBar: () => void;
  handlePlatformAuth: (payload: {
    auth: PlatformAuthSnapshot;
    error?: { code?: string; message?: string };
  }) => void;
  handlePlatformAiAccess: (payload: { source?: string; access: PlatformAiAccessSnapshot }) => void;
  handlePlatformUsage: (payload: { source?: string; usage: PlatformUsageSnapshot }) => void;
  handlePlatformUpdate: (payload: {
    source?: string;
    update: PlatformUpdateSnapshot | null;
    error?: { code?: string; message?: string };
  }) => void;
  applyPendingFromDiffModal: () => void;
  clearPending: () => void;
};

const MAX_ACTIVE_FILE_CONTEXT_CHARS = 10000;
const MAX_OPEN_FILE_CONTEXT_CHARS = 8000;
const MAX_SELECTION_CONTEXT_CHARS = 4000;
const MAX_OPEN_FILE_SNAPSHOTS = 4;
const MAX_OPEN_FILES_METADATA = 12;
const MAX_RECENT_ISSUES = 5;
const AUTONOMOUS_LOOP_LIMIT = 8;
const AUTONOMOUS_CONTINUE_DELAY_MS = 120;
const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024;
const USAGE_REFRESH_DELAY_MS = 300;

type AiImageAttachment = {
  mimeType: string;
  data: string;
  name: string;
  size: number;
};

type AiRequestPart = {
  text?: string;
  inlineData?: { mimeType: string; data: string };
};

type PendingAiRequest = {
  message: string;
  parts?: AiRequestPart[];
  contextPayload?: Record<string, unknown>;
};

export const initAiChatUi = (context: AppContext, deps: AiChatDeps): AiChatApi => {
  const {
    aiChatLog, aiChat, aiProposals, aiAttachments, aiAttach, aiAttachInput, aiInput, aiSend, aiStatus, aiChatNew,
    aiTopbarTitle, aiUsageMeter, aiUsageMeterText, aiHistoryToggle, aiHistory, aiHistoryList, aiAuthTopbar,
    aiContextBar, aiStop,
  } = context.dom;

  const chats: ChatState[] = [];
  const chatIndex = new Map<string, ChatState>();
  const proposalIndex = new Map<string, string>();
  let activeChatId: string | null = null;
  const runningConversations = new Set<string>();
  const resumableConversations = new Set<string>();
  let agentSettings: AgentSettings | null = null;
  const continueAfterApply = new Set<string>();
  const streamingMessages = new Map<string, { message: ChatMessage; element: HTMLElement | null }>();
  const thinkingMessages = new Map<string, { text: string; element: HTMLElement | null }>();
  const pendingAgentRequests = new Map<string, PendingAiRequest>();
  let pendingAttachments: AiImageAttachment[] = [];
  let platformAuth: PlatformAuthSnapshot | null = null;
  let platformAiAccess: PlatformAiAccessSnapshot | null = null;
  let platformUsage: PlatformUsageSnapshot | null = null;
  let platformError: { code?: string; message?: string } | null = null;
  let usageRefreshTimer: number | null = null;
  let requestedInitialUsage = false;

  const makeChatId = () => `chat-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const requestPlatformState = () => {
    deps.postToNative({ type: "platform:state:get" }, true);
  };
  const requestAiAccessCheck = (force = false) => {
    deps.postToNative({ type: "feature:check", names: ["ai"], force }, true);
  };
  const requestPlatformUsage = (force = false) => {
    deps.postToNative({ type: "platform:usage:get", force }, true);
  };
  const normalizeUsageSnapshot = (usage?: PlatformUsageSnapshot | null): PlatformUsageSnapshot | null => {
    if (!usage || typeof usage !== "object") return null;
    return usage;
  };
  const scheduleUsageRefresh = (force = true) => {
    if (usageRefreshTimer !== null) {
      window.clearTimeout(usageRefreshTimer);
      usageRefreshTimer = null;
    }
    usageRefreshTimer = window.setTimeout(() => {
      usageRefreshTimer = null;
      requestPlatformUsage(force);
    }, USAGE_REFRESH_DELAY_MS);
  };
  const isAiBlocked = () =>
    Boolean(platformAiAccess && platformAiAccess.allowed === false);
  const needsLogin = () =>
    Boolean(
      !platformAuth?.authenticated ||
        (platformAiAccess &&
          (!platformAiAccess.authenticated ||
            platformAiAccess.reason === "AUTH_REQUIRED" ||
            platformAiAccess.reason === "TOKEN_EXPIRED"))
    );
  type StatusAction = "login" | "pricing";

  const withUtilityActions = (actions?: Array<{ action: StatusAction; label: string }>) => {
    return Array.isArray(actions) ? [...actions] : [];
  };
  const normalizeAuthError = (error?: { code?: string; message?: string } | null) => {
    if (!error || typeof error !== "object") {
      return null;
    }
    const code = typeof error.code === "string" ? error.code : "";
    const fallbackMessage =
      typeof error.message === "string" && error.message.trim()
        ? error.message.trim()
        : "ログインに失敗しました。";
    switch (code) {
      case "AUTH_START_INVALID_URL":
        return {
          code,
          message: "ログインページを開けませんでした。",
        };
      case "AUTH_BROWSER_UNAVAILABLE":
        return {
          code,
          message: "ブラウザを起動できませんでした。",
        };
      case "AUTH_BROWSER_OPEN_FAILED":
        return {
          code,
          message: "ログインページを開けませんでした。",
        };
      case "OAUTH_PENDING_EXPIRED":
        return {
          code,
          message: "ログインがタイムアウトしました。",
        };
      case "OAUTH_NO_PENDING":
        return {
          code,
          message: "ログイン状態を確認できませんでした。",
        };
      case "OAUTH_STATE_MISMATCH":
      case "OAUTH_CALLBACK_MISMATCH":
      case "OAUTH_INVALID_CALLBACK":
        return {
          code,
          message: "ログイン結果の検証に失敗しました。",
        };
      case "OAUTH_DENIED":
        return {
          code,
          message: "Googleログインがキャンセルされました。",
        };
      default:
        return { code, message: fallbackMessage };
    }
  };

  const tokenNumberFormat = new Intl.NumberFormat("ja-JP");
  const formatTokenCount = (value: number) =>
    tokenNumberFormat.format(Math.max(0, Math.round(value)));
  const formatTokenCompact = (value: number) => {
    const v = Math.max(0, Math.round(value));
    if (v < 10_000) {
      return formatTokenCount(v);
    }
    if (v < 1_000_000) {
      const k = v / 1000;
      if (k < 100) {
        return `${k.toFixed(1).replace(/\\.0$/, "")}k`;
      }
      return `${Math.floor(k)}k`;
    }
    const m = v / 1_000_000;
    if (m < 100) {
      return `${m.toFixed(1).replace(/\\.0$/, "")}M`;
    }
    return `${Math.floor(m)}M`;
  };

  const renderStatus = (
    headline: string,
    detail?: string,
    actions?: Array<{ action: StatusAction; label: string }>
  ) => {
    if (!(aiStatus instanceof HTMLElement)) {
      return;
    }
    aiStatus.replaceChildren();
    aiStatus.classList.remove("ai-status--actions-only");
    aiStatus.classList.remove("ai-status--error");
    aiStatus.classList.remove("ai-status--warn");
    aiStatus.classList.remove("ai-status--ok");
    const hasActions = Array.isArray(actions) && actions.length > 0;
    if (!headline && !detail && !hasActions) {
      aiStatus.style.display = "none";
      return;
    }
    aiStatus.style.display = "block";
    if (!headline && !detail && hasActions) {
      aiStatus.classList.add("ai-status--actions-only");
    }
    if (headline) {
      const head = document.createElement("div");
      head.className = "ai-status-line";
      head.textContent = headline;
      aiStatus.appendChild(head);
    }
    if (detail) {
      const body = document.createElement("div");
      body.className = "ai-status-detail";
      body.textContent = detail;
      aiStatus.appendChild(body);
    }
    if (Array.isArray(actions) && actions.length > 0) {
      const actionWrap = document.createElement("div");
      actionWrap.className = "ai-status-actions";
      actions.forEach((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ai-status-action";
        button.dataset.aiStatusAction = item.action;
        button.textContent = item.label;
        actionWrap.appendChild(button);
      });
      aiStatus.appendChild(actionWrap);
    }
  };

  const updateTopbarAuthButton = () => {
    if (!(aiAuthTopbar instanceof HTMLButtonElement)) {
      return;
    }
    const authenticated = Boolean(platformAuth?.authenticated);
    aiAuthTopbar.classList.toggle("is-hidden", authenticated);
    aiAuthTopbar.textContent = "ログイン";
    aiAuthTopbar.disabled = false;
  };

  const updateUsageMeter = () => {
    if (!(aiUsageMeter instanceof HTMLElement)) {
      return;
    }
    const quota = platformUsage?.summary ?? platformAiAccess?.quota ?? null;
    const limitTokens =
      typeof quota?.limitTokens === "number" && Number.isFinite(quota.limitTokens)
        ? Math.max(0, Math.round(quota.limitTokens))
        : 0;
    const usedTokens =
      typeof quota?.usedTokens === "number" && Number.isFinite(quota.usedTokens)
        ? Math.max(0, Math.round(quota.usedTokens))
        : 0;
    if (!limitTokens) {
      aiUsageMeter.classList.add("is-hidden");
      aiUsageMeter.classList.remove("is-warn");
      aiUsageMeter.classList.remove("is-critical");
      aiUsageMeter.style.removeProperty("--ai-usage-pct");
      aiUsageMeter.removeAttribute("title");
      aiUsageMeter.setAttribute("aria-label", "AI使用量");
      if (aiUsageMeterText instanceof HTMLElement) {
        aiUsageMeterText.textContent = "-";
      }
      return;
    }
    const pct = Math.max(0, Math.min(100, (usedTokens / limitTokens) * 100));
    aiUsageMeter.classList.remove("is-hidden");
    aiUsageMeter.classList.toggle("is-warn", pct >= 80 && pct < 95);
    aiUsageMeter.classList.toggle("is-critical", pct >= 95);
    aiUsageMeter.style.setProperty("--ai-usage-pct", pct.toFixed(2));
    const label = `${formatTokenCount(usedTokens)} / ${formatTokenCount(limitTokens)} トークン`;
    aiUsageMeter.setAttribute("aria-label", `AI使用量: ${label}`);
    aiUsageMeter.title = label;
    if (aiUsageMeterText instanceof HTMLElement) {
      aiUsageMeterText.textContent = formatTokenCompact(usedTokens);
    }
  };

  const openExternalUrl = (url: string) => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) {
      return;
    }
    deps.postToNative({ type: "shell:openExternal", url: url.trim() }, true);
  };

  const resolvePricingUrl = () => {
    const fromAccess =
      typeof platformAiAccess?.pricingUrl === "string" && platformAiAccess.pricingUrl.trim()
        ? platformAiAccess.pricingUrl.trim()
        : "";
    if (fromAccess) {
      return fromAccess;
    }
    const fromAuth =
      typeof platformAuth?.pricingUrl === "string" && platformAuth.pricingUrl.trim()
        ? platformAuth.pricingUrl.trim()
        : "";
    if (fromAuth) {
      return fromAuth;
    }
    return TEX64_LINKS.pricing;
  };

  // ── Helpers ───────────────────────────────────────────
  const getChat = (chatId?: string | null) => getChatState(chatIndex, activeChatId, chatId);

  const resolveChatTitle = (chatId: string) => {
    if (chatId === "search-rename") return "シンボルリネーム";
    return `Chat ${chats.length + 1}`;
  };

  const ensureChat = (chatId?: string | null) =>
    ensureChatState({
      chatId,
      activeChatId,
      chats,
      chatIndex,
      defaultAutonomous: true,
      defaultAutoLoopBudget: AUTONOMOUS_LOOP_LIMIT,
      resolveChatTitle,
    });

  const createChat = () => {
    const chat = createChatState({
      chats,
      chatIndex,
      makeChatId,
      resolveChatTitle,
      defaultAutonomous: true,
      defaultAutoLoopBudget: AUTONOMOUS_LOOP_LIMIT,
    });
    return chat;
  };

  const setChatTitle = (chat: ChatState) => {
    if (aiTopbarTitle instanceof HTMLElement) {
      aiTopbarTitle.textContent = chat.title;
    }
  };

  const switchActiveChat = (chatId: string) => {
    const chat = getChat(chatId);
    if (!chat) return;
    activeChatId = chat.id;
    setChatTitle(chat);
    clearPendingAttachments();
    renderChatContent();
    updateStatusDisplay();
    updateSendState();
    renderHistoryList();
  };

  const resetToNewChatState = () => {
    activeChatId = null;
    clearPendingAttachments();
    if (aiTopbarTitle instanceof HTMLElement) {
      aiTopbarTitle.textContent = "新規チャット";
    }
    const chatLog = getChatLog();
    if (chatLog) {
      chatLog.replaceChildren();
    }
    const proposals = getProposalsContainer();
    if (proposals) {
      proposals.replaceChildren();
      proposals.classList.add("is-hidden");
    }
    updateStatusDisplay();
    updateSendState();
    renderHistoryList();
  };

  // ── History ──────────────────────────────────────────
  let historyOpen = false;
  const toggleHistory = () => {
    historyOpen = !historyOpen;
    if (aiHistory instanceof HTMLElement) aiHistory.classList.toggle("is-open", historyOpen);
    if (historyOpen) renderHistoryList();
  };
  const closeHistory = () => {
    historyOpen = false;
    if (aiHistory instanceof HTMLElement) aiHistory.classList.remove("is-open");
  };

  const renderHistoryList = () => {
    if (!(aiHistoryList instanceof HTMLElement)) return;
    aiHistoryList.replaceChildren();
    if (chats.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ai-history-empty";
      empty.textContent = "履歴なし";
      aiHistoryList.appendChild(empty);
      return;
    }
    for (let i = chats.length - 1; i >= 0; i--) {
      const chat = chats[i];
      const item = document.createElement("button");
      item.className = "ai-history-item";
      item.type = "button";
      if (chat.id === activeChatId) item.classList.add("is-active");
      if (runningConversations.has(chat.id)) item.classList.add("is-running");
      const suffixParts: string[] = [];
      if (runningConversations.has(chat.id)) suffixParts.push("実行中");
      if (chat.proposals.size > 0) suffixParts.push(`提案 ${chat.proposals.size}`);
      const suffix = suffixParts.length > 0 ? ` (${suffixParts.join(" / ")})` : "";
      item.textContent = `${chat.title}${suffix}`;
      item.addEventListener("click", () => {
        switchActiveChat(chat.id);
        closeHistory();
      });
      aiHistoryList.appendChild(item);
    }
  };

  if (aiHistoryToggle instanceof HTMLButtonElement) {
    aiHistoryToggle.addEventListener("click", toggleHistory);
  }
  if (aiAuthTopbar instanceof HTMLButtonElement) {
    aiAuthTopbar.addEventListener("click", () => {
      deps.postToNative({ type: "auth:google:start" });
    });
  }

  // ── Context Bar ───────────────────────────────────────
  const updateContextBar = () => {
    if (!(aiContextBar instanceof HTMLElement)) return;
    const filePath = deps.getActiveFilePath();
    aiContextBar.textContent = "";
    const chips: string[] = [];
    if (filePath) {
      chips.push(filePath.split("/").pop() || filePath);
    }
    const selection = deps.getActiveSelectionSnapshot?.() ?? null;
    if (selection) {
      chips.push(
        `selection ${selection.startLine}:${selection.startColumn}-${selection.endLine}:${selection.endColumn}`
      );
    } else {
      const cursor = deps.getActiveCursorPosition?.() ?? null;
      if (cursor) {
        chips.push(`cursor ${cursor.lineNumber}:${cursor.column}`);
      }
    }
    chips.forEach((label) => {
      const chip = document.createElement("span");
      chip.className = "ai-context-chip";
      chip.textContent = label;
      aiContextBar.appendChild(chip);
    });
    aiContextBar.style.display = chips.length > 0 ? "flex" : "none";
  };

  const renderAttachmentBar = () => {
    if (!(aiAttachments instanceof HTMLElement)) return;
    aiAttachments.replaceChildren();
    if (pendingAttachments.length === 0) {
      aiAttachments.classList.add("is-empty");
      return;
    }
    aiAttachments.classList.remove("is-empty");
    pendingAttachments.forEach((attachment, index) => {
      const chip = document.createElement("div");
      chip.className = "ai-attachment-chip";

      const name = document.createElement("span");
      name.className = "ai-attachment-name";
      name.textContent = attachment.name || `image-${index + 1}`;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ai-attachment-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", "添付を削除");
      remove.addEventListener("click", () => {
        pendingAttachments = pendingAttachments.filter((_, targetIndex) => targetIndex !== index);
        renderAttachmentBar();
      });

      chip.append(name, remove);
      aiAttachments.appendChild(chip);
    });
  };

  const clearPendingAttachments = (resetInput = true) => {
    pendingAttachments = [];
    renderAttachmentBar();
    if (resetInput && aiAttachInput instanceof HTMLInputElement) {
      aiAttachInput.value = "";
    }
  };

  const parseBase64FromDataUrl = (dataUrl: string) => {
    const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
    if (!match) return null;
    return { mimeType: match[1], data: match[2] };
  };

  const readImageAttachment = async (file: File): Promise<AiImageAttachment | null> =>
    new Promise((resolve) => {
      if (!file || !file.type.startsWith("image/")) {
        resolve(null);
        return;
      }
      if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => resolve(null);
      reader.onload = () => {
        const value = typeof reader.result === "string" ? reader.result : "";
        const parsed = parseBase64FromDataUrl(value);
        if (!parsed || !parsed.data) {
          resolve(null);
          return;
        }
        resolve({
          mimeType: parsed.mimeType || file.type || "image/png",
          data: parsed.data,
          name: file.name || "image",
          size: file.size,
        });
      };
      reader.readAsDataURL(file);
    });

  const addImageFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    let rejectedNonImage = 0;
    let rejectedTooLarge = 0;
    let rejectedByCount = 0;
    let rejectedByTotal = 0;
    let rejectedUnreadable = 0;
    let totalBytes = pendingAttachments.reduce((sum, item) => sum + item.size, 0);
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        rejectedNonImage += 1;
        continue;
      }
      if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
        rejectedTooLarge += 1;
        continue;
      }
      if (pendingAttachments.length >= MAX_IMAGE_ATTACHMENTS) {
        rejectedByCount += 1;
        continue;
      }
      if (totalBytes + file.size > MAX_IMAGE_ATTACHMENT_TOTAL_BYTES) {
        rejectedByTotal += 1;
        continue;
      }
      const attachment = await readImageAttachment(file);
      if (!attachment) {
        rejectedUnreadable += 1;
        continue;
      }
      pendingAttachments.push(attachment);
      totalBytes += attachment.size;
    }
    renderAttachmentBar();
    const notices: string[] = [];
    if (rejectedTooLarge > 0) {
      notices.push(`5MBを超える画像は添付できません（${rejectedTooLarge}件）。`);
    }
    if (rejectedByTotal > 0) {
      notices.push("添付画像の合計サイズは8MBまでです。");
    }
    if (rejectedByCount > 0) {
      notices.push("画像添付は最大4件までです。");
    }
    if (rejectedNonImage > 0) {
      notices.push(`画像ファイルのみ添付できます（${rejectedNonImage}件を除外）。`);
    }
    if (rejectedUnreadable > 0) {
      notices.push(`画像の読み込みに失敗したため添付できませんでした（${rejectedUnreadable}件）。`);
    }
    if (notices.length > 0) {
      const chat = getChat(activeChatId);
      if (chat) {
        appendMessage({ role: "system", text: notices.join("\n") }, chat.id);
      } else if (aiStatus instanceof HTMLElement) {
        aiStatus.textContent = notices.join(" ");
      }
    }
  };

  // ── Auto-grow ─────────────────────────────────────────
  const autoGrow = () => {
    if (!(aiInput instanceof HTMLTextAreaElement)) return;
    aiInput.style.height = "auto";
    aiInput.style.height = Math.min(aiInput.scrollHeight, 200) + "px";
  };
  if (aiInput instanceof HTMLTextAreaElement) aiInput.addEventListener("input", autoGrow);

  // ── UI State ──────────────────────────────────────────
  const updateSendState = () => {
    const active = getChat(activeChatId);
    const isRunning = Boolean(active && runningConversations.has(active.id));
    const canResume = Boolean(active && !isRunning && resumableConversations.has(active.id));
    if (aiSend instanceof HTMLButtonElement) {
      aiSend.disabled = isRunning;
      aiSend.classList.remove("is-loading");
      aiSend.style.display = isRunning ? "none" : "flex";
    }
    if (aiInput instanceof HTMLTextAreaElement) aiInput.disabled = isRunning;
    if (aiAttach instanceof HTMLButtonElement) aiAttach.disabled = isRunning;
    if (aiAttachInput instanceof HTMLInputElement) aiAttachInput.disabled = isRunning;
    if (aiStop instanceof HTMLButtonElement) {
      aiStop.disabled = false;
      aiStop.textContent = isRunning ? "停止" : "再開";
      aiStop.style.display = isRunning || canResume ? "flex" : "none";
    }
  };

  const updateStatusDisplay = () => {
    updateTopbarAuthButton();
    updateUsageMeter();
    const pricingUrl = resolvePricingUrl();
    const quota = platformUsage?.summary ?? platformAiAccess?.quota ?? null;
    const periodEnd = typeof platformAiAccess?.periodEnd === "string" ? platformAiAccess.periodEnd : null;
    const periodEndLabel =
      periodEnd && Number.isFinite(Date.parse(periodEnd))
        ? new Date(periodEnd).toLocaleDateString("ja-JP")
        : "";
    if (platformError?.message) {
      renderStatus(
        "ログインに失敗しました。",
        platformError.message,
        withUtilityActions([{ action: "login", label: "Googleでログイン" }])
      );
      return;
    }
    if (platformAuth?.pending) {
      renderStatus("Googleログインを処理中です。");
      return;
    }
    if (needsLogin()) {
      renderStatus(
        "AI機能を使うにはGoogleログインが必要です。",
        "",
        withUtilityActions([{ action: "login", label: "Googleでログイン" }])
      );
      return;
    }
    if (isAiBlocked()) {
      const reason =
        typeof platformAiAccess?.reason === "string" && platformAiAccess.reason
          ? platformAiAccess.reason
          : typeof platformUsage?.errorCode === "string" && platformUsage.errorCode
          ? platformUsage.errorCode
          : "";
      if (reason === "QUOTA_EXCEEDED") {
        const detailPieces: string[] = [];
        if (
          quota &&
          typeof quota.usedTokens === "number" &&
          typeof quota.limitTokens === "number"
        ) {
          detailPieces.push(
            `${formatTokenCount(quota.usedTokens)} / ${formatTokenCount(quota.limitTokens)} トークン`
          );
        }
        if (periodEndLabel) {
          detailPieces.push(`次回リセット: ${periodEndLabel}`);
        }
        renderStatus(
          "今月のトークン上限に達しました。",
          detailPieces.join(" / "),
          withUtilityActions([{ action: "pricing", label: "プランを見る" }])
        );
        return;
      }
      if (
        reason === "PLAN_REQUIRED" ||
        reason === "FEATURE_NOT_ENABLED" ||
        reason === "PAYMENT_PAST_DUE"
      ) {
        renderStatus(
          "現在の契約状態ではAI機能を利用できません。",
          "プラン・契約状態を確認してください。",
          withUtilityActions([{ action: "pricing", label: "プランを見る" }])
        );
        return;
      }
      const fallbackMessage =
        typeof platformAiAccess?.message === "string" && platformAiAccess.message.trim()
          ? platformAiAccess.message.trim()
          : typeof platformUsage?.message === "string" && platformUsage.message.trim()
          ? platformUsage.message.trim()
          : "AI機能を利用できません。";
      renderStatus(
        fallbackMessage,
        "",
        withUtilityActions([{ action: "pricing", label: "プランを見る" }])
      );
      return;
    }
    if (!pricingUrl) {
      renderStatus("", "", withUtilityActions());
      return;
    }
    renderStatus("", "", withUtilityActions());
  };

  // ── Context Builders ──────────────────────────────────
  const resolveMaxChars = (value: number | undefined, fallback: number) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return value <= 0 ? Number.POSITIVE_INFINITY : value;
  };

  const buildActiveFileContext = () => {
    const maxChars = resolveMaxChars(agentSettings?.openFileMaxChars, MAX_ACTIVE_FILE_CONTEXT_CHARS);
    const snapshot = deps.getActiveFileSnapshot?.() ?? null;
    const fallbackPath = deps.getActiveFilePath();
    if (!snapshot) return fallbackPath ? { activeFilePath: fallbackPath } : {};
    let content = snapshot.content;
    let truncated = false;
    if (Number.isFinite(maxChars) && content.length > maxChars) { content = content.slice(0, maxChars); truncated = true; }
    return { activeFilePath: snapshot.path, activeFileContent: content, activeFileIsDirty: snapshot.isDirty, activeFileContentTruncated: truncated, activeFileContentLength: snapshot.content.length };
  };

  const buildSelectionContext = () => {
    const maxChars = resolveMaxChars(agentSettings?.openFileMaxChars, MAX_SELECTION_CONTEXT_CHARS);
    const selection = deps.getActiveSelectionSnapshot?.() ?? null;
    if (!selection || !selection.text) {
      return {};
    }
    let text = selection.text;
    let truncated = false;
    if (Number.isFinite(maxChars) && text.length > maxChars) {
      text = text.slice(0, maxChars);
      truncated = true;
    }
    return {
      activeSelectionRequested: true,
      activeSelection: {
        path: selection.path,
        text,
        isDirty: selection.isDirty,
        startLine: selection.startLine,
        startColumn: selection.startColumn,
        endLine: selection.endLine,
        endColumn: selection.endColumn,
        truncated,
        textLength: selection.text.length,
      },
    };
  };

  const buildOpenFilesContext = () => {
    const maxChars = resolveMaxChars(agentSettings?.openFileMaxChars, MAX_OPEN_FILE_CONTEXT_CHARS);
    const s = deps.getOpenFileSnapshots?.({ maxFiles: MAX_OPEN_FILE_SNAPSHOTS, maxChars });
    if (!s) {
      return {};
    }
    const files =
      s.files.length > MAX_OPEN_FILES_METADATA
        ? s.files.slice(0, MAX_OPEN_FILES_METADATA)
        : s.files;
    return { openFiles: files, openFileSnapshots: s.snapshots };
  };

  const buildIssuesContext = () => {
    const snapshot = deps.getRecentIssuesSnapshot?.();
    if (!snapshot || !Array.isArray(snapshot.issues) || snapshot.issues.length === 0) return {};
    const items = snapshot.issues.slice(0, MAX_RECENT_ISSUES).map((issue) => ({
      severity: issue.severity, message: issue.message, path: issue.path, line: issue.line, column: issue.column, action: issue.action, resolution: getIssueResolution(issue),
    }));
    return { recentIssueSummary: snapshot.summary, recentIssueStatus: snapshot.status, recentIssuesUpdatedAt: new Date(snapshot.updatedAt).toISOString(), recentIssues: items };
  };

  const buildContextPayload = () => {
    const payload = {
      ...buildActiveFileContext(),
      ...buildSelectionContext(),
      ...buildOpenFilesContext(),
      ...buildIssuesContext(),
      contextControls: {
        includeSelection: true,
        includeOpenFiles: true,
        includeIssues: true,
      },
    } as Record<string, unknown>;
    return payload;
  };

  // ── Chat Log ──────────────────────────────────────────
  const getChatLog = () => (aiChatLog instanceof HTMLElement ? aiChatLog : null);
  const getProposalsContainer = () => (aiProposals instanceof HTMLElement ? aiProposals : null);

  const ensureProposalsEmbedded = () => {
    const chatLog = getChatLog();
    const proposals = getProposalsContainer();
    if (!chatLog || !proposals) return null;
    if (proposals.parentElement !== chatLog) chatLog.appendChild(proposals);
    else if (chatLog.lastElementChild !== proposals) chatLog.appendChild(proposals);
    return proposals;
  };

  const appendToChatLog = (element: HTMLElement) => {
    const chatLog = getChatLog();
    if (!chatLog) return;
    chatLog.querySelector(".ai-empty-state")?.remove();
    const proposals = getProposalsContainer();
    if (proposals && proposals.parentElement === chatLog) chatLog.insertBefore(element, proposals);
    else chatLog.appendChild(element);
  };

  const scrollToBottom = () => { if (aiChat instanceof HTMLElement) aiChat.scrollTop = aiChat.scrollHeight; };

  // ── Streaming ─────────────────────────────────────────
  const ensureStreamingMessage = (chatId: string) => {
    const existing = streamingMessages.get(chatId);
    if (existing) return existing;
    const chat = ensureChat(chatId);
    if (!chat) return null;
    const message: ChatMessage = { role: "assistant", text: "" };
    chat.messages.push(message);
    let element: HTMLElement | null = null;
    if (chat.id === activeChatId && aiChatLog instanceof HTMLElement) {
      element = createMessageElement(message);
      appendToChatLog(element);
      scrollToBottom();
    }
    const entry = { message, element };
    streamingMessages.set(chatId, entry);
    return entry;
  };

  const finalizeStreamingMessage = (chatId: string, text: string) => {
    const entry = streamingMessages.get(chatId);
    if (!entry) return false;
    entry.message.text = text;
    updateMessageElement(entry.element, text);
    streamingMessages.delete(chatId);
    return true;
  };

  const appendMessage = (message: ChatMessage, chatId?: string) => {
    const chat = ensureChat(chatId);
    if (!chat) return;
    chat.messages.push(message);
    if (chat.id !== activeChatId || !(aiChatLog instanceof HTMLElement)) return;
    appendToChatLog(createMessageElement(message));
    scrollToBottom();
  };

  const normalizeThinkingText = (text?: string) => {
    const raw = typeof text === "string" ? text.trim() : "";
    if (!raw) return "思考中...";
    if (raw.startsWith("思考中")) return raw;
    return `思考中: ${raw}`;
  };

  const upsertThinkingMessage = (chatId?: string | null, text?: string) => {
    const chat = ensureChat(chatId);
    if (!chat) return;
    const normalized = normalizeThinkingText(text);
    let entry = thinkingMessages.get(chat.id);
    if (!entry) {
      entry = { text: normalized, element: null };
      thinkingMessages.set(chat.id, entry);
    } else {
      entry.text = normalized;
    }
    if (chat.id !== activeChatId || !(aiChatLog instanceof HTMLElement)) return;
    if (!entry.element) {
      entry.element = createMessageElement({ role: "assistant", text: normalized });
      entry.element.classList.add("ai-thinking-message");
      appendToChatLog(entry.element);
      scrollToBottom();
      return;
    }
    updateMessageElement(entry.element, normalized);
  };

  const clearThinkingMessage = (chatId?: string | null) => {
    const chat = getChat(chatId);
    if (!chat) return;
    const entry = thinkingMessages.get(chat.id);
    if (!entry) return;
    entry.element?.remove();
    thinkingMessages.delete(chat.id);
  };

  const disableAutonomous = (chatId?: string | null) => {
    const chat = getChat(chatId);
    if (!chat) return;
    chat.autonomous = false;
    chat.autoLoopBudget = 0;
  };

  const enableAutonomous = (chat: ChatState) => {
    chat.autonomous = true;
    chat.autoLoopBudget = AUTONOMOUS_LOOP_LIMIT;
  };

  // ── Proposals ─────────────────────────────────────────
  let pendingAiProposalId: string | null = null;
  const dismissProposal = (proposalId: string) => {
    const chatId = proposalIndex.get(proposalId);
    const chat = getChat(chatId);
    if (!chat) return;
    chat.proposals.delete(proposalId);
    proposalIndex.delete(proposalId);
    continueAfterApply.delete(proposalId);
    if (chat.id === activeChatId) {
      const proposals = getProposalsContainer();
      proposals?.querySelector(`[data-proposal-id="${proposalId}"]`)?.remove();
      if (proposals && chat.proposals.size === 0) {
        proposals.classList.add("is-hidden");
      }
    }
    renderHistoryList();
  };
  const buildProposalCard = (proposal: AgentProposal) =>
    createProposalCard(proposal, {
      postToNative: deps.postToNative,
      continueAfterApply,
      dismissProposal,
      setPendingProposalId: (v) => { pendingAiProposalId = v; },
      showDiffModal: deps.showDiffModal,
      setDiffContext: deps.setDiffContext,
    });

  // ── Render ────────────────────────────────────────────
  const renderChatContent = () => {
    const chat = getChat(activeChatId);
    if (!chat) return;
    const chatLog = getChatLog();
    thinkingMessages.forEach((entry) => {
      entry.element = null;
    });
    chatLog?.replaceChildren();
    chat.messages.forEach((msg) => { if (chatLog) chatLog.appendChild(createMessageElement(msg)); });
    const proposals = ensureProposalsEmbedded();
    if (proposals) {
      proposals.replaceChildren();
      proposals.classList.toggle("is-hidden", chat.proposals.size === 0);
      chat.proposals.forEach((p) => proposals.appendChild(buildProposalCard(p)));
    }
    const se = streamingMessages.get(chat.id);
    const last = chatLog?.querySelectorAll(".ai-message");
    if (se && last && last.length > 0) se.element = last[last.length - 1] as HTMLElement;
    const thinking = thinkingMessages.get(chat.id);
    if (thinking) {
      const element = createMessageElement({ role: "assistant", text: thinking.text });
      element.classList.add("ai-thinking-message");
      thinking.element = element;
      appendToChatLog(element);
    }
    scrollToBottom();
  };

  const restoreDraftFromPending = (chatId: string, request: PendingAiRequest | null) => {
    if (!request || chatId !== activeChatId) {
      return;
    }
    if (!(aiInput instanceof HTMLTextAreaElement)) {
      return;
    }
    if ((aiInput.value ?? "").trim().length > 0) {
      return;
    }
    const restored = typeof request.message === "string" ? request.message : "";
    if (!restored.trim()) {
      return;
    }
    aiInput.value = restored;
    autoGrow();
    aiInput.focus();
    appendMessage(
      {
        role: "system",
        text: "送信できなかった入力を復元しました。内容を確認して再送信してください。",
      },
      chatId
    );
  };

  // ── Agent Communication ───────────────────────────────
  const requestAgentRun = (
    chatId: string,
    message: string,
    parts?: AiRequestPart[],
    contextPayload?: Record<string, unknown>
  ) => {
    if (isAiBlocked() || needsLogin()) {
      requestAiAccessCheck(true);
      requestPlatformUsage(true);
      updateStatusDisplay();
      return false;
    }
    const hasText = typeof message === "string" && message.trim().length > 0;
    const hasParts = Array.isArray(parts) && parts.length > 0;
    if (!hasText && !hasParts) return false;
    const chat = ensureChat(chatId);
    if (!chat) return false;
    if (runningConversations.has(chat.id)) return false;
    const contextToSend = contextPayload ?? buildContextPayload();
    pendingAgentRequests.set(chat.id, {
      message,
      parts: Array.isArray(parts) ? parts : undefined,
      contextPayload: contextToSend,
    });
    chat.statusMessage = "思考中...";
    runningConversations.add(chat.id);
    upsertThinkingMessage(chat.id, chat.statusMessage);
    renderHistoryList();
    updateSendState();
    updateStatusDisplay();
    const posted = deps.postToNative({
      type: "agent:run", message, parts, conversationId: chat.id,
      context: contextToSend,
    });
    if (!posted) {
      runningConversations.delete(chat.id);
      chat.statusMessage = "";
      clearThinkingMessage(chat.id);
      const pending = pendingAgentRequests.get(chat.id) ?? null;
      pendingAgentRequests.delete(chat.id);
      restoreDraftFromPending(chat.id, pending);
      renderHistoryList();
      updateSendState();
      updateStatusDisplay();
      return false;
    }
    return true;
  };

  const buildAutonomousContinueMessage = () => [
    "直前のユーザー指示と会話の目的を最優先して、自律的に継続してください。",
    "まず run_build で検証してください。",
    "ビルドが失敗した場合: 失敗理由を特定し、必要最小限の修正提案だけを出してください（軽微な気になる点は無理に直さない）。",
    "ビルドが成功した場合: 次に進むための提案を1つだけ出してください（闇雲な大規模変更はしない）。",
  ].join("\n");

  const maybeContinueAutonomous = (chatId?: string | null, forceOnce = false) => {
    if (!forceOnce) return;
    const chat = getChat(chatId);
    if (!chat) return;
    if (runningConversations.has(chat.id)) return;
    if (chat.proposals.size > 0) return;
    requestAgentRun(chat.id, buildAutonomousContinueMessage());
  };

  // ── Event Listeners ───────────────────────────────────
  const handleSend = () => {
    if (!(aiInput instanceof HTMLTextAreaElement)) return;
    const text = aiInput.value.trim();
    const hasAttachments = pendingAttachments.length > 0;
    if (!text && !hasAttachments) return;
    if (isAiBlocked() || needsLogin()) {
      requestAiAccessCheck(true);
      requestPlatformUsage(true);
      updateStatusDisplay();
      return;
    }

    if (!activeChatId) { const c = createChat(); activeChatId = c.id; }
    const chat = getChat(activeChatId);
    if (!chat) return;

    if (chat.title.startsWith("Chat ") && text) {
      chat.title = text.slice(0, 24).replace(/\s+/g, " ") || chat.title;
    }
    setChatTitle(chat);

    renderHistoryList();
    const userLabel = text || "画像を送信しました。";
    const attachmentNote = hasAttachments ? `\n[添付画像 ${pendingAttachments.length}件]` : "";
    appendMessage({ role: "user", text: `${userLabel}${attachmentNote}` }, chat.id);
    aiInput.value = "";
    autoGrow();
    updateContextBar();
    const requestParts: AiRequestPart[] = [];
    if (text) {
      requestParts.push({ text });
    }
    pendingAttachments.forEach((attachment) => {
      requestParts.push({
        inlineData: {
          mimeType: attachment.mimeType,
          data: attachment.data,
        },
      });
    });
    const requestMessage = text || "添付画像を解析してください。";
    const contextPayload = buildContextPayload();
    const sent = requestAgentRun(chat.id, requestMessage, requestParts, contextPayload);
    if (sent) {
      clearPendingAttachments();
    }
  };

  if (aiSend instanceof HTMLButtonElement) aiSend.addEventListener("click", handleSend);
  if (aiInput instanceof HTMLTextAreaElement) {
    aiInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); handleSend(); }
    });
    aiInput.addEventListener("paste", (event) => {
      const files = event.clipboardData?.files ?? null;
      if (!files || files.length === 0) return;
      const hasImage = Array.from(files).some((file) => file.type.startsWith("image/"));
      if (!hasImage) return;
      event.preventDefault();
      void addImageFiles(files);
    });
  }
  if (aiAttach instanceof HTMLButtonElement && aiAttachInput instanceof HTMLInputElement) {
    aiAttach.addEventListener("click", () => {
      if (!aiAttach.disabled) aiAttachInput.click();
    });
    aiAttachInput.addEventListener("change", () => {
      void addImageFiles(aiAttachInput.files);
    });
  }
  if (aiStatus instanceof HTMLElement) {
    aiStatus.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      const button = target?.closest<HTMLButtonElement>("[data-ai-status-action]");
      if (!button) {
        return;
      }
      const action = button.dataset.aiStatusAction;
      if (action === "login") {
        deps.postToNative({ type: "auth:google:start" });
        return;
      }
      if (action === "pricing") {
        openExternalUrl(resolvePricingUrl());
        return;
      }
    });
  }
  const attachDropHost = aiAttach instanceof HTMLElement ? aiAttach.closest(".ai-chat-input") : null;
  if (attachDropHost instanceof HTMLElement) {
    attachDropHost.addEventListener("dragover", (event) => {
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const hasImage = Array.from(files).some((file) => file.type.startsWith("image/"));
      if (!hasImage) return;
      event.preventDefault();
    });
    attachDropHost.addEventListener("drop", (event) => {
      const files = event.dataTransfer?.files ?? null;
      if (!files || files.length === 0) return;
      const hasImage = Array.from(files).some((file) => file.type.startsWith("image/"));
      if (!hasImage) return;
      event.preventDefault();
      void addImageFiles(files);
    });
  }
  if (aiStop instanceof HTMLButtonElement) {
    aiStop.addEventListener("click", () => {
      const chat = getChat(activeChatId);
      if (!chat) return;
      if (runningConversations.has(chat.id)) {
        disableAutonomous(chat.id);
        deps.postToNative({ type: "agent:abort", conversationId: chat.id }, true);
        resumableConversations.delete(chat.id);
        pendingAgentRequests.delete(chat.id);
        chat.statusMessage = "";
        runningConversations.delete(chat.id);
        clearThinkingMessage(chat.id);
        renderHistoryList();
        updateSendState();
        updateStatusDisplay();
        return;
      }
      if (!resumableConversations.has(chat.id)) {
        return;
      }
      if (isAiBlocked() || needsLogin()) {
        requestAiAccessCheck(true);
        requestPlatformUsage(true);
        updateStatusDisplay();
        return;
      }
      const contextToSend = buildContextPayload();
      chat.statusMessage = "思考中...";
      runningConversations.add(chat.id);
      resumableConversations.delete(chat.id);
      upsertThinkingMessage(chat.id, chat.statusMessage);
      renderHistoryList();
      updateSendState();
      updateStatusDisplay();
      const posted = deps.postToNative(
        { type: "agent:resume", conversationId: chat.id, context: contextToSend },
        true
      );
      if (!posted) {
        runningConversations.delete(chat.id);
        resumableConversations.add(chat.id);
        chat.statusMessage = "";
        clearThinkingMessage(chat.id);
        renderHistoryList();
        updateSendState();
        updateStatusDisplay();
      }
    });
  }
  if (aiChatNew instanceof HTMLButtonElement) {
    aiChatNew.addEventListener("click", () => {
      resetToNewChatState();
      if (aiInput instanceof HTMLTextAreaElement) aiInput.focus();
    });
  }
  if (aiInput instanceof HTMLTextAreaElement && !aiInput.placeholder.trim()) {
    aiInput.placeholder = "執筆内容を指示してください...";
  }

  // ── Handler API ───────────────────────────────────────
  const handleState = (state: AgentUiState) => {
    const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
    if (sessions.length === 0) {
      return;
    }
    sessions.sort((a, b) => {
      const aUpdated = typeof a?.updatedAt === "number" ? a.updatedAt : 0;
      const bUpdated = typeof b?.updatedAt === "number" ? b.updatedAt : 0;
      return aUpdated - bUpdated;
    });

    chats.splice(0, chats.length);
    chatIndex.clear();
    proposalIndex.clear();
    runningConversations.clear();
    resumableConversations.clear();
    streamingMessages.clear();
    thinkingMessages.clear();

    activeChatId = null;
    clearPendingAttachments();

    sessions.forEach((session) => {
      if (!session || typeof session !== "object") {
        return;
      }
      const conversationId =
        typeof session.conversationId === "string" && session.conversationId.trim()
          ? session.conversationId.trim()
          : "";
      if (!conversationId) {
        return;
      }
      const chat = ensureChat(conversationId);
      if (!chat) {
        return;
      }
      if (typeof session.title === "string" && session.title.trim()) {
        chat.title = session.title.trim();
      }
      const restoredMessages = Array.isArray(session.messages) ? session.messages : [];
      chat.messages = restoredMessages
        .filter((msg) => msg && typeof msg === "object")
        .map((msg): ChatMessage => ({
          role: msg.role === "assistant" ? "assistant" : "user",
          text: typeof msg.text === "string" ? msg.text : "",
        }))
        .filter((msg) => msg.text.trim().length > 0);

      chat.proposals.clear();
      const restoredProposals = Array.isArray(session.proposals) ? session.proposals : [];
      restoredProposals.forEach((proposal) => {
        if (!proposal || typeof proposal !== "object") {
          return;
        }
        if (typeof proposal.id !== "string" || !proposal.id) {
          return;
        }
        chat.proposals.set(proposal.id, proposal as AgentProposal);
        proposalIndex.set(proposal.id, chat.id);
      });

      const statusState = session.status?.state;
      const statusMessage =
        typeof session.status?.message === "string" ? session.status.message : "";
      if (statusState === "running") {
        runningConversations.add(chat.id);
        chat.statusMessage = statusMessage || "思考中...";
        upsertThinkingMessage(chat.id, chat.statusMessage);
      } else if (statusState === "error") {
        resumableConversations.add(chat.id);
        chat.statusMessage = "";
      } else {
        chat.statusMessage = "";
      }
    });

    const latest = sessions[sessions.length - 1];
    if (latest && typeof latest.conversationId === "string") {
      const chat = getChat(latest.conversationId);
      if (chat) {
        activeChatId = chat.id;
        setChatTitle(chat);
        renderChatContent();
      }
    }
    renderHistoryList();
    updateSendState();
    updateStatusDisplay();
  };

  const handleSettings = (s: AgentSettings) => { agentSettings = s; updateSendState(); };

  const handleStatus = (state: AgentStatusState, message?: string, conversationId?: string) => {
    const chat = ensureChat(conversationId);
    if (!chat) return;
    if (state === "running") {
      runningConversations.add(chat.id);
      resumableConversations.delete(chat.id);
      chat.statusMessage = message || "思考中...";
      upsertThinkingMessage(chat.id, chat.statusMessage);
    } else {
      runningConversations.delete(chat.id);
      chat.statusMessage = "";
      clearThinkingMessage(chat.id);
      if (state === "error") {
        resumableConversations.add(chat.id);
      } else {
        resumableConversations.delete(chat.id);
      }
      scheduleUsageRefresh(true);
    }
    renderHistoryList();
    updateSendState();
    if (chat.id === activeChatId) updateStatusDisplay();
  };

  const handleMessage = (text: string, conversationId?: string) => {
    clearThinkingMessage(conversationId);
    if (conversationId) {
      pendingAgentRequests.delete(conversationId);
    }
    if (conversationId && finalizeStreamingMessage(conversationId, text)) scrollToBottom();
    else appendMessage({ role: "assistant", text }, conversationId);
    if (conversationId) {
      runningConversations.delete(conversationId);
      updateSendState();
      renderHistoryList();
    }
    const chat = ensureChat(conversationId);
    if (chat) chat.statusMessage = "";
    updateStatusDisplay();
    scheduleUsageRefresh(true);
  };

  const handleMessageDelta = (text: string, conversationId?: string) => {
    const chatId = conversationId ?? activeChatId;
    if (!chatId || !text) return;
    clearThinkingMessage(chatId);
    const entry = ensureStreamingMessage(chatId);
    if (!entry) return;
    entry.message.text += text;
    updateMessageElement(entry.element, entry.message.text);
    scrollToBottom();
  };

  const handleTool = (payload: { name: string; summary?: string; conversationId?: string }) => {
    const chat = ensureChat(payload.conversationId);
    if (!chat || !runningConversations.has(chat.id)) return;
    chat.statusMessage = payload.summary ? `${payload.name} (${payload.summary})` : payload.name;
    upsertThinkingMessage(chat.id, chat.statusMessage);
    if (chat.id === activeChatId) updateStatusDisplay();
  };

  const handleProposal = (proposal: AgentProposal) => {
    const chat = ensureChat(proposal.conversationId);
    if (!chat) return;
    chat.proposals.set(proposal.id, proposal);
    proposalIndex.set(proposal.id, chat.id);
    renderHistoryList();
    if (chat.id === activeChatId) {
      const proposals = ensureProposalsEmbedded();
      if (proposals) { proposals.classList.remove("is-hidden"); proposals.appendChild(buildProposalCard(proposal)); }
      scrollToBottom();
    }
  };

  const handleApplyResult = (payload: {
    proposalId: string;
    ok: boolean;
    error?: string;
    conflict?: boolean;
  }) => {
    const chatId = proposalIndex.get(payload.proposalId);
    const chat = getChat(chatId);
    if (!chat) return;
    const proposal = chat.proposals.get(payload.proposalId);
    if (!proposal) return;
    if (payload.ok) {
      chat.proposals.delete(payload.proposalId);
      proposalIndex.delete(payload.proposalId);
      if (chat.id === activeChatId) {
        const pc = getProposalsContainer();
        pc?.querySelector(`[data-proposal-id="${payload.proposalId}"]`)?.remove();
        if (pc && chat.proposals.size === 0) pc.classList.add("is-hidden");
      }
      appendMessage({ role: "system", text: `適用完了: ${proposal.path}` }, chat.id);
      renderHistoryList();
      const forceOnce = continueAfterApply.delete(payload.proposalId);
      window.setTimeout(
        () => maybeContinueAutonomous(chat.id, forceOnce),
        AUTONOMOUS_CONTINUE_DELAY_MS
      );
    } else {
      const label = payload.conflict ? "適用競合" : "適用失敗";
      appendMessage({ role: "system", text: `${label}: ${payload.error ?? "不明なエラー"}` }, chat.id);
    }
  };

  const handleUndoResult = (payload: {
    ok: boolean;
    message?: string;
    path?: string;
    conversationId?: string;
  }) => {
    const targetChatId = payload.conversationId ?? activeChatId ?? undefined;
    const line = payload.ok
      ? `取り消し完了: ${payload.path ?? payload.message ?? "直前の適用を戻しました。"}`
      : `取り消し失敗: ${payload.message ?? "取り消せる操作がありません。"}`;
    appendMessage({ role: "system", text: line }, targetChatId);
    updateContextBar();
  };

  const handleError = (message: string, conversationId?: string) => {
    appendMessage({ role: "system", text: message }, conversationId);
    const chat = ensureChat(conversationId);
    if (chat) {
      chat.statusMessage = "";
      disableAutonomous(chat.id);
      resumableConversations.add(chat.id);
      clearThinkingMessage(chat.id);
    }
    if (conversationId) streamingMessages.delete(conversationId);
    if (conversationId) {
      const pending = pendingAgentRequests.get(conversationId) ?? null;
      pendingAgentRequests.delete(conversationId);
      restoreDraftFromPending(conversationId, pending);
    }
    if (conversationId) {
      runningConversations.delete(conversationId);
      renderHistoryList();
      updateSendState();
    }
    updateStatusDisplay();
    scheduleUsageRefresh(true);
  };

  const handlePlatformAuth = (payload: {
    auth: PlatformAuthSnapshot;
    error?: { code?: string; message?: string };
  }) => {
    platformAuth = payload?.auth ?? null;
    platformError = normalizeAuthError(payload?.error ?? null);
    if (!platformAuth?.authenticated) {
      platformAiAccess = null;
      platformUsage = null;
      requestedInitialUsage = false;
    } else if (!platformAuth.pending && !requestedInitialUsage && !payload?.error?.message) {
      requestedInitialUsage = true;
      requestAiAccessCheck(false);
      requestPlatformUsage(false);
    }
    updateStatusDisplay();
  };

  const handlePlatformAiAccess = (payload: {
    source?: string;
    access: PlatformAiAccessSnapshot;
  }) => {
    const access = payload?.access ?? null;
    if (!access) {
      return;
    }
    platformAiAccess = access;
    if (access.allowed) {
      platformError = null;
    }
    if (
      access.quota &&
      (!platformUsage?.summary ||
        payload?.source === "auth" ||
        payload?.source === "manual" ||
        payload?.source === "chat")
    ) {
      const usageFromAccess = normalizeUsageSnapshot({
        authenticated: Boolean(access.authenticated),
        plan: access.plan ?? null,
        period: null,
        summary: access.quota,
        byFeature: platformUsage?.byFeature ?? null,
        errorCode: access.allowed ? null : access.reason ?? null,
        message: access.message ?? null,
        fetchedAt: access.fetchedAt ?? Date.now(),
      });
      if (usageFromAccess) {
        const currentFetchedAt =
          typeof platformUsage?.fetchedAt === "number" && Number.isFinite(platformUsage.fetchedAt)
            ? platformUsage.fetchedAt
            : 0;
        const nextFetchedAt =
          typeof usageFromAccess.fetchedAt === "number" &&
          Number.isFinite(usageFromAccess.fetchedAt)
            ? usageFromAccess.fetchedAt
            : Date.now();
        if (!platformUsage || nextFetchedAt >= currentFetchedAt) {
          platformUsage = usageFromAccess;
        }
      }
    }
    updateStatusDisplay();
  };

  const handlePlatformUsage = (payload: {
    source?: string;
    usage: PlatformUsageSnapshot;
  }) => {
    platformUsage = normalizeUsageSnapshot(payload?.usage ?? null);
    if (!platformUsage?.errorCode) {
      platformError = null;
    }
    updateStatusDisplay();
  };

  const handlePlatformUpdate = (_payload: {
    source?: string;
    update: PlatformUpdateSnapshot | null;
    error?: { code?: string; message?: string };
  }) => {};

  // ── Init ──────────────────────────────────────────────
  resetToNewChatState();
  updateContextBar();
  renderAttachmentBar();
  requestPlatformState();

  return {
    handleSettings, handleState, handleStatus, handleMessage, handleMessageDelta, handleTool,
    handleProposal, handleApplyResult, handleUndoResult, handleError,
    refreshContextBar: updateContextBar,
    handlePlatformAuth, handlePlatformAiAccess, handlePlatformUsage,
    handlePlatformUpdate,
    applyPendingFromDiffModal: () => { if (pendingAiProposalId) { deps.postToNative({ type: "agent:apply", proposalId: pendingAiProposalId }); pendingAiProposalId = null; } },
    clearPending: () => { pendingAiProposalId = null; },
  };
};
