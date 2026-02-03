import { tabConfig, type TabKey } from "./config.js";
import type { AppContext } from "./context.js";

type TabControllerDeps = {
  onFilesTabActive: () => void;
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
    sidebarPanels,
  } = context.dom;

  let activeTab: TabKey = "files";

  const normalizeTabKey = (key: string | undefined): TabKey => {
    if (key && key in tabConfig) {
      return key as TabKey;
    }
    return "files";
  };

  const setActiveTab = (tabKey: TabKey) => {
    tabs.forEach((tab) => {
      const isActive = tab.dataset.tab === tabKey;
      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-selected", isActive ? "true" : "false");
    });

    activeTab = tabKey;
    document.body.dataset.activeTab = tabKey;
    const keepFilesVisible = context.isE2E && tabKey === "blocks";
    sidebarPanels.forEach((panel) => {
      const isActive =
        panel.dataset.panel === tabKey ||
        (keepFilesVisible && panel.dataset.panel === "files");
      panel.classList.toggle("is-active", isActive);
    });
    if (tabKey === "files") {
      deps.onFilesTabActive();
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
