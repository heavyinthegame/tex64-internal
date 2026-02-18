import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { AgentService } = require("../../electron/services/agent.cjs");
const { AGENT_TOOL_DECLARATIONS } = require("../../electron/services/agent-tools.cjs");
const { buildAgentPolicy } = require("../../electron/services/agent-policy.cjs");

const toPosixPath = (value) => value.split(path.sep).join("/");

const createWorkspace = (rootPath) => {
  const resolvePath = (relativePath = "") => {
    const relative = typeof relativePath === "string" ? relativePath.trim() : "";
    const resolved = path.resolve(rootPath, relative || ".");
    const rootWithSep = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`;
    if (resolved !== rootPath && !resolved.startsWith(rootWithSep)) {
      throw new Error(`path escapes workspace: ${relativePath}`);
    }
    return resolved;
  };

  const listFiles = async () => {
    const result = [];
    const walk = async (dirPath) => {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const absPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          await walk(absPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        result.push(toPosixPath(path.relative(rootPath, absPath)));
      }
    };
    await walk(rootPath);
    result.sort((left, right) => left.localeCompare(right, "ja"));
    return result;
  };

  return {
    getRootPath: () => rootPath,
    resolvePath,
    listFiles,
    writeFile: async (relativePath, content) => {
      const resolved = resolvePath(relativePath);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, "utf8");
    },
    rootInfo: async () => ({ path: "main.tex" }),
    resolveTexRootFromMagic: async () => null,
    loadSettings: async () => ({}),
  };
};

const seedWorkspace = async (rootPath) => {
  await fs.mkdir(path.join(rootPath, "sections"), { recursive: true });
  await fs.mkdir(path.join(rootPath, "assets"), { recursive: true });
  await fs.mkdir(path.join(rootPath, "blocked"), { recursive: true });
  await fs.writeFile(
    path.join(rootPath, "main.tex"),
    [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{Intro}\\label{oldlabel}",
      "See Section~\\ref{oldlabel}.",
      "SEARCH_TOKEN appears here.",
      "\\end{document}",
      "",
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(rootPath, "refs.bib"),
    ["@article{oldcite,", "  title={Sample}", "}", ""].join("\n"),
    "utf8"
  );
  await fs.writeFile(path.join(rootPath, "notes.txt"), "line one\nSEARCH_TOKEN line two\n", "utf8");
  await fs.writeFile(path.join(rootPath, "patch.tex"), "alpha beta alpha\n", "utf8");
  await fs.writeFile(path.join(rootPath, "delete-me.tex"), "delete me\n", "utf8");
  await fs.writeFile(path.join(rootPath, "rename-me.tex"), "rename me\n", "utf8");
  await fs.writeFile(path.join(rootPath, "sections", "intro.tex"), "intro section\n", "utf8");
  await fs.writeFile(path.join(rootPath, "assets", "data.txt"), "asset text\n", "utf8");
  await fs.writeFile(path.join(rootPath, "blocked", "secret.tex"), "secret\n", "utf8");
  await fs.writeFile(path.join(rootPath, "binary.bin"), Buffer.from([0x00, 0xff, 0x10, 0x00]));
};

const getProposalFromResult = (service, result) => {
  const proposalId =
    typeof result?.proposalId === "string"
      ? result.proposalId
      : Array.isArray(result?.proposalIds) && typeof result.proposalIds[0] === "string"
      ? result.proposalIds[0]
      : null;
  if (!proposalId) {
    return null;
  }
  const proposal = service.proposals.get(proposalId);
  return proposal ? { proposalId, proposal } : null;
};

const run = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tex64-ai-tools-"));
  const workspacePath = path.join(tempDir, "workspace");
  await fs.mkdir(workspacePath, { recursive: true });
  await seedWorkspace(workspacePath);

  try {
    let settingsSnapshot = {
      compileEngine: "lualatex",
      autoSynctexOnBuild: true,
      reverseSynctexEnabled: true,
      pdfViewerMode: "single",
      ghostCompletionEnabled: true,
      alignEnv: true,
      formatSettings: {},
    };

    let buildCallCount = 0;
    let service = null;
    const rendererEvents = [];
    const sendToRenderer = (channel, payload) => {
      rendererEvents.push({ channel, payload });
      if (channel !== "settings:request") {
        return;
      }
      const action = payload?.action;
      const requestId = payload?.requestId;
      if (!requestId || !service) {
        return;
      }
      if (action === "get") {
        service.handleSettingsResponse({ requestId, settings: { ...settingsSnapshot } });
        return;
      }
      if (action === "set") {
        const patch =
          payload?.settings && typeof payload.settings === "object" ? payload.settings : {};
        settingsSnapshot = { ...settingsSnapshot, ...patch };
        service.handleSettingsResponse({ requestId, settings: { ...settingsSnapshot } });
      }
    };

    service = new AgentService({
      workspace: createWorkspace(workspacePath),
      searchService: null,
      ensureUserSettings: () => ({
        getAgentSettings: async () => ({}),
        updateAgentSettings: async (partial) => partial ?? {},
      }),
      sendToRenderer,
      updateWorkspaceIfNeeded: async () => {},
      requestIndex: () => {},
      buildService: {
        build: async (rootPath, targetFile, engine) => {
          buildCallCount += 1;
          assert.equal(path.resolve(rootPath), path.resolve(workspacePath));
          assert.equal(typeof targetFile, "string");
          assert.equal(typeof engine, "string");
          return {
            kind: "success",
            summary: "build ok",
            issues: [],
            pdfPath: path.join(rootPath, "main.pdf"),
            log: "",
          };
        },
      },
      sendBuildState: () => {},
      sendBuildLog: () => {},
      sendIssues: () => {},
      indexerService: {
        buildIndex: async () => ({
          labels: [{ key: "oldlabel", path: "main.tex", line: 3 }],
          references: [{ key: "oldlabel", path: "main.tex", line: 4 }],
          citations: [{ key: "oldcite", path: "main.tex", line: 4 }],
          sections: [{ title: "Intro", path: "main.tex", line: 3 }],
          figures: [],
          tables: [],
          todos: [],
        }),
      },
      apiUsageService: null,
    });

    const covered = new Set();
    const callToolRaw = async (name, args = {}, conversationId = "tool-coverage") =>
      service.executeToolCall({ name, args }, conversationId);

    let errorChecks = 0;
    const callTool = async (name, args = {}, conversationId = "tool-coverage") => {
      covered.add(name);
      const result = await callToolRaw(name, args, conversationId);
      assert.ok(result && typeof result === "object", `${name}: invalid result`);
      assert.ok(!result.error, `${name}: ${result.error}`);
      return result;
    };

    const expectToolError = async (name, args = {}, expected = "", conversationId = "tool-errors") => {
      const result = await callToolRaw(name, args, conversationId);
      assert.ok(result && typeof result === "object", `${name}: invalid result`);
      assert.ok(typeof result.error === "string" && result.error.length > 0, `${name}: expected error`);
      if (expected) {
        assert.ok(
          result.error.includes(expected),
          `${name}: expected error to include "${expected}", got "${result.error}"`
        );
      }
      errorChecks += 1;
      return result.error;
    };

    const withPolicy = async (settings, callback) => {
      const previousPolicy = service.agentPolicy;
      service.agentPolicy = buildAgentPolicy(settings);
      try {
        await callback();
      } finally {
        service.agentPolicy = previousPolicy;
      }
    };

    // Success path coverage (all declared tools)
    const listResult = await callTool("list_files", {});
    assert.ok(Array.isArray(listResult.files), "list_files: files must be array");
    assert.ok(listResult.files.includes("main.tex"), "list_files: main.tex missing");

    const readFileResult = await callTool("read_file", { path: "main.tex" });
    assert.ok(
      typeof readFileResult.content === "string" &&
        readFileResult.content.includes("\\label{oldlabel}"),
      "read_file: expected label content"
    );

    const readBinaryResult = await callTool("read_file", {
      path: "binary.bin",
      encoding: "base64",
    });
    assert.equal(readBinaryResult.encoding, "base64", "read_file: binary should use base64");
    assert.equal(readBinaryResult.binary, true, "read_file: binary flag missing");

    const readFilesResult = await callTool("read_files", {
      paths: ["main.tex", "refs.bib"],
    });
    assert.ok(
      typeof readFilesResult.files?.["main.tex"]?.content === "string",
      "read_files: main.tex content missing"
    );
    assert.ok(
      typeof readFilesResult.files?.["refs.bib"]?.content === "string",
      "read_files: refs.bib content missing"
    );

    const searchResult = await callTool("search_files", { query: "SEARCH_TOKEN" });
    assert.ok(Array.isArray(searchResult.results), "search_files: results must be array");
    assert.ok(
      searchResult.results.some((entry) => entry.path === "notes.txt"),
      "search_files: expected notes.txt hit"
    );

    const structureResult = await callTool("get_project_structure", { maxDepth: 3 });
    assert.ok(Array.isArray(structureResult.structure), "get_project_structure: structure missing");
    assert.ok(structureResult.structure.length > 0, "get_project_structure: structure empty");

    const indexResult = await callTool("get_index", {
      kinds: ["labels", "references", "citations", "sections"],
    });
    assert.ok(indexResult.index?.labels?.length > 0, "get_index: labels missing");
    assert.ok(indexResult.index?.sections?.length > 0, "get_index: sections missing");

    const renameSymbolResult = await callTool("rename_latex_symbol", {
      from: "oldlabel",
      to: "newlabel",
      kinds: ["label", "ref"],
    });
    assert.equal(renameSymbolResult.status, "proposed");
    assert.ok(
      Array.isArray(renameSymbolResult.proposalIds),
      "rename_latex_symbol: proposalIds missing"
    );
    assert.ok(renameSymbolResult.proposalIds.length >= 1, "rename_latex_symbol: no proposal");
    await service.applyProposal(renameSymbolResult.proposalIds[0]);
    const renamedText = await fs.readFile(path.join(workspacePath, "main.tex"), "utf8");
    assert.ok(renamedText.includes("\\label{newlabel}"), "rename_latex_symbol: label not renamed");
    assert.ok(renamedText.includes("\\ref{newlabel}"), "rename_latex_symbol: ref not renamed");

    const runBuildResult = await callTool("run_build", {
      mainFile: "main.tex",
      engine: "lualatex",
    });
    assert.equal(runBuildResult.status, "success", "run_build: expected success");
    assert.equal(buildCallCount, 1, "run_build: build should run once");

    await expectToolError(
      "run_command",
      { command: "printf should-not-run" },
      "run_command は現在無効です"
    );
    service.agentOptions.allowRunCommand = true;
    const runCommandResult = await callTool("run_command", { command: "printf ai-tools-ok" });
    assert.equal(runCommandResult.exitCode, 0, "run_command: exit code");
    assert.ok(runCommandResult.stdout.includes("ai-tools-ok"), "run_command: stdout mismatch");

    const getSettingsResult = await callTool("get_app_settings", {
      keys: ["compileEngine", "ghostCompletionEnabled"],
    });
    assert.equal(
      getSettingsResult.settings.compileEngine,
      "lualatex",
      "get_app_settings: compileEngine"
    );
    assert.equal(
      getSettingsResult.settings.ghostCompletionEnabled,
      true,
      "get_app_settings: ghostCompletionEnabled"
    );

    const setSettingsResult = await callTool("set_app_settings", {
      settings: { compileEngine: "xelatex", ghostCompletionEnabled: false },
    });
    assert.equal(
      setSettingsResult.settings.compileEngine,
      "xelatex",
      "set_app_settings: compileEngine"
    );
    assert.equal(
      setSettingsResult.settings.ghostCompletionEnabled,
      false,
      "set_app_settings: ghostCompletionEnabled"
    );

    const proposeWriteResult = await callTool("propose_write", {
      path: "write-target.tex",
      content: "write result\n",
      summary: "write tool test",
    });
    const writeProposal = getProposalFromResult(service, proposeWriteResult);
    assert.ok(writeProposal, "propose_write: proposal missing");
    await service.applyProposal(writeProposal.proposalId);
    assert.equal(
      await fs.readFile(path.join(workspacePath, "write-target.tex"), "utf8"),
      "write result\n",
      "propose_write: apply mismatch"
    );

    const proposePatchResult = await callTool("propose_patch", {
      path: "patch.tex",
      search: "alpha",
      replace: "omega",
      replaceAll: true,
      summary: "patch tool test",
    });
    const patchProposal = getProposalFromResult(service, proposePatchResult);
    assert.ok(patchProposal, "propose_patch: proposal missing");
    await service.applyProposal(patchProposal.proposalId);
    const patchText = await fs.readFile(path.join(workspacePath, "patch.tex"), "utf8");
    assert.ok(patchText.includes("omega"), "propose_patch: replacement missing");
    assert.ok(!patchText.includes("alpha"), "propose_patch: old token remains");

    const proposeDeleteResult = await callTool("propose_delete", {
      path: "delete-me.tex",
      summary: "delete tool test",
    });
    const deleteProposal = getProposalFromResult(service, proposeDeleteResult);
    assert.ok(deleteProposal, "propose_delete: proposal missing");
    await service.applyProposal(deleteProposal.proposalId);
    const deleteExists = await fs
      .access(path.join(workspacePath, "delete-me.tex"))
      .then(() => true)
      .catch(() => false);
    assert.equal(deleteExists, false, "propose_delete: file should be removed");

    const proposeRenameResult = await callTool("propose_rename", {
      oldPath: "rename-me.tex",
      newPath: "renamed/renamed.tex",
      summary: "rename tool test",
    });
    const renameProposal = getProposalFromResult(service, proposeRenameResult);
    assert.ok(renameProposal, "propose_rename: proposal missing");
    await service.applyProposal(renameProposal.proposalId);
    const renameSourceExists = await fs
      .access(path.join(workspacePath, "rename-me.tex"))
      .then(() => true)
      .catch(() => false);
    const renameTargetExists = await fs
      .access(path.join(workspacePath, "renamed", "renamed.tex"))
      .then(() => true)
      .catch(() => false);
    assert.equal(renameSourceExists, false, "propose_rename: source should be removed");
    assert.equal(renameTargetExists, true, "propose_rename: target should exist");

    const proposeMkdirResult = await callTool("propose_create_directory", {
      path: "created/by-tool",
      summary: "mkdir tool test",
    });
    const mkdirProposal = getProposalFromResult(service, proposeMkdirResult);
    assert.ok(mkdirProposal, "propose_create_directory: proposal missing");
    await service.applyProposal(mkdirProposal.proposalId);
    const mkdirStat = await fs.stat(path.join(workspacePath, "created", "by-tool"));
    assert.ok(mkdirStat.isDirectory(), "propose_create_directory: directory missing");

    // Error path checks
    await expectToolError("list_files", { directory: "missing-dir" }, "ディレクトリが見つかりません");
    await expectToolError("read_file", { path: "" }, "path が空です");
    await expectToolError("read_file", { path: "missing.tex" }, "ファイルが見つかりません");
    await expectToolError("read_files", { paths: [] }, "paths が空です");

    await withPolicy({ maxReadFiles: 1 }, async () => {
      await expectToolError(
        "read_files",
        { paths: ["main.tex", "notes.txt"] },
        "一度に読み取れるファイルは1個までです。"
      );
    });

    await withPolicy({ textExtensions: ["tex", "txt", "bib"] }, async () => {
      await expectToolError(
        "read_file",
        { path: "binary.bin" },
        "テキストファイルのみ読み取れます"
      );
    });

    await expectToolError("run_command", { command: "" }, "command が空です");
    await expectToolError("run_command", { command: "pwd", cwd: "../../" }, "cwd が不正です");
    await expectToolError(
      "run_command",
      { command: "printf hello && ls" },
      "シェル演算子"
    );
    await expectToolError(
      "run_command",
      { command: "rm -rf ." },
      "許可されていないコマンド"
    );
    await expectToolError(
      "rename_latex_symbol",
      { from: "newlabel", to: "newlabel" },
      "from と to が同じです"
    );
    await expectToolError(
      "rename_latex_symbol",
      { from: "bad key", to: "newkey" },
      "from/to に空白や区切り文字は使えません"
    );
    await expectToolError(
      "rename_latex_symbol",
      { from: "newlabel", to: "x", kinds: ["unknown"] },
      "kinds が不正です"
    );
    await expectToolError(
      "rename_latex_symbol",
      { from: "not-found-symbol", to: "another-symbol" },
      "一致するシンボルが見つかりません"
    );

    await expectToolError("set_app_settings", {}, "settings が空です");
    await expectToolError("propose_write", { path: "", content: "x" }, "path が空です");
    await withPolicy({ textExtensions: ["tex", "txt", "bib"] }, async () => {
      await expectToolError(
        "propose_write",
        { path: "image.png", content: "abc" },
        "テキストファイルのみ書き込み可能です"
      );
    });
    await withPolicy({ maxFileBytes: 3 }, async () => {
      await expectToolError(
        "propose_write",
        { path: "tiny-limit.tex", content: "12345" },
        "内容が大きすぎます"
      );
    });
    await expectToolError(
      "propose_write",
      { path: "binary-out.bin", content: "%%%invalid%%%", encoding: "base64" },
      "base64 の内容が不正です"
    );
    await expectToolError("propose_patch", { path: "patch.tex", search: "" }, "path と search は必須です");
    await expectToolError("propose_patch", { edits: [] }, "edits が空です");
    await expectToolError(
      "propose_patch",
      { path: "patch.tex", search: "notfound", replace: "x" },
      "検索文字列が見つかりません"
    );
    await expectToolError(
      "propose_patch",
      { path: "binary.bin", search: "a", replace: "b" },
      "バイナリファイルのため部分編集できません"
    );
    await expectToolError("propose_delete", { path: "not-exists.tex" }, "ファイルが見つかりません");
    await expectToolError(
      "propose_rename",
      { oldPath: "", newPath: "x.tex" },
      "oldPath と newPath は必須です"
    );
    await expectToolError(
      "propose_rename",
      { oldPath: "not-found.tex", newPath: "x.tex" },
      "ファイルが見つかりません"
    );
    await expectToolError("propose_create_directory", { path: "" }, "path が空です");
    await expectToolError("unknown_tool", {}, "unknown tool:");

    await withPolicy({ blockedTopLevel: ["blocked"] }, async () => {
      await expectToolError("list_files", { directory: "blocked" }, "対象パスは読み取り禁止です");
      await expectToolError(
        "propose_write",
        { path: "blocked/new.tex", content: "x" },
        "対象パスは書き込み禁止です"
      );
      await expectToolError(
        "propose_delete",
        { path: "blocked/secret.tex" },
        "対象パスは削除禁止です"
      );
      await expectToolError(
        "propose_create_directory",
        { path: "blocked/new-dir" },
        "対象パスは作成禁止です"
      );
    });

    const previousIndexer = service.indexerService;
    service.indexerService = null;
    await expectToolError("get_index", {}, "インデクサが利用できません");
    service.indexerService = previousIndexer;

    const previousBuildService = service.buildService;
    service.buildService = null;
    await expectToolError("run_build", {}, "ビルド機能が利用できません");
    service.buildService = previousBuildService;

    service.buildService = {
      build: async () => ({ kind: "busy", summary: "busy" }),
    };
    const busyBuildResult = await callToolRaw("run_build", {});
    assert.equal(busyBuildResult.status, "busy", "run_build busy path should return busy");

    service.buildService = {
      build: async () => ({
        kind: "failure",
        summary: "failed",
        issues: [{ severity: "error", message: "build failed" }],
      }),
    };
    const failureBuildResult = await callToolRaw("run_build", {});
    assert.equal(failureBuildResult.status, "failure", "run_build failure path should return failure");

    service.buildService = previousBuildService;

    const previousRequestAppSettings = service.requestAppSettings.bind(service);
    service.requestAppSettings = async () => ({ error: "settings backend error" });
    await expectToolError("get_app_settings", {}, "settings backend error");
    await expectToolError("set_app_settings", { settings: { compileEngine: "lualatex" } }, "settings backend error");
    service.requestAppSettings = async () => ({});
    await expectToolError("get_app_settings", {}, "設定が取得できませんでした。");
    await expectToolError(
      "set_app_settings",
      { settings: { compileEngine: "lualatex" } },
      "設定が更新できませんでした。"
    );
    service.requestAppSettings = previousRequestAppSettings;

    await service.applyProposal("missing-proposal-id");
    const applyErrorEvent = rendererEvents
      .filter((entry) => entry.channel === "agent:applyResult")
      .at(-1);
    assert.ok(applyErrorEvent, "apply missing proposal should emit agent:applyResult");
    assert.equal(applyErrorEvent.payload?.ok, false, "apply missing proposal should fail");
    assert.ok(
      String(applyErrorEvent.payload?.error ?? "").includes("提案が見つかりません"),
      "apply missing proposal should include expected error message"
    );

    // Apply conflict check (proposal stale)
    await fs.writeFile(path.join(workspacePath, "conflict-target.tex"), "before\n", "utf8");
    const conflictProposeResult = await callTool("propose_write", {
      path: "conflict-target.tex",
      content: "after\n",
      summary: "conflict test",
    });
    const conflictProposal = getProposalFromResult(service, conflictProposeResult);
    assert.ok(conflictProposal, "conflict proposal should exist");
    await fs.writeFile(path.join(workspacePath, "conflict-target.tex"), "changed externally\n", "utf8");
    await service.applyProposal(conflictProposal.proposalId);
    const conflictApplyEvent = rendererEvents
      .filter((entry) => entry.channel === "agent:applyResult")
      .at(-1);
    assert.ok(conflictApplyEvent, "conflict apply should emit agent:applyResult");
    assert.equal(conflictApplyEvent.payload?.ok, false, "conflict apply should fail");
    assert.equal(conflictApplyEvent.payload?.conflict, true, "conflict flag should be true");
    const conflictText = await fs.readFile(path.join(workspacePath, "conflict-target.tex"), "utf8");
    assert.equal(conflictText, "changed externally\n", "stale proposal must not overwrite newer file");

    // Undo last apply
    const undoWriteResult = await callTool("propose_write", {
      path: "undo-target.tex",
      content: "undo content\n",
      summary: "undo test",
    });
    const undoWriteProposal = getProposalFromResult(service, undoWriteResult);
    assert.ok(undoWriteProposal, "undo proposal should exist");
    await service.applyProposal(undoWriteProposal.proposalId);
    await service.undoLastApply("tool-coverage");
    const undoEvent = rendererEvents
      .filter((entry) => entry.channel === "agent:undoResult")
      .at(-1);
    assert.ok(undoEvent, "undo should emit agent:undoResult");
    assert.equal(undoEvent.payload?.ok, true, "undo should succeed");
    const undoTargetExists = await fs
      .access(path.join(workspacePath, "undo-target.tex"))
      .then(() => true)
      .catch(() => false);
    assert.equal(undoTargetExists, false, "undo should remove newly created file");

    const declaredToolNames = AGENT_TOOL_DECLARATIONS.map((entry) => entry.name).sort();
    const coveredToolNames = Array.from(covered).sort();
    assert.deepEqual(
      coveredToolNames,
      declaredToolNames,
      "tool coverage mismatch: declared tool was not executed"
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          coveredTools: coveredToolNames.length,
          errorChecks,
          tools: coveredToolNames,
        },
        null,
        2
      )
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

await run();
