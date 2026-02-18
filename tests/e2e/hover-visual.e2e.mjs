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
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "200", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "60", 10);
const visualPasses = Math.max(1, Number.parseInt(process.env.E2E_VISUAL_PASSES ?? "3", 10));

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[hover-visual-e2e ${now()}] ${message}`);
};

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-hover-visual-"));
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  return { tempDir, workspacePath };
};

const postToBridge = async (page, payload) => {
  await page.evaluate((value) => {
    window.tex64Bridge.postMessage(value);
  }, payload);
};

const waitForWorkspaceReady = async (page, activeFile = "main.tex") => {
  await page.waitForSelector("body.is-ready", { timeout: 15000 });
  await page.waitForSelector(`#editor-tabs-list .editor-tab.is-active[data-path="${activeFile}"]`, {
    timeout: 20000,
  });
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#outline-labels .outline-item").length > 0 &&
      document.querySelectorAll("#outline-citations .outline-item").length > 0,
    undefined,
    { timeout: 20000 }
  );
};

const focusEditor = async (page) => {
  const editor = page.locator("#editor .monaco-editor");
  await editor.waitFor({ state: "visible", timeout: 15000 });
  await editor.click({ position: { x: 120, y: 80 } });
  await page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    if (editors[0]?.focus) {
      editors[0].focus();
    }
  });
  await pause(120);
};

const appendLineViaModel = async (page, text) => {
  const lineNumber = await page.evaluate((lineText) => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    const model = active?.getModel?.();
    if (!active || !model) {
      return -1;
    }

    const lastLine = model.getLineCount();
    const endColumn = model.getLineMaxColumn(lastLine);
    const hasValue = model.getValueLength() > 0;
    const insertText = `${hasValue ? "\n" : ""}${lineText}`;
    active.executeEdits("hover-visual-e2e", [
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
    active.focus();
    return insertedLineNumber;
  }, text);

  assert.ok(lineNumber > 0, `appendLineViaModel failed: ${text}`);
  await pause(100);
  return { lineNumber, text };
};

const setCursorOnLineSubstring = async (page, lineNumber, lineText, needle, occurrence = 1) => {
  let fromIndex = 0;
  let foundIndex = -1;
  for (let i = 0; i < occurrence; i += 1) {
    foundIndex = lineText.indexOf(needle, fromIndex);
    if (foundIndex < 0) break;
    fromIndex = foundIndex + needle.length;
  }
  assert.ok(foundIndex >= 0, `substring not found: ${needle} in ${lineText}`);
  const column = foundIndex + Math.max(1, Math.floor(needle.length / 2)) + 1;
  await page.evaluate(
    (payload) => {
      const editors = window.monaco?.editor?.getEditors?.() ?? [];
      const active =
        editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
        editors[0];
      if (active?.setPosition) {
        active.setPosition({ lineNumber: payload.lineNumber, column: payload.column });
      }
      active?.focus?.();
    },
    { lineNumber, column }
  );
  await pause(100);
};

const triggerShowHover = async (page) => {
  await page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    const position = active?.getPosition?.();
    if (position && active?.revealPositionInCenterIfOutsideViewport) {
      active.revealPositionInCenterIfOutsideViewport(position);
    }
    active?.trigger?.("hover-visual-e2e", "editor.action.showHover", {});
  });
  await pause(160);
};

const hideHover = async (page) => {
  await page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    active?.trigger?.("hover-visual-e2e", "editor.action.hideHover", {});
  });
  await pause(90);
};

const assertHoverVisible = async (page, testName, timeout = 5000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const visible = await page.evaluate(() => {
      return Array.from(document.querySelectorAll(".monaco-hover")).some((hover) => {
        const style = window.getComputedStyle(hover);
        const rect = hover.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      });
    });
    if (visible) return;
    await pause(80);
  }
  throw new Error(`${testName}: hover not visible`);
};

const assertNoHoverVisible = async (page, testName, timeout = 900) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const visible = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll(".monaco-hover")).filter((hover) => {
        const style = window.getComputedStyle(hover);
        const rect = hover.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      });
      if (candidates.length === 0) {
        return null;
      }
      const hover = candidates[0];
      return {
        text: (hover.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
        htmlLength: (hover.innerHTML ?? "").length,
      };
    });
    if (visible) {
      throw new Error(
        `${testName}: hover should be disabled, but it appeared (${JSON.stringify(visible)})`
      );
    }
    await pause(80);
  }
};

const waitForHoverContentByType = async (page, type, testName, timeout = 5000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const ready = await page.evaluate((hoverType) => {
      const visibleHovers = Array.from(document.querySelectorAll(".monaco-hover")).filter((node) => {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 1 && rect.height > 1;
      });
      if (visibleHovers.length === 0) {
        return false;
      }
      if (hoverType === "image") {
        return visibleHovers.some((hover) =>
          Boolean(
            hover.querySelector("img[src*='#tex64-image']") ??
              hover.querySelector('[data-tex64-preview="image"] img[src^="data:image"]') ??
              hover.querySelector("img[src^='data:image']")
          )
        );
      }
      if (hoverType === "math") {
        return visibleHovers.some((hover) =>
          Boolean(
            hover.querySelector("img[src*='#tex64-math']") ??
              hover.querySelector(".rendered-markdown math") ??
              hover.querySelector(".rendered-markdown span.ML__latex") ??
              hover.querySelector('[data-tex64-preview="math"]')
          )
        );
      }
      return visibleHovers.some((hover) => {
        if (hover.querySelector("img[src^='data:image']")) {
          return false;
        }
        return ((hover.textContent ?? "").trim().length ?? 0) > 0;
      });
    }, type);
    if (ready) {
      return;
    }
    await pause(80);
  }
  throw new Error(`${testName}: hover content was not ready for type=${type}`);
};

const captureHoverScreenshot = async (page, name, selector = ".monaco-hover", timeoutMs = 5000) => {
  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (!dir) return null;
  await fs.mkdir(dir, { recursive: true });
  const targetPath = path.join(dir, `${name}.png`);
  const startedAt = Date.now();
  let clip = null;
  while (Date.now() - startedAt < timeoutMs) {
    clip = await page.evaluate((query) => {
      const candidates = Array.from(document.querySelectorAll(query));
      const el = candidates.find((node) => {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 1 && rect.height > 1;
      });
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const x = Math.max(0, Math.floor(rect.left));
      const y = Math.max(0, Math.floor(rect.top));
      const width = Math.max(1, Math.min(vw - x, Math.ceil(rect.width)));
      const height = Math.max(1, Math.min(vh - y, Math.ceil(rect.height)));
      return { x, y, width, height };
    }, selector);
    if (clip) break;
    await pause(80);
  }
  if (clip) {
    await page.screenshot({ path: targetPath, clip });
  } else {
    await page.screenshot({ path: targetPath });
  }
  return targetPath;
};

const captureHoverContextScreenshot = async (page, name, timeoutMs = 5000) => {
  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (!dir) return null;
  await fs.mkdir(dir, { recursive: true });
  const targetPath = path.join(dir, `${name}.png`);
  const startedAt = Date.now();
  let clip = null;
  while (Date.now() - startedAt < timeoutMs) {
    clip = await page.evaluate(() => {
      const hover = Array.from(document.querySelectorAll(".monaco-hover")).find((node) => {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 1 && rect.height > 1;
      });
      if (!hover) return null;
    const hoverRect = hover.getBoundingClientRect();
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    const position = active?.getPosition?.();
    const domNode = active?.getDomNode?.();
    const visible = position ? active?.getScrolledVisiblePosition?.(position) : null;
    let cursorX = hoverRect.left + hoverRect.width / 2;
    let cursorY = hoverRect.top + hoverRect.height / 2;
    if (position && domNode && visible) {
      const hostRect = domNode.getBoundingClientRect();
      cursorX = hostRect.left + visible.left + Math.max(6, Math.floor((visible.width || 12) / 2));
      cursorY = hostRect.top + visible.top + Math.max(6, Math.floor((visible.height || 18) / 2));
    }
    const pad = 28;
    const left = Math.min(hoverRect.left, cursorX) - pad;
    const top = Math.min(hoverRect.top, cursorY) - pad;
    const right = Math.max(hoverRect.right, cursorX) + pad;
    const bottom = Math.max(hoverRect.bottom, cursorY) + pad;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const x = Math.max(0, Math.floor(left));
    const y = Math.max(0, Math.floor(top));
    const width = Math.max(1, Math.min(vw - x, Math.ceil(right - left)));
    const height = Math.max(1, Math.min(vh - y, Math.ceil(bottom - top)));
    return { x, y, width, height };
    });
    if (clip) break;
    await pause(80);
  }
  if (clip) {
    await page.screenshot({ path: targetPath, clip });
  } else {
    await page.screenshot({ path: targetPath });
  }
  return targetPath;
};

const getHoverVisualStats = async (page, type = "math") =>
  page.evaluate((hoverType) => {
    const parseColor = (value) => {
      const m = String(value ?? "")
        .trim()
        .match(/^rgba?\(([^)]+)\)$/i);
      if (!m) return null;
      const parts = m[1].split(",").map((v) => Number.parseFloat(v.trim()));
      if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
      return { r: parts[0], g: parts[1], b: parts[2], a: Number.isFinite(parts[3]) ? parts[3] : 1 };
    };

    const toLinear = (c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };

    const luminance = (rgb) => 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);

    const contrast = (fg, bg) => {
      if (!fg || !bg) return null;
      const l1 = luminance(fg);
      const l2 = luminance(bg);
      const hi = Math.max(l1, l2);
      const lo = Math.min(l1, l2);
      return (hi + 0.05) / (lo + 0.05);
    };

    const visibleHovers = Array.from(document.querySelectorAll(".monaco-hover")).filter((node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 1 && rect.height > 1;
    });
    const hover =
      (hoverType === "image"
        ? visibleHovers.find((node) =>
            Boolean(
              node.querySelector('[data-tex64-preview="image"] img[src^="data:image"]') ??
                node.querySelector("img[src*='#tex64-image']") ??
                node.querySelector("img[src^='data:image']")
            )
          )
        : hoverType === "math"
          ? visibleHovers.find((node) =>
              Boolean(
                node.querySelector(".rendered-markdown math") ??
                  node.querySelector(".rendered-markdown span.ML__latex") ??
                  node.querySelector('[data-tex64-preview="math"]') ??
                  node.querySelector("img[src*='#tex64-math']") ??
                  node.querySelector("img[src^='data:image']")
              )
            )
          : visibleHovers.find(
              (node) =>
                !node.querySelector(".rendered-markdown math") &&
                !node.querySelector("img[src^='data:image']") &&
                ((node.textContent ?? "").trim().length > 0 || node.querySelector(".rendered-markdown"))
            )) ??
      visibleHovers[0] ??
      null;
    if (!hover) return null;

    const imageRoot =
      hover.querySelector('.rendered-markdown > div[data-tex64-preview="image"]') ??
      hover.querySelector(".rendered-markdown > div:has(> img[src^='data:image'])") ??
      null;
    const mathRoot =
      hover.querySelector('.rendered-markdown > div[data-tex64-preview="math"]') ??
      hover.querySelector(".rendered-markdown > div:has(math)") ??
      hover.querySelector(".rendered-markdown > div:has(> span.ML__latex)") ??
      hover.querySelector(".rendered-markdown > div:has(> img[src^='data:image'])") ??
      hover.querySelector("span.ML__latex")?.closest("div") ??
      null;
    const previewRoot = mathRoot ?? imageRoot ?? hover;

    const disallowed = [
      ".ML__toggles",
      ".ML__menu-toggle",
      ".ML__virtual-keyboard-toggle",
      ".ML__popover",
      "[part='menu-toggle']",
      "[part='virtual-keyboard-toggle']",
      ".tex64-hover-math button",
    ];
    const disallowedCount = disallowed.reduce(
      (sum, selector) => sum + hover.querySelectorAll(selector).length,
      0
    );

    let innerMaxBorderPx = 0;
    let innerMaxOutlinePx = 0;
    let innerBoxShadowCount = 0;
    const nodes = [previewRoot, ...previewRoot.querySelectorAll("*")].slice(0, 300);
    for (const node of nodes) {
      const style = window.getComputedStyle(node);
      const bVals = [
        Number.parseFloat(style.borderTopWidth),
        Number.parseFloat(style.borderRightWidth),
        Number.parseFloat(style.borderBottomWidth),
        Number.parseFloat(style.borderLeftWidth),
      ].filter((n) => Number.isFinite(n));
      const o = Number.parseFloat(style.outlineWidth);
      const bMax = bVals.length > 0 ? Math.max(...bVals) : 0;
      innerMaxBorderPx = Math.max(innerMaxBorderPx, bMax);
      if (Number.isFinite(o)) innerMaxOutlinePx = Math.max(innerMaxOutlinePx, o);
      if (style.boxShadow && style.boxShadow !== "none") {
        innerBoxShadowCount += 1;
      }
    }

    const hoverRect = hover.getBoundingClientRect();
    const rootRect = previewRoot.getBoundingClientRect();

    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    const position = active?.getPosition?.();
    const domNode = active?.getDomNode?.();
    const visible = position ? active?.getScrolledVisiblePosition?.(position) : null;

    let gapAbove = null;
    let gapBelow = null;
    let dockTopDelta = null;
    let dockRightDelta = null;
    let overlapsCursor = null;
    if (position && domNode && visible) {
      const hostRect = domNode.getBoundingClientRect();
      const cursorY = hostRect.top + visible.top + Math.max(1, (visible.height || 18) / 2);
      const cursorX = hostRect.left + visible.left + Math.max(1, (visible.width || 10) / 2);
      gapAbove = Math.round(cursorY - hoverRect.bottom);
      gapBelow = Math.round(hoverRect.top - cursorY);
      overlapsCursor =
        cursorX >= hoverRect.left &&
        cursorX <= hoverRect.right &&
        cursorY >= hoverRect.top &&
        cursorY <= hoverRect.bottom;
      dockTopDelta = Math.round(hoverRect.top - hostRect.top);
      dockRightDelta = Math.round(hostRect.right - hoverRect.right);
    } else if (domNode) {
      const hostRect = domNode.getBoundingClientRect();
      dockTopDelta = Math.round(hoverRect.top - hostRect.top);
      dockRightDelta = Math.round(hostRect.right - hoverRect.right);
    }

    const hoverStyle = window.getComputedStyle(hover);
    const previewStyle = window.getComputedStyle(previewRoot);
    const wrapper = hover.closest(".monaco-resizable-hover");
    const wrapperStyle = wrapper ? window.getComputedStyle(wrapper) : null;
    const mathTextNode = (mathRoot ?? hover).querySelector?.("span.ML__latex") ?? (mathRoot || previewRoot);
    const fgStyle = window.getComputedStyle(mathTextNode);
    const hoverBorderVals = [
      Number.parseFloat(hoverStyle.borderTopWidth),
      Number.parseFloat(hoverStyle.borderRightWidth),
      Number.parseFloat(hoverStyle.borderBottomWidth),
      Number.parseFloat(hoverStyle.borderLeftWidth),
    ].filter((n) => Number.isFinite(n));
    const hoverBorderPx = hoverBorderVals.length > 0 ? Math.max(...hoverBorderVals) : 0;
    const hoverOutlinePx = Number.parseFloat(hoverStyle.outlineWidth);
    const hoverBoxShadow = hoverStyle.boxShadow ?? "none";
    const wrapperBorderVals = wrapperStyle
      ? [
          Number.parseFloat(wrapperStyle.borderTopWidth),
          Number.parseFloat(wrapperStyle.borderRightWidth),
          Number.parseFloat(wrapperStyle.borderBottomWidth),
          Number.parseFloat(wrapperStyle.borderLeftWidth),
        ].filter((n) => Number.isFinite(n))
      : [];
    const wrapperBorderPx = wrapperBorderVals.length > 0 ? Math.max(...wrapperBorderVals) : 0;
    const wrapperOutlinePx = wrapperStyle ? Number.parseFloat(wrapperStyle.outlineWidth) : 0;
    const wrapperBoxShadow = wrapperStyle?.boxShadow ?? "none";
    const wrapperRadiusPx = wrapperStyle ? Number.parseFloat(wrapperStyle.borderTopLeftRadius) : 0;
    const bg = parseColor(previewStyle.backgroundColor || hoverStyle.backgroundColor);
    const fg = parseColor(fgStyle.color);

    const text = hover.textContent?.replace(/\s+/g, " ").trim() ?? "";
    return {
      disallowedCount,
      innerMaxBorderPx,
      innerMaxOutlinePx,
      innerBoxShadowCount,
      hoverWidth: Math.round(hoverRect.width),
      hoverHeight: Math.round(hoverRect.height),
      rootWidth: Math.round(rootRect.width),
      rootHeight: Math.round(rootRect.height),
      hoverBorderPx,
      hoverOutlinePx: Number.isFinite(hoverOutlinePx) ? hoverOutlinePx : 0,
      hoverBoxShadow,
      wrapperBorderPx,
      wrapperOutlinePx: Number.isFinite(wrapperOutlinePx) ? wrapperOutlinePx : 0,
      wrapperBoxShadow,
      wrapperRadiusPx: Number.isFinite(wrapperRadiusPx) ? wrapperRadiusPx : 0,
      previewBg: previewStyle.backgroundColor,
      previewBgAlpha: bg?.a ?? 0,
      gapAbove,
      gapBelow,
      dockTopDelta,
      dockRightDelta,
      overlapsCursor,
      contrastRatio: contrast(fg, bg),
      hasMathRoot: Boolean(mathRoot),
      hasMathMl: Boolean(mathRoot?.querySelector("math")),
      hasImageRoot: Boolean(imageRoot),
      hasImagePreview: Boolean(
        hover.querySelector('[data-tex64-preview="image"] img[src^="data:image"]') ??
          hover.querySelector("img[src*='#tex64-image']") ??
          hover.querySelector("img[src^='data:image']")
      ),
      hasMathPreview: Boolean(
        hover.querySelector(".rendered-markdown math") ??
          hover.querySelector(".rendered-markdown span.ML__latex") ??
          hover.querySelector('[data-tex64-preview="math"]') ??
          hover.querySelector("img[src*='#tex64-math']") ??
          hover.querySelector("img[src^='data:image']")
      ),
      text,
      html: hover.innerHTML,
    };
  }, type);

const runVisualPass = async (page, passIndex) => {
  log(`visual pass ${passIndex} start`);
  const cases = [
    {
      id: "V-01",
      text: "$E=mc^2$",
      needle: "E=mc^2",
      type: "math",
      expectedTextFragment: "E=mc2",
      screenshotSelector: ".monaco-hover .rendered-markdown",
    },
    {
      id: "V-02",
      text: "$\\Theta^{(\\mathrm{det})}_S$",
      needle: "\\mathrm{det}",
      type: "math",
      expectedTextFragment: "det",
      screenshotSelector: ".monaco-hover .rendered-markdown",
    },
    {
      id: "V-02b",
      text: "$X_i:t\\mapsto X_{i,t}$",
      needle: "mapsto",
      type: "math",
      expectedTextFragment: "↦",
      screenshotSelector: ".monaco-hover .rendered-markdown",
    },
    {
      id: "V-02c",
      text: "$\\Theta^{(\\mathrm{det})}_S + R + X_{i:t}\\mapsto X_{i,t} + \\frac{\\|J\\|}{\\rho}$",
      needle: "mapsto",
      type: "math",
      expectedTextFragment: "↦",
      screenshotSelector: ".monaco-hover .rendered-markdown",
    },
    {
      id: "V-02d",
      text: "$$\\sum_{k=1}^n k$$",
      needle: "sum",
      type: "math",
      expectedTextFragment: "∑",
      screenshotSelector: ".monaco-hover .rendered-markdown",
    },
    {
      id: "V-02e",
      text: "\\begin{equation}E=mc^2\\end{equation}",
      needle: "E=mc^2",
      type: "math",
      expectedTextFragment: "E=mc2",
      screenshotSelector: ".monaco-hover .rendered-markdown",
    },
    {
      id: "V-03",
      text: "\\includegraphics{figures/sample-image.png}",
      needle: "sample-image.png",
      type: "image",
      screenshotSelector: ".monaco-hover img[src^='data:image']",
    },
    {
      id: "V-04",
      text: "\\cite{lamport1994}",
      needle: "lamport1994",
      type: "text",
      screenshotSelector: ".monaco-hover",
    },
    {
      id: "V-05",
      text: "Section~\\ref{sec:methods}",
      needle: "sec:methods",
      type: "text",
      screenshotSelector: ".monaco-hover",
    },
    {
      id: "V-06",
      text: "\\RequirePackage{graphicx}",
      needle: "graphicx",
      type: "text",
      screenshotSelector: ".monaco-hover",
    },
    {
      id: "V-07",
      text: "\\begin{document}",
      needle: "\\begin",
      type: "none",
      expectVisible: false,
      screenshotSelector: ".monaco-editor",
    },
    {
      id: "V-08",
      text: "\\includegraphics[width=0.8\\linewidth]{figures/sample-image.png}",
      needle: "\\includegraphics",
      type: "none",
      expectVisible: false,
      screenshotSelector: ".monaco-editor",
    },
    {
      id: "V-09",
      text: "\\ref{sec:not-found}",
      needle: "sec:not-found",
      type: "none",
      expectVisible: false,
      screenshotSelector: ".monaco-editor",
    },
    {
      id: "V-10",
      text: "\\cite{unknown2026}",
      needle: "unknown2026",
      type: "none",
      expectVisible: false,
      screenshotSelector: ".monaco-editor",
    },
    {
      id: "V-11",
      text: "\\includegraphics{figures/not-found}",
      needle: "not-found",
      type: "none",
      expectVisible: false,
      screenshotSelector: ".monaco-editor",
    },
    {
      id: "V-12",
      text: "\\include{sections/not-found}",
      needle: "sections/not-found",
      type: "none",
      expectVisible: false,
      screenshotSelector: ".monaco-editor",
    },
  ];

  for (const entry of cases) {
    const line = await appendLineViaModel(page, entry.text);
    await setCursorOnLineSubstring(page, line.lineNumber, line.text, entry.needle);
    await hideHover(page);
    await triggerShowHover(page);
    if (entry.expectVisible === false) {
      await assertNoHoverVisible(page, `${entry.id}/pass${passIndex}`, 1200);
      await captureHoverContextScreenshot(page, `hover-visual-pass${passIndex}-${entry.id.toLowerCase()}-context`);
      await hideHover(page);
      await pause(100);
      continue;
    }
    await assertHoverVisible(page, `${entry.id}/pass${passIndex}`);
    if (entry.type === "math" || entry.type === "image" || entry.type === "text") {
      await waitForHoverContentByType(page, entry.type, `${entry.id}/pass${passIndex}`);
    }

    const stats = await getHoverVisualStats(page, entry.type);
    assert.ok(stats, `${entry.id}/pass${passIndex}: no visual stats`);

    assert.equal(
      stats.disallowedCount,
      0,
      `${entry.id}/pass${passIndex}: disallowed controls remain\n${JSON.stringify(stats, null, 2)}`
    );

    assert.ok(
      stats.overlapsCursor === false,
      `${entry.id}/pass${passIndex}: docked hover overlaps cursor/source\n${JSON.stringify(stats, null, 2)}`
    );

    assert.ok(
      Number.isFinite(stats.dockTopDelta) &&
        stats.dockTopDelta >= 0 &&
        stats.dockTopDelta <= 64,
      `${entry.id}/pass${passIndex}: hover is not docked near top edge\n${JSON.stringify(stats, null, 2)}`
    );

    assert.ok(
      Number.isFinite(stats.dockRightDelta) &&
        stats.dockRightDelta >= 0 &&
        stats.dockRightDelta <= 64,
      `${entry.id}/pass${passIndex}: hover is not docked near right edge\n${JSON.stringify(stats, null, 2)}`
    );

    assert.ok(
      (stats.previewBgAlpha ?? 0) >= 0.75,
      `${entry.id}/pass${passIndex}: preview background is not contrast-friendly\n${JSON.stringify(
        stats,
        null,
        2
      )}`
    );

    assert.ok(
      stats.hoverWidth <= 360 && stats.hoverHeight <= 200,
      `${entry.id}/pass${passIndex}: hover not compact\n${JSON.stringify(stats, null, 2)}`
    );

    assert.ok(
      stats.hoverBorderPx <= 0.5 && stats.hoverOutlinePx <= 0.5,
      `${entry.id}/pass${passIndex}: hover border/outline remains\n${JSON.stringify(stats, null, 2)}`
    );

    assert.ok(
      stats.hoverBoxShadow === "none",
      `${entry.id}/pass${passIndex}: hover box-shadow remains\n${JSON.stringify(stats, null, 2)}`
    );

    assert.ok(
      stats.wrapperBorderPx <= 0.5 &&
        stats.wrapperOutlinePx <= 0.5 &&
        stats.wrapperRadiusPx <= 0.5 &&
        stats.wrapperBoxShadow === "none",
      `${entry.id}/pass${passIndex}: wrapper frame remains\n${JSON.stringify(stats, null, 2)}`
    );

    if (entry.type === "math") {
      assert.ok(
        stats.hasMathPreview || stats.text.length > 0,
        `${entry.id}/pass${passIndex}: math preview content missing\n${JSON.stringify(stats, null, 2)}`
      );
      assert.ok(
        (stats.contrastRatio ?? 0) >= 4.5,
        `${entry.id}/pass${passIndex}: math contrast too low\n${JSON.stringify(stats, null, 2)}`
      );
      if (!stats.hasMathPreview) {
        assert.ok(
          !stats.text.includes("\\"),
          `${entry.id}/pass${passIndex}: raw latex command text should not be shown\n${JSON.stringify(stats, null, 2)}`
        );
      }
      if (entry.expectedTextFragment && !stats.hasMathPreview) {
        assert.ok(
          stats.text.replace(/\s+/g, "").includes(entry.expectedTextFragment),
          `${entry.id}/pass${passIndex}: rendered text mismatch\n${JSON.stringify(stats, null, 2)}`
        );
      }
    }

    if (entry.type === "image") {
      assert.ok(stats.hasImagePreview, `${entry.id}/pass${passIndex}: image preview missing`);
      assert.ok(
        !stats.text.includes("figures/sample-image.png"),
        `${entry.id}/pass${passIndex}: filename text should not appear\n${JSON.stringify(stats, null, 2)}`
      );
    }

    if (entry.type === "text") {
      assert.ok(
        !stats.hasImagePreview,
        `${entry.id}/pass${passIndex}: text hover unexpectedly rendered image\n${JSON.stringify(stats, null, 2)}`
      );
      assert.ok(
        (stats.previewBgAlpha ?? 0) >= 0.85,
        `${entry.id}/pass${passIndex}: text hover background should be opaque\n${JSON.stringify(stats, null, 2)}`
      );
      assert.ok(
        (stats.contrastRatio ?? 0) >= 4.5,
        `${entry.id}/pass${passIndex}: text hover contrast too low\n${JSON.stringify(stats, null, 2)}`
      );
      assert.ok(
        stats.text.length > 0,
        `${entry.id}/pass${passIndex}: text hover content is empty\n${JSON.stringify(stats, null, 2)}`
      );
    }

    await captureHoverScreenshot(page, `hover-visual-pass${passIndex}-${entry.id.toLowerCase()}-hover`, ".monaco-hover");
    await captureHoverContextScreenshot(page, `hover-visual-pass${passIndex}-${entry.id.toLowerCase()}-context`);
    await captureHoverScreenshot(page, `hover-visual-pass${passIndex}-${entry.id.toLowerCase()}-content`, entry.screenshotSelector);
    await hideHover(page);
    await pause(100);
  }

  log(`visual pass ${passIndex} passed`);
};

const run = async () => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  let electronApp;

  try {
    log(`workspace copy: ${workspacePath}`);
    log("launching Electron...");
    electronApp = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      slowMo: Number.isFinite(slowMoMs) ? Math.max(0, slowMoMs) : 0,
      env: { ...process.env },
    });

    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1640, height: 980 });

    page.on("dialog", async (dialog) => {
      log(`dialog intercepted: ${dialog.type()} ${dialog.message()}`);
      try {
        await dialog.dismiss();
      } catch {
        // ignore protocol races
      }
    });

    log("opening workspace via bridge...");
    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page, "main.tex");
    await focusEditor(page);

    await page.waitForFunction(
      () => Boolean(window.MathLive?.convertLatexToMathMl || window.MathLive?.convertLatexToMarkup),
      undefined,
      {
      timeout: 20000,
      }
    );

    log("MathLive ready");
    for (let i = 1; i <= visualPasses; i += 1) {
      await runVisualPass(page, i);
    }

    log("all visual passes passed");
  } finally {
    if (electronApp) {
      try {
        await electronApp.close();
      } catch {
        try {
          electronApp.process()?.kill("SIGKILL");
        } catch {
          // ignore force kill failure
        }
      }
    }

    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true });
      log("temporary workspace removed");
    } else {
      log(`workspace kept: ${workspacePath}`);
    }
  }
};

run().catch((error) => {
  console.error("[hover-visual-e2e] FAILED");
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
