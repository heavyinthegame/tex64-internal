import { _electron as electron } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const repoRoot = path.resolve(__dirname, "..", "..");
export const workspaceRoot = path.join(repoRoot, "test-workspace");

export const launchApp = async (extraEnv = {}) => {
  const env = {
    ...process.env,
    TEX180_E2E: "1",
    TEX180_E2E_WORKSPACE: workspaceRoot,
    ...extraEnv,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({ args: ["."], cwd: repoRoot, env });
};

export const openWorkspaceApp = async (extraEnv = {}) => {
  const electronApp = await launchApp(extraEnv);
  const page = await electronApp.firstWindow();
  await page.waitForSelector("#file-tree");
  await page.waitForSelector('button.file-item[data-path="main.tex"]');
  await page.waitForFunction(() => window.__tex180Editor);
  return { electronApp, page };
};
