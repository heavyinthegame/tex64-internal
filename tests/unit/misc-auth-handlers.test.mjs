import assert from "node:assert/strict";
import os from "node:os";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createMiscHandlers } = require("../../electron/handlers/misc.cjs");

const createAuthSnapshot = (state) => ({
  authenticated: Boolean(state.authenticated),
  pending: Boolean(state.pending),
  user: state.authenticated ? { id: "usr_1", email: "user@example.com", name: "User" } : null,
  plan: state.authenticated ? "pro" : null,
  pricingUrl: "https://tex64.com/pricing",
});

const createAiAccessSnapshot = (state) => ({
  authenticated: Boolean(state.authenticated),
  allowed: Boolean(state.authenticated),
  reason: state.authenticated ? "active" : "AUTH_REQUIRED",
  status: state.authenticated ? "active" : null,
  plan: state.authenticated ? "pro" : null,
  user: state.authenticated ? { id: "usr_1", email: "user@example.com", name: "User" } : null,
  quota: null,
  periodStart: null,
  periodEnd: null,
  graceEndsAt: null,
  message: null,
  pricingUrl: "https://tex64.com/pricing",
  fetchedAt: Date.now(),
});

const createAiUsageSnapshot = (state) => ({
  authenticated: Boolean(state.authenticated),
  plan: state.authenticated ? "pro" : null,
  period: null,
  summary: null,
  byFeature: null,
  errorCode: state.authenticated ? null : "AUTH_REQUIRED",
  message: null,
  fetchedAt: Date.now(),
});

const createHarness = (options = {}) => {
  const events = [];
  const state = { authenticated: false, pending: false };
  const calls = {
    startGoogleAuth: 0,
    completeGoogleAuthFromCallback: [],
    cancelGoogleAuthPending: 0,
    openExternal: [],
  };

  const shell =
    options.shell ??
    {
      openExternal: async (url) => {
        calls.openExternal.push(url);
        if (options.openExternalError) {
          throw options.openExternalError;
        }
      },
    };

  const platformService = {
    getAuthSnapshot: async () => createAuthSnapshot(state),
    startGoogleAuth: async () => {
      calls.startGoogleAuth += 1;
      if (typeof options.startGoogleAuth === "function") {
        return await options.startGoogleAuth(state);
      }
      state.pending = true;
      return {
        bypassed: false,
        authUrl: "https://accounts.example.com/oauth",
        reused: false,
      };
    },
    completeGoogleAuthFromCallback: async (callbackUrl) => {
      calls.completeGoogleAuthFromCallback.push(callbackUrl);
      state.pending = false;
      state.authenticated = true;
      if (typeof options.completeGoogleAuthFromCallback === "function") {
        return await options.completeGoogleAuthFromCallback(callbackUrl, state);
      }
      return createAuthSnapshot(state);
    },
    cancelGoogleAuthPending: async () => {
      calls.cancelGoogleAuthPending += 1;
      state.pending = false;
      if (typeof options.cancelGoogleAuthPending === "function") {
        return await options.cancelGoogleAuthPending(state);
      }
      return createAuthSnapshot(state);
    },
    checkAiAccess: async () => createAiAccessSnapshot(state),
    fetchAiUsage: async () => createAiUsageSnapshot(state),
    signOut: async () => {
      state.pending = false;
      state.authenticated = false;
      return createAuthSnapshot(state);
    },
  };

  const handlers = createMiscHandlers({
    envService: {
      checkCommand: async () => true,
      installEnvironment: async () => ({ success: true, message: "ok" }),
    },
    ensureUserSettings: () => ({
      getRecentProjects: async () => [],
      removeRecentProject: async () => [],
      addRecentProject: async () => [],
    }),
    workspace: {
      getRootPath: () => null,
    },
    shell,
    Notification: null,
    sendToRenderer: (type, payload) => {
      events.push({ type, payload });
    },
    blocksStore: {
      load: async () => [],
      save: async () => {},
    },
    apiUsageService: {
      getSnapshot: async () => ({}),
      reset: async () => ({}),
    },
    platformService,
    runtimeInfo: {
      version: "0.1.0",
      platform: "darwin",
      arch: "arm64",
      userDataPath: os.tmpdir(),
    },
  });

  return {
    handlers,
    events,
    calls,
    state,
  };
};

test("handleAuthGoogleStart consumes tex64 callback URL without opening browser", async () => {
  const harness = createHarness({
    startGoogleAuth: async (state) => {
      state.pending = true;
      return {
        bypassed: false,
        authUrl: "tex64://oauth/callback?code=abc&state=oauth-state",
        reused: false,
      };
    },
  });

  await harness.handlers.handleAuthGoogleStart();

  assert.equal(harness.calls.startGoogleAuth, 1);
  assert.equal(harness.calls.openExternal.length, 0);
  assert.equal(harness.calls.completeGoogleAuthFromCallback.length, 1);
  assert.equal(
    harness.calls.completeGoogleAuthFromCallback[0],
    "tex64://oauth/callback?code=abc&state=oauth-state"
  );
  const authEvents = harness.events.filter((event) => event.type === "platform:auth");
  assert.ok(authEvents.length >= 2);
  const lastAuth = authEvents[authEvents.length - 1].payload.auth;
  assert.equal(lastAuth.authenticated, true);
  assert.equal(lastAuth.pending, false);
  const aiAccessEvents = harness.events.filter((event) => event.type === "platform:aiAccess");
  const usageEvents = harness.events.filter((event) => event.type === "platform:usage");
  assert.equal(aiAccessEvents.length, 1);
  assert.equal(usageEvents.length, 2);
  assert.equal(aiAccessEvents[0].payload.source, "auth");
  assert.equal(usageEvents[0].payload.source, "auth");
  assert.equal(usageEvents[1].payload.source, "auth");
});

test("handleAuthGoogleStart consumes legacy tex64 callback URL without opening browser", async () => {
  const harness = createHarness({
    startGoogleAuth: async (state) => {
      state.pending = true;
      return {
        bypassed: false,
        authUrl: "tex64://account/oauth/callback?code=abc&state=oauth-state",
        reused: false,
      };
    },
  });

  await harness.handlers.handleAuthGoogleStart();

  assert.equal(harness.calls.startGoogleAuth, 1);
  assert.equal(harness.calls.openExternal.length, 0);
  assert.equal(harness.calls.completeGoogleAuthFromCallback.length, 1);
  assert.equal(
    harness.calls.completeGoogleAuthFromCallback[0],
    "tex64://account/oauth/callback?code=abc&state=oauth-state"
  );
  const authEvents = harness.events.filter((event) => event.type === "platform:auth");
  assert.ok(authEvents.length >= 2);
  const lastAuth = authEvents[authEvents.length - 1].payload.auth;
  assert.equal(lastAuth.authenticated, true);
  assert.equal(lastAuth.pending, false);
});

test("handleAuthGoogleStart clears pending auth when browser open fails", async () => {
  const harness = createHarness({
    openExternalError: new Error("open failed"),
  });

  await harness.handlers.handleAuthGoogleStart();

  assert.equal(harness.calls.startGoogleAuth, 1);
  assert.equal(harness.calls.openExternal.length, 1);
  assert.equal(harness.calls.cancelGoogleAuthPending, 1);
  const authErrorEvent = [...harness.events]
    .reverse()
    .find((event) => event.type === "platform:auth" && event.payload?.error);
  assert.ok(authErrorEvent, "platform:auth error event should be emitted");
  assert.equal(authErrorEvent.payload.error.code, "AUTH_BROWSER_OPEN_FAILED");
  assert.equal(authErrorEvent.payload.auth.pending, false);
});

test("handleAuthGoogleStart clears pending auth when browser API is unavailable", async () => {
  const harness = createHarness({
    shell: {},
  });

  await harness.handlers.handleAuthGoogleStart();

  assert.equal(harness.calls.startGoogleAuth, 1);
  assert.equal(harness.calls.openExternal.length, 0);
  assert.equal(harness.calls.cancelGoogleAuthPending, 1);
  const authErrorEvent = [...harness.events]
    .reverse()
    .find((event) => event.type === "platform:auth" && event.payload?.error);
  assert.ok(authErrorEvent, "platform:auth error event should be emitted");
  assert.equal(authErrorEvent.payload.error.code, "AUTH_BROWSER_UNAVAILABLE");
  assert.equal(authErrorEvent.payload.auth.pending, false);
});
