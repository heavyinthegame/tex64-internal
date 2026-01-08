import { tabConfig } from "./config.js";
export const initTabController = (context, deps) => {
    const { tabs, issuesBar, sidebarPanels, miniOutline, editorTitle, editorDesc, editorHint, } = context.dom;
    let activeTab = "files";
    const setText = (element, text) => {
        if (element) {
            element.textContent = text;
        }
    };
    const normalizeTabKey = (key) => {
        if (key && key in tabConfig) {
            return key;
        }
        return "files";
    };
    const setActiveTab = (tabKey) => {
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
