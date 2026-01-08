import { tabConfig, type TabKey } from "./config.js";
import type { AppContext } from "./context.js";

type TabControllerDeps = {
  onFilesTabActive: () => void;
  onGitTabActive: () => void;
  onSettingsTabActive: () => void;
  updateMathKeyboardVisibility: () => void;
};

export type TabControllerApi = {
  getActiveTab: () => TabKey;
  normalizeTabKey: (key: string | undefined) => TabKey;
  setActiveTab: (tabKey: TabKey) => void;
};

export const initTabController = (
  context: AppContext,
  deps: TabControllerDeps
): TabControllerApi => {
  const {
    tabs,
    issuesBar,
    sidebarPanels,
    miniOutline,
    editorTitle,
    editorDesc,
    editorHint,
  } = context.dom;

  let activeTab: TabKey = "files";

  const setText = (element: HTMLElement | null, text: string) => {
    if (element) {
      element.textContent = text;
    }
  };

  const normalizeTabKey = (key: string | undefined): TabKey => {
    if (key && key in tabConfig) {
      return key as TabKey;
    }
    return "files";
  };

  const setActiveTab = (tabKey: TabKey) => {
    const config = tabConfig[tabKey];

    tabs.forEach((tab) => {
      const isActive = tab.dataset.tab === tabKey;
      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-selected", isActive ? "true" : "false");
    });

    activeTab = tabKey;
    document.body.dataset.activeTab = tabKey;
    sidebarPanels.forEach((panel) => {
      const isActive = panel.dataset.panel === tabKey;
      panel.classList.toggle("is-active", isActive);
    });
    if (issuesBar instanceof HTMLElement) {
      issuesBar.setAttribute("aria-expanded", tabKey === "issues" ? "true" : "false");
    }
    setText(miniOutline, config.outline);
    setText(editorTitle, config.title);
    setText(editorDesc, config.desc);
    setText(editorHint, config.hint);
    if (tabKey === "files") {
      deps.onFilesTabActive();
    }
    if (tabKey === "git") {
      deps.onGitTabActive();
    }
    if (tabKey === "settings") {
      deps.onSettingsTabActive();
    }
    deps.updateMathKeyboardVisibility();
  };

  return {
    getActiveTab: () => activeTab,
    normalizeTabKey,
    setActiveTab,
  };
};
