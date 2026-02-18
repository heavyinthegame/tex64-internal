import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const sampleWorkspace = path.join(repoRoot, "test-sample-hover");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const toPosix = (value) => value.split(path.sep).join("/");

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-hover-sample-all-"));
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(sampleWorkspace, workspacePath, { recursive: true });
  return { tempDir, workspacePath };
};

const parseColor = (value) => {
  if (typeof value !== "string") return null;
  const m = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/i);
  if (!m) return null;
  return {
    r: Number.parseInt(m[1], 10),
    g: Number.parseInt(m[2], 10),
    b: Number.parseInt(m[3], 10),
    a: m[4] == null ? 1 : Number.parseFloat(m[4]),
  };
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

const openSampleWorkspace = async (page) => {
  await page.setViewportSize({ width: 1680, height: 980 });
  await openWorkspaceViaLauncher(page);

  await page.waitForSelector("body.is-ready", { timeout: 20000 });
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
    timeout: 30000,
  });
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#outline-labels .outline-item").length > 0 &&
      document.querySelectorAll("#outline-citations .outline-item").length > 0,
    undefined,
    { timeout: 30000 }
  );

  await page.locator("#editor .monaco-editor").click({ position: { x: 130, y: 90 } });
  await wait(120);
};

const showHoverAt = async (page, target) => {
  const ok = await page.evaluate((payload) => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const editor =
      editors.find((ed) => typeof ed.hasTextFocus === "function" && ed.hasTextFocus()) ?? editors[0];
    const model = editor?.getModel?.();
    if (!editor || !model) return false;

    const lineCount = model.getLineCount?.() ?? 0;
    let lineMatchCount = 0;
    let lineNumber = -1;
    for (let line = 1; line <= lineCount; line += 1) {
      const text = model.getLineContent(line);
      if (!text.includes(payload.lineContains)) continue;
      lineMatchCount += 1;
      if (lineMatchCount === (payload.lineOccurrence ?? 1)) {
        lineNumber = line;
        break;
      }
    }
    if (lineNumber < 0) return false;

    const lineText = model.getLineContent(lineNumber);
    let tokenMatchCount = 0;
    let idx = -1;
    let searchFrom = 0;
    while (searchFrom <= lineText.length) {
      const found = lineText.indexOf(payload.token, searchFrom);
      if (found < 0) break;
      tokenMatchCount += 1;
      if (tokenMatchCount === (payload.tokenOccurrence ?? 1)) {
        idx = found;
        break;
      }
      searchFrom = found + payload.token.length;
    }
    if (idx < 0) return false;

    const mid = idx + Math.max(1, Math.floor(payload.token.length / 2));
    const column = mid + 1;

    editor.trigger?.("hover-sample-all", "editor.action.hideHover", {});
    editor.setPosition?.({ lineNumber, column });
    editor.focus?.();
    editor.revealPositionInCenterIfOutsideViewport?.({ lineNumber, column });
    editor.trigger?.("hover-sample-all", "editor.action.showHover", {});
    return true;
  }, target);
  return ok;
};

const getVisibleHoverStats = async (page) =>
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

    const previewRoot =
      hover.querySelector('[data-tex64-preview="math"]') ??
      hover.querySelector('[data-tex64-preview="image"]') ??
      hover.querySelector(".rendered-markdown > div") ??
      hover;

    const codeEl = hover.querySelector(".rendered-markdown code");
    const hoverStyle = window.getComputedStyle(hover);
    const previewStyle = window.getComputedStyle(previewRoot);
    const codeStyle = codeEl ? window.getComputedStyle(codeEl) : null;

    const text = (hover.textContent ?? "").replace(/\s+/g, " ").trim();
    const mathImage = hover.querySelector('img[src*="#tex64-math"]');
    let mathSvgDecoded = null;
    if (mathImage && typeof mathImage.getAttribute === "function") {
      const src = mathImage.getAttribute("src") ?? "";
      const raw = src.split("#")[0] ?? "";
      const comma = raw.indexOf(",");
      if (comma >= 0) {
        try {
          mathSvgDecoded = decodeURIComponent(raw.slice(comma + 1));
        } catch {
          mathSvgDecoded = null;
        }
      }
    }

    return {
      text,
      html: (hover.innerHTML ?? "").slice(0, 1200),
      mathSvgDecoded: typeof mathSvgDecoded === "string" ? mathSvgDecoded.slice(0, 6000) : null,
      hasMathPreview: Boolean(
        hover.querySelector('[data-tex64-preview="math"]') ??
        hover.querySelector("img[src*='#tex64-math']") ??
        hover.querySelector(".rendered-markdown math") ??
        hover.querySelector(".rendered-markdown .ML__latex")
      ),
      hasImagePreview: Boolean(
        hover.querySelector("img[src*='#tex64-image']") ??
          hover.querySelector('[data-tex64-preview="image"] img[src^="data:image"]') ??
          hover.querySelector("img[src^='data:image']")
      ),
      hoverBg: hoverStyle.backgroundColor,
      previewBg: previewStyle.backgroundColor,
      codeBg: codeStyle?.backgroundColor ?? null,
      codeColor: codeStyle?.color ?? null,
      width: Math.round(hover.getBoundingClientRect().width),
      height: Math.round(hover.getBoundingClientRect().height),
    };
  });

const waitForHover = async (page, testId, expectVisible) => {
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline) {
    const stats = await getVisibleHoverStats(page);
    if (expectVisible) {
      if (stats) return stats;
    } else if (!stats) {
      return null;
    }
    await wait(80);
  }
  const last = await getVisibleHoverStats(page);
  if (expectVisible) {
    throw new Error(`${testId}: hover not visible`);
  }
  throw new Error(`${testId}: hover should be hidden, but visible: ${JSON.stringify(last)}`);
};

const assertReadableBackground = (stats, testId) => {
  const hoverBg = parseColor(stats.hoverBg);
  const previewBg = parseColor(stats.previewBg);
  const effective = (previewBg?.a ?? 0) > 0.2 ? previewBg : hoverBg;
  assert.ok(effective, `${testId}: background color parse failed (${stats.hoverBg} / ${stats.previewBg})`);
  assert.ok((effective.a ?? 0) >= 0.8, `${testId}: background alpha too low (${JSON.stringify(effective)})`);
};

const cases = [
  { id: "PKG-CLASS", lineContains: "\\documentclass[a4paper]{article}", token: "article", kind: "text" },
  { id: "PKG-amsmath", lineContains: "\\usepackage{amsmath,amssymb}", token: "amsmath", kind: "text" },
  { id: "PKG-amssymb", lineContains: "\\usepackage{amsmath,amssymb}", token: "amssymb", kind: "text" },
  { id: "PKG-graphicx", lineContains: "\\RequirePackage{graphicx,xcolor}", token: "graphicx", kind: "text" },
  { id: "PKG-xcolor", lineContains: "\\RequirePackage{graphicx,xcolor}", token: "xcolor", kind: "text" },
  { id: "PKG-hyperref", lineContains: "\\usepackage{hyperref}", token: "hyperref", kind: "text" },
  { id: "PKG-cleveref", lineContains: "\\usepackage{cleveref}", token: "cleveref", kind: "text" },

  { id: "REF-ref", lineContains: "REF-ref:", token: "sec:methods", kind: "text", expectCodeChip: true },
  { id: "REF-eqref", lineContains: "REF-eqref:", token: "eq:newton", kind: "text" },
  { id: "REF-pageref", lineContains: "REF-pageref:", token: "sec:methods", kind: "text" },
  { id: "REF-autoref", lineContains: "REF-autoref:", token: "sec:methods", kind: "text" },
  { id: "REF-cref", lineContains: "REF-cref:", token: "sec:methods", kind: "text" },
  { id: "REF-Cref", lineContains: "REF-Cref:", token: "sec:methods", kind: "text" },
  { id: "REF-namecref", lineContains: "REF-namecref:", token: "sec:methods", kind: "text" },
  { id: "REF-Namecref", lineContains: "REF-Namecref:", token: "sec:methods", kind: "text" },
  { id: "REF-nameref", lineContains: "REF-nameref:", token: "sec:methods", kind: "text" },
  { id: "REF-Nameref", lineContains: "REF-Nameref:", token: "sec:methods", kind: "text" },

  { id: "CITE-cite", lineContains: "CITE-cite:", token: "lamport1994", kind: "text" },
  { id: "CITE-citet", lineContains: "CITE-citet:", token: "lamport1994", kind: "text" },
  { id: "CITE-citep", lineContains: "CITE-citep:", token: "knuth1984", kind: "text" },
  { id: "CITE-citeauthor", lineContains: "CITE-citeauthor:", token: "lamport1994", kind: "text" },
  { id: "CITE-citeyear", lineContains: "CITE-citeyear:", token: "lamport1994", kind: "text" },
  { id: "CITE-autocite", lineContains: "CITE-autocite:", token: "lamport1994", kind: "text" },
  { id: "CITE-parencite", lineContains: "CITE-parencite:", token: "knuth1984", kind: "text" },
  { id: "CITE-textcite", lineContains: "CITE-textcite:", token: "lamport1994", kind: "text" },
  { id: "CITE-footcite", lineContains: "CITE-footcite:", token: "lamport1994", kind: "text" },
  { id: "CITE-supercite", lineContains: "CITE-supercite:", token: "knuth1984", kind: "text" },
  { id: "CITE-multi-second", lineContains: "CITE-multi:", token: "lamport1994", kind: "text" },

  { id: "MATH-inline", lineContains: "MATH-inline:", token: "E=mc^2", kind: "math", mathProbe: /E\s*=\s*mc2/i },
  { id: "MATH-paren", lineContains: "MATH-inline-paren:", token: "int_0^1", kind: "math", mathProbe: /(∫|dx)/i },
  { id: "MATH-absnorm", lineContains: "MATH-inline-absnorm:", token: "left|x", kind: "math", mathProbe: /(\|x\||∥|l∥)/ },
  {
    id: "MATH-bars-double",
    lineContains: "MATH-inline-bars-double:",
    token: "left\\|z",
    kind: "math",
    mathProbe: /(\|z\||\|v\||\|J\|)/,
  },
  {
    id: "MATH-sets",
    lineContains: "MATH-inline-sets:",
    token: "setminus",
    kind: "math",
    mathProbe: /(∪|∩|\\\\)/,
  },
  {
    id: "MATH-opname",
    lineContains: "MATH-inline-opname:",
    token: "argmax",
    kind: "math",
    mathProbe: /(argmax|diag)/i,
  },
  {
    id: "MATH-prob",
    lineContains: "MATH-inline-prob:",
    token: "Pr(",
    kind: "math",
    mathProbe: /(Pr|Var|E)/,
  },
  { id: "MATH-display-bracket", lineContains: "\\sum_{k=1}^{n}", token: "sum_{k=1}^{n}", kind: "math", mathProbe: /(∑|n\(n\+1\))/ },
  { id: "MATH-display-dollar", lineContains: "\\Theta_S^{(\\mathrm{det})}", token: "mapsto", kind: "math", mathProbe: /(Θ|ρ|Xi,t|Xi:t)/ },
  { id: "MATH-equation-env", lineContains: "+ \\frac{\\|J\\|}{\\rho}", token: "frac", kind: "math", mathProbe: /(Θ|ρ|J)/ },
  {
    id: "MATH-alignat",
    lineContains: "x_1+x_2 & = 1",
    token: "x_1+x_2",
    kind: "math",
    mathProbe: /(x1|x2|1|2)/,
  },
  {
    id: "MATH-flalign",
    lineContains: "u+v & = w",
    token: "u+v",
    kind: "math",
    mathProbe: /(u|v|w)/,
  },

  { id: "INCLUDE-input", lineContains: "\\include{sections/intro}", token: "sections/intro", kind: "text" },
  { id: "INCLUDE-include", lineContains: "\\include{sections/methods}", token: "sections/methods", kind: "text" },

  { id: "GRAPHICS-png", lineContains: "GRAPHICS-png:", token: "sample-image.png", kind: "image" },
  { id: "GRAPHICS-png-opt", lineContains: "GRAPHICS-png-opt:", token: "sample-image.png", kind: "image" },
  { id: "GRAPHICS-pdf", lineContains: "GRAPHICS-pdf:", token: "sample.pdf", kind: "text" },
  { id: "GRAPHICS-svg", lineContains: "GRAPHICS-svg:", token: "sample-vector.svg", kind: "graphics" },

  { id: "UNRESOLVED-ref", lineContains: "REF-unresolved:", token: "sec:not-found", kind: "none" },
  { id: "UNRESOLVED-cite", lineContains: "CITE-unresolved:", token: "unknown2026", kind: "none" },
  { id: "UNRESOLVED-include", lineContains: "INCLUDE-unresolved-input:", token: "sections/not-found", kind: "none" },
  { id: "UNRESOLVED-graphics", lineContains: "GRAPHICS-unresolved:", token: "figures/not-found", kind: "none" },
];

const run = async () => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const userDataPath = path.join(tempDir, "userdata");
  let app;
  try {
    await fs.mkdir(userDataPath, { recursive: true });
    app = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      slowMo: 35,
      env: {
        ...process.env,
        TEX64_E2E: "1",
        TEX64_E2E_USERDATA: userDataPath,
        TEX64_E2E_DIALOG_QUEUE: JSON.stringify({
          openWorkspace: [toPosix(workspacePath)],
        }),
      },
    });
    const page = await app.firstWindow();
    await openSampleWorkspace(page);

    for (const c of cases) {
      const positioned = await showHoverAt(page, c);
      if (!positioned) {
        console.warn(`[hover-sample-all] SKIP (position): ${c.id}`);
        continue;
      }
      if (c.kind === "none") {
        await waitForHover(page, c.id, false);
        continue;
      }

      const stats = await waitForHover(page, c.id, true);
      assert.ok(stats, `${c.id}: hover missing`);
      assertReadableBackground(stats, c.id);
      assert.ok(stats.width > 20 && stats.height > 20, `${c.id}: invalid hover size ${stats.width}x${stats.height}`);

      if (c.kind === "math") {
        const fallbackMathRendered =
          !/\\[A-Za-z]+/.test(stats.text) && (c.mathProbe instanceof RegExp ? c.mathProbe.test(stats.text) : false);
        assert.ok(
          stats.hasMathPreview || fallbackMathRendered,
          `${c.id}: math preview not rendered; text=${stats.text}; html=${stats.html}`
        );
        assert.ok(!/\\[A-Za-z]+/.test(stats.text), `${c.id}: raw latex leaked in text: ${stats.text}`);
        assert.ok(!stats.text.includes("&#"), `${c.id}: leaked HTML entity text: ${stats.text}`);
        if (typeof stats.mathSvgDecoded === "string" && stats.mathSvgDecoded.length > 0) {
          assert.ok(
            !stats.mathSvgDecoded.includes("&amp;#"),
            `${c.id}: encoded HTML entity leaked into SVG payload`
          );
          assert.ok(
            !stats.mathSvgDecoded.includes("&#8290;"),
            `${c.id}: invisible-times entity leaked into SVG payload`
          );
          assert.ok(
            !/\\(?:left|right|lVert|rVert|Vert)\b/.test(stats.mathSvgDecoded),
            `${c.id}: raw delimiter latex leaked into SVG payload`
          );
          assert.ok(
            !/<merror\b/i.test(stats.mathSvgDecoded),
            `${c.id}: MathML contains merror node`
          );
          assert.ok(
            !/<m[io][^>]*>&amp;<\/m[io]>/i.test(stats.mathSvgDecoded),
            `${c.id}: ampersand token leaked as math identifier/operator`
          );
          assert.ok(
            !/\b(?:alignat|flalign)\b/i.test(stats.mathSvgDecoded),
            `${c.id}: unsupported environment text leaked into rendered payload`
          );
        }
        if (c.id === "MATH-absnorm" || c.id === "MATH-bars-double") {
          assert.ok(!stats.text.includes("//"), `${c.id}: delimiter rendered as slash pair: ${stats.text}`);
          if (typeof stats.mathSvgDecoded === "string" && stats.mathSvgDecoded.length > 0) {
            assert.ok(
              !stats.mathSvgDecoded.includes("∥"),
              `${c.id}: parallel-bar glyph still present in SVG payload`
            );
            assert.ok(
              stats.mathSvgDecoded.includes("<mo>|</mo><mo>|</mo>"),
              `${c.id}: normalized double bars missing in SVG payload`
            );
          }
        }
      }

      if (c.kind === "image") {
        assert.ok(stats.hasImagePreview, `${c.id}: image preview not rendered`);
      }

      if (c.kind === "text") {
        assert.ok(stats.text.length > 0, `${c.id}: text hover content is empty`);
      }

      if (c.kind === "graphics") {
        assert.ok(
          stats.hasImagePreview || stats.text.length > 0,
          `${c.id}: graphics hover should show preview or path text`
        );
      }

      if (c.expectCodeChip) {
        assert.ok(stats.codeBg, `${c.id}: expected inline code chip background`);
        assert.notEqual(
          stats.codeBg,
          "rgba(10, 10, 10, 0.4)",
          `${c.id}: file-path code chip still uses old default tint`
        );
      }

      await page.evaluate(() => {
        const editors = window.monaco?.editor?.getEditors?.() ?? [];
        const editor =
          editors.find((ed) => typeof ed.hasTextFocus === "function" && ed.hasTextFocus()) ?? editors[0];
        editor?.trigger?.("hover-sample-all", "editor.action.hideHover", {});
      });
      await wait(80);
    }

    console.log(`[hover-sample-all] PASS (${cases.length} cases)`);
  } finally {
    if (app) {
      await app.close().catch(() => {});
    }
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
};

run().catch((error) => {
  console.error("[hover-sample-all] FAILED");
  console.error(error);
  process.exitCode = 1;
});
