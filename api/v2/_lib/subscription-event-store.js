import {
  hasProcessedSubscriptionEventRecord,
  isDatabaseConfigured,
  pruneProcessedSubscriptionEventRecords,
  recordProcessedSubscriptionEvent,
} from "./db-adapter.js";
import { ApiError } from "./http.js";
import { loadPlatformState, savePlatformState } from "./state-store.js";
import { isStateFallbackEnabled } from "./state-backend.js";

const isObject = (value) =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const parseInteger = (value, fallback = 0) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
};

const normalizeSource = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : "";

const normalizeEventId = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : "";

const buildEventKey = (source, eventId) => `${source}:${eventId}`;

const ensureEventMap = (state) => {
  if (!isObject(state.processedSubscriptionEvents)) {
    state.processedSubscriptionEvents = {};
  }
  return state.processedSubscriptionEvents;
};

const pruneProcessedEventsInState = (state, maxAgeMs) => {
  const ttlMs = Math.max(0, parseInteger(maxAgeMs, 0));
  if (ttlMs <= 0) {
    return 0;
  }
  const threshold = Date.now() - ttlMs;
  const eventMap = ensureEventMap(state);
  let removed = 0;
  for (const [key, record] of Object.entries(eventMap)) {
    const createdAtMs = Date.parse(record?.createdAt || "");
    if (!Number.isFinite(createdAtMs) || createdAtMs < threshold) {
      delete eventMap[key];
      removed += 1;
    }
  }
  return removed;
};

const hasProcessedEventInState = (state, source, eventId) => {
  const eventMap = ensureEventMap(state);
  return Boolean(eventMap[buildEventKey(source, eventId)]);
};

const recordProcessedEventInState = (state, payload = {}) => {
  const source = normalizeSource(payload?.source);
  const eventId = normalizeEventId(payload?.eventId);
  if (!source || !eventId) {
    return { tracked: false, duplicate: false };
  }
  const eventMap = ensureEventMap(state);
  const key = buildEventKey(source, eventId);
  if (eventMap[key]) {
    return { tracked: true, duplicate: true };
  }
  eventMap[key] = {
    source,
    eventId,
    userId:
      typeof payload?.userId === "string" && payload.userId.trim()
        ? payload.userId.trim()
        : null,
    payload: isObject(payload?.payload) ? payload.payload : {},
    createdAt: new Date().toISOString(),
  };
  return { tracked: true, duplicate: false };
};

const requireFallback = (config) => {
  if (isStateFallbackEnabled(config)) {
    return;
  }
  throw new ApiError(
    "STATE_BACKEND_UNAVAILABLE",
    "Persistent state backend is unavailable.",
    503
  );
};

const withFallbackState = async (config, updater) => {
  requireFallback(config);
  const state = await loadPlatformState(config);
  const output = await updater(state);
  await savePlatformState(config, state);
  return output;
};

export const isSubscriptionEventProcessed = async (
  config,
  source,
  eventId,
  options = {}
) => {
  const normalizedSource = normalizeSource(source);
  const normalizedEventId = normalizeEventId(eventId);
  if (!normalizedSource || !normalizedEventId) {
    return false;
  }
  const pruneMaxAgeMs = Math.max(0, parseInteger(options.pruneMaxAgeMs, 0));
  if (isDatabaseConfigured(config)) {
    if (pruneMaxAgeMs > 0) {
      await pruneProcessedSubscriptionEventRecords(config, pruneMaxAgeMs);
    }
    return hasProcessedSubscriptionEventRecord(
      config,
      normalizedSource,
      normalizedEventId
    );
  }
  return withFallbackState(config, async (state) => {
    if (pruneMaxAgeMs > 0) {
      pruneProcessedEventsInState(state, pruneMaxAgeMs);
    }
    return hasProcessedEventInState(state, normalizedSource, normalizedEventId);
  });
};

export const markSubscriptionEventProcessed = async (
  config,
  payload = {},
  options = {}
) => {
  const pruneMaxAgeMs = Math.max(0, parseInteger(options.pruneMaxAgeMs, 0));
  if (isDatabaseConfigured(config)) {
    if (pruneMaxAgeMs > 0) {
      await pruneProcessedSubscriptionEventRecords(config, pruneMaxAgeMs);
    }
    return recordProcessedSubscriptionEvent(config, payload);
  }
  return withFallbackState(config, async (state) => {
    if (pruneMaxAgeMs > 0) {
      pruneProcessedEventsInState(state, pruneMaxAgeMs);
    }
    return recordProcessedEventInState(state, payload);
  });
};
