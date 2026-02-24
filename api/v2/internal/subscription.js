import {
  ApiError,
  createRequestId,
  handleOptionsRequest,
  readJsonBody,
  sendApiError,
  sendJson,
  setCorsHeaders,
} from "../_lib/http.js";
import { getRuntimeConfig } from "../_lib/runtime-config.js";
import {
  isSubscriptionEventProcessed,
  markSubscriptionEventProcessed,
} from "../_lib/subscription-event-store.js";
import {
  applySubscriptionPatch,
  getUsageSnapshot,
  getUserContext,
} from "../_lib/user-context.js";

const isObject = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const WEBHOOK_TOKEN_REGEX = /^[A-Za-z0-9._:-]+$/;

const sanitizeString = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const readHeaderString = (req, headerName) => {
  const value = req?.headers?.[headerName];
  if (Array.isArray(value)) {
    return sanitizeString(value[0]);
  }
  return sanitizeString(value);
};

const sanitizeWebhookToken = (value, maxLength) => {
  const token = sanitizeString(value);
  if (!token) {
    return null;
  }
  if (token.length > maxLength || !WEBHOOK_TOKEN_REGEX.test(token)) {
    return null;
  }
  return token;
};

const asEmail = (value) => {
  const email = sanitizeString(value)?.toLowerCase() ?? null;
  if (!email) {
    return null;
  }
  if (!email.includes("@")) {
    return null;
  }
  return email;
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
    if (!config.adminSecret) {
      throw new ApiError(
        "INTERNAL_ERROR",
        "TEX64_PLATFORM_ADMIN_SECRET is not configured.",
        500
      );
    }
    const providedSecret = sanitizeString(req.headers?.["x-tex64-admin-secret"]);
    if (!providedSecret || providedSecret !== config.adminSecret) {
      throw new ApiError("AUTH_REQUIRED", "Admin authentication failed.", 401);
    }
    const body = await readJsonBody(req);
    if (!isObject(body)) {
      throw new ApiError("VALIDATION_ERROR", "JSON body is required.", 400);
    }
    const email = asEmail(body.email);
    const explicitUserId = sanitizeString(body.userId);
    if (!explicitUserId && !email) {
      throw new ApiError(
        "VALIDATION_ERROR",
        "Either userId or email is required to update a subscription.",
        400
      );
    }
    const rawSource =
      sanitizeString(body.source) ||
      readHeaderString(req, "x-tex64-webhook-source") ||
      readHeaderString(req, "x-tex64-source") ||
      "manual";
    const source = sanitizeWebhookToken(rawSource, 64);
    if (!source) {
      throw new ApiError(
        "VALIDATION_ERROR",
        "Webhook source is invalid.",
        400
      );
    }
    const rawEventId =
      sanitizeString(body.eventId) ||
      readHeaderString(req, "x-tex64-event-id") ||
      readHeaderString(req, "idempotency-key");
    const eventId = sanitizeWebhookToken(rawEventId, 180);
    if (rawEventId && !eventId) {
      throw new ApiError("VALIDATION_ERROR", "eventId is invalid.", 400);
    }

    const userClaims = {
      id: explicitUserId,
      email,
      name: sanitizeString(body.name),
    };
    const patch = {};
    if (sanitizeString(body.plan)) {
      patch.plan = sanitizeString(body.plan);
    }
    if (sanitizeString(body.status)) {
      patch.status = sanitizeString(body.status);
    }
    if (sanitizeString(body.billingPeriodStart)) {
      patch.billingPeriodStart = sanitizeString(body.billingPeriodStart);
    }
    if (sanitizeString(body.billingPeriodEnd)) {
      patch.billingPeriodEnd = sanitizeString(body.billingPeriodEnd);
    }
    if (sanitizeString(body.graceEndsAt)) {
      patch.graceEndsAt = sanitizeString(body.graceEndsAt);
    }
    if (Number.isFinite(Number(body.quotaLimitTokens))) {
      patch.quotaLimitTokens = Number(body.quotaLimitTokens);
    }
    if (Number.isFinite(Number(body.quotaLimitRequests))) {
      patch.quotaLimitRequests = Number(body.quotaLimitRequests);
    }
    const pruneMaxAgeMs =
      Math.max(3600, Math.round(config.subscriptionEventTtlSec || 90 * 24 * 60 * 60)) *
      1000;
    if (eventId) {
      const duplicate = await isSubscriptionEventProcessed(
        config,
        source,
        eventId,
        { pruneMaxAgeMs }
      );
      if (duplicate) {
        const duplicateContext = await getUserContext(config, userClaims);
        const duplicateUsage = getUsageSnapshot(duplicateContext.usage);
        sendJson(res, 200, {
          requestId,
          duplicate: true,
          source,
          eventId,
          user: {
            id: duplicateContext.user.id,
            email: duplicateContext.user.email,
            name: duplicateContext.user.name,
          },
          subscription: duplicateContext.subscription,
          summary: duplicateUsage.summary,
          byFeature: duplicateUsage.byFeature,
        });
        return;
      }
    }
    const context = await applySubscriptionPatch({
      config,
      userClaims,
      patch,
      resetUsage: body.resetUsage === true,
    });
    let duplicate = false;
    if (eventId) {
      const tracking = await markSubscriptionEventProcessed(
        config,
        {
          source,
          eventId,
          userId: context.user.id,
          payload: patch,
        },
        { pruneMaxAgeMs }
      );
      duplicate = tracking?.duplicate === true;
    }
    const usage = getUsageSnapshot(context.usage);

    sendJson(res, 200, {
      requestId,
      duplicate,
      source: eventId ? source : null,
      eventId: eventId || null,
      user: {
        id: context.user.id,
        email: context.user.email,
        name: context.user.name,
      },
      subscription: context.subscription,
      summary: usage.summary,
      byFeature: usage.byFeature,
    });
  } catch (error) {
    sendApiError(res, requestId, error);
  }
};

export default handler;
