export const initContextMenu = (context) => {
    const { contextMenu, contextMenuPanel } = context.dom;
    let menuOpen = false;
    const close = () => {
        if (!contextMenu || !contextMenuPanel) {
            menuOpen = false;
            return;
        }
        menuOpen = false;
        contextMenu.classList.remove("is-open");
        contextMenu.setAttribute("aria-hidden", "true");
        contextMenuPanel.innerHTML = "";
    };
    const open = (x, y, items) => {
        if (!contextMenu || !contextMenuPanel) {
            return;
        }
        contextMenuPanel.innerHTML = "";
        items.forEach((item) => {
            if (item.type === "separator") {
                const separator = document.createElement("div");
                separator.className = "context-menu-separator";
                contextMenuPanel.appendChild(separator);
                return;
            }
            const button = document.createElement("button");
            button.type = "button";
            button.className = "context-menu-item";
            button.textContent = item.label;
            if (item.shortcut) {
                const shortcut = document.createElement("span");
                shortcut.className = "context-menu-shortcut";
                shortcut.textContent = item.shortcut;
                button.appendChild(shortcut);
            }
            if (item.danger) {
                button.classList.add("is-danger");
            }
            const enabled = item.enabled !== false;
            button.disabled = !enabled;
            if (enabled) {
                button.addEventListener("click", () => {
                    item.action();
                    close();
                });
            }
            contextMenuPanel.appendChild(button);
        });
        contextMenu.classList.add("is-open");
        contextMenu.setAttribute("aria-hidden", "false");
        menuOpen = true;
        requestAnimationFrame(() => {
            const rect = contextMenuPanel.getBoundingClientRect();
            let left = x;
            let top = y;
            const padding = 8;
            if (left + rect.width > window.innerWidth - padding) {
                left = window.innerWidth - rect.width - padding;
            }
            if (top + rect.height > window.innerHeight - padding) {
                top = window.innerHeight - rect.height - padding;
            }
            if (left < padding) {
                left = padding;
            }
            if (top < padding) {
                top = padding;
            }
            contextMenuPanel.style.left = `${left}px`;
            contextMenuPanel.style.top = `${top}px`;
        });
    };
    if (contextMenuPanel instanceof HTMLElement) {
        contextMenuPanel.addEventListener("click", (event) => {
            event.stopPropagation();
        });
        contextMenuPanel.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
    }
    if (contextMenu instanceof HTMLElement) {
        contextMenu.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        contextMenu.addEventListener("click", (event) => {
            if (!menuOpen) {
                return;
            }
            const target = event.target;
            if (contextMenuPanel instanceof HTMLElement && target instanceof Node) {
                if (contextMenuPanel.contains(target)) {
                    return;
                }
            }
            close();
        });
    }
    document.addEventListener("click", () => {
        if (menuOpen) {
            close();
        }
    });
    window.addEventListener("blur", () => {
        if (menuOpen) {
            close();
        }
    });
    window.addEventListener("scroll", () => {
        if (menuOpen) {
            close();
        }
    }, true);
    window.addEventListener("resize", () => {
        if (menuOpen) {
            close();
        }
    });
    window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && menuOpen) {
            event.preventDefault();
            close();
        }
    });
    return { open, close, isOpen: () => menuOpen };
};
