const STORAGE_KEY_SIDEBAR = "tex64.layout.sidebarVisible";
const STORAGE_KEY_BOTTOM = "tex64.layout.bottomPanelVisible";
const STORAGE_KEY_BOTTOM_HEIGHT = "tex64.layout.bottomPanelHeight";
const MIN_PANEL_HEIGHT = 120;
const MAX_PANEL_HEIGHT = 600;
const DEFAULT_PANEL_HEIGHT = 220;
export const initBottomPanelUi = (context) => {
    const { bottomPanel, bottomPanelResizer, bottomPanelClose, bottomPanelBody, toggleSidebarButton, toggleBottomPanelButton, } = context.dom;
    const editorSection = document.querySelector("section.editor");
    const mainEl = document.querySelector(".main");
    const blockCompose = document.querySelector(".block-compose");
    const sidebarBlocksBody = document.querySelector(".blocks-panel");
    let sidebarVisible = true;
    let bottomPanelOpen = false;
    let panelHeight = DEFAULT_PANEL_HEIGHT;
    /** remember where block-compose originally lived */
    let blockComposeOriginalParent = sidebarBlocksBody;
    // --- Persistence ---
    const loadState = () => {
        try {
            const sv = localStorage.getItem(STORAGE_KEY_SIDEBAR);
            if (sv !== null)
                sidebarVisible = sv !== "false";
            const bv = localStorage.getItem(STORAGE_KEY_BOTTOM);
            if (bv !== null)
                bottomPanelOpen = bv === "true";
            const bh = localStorage.getItem(STORAGE_KEY_BOTTOM_HEIGHT);
            if (bh !== null) {
                const parsed = parseInt(bh, 10);
                if (Number.isFinite(parsed)) {
                    panelHeight = Math.max(MIN_PANEL_HEIGHT, Math.min(MAX_PANEL_HEIGHT, parsed));
                }
            }
        }
        catch { /* ignore */ }
    };
    const saveState = () => {
        try {
            localStorage.setItem(STORAGE_KEY_SIDEBAR, String(sidebarVisible));
            localStorage.setItem(STORAGE_KEY_BOTTOM, String(bottomPanelOpen));
            localStorage.setItem(STORAGE_KEY_BOTTOM_HEIGHT, String(panelHeight));
        }
        catch { /* ignore */ }
    };
    // --- DOM manipulation ---
    const moveBlocksToBottom = () => {
        if (!blockCompose || !bottomPanelBody)
            return;
        if (blockCompose.parentElement === bottomPanelBody)
            return;
        bottomPanelBody.appendChild(blockCompose);
    };
    const moveBlocksToSidebar = () => {
        if (!blockCompose || !blockComposeOriginalParent)
            return;
        if (blockCompose.parentElement === blockComposeOriginalParent)
            return;
        blockComposeOriginalParent.appendChild(blockCompose);
    };
    // --- Apply layout ---
    const applyBottomPanel = () => {
        if (!editorSection || !bottomPanel)
            return;
        if (bottomPanelOpen) {
            editorSection.classList.add("has-bottom-panel");
            editorSection.style.setProperty("--bottom-panel-height", `${panelHeight}px`);
            bottomPanel.setAttribute("aria-hidden", "false");
            moveBlocksToBottom();
        }
        else {
            editorSection.classList.remove("has-bottom-panel");
            editorSection.style.removeProperty("--bottom-panel-height");
            bottomPanel.setAttribute("aria-hidden", "true");
            moveBlocksToSidebar();
        }
        // Toggle button state
        if (toggleBottomPanelButton) {
            toggleBottomPanelButton.classList.toggle("is-active", bottomPanelOpen);
            toggleBottomPanelButton.setAttribute("aria-pressed", String(bottomPanelOpen));
        }
    };
    const applySidebar = () => {
        if (!mainEl)
            return;
        mainEl.classList.toggle("sidebar-collapsed", !sidebarVisible);
        if (toggleSidebarButton) {
            toggleSidebarButton.classList.toggle("is-active", sidebarVisible);
            toggleSidebarButton.setAttribute("aria-pressed", String(sidebarVisible));
        }
    };
    // --- Public API ---
    const openBottomPanel = () => {
        bottomPanelOpen = true;
        applyBottomPanel();
        saveState();
    };
    const closeBottomPanel = () => {
        bottomPanelOpen = false;
        applyBottomPanel();
        saveState();
    };
    const toggleBottomPanel = () => {
        bottomPanelOpen = !bottomPanelOpen;
        applyBottomPanel();
        saveState();
    };
    const isBottomPanelOpen = () => bottomPanelOpen;
    const toggleSidebar = () => {
        sidebarVisible = !sidebarVisible;
        applySidebar();
        saveState();
        // Trigger Monaco editor relayout after sidebar collapse/expand
        window.dispatchEvent(new Event("resize"));
    };
    const isSidebarVisible = () => sidebarVisible;
    // --- Resizer drag ---
    const initResizer = () => {
        if (!bottomPanelResizer || !editorSection)
            return;
        let startY = 0;
        let startHeight = 0;
        const onMouseMove = (e) => {
            e.preventDefault();
            const delta = startY - e.clientY;
            const newHeight = Math.max(MIN_PANEL_HEIGHT, Math.min(MAX_PANEL_HEIGHT, startHeight + delta));
            panelHeight = newHeight;
            editorSection.style.setProperty("--bottom-panel-height", `${panelHeight}px`);
        };
        const onMouseUp = () => {
            document.removeEventListener("mousemove", onMouseMove);
            document.removeEventListener("mouseup", onMouseUp);
            bottomPanelResizer.classList.remove("is-resizing");
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            saveState();
            window.dispatchEvent(new Event("resize"));
        };
        bottomPanelResizer.addEventListener("mousedown", (e) => {
            e.preventDefault();
            startY = e.clientY;
            startHeight = panelHeight;
            bottomPanelResizer.classList.add("is-resizing");
            document.body.style.cursor = "row-resize";
            document.body.style.userSelect = "none";
            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
        });
    };
    // --- Event listeners ---
    if (toggleSidebarButton) {
        toggleSidebarButton.addEventListener("click", toggleSidebar);
    }
    if (toggleBottomPanelButton) {
        toggleBottomPanelButton.addEventListener("click", toggleBottomPanel);
    }
    if (bottomPanelClose) {
        bottomPanelClose.addEventListener("click", closeBottomPanel);
    }
    // --- Init ---
    loadState();
    applySidebar();
    applyBottomPanel();
    initResizer();
    return {
        openBottomPanel,
        closeBottomPanel,
        toggleBottomPanel,
        isBottomPanelOpen,
        toggleSidebar,
        isSidebarVisible,
    };
};
