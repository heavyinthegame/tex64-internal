import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  consumeOAuthRequest,
  persistRefreshToken,
  revokeRefreshTokens,
  rotateRefreshToken,
  storeOAuthRequest,
} from "../../api/v2/_lib/auth-storage.js";

const createConfig = (suffix) => ({
  databaseUrl: "",
  stateFallbackEnabled: true,
  stateFilePath: path.join(os.tmpdir(), `tex64-auth-storage-${suffix}.json`),
});

test("auth-storage stores and consumes oauth state in fallback mode", async () => {
  const config = createConfig(`oauth-${Date.now()}`);
  const payload = {
    deviceId: "device-12345678",
    redirectUri: "tex64://oauth/callback",
    codeChallenge: "x".repeat(43),
    codeChallengeMethod: "S256",
  };

  const stored = await storeOAuthRequest(config, "st_test", payload, {
    pruneMaxAgeMs: 10_000,
  });
  assert.equal(stored, true);

  const consumed = await consumeOAuthRequest(config, "st_test", {
    pruneMaxAgeMs: 10_000,
  });
  assert.deepEqual(consumed, payload);

  const consumedAgain = await consumeOAuthRequest(config, "st_test", {
    pruneMaxAgeMs: 10_000,
  });
  assert.equal(consumedAgain, null);
});

test("auth-storage rotates and revokes refresh tokens in fallback mode", async () => {
  const config = createConfig(`refresh-${Date.now()}`);
  const oldRefreshToken = "old-refresh-token-value";
  const newRefreshToken = "new-refresh-token-value";
  const userId = "usr_refresh_test";
  const deviceId = "device-12345678";
  const expiresAtEpochSec = Math.floor(Date.now() / 1000) + 3600;

  const persisted = await persistRefreshToken(config, {
    refreshToken: oldRefreshToken,
    userId,
    deviceId,
    expiresAtEpochSec,
    metadata: { source: "test_persist" },
  });
  assert.equal(persisted.ok, true);

  const rotated = await rotateRefreshToken(config, {
    oldRefreshToken,
    newRefreshToken,
    userId,
    deviceId,
    newExpiresAtEpochSec: expiresAtEpochSec + 60,
    metadata: { source: "test_rotate" },
  });
  assert.equal(rotated.ok, true);

  const rotatedAgain = await rotateRefreshToken(config, {
    oldRefreshToken,
    newRefreshToken: `${newRefreshToken}-2`,
    userId,
    deviceId,
    newExpiresAtEpochSec: expiresAtEpochSec + 120,
    metadata: { source: "test_rotate_again" },
  });
  assert.equal(rotatedAgain.ok, false);
  assert.equal(rotatedAgain.reason, "REVOKED");

  const revokedCount = await revokeRefreshTokens(config, {
    userId,
    deviceId,
    allDevices: false,
  });
  assert.equal(revokedCount, 1);

  const rotateAfterRevoke = await rotateRefreshToken(config, {
    oldRefreshToken: newRefreshToken,
    newRefreshToken: `${newRefreshToken}-3`,
    userId,
    deviceId,
    newExpiresAtEpochSec: expiresAtEpochSec + 180,
    metadata: { source: "test_rotate_after_revoke" },
  });
  assert.equal(rotateAfterRevoke.ok, false);
  assert.equal(rotateAfterRevoke.reason, "REVOKED");
});
