export const STATE_BACKEND_UNAVAILABLE = Object.freeze({
  statusCode: 503,
  code: "STATE_BACKEND_UNAVAILABLE",
  message:
    "Persistent state backend is unavailable. Configure DATABASE_URL or enable fallback for development.",
});

export const isStateFallbackEnabled = (config) =>
  Boolean(config?.stateFallbackEnabled);
