import {
  deleteUsageRecordsForUser,
  getSubscriptionRecordByUserId,
  getUsageRecordForUserPeriod,
  isDatabaseConfigured,
  upsertSubscriptionRecordForUser,
  upsertUsageRecordForUserPeriod,
  upsertUserRecord,
} from "./db-adapter.js";
import { ApiError } from "./http.js";
import { loadPlatformState, savePlatformState } from "./state-store.js";
import { isStateFallbackEnabled } from "./state-backend.js";
import {
  buildQuotaSummary,
  buildUsageBreakdown,
  ensureSubscriptionState,
  ensureUsageRecord,
  ensureUserRecord,
  evaluateAiFeature,
  upsertSubscriptionRecord,
} from "./subscription-domain.js";

const buildEmptyState = () => ({
  users: {},
  usersByEmail: {},
  subscriptions: {},
  usage: {},
  authRequests: {},
  refreshTokens: {},
  processedSubscriptionEvents: {},
});

const applyContextFromState = (state, userClaims, config, now = new Date()) => {
  const userResult = ensureUserRecord(state, userClaims);
  const subscriptionResult = ensureSubscriptionState(
    state,
    userResult.user.id,
    config,
    now
  );
  const usageResult = ensureUsageRecord(
    state,
    userResult.user.id,
    subscriptionResult.subscription
  );
  return {
    user: userResult.user,
    subscription: subscriptionResult.subscription,
    usage: usageResult.usage,
    changed: Boolean(
      userResult.changed || subscriptionResult.changed || usageResult.changed
    ),
  };
};

const withFallbackState = async (config, userClaims, callback) => {
  const state = await loadPlatformState(config);
  const ctx = applyContextFromState(state, userClaims, config, new Date());
  return callback({
    backend: "fallback",
    state,
    ...ctx,
    save: async () => {
      await savePlatformState(config, state);
    },
  });
};

const withDatabaseState = async (config, userClaims, callback) => {
  const now = new Date();
  const state = buildEmptyState();
  const userRow = await upsertUserRecord(config, userClaims);
  const resolvedClaims = userRow
    ? {
        id: userRow.id,
        email: userRow.email,
        name: userRow.name,
      }
    : userClaims;
  const userResult = ensureUserRecord(state, resolvedClaims);
  const userId = userResult.user.id;
  const dbSubscription = await getSubscriptionRecordByUserId(config, userId);
  if (dbSubscription) {
    state.subscriptions[userId] = dbSubscription;
  }
  const subscriptionResult = ensureSubscriptionState(state, userId, config, now);
  const dbUsage = await getUsageRecordForUserPeriod(config, {
    userId,
    periodStart: subscriptionResult.subscription.quotaPeriodStart,
    periodEnd: subscriptionResult.subscription.quotaPeriodEnd,
  });
  if (dbUsage) {
    state.usage[userId] = dbUsage;
  }
  const usageResult = ensureUsageRecord(state, userId, subscriptionResult.subscription);
  const persist = async () => {
    await upsertUserRecord(config, userResult.user);
    await upsertSubscriptionRecordForUser(config, {
      userId,
      ...subscriptionResult.subscription,
    });
    await upsertUsageRecordForUserPeriod(config, {
      userId,
      ...usageResult.usage,
    });
  };
  if (
    userResult.changed ||
    subscriptionResult.changed ||
    usageResult.changed ||
    !dbSubscription ||
    !dbUsage
  ) {
    await persist();
  }
  return callback({
    backend: "database",
    state,
    user: userResult.user,
    subscription: subscriptionResult.subscription,
    usage: usageResult.usage,
    changed: false,
    save: persist,
  });
};

const ensureBackendAvailable = (config) => {
  if (isDatabaseConfigured(config) || isStateFallbackEnabled(config)) {
    return;
  }
  throw new ApiError(
    "STATE_BACKEND_UNAVAILABLE",
    "Persistent state backend is unavailable.",
    503
  );
};

export const withUserContext = async (config, userClaims, callback) => {
  ensureBackendAvailable(config);
  if (isDatabaseConfigured(config)) {
    return withDatabaseState(config, userClaims, callback);
  }
  return withFallbackState(config, userClaims, callback);
};

export const getUserContext = async (config, userClaims) =>
  withUserContext(config, userClaims, async (ctx) => {
    if (ctx.changed && typeof ctx.save === "function") {
      await ctx.save();
    }
    return {
      backend: ctx.backend,
      state: ctx.state,
      user: ctx.user,
      subscription: ctx.subscription,
      usage: ctx.usage,
      save: ctx.save,
    };
  });

export const getAiFeatureSnapshot = (subscription, usage, config) =>
  evaluateAiFeature(subscription, usage, config.pricingUrl);

export const getUsageSnapshot = (usage) => ({
  summary: buildQuotaSummary(usage),
  byFeature: buildUsageBreakdown(usage),
});

export const applySubscriptionPatch = async ({
  config,
  userClaims,
  patch = {},
  resetUsage = false,
}) =>
  withUserContext(config, userClaims, async (ctx) => {
    const userId = ctx.user.id;
    if (ctx.backend === "database") {
      const transient = buildEmptyState();
      transient.users[userId] = ctx.user;
      transient.subscriptions[userId] = ctx.subscription;
      upsertSubscriptionRecord(transient, userId, patch, config, new Date());
      const normalized = ensureSubscriptionState(transient, userId, config, new Date());
      await upsertSubscriptionRecordForUser(config, {
        userId,
        ...normalized.subscription,
      });
      if (resetUsage) {
        await deleteUsageRecordsForUser(config, userId);
      }
      return getUserContext(config, ctx.user);
    }
    upsertSubscriptionRecord(ctx.state, userId, patch, config, new Date());
    ensureSubscriptionState(ctx.state, userId, config, new Date());
    if (resetUsage) {
      delete ctx.state.usage[userId];
    }
    ensureUsageRecord(ctx.state, userId, ctx.state.subscriptions[userId]);
    await ctx.save();
    return getUserContext(config, ctx.user);
  });
