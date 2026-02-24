const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const fetch = require("node-fetch");
const { pipeline } = require("stream/promises");

const createMiscHandlers = (deps) => {
  const {
    envService,
    ensureUserSettings,
    workspace,
    shell,
    Notification,
    sendToRenderer,
    blocksStore,
    apiUsageService,
    platformService,
    ensureProtocolClient,
    runtimeInfo,
  } = deps;
  const { requestGemini } = require("../services/agent-llm.cjs");
  const appVersion =
    typeof runtimeInfo?.version === "string" && runtimeInfo.version.trim()
      ? runtimeInfo.version.trim()
      : "0.0.0";
  const appPlatform =
    typeof runtimeInfo?.platform === "string" && runtimeInfo.platform.trim()
      ? runtimeInfo.platform.trim()
      : process.platform;
  const appArch =
    typeof runtimeInfo?.arch === "string" && runtimeInfo.arch.trim()
      ? runtimeInfo.arch.trim()
      : process.arch;
  const strictProduction = runtimeInfo?.packaged === true;
  const defaultUpdateChannel =
    typeof process.env.TEX64_UPDATE_CHANNEL === "string" &&
    process.env.TEX64_UPDATE_CHANNEL.trim()
      ? process.env.TEX64_UPDATE_CHANNEL.trim()
      : "stable";
  const updateDownloadDir = path.join(
    typeof runtimeInfo?.userDataPath === "string" && runtimeInfo.userDataPath.trim()
      ? runtimeInfo.userDataPath.trim()
      : os.tmpdir(),
    "updates"
  );
  let latestUpdateSnapshot = null;
  let downloadedInstallerPath = null;
  let updateStatus = {
    phase: "idle",
    mode: "artifact",
    message: "更新確認待ちです。",
    progressPercent: null,
    transferredBytes: null,
    totalBytes: null,
    downloadedPath: null,
    currentVersion: appVersion,
    latestVersion: null,
    checkedAt: null,
    updatedAt: Date.now(),
    error: null,
  };
  let lastNotifiedUpdateVersion = null;

  const parseNumber = (value, fallback = 0) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return fallback;
  };

  const normalizeOAuthPathname = (value) => {
    const pathname = typeof value === "string" && value ? value : "/";
    if (pathname === "/") {
      return "/";
    }
    const normalized = pathname.replace(/\/+$/, "");
    return normalized || "/";
  };

  const isTex64OAuthCallbackUrl = (value) => {
    if (typeof value !== "string") {
      return false;
    }
    const raw = value.trim();
    if (!/^tex64:\/\//i.test(raw)) {
      return false;
    }
    try {
      const parsed = new URL(raw);
      const hostname = parsed.hostname.toLowerCase();
      const pathname = normalizeOAuthPathname(parsed.pathname || "/");
      if (hostname === "oauth" && pathname === "/callback") {
        return true;
      }
      if (!hostname && pathname === "/oauth/callback") {
        return true;
      }
      if (hostname === "account" && pathname === "/oauth/callback") {
        return true;
      }
      if (!hostname && pathname === "/account/oauth/callback") {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  const normalizeQuotaSummary = (quota, periodOverrides = {}) => {
    if (!quota || typeof quota !== "object") {
      return null;
    }
    const limitTokens = Math.max(0, Math.round(parseNumber(quota.limitTokens, 0)));
    const usedTokens = Math.max(0, Math.round(parseNumber(quota.usedTokens, 0)));
    const maxRemainingTokens = Math.max(0, limitTokens - usedTokens);
    const rawRemainingTokens = parseNumber(quota.remainingTokens, Number.NaN);
    const normalizedRemainingTokens = Number.isFinite(rawRemainingTokens)
      ? Math.max(0, Math.round(rawRemainingTokens))
      : maxRemainingTokens;
    return {
      limitTokens,
      usedTokens,
      remainingTokens: Math.min(normalizedRemainingTokens, maxRemainingTokens),
      usedRequests: Math.max(0, Math.round(parseNumber(quota.usedRequests, 0))),
      remainingRequests: Math.max(
        0,
        Math.round(parseNumber(quota.remainingRequests, 0))
      ),
      periodStart:
        typeof periodOverrides.periodStart === "string"
          ? periodOverrides.periodStart
          : typeof quota.periodStart === "string"
          ? quota.periodStart
          : null,
      periodEnd:
        typeof periodOverrides.periodEnd === "string"
          ? periodOverrides.periodEnd
          : typeof quota.periodEnd === "string"
          ? quota.periodEnd
          : null,
    };
  };

  const toUpdateErrorPayload = (error, fallbackCode = "UPDATE_ERROR") => ({
    code: typeof error?.code === "string" && error.code ? error.code : fallbackCode,
    message:
      typeof error?.message === "string" && error.message
        ? error.message
        : "アップデート処理に失敗しました。",
  });

  const emitUpdateStatus = (source = "update") => {
    sendToRenderer("platform:updateStatus", {
      source,
      status: {
        ...updateStatus,
        downloadedPath: downloadedInstallerPath,
      },
    });
  };

  const setUpdateStatus = (patch, source = "update") => {
    updateStatus = {
      ...updateStatus,
      ...(patch && typeof patch === "object" ? patch : {}),
      downloadedPath: downloadedInstallerPath,
      updatedAt: Date.now(),
    };
    emitUpdateStatus(source);
  };

  const canShowDesktopNotification = () => {
    if (typeof Notification !== "function") {
      return false;
    }
    if (typeof Notification.isSupported === "function") {
      try {
        return Notification.isSupported() === true;
      } catch {
        return false;
      }
    }
    return true;
  };

  const notifyUpdateAvailable = (update, source = "manual") => {
    if (source !== "background") {
      return;
    }
    if (!update?.hasUpdate) {
      lastNotifiedUpdateVersion = null;
      return;
    }
    const latestVersion =
      typeof update.latestVersion === "string" && update.latestVersion.trim()
        ? update.latestVersion.trim()
        : "";
    if (!latestVersion || latestVersion === lastNotifiedUpdateVersion) {
      return;
    }
    lastNotifiedUpdateVersion = latestVersion;
    if (!canShowDesktopNotification()) {
      return;
    }
    try {
      const notification = new Notification({
        title: "TeX64 のアップデート",
        body: `バージョン ${latestVersion} を利用できます。`,
        silent: true,
      });
      if (typeof notification.on === "function" && shell?.openExternal) {
        notification.on("click", () => {
          const fallbackUrl = resolveUpdateFallbackUrl();
          if (fallbackUrl) {
            shell.openExternal(fallbackUrl).catch(() => {});
          }
        });
      }
      if (typeof notification.show === "function") {
        notification.show();
      }
    } catch {
      // ignore notification failures
    }
  };

  const resolveUpdateArtifactUrl = (update = latestUpdateSnapshot) => {
    if (
      update &&
      typeof update.artifactUrl === "string" &&
      update.artifactUrl.trim()
    ) {
      return update.artifactUrl.trim();
    }
    return null;
  };

  const resolveUpdateFallbackUrl = () => {
    if (
      latestUpdateSnapshot &&
      typeof latestUpdateSnapshot.notesUrl === "string" &&
      latestUpdateSnapshot.notesUrl.trim()
    ) {
      return latestUpdateSnapshot.notesUrl.trim();
    }
    return resolveUpdateArtifactUrl() || "https://tex64.com/download";
  };

  const resolveUpdateFileName = (artifactUrl, latestVersion) => {
    if (typeof artifactUrl === "string" && artifactUrl.trim()) {
      try {
        const parsed = new URL(artifactUrl);
        const name = path.basename(parsed.pathname);
        if (name && name !== "/" && name !== ".") {
          return name;
        }
      } catch {
        // ignore malformed URL
      }
    }
    const version =
      typeof latestVersion === "string" && latestVersion.trim()
        ? latestVersion.trim()
        : "latest";
    if (appPlatform === "darwin") {
      return `tex64-${version}.dmg`;
    }
    if (appPlatform === "win32") {
      return `tex64-${version}.exe`;
    }
    return `tex64-${version}.AppImage`;
  };

  const normalizeBase64Digest = (value) => {
    if (typeof value !== "string") {
      return null;
    }
    const raw = value.trim().replace(/\s+/g, "");
    if (!raw) {
      return null;
    }
    if (/[^A-Za-z0-9+/=_-]/.test(raw)) {
      return null;
    }
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const mod = normalized.length % 4;
    if (mod === 1) {
      return null;
    }
    if (mod === 0) {
      return normalized;
    }
    return `${normalized}${"=".repeat(4 - mod)}`;
  };

  const parseSha256Digest = (value) => {
    if (typeof value !== "string") {
      return null;
    }
    let text = value.trim();
    if (!text) {
      return null;
    }
    const prefixed = text.match(/^sha[-_]?256(?:[:=\s-]+)(.+)$/i);
    if (prefixed && prefixed[1]) {
      text = prefixed[1].trim();
    }
    if (/^[a-f0-9]{64}$/i.test(text)) {
      return {
        algorithm: "sha256",
        hex: text.toLowerCase(),
      };
    }
    const normalizedBase64 = normalizeBase64Digest(text);
    if (!normalizedBase64) {
      return null;
    }
    let decoded = null;
    try {
      decoded = Buffer.from(normalizedBase64, "base64");
    } catch {
      decoded = null;
    }
    if (!decoded || decoded.length !== 32) {
      return null;
    }
    if (decoded.toString("base64") !== normalizedBase64) {
      return null;
    }
    return {
      algorithm: "sha256",
      hex: decoded.toString("hex"),
    };
  };

  const resolveExpectedArtifactDigest = (update) => {
    if (!update || typeof update !== "object") {
      return null;
    }
    const candidates = [
      update.artifactSha256,
      update.sha256,
      update.checksum,
      update.signature,
    ];
    for (const candidate of candidates) {
      const parsed = parseSha256Digest(candidate);
      if (parsed) {
        return parsed;
      }
    }
    return null;
  };

  const extractInlineText = (raw, prefix) => {
    if (typeof raw !== "string") {
      return null;
    }
    let text = raw.trim();
    if (!text) {
      return null;
    }
    if (text.startsWith("```")) {
      const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*?)```/);
      if (fence && fence[1]) {
        text = fence[1].trim();
      }
    }
    text = text.replace(/<CURSOR>/g, "");
    const newlineIndex = text.indexOf("\n");
    if (newlineIndex >= 0) {
      text = text.slice(0, newlineIndex).trimEnd();
    }
    if (typeof prefix === "string" && text.startsWith(prefix)) {
      text = text.slice(prefix.length);
    }
    return text.trimEnd() || null;
  };

  const buildUsageFromAccess = (access) => {
    if (!access || typeof access !== "object") {
      return null;
    }
    const quota = access.quota && typeof access.quota === "object" ? access.quota : null;
    return {
      authenticated: Boolean(access.authenticated),
      plan: typeof access.plan === "string" ? access.plan : null,
      period: null,
      summary: normalizeQuotaSummary(quota, {
        periodStart:
          typeof access.periodStart === "string" ? access.periodStart : null,
        periodEnd:
          typeof access.periodEnd === "string" ? access.periodEnd : null,
      }),
      byFeature: null,
      errorCode: access.allowed ? null : access.reason ?? "FEATURE_NOT_ENABLED",
      message: typeof access.message === "string" ? access.message : null,
      fetchedAt:
        typeof access.fetchedAt === "number" && Number.isFinite(access.fetchedAt)
          ? access.fetchedAt
          : Date.now(),
    };
  };

  const buildUsageFromQuota = (quota, plan, source = "completion") => {
    if (!quota || typeof quota !== "object") {
      return null;
    }
    const summary = normalizeQuotaSummary(quota);
    return {
      source,
      usage: {
        authenticated: true,
        plan: typeof plan === "string" ? plan : null,
        period: null,
        summary,
        byFeature: null,
        errorCode: null,
        message: null,
        fetchedAt: Date.now(),
      },
    };
  };

  const extractUsageMetadata = (response) => {
    if (!response || typeof response !== "object") {
      return null;
    }
    const usage = response.usageMetadata ?? response.usage ?? null;
    if (!usage || typeof usage !== "object") {
      return null;
    }
    const promptTokens = parseNumber(
      usage.promptTokenCount ??
        usage.promptTokens ??
        usage.inputTokenCount ??
        usage.inputTokens ??
        usage.input_tokens,
      0
    );
    const outputTokens = parseNumber(
      usage.candidatesTokenCount ??
        usage.outputTokenCount ??
        usage.outputTokens ??
        usage.output_tokens,
      0
    );
    const totalTokens = parseNumber(
      usage.totalTokenCount ??
        usage.totalTokens ??
        usage.quotaConsumedTokens ??
        promptTokens + outputTokens,
      promptTokens + outputTokens
    );
    return {
      promptTokens,
      outputTokens,
      totalTokens,
    };
  };

  const resolveResponseModel = (response) => {
    if (!response || typeof response !== "object") {
      return "";
    }
    const candidates = [
      response.resolvedModel,
      response.modelVersion,
      response.model,
      response.output?.model,
      response.usage?.model,
      response.usageMetadata?.model,
      response.usage_metadata?.model,
      response.token_usage?.model,
    ];
    for (const value of candidates) {
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    return "";
  };

  const buildAiBlockedMessage = (access) => {
    const reason = typeof access?.reason === "string" ? access.reason : "";
    const pricingUrl =
      typeof access?.pricingUrl === "string" && access.pricingUrl.trim()
        ? access.pricingUrl.trim()
        : "https://tex64.com/pricing";
    if (!access?.authenticated || reason === "AUTH_REQUIRED" || reason === "TOKEN_EXPIRED") {
      return "AI補完を使うには Google ログインが必要です。";
    }
    if (reason === "QUOTA_EXCEEDED") {
      return `今月のAIトークン上限に達しました。プラン変更: ${pricingUrl}`;
    }
    if (
      reason === "PLAN_REQUIRED" ||
      reason === "FEATURE_NOT_ENABLED" ||
      reason === "PAYMENT_PAST_DUE"
    ) {
      return `現在の契約状態ではAI機能を利用できません。プラン確認: ${pricingUrl}`;
    }
    return "AI補完を利用できません。";
  };

  const toErrorPayload = (error, fallbackCode = "PLATFORM_ERROR") => ({
    code: typeof error?.code === "string" && error.code ? error.code : fallbackCode,
    message:
      typeof error?.message === "string" && error.message
        ? error.message
        : "リクエスト処理に失敗しました。",
  });

  const emitPlatformAuth = async () => {
    if (!platformService) {
      return;
    }
    const auth = await platformService.getAuthSnapshot();
    sendToRenderer("platform:auth", { auth });
  };

  const clearOAuthPendingAndEmitAuth = async () => {
    if (!platformService || typeof platformService.cancelGoogleAuthPending !== "function") {
      return;
    }
    try {
      await platformService.cancelGoogleAuthPending();
    } catch {
      // ignore pending-clear errors
    }
    try {
      await emitPlatformAuth();
    } catch {
      // ignore auth snapshot errors after pending clear
    }
  };

  const emitPlatformAiAccess = async (force = false, source = "check") => {
    if (!platformService) {
      return null;
    }
    const access = await platformService.checkAiAccess({ force });
    sendToRenderer("platform:aiAccess", { source, access });
    const usage = buildUsageFromAccess(access);
    if (usage) {
      sendToRenderer("platform:usage", { source, usage });
    }
    return access;
  };

  const emitPlatformUsage = async (force = false, source = "usage") => {
    if (!platformService) {
      return null;
    }
    const usage = await platformService.fetchAiUsage({ force });
    sendToRenderer("platform:usage", { source, usage });
    return usage;
  };

  const emitPlatformUpdate = async (payload = {}, source = "update") => {
    if (!platformService || typeof platformService.fetchUpdateManifest !== "function") {
      return null;
    }
    const update = await platformService.fetchUpdateManifest({
      platform: payload.platform ?? appPlatform,
      arch: payload.arch ?? appArch,
      channel:
        typeof payload.channel === "string" && payload.channel.trim()
          ? payload.channel.trim()
          : defaultUpdateChannel,
      currentVersion: appVersion,
    });
    latestUpdateSnapshot = update;
    sendToRenderer("platform:update", { source, update });
    return update;
  };

  const handleEnvCheck = async (command) => {
    const result = await envService.checkCommand(command);
    sendToRenderer("env:checkResult", { command, available: result });
  };

  const handleEnvInstall = async (target) => {
    sendToRenderer("env:installStart", { target });
    const result = await envService.installEnvironment(target);
    sendToRenderer("env:installResult", { target, ...result });
    // Re-check relevant commands after install attempt
    if (target === "basictex") {
      const lualatex = await envService.checkCommand("lualatex");
      const latexmk = await envService.checkCommand("latexmk");
      sendToRenderer("env:checkResult", { command: "lualatex", available: lualatex });
      sendToRenderer("env:checkResult", { command: "latexmk", available: latexmk });
    } else if (target === "latexmk") {
      const available = await envService.checkCommand("latexmk");
      sendToRenderer("env:checkResult", { command: "latexmk", available });
    }
  };

  const handleBlocksSave = async (entry) => {
    const rootPath = workspace.getRootPath();
    if (!rootPath) {
      return;
    }
    let blocks = [];
    try {
      blocks = await blocksStore.load(rootPath);
    } catch {
      blocks = [];
    }
    if (entry && typeof entry === "object") {
      blocks.push(entry);
    }
    await blocksStore.save(rootPath, blocks);
  };

  const handleApiUsageGet = async () => {
    if (!apiUsageService) {
      return;
    }
    const snapshot = await apiUsageService.getSnapshot();
    sendToRenderer("api:usage", { snapshot });
  };

  const handleApiUsageReset = async () => {
    if (!apiUsageService) {
      return;
    }
    const snapshot = await apiUsageService.reset();
    sendToRenderer("api:usage", { snapshot });
  };

  const handlePlatformStateGet = async () => {
    if (!platformService) {
      return;
    }
    try {
      await emitPlatformAuth();
    } catch (error) {
      const auth = await platformService.getAuthSnapshot();
      sendToRenderer("platform:auth", { auth, error: toErrorPayload(error) });
    }
  };

  const handleFeatureCheck = async (payload) => {
    if (!platformService) {
      return;
    }
    try {
      const names = Array.isArray(payload?.names) ? payload.names : [];
      const force = payload?.force === true;
      if (names.includes("ai")) {
        await emitPlatformAiAccess(force, "manual");
      }
    } catch (error) {
      const auth = await platformService.getAuthSnapshot();
      sendToRenderer("platform:auth", { auth, error: toErrorPayload(error) });
    }
  };

  const handlePlatformUsageGet = async (payload) => {
    if (!platformService) {
      return;
    }
    try {
      await emitPlatformUsage(payload?.force === true, "manual");
    } catch (error) {
      const auth = await platformService.getAuthSnapshot();
      sendToRenderer("platform:auth", { auth, error: toErrorPayload(error) });
    }
  };

  const handleUpdateCheck = async (payload) => {
    if (!platformService || typeof platformService.fetchUpdateManifest !== "function") {
      return null;
    }
    const source = payload?.source === "background" ? "background" : "manual";
    setUpdateStatus(
      {
        phase: "checking",
        message: "更新を確認しています。",
        progressPercent: null,
        transferredBytes: null,
        totalBytes: null,
        checkedAt: null,
        error: null,
      },
      source
    );
    try {
      const update = await emitPlatformUpdate(payload, source);
      if (!update?.hasUpdate) {
        downloadedInstallerPath = null;
        lastNotifiedUpdateVersion = null;
        setUpdateStatus(
          {
            phase: "up-to-date",
            latestVersion: update?.latestVersion ?? null,
            currentVersion: update?.currentVersion ?? appVersion,
            checkedAt: update?.checkedAt ?? Date.now(),
            message: "最新バージョンを使用中です。",
            error: null,
          },
          source
        );
        return update ?? null;
      }
      downloadedInstallerPath = null;
      setUpdateStatus(
        {
          phase: "available",
          latestVersion: update.latestVersion ?? null,
          currentVersion: update.currentVersion ?? appVersion,
          checkedAt: update.checkedAt ?? Date.now(),
          message:
            typeof update.latestVersion === "string" && update.latestVersion
              ? `新しいバージョン ${update.latestVersion} を利用できます。`
              : "新しいバージョンを利用できます。",
          error: null,
        },
        source
      );
      notifyUpdateAvailable(update, source);
      return update ?? null;
    } catch (error) {
      sendToRenderer("platform:update", {
        source,
        update: null,
        error: toErrorPayload(error, "UPDATE_CHECK_FAILED"),
      });
      setUpdateStatus(
        {
          phase: "error",
          message: "更新確認に失敗しました。",
          error: toUpdateErrorPayload(error, "UPDATE_CHECK_FAILED"),
        },
        source
      );
      return null;
    }
  };

  const downloadUpdateArtifact = async (artifactUrl, latestVersion, expectedDigest) => {
    const fileName = resolveUpdateFileName(artifactUrl, latestVersion);
    await fsp.mkdir(updateDownloadDir, { recursive: true });
    const finalPath = path.join(updateDownloadDir, fileName);
    const tempPath = `${finalPath}.part`;
    if (!expectedDigest || expectedDigest.algorithm !== "sha256") {
      throw {
        code: "UPDATE_VERIFY_METADATA_MISSING",
        message: "更新ファイルの検証情報が不足しています。",
      };
    }
    let completed = false;
    try {
      const response = await fetch(artifactUrl);
      if (!response.ok || !response.body) {
        throw {
          code: "UPDATE_DOWNLOAD_FAILED",
          message: `HTTP ${response.status} で更新ファイル取得に失敗しました。`,
        };
      }
      const totalBytesRaw = Number.parseInt(response.headers.get("content-length") || "", 10);
      const totalBytes =
        Number.isFinite(totalBytesRaw) && totalBytesRaw > 0 ? totalBytesRaw : null;
      let transferredBytes = 0;
      const hash = crypto.createHash("sha256");
      response.body.on("data", (chunk) => {
        transferredBytes += chunk?.length ?? 0;
        if (chunk) {
          hash.update(chunk);
        }
        const progressPercent =
          totalBytes && totalBytes > 0
            ? Math.max(0, Math.min(100, (transferredBytes / totalBytes) * 100))
            : null;
        setUpdateStatus(
          {
            phase: "downloading",
            message: "更新ファイルをダウンロード中です。",
            progressPercent,
            transferredBytes,
            totalBytes,
            error: null,
          },
          "download"
        );
      });
      await pipeline(response.body, fs.createWriteStream(tempPath));
      const downloadedDigest = hash.digest("hex");
      if (downloadedDigest !== expectedDigest.hex) {
        throw {
          code: "UPDATE_VERIFY_MISMATCH",
          message: "更新ファイルの検証に失敗しました。再度お試しください。",
        };
      }
      await fsp.rm(finalPath, { force: true }).catch(() => {});
      await fsp.rename(tempPath, finalPath);
      downloadedInstallerPath = finalPath;
      completed = true;
      return {
        path: finalPath,
        totalBytes,
      };
    } finally {
      if (!completed) {
        await fsp.rm(tempPath, { force: true }).catch(() => {});
      }
    }
  };

  const handleUpdateDownload = async (payload) => {
    let update = latestUpdateSnapshot;
    const shouldForceCheck = payload?.forceCheck === true;
    if (!update || shouldForceCheck) {
      update = await handleUpdateCheck({ force: true });
    }
    if (!update) {
      if (updateStatus.phase === "error") {
        return;
      }
      setUpdateStatus(
        {
          phase: "up-to-date",
          message: "適用可能な更新はありません。",
          error: null,
        },
        "download"
      );
      return;
    }
    if (!update.hasUpdate) {
      setUpdateStatus(
        {
          phase: "up-to-date",
          message: "適用可能な更新はありません。",
          error: null,
        },
        "download"
      );
      return;
    }
    const artifactUrl = resolveUpdateArtifactUrl(update);
    if (!artifactUrl) {
      downloadedInstallerPath = null;
      setUpdateStatus(
        {
          phase: "error",
          message: "ダウンロードURLが見つかりません。手動ダウンロードを利用してください。",
          error: {
            code: "UPDATE_ARTIFACT_URL_MISSING",
            message: "artifactUrl が未設定です。",
          },
        },
        "download"
      );
      return;
    }
    const expectedDigest = resolveExpectedArtifactDigest(update);
    if (!expectedDigest) {
      downloadedInstallerPath = null;
      setUpdateStatus(
        {
          phase: "error",
          message: "更新ファイルの検証情報が不足しています。手動ダウンロードをご利用ください。",
          error: {
            code: "UPDATE_VERIFY_METADATA_MISSING",
            message: "manifest に sha256/checksum/signature が不足しています。",
          },
        },
        "download"
      );
      return;
    }
    downloadedInstallerPath = null;
    setUpdateStatus(
      {
        phase: "downloading",
        latestVersion: update.latestVersion ?? null,
        currentVersion: update.currentVersion ?? appVersion,
        checkedAt: update.checkedAt ?? Date.now(),
        message: "更新ファイルをダウンロード中です。",
        progressPercent: 0,
        transferredBytes: 0,
        totalBytes: null,
        error: null,
      },
      "download"
    );
    try {
      const downloaded = await downloadUpdateArtifact(
        artifactUrl,
        update.latestVersion ?? null,
        expectedDigest
      );
      setUpdateStatus(
        {
          phase: "downloaded",
          latestVersion: update.latestVersion ?? null,
          currentVersion: update.currentVersion ?? appVersion,
          checkedAt: update.checkedAt ?? Date.now(),
          message: "更新ファイルのダウンロードと検証が完了しました。",
          progressPercent: 100,
          transferredBytes: downloaded.totalBytes ?? null,
          totalBytes: downloaded.totalBytes ?? null,
          error: null,
        },
        "download"
      );
      if (payload?.autoInstall === true) {
        await handleUpdateInstall({ openFallbackOnError: true });
      }
    } catch (error) {
      setUpdateStatus(
        {
          phase: "error",
          message: "ダウンロードに失敗しました。",
          error: toUpdateErrorPayload(error, "UPDATE_DOWNLOAD_FAILED"),
        },
        "download"
      );
      if (payload?.openFallbackOnError && shell?.openExternal) {
        const fallbackUrl = resolveUpdateFallbackUrl();
        if (fallbackUrl) {
          await shell.openExternal(fallbackUrl).catch(() => {});
        }
      }
    }
  };

  const handleUpdateInstall = async (payload = {}) => {
    if (!downloadedInstallerPath) {
      setUpdateStatus(
        {
          phase: "error",
          message: "先に更新ファイルをダウンロードしてください。",
          error: {
            code: "UPDATE_INSTALL_MISSING_FILE",
            message: "インストール対象ファイルがありません。",
          },
        },
        "install"
      );
      return;
    }
    try {
      await fsp.access(downloadedInstallerPath, fs.constants.F_OK);
    } catch {
      setUpdateStatus(
        {
          phase: "error",
          message: "更新ファイルが見つかりません。再ダウンロードしてください。",
          error: {
            code: "UPDATE_INSTALL_FILE_NOT_FOUND",
            message: "更新ファイルが存在しません。",
          },
        },
        "install"
      );
      return;
    }
    setUpdateStatus(
      {
        phase: "installing",
        message: "インストーラを起動しています。",
        error: null,
      },
      "install"
    );
    try {
      const result = shell?.openPath
        ? await shell.openPath(downloadedInstallerPath)
        : "openPath is unavailable";
      if (typeof result === "string" && result.trim()) {
        throw {
          code: "UPDATE_INSTALL_OPEN_FAILED",
          message: result,
        };
      }
      setUpdateStatus(
        {
          phase: "installing",
          message: "インストーラを起動しました。画面の手順に従って更新してください。",
          error: null,
        },
        "install"
      );
    } catch (error) {
      setUpdateStatus(
        {
          phase: "error",
          message: "インストーラの起動に失敗しました。",
          error: toUpdateErrorPayload(error, "UPDATE_INSTALL_FAILED"),
        },
        "install"
      );
      if (payload?.openFallbackOnError && shell?.openExternal) {
        const fallbackUrl = resolveUpdateFallbackUrl();
        if (fallbackUrl) {
          await shell.openExternal(fallbackUrl).catch(() => {});
        }
      }
    }
  };

  const handleUpdateStatusGet = async () => {
    if (latestUpdateSnapshot) {
      sendToRenderer("platform:update", { source: "status", update: latestUpdateSnapshot });
    }
    emitUpdateStatus("status");
  };

  const handleAuthGoogleStart = async () => {
    if (!platformService) {
      return;
    }
    try {
      if (typeof ensureProtocolClient === "function") {
        try {
          ensureProtocolClient();
        } catch {
          // continue even if protocol registration fails in this runtime
        }
      }
      await emitPlatformAuth();
      const started = await platformService.startGoogleAuth();
      await emitPlatformAuth();
      if (started?.bypassed) {
        return;
      }
      const authUrl =
        typeof started?.authUrl === "string" && started.authUrl.trim()
          ? started.authUrl.trim()
          : null;
      if (!authUrl) {
        throw {
          code: "AUTH_START_INVALID_URL",
          message: "OAuth authorization URL is missing.",
        };
      }
      if (isTex64OAuthCallbackUrl(authUrl)) {
        await handleAuthGoogleCallback(authUrl);
        return;
      }
      if (!shell?.openExternal) {
        await clearOAuthPendingAndEmitAuth();
        throw {
          code: "AUTH_BROWSER_UNAVAILABLE",
          message: "External browser is unavailable in this runtime.",
        };
      }
      try {
        await shell.openExternal(authUrl);
      } catch (error) {
        await clearOAuthPendingAndEmitAuth();
        throw {
          code: "AUTH_BROWSER_OPEN_FAILED",
          message:
            typeof error?.message === "string" && error.message
              ? error.message
              : "Failed to open OAuth page in external browser.",
        };
      }
    } catch (error) {
      const auth = await platformService.getAuthSnapshot();
      sendToRenderer("platform:auth", { auth, error: toErrorPayload(error, "AUTH_START_FAILED") });
    }
  };

  const handleAuthGoogleCallback = async (callbackUrl) => {
    if (!platformService) {
      return;
    }
    try {
      await platformService.completeGoogleAuthFromCallback(callbackUrl);
      await emitPlatformAuth();
      await emitPlatformAiAccess(true, "auth");
      await emitPlatformUsage(true, "auth");
    } catch (error) {
      const auth = await platformService.getAuthSnapshot();
      sendToRenderer("platform:auth", {
        auth,
        error: toErrorPayload(error, "AUTH_CALLBACK_FAILED"),
      });
    }
  };

  const handleAuthSignOut = async () => {
    if (!platformService) {
      return;
    }
    try {
      await platformService.signOut();
      await emitPlatformAuth();
      await emitPlatformAiAccess(true, "auth");
      await emitPlatformUsage(true, "auth");
    } catch (error) {
      const auth = await platformService.getAuthSnapshot();
      sendToRenderer("platform:auth", { auth, error: toErrorPayload(error, "AUTH_SIGNOUT_FAILED") });
    }
  };

  const handleAuthGoogleCancel = async () => {
    if (!platformService || typeof platformService.cancelGoogleAuthPending !== "function") {
      return;
    }
    try {
      await platformService.cancelGoogleAuthPending();
      await emitPlatformAuth();
      await emitPlatformAiAccess(true, "auth");
      await emitPlatformUsage(true, "auth");
    } catch (error) {
      const auth = await platformService.getAuthSnapshot();
      sendToRenderer("platform:auth", {
        auth,
        error: toErrorPayload(error, "AUTH_CANCEL_FAILED"),
      });
    }
  };

  const handleOpenExternal = async (url) => {
    if (!shell?.openExternal) {
      return;
    }
    const normalized = typeof url === "string" ? url.trim() : "";
    if (!/^https?:\/\//i.test(normalized)) {
      return;
    }
    try {
      await shell.openExternal(normalized);
    } catch {
      // ignore browser launch failures
    }
  };

  const handleFeedbackSend = async (payload) => {
    if (!platformService || typeof platformService.submitFeedback !== "function") {
      return;
    }
    const message =
      typeof payload?.message === "string" && payload.message.trim()
        ? payload.message.trim()
        : "";
    const category =
      typeof payload?.category === "string" && payload.category.trim()
        ? payload.category.trim()
        : "general";
    if (!message) {
      sendToRenderer("platform:feedback", {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "フィードバック内容が空です。",
        },
      });
      return;
    }
    const contactEmail =
      typeof payload?.contactEmail === "string" && payload.contactEmail.trim()
        ? payload.contactEmail.trim()
        : null;
    const diagnostics =
      payload?.diagnostics && typeof payload.diagnostics === "object"
        ? payload.diagnostics
        : null;
    try {
      const response = await platformService.submitFeedback(
        {
          category,
          message,
          contactEmail,
          app: {
            version: appVersion,
            platform: `${appPlatform}-${appArch}`,
          },
          diagnostics,
        },
        {}
      );
      sendToRenderer("platform:feedback", {
        ok: true,
        feedbackId: response?.feedbackId ?? null,
      });
    } catch (error) {
      sendToRenderer("platform:feedback", {
        ok: false,
        error: toErrorPayload(error, "FEEDBACK_SEND_FAILED"),
      });
    }
  };

  const handleErrorReportSend = async (payload) => {
    if (!platformService || typeof platformService.submitErrorReport !== "function") {
      return;
    }
    const raw =
      payload?.report && typeof payload.report === "object"
        ? payload.report
        : payload && typeof payload === "object"
        ? payload
        : null;
    if (!raw) {
      return;
    }
    const report = {
      ...raw,
      source:
        typeof raw.source === "string" && raw.source.trim()
          ? raw.source.trim()
          : "app-renderer",
      appVersion:
        typeof raw.appVersion === "string" && raw.appVersion.trim()
          ? raw.appVersion.trim()
          : appVersion,
      diagnostics:
        raw.diagnostics && typeof raw.diagnostics === "object"
          ? {
              ...raw.diagnostics,
              platform: `${appPlatform}-${appArch}`,
            }
          : {
              platform: `${appPlatform}-${appArch}`,
            },
    };
    try {
      await platformService.submitErrorReport(report, {});
    } catch {
      // ignore reporting failures
    }
  };

  const handleApiGhostCompletion = async (payload) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const requestId =
      typeof payload.requestId === "string" ? payload.requestId : null;
    if (!requestId) {
      return;
    }
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    const prefix = typeof payload.prefix === "string" ? payload.prefix : "";
    const timeoutMs =
      typeof payload.timeoutMs === "number" && Number.isFinite(payload.timeoutMs)
        ? payload.timeoutMs
        : 3500;
    const maxOutputTokens =
      typeof payload.maxOutputTokens === "number" &&
      Number.isFinite(payload.maxOutputTokens)
        ? payload.maxOutputTokens
        : 40;
    const temperature =
      typeof payload.temperature === "number" && Number.isFinite(payload.temperature)
        ? payload.temperature
        : 0.2;
    const topP =
      typeof payload.topP === "number" && Number.isFinite(payload.topP) ? payload.topP : 0.9;
    const topK =
      typeof payload.topK === "number" && Number.isFinite(payload.topK) ? payload.topK : 40;
    const agentSettings = await ensureUserSettings().getAgentSettings().catch(() => null);
    const chatModel =
      typeof agentSettings?.model === "string" && agentSettings.model.trim()
        ? agentSettings.model.trim()
        : "gemini-3-flash-preview";
    const inlineModel =
      typeof agentSettings?.inlineModel === "string" && agentSettings.inlineModel.trim()
        ? agentSettings.inlineModel.trim()
        : chatModel;

    if (platformService) {
      const access = await emitPlatformAiAccess(false, "completion");
      if (!access?.allowed) {
        sendToRenderer("api:completionResult", {
          requestId,
          ok: false,
          error: buildAiBlockedMessage(access),
        });
        return;
      }
    }

    if (!prompt.trim()) {
      sendToRenderer("api:completionResult", {
        requestId,
        ok: false,
        error: "empty prompt",
      });
      return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.max(800, timeoutMs));
    try {
      let response = null;
      let rawText = "";
      if (
        platformService &&
        typeof platformService.requestAiCompletion === "function"
      ) {
        const completion = await platformService.requestAiCompletion(
          {
            model: inlineModel,
            prompt,
            prefix,
            maxOutputTokens,
            temperature,
            topP,
            topK,
            timeoutMs,
          },
          { signal: controller.signal }
        );
        response =
          completion?.raw && typeof completion.raw === "object"
            ? {
                ...completion.raw,
                ...(completion?.resolvedModel ? { resolvedModel: completion.resolvedModel } : {}),
              }
            : completion?.raw ?? null;
        rawText = typeof completion?.text === "string" ? completion.text : "";
        const platformUsage = buildUsageFromQuota(
          completion?.quota ?? null,
          completion?.plan ?? null,
          "completion"
        );
        if (platformUsage) {
          sendToRenderer("platform:usage", platformUsage);
        }
      } else {
        if (strictProduction) {
          throw {
            code: "INLINE_COMPLETION_BACKEND_UNAVAILABLE",
            message: "AI補完バックエンドを初期化できませんでした。",
          };
        }
        const proxyUrl =
          typeof process.env.TEX64_AI_PROXY_URL === "string"
            ? process.env.TEX64_AI_PROXY_URL.trim()
            : "";
        const resolvedProxy =
          proxyUrl || "https://tex64.vercel.app/api/ai-chat";
        response = await requestGemini({
          proxyUrl: resolvedProxy,
          model: inlineModel,
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }],
            },
          ],
          systemInstruction: {
            parts: [
              {
                text: [
                  "You are a high-precision LaTeX inline copilot.",
                  "Return ONLY the continuation text to insert at <CURSOR>.",
                  "Do not repeat the prefix already typed by the user.",
                  "Prefer useful, immediately actionable continuation over generic phrases.",
                  "Keep LaTeX syntax coherent and compile-safe.",
                  "Stay concise (typically one line). If confidence is low, return empty.",
                ].join(" "),
              },
            ],
          },
          generationConfig: {
            maxOutputTokens,
            temperature,
            topP,
            topK,
            stopSequences: ["\n"],
          },
          signal: controller.signal,
        });
        const parts = response?.candidates?.[0]?.content?.parts ?? [];
        rawText = parts
          .map((part) => part?.text)
          .filter((text) => typeof text === "string")
          .join("");
      }
      const text = extractInlineText(rawText, prefix);

      let usageSnapshot = null;
      const usage = extractUsageMetadata(response);
      if (apiUsageService && usage) {
        usageSnapshot = await apiUsageService.recordUsage({
          model: resolveResponseModel(response) || "unknown",
          promptTokens: usage.promptTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          source: "inline",
        });
        if (usageSnapshot) {
          sendToRenderer("api:usage", { snapshot: usageSnapshot });
        }
      }

      sendToRenderer("api:completionResult", {
        requestId,
        ok: true,
        text,
        usageSnapshot: usageSnapshot ?? undefined,
      });
    } catch (error) {
      sendToRenderer("api:completionResult", {
        requestId,
        ok: false,
        error: error?.message ?? "api error",
      });
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return {
    handleEnvCheck,
    handleEnvInstall,
    handleBlocksSave,
    handleApiUsageGet,
    handleApiUsageReset,
    handlePlatformStateGet,
    handleFeatureCheck,
    handlePlatformUsageGet,
    handleUpdateCheck,
    handleUpdateDownload,
    handleUpdateInstall,
    handleUpdateStatusGet,
    handleAuthGoogleStart,
    handleAuthGoogleCallback,
    handleAuthGoogleCancel,
    handleAuthSignOut,
    handleOpenExternal,
    handleFeedbackSend,
    handleErrorReportSend,
    handleApiGhostCompletion,
  };
};

module.exports = { createMiscHandlers };
