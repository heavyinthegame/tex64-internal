import type { AppContext } from "./context.js";
import type { IssueItem, IssuesStatus, RootSource } from "./types.js";

type RootSelectorDeps = {
  getWorkspaceRootKey: () => string | null;
  getWorkspaceFiles: () => string[];
  getRootFilePath: () => string | null;
  getRootSource: () => RootSource;
  postToNative: (
    payload: { type: string; [key: string]: unknown },
    silent?: boolean
  ) => boolean;
  updateIssues: (
    count: number,
    summary: string,
    status: IssuesStatus,
    issues: IssueItem[]
  ) => void;
};

export type RootSelectorApi = {
  render: () => void;
  setupActions: () => void;
};

export const initRootSelectorUi = (
  context: AppContext,
  deps: RootSelectorDeps
): RootSelectorApi => {
  const { settingsRootSelect, settingsRootAuto } = context.dom;

  const requestSetRoot = (path: string) => {
    if (!deps.getWorkspaceRootKey()) {
      deps.updateIssues(1, "ワークスペースが未選択です。", "error", [
        { severity: "error", message: "ワークスペースが未選択です。" },
      ]);
      return;
    }
    if (!path || path === deps.getRootFilePath()) {
      return;
    }
    deps.postToNative({ type: "setRoot", path });
  };

  const requestDetectRoot = () => {
    if (!deps.getWorkspaceRootKey()) {
      deps.updateIssues(1, "ワークスペースが未選択です。", "error", [
        { severity: "error", message: "ワークスペースが未選択です。" },
      ]);
      return;
    }
    deps.postToNative({ type: "detectRoot" });
  };

  const render = () => {
    if (!(settingsRootSelect instanceof HTMLSelectElement)) {
      return;
    }
    settingsRootSelect.innerHTML = "";
    const workspaceFiles = deps.getWorkspaceFiles();
    const workspaceRootKey = deps.getWorkspaceRootKey();
    const rootFilePath = deps.getRootFilePath();
    const rootSource = deps.getRootSource();
    const texFiles = workspaceFiles
      .filter((path) => path.toLowerCase().endsWith(".tex"))
      .sort((a, b) => a.localeCompare(b, "ja"));
    const placeholder = document.createElement("option");
    if (!workspaceRootKey) {
      placeholder.textContent = "ワークスペース未選択";
    } else if (texFiles.length === 0) {
      placeholder.textContent = "TeXファイルがありません";
    } else {
      placeholder.textContent = rootFilePath ? "メインTeX" : "メインTeXを選択";
    }
    placeholder.value = "";
    placeholder.disabled = true;
    if (!rootFilePath) {
      placeholder.selected = true;
    }
    settingsRootSelect.appendChild(placeholder);
    if (rootFilePath && !texFiles.includes(rootFilePath)) {
      const missing = document.createElement("option");
      missing.value = rootFilePath;
      missing.textContent = `${rootFilePath} (見つかりません)`;
      settingsRootSelect.appendChild(missing);
    }
    texFiles.forEach((path) => {
      const option = document.createElement("option");
      option.value = path;
      option.textContent = path;
      settingsRootSelect.appendChild(option);
    });
    settingsRootSelect.disabled = !workspaceRootKey || texFiles.length === 0;
    settingsRootSelect.value = rootFilePath ?? "";
    if (settingsRootAuto instanceof HTMLButtonElement) {
      settingsRootAuto.disabled = !workspaceRootKey || texFiles.length === 0;
      settingsRootAuto.textContent = rootSource === "manual" ? "自動に戻す" : "再検出";
    }
  };

  const setupActions = () => {
    if (settingsRootSelect instanceof HTMLSelectElement) {
      settingsRootSelect.addEventListener("change", () => {
        if (settingsRootSelect.value) {
          requestSetRoot(settingsRootSelect.value);
        }
      });
    }

    if (settingsRootAuto instanceof HTMLButtonElement) {
      settingsRootAuto.addEventListener("click", () => {
        requestDetectRoot();
      });
    }
  };

  return { render, setupActions };
};
