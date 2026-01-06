import { test, expect } from "@playwright/test";
import { openWorkspaceApp } from "./helpers.js";

const waitForBridgeMessage = (page, type) =>
  page.evaluate(
    (messageType) =>
      new Promise((resolve) => {
        const bridge = window.tex180Bridge;
        if (!bridge?.onMessage) {
          resolve(null);
          return;
        }
        const off = bridge.onMessage((message) => {
          if (message?.type === messageType) {
            off();
            resolve(message.payload);
          }
        });
      }),
    type
  );

test("pdf click -> reverse synctex returns source lines", async () => {
  test.setTimeout(120000);
  const { electronApp, page } = await openWorkspaceApp();
  try {
    await page.click('button.file-item[data-path="main.tex"]');
    await page.waitForSelector('button.file-item[data-path="main.tex"].is-active');

    await page.click('.tab[data-tab="settings"]');
    const autoToggle = page.locator("#editor-auto-synctex-build");
    if (await autoToggle.isChecked()) {
      await autoToggle.click();
    }
    await page.click('.tab[data-tab="files"]');

    const pdfWindowPromise = electronApp.waitForEvent("window");
    await page.click("#build-button");
    const pdfWindow = await pdfWindowPromise;
    await pdfWindow.waitForLoadState("domcontentloaded");
    await pdfWindow.waitForFunction(
      () => document.querySelectorAll("#pdf-pages .page").length > 0,
      { timeout: 15000 }
    );
    await expect(pdfWindow.locator("#pdf-status")).toHaveText(/準備完了/);

    const targets = [33, 38, 60];
    let lastMarker = null;

    for (const lineNumber of targets) {
      const forwardPromise = waitForBridgeMessage(page, "synctex:forwardResult");
      await page.evaluate((line) => {
        window.tex180Bridge?.postMessage({
          type: "synctex:forward",
          path: "main.tex",
          line,
          column: 1,
          fallbackToTop: false,
        });
      }, lineNumber);

      const forwardResult = await forwardPromise;
      expect(forwardResult?.ok).toBe(true);

      await pdfWindow.evaluate(() => {
        const scrollEl = document.getElementById("pdf-scroll");
        if (!scrollEl) return Promise.resolve();
        return new Promise((resolve) => {
          let last = scrollEl.scrollTop;
          let stable = 0;
          const tick = () => {
            const current = scrollEl.scrollTop;
            if (Math.abs(current - last) < 0.5) {
              stable += 1;
            } else {
              stable = 0;
              last = current;
            }
            if (stable >= 3) {
              resolve();
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      });

      await pdfWindow.waitForSelector(".pdf-sync-marker", { timeout: 8000 });
      let markerInfo = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        markerInfo = await pdfWindow.evaluate(() => {
          const marker = document.querySelector(".pdf-sync-marker");
          if (!marker) return null;
          const rect = marker.getBoundingClientRect();
          const page = marker.closest(".page");
          const pageNumber = page?.getAttribute("data-page-number");
          const pageRect = page?.getBoundingClientRect();
          return {
            page: pageNumber ? Number(pageNumber) : null,
            x: pageRect ? rect.left - pageRect.left + rect.width / 2 : null,
            y: pageRect ? rect.top - pageRect.top + rect.height / 2 : null,
          };
        });
        if (!markerInfo) {
          break;
        }
        if (
          !lastMarker ||
          Math.abs(markerInfo.x - lastMarker.x) > 0.5 ||
          Math.abs(markerInfo.y - lastMarker.y) > 0.5
        ) {
          break;
        }
        await pdfWindow.waitForTimeout(100);
      }
      expect(markerInfo?.page).toBe(forwardResult?.page);
      if (!markerInfo || markerInfo.x === null || markerInfo.y === null) {
        throw new Error("Sync marker not found");
      }
      lastMarker = markerInfo;

      const pageLocator = pdfWindow.locator(
        `.page[data-page-number="${markerInfo.page}"]`
      );
      await pageLocator.click({ position: { x: markerInfo.x, y: markerInfo.y } });
      await expect(pdfWindow.locator("#pdf-jump-button")).toHaveClass(/is-visible/);

      const pendingReverse = await pdfWindow.evaluate(() => {
        return window.__tex180PdfViewer?.state?.pendingReverse ?? null;
      });
      if (!pendingReverse) {
        throw new Error("pendingReverse is missing");
      }
      const diffX = Math.abs(pendingReverse.x - forwardResult.x);
      const diffY = Math.abs(pendingReverse.y - forwardResult.y);
      if (diffX > 12 || diffY > 12) {
        throw new Error(
          `reverse coords drifted (dx=${diffX.toFixed(2)}, dy=${diffY.toFixed(
            2
          )})`
        );
      }

      const reversePromise = waitForBridgeMessage(page, "synctex:reverseResult");
      await pdfWindow.click("#pdf-jump-button");
      const reverseResult = await reversePromise;

      expect(reverseResult?.ok).toBe(true);
      expect(reverseResult?.path).toBe("main.tex");
      expect(Math.abs((reverseResult?.line ?? 0) - lineNumber)).toBeLessThanOrEqual(2);

      await page.waitForFunction(
        (line) => {
          const editor = window.__tex180Editor;
          return editor && editor.getPosition?.().lineNumber === line;
        },
        reverseResult?.line ?? lineNumber,
        { timeout: 10000 }
      );
    }
  } finally {
    await electronApp.close();
  }
});
