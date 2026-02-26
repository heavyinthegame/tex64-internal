import assert from "node:assert/strict";
import os from "node:os";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createMiscHandlers } = require("../../electron/handlers/misc.cjs");

const createHarness = (fetchUpdateManifest) => {
  const events = [];
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
    shell: {
      openExternal: async () => {},
      openPath: async () => "",
    },
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
    platformService: {
      fetchUpdateManifest,
      getAuthSnapshot: async () => ({
        authenticated: false,
        pending: false,
        user: null,
        plan: "free",
        pricingUrl: "https://tex64.com/pricing",
      }),
      checkAiAccess: async () => ({
        authenticated: false,
        allowed: false,
        reason: "AUTH_REQUIRED",
        pricingUrl: "https://tex64.com/pricing",
        fetchedAt: Date.now(),
      }),
      fetchAiUsage: async () => ({
        authenticated: false,
        plan: "free",
        summary: null,
        byFeature: null,
        errorCode: "AUTH_REQUIRED",
        fetchedAt: Date.now(),
      }),
    },
    runtimeInfo: {
      version: "0.1.0",
      platform: "darwin",
      arch: "arm64",
      userDataPath: os.tmpdir(),
    },
  });
  return { handlers, events };
};

const getLastUpdateStatus = (events) => {
  const statusEvents = events.filter((event) => event.type === "platform:updateStatus");
  return statusEvents.at(-1)?.payload?.status ?? null;
};

test("handleUpdateCheck emits available status when newer version exists", async () => {
  const harness = createHarness(async () => ({
    latestVersion: "0.2.0",
    currentVersion: "0.1.0",
    hasUpdate: true,
    required: false,
    notesUrl: "https://tex64.com/releases/0.2.0",
    artifactUrl: "https://downloads.tex64.com/tex64/v0.2.0/TeX64-0.2.0-mac-arm64.dmg",
    artifactSha256:
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    checkedAt: Date.now(),
  }));

  await harness.handlers.handleUpdateCheck({ force: true, source: "manual" });

  const updateEvents = harness.events.filter((event) => event.type === "platform:update");
  assert.equal(updateEvents.length >= 1, true);
  assert.equal(updateEvents.at(-1)?.payload?.update?.hasUpdate, true);
  assert.equal(updateEvents.at(-1)?.payload?.update?.latestVersion, "0.2.0");

  const finalStatus = getLastUpdateStatus(harness.events);
  assert.equal(finalStatus?.phase, "available");
  assert.equal(finalStatus?.latestVersion, "0.2.0");
  assert.equal(finalStatus?.currentVersion, "0.1.0");
});

test("handleUpdateCheck emits up-to-date status when no newer version exists", async () => {
  const harness = createHarness(async () => ({
    latestVersion: "0.1.0",
    currentVersion: "0.1.0",
    hasUpdate: false,
    required: false,
    notesUrl: "https://tex64.com/releases/0.1.0",
    artifactUrl: "https://downloads.tex64.com/tex64/v0.1.0/TeX64-0.1.0-mac-arm64.dmg",
    artifactSha256:
      "sha256:abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    checkedAt: Date.now(),
  }));

  await harness.handlers.handleUpdateCheck({ force: true, source: "manual" });
  const finalStatus = getLastUpdateStatus(harness.events);
  assert.equal(finalStatus?.phase, "up-to-date");
  assert.equal(finalStatus?.latestVersion, "0.1.0");
  assert.equal(finalStatus?.currentVersion, "0.1.0");
});
