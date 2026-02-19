const crypto = require("crypto");
const path = require("path");
const fsp = require("fs/promises");
const { requestGemini } = require("./agent-llm.cjs");

const FEATURE_CACHE_TTL_MS = 60_000;
const USAGE_CACHE_TTL_MS = 60_000;
const TOKEN_REFRESH_LEEWAY_MS = 60_000;

const DEFAULT_STATE = {
  deviceId: null,
  session: null,
  oauthPending: null,
  aiAccessCache: null,
  aiAccessFetchedAt: 0,
  aiUsageCache: null,
  aiUsageFetchedAt: 0,
};

const clone = (value) => JSON.parse(JSON.stringify(value));

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

const sanitizeBaseUrl = (value, fallback) => {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return raw.replace(/\/+$/, "");
};

const parseDate = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

const parseInteger = (value, fallback = 0) => {
  const numeric = parseNumber(value, fallback);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.round(numeric);
};

const resolveModelLabel = (payload) => {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const candidates = [
    payload.resolvedModel,
    payload.modelVersion,
    payload.model,
    payload.output?.model,
    payload.usage?.model,
    payload.usageMetadata?.model,
    payload.usage_metadata?.model,
    payload.token_usage?.model,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
};

const sanitizeHttpUrl = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const url = value.trim();
  if (!/^https?:\/\//i.test(url)) {
    return null;
  }
  return url;
};

const sanitizeDigestText = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const digest = value.trim();
  if (digest.length > 512) {
    return null;
  }
  return digest;
};

const parseVersionTokens = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  return value
    .trim()
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      if (/^\d+$/.test(token)) {
        return Number.parseInt(token, 10);
      }
      return token.toLowerCase();
    });
};

const compareVersionValues = (left, right) => {
  const leftTokens = parseVersionTokens(left);
  const rightTokens = parseVersionTokens(right);
  const maxLength = Math.max(leftTokens.length, rightTokens.length);
  for (let index = 0; index < maxLength; index += 1) {
    const a = leftTokens[index];
    const b = rightTokens[index];
    if (a === undefined && b === undefined) {
      return 0;
    }
    if (a === undefined) {
      if (typeof b === "number") {
        if (b === 0) {
          continue;
        }
        return -1;
      }
      return 1;
    }
    if (b === undefined) {
      if (typeof a === "number") {
        if (a === 0) {
          continue;
        }
        return 1;
      }
      return -1;
    }
    if (a === b) {
      continue;
    }
    if (typeof a === "number" && typeof b === "number") {
      return a > b ? 1 : -1;
    }
    if (typeof a === "number") {
      return 1;
    }
    if (typeof b === "number") {
      return -1;
    }
    return a > b ? 1 : -1;
  }
  return 0;
};

const toBase64Url = (buffer) =>
  buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

class PlatformApiError extends Error {
  constructor(code, message, status = 0, details = null) {
    super(message || code || "Platform API error");
    this.name = "PlatformApiError";
    this.code = typeof code === "string" && code ? code : "PLATFORM_ERROR";
    this.status = Number.isFinite(status) ? status : 0;
    this.details = details;
  }
}

class PlatformAccessService {
  constructor(options = {}) {
    this.filePath = path.join(
      options.userDataPath || ".",
      "tex64-platform-session.json"
    );
    this.state = null;
    this.apiBaseUrl = sanitizeBaseUrl(
      options.apiBaseUrl ||
        process.env.TEX64_PLATFORM_API_BASE_URL ||
        "https://tex64.com/v2",
      "https://tex64.com/v2"
    );
    this.webBaseUrl = sanitizeBaseUrl(
      options.webBaseUrl || process.env.TEX64_PLATFORM_WEB_BASE_URL || "https://tex64.com",
      "https://tex64.com"
    );
    this.redirectUri =
      options.redirectUri ||
      process.env.TEX64_PLATFORM_OAUTH_REDIRECT_URI ||
      "tex64://oauth/callback";
    this.legacyProxyUrl = sanitizeBaseUrl(
      options.legacyProxyUrl ||
        process.env.TEX64_AI_PROXY_URL ||
        "https://tex64.vercel.app/api/ai-chat",
      "https://tex64.vercel.app/api/ai-chat"
    );
    this.bypassEntitlement =
      options.bypassEntitlement === true ||
      process.env.TEX64_AI_BYPASS_ENTITLEMENT === "1" ||
      process.env.TEX64_E2E_HEADLESS === "1" ||
      (typeof process.env.TEX64_E2E_USERDATA === "string" &&
        process.env.TEX64_E2E_USERDATA.trim().length > 0);
  }

  async load() {
    if (this.state) {
      return clone(this.state);
    }
    const stored = await fsp
      .readFile(this.filePath, "utf8")
      .then((content) => JSON.parse(content))
      .catch(() => null);
    this.state = {
      ...clone(DEFAULT_STATE),
      ...(stored && typeof stored === "object" ? stored : {}),
    };
    return clone(this.state);
  }

  async save() {
    if (!this.state) {
      return;
    }
    await fsp.writeFile(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  async ensureLoadedState() {
    if (!this.state) {
      await this.load();
    }
    return this.state;
  }

  async ensureDeviceId() {
    const state = await this.ensureLoadedState();
    if (typeof state.deviceId === "string" && state.deviceId.trim()) {
      return state.deviceId;
    }
    state.deviceId =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : toBase64Url(crypto.randomBytes(18));
    this.state = state;
    await this.save();
    return state.deviceId;
  }

  buildAuthSnapshot() {
    const session = this.state?.session ?? null;
    const user = session?.user && typeof session.user === "object" ? session.user : null;
    return {
      authenticated: Boolean(session?.accessToken),
      pending: Boolean(this.state?.oauthPending),
      user: user
        ? {
            id: typeof user.id === "string" ? user.id : null,
            email: typeof user.email === "string" ? user.email : null,
            name: typeof user.name === "string" ? user.name : null,
          }
        : null,
      plan: typeof session?.plan === "string" ? session.plan : null,
      pricingUrl: this.getPricingUrl(),
    };
  }

  async getAuthSnapshot() {
    await this.ensureLoadedState();
    return this.buildAuthSnapshot();
  }

  getPricingUrl() {
    return `${this.webBaseUrl}/pricing`;
  }

  clearCaches() {
    if (!this.state) {
      return;
    }
    this.state.aiAccessCache = null;
    this.state.aiAccessFetchedAt = 0;
    this.state.aiUsageCache = null;
    this.state.aiUsageFetchedAt = 0;
  }

  normalizeSessionPayload(payload, fallbackSession = null) {
    const accessToken =
      typeof payload?.accessToken === "string" && payload.accessToken.trim()
        ? payload.accessToken.trim()
        : null;
    if (!accessToken) {
      throw new PlatformApiError("AUTH_INVALID_RESPONSE", "Missing access token.", 0, payload);
    }
    const refreshToken =
      typeof payload?.refreshToken === "string" && payload.refreshToken.trim()
        ? payload.refreshToken.trim()
        : fallbackSession?.refreshToken ?? null;
    const expiresInSec = parseNumber(payload?.expiresInSec, 900);
    const expiresAt = Date.now() + Math.max(60, Math.round(expiresInSec)) * 1000;
    const currentUser =
      payload?.user && typeof payload.user === "object" ? payload.user : fallbackSession?.user;
    const user =
      currentUser && typeof currentUser === "object"
        ? {
            id: typeof currentUser.id === "string" ? currentUser.id : null,
            email: typeof currentUser.email === "string" ? currentUser.email : null,
            name: typeof currentUser.name === "string" ? currentUser.name : null,
          }
        : null;
    const plan =
      typeof payload?.plan === "string"
        ? payload.plan
        : typeof payload?.user?.plan === "string"
        ? payload.user.plan
        : fallbackSession?.plan ?? null;
    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: expiresAt,
      user,
      plan,
      updatedAt: Date.now(),
    };
  }

  async requestJson(url, options = {}) {
    if (typeof fetch !== "function") {
      throw new PlatformApiError(
        "PLATFORM_FETCH_UNAVAILABLE",
        "fetch is not available in this runtime."
      );
    }
    const method = options.method || "GET";
    const headers = {
      Accept: "application/json",
      ...(options.headers && typeof options.headers === "object" ? options.headers : {}),
    };
    const init = {
      method,
      headers,
    };
    if (options.signal) {
      init.signal = options.signal;
    }
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (error?.name === "AbortError") {
        throw error;
      }
      throw new PlatformApiError(
        "NETWORK_ERROR",
        error?.message || "Network error while contacting platform API."
      );
    }
    const raw = await response.text().catch(() => "");
    let json = null;
    if (raw) {
      try {
        json = JSON.parse(raw);
      } catch {
        json = null;
      }
    }
    if (!response.ok) {
      const code =
        (json && typeof json === "object" && (json.error?.code || json.code)) ||
        `HTTP_${response.status}`;
      const message =
        (json && typeof json === "object" && (json.error?.message || json.message)) ||
        `HTTP ${response.status}`;
      throw new PlatformApiError(code, message, response.status, json);
    }
    return json && typeof json === "object" ? json : {};
  }

  async refreshAccessToken(force = false) {
    const state = await this.ensureLoadedState();
    const session = state.session;
    if (!session || !session.accessToken) {
      throw new PlatformApiError("AUTH_REQUIRED", "Sign in is required.");
    }
    const expiresAt = parseNumber(session.accessTokenExpiresAt, 0);
    if (!force && expiresAt - Date.now() > TOKEN_REFRESH_LEEWAY_MS) {
      return session.accessToken;
    }
    if (!session.refreshToken) {
      return session.accessToken;
    }
    const refreshed = await this.requestJson(`${this.apiBaseUrl}/auth/refresh`, {
      method: "POST",
      body: {
        refreshToken: session.refreshToken,
        deviceId: await this.ensureDeviceId(),
      },
    });
    state.session = this.normalizeSessionPayload(refreshed, session);
    this.clearCaches();
    this.state = state;
    await this.save();
    return state.session.accessToken;
  }

  async authorizedRequest(pathname, options = {}) {
    const run = async (forceRefresh = false) => {
      const token = await this.refreshAccessToken(forceRefresh);
      return this.requestJson(`${this.apiBaseUrl}${pathname}`, {
        ...options,
        headers: {
          ...(options.headers && typeof options.headers === "object" ? options.headers : {}),
          Authorization: `Bearer ${token}`,
        },
      });
    };
    try {
      return await run(false);
    } catch (error) {
      if (
        error instanceof PlatformApiError &&
        (error.status === 401 || error.code === "TOKEN_EXPIRED")
      ) {
        return run(true);
      }
      throw error;
    }
  }

  buildQuotaSnapshot(quota) {
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
      periodStart: parseDate(quota.periodStart),
      periodEnd: parseDate(quota.periodEnd),
    };
  }

  buildUsageSnapshotFromQuota(quota, plan, options = {}) {
    const normalized = this.buildQuotaSnapshot(quota);
    return {
      authenticated:
        typeof options.authenticated === "boolean" ? options.authenticated : true,
      plan: typeof plan === "string" && plan ? plan : null,
      period: typeof options.period === "string" ? options.period : null,
      summary: normalized,
      byFeature:
        options.byFeature && typeof options.byFeature === "object"
          ? options.byFeature
          : null,
      errorCode:
        typeof options.errorCode === "string" && options.errorCode
          ? options.errorCode
          : null,
      message:
        typeof options.message === "string" && options.message ? options.message : null,
      fetchedAt: Date.now(),
    };
  }

  normalizeUsageMetadata(usage) {
    if (!usage || typeof usage !== "object") {
      return null;
    }
    const promptTokenCount = parseInteger(
      usage.promptTokenCount ??
        usage.promptTokens ??
        usage.inputTokenCount ??
        usage.inputTokens ??
        usage.input_tokens,
      0
    );
    const candidatesTokenCount = parseInteger(
      usage.candidatesTokenCount ??
        usage.outputTokenCount ??
        usage.outputTokens ??
        usage.output_tokens,
      0
    );
    const totalTokenCount = parseInteger(
      usage.totalTokenCount ??
        usage.totalTokens ??
        usage.quotaConsumedTokens ??
        promptTokenCount + candidatesTokenCount,
      promptTokenCount + candidatesTokenCount
    );
    return {
      promptTokenCount: Math.max(0, promptTokenCount),
      candidatesTokenCount: Math.max(0, candidatesTokenCount),
      totalTokenCount: Math.max(0, totalTokenCount),
    };
  }

  buildTextOnlyCandidate(text) {
    if (typeof text !== "string" || !text.trim()) {
      return null;
    }
    return {
      role: "model",
      parts: [{ text }],
    };
  }

  extractTextFromOpenAiContent(content) {
    if (typeof content === "string") {
      return content;
    }
    if (!Array.isArray(content)) {
      return "";
    }
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object") {
          if (typeof part.text === "string") {
            return part.text;
          }
          if (typeof part.input_text === "string") {
            return part.input_text;
          }
        }
        return "";
      })
      .filter(Boolean)
      .join("");
  }

  convertFunctionDeclarationsToOpenAiTools(tools) {
    if (!Array.isArray(tools)) {
      return [];
    }
    const declarations = [];
    tools.forEach((entry) => {
      if (Array.isArray(entry?.functionDeclarations)) {
        declarations.push(...entry.functionDeclarations);
      }
    });
    return declarations
      .filter((declaration) => declaration && typeof declaration.name === "string")
      .map((declaration) => ({
        type: "function",
        function: {
          name: declaration.name,
          description:
            typeof declaration.description === "string" ? declaration.description : "",
          parameters:
            declaration.parameters && typeof declaration.parameters === "object"
              ? declaration.parameters
              : { type: "object", properties: {} },
        },
      }));
  }

  mapGeminiToolModeToOpenAiChoice(toolConfig) {
    const mode = toolConfig?.functionCallingConfig?.mode;
    if (mode === "AUTO") {
      return "auto";
    }
    if (mode === "NONE") {
      return "none";
    }
    if (mode === "ANY") {
      return "required";
    }
    return undefined;
  }

  buildOpenAiMessagesFromGeminiContents(contents, systemInstruction) {
    const messages = [];
    const systemText = this.extractTextFromOpenAiContent(systemInstruction?.parts ?? []);
    if (systemText.trim()) {
      messages.push({ role: "system", content: systemText });
    }
    if (!Array.isArray(contents)) {
      return messages;
    }
    const pendingToolCalls = [];
    const nextToolCallId = (name, index) =>
      `call_${name || "tool"}_${index}_${Math.random().toString(16).slice(2, 8)}`;
    contents.forEach((entry, contentIndex) => {
      const role = typeof entry?.role === "string" ? entry.role : "user";
      const parts = Array.isArray(entry?.parts) ? entry.parts : [];
      if (role === "user") {
        const text = this.extractTextFromOpenAiContent(parts);
        if (text.trim()) {
          messages.push({ role: "user", content: text });
        }
        return;
      }
      if (role === "model") {
        const text = this.extractTextFromOpenAiContent(parts);
        const toolCalls = parts
          .filter((part) => part?.functionCall)
          .map((part, idx) => {
            const call = part.functionCall;
            const callId =
              typeof call?.id === "string" && call.id
                ? call.id
                : nextToolCallId(call?.name, contentIndex * 10 + idx);
            pendingToolCalls.push({
              id: callId,
              name: typeof call?.name === "string" ? call.name : "",
            });
            const args =
              call && typeof call.args === "object" ? JSON.stringify(call.args) : "{}";
            return {
              id: callId,
              type: "function",
              function: {
                name: typeof call?.name === "string" ? call.name : "",
                arguments: args,
              },
            };
          });
        if (text.trim() || toolCalls.length > 0) {
          messages.push({
            role: "assistant",
            content: text || "",
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          });
        }
        return;
      }
      if (role === "tool") {
        parts
          .filter((part) => part?.functionResponse)
          .forEach((part, idx) => {
            const response = part.functionResponse;
            const responseName =
              typeof response?.name === "string" ? response.name : "";
            let toolCallId = null;
            const queueIndex = pendingToolCalls.findIndex(
              (entry) => entry.name === responseName
            );
            if (queueIndex >= 0) {
              toolCallId = pendingToolCalls[queueIndex].id;
              pendingToolCalls.splice(queueIndex, 1);
            } else {
              toolCallId = nextToolCallId(responseName, contentIndex * 10 + idx);
            }
            messages.push({
              role: "tool",
              tool_call_id: toolCallId,
              name: responseName || undefined,
              content: JSON.stringify(
                response?.response && typeof response.response === "object"
                  ? response.response
                  : response?.response ?? {}
              ),
            });
          });
      }
    });
    return messages;
  }

  buildChatRequestBody(payload) {
    const body = payload && typeof payload === "object" ? { ...payload } : {};
    body.stream = false;
    const openAiTools = this.convertFunctionDeclarationsToOpenAiTools(body.tools);
    const openAiMessages = this.buildOpenAiMessagesFromGeminiContents(
      body.contents,
      body.systemInstruction
    );
    body.messages = openAiMessages;
    if (openAiTools.length > 0) {
      body.openaiTools = openAiTools;
      body.toolsOpenAI = openAiTools;
      body.tools_openai = openAiTools;
    }
    const openAiToolChoice = this.mapGeminiToolModeToOpenAiChoice(body.toolConfig);
    if (openAiToolChoice) {
      body.openaiToolChoice = openAiToolChoice;
      body.toolChoiceOpenAI = openAiToolChoice;
      body.tool_choice = openAiToolChoice;
    }
    if (body.generationConfig && typeof body.generationConfig === "object") {
      const generationConfig = body.generationConfig;
      const temperature = parseNumber(generationConfig.temperature, undefined);
      const topP = parseNumber(generationConfig.topP, undefined);
      const topK = parseInteger(generationConfig.topK, undefined);
      const maxOutputTokens = parseInteger(generationConfig.maxOutputTokens, undefined);
      if (typeof temperature === "number" && Number.isFinite(temperature)) {
        body.temperature = temperature;
      }
      if (typeof topP === "number" && Number.isFinite(topP)) {
        body.topP = topP;
      }
      if (typeof topK === "number" && Number.isFinite(topK)) {
        body.topK = topK;
      }
      if (typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens)) {
        body.maxOutputTokens = maxOutputTokens;
        body.max_tokens = maxOutputTokens;
      }
    }
    return body;
  }

  normalizeOpenAiChoiceToCandidate(choice) {
    const message = choice?.message;
    if (!message || typeof message !== "object") {
      return null;
    }
    const parts = [];
    const text = this.extractTextFromOpenAiContent(message.content);
    if (text.trim()) {
      parts.push({ text });
    }
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    toolCalls.forEach((toolCall) => {
      const name = toolCall?.function?.name;
      if (typeof name !== "string" || !name.trim()) {
        return;
      }
      const rawArgs = toolCall?.function?.arguments;
      let args = {};
      if (typeof rawArgs === "string" && rawArgs.trim()) {
        try {
          args = JSON.parse(rawArgs);
        } catch {
          args = {};
        }
      } else if (rawArgs && typeof rawArgs === "object") {
        args = rawArgs;
      }
      parts.push({
        functionCall: {
          id:
            typeof toolCall?.id === "string" && toolCall.id ? toolCall.id : undefined,
          name,
          args,
        },
      });
    });
    if (parts.length === 0) {
      return null;
    }
    return {
      content: {
        role: "model",
        parts,
      },
    };
  }

  normalizeCustomToolCalls(response) {
    const calls = Array.isArray(response?.toolCalls)
      ? response.toolCalls
      : Array.isArray(response?.output?.toolCalls)
      ? response.output.toolCalls
      : null;
    if (!calls || calls.length === 0) {
      return [];
    }
    return calls
      .map((call) => {
        const name = typeof call?.name === "string" ? call.name : "";
        if (!name) {
          return null;
        }
        return {
          functionCall: {
            id: typeof call?.id === "string" ? call.id : undefined,
            name,
            args: call?.args && typeof call.args === "object" ? call.args : {},
          },
        };
      })
      .filter(Boolean);
  }

  normalizeModelResponse(payload) {
    const response = payload && typeof payload === "object" ? payload : {};
    const resolvedModel = resolveModelLabel(response);
    const usageMetadata = this.normalizeUsageMetadata(
      response.usageMetadata ??
        response.usage ??
        response.usage_metadata ??
        response.token_usage ??
        null
    );
    const quota = this.buildQuotaSnapshot(
      response.quota ??
        response.summary ??
        response.usage?.quota ??
        response.output?.quota ??
        response.usage?.summary ??
        null
    );
    let candidates = Array.isArray(response.candidates) ? response.candidates : null;
    if ((!candidates || candidates.length === 0) && Array.isArray(response.choices)) {
      candidates = response.choices
        .map((choice) => this.normalizeOpenAiChoiceToCandidate(choice))
        .filter(Boolean);
    }
    if (!candidates || candidates.length === 0) {
      const output = response.output && typeof response.output === "object" ? response.output : {};
      const outputParts = Array.isArray(output.parts) ? output.parts : null;
      const outputText =
        typeof output.text === "string"
          ? output.text
          : typeof response.text === "string"
          ? response.text
          : typeof response.output_text === "string"
          ? response.output_text
          : null;
      if (outputParts && outputParts.length > 0) {
        candidates = [{ content: { role: "model", parts: outputParts } }];
      } else {
        const customToolParts = this.normalizeCustomToolCalls(response);
        if (customToolParts.length > 0) {
          candidates = [{ content: { role: "model", parts: customToolParts } }];
        }
        const candidate = this.buildTextOnlyCandidate(outputText);
        if (candidate && (!candidates || candidates.length === 0)) {
          candidates = [{ content: candidate }];
        }
      }
    }
    return {
      ...response,
      candidates: candidates ?? [],
      resolvedModel: resolvedModel || null,
      usageMetadata: usageMetadata ?? response.usageMetadata ?? null,
      quota,
      plan:
        typeof response.plan === "string"
          ? response.plan
          : typeof this.state?.session?.plan === "string"
          ? this.state.session.plan
          : null,
    };
  }

  async requestAiChat(payload, options = {}) {
    const state = await this.ensureLoadedState();
    if (this.bypassEntitlement && !state.session?.accessToken) {
      const response = await requestGemini({
        proxyUrl: this.legacyProxyUrl,
        model: payload?.model,
        contents: payload?.contents,
        systemInstruction: payload?.systemInstruction,
        tools: payload?.tools,
        toolConfig: payload?.toolConfig,
        generationConfig: payload?.generationConfig,
        signal: options.signal,
        onDelta: options.onDelta,
      });
      return this.normalizeModelResponse(response);
    }
    const body = this.buildChatRequestBody(payload);
    const response = await this.authorizedRequest("/ai/chat", {
      method: "POST",
      body,
      signal: options.signal,
    });
    const normalized = this.normalizeModelResponse(response);
    return normalized;
  }

  async requestAiCompletion(payload, options = {}) {
    const state = await this.ensureLoadedState();
    if (this.bypassEntitlement && !state.session?.accessToken) {
      const response = await requestGemini({
        proxyUrl: this.legacyProxyUrl,
        model: payload?.model,
        contents: [
          {
            role: "user",
            parts: [{ text: typeof payload?.prompt === "string" ? payload.prompt : "" }],
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
          maxOutputTokens: parseInteger(payload?.maxOutputTokens, 40),
          temperature: parseNumber(payload?.temperature, 0.2),
          topP: parseNumber(payload?.topP, 0.9),
          topK: parseInteger(payload?.topK, 40),
          stopSequences: ["\n"],
        },
        signal: options.signal,
      });
      const normalized = this.normalizeModelResponse(response);
      const text = normalized.candidates
        .flatMap((candidate) => candidate?.content?.parts ?? [])
        .map((part) => part?.text)
        .filter((entry) => typeof entry === "string")
        .join("");
      return {
        raw: response,
        text: text || null,
        resolvedModel: normalized.resolvedModel || resolveModelLabel(response) || null,
        usageMetadata: normalized.usageMetadata ?? null,
        quota: normalized.quota ?? null,
        plan: typeof state.session?.plan === "string" ? state.session.plan : null,
      };
    }
    const body = payload && typeof payload === "object" ? { ...payload } : {};
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!Array.isArray(body.messages) && prompt.trim()) {
      body.messages = [{ role: "user", content: prompt }];
    }
    const maxOutputTokens = parseInteger(body.maxOutputTokens, undefined);
    if (typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens)) {
      body.max_tokens = maxOutputTokens;
    }
    const temperature = parseNumber(body.temperature, undefined);
    if (typeof temperature === "number" && Number.isFinite(temperature)) {
      body.temperature = temperature;
    }
    const topP = parseNumber(body.topP, undefined);
    if (typeof topP === "number" && Number.isFinite(topP)) {
      body.top_p = topP;
    }
    const response = await this.authorizedRequest("/ai/completion", {
      method: "POST",
      body,
      signal: options.signal,
    });
    const usageMetadata = this.normalizeUsageMetadata(
      response.usageMetadata ??
        response.usage ??
        response.usage_metadata ??
        response.token_usage ??
        null
    );
    const quota = this.buildQuotaSnapshot(
      response.quota ??
        response.summary ??
        response.output?.quota ??
        response.usage?.quota ??
        null
    );
    let text = null;
    if (typeof response?.output?.text === "string") {
      text = response.output.text;
    } else if (typeof response?.text === "string") {
      text = response.text;
    } else if (typeof response?.output_text === "string") {
      text = response.output_text;
    } else if (Array.isArray(response?.choices)) {
      text = response.choices
        .map((choice) => {
          if (typeof choice?.text === "string") {
            return choice.text;
          }
          return this.extractTextFromOpenAiContent(choice?.message?.content);
        })
        .filter((entry) => typeof entry === "string" && entry.trim())
        .join("");
    } else if (Array.isArray(response?.candidates)) {
      text = response.candidates
        .flatMap((candidate) => candidate?.content?.parts ?? [])
        .map((part) => part?.text)
        .filter((entry) => typeof entry === "string")
        .join("");
    }
    return {
      raw: response,
      text: typeof text === "string" ? text : null,
      resolvedModel: resolveModelLabel(response) || null,
      usageMetadata,
      quota,
      plan:
        typeof response?.plan === "string"
          ? response.plan
          : typeof this.state?.session?.plan === "string"
          ? this.state.session.plan
          : null,
    };
  }

  async submitFeedback(payload, options = {}) {
    const body = payload && typeof payload === "object" ? { ...payload } : {};
    body.category =
      typeof body.category === "string" && body.category.trim()
        ? body.category.trim()
        : "general";
    body.message =
      typeof body.message === "string" && body.message.trim()
        ? body.message.trim()
        : "";
    if (!body.message) {
      throw new PlatformApiError(
        "VALIDATION_ERROR",
        "Feedback message is required.",
        400
      );
    }
    if (!body.app || typeof body.app !== "object") {
      body.app = null;
    }
    const state = await this.ensureLoadedState();
    const requestUrl = `${this.apiBaseUrl}/feedback`;
    const headers = {};
    if (state?.session?.accessToken) {
      try {
        const token = await this.refreshAccessToken(false);
        if (typeof token === "string" && token) {
          headers.Authorization = `Bearer ${token}`;
        }
      } catch {
        // Ignore auth refresh failures and submit anonymously as fallback.
      }
    }
    const response = await this.requestJson(requestUrl, {
      method: "POST",
      headers,
      body,
      signal: options.signal,
    });
    return {
      requestId:
        typeof response?.requestId === "string" ? response.requestId : null,
      feedbackId:
        typeof response?.feedbackId === "string" ? response.feedbackId : null,
      status: typeof response?.status === "string" ? response.status : "accepted",
    };
  }

  async fetchUpdateManifest(options = {}) {
    const normalizePlatform = (value) => {
      const raw = typeof value === "string" && value.trim() ? value.trim() : process.platform;
      if (raw === "darwin") {
        return "darwin";
      }
      if (raw === "win32") {
        return "win32";
      }
      if (raw === "linux") {
        return "linux";
      }
      return raw;
    };
    const platform = normalizePlatform(options.platform);
    const arch =
      typeof options.arch === "string" && options.arch.trim()
        ? options.arch.trim()
        : process.arch;
    const channel =
      typeof options.channel === "string" && options.channel.trim()
        ? options.channel.trim()
        : "stable";
    const currentVersion =
      typeof options.currentVersion === "string" && options.currentVersion.trim()
        ? options.currentVersion.trim()
        : null;
    const params = new URLSearchParams();
    params.set("platform", platform);
    params.set("arch", arch);
    params.set("channel", channel);
    const response = await this.requestJson(
      `${this.apiBaseUrl}/updates/manifest?${params.toString()}`
    );
    const latestVersion =
      typeof response?.latestVersion === "string" && response.latestVersion.trim()
        ? response.latestVersion.trim()
        : null;
    const required = Boolean(response?.required);
    const hasUpdate =
      latestVersion && currentVersion
        ? compareVersionValues(latestVersion, currentVersion) > 0
        : Boolean(latestVersion);
    return {
      platform,
      arch,
      channel,
      currentVersion,
      latestVersion,
      hasUpdate,
      required,
      notesUrl: sanitizeHttpUrl(response?.notesUrl),
      artifactUrl: sanitizeHttpUrl(response?.artifactUrl),
      artifactSha256: sanitizeDigestText(
        response?.artifactSha256 ?? response?.sha256 ?? response?.checksum
      ),
      sha256: sanitizeDigestText(response?.sha256),
      checksum: sanitizeDigestText(response?.checksum),
      signature:
        sanitizeDigestText(response?.signature),
      checkedAt: Date.now(),
    };
  }

  buildBlockedAccess(code, message, authenticated = true) {
    return {
      authenticated,
      allowed: false,
      reason: code,
      status: null,
      plan: typeof this.state?.session?.plan === "string" ? this.state.session.plan : null,
      user: this.state?.session?.user ?? null,
      quota: null,
      periodStart: null,
      periodEnd: null,
      graceEndsAt: null,
      message,
      pricingUrl: this.getPricingUrl(),
      fetchedAt: Date.now(),
    };
  }

  async fetchAiAccess(options = {}) {
    const state = await this.ensureLoadedState();
    if (this.bypassEntitlement) {
      return {
        authenticated: true,
        allowed: true,
        reason: "BYPASS",
        status: "active",
        plan: state?.session?.plan ?? "pro",
        user: state?.session?.user ?? null,
        quota: null,
        periodStart: null,
        periodEnd: null,
        graceEndsAt: null,
        message: null,
        pricingUrl: this.getPricingUrl(),
        fetchedAt: Date.now(),
      };
    }
    const force = options.force === true;
    if (!force && state.aiAccessCache && Date.now() - state.aiAccessFetchedAt < FEATURE_CACHE_TTL_MS) {
      return clone(state.aiAccessCache);
    }
    if (!state.session?.accessToken) {
      const blocked = this.buildBlockedAccess(
        "AUTH_REQUIRED",
        "Googleログインが必要です。",
        false
      );
      state.aiAccessCache = blocked;
      state.aiAccessFetchedAt = Date.now();
      this.state = state;
      await this.save();
      return clone(blocked);
    }
    try {
      const payload = await this.authorizedRequest("/me/features?names=ai");
      const feature = payload?.features?.ai ?? null;
      const quota = this.buildQuotaSnapshot(feature?.quota ?? null);
      const user = payload?.user && typeof payload.user === "object" ? payload.user : null;
      const access = {
        authenticated: true,
        allowed: Boolean(feature?.enabled),
        reason:
          typeof feature?.reason === "string" && feature.reason
            ? feature.reason
            : feature?.enabled
            ? "active"
            : "FEATURE_NOT_ENABLED",
        status: typeof feature?.status === "string" ? feature.status : null,
        plan:
          (typeof user?.plan === "string" && user.plan) ||
          (typeof state.session.plan === "string" ? state.session.plan : null),
        user: {
          id:
            (typeof user?.id === "string" && user.id) ||
            (typeof state.session.user?.id === "string" ? state.session.user.id : null),
          email:
            (typeof user?.email === "string" && user.email) ||
            (typeof state.session.user?.email === "string"
              ? state.session.user.email
              : null),
          name:
            (typeof user?.name === "string" && user.name) ||
            (typeof state.session.user?.name === "string" ? state.session.user.name : null),
        },
        quota,
        periodStart: parseDate(feature?.periodStart) || quota?.periodStart || null,
        periodEnd: parseDate(feature?.periodEnd) || quota?.periodEnd || null,
        graceEndsAt: parseDate(feature?.graceEndsAt),
        message: null,
        pricingUrl: this.getPricingUrl(),
        fetchedAt: Date.now(),
      };
      state.session = {
        ...(state.session || {}),
        plan: access.plan,
        user: access.user,
      };
      state.aiAccessCache = access;
      state.aiAccessFetchedAt = Date.now();
      this.state = state;
      await this.save();
      return clone(access);
    } catch (error) {
      const code = error instanceof PlatformApiError ? error.code : "PLATFORM_ERROR";
      const status = error instanceof PlatformApiError ? error.status : 0;
      if (
        code === "AUTH_REQUIRED" ||
        code === "TOKEN_EXPIRED" ||
        status === 401
      ) {
        state.session = null;
      }
      const blocked = this.buildBlockedAccess(
        code,
        error instanceof Error ? error.message : "AI access check failed.",
        code !== "AUTH_REQUIRED" && code !== "TOKEN_EXPIRED" && status !== 401
      );
      state.aiAccessCache = blocked;
      state.aiAccessFetchedAt = Date.now();
      this.state = state;
      await this.save();
      return clone(blocked);
    }
  }

  async fetchAiUsage(options = {}) {
    const state = await this.ensureLoadedState();
    if (this.bypassEntitlement) {
      return {
        authenticated: true,
        plan: state?.session?.plan ?? "pro",
        period: null,
        summary: null,
        byFeature: null,
        errorCode: null,
        message: null,
        fetchedAt: Date.now(),
      };
    }
    const force = options.force === true;
    if (!force && state.aiUsageCache && Date.now() - state.aiUsageFetchedAt < USAGE_CACHE_TTL_MS) {
      return clone(state.aiUsageCache);
    }
    if (!state.session?.accessToken) {
      const payload = {
        authenticated: false,
        plan: null,
        period: null,
        summary: null,
        byFeature: null,
        errorCode: "AUTH_REQUIRED",
        message: "Googleログインが必要です。",
        fetchedAt: Date.now(),
      };
      state.aiUsageCache = payload;
      state.aiUsageFetchedAt = Date.now();
      this.state = state;
      await this.save();
      return clone(payload);
    }
    try {
      const response = await this.authorizedRequest("/me/usage/ai?period=current_month");
      const summary = this.buildQuotaSnapshot(response?.summary ?? null);
      const usage = {
        authenticated: true,
        plan:
          typeof response?.plan === "string"
            ? response.plan
            : typeof state.session.plan === "string"
            ? state.session.plan
            : null,
        period: typeof response?.period === "string" ? response.period : null,
        summary,
        byFeature:
          response?.byFeature && typeof response.byFeature === "object"
            ? response.byFeature
            : null,
        errorCode: null,
        message: null,
        fetchedAt: Date.now(),
      };
      state.session = {
        ...(state.session || {}),
        plan: usage.plan,
      };
      state.aiUsageCache = usage;
      state.aiUsageFetchedAt = Date.now();
      this.state = state;
      await this.save();
      return clone(usage);
    } catch (error) {
      const code = error instanceof PlatformApiError ? error.code : "PLATFORM_ERROR";
      const status = error instanceof PlatformApiError ? error.status : 0;
      if (
        code === "AUTH_REQUIRED" ||
        code === "TOKEN_EXPIRED" ||
        status === 401
      ) {
        state.session = null;
      }
      const failed = {
        authenticated: Boolean(state.session?.accessToken),
        plan: typeof state.session?.plan === "string" ? state.session.plan : null,
        period: null,
        summary: null,
        byFeature: null,
        errorCode: code,
        message: error instanceof Error ? error.message : "AI usage check failed.",
        fetchedAt: Date.now(),
      };
      state.aiUsageCache = failed;
      state.aiUsageFetchedAt = Date.now();
      this.state = state;
      await this.save();
      return clone(failed);
    }
  }

  async checkAiAccess(options = {}) {
    return this.fetchAiAccess(options);
  }

  async startGoogleAuth() {
    const state = await this.ensureLoadedState();
    if (this.bypassEntitlement) {
      return {
        bypassed: true,
        authUrl: null,
        state: null,
      };
    }
    const deviceId = await this.ensureDeviceId();
    const verifier = toBase64Url(crypto.randomBytes(48));
    const challenge = toBase64Url(crypto.createHash("sha256").update(verifier).digest());
    const payload = await this.requestJson(`${this.apiBaseUrl}/auth/google/start`, {
      method: "POST",
      body: {
        deviceId,
        redirectUri: this.redirectUri,
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      },
    });
    const authUrl =
      typeof payload?.authUrl === "string" && payload.authUrl.trim()
        ? payload.authUrl.trim()
        : null;
    const oauthState =
      typeof payload?.state === "string" && payload.state.trim()
        ? payload.state.trim()
        : null;
    if (!authUrl || !oauthState) {
      throw new PlatformApiError("AUTH_INVALID_RESPONSE", "OAuth start response is invalid.");
    }
    state.oauthPending = {
      state: oauthState,
      codeVerifier: verifier,
      createdAt: Date.now(),
    };
    this.state = state;
    await this.save();
    return {
      bypassed: false,
      authUrl,
      state: oauthState,
    };
  }

  async completeGoogleAuthFromCallback(callbackUrl) {
    if (!callbackUrl || typeof callbackUrl !== "string") {
      throw new PlatformApiError("OAUTH_INVALID_CALLBACK", "Invalid OAuth callback URL.");
    }
    const state = await this.ensureLoadedState();
    const pending = state.oauthPending;
    if (!pending) {
      throw new PlatformApiError("OAUTH_NO_PENDING", "OAuth request was not started.");
    }
    let url;
    try {
      url = new URL(callbackUrl);
    } catch {
      throw new PlatformApiError("OAUTH_INVALID_CALLBACK", "Invalid OAuth callback URL.");
    }
    const errorParam = url.searchParams.get("error");
    if (errorParam) {
      state.oauthPending = null;
      this.state = state;
      await this.save();
      const message = url.searchParams.get("error_description") || errorParam;
      throw new PlatformApiError("OAUTH_DENIED", message);
    }
    const code = url.searchParams.get("code");
    const oauthState = url.searchParams.get("state");
    if (!code || !oauthState) {
      throw new PlatformApiError("OAUTH_INVALID_CALLBACK", "Missing OAuth code/state.");
    }
    if (oauthState !== pending.state) {
      throw new PlatformApiError("OAUTH_STATE_MISMATCH", "OAuth state does not match.");
    }
    const exchanged = await this.requestJson(`${this.apiBaseUrl}/auth/google/exchange`, {
      method: "POST",
      body: {
        code,
        state: oauthState,
        redirectUri: this.redirectUri,
        codeVerifier: pending.codeVerifier,
        deviceId: await this.ensureDeviceId(),
      },
    });
    state.session = this.normalizeSessionPayload(exchanged, state.session);
    state.oauthPending = null;
    this.clearCaches();
    this.state = state;
    await this.save();
    return this.buildAuthSnapshot();
  }

  async signOut() {
    const state = await this.ensureLoadedState();
    state.session = null;
    state.oauthPending = null;
    this.clearCaches();
    this.state = state;
    await this.save();
    return this.buildAuthSnapshot();
  }
}

module.exports = {
  PlatformAccessService,
  PlatformApiError,
};
