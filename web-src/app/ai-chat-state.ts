import type { AgentProposal } from "./types.js";

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  text: string;
};

export type ChatState = {
  id: string;
  title: string;
  messages: ChatMessage[];
  proposals: Map<string, AgentProposal>;
  statusMessage: string;
  mode: "general" | "paper";
  autoPilot: boolean;
};

export const createChatState = (
  id: string,
  title: string,
  mode: "general" | "paper",
  autoPilot: boolean
): ChatState => ({
  id,
  title,
  messages: [],
  proposals: new Map(),
  statusMessage: "待機中",
  mode,
  autoPilot,
});

export const getChat = (
  chatIndex: Map<string, ChatState>,
  activeChatId: string | null,
  chatId?: string | null
) => {
  if (chatId && chatIndex.has(chatId)) {
    return chatIndex.get(chatId) ?? null;
  }
  return activeChatId ? chatIndex.get(activeChatId) ?? null : null;
};

export const ensureChat = (options: {
  chatId?: string | null;
  activeChatId: string | null;
  chats: ChatState[];
  chatIndex: Map<string, ChatState>;
  defaultChatMode: "general" | "paper";
  defaultAutoPilot: boolean;
  resolveChatTitle: (chatId: string) => string;
  onChatCreated?: () => void;
}) => {
  const {
    chatId,
    activeChatId,
    chats,
    chatIndex,
    defaultChatMode,
    defaultAutoPilot,
    resolveChatTitle,
    onChatCreated,
  } = options;
  if (chatId && !chatIndex.has(chatId)) {
    const chat = createChatState(
      chatId,
      resolveChatTitle(chatId),
      defaultChatMode,
      defaultAutoPilot
    );
    chats.push(chat);
    chatIndex.set(chatId, chat);
    onChatCreated?.();
  }
  return getChat(chatIndex, activeChatId, chatId);
};

export const createChat = (options: {
  chats: ChatState[];
  chatIndex: Map<string, ChatState>;
  makeChatId: () => string;
  resolveChatTitle: (chatId: string) => string;
  defaultChatMode: "general" | "paper";
  defaultAutoPilot: boolean;
}) => {
  const {
    chats,
    chatIndex,
    makeChatId,
    resolveChatTitle,
    defaultChatMode,
    defaultAutoPilot,
  } = options;
  const id = makeChatId();
  const chat = createChatState(
    id,
    resolveChatTitle(id),
    defaultChatMode,
    defaultAutoPilot
  );
  chats.push(chat);
  chatIndex.set(id, chat);
  return chat;
};
