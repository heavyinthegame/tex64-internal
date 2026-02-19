import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

const keepWorkspace = process.env.E2E_KEEP_WORKSPACE === "1";
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "200", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "40", 10);

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[launcher-e2e ${now()}] ${message}`);
};

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const toPosix = (value) => value.split(path.sep).join("/");

const createWorkspaceDir = async (dirPath, marker) => {
  await fs.mkdir(dirPath, { recursive: true });
  const content = [
    "\\documentclass{article}",
    "\\begin{document}",
    `\\section{${marker}}`,
    `\\label{sec:${marker.toLowerCase()}}`,
    `workspace: ${marker}`,
    "\\end{document}",
    "",
  ].join("\n");
  await fs.writeFile(path.join(dirPath, "main.tex"), content, "utf8");
};

const settingsPath = (userDataPath) => path.join(userDataPath, "tex64-user-settings.json");

const writeRecentProjects = async (userDataPath, projects) => {
  await fs.mkdir(userDataPath, { recursive: true });
  const payload = { recentProjects: projects };
  await fs.writeFile(settingsPath(userDataPath), JSON.stringify(payload, null, 2), "utf8");
};

const readRecentProjects = async (userDataPath) => {
  const raw = await fs
    .readFile(settingsPath(userDataPath), "utf8")
    .catch(() => JSON.stringify({ recentProjects: [] }));
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  return Array.isArray(parsed?.recentProjects) ? parsed.recentProjects : [];
};

const waitForRecentState = async (userDataPath, predicate, timeoutMs = 10000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const projects = await readRecentProjects(userDataPath);
    if (predicate(projects)) {
      return projects;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("timed out waiting for recent projects state");
};

const launchApp = async ({ userDataPath, dialogQueue = null }) => {
  const env = {
    ...process.env,
    TEX64_E2E: "1",
        TEX64_E2E_HEADLESS: "1",
    TEX64_E2E_USERDATA: userDataPath,
  };
  if (dialogQueue) {
    env.TEX64_E2E_DIALOG_QUEUE = JSON.stringify(dialogQueue);
  }
  const app = await electron.launch({
    args: ["."],
    cwd: repoRoot,
    slowMo: Number.isFinite(slowMoMs) ? Math.max(0, slowMoMs) : 0,
    env,
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1600, height: 980 });
  await page.waitForSelector("body.is-ready", { timeout: 20000 });
  return { app, page };
};

const closeApp = async (app) => {
  if (!app) {
    return;
  }
  await app.close();
};

const waitForLauncherVisible = async (page, timeout = 15000) => {
  await page.waitForFunction(
    () => {
      const launcher = document.getElementById("launcher");
      return Boolean(
        launcher &&
          launcher.classList.contains("is-visible") &&
          launcher.getAttribute("aria-hidden") === "false" &&
          document.body.classList.contains("has-launcher")
      );
    },
    undefined,
    { timeout }
  );
};

const waitForLauncherHidden = async (page, timeout = 15000) => {
  await page.waitForFunction(
    () => {
      const launcher = document.getElementById("launcher");
      if (!launcher) {
        return false;
      }
      return (
        !launcher.classList.contains("is-visible") &&
        launcher.getAttribute("aria-hidden") === "true" &&
        !document.body.classList.contains("has-launcher")
      );
    },
    undefined,
    { timeout }
  );
};

const waitForLauncherSelected = async (page, id, timeout = 12000) => {
  await page.waitForFunction(
    (targetId) => {
      const target = document.getElementById(targetId);
      return Boolean(target && target.classList.contains("is-selected"));
    },
    id,
    { timeout }
  );
};

const getWorkspaceLabel = async (page) => {
  const text = await page.locator("#workspace-label").first().textContent();
  return (text ?? "").trim();
};

const waitForWorkspaceOpened = async (page, expectedName) => {
  await waitForLauncherHidden(page, 20000);
  await page.waitForFunction(
    (name) => {
      const label = document.getElementById("workspace-label");
      return Boolean(label) && (label.textContent ?? "").trim() === name;
    },
    expectedName,
    { timeout: 25000 }
  );
  await page.waitForSelector("#editor-tabs-list .editor-tab.is-active", {
    timeout: 25000,
  });
};

const clickSidebarTab = async (page, key) => {
  await page.click(`button.tab[data-tab="${key}"]`);
  await page.waitForSelector(`.sidebar-panel .panel.is-active[data-panel="${key}"]`, {
    timeout: 10000,
  });
  await pause(100);
};

const waitForIndexReadyInOutline = async (page) => {
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#outline-sections .outline-item").length > 0 &&
      document.querySelectorAll("#outline-labels .outline-item").length > 0,
    undefined,
    { timeout: 25000 }
  );
};

const countVisibleRecentItems = async (page) =>
  page.locator("#launcher-recent-list .launcher-recent-item").count();

const clickRecentItemByPath = async (page, targetPath) => {
  const clicked = await page.evaluate((value) => {
    const items = Array.from(
      document.querySelectorAll("#launcher-recent-list .launcher-recent-item")
    );
    const target = items.find((node) => node.dataset.path === value);
    if (!target) {
      return false;
    }
    target.click();
    return true;
  }, toPosix(targetPath));
  assert.equal(clicked, true, `recent item not found: ${targetPath}`);
};

const createRecentProjectEntry = (projectPath, index) => ({
  path: toPosix(projectPath),
  name: path.basename(projectPath),
  openedAt: Date.now() - index * 1000,
});

const run = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-launcher-"));
  const userDataPath = path.join(tempDir, "userdata");
  await fs.mkdir(userDataPath, { recursive: true });

  const openWorkspacePath = path.join(tempDir, "open-workspace");
  await createWorkspaceDir(openWorkspacePath, "OpenFlow");

  const createFreshPath = path.join(tempDir, "create-fresh");
  await fs.mkdir(createFreshPath, { recursive: true });

  const createExistingPath = path.join(tempDir, "create-existing");
  await fs.mkdir(createExistingPath, { recursive: true });
  const existingMainPath = path.join(createExistingPath, "main.tex");
  const existingMainContent = "% existing main\n\\documentclass{article}\n\\begin{document}\nold\n\\end{document}\n";
  await fs.writeFile(existingMainPath, existingMainContent, "utf8");

  const recentValidDirs = [];
  for (let i = 1; i <= 10; i += 1) {
    const dir = path.join(tempDir, `recent-${String(i).padStart(2, "0")}`);
    await createWorkspaceDir(dir, `Recent${i}`);
    recentValidDirs.push(dir);
  }
  const missingRecentPath = path.join(tempDir, "recent-missing");
  const overflowOpenPath = path.join(tempDir, "open-overflow");
  await createWorkspaceDir(overflowOpenPath, "Overflow");

  let app = null;
  try {
    log("[1/7] launcher keyboard navigation + open workspace flow");
    ({ app } = await launchApp({
      userDataPath,
      dialogQueue: { openWorkspace: [toPosix(openWorkspacePath)] },
    }));
    let page = await app.firstWindow();
    await waitForLauncherVisible(page);
    await waitForLauncherSelected(page, "launcher-open");
    await page.keyboard.press("ArrowDown");
    await waitForLauncherSelected(page, "launcher-create");
    await page.keyboard.press("ArrowUp");
    await waitForLauncherSelected(page, "launcher-open");
    await page.keyboard.press("Enter");
    await waitForWorkspaceOpened(page, path.basename(openWorkspacePath));
    await clickSidebarTab(page, "outline");
    await waitForIndexReadyInOutline(page);
    await closeApp(app);
    app = null;

    log("[2/7] create project via launcher keyboard (paper template)");
    ({ app } = await launchApp({
      userDataPath,
      dialogQueue: { createProject: [toPosix(createFreshPath)] },
    }));
    page = await app.firstWindow();
    await waitForLauncherVisible(page);
    await waitForLauncherSelected(page, "launcher-open");
    await page.keyboard.press("ArrowDown");
    await waitForLauncherSelected(page, "launcher-create");
    await page.keyboard.press("Enter");
    await waitForWorkspaceOpened(page, path.basename(createFreshPath));
    const createdMainPath = path.join(createFreshPath, "main.tex");
    const createdMainContent = await fs.readFile(createdMainPath, "utf8");
    assert.ok(createdMainContent.includes("\\title{タイトル}"), "paper template title not found");
    assert.ok(!createdMainContent.includes("\\title{講義ノート}"), "lecture template title should not be used");
    await closeApp(app);
    app = null;

    log("[3/7] create project uses auto-numbering (main2.tex) when main.tex exists");
    ({ app } = await launchApp({
      userDataPath,
      dialogQueue: { createProject: [toPosix(createExistingPath)] },
    }));
    page = await app.firstWindow();
    await waitForLauncherVisible(page);
    await page.keyboard.press("ArrowDown");
    await waitForLauncherSelected(page, "launcher-create");
    await page.keyboard.press("Enter");
    await waitForWorkspaceOpened(page, path.basename(createExistingPath));
    const createdMain2Path = path.join(createExistingPath, "main2.tex");
    const createdMain2Content = await fs.readFile(createdMain2Path, "utf8");
    assert.ok(createdMain2Content.includes("\\title{タイトル}"), "main2.tex should be created with paper template");
    const persistedMainContent = await fs.readFile(existingMainPath, "utf8");
    assert.equal(persistedMainContent, existingMainContent, "existing main.tex must not be overwritten");
    await closeApp(app);
    app = null;

    log("[4/7] seed recent projects and verify initial 3 / toggle to 10 / fold");
    const seededRecentProjects = [
      createRecentProjectEntry(missingRecentPath, 0),
      ...recentValidDirs.slice(0, 9).map((dir, index) => createRecentProjectEntry(dir, index + 1)),
    ];
    await writeRecentProjects(userDataPath, seededRecentProjects);

    ({ app } = await launchApp({ userDataPath }));
    page = await app.firstWindow();
    await waitForLauncherVisible(page);
    await page.waitForFunction(
      () => document.querySelectorAll("#launcher-recent-list .launcher-recent-item").length === 3,
      undefined,
      { timeout: 12000 }
    );
    assert.equal(await countVisibleRecentItems(page), 3, "collapsed recent list should show 3 items");
    await page.click("#launcher-recent-toggle");
    await page.waitForFunction(
      () => document.querySelectorAll("#launcher-recent-list .launcher-recent-item").length === 10,
      undefined,
      { timeout: 12000 }
    );
    assert.equal(await countVisibleRecentItems(page), 10, "expanded recent list should show 10 items");
    await page.click("#launcher-recent-toggle");
    await page.waitForFunction(
      () => document.querySelectorAll("#launcher-recent-list .launcher-recent-item").length === 3,
      undefined,
      { timeout: 12000 }
    );
    assert.equal(await countVisibleRecentItems(page), 3, "folded recent list should return to 3 items");

    log("[5/7] missing recent project is auto-removed on click");
    await clickRecentItemByPath(page, missingRecentPath);
    await waitForLauncherVisible(page);
    const afterMissingRemove = await waitForRecentState(
      userDataPath,
      (projects) => projects.every((entry) => entry.path !== toPosix(missingRecentPath)),
      12000
    );
    assert.ok(
      afterMissingRemove.every((entry) => entry.path !== toPosix(missingRecentPath)),
      "missing recent path should be removed from settings"
    );

    log("[6/7] click valid recent project to reopen workspace");
    const reopenTarget = recentValidDirs[0];
    await clickRecentItemByPath(page, reopenTarget);
    await waitForWorkspaceOpened(page, path.basename(reopenTarget));
    assert.equal(
      await getWorkspaceLabel(page),
      path.basename(reopenTarget),
      "workspace label should match reopened recent project"
    );
    await closeApp(app);
    app = null;

    log("[7/7] opening one more project keeps recent list capped at 10");
    const capSeedProjects = recentValidDirs.map((dir, index) =>
      createRecentProjectEntry(dir, index)
    );
    await writeRecentProjects(userDataPath, capSeedProjects);
    ({ app } = await launchApp({
      userDataPath,
      dialogQueue: { openWorkspace: [toPosix(overflowOpenPath)] },
    }));
    page = await app.firstWindow();
    await waitForLauncherVisible(page);
    await waitForLauncherSelected(page, "launcher-open");
    await page.keyboard.press("Enter");
    await waitForWorkspaceOpened(page, path.basename(overflowOpenPath));
    await closeApp(app);
    app = null;

    const finalRecentProjects = await readRecentProjects(userDataPath);
    assert.equal(finalRecentProjects.length, 10, "recent projects should be capped at 10");
    assert.equal(
      finalRecentProjects[0]?.path,
      toPosix(overflowOpenPath),
      "most recently opened workspace should be first"
    );
    assert.ok(
      !finalRecentProjects.some((entry) => entry.path === toPosix(recentValidDirs[9])),
      "oldest recent project should be dropped after cap overflow"
    );

    log("launcher/workspace e2e passed");
  } finally {
    await closeApp(app).catch(() => {});
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true });
      log("temporary workspace removed");
    } else {
      log(`temporary workspace kept: ${tempDir}`);
    }
  }
};

run().catch((error) => {
  console.error("[launcher-e2e] failed:", error);
  process.exitCode = 1;
});
