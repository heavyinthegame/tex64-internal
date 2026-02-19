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
