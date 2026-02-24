import {
  ApiError,
  createRequestId,
  handleOptionsRequest,
  readJsonBody,
  sendApiError,
  sendJson,
  setCorsHeaders,
} from "../_lib/http.js";
import { getRuntimeConfig } from "../_lib/runtime-config.js";
import { invokeGemini } from "../_lib/gemini-client.js";
import {
  assertAiFeatureEnabled,
  commitQuotaConsumption,
  loadAuthorizedAiContext,
} from "../_lib/ai-access.js";

const isObject = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));

const pickConsumedTokens = (usageMetadata) => {
  const total = Number(usageMetadata?.totalTokenCount);
  if (Number.isFinite(total)) {
    return Math.max(0, Math.round(total));
  }
  const prompt = Number(usageMetadata?.promptTokenCount);
  const candidates = Number(usageMetadata?.candidatesTokenCount);
  const fallback =
    (Number.isFinite(prompt) ? prompt : 0) + (Number.isFinite(candidates) ? candidates : 0);
  return Math.max(0, Math.round(fallback));
};

const handler = async (req, res) => {
  if (handleOptionsRequest(req, res)) {
    return;
  }
  setCorsHeaders(res);
  const requestId = createRequestId();
  try {
    if (req.method !== "POST") {
      throw new ApiError("METHOD_NOT_ALLOWED", "Method Not Allowed.", 405);
    }
    const config = getRuntimeConfig();
    const context = await loadAuthorizedAiContext(req, config);
    assertAiFeatureEnabled(context.feature);
    const body = await readJsonBody(req);
    if (!isObject(body)) {
      throw new ApiError("VALIDATION_ERROR", "JSON body is required.", 400);
    }
    if (!Array.isArray(body.contents) || body.contents.length === 0) {
      throw new ApiError("VALIDATION_ERROR", "contents is required.", 400);
    }
    const upstreamRequest = {
      contents: body.contents,
      systemInstruction: body.systemInstruction,
      tools: body.tools,
      toolConfig: body.toolConfig,
      generationConfig: body.generationConfig,
    };
    const upstream = await invokeGemini(upstreamRequest, {
      geminiApiKey: config.geminiApiKey,
      geminiEndpoint: config.geminiEndpoint,
      geminiDefaultModel: config.geminiDefaultModel,
      model: typeof body.model === "string" ? body.model : null,
    });
    const consumedTokens = pickConsumedTokens(upstream.usageMetadata);
    const consumedTokensForQuota = Math.max(1, consumedTokens);
    const quota = await commitQuotaConsumption({
      save: context.save,
      usage: context.usage,
      featureName: "chat",
      consumedTokens: consumedTokensForQuota,
      consumedRequests: 1,
    });
    const usage = {
      inputTokens: upstream.usageMetadata.promptTokenCount,
      outputTokens: upstream.usageMetadata.candidatesTokenCount,
      totalTokens: upstream.usageMetadata.totalTokenCount,
      quotaConsumedTokens: consumedTokensForQuota,
      model: upstream.model,
    };
    sendJson(res, 200, {
      requestId,
      ...upstream.raw,
      usage,
      quota,
      plan: context.subscription.plan,
    });
  } catch (error) {
    sendApiError(res, requestId, error);
  }
};

export default handler;
