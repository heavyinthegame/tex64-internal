import { tabConfig } from "./config.js";
export const initTabController = (context, deps) => {
    const { tabs, sidebarPanels, } = context.dom;
    let activeTab = "files";
    const normalizeTabKey = (key) => {
        if (key && key in tabConfig) {
            return key;
        }
        return "files";
    };
    const setActiveTab = (tabKey) => {
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
