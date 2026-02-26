const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETAIN_FILES = 3;
const DEFAULT_MAX_LINE_BYTES = 20_000;
const DEFAULT_CHECK_INTERVAL = 25;

const normalizeInteger = (value, fallback) => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.round(parsed);
};

const clipUtf8Bytes = (value, maxBytes) => {
  const text = typeof value === "string" ? value : "";
  const limit = Math.max(512, normalizeInteger(maxBytes, DEFAULT_MAX_LINE_BYTES));
  if (Buffer.byteLength(text, "utf8") <= limit) {
    return { text, truncated: false };
  }
  const buffer = Buffer.from(text, "utf8");
  const clipped = buffer.slice(0, limit).toString("utf8");
  return { text: clipped, truncated: true };
};

const hashHex = (value) =>
  crypto.createHash("sha256").update(String(value ?? "")).digest("hex");

class AgentAuditService {
  constructor({
    userDataPath,
    fileName = "tex64-agent-audit.ndjson",
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    retainFiles = DEFAULT_RETAIN_FILES,
    maxLineBytes = DEFAULT_MAX_LINE_BYTES,
    rotateCheckInterval = DEFAULT_CHECK_INTERVAL,
  } = {}) {
    this.filePath = path.join(userDataPath || ".", fileName);
    this.maxFileBytes = Math.max(128 * 1024, normalizeInteger(maxFileBytes, DEFAULT_MAX_FILE_BYTES));
    this.retainFiles = Math.max(1, Math.min(10, normalizeInteger(retainFiles, DEFAULT_RETAIN_FILES)));
    this.maxLineBytes = Math.max(2048, normalizeInteger(maxLineBytes, DEFAULT_MAX_LINE_BYTES));
    this.rotateCheckInterval = Math.max(1, normalizeInteger(rotateCheckInterval, DEFAULT_CHECK_INTERVAL));
    this.appendCount = 0;
    this.queue = Promise.resolve();
  }

  enqueue(task) {
    this.queue = this.queue.then(task).catch(() => {});
    return this.queue;
  }

  async rotateIfNeeded() {
    let stat;
    try {
      stat = await fsp.stat(this.filePath);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile() || stat.size < this.maxFileBytes) {
      return;
    }

    for (let index = this.retainFiles - 1; index >= 1; index -= 1) {
      const from = `${this.filePath}.${index}`;
      const to = `${this.filePath}.${index + 1}`;
      try {
        await fsp.rename(from, to);
      } catch {
        // ignore missing/permission errors
      }
    }
    try {
      await fsp.rename(this.filePath, `${this.filePath}.1`);
    } catch {
      // ignore
    }
  }

  append(event) {
    if (!event || typeof event !== "object") {
      return Promise.resolve();
    }
    return this.enqueue(async () => {
      this.appendCount += 1;
      if (this.appendCount % this.rotateCheckInterval === 0) {
        await this.rotateIfNeeded();
      }

      let json = "";
      try {
        json = JSON.stringify(event);
      } catch {
        json = JSON.stringify({
          ts: Date.now(),
          eventType: "audit_serialize_failed",
          payload: { message: "Failed to serialize audit event." },
        });
      }
      const clipped = clipUtf8Bytes(json, this.maxLineBytes);
      const line = clipped.truncated
        ? `${JSON.stringify({
            ts: typeof event.ts === "number" ? event.ts : Date.now(),
            conversationId:
              typeof event.conversationId === "string" ? event.conversationId : null,
            runId: typeof event.runId === "string" ? event.runId : null,
            eventType:
              typeof event.eventType === "string" && event.eventType
                ? event.eventType
                : "event",
            truncated: true,
            digest: hashHex(json),
            preview: clipped.text,
            byteLimit: this.maxLineBytes,
          })}\n`
        : `${clipped.text}\n`;
      try {
        await fsp.appendFile(this.filePath, line, { encoding: "utf8" });
      } catch (error) {
        if (error?.code === "ENOENT") {
          try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            await fsp.appendFile(this.filePath, line, { encoding: "utf8" });
          } catch {
            // ignore
          }
        }
      }
    });
  }
}

module.exports = {
  AgentAuditService,
};
