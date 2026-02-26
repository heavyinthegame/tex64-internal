import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import {
  ALIAS_TRIGGERS,
  MANUAL_TRIGGERS,
} from "../../Resources/web/math/wysiwyg/math-wysiwyg-triggers-data.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

const sourceWorkspace = path.join(repoRoot, "test-workspace");
const keepWorkspace = process.env.E2E_KEEP_WORKSPACE === "1";
const verboseDebug = process.env.E2E_DEBUG === "1";
const commandFilterRaw = String(process.env.E2E_COMMAND_FILTER ?? "")
  .trim()
  .toLowerCase();
const commandOffset = Math.max(0, Number.parseInt(process.env.E2E_COMMAND_OFFSET ?? "0", 10) || 0);
const commandLimit = Math.max(0, Number.parseInt(process.env.E2E_COMMAND_LIMIT ?? "0", 10) || 0);
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "80", 10);
const typeDelayMs = Number.parseInt(process.env.E2E_TYPE_DELAY_MS ?? "12", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "0", 10);
const isMac = process.platform === "darwin";
const selectAllShortcut = isMac ? "Meta+A" : "Control+A";
const explicitSuggestShortcut = isMac ? "Meta+." : "Control+.";

const COMMAND_SOURCE_FILES = [
  path.join(repoRoot, "web-src/math/wysiwyg/math-wysiwyg-triggers-data.ts"),
  path.join(repoRoot, "web-src/math/wysiwyg/math-wysiwyg-candidates.ts"),
  path.join(repoRoot, "web-src/app/math-keyboard-data.ts"),
];

const EXCLUDED_COMMANDS = new Set([
  "left",
  "right",
  "begin",
  "end",
  "middle",
  "lbrace",
  "rbrace",
  "mathchoice",
  "unicode",
  "mathrm",
  "mathbf",
  "mathbb",
  "mathcal",
  "mathfrak",
  "mathit",
  "mathsf",
  "mathtt",
  "operatorname",
  "text",
  "bbox",
  "mbox",
  "color",
  "phantom",
  "overline",
  "underline",
  "hat",
  "tilde",
  "vec",
  "bar",
  "dot",
  "ddot",
  "widehat",
  "widetilde",
  // Personal pack defaults off: avoid false negatives in default settings.
  "boxed",
  "cancel",
  "bcancel",
  "xcancel",
  "boldsymbol",
  "bm",
  "overbrace",
  "underbrace",
]);

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[math-wysiwyg-command-audit ${now()}] ${message}`);
};

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const normalizeLatex = (value) => String(value ?? "").replace(/\s+/g, "");
const normalizeHint = (value) => String(value ?? "").trim().toLowerCase();
const normalizeSymbol = (value) =>
  String(value ?? "")
    .replace(/[\s\u200B\u2060]+/g, "")
    .trim();
const escapeRegExp = (value) => String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const cleanupStaleElectron = () => {
  try {
    execSync(
      `pkill -f "${path.join(
        repoRoot,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
      )}"`,
      { stdio: "ignore" }
    );
  } catch {
    // no stale process
  }
};

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-math-command-audit-"));
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
  await page.waitForSelector(`.sidebar-panel .panel.is-active[data-panel="${key}"]`, {
    timeout: 12000,
  });
  await pause(60);
};

const waitForMathFieldReady = async (page) => {
  await page.waitForFunction(
    () => {
      const field = document.getElementById("block-math-input");
      return Boolean(
        field &&
          field.tagName.toLowerCase() === "math-field" &&
          typeof field.getValue === "function" &&
          field.shadowRoot
      );
    },
    undefined,
    { timeout: 20000 }
  );
};

const focusMathField = async (page) => {
  const field = page.locator("#block-math-input");
  await field.waitFor({ state: "visible", timeout: 10000 });
  await field.click({ timeout: 4000 });
  await page.waitForFunction(() => {
    const active = document.activeElement;
    return active?.id === "block-math-input" || active?.closest?.("#block-math-input");
  });
  await pause(30);
};

const getMathFieldLatex = async (page) =>
  page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    if (!field || typeof field.getValue !== "function") return "";
    try {
      return String(field.getValue("latex") ?? "");
    } catch {
      return "";
    }
  });

const setMathFieldLatex = async (page, value) =>
  page.evaluate((nextValue) => {
    const field = document.getElementById("block-math-input");
    if (!field) return false;
    const latex = String(nextValue ?? "");
    try {
      if (typeof field.setValue === "function") {
        try {
          field.setValue(latex, { format: "latex" });
        } catch {
          field.setValue(latex);
        }
        return true;
      }
      if ("value" in field) {
        field.value = latex;
        field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  }, value);

const clearMathField = async (page) => {
  await focusMathField(page);
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press(selectAllShortcut);
    await page.keyboard.press("Backspace");
    await pause(30);
    const current = normalizeLatex(await getMathFieldLatex(page));
    if (!current) return;
  }
  const resetByApi = await setMathFieldLatex(page, "");
  if (resetByApi) {
    await pause(40);
    if (!normalizeLatex(await getMathFieldLatex(page))) {
      return;
    }
  }
  assert.equal(normalizeLatex(await getMathFieldLatex(page)), "", "failed to clear math-field");
};

const waitForSuggestions = async (page, expectedHint = "") => {
  const needle = String(expectedHint ?? "").trim().toLowerCase();
  await page.waitForFunction(
    (hint) => {
      const panel = document.querySelector(".math-wysiwyg-panel");
      if (!(panel instanceof HTMLElement)) return false;
      if (panel.getAttribute("aria-hidden") !== "false") return false;
      const items = Array.from(panel.querySelectorAll(".math-wysiwyg-item"));
      if (items.length === 0) return false;
      if (!hint) return true;
      return items.some((item) => {
        const label = (item.querySelector(".math-wysiwyg-label")?.textContent ?? "")
          .trim()
          .toLowerCase();
        return label === hint;
      });
    },
    needle,
    { timeout: 10000 }
  );
};

const waitForSuggestionsClosed = async (page, timeout = 5000) => {
  await page.waitForFunction(
    () => {
      const panel = document.querySelector(".math-wysiwyg-panel");
      if (!(panel instanceof HTMLElement)) return true;
      return panel.getAttribute("aria-hidden") !== "false";
    },
    undefined,
    { timeout }
  );
};

const getSuggestionItems = async (page) =>
  page.evaluate(() => {
    const panel = document.querySelector(".math-wysiwyg-panel");
    if (!(panel instanceof HTMLElement)) {
      return { visible: false, items: [] };
    }
    const visible = panel.getAttribute("aria-hidden") === "false";
    const items = Array.from(panel.querySelectorAll(".math-wysiwyg-item")).map((item) => ({
      hint: (item.querySelector(".math-wysiwyg-label")?.textContent ?? "").trim(),
      symbolText: (item.querySelector(".math-wysiwyg-symbol")?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim(),
      symbolHtml: (item.querySelector(".math-wysiwyg-symbol")?.innerHTML ?? "").trim(),
    }));
    return { visible, items };
  });

const getRenderSnapshot = async (page) =>
  page.evaluate(() => {
    const field = document.getElementById("block-math-input");
    if (!(field instanceof HTMLElement) || field.tagName.toLowerCase() !== "math-field") {
      return null;
    }
    const root = field.shadowRoot;
    if (!(root instanceof ShadowRoot)) {
      return null;
    }
    const visibleRoot = root.querySelector(".ML__latex") ?? root;
    return {
      rawText: (visibleRoot.textContent ?? "").replace(/\s+/g, " ").trim(),
      errorCount: root.querySelectorAll(".ML__error").length,
      placeholderCount: root.querySelectorAll(".ML__placeholder, .ML__prompt, .ML__editablePromptBox")
        .length,
    };
  });

const assertRenderHealthy = async (page, label, { allowPlaceholder = true } = {}) => {
  const snapshot = await getRenderSnapshot(page);
  assert.ok(snapshot, `${label}: render snapshot unavailable`);
  assert.equal(snapshot.errorCount, 0, `${label}: render has MathLive error node(s)`);
  if (!allowPlaceholder) {
    assert.equal(snapshot.placeholderCount, 0, `${label}: unresolved placeholder remains`);
  }
  assert.ok(!snapshot.rawText.includes("\\"), `${label}: raw LaTeX leaked in render (${snapshot.rawText})`);
};

const decodeQuotedLiteral = (raw) => {
  try {
    return JSON.parse(`"${raw.replace(/"/g, '\\"')}"`);
  } catch {
    return null;
  }
};

const extractCommandsFromLatex = (value) => {
  const result = [];
  const commandRe = /\\([A-Za-z]+\*?)/g;
  let commandMatch;
  while ((commandMatch = commandRe.exec(value))) {
    const raw = commandMatch[1] ?? "";
    if (!raw) continue;
    const normalized = raw.replace(/\*+$/, "").toLowerCase();
    if (!normalized || EXCLUDED_COMMANDS.has(normalized)) continue;
    result.push({ raw, normalized });
  }
  return result;
};

const buildManualCommandMetadata = () => {
  const map = new Map();
  for (const group of MANUAL_TRIGGERS) {
    const query = String(group?.trigger ?? "").trim().toLowerCase();
    if (!query) continue;
    const candidates = Array.isArray(group?.candidates) ? group.candidates : [];
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const candidate = candidates[candidateIndex];
      const latex = typeof candidate?.latex === "string" ? candidate.latex : "";
      const label = String(candidate?.label ?? "").trim();
      extractCommandsFromLatex(latex).forEach(({ normalized }) => {
        const meta = map.get(normalized) ?? {
          queries: new Set(),
          labels: new Set(),
          triggerIndices: new Map(),
        };
        meta.queries.add(query);
        if (label) {
          meta.labels.add(label);
        }
        const indices = meta.triggerIndices.get(query) ?? new Set();
        indices.add(candidateIndex);
        meta.triggerIndices.set(query, indices);
        map.set(normalized, meta);
      });
    }
  }
  return map;
};

const MANUAL_COMMAND_METADATA = buildManualCommandMetadata();
const ALIAS_TRIGGER_MAP = new Map(
  (Array.isArray(ALIAS_TRIGGERS) ? ALIAS_TRIGGERS : []).map((entry) => [
    String(entry?.alias ?? "").trim().toLowerCase(),
    String(entry?.canonical ?? "").trim().toLowerCase(),
  ])
);

const collectTeXCommandsForAudit = async () => {
  const map = new Map();
  const latexLiteralRe = /(?:latex|shiftLatex|fallback|shiftFallback)\s*:\s*"((?:\\.|[^"\\])*)"/g;
  for (const filePath of COMMAND_SOURCE_FILES) {
    const source = await fs.readFile(filePath, "utf8");
    let literalMatch;
    while ((literalMatch = latexLiteralRe.exec(source))) {
      const decoded = decodeQuotedLiteral(literalMatch[1] ?? "");
      if (!decoded) {
        continue;
      }
      extractCommandsFromLatex(decoded).forEach(({ raw, normalized }) => {
        const manualMeta = MANUAL_COMMAND_METADATA.get(normalized);
        const entry = map.get(normalized) ?? {
          query: normalized,
          raw: new Set(),
          queries: new Set(),
          labels: new Set(),
          preferredIndices: new Map(),
        };
        entry.raw.add(raw);
        if (manualMeta) {
          manualMeta.queries.forEach((query) => entry.queries.add(query));
          manualMeta.labels.forEach((label) => entry.labels.add(label));
          manualMeta.triggerIndices.forEach((indices, trigger) => {
            const current = entry.preferredIndices.get(trigger) ?? new Set();
            indices.forEach((value) => current.add(value));
            entry.preferredIndices.set(trigger, current);
          });
        }
        ALIAS_TRIGGER_MAP.forEach((canonical, alias) => {
          if (canonical && alias && entry.queries.has(canonical)) {
            entry.queries.add(alias);
          }
        });
        entry.queries.add(normalized);
        map.set(normalized, entry);
      });
    }
  }
  return Array.from(map.values())
    .sort((a, b) => a.query.localeCompare(b.query))
    .map((entry) => ({
      query: entry.query,
      raw: Array.from(entry.raw).sort(),
      labels: Array.from(entry.labels).sort(),
      preferredIndices: Object.fromEntries(
        Array.from(entry.preferredIndices.entries()).map(([trigger, indices]) => [
          trigger,
          Array.from(indices).sort((a, b) => a - b),
        ])
      ),
      queries: Array.from(entry.queries).sort((a, b) => {
        if (a === entry.query) return 1;
        if (b === entry.query) return -1;
        return a.localeCompare(b);
      }),
    }));
};

const findCandidateIndex = (items, query) => {
  const exact = items.findIndex((item) => normalizeHint(item.hint) === query);
  if (exact >= 0) return exact;
  const startsWith = items.findIndex((item) => normalizeHint(item.hint).startsWith(query));
  if (startsWith >= 0) return startsWith;
  return items.findIndex((item) => normalizeHint(item.hint).includes(query));
};

const findPreferredCandidateIndex = (items, query, entry) => {
  const preferred = entry.preferredIndices?.[query];
  const pickPreferred = () => {
    if (!Array.isArray(preferred)) return -1;
    for (const index of preferred) {
      if (Number.isInteger(index) && index >= 0 && index < items.length) {
        return index;
      }
    }
    return -1;
  };

  const exactHintIndices = items
    .map((item, index) => ({ index, hint: normalizeHint(item.hint) }))
    .filter((entryItem) => entryItem.hint === query)
    .map((entryItem) => entryItem.index);
  if (exactHintIndices.length === 1) {
    return exactHintIndices[0];
  }

  if (query !== entry.query) {
    const preferredIndex = pickPreferred();
    if (preferredIndex >= 0) return preferredIndex;
  }

  const pickByLabel = (targetIndices = null) => {
    if (!Array.isArray(entry.labels) || entry.labels.length === 0) return -1;
    const normalizedLabels = entry.labels
      .map((value) => normalizeSymbol(value))
      .filter((value) => value.length > 0);
    if (normalizedLabels.length === 0) return -1;
    const pool = Array.isArray(targetIndices)
      ? targetIndices.map((index) => ({
          index,
          symbol: normalizeSymbol(items[index]?.symbolText),
        }))
      : items.map((item, index) => ({
          index,
          symbol: normalizeSymbol(item.symbolText),
        }));
    const exactLabelMatches = pool
      .filter(
        ({ symbol }) =>
          symbol.length > 0 && normalizedLabels.some((label) => symbol === label)
      )
      .map(({ index }) => index);
    if (exactLabelMatches.length === 1) return exactLabelMatches[0];
    const fuzzyLabelMatches = pool
      .filter(
        ({ symbol }) =>
          symbol.length > 0 &&
          normalizedLabels.some(
            (label) => symbol === label || symbol.includes(label) || label.includes(symbol)
          )
      )
      .map(({ index }) => index);
    if (fuzzyLabelMatches.length === 1) return fuzzyLabelMatches[0];
    return -1;
  };

  if (exactHintIndices.length > 1) {
    const byLabelInExactHint = pickByLabel(exactHintIndices);
    if (byLabelInExactHint >= 0) return byLabelInExactHint;
  }

  const byHint = findCandidateIndex(items, query);
  if (byHint >= 0) return byHint;

  const preferredIndex = pickPreferred();
  if (preferredIndex >= 0) return preferredIndex;

  const byLabel = pickByLabel();
  if (byLabel >= 0) return byLabel;

  return 0;
};

const buildCandidateTryOrder = (items, query, entry) => {
  const order = [];
  const push = (index) => {
    if (!Number.isInteger(index) || index < 0 || index >= items.length) return;
    if (!order.includes(index)) order.push(index);
  };

  push(findPreferredCandidateIndex(items, query, entry));
  items.forEach((item, index) => {
    if (normalizeHint(item.hint) === query) push(index);
  });
  items.forEach((item, index) => {
    if (normalizeHint(item.hint).startsWith(query)) push(index);
  });
  items.forEach((item, index) => {
    if (normalizeHint(item.hint).includes(query)) push(index);
  });
  for (let index = 0; index < Math.min(items.length, 10); index += 1) {
    push(index);
  }
  return order;
};

const latexContainsEntryCommand = (latex, entry) => {
  const normalizedLatex = String(latex ?? "").toLowerCase();
  return entry.raw.some((raw) => {
    const rawToken = String(raw ?? "").trim().toLowerCase();
    const normalizedToken = rawToken.replace(/\*+$/, "");
    if (!normalizedToken) return false;
    const normalizedRe = new RegExp(`\\\\${escapeRegExp(normalizedToken)}(?![a-z])`);
    if (normalizedRe.test(normalizedLatex)) return true;
    if (rawToken && rawToken !== normalizedToken) {
      const rawRe = new RegExp(`\\\\${escapeRegExp(rawToken)}(?![a-z])`);
      if (rawRe.test(normalizedLatex)) return true;
    }
    return false;
  });
};

const moveToCandidateIndex = async (page, index) => {
  for (let i = 0; i < index; i += 1) {
    await page.keyboard.press("ArrowDown");
    await pause(10);
  }
};

const startQueryInput = async (page) => {
  await focusMathField(page);
  // Replace any previous structure in one shot to avoid carrying context across commands.
  await page.keyboard.press(selectAllShortcut);
  await pause(10);
  await page.keyboard.press("Backslash");
};

const auditSingleCommand = async (page, entry, index, total) => {
  const label = `command ${index + 1}/${total} ${entry.query}`;
  let usedQuery = null;
  let panel = null;
  let candidateIndex = -1;
  let finalLatex = "";

  for (const query of entry.queries) {
    /** @type {number[]} */
    let tryOrder = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await startQueryInput(page);
      try {
        await waitForSuggestions(page);
      } catch {
        await page.keyboard.press(explicitSuggestShortcut);
        await waitForSuggestions(page);
      }

      await page.keyboard.type(query, { delay: typeDelayMs });
      try {
        await waitForSuggestions(page);
      } catch {
        await page.keyboard.press(explicitSuggestShortcut);
        try {
          await waitForSuggestions(page);
        } catch {
          await page.keyboard.press("Escape");
          await waitForSuggestionsClosed(page, 800).catch(() => {});
          break;
        }
      }

      const nextPanel = await getSuggestionItems(page);
      if (!nextPanel.visible || nextPanel.items.length === 0) {
        await page.keyboard.press("Escape");
        await waitForSuggestionsClosed(page, 800).catch(() => {});
        break;
      }

      if (attempt === 0) {
        tryOrder = buildCandidateTryOrder(nextPanel.items, query, entry);
      }
      if (attempt >= tryOrder.length) {
        await page.keyboard.press("Escape");
        await waitForSuggestionsClosed(page, 800).catch(() => {});
        break;
      }

      const nextIndex = tryOrder[attempt];
      const candidate = nextPanel.items[nextIndex];
      const rendered =
        (candidate.symbolHtml.length > 0 && !candidate.symbolHtml.includes("\\")) ||
        (candidate.symbolText.length > 0 && !candidate.symbolText.includes("\\"));
      if (!rendered) {
        await page.keyboard.press("Escape");
        await waitForSuggestionsClosed(page, 800).catch(() => {});
        continue;
      }

      await moveToCandidateIndex(page, nextIndex);
      await page.keyboard.press("Enter");
      await waitForSuggestionsClosed(page, 5000);
      await pause(20);

      const latex = normalizeLatex(await getMathFieldLatex(page));
      if (!latex || !latexContainsEntryCommand(latex, entry)) {
        if (verboseDebug) {
          log(
            `[debug] ${label} query=${query} candidate=${JSON.stringify(
              candidate
            )} latex=${JSON.stringify(latex)} panel=${JSON.stringify(
              nextPanel.items.map((item) => ({ hint: item.hint, symbolText: item.symbolText }))
            )}`
          );
        }
        continue;
      }

      await assertRenderHealthy(page, `${label} via ${query}`, { allowPlaceholder: true });
      usedQuery = query;
      panel = nextPanel;
      candidateIndex = nextIndex;
      finalLatex = latex;
      break;
    }
    if (usedQuery) {
      break;
    }
  }

  assert.ok(
    usedQuery,
    `${label}: no suggestion query produced target command (${entry.queries.join(", ")})`
  );
  assert.ok(panel?.visible, `${label}: suggestion panel not visible`);
  assert.ok((panel?.items?.length ?? 0) > 0, `${label}: suggestion list is empty`);
  assert.ok(candidateIndex >= 0, `${label}: candidate index resolution failed`);
  assert.ok(finalLatex.includes("\\"), `${label}: insertion did not produce command-like latex (${finalLatex})`);
};

const run = async () => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const userDataPath = path.join(tempDir, "user-data");
  /** @type {import('playwright').ElectronApplication | undefined} */
  let electronApp;

  try {
    await fs.mkdir(userDataPath, { recursive: true });
    cleanupStaleElectron();

    const allCommands = await collectTeXCommandsForAudit();
    const filteredCommands = commandFilterRaw
      ? allCommands.filter(
          (entry) =>
            entry.query.includes(commandFilterRaw) ||
            entry.raw.some((raw) => raw.toLowerCase().includes(commandFilterRaw))
        )
      : allCommands;
    const commands =
      commandLimit > 0
        ? filteredCommands.slice(commandOffset, commandOffset + commandLimit)
        : filteredCommands.slice(commandOffset);
    assert.ok(commands.length > 0, "no TeX commands collected");
    log(`collected ${commands.length} TeX commands for audit`);

    electronApp = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      slowMo: Number.isFinite(slowMoMs) ? Math.max(0, slowMoMs) : 0,
      env: {
        ...process.env,
        TEX64_E2E: "1",
        TEX64_E2E_HEADLESS: "1",
        TEX64_E2E_USERDATA: userDataPath,
      },
    });

    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1600, height: 980 });

    const resetAuditContext = async () => {
      await postToBridge(page, { type: "openRecentProject", path: workspacePath });
      await waitForWorkspaceReady(page);
      await page.waitForFunction(() => Boolean(window.MathLive?.convertLatexToMarkup), undefined, {
        timeout: 20000,
      });
      await openSideTab(page, "blocks");
      await waitForMathFieldReady(page);
      try {
        await clearMathField(page);
      } catch {
        await setMathFieldLatex(page, "");
      }
    };

    await resetAuditContext();

    for (let i = 0; i < commands.length; i += 1) {
      const entry = commands[i];
      let commandError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (attempt > 0) {
          log(`retrying command ${entry.query} after context reset`);
          await resetAuditContext();
        }
        try {
          await auditSingleCommand(page, entry, i, commands.length);
          commandError = null;
          break;
        } catch (error) {
          commandError = error;
        }
      }
      if (commandError) {
        throw new Error(
          `failed at command ${entry.query} (${i + 1}/${commands.length}): ${String(commandError)}`
        );
      }
      if ((i + 1) % 20 === 0 || i + 1 === commands.length) {
        log(`audited ${i + 1}/${commands.length} commands`);
      }
    }

    log("math-wysiwyg command audit passed");
  } finally {
    if (electronApp) {
      try {
        await electronApp.close();
      } catch {
        try {
          electronApp.process()?.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    cleanupStaleElectron();
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
};

run().catch((error) => {
  console.error("[math-wysiwyg-command-audit] FAILED");
  console.error(error);
  process.exitCode = 1;
});
