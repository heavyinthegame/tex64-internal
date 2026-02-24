import crypto from "node:crypto";

import {
  isDatabaseConfigured,
  persistRefreshTokenRecord,
  revokeRefreshTokensForUserDevice,
  rotateRefreshTokenRecord,
  setAuthRequestRecord,
  takeAuthRequestRecord,
  pruneAuthRequestRecords,
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

const toIsoDate = (value) => {
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) {
      return date.toISOString();
    }
  }
  return null;
};

const normalizeMetadata = (value) => (isObject(value) ? value : {});

const hashToken = (token) =>
  crypto.createHash("sha256").update(String(token || "")).digest("hex");

const requireFallbackState = (config) => {
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
  requireFallbackState(config);
  const state = await loadPlatformState(config);
  const output = await updater(state);
  await savePlatformState(config, state);
  return output;
};

const ensureAuthRequestMap = (state) => {
  if (!isObject(state.authRequests)) {
    state.authRequests = {};
  }
  return state.authRequests;
};

const ensureRefreshTokenMap = (state) => {
  if (!isObject(state.refreshTokens)) {
    state.refreshTokens = {};
  }
  return state.refreshTokens;
};

const pruneAuthRequestsInState = (state, maxAgeMs) => {
  const ttlMs = Math.max(0, parseInteger(maxAgeMs, 0));
  if (ttlMs <= 0) {
    return 0;
  }
  const threshold = Date.now() - ttlMs;
  const authRequests = ensureAuthRequestMap(state);
  let removed = 0;
  for (const [oauthState, entry] of Object.entries(authRequests)) {
    const createdAtMs = Date.parse(entry?.createdAt || "");
    if (!Number.isFinite(createdAtMs) || createdAtMs < threshold) {
      delete authRequests[oauthState];
      removed += 1;
    }
  }
  return removed;
};

const setAuthRequestInState = (state, oauthState, payload) => {
  const key = typeof oauthState === "string" ? oauthState.trim() : "";
  if (!key) {
    return false;
  }
  const authRequests = ensureAuthRequestMap(state);
  authRequests[key] = {
    payload: normalizeMetadata(payload),
    createdAt: new Date().toISOString(),
  };
  return true;
};

const takeAuthRequestFromState = (state, oauthState) => {
  const key = typeof oauthState === "string" ? oauthState.trim() : "";
  if (!key) {
    return null;
  }
  const authRequests = ensureAuthRequestMap(state);
  const entry = authRequests[key];
  if (!isObject(entry)) {
    return null;
  }
  delete authRequests[key];
  return normalizeMetadata(entry.payload);
};

const normalizeRefreshTokenRecord = (entry) => {
  if (!isObject(entry)) {
    return null;
  }
  return {
    tokenHash:
      typeof entry.tokenHash === "string" && entry.tokenHash.trim()
        ? entry.tokenHash.trim()
        : "",
    userId:
      typeof entry.userId === "string" && entry.userId.trim() ? entry.userId.trim() : "",
    deviceId:
      typeof entry.deviceId === "string" && entry.deviceId.trim()
        ? entry.deviceId.trim()
        : null,
    expiresAt: toIsoDate(entry.expiresAt),
    revokedAt: toIsoDate(entry.revokedAt),
    replacedByHash:
      typeof entry.replacedByHash === "string" && entry.replacedByHash.trim()
        ? entry.replacedByHash.trim()
        : null,
    metadata: normalizeMetadata(entry.metadata),
    createdAt: toIsoDate(entry.createdAt),
    updatedAt: toIsoDate(entry.updatedAt),
  };
};

const persistRefreshTokenInState = (state, payload) => {
  const refreshToken =
    typeof payload?.refreshToken === "string" ? payload.refreshToken.trim() : "";
  const userId = typeof payload?.userId === "string" ? payload.userId.trim() : "";
  const expiresAtEpochSec = parseInteger(payload?.expiresAtEpochSec, 0);
  if (!refreshToken || !userId) {
    return { ok: false, reason: "INVALID" };
  }
  if (!Number.isFinite(expiresAtEpochSec) || expiresAtEpochSec <= 0) {
    return { ok: false, reason: "INVALID_EXPIRY" };
  }
  const tokenHash = hashToken(refreshToken);
  const refreshTokens = ensureRefreshTokenMap(state);
  const nowIso = new Date().toISOString();
  const existing = normalizeRefreshTokenRecord(refreshTokens[tokenHash]);
  refreshTokens[tokenHash] = {
    tokenHash,
    userId,
    deviceId:
      typeof payload?.deviceId === "string" && payload.deviceId.trim()
        ? payload.deviceId.trim()
        : null,
    expiresAt: new Date(expiresAtEpochSec * 1000).toISOString(),
    revokedAt: null,
    replacedByHash: null,
    metadata: normalizeMetadata(payload?.metadata),
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso,
  };
  return { ok: true };
};

const rotateRefreshTokenInState = (state, payload) => {
  const oldRefreshToken =
    typeof payload?.oldRefreshToken === "string" ? payload.oldRefreshToken.trim() : "";
  const newRefreshToken =
    typeof payload?.newRefreshToken === "string" ? payload.newRefreshToken.trim() : "";
  const userId = typeof payload?.userId === "string" ? payload.userId.trim() : "";
  const newExpiresAtEpochSec = parseInteger(payload?.newExpiresAtEpochSec, 0);
  const requestedDeviceId =
    typeof payload?.deviceId === "string" && payload.deviceId.trim()
      ? payload.deviceId.trim()
      : null;
  if (!oldRefreshToken || !newRefreshToken || !userId || newExpiresAtEpochSec <= 0) {
    return { ok: false, reason: "INVALID" };
  }
  const refreshTokens = ensureRefreshTokenMap(state);
  const oldHash = hashToken(oldRefreshToken);
  const newHash = hashToken(newRefreshToken);
  const existing = normalizeRefreshTokenRecord(refreshTokens[oldHash]);
  if (!existing) {
    return { ok: false, reason: "NOT_FOUND" };
  }
  if (existing.userId !== userId) {
    return { ok: false, reason: "MISMATCH" };
  }
  if (requestedDeviceId && existing.deviceId && existing.deviceId !== requestedDeviceId) {
    return { ok: false, reason: "MISMATCH" };
  }
  const expiresAtMs = Date.parse(existing.expiresAt || "");
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
    return { ok: false, reason: "EXPIRED" };
  }
  if (existing.revokedAt || existing.replacedByHash) {
    return { ok: false, reason: "REVOKED" };
  }
  const nowIso = new Date().toISOString();
  refreshTokens[oldHash] = {
    ...existing,
    revokedAt: nowIso,
    replacedByHash: newHash,
    updatedAt: nowIso,
  };
  const next = normalizeRefreshTokenRecord(refreshTokens[newHash]);
  refreshTokens[newHash] = {
    tokenHash: newHash,
    userId,
    deviceId: requestedDeviceId || existing.deviceId || null,
    expiresAt: new Date(newExpiresAtEpochSec * 1000).toISOString(),
    revokedAt: null,
    replacedByHash: null,
    metadata: normalizeMetadata(payload?.metadata),
    createdAt: next?.createdAt || nowIso,
    updatedAt: nowIso,
  };
  return { ok: true };
};

const revokeRefreshTokensInState = (state, payload = {}) => {
  const userId = typeof payload?.userId === "string" ? payload.userId.trim() : "";
  if (!userId) {
    return 0;
  }
  const requestedDeviceId =
    typeof payload?.deviceId === "string" && payload.deviceId.trim()
      ? payload.deviceId.trim()
      : null;
  const allDevices = payload?.allDevices === true;
  const refreshTokens = ensureRefreshTokenMap(state);
  const nowIso = new Date().toISOString();
  let updated = 0;
  for (const tokenHash of Object.keys(refreshTokens)) {
    const record = normalizeRefreshTokenRecord(refreshTokens[tokenHash]);
    if (!record || record.userId !== userId) {
      continue;
    }
    if (!allDevices && requestedDeviceId && record.deviceId !== requestedDeviceId) {
      continue;
    }
    if (record.revokedAt) {
      continue;
    }
    refreshTokens[tokenHash] = {
      ...record,
      revokedAt: nowIso,
      updatedAt: nowIso,
    };
    updated += 1;
  }
  return updated;
};

export const storeOAuthRequest = async (
  config,
  oauthState,
  payload,
  options = {}
) => {
  const pruneMaxAgeMs = Math.max(0, parseInteger(options.pruneMaxAgeMs, 0));
  if (isDatabaseConfigured(config)) {
    await setAuthRequestRecord(config, oauthState, payload);
    if (pruneMaxAgeMs > 0) {
      await pruneAuthRequestRecords(config, pruneMaxAgeMs);
    }
    return true;
  }
  return withFallbackState(config, async (state) => {
    if (pruneMaxAgeMs > 0) {
      pruneAuthRequestsInState(state, pruneMaxAgeMs);
    }
    return setAuthRequestInState(state, oauthState, payload);
  });
};

export const consumeOAuthRequest = async (config, oauthState, options = {}) => {
  const pruneMaxAgeMs = Math.max(0, parseInteger(options.pruneMaxAgeMs, 0));
  if (isDatabaseConfigured(config)) {
    const payload = await takeAuthRequestRecord(config, oauthState);
    if (pruneMaxAgeMs > 0) {
      await pruneAuthRequestRecords(config, pruneMaxAgeMs);
    }
    return payload;
  }
  return withFallbackState(config, async (state) => {
    if (pruneMaxAgeMs > 0) {
      pruneAuthRequestsInState(state, pruneMaxAgeMs);
    }
    return takeAuthRequestFromState(state, oauthState);
  });
};

export const persistRefreshToken = async (config, payload) => {
  if (isDatabaseConfigured(config)) {
    return persistRefreshTokenRecord(config, payload);
  }
  return withFallbackState(config, async (state) =>
    persistRefreshTokenInState(state, payload)
  );
};

export const rotateRefreshToken = async (config, payload) => {
  if (isDatabaseConfigured(config)) {
    return rotateRefreshTokenRecord(config, payload);
  }
  return withFallbackState(config, async (state) =>
    rotateRefreshTokenInState(state, payload)
  );
};

export const revokeRefreshTokens = async (config, payload = {}) => {
  if (isDatabaseConfigured(config)) {
    return revokeRefreshTokensForUserDevice(config, payload);
  }
  return withFallbackState(config, async (state) =>
    revokeRefreshTokensInState(state, payload)
  );
};
