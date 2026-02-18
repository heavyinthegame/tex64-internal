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

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-hover-dock-"));
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  return { tempDir, workspacePath };
};

const appendLine = async (page, text) =>
  page.evaluate((lineText) => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    const model = active?.getModel?.();
    if (!active || !model) return -1;
    const lastLine = model.getLineCount();
    const endColumn = model.getLineMaxColumn(lastLine);
    const hasValue = model.getValueLength() > 0;
    const insertText = `${hasValue ? "\n" : ""}${lineText}`;
    active.executeEdits("hover-dock-targeted", [
      {
        range: {
          startLineNumber: lastLine,
          startColumn: endColumn,
          endLineNumber: lastLine,
          endColumn,
        },
        text: insertText,
        forceMoveMarkers: true,
      },
    ]);
    const insertedLineNumber = hasValue ? lastLine + 1 : lastLine;
    active.setPosition({ lineNumber: insertedLineNumber, column: lineText.length + 1 });
    active.focus?.();
    return insertedLineNumber;
  }, text);

const setCursorOnNeedle = async (page, lineNumber, lineText, needle, offset = 0) => {
  const idx = lineText.indexOf(needle);
  assert.ok(idx >= 0, `needle not found: ${needle}`);
  const column = idx + 1 + Math.max(1, Math.floor(needle.length / 2)) + offset;
  await page.evaluate(
    (payload) => {
      const editors = window.monaco?.editor?.getEditors?.() ?? [];
      const active =
        editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
        editors[0];
      active?.setPosition?.({ lineNumber: payload.lineNumber, column: payload.column });
      active?.focus?.();
      active?.trigger?.("hover-dock-targeted", "editor.action.showHover", {});
    },
    { lineNumber, column }
  );
};

const moveCursorOnNeedle = async (page, lineNumber, lineText, needle, offset = 0) => {
  const idx = lineText.indexOf(needle);
  assert.ok(idx >= 0, `needle not found: ${needle}`);
  const column = idx + 1 + Math.max(1, Math.floor(needle.length / 2)) + offset;
  await page.evaluate(
    (payload) => {
      const editors = window.monaco?.editor?.getEditors?.() ?? [];
      const active =
        editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
        editors[0];
      active?.setPosition?.({ lineNumber: payload.lineNumber, column: payload.column });
      active?.focus?.();
    },
    { lineNumber, column }
  );
};

const forceShowHoverOnNeedle = async (page, lineNumber, lineText, needle, offset = 0) => {
  const idx = lineText.indexOf(needle);
  assert.ok(idx >= 0, `needle not found: ${needle}`);
  const column = idx + 1 + Math.max(1, Math.floor(needle.length / 2)) + offset;
  await page.evaluate(
    (payload) => {
      const editors = window.monaco?.editor?.getEditors?.() ?? [];
      const active =
        editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
        editors[0];
      active?.trigger?.("hover-dock-targeted", "editor.action.hideHover", {});
      active?.setPosition?.({ lineNumber: payload.lineNumber, column: payload.column });
      active?.focus?.();
      active?.trigger?.("hover-dock-targeted", "editor.action.showHover", {});
    },
    { lineNumber, column }
  );
};

const readDockStats = async (page) =>
  page.evaluate(() => {
    const visible = Array.from(document.querySelectorAll(".monaco-hover")).filter((node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return (
        !node.classList.contains("hidden") &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number.parseFloat(style.opacity || "1") > 0.1 &&
        rect.width > 1 &&
        rect.height > 1
      );
    });
    const hover = visible[0] ?? null;
    if (!hover) return null;
    if (!hover.dataset.tex64DockProbeId) {
      hover.dataset.tex64DockProbeId = `dock-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
    const wrapper = hover.closest(".monaco-resizable-hover");
    const hoverRect = hover.getBoundingClientRect();
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    const position = active?.getPosition?.();
    const domNode = active?.getDomNode?.();
    const visiblePos = position ? active?.getScrolledVisiblePosition?.(position) : null;
    if (!domNode || !visiblePos) {
      return {
        hoverId: hover.dataset.tex64DockProbeId,
        docked: wrapper?.classList.contains("tex64-hover-docked") ?? false,
        rect: {
          left: Math.round(hoverRect.left),
          top: Math.round(hoverRect.top),
          width: Math.round(hoverRect.width),
          height: Math.round(hoverRect.height),
        },
      };
    }
    const hostRect = domNode.getBoundingClientRect();
    const cursorX = hostRect.left + visiblePos.left + Math.max(1, Math.floor((visiblePos.width || 12) / 2));
    const cursorY = hostRect.top + visiblePos.top + Math.max(1, Math.floor((visiblePos.height || 18) / 2));
    const overlapsCursor =
      cursorX >= hoverRect.left &&
      cursorX <= hoverRect.right &&
      cursorY >= hoverRect.top &&
      cursorY <= hoverRect.bottom;
    return {
      hoverId: hover.dataset.tex64DockProbeId,
      docked: wrapper?.classList.contains("tex64-hover-docked") ?? false,
      dockTopDelta: Math.round(hoverRect.top - hostRect.top),
      dockRightDelta: Math.round(hostRect.right - hoverRect.right),
      overlapsCursor,
      rect: {
        left: Math.round(hoverRect.left),
        top: Math.round(hoverRect.top),
        width: Math.round(hoverRect.width),
        height: Math.round(hoverRect.height),
      },
    };
  });

const readHoverSurfaceColor = async (page) =>
  page.evaluate(() => {
    const visible = Array.from(document.querySelectorAll(".monaco-hover")).filter((node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return (
        !node.classList.contains("hidden") &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number.parseFloat(style.opacity || "1") > 0.1 &&
        rect.width > 1 &&
        rect.height > 1
      );
    });
    const hover = visible[0] ?? null;
    if (!hover) return null;
    const rootBg = window.getComputedStyle(hover).backgroundColor;
    const previewNode =
      hover.querySelector('[data-tex64-preview="math"]') ??
      hover.querySelector('[data-tex64-preview="image"]') ??
      hover.querySelector(".tex64-hover-preview") ??
      hover.querySelector(".rendered-markdown > div");
    const previewBg = previewNode ? window.getComputedStyle(previewNode).backgroundColor : null;
    const effective = [previewBg, rootBg].find(
      (value) => value && !/rgba?\(0,\s*0,\s*0(?:,\s*0)?\)/.test(value) && value !== "transparent"
    );
    return { rootBg, previewBg, effectiveBg: effective ?? rootBg };
  });

const readMathRenderQuality = async (page) =>
  page.evaluate(() => {
    const hover = Array.from(document.querySelectorAll(".monaco-hover")).find((node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return (
        !node.classList.contains("hidden") &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number.parseFloat(style.opacity || "1") > 0.1 &&
        rect.width > 1 &&
        rect.height > 1
      );
    });
    if (!hover) return null;
    const hasMathLiveMarkup = !!hover.querySelector(".tex64-hover-math-markup .ML__latex");
    const hasMathMl = !!hover.querySelector("math");
    const mathImage = hover.querySelector('img[src*="#tex64-math"]');
    const usesMathImageFallback = !!mathImage;
    const hasRenderedSpanMath = !!hover.querySelector(".rendered-markdown > div > span");
    let hasSvgImagePayload = false;
    if (mathImage && typeof mathImage.getAttribute === "function") {
      try {
        const src = mathImage.getAttribute("src") ?? "";
        const raw = src.split("#")[0] ?? "";
        hasSvgImagePayload =
          raw.startsWith("data:image/svg+xml") &&
          (raw.includes("%3Csvg") || raw.includes("<svg"));
      } catch {
        hasSvgImagePayload = false;
      }
    }
    const text = (hover.textContent ?? "").replace(/\s+/g, " ").trim();
    const innerHtml = (hover.querySelector(".rendered-markdown")?.innerHTML ?? hover.innerHTML ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400);
    return {
      hasMathLiveMarkup,
      hasMathMl,
      usesMathImageFallback,
      hasRenderedSpanMath,
      hasSvgImagePayload,
      text,
      innerHtml,
    };
  });

const probeNoHoverFlash = async (page, durationMs = 420) =>
  page.evaluate(async (probeMs) => {
    const started = performance.now();
    let frames = 0;
    let violation = null;
    const isVisible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return (
        !node.classList.contains("hidden") &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number.parseFloat(style.opacity || "1") > 0.1 &&
        rect.width > 1 &&
        rect.height > 1
      );
    };
    const sample = () => {
      frames += 1;
      const hover = Array.from(document.querySelectorAll(".monaco-hover")).find((node) => isVisible(node));
      if (!hover) return;
      const editors = window.monaco?.editor?.getEditors?.() ?? [];
      const active =
        editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
        editors[0];
      const domNode = active?.getDomNode?.();
      if (!domNode) return;
      const hoverRect = hover.getBoundingClientRect();
      const hostRect = domNode.getBoundingClientRect();
      const dockTopDelta = Math.round(hoverRect.top - hostRect.top);
      const dockRightDelta = Math.round(hostRect.right - hoverRect.right);
      if (dockTopDelta < 0 || dockTopDelta > 90 || dockRightDelta < 0 || dockRightDelta > 120) {
        violation = {
          kind: "not-docked-position",
          dockTopDelta,
          dockRightDelta,
          hoverRect: {
            left: Math.round(hoverRect.left),
            top: Math.round(hoverRect.top),
            width: Math.round(hoverRect.width),
            height: Math.round(hoverRect.height),
          },
        };
      }
    };
    while (performance.now() - started < probeMs) {
      sample();
      if (violation) break;
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
    return { frames, violation };
  }, durationMs);

const assertHoverSurfaceTone = (stats, label) => {
  assert.ok(stats, `${label}: hover color should be readable`);
  const bg = stats.effectiveBg ?? "";
  assert.ok(
    /rgba?\(\s*39,\s*54,\s*84(?:,\s*(?:0\.9[0-9]*|1))?\s*\)/.test(bg),
    `${label}: hover background should match math tone, got ${bg}`
  );
};

const runScenario = async (page, line, needle) => {
  const lineNumber = await appendLine(page, line);
  assert.ok(lineNumber > 0, `failed to append: ${line}`);

  await setCursorOnNeedle(page, lineNumber, line, needle, 0);
  await pause(220);
  const s1 = await readDockStats(page);
  assert.ok(s1, "hover should be visible");
  assert.equal(s1.overlapsCursor, false, `hover should not overlap cursor: ${JSON.stringify(s1)}`);
  assert.ok(
    Number.isFinite(s1.dockTopDelta) && s1.dockTopDelta >= 0 && s1.dockTopDelta <= 80,
    `hover should be near top-right (top): ${JSON.stringify(s1)}`
  );
  assert.ok(
    Number.isFinite(s1.dockRightDelta) && s1.dockRightDelta >= 0 && s1.dockRightDelta <= 80,
    `hover should be near top-right (right): ${JSON.stringify(s1)}`
  );

  await setCursorOnNeedle(page, lineNumber, line, needle, -1);
  await pause(160);
  const s2 = await readDockStats(page);
  await setCursorOnNeedle(page, lineNumber, line, needle, 1);
  await pause(160);
  const s3 = await readDockStats(page);
  assert.ok(s2 && s3, "hover should stay visible while moving inside token");
  assert.equal(s2.hoverId, s1.hoverId, "hover should not regenerate inside token");
  assert.equal(s3.hoverId, s1.hoverId, "hover should not regenerate inside token");
  const tops = [s1.rect.top, s2.rect.top, s3.rect.top];
  const lefts = [s1.rect.left, s2.rect.left, s3.rect.left];
  assert.ok(Math.max(...tops) - Math.min(...tops) <= 1, `hover top drifted: ${JSON.stringify([s1, s2, s3])}`);
  assert.ok(Math.max(...lefts) - Math.min(...lefts) <= 1, `hover left drifted: ${JSON.stringify([s1, s2, s3])}`);

  const longRun = [];
  for (const offset of [-1, 0, 1, -1, 1, 0, -1, 1]) {
    await moveCursorOnNeedle(page, lineNumber, line, needle, offset);
    await pause(70);
    const sample = await readDockStats(page);
    if (sample) {
      longRun.push(sample);
    }
  }
  assert.ok(longRun.length >= 6, "hover stability probe should capture samples");
  const runIds = new Set(longRun.map((sample) => sample.hoverId));
  assert.equal(runIds.size, 1, `hover should not regenerate in same token: ${JSON.stringify(longRun)}`);
  const runLefts = longRun.map((sample) => sample.rect.left);
  const runTops = longRun.map((sample) => sample.rect.top);
  assert.ok(Math.max(...runLefts) - Math.min(...runLefts) <= 1, `hover flickered horizontally: ${JSON.stringify(longRun)}`);
  assert.ok(Math.max(...runTops) - Math.min(...runTops) <= 1, `hover flickered vertically: ${JSON.stringify(longRun)}`);
  const flashProbe = await probeNoHoverFlash(page, 460);
  assert.ok(
    !flashProbe.violation,
    `hover flashed near source/cursor: ${JSON.stringify(flashProbe)}`
  );

  return { lineNumber };
};

const run = async () => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  let app;
  try {
    app = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      slowMo: 40,
      env: { ...process.env },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1640, height: 980 });
    await page.evaluate((p) => {
      window.tex64Bridge.postMessage({ type: "openRecentProject", path: p });
    }, workspacePath);
    await page.waitForSelector("body.is-ready", { timeout: 15000 });
    await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
      timeout: 20000,
    });
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#outline-labels .outline-item").length > 0 &&
        document.querySelectorAll("#outline-citations .outline-item").length > 0,
      undefined,
      { timeout: 20000 }
    );
    await page.locator("#editor .monaco-editor").click({ position: { x: 130, y: 80 } });

    await runScenario(page, "Ref: \\ref{sec:methods}", "sec:methods");
    const refColor = await readHoverSurfaceColor(page);
    assertHoverSurfaceTone(refColor, "ref-hover");

    const mathLine = "Math abs: $\\left|x\\right| + \\lVert v \\rVert$";
    const { lineNumber: mathLineNumber } = await runScenario(page, mathLine, "\\left|x\\right|");
    await forceShowHoverOnNeedle(page, mathLineNumber, mathLine, "\\left|x\\right|");
    await pause(180);
    const mathQuality = await readMathRenderQuality(page);
    assert.ok(mathQuality, "math-hover: quality probe should read visible hover");
    assert.equal(
      Boolean(
        mathQuality.hasMathLiveMarkup ||
          mathQuality.hasMathMl ||
          mathQuality.usesMathImageFallback ||
          mathQuality.hasRenderedSpanMath
      ),
      true,
      `math-hover should provide a rendered preview: ${JSON.stringify(mathQuality)}`
    );
    if (mathQuality.usesMathImageFallback) {
      assert.equal(
        mathQuality.hasSvgImagePayload,
        true,
        `math-hover should include SVG payload when using image preview: ${JSON.stringify(mathQuality)}`
      );
      assert.ok(
        !/\\left|\\right|\\lVert|\\rVert/.test(mathQuality.text),
        `math-hover should not show raw LaTeX command text: ${JSON.stringify(mathQuality)}`
      );
    } else {
      assert.ok(
        /∣x∣/.test(mathQuality.text) && /∥v∥/.test(mathQuality.text),
        `math-hover should render absolute/norm bars as symbols: ${JSON.stringify(mathQuality)}`
      );
      assert.ok(
        !/\\left|\\right|\\lVert|\\rVert/.test(mathQuality.text),
        `math-hover should not show raw LaTeX commands: ${JSON.stringify(mathQuality)}`
      );
    }

    await runScenario(page, "\\includegraphics{figures/sample-image.png}", "sample-image.png");
    const imageColor = await readHoverSurfaceColor(page);
    assertHoverSurfaceTone(imageColor, "image-hover");
    console.log("[hover-dock-targeted] PASS");
  } finally {
    if (app) {
      await app.close().catch(() => {});
    }
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
};

run().catch((error) => {
  console.error("[hover-dock-targeted] FAILED");
  console.error(error);
  process.exitCode = 1;
});
