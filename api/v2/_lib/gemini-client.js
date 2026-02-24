import { ApiError } from "./http.js";

const parseNumber = (value, fallback = 0) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
};

const asObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : null;

const buildUsageMetadata = (payload) => {
  const usage = asObject(
    payload?.usageMetadata ?? payload?.usage ?? payload?.usage_metadata ?? payload?.token_usage
  );
  if (!usage) {
    return {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    };
  }
  const promptTokenCount = Math.max(
    0,
    Math.round(
      parseNumber(
        usage.promptTokenCount ??
          usage.promptTokens ??
          usage.inputTokenCount ??
          usage.inputTokens ??
          usage.input_tokens,
        0
      )
    )
  );
  const candidatesTokenCount = Math.max(
    0,
    Math.round(
      parseNumber(
        usage.candidatesTokenCount ??
          usage.outputTokenCount ??
          usage.outputTokens ??
          usage.output_tokens,
        0
      )
    )
  );
  const rawTotal = Math.round(
    parseNumber(
      usage.totalTokenCount ??
        usage.totalTokens ??
        usage.quotaConsumedTokens ??
        usage.total_tokens,
      Number.NaN
    )
  );
  const totalTokenCount = Number.isFinite(rawTotal)
    ? Math.max(rawTotal, promptTokenCount + candidatesTokenCount)
    : promptTokenCount + candidatesTokenCount;
  return {
    promptTokenCount,
    candidatesTokenCount,
    totalTokenCount: Math.max(0, totalTokenCount),
  };
};

export const invokeGemini = async (requestPayload, options = {}) => {
  if (typeof fetch !== "function") {
    throw new ApiError("INTERNAL_ERROR", "fetch is not available.", 500);
  }
  const apiKey =
    typeof options.geminiApiKey === "string" ? options.geminiApiKey.trim() : "";
  if (!apiKey) {
    throw new ApiError("INTERNAL_ERROR", "GEMINI_API_KEY is not configured.", 500);
  }
  const endpointBase =
    typeof options.geminiEndpoint === "string" && options.geminiEndpoint.trim()
      ? options.geminiEndpoint.trim().replace(/\/+$/, "")
      : "https://generativelanguage.googleapis.com/v1beta/models";
  const model =
    typeof options.model === "string" && options.model.trim()
      ? options.model.trim()
      : typeof options.geminiDefaultModel === "string" && options.geminiDefaultModel.trim()
      ? options.geminiDefaultModel.trim()
      : "gemini-3-flash-preview";
  const upstreamUrl = `${endpointBase}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(
    apiKey
  )}`;
  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload),
    });
  } catch (error) {
    throw new ApiError("NETWORK_ERROR", error?.message || "Failed to call Gemini API.", 502);
  }
  const raw = await upstreamResponse.text().catch(() => "");
  let payload = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
  }
  if (!upstreamResponse.ok) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      `Gemini upstream returned HTTP ${upstreamResponse.status}.`;
    throw new ApiError("INTERNAL_ERROR", message, 502);
  }
  const responsePayload = asObject(payload) || {};
  const usageMetadata = buildUsageMetadata(responsePayload);
  return {
    raw: responsePayload,
    usageMetadata,
    model,
  };
};

const extractPartsText = (parts) => {
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("");
};

export const extractTextFromGeminiResponse = (payload) => {
  if (!asObject(payload)) {
    return "";
  }
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  for (const candidate of candidates) {
    const text = extractPartsText(candidate?.content?.parts);
    if (text) {
      return text;
    }
  }
  if (typeof payload.output?.text === "string") {
    return payload.output.text;
  }
  if (typeof payload.text === "string") {
    return payload.text;
  }
  return "";
};
