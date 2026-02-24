import crypto from "node:crypto";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const DESKTOP_REDIRECT_URI = "tex64://oauth/callback";

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PKCE_VERIFIER_REGEX = /^[A-Za-z0-9\-._~]+$/;
const PKCE_CHALLENGE_REGEX = /^[A-Za-z0-9_-]+$/;

const hashHex = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");

const toBase64Url = (buffer) =>
  buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const asNonEmptyString = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const parseBaseWebOrigin = (config) => {
  const fallback = "https://tex64.com";
  try {
    return new URL(config?.baseWebUrl || fallback).origin.toLowerCase();
  } catch {
    return fallback;
  }
};

export const buildOAuthState = () => {
  if (typeof crypto.randomUUID === "function") {
    return `st_${crypto.randomUUID().replace(/-/g, "")}`;
  }
  return `st_${crypto.randomBytes(18).toString("hex")}`;
};

export const isValidPkceCodeVerifier = (value) => {
  const verifier = asNonEmptyString(value);
  if (!verifier) {
    return false;
  }
  return (
    verifier.length >= 43 &&
    verifier.length <= 128 &&
    PKCE_VERIFIER_REGEX.test(verifier)
  );
};

export const isValidPkceCodeChallenge = (value) => {
  const challenge = asNonEmptyString(value);
  if (!challenge) {
    return false;
  }
  return (
    challenge.length >= 43 &&
    challenge.length <= 128 &&
    PKCE_CHALLENGE_REGEX.test(challenge)
  );
};

export const createPkceCodeChallengeS256 = (codeVerifier) => {
  if (!isValidPkceCodeVerifier(codeVerifier)) {
    return null;
  }
  const digest = crypto
    .createHash("sha256")
    .update(codeVerifier.trim())
    .digest();
  return toBase64Url(digest);
};

export const canUseGoogleOAuth = (config) =>
  !config?.mockOAuthEnabled &&
  Boolean(asNonEmptyString(config?.googleClientId)) &&
  Boolean(asNonEmptyString(config?.googleClientSecret));

export const isMockOAuthEnabled = (config) => config?.mockOAuthEnabled === true;

export const resolveOAuthProviderMode = (config) => {
  if (canUseGoogleOAuth(config)) {
    return "google";
  }
  if (isMockOAuthEnabled(config)) {
    return "mock";
  }
  return "unavailable";
};

export const normalizeOAuthRedirectUri = (value, config) => {
  const raw = asNonEmptyString(value);
  if (!raw) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return null;
  }
  const protocol = parsed.protocol.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname || "/";
  if (protocol === "tex64:") {
    if (hostname !== "oauth" || pathname !== "/callback" || parsed.port) {
      return null;
    }
    return parsed.toString();
  }
  if (protocol !== "https:" && protocol !== "http:") {
    return null;
  }
  const isLocalhost = LOCALHOST_HOSTS.has(hostname);
  if (protocol === "http:" && !isLocalhost) {
    return null;
  }
  const origin = parsed.origin.toLowerCase();
  if (!isLocalhost && origin !== parseBaseWebOrigin(config)) {
    return null;
  }
  return parsed.toString();
};

export const resolveGoogleOAuthRedirectUri = (redirectUri, config) => {
  const normalized = normalizeOAuthRedirectUri(redirectUri, config);
  if (!normalized) {
    return null;
  }
  if (normalized === DESKTOP_REDIRECT_URI) {
    return `${config.baseWebUrl}/api/v2/auth/google/callback`;
  }
  return normalized;
};

export const buildGoogleAuthUrl = ({
  config,
  redirectUri,
  state,
  codeChallenge,
  codeChallengeMethod,
}) => {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", config.googleClientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", codeChallengeMethod || "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
};

const requestJson = async (url, options = {}) => {
  if (typeof fetch !== "function") {
    throw new Error("fetch is not available in this runtime.");
  }
  const response = await fetch(url, options);
  const raw = await response.text().catch(() => "");
  let payload = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const message =
      payload?.error_description ||
      payload?.error?.message ||
      payload?.error ||
      payload?.message ||
      `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload || {};
};

export const exchangeCodeWithGoogle = async ({
  config,
  code,
  redirectUri,
  codeVerifier,
}) => {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.googleClientId,
    client_secret: config.googleClientSecret,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const tokenPayload = await requestJson(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const accessToken = asNonEmptyString(tokenPayload?.access_token);
  if (!accessToken) {
    throw new Error("Google token exchange did not return access_token.");
  }
  const userInfo = await requestJson(GOOGLE_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const email = asNonEmptyString(userInfo?.email)?.toLowerCase();
  if (!email) {
    throw new Error("Google user info did not include email.");
  }
  return {
    id: `google_${hashHex(userInfo?.sub || email).slice(0, 20)}`,
    email,
    name: asNonEmptyString(userInfo?.name) || email.split("@")[0],
  };
};

export const resolveMockUserFromCode = (code, config) => {
  const rawCode = asNonEmptyString(code) || "";
  const suffix = rawCode.startsWith("mock:") ? rawCode.slice("mock:".length) : "";
  const email =
    (suffix || asNonEmptyString(config?.mockOAuthEmail) || "dev@tex64.com")
      .trim()
      .toLowerCase();
  const safeEmail = email.includes("@") ? email : `${email}@tex64.com`;
  return {
    id: `mock_${hashHex(safeEmail).slice(0, 20)}`,
    email: safeEmail,
    name: safeEmail.split("@")[0],
  };
};

export const buildMockAuthUrl = (redirectUri, state, config) => {
  const callbackUrl = new URL(redirectUri);
  callbackUrl.searchParams.set(
    "code",
    `mock:${config?.mockOAuthEmail || "dev@tex64.com"}`
  );
  callbackUrl.searchParams.set("state", state);
  return callbackUrl.toString();
};

export const DESKTOP_OAUTH_CALLBACK_URI = DESKTOP_REDIRECT_URI;
