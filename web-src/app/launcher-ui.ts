import type { AppContext } from "./context.js";
import type { LauncherTemplate } from "./types.js";

type LauncherUiDeps = {
  onCreate: (template: LauncherTemplate) => void;
  onOpen: () => void;
};

export type LauncherUiApi = {
  setVisible: (isVisible: boolean) => void;
  setStatus: (payload: { isBusy?: boolean; message?: string | null }) => void;
  setTemplate: (template: LauncherTemplate) => void;
  getTemplate: () => LauncherTemplate;
  isBusy: () => boolean;
};

export const initLauncherUi = (
  context: AppContext,
  deps: LauncherUiDeps
): LauncherUiApi => {
  const {
    launcher,
    launcherCreateButton,
    launcherOpenButton,
    launcherStatus,
    launcherStatusText,
    launcherStatusSpinner,
    launcherTemplateButtons,
  } = context.dom;

  let selectedActionIndex = 0;
  let launcherTemplate: LauncherTemplate = "paper";
  let launcherBusy = false;
  let launcherMessage: string | null = null;
  const launcherActions = [launcherOpenButton, launcherCreateButton];

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
    if (payload.message !== undefined) {
      launcherMessage = payload.message ?? null;
    }
    if (launcherCreateButton instanceof HTMLButtonElement) {
      launcherCreateButton.disabled = launcherBusy;
    }
    if (launcherOpenButton instanceof HTMLButtonElement) {
      launcherOpenButton.disabled = launcherBusy;
    }
    if (!(launcherStatus instanceof HTMLElement) || !(launcherStatusText instanceof HTMLElement)) {
      return;
    }
    if (!launcherBusy && !launcherMessage) {
      launcherStatus.classList.remove("is-visible", "is-busy");
      launcherStatusText.textContent = "";
      return;
    }
    launcherStatus.classList.add("is-visible");
    launcherStatus.classList.toggle("is-busy", launcherBusy);
    launcherStatusText.textContent = launcherBusy ? "準備中..." : launcherMessage ?? "";
    if (launcherStatusSpinner instanceof HTMLElement) {
      launcherStatusSpinner.hidden = !launcherBusy;
    }
    updateActionSelection();
  };

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
  };
};
