export const createChatState = (id, title, mode, autoPilot) => ({
    id,
    title,
    messages: [],
    proposals: new Map(),
    statusMessage: "待機中",
    mode,
    autoPilot,
});
export const getChat = (chatIndex, activeChatId, chatId) => {
    var _a, _b;
    if (chatId && chatIndex.has(chatId)) {
        return (_a = chatIndex.get(chatId)) !== null && _a !== void 0 ? _a : null;
    }
    return activeChatId ? (_b = chatIndex.get(activeChatId)) !== null && _b !== void 0 ? _b : null : null;
};
export const ensureChat = (options) => {
    const { chatId, activeChatId, chats, chatIndex, defaultChatMode, defaultAutoPilot, resolveChatTitle, onChatCreated, } = options;
    if (chatId && !chatIndex.has(chatId)) {
        const chat = createChatState(chatId, resolveChatTitle(chatId), defaultChatMode, defaultAutoPilot);
        chats.push(chat);
        chatIndex.set(chatId, chat);
        onChatCreated === null || onChatCreated === void 0 ? void 0 : onChatCreated();
    }
    return getChat(chatIndex, activeChatId, chatId);
};
export const createChat = (options) => {
    const { chats, chatIndex, makeChatId, resolveChatTitle, defaultChatMode, defaultAutoPilot, } = options;
    const id = makeChatId();
    const chat = createChatState(id, resolveChatTitle(id), defaultChatMode, defaultAutoPilot);
    chats.push(chat);
    chatIndex.set(id, chat);
    return chat;
};
