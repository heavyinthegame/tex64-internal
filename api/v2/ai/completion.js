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
import { extractTextFromGeminiResponse, invokeGemini } from "../_lib/gemini-client.js";
import {
  assertAiFeatureEnabled,
  commitQuotaConsumption,
  loadAuthorizedAiContext,
} from "../_lib/ai-access.js";

const isObject = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));

const parseNumber = (value, fallback) => {
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

const parseInteger = (value, fallback) => {
  const parsed = parseNumber(value, Number.NaN);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.round(parsed);
};

const extractPrompt = (body) => {
  if (typeof body.prompt === "string" && body.prompt.trim()) {
    return body.prompt;
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const texts = messages
    .map((message) => {
      if (typeof message?.content === "string") {
        return message.content;
      }
      if (Array.isArray(message?.content)) {
        return message.content
          .map((entry) => (typeof entry?.text === "string" ? entry.text : ""))
          .join(" ");
      }
      return "";
    })
    .filter((entry) => typeof entry === "string" && entry.trim());
  return texts.join("\n");
};

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
    const prompt = extractPrompt(body);
    if (!prompt.trim()) {
      throw new ApiError("VALIDATION_ERROR", "prompt is required.", 400);
    }
    const upstreamRequest = {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        maxOutputTokens: Math.max(1, parseInteger(body.maxOutputTokens ?? body.max_tokens, 80)),
        temperature: parseNumber(body.temperature, 0.2),
        topP: parseNumber(body.topP ?? body.top_p, 0.9),
        topK: Math.max(1, parseInteger(body.topK ?? body.top_k, 40)),
      },
      systemInstruction:
        isObject(body.systemInstruction) && Array.isArray(body.systemInstruction.parts)
          ? body.systemInstruction
          : undefined,
    };
    const upstream = await invokeGemini(upstreamRequest, {
      geminiApiKey: config.geminiApiKey,
      geminiEndpoint: config.geminiEndpoint,
      geminiDefaultModel: config.geminiDefaultModel,
      model: typeof body.model === "string" ? body.model : null,
    });
    const text = extractTextFromGeminiResponse(upstream.raw);
    const consumedTokens = pickConsumedTokens(upstream.usageMetadata);
    const consumedTokensForQuota = Math.max(1, consumedTokens);
    const quota = await commitQuotaConsumption({
      save: context.save,
      usage: context.usage,
      featureName: "completion",
      consumedTokens: consumedTokensForQuota,
      consumedRequests: 1,
    });
    sendJson(res, 200, {
      requestId,
      output: {
        text,
      },
      usage: {
        model: upstream.model,
        inputTokens: upstream.usageMetadata.promptTokenCount,
        outputTokens: upstream.usageMetadata.candidatesTokenCount,
        totalTokens: upstream.usageMetadata.totalTokenCount,
        quotaConsumedTokens: consumedTokensForQuota,
      },
      quota,
      plan: context.subscription.plan,
    });
  } catch (error) {
    sendApiError(res, requestId, error);
  }
};

export default handler;
