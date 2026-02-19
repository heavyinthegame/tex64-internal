import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

const defaultDatasetPath = path.join(
  repoRoot,
  "tests",
  "e2e",
  "fixtures",
  "math-ocr-benchmark",
  "samples.json"
);
const defaultOutPath = path.join(repoRoot, "tmp", "math-ocr-bench", "latest.json");
const sourceWorkspace = path.join(repoRoot, "test-workspace");

const nowIso = () => new Date().toISOString();
const now = () => nowIso().slice(11, 19);
const log = (message) => {
  console.log(`[math-ocr-bench ${now()}] ${message}`);
};

const parseArgs = (argv) => {
  const args = {
    dataset: defaultDatasetPath,
    out: defaultOutPath,
    limit: null,
    keepWorkspace: process.env.E2E_KEEP_WORKSPACE === "1",
    slowMo: Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "0", 10),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--dataset" && i + 1 < argv.length) {
      args.dataset = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === "--out" && i + 1 < argv.length) {
      args.out = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === "--limit" && i + 1 < argv.length) {
      const value = Number.parseInt(argv[i + 1], 10);
      args.limit = Number.isFinite(value) && value > 0 ? value : null;
      i += 1;
      continue;
    }
    if (token === "--keep-workspace") {
      args.keepWorkspace = true;
      continue;
    }
  }
  return args;
};

const readDataset = async (datasetPath) => {
  const raw = await fs.readFile(datasetPath, "utf8");
  const parsed = JSON.parse(raw);
  const samplesRaw = Array.isArray(parsed?.samples) ? parsed.samples : [];
  const datasetDir = path.dirname(datasetPath);
  const samples = samplesRaw
    .map((entry, index) => {
      const id =
        typeof entry?.id === "string" && entry.id.trim().length > 0
          ? entry.id.trim()
          : `sample-${String(index + 1).padStart(2, "0")}`;
      const expectedRaw =
        typeof entry?.expected === "string"
          ? entry.expected
          : typeof entry?.latex === "string"
          ? entry.latex
          : "";
      const expected = expectedRaw.trim();
      const imagePath =
        typeof entry?.imagePath === "string" && entry.imagePath.trim().length > 0
          ? path.resolve(datasetDir, entry.imagePath.trim())
          : null;
      const variantIndex = Number.isFinite(entry?.variantIndex)
        ? Number(entry.variantIndex)
        : null;
      return { id, expected, imagePath, variantIndex };
    })
    .filter((entry) => entry.expected.length > 0 || !!entry.imagePath);
  return samples;
};

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-math-ocr-bench-"));
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  return { tempDir, workspacePath };
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector("body.is-ready", { timeout: 30000 });
  await page.waitForFunction(
    () => typeof window.__tex64TestRecognizeMath === "function",
    undefined,
    { timeout: 30000 }
  );
  await page.evaluate(async () => {
    const addStyle = () => {
      if (document.querySelector('link[data-math-ocr-bench-style="mathlive"]')) {
        return;
      }
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "mathlive/mathlive-static.css";
      link.setAttribute("data-math-ocr-bench-style", "mathlive");
      document.head.appendChild(link);
    };

    const loadScript = async (src) => {
      await new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-math-ocr-bench-src="${src}"]`);
        if (existing) {
          resolve();
          return;
        }
        const script = document.createElement("script");
        script.src = src;
        script.async = true;
        script.setAttribute("data-math-ocr-bench-src", src);
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`failed to load script: ${src}`));
        document.head.appendChild(script);
      });
    };

    addStyle();
    if (typeof window.MathLive?.convertLatexToMarkup !== "function") {
      await loadScript("mathlive/mathlive.min.js");
      addStyle();
    }
    if (typeof window.MathLive?.convertLatexToMarkup !== "function") {
      throw new Error("MathLive static renderer is unavailable");
    }
  });
};

const postToBridge = async (page, payload) => {
  await page.evaluate((value) => {
    window.tex64Bridge.postMessage(value);
  }, payload);
};

const styleVariants = [
  {
    name: "clean-large",
    background: "#ffffff",
    color: "#111111",
    fontSize: 56,
    padding: 24,
    scale: 1,
    letterSpacing: "0px",
  },
  {
    name: "paper",
    background: "#f7f6f2",
    color: "#1d1d1d",
    fontSize: 48,
    padding: 22,
    scale: 1,
    letterSpacing: "0px",
  },
  {
    name: "low-contrast",
    background: "#f3f3f3",
    color: "#444444",
    fontSize: 42,
    padding: 20,
    scale: 0.98,
    letterSpacing: "0.1px",
  },
  {
    name: "compact",
    background: "#ffffff",
    color: "#1c1c1c",
    fontSize: 34,
    padding: 14,
    scale: 0.95,
    letterSpacing: "0px",
    rotateDeg: 0,
    blurPx: 0,
    contrast: 1,
    brightness: 1,
  },
  {
    name: "scan-soft",
    background: "#f7f5ef",
    color: "#252525",
    fontSize: 40,
    padding: 16,
    scale: 0.93,
    letterSpacing: "0.1px",
    rotateDeg: -0.5,
    blurPx: 0.35,
    contrast: 0.94,
    brightness: 1.03,
  },
  {
    name: "mini-dpi",
    background: "#ffffff",
    color: "#1d1d1d",
    fontSize: 30,
    padding: 12,
    scale: 0.82,
    letterSpacing: "0.15px",
    rotateDeg: 0.35,
    blurPx: 0.22,
    contrast: 1.02,
    brightness: 0.98,
  },
  {
    name: "tablet-photo",
    background: "#f2f2f2",
    color: "#333333",
    fontSize: 46,
    padding: 20,
    scale: 0.9,
    letterSpacing: "0.1px",
    rotateDeg: -0.25,
    blurPx: 0.28,
    contrast: 0.9,
    brightness: 1.04,
  },
  {
    name: "window-capture",
    background: "#fbfbfb",
    color: "#2b2b2b",
    fontSize: 38,
    padding: 18,
    scale: 0.88,
    letterSpacing: "0.05px",
    rotateDeg: 0.15,
    blurPx: 0.18,
    contrast: 0.96,
    brightness: 1.01,
  },
];

const renderSampleImage = async (page, sample, style) => {
  const hostId = `math-ocr-bench-${sample.id}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  await page.evaluate(
    async ({ id, latex, style }) => {
      const prev = document.getElementById(id);
      if (prev) {
        prev.remove();
      }
      const host = document.createElement("div");
      host.id = id;
      host.style.position = "fixed";
      host.style.left = "16px";
      host.style.top = "16px";
      host.style.zIndex = "2147483647";
      host.style.background = style.background;
      host.style.padding = `${style.padding}px`;
      host.style.borderRadius = "10px";
      host.style.boxShadow = "0 3px 10px rgba(0,0,0,0.12)";
      host.style.pointerEvents = "none";
      host.style.userSelect = "none";
      const rotateDeg = Number.isFinite(style.rotateDeg) ? style.rotateDeg : 0;
      host.style.transform = `scale(${style.scale}) rotate(${rotateDeg}deg)`;
      host.style.transformOrigin = "top left";
      const blurPx = Number.isFinite(style.blurPx) ? style.blurPx : 0;
      const contrast = Number.isFinite(style.contrast) ? style.contrast : 1;
      const brightness = Number.isFinite(style.brightness) ? style.brightness : 1;
      host.style.filter = `blur(${blurPx}px) contrast(${contrast}) brightness(${brightness})`;

      const mount = document.createElement("div");
      mount.style.display = "inline-block";
      mount.style.fontSize = `${style.fontSize}px`;
      mount.style.color = style.color;
      mount.style.letterSpacing = style.letterSpacing;
      mount.style.lineHeight = "1.2";
      const render = window.MathLive?.convertLatexToMarkup;
      if (typeof render !== "function") {
        throw new Error("MathLive static renderer is unavailable");
      }
      mount.innerHTML = render(latex, {
        letterShapeStyle: "tex",
        mathstyle: "displaystyle",
      });
      host.appendChild(mount);
      document.body.appendChild(host);

      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise((resolve) => setTimeout(resolve, 40));
    },
    { id: hostId, latex: sample.expected, style }
  );

  const locator = page.locator(`#${hostId}`);
  await locator.waitFor({ state: "visible", timeout: 5000 });
  const pngBuffer = await locator.screenshot({ type: "png", animations: "disabled" });

  await page.evaluate((id) => {
    document.getElementById(id)?.remove();
  }, hostId);

  return pngBuffer;
};

const normalizeLatex = (value) => {
  if (!value) return "";
  return String(value)
    .trim()
    .replace(/\\\s/g, "")
    .replace(/\s+/g, "")
    .replace(/\\left/g, "")
    .replace(/\\right/g, "")
    .replace(/\\dfrac/g, "\\frac")
    .replace(/\\tfrac/g, "\\frac")
    .replace(/\\,/g, "")
    .replace(/\\!/g, "")
    .replace(/\\;/g, "")
    .replace(/\\:/g, "")
    .replace(/\\cdot/g, "*")
    .replace(/\\times/g, "*")
    .replace(/\\mid/g, "|")
    .replace(/\\+$/g, "")
    .replace(/\{([A-Za-z0-9])\}/g, "$1");
};

const levenshteinDistance = (a, b) => {
  const left = a ?? "";
  const right = b ?? "";
  const cols = right.length + 1;
  const rows = left.length + 1;
  const dp = Array.from({ length: rows }, () => new Uint16Array(cols));
  for (let i = 0; i < rows; i += 1) dp[i][0] = i;
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const del = dp[i - 1][j] + 1;
      const ins = dp[i][j - 1] + 1;
      const sub = dp[i - 1][j - 1] + cost;
      dp[i][j] = Math.min(del, ins, sub);
    }
  }
  return dp[rows - 1][cols - 1];
};

const calcSimilarity = (expected, actual) => {
  const base = Math.max(expected.length, actual.length, 1);
  const distance = levenshteinDistance(expected, actual);
  return 1 - distance / base;
};

const formatPct = (value) => `${(value * 100).toFixed(1)}%`;

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  const allSamples = await readDataset(args.dataset);
  const samples = args.limit ? allSamples.slice(0, args.limit) : allSamples;
  if (samples.length === 0) {
    throw new Error(`No samples found in dataset: ${args.dataset}`);
  }

  const { tempDir, workspacePath } = await createWorkspaceCopy();
  let electronApp;

  try {
    log(`dataset: ${args.dataset}`);
    log(`samples: ${samples.length}`);
    log(`workspace copy: ${workspacePath}`);

    electronApp = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      slowMo: Number.isFinite(args.slowMo) ? Math.max(0, args.slowMo) : 0,
      env: { ...process.env, TEX64_E2E_HEADLESS: "1" },
    });

    const page = await electronApp.firstWindow();
    page.setDefaultTimeout(120000);
    await page.setViewportSize({ width: 1680, height: 1100 });

    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);

    const results = [];
    const startedAt = Date.now();

    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i];
      const styleIndex = Number.isFinite(sample.variantIndex)
        ? ((sample.variantIndex % styleVariants.length) + styleVariants.length) %
          styleVariants.length
        : i % styleVariants.length;
      const style = styleVariants[styleIndex];
      const styleName = sample.imagePath ? "file-input" : style.name;
      const imageBuffer = sample.imagePath
        ? await fs.readFile(sample.imagePath)
        : await renderSampleImage(page, sample, style);
      const imageDataUrl = `data:image/png;base64,${imageBuffer.toString("base64")}`;

      const timeStart = Date.now();
      const recognized = await page.evaluate(async (dataUrl) => {
        const fn = window.__tex64TestRecognizeMath;
        if (typeof fn !== "function") {
          return { latex: "", error: "recognize hook unavailable" };
        }
        try {
          const latex = await fn(dataUrl);
          return { latex, error: "" };
        } catch (error) {
          return {
            latex: "",
            error: error instanceof Error ? error.message : String(error ?? "OCR failed"),
          };
        }
      }, imageDataUrl);
      const elapsedMs = Date.now() - timeStart;

      const expectedNorm = normalizeLatex(sample.expected);
      const actualNorm = normalizeLatex(recognized.latex || "");
      const hasExpected = expectedNorm.length > 0;
      const similarity = hasExpected ? calcSimilarity(expectedNorm, actualNorm) : 0;
      const exact = hasExpected && expectedNorm === actualNorm;
      const pass = !hasExpected || exact || similarity >= 0.9;

      const row = {
        id: sample.id,
        style: styleName,
        expected: sample.expected,
        actual: recognized.latex || "",
        expectedNormalized: expectedNorm,
        actualNormalized: actualNorm,
        hasExpected,
        exact,
        pass,
        similarity: Number(similarity.toFixed(4)),
        elapsedMs,
        error: recognized.error || "",
      };
      results.push(row);

      const status = pass ? "PASS" : "FAIL";
      log(
        `[${String(i + 1).padStart(2, "0")}/${samples.length}] ${status} ${sample.id} (${styleName}) ` +
          `sim=${row.similarity.toFixed(3)} time=${elapsedMs}ms`
      );
      if (!pass) {
        log(`  expected=${sample.expected || "<none>"}`);
        log(`  actual  =${recognized.latex || "<empty>"}`);
      }
    }

    const totalMs = Date.now() - startedAt;
    const scored = results.filter((row) => row.hasExpected);
    const exactCount = scored.filter((row) => row.exact).length;
    const passCount = scored.filter((row) => row.pass).length;
    const failed = scored.filter((row) => !row.pass).sort((a, b) => a.similarity - b.similarity);
    const avgSimilarity =
      scored.reduce((sum, row) => sum + row.similarity, 0) / Math.max(1, scored.length);
    const avgElapsedMs =
      results.reduce((sum, row) => sum + row.elapsedMs, 0) / Math.max(1, results.length);

    const summary = {
      total: results.length,
      scored: scored.length,
      exact: exactCount,
      relaxedPass: passCount,
      exactRate: Number((exactCount / Math.max(1, scored.length)).toFixed(4)),
      relaxedPassRate: Number((passCount / Math.max(1, scored.length)).toFixed(4)),
      avgSimilarity: Number(avgSimilarity.toFixed(4)),
      avgElapsedMs: Number(avgElapsedMs.toFixed(1)),
      totalElapsedMs: totalMs,
    };

    const report = {
      generatedAt: nowIso(),
      datasetPath: args.dataset,
      workspacePath,
      summary,
      failures: failed.slice(0, 20),
      results,
    };

    await fs.mkdir(path.dirname(args.out), { recursive: true });
    await fs.writeFile(args.out, JSON.stringify(report, null, 2), "utf8");

    log(`summary exact=${exactCount}/${summary.scored} (${formatPct(summary.exactRate)})`);
    log(
      `summary relaxed=${passCount}/${summary.scored} (${formatPct(summary.relaxedPassRate)}), ` +
        `avg-sim=${summary.avgSimilarity.toFixed(3)}, avg-time=${summary.avgElapsedMs.toFixed(1)}ms`
    );
    log(`report: ${args.out}`);

    if (failed.length > 0) {
      log("top failures:");
      failed.slice(0, 8).forEach((row) => {
        log(
          `  ${row.id} (${row.style}) sim=${row.similarity.toFixed(3)} expected=${row.expected} actual=${row.actual || "<empty>"}`
        );
      });
    }
  } finally {
    if (electronApp) {
      await electronApp.close();
    }
    if (!args.keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true });
      log("workspace copy removed");
    } else {
      log(`workspace copy kept: ${tempDir}`);
    }
  }
};

run().catch((error) => {
  console.error("[math-ocr-bench] FAILED");
  console.error(error);
  process.exitCode = 1;
});
