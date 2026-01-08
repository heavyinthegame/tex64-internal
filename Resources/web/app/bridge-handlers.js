export const initBridgeHandlers = (deps) => {
    var _a;
    const { bridgeWindow } = deps;
    bridgeWindow.tex180SetBuildState = (payload) => {
        deps.build.setBuildState(payload.state, payload.message);
    };
    bridgeWindow.tex180UpdateIssues = (payload) => {
        var _a, _b;
        const status = (_a = payload.status) !== null && _a !== void 0 ? _a : (payload.count > 0 ? "error" : "success");
        deps.updateIssues(payload.count, payload.summary, status, (_b = payload.issues) !== null && _b !== void 0 ? _b : []);
    };
    bridgeWindow.tex180UpdateWorkspace = (payload) => {
        deps.handleWorkspaceUpdate(payload);
    };
    bridgeWindow.tex180UpdateIndex = (payload) => {
        deps.handleIndexUpdate(payload);
    };
    bridgeWindow.tex180UpdateSearch = (payload) => {
        deps.search.handleSearchUpdate(payload);
    };
    bridgeWindow.tex180UpdateGit = (payload) => {
        deps.git.handleUpdate(payload);
    };
    bridgeWindow.tex180UpdateGitDiff = (payload) => {
        deps.git.handleDiff(payload);
    };
    bridgeWindow.tex180UpdateGitActionResult = (payload) => {
        deps.git.handleActionResult(payload);
    };
    bridgeWindow.tex180OpenFileResult = (payload) => {
        deps.editorSession.handleOpenFileResult(payload);
    };
    bridgeWindow.tex180SaveResult = (payload) => {
        deps.editorSession.handleSaveResult(payload);
    };
    bridgeWindow.tex180FormatResult = (payload) => {
        deps.build.handleFormatResult(payload);
    };
    bridgeWindow.tex180RenameResult = (payload) => {
        deps.editorSession.handleRenameResult(payload);
    };
    const handleBridgeMessage = (message) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
        if (!(message === null || message === void 0 ? void 0 : message.type)) {
            return;
        }
        switch (message.type) {
            case "setBuildState":
                (_a = bridgeWindow.tex180SetBuildState) === null || _a === void 0 ? void 0 : _a.call(bridgeWindow, message.payload);
                break;
            case "updateIssues":
                (_b = bridgeWindow.tex180UpdateIssues) === null || _b === void 0 ? void 0 : _b.call(bridgeWindow, message.payload);
                break;
            case "updateWorkspace":
                (_c = bridgeWindow.tex180UpdateWorkspace) === null || _c === void 0 ? void 0 : _c.call(bridgeWindow, message.payload);
                break;
            case "updateIndex":
                (_d = bridgeWindow.tex180UpdateIndex) === null || _d === void 0 ? void 0 : _d.call(bridgeWindow, message.payload);
                break;
            case "updateSearch":
                (_e = bridgeWindow.tex180UpdateSearch) === null || _e === void 0 ? void 0 : _e.call(bridgeWindow, message.payload);
                break;
            case "updateGit":
                (_f = bridgeWindow.tex180UpdateGit) === null || _f === void 0 ? void 0 : _f.call(bridgeWindow, message.payload);
                break;
            case "updateGitDiff":
                (_g = bridgeWindow.tex180UpdateGitDiff) === null || _g === void 0 ? void 0 : _g.call(bridgeWindow, message.payload);
                break;
            case "gitActionResult":
                (_h = bridgeWindow.tex180UpdateGitActionResult) === null || _h === void 0 ? void 0 : _h.call(bridgeWindow, message.payload);
                break;
            case "openFileResult":
                (_j = bridgeWindow.tex180OpenFileResult) === null || _j === void 0 ? void 0 : _j.call(bridgeWindow, message.payload);
                break;
            case "saveResult":
                (_k = bridgeWindow.tex180SaveResult) === null || _k === void 0 ? void 0 : _k.call(bridgeWindow, message.payload);
                break;
            case "formatResult":
                (_l = bridgeWindow.tex180FormatResult) === null || _l === void 0 ? void 0 : _l.call(bridgeWindow, message.payload);
                break;
            case "buildLog":
                deps.build.handleBuildLog((_o = (_m = message.payload) === null || _m === void 0 ? void 0 : _m.log) !== null && _o !== void 0 ? _o : null);
                break;
            case "synctex:forwardResult":
                deps.build.handleSynctexForwardResult(message.payload);
                break;
            case "renameResult":
                (_p = bridgeWindow.tex180RenameResult) === null || _p === void 0 ? void 0 : _p.call(bridgeWindow, message.payload);
                break;
            case "launcherStatus":
                deps.handleLauncherStatus(message.payload);
                break;
            default:
                break;
        }
    };
    if ((_a = bridgeWindow.tex180Bridge) === null || _a === void 0 ? void 0 : _a.onMessage) {
        bridgeWindow.tex180Bridge.onMessage(handleBridgeMessage);
    }
};
