import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadPlatformState, savePlatformState } from "../../api/v2/_lib/state-store.js";
import {
  isSubscriptionEventProcessed,
  markSubscriptionEventProcessed,
} from "../../api/v2/_lib/subscription-event-store.js";

const createConfig = (suffix) => ({
  databaseUrl: "",
  stateFallbackEnabled: true,
  stateFilePath: path.join(
    os.tmpdir(),
    `tex64-subscription-event-store-${suffix}.json`
  ),
});

test("subscription-event-store marks duplicate events in fallback mode", async () => {
  const config = createConfig(`dup-${Date.now()}`);
  const source = "tex64.com";
  const eventId = "evt_duplicate_test";

  const processedBefore = await isSubscriptionEventProcessed(config, source, eventId);
  assert.equal(processedBefore, false);

  const first = await markSubscriptionEventProcessed(config, {
    source,
    eventId,
    userId: "usr_1",
    payload: { plan: "basic", status: "active" },
  });
  assert.equal(first.tracked, true);
  assert.equal(first.duplicate, false);

  const processedAfter = await isSubscriptionEventProcessed(config, source, eventId);
  assert.equal(processedAfter, true);

  const second = await markSubscriptionEventProcessed(config, {
    source,
    eventId,
    userId: "usr_1",
    payload: { plan: "pro", status: "active" },
  });
  assert.equal(second.tracked, true);
  assert.equal(second.duplicate, true);
});

test("subscription-event-store prunes expired event records", async () => {
  const config = createConfig(`prune-${Date.now()}`);
  const source = "tex64.com";
  const eventId = "evt_expired_test";
  await markSubscriptionEventProcessed(config, {
    source,
    eventId,
    userId: "usr_2",
    payload: { status: "grace" },
  });

  const state = await loadPlatformState(config);
  const key = `${source}:${eventId}`;
  assert.ok(state.processedSubscriptionEvents[key]);
  state.processedSubscriptionEvents[key].createdAt = new Date(
    Date.now() - 10 * 60 * 1000
  ).toISOString();
  await savePlatformState(config, state);

  const stillProcessed = await isSubscriptionEventProcessed(config, source, eventId, {
    pruneMaxAgeMs: 1000,
  });
  assert.equal(stillProcessed, false);
});
