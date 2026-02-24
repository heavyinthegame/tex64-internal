import {
  ApiError,
  createRequestId,
  handleOptionsRequest,
  parseUrl,
  sendApiError,
  setCorsHeaders,
} from "../../_lib/http.js";

const DESKTOP_CALLBACK_URI = "tex64://oauth/callback";

const asNonEmptyString = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const buildDesktopCallbackUrl = (requestUrl) => {
  const source = new URL(requestUrl);
  const target = new URL(DESKTOP_CALLBACK_URI);
  const code = asNonEmptyString(source.searchParams.get("code"));
  const state = asNonEmptyString(source.searchParams.get("state"));
  const error = asNonEmptyString(source.searchParams.get("error"));
  const errorDescription = asNonEmptyString(
    source.searchParams.get("error_description")
  );

  if (code) {
    target.searchParams.set("code", code);
  }
  if (state) {
    target.searchParams.set("state", state);
  }
  if (error) {
    target.searchParams.set("error", error);
  }
  if (errorDescription) {
    target.searchParams.set("error_description", errorDescription);
  }
  if (!code && !error) {
    target.searchParams.set("error", "invalid_request");
    target.searchParams.set(
      "error_description",
      "Missing code or error in OAuth callback."
    );
  }
  if (!state) {
    target.searchParams.set("error", "invalid_request");
    target.searchParams.set("error_description", "Missing OAuth state in callback.");
  }
  return target.toString();
};

const handler = async (req, res) => {
  if (handleOptionsRequest(req, res)) {
    return;
  }
  setCorsHeaders(res);
  const requestId = createRequestId();
  try {
    if (req.method !== "GET") {
      throw new ApiError("METHOD_NOT_ALLOWED", "Method Not Allowed.", 405);
    }
    const callbackUrl = buildDesktopCallbackUrl(parseUrl(req).toString());
    res.statusCode = 302;
    res.setHeader("Location", callbackUrl);
    res.end();
  } catch (error) {
    sendApiError(res, requestId, error);
  }
};

export default handler;
