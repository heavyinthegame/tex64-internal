import { requireAuthenticatedUser } from "../_lib/auth.js";
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
import { revokeRefreshTokens } from "../_lib/auth-storage.js";

const isObject = (value) =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const asNonEmptyString = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

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
    const user = requireAuthenticatedUser(req, config);
    const body = await readJsonBody(req);
    const payload = isObject(body) ? body : {};
    const allDevices = payload.allDevices === true;
    const requestedDeviceId =
      asNonEmptyString(payload.deviceId) || asNonEmptyString(user.deviceId) || null;
    const revokedCount = await revokeRefreshTokens(config, {
      userId: user.id,
      deviceId: requestedDeviceId,
      allDevices,
    });

    sendJson(res, 200, {
      requestId,
      status: "ok",
      revokedCount: Number.isFinite(revokedCount) ? revokedCount : 0,
    });
  } catch (error) {
    sendApiError(res, requestId, error);
  }
};

export default handler;
