const assertFetch = () => {
  if (typeof fetch !== "function") {
    throw new Error("fetch is not available in this runtime.");
  }
};

const DEFAULT_GEMINI_MODEL = "gemini-3-flash-preview";

const normalizeModelName = (value) => {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/^models\//i, "");
};

const requestGemini = async ({
  proxyUrl,
  model,
  contents,
  systemInstruction,
  tools,
  toolConfig,
  generationConfig,
  signal,
  onDelta,
}) => {
  if (!proxyUrl) {
    throw new Error("AI proxy URL is missing.");
  }
  assertFetch();
  const resolvedModel =
    normalizeModelName(model) ||
    normalizeModelName(process.env.GEMINI_MODEL) ||
    DEFAULT_GEMINI_MODEL;
  const body = {
    model: resolvedModel,
    contents,
    systemInstruction,
    tools,
    toolConfig,
    generationConfig,
    stream: Boolean(onDelta),
  };
  const response = await fetch(proxyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: onDelta ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  const contentType = response.headers.get("content-type") || "";
  const resolvedModelHeader = response.headers.get("x-tex64-resolved-model") || "";
  const isSse = contentType.includes("text/event-stream");
  if (onDelta && isSse && response.body) {
    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      let json = null;
      try {
        json = raw ? JSON.parse(raw) : null;
      } catch {
        json = null;
      }
      const message = json?.error?.message ?? json?.error ?? `HTTP ${response.status}`;
      throw new Error(message);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let textBuffer = "";
    const collectedParts = [];
    let usageMetadata = null;
    const flushText = () => {
      if (textBuffer) {
        collectedParts.push({ text: textBuffer });
        textBuffer = "";
      }
    };
    const handleData = (data) => {
      if (!data || data === "[DONE]") {
        return;
      }
      let json = null;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      const parts = json?.candidates?.[0]?.content?.parts ?? [];
      if (json?.usageMetadata) {
        usageMetadata = json.usageMetadata;
      }
      parts.forEach((part) => {
        if (part?.functionCall) {
          flushText();
          const functionCallPart = { functionCall: part.functionCall };
          if (typeof part.thoughtSignature === "string" && part.thoughtSignature) {
            functionCallPart.thoughtSignature = part.thoughtSignature;
          }
          if (part.thought === true) {
            functionCallPart.thought = true;
          }
          collectedParts.push(functionCallPart);
          return;
        }
        if (typeof part?.text === "string" && part.text.length > 0) {
          textBuffer += part.text;
          onDelta(part.text);
        }
      });
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const findSeparatorIndex = (value) => {
        const lfIndex = value.indexOf("\n\n");
        const crlfIndex = value.indexOf("\r\n\r\n");
        if (lfIndex === -1) {
          return crlfIndex;
        }
        if (crlfIndex === -1) {
          return lfIndex;
        }
        return Math.min(lfIndex, crlfIndex);
      };
      const separatorLength = (value, index) =>
        value.startsWith("\r\n\r\n", index) ? 4 : 2;
      let index = findSeparatorIndex(buffer);
      while (index !== -1) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + separatorLength(buffer, index));
        chunk
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .forEach((line) => {
            const data = line.replace(/^data:\s*/, "");
            handleData(data);
          });
        index = findSeparatorIndex(buffer);
      }
    }
    flushText();
    if (collectedParts.length === 0) {
      throw new Error("Empty response from AI proxy.");
    }
    const payload = { candidates: [{ content: { parts: collectedParts } }] };
    if (usageMetadata) {
      payload.usageMetadata = usageMetadata;
    }
    if (resolvedModelHeader) {
      payload.resolvedModel = resolvedModelHeader;
    }
    return payload;
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
    const message = json?.error?.message ?? json?.error ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  if (!json) {
    throw new Error("Empty response from AI proxy.");
  }
  if (resolvedModelHeader && typeof json === "object" && json !== null) {
    if (typeof json.resolvedModel !== "string" || !json.resolvedModel.trim()) {
      json.resolvedModel = resolvedModelHeader;
    }
  }
  return json;
};

module.exports = {
  DEFAULT_GEMINI_MODEL,
  requestGemini,
};
