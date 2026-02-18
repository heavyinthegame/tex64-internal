import type { AppContext } from "./context.js";
import type {
  AgentProposal,
  AgentSettings,
  AgentStatusState,
  IssueItem,
  IssuesStatus,
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

type AiChatDeps = {
  postToNative: (payload: { type: string; [key: string]: unknown }, silent?: boolean) => boolean;
  getActiveFilePath: () => string | null;
  getActiveFileSnapshot?: () => { path: string; content: string; isDirty: boolean } | null;
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
  handleStatus: (state: AgentStatusState, message?: string, conversationId?: string) => void;
  handleMessage: (text: string, conversationId?: string) => void;
  handleMessageDelta: (text: string, conversationId?: string) => void;
  handleTool: (payload: { name: string; summary?: string; conversationId?: string }) => void;
  handleProposal: (proposal: AgentProposal) => void;
  handleApplyResult: (payload: { proposalId: string; ok: boolean; error?: string; conflict?: boolean }) => void;
  handleUndoResult: (payload: { ok: boolean; message?: string; path?: string; conversationId?: string }) => void;
  handleError: (message: string, conversationId?: string) => void;
  applyPendingFromDiffModal: () => void;
  clearPending: () => void;
};

const MAX_ACTIVE_FILE_CONTEXT_CHARS = 12000;
const MAX_OPEN_FILE_CONTEXT_CHARS = 12000;
const MAX_SELECTION_CONTEXT_CHARS = 6000;
const MAX_OPEN_FILE_SNAPSHOTS = Number.POSITIVE_INFINITY;
const MAX_RECENT_ISSUES = 5;
const AUTONOMOUS_LOOP_LIMIT = 8;
const AUTONOMOUS_CONTINUE_DELAY_MS = 120;
const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024;

type AiImageAttachment = {
  mimeType: string;
  data: string;
  name: string;
  size: number;
};

export const initAiChatUi = (context: AppContext, deps: AiChatDeps): AiChatApi => {
  const {
    aiChatLog, aiChat, aiProposals, aiAttachments, aiAttach, aiAttachInput, aiInput, aiSend, aiStatus, aiChatNew,
    aiTopbarTitle, aiHistoryToggle, aiHistory, aiHistoryList,
    aiContextBar, aiStop,
  } = context.dom;

  const chats: ChatState[] = [];
  const chatIndex = new Map<string, ChatState>();
  const proposalIndex = new Map<string, string>();
  let activeChatId: string | null = null;
  const runningConversations = new Set<string>();
  let agentSettings: AgentSettings | null = null;
  const continueAfterApply = new Set<string>();
  const streamingMessages = new Map<string, { message: ChatMessage; element: HTMLElement | null }>();
  const thinkingMessages = new Map<string, { text: string; element: HTMLElement | null }>();
  let pendingAttachments: AiImageAttachment[] = [];

  const makeChatId = () => `chat-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;

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
    if (aiSend instanceof HTMLButtonElement) {
      aiSend.disabled = isRunning;
      aiSend.classList.remove("is-loading");
      aiSend.style.display = isRunning ? "none" : "flex";
    }
    if (aiInput instanceof HTMLTextAreaElement) aiInput.disabled = isRunning;
    if (aiAttach instanceof HTMLButtonElement) aiAttach.disabled = isRunning;
    if (aiAttachInput instanceof HTMLInputElement) aiAttachInput.disabled = isRunning;
    if (aiStop instanceof HTMLButtonElement) {
      aiStop.disabled = !isRunning;
      aiStop.style.display = isRunning ? "flex" : "none";
    }
  };

  const updateStatusDisplay = () => {
    if (!(aiStatus instanceof HTMLElement)) return;
    aiStatus.textContent = "";
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
    return s ? { openFiles: s.files, openFileSnapshots: s.snapshots } : {};
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

  // ── Agent Communication ───────────────────────────────
  const requestAgentRun = (
    chatId: string,
    message: string,
    parts?: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>,
    contextPayload?: Record<string, unknown>
  ) => {
    const hasText = typeof message === "string" && message.trim().length > 0;
    const hasParts = Array.isArray(parts) && parts.length > 0;
    if (!hasText && !hasParts) return false;
    const chat = ensureChat(chatId);
    if (!chat) return false;
    if (runningConversations.has(chat.id)) return false;
    chat.statusMessage = "思考中...";
    runningConversations.add(chat.id);
    upsertThinkingMessage(chat.id, chat.statusMessage);
    renderHistoryList();
    updateSendState();
    updateStatusDisplay();
    deps.postToNative({
      type: "agent:run", message, parts, conversationId: chat.id,
      context: contextPayload ?? buildContextPayload(),
    });
    return true;
  };

  const buildAutonomousContinueMessage = () => [
    "執筆を自律的に継続してください。",
    "前進に必要なまとまった変更を自分で判断し、必要なら検証も実行してください。",
    "変更提案は必要に応じて複数箇所をまとめて提示してください。",
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
    const requestParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
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
      disableAutonomous(chat.id);
      deps.postToNative({ type: "agent:abort", conversationId: chat.id }, true);
      chat.statusMessage = "";
      runningConversations.delete(chat.id);
      clearThinkingMessage(chat.id);
      renderHistoryList();
      updateSendState();
      updateStatusDisplay();
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
  const handleSettings = (s: AgentSettings) => { agentSettings = s; updateSendState(); };

  const handleStatus = (state: AgentStatusState, message?: string, conversationId?: string) => {
    const chat = ensureChat(conversationId);
    if (!chat) return;
    if (state === "running") {
      runningConversations.add(chat.id);
      chat.statusMessage = message || "思考中...";
      upsertThinkingMessage(chat.id, chat.statusMessage);
    } else {
      runningConversations.delete(chat.id);
      chat.statusMessage = "";
      clearThinkingMessage(chat.id);
    }
    renderHistoryList();
    updateSendState();
    if (chat.id === activeChatId) updateStatusDisplay();
  };

  const handleMessage = (text: string, conversationId?: string) => {
    clearThinkingMessage(conversationId);
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
      clearThinkingMessage(chat.id);
    }
    if (conversationId) streamingMessages.delete(conversationId);
    if (conversationId) {
      runningConversations.delete(conversationId);
      renderHistoryList();
      updateSendState();
    }
    updateStatusDisplay();
  };

  // ── Init ──────────────────────────────────────────────
  resetToNewChatState();
  updateContextBar();
  renderAttachmentBar();

  return {
    handleSettings, handleStatus, handleMessage, handleMessageDelta, handleTool,
    handleProposal, handleApplyResult, handleUndoResult, handleError,
    applyPendingFromDiffModal: () => { if (pendingAiProposalId) { deps.postToNative({ type: "agent:apply", proposalId: pendingAiProposalId }); pendingAiProposalId = null; } },
    clearPending: () => { pendingAiProposalId = null; },
  };
};
