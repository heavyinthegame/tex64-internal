export const initBridgeSender = (deps) => {
    return (payload, silent = false) => {
        var _a, _b, _c;
        const handler = (_a = deps.bridgeWindow.tex64Bridge) !== null && _a !== void 0 ? _a : (_c = (_b = deps.bridgeWindow.webkit) === null || _b === void 0 ? void 0 : _b.messageHandlers) === null || _c === void 0 ? void 0 : _c.tex64;
        if (!handler || typeof handler.postMessage !== "function") {
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
