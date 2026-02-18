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
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "160", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "30", 10);

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[math-capture-e2e ${now()}] ${message}`);
};

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-math-capture-"));
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  return { tempDir, workspacePath };
};

const postToBridge = async (page, payload) => {
  await page.evaluate((value) => {
    window.tex64Bridge.postMessage(value);
  }, payload);
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector("body.is-ready", { timeout: 15000 });
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
    timeout: 20000,
  });
};

const openSideTab = async (page, key) => {
  await page.click(`button.tab[data-tab="${key}"]`);
  await pause(80);
};

const waitForModalState = async (page, id, open, timeout = 10000) => {
  await page.waitForFunction(
    ({ modalId, expectedOpen }) => {
      const node = document.getElementById(modalId);
      if (!(node instanceof HTMLElement)) return false;
      const isOpen = node.classList.contains("is-open");
      const aria = node.getAttribute("aria-hidden");
      return isOpen === expectedOpen && aria === (expectedOpen ? "false" : "true");
    },
    { modalId: id, expectedOpen: open },
    { timeout }
  );
};

const getIssueMessages = async (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("#issues-list .issue-message")).map((node) =>
      (node.textContent ?? "").trim()
    )
  );

const waitForIssueContains = async (page, needle, timeout = 15000) => {
  const normalized = needle.toLowerCase();
  await page.waitForFunction(
    (value) => {
      const rows = Array.from(document.querySelectorAll("#issues-list .issue-message"));
      return rows.some((row) => (row.textContent ?? "").toLowerCase().includes(value));
    },
    normalized,
    { timeout }
  );
};

const assertApprox = (actual, expected, tolerance, message) => {
  assert.ok(Number.isFinite(actual), `${message}: actual is not finite (${actual})`);
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected} ±${tolerance}, got ${actual}`
  );
};

const createSampleImageDataUrl = async (page, width = 320, height = 180) =>
  page.evaluate(
    ({ w, h }) => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("canvas context missing");
      }
      const imageData = ctx.createImageData(w, h);
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const idx = (y * w + x) * 4;
          const nx = w > 1 ? x / (w - 1) : 0;
          const ny = h > 1 ? y / (h - 1) : 0;
          imageData.data[idx] = Math.round(nx * 255);
          imageData.data[idx + 1] = Math.round(ny * 255);
          imageData.data[idx + 2] = 96;
          imageData.data[idx + 3] = 255;
        }
      }
      ctx.putImageData(imageData, 0, 0);
      return canvas.toDataURL("image/png");
    },
    { w: width, h: height }
  );

const installMocks = async (page, { imageDataUrl, imageWidth, imageHeight }) => {
  await page.evaluate(
    ({ dataUrl, width, height }) => {
      const parsePngSize = (value) => {
        if (typeof value !== "string" || !value.startsWith("data:image/png;base64,")) {
          return { width: null, height: null };
        }
        const base64 = value.slice("data:image/png;base64,".length);
        const bin = atob(base64);
        if (bin.length < 24) {
          return { width: null, height: null };
        }
        const readU32 = (offset) =>
          ((bin.charCodeAt(offset) & 0xff) << 24) |
          ((bin.charCodeAt(offset + 1) & 0xff) << 16) |
          ((bin.charCodeAt(offset + 2) & 0xff) << 8) |
          (bin.charCodeAt(offset + 3) & 0xff);
        return { width: readU32(16) >>> 0, height: readU32(20) >>> 0 };
      };

      const analyzeCropImage = async (value, sourceWidth, sourceHeight) => {
        if (typeof value !== "string" || value.length === 0) {
          return {
            topLeftR: null,
            topLeftG: null,
            topLeftB: null,
            centerR: null,
            centerG: null,
            centerB: null,
            inferredTopLeftX: null,
            inferredTopLeftY: null,
            inferredCenterX: null,
            inferredCenterY: null,
          };
        }
        try {
          const image = await new Promise((resolve, reject) => {
            const next = new Image();
            next.onload = () => resolve(next);
            next.onerror = () => reject(new Error("crop image decode failed"));
            next.src = value;
          });
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth || image.width || 1;
          canvas.height = image.naturalHeight || image.height || 1;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            throw new Error("crop canvas context missing");
          }
          ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
          const centerX = Math.max(0, Math.min(canvas.width - 1, Math.floor(canvas.width / 2)));
          const centerY = Math.max(0, Math.min(canvas.height - 1, Math.floor(canvas.height / 2)));
          const topLeft = ctx.getImageData(0, 0, 1, 1).data;
          const center = ctx.getImageData(centerX, centerY, 1, 1).data;
          const infer = (channel, span) =>
            Number.isFinite(channel) && span > 1 ? (channel / 255) * (span - 1) : null;
          return {
            topLeftR: topLeft[0],
            topLeftG: topLeft[1],
            topLeftB: topLeft[2],
            centerR: center[0],
            centerG: center[1],
            centerB: center[2],
            inferredTopLeftX: infer(topLeft[0], sourceWidth),
            inferredTopLeftY: infer(topLeft[1], sourceHeight),
            inferredCenterX: infer(center[0], sourceWidth),
            inferredCenterY: infer(center[1], sourceHeight),
          };
        } catch {
          return {
            topLeftR: null,
            topLeftG: null,
            topLeftB: null,
            centerR: null,
            centerG: null,
            centerB: null,
            inferredTopLeftX: null,
            inferredTopLeftY: null,
            inferredCenterX: null,
            inferredCenterY: null,
          };
        }
      };

      window.__mathCaptureE2EState = {
        mode: "success",
        ocrReject: false,
        listSourcesCalls: 0,
        ocrRuns: [],
        ocrResult: "x^2+1",
        ocrResponses: [],
        sources: [
          {
            id: "window:mock-calculator",
            title: "Calculator - Mock",
            app: "Calculator",
            thumbnailUrl: dataUrl,
            width,
            height,
          },
          {
            id: "screen:mock-primary",
            title: "Screen 1",
            app: "画面",
            thumbnailUrl: dataUrl,
            width,
            height,
          },
        ],
      };

      window.__tex64TestCaptureApi = {
        listSources: async () => {
          window.__mathCaptureE2EState.listSourcesCalls += 1;
          const mode = window.__mathCaptureE2EState.mode;
          if (mode === "throw") {
            throw new Error("mock listSources failure");
          }
          if (mode === "empty") {
            return [];
          }
          return window.__mathCaptureE2EState.sources;
        },
      };

      window.__tex64TestMathOcr = {
        run: async (payload) => {
          const cropSize = parsePngSize(payload?.imageDataUrl);
          const cropPixels = await analyzeCropImage(payload?.imageDataUrl, width, height);
          const tensorData =
            payload?.data instanceof ArrayBuffer ? new Float32Array(payload.data) : null;
          let tensorMin = null;
          let tensorMax = null;
          let tensorMean = null;
          let tensorLength = null;
          let tensorChannels = null;
          if (tensorData && tensorData.length > 0) {
            tensorLength = tensorData.length;
            const area =
              Number.isFinite(payload?.width) && Number.isFinite(payload?.height)
                ? payload.width * payload.height
                : 0;
            if (area > 0) {
              tensorChannels = tensorData.length / area;
            }
            let min = Number.POSITIVE_INFINITY;
            let max = Number.NEGATIVE_INFINITY;
            let sum = 0;
            for (let i = 0; i < tensorData.length; i += 1) {
              const value = tensorData[i];
              if (value < min) min = value;
              if (value > max) max = value;
              sum += value;
            }
            tensorMin = min;
            tensorMax = max;
            tensorMean = sum / tensorData.length;
          }
          window.__mathCaptureE2EState.ocrRuns.push({
            cropWidth: cropSize.width,
            cropHeight: cropSize.height,
            tensorWidth: payload?.width ?? null,
            tensorHeight: payload?.height ?? null,
            tensorLength,
            tensorChannels,
            tensorMin,
            tensorMax,
            tensorMean,
            fallbackCandidateCount: Array.isArray(payload?.fallbackImageDataUrls)
              ? payload.fallbackImageDataUrls.length
              : 0,
            cropTopLeftR: cropPixels.topLeftR,
            cropTopLeftG: cropPixels.topLeftG,
            cropTopLeftB: cropPixels.topLeftB,
            cropCenterR: cropPixels.centerR,
            cropCenterG: cropPixels.centerG,
            cropCenterB: cropPixels.centerB,
            cropTopLeftInferredX: cropPixels.inferredTopLeftX,
            cropTopLeftInferredY: cropPixels.inferredTopLeftY,
            cropCenterInferredX: cropPixels.inferredCenterX,
            cropCenterInferredY: cropPixels.inferredCenterY,
          });
          if (window.__mathCaptureE2EState.ocrReject) {
            throw new Error("mock OCR failure");
          }
          const queued = window.__mathCaptureE2EState.ocrResponses;
          if (Array.isArray(queued) && queued.length > 0) {
            const next = queued.shift();
            return { latex: typeof next === "string" ? next : "" };
          }
          return { latex: window.__mathCaptureE2EState.ocrResult };
        },
      };
    },
    { dataUrl: imageDataUrl, width: imageWidth, height: imageHeight }
  );
};

const setMockMode = async (page, mode) => {
  await page.evaluate((value) => {
    window.__mathCaptureE2EState.mode = value;
  }, mode);
};

const setMockOcrReject = async (page, value) => {
  await page.evaluate((next) => {
    window.__mathCaptureE2EState.ocrReject = next === true;
  }, value);
};

const setMockOcrResponses = async (page, responses) => {
  await page.evaluate((next) => {
    window.__mathCaptureE2EState.ocrResponses = Array.isArray(next) ? [...next] : [];
  }, responses);
};

const getLastOcrRun = async (page) =>
  page.evaluate(() => {
    const runs = window.__mathCaptureE2EState?.ocrRuns ?? [];
    return runs[runs.length - 1] ?? null;
  });

const getOcrRunCount = async (page) =>
  page.evaluate(() => {
    const runs = window.__mathCaptureE2EState?.ocrRuns ?? [];
    return runs.length;
  });

const getWindowPickerItemIds = async (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("#math-capture-window-grid .capture-window-item")).map(
      (node) => node.getAttribute("data-id")
    )
  );

const getSelectionRect = async (page) =>
  page.evaluate(() => {
    const node = document.getElementById("math-capture-crop-selection");
    if (!(node instanceof HTMLElement)) return null;
    const style = window.getComputedStyle(node);
    return {
      display: style.display,
      left: Number.parseFloat(style.left || "0"),
      top: Number.parseFloat(style.top || "0"),
      width: Number.parseFloat(style.width || "0"),
      height: Number.parseFloat(style.height || "0"),
    };
  });

const getCropImageGeometry = async (page) =>
  page.evaluate(() => {
    const canvas = document.getElementById("math-capture-crop-canvas");
    const image = document.getElementById("math-capture-crop-image");
    if (!(canvas instanceof HTMLElement)) return null;
    if (!(image instanceof HTMLImageElement)) return null;
    const rect = canvas.getBoundingClientRect();
    const naturalWidth = image.naturalWidth || 1;
    const naturalHeight = image.naturalHeight || 1;
    const canvasWidth = rect.width;
    const canvasHeight = rect.height;
    const imageAspect = naturalWidth / naturalHeight;
    const canvasAspect = canvasWidth / canvasHeight;
    let displayWidth = canvasWidth;
    let displayHeight = canvasHeight;
    let offsetX = 0;
    let offsetY = 0;
    if (imageAspect > canvasAspect) {
      displayWidth = canvasWidth;
      displayHeight = canvasWidth / imageAspect;
      offsetY = (canvasHeight - displayHeight) / 2;
    } else {
      displayHeight = canvasHeight;
      displayWidth = canvasHeight * imageAspect;
      offsetX = (canvasWidth - displayWidth) / 2;
    }
    return {
      naturalWidth,
      naturalHeight,
      displayWidth,
      displayHeight,
      offsetX,
      offsetY,
    };
  });

const getExpectedCropFromSelection = (selection, geometry) => {
  const scaleX = geometry.naturalWidth / geometry.displayWidth;
  const scaleY = geometry.naturalHeight / geometry.displayHeight;
  const x = Math.max(0, Math.round((selection.left - geometry.offsetX) * scaleX));
  const y = Math.max(0, Math.round((selection.top - geometry.offsetY) * scaleY));
  const width = Math.max(1, Math.round(selection.width * scaleX));
  const height = Math.max(1, Math.round(selection.height * scaleY));
  return {
    x,
    y,
    width,
    height,
    centerX: x + width / 2,
    centerY: y + height / 2,
  };
};

const drag = async (page, from, to, steps = 10) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
};

const getMathInputValue = async (page) =>
  page.evaluate(() => {
    const mathField = document.getElementById("block-math-input");
    if (mathField && typeof mathField.getValue === "function") {
      try {
        return String(mathField.getValue("latex") ?? "");
      } catch {
        return "";
      }
    }
    const textArea = document.querySelector("#block-math-input-container textarea");
    return textArea instanceof HTMLTextAreaElement ? textArea.value : "";
  });

const clickCaptureButton = async (page) => {
  const button = page.locator("#block-capture-button");
  await button.waitFor({ state: "visible", timeout: 10000 });
  let clicked = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await button.click({ timeout: 4000 });
      clicked = true;
      break;
    } catch {
      await pause(80);
    }
  }
  assert.ok(clicked, "capture button is not available");
};

const run = async () => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  let electronApp;

  try {
    log(`workspace copy: ${workspacePath}`);
    electronApp = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      slowMo: Number.isFinite(slowMoMs) ? Math.max(0, slowMoMs) : 0,
      env: { ...process.env },
    });
    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1600, height: 980 });

    log("opening workspace");
    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);
    await openSideTab(page, "blocks");

    const imageWidth = 320;
    const imageHeight = 180;
    const imageDataUrl = await createSampleImageDataUrl(page, imageWidth, imageHeight);
    await installMocks(page, { imageDataUrl, imageWidth, imageHeight });

    log("[1/8] window picker list + search + escape/cancel close");
    await clickCaptureButton(page);
    await waitForModalState(page, "math-capture-window-modal", true);
    let itemIds = await getWindowPickerItemIds(page);
    assert.deepEqual(
      itemIds,
      ["window:mock-calculator", "screen:mock-primary"],
      "window picker should list both window and screen sources"
    );
    await page.fill("#math-capture-window-search", "screen");
    itemIds = await getWindowPickerItemIds(page);
    assert.deepEqual(itemIds, ["screen:mock-primary"], "search should filter picker sources");
    await page.keyboard.press("Escape");
    await waitForModalState(page, "math-capture-window-modal", false);
    await clickCaptureButton(page);
    await waitForModalState(page, "math-capture-window-modal", true);
    await page.click("#math-capture-window-cancel");
    await waitForModalState(page, "math-capture-window-modal", false);

    log("[2/8] cropper selection create/move/resize + escape behavior");
    await clickCaptureButton(page);
    await waitForModalState(page, "math-capture-window-modal", true);
    await page.click('#math-capture-window-grid .capture-window-item[data-id="window:mock-calculator"]');
    await waitForModalState(page, "math-capture-crop-modal", true);
    let selection = await getSelectionRect(page);
    assert.equal(selection?.display, "none", "selection should be hidden initially");

    const canvasBox = await page.locator("#math-capture-crop-canvas").boundingBox();
    assert.ok(canvasBox, "crop canvas should be visible");
    await drag(
      page,
      { x: canvasBox.x + canvasBox.width * 0.25, y: canvasBox.y + canvasBox.height * 0.32 },
      { x: canvasBox.x + canvasBox.width * 0.52, y: canvasBox.y + canvasBox.height * 0.58 }
    );
    selection = await getSelectionRect(page);
    assert.equal(selection?.display, "block", "selection should be visible after drag create");
    assert.ok((selection?.width ?? 0) > 20 && (selection?.height ?? 0) > 20, "selection size");

    const beforeMove = selection;
    await drag(
      page,
      {
        x: canvasBox.x + beforeMove.left + beforeMove.width * 0.5,
        y: canvasBox.y + beforeMove.top + beforeMove.height * 0.5,
      },
      {
        x: canvasBox.x + beforeMove.left + beforeMove.width * 0.5 + 40,
        y: canvasBox.y + beforeMove.top + beforeMove.height * 0.5 + 26,
      }
    );
    selection = await getSelectionRect(page);
    assert.ok((selection?.left ?? 0) > beforeMove.left, "selection should move on drag");

    const beforeResize = selection;
    const handle = await page.locator("#math-capture-crop-selection .capture-crop-handle.br").boundingBox();
    assert.ok(handle, "resize handle should be visible");
    await drag(
      page,
      { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 },
      { x: handle.x + handle.width / 2 + 42, y: handle.y + handle.height / 2 + 24 }
    );
    selection = await getSelectionRect(page);
    assert.ok((selection?.width ?? 0) > beforeResize.width, "selection width should increase");
    assert.ok((selection?.height ?? 0) > beforeResize.height, "selection height should increase");

    await page.keyboard.press("Escape");
    selection = await getSelectionRect(page);
    assert.equal(selection?.display, "none", "escape should clear selection");
    await page.keyboard.press("Escape");
    selection = await getSelectionRect(page);
    assert.equal(selection?.display, "none", "escape with no selection should keep no selection");
    await waitForModalState(page, "math-capture-crop-modal", true);

    log("[3/8] Enter apply with no selection => full image OCR");
    const ocrCountBeforeFull = await getOcrRunCount(page);
    await page.keyboard.press("Enter");
    await waitForModalState(page, "math-capture-crop-modal", false);
    await page.waitForFunction(
      (count) => (window.__mathCaptureE2EState?.ocrRuns?.length ?? 0) > count,
      ocrCountBeforeFull,
      { timeout: 10000 }
    );
    let lastRun = await getLastOcrRun(page);
    assert.equal(lastRun?.cropWidth, imageWidth, "full apply should use whole image width");
    assert.equal(lastRun?.cropHeight, imageHeight, "full apply should use whole image height");
    assert.equal(lastRun?.tensorWidth, 384, "OCR input width should be 384");
    assert.equal(lastRun?.tensorHeight, 384, "OCR input height should be 384");
    assert.equal(lastRun?.tensorLength, 384 * 384 * 3, "OCR tensor length should be 384*384*3");
    assertApprox(lastRun?.tensorChannels, 3, 1e-6, "OCR tensor channel count");
    assert.ok(lastRun?.tensorMin >= -1.05, "OCR tensor min should be normalized");
    assert.ok(lastRun?.tensorMax <= 1.05, "OCR tensor max should be normalized");
    assertApprox(lastRun?.cropTopLeftInferredX, 0, 2, "full-image crop top-left X");
    assertApprox(lastRun?.cropTopLeftInferredY, 0, 2, "full-image crop top-left Y");
    assertApprox(lastRun?.cropCenterInferredX, (imageWidth - 1) / 2, 2, "full-image crop center X");
    assertApprox(lastRun?.cropCenterInferredY, (imageHeight - 1) / 2, 2, "full-image crop center Y");
    await page.waitForFunction(
      () => {
        const field = document.getElementById("block-math-input");
        if (field && typeof field.getValue === "function") {
          try {
            const value = String(field.getValue("latex") ?? "");
            return value.replace(/\s+/g, "").includes("x^2+1");
          } catch {
            return false;
          }
        }
        const textArea = document.querySelector("#block-math-input-container textarea");
        if (!(textArea instanceof HTMLTextAreaElement)) return false;
        return textArea.value.replace(/\s+/g, "").includes("x^2+1");
      },
      undefined,
      { timeout: 10000 }
    );
    const inserted = await getMathInputValue(page);
    assert.ok(inserted.replace(/\s+/g, "").includes("x^2+1"), "OCR result should be inserted");

    log("[4/8] apply with selection => cropped image OCR");
    await clickCaptureButton(page);
    await waitForModalState(page, "math-capture-window-modal", true);
    await page.click('#math-capture-window-grid .capture-window-item[data-id="window:mock-calculator"]');
    await waitForModalState(page, "math-capture-crop-modal", true);
    const canvasBox2 = await page.locator("#math-capture-crop-canvas").boundingBox();
    assert.ok(canvasBox2, "crop canvas should be visible");
    await drag(
      page,
      { x: canvasBox2.x + canvasBox2.width * 0.33, y: canvasBox2.y + canvasBox2.height * 0.28 },
      { x: canvasBox2.x + canvasBox2.width * 0.58, y: canvasBox2.y + canvasBox2.height * 0.48 }
    );
    const selectionForCrop = await getSelectionRect(page);
    const geometryForCrop = await getCropImageGeometry(page);
    assert.ok(selectionForCrop, "selection must exist before cropped apply");
    assert.ok(geometryForCrop, "crop geometry should be available");
    const expectedCrop = getExpectedCropFromSelection(selectionForCrop, geometryForCrop);
    const ocrCountBeforeCropped = await getOcrRunCount(page);
    await page.click("#math-capture-crop-apply");
    await waitForModalState(page, "math-capture-crop-modal", false);
    await page.waitForFunction(
      (count) => (window.__mathCaptureE2EState?.ocrRuns?.length ?? 0) > count,
      ocrCountBeforeCropped,
      { timeout: 10000 }
    );
    lastRun = await getLastOcrRun(page);
    assert.ok((lastRun?.cropWidth ?? 0) < imageWidth, "cropped apply should reduce width");
    assert.ok((lastRun?.cropHeight ?? 0) < imageHeight, "cropped apply should reduce height");
    assertApprox(lastRun?.cropWidth, expectedCrop.width, 2, "cropped width should match UI selection");
    assertApprox(
      lastRun?.cropHeight,
      expectedCrop.height,
      2,
      "cropped height should match UI selection"
    );
    assertApprox(lastRun?.cropTopLeftInferredX, expectedCrop.x, 3, "cropped top-left X should match");
    assertApprox(lastRun?.cropTopLeftInferredY, expectedCrop.y, 3, "cropped top-left Y should match");
    assertApprox(
      lastRun?.cropCenterInferredX,
      expectedCrop.centerX,
      3,
      "cropped center X should match"
    );
    assertApprox(
      lastRun?.cropCenterInferredY,
      expectedCrop.centerY,
      3,
      "cropped center Y should match"
    );
    assert.equal(lastRun?.tensorLength, 384 * 384 * 3, "cropped OCR tensor length should be fixed");
    assertApprox(lastRun?.tensorChannels, 3, 1e-6, "cropped OCR tensor channel count");
    assert.ok(lastRun?.tensorMin >= -1.05, "cropped OCR tensor min should be normalized");
    assert.ok(lastRun?.tensorMax <= 1.05, "cropped OCR tensor max should be normalized");

    log("[5/8] Retry closes flow (does not return to picker)");
    await clickCaptureButton(page);
    await waitForModalState(page, "math-capture-window-modal", true);
    await page.click('#math-capture-window-grid .capture-window-item[data-id="window:mock-calculator"]');
    await waitForModalState(page, "math-capture-crop-modal", true);
    await page.click("#math-capture-crop-retry");
    await waitForModalState(page, "math-capture-crop-modal", false);
    await waitForModalState(page, "math-capture-window-modal", false);

    log("[6/8] capture-only issues are cleared on start");
    await setMockMode(page, "throw");
    await openSideTab(page, "blocks");
    await clickCaptureButton(page);
    await waitForIssueContains(page, "ウィンドウ一覧の取得に失敗しました");

    await setMockMode(page, "success");
    await openSideTab(page, "blocks");
    await clickCaptureButton(page);
    await waitForModalState(page, "math-capture-window-modal", true);
    const issuesAfterClear = await getIssueMessages(page);
    assert.equal(issuesAfterClear.length, 0, "capture-only issues should be cleared on open");
    await page.keyboard.press("Escape");
    await waitForModalState(page, "math-capture-window-modal", false);

    log("[7/8] OCR failure is reported");
    await setMockMode(page, "success");
    await setMockOcrReject(page, true);
    await openSideTab(page, "blocks");
    await clickCaptureButton(page);
    await waitForModalState(page, "math-capture-window-modal", true);
    await page.click('#math-capture-window-grid .capture-window-item[data-id="window:mock-calculator"]');
    await waitForModalState(page, "math-capture-crop-modal", true);
    await page.click("#math-capture-crop-apply");
    await waitForModalState(page, "math-capture-crop-modal", false);
    await waitForIssueContains(page, "mock OCR failure");

    log("[8/8] multi-pass OCR reranking picks better candidate");
    await setMockOcrReject(page, false);
    await setMockOcrResponses(page, ["\\begin{array}", "\\frac{a}{b}"]);
    await openSideTab(page, "blocks");
    const ocrCountBeforeRerank = await getOcrRunCount(page);
    await clickCaptureButton(page);
    await waitForModalState(page, "math-capture-window-modal", true);
    await page.click('#math-capture-window-grid .capture-window-item[data-id="window:mock-calculator"]');
    await waitForModalState(page, "math-capture-crop-modal", true);
    await page.click("#math-capture-crop-apply");
    await waitForModalState(page, "math-capture-crop-modal", false);
    await page.waitForFunction(
      (count) => (window.__mathCaptureE2EState?.ocrRuns?.length ?? 0) >= count + 2,
      ocrCountBeforeRerank,
      { timeout: 10000 }
    );
    await page.waitForFunction(
      () => {
        const field = document.getElementById("block-math-input");
        if (field && typeof field.getValue === "function") {
          try {
            const value = String(field.getValue("latex") ?? "");
            return value.includes("\\frac{a}{b}");
          } catch {
            return false;
          }
        }
        const textArea = document.querySelector("#block-math-input-container textarea");
        if (!(textArea instanceof HTMLTextAreaElement)) return false;
        return textArea.value.includes("\\frac{a}{b}");
      },
      undefined,
      { timeout: 10000 }
    );
    const reranked = await getMathInputValue(page);
    assert.ok(reranked.includes("\\frac{a}{b}"), "better OCR candidate should be selected");
    await setMockOcrResponses(page, []);

    log("math-capture e2e passed");
  } finally {
    if (electronApp) {
      await electronApp.close();
    }
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true });
      log("workspace copy removed");
    } else {
      log(`workspace copy kept: ${tempDir}`);
    }
  }
};

run().catch((error) => {
  console.error("[math-capture-e2e] FAILED");
  console.error(error);
  process.exitCode = 1;
});
