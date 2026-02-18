import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";

const repoRoot = process.cwd();
const sourceWorkspace = path.join(repoRoot, "tests/e2e/fixtures/synctex-precision");
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-sync-check-"));
const workspacePath = path.join(tempDir, "workspace");
await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
const app = await electron.launch({ args: ["."], cwd: repoRoot, env: { ...process.env } });
const page = await app.firstWindow();
await page.setViewportSize({ width: 1200, height: 900 });

const normalizeWorkspacePath = (workspace, value) => {
  if (!value || typeof value !== "string") return null;
  return path.isAbsolute(value) ? path.normalize(value) : path.join(workspace, value);
};

const postToBridge = (payload) => page.evaluate((value) => window.tex64Bridge.postMessage(value), payload);
const waitForBridgeMessage = async (type, expectedRequestId) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const msg = await page.evaluate((params) => {
      const messages = window.__synctexTestMessages;
      if (!Array.isArray(messages) || messages.length === 0) return null;
      const index = messages.findIndex((item) => {
        if (!item || item.type !== params.type) return false;
        if (!params.requestId) return true;
        return item.requestId === params.requestId;
      });
      if (index === -1) return null;
      const item = messages[index];
      messages.splice(index, 1);
      return item;
    }, { type, requestId: expectedRequestId });
    if (msg) return msg;
    await page.waitForTimeout(20);
  }
  throw new Error(`timeout ${type} ${expectedRequestId}`);
};

await page.evaluate(() => {
  if (!window.__synctexTestMessages) window.__synctexTestMessages = [];
  window.tex64Bridge.onMessage((msg) => {
    const requestId =
      msg?.payload && typeof msg.payload === "object" ? msg.payload?.requestId : msg?.requestId;
    window.__synctexTestMessages.push({
      type: msg?.type,
      requestId,
      payload: msg?.payload ?? null,
    });
  });
});

await postToBridge({ type: "openRecentProject", path: workspacePath });
await page.waitForSelector("body.is-ready", { timeout: 15000 });
await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', { timeout: 20000 });
await postToBridge({ type: "build" });
await page.waitForFunction(() => {
  const button = document.getElementById("build-button");
  return button instanceof HTMLButtonElement && !button.classList.contains("is-busy");
}, undefined, { timeout: 40000 });
await page.waitForTimeout(400);

for (const relativePath of ["sections/overview.tex", "sections/appendix.tex"]) {
  for (const line of [1, 2, 3]) {
    const req = `f-${relativePath}-${line}`;
    await postToBridge({
      type: "synctex:forward",
      requestId: req,
      path: relativePath,
      line,
      column: 1,
      fallbackToTop: false,
    });
    const fwMsg = await waitForBridgeMessage("synctex:forwardResult", req);
    const fw = fwMsg?.payload;
    if (!fw?.ok) {
      console.log("forward fail", relativePath, line, fw);
      continue;
    }
    const revReq = `r-${relativePath}-${line}`;
    await postToBridge({
      type: "synctex:reverse",
      requestId: revReq,
      page: fw.page,
      x: fw.x,
      y: fw.y,
      pdfPath: fw.pdfPath,
      bypassHint: true,
      refineLines: 3,
      allowExpandedOffsets: true,
    });
    const rvMsg = await waitForBridgeMessage("synctex:reverseResult", revReq);
    const rv = rvMsg?.payload;
    const expected = normalizeWorkspacePath(workspacePath, path.join(workspacePath, relativePath));
    const actual = rv?.ok ? normalizeWorkspacePath(workspacePath, rv.path) : null;
    console.log(relativePath, "line", line, "ok", rv?.ok, "payload", rv, "expected", expected, "actual", actual, "same", actual === expected);
  }
}

await app.close();
await fs.rm(tempDir, { recursive: true, force: true });
