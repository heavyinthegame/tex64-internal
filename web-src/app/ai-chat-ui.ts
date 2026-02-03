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
  getOpenFileSnapshots?: (options?: {
    maxFiles?: number;
    maxChars?: number;
  }) => {
    files: Array<{ path: string; isDirty: boolean; isActive: boolean }>;
    snapshots: Array<{
      path: string;
      content: string;
      isDirty: boolean;
      truncated: boolean;
      contentLength: number;
    }>;
  };
  getRecentIssuesSnapshot?: () => {
    count: number;
    summary: string;
    status: IssuesStatus;
    issues: IssueItem[];
    updatedAt: number;
  } | null;
  showDiffModal?: (
    original: string,
    modified: string,
    lineOffset?: number,
    options?: { title?: string; fileName?: string; submitLabel?: string }
  ) => void;
  setDiffContext?: (context: DiffContext) => void;
};

export type AiChatApi = {
  handleSettings: (settings: AgentSettings) => void;
  handleStatus: (state: AgentStatusState, message?: string, conversationId?: string) => void;
  handleMessage: (text: string, conversationId?: string) => void;
  handleMessageDelta: (text: string, conversationId?: string) => void;
  handleTool: (payload: { name: string; summary?: string; conversationId?: string }) => void;
  handleProposal: (proposal: AgentProposal) => void;
  handleApplyResult: (payload: { proposalId: string; ok: boolean; error?: string }) => void;
  handleError: (message: string, conversationId?: string) => void;
  applyPendingFromDiffModal: () => void;
  clearPending: () => void;
};

const MAX_ACTIVE_FILE_CONTEXT_CHARS = 12000;
const MAX_OPEN_FILE_CONTEXT_CHARS = 12000;
const MAX_OPEN_FILE_SNAPSHOTS = Number.POSITIVE_INFINITY;
const MAX_RECENT_ISSUES = 5;

export const initAiChatUi = (context: AppContext, deps: AiChatDeps): AiChatApi => {
  const {
    aiChatLog,
    aiChat,
    aiProposals,
    aiInput,
    aiSend,
    aiStatus,
    aiClear,
    aiChatList,
    aiChatNew,
  } = context.dom;

  const chats: ChatState[] = [];
  const chatIndex = new Map<string, ChatState>();
  const proposalIndex = new Map<string, string>();
  let activeChatId: string | null = null;
  let runningConversationId: string | null = null;
  let agentSettings: AgentSettings | null = null;
  const continueAfterApply = new Set<string>();
  const streamingMessages = new Map<
    string,
    { message: ChatMessage; element: HTMLElement | null }
  >();

  const makeChatId = () => `chat-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;

  // --- Two-Stage View State ---
  let viewMode: "list" | "chat" = "list";

  const storage = {
    modeKey: "tex64.ai.mode",
    autoPilotKey: "tex64.ai.autopilot",
  } as const;

  const loadBool = (key: string, fallback: boolean) => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === "1") return true;
      if (raw === "0") return false;
      return fallback;
    } catch {
      return fallback;
    }
  };

  const saveBool = (key: string, value: boolean) => {
    try {
      localStorage.setItem(key, value ? "1" : "0");
    } catch {
      // ignore
    }
  };

  const loadMode = (): "general" | "paper" => {
    try {
      const raw = localStorage.getItem(storage.modeKey);
      return raw === "paper" ? "paper" : "general";
    } catch {
      return "general";
    }
  };

  const saveMode = (mode: "general" | "paper") => {
    try {
      localStorage.setItem(storage.modeKey, mode);
    } catch {
      // ignore
    }
  };

  const defaultChatMode = loadMode();
  const defaultAutoPilot = loadBool(storage.autoPilotKey, false);

  // Create Back Button Container (Toolbar)
  const aiChatToolbar = document.createElement("div");
  aiChatToolbar.className = "ai-chat-toolbar";
  aiChatToolbar.style.padding = "10px 16px 0";
  aiChatToolbar.style.display = "none"; // Initially hidden
  aiChatToolbar.style.alignItems = "center"; // Vertical alignment
  aiChatToolbar.style.gap = "8px";
  
  const aiBack = document.createElement("button");
  aiBack.className = "panel-button ghost";
  aiBack.style.padding = "4px 8px";
  aiBack.style.fontSize = "9px";
  aiBack.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 4px;"><path d="M19 12H5M12 19l-7-7 7-7"/></svg> 戻る`;
  
  aiChatToolbar.appendChild(aiBack);

  // Chat Title in Toolbar
  const aiChatTitle = document.createElement("span");
  aiChatTitle.style.marginLeft = "8px";
  aiChatTitle.style.fontSize = "10px";
  aiChatTitle.style.fontWeight = "600";
  aiChatTitle.style.color = "var(--text)";
  aiChatTitle.style.overflow = "hidden";
  aiChatTitle.style.textOverflow = "ellipsis";
  aiChatTitle.style.whiteSpace = "nowrap";
  aiChatTitle.style.display = "flex";
  aiChatTitle.style.alignItems = "center";
  aiChatTitle.style.height = "24px"; // Match button height
  aiChatToolbar.appendChild(aiChatTitle);

  const aiModeControls = document.createElement("div");
  aiModeControls.className = "ai-mode-controls";

  const aiPaperModeButton = document.createElement("button");
  aiPaperModeButton.type = "button";
  aiPaperModeButton.className = "panel-button ghost ai-mode-toggle";
  aiPaperModeButton.textContent = "論文";
  aiPaperModeButton.setAttribute("aria-pressed", "false");

  const aiAutoPilotButton = document.createElement("button");
  aiAutoPilotButton.type = "button";
  aiAutoPilotButton.className = "panel-button ghost ai-mode-toggle";
  aiAutoPilotButton.textContent = "自律";
  aiAutoPilotButton.setAttribute("aria-pressed", "false");

  const aiNextButton = document.createElement("button");
  aiNextButton.type = "button";
  aiNextButton.className = "panel-button ghost ai-next-button";
  aiNextButton.textContent = "次へ";

  const aiStopButton = document.createElement("button");
  aiStopButton.type = "button";
  aiStopButton.className = "panel-button ghost ai-stop-button";
  aiStopButton.textContent = "停止";
  aiStopButton.disabled = true;

  aiModeControls.append(aiPaperModeButton, aiAutoPilotButton, aiNextButton, aiStopButton);
  aiChatToolbar.appendChild(aiModeControls);

  // Insert Toolbar at the top of aiChat
  if (aiChat) {
    aiChat.prepend(aiChatToolbar);
  }

  const setViewMode = (mode: "list" | "chat") => {
    viewMode = mode;
    const { aiPanel } = context.dom;
    if (aiPanel) {
      aiPanel.classList.toggle("is-view-list", mode === "list");
      aiPanel.classList.toggle("is-view-chat", mode === "chat");
    }
    
    // Toggle Toolbar visibility
    aiChatToolbar.style.display = mode === "chat" ? "flex" : "none";
    syncModeControls();
    
    // Clear button is removed from header, no need to toggle
  };

  aiBack.addEventListener("click", () => {
    setViewMode("list");
  });

  const getChat = (chatId?: string | null) =>
    getChatState(chatIndex, activeChatId, chatId);

  const getChatMode = (chatId?: string | null) => {
    const chat = getChat(chatId);
    return chat?.mode ?? defaultChatMode;
  };

  const isAutoPilotEnabled = (chatId?: string | null) => {
    const chat = getChat(chatId);
    return Boolean(chat?.autoPilot);
  };

  function syncModeControls() {
    const chat = getChat(activeChatId);
    const mode = chat?.mode ?? defaultChatMode;
    const autoPilot = Boolean(chat?.autoPilot);
    aiPaperModeButton.classList.toggle("is-active", mode === "paper");
    aiPaperModeButton.setAttribute("aria-pressed", mode === "paper" ? "true" : "false");
    aiAutoPilotButton.classList.toggle("is-active", autoPilot);
    aiAutoPilotButton.setAttribute("aria-pressed", autoPilot ? "true" : "false");
  }

  const resolveChatTitle = (chatId: string) => {
    if (chatId === "search-rename") {
      return "シンボルリネーム";
    }
    return `Chat ${chats.length + 1}`;
  };

  const ensureChat = (chatId?: string | null) =>
    ensureChatState({
      chatId,
      activeChatId,
      chats,
      chatIndex,
      defaultChatMode,
      defaultAutoPilot,
      resolveChatTitle,
      onChatCreated: renderChatList,
    });

  const createChat = () =>
    createChatState({
      chats,
      chatIndex,
      makeChatId,
      resolveChatTitle,
      defaultChatMode,
      defaultAutoPilot,
    });

  const updateSendState = () => {
    const isRunning = Boolean(runningConversationId);
    if (aiSend instanceof HTMLButtonElement) {
      aiSend.disabled = isRunning;
      aiSend.classList.toggle("is-loading", isRunning);
    }
    if (aiInput instanceof HTMLTextAreaElement) {
      aiInput.disabled = isRunning;
    }
    aiNextButton.disabled = isRunning;
    aiStopButton.disabled = !isRunning;
  };

  const updateStatusDisplay = () => {
    if (!(aiStatus instanceof HTMLElement)) {
      return;
    }
    const activeChat = getChat(activeChatId);
    if (!activeChat) {
      aiStatus.textContent = "待機中";
      return;
    }
    if (runningConversationId && runningConversationId !== activeChat.id) {
      aiStatus.textContent = "他のチャットが応答中です...";
      return;
    }
    // Only show status when actively running, otherwise hide
    if (runningConversationId === activeChat.id) {
      aiStatus.textContent = activeChat.statusMessage || "";
    } else {
      aiStatus.textContent = "";
    }
  };

  const resolveMaxChars = (value: number | undefined, fallback: number) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }
    if (value <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    return value;
  };

  const buildActiveFileContext = () => {
    const maxChars = resolveMaxChars(
      agentSettings?.openFileMaxChars,
      MAX_ACTIVE_FILE_CONTEXT_CHARS
    );
    const snapshot = deps.getActiveFileSnapshot?.() ?? null;
    const fallbackPath = deps.getActiveFilePath();
    if (!snapshot) {
      return fallbackPath ? { activeFilePath: fallbackPath } : {};
    }
    let content = snapshot.content;
    let truncated = false;
    if (Number.isFinite(maxChars) && content.length > maxChars) {
      content = content.slice(0, maxChars);
      truncated = true;
    }
    return {
      activeFilePath: snapshot.path,
      activeFileContent: content,
      activeFileIsDirty: snapshot.isDirty,
      activeFileContentTruncated: truncated,
      activeFileContentLength: snapshot.content.length,
    };
  };

  const buildOpenFilesContext = () => {
    const maxChars = resolveMaxChars(
      agentSettings?.openFileMaxChars,
      MAX_OPEN_FILE_CONTEXT_CHARS
    );
    const openSnapshots = deps.getOpenFileSnapshots?.({
      maxFiles: MAX_OPEN_FILE_SNAPSHOTS,
      maxChars,
    });
    if (!openSnapshots) {
      return {};
    }
    return {
      openFiles: openSnapshots.files,
      openFileSnapshots: openSnapshots.snapshots,
    };
  };

  const buildIssuesContext = () => {
    const snapshot = deps.getRecentIssuesSnapshot?.();
    if (!snapshot || !Array.isArray(snapshot.issues) || snapshot.issues.length === 0) {
      return {};
    }
    const items = snapshot.issues.slice(0, MAX_RECENT_ISSUES).map((issue) => ({
      severity: issue.severity,
      message: issue.message,
      path: issue.path,
      line: issue.line,
      column: issue.column,
      action: issue.action,
      resolution: getIssueResolution(issue),
    }));
    return {
      recentIssueSummary: snapshot.summary,
      recentIssueStatus: snapshot.status,
      recentIssuesUpdatedAt: new Date(snapshot.updatedAt).toISOString(),
      recentIssues: items,
    };
  };

  const buildAgentModeContext = (chatId?: string | null) => ({
    agentMode: getChatMode(chatId),
  });

  const getChatLog = () =>
    aiChatLog instanceof HTMLElement ? aiChatLog : null;

  const getProposalsContainer = () =>
    aiProposals instanceof HTMLElement ? aiProposals : null;

  const ensureProposalsEmbedded = () => {
    const chatLog = getChatLog();
    const proposals = getProposalsContainer();
    if (!chatLog || !proposals) {
      return null;
    }
    if (proposals.parentElement !== chatLog) {
      chatLog.appendChild(proposals);
    } else if (chatLog.lastElementChild !== proposals) {
      chatLog.appendChild(proposals);
    }
    return proposals;
  };

  const appendToChatLog = (element: HTMLElement) => {
    const chatLog = getChatLog();
    if (!chatLog) {
      return;
    }
    const proposals = getProposalsContainer();
    if (proposals && proposals.parentElement === chatLog) {
      chatLog.insertBefore(element, proposals);
    } else {
      chatLog.appendChild(element);
    }
  };

  const getLastMessageElement = () => {
    const chatLog = getChatLog();
    if (!chatLog) {
      return null;
    }
    const nodes = chatLog.querySelectorAll(".ai-message");
    if (nodes.length === 0) {
      return null;
    }
    return nodes[nodes.length - 1] as HTMLElement;
  };

  function setActiveChat(chatId: string) {
    if (!chatIndex.has(chatId)) {
      return;
    }
    activeChatId = chatId;

    // Update title in toolbar
    const chat = getChat(chatId);
    if (chat) {
      aiChatTitle.textContent = chat.title;
    }
    syncModeControls();

    renderChatList();
    renderChatContent();
    updateStatusDisplay();
    setViewMode("chat");
  }

  const ensureStreamingMessage = (chatId: string) => {
    const existing = streamingMessages.get(chatId);
    if (existing) {
      return existing;
    }
    const chat = ensureChat(chatId);
    if (!chat) {
      return null;
    }
    const message: ChatMessage = { role: "assistant", text: "" };
    chat.messages.push(message);
    let element: HTMLElement | null = null;
    if (chat.id === activeChatId && aiChatLog instanceof HTMLElement) {
      element = createMessageElement(message);
      appendToChatLog(element);
      if (aiChat instanceof HTMLElement) {
        aiChat.scrollTop = aiChat.scrollHeight;
      }
    }
    const entry = { message, element };
    streamingMessages.set(chatId, entry);
    return entry;
  };

  const finalizeStreamingMessage = (chatId: string, text: string) => {
    const entry = streamingMessages.get(chatId);
    if (!entry) {
      return false;
    }
    entry.message.text = text;
    updateMessageElement(entry.element, text);
    streamingMessages.delete(chatId);
    return true;
  };

  const appendMessage = (message: ChatMessage, chatId?: string) => {
    const chat = ensureChat(chatId);
    if (!chat) {
      return;
    }
    chat.messages.push(message);
    if (chat.id !== activeChatId) {
      return;
    }
    if (!(aiChatLog instanceof HTMLElement)) {
      return;
    }
    appendToChatLog(createMessageElement(message));
    if (aiChat instanceof HTMLElement) {
      aiChat.scrollTop = aiChat.scrollHeight;
    }
  };

  let pendingAiProposalId: string | null = null;
  const setPendingProposalId = (value: string | null) => {
    pendingAiProposalId = value;
  };
  const buildProposalCard = (proposal: AgentProposal) =>
    createProposalCard(proposal, {
      postToNative: deps.postToNative,
      continueAfterApply,
      setPendingProposalId,
      showDiffModal: deps.showDiffModal,
      setDiffContext: deps.setDiffContext,
    });

  function renderChatList() {
    if (!(aiChatList instanceof HTMLElement)) {
      return;
    }
    aiChatList.replaceChildren();

    // "New Chat" button removed from list view as per request.
    // New chats are now created by sending a message from the list view.

    // Reverse chats to show newest first
    const reversedChats = [...chats].reverse();
    
    // Determine items to show
    const isExpanded = (aiChatList as any)._isExpanded || false;
    const limit = 3;
    const showAll = isExpanded || reversedChats.length <= limit;
    const visibleChats = showAll ? reversedChats : reversedChats.slice(0, limit);

    visibleChats.forEach((chat) => {
      const row = document.createElement("div");
      row.className = "ai-chat-item";
      if (chat.id === activeChatId) {
        row.classList.add("is-active");
      }
      row.dataset.chatId = chat.id;
      row.addEventListener("click", () => setActiveChat(chat.id));

      // Title/Input container
      const titleContainer = document.createElement("div");
      titleContainer.style.flex = "1";
      titleContainer.style.overflow = "hidden";
      titleContainer.style.display = "flex";
      titleContainer.style.alignItems = "center";

      const titleSpan = document.createElement("span");
      titleSpan.className = "ai-chat-item-text";
      titleSpan.textContent = chat.title;
      titleContainer.appendChild(titleSpan);
      row.appendChild(titleContainer);

      // Actions container (Rename + Close)
      const actions = document.createElement("div");
      actions.className = "ai-chat-item-actions";

      // Rename Button (Pen)
      const renameBtn = document.createElement("button");
      renameBtn.className = "ai-chat-item-btn";
      renameBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
      renameBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        
        // Switch to edit mode
        titleSpan.style.display = "none";
        const input = document.createElement("input");
        input.className = "ai-chat-item-rename-input";
        input.value = chat.title;
        input.onclick = (ev) => ev.stopPropagation(); // Prevent row click
        
        const save = () => {
             const newTitle = input.value.trim() || chat.title;
             chat.title = newTitle;
             // Update logic updates (assuming toolbar update happens on render or setActive)
             if (activeChatId === chat.id) {
               aiChatTitle.textContent = newTitle;
             }
             renderChatList();
        };

        input.addEventListener("blur", save);
        input.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
             input.blur();
          }
        });

        titleContainer.appendChild(input);
        input.focus();
      });
      actions.appendChild(renameBtn);

      if (chats.length > 1) {
        const closeButton = document.createElement("button");
        closeButton.type = "button";
        closeButton.className = "ai-chat-item-btn"; // Use generic btn class
        closeButton.textContent = "×";
        closeButton.style.fontSize = "18px"; // Larger X
        closeButton.addEventListener("click", (event) => {
          event.stopPropagation();
          removeChat(chat.id);
        });
        actions.appendChild(closeButton);
      }
      
      row.appendChild(actions);

      aiChatList.appendChild(row);
    });

    // Expand Button
    if (!showAll) {
      const expandWrapper = document.createElement("div");
      expandWrapper.className = "ai-chat-expand-wrapper";
      
      const expandBtn = document.createElement("button");
      expandBtn.className = "ai-chat-expand-btn";
      expandBtn.innerHTML = `<span>すべて表示 (${chats.length})</span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>`;
      expandBtn.onclick = () => {
        (aiChatList as any)._isExpanded = true;
        renderChatList();
      };
      
      expandWrapper.appendChild(expandBtn);
      aiChatList.appendChild(expandWrapper);
    } else if (chats.length > limit) {
       // Optional: Collapse button? User didn't ask for collapse, but "expand capability". 
       // User said "click long button to look for chats". 
       // Often implies toggle. I'll add toggle back to collapsed if already expanded?
       // Just keeping expanded for now is safer unless requested.
       // Actually, let's allow collapsing for convenience.
      const expandWrapper = document.createElement("div");
      expandWrapper.className = "ai-chat-expand-wrapper";
      
      const collapseBtn = document.createElement("button");
      collapseBtn.className = "ai-chat-expand-btn";
      collapseBtn.innerHTML = `<span>閉じる</span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 15l-6-6-6 6"/></svg>`;
      collapseBtn.onclick = () => {
        (aiChatList as any)._isExpanded = false;
        renderChatList();
      };
      
      expandWrapper.appendChild(collapseBtn);
      aiChatList.appendChild(expandWrapper);
    }
  }

  const renderChatContent = () => {
    const chat = getChat(activeChatId);
    if (!chat) {
      return;
    }
    const chatLog = getChatLog();
    chatLog?.replaceChildren();
    chat.messages.forEach((message) => {
      const element = createMessageElement(message);
      if (chatLog) {
        chatLog.appendChild(element);
      }
    });
    const proposals = ensureProposalsEmbedded();
    if (proposals) {
      proposals.replaceChildren();
      proposals.classList.toggle("is-hidden", chat.proposals.size === 0);
      chat.proposals.forEach((proposal) => {
        proposals.appendChild(buildProposalCard(proposal));
      });
    }
    const streamingEntry = streamingMessages.get(chat.id);
    const lastMessage = getLastMessageElement();
    if (streamingEntry && lastMessage) {
      streamingEntry.element = lastMessage;
    }
    if (aiChat instanceof HTMLElement) {
      aiChat.scrollTop = aiChat.scrollHeight;
    }
  };

  const removeChat = (chatId: string) => {
    if (chats.length <= 1) {
      return;
    }
    const index = chats.findIndex((entry) => entry.id === chatId);
    if (index < 0) {
      return;
    }
    const [removed] = chats.splice(index, 1);
    chatIndex.delete(removed.id);
    removed.proposals.forEach((proposal) => proposalIndex.delete(proposal.id));
    if (activeChatId === removed.id) {
      const next = chats[Math.max(0, index - 1)] ?? chats[0];
      activeChatId = next.id;
    }
    renderChatList();
    renderChatContent();
    updateStatusDisplay();
  };

  const canRunInChat = (chatId: string) => {
    if (!chatId) {
      return false;
    }
    return !runningConversationId;
  };

  const buildContinueMessage = (chatId: string) => {
    const mode = getChatMode(chatId);
    if (mode === "paper") {
      return [
        "続けてください。",
        "論文が前に進む“次の小さな変更提案”を1つだけ出してください。",
        "提案は propose_* で行い、最後に「次の提案: ...」を1行で書いてください。",
      ].join("\n");
    }
    return [
      "続けてください。",
      "プロジェクトが前に進む“次の小さな変更提案”を1つだけ出してください。",
      "提案は propose_* で行い、最後に「次の提案: ...」を1行で書いてください。",
    ].join("\n");
  };

  const requestAgentRun = (chatId: string, message: string) => {
    if (!message.trim()) {
      return;
    }
    if (!canRunInChat(chatId)) {
      return;
    }
    const chat = ensureChat(chatId);
    if (!chat) {
      return;
    }
    chat.statusMessage = "思考中...";
    runningConversationId = chat.id;
    updateSendState();
    updateStatusDisplay();
    deps.postToNative({
      type: "agent:run",
      message,
      conversationId: chat.id,
      context: {
        ...buildActiveFileContext(),
        ...buildOpenFilesContext(),
        ...buildIssuesContext(),
        ...buildAgentModeContext(chat.id),
      },
    });
  };

  const continueChat = (chatId: string) => {
    if (!chatId) {
      return;
    }
    if (!canRunInChat(chatId)) {
      return;
    }
    appendMessage({ role: "system", text: "次の提案を生成します…" }, chatId);
    requestAgentRun(chatId, buildContinueMessage(chatId));
  };

  aiPaperModeButton.addEventListener("click", () => {
    const chat = getChat(activeChatId);
    if (!chat) {
      return;
    }
    chat.mode = chat.mode === "paper" ? "general" : "paper";
    saveMode(chat.mode);
    syncModeControls();
    appendMessage(
      {
        role: "system",
        text: chat.mode === "paper" ? "論文モードを有効化しました。" : "論文モードを解除しました。",
      },
      chat.id
    );
  });

  aiAutoPilotButton.addEventListener("click", () => {
    const chat = getChat(activeChatId);
    if (!chat) {
      return;
    }
    chat.autoPilot = !chat.autoPilot;
    saveBool(storage.autoPilotKey, chat.autoPilot);
    syncModeControls();
    appendMessage(
      {
        role: "system",
        text: chat.autoPilot ? "自律モードを有効化しました。" : "自律モードを解除しました。",
      },
      chat.id
    );
  });

  aiNextButton.addEventListener("click", () => {
    const chat = getChat(activeChatId);
    if (!chat) {
      return;
    }
    continueChat(chat.id);
  });

  aiStopButton.addEventListener("click", () => {
    deps.postToNative({ type: "agent:abort" }, true);
  });

  const handleSend = () => {
    if (!(aiInput instanceof HTMLTextAreaElement)) {
      return;
    }
    const text = aiInput.value.trim();
    if (!text) {
      return;
    }

    // Auto-create chat if in list view or no active chat
    if (viewMode === "list" || !activeChatId) {
      const chat = createChat();
      setActiveChat(chat.id); // Switches to chat view
    }

    const chat = getChat(activeChatId);
    if (!chat) {
      return;
    }
    if (chat.title.startsWith("Chat ")) {
      chat.title = text.slice(0, 18).replace(/\s+/g, " ") || chat.title;
      aiChatTitle.textContent = chat.title; // Update toolbar title
      renderChatList();
    }
    appendMessage({ role: "user", text }, chat.id);
    aiInput.value = "";
    chat.statusMessage = "思考中...";
    runningConversationId = chat.id;
    updateSendState();
    updateStatusDisplay();
    deps.postToNative({
      type: "agent:run",
      message: text,
      conversationId: chat.id,
      context: {
        ...buildActiveFileContext(),
        ...buildOpenFilesContext(),
        ...buildIssuesContext(),
        ...buildAgentModeContext(chat.id),
      },
    });
  };

  if (aiSend instanceof HTMLButtonElement) {
    aiSend.addEventListener("click", () => handleSend());
  }

  if (aiInput instanceof HTMLTextAreaElement) {
    aiInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        handleSend();
      }
    });
  }

  if (aiClear instanceof HTMLButtonElement) {
    aiClear.addEventListener("click", () => {
      const chat = getChat(activeChatId);
      if (!chat) {
        return;
      }
      chat.messages = [];
      chat.proposals.clear();
      if (chat.id) {
        streamingMessages.delete(chat.id);
      }
      renderChatContent();
      proposalIndex.forEach((value, key) => {
        if (value === chat.id) {
          proposalIndex.delete(key);
        }
      });
      deps.postToNative({ type: "agent:clear", conversationId: chat.id }, true);
      chat.statusMessage = "履歴をクリアしました。";
      updateStatusDisplay();
    });
  }

  if (aiChatNew instanceof HTMLButtonElement) {
    aiChatNew.addEventListener("click", () => {
      const chat = createChat();
      setActiveChat(chat.id);
    });
  }

  const handleSettings = (_settings: AgentSettings) => {
    agentSettings = _settings;
    updateSendState();
  };

  const handleStatus = (state: AgentStatusState, message?: string, conversationId?: string) => {
    const chat = ensureChat(conversationId);
    if (!chat) {
      return;
    }
    if (state === "running") {
      runningConversationId = chat.id;
      chat.statusMessage = message || "AIが応答中です...";
    } else {
      if (runningConversationId === chat.id) {
        runningConversationId = null;
      }
      chat.statusMessage = message || "待機中";
    }
    updateSendState();
    if (chat.id === activeChatId) {
      updateStatusDisplay();
    }
  };

  const handleMessage = (text: string, conversationId?: string) => {
    if (conversationId && finalizeStreamingMessage(conversationId, text)) {
      if (aiChat instanceof HTMLElement) {
        aiChat.scrollTop = aiChat.scrollHeight;
      }
    } else {
      appendMessage({ role: "assistant", text }, conversationId);
    }
    if (conversationId && runningConversationId === conversationId) {
      runningConversationId = null;
      updateSendState();
    }
    const chat = ensureChat(conversationId);
    if (chat) {
      chat.statusMessage = "待機中";
    }
    updateStatusDisplay();
  };

  const handleMessageDelta = (text: string, conversationId?: string) => {
    const chatId = conversationId ?? activeChatId;
    if (!chatId || !text) {
      return;
    }
    const entry = ensureStreamingMessage(chatId);
    if (!entry) {
      return;
    }
    entry.message.text += text;
    updateMessageElement(entry.element, entry.message.text);
    if (aiChat instanceof HTMLElement) {
      aiChat.scrollTop = aiChat.scrollHeight;
    }
  };

  const handleTool = (payload: { name: string; summary?: string; conversationId?: string }) => {
    const chat = ensureChat(payload.conversationId);
    if (!chat) {
      return;
    }
    if (runningConversationId !== chat.id) {
      return;
    }
    const summary = payload.summary ? ` (${payload.summary})` : "";
    chat.statusMessage = `思考中: ${payload.name}${summary}`;
    if (chat.id === activeChatId) {
      updateStatusDisplay();
    }
  };

  const handleProposal = (proposal: AgentProposal) => {
    const chat = ensureChat(proposal.conversationId);
    if (!chat) {
      return;
    }
    chat.proposals.set(proposal.id, proposal);
    proposalIndex.set(proposal.id, chat.id);
    if (chat.id === activeChatId) {
      const proposals = ensureProposalsEmbedded();
      if (proposals) {
        proposals.classList.remove("is-hidden");
        proposals.appendChild(buildProposalCard(proposal));
      }
      if (aiChat instanceof HTMLElement) {
        aiChat.scrollTop = aiChat.scrollHeight;
      }
    }
  };

  const handleApplyResult = (payload: { proposalId: string; ok: boolean; error?: string }) => {
    const chatId = proposalIndex.get(payload.proposalId);
    const chat = getChat(chatId);
    if (!chat) {
      return;
    }
    const proposal = chat.proposals.get(payload.proposalId);
    if (!proposal) {
      return;
    }
    if (payload.ok) {
      chat.proposals.delete(payload.proposalId);
      proposalIndex.delete(payload.proposalId);
      const proposals = getProposalsContainer();
      proposals?.querySelector(`[data-proposal-id="${payload.proposalId}"]`)?.remove();
      if (proposals && chat.proposals.size === 0) {
        proposals.classList.add("is-hidden");
      }
      appendMessage({ role: "system", text: `適用完了: ${proposal.path}` }, chat.id);
      const requestedContinue = continueAfterApply.delete(payload.proposalId);
      const shouldContinue =
        chat.proposals.size === 0 &&
        chat.id === activeChatId &&
        (requestedContinue || chat.autoPilot);
      if (shouldContinue) {
        window.setTimeout(() => continueChat(chat.id), 120);
      }
    } else {
      appendMessage(
        { role: "system", text: `適用失敗: ${payload.error ?? "不明なエラー"}` },
        chat.id
      );
    }
  };

  const handleError = (message: string, conversationId?: string) => {
    appendMessage({ role: "system", text: message }, conversationId);
    const chat = ensureChat(conversationId);
    if (chat) {
      chat.statusMessage = message;
    }
    if (conversationId) {
      streamingMessages.delete(conversationId);
    }
    if (conversationId && runningConversationId === conversationId) {
      runningConversationId = null;
      updateSendState();
    }
    updateStatusDisplay();
  };

  const applyPendingFromDiffModal = () => {
    if (!pendingAiProposalId) {
      return;
    }
    deps.postToNative({ type: "agent:apply", proposalId: pendingAiProposalId });
    pendingAiProposalId = null;
  };

  const clearPending = () => {
    pendingAiProposalId = null;
  };

  if (chats.length === 0) {
    const initial = createChat();
    activeChatId = initial.id;
    // Do not set active view here, stay in list
  }
  
  // Initial View Setup
  setViewMode("list");
  renderChatList();


  return {
    handleSettings,
    handleStatus,
    handleMessage,
    handleMessageDelta,
    handleTool,
    handleProposal,
    handleApplyResult,
    handleError,
    applyPendingFromDiffModal,
    clearPending,
  };
};
