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
const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "220", 10);
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "50", 10);

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[outline-e2e ${now()}] ${message}`);
};

const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-outline-"));
  const workspacePath = path.join(tempDir, "workspace");
  const userDataPath = path.join(tempDir, "userdata");
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });
  return { tempDir, workspacePath, userDataPath };
};

const seedDedupeFixtures = async (workspacePath) => {
  const fixtureDir = path.join(workspacePath, "cases", "index");
  await fs.mkdir(fixtureDir, { recursive: true });

  const dedupeTex = String.raw`\section{E2E Dedupe}\section{E2E Dedupe}
\label{e2e:dup-label}\label{e2e:dup-label}
See \ref{e2e:dup-label}\ref{e2e:dup-label}
\cite{e2eDupBib}\cite{e2eDupBib}
\todo{E2E_DUP_TODO}\todo{E2E_DUP_TODO}
\begin{figure}
\caption{E2E Dup Figure}\caption{E2E Dup Figure}
\end{figure}
\begin{table}
\caption{E2E Dup Table}\caption{E2E Dup Table}
\end{table}
`;
  const dedupeBib = "@book{e2eDupBib, title={A}} @book{e2eDupBib, title={B}}\n";

  await fs.writeFile(path.join(fixtureDir, "dedupe.tex"), dedupeTex, "utf8");
  await fs.writeFile(path.join(fixtureDir, "dedupe.bib"), dedupeBib, "utf8");
};

const postToBridge = async (page, payload) => {
  await page.evaluate((value) => {
    window.tex64Bridge.postMessage(value);
  }, payload);
};

const waitForBridgeMessage = async (page, type, timeout = 30000) =>
  page.evaluate(
    ({ eventType, eventTimeout }) =>
      new Promise((resolve) => {
        let off = null;
        const done = (value) => {
          if (off) {
            off();
            off = null;
          }
          resolve(value);
        };
        const timer = setTimeout(() => {
          done({ __timeout: true });
        }, eventTimeout);
        off = window.tex64Bridge.onMessage((message) => {
          if (message?.type !== eventType) {
            return;
          }
          clearTimeout(timer);
          done(message?.payload ?? null);
        });
      }),
    { eventType: type, eventTimeout: timeout }
  );

const waitForAppReady = async (page) => {
  await page.waitForSelector("body.is-ready", { timeout: 20000 });
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', {
    timeout: 25000,
  });
};

const openSideTab = async (page, key) => {
  await page.evaluate((tabKey) => {
    const tab = document.querySelector(`button.tab[data-tab="${tabKey}"]`);
    if (tab instanceof HTMLButtonElement) {
      tab.classList.remove("is-hidden");
      tab.setAttribute("aria-hidden", "false");
      tab.click();
    }
    const panel = document.querySelector(`.sidebar-panel .panel[data-panel="${tabKey}"]`);
    if (panel instanceof HTMLElement) {
      panel.classList.remove("is-hidden");
    }
  }, key);
  await page.waitForFunction(
    (tabKey) => {
      const panel = document.querySelector(`.sidebar-panel .panel[data-panel="${tabKey}"]`);
      return panel instanceof HTMLElement && panel.classList.contains("is-active");
    },
    key,
    { timeout: 10000 }
  );
  await pause(80);
};

const setOutlineMode = async (page, mode) => {
  const targetId = mode === "project" ? "outline-mode-project" : "outline-mode-current";
  await page.evaluate((id) => {
    const button = document.getElementById(id);
    if (button instanceof HTMLButtonElement) {
      button.click();
    }
  }, targetId);
  await page.waitForFunction(
    (id) => {
      const button = document.getElementById(id);
      return (
        button instanceof HTMLButtonElement &&
        button.getAttribute("aria-pressed") === "true" &&
        button.classList.contains("is-active")
      );
    },
    targetId,
    { timeout: 10000 }
  );
  await pause(80);
};

const waitForOutlineItems = async (page) => {
  await page.waitForFunction(
    () => {
      const count =
        document.querySelectorAll("#outline-sections .outline-item").length +
        document.querySelectorAll("#outline-labels .outline-item").length +
        document.querySelectorAll("#outline-citations .outline-item").length +
        document.querySelectorAll("#outline-todos .outline-item").length;
      return count > 0;
    },
    undefined,
    { timeout: 15000 }
  );
};

const readOutlineEntries = async (page, containerId) =>
  page.evaluate((id) => {
    const container = document.getElementById(id);
    if (!(container instanceof HTMLElement)) {
      return [];
    }
    return Array.from(container.querySelectorAll(".outline-item")).map((item) => {
      const label = (item.querySelector("div")?.textContent ?? item.textContent ?? "").trim();
      const meta = (item.querySelector(".outline-item-meta")?.textContent ?? "").trim();
      const style = window.getComputedStyle(item);
      const paddingLeft = Number.parseFloat(style.paddingLeft || "0");
      return {
        text: label,
        meta,
        paddingLeft: Number.isFinite(paddingLeft) ? paddingLeft : 0,
      };
    });
  }, containerId);

const clickOutlineEntry = async (page, containerId, needle, exact = false) =>
  page.evaluate(
    ({ id, target, shouldBeExact }) => {
      const container = document.getElementById(id);
      if (!(container instanceof HTMLElement)) {
        return false;
      }
      const items = Array.from(container.querySelectorAll(".outline-item"));
      const targetItem = items.find((item) => {
        const text = (item.querySelector("div")?.textContent ?? item.textContent ?? "").trim();
        return shouldBeExact ? text === target : text.includes(target);
      });
      if (!(targetItem instanceof HTMLElement)) {
        return false;
      }
      targetItem.click();
      return true;
    },
    { id: containerId, target: needle, shouldBeExact: exact }
  );

const clickFileTreePath = async (page, relativePath, type = "file") => {
  const selector =
    type === "file"
      ? `#file-tree button.file-item[data-path="${relativePath}"]`
      : `#file-tree details.file-folder[data-path="${relativePath}"] > summary`;
  await page.waitForSelector(selector, { timeout: 10000 });
  await page.click(selector);
};

const ensureFolderOpen = async (page, relativePath) => {
  const detailsSelector = `#file-tree details.file-folder[data-path="${relativePath}"]`;
  await page.waitForSelector(detailsSelector, { timeout: 10000 });
  const isOpen = await page.$eval(
    detailsSelector,
    (node) => node instanceof HTMLDetailsElement && node.open
  );
  if (!isOpen) {
    await clickFileTreePath(page, relativePath, "dir");
  }
  await page.waitForFunction(
    (value) => {
      const node = document.querySelector(
        `#file-tree details.file-folder[data-path="${value}"]`
      );
      return node instanceof HTMLDetailsElement && node.open;
    },
    relativePath,
    { timeout: 8000 }
  );
};

const waitForSecondaryCursorLine = async (page, expectedLine, timeout = 15000) => {
  await page.waitForFunction(
    (line) => {
      const monacoApi = window.monaco?.editor;
      const editors = monacoApi?.getEditors ? monacoApi.getEditors() : [];
      for (const editor of editors) {
        const node = typeof editor.getDomNode === "function" ? editor.getDomNode() : null;
        if (!node || !node.closest('[data-editor-group="secondary"]')) {
          continue;
        }
        const position =
          typeof editor.getPosition === "function" ? editor.getPosition() : null;
        return position?.lineNumber === line;
      }
      return false;
    },
    expectedLine,
    { timeout }
  );
};

const assertSecondaryJump = async (page, targetPath, targetLine) => {
  await page.waitForSelector('#editor-groups[data-split="true"]', { timeout: 10000 });
  await page.waitForSelector(
    `#editor-tabs-list-secondary .editor-tab.is-active[data-path="${targetPath}"]`,
    { timeout: 15000 }
  );
  await waitForSecondaryCursorLine(page, targetLine);
};

const assertUniqueByToken = (entries, tokenBuilder, label) => {
  const tokens = entries.map(tokenBuilder);
  const unique = new Set(tokens);
  assert.equal(unique.size, entries.length, `${label} should be deduped`);
};

const countEntriesByKey = (entries, key) =>
  entries.filter((entry) => entry?.key === key).length;

const countSectionsByTitle = (entries, title) =>
  entries.filter((entry) => entry?.title === title).length;

const run = async () => {
  const { tempDir, workspacePath, userDataPath } = await createWorkspaceCopy();
  let electronApp;

  try {
    await seedDedupeFixtures(workspacePath);
    log(`workspace copy: ${workspacePath}`);
    electronApp = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      slowMo: Number.isFinite(slowMoMs) ? Math.max(0, slowMoMs) : 0,
      env: {
        ...process.env,
        TEX64_E2E_USERDATA: userDataPath,
      },
    });
    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1600, height: 980 });

    await waitForAppReady(page);

    const indexPayloadPromise = waitForBridgeMessage(page, "updateIndex", 40000);
    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);

    log("[1/4] index snapshot (10.1)");
    const indexPayload = await indexPayloadPromise;
    assert.notEqual(
      indexPayload?.__timeout,
      true,
      "updateIndex payload was not received after opening workspace"
    );
    assert.ok(indexPayload && typeof indexPayload === "object", "updateIndex payload missing");

    const requiredCollections = [
      "labels",
      "references",
      "citations",
      "sections",
      "figures",
      "tables",
      "todos",
    ];
    for (const key of requiredCollections) {
      assert.ok(Array.isArray(indexPayload[key]), `${key} should be an array`);
      assert.ok(indexPayload[key].length > 0, `${key} should not be empty`);
    }

    assertUniqueByToken(
      indexPayload.labels,
      (entry) => `${entry.key}|${entry.path}|${entry.line}`,
      "labels"
    );
    assertUniqueByToken(
      indexPayload.references,
      (entry) => `${entry.key}|${entry.path}|${entry.line}`,
      "references"
    );
    assertUniqueByToken(
      indexPayload.citations,
      (entry) => `${entry.key}|${entry.path}|${entry.line}`,
      "citations"
    );
    assertUniqueByToken(
      indexPayload.sections,
      (entry) => `${entry.title}|${entry.path}|${entry.line}|${entry.level}`,
      "sections"
    );
    assertUniqueByToken(
      indexPayload.figures,
      (entry) => `${entry.key}|${entry.path}|${entry.line}`,
      "figures"
    );
    assertUniqueByToken(
      indexPayload.tables,
      (entry) => `${entry.key}|${entry.path}|${entry.line}`,
      "tables"
    );
    assertUniqueByToken(
      indexPayload.todos,
      (entry) => `${entry.key}|${entry.path}|${entry.line}`,
      "todos"
    );

    assert.equal(
      countEntriesByKey(indexPayload.labels, "e2e:dup-label"),
      1,
      "duplicate labels in same line should be deduped"
    );
    assert.equal(
      countEntriesByKey(indexPayload.references, "e2e:dup-label"),
      1,
      "duplicate references in same line should be deduped"
    );
    assert.equal(
      countEntriesByKey(indexPayload.citations, "e2eDupBib"),
      2,
      "duplicate citations in .tex/.bib should be deduped per location"
    );
    assert.equal(
      countSectionsByTitle(indexPayload.sections, "E2E Dedupe"),
      1,
      "duplicate sections in same line should be deduped"
    );
    assert.equal(
      countEntriesByKey(indexPayload.figures, "E2E Dup Figure"),
      1,
      "duplicate figure captions in same line should be deduped"
    );
    assert.equal(
      countEntriesByKey(indexPayload.tables, "E2E Dup Table"),
      1,
      "duplicate table captions in same line should be deduped"
    );
    assert.equal(
      countEntriesByKey(indexPayload.todos, "E2E_DUP_TODO"),
      1,
      "duplicate todos in same line should be deduped"
    );
    assert.ok(
      indexPayload.figures.some((entry) => entry.key.includes("Sample image")),
      "figure entries should include main workspace figure caption"
    );
    assert.ok(
      indexPayload.tables.some((entry) => entry.key.includes("Evaluation metrics")),
      "table entries should include main workspace table caption"
    );

    log("[2/4] outline current mode + active file filter (10.2)");
    await openSideTab(page, "outline");
    await waitForOutlineItems(page);
    await setOutlineMode(page, "current");

    let currentSections = await readOutlineEntries(page, "outline-sections");
    let currentLabels = await readOutlineEntries(page, "outline-labels");
    let currentCitations = await readOutlineEntries(page, "outline-citations");
    let currentTodos = await readOutlineEntries(page, "outline-todos");

    assert.ok(
      currentSections.some((entry) => entry.text.includes("Overview")),
      "current mode should include active file section"
    );
    assert.equal(
      currentSections.some((entry) => entry.text.includes("Introduction")),
      false,
      "current mode should hide sections from non-active files"
    );
    assert.ok(
      currentLabels.some((entry) => entry.text === "sec:overview"),
      "current mode should include active file labels"
    );
    assert.equal(
      currentLabels.some((entry) => entry.text === "sec:intro"),
      false,
      "current mode should hide labels from non-active files"
    );
    assert.ok(
      currentCitations.some((entry) => entry.text === "knuth1984"),
      "current mode should include citations from active file"
    );
    assert.equal(
      currentCitations.some((entry) => entry.text === "texbook1990"),
      false,
      "current mode should hide citations from non-active files"
    );
    assert.ok(
      currentTodos.some((entry) => entry.text.includes("revisit the summary section")),
      "current mode should include TODO from active file"
    );
    for (const entry of [
      ...currentSections,
      ...currentLabels,
      ...currentCitations,
      ...currentTodos,
    ]) {
      assert.equal(entry.meta, "", "current mode should not render location metadata");
    }

    await openSideTab(page, "files");
    await ensureFolderOpen(page, "sections");
    await clickFileTreePath(page, "sections/intro.tex");
    await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="sections/intro.tex"]', {
      timeout: 10000,
    });
    await openSideTab(page, "outline");
    await setOutlineMode(page, "current");
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll("#outline-sections .outline-item"))
          .map((item) => (item.querySelector("div")?.textContent ?? item.textContent ?? "").trim())
          .some((text) => text.includes("Introduction")),
      undefined,
      { timeout: 10000 }
    );
    currentSections = await readOutlineEntries(page, "outline-sections");
    assert.ok(
      currentSections.some((entry) => entry.text.includes("Introduction")),
      "current mode should follow active file changes"
    );
    assert.ok(
      currentSections.some((entry) => entry.text.includes("Background")),
      "current mode should include subsection in active file"
    );
    assert.equal(
      currentSections.some((entry) => entry.text.includes("Overview")),
      false,
      "previous active-file sections should disappear after file switch"
    );

    log("[3/4] outline project mode + hierarchy");
    await setOutlineMode(page, "project");
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll("#outline-labels .outline-item"))
          .map((item) => (item.querySelector("div")?.textContent ?? item.textContent ?? "").trim())
          .some((text) => text === "sec:overview"),
      undefined,
      { timeout: 10000 }
    );

    const projectSections = await readOutlineEntries(page, "outline-sections");
    const projectLabels = await readOutlineEntries(page, "outline-labels");
    const projectCitations = await readOutlineEntries(page, "outline-citations");
    const projectTodos = await readOutlineEntries(page, "outline-todos");

    const paddingFor = (needle) => {
      const entry = projectSections.find((item) => item.text.includes(needle));
      assert.ok(entry, `section not found: ${needle}`);
      return entry.paddingLeft;
    };
    const sectionPad = paddingFor("Appendix: Additional Checks");
    const subsectionPad = paddingFor("Extra Notes");
    const subsubsectionPad = paddingFor("Detail Block");
    const paragraphPad = paddingFor("Paragraph Level");
    const subparagraphPad = paddingFor("Subparagraph Level");
    assert.ok(subsectionPad > sectionPad, "subsection should be indented more than section");
    assert.ok(
      subsubsectionPad > subsectionPad,
      "subsubsection should be indented more than subsection"
    );
    assert.ok(paragraphPad > subsubsectionPad, "paragraph should be deeper than subsubsection");
    assert.ok(
      subparagraphPad > paragraphPad,
      "subparagraph should be deeper than paragraph"
    );

    for (const entry of [...projectLabels, ...projectCitations, ...projectTodos]) {
      assert.ok(
        typeof entry.meta === "string" && entry.meta.includes(":"),
        "project mode should render location metadata"
      );
    }
    const knuthCitation = projectCitations.find((entry) => entry.text === "knuth1984");
    assert.ok(knuthCitation, "project mode should include knuth1984 citation entry");
    assert.ok(
      knuthCitation.meta.startsWith("refs.bib:"),
      "project mode citation should jump to .bib source"
    );

    log("[4/4] outline jump targets (section/todo/label/citation)");
    const clickedSection = await clickOutlineEntry(page, "outline-sections", "Introduction");
    assert.equal(clickedSection, true, "could not click outline section: Introduction");
    await assertSecondaryJump(page, "sections/intro.tex", 1);

    const clickedTodo = await clickOutlineEntry(page, "outline-todos", "Verify the loss function");
    assert.equal(clickedTodo, true, "could not click outline todo in methods");
    await assertSecondaryJump(page, "sections/methods.tex", 19);

    const clickedLabel = await clickOutlineEntry(page, "outline-labels", "sec:overview", true);
    assert.equal(clickedLabel, true, "could not click outline label: sec:overview");
    await assertSecondaryJump(page, "main.tex", 25);

    const clickedCitation = await clickOutlineEntry(page, "outline-citations", "knuth1984", true);
    assert.equal(clickedCitation, true, "could not click outline citation: knuth1984");
    await assertSecondaryJump(page, "refs.bib", 1);

    log("outline e2e passed");
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
  console.error(error);
  process.exitCode = 1;
});
