import type { ApiCompletionResultPayload, ApiUsageSnapshot } from "./types.js";

type ApiCompletionRequest = {
  prompt: string;
  prefix: string;
  maxOutputTokens: number;
  temperature: number;
  topP: number;
  topK: number;
  timeoutMs: number;
};

type ApiCompletionBroker = {
  requestCompletion: (
    payload: ApiCompletionRequest
  ) => Promise<{ text: string | null; usageSnapshot?: ApiUsageSnapshot }>;
  handleCompletionResult: (payload: ApiCompletionResultPayload) => void;
  handleUsage: (payload: { snapshot?: ApiUsageSnapshot }) => void;
  getLatestUsage: () => ApiUsageSnapshot | null;
};

const buildRequestId = (() => {
  let counter = 0;
  return () => `api-${Date.now().toString(36)}-${counter++}`;
})();

export const createApiCompletionBroker = (
  postToNative: (payload: { type: string; [key: string]: unknown }, silent?: boolean) => boolean
): ApiCompletionBroker => {
  const pending = new Map<
    string,
    {
      resolve: (value: { text: string | null; usageSnapshot?: ApiUsageSnapshot }) => void;
      timeoutId: number;
    }
  >();
  let latestUsage: ApiUsageSnapshot | null = null;

  const requestCompletion = (payload: ApiCompletionRequest) => {
    const requestId = buildRequestId();
    const timeoutMs = Number.isFinite(payload.timeoutMs) ? payload.timeoutMs : 3500;
    return new Promise<{ text: string | null; usageSnapshot?: ApiUsageSnapshot }>((resolve) => {
      const timeoutId = window.setTimeout(() => {
        pending.delete(requestId);
        resolve({ text: null });
      }, Math.max(800, timeoutMs + 200));
      pending.set(requestId, { resolve, timeoutId });
      postToNative(
        {
          type: "api:ghostCompletion",
          requestId,
          prompt: payload.prompt,
          prefix: payload.prefix,
          maxOutputTokens: payload.maxOutputTokens,
          temperature: payload.temperature,
          topP: payload.topP,
          topK: payload.topK,
          timeoutMs,
        },
        true
      );
    });
  };

  const handleCompletionResult = (payload: ApiCompletionResultPayload) => {
    if (!payload || typeof payload.requestId !== "string") {
      return;
    }
    const entry = pending.get(payload.requestId);
    if (!entry) {
      if (payload.usageSnapshot) {
        latestUsage = payload.usageSnapshot;
      }
      return;
    }
    pending.delete(payload.requestId);
    window.clearTimeout(entry.timeoutId);
    if (payload.usageSnapshot) {
      latestUsage = payload.usageSnapshot;
    }
    if (payload.ok === false) {
      entry.resolve({ text: null, usageSnapshot: payload.usageSnapshot });
      return;
    }
    entry.resolve({
      text: typeof payload.text === "string" ? payload.text : null,
      usageSnapshot: payload.usageSnapshot,
    });
  };

  const handleUsage = (payload: { snapshot?: ApiUsageSnapshot }) => {
    if (payload?.snapshot) {
      latestUsage = payload.snapshot;
    }
  };

  const getLatestUsage = () => latestUsage;

  return {
    requestCompletion,
    handleCompletionResult,
    handleUsage,
    getLatestUsage,
  };
};
