#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

const WIDTH = 640;
const HEIGHT = 420;

const htmlPath = path.join(projectRoot, "assets", "dmg", "background.html");
const outDir = path.join(projectRoot, "assets", "dmg");
const out1x = path.join(outDir, "background.png");
const out2x = path.join(outDir, "background@2x.png");

const fileExists = async (filePath) => {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
};

const ensureDir = async (dirPath) => {
  await fs.mkdir(dirPath, { recursive: true });
};

const render = async ({ deviceScaleFactor, outPath }) => {
  // Lazy import so we can print a friendly message if playwright isn't usable.
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor,
  });

  await page.goto(`file://${htmlPath}`);
  const frame = page.locator(".frame");
  await frame.waitFor({ state: "visible" });
  await frame.screenshot({ path: outPath });
  await browser.close();
};

const main = async () => {
  await ensureDir(outDir);

  if (!(await fileExists(htmlPath))) {
    console.error(`ERROR: DMG background HTML not found: ${htmlPath}`);
    process.exit(1);
  }

  try {
    await render({ deviceScaleFactor: 1, outPath: out1x });
    await render({ deviceScaleFactor: 2, outPath: out2x });
  } catch (error) {
    console.error("ERROR: Failed to render DMG background via Playwright.");
    console.error(
      "If this is your first time, run: `npx playwright install chromium`"
    );
    console.error(error);
    process.exit(1);
  }

  console.log(`Wrote:\n- ${out1x}\n- ${out2x}`);
};

main();

