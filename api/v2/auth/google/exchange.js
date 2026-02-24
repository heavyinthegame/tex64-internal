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
import { getRefreshPayload, issueSessionTokens } from "../../_lib/auth.js";
import {
  canUseGoogleOAuth,
  createPkceCodeChallengeS256,
  exchangeCodeWithGoogle,
  isMockOAuthEnabled,
  isValidPkceCodeVerifier,
  normalizeOAuthRedirectUri,
  resolveGoogleOAuthRedirectUri,
  resolveMockUserFromCode,
} from "../../_lib/google-oauth.js";
import {
  consumeOAuthRequest,
  persistRefreshToken,
} from "../../_lib/auth-storage.js";
import { getUserContext } from "../../_lib/user-context.js";

const isObject = (value) =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const asNonEmptyString = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const isValidDeviceId = (value) =>
  typeof value === "string" &&
  value.length >= 8 &&
  value.length <= 200 &&
  /^[A-Za-z0-9._:-]+$/.test(value);

const toOAuthUser = (profile) => {
  if (!isObject(profile)) {
    return null;
  }
  const id = asNonEmptyString(profile.id);
  const email = asNonEmptyString(profile.email)?.toLowerCase() || null;
  if (!id || !email) {
    return null;
  }
  return {
    id,
    email,
    name: asNonEmptyString(profile.name),
  };
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
    const body = await readJsonBody(req);
    if (!isObject(body)) {
      throw new ApiError("VALIDATION_ERROR", "JSON body is required.", 400);
    }
    const code = asNonEmptyString(body.code);
    const oauthState = asNonEmptyString(body.state);
    const redirectUri = normalizeOAuthRedirectUri(
      asNonEmptyString(body.redirectUri),
      config
    );
    const codeVerifier = asNonEmptyString(body.codeVerifier);
    const deviceId = asNonEmptyString(body.deviceId);
    if (!code || !oauthState || !redirectUri || !codeVerifier || !deviceId) {
      throw new ApiError(
        "VALIDATION_ERROR",
        "code, state, redirectUri, codeVerifier, deviceId are required.",
        400
      );
    }
    if (!isValidDeviceId(deviceId)) {
      throw new ApiError("VALIDATION_ERROR", "deviceId is invalid.", 400);
    }
    if (!isValidPkceCodeVerifier(codeVerifier)) {
      throw new ApiError("VALIDATION_ERROR", "codeVerifier is invalid.", 400);
    }

    const pendingRequest = await consumeOAuthRequest(config, oauthState, {
      pruneMaxAgeMs: Math.max(60, Math.round(config.oauthStateTtlSec || 600)) * 1000,
    });
    if (!pendingRequest) {
      throw new ApiError(
        "OAUTH_NO_PENDING",
        "OAuth request was not started or has expired.",
        400
      );
    }
    if (pendingRequest.deviceId !== deviceId || pendingRequest.redirectUri !== redirectUri) {
      throw new ApiError(
        "OAUTH_STATE_MISMATCH",
        "OAuth request context does not match.",
        400
      );
    }
    const expectedChallenge = asNonEmptyString(pendingRequest.codeChallenge);
    const expectedChallengeMethod =
      asNonEmptyString(pendingRequest.codeChallengeMethod) || "S256";
    if (!expectedChallenge || expectedChallengeMethod !== "S256") {
      throw new ApiError(
        "OAUTH_STATE_MISMATCH",
        "OAuth request challenge is invalid.",
        400
      );
    }
    const actualChallenge = createPkceCodeChallengeS256(codeVerifier);
    if (!actualChallenge || actualChallenge !== expectedChallenge) {
      throw new ApiError("OAUTH_PKCE_MISMATCH", "OAuth PKCE verification failed.", 400);
    }

    const pendingUseGoogle =
      typeof pendingRequest.useGoogle === "boolean"
        ? pendingRequest.useGoogle
        : canUseGoogleOAuth(config);
    const pendingGoogleRedirectUri =
      asNonEmptyString(pendingRequest.googleRedirectUri);
    const googleRedirectUri =
      pendingGoogleRedirectUri || resolveGoogleOAuthRedirectUri(redirectUri, config);
    const usesMockCode = code.startsWith("mock:");
    if (pendingUseGoogle && usesMockCode) {
      throw new ApiError("OAUTH_PROVIDER_MISMATCH", "OAuth provider mismatch.", 400);
    }
    if (!pendingUseGoogle && !isMockOAuthEnabled(config)) {
      throw new ApiError("OAUTH_PROVIDER_UNAVAILABLE", "Mock OAuth is disabled.", 503);
    }
    if (!pendingUseGoogle && !usesMockCode) {
      throw new ApiError("OAUTH_PROVIDER_MISMATCH", "OAuth provider mismatch.", 400);
    }
    if (pendingUseGoogle && !googleRedirectUri) {
      throw new ApiError(
        "OAUTH_STATE_MISMATCH",
        "OAuth redirect URI context is invalid.",
        400
      );
    }
    if (pendingUseGoogle && !canUseGoogleOAuth(config)) {
      throw new ApiError(
        "OAUTH_PROVIDER_UNAVAILABLE",
        "Google OAuth is not configured.",
        503
      );
    }

    const profile = pendingUseGoogle
      ? await exchangeCodeWithGoogle({
          config,
          code,
          redirectUri: googleRedirectUri,
          codeVerifier,
        })
      : resolveMockUserFromCode(code, config);
    const oauthUser = toOAuthUser(profile);
    if (!oauthUser) {
      throw new ApiError(
        "AUTH_INVALID_RESPONSE",
        "Unable to resolve user profile from OAuth exchange.",
        400
      );
    }
    const context = await getUserContext(config, oauthUser);
    const session = issueSessionTokens(
      {
        user: context.user,
        plan: context.subscription.plan,
        deviceId,
      },
      config
    );
    const refreshPayload = getRefreshPayload(session.refreshToken, config);
    const persistedToken = await persistRefreshToken(config, {
      refreshToken: session.refreshToken,
      userId: context.user.id,
      deviceId,
      expiresAtEpochSec: refreshPayload.exp,
      metadata: { source: "oauth_exchange" },
    });
    if (persistedToken?.ok === false) {
      throw new ApiError(
        "INTERNAL_ERROR",
        "Failed to persist refresh token state.",
        500
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
