const createGitHandlers = (deps) => {
  const { gitService, sendToRenderer, sendIssues, ensureWorkspace, isE2E } = deps;

  const handleGitStatus = async () => {
    if (isE2E) {
      return;
    }
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendToRenderer("updateGit", {
        entries: [],
        message: "ワークスペースが選択されていません。",
      });
      return;
    }
    const snapshot = await gitService.status(rootPath);
    sendToRenderer("updateGit", snapshot);
  };

  const sendGitActionResult = (action, result) => {
    sendToRenderer("gitActionResult", {
      action,
      ok: result?.ok ?? false,
      status: result?.status ?? "error",
      message: result?.message ?? null,
      hint: result?.hint ?? null,
    });
  };

  const reportGitAction = (result, fallback) => {
    const message = result?.message ?? fallback;
    const status = result?.status ?? (result?.ok ? "success" : "error");
    if (status === "success") {
      sendIssues(0, message, "success", []);
      return;
    }
    if (status === "info") {
      sendIssues(0, message, "info", []);
      return;
    }
    sendIssues(1, message, "error", [{ severity: "error", message }]);
  };

  const handleGitInit = async () => {
    if (isE2E) {
      return;
    }
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "ワークスペースが選択されていません。", "error", [
        { severity: "error", message: "ワークスペースが選択されていません." },
      ]);
      return;
    }
    const result = await gitService.init(rootPath);
    reportGitAction(result, "履歴管理の開始に失敗しました。");
    sendGitActionResult("init", result);
    await handleGitStatus();
  };

  const handleGitCommit = async (message) => {
    if (isE2E) {
      return;
    }
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "ワークスペースが選択されていません。", "error", [
        { severity: "error", message: "ワークスペースが選択されていません." },
      ]);
      return;
    }
    const result = await gitService.commit(rootPath, message);
    reportGitAction(result, "履歴の保存に失敗しました。");
    sendGitActionResult("commit", result);
    await handleGitStatus();
  };

  const handleGitSetRemote = async (url) => {
    if (isE2E) {
      return;
    }
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "ワークスペースが選択されていません。", "error", [
        { severity: "error", message: "ワークスペースが選択されていません." },
      ]);
      return;
    }
    const result = await gitService.setRemote(rootPath, url);
    reportGitAction(result, "同期先の保存に失敗しました。");
    sendGitActionResult("remote", result);
    await handleGitStatus();
  };

  const handleGitPull = async () => {
    if (isE2E) {
      return;
    }
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "ワークスペースが選択されていません。", "error", [
        { severity: "error", message: "ワークスペースが選択されていません." },
      ]);
      return;
    }
    const result = await gitService.pull(rootPath);
    reportGitAction(result, "同期に失敗しました。");
    sendGitActionResult("pull", result);
    await handleGitStatus();
  };

  const handleGitPush = async () => {
    if (isE2E) {
      return;
    }
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "ワークスペースが選択されていません。", "error", [
        { severity: "error", message: "ワークスペースが選択されていません." },
      ]);
      return;
    }
    const result = await gitService.push(rootPath);
    reportGitAction(result, "送信に失敗しました。");
    sendGitActionResult("push", result);
    await handleGitStatus();
  };

  const handleGitRestore = async (hash) => {
    if (isE2E) {
      return;
    }
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendIssues(1, "ワークスペースが選択されていません。", "error", [
        { severity: "error", message: "ワークスペースが選択されていません." },
      ]);
      return;
    }
    const result = await gitService.restore(rootPath, hash);
    reportGitAction(result, "履歴の復元に失敗しました。");
    sendGitActionResult("restore", result);
    await handleGitStatus();
  };

  const handleGitDiff = async (mode, hash) => {
    if (isE2E) {
      return;
    }
    const rootPath = ensureWorkspace();
    if (!rootPath) {
      sendToRenderer("updateGitDiff", {
        ok: false,
        mode: mode === "restore" ? "restore" : "commit",
        message: "ワークスペースが選択されていません。",
      });
      return;
    }
    const resolvedMode = mode === "restore" ? "restore" : "commit";
    const snapshot =
      resolvedMode === "restore"
        ? await gitService.getRestoreDiff(rootPath, hash)
        : await gitService.getCommitDiff(rootPath);
    sendToRenderer("updateGitDiff", {
      ok: snapshot.ok,
      mode: resolvedMode,
      hash,
      patch: snapshot.patch,
      message: snapshot.message,
    });
  };

  return {
    handleGitStatus,
    handleGitInit,
    handleGitCommit,
    handleGitSetRemote,
    handleGitPull,
    handleGitPush,
    handleGitRestore,
    handleGitDiff,
  };
};

module.exports = { createGitHandlers };
