import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

const sourceWorkspace = path.join(repoRoot, "test-workspace");
const keepWorkspace = process.env.E2E_KEEP_WORKSPACE === "1";
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "260", 10);
const typeDelayMs = Number.parseInt(process.env.E2E_TYPE_DELAY_MS ?? "40", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "70", 10);

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[input-assist-e2e ${now()}] ${message}`);
};

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-"));
  const workspacePath = path.join(tempDir, "workspace");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  return { tempDir, workspacePath };
};

const createMockAiProxy = async () => {
  const requests = [];
  const extractPrefixFromPrompt = (prompt) => {
    const lines = String(prompt ?? "").split("\n");
    const cursorLine = lines[lines.length - 1] ?? "";
    return cursorLine.replace("<CURSOR>", "");
  };
  const continuationForPrefix = (prefix) => {
    if (prefix.includes("EMPTY_NEGATIVE_CASE")) {
      return "";
    }
    if (prefix.includes("We compare the proposed method with a strong baseline")) {
      return " and report robust improvements.";
    }
    if (prefix.includes("Cooldown retry should eventually request again")) {
      return " with stable behavior after waiting.";
    }
    return " and remains consistent across runs.";
  };

  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        body = {};
      }
      const prompt = body?.contents?.[0]?.parts?.[0]?.text ?? "";
      const prefix = extractPrefixFromPrompt(prompt);
      requests.push({ prefix, prompt, at: Date.now() });
      const text = continuationForPrefix(prefix);
      const payload = {
        candidates: [{ content: { parts: [{ text }] } }],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: text.length > 0 ? 7 : 0, totalTokenCount: 18 },
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  if (!port) {
    throw new Error("failed to start mock ai proxy");
  }
  const proxyUrl = `http://127.0.0.1:${port}/ai`;

  return {
    proxyUrl,
    requests,
    countByPrefix: (needle) => requests.filter((entry) => entry.prefix.includes(needle)).length,
    countTotal: () => requests.length,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
    },
  };
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
  await pause(150);
};

const moveCursorToEnd = async (page) => {
  await page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    const model = active?.getModel?.();
    if (!active || !model) {
      return;
    }
    const lineNumber = model.getLineCount();
    const column = model.getLineMaxColumn(lineNumber);
    active.setPosition({ lineNumber, column });
    active.revealPositionInCenterIfOutsideViewport?.({ lineNumber, column });
    active.focus();
  });
  await pause(100);
};

const triggerSuggest = async (page) => {
  await page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    if (active?.focus) {
      active.focus();
    }
    if (active?.trigger) {
      active.trigger("input-assist-e2e", "editor.action.triggerSuggest", {});
    }
  });
};

const typeScenarioPrefix = async (page, prefix) => {
  await moveCursorToEnd(page);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await page.keyboard.type(prefix, { delay: typeDelayMs });
  await triggerSuggest(page);
  await pause();
};

const getVisibleSuggestions = async (page) => {
  try {
    await page.waitForFunction(
      () => {
        const widget = document.querySelector(".suggest-widget.visible");
        if (!widget) {
          return false;
        }
        return widget.querySelectorAll(".monaco-list-row").length > 0;
      },
      undefined,
      { timeout: 5000 }
    );
  } catch {
    await triggerSuggest(page);
    await page.waitForFunction(
      () => {
        const widget = document.querySelector(".suggest-widget.visible");
        if (!widget) {
          return false;
        }
        return widget.querySelectorAll(".monaco-list-row").length > 0;
      },
      undefined,
      { timeout: 10000 }
    );
  }

  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".suggest-widget.visible .monaco-list-row"))
      .map((row) => row.textContent?.replace(/\s+/g, " ").trim() ?? "")
      .filter(Boolean)
  );
};

const assertSuggestionsIncludeAll = async (page, expected, testName, options = {}) => {
  const suggestions = await getVisibleSuggestions(page);
  expected.forEach((needle) => {
    const hit = suggestions.some((item) => item.includes(needle));
    assert.ok(
      hit,
      `${testName}: expected suggestion "${needle}" not found.\nSuggestions:\n${suggestions.join("\n")}`
    );
  });
  log(`${testName}: suggestions include ${expected.join(", ")}`);
  if (options.closeWidget !== false) {
    await page.keyboard.press("Escape");
    await pause();
  }
};

const focusSuggestionByContains = async (page, needle) => {
  const selected = await page.evaluate((text) => {
    const rows = Array.from(document.querySelectorAll(".suggest-widget.visible .monaco-list-row"));
    const row = rows.find((entry) => (entry.textContent ?? "").includes(text));
    if (!row) {
      return false;
    }
    row.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  }, needle);
  assert.ok(selected, `could not focus suggestion containing "${needle}"`);
  await pause(120);
};

const getFocusedSuggestionIndex = async (page) =>
  page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".suggest-widget.visible .monaco-list-row"));
    return rows.findIndex(
      (row) => row.classList.contains("focused") || row.getAttribute("aria-selected") === "true"
    );
  });

const getEditorState = async (page) =>
  page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    const model = active?.getModel?.();
    const position = active?.getPosition?.();
    const lineNumber = position?.lineNumber ?? 1;
    const lineContent = model?.getLineContent?.(lineNumber) ?? "";
    return {
      lineNumber,
      column: position?.column ?? 1,
      lineContent,
      value: model?.getValue?.() ?? "",
    };
  });

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
    active.executeEdits("input-assist-e2e", [
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

  assert.ok(lineNumber > 0, `appendLineViaModel: failed to append line "${text}"`);
  await pause(120);
  return { lineNumber, text };
};

const setCursorOnLineSubstring = async (page, lineNumber, lineText, needle, occurrence = 1) => {
  let fromIndex = 0;
  let foundIndex = -1;
  for (let i = 0; i < occurrence; i += 1) {
    foundIndex = lineText.indexOf(needle, fromIndex);
    if (foundIndex < 0) {
      break;
    }
    fromIndex = foundIndex + needle.length;
  }
  assert.ok(foundIndex >= 0, `substring "${needle}" not found in line: ${lineText}`);
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
  await pause(120);
};

const triggerShowHover = async (page) => {
  const anchor = await page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    const position = active?.getPosition?.();
    if (position && active?.revealPositionInCenterIfOutsideViewport) {
      active.revealPositionInCenterIfOutsideViewport(position);
    }
    active?.trigger?.("input-assist-e2e", "editor.action.showHover", {});
    const domNode = active?.getDomNode?.();
    const visible = position ? active?.getScrolledVisiblePosition?.(position) : null;
    if (!domNode || !visible) {
      return null;
    }
    const rect = domNode.getBoundingClientRect();
    const x = rect.left + visible.left + Math.max(6, Math.floor((visible.width || 12) / 2));
    const y = rect.top + visible.top + Math.max(6, Math.floor((visible.height || 18) / 2));
    return { x, y };
  });
  if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
    await page.mouse.move(anchor.x, anchor.y);
    await pause(140);
  }
};

const hideHover = async (page) => {
  await page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    active?.trigger?.("input-assist-e2e", "editor.action.hideHover", {});
  });
  await pause(100);
};

const getHoverSnapshot = async (page) =>
  page.evaluate(() => {
    const hover = document.querySelector(".monaco-hover");
    if (!hover) {
      return null;
    }
    const style = window.getComputedStyle(hover);
    const rect = hover.getBoundingClientRect();
    const visible = style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
    if (!visible) {
      return null;
    }
    const text = hover.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const links = Array.from(hover.querySelectorAll("a[href], [data-tex64-href]"))
      .map((entry) => entry.getAttribute("data-tex64-href") ?? entry.getAttribute("href") ?? "")
      .filter(Boolean);
    const hasImagePreview = Boolean(hover.querySelector('img[src^="data:image"]'));
    return { text, links, hasImagePreview, html: hover.innerHTML };
  });

const getAnyHoverSnapshot = async (page) =>
  page.evaluate(() => {
    const hover = document.querySelector(".monaco-hover");
    if (!hover) {
      return null;
    }
    const text = hover.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (!text) {
      return null;
    }
    const links = Array.from(hover.querySelectorAll("a[href], [data-tex64-href]"))
      .map((entry) => entry.getAttribute("data-tex64-href") ?? entry.getAttribute("href") ?? "")
      .filter(Boolean);
    const hasImagePreview = Boolean(hover.querySelector('img[src^="data:image"]'));
    return { text, links, hasImagePreview, html: hover.innerHTML };
  });

const assertHoverVisible = async (page, testName, options = {}) => {
  const timeout = options.timeout ?? 5000;
  const startedAt = Date.now();
  let snapshot = null;
  while (!snapshot && Date.now() - startedAt < timeout) {
    snapshot = await getHoverSnapshot(page);
    if (!snapshot) {
      await pause(80);
    }
  }
  if (!snapshot) {
    snapshot = await getAnyHoverSnapshot(page);
  }
  if (!snapshot) {
    const debug = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[class*="hover"]'))
        .slice(0, 24)
        .map((node) => {
          const el = node;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            className: el.className,
            display: style.display,
            visibility: style.visibility,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 140),
          };
        })
    );
    assert.fail(`${testName}: hover did not appear.\nDebug:\n${JSON.stringify(debug, null, 2)}`);
  }
  return snapshot;
};

const assertNoHoverVisible = async (page, testName) => {
  await pause(500);
  const snapshot = await getHoverSnapshot(page);
  assert.equal(snapshot, null, `${testName}: expected no hover, but hover is visible`);
};

const triggerInlineSuggest = async (page) => {
  await page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    active?.trigger?.("input-assist-e2e", "editor.action.inlineSuggest.trigger", {});
  });
};

const commitInlineSuggest = async (page) => {
  await page.evaluate(() => {
    const editors = window.monaco?.editor?.getEditors?.() ?? [];
    const active =
      editors.find((editor) => typeof editor.hasTextFocus === "function" && editor.hasTextFocus()) ??
      editors[0];
    active?.trigger?.("input-assist-e2e", "editor.action.inlineSuggest.commit", {});
  });
};

const openWorkspaceFile = async (page, filePath) => {
  await postToBridge(page, { type: "openFile", path: filePath });
  await page.waitForSelector(`#editor-tabs-list .editor-tab.is-active[data-path="${filePath}"]`, {
    timeout: 15000,
  });
  await focusEditor(page);
};

const saveCurrentFile = async (page) => {
  const shortcut = process.platform === "darwin" ? "Meta+S" : "Control+S";
  await page.keyboard.press(shortcut);
  await pause(900);
};

const runCompletionChecks = async (page) => {
  log("Completion checks start");

  const refLikeCommands = ["\\ref{sec:", "\\eqref{eq:", "\\pageref{sec:", "\\autoref{sec:"];
  for (const command of refLikeCommands) {
    const expected = command.includes("{eq:") ? ["eq:newton", "eq:align", "eq:eqbox"] : ["sec:methods"];
    await typeScenarioPrefix(page, command);
    await assertSuggestionsIncludeAll(page, expected, `completion ${command}`);
  }

  const crefFamily = ["\\cref{sec:", "\\Cref{sec:", "\\namecref{sec:"];
  for (const command of crefFamily) {
    await typeScenarioPrefix(page, command);
    await assertSuggestionsIncludeAll(page, ["sec:methods"], `completion ${command}`);
  }

  await typeScenarioPrefix(page, "\\cite{la");
  await assertSuggestionsIncludeAll(page, ["lamport1994"], "completion \\cite");

  const citeVariants = ["\\citet{la", "\\citep{la", "\\autocite{la", "\\parencite{la"];
  for (const command of citeVariants) {
    await typeScenarioPrefix(page, command);
    await assertSuggestionsIncludeAll(page, ["lamport1994"], `completion ${command}`);
  }

  await typeScenarioPrefix(page, "\\cite[see]{la");
  await assertSuggestionsIncludeAll(page, ["lamport1994"], "completion optional cite");

  await typeScenarioPrefix(page, "\\cite{knuth1984,la");
  await assertSuggestionsIncludeAll(page, ["lamport1994"], "completion cite second key");

  await typeScenarioPrefix(page, "\\input{sections/me");
  await assertSuggestionsIncludeAll(page, ["sections/methods"], "completion input path");

  await typeScenarioPrefix(page, "\\include{sections/re");
  await assertSuggestionsIncludeAll(page, ["sections/results"], "completion include path");

  await typeScenarioPrefix(page, "\\input{sections/methods.t");
  await assertSuggestionsIncludeAll(page, ["sections/methods.tex"], "completion explicit extension");

  await typeScenarioPrefix(page, "\\includegraphics{figures/sample-");
  await assertSuggestionsIncludeAll(
    page,
    ["figures/sample-image.png", "figures/sample-vector.svg"],
    "completion includegraphics image candidates"
  );

  await typeScenarioPrefix(page, "\\includegraphics{assets/pdfs/sa");
  await assertSuggestionsIncludeAll(
    page,
    ["assets/pdfs/sample.pdf"],
    "completion includegraphics pdf candidate"
  );

  const beginCases = [
    { prefix: "\\begin{fig", env: "figure" },
    { prefix: "\\begin{tab", env: "table" },
    { prefix: "\\begin{ali", env: "align" },
    { prefix: "\\begin{ite", env: "itemize" },
  ];
  for (const entry of beginCases) {
    await typeScenarioPrefix(page, entry.prefix);
    await assertSuggestionsIncludeAll(page, [entry.env], `completion begin ${entry.env}`, {
      closeWidget: false,
    });
    await focusSuggestionByContains(page, entry.env);
    await page.keyboard.press("Enter");
    await pause();
    const state = await getEditorState(page);
    assert.ok(
      state.value.includes(`\\begin{${entry.env}}`) && state.value.includes(`\\end{${entry.env}}`),
      `completion begin ${entry.env}: expected snippet to be expanded`
    );
  }

  await typeScenarioPrefix(page, "\\ref{sec:");
  await assertSuggestionsIncludeAll(page, ["sec:methods"], "completion tab navigation", {
    closeWidget: false,
  });
  const focusedBefore = await getFocusedSuggestionIndex(page);
  await page.keyboard.press("Tab");
  await pause();
  const focusedAfterTab = await getFocusedSuggestionIndex(page);
  assert.ok(
    focusedBefore >= 0 && focusedAfterTab >= 0 && focusedAfterTab !== focusedBefore,
    `completion tab navigation: expected focus move. before=${focusedBefore}, after=${focusedAfterTab}`
  );
  await page.keyboard.press("Shift+Tab");
  await pause();
  const focusedAfterShiftTab = await getFocusedSuggestionIndex(page);
  assert.ok(
    focusedAfterShiftTab >= 0 && focusedAfterShiftTab !== focusedAfterTab,
    `completion shift+tab navigation: expected focus move. afterTab=${focusedAfterTab}, afterShiftTab=${focusedAfterShiftTab}`
  );
  await page.keyboard.press("Enter");
  await pause();
  const lineAfterAccept = (await getEditorState(page)).lineContent;
  assert.ok(
    /\\ref\{sec:[^}\s]+/.test(lineAfterAccept),
    `completion enter accept: expected selected item insertion.\nLine: ${lineAfterAccept}`
  );

  log("Completion checks passed");
};

const runHoverChecks = async (page) => {
  log("Hover checks start");

  const hoverLines = [];
  const addHoverLine = async (text) => {
    const inserted = await appendLineViaModel(page, text);
    hoverLines.push(inserted);
    return inserted;
  };

  const h01 = await addHoverLine("Section~\\ref{sec:methods}");
  await setCursorOnLineSubstring(page, h01.lineNumber, h01.text, "sec:methods");
  await hideHover(page);
  await triggerShowHover(page);
  const hoverH01 = await assertHoverVisible(page, "H-01");
  assert.ok(
    hoverH01.text.includes("sec:methods") &&
      hoverH01.text.includes("sections/methods.tex"),
    "H-01: expected ref definition details"
  );
  assert.ok(
    hoverH01.links.some((href) => href.startsWith("tex64://view-on-pdf")) ||
      hoverH01.text.includes("View on PDF"),
    "H-01: expected View on PDF entry"
  );
  await hideHover(page);

  const h02 = await addHoverLine("\\ref{sec:not-found}");
  await setCursorOnLineSubstring(page, h02.lineNumber, h02.text, "sec:not-found");
  await triggerShowHover(page);
  const hoverH02 = await assertHoverVisible(page, "H-02");
  assert.ok(hoverH02.text.includes("未解決"), "H-02: expected unresolved text");
  await hideHover(page);

  const h03 = await addHoverLine("\\cite{lamport1994}");
  await setCursorOnLineSubstring(page, h03.lineNumber, h03.text, "lamport1994");
  await triggerShowHover(page);
  const hoverH03 = await assertHoverVisible(page, "H-03");
  assert.ok(
    hoverH03.text.includes("Title") && hoverH03.text.includes("Author") && hoverH03.text.includes("Year"),
    "H-03: expected bib summary fields"
  );
  await hideHover(page);

  const h04 = await addHoverLine("\\cite[see]{knuth1984,lamport1994}");
  await setCursorOnLineSubstring(page, h04.lineNumber, h04.text, "knuth1984");
  await triggerShowHover(page);
  const hoverH04a = await assertHoverVisible(page, "H-04 key1");
  assert.ok(hoverH04a.text.includes("The TeXbook"), "H-04 key1: expected knuth title");
  await hideHover(page);
  await setCursorOnLineSubstring(page, h04.lineNumber, h04.text, "lamport1994");
  await triggerShowHover(page);
  const hoverH04b = await assertHoverVisible(page, "H-04 key2");
  assert.ok(
    hoverH04b.text.includes("LaTeX: A Document Preparation System"),
    "H-04 key2: expected lamport title"
  );
  await hideHover(page);

  const h05 = await addHoverLine("\\cite{unknown2026}");
  await setCursorOnLineSubstring(page, h05.lineNumber, h05.text, "unknown2026");
  await triggerShowHover(page);
  const hoverH05 = await assertHoverVisible(page, "H-05");
  assert.ok(hoverH05.text.includes("未解決"), "H-05: expected unresolved cite");
  await hideHover(page);

  const h06 = await addHoverLine("\\includegraphics{figures/sample-image.png}");
  await setCursorOnLineSubstring(page, h06.lineNumber, h06.text, "sample-image.png");
  await triggerShowHover(page);
  const hoverH06 = await assertHoverVisible(page, "H-06");
  assert.ok(hoverH06.hasImagePreview, "H-06: expected image preview");
  await hideHover(page);

  const h07 = await addHoverLine("\\includegraphics{figures/not-found}");
  await setCursorOnLineSubstring(page, h07.lineNumber, h07.text, "not-found");
  await triggerShowHover(page);
  const hoverH07 = await assertHoverVisible(page, "H-07");
  assert.ok(hoverH07.text.includes("見つかりません"), "H-07: expected not-found message");
  await hideHover(page);

  const h08 = await addHoverLine("$E=mc^2$");
  await setCursorOnLineSubstring(page, h08.lineNumber, h08.text, "E=mc^2");
  await triggerShowHover(page);
  const hoverH08 = await assertHoverVisible(page, "H-08");
  assert.ok(hoverH08.text.includes("Math Preview"), "H-08: expected math preview");
  await hideHover(page);

  const h09 = await addHoverLine("\\(\\int_0^1 x^2 dx\\)");
  await setCursorOnLineSubstring(page, h09.lineNumber, h09.text, "\\int_0^1 x^2 dx");
  await triggerShowHover(page);
  const hoverH09 = await assertHoverVisible(page, "H-09");
  assert.ok(hoverH09.text.includes("Math Preview"), "H-09: expected math preview");
  await hideHover(page);

  const h10 = await addHoverLine("\\[\\sum_{k=1}^n k\\]");
  await setCursorOnLineSubstring(page, h10.lineNumber, h10.text, "\\sum_{k=1}^n k");
  await triggerShowHover(page);
  const hoverH10 = await assertHoverVisible(page, "H-10");
  assert.ok(hoverH10.text.includes("Math Preview"), "H-10: expected math preview");
  await hideHover(page);

  const h11 = await addHoverLine("$a+b$ % $c+d$");
  await setCursorOnLineSubstring(page, h11.lineNumber, h11.text, "a+b");
  await triggerShowHover(page);
  const hoverH11a = await assertHoverVisible(page, "H-11 front");
  assert.ok(hoverH11a.text.includes("Math Preview"), "H-11 front: expected math preview");
  await hideHover(page);
  await setCursorOnLineSubstring(page, h11.lineNumber, h11.text, "c+d");
  await triggerShowHover(page);
  await assertNoHoverVisible(page, "H-11 comment side");

  log("Hover checks passed");
};

const runGhostLocalChecks = async (page) => {
  log("Ghost local checks start");

  const triggerAndCommitInlineUntilChanged = async (
    beforeLine,
    options = { attempts: 4, triggerWaitMs: 160 }
  ) => {
    let current = await getEditorState(page);
    for (let i = 0; i < options.attempts; i += 1) {
      await triggerInlineSuggest(page);
      await pause(options.triggerWaitMs);
      await commitInlineSuggest(page);
      await pause(options.triggerWaitMs);
      current = await getEditorState(page);
      if (current.lineContent !== beforeLine) {
        break;
      }
    }
    return current;
  };

  const runCase = async (label, input, expected, options = {}) => {
    log(`${label}: start`);
    await moveCursorToEnd(page);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    await page.keyboard.type(input, { delay: typeDelayMs });
    if (typeof options.cursorDelta === "number" && options.cursorDelta > 0) {
      for (let i = 0; i < options.cursorDelta; i += 1) {
        await page.keyboard.press("ArrowLeft");
      }
    }
    await page.keyboard.press("Escape");
    await pause(80);
    const before = await getEditorState(page);
    await pause(620);
    const after = await triggerAndCommitInlineUntilChanged(before.lineContent);
    if (options.expectNoChange) {
      assert.equal(after.lineContent, before.lineContent, `${label}: expected no inline insertion`);
      log(`${label}: no-change ok`);
      return;
    }
    assert.equal(after.lineContent, expected, `${label}: unexpected inline insertion`);
    log(`${label}: inserted "${after.lineContent}"`);
  };

  await runCase("G-01", "\\sec", "\\section{}");
  await runCase("G-02", "\\textb", "\\textbf{}");
  await runCase("G-03", "\\cite{lamport1994", "\\cite{lamport1994}");
  await runCase("G-04", "\\begin{ite", "\\begin{itemize}");

  log("G-05: start");
  await moveCursorToEnd(page);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await page.keyboard.type("\\begin{align}", { delay: typeDelayMs });
  await page.keyboard.press("Escape");
  await pause(80);
  const beforeBlock = await getEditorState(page);
  await pause(620);
  const afterBlock = await triggerAndCommitInlineUntilChanged(beforeBlock.lineContent);
  assert.ok(
    afterBlock.value.includes("\\begin{align}\n\\end{align}"),
    `G-05: expected begin/end pair insertion.\nBefore line: ${beforeBlock.lineContent}`
  );
  log("G-05: inserted align end");

  await runCase("G-06", "% \\sec", "% \\sec", { expectNoChange: true });
  await runCase("G-07", "\\secabc", "\\secabc", { cursorDelta: 3, expectNoChange: true });

  log("Ghost local checks passed");
};

const runGhostRemoteChecks = async (page, mockProxy) => {
  log("Ghost remote checks start");

  const remoteCase = async (label, input, options = {}) => {
    log(`${label}: start`);
    await moveCursorToEnd(page);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    await page.keyboard.type(input, { delay: 0 });
    const before = await getEditorState(page);
    if (options.waitMs) {
      await pause(options.waitMs);
    }
    const beforeCount = mockProxy.countByPrefix(input);
    const beforeTotal = mockProxy.countTotal();
    await triggerInlineSuggest(page);
    await pause(140);
    await commitInlineSuggest(page);
    await pause(200);
    const after = await getEditorState(page);
    const afterCount = mockProxy.countByPrefix(input);
    const afterTotal = mockProxy.countTotal();
    log(
      `${label}: before="${before.lineContent}" after="${after.lineContent}" requests=${beforeTotal}->${afterTotal}`
    );
    return { before, after, beforeCount, afterCount, beforeTotal, afterTotal };
  };

  const r01Input = "We compare the proposed method with a strong baseline";
  const r01 = await remoteCase("R-01", r01Input, { waitMs: 700 });
  assert.ok(
    r01.after.lineContent.includes("and report robust improvements."),
    `R-01: expected remote continuation insertion.\nLine: ${r01.after.lineContent}`
  );
  assert.equal(r01.afterCount, r01.beforeCount + 1, "R-01: expected one proxy request");
  log("R-01: ok");

  const r02 = await remoteCase("R-02", "short", { waitMs: 200 });
  assert.equal(r02.after.lineContent, r02.before.lineContent, "R-02: prefix<10 should not insert");
  assert.equal(r02.afterTotal, r02.beforeTotal, "R-02: prefix<10 should not call proxy");
  log("R-02: ok");

  const r03Input = "Ablation studies confirm stability under distribution shift";
  const r03 = await remoteCase("R-03", r03Input, { waitMs: 650 });
  assert.equal(r03.after.lineContent, r03.before.lineContent, "R-03: cooldown should block insertion");
  assert.equal(r03.afterTotal, r03.beforeTotal, "R-03: cooldown should block proxy call");
  log("R-03: ok");

  await pause(3200);
  const r04Input = "Cooldown retry should eventually request again";
  const r04 = await remoteCase("R-04", r04Input, { waitMs: 700 });
  assert.ok(
    r04.after.lineContent.includes("with stable behavior after waiting."),
    `R-04: expected remote continuation after cooldown.\nLine: ${r04.after.lineContent}`
  );
  assert.equal(r04.afterCount, r04.beforeCount + 1, "R-04: expected one proxy request");
  log("R-04: ok");

  await pause(3200);
  const r05Input = "EMPTY_NEGATIVE_CASE should cache empty response";
  const r05a = await remoteCase("R-05 first", r05Input, { waitMs: 700 });
  assert.equal(r05a.after.lineContent, r05a.before.lineContent, "R-05 first: empty response should not insert");
  assert.equal(r05a.afterCount, r05a.beforeCount + 1, "R-05 first: expected proxy request");
  log("R-05 first: ok");

  const beforeSecond = await getEditorState(page);
  const beforeSecondCount = mockProxy.countByPrefix(r05Input);
  await triggerInlineSuggest(page);
  await pause(120);
  await commitInlineSuggest(page);
  await pause(160);
  const afterSecond = await getEditorState(page);
  const afterSecondCount = mockProxy.countByPrefix(r05Input);
  assert.equal(
    afterSecond.lineContent,
    beforeSecond.lineContent,
    "R-05 second: negative cache should suppress insertion"
  );
  assert.equal(
    afterSecondCount,
    beforeSecondCount,
    "R-05 second: negative cache should suppress repeated proxy request"
  );
  log("R-05 second: ok");

  log("Ghost remote checks passed");
};

const runRelativePathCheck = async (page) => {
  log("Relative path completion check start");
  await openWorkspaceFile(page, "sections/intro.tex");
  await typeScenarioPrefix(page, "\\includegraphics{../figures/sample-");
  await assertSuggestionsIncludeAll(
    page,
    ["../figures/sample-image.png"],
    "relative includegraphics completion",
    { closeWidget: false }
  );
  await focusSuggestionByContains(page, "../figures/sample-image.png");
  await page.keyboard.press("Enter");
  await pause();
  const state = await getEditorState(page);
  assert.ok(
    state.value.includes("\\includegraphics{../figures/sample-image.png"),
    `relative path completion: expected insertion.\nLine: ${state.lineContent}`
  );
  log("Relative path completion check passed");
};

const run = async () => {
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  const mockProxy = await createMockAiProxy();
  let electronApp;

  try {
    log(`workspace copy: ${workspacePath}`);
    log(`mock ai proxy: ${mockProxy.proxyUrl}`);
    log("launching Electron...");
    electronApp = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      slowMo: Number.isFinite(slowMoMs) ? Math.max(0, slowMoMs) : 0,
      env: {
        ...process.env,
        TEX64_AI_PROXY_URL: mockProxy.proxyUrl,
      },
    });

    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1640, height: 980 });
    page.on("dialog", async (dialog) => {
      log(`dialog intercepted: ${dialog.type()} ${dialog.message()}`);
      try {
        await dialog.dismiss();
      } catch {
        // ignore flaky protocol races on auto-closed dialogs
      }
    });

    log("opening workspace via bridge...");
    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page, "main.tex");
    log("workspace/index ready");

    await focusEditor(page);
    await runCompletionChecks(page);
    await runHoverChecks(page);
    await runGhostLocalChecks(page);
    await runGhostRemoteChecks(page, mockProxy);
    await runRelativePathCheck(page);

    await saveCurrentFile(page);

    const savedMain = await fs.readFile(path.join(workspacePath, "main.tex"), "utf8");
    assert.ok(savedMain.includes("\\section{}"), "final check: expected ghost local output in main.tex");
    assert.ok(
      savedMain.includes("and report robust improvements."),
      "final check: expected ghost remote output in main.tex"
    );
    const savedIntro = await fs.readFile(path.join(workspacePath, "sections", "intro.tex"), "utf8");
    assert.ok(
      savedIntro.includes("\\includegraphics{../figures/sample-image.png"),
      "final check: expected relative path insertion in intro.tex"
    );

    log("all input-assist checks passed");
  } finally {
    if (electronApp) {
      try {
        await Promise.race([
          electronApp.close(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("electronApp.close timeout")), 5000)
          ),
        ]);
      } catch (closeError) {
        log(`electron close fallback: ${closeError instanceof Error ? closeError.message : closeError}`);
        try {
          electronApp.process()?.kill("SIGKILL");
        } catch {
          // ignore force-kill failure
        }
      }
    }
    await mockProxy.close();
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true });
      log("temporary workspace removed");
    } else {
      log(`temporary workspace kept: ${tempDir}`);
    }
  }
};

run().catch((error) => {
  console.error("[input-assist-e2e] FAILED");
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exitCode = 1;
});
