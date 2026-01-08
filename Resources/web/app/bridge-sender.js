export const initBridgeSender = (deps) => {
    const pending = [];
    let retryTimer = null;
    const tryFlush = () => {
        var _a, _b, _c;
        const handler = (_a = deps.bridgeWindow.tex64Bridge) !== null && _a !== void 0 ? _a : (_c = (_b = deps.bridgeWindow.webkit) === null || _b === void 0 ? void 0 : _b.messageHandlers) === null || _c === void 0 ? void 0 : _c.tex64;
        if (!handler || typeof handler.postMessage !== "function") {
            return false;
        }
        while (pending.length > 0) {
            const entry = pending.shift();
            if (entry) {
                handler.postMessage(entry.payload);
            }
        }
        return true;
    };
    const scheduleRetry = () => {
        if (retryTimer !== null) {
            return;
        }
        retryTimer = window.setInterval(() => {
            if (tryFlush()) {
                if (retryTimer !== null) {
                    window.clearInterval(retryTimer);
                    retryTimer = null;
                }
            }
        }, 50);
    };
    return (payload, silent = false) => {
        var _a, _b, _c;
        if (deps.isE2E) {
            const log = window.__tex64PostMessages;
            if (Array.isArray(log)) {
                log.push(payload);
            }
        }
        const handler = (_a = deps.bridgeWindow.tex64Bridge) !== null && _a !== void 0 ? _a : (_c = (_b = deps.bridgeWindow.webkit) === null || _b === void 0 ? void 0 : _b.messageHandlers) === null || _c === void 0 ? void 0 : _c.tex64;
        if (!handler || typeof handler.postMessage !== "function") {
            if (deps.isE2E) {
                pending.push({ payload });
                scheduleRetry();
                return true;
            }
            if (!silent) {
                deps.updateIssues(1, "ネイティブ連携が利用できません。", "error", [
                    { severity: "error", message: "ネイティブ連携が利用できません。" },
                ]);
            }
            return false;
        }
        handler.postMessage(payload);
        return true;
    };
};
