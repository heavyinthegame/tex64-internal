export const createEnvStatusManager = (params: {
  postToNative: (
    payload: { type: string; [key: string]: unknown },
    silent?: boolean
  ) => boolean;
  envCheckTargets: string[];
  envDisplayTargets: string[];
  texEngineCommands: Set<string>;
}) => {
  const envCheckState = new Map<string, boolean>();
  let envCheckRetryTimer: number | null = null;
  let envCheckRetryCount = 0;
  const envCheckMaxRetries = 4;

  const renderEnvStatus = (envName: string, available: boolean | null) => {
    const item = document.querySelector(`.env-item[data-env="${envName}"]`);
    if (!item) {
      return;
    }

    const statusBadge = item.querySelector(".env-badge");
    const actionBtn = item.querySelector(".env-btn");

    if (statusBadge) {
      if (available === null) {
        statusBadge.className = "env-badge checking";
        statusBadge.textContent = "確認中...";
      } else {
        statusBadge.className = available ? "env-badge ok" : "env-badge error";
        statusBadge.textContent = available ? "利用可能" : "未検出";
      }
    }

    if (actionBtn instanceof HTMLElement) {
      actionBtn.classList.remove("is-hidden");
      if (available === null) {
        actionBtn.setAttribute("disabled", "true");
        return;
      }
      actionBtn.removeAttribute("disabled");
      actionBtn.textContent = available ? "更新/再インストール" : "インストール";
    }
  };

  const checkEnvironmentStatus = (isRetry = false) => {
    if (!isRetry) {
      envCheckRetryCount = 0;
    }
    if (envCheckRetryTimer !== null) {
      window.clearTimeout(envCheckRetryTimer);
      envCheckRetryTimer = null;
    }
    params.envDisplayTargets.forEach((envName) => renderEnvStatus(envName, null));
    params.envCheckTargets.forEach((command) => envCheckState.delete(command));
    let postedAll = true;
    params.envCheckTargets.forEach((command) => {
      if (!params.postToNative({ type: "env:check", command }, true)) {
        postedAll = false;
      }
    });
    if (postedAll) {
      envCheckRetryCount = 0;
      return;
    }
    envCheckRetryCount += 1;
    if (envCheckRetryCount >= envCheckMaxRetries) {
      envCheckRetryCount = 0;
      params.envDisplayTargets.forEach((envName) => renderEnvStatus(envName, false));
      return;
    }
    envCheckRetryTimer = window.setTimeout(() => {
      envCheckRetryTimer = null;
      checkEnvironmentStatus(true);
    }, 400);
  };

  const updateEnvStatus = (command: string, available: boolean) => {
    if (!command) {
      return;
    }
    envCheckState.set(command, available);
    if (params.texEngineCommands.has(command)) {
      const hasEngine = Array.from(params.texEngineCommands).some(
        (engine) => envCheckState.get(engine) === true
      );
      renderEnvStatus("lualatex", hasEngine);
      return;
    }
    renderEnvStatus(command, available);
  };

  return {
    checkEnvironmentStatus,
    updateEnvStatus,
  };
};
