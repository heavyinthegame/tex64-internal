import type { AppContext } from "./context.js";
import type { LauncherTemplate } from "./types.js";

type RecentProject = {
  path: string;
  name: string;
  openedAt: number;
};

type LauncherUiDeps = {
  onCreate: (template: LauncherTemplate) => void;
  onOpen: () => void;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
};

export type LauncherUiApi = {
  setVisible: (isVisible: boolean) => void;
  setStatus: (payload: { isBusy?: boolean; message?: string | null }) => void;
  setTemplate: (template: LauncherTemplate) => void;
  getTemplate: () => LauncherTemplate;
  isBusy: () => boolean;
  updateRecentProjects: (projects: RecentProject[]) => void;
};

const INITIAL_VISIBLE_COUNT = 3;

export const initLauncherUi = (
  context: AppContext,
  deps: LauncherUiDeps
): LauncherUiApi => {
  const {
    launcher,
    launcherCreateButton,
    launcherOpenButton,
    launcherTemplateButtons,
    launcherRecent,
    launcherRecentList,
    launcherRecentEmpty,
    launcherRecentToggle,
  } = context.dom;

  let selectedActionIndex = 0;
  let launcherTemplate: LauncherTemplate = "paper";
  let launcherBusy = false;
  const launcherActions = [launcherOpenButton, launcherCreateButton];
  
  let recentProjects: RecentProject[] = [];
  let recentExpanded = false;

  const updateActionSelection = () => {
    launcherActions.forEach((btn, index) => {
      if (btn instanceof HTMLElement) {
        if (index === selectedActionIndex) {
          btn.classList.add("is-selected");
          requestAnimationFrame(() => btn.focus());
        } else {
          btn.classList.remove("is-selected");
        }
      }
    });
  };

  const setVisible = (isVisible: boolean) => {
    if (launcher instanceof HTMLElement) {
      launcher.classList.toggle("is-visible", isVisible);
      launcher.setAttribute("aria-hidden", isVisible ? "false" : "true");
    }
    document.body.classList.toggle("has-launcher", isVisible);
    if (isVisible) {
      selectedActionIndex = 0;
      updateActionSelection();
    }
  };

  const setTemplate = (template: LauncherTemplate) => {
    launcherTemplate = template;
    launcherTemplateButtons.forEach((button) => {
      const isActive = button.dataset.template === template;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", isActive ? "true" : "false");
    });
  };

  const setStatus = (payload: { isBusy?: boolean; message?: string | null }) => {
    if (typeof payload.isBusy === "boolean") {
      launcherBusy = payload.isBusy;
    }
    if (launcherCreateButton instanceof HTMLButtonElement) {
      launcherCreateButton.disabled = launcherBusy;
    }
    if (launcherOpenButton instanceof HTMLButtonElement) {
      launcherOpenButton.disabled = launcherBusy;
    }
  };

  const renderRecentProjects = () => {
    if (!(launcherRecentList instanceof HTMLElement)) {
      return;
    }
    launcherRecentList.innerHTML = "";
    
    const visibleProjects = recentExpanded 
      ? recentProjects 
      : recentProjects.slice(0, INITIAL_VISIBLE_COUNT);
    
    for (const project of visibleProjects) {
      const item = document.createElement("button");
      item.className = "launcher-recent-item";
      item.type = "button";
      item.dataset.path = project.path;
      
      const nameSpan = document.createElement("span");
      nameSpan.className = "launcher-recent-item-name";
      nameSpan.textContent = project.name;
      
      const pathSpan = document.createElement("span");
      pathSpan.className = "launcher-recent-item-path";
      pathSpan.textContent = project.path;
      
      item.appendChild(nameSpan);
      item.appendChild(pathSpan);
      
      item.addEventListener("click", () => {
        if (launcherBusy) return;
        setStatus({ isBusy: true, message: null });
        deps.onOpenRecent(project.path);
      });
      
      launcherRecentList.appendChild(item);
    }
    
    // Update empty state
    if (launcherRecentEmpty instanceof HTMLElement) {
      launcherRecentEmpty.style.display = recentProjects.length === 0 ? "" : "none";
    }
    
    // Update toggle button
    if (launcherRecentToggle instanceof HTMLElement) {
      const hasMore = recentProjects.length > INITIAL_VISIBLE_COUNT;
      launcherRecentToggle.style.display = hasMore ? "" : "none";
      launcherRecentToggle.setAttribute("aria-expanded", recentExpanded ? "true" : "false");
      const toggleText = launcherRecentToggle.querySelector(".launcher-recent-toggle-text");
      if (toggleText) {
        toggleText.textContent = recentExpanded ? "折りたたむ" : "すべて表示";
      }
    }
    
    // Update recent section visibility
    if (launcherRecent instanceof HTMLElement) {
      launcherRecent.style.display = "";
    }
  };

  const updateRecentProjects = (projects: RecentProject[]) => {
    recentProjects = projects;
    renderRecentProjects();
  };

  // Toggle handler for recent projects
  if (launcherRecentToggle instanceof HTMLElement) {
    launcherRecentToggle.addEventListener("click", () => {
      recentExpanded = !recentExpanded;
      renderRecentProjects();
    });
  }

  const handleLauncherKeydown = (event: KeyboardEvent) => {
    if (!launcher?.classList.contains("is-visible")) {
      return;
    }
    if (event.key === "ArrowDown") {
      selectedActionIndex = (selectedActionIndex + 1) % launcherActions.length;
      updateActionSelection();
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowUp") {
      selectedActionIndex =
        (selectedActionIndex - 1 + launcherActions.length) % launcherActions.length;
      updateActionSelection();
      event.preventDefault();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const currentBtn = launcherActions[selectedActionIndex];
      if (currentBtn instanceof HTMLButtonElement && !currentBtn.disabled) {
        currentBtn.click();
      }
    }
  };

  window.addEventListener("keydown", handleLauncherKeydown);

  launcherTemplateButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const template = button.dataset.template === "lecture" ? "lecture" : "paper";
      setTemplate(template);
    });
  });

  if (launcherCreateButton instanceof HTMLButtonElement) {
    launcherCreateButton.addEventListener("click", () => {
      if (launcherBusy) {
        return;
      }
      setStatus({ isBusy: true, message: null });
      deps.onCreate(launcherTemplate);
    });
  }

  if (launcherOpenButton instanceof HTMLButtonElement) {
    launcherOpenButton.addEventListener("click", () => {
      if (launcherBusy) {
        return;
      }
      setStatus({ isBusy: true, message: null });
      deps.onOpen();
    });
  }

  setTemplate(launcherTemplate);

  return {
    setVisible,
    setStatus,
    setTemplate,
    getTemplate: () => launcherTemplate,
    isBusy: () => launcherBusy,
    updateRecentProjects,
  };
};
