import { test } from "@playwright/test";
import { launchApp, installDialogStub, queueDialogResult } from "./helpers.js";

test("debug launcher status message", async () => {
  const { electronApp, page } = await launchApp({ workspacePath: null });
  try {
    await page.waitForSelector("#launcher.is-visible");
    await page.evaluate(() => {
      window.__e2eMessages = [];
      window.tex180Bridge?.onMessage?.((message) => {
        window.__e2eMessages.push(message);
      });
    });
    await installDialogStub(electronApp);
    await queueDialogResult(electronApp, { canceled: true, filePaths: [] });
    await page.click("#launcher-open");
    await page.waitForTimeout(200);
    const messages = await page.evaluate(() => window.__e2eMessages ?? []);
    console.log(messages);
  } finally {
    await electronApp.close();
  }
});
