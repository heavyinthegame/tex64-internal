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
import { invokeGemini, invokeGeminiStream, buildUsageMetadata } from "../_lib/gemini-client.js";
import {
  assertAiFeatureEnabled,
  commitQuotaConsumption,
  loadAuthorizedAiContext,
} from "../_lib/ai-access.js";

const isObject = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));

const pickConsumedTokens = (usageMetadata) => {
  const total = Number(usageMetadata?.totalTokenCount);
  if (Number.isFinite(total)) return Math.max(0, Math.round(total));
  const prompt = Number(usageMetadata?.promptTokenCount);
  const candidates = Number(usageMetadata?.candidatesTokenCount);
  return Math.max(0, Math.round(
    (Number.isFinite(prompt) ? prompt : 0) + (Number.isFinite(candidates) ? candidates : 0)
  ));
};

const handler = async (req, res) => {
  if (handleOptionsRequest(req, res)) return;
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

    const geminiOptions = {
      geminiApiKey: config.geminiApiKey,
      geminiEndpoint: config.geminiEndpoint,
      geminiDefaultModel: config.geminiDefaultModel,
      model: typeof body.model === "string" ? body.model : null,
    };
    const upstreamRequest = {
      contents: body.contents,
      systemInstruction: body.systemInstruction,
      tools: body.tools,
      toolConfig: body.toolConfig,
      generationConfig: body.generationConfig,
    };

    const wantsStream =
      Boolean(body.stream) ||
      (typeof req.headers?.accept === "string" && req.headers.accept.includes("text/event-stream"));

    if (wantsStream) {
      const { response: upstreamResponse, model: resolvedModel } =
        await invokeGeminiStream(upstreamRequest, geminiOptions);

      res.setHeader("X-Tex64-Resolved-Model", resolvedModel);
      res.statusCode = upstreamResponse.status;

      if (!upstreamResponse.ok) {
        const raw = await upstreamResponse.text();
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(raw || "{}");
        return;
      }

      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      // Forward SSE chunks and capture the last usageMetadata event.
      let lastRawUsage = null;
      const decoder = new TextDecoder();
      let sseBuffer = "";

      req.on("close", () => upstreamResponse.body?.cancel?.());

      for await (const chunk of upstreamResponse.body) {
        res.write(chunk);
        sseBuffer += decoder.decode(chunk, { stream: true });
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const parsed = JSON.parse(line.slice(6));
              if (parsed?.usageMetadata) lastRawUsage = parsed.usageMetadata;
            } catch { /* partial chunk, skip */ }
          }
        }
      }
      res.end();

      // Commit quota after stream completes (fire-and-forget, don't fail the response).
      if (lastRawUsage) {
        const usageMetadata = buildUsageMetadata({ usageMetadata: lastRawUsage });
        const consumedTokens = Math.max(1, pickConsumedTokens(usageMetadata));
        await commitQuotaConsumption({
          save: context.save,
          usage: context.usage,
          featureName: "chat",
          consumedTokens,
          consumedRequests: 1,
        }).catch(() => null);
      }
      return;
    }

    // Non-streaming path.
    const upstream = await invokeGemini(upstreamRequest, geminiOptions);
    const consumedTokens = Math.max(1, pickConsumedTokens(upstream.usageMetadata));
    const quota = await commitQuotaConsumption({
      save: context.save,
      usage: context.usage,
      featureName: "chat",
      consumedTokens,
      consumedRequests: 1,
    });
    sendJson(res, 200, {
      requestId,
      ...upstream.raw,
      usage: {
        inputTokens: upstream.usageMetadata.promptTokenCount,
        outputTokens: upstream.usageMetadata.candidatesTokenCount,
        totalTokens: upstream.usageMetadata.totalTokenCount,
        quotaConsumedTokens: consumedTokens,
        model: upstream.model,
      },
      quota,
      plan: context.subscription.plan,
    });
  } catch (error) {
    sendApiError(res, requestId, error);
  }
};

export default handler;
