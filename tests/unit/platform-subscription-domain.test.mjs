import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQuotaSummary,
  consumeQuota,
  ensureSubscriptionState,
  ensureUsageRecord,
  ensureUserRecord,
  evaluateAiFeature,
  upsertSubscriptionRecord,
} from "../../api/v2/_lib/subscription-domain.js";

const config = {
  defaultPlan: "free",
  defaultStatus: "active",
  graceDays: 3,
  freeMonthlyTokens: 0,
  basicBudgetUsd: 1,
  proBudgetUsd: 10,
  blendedCostPerTokenUsd: 0.000002,
  requestLimitFree: 100,
  requestLimitBasic: 10000,
  requestLimitPro: 100000,
};

const buildState = () => ({
  users: {},
  usersByEmail: {},
  subscriptions: {},
  usage: {},
});

test("default free subscription blocks AI by plan", () => {
  const state = buildState();
  const userResult = ensureUserRecord(state, { email: "user@example.com", name: "User" });
  const subscriptionResult = ensureSubscriptionState(
    state,
    userResult.user.id,
    config,
    new Date("2026-02-15T00:00:00Z")
  );
  const usageResult = ensureUsageRecord(state, userResult.user.id, subscriptionResult.subscription);
  const feature = evaluateAiFeature(subscriptionResult.subscription, usageResult.usage);

  assert.equal(subscriptionResult.subscription.plan, "free");
  assert.equal(feature.enabled, false);
  assert.equal(feature.reason, "PLAN_REQUIRED");
  assert.equal(feature.quota.limitTokens, 0);
});

test("active subscription rolls over monthly and resets usage", () => {
  const state = buildState();
  const userResult = ensureUserRecord(state, { email: "basic@example.com" });
  upsertSubscriptionRecord(
    state,
    userResult.user.id,
    {
      plan: "basic",
      status: "active",
      billingPeriodStart: "2026-02-01T00:00:00Z",
      billingPeriodEnd: "2026-03-01T00:00:00Z",
      quotaPeriodStart: "2026-02-01T00:00:00Z",
      quotaPeriodEnd: "2026-03-01T00:00:00Z",
      quotaLimitTokens: 500000,
      quotaLimitRequests: 10000,
    },
    config,
    new Date("2026-02-20T00:00:00Z")
  );
  const beforeUsage = ensureUsageRecord(state, userResult.user.id, state.subscriptions[userResult.user.id]);
  consumeQuota(beforeUsage.usage, "chat", 1200, 3);
  const beforeSummary = buildQuotaSummary(beforeUsage.usage);
  assert.equal(beforeSummary.usedTokens, 1200);

  const rolled = ensureSubscriptionState(
    state,
    userResult.user.id,
    config,
    new Date("2026-03-05T00:00:00Z")
  );
  const afterUsage = ensureUsageRecord(state, userResult.user.id, rolled.subscription);
  const summary = buildQuotaSummary(afterUsage.usage);

  assert.equal(rolled.subscription.billingPeriodStart, "2026-03-01T00:00:00.000Z");
  assert.equal(rolled.subscription.billingPeriodEnd, "2026-04-01T00:00:00.000Z");
  assert.equal(summary.usedTokens, 0);
  assert.equal(summary.limitTokens, 500000);
});

test("grace state keeps previous quota window without reset", () => {
  const state = buildState();
  const userResult = ensureUserRecord(state, { email: "grace@example.com" });
  upsertSubscriptionRecord(
    state,
    userResult.user.id,
    {
      plan: "basic",
      status: "grace",
      billingPeriodStart: "2026-02-01T00:00:00Z",
      billingPeriodEnd: "2026-03-01T00:00:00Z",
      graceEndsAt: "2026-03-04T00:00:00Z",
      quotaPeriodStart: "2026-02-01T00:00:00Z",
      quotaPeriodEnd: "2026-03-01T00:00:00Z",
      quotaLimitTokens: 500000,
      quotaLimitRequests: 10000,
    },
    config,
    new Date("2026-03-01T12:00:00Z")
  );
  const usageResult = ensureUsageRecord(state, userResult.user.id, state.subscriptions[userResult.user.id]);
  consumeQuota(usageResult.usage, "chat", 3456, 2);
  const beforePeriodStart = usageResult.usage.periodStart;
  const beforeUsedTokens = usageResult.usage.usedTokens;

  const after = ensureSubscriptionState(
    state,
    userResult.user.id,
    config,
    new Date("2026-03-02T12:00:00Z")
  );
  const usageAfter = ensureUsageRecord(state, userResult.user.id, after.subscription);
  const summary = buildQuotaSummary(usageAfter.usage);
  const feature = evaluateAiFeature(after.subscription, usageAfter.usage);

  assert.equal(after.subscription.status, "grace");
  assert.equal(usageAfter.usage.periodStart, beforePeriodStart);
  assert.equal(summary.usedTokens, beforeUsedTokens);
  assert.equal(feature.enabled, true);
  assert.equal(feature.reason, "PAYMENT_GRACE");
});

test("grace expires to past_due and blocks AI", () => {
  const state = buildState();
  const userResult = ensureUserRecord(state, { email: "pastdue@example.com" });
  upsertSubscriptionRecord(
    state,
    userResult.user.id,
    {
      plan: "pro",
      status: "grace",
      billingPeriodStart: "2026-02-01T00:00:00Z",
      billingPeriodEnd: "2026-03-01T00:00:00Z",
      graceEndsAt: "2026-03-04T00:00:00Z",
      quotaPeriodStart: "2026-02-01T00:00:00Z",
      quotaPeriodEnd: "2026-03-01T00:00:00Z",
      quotaLimitTokens: 5000000,
      quotaLimitRequests: 100000,
    },
    config,
    new Date("2026-03-01T00:00:00Z")
  );

  const updated = ensureSubscriptionState(
    state,
    userResult.user.id,
    config,
    new Date("2026-03-05T00:00:00Z")
  );
  const usage = ensureUsageRecord(state, userResult.user.id, updated.subscription);
  const feature = evaluateAiFeature(updated.subscription, usage.usage);

  assert.equal(updated.subscription.status, "past_due");
  assert.equal(feature.enabled, false);
  assert.equal(feature.reason, "PAYMENT_PAST_DUE");
});

test("billing period patch aligns quota period and resets usage window", () => {
  const state = buildState();
  const userResult = ensureUserRecord(state, { email: "cycle@example.com" });
  upsertSubscriptionRecord(
    state,
    userResult.user.id,
    {
      plan: "basic",
      status: "active",
      billingPeriodStart: "2026-02-01T00:00:00Z",
      billingPeriodEnd: "2026-03-01T00:00:00Z",
      quotaPeriodStart: "2026-02-01T00:00:00Z",
      quotaPeriodEnd: "2026-03-01T00:00:00Z",
    },
    config,
    new Date("2026-02-05T00:00:00Z")
  );
  const beforeUsage = ensureUsageRecord(state, userResult.user.id, state.subscriptions[userResult.user.id]);
  consumeQuota(beforeUsage.usage, "chat", 1234, 2);
  assert.equal(beforeUsage.usage.usedTokens, 1234);

  const patched = upsertSubscriptionRecord(
    state,
    userResult.user.id,
    {
      billingPeriodStart: "2026-03-01T00:00:00Z",
      billingPeriodEnd: "2026-04-01T00:00:00Z",
    },
    config,
    new Date("2026-03-01T00:00:00Z")
  );
  assert.equal(patched.quotaPeriodStart, "2026-03-01T00:00:00.000Z");
  assert.equal(patched.quotaPeriodEnd, "2026-04-01T00:00:00.000Z");
  assert.equal(patched.quotaLimitTokens, 500000);

  const afterUsage = ensureUsageRecord(state, userResult.user.id, patched);
  assert.equal(afterUsage.usage.periodStart, "2026-03-01T00:00:00.000Z");
  assert.equal(afterUsage.usage.usedTokens, 0);
});

test("plan change recomputes quota limits when explicit limits are omitted", () => {
  const state = buildState();
  const userResult = ensureUserRecord(state, { email: "upgrade@example.com" });
  const before = upsertSubscriptionRecord(
    state,
    userResult.user.id,
    {
      plan: "basic",
      status: "active",
      billingPeriodStart: "2026-02-01T00:00:00Z",
      billingPeriodEnd: "2026-03-01T00:00:00Z",
      quotaPeriodStart: "2026-02-01T00:00:00Z",
      quotaPeriodEnd: "2026-03-01T00:00:00Z",
    },
    config,
    new Date("2026-02-10T00:00:00Z")
  );
  assert.equal(before.quotaLimitTokens, 500000);
  assert.equal(before.quotaLimitRequests, 10000);

  const upgraded = upsertSubscriptionRecord(
    state,
    userResult.user.id,
    { plan: "pro" },
    config,
    new Date("2026-02-20T00:00:00Z")
  );
  assert.equal(upgraded.plan, "pro");
  assert.equal(upgraded.quotaLimitTokens, 5000000);
  assert.equal(upgraded.quotaLimitRequests, 100000);
});

test("consumeQuota throws when limit is exceeded", () => {
  const usage = {
    periodStart: "2026-02-01T00:00:00Z",
    periodEnd: "2026-03-01T00:00:00Z",
    limitTokens: 10,
    limitRequests: 2,
    usedTokens: 9,
    usedRequests: 1,
    byFeature: {
      chat: { usedTokens: 9, usedRequests: 1 },
      completion: { usedTokens: 0, usedRequests: 0 },
    },
  };

  assert.throws(() => consumeQuota(usage, "chat", 2, 1), {
    name: "ApiError",
    code: "QUOTA_EXCEEDED",
  });
});
