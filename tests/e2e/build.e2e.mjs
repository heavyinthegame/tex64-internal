import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

const sourceWorkspace = path.join(repoRoot, "test-workspace");
const keepWorkspace = process.env.E2E_KEEP_WORKSPACE === "1";
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "220", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "0", 10);

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => console.log(`[build-e2e ${now()}] ${message}`);

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const toPosix = (value) => value.split(path.sep).join("/");

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-build-"));
  const workspacePath = path.join(tempDir, "workspace");
  const userDataPath = path.join(tempDir, "userdata");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });
  return { tempDir, workspacePath, userDataPath };
};

const launchApp = async ({ workspacePath, userDataPath, extraEnv = {} }) => {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    let app = null;
    try {
      app = await electron.launch({
        args: ["."],
        cwd: repoRoot,
        slowMo: Number.isFinite(slowMoMs) ? Math.max(0, slowMoMs) : 0,
        env: {
          ...process.env,
          TEX64_E2E: "1",
          TEX64_E2E_USERDATA: userDataPath,
          TEX64_E2E_DIALOG_QUEUE: JSON.stringify({
            openWorkspace: [toPosix(workspacePath)],
          }),
          ...extraEnv,
        },
      });
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1660, height: 980 });
      await page.waitForSelector("body.is-ready", { timeout: 25000 });
      return { app, page };
    } catch (error) {
      lastError = error;
      if (app) {
        await app.close().catch(() => {});
      }
      if (attempt < 5) {
        await pause(320);
      }
    }
  }
  throw lastError;
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

const openWorkspaceViaLauncher = async (page) => {
  await waitForLauncherVisible(page, 20000);
  await page.waitForSelector("#launcher-open", { timeout: 10000 });
  await page.click("#launcher-open");
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector("body.is-ready", { timeout: 20000 });
  await page.waitForSelector("#editor-tabs-list .editor-tab.is-active", {
    timeout: 30000,
  });
  await page.waitForSelector("#file-tree", { timeout: 15000 });
};

const clickSideTab = async (page, key) => {
  await page.click(`button.tab[data-tab="${key}"]`);
  await page.waitForSelector(`.sidebar-panel .panel.is-active[data-panel="${key}"]`, {
    timeout: 10000,
  });
};

const openSettingsPage = async (page, pageId) => {
  await clickSideTab(page, "settings");
  await page.waitForSelector("#settings-panel", { timeout: 10000 });

  const alreadyOpen = await page
    .locator(`.settings-page[data-settings-page="${pageId}"].is-active`)
    .count();
  if (alreadyOpen > 0) {
    return;
  }

  const navSelector = `button.settings-nav-item[data-settings-target="${pageId}"]`;
  const navVisible = await page.locator(navSelector).isVisible().catch(() => false);
  if (!navVisible) {
    const backButtons = page.locator("button.settings-back[data-settings-back]");
    if ((await backButtons.count()) > 0) {
      await backButtons.first().click();
      await pause(120);
    }
  }

  await page.evaluate((selector) => {
    const button = document.querySelector(selector);
    if (button instanceof HTMLButtonElement) {
      button.click();
    }
  }, navSelector);

  await page.waitForSelector(`.settings-page[data-settings-page="${pageId}"].is-active`, {
    timeout: 10000,
  });
};

const waitForBuildIdle = async (page, timeout = 120000) => {
  await page.waitForFunction(
    () => {
      const button = document.getElementById("build-button");
      return button instanceof HTMLButtonElement && !button.classList.contains("is-busy");
    },
    undefined,
    { timeout }
  );
};

const clickBuildAndWait = async (page, timeout = 120000) => {
  await page.click("#build-button");
  await waitForBuildIdle(page, timeout);
};

const waitForCondition = async (predicate, timeoutMs, label) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await pause(120);
  }
  throw new Error(`timeout: ${label}`);
};

const fileExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const waitForIssueContainsAny = async (page, needles, timeout = 25000) => {
  const values = needles.map((entry) => entry.toLowerCase());
  await page.waitForFunction(
    (expected) => {
      const rows = Array.from(document.querySelectorAll("#issues-list .issue-message"));
      return rows.some((row) => {
        const text = (row.textContent ?? "").toLowerCase();
        return expected.some((needle) => text.includes(needle));
      });
    },
    values,
    { timeout }
  );
};

const waitForIssueContains = async (page, needle, timeout = 25000) => {
  await waitForIssueContainsAny(page, [needle], timeout);
};

const setRootFileFromProjectPanel = async (page, relativePath) => {
  await clickSideTab(page, "project");
  await page.waitForSelector("#settings-root-select", { timeout: 12000 });
  await page.waitForFunction(
    (value) => {
      const select = document.getElementById("settings-root-select");
      return (
        select instanceof HTMLSelectElement &&
        Array.from(select.options).some((option) => option.value === value)
      );
    },
    relativePath,
    { timeout: 15000 }
  );
  const selected = await page.selectOption("#settings-root-select", relativePath);
  assert.ok(selected.includes(relativePath), `failed to set root file: ${relativePath}`);
  await pause(450);
};

const getBuildProfileSelectValue = async (page) =>
  page.evaluate(() => {
    const select = document.getElementById("settings-build-profile");
    return select instanceof HTMLSelectElement ? select.value : null;
  });

const ensureEditableBuildProfileSelected = async (page) => {
  const current = await getBuildProfileSelectValue(page);
  if (current) {
    return current;
  }
  const fallbackId = await page.evaluate(() => {
    const select = document.getElementById("settings-build-profile");
    if (!(select instanceof HTMLSelectElement)) {
      return "";
    }
    const option = Array.from(select.options).find((entry) => entry.value !== "");
    return option?.value ?? "";
  });
  assert.notEqual(fallbackId, "", "expected at least one custom build profile");
  await page.selectOption("#settings-build-profile", fallbackId);
  await pause(220);
  return fallbackId;
};

const setBuildProfileFields = async (page, { name, outDir, extraArgs }) => {
  await page.fill("#settings-build-profile-name", name);
  await page.fill("#settings-build-outdir", outDir);
  await page.fill("#settings-build-extra-args", extraArgs);
  await page.locator("#settings-build-extra-args").blur();
  await pause(520);
};

const waitForSettingsProfile = async (settingsPath, profileId, expected) => {
  await waitForCondition(
    async () => {
      const raw = await fs.readFile(settingsPath, "utf8").catch(() => "{}");
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = {};
      }
      const profiles = Array.isArray(parsed?.buildProfiles) ? parsed.buildProfiles : [];
      const profile = profiles.find((entry) => entry?.id === profileId);
      if (!profile) {
        return false;
      }
      if ((parsed?.buildProfileId ?? "") !== profileId) {
        return false;
      }
      return (
        profile.name === expected.name &&
        profile.outDir === expected.outDir &&
        profile.extraArgs === expected.extraArgs
      );
    },
    12000,
    "build profile persisted"
  );
};

const writeManyBuildProfiles = async (workspacePath, count, activeId) => {
  const settingsDir = path.join(workspacePath, ".tex64");
  const settingsPath = path.join(settingsDir, "settings.json");
  await fs.mkdir(settingsDir, { recursive: true });
  const profiles = [];
  for (let index = 0; index < count; index += 1) {
    profiles.push({
      id: `bulk-${index}`,
      name: `bulk-${index}`,
      outDir: null,
      extraArgs: null,
    });
  }
  const payload = {
    buildProfiles: profiles,
    buildProfileId: activeId,
  };
  await fs.writeFile(settingsPath, JSON.stringify(payload, null, 2), "utf8");
};

const run = async () => {
  const { tempDir, workspacePath, userDataPath } = await createWorkspaceCopy();
  const mainPdfPath = path.join(workspacePath, "main.pdf");
  const mainSynctexPath = path.join(workspacePath, "main.synctex.gz");
  const settingsPath = path.join(workspacePath, ".tex64", "settings.json");
  let app;

  try {
    log(`workspace copy: ${workspacePath}`);

    ({ app } = await launchApp({ workspacePath, userDataPath }));
    let page = await app.firstWindow();

    await openWorkspaceViaLauncher(page);
    await waitForWorkspaceReady(page);

    log("[1/6] build engine matrix + synctex artifact");
    await setRootFileFromProjectPanel(page, "main.tex");
    for (const engine of ["lualatex", "pdflatex", "xelatex"]) {
      await openSettingsPage(page, "build");
      await page.selectOption("#settings-compile-engine", engine);
      await pause(220);
      await fs.rm(mainPdfPath, { force: true });
      await fs.rm(mainSynctexPath, { force: true });
      await clickSideTab(page, "files");
      await clickBuildAndWait(page, 180000);
      await waitForCondition(
        async () => (await fileExists(mainPdfPath)) && (await fileExists(mainSynctexPath)),
        60000,
        `build outputs for engine=${engine}`
      );
    }
    await openSettingsPage(page, "build");
    await page.selectOption("#settings-compile-engine", "uplatex");
    await pause(180);
    const selectedEngine = await page.$eval(
      "#settings-compile-engine",
      (node) => (node instanceof HTMLSelectElement ? node.value : "")
    );
    assert.equal(selectedEngine, "uplatex", "uplatex should be selectable in compile engine");

    log("[2/6] build profile autosave + outDir/extraArgs precedence");
    await openSettingsPage(page, "build");
    await page.selectOption("#settings-compile-engine", "lualatex");
    await pause(150);
    await page.click("#settings-build-profile-add");
    await pause(180);
    const profileId = await getBuildProfileSelectValue(page);
    assert.ok(profileId && profileId !== "", "new build profile should be selected");
    await setBuildProfileFields(page, {
      name: "e2e-outdir-override",
      outDir: "build-profile-a",
      extraArgs: "-outdir=build-profile-b",
    });
    await waitForSettingsProfile(settingsPath, profileId, {
      name: "e2e-outdir-override",
      outDir: "build-profile-a",
      extraArgs: "-outdir=build-profile-b",
    });

    const outDirA = path.join(workspacePath, "build-profile-a");
    const outDirB = path.join(workspacePath, "build-profile-b");
    await fs.rm(outDirA, { recursive: true, force: true });
    await fs.rm(outDirB, { recursive: true, force: true });
    await clickSideTab(page, "files");
    await clickBuildAndWait(page, 180000);
    await waitForCondition(
      async () => await fileExists(path.join(outDirB, "main.pdf")),
      60000,
      "outDir from extraArgs should produce pdf"
    );
    assert.equal(
      await fileExists(path.join(outDirA, "main.pdf")),
      false,
      "profile outDir should be ignored when extraArgs contains -outdir"
    );

    log("[3/6] build profile max=20 + active fallback");
    await app.close();
    app = null;

    await writeManyBuildProfiles(workspacePath, 25, "bulk-24");

    ({ app } = await launchApp({ workspacePath, userDataPath }));
    page = await app.firstWindow();
    await openWorkspaceViaLauncher(page);
    await waitForWorkspaceReady(page);
    await openSettingsPage(page, "build");

    const optionCount = await page.evaluate(() => {
      const select = document.getElementById("settings-build-profile");
      return select instanceof HTMLSelectElement ? select.options.length : 0;
    });
    assert.equal(optionCount, 21, "build profiles should be capped at 20 (+Default)");

    const selectedAfterTrim = await getBuildProfileSelectValue(page);
    assert.equal(
      selectedAfterTrim,
      "",
      "active profile should fallback to Default when selected id is outside capped list"
    );

    log("[4/6] invalid outDir is rejected");
    const editableProfileId = await ensureEditableBuildProfileSelected(page);
    await setBuildProfileFields(page, {
      name: "e2e-invalid-outdir",
      outDir: "/tmp/tex64-e2e-invalid-outdir",
      extraArgs: "",
    });
    await waitForSettingsProfile(settingsPath, editableProfileId, {
      name: "e2e-invalid-outdir",
      outDir: "/tmp/tex64-e2e-invalid-outdir",
      extraArgs: null,
    });
    await clickSideTab(page, "files");
    await clickBuildAndWait(page, 120000);
    await waitForIssueContains(page, "outdir が不正です", 30000);
    await openSettingsPage(page, "build");
    await setBuildProfileFields(page, {
      name: "e2e-invalid-outdir",
      outDir: "",
      extraArgs: "",
    });
    await waitForSettingsProfile(settingsPath, editableProfileId, {
      name: "e2e-invalid-outdir",
      outDir: null,
      extraArgs: null,
    });

    log("[5/6] build failure parsing + issues log");
    await setRootFileFromProjectPanel(page, "broken.tex");
    await clickSideTab(page, "files");
    await clickBuildAndWait(page, 120000);
    await clickSideTab(page, "issues");
    await page.waitForSelector("#issues-list .issue-item", { timeout: 30000 });
    const firstIssueMessage = await page.evaluate(() => {
      const node = document.querySelector("#issues-list .issue-item .issue-message");
      return (node?.textContent ?? "").trim();
    });
    assert.notEqual(firstIssueMessage, "", "build failure should surface an issue message");

    const firstIssueLocation = await page.evaluate(() => {
      const node = document.querySelector("#issues-list .issue-item .issue-location");
      return (node?.textContent ?? "").trim();
    });
    if (firstIssueLocation !== "位置不明") {
      assert.ok(
        firstIssueLocation.includes("broken.tex"),
        `unexpected issue location: ${firstIssueLocation}`
      );
      assert.ok(
        /:\d+/.test(firstIssueLocation),
        `line number should be present: ${firstIssueLocation}`
      );
    }
    const buildLogText = await page.evaluate(() => {
      return document.getElementById("issues-log-content")?.textContent ?? "";
    });
    assert.ok(buildLogText.trim().length > 0, "build log text should be retained");
    assert.ok(
      buildLogText.toLowerCase().includes("broken.tex"),
      "build log should include broken.tex"
    );

    log("[6/6] tool-missing open-runtime action");
    await app.close();
    app = null;

    ({ app } = await launchApp({
      workspacePath,
      userDataPath,
      extraEnv: { TEX64_E2E_FORCE_MISSING_TOOLS: "latexmk" },
    }));
    page = await app.firstWindow();
    await openWorkspaceViaLauncher(page);
    await waitForWorkspaceReady(page);

    await clickSideTab(page, "files");
    await clickBuildAndWait(page, 120000);
    await clickSideTab(page, "issues");
    await page.waitForSelector('#issues-list .issue-item[data-action="open-runtime"]', {
      timeout: 30000,
    });
    await waitForIssueContains(page, "latexmk", 30000);

    await page.click('#issues-list .issue-item[data-action="open-runtime"]');
    await page.waitForSelector(
      '.panel.is-active[data-panel="settings"] .settings-page[data-settings-page="runtime"].is-active',
      { timeout: 12000 }
    );

    log("build e2e passed");
  } finally {
    if (app) {
      await app.close().catch(() => {});
    }
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      log("workspace copy removed");
    } else {
      log(`workspace copy kept: ${tempDir}`);
    }
  }
};

const isTransientElectronError = (error) => {
  const message = error?.message ?? String(error);
  return (
    message.includes("Target page, context or browser has been closed") ||
    message.includes("Target closed") ||
    message.includes("Process failed to launch")
  );
};

const runWithRetry = async () => {
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await run();
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientElectronError(error) || attempt >= 5) {
        throw error;
      }
      log(`transient error detected, retrying (${attempt}/5)`);
      await pause(320);
    }
  }
  throw lastError;
};

runWithRetry().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
