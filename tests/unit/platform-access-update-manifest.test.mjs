import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { PlatformAccessService } = require("../../electron/services/platform-access.cjs");

test("fetchUpdateManifest maps artifact hash fields", async () => {
  const service = new PlatformAccessService({
    userDataPath: path.join(os.tmpdir(), "tex64-platform-access-test"),
  });
  service.requestJson = async () => ({
    latestVersion: "0.2.3",
    artifactUrl: "https://downloads.tex64.com/tex64-0.2.3.dmg",
    sha256: "sha256:abcd",
    signature: "sha256:efgh",
  });

  const manifest = await service.fetchUpdateManifest({
    platform: "darwin",
    arch: "arm64",
    channel: "stable",
    currentVersion: "0.2.2",
  });

  assert.equal(manifest.hasUpdate, true);
  assert.equal(manifest.artifactSha256, "sha256:abcd");
  assert.equal(manifest.sha256, "sha256:abcd");
  assert.equal(manifest.signature, "sha256:efgh");
});

test("fetchUpdateManifest sanitizes oversized digest text", async () => {
  const service = new PlatformAccessService({
    userDataPath: path.join(os.tmpdir(), "tex64-platform-access-test"),
  });
  const tooLongDigest = "a".repeat(513);
  service.requestJson = async () => ({
    latestVersion: "0.2.3",
    artifactUrl: "https://downloads.tex64.com/tex64-0.2.3.dmg",
    artifactSha256: tooLongDigest,
    signature: tooLongDigest,
  });

  const manifest = await service.fetchUpdateManifest({
    platform: "darwin",
    arch: "arm64",
    channel: "stable",
    currentVersion: "0.2.3",
  });

  assert.equal(manifest.hasUpdate, false);
  assert.equal(manifest.artifactSha256, null);
  assert.equal(manifest.signature, null);
});

test("submitErrorReport sends authenticated request when refresh succeeds", async () => {
  const service = new PlatformAccessService({
    userDataPath: path.join(os.tmpdir(), "tex64-platform-access-test"),
  });
  service.ensureLoadedState = async () => ({
    session: {
      accessToken: "cached-access",
      refreshToken: "refresh-token",
    },
  });
  service.refreshAccessToken = async () => "next-access-token";
  let captured = null;
  service.requestJson = async (requestUrl, options) => {
    captured = { requestUrl, options };
    return {
      requestId: "req_1",
      feedbackId: "err_1",
      status: "accepted",
      storage: "database",
    };
  };

  const result = await service.submitErrorReport({
    kind: "test_error",
    message: "boom",
  });

  assert.equal(result.requestId, "req_1");
  assert.equal(result.feedbackId, "err_1");
  assert.equal(result.status, "accepted");
  assert.equal(result.storage, "database");
  assert.equal(captured.requestUrl.endsWith("/internal/error-report"), true);
  assert.equal(captured.options.method, "POST");
  assert.equal(
    captured.options.headers.Authorization,
    "Bearer next-access-token"
  );
  assert.equal(captured.options.body.report.message, "boom");
});

test("submitErrorReport falls back to anonymous request when refresh fails", async () => {
  const service = new PlatformAccessService({
    userDataPath: path.join(os.tmpdir(), "tex64-platform-access-test"),
  });
  service.ensureLoadedState = async () => ({
    session: {
      accessToken: "cached-access",
      refreshToken: "refresh-token",
    },
  });
  service.refreshAccessToken = async () => {
    throw new Error("refresh failed");
  };
  let captured = null;
  service.requestJson = async (_requestUrl, options) => {
    captured = options;
    return {
      requestId: "req_2",
      feedbackId: "err_2",
      status: "accepted",
      storage: "fallback",
    };
  };

  const result = await service.submitErrorReport({
    kind: "test_error",
    message: "boom",
  });

  assert.equal(result.requestId, "req_2");
  assert.equal(result.feedbackId, "err_2");
  assert.equal(result.storage, "fallback");
  assert.deepEqual(captured.headers, {});
  assert.equal(captured.body.report.kind, "test_error");
});

test("startGoogleAuth reuses pending auth URL while request is active", async () => {
  const service = new PlatformAccessService({
    userDataPath: path.join(os.tmpdir(), "tex64-platform-access-test"),
  });
  const state = {
    deviceId: "device-1",
    session: null,
    oauthPending: {
      state: "pending-state",
      codeVerifier: "pending-verifier",
      createdAt: Date.now(),
      authUrl: "https://accounts.example.com/oauth",
    },
    aiAccessCache: null,
    aiAccessFetchedAt: 0,
    aiUsageCache: null,
    aiUsageFetchedAt: 0,
  };
  let requested = false;
  service.ensureLoadedState = async () => state;
  service.requestJson = async () => {
    requested = true;
    return null;
  };

  const result = await service.startGoogleAuth();

  assert.equal(result.bypassed, false);
  assert.equal(result.reused, true);
  assert.equal(result.authUrl, "https://accounts.example.com/oauth");
  assert.equal(requested, false);
});

test("startGoogleAuth rejects invalid auth URL in start response", async () => {
  const service = new PlatformAccessService({
    userDataPath: path.join(os.tmpdir(), "tex64-platform-access-test"),
  });
  const state = {
    deviceId: "device-1",
    session: null,
    oauthPending: null,
    aiAccessCache: null,
    aiAccessFetchedAt: 0,
    aiUsageCache: null,
    aiUsageFetchedAt: 0,
  };
  service.ensureLoadedState = async () => state;
  service.ensureDeviceId = async () => "device-1";
  service.requestJson = async () => ({
    authUrl: "javascript:alert(1)",
    state: "oauth-state",
  });

  await assert.rejects(service.startGoogleAuth(), (error) => {
    assert.equal(error?.code, "AUTH_INVALID_RESPONSE");
    return true;
  });

  assert.equal(state.oauthPending, null);
});

test("completeGoogleAuthFromCallback clears pending and fails on state mismatch", async () => {
  const service = new PlatformAccessService({
    userDataPath: path.join(os.tmpdir(), "tex64-platform-access-test"),
  });
  const state = {
    deviceId: "device-1",
    session: null,
    oauthPending: {
      state: "expected-state",
      codeVerifier: "pending-verifier",
      createdAt: Date.now(),
      authUrl: "https://accounts.example.com/oauth",
    },
    aiAccessCache: null,
    aiAccessFetchedAt: 0,
    aiUsageCache: null,
    aiUsageFetchedAt: 0,
  };
  let saveCount = 0;
  service.ensureLoadedState = async () => state;
  service.save = async () => {
    saveCount += 1;
  };

  await assert.rejects(
    service.completeGoogleAuthFromCallback("tex64://oauth/callback?code=abc&state=unexpected"),
    (error) => {
      assert.equal(error?.code, "OAUTH_STATE_MISMATCH");
      return true;
    }
  );

  assert.equal(state.oauthPending, null);
  assert.ok(saveCount >= 1);
});

test("completeGoogleAuthFromCallback rejects mismatched callback endpoint", async () => {
  const service = new PlatformAccessService({
    userDataPath: path.join(os.tmpdir(), "tex64-platform-access-test"),
  });
  const state = {
    deviceId: "device-1",
    session: null,
    oauthPending: {
      state: "expected-state",
      codeVerifier: "pending-verifier",
      createdAt: Date.now(),
      authUrl: "https://accounts.example.com/oauth",
    },
    aiAccessCache: null,
    aiAccessFetchedAt: 0,
    aiUsageCache: null,
    aiUsageFetchedAt: 0,
  };
  service.ensureLoadedState = async () => state;
  service.save = async () => {};

  await assert.rejects(
    service.completeGoogleAuthFromCallback("tex64://other/callback?code=abc&state=expected-state"),
    (error) => {
      assert.equal(error?.code, "OAUTH_CALLBACK_MISMATCH");
      return true;
    }
  );

  assert.ok(state.oauthPending);
  assert.equal(state.oauthPending.state, "expected-state");
});

test("completeGoogleAuthFromCallback accepts legacy callback endpoint", async () => {
  const service = new PlatformAccessService({
    userDataPath: path.join(os.tmpdir(), "tex64-platform-access-test"),
  });
  const state = {
    deviceId: "device-1",
    session: null,
    oauthPending: {
      state: "expected-state",
      codeVerifier: "pending-verifier",
      createdAt: Date.now(),
      authUrl: "https://accounts.example.com/oauth",
    },
    aiAccessCache: null,
    aiAccessFetchedAt: 0,
    aiUsageCache: null,
    aiUsageFetchedAt: 0,
  };
  let capturedRequest = null;
  service.ensureLoadedState = async () => state;
  service.ensureDeviceId = async () => "device-1";
  service.requestJson = async (requestUrl, options) => {
    capturedRequest = { requestUrl, options };
    return {
      accessToken: "access-token-legacy",
      refreshToken: "refresh-token-legacy",
      expiresInSec: 3600,
      plan: "pro",
      user: {
        id: "usr_legacy",
        email: "legacy@example.com",
        name: "Legacy User",
      },
    };
  };
  service.save = async () => {};

  const snapshot = await service.completeGoogleAuthFromCallback(
    "tex64://account/oauth/callback?code=oauth-code&state=expected-state"
  );

  assert.ok(capturedRequest);
  assert.equal(capturedRequest.requestUrl.endsWith("/auth/google/exchange"), true);
  assert.equal(capturedRequest.options.body.code, "oauth-code");
  assert.equal(capturedRequest.options.body.state, "expected-state");
  assert.equal(state.oauthPending, null);
  assert.equal(snapshot.authenticated, true);
  assert.equal(snapshot.pending, false);
  assert.equal(snapshot.user?.email, "legacy@example.com");
});

test("completeGoogleAuthFromCallback accepts oauth params in hash fragment", async () => {
  const service = new PlatformAccessService({
    userDataPath: path.join(os.tmpdir(), "tex64-platform-access-test"),
  });
  const state = {
    deviceId: "device-1",
    session: null,
    oauthPending: {
      state: "expected-state",
      codeVerifier: "pending-verifier",
      createdAt: Date.now(),
      authUrl: "https://accounts.example.com/oauth",
    },
    aiAccessCache: null,
    aiAccessFetchedAt: 0,
    aiUsageCache: null,
    aiUsageFetchedAt: 0,
  };
  let capturedRequest = null;
  service.ensureLoadedState = async () => state;
  service.ensureDeviceId = async () => "device-1";
  service.requestJson = async (requestUrl, options) => {
    capturedRequest = { requestUrl, options };
    return {
      accessToken: "access-token-fragment",
      refreshToken: "refresh-token-fragment",
      expiresInSec: 3600,
      plan: "pro",
      user: {
        id: "usr_fragment",
        email: "fragment@example.com",
        name: "Fragment User",
      },
    };
  };
  service.save = async () => {};

  const snapshot = await service.completeGoogleAuthFromCallback(
    "tex64://oauth/callback#code=oauth-code&state=expected-state"
  );

  assert.ok(capturedRequest);
  assert.equal(capturedRequest.requestUrl.endsWith("/auth/google/exchange"), true);
  assert.equal(capturedRequest.options.body.code, "oauth-code");
  assert.equal(capturedRequest.options.body.state, "expected-state");
  assert.equal(state.oauthPending, null);
  assert.equal(snapshot.authenticated, true);
  assert.equal(snapshot.pending, false);
  assert.equal(snapshot.user?.email, "fragment@example.com");
});

test("completeGoogleAuthFromCallback accepts hostless oauth callback endpoint", async () => {
  const service = new PlatformAccessService({
    userDataPath: path.join(os.tmpdir(), "tex64-platform-access-test"),
  });
  const state = {
    deviceId: "device-1",
    session: null,
    oauthPending: {
      state: "expected-state",
      codeVerifier: "pending-verifier",
      createdAt: Date.now(),
      authUrl: "https://accounts.example.com/oauth",
    },
    aiAccessCache: null,
    aiAccessFetchedAt: 0,
    aiUsageCache: null,
    aiUsageFetchedAt: 0,
  };
  let capturedRequest = null;
  service.ensureLoadedState = async () => state;
  service.ensureDeviceId = async () => "device-1";
  service.requestJson = async (requestUrl, options) => {
    capturedRequest = { requestUrl, options };
    return {
      accessToken: "access-token-hostless",
      refreshToken: "refresh-token-hostless",
      expiresInSec: 3600,
      plan: "pro",
      user: {
        id: "usr_hostless",
        email: "hostless@example.com",
        name: "Hostless User",
      },
    };
  };
  service.save = async () => {};

  const snapshot = await service.completeGoogleAuthFromCallback(
    "tex64:///oauth/callback?code=oauth-code&state=expected-state"
  );

  assert.ok(capturedRequest);
  assert.equal(capturedRequest.requestUrl.endsWith("/auth/google/exchange"), true);
  assert.equal(capturedRequest.options.body.code, "oauth-code");
  assert.equal(capturedRequest.options.body.state, "expected-state");
  assert.equal(state.oauthPending, null);
  assert.equal(snapshot.authenticated, true);
  assert.equal(snapshot.pending, false);
  assert.equal(snapshot.user?.email, "hostless@example.com");
});

test("completeGoogleAuthFromCallback clears pending on malformed callback payload", async () => {
  const service = new PlatformAccessService({
    userDataPath: path.join(os.tmpdir(), "tex64-platform-access-test"),
  });
  const state = {
    deviceId: "device-1",
    session: null,
    oauthPending: {
      state: "expected-state",
      codeVerifier: "pending-verifier",
      createdAt: Date.now(),
      authUrl: "https://accounts.example.com/oauth",
    },
    aiAccessCache: null,
    aiAccessFetchedAt: 0,
    aiUsageCache: null,
    aiUsageFetchedAt: 0,
  };
  let saveCount = 0;
  service.ensureLoadedState = async () => state;
  service.save = async () => {
    saveCount += 1;
  };

  await assert.rejects(
    service.completeGoogleAuthFromCallback("tex64://oauth/callback"),
    (error) => {
      assert.equal(error?.code, "OAUTH_INVALID_CALLBACK");
      return true;
    }
  );

  assert.equal(state.oauthPending, null);
  assert.ok(saveCount >= 1);
});

test("completeGoogleAuthFromCallback rejects expired pending auth", async () => {
  const service = new PlatformAccessService({
    userDataPath: path.join(os.tmpdir(), "tex64-platform-access-test"),
  });
  const state = {
    deviceId: "device-1",
    session: null,
    oauthPending: {
      state: "expired-state",
      codeVerifier: "pending-verifier",
      createdAt: Date.now() - 11 * 60 * 1000,
      authUrl: "https://accounts.example.com/oauth",
    },
    aiAccessCache: null,
    aiAccessFetchedAt: 0,
    aiUsageCache: null,
    aiUsageFetchedAt: 0,
  };
  service.ensureLoadedState = async () => state;
  service.save = async () => {};

  await assert.rejects(
    service.completeGoogleAuthFromCallback("tex64://oauth/callback?code=abc&state=expired-state"),
    (error) => {
      assert.equal(error?.code, "OAUTH_PENDING_EXPIRED");
      return true;
    }
  );
  assert.equal(state.oauthPending, null);
});

test("cancelGoogleAuthPending clears pending auth state", async () => {
  const service = new PlatformAccessService({
    userDataPath: path.join(os.tmpdir(), "tex64-platform-access-test"),
  });
  const state = {
    deviceId: "device-1",
    session: null,
    oauthPending: {
      state: "state-1",
      codeVerifier: "verifier-1",
      createdAt: Date.now(),
      authUrl: "https://accounts.example.com/oauth",
    },
    aiAccessCache: null,
    aiAccessFetchedAt: 0,
    aiUsageCache: null,
    aiUsageFetchedAt: 0,
  };
  service.ensureLoadedState = async () => state;
  service.save = async () => {};

  const snapshot = await service.cancelGoogleAuthPending();

  assert.equal(state.oauthPending, null);
  assert.equal(snapshot.pending, false);
  assert.equal(snapshot.authenticated, false);
});

test("startGoogleAuth replaces expired pending auth request", async () => {
  const service = new PlatformAccessService({
    userDataPath: path.join(os.tmpdir(), "tex64-platform-access-test"),
  });
  const state = {
    deviceId: "device-1",
    session: null,
    oauthPending: {
      state: "expired-state",
      codeVerifier: "expired-verifier",
      createdAt: Date.now() - 11 * 60 * 1000,
      authUrl: "https://accounts.example.com/oauth-old",
    },
    aiAccessCache: null,
    aiAccessFetchedAt: 0,
    aiUsageCache: null,
    aiUsageFetchedAt: 0,
  };
  service.ensureLoadedState = async () => state;
  service.ensureDeviceId = async () => "device-1";
  service.requestJson = async () => ({
    authUrl: "https://accounts.example.com/oauth-new",
    state: "new-state",
  });
  service.save = async () => {};

  const result = await service.startGoogleAuth();

  assert.equal(result.bypassed, false);
  assert.equal(result.reused, false);
  assert.equal(result.authUrl, "https://accounts.example.com/oauth-new");
  assert.equal(result.state, "new-state");
  assert.equal(state.oauthPending?.state, "new-state");
  assert.equal(state.oauthPending?.authUrl, "https://accounts.example.com/oauth-new");
});

test("completeGoogleAuthFromCallback exchanges auth code and stores session", async () => {
  const service = new PlatformAccessService({
    userDataPath: path.join(os.tmpdir(), "tex64-platform-access-test"),
  });
  const state = {
    deviceId: "device-1",
    session: null,
    oauthPending: {
      state: "expected-state",
      codeVerifier: "pending-verifier",
      createdAt: Date.now(),
      authUrl: "https://accounts.example.com/oauth",
    },
    aiAccessCache: null,
    aiAccessFetchedAt: 0,
    aiUsageCache: null,
    aiUsageFetchedAt: 0,
  };
  let capturedRequest = null;
  let saveCount = 0;
  service.ensureLoadedState = async () => state;
  service.ensureDeviceId = async () => "device-1";
  service.requestJson = async (requestUrl, options) => {
    capturedRequest = { requestUrl, options };
    return {
      accessToken: "access-token-1",
      refreshToken: "refresh-token-1",
      expiresInSec: 3600,
      plan: "pro",
      user: {
        id: "usr_1",
        email: "user@example.com",
        name: "User",
      },
    };
  };
  service.save = async () => {
    saveCount += 1;
  };

  const snapshot = await service.completeGoogleAuthFromCallback(
    "tex64://oauth/callback?code=oauth-code&state=expected-state"
  );

  assert.ok(capturedRequest);
  assert.equal(capturedRequest.requestUrl.endsWith("/auth/google/exchange"), true);
  assert.equal(capturedRequest.options.method, "POST");
  assert.equal(capturedRequest.options.body.code, "oauth-code");
  assert.equal(capturedRequest.options.body.state, "expected-state");
  assert.equal(capturedRequest.options.body.codeVerifier, "pending-verifier");
  assert.equal(capturedRequest.options.body.deviceId, "device-1");
  assert.equal(state.oauthPending, null);
  assert.equal(state.session?.accessToken, "access-token-1");
  assert.equal(state.session?.refreshToken, "refresh-token-1");
  assert.equal(state.session?.plan, "pro");
  assert.equal(snapshot.authenticated, true);
  assert.equal(snapshot.pending, false);
  assert.equal(snapshot.user?.email, "user@example.com");
  assert.ok(saveCount >= 1);
});

test("completeGoogleAuthFromCallback clears pending auth when user denies consent", async () => {
  const service = new PlatformAccessService({
    userDataPath: path.join(os.tmpdir(), "tex64-platform-access-test"),
  });
  const state = {
    deviceId: "device-1",
    session: null,
    oauthPending: {
      state: "expected-state",
      codeVerifier: "pending-verifier",
      createdAt: Date.now(),
      authUrl: "https://accounts.example.com/oauth",
    },
    aiAccessCache: null,
    aiAccessFetchedAt: 0,
    aiUsageCache: null,
    aiUsageFetchedAt: 0,
  };
  service.ensureLoadedState = async () => state;
  service.save = async () => {};

  await assert.rejects(
    service.completeGoogleAuthFromCallback(
      "tex64://oauth/callback?error=access_denied&error_description=Denied&state=expected-state"
    ),
    (error) => {
      assert.equal(error?.code, "OAUTH_DENIED");
      return true;
    }
  );

  assert.equal(state.oauthPending, null);
});

test("strictProduction forces production endpoints and disables bypass", async () => {
  const oldApi = process.env.TEX64_PLATFORM_API_BASE_URL;
  const oldWeb = process.env.TEX64_PLATFORM_WEB_BASE_URL;
  const oldRedirect = process.env.TEX64_PLATFORM_OAUTH_REDIRECT_URI;
  const oldBypass = process.env.TEX64_AI_BYPASS_ENTITLEMENT;
  const oldE2EHeadless = process.env.TEX64_E2E_HEADLESS;
  const oldE2EUserData = process.env.TEX64_E2E_USERDATA;
  process.env.TEX64_PLATFORM_API_BASE_URL = "http://localhost:8787/v2";
  process.env.TEX64_PLATFORM_WEB_BASE_URL = "http://localhost:3000";
  process.env.TEX64_PLATFORM_OAUTH_REDIRECT_URI = "tex64://oauth/dev-callback";
  process.env.TEX64_AI_BYPASS_ENTITLEMENT = "1";
  process.env.TEX64_E2E_HEADLESS = "1";
  process.env.TEX64_E2E_USERDATA = "/tmp/e2e-userdata";
  try {
    const service = new PlatformAccessService({
      userDataPath: path.join(os.tmpdir(), "tex64-platform-access-test"),
      strictProduction: true,
      allowDirectOAuthCallbackAuthUrl: true,
    });
    assert.equal(service.apiBaseUrl, "https://tex64.com/api/v2");
    assert.equal(service.webBaseUrl, "https://tex64.com");
    assert.equal(service.redirectUri, "tex64://oauth/callback");
    assert.equal(service.bypassEntitlement, false);
    assert.equal(service.allowDirectOAuthCallbackAuthUrl, false);
  } finally {
    if (oldApi === undefined) {
      delete process.env.TEX64_PLATFORM_API_BASE_URL;
    } else {
      process.env.TEX64_PLATFORM_API_BASE_URL = oldApi;
    }
    if (oldWeb === undefined) {
      delete process.env.TEX64_PLATFORM_WEB_BASE_URL;
    } else {
      process.env.TEX64_PLATFORM_WEB_BASE_URL = oldWeb;
    }
    if (oldRedirect === undefined) {
      delete process.env.TEX64_PLATFORM_OAUTH_REDIRECT_URI;
    } else {
      process.env.TEX64_PLATFORM_OAUTH_REDIRECT_URI = oldRedirect;
    }
    if (oldBypass === undefined) {
      delete process.env.TEX64_AI_BYPASS_ENTITLEMENT;
    } else {
      process.env.TEX64_AI_BYPASS_ENTITLEMENT = oldBypass;
    }
    if (oldE2EHeadless === undefined) {
      delete process.env.TEX64_E2E_HEADLESS;
    } else {
      process.env.TEX64_E2E_HEADLESS = oldE2EHeadless;
    }
    if (oldE2EUserData === undefined) {
      delete process.env.TEX64_E2E_USERDATA;
    } else {
      process.env.TEX64_E2E_USERDATA = oldE2EUserData;
    }
  }
});

test("startGoogleAuth rejects direct callback auth URL in strictProduction mode", async () => {
  const service = new PlatformAccessService({
    userDataPath: path.join(os.tmpdir(), "tex64-platform-access-test"),
    strictProduction: true,
  });
  const state = {
    deviceId: "device-1",
    session: null,
    oauthPending: null,
    aiAccessCache: null,
    aiAccessFetchedAt: 0,
    aiUsageCache: null,
    aiUsageFetchedAt: 0,
  };
  service.ensureLoadedState = async () => state;
  service.ensureDeviceId = async () => "device-1";
  service.requestJson = async () => ({
    authUrl: "tex64://oauth/callback?code=abc&state=invalid",
    state: "oauth-state",
  });

  await assert.rejects(service.startGoogleAuth(), (error) => {
    assert.equal(error?.code, "AUTH_INVALID_RESPONSE");
    return true;
  });
  assert.equal(state.oauthPending, null);
});
