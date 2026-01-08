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
  if (!mergedEnv.TEX180_E2E_USERDATA) {
    const userDataRoot = path.join(tempRoot, "userdata");
    await fs.mkdir(userDataRoot, { recursive: true });
    if (workspacePath) {
      mergedEnv.TEX180_E2E_USERDATA = path.join(userDataRoot, path.basename(workspacePath));
      await fs.mkdir(mergedEnv.TEX180_E2E_USERDATA, { recursive: true });
    } else {
      mergedEnv.TEX180_E2E_USERDATA = await fs.mkdtemp(path.join(userDataRoot, "session-"));
    }
  }
  delete mergedEnv.ELECTRON_RUN_AS_NODE;
  const electronApp = await electron.launch({ args: ["."], cwd: repoRoot, env: mergedEnv });
  const page = await electronApp.firstWindow();
  return { electronApp, page };
};

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

export const removeTempRoot = async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
};
