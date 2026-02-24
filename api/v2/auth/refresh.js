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
import { getRefreshPayload, issueSessionTokens } from "../_lib/auth.js";
import { getUserContext } from "../_lib/user-context.js";
import { rotateRefreshToken } from "../_lib/auth-storage.js";

const isObject = (value) =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const asNonEmptyString = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const toUserClaims = (payload) => ({
  id: asNonEmptyString(payload?.sub),
  email: asNonEmptyString(payload?.email)?.toLowerCase() || null,
  name: asNonEmptyString(payload?.name),
});

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
    const body = await readJsonBody(req);
    if (!isObject(body)) {
      throw new ApiError("VALIDATION_ERROR", "JSON body is required.", 400);
    }
    const refreshToken = asNonEmptyString(body.refreshToken);
    const requestedDeviceId = asNonEmptyString(body.deviceId);
    if (!refreshToken) {
      throw new ApiError("VALIDATION_ERROR", "refreshToken is required.", 400);
    }

    const payload = getRefreshPayload(refreshToken, config);
    if (requestedDeviceId && payload.deviceId && payload.deviceId !== requestedDeviceId) {
      throw new ApiError("AUTH_REQUIRED", "Device mismatch.", 401);
    }
    const context = await getUserContext(config, toUserClaims(payload));
    const normalizedDeviceId =
      requestedDeviceId || asNonEmptyString(payload.deviceId) || "";
    const session = issueSessionTokens(
      {
        user: context.user,
        plan: context.subscription.plan,
        deviceId: normalizedDeviceId,
      },
      config
    );
    const nextRefreshPayload = getRefreshPayload(session.refreshToken, config);
    const rotateResult = await rotateRefreshToken(config, {
      oldRefreshToken: refreshToken,
      newRefreshToken: session.refreshToken,
      userId: context.user.id,
      deviceId: normalizedDeviceId,
      newExpiresAtEpochSec: nextRefreshPayload.exp,
      metadata: { source: "refresh_rotate" },
    });
    if (rotateResult?.ok === false) {
      if (rotateResult.reason === "EXPIRED") {
        throw new ApiError("TOKEN_EXPIRED", "Refresh token has expired.", 401);
      }
      throw new ApiError(
        "AUTH_REQUIRED",
        "Refresh token is no longer valid. Please sign in again.",
        401
      );
    }

    sendJson(res, 200, {
      requestId,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresInSec: session.expiresInSec,
      user: session.user,
      plan: context.subscription.plan,
    });
  } catch (error) {
    sendApiError(res, requestId, error);
  }
};

export default handler;
