import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

const keepWorkspace = process.env.E2E_KEEP_WORKSPACE === "1";
const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "0", 10);
const defaultTimeoutMs = Number.parseInt(process.env.E2E_AI_TIMEOUT_MS ?? "180000", 10);

const now = () => new Date().toISOString().slice(11, 19);
const log = (message) => {
  console.log(`[ai-autonomous-e2e ${now()}] ${message}`);
};

const writeFile = async (workspacePath, relativePath, content) => {
  const absolutePath = path.join(workspacePath, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
};

const createWorkspace = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-e2e-ai-autonomous-"));
  const workspacePath = path.join(tempDir, "workspace");
  await fs.mkdir(workspacePath, { recursive: true });

  await writeFile(
    workspacePath,
    "main.tex",
    [
      "\\documentclass{article}",
      "\\usepackage{hyperref}",
      "\\begin{document}",
      "\\input{paper/intro}",
      "\\input{paper/body}",
      "\\input{paper/conclusion}",
      "\\input{paper/error-target}",
      "\\end{document}",
      "",
    ].join("\n")
  );

  await writeFile(
    workspacePath,
    "paper/intro.tex",
    ["\\section{Intro}", "既存イントロです。", "% INSERT_MULTI_INTRO", ""].join("\n")
  );
  await writeFile(
    workspacePath,
    "paper/body.tex",
    ["\\section{Body}", "既存の説明です。", "% INSERT_AUTONOMOUS", ""].join("\n")
  );
  await writeFile(
    workspacePath,
    "paper/conclusion.tex",
    ["\\section{Conclusion}", "既存結論です。", "% INSERT_MULTI_CONCLUSION", ""].join("\n")
  );
  await writeFile(
    workspacePath,
    "paper/error-target.tex",
    [
      "\\section{ErrorTarget}",
      "この段落は保持する。",
      "\\undefinedcommand{abc}",
      "TODO_MINOR_KEEP",
      "",
    ].join("\n")
  );

  return { tempDir, workspacePath };
};

const postToBridge = async (page, payload) => {
  await page.evaluate((value) => {
    window.tex64Bridge.postMessage(value);
  }, payload);
};

const waitForWorkspaceReady = async (page) => {
  await page.waitForSelector("body.is-ready", { timeout: 20000 });
  await page.waitForFunction(
    () => {
      const tab = document.querySelector("#editor-tabs-list .editor-tab.is-active");
      const path = tab?.getAttribute("data-path") ?? "";
      return path.endsWith(".tex");
    },
    undefined,
    { timeout: 25000 }
  );
};

const openAiPanel = async (page) => {
  await page.click('button.tab[data-tab="ai"]');
  await page.waitForSelector("#ai-input", { timeout: 10000 });
};

const waitForAiIdle = async (page, timeout = defaultTimeoutMs) => {
  await page.waitForFunction(
    () => {
      const stop = document.getElementById("ai-stop");
      const send = document.getElementById("ai-send");
      if (!(stop instanceof HTMLElement) || !(send instanceof HTMLElement)) return false;
      const stopHidden = window.getComputedStyle(stop).display === "none";
      const sendVisible = window.getComputedStyle(send).display !== "none";
      const sendEnabled = !(send instanceof HTMLButtonElement) || !send.disabled;
      return stopHidden && sendVisible && sendEnabled;
    },
    undefined,
    { timeout }
  );
};

const startNewChat = async (page) => {
  await page.click("#ai-chat-new");
  await page.waitForFunction(
    () => {
      const messages = document.querySelectorAll("#ai-chat-log .ai-message").length;
      const proposals = document.querySelectorAll("#ai-proposals .ai-proposal").length;
      return messages === 0 && proposals === 0;
    },
    undefined,
    { timeout: 12000 }
  );
};

const waitForAssistantMessageContaining = async (page, needle, timeout = defaultTimeoutMs) => {
  await page.waitForFunction(
    (token) =>
      Array.from(
        document.querySelectorAll("#ai-chat-log .ai-message.is-assistant .ai-message-content")
      ).some((node) => (node.textContent ?? "").includes(token)),
    needle,
    { timeout }
  );
  const message = await page.evaluate((token) => {
    const nodes = Array.from(
      document.querySelectorAll("#ai-chat-log .ai-message.is-assistant .ai-message-content")
    );
    const found = nodes
      .map((node) => node.textContent ?? "")
      .filter((text) => text.includes(token))
      .pop();
    return found ?? "";
  }, needle);
  return message;
};

const sendPromptAndWait = async (page, prompt, token) => {
  await waitForAiIdle(page);
  await page.fill("#ai-input", prompt);
  await page.click("#ai-send");
  const assistantMessage = await waitForAssistantMessageContaining(page, token);
  await waitForAiIdle(page);
  return assistantMessage;
};

const sendPrompt = async (page, prompt) => {
  await waitForAiIdle(page);
  await page.fill("#ai-input", prompt);
  await page.click("#ai-send");
};

const waitForAnyAssistantMessage = async (page, timeout = defaultTimeoutMs) => {
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#ai-chat-log .ai-message.is-assistant .ai-message-content")
        .length > 0,
    undefined,
    { timeout }
  );
  return page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll("#ai-chat-log .ai-message.is-assistant .ai-message-content")
    );
    return (nodes.pop()?.textContent ?? "").trim();
  });
};

const getProposalPaths = async (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("#ai-proposals .ai-proposal-path"))
      .map((node) => (node.textContent ?? "").trim())
      .filter(Boolean)
  );

const waitForProposalPath = async (page, targetPath, timeout = defaultTimeoutMs) => {
  await page.waitForFunction(
    (expectedPath) =>
      Array.from(document.querySelectorAll("#ai-proposals .ai-proposal-path")).some(
        (node) => (node.textContent ?? "").trim() === expectedPath
      ),
    targetPath,
    { timeout }
  );
};

const clickProposalAction = async (page, targetPath, label) => {
  const clicked = await page.evaluate(
    ({ expectedPath, actionLabel }) => {
      const cards = Array.from(document.querySelectorAll("#ai-proposals .ai-proposal"));
      const card = cards.find(
        (node) =>
          (node.querySelector(".ai-proposal-path")?.textContent ?? "").trim() === expectedPath
      );
      if (!card) return false;
      const button = Array.from(card.querySelectorAll("button")).find(
        (node) => (node.textContent ?? "").trim() === actionLabel
      );
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    },
    { expectedPath: targetPath, actionLabel: label }
  );
  assert.ok(clicked, `proposal action not found: path=${targetPath}, label=${label}`);
};

const waitForSystemMessageContains = async (page, needle, timeout = 45000) => {
  await page.waitForFunction(
    (token) =>
      Array.from(document.querySelectorAll("#ai-chat-log .ai-message.is-system .ai-message-content"))
        .some((node) => (node.textContent ?? "").includes(token)),
    needle,
    { timeout }
  );
};

const applyProposal = async (page, targetPath) => {
  await clickProposalAction(page, targetPath, "適用");
  await waitForSystemMessageContains(page, `適用完了: ${targetPath}`);
};

const run = async () => {
  const { tempDir, workspacePath } = await createWorkspace();
  let electronApp;
  const bodyFile = path.join(workspacePath, "paper", "body.tex");
  const introFile = path.join(workspacePath, "paper", "intro.tex");
  const conclusionFile = path.join(workspacePath, "paper", "conclusion.tex");
  const errorTargetFile = path.join(workspacePath, "paper", "error-target.tex");

  try {
    log(`workspace prepared: ${workspacePath}`);
    electronApp = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      slowMo: Number.isFinite(slowMoMs) ? Math.max(0, slowMoMs) : 0,
      env: { ...process.env },
    });
    const page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1660, height: 980 });

    log("opening workspace");
    await postToBridge(page, { type: "openRecentProject", path: workspacePath });
    await waitForWorkspaceReady(page);
    await openAiPanel(page);

    log("[1/5] conversational summary without file changes");
    await startNewChat(page);
    const summaryResponse = await sendPromptAndWait(
      page,
      [
        "このワークスペースの論文構成を日本語で2文に要約してください。",
        "今回はファイル変更提案をしないでください。",
        "回答の最後に [CHECK:SUMMARY] を入れてください。",
      ].join("\n"),
      "[CHECK:SUMMARY]"
    );
    assert.ok(summaryResponse.length >= 20, "summary response is too short");
    assert.match(
      summaryResponse,
      /(論文|構成|section|セクション|LaTeX)/i,
      "summary response does not describe structure"
    );
    assert.deepEqual(
      await getProposalPaths(page),
      [],
      "summary-only request should not generate proposals"
    );

    log("[2/5] single-file autonomous authoring");
    await startNewChat(page);
    const singleResponse = await sendPromptAndWait(
      page,
      [
        "paper/body.tex の `% INSERT_AUTONOMOUS` の直後に次の1文をそのまま追加してください。",
        "AUTO_TEST_ALPHA: 本研究の主張は再現性を重視した逐次検証である。",
        "他の行は変更しないでください。変更提案を作成してください。",
        "回答の最後に [CHECK:SINGLE] を入れてください。",
      ].join("\n"),
      "[CHECK:SINGLE]"
    );
    assert.ok(singleResponse.includes("[CHECK:SINGLE]"), "single-file answer token missing");
    await waitForProposalPath(page, "paper/body.tex");
    await applyProposal(page, "paper/body.tex");
    const bodyAfterSingle = await fs.readFile(bodyFile, "utf8");
    assert.ok(bodyAfterSingle.includes("AUTO_TEST_ALPHA"), "single-file proposal was not applied");
    assert.equal(
      (bodyAfterSingle.match(/AUTO_TEST_ALPHA/g) ?? []).length,
      1,
      "single-file marker should appear exactly once"
    );

    log("[3/5] multi-file coordinated edits");
    await startNewChat(page);
    const multiResponse = await sendPromptAndWait(
      page,
      [
        "次の2ファイルを同時に更新してください。",
        "1) paper/intro.tex の `% INSERT_MULTI_INTRO` の直後",
        "2) paper/conclusion.tex の `% INSERT_MULTI_CONCLUSION` の直後",
        "それぞれに `AUTO_TEST_BETA: 章間の整合性を保つ。` を1行追加してください。",
        "2ファイルとも変更提案を出してください。",
        "回答の最後に [CHECK:MULTI] を入れてください。",
      ].join("\n"),
      "[CHECK:MULTI]"
    );
    assert.ok(multiResponse.includes("[CHECK:MULTI]"), "multi-file answer token missing");
    await waitForProposalPath(page, "paper/intro.tex");
    await waitForProposalPath(page, "paper/conclusion.tex");
    await applyProposal(page, "paper/intro.tex");
    await applyProposal(page, "paper/conclusion.tex");
    const introAfterMulti = await fs.readFile(introFile, "utf8");
    const conclusionAfterMulti = await fs.readFile(conclusionFile, "utf8");
    assert.ok(introAfterMulti.includes("AUTO_TEST_BETA"), "intro multi-file change missing");
    assert.ok(conclusionAfterMulti.includes("AUTO_TEST_BETA"), "conclusion multi-file change missing");

    log("[4/5] major issue only, avoid unnecessary edits");
    await startNewChat(page);
    const bodyBeforeMajor = await fs.readFile(bodyFile, "utf8");
    await sendPrompt(
      page,
      [
        "重大な問題だけを修正してください。",
        "run_build は実行しないでください。",
        "paper/error-target.tex の \\undefinedcommand を有効なLaTeXコマンドに置き換えてください。",
        "`TODO_MINOR_KEEP` を含む行は絶対に変更しないでください。",
        "他ファイルは変更しないでください。",
      ].join("\n"),
    );
    await waitForProposalPath(page, "paper/error-target.tex");
    const majorResponse = await waitForAnyAssistantMessage(page, 120000);
    assert.ok(majorResponse.length >= 10, "major-fix assistant response is missing");
    const majorProposalPaths = await getProposalPaths(page);
    assert.ok(majorProposalPaths.length >= 1, "major-fix proposal missing");
    assert.ok(
      majorProposalPaths.every((item) => item === "paper/error-target.tex"),
      `unexpected proposal paths in major-fix scenario: ${majorProposalPaths.join(", ")}`
    );
    await applyProposal(page, "paper/error-target.tex");
    const errorAfterMajor = await fs.readFile(errorTargetFile, "utf8");
    const bodyAfterMajor = await fs.readFile(bodyFile, "utf8");
    assert.ok(!errorAfterMajor.includes("\\undefinedcommand"), "major error was not fixed");
    assert.ok(errorAfterMajor.includes("TODO_MINOR_KEEP"), "minor TODO line must remain untouched");
    assert.equal(
      bodyAfterMajor,
      bodyBeforeMajor,
      "non-critical file should not be changed in major-fix scenario"
    );

    log("[5/5] dialogue-first response without proposing edits");
    await startNewChat(page);
    const dialogueResponse = await sendPromptAndWait(
      page,
      [
        "まだ変更しないでください。",
        "今後の改善のために確認すべき質問を2つだけ提示してください。",
        "ファイル変更提案は行わないでください。",
        "回答の最後に [CHECK:DIALOGUE] を入れてください。",
      ].join("\n"),
      "[CHECK:DIALOGUE]"
    );
    const questionCount = (dialogueResponse.match(/[?？]/g) ?? []).length;
    assert.ok(questionCount >= 2, "dialogue response should contain at least two questions");
    assert.deepEqual(
      await getProposalPaths(page),
      [],
      "dialogue-first request should not generate proposals"
    );

    log("ai autonomous writing e2e passed");
  } finally {
    if (electronApp) {
      await electronApp.close();
    }
    if (!keepWorkspace) {
      await fs.rm(tempDir, { recursive: true, force: true });
      log("workspace removed");
    } else {
      log(`workspace kept: ${tempDir}`);
    }
  }
};

run().catch((error) => {
  console.error("[ai-autonomous-e2e] FAILED");
  console.error(error);
  process.exitCode = 1;
});
