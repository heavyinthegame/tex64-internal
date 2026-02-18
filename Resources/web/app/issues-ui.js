import { getIssueResolution } from "./issue-resolution.js";
export const initIssuesUi = (context, deps) => {
    const { issuesList, issuesEmpty } = context.dom;
    const render = (issues) => {
        if (!(issuesList instanceof HTMLElement) || !(issuesEmpty instanceof HTMLElement)) {
            return;
        }
        issuesList.innerHTML = "";
        if (issues.length === 0) {
            issuesList.style.display = "none";
            issuesEmpty.style.display = "block";
            return;
        }
        issuesEmpty.style.display = "none";
        issuesList.style.display = "flex";
        issues.forEach((issue) => {
            var _a;
            const detail = deps.parseIssueDetail(issue);
            const item = document.createElement("button");
            item.type = "button";
            item.className = "issue-item";
            item.dataset.severity = issue.severity;
            if (issue.action) {
                item.dataset.action = issue.action;
            }
            const header = document.createElement("div");
            header.className = "issue-header";
            const badge = document.createElement("span");
            badge.className = `issue-badge issue-badge-${issue.severity}`;
            badge.textContent = issue.severity === "warning" ? "警告" : "エラー";
            const location = document.createElement("span");
            location.className = "issue-location";
            if (detail.path && detail.line) {
                location.textContent = `${detail.path}:${detail.line}`;
            }
            else if (detail.path) {
                location.textContent = detail.path;
            }
            else if (detail.line) {
                location.textContent = `行 ${detail.line}`;
            }
            else {
                location.textContent = "位置不明";
            }
            header.append(badge, location);
            const message = document.createElement("div");
            message.className = "issue-message";
            message.textContent = detail.message || issue.message;
            const detailBlock = document.createElement("div");
            detailBlock.className = "issue-extra";
            const resolution = document.createElement("div");
            resolution.className = "issue-resolution";
            const hint = document.createElement("div");
            hint.className = "issue-hintline";
            const isRuntimeAction = issue.action === "open-runtime" && typeof deps.onOpenRuntimeSettings === "function";
            const hasJumpTarget = Boolean(detail.path || detail.line);
            item.disabled = !isRuntimeAction && !hasJumpTarget;
            const resolutionText = (_a = getIssueResolution(issue)) !== null && _a !== void 0 ? _a : "";
            const showResolution = Boolean(resolutionText) && (issue.severity === "error" || isRuntimeAction);
            resolution.textContent = resolutionText;
            hint.textContent = isRuntimeAction
                ? "クリックでRuntimeを開く"
                : hasJumpTarget
                    ? "クリックで移動"
                    : "移動先なし";
            if (showResolution) {
                detailBlock.append(resolution);
            }
            detailBlock.append(hint);
            item.append(header, message, detailBlock);
            item.addEventListener("click", () => {
                var _a;
                if (isRuntimeAction) {
                    (_a = deps.onOpenRuntimeSettings) === null || _a === void 0 ? void 0 : _a.call(deps);
                    return;
                }
                if (!hasJumpTarget) {
                    return;
                }
                deps.onFocusIssue(issue);
            });
            issuesList.appendChild(item);
        });
    };
    return { render };
};
