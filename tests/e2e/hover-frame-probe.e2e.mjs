import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const sourceWorkspace = path.join(repoRoot, "test-workspace");

const now = () => new Date().toISOString().slice(11, 19);
const log = (msg) => console.log(`[hover-frame-probe ${now()}] ${msg}`);

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-hover-probe-"));
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  return { tempDir, workspacePath };
};

const run = async () => {
  const outDir = process.env.E2E_SCREENSHOT_DIR || path.join(repoRoot, "tmp", "hover-frame-probe");
  await fs.mkdir(outDir, { recursive: true });

  const { tempDir, workspacePath } = await createWorkspaceCopy();
  let app;
  try {
    app = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      slowMo: 60,
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
    const editor = page.locator("#editor .monaco-editor");
    await editor.waitFor({ state: "visible", timeout: 15000 });
    await editor.click({ position: { x: 130, y: 90 } });

    const scenarios = [
      {
        id: "image",
        text: "\\includegraphics{figures/sample-image.png}",
        needle: "sample-image.png",
        previewKind: "image",
      },
      {
        id: "text-cite",
        text: "\\cite{lamport1994}",
        needle: "lamport1994",
        previewKind: "text",
      },
      {
        id: "text-ref",
        text: "Section~\\ref{sec:methods}",
        needle: "sec:methods",
        previewKind: "text",
      },
      {
        id: "math",
        text: "$E=mc^2$",
        needle: "E=mc^2",
        previewKind: "math",
      },
      {
        id: "math-display-dollar",
        text: "$$\\sum_{k=1}^n k$$",
        needle: "sum",
        previewKind: "math",
      },
      {
        id: "math-display-block",
        text: "\\[\n\\Theta^{(\\mathrm{det})}_S + R + X_{i:t}\\mapsto X_{i,t}\n\\]",
        needle: "mapsto",
        previewKind: "math",
      },
      {
        id: "math-environment",
        text: "\\begin{equation}\nE=mc^2\n\\end{equation}",
        needle: "E=mc^2",
        previewKind: "math",
      },
      {
        id: "math-complex",
        text: "$\\Theta^{(\\mathrm{det})}_S + R + X_{i:t}\\mapsto X_{i,t} + \\frac{\\|J\\|}{\\rho}$",
        needle: "mapsto",
        previewKind: "math",
      },
    ];

    const analyzeHover = async (previewKind = "image") =>
      page.evaluate((previewKindInner) => {
        const visibleHovers = Array.from(document.querySelectorAll(".monaco-hover"))
          .map((node) => node)
          .filter((el) => {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return (
              !el.classList.contains("hidden") &&
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number.parseFloat(style.opacity || "1") > 0.1 &&
              rect.width > 1 &&
              rect.height > 1
            );
          })
          .sort((a, b) => {
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            return rb.width * rb.height - ra.width * ra.height;
          });
        const hover =
          (previewKindInner === "image"
            ? visibleHovers.find((el) =>
                Boolean(
                  el.querySelector('[data-tex64-preview="image"] img[src^="data:image"]') ??
                    el.querySelector("img[src*='#tex64-image']") ??
                    el.querySelector("img[src^='data:image']")
                )
              )
            : previewKindInner === "math"
              ? visibleHovers.find((el) =>
                  Boolean(
                    el.querySelector(".rendered-markdown math") ??
                      el.querySelector(".rendered-markdown span.ML__latex") ??
                      el.querySelector('[data-tex64-preview="math"]') ??
                      el.querySelector("img[src*='#tex64-math']") ??
                      el.querySelector("img[src^='data:image']")
                  )
                )
              : visibleHovers.find(
                  (el) => !el.querySelector(".rendered-markdown math") && !el.querySelector("img[src^='data:image']")
                )) ??
          visibleHovers[0] ??
          null;
        if (!hover) {
          return {
            frameCandidates: [],
            styleNodes: [],
            visibleMathLiveNodes: [],
            hoverText: "",
            hoverHtml: "",
            wrapperFrame: null,
          };
        }
        const all = [hover, ...hover.querySelectorAll("*")];
        const frameCandidates = [];
        const styleNodes = [];
        for (const node of all) {
          const el = node;
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) continue;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") continue;

          const borders = [
            Number.parseFloat(style.borderTopWidth),
            Number.parseFloat(style.borderRightWidth),
            Number.parseFloat(style.borderBottomWidth),
            Number.parseFloat(style.borderLeftWidth),
          ].filter((n) => Number.isFinite(n));
          const borderPx = borders.length ? Math.max(...borders) : 0;
          const outlinePx = Number.parseFloat(style.outlineWidth);
          const boxShadow = style.boxShadow || "none";

          const hasFrame =
            borderPx > 0.5 || (Number.isFinite(outlinePx) && outlinePx > 0.5) || boxShadow !== "none";
          const base = {
            tag: el.tagName,
            className: el.className,
            rect: {
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
            },
            background: style.backgroundColor || "",
            borderPx,
            outlinePx: Number.isFinite(outlinePx) ? outlinePx : 0,
            boxShadow,
            borderRadius: style.borderRadius || "",
            opacity: style.opacity || "",
            zIndex: style.zIndex || "",
            text: (el.textContent || "").trim().slice(0, 64),
          };

          if (hasFrame) {
            frameCandidates.push(base);
          }

          const bg = (style.backgroundColor || "").replace(/\s+/g, "");
          const hasVisibleBg =
            bg && bg !== "transparent" && bg !== "rgba(0,0,0,0)" && bg !== "rgb(0,0,0,0)";
          const hasRadius =
            typeof style.borderRadius === "string" &&
            style.borderRadius !== "0px" &&
            style.borderRadius !== "0px 0px 0px 0px";
          if (hasVisibleBg || hasRadius) {
            styleNodes.push(base);
          }
        }
        frameCandidates.sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
        styleNodes.sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
        const visibleMathLiveNodes = Array.from(document.querySelectorAll('[class*="ML__"]'))
          .map((node) => node)
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width < 1 || rect.height < 1) return false;
            const style = window.getComputedStyle(el);
            return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
          })
          .map((el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return {
              tag: el.tagName,
              className: el.className,
              text: (el.textContent || "").trim().slice(0, 80),
              rect: {
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
              },
              background: style.backgroundColor || "",
              borderTop: style.borderTop || "",
              outline: style.outline || "",
              boxShadow: style.boxShadow || "",
              position: style.position || "",
              zIndex: style.zIndex || "",
            };
          });
        const wrapper = hover.closest(".monaco-resizable-hover");
        const wrapperFrame = (() => {
          if (!wrapper) return null;
          const style = window.getComputedStyle(wrapper);
          const borders = [
            Number.parseFloat(style.borderTopWidth),
            Number.parseFloat(style.borderRightWidth),
            Number.parseFloat(style.borderBottomWidth),
            Number.parseFloat(style.borderLeftWidth),
          ].filter((n) => Number.isFinite(n));
          const borderPx = borders.length ? Math.max(...borders) : 0;
          const outlinePx = Number.parseFloat(style.outlineWidth);
          const radiusPx = Number.parseFloat(style.borderTopLeftRadius);
          return {
            className: wrapper.className,
            borderPx,
            outlinePx: Number.isFinite(outlinePx) ? outlinePx : 0,
            radiusPx: Number.isFinite(radiusPx) ? radiusPx : 0,
            boxShadow: style.boxShadow || "none",
            background: style.backgroundColor || "",
          };
        })();
        const previewNode =
          (previewKindInner === "image"
            ? hover.querySelector('.rendered-markdown > div[data-tex64-preview="image"]') ??
              hover.querySelector(".rendered-markdown > div:has(> img[src^='data:image'])")
            : previewKindInner === "math"
              ? hover.querySelector('.rendered-markdown > div[data-tex64-preview="math"]') ??
                hover.querySelector(".rendered-markdown > div:has(math)") ??
                hover.querySelector(".rendered-markdown > div:has(> span.ML__latex)") ??
                hover.querySelector(".rendered-markdown > div:has(> img[src^='data:image'])") ??
                hover.querySelector('.rendered-markdown > div:has(> span)')
              : hover.querySelector(".rendered-markdown")) ??
          hover.querySelector("img[src^='data:image']")?.closest("div") ??
          hover;
        const previewStyle = (() => {
          if (!previewNode) return null;
          const style = window.getComputedStyle(previewNode);
          const borders = [
            Number.parseFloat(style.borderTopWidth),
            Number.parseFloat(style.borderRightWidth),
            Number.parseFloat(style.borderBottomWidth),
            Number.parseFloat(style.borderLeftWidth),
          ].filter((n) => Number.isFinite(n));
          const borderPx = borders.length ? Math.max(...borders) : 0;
          return {
            background: style.backgroundColor || "",
            borderPx,
            radiusPx: Number.parseFloat(style.borderTopLeftRadius) || 0,
          };
        })();
        return {
          frameCandidates: frameCandidates.slice(0, 20),
          styleNodes: styleNodes.slice(0, 40),
          visibleMathLiveNodes: visibleMathLiveNodes.slice(0, 120),
          hoverText: (hover.textContent || "").replace(/\s+/g, " ").trim(),
          hoverHtml: hover.innerHTML || "",
          wrapperFrame,
          previewStyle,
        };
      }, previewKind);

    const topEdgeAnchor = await page.evaluate(() => {
      const editors = window.monaco?.editor?.getEditors?.() ?? [];
      const active =
        editors.find((ed) => typeof ed.hasTextFocus === "function" && ed.hasTextFocus()) ?? editors[0];
      const model = active?.getModel?.();
      if (!active || !model) return null;
      const needle = "amsmath";
      let lineNumber = 1;
      let idx = -1;
      const lineCount = model.getLineCount();
      for (let line = 1; line <= lineCount; line += 1) {
        const content = model.getLineContent(line);
        const found = content.indexOf(needle);
        if (found >= 0) {
          lineNumber = line;
          idx = found;
          break;
        }
      }
      if (idx < 0) {
        return null;
      }
      const column = idx + 2;
      active.setPosition({ lineNumber, column });
      active.revealPosition?.({ lineNumber, column });
      active.focus?.();
      active.trigger?.("hover-frame-probe", "editor.action.showHover", {});
      const domNode = active?.getDomNode?.();
      const visible = active?.getScrolledVisiblePosition?.({ lineNumber, column });
      if (!domNode || !visible) {
        return null;
      }
      const rect = domNode.getBoundingClientRect();
      return {
        cursorX: rect.left + visible.left + Math.max(6, Math.floor((visible.width || 12) / 2)),
        cursorY: rect.top + visible.top + Math.max(6, Math.floor((visible.height || 18) / 2)),
      };
    });
    await pause(500);
    const topEdgeStats = await page.evaluate(() => {
      const visibleHovers = Array.from(document.querySelectorAll(".monaco-hover"))
        .map((node) => node)
        .filter((el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return (
            !el.classList.contains("hidden") &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number.parseFloat(style.opacity || "1") > 0.1 &&
            rect.width > 1 &&
            rect.height > 1
          );
        })
        .sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        });
      const hover = visibleHovers.find((el) => !el.querySelector("img[src^='data:image']")) ?? visibleHovers[0] ?? null;
      if (!hover) return null;
      const rect = hover.getBoundingClientRect();
      return {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    });
    if (!topEdgeAnchor || !topEdgeStats) {
      throw new Error(`top-edge: hover did not appear near the first lines ${JSON.stringify({ topEdgeAnchor, topEdgeStats })}`);
    }
    if (topEdgeStats.top < 2 || topEdgeStats.left < 2) {
      throw new Error(`top-edge: hover is clipped near Monaco edge ${JSON.stringify(topEdgeStats)}`);
    }
    if (topEdgeStats.right > topEdgeStats.viewportWidth - 2 || topEdgeStats.bottom > topEdgeStats.viewportHeight - 2) {
      throw new Error(`top-edge: hover exceeds viewport bounds ${JSON.stringify(topEdgeStats)}`);
    }
    await page.screenshot({
      path: path.join(outDir, "probe-top-edge-context.png"),
    });
    await page.evaluate(() => {
      const editors = window.monaco?.editor?.getEditors?.() ?? [];
      const active =
        editors.find((ed) => typeof ed.hasTextFocus === "function" && ed.hasTextFocus()) ?? editors[0];
      active?.trigger?.("hover-frame-probe", "editor.action.hideHover", {});
    });
    await pause(180);

    const results = {};
    for (const scenario of scenarios) {
      const anchor = await page.evaluate((payload) => {
        const editors = window.monaco?.editor?.getEditors?.() ?? [];
        const active =
          editors.find((ed) => typeof ed.hasTextFocus === "function" && ed.hasTextFocus()) ?? editors[0];
        const model = active?.getModel?.();
        if (!active || !model) return null;
        const lastLine = model.getLineCount();
        const endColumn = model.getLineMaxColumn(lastLine);
        const hasValue = model.getValueLength() > 0;
        const insertText = `${model.getValueLength() > 0 ? "\n" : ""}${payload.text}`;
        active.executeEdits("hover-frame-probe", [
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
        const insertedStartLine = hasValue ? lastLine + 1 : lastLine;
        const insertedEndLine = model.getLineCount();
        let lineNumber = insertedEndLine;
        let lineText = model.getLineContent(lineNumber);
        let idx = -1;
        for (let line = insertedStartLine; line <= insertedEndLine; line += 1) {
          const currentLine = model.getLineContent(line);
          const found = currentLine.indexOf(payload.needle);
          if (found >= 0) {
            lineNumber = line;
            lineText = currentLine;
            idx = found;
            break;
          }
        }
        if (idx < 0) {
          idx = Math.max(0, lineText.length - Math.max(1, payload.needle.length));
        }
        const tokenStartColumn = (idx >= 0 ? idx : Math.max(0, lineText.length - 2)) + 1;
        const tokenEndColumn = tokenStartColumn + Math.max(0, payload.needle.length - 1);
        const cursorColumn = tokenStartColumn + 1;
        active.setPosition({ lineNumber, column: cursorColumn });
        active.revealPositionInCenterIfOutsideViewport?.({ lineNumber, column: cursorColumn });
        active.focus?.();
        active.trigger?.("hover-frame-probe", "editor.action.showHover", {});
        const domNode = active?.getDomNode?.();
        const visible = active?.getScrolledVisiblePosition?.({ lineNumber, column: cursorColumn });
        if (!domNode || !visible) {
          return null;
        }
        const rect = domNode.getBoundingClientRect();
        const x = rect.left + visible.left + Math.max(6, Math.floor((visible.width || 12) / 2));
        const y = rect.top + visible.top + Math.max(6, Math.floor((visible.height || 18) / 2));
        return {
          x,
          y,
          lineNumber,
          tokenStartColumn,
          tokenEndColumn: Math.max(tokenStartColumn, tokenEndColumn),
        };
      }, scenario);
      await pause(500);
      await page.waitForFunction(() => {
        const nodes = Array.from(document.querySelectorAll(".monaco-hover"));
        return nodes.some((node) => {
          const el = node;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return (
            !el.classList.contains("hidden") &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number.parseFloat(style.opacity || "1") > 0.1 &&
            rect.width > 1 &&
            rect.height > 1
          );
        });
      }, undefined, { timeout: 7000 });

      const stabilitySamples = [];
      let expectedSampleCount = 0;
      if (anchor && Number.isFinite(anchor.lineNumber) && Number.isFinite(anchor.tokenStartColumn)) {
        const sampleColumns = (() => {
          const start = Math.max(1, Math.floor(anchor.tokenStartColumn));
          const end = Math.max(start, Math.floor(anchor.tokenEndColumn ?? start));
          const mid = Math.max(start, Math.floor((start + end) / 2));
          return Array.from(new Set([start, mid, end]));
        })();
        expectedSampleCount = sampleColumns.length;
        const takeHoverSnapshot = async (previewKindInner) =>
          page.evaluate((kind) => {
            const visibleHovers = Array.from(document.querySelectorAll(".monaco-hover"))
              .map((node) => node)
              .filter((el) => {
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return (
                  !el.classList.contains("hidden") &&
                  style.display !== "none" &&
                  style.visibility !== "hidden" &&
                  Number.parseFloat(style.opacity || "1") > 0.1 &&
                  rect.width > 1 &&
                  rect.height > 1
                );
              })
              .sort((a, b) => {
                const ra = a.getBoundingClientRect();
                const rb = b.getBoundingClientRect();
                return rb.width * rb.height - ra.width * ra.height;
              });
            const hover =
              (kind === "image"
                ? visibleHovers.find((el) => Boolean(el.querySelector("img[src*='#tex64-image']") ?? el.querySelector("img[src^='data:image']")))
                : kind === "math"
                  ? visibleHovers.find((el) =>
                      Boolean(
                        el.querySelector(".rendered-markdown math") ??
                          el.querySelector(".rendered-markdown span.ML__latex") ??
                          el.querySelector('[data-tex64-preview="math"]') ??
                          el.querySelector("img[src*='#tex64-math']") ??
                          el.querySelector("img[src^='data:image']")
                      )
                    )
                  : visibleHovers.find(
                      (el) => !el.querySelector(".rendered-markdown math") && !el.querySelector("img[src^='data:image']")
                    )) ??
              visibleHovers[0] ??
              null;
            if (!hover) return null;
            if (!hover.dataset.tex64StableHoverId) {
              hover.dataset.tex64StableHoverId = `hover-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            }
            const image = hover.querySelector("img[src^='data:image']");
            const imageSrc = image?.getAttribute("src") ?? "";
            const math = hover.querySelector(".rendered-markdown math");
            const mathSpan = hover.querySelector(".rendered-markdown span.ML__latex");
            const mathSignature = ((math?.textContent ?? "") || (mathSpan?.textContent ?? ""))
              .replace(/\s+/g, "")
              .slice(0, 220);
            const html = hover.innerHTML || "";
            const r = hover.getBoundingClientRect();
            return {
              hoverId: hover.dataset.tex64StableHoverId,
              imageSrc,
              mathSignature,
              htmlLength: html.length,
              rect: {
                left: Math.round(r.left),
                top: Math.round(r.top),
                width: Math.round(r.width),
                height: Math.round(r.height),
              },
            };
          }, previewKindInner);

        const firstSnapshot = await takeHoverSnapshot(scenario.previewKind);
        if (firstSnapshot) {
          stabilitySamples.push({ column: sampleColumns[0], ...firstSnapshot });
        }

        for (const column of sampleColumns.slice(1)) {
          await page.evaluate((payload) => {
            const editors = window.monaco?.editor?.getEditors?.() ?? [];
            const active =
              editors.find((ed) => typeof ed.hasTextFocus === "function" && ed.hasTextFocus()) ?? editors[0];
            if (!active) return;
            active.setPosition({ lineNumber: payload.lineNumber, column: payload.column });
            active.focus?.();
          }, { lineNumber: anchor.lineNumber, column });
          await pause(120);
          const snapshot = await takeHoverSnapshot(scenario.previewKind);
          if (snapshot) {
            stabilitySamples.push({ column, ...snapshot });
          }
        }
        if (stabilitySamples.length !== expectedSampleCount) {
          throw new Error(
            `${scenario.id}: hover disappeared while moving within the same source token, got ${JSON.stringify(
              stabilitySamples
            )}`
          );
        }
      }
      if (stabilitySamples.length >= 2) {
        const leftValues = stabilitySamples.map((entry) => entry.rect.left);
        const topValues = stabilitySamples.map((entry) => entry.rect.top);
        const widthValues = stabilitySamples.map((entry) => entry.rect.width);
        const heightValues = stabilitySamples.map((entry) => entry.rect.height);
        const deltaLeft = Math.max(...leftValues) - Math.min(...leftValues);
        const deltaTop = Math.max(...topValues) - Math.min(...topValues);
        const deltaWidth = Math.max(...widthValues) - Math.min(...widthValues);
        const deltaHeight = Math.max(...heightValues) - Math.min(...heightValues);
        if (deltaLeft > 1 || deltaTop > 1 || deltaWidth > 1 || deltaHeight > 1) {
          throw new Error(
            `${scenario.id}: hover position/size should stay stable within token, got ${JSON.stringify(
              stabilitySamples
            )}`
          );
        }
        const hoverIds = new Set(stabilitySamples.map((entry) => entry.hoverId).filter(Boolean));
        if (hoverIds.size > 1) {
          throw new Error(
            `${scenario.id}: hover was regenerated while moving within the same source token, got ${JSON.stringify(
              stabilitySamples
            )}`
          );
        }
        if (scenario.previewKind === "image") {
          const imageSrcSet = new Set(stabilitySamples.map((entry) => entry.imageSrc).filter(Boolean));
          if (imageSrcSet.size > 1) {
            throw new Error(
              `${scenario.id}: preview image changed while moving in token, got ${JSON.stringify(
                stabilitySamples
              )}`
            );
          }
        }
        if (scenario.previewKind === "math") {
          const mathSigSet = new Set(stabilitySamples.map((entry) => entry.mathSignature).filter(Boolean));
          if (mathSigSet.size > 1) {
            throw new Error(
              `${scenario.id}: math preview content changed while moving in token, got ${JSON.stringify(
                stabilitySamples
              )}`
            );
          }
        }
      }

      await page.evaluate(() => {
        const editors = window.monaco?.editor?.getEditors?.() ?? [];
        const active =
          editors.find((ed) => typeof ed.hasTextFocus === "function" && ed.hasTextFocus()) ?? editors[0];
        active?.trigger?.("hover-frame-probe", "editor.action.showHover", {});
      });
      await pause(120);

      const hoverClip = await page.evaluate((previewKindInner) => {
        const visibleHovers = Array.from(document.querySelectorAll(".monaco-hover"))
          .map((node) => node)
          .filter((el) => {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return (
              !el.classList.contains("hidden") &&
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number.parseFloat(style.opacity || "1") > 0.1 &&
              rect.width > 1 &&
              rect.height > 1
            );
          })
          .sort((a, b) => {
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            return rb.width * rb.height - ra.width * ra.height;
          });
        const hover =
          (previewKindInner === "image"
            ? visibleHovers.find((el) =>
                Boolean(el.querySelector("img[src*='#tex64-image']") ?? el.querySelector("img[src^='data:image']"))
              )
            : previewKindInner === "math"
              ? visibleHovers.find((el) =>
                  Boolean(
                    el.querySelector(".rendered-markdown math") ??
                      el.querySelector(".rendered-markdown span.ML__latex") ??
                      el.querySelector('[data-tex64-preview="math"]') ??
                      el.querySelector("img[src*='#tex64-math']") ??
                      el.querySelector("img[src^='data:image']")
                  )
                )
              : visibleHovers.find(
                  (el) => !el.querySelector(".rendered-markdown math") && !el.querySelector("img[src^='data:image']")
                )) ??
          visibleHovers[0] ??
          null;
        if (!hover) return null;
        const rect = hover.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const pad = 28;
        const x = Math.max(0, Math.floor(rect.left - pad));
        const y = Math.max(0, Math.floor(rect.top - pad));
        const width = Math.max(1, Math.min(vw - x, Math.ceil(rect.width + pad * 2)));
        const height = Math.max(1, Math.min(vh - y, Math.ceil(rect.height + pad * 2)));
        return {
          x,
          y,
          width,
          height,
          hoverOnly: {
            x: Math.max(0, Math.floor(rect.left)),
            y: Math.max(0, Math.floor(rect.top)),
            width: Math.max(1, Math.min(vw - Math.max(0, Math.floor(rect.left)), Math.ceil(rect.width))),
            height: Math.max(1, Math.min(vh - Math.max(0, Math.floor(rect.top)), Math.ceil(rect.height))),
          },
        };
      }, scenario.previewKind);
      if (hoverClip) {
        await page.screenshot({
          path: path.join(outDir, `probe-${scenario.id}-context.png`),
          clip: { x: hoverClip.x, y: hoverClip.y, width: hoverClip.width, height: hoverClip.height },
        });
        await page.screenshot({
          path: path.join(outDir, `probe-${scenario.id}-hover-full.png`),
          clip: hoverClip.hoverOnly,
        });
      }

      await pause(180);
      const analysis = await analyzeHover(scenario.previewKind);
      const previewPresence = await page.evaluate(() => {
        const visibleHovers = Array.from(document.querySelectorAll(".monaco-hover"))
          .map((node) => node)
          .filter((el) => {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return (
              !el.classList.contains("hidden") &&
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number.parseFloat(style.opacity || "1") > 0.1 &&
              rect.width > 1 &&
              rect.height > 1
            );
          })
            .sort((a, b) => {
              const ra = a.getBoundingClientRect();
              const rb = b.getBoundingClientRect();
              return rb.width * rb.height - ra.width * ra.height;
            });
        const hasImage = visibleHovers.some((hover) =>
          Boolean(hover.querySelector("img[src*='#tex64-image']") ?? hover.querySelector("img[src^='data:image']"))
        );
        const hasMath = visibleHovers.some((hover) =>
          Boolean(
            hover.querySelector(".rendered-markdown math") ??
              hover.querySelector(".rendered-markdown span.ML__latex") ??
              hover.querySelector('[data-tex64-preview="math"]') ??
              hover.querySelector("img[src*='#tex64-math']")
          )
        );
        return { hasImage, hasMath };
      });
      const hasImagePreview =
        Boolean(previewPresence?.hasImage) ||
        Boolean(stabilitySamples.find((sample) => typeof sample.imageSrc === "string" && sample.imageSrc));
      const hasMathPreview =
        Boolean(previewPresence?.hasMath) ||
        Boolean(stabilitySamples.find((sample) => typeof sample.mathSignature === "string" && sample.mathSignature));
      results[scenario.id] = analysis;
      results[scenario.id].stabilitySamples = stabilitySamples;
      log(
        `${scenario.id}: frame=${analysis.frameCandidates.length} style=${analysis.styleNodes.length} ml=${analysis.visibleMathLiveNodes.length} image=${hasImagePreview} math=${hasMathPreview} text="${analysis.hoverText}"`
      );
      if (scenario.previewKind === "image" && !hasImagePreview) {
        throw new Error(`${scenario.id}: image preview was not rendered`);
      }
      if (scenario.previewKind === "math" && !hasMathPreview) {
        throw new Error(`${scenario.id}: math preview was not rendered`);
      }
      if (scenario.previewKind !== "image" && scenario.previewKind !== "math" && (hasImagePreview || hasMathPreview)) {
        throw new Error(`${scenario.id}: unexpected preview rendered`);
      }
      if (!analysis.previewStyle) {
        await page.evaluate(() => {
          const editors = window.monaco?.editor?.getEditors?.() ?? [];
          const active =
            editors.find((ed) => typeof ed.hasTextFocus === "function" && ed.hasTextFocus()) ?? editors[0];
          active?.trigger?.("hover-frame-probe", "editor.action.hideHover", {});
        });
        await pause(180);
        continue;
      }
      if (stabilitySamples.length > 0) {
        const maxWidth = Math.max(...stabilitySamples.map((entry) => entry.rect.width));
        const maxHeight = Math.max(...stabilitySamples.map((entry) => entry.rect.height));
        if (maxWidth > 360 || maxHeight > 200) {
          throw new Error(
            `${scenario.id}: preview is not compact (w=${maxWidth}, h=${maxHeight})`
          );
        }
      }
      const normalizedBg = String(analysis.previewStyle.background || "").replace(/\s+/g, "");
      if (
        !normalizedBg ||
        normalizedBg === "transparent" ||
        normalizedBg === "rgba(0,0,0,0)" ||
        normalizedBg === "rgb(0,0,0,0)"
      ) {
        await fs.writeFile(path.join(outDir, "probe-debug-analysis.json"), JSON.stringify(analysis, null, 2), "utf8");
        throw new Error(`${scenario.id}: preview background is not visible`);
      }
      if (analysis.previewStyle.borderPx > 0.5) {
        throw new Error(`${scenario.id}: preview border should be absent`);
      }
      if (
        analysis.wrapperFrame &&
        (analysis.wrapperFrame.borderPx > 0.5 ||
          analysis.wrapperFrame.outlinePx > 0.5 ||
          analysis.wrapperFrame.radiusPx > 0.5 ||
          analysis.wrapperFrame.boxShadow !== "none")
      ) {
        throw new Error(
          `${scenario.id}: wrapper frame remains ${JSON.stringify(analysis.wrapperFrame)}`
        );
      }
      await page.evaluate(() => {
        const editors = window.monaco?.editor?.getEditors?.() ?? [];
        const active =
          editors.find((ed) => typeof ed.hasTextFocus === "function" && ed.hasTextFocus()) ?? editors[0];
        active?.trigger?.("hover-frame-probe", "editor.action.hideHover", {});
      });
      await pause(180);
    }

    await fs.writeFile(path.join(outDir, "probe-candidates.json"), JSON.stringify(results, null, 2), "utf8");
    log(`saved: ${outDir}`);
  } finally {
    if (app) {
      try {
        await app.close();
      } catch {
        try {
          app.process()?.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

run().catch((error) => {
  console.error("[hover-frame-probe] FAILED");
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
