import { _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const repoRoot = path.resolve(__dirname, "..", "..");
export const workspaceRoot = path.join(repoRoot, "test-workspace");
const tempRoot = path.join(workspaceRoot, "__e2e__");

export const launchApp = async ({ workspacePath = null, env = {} } = {}) => {
  const mergedEnv = {
    ...process.env,
    TEX180_E2E: "1",
    ...env,
  };
  mergedEnv.TEX180_E2E_WORKSPACE = workspacePath ? workspacePath : "";
  delete mergedEnv.ELECTRON_RUN_AS_NODE;
  const electronApp = await electron.launch({ args: ["."], cwd: repoRoot, env: mergedEnv });
  const page = await electronApp.firstWindow();
  return { electronApp, page };
};

export const installDialogStub = async (electronApp) => {
  await electronApp.evaluate(() => {
    const { dialog } = require("electron");
    if (global.__tex180DialogStub) {
      return;
    }
    global.__tex180DialogStub = {
      calls: [],
      queue: [],
      resolvers: [],
      original: dialog.showOpenDialog,
    };
    dialog.showOpenDialog = (...args) => {
      const options = args.length === 2 ? args[1] : args[0];
      global.__tex180DialogStub.calls.push({
        hasWindow: args.length === 2,
        options,
      });
      if (global.__tex180DialogStub.queue.length > 0) {
        return Promise.resolve(global.__tex180DialogStub.queue.shift());
      }
      return new Promise((resolve) => {
        global.__tex180DialogStub.resolvers.push(resolve);
      });
    };
  });
};

export const queueDialogResult = async (electronApp, result) => {
  await electronApp.evaluate((payload) => {
    const stub = global.__tex180DialogStub;
    if (!stub) {
      return;
    }
    stub.queue.push(payload);
  }, result);
};

export const resolveDialog = async (electronApp, result) => {
  await electronApp.evaluate((payload) => {
    const stub = global.__tex180DialogStub;
    if (!stub) {
      return;
    }
    const resolver = stub.resolvers.shift();
    if (resolver) {
      resolver(payload);
    } else {
      stub.queue.push(payload);
    }
  }, result);
};

export const getDialogCalls = async (electronApp) =>
  electronApp.evaluate(() => global.__tex180DialogStub?.calls ?? []);

export const createTempDir = async (prefix = "workspace-") => {
  await fs.mkdir(tempRoot, { recursive: true });
  return fs.mkdtemp(path.join(tempRoot, prefix));
};

export const writeWorkspaceFile = async (root, relativePath, content) => {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content);
  return fullPath;
};

export const removeDir = async (dirPath) => {
  if (!dirPath) {
    return;
  }
  await fs.rm(dirPath, { recursive: true, force: true });
};
