const buildRequestId = (() => {
    let counter = 0;
    return () => `api-${Date.now().toString(36)}-${counter++}`;
})();
export const createApiCompletionBroker = (postToNative) => {
    const pending = new Map();
    let latestUsage = null;
    const requestCompletion = (payload) => {
        const requestId = buildRequestId();
        const timeoutMs = Number.isFinite(payload.timeoutMs) ? payload.timeoutMs : 3500;
        return new Promise((resolve) => {
            const timeoutId = window.setTimeout(() => {
                pending.delete(requestId);
                resolve({ text: null });
            }, Math.max(800, timeoutMs + 200));
            pending.set(requestId, { resolve, timeoutId });
            postToNative({
                type: "api:ghostCompletion",
                requestId,
                prompt: payload.prompt,
                prefix: payload.prefix,
                maxOutputTokens: payload.maxOutputTokens,
                temperature: payload.temperature,
                topP: payload.topP,
                topK: payload.topK,
                timeoutMs,
            }, true);
        });
    };
    const handleCompletionResult = (payload) => {
        if (!payload || typeof payload.requestId !== "string") {
            return;
        }
        const entry = pending.get(payload.requestId);
        if (!entry) {
            if (payload.usageSnapshot) {
                latestUsage = payload.usageSnapshot;
            }
            return;
        }
        pending.delete(payload.requestId);
        window.clearTimeout(entry.timeoutId);
        if (payload.usageSnapshot) {
            latestUsage = payload.usageSnapshot;
        }
        if (payload.ok === false) {
            entry.resolve({ text: null, usageSnapshot: payload.usageSnapshot });
            return;
        }
        entry.resolve({
            text: typeof payload.text === "string" ? payload.text : null,
            usageSnapshot: payload.usageSnapshot,
        });
    };
    const handleUsage = (payload) => {
        if (payload === null || payload === void 0 ? void 0 : payload.snapshot) {
            latestUsage = payload.snapshot;
        }
    };
    const getLatestUsage = () => latestUsage;
    return {
        requestCompletion,
        handleCompletionResult,
        handleUsage,
        getLatestUsage,
    };
};
