import {
  ApiError,
  createRequestId,
  handleOptionsRequest,
  readJsonBody,
  sendApiError,
  sendJson,
  setCorsHeaders,
} from "../../_lib/http.js";
import { getRuntimeConfig } from "../../_lib/runtime-config.js";
import { storeOAuthRequest } from "../../_lib/auth-storage.js";
import {
  buildGoogleAuthUrl,
  buildMockAuthUrl,
  buildOAuthState,
  isValidPkceCodeChallenge,
  normalizeOAuthRedirectUri,
  resolveGoogleOAuthRedirectUri,
  resolveOAuthProviderMode,
} from "../../_lib/google-oauth.js";

const isObject = (value) =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const asNonEmptyString = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const isValidDeviceId = (value) =>
  typeof value === "string" &&
  value.length >= 8 &&
  value.length <= 200 &&
  /^[A-Za-z0-9._:-]+$/.test(value);

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
    const deviceId = asNonEmptyString(body.deviceId);
    const redirectUri = normalizeOAuthRedirectUri(
      asNonEmptyString(body.redirectUri),
      config
    );
    const codeChallenge = asNonEmptyString(body.codeChallenge);
    const codeChallengeMethod = asNonEmptyString(body.codeChallengeMethod) || "S256";
    if (!deviceId || !redirectUri || !codeChallenge) {
      throw new ApiError(
        "VALIDATION_ERROR",
        "deviceId, redirectUri, codeChallenge are required.",
        400
      );
    }
    if (!isValidDeviceId(deviceId)) {
      throw new ApiError("VALIDATION_ERROR", "deviceId is invalid.", 400);
    }
    if (codeChallengeMethod !== "S256") {
      throw new ApiError(
        "VALIDATION_ERROR",
        "codeChallengeMethod must be S256.",
        400
      );
    }
    if (!isValidPkceCodeChallenge(codeChallenge)) {
      throw new ApiError("VALIDATION_ERROR", "codeChallenge is invalid.", 400);
    }

    const providerMode = resolveOAuthProviderMode(config);
    if (providerMode === "unavailable") {
      throw new ApiError(
        "OAUTH_PROVIDER_UNAVAILABLE",
        "Google OAuth is not configured.",
        503
      );
    }
    const oauthState = buildOAuthState();
    const useGoogle = providerMode === "google";
    const googleRedirectUri = useGoogle
      ? resolveGoogleOAuthRedirectUri(redirectUri, config)
      : null;
    if (useGoogle && !googleRedirectUri) {
      throw new ApiError("VALIDATION_ERROR", "redirectUri is invalid.", 400);
    }
    const authUrl = useGoogle
      ? buildGoogleAuthUrl({
          config,
          redirectUri: googleRedirectUri,
          state: oauthState,
          codeChallenge,
          codeChallengeMethod,
        })
      : buildMockAuthUrl(redirectUri, oauthState, config);

    await storeOAuthRequest(
      config,
      oauthState,
      {
        deviceId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod,
        useGoogle,
        providerMode,
        googleRedirectUri: useGoogle ? googleRedirectUri : null,
      },
      {
        pruneMaxAgeMs: Math.max(60, Math.round(config.oauthStateTtlSec || 600)) * 1000,
      }
    );

    sendJson(res, 200, {
      requestId,
      authUrl,
      state: oauthState,
      provider: providerMode,
    });
  } catch (error) {
    sendApiError(res, requestId, error);
  }
};

export default handler;
