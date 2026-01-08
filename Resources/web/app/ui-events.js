export const initUiEvents = (context, deps) => {
    const { tabs, editorHost, editorHostSecondary, diffModalSubmit, diffModalCancel, saveFileButton, issuesBar, } = context.dom;
    const handleSave = () => {
        deps.saveCurrentFile().catch((message) => {
            deps.updateIssues(1, message, "error", [{ severity: "error", message }]);
        });
    };
    const handleIssuesFocus = () => {
        if (deps.getCurrentIssues().length === 0) {
            return;
        }
        deps.setActiveTab("issues");
    };
    const setup = () => {
        tabs.forEach((tab) => {
            tab.addEventListener("click", () => {
                deps.setActiveTab(deps.normalizeTabKey(tab.dataset.tab));
            });
        });
        if (editorHost instanceof HTMLElement) {
            editorHost.addEventListener("mousedown", () => {
                deps.fileTree.setTreeFocus(false);
            });
        }
        if (editorHostSecondary instanceof HTMLElement) {
            editorHostSecondary.addEventListener("mousedown", () => {
                deps.fileTree.setTreeFocus(false);
            });
        }
        if (diffModalSubmit instanceof HTMLButtonElement) {
            diffModalSubmit.addEventListener("click", () => {
                var _a;
                const diffContext = deps.diffModal.getDiffContext();
                if ((diffContext === null || diffContext === void 0 ? void 0 : diffContext.type) === "gitCommit") {
                    deps.diffModal.closeDiffModal();
                    deps.gitOps.requestCommit();
                    return;
                }
                if ((diffContext === null || diffContext === void 0 ? void 0 : diffContext.type) === "gitRestore") {
                    const targetHash = diffContext.hash;
                    deps.diffModal.closeDiffModal();
                    deps.gitOps.requestRestore(targetHash);
                    return;
                }
                (_a = deps.blockInsert) === null || _a === void 0 ? void 0 : _a.applyPendingFromDiffModal();
                deps.diffModal.closeDiffModal();
            });
        }
        if (diffModalCancel instanceof HTMLButtonElement) {
            diffModalCancel.addEventListener("click", () => {
                var _a;
                deps.diffModal.closeDiffModal();
                (_a = deps.blockInsert) === null || _a === void 0 ? void 0 : _a.clearPending();
            });
        }
        if (saveFileButton instanceof HTMLButtonElement) {
            saveFileButton.addEventListener("click", () => {
                handleSave();
            });
        }
        deps.buildOps.setupActionButtons();
        deps.gitOps.setupActions();
        deps.rootSelectorUi.setupActions();
        window.addEventListener("keydown", (event) => {
            if (event.metaKey && event.key.toLowerCase() === "s") {
                event.preventDefault();
                handleSave();
            }
        });
        if (issuesBar instanceof HTMLElement) {
            issuesBar.addEventListener("click", () => {
                handleIssuesFocus();
            });
            issuesBar.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    handleIssuesFocus();
                }
            });
        }
    };
    return { setup };
};
