const setText = (element, text) => {
    if (element) {
        element.textContent = text;
    }
};
const setElementHidden = (element, hidden) => {
    if (element) {
        element.hidden = hidden;
    }
};
const formatGitStatusLabel = (status) => {
    const normalized = status.replace(/\s+/g, "");
    if (normalized === "??") {
        return "新規";
    }
    if (normalized.includes("U")) {
        return "競合";
    }
    if (normalized.includes("R")) {
        return "名前変更";
    }
    if (normalized.includes("D")) {
        return "削除";
    }
    if (normalized.includes("A")) {
        return "追加";
    }
    if (normalized.includes("M")) {
        return "変更";
    }
    return normalized || "変更";
};
const renderGitStatus = (target, entries, message) => {
    if (!(target instanceof HTMLElement)) {
        return;
    }
    target.innerHTML = "";
    if (entries.length === 0) {
        const empty = document.createElement("div");
        empty.className = "panel-placeholder";
        empty.textContent = message;
        target.appendChild(empty);
        return;
    }
    entries.forEach((entry) => {
        const item = document.createElement("div");
        item.className = "git-item";
        const title = document.createElement("div");
        title.className = "git-item-title";
        title.textContent = formatGitStatusLabel(entry.status);
        const meta = document.createElement("div");
        meta.className = "git-item-meta";
        meta.textContent = entry.path;
        item.append(title, meta);
        target.appendChild(item);
    });
};
const renderGitHistory = (target, entries, message, state) => {
    if (!(target instanceof HTMLElement)) {
        return;
    }
    target.innerHTML = "";
    if (entries.length === 0) {
        const empty = document.createElement("div");
        empty.className = "panel-placeholder";
        empty.textContent = message;
        target.appendChild(empty);
        return;
    }
    const canRestoreBase = state.repoState.ok &&
        !state.busy &&
        state.statusEntries.length === 0 &&
        !state.branchState.detached;
    entries.forEach((entry, index) => {
        const item = document.createElement("div");
        item.className = "git-history-item";
        if (index === 0) {
            item.dataset.current = "true";
        }
        const title = document.createElement("div");
        title.className = "git-history-title";
        title.textContent = entry.message || "履歴";
        const meta = document.createElement("div");
        meta.className = "git-history-meta";
        meta.textContent = `${entry.date} · ${entry.shortHash}${index === 0 ? " · 現在" : ""}`;
        const actions = document.createElement("div");
        actions.className = "git-history-actions";
        const restore = document.createElement("button");
        restore.type = "button";
        restore.className = "panel-button ghost";
        restore.textContent = "この時点に戻す";
        restore.dataset.gitAction = "restore";
        restore.dataset.hash = entry.hash;
        restore.dataset.shortHash = entry.shortHash;
        restore.dataset.message = entry.message;
        restore.disabled = !canRestoreBase || index === 0;
        actions.appendChild(restore);
        item.append(title, meta, actions);
        target.appendChild(item);
    });
};
const buildGitSummaryMessage = (state) => {
    var _a;
    if (state.busy) {
        return (_a = state.busyMessage) !== null && _a !== void 0 ? _a : "処理中...";
    }
    if (!state.workspaceRootKey) {
        return "ワークスペースが未選択です。";
    }
    if (state.repoState.reason === "git-missing") {
        return "この環境では履歴管理を使えません。";
    }
    if (!state.repoState.ok) {
        return "履歴管理がまだ有効ではありません。";
    }
    return "履歴を保存して同期できます。";
};
const buildGitSyncMessage = (state) => {
    var _a, _b;
    if (!state.repoState.ok) {
        return "履歴管理を有効にすると同期できます。";
    }
    if (!state.remoteState.exists) {
        return "同期先が未設定です。";
    }
    if (state.branchState.detached) {
        return "現在の状態では同期できません。";
    }
    if (state.entries.length > 0) {
        return "送受信の前に履歴に保存してください。";
    }
    const ahead = (_a = state.branchState.ahead) !== null && _a !== void 0 ? _a : 0;
    const behind = (_b = state.branchState.behind) !== null && _b !== void 0 ? _b : 0;
    if (ahead > 0 && behind > 0) {
        return "送受信の両方が必要です。";
    }
    if (ahead > 0) {
        return "送る準備ができています。";
    }
    if (behind > 0) {
        return "受け取りが必要です。";
    }
    return "同期されています。";
};
export const renderGitPanel = (context, state) => {
    var _a, _b;
    const { gitStatus, gitHistory, gitSummaryText, gitGuide, gitGuideText, gitSyncText, gitInitRow, gitInitButton, gitCommitMessage, gitCommitButton, gitCommitSection, gitHistorySection, gitSyncSection, gitRemoteSection, gitPullButton, gitPushButton, gitRemoteInput, gitRemoteSaveButton, gitRefreshButton, } = context.dom;
    renderGitStatus(gitStatus, state.entries, state.message);
    renderGitHistory(gitHistory, state.historyEntries, state.historyMessage, {
        repoState: state.repoState,
        busy: state.busy,
        branchState: state.branchState,
        statusEntries: state.entries,
    });
    if (gitSummaryText instanceof HTMLElement) {
        setText(gitSummaryText, buildGitSummaryMessage(state));
    }
    if (gitGuide instanceof HTMLElement && gitGuideText instanceof HTMLElement) {
        setElementHidden(gitGuide, !state.guideMessage);
        setText(gitGuideText, (_a = state.guideMessage) !== null && _a !== void 0 ? _a : "");
    }
    if (gitSyncText instanceof HTMLElement) {
        setText(gitSyncText, buildGitSyncMessage(state));
    }
    const repoReady = state.repoState.ok;
    const hasWorkspace = Boolean(state.workspaceRootKey);
    const gitUnavailable = state.repoState.reason === "git-missing";
    const hasChanges = state.entries.length > 0;
    const branchDetached = state.branchState.detached === true;
    const canCommit = repoReady && hasChanges && !state.busy;
    const canSync = repoReady && state.remoteState.exists && !branchDetached && !hasChanges && !state.busy;
    setElementHidden(gitInitRow, repoReady || gitUnavailable || !hasWorkspace);
    setElementHidden(gitCommitSection, !repoReady);
    setElementHidden(gitHistorySection, !repoReady);
    setElementHidden(gitSyncSection, !repoReady);
    setElementHidden(gitRemoteSection, !repoReady);
    if (gitInitButton instanceof HTMLButtonElement) {
        gitInitButton.disabled = state.busy || !hasWorkspace || repoReady || gitUnavailable;
    }
    if (gitCommitMessage instanceof HTMLInputElement) {
        gitCommitMessage.disabled = !repoReady || state.busy;
    }
    if (gitCommitButton instanceof HTMLButtonElement) {
        gitCommitButton.disabled = !canCommit;
    }
    if (gitPullButton instanceof HTMLButtonElement) {
        gitPullButton.disabled = !canSync;
    }
    if (gitPushButton instanceof HTMLButtonElement) {
        gitPushButton.disabled = !canSync;
    }
    if (gitRemoteInput instanceof HTMLInputElement) {
        gitRemoteInput.disabled = !repoReady || state.busy;
        if (document.activeElement !== gitRemoteInput) {
            gitRemoteInput.value = (_b = state.remoteState.url) !== null && _b !== void 0 ? _b : "";
        }
    }
    if (gitRemoteSaveButton instanceof HTMLButtonElement) {
        gitRemoteSaveButton.disabled = !repoReady || state.busy;
    }
    if (gitRefreshButton instanceof HTMLButtonElement) {
        gitRefreshButton.disabled = state.busy;
    }
};
