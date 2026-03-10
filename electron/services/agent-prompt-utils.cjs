const {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_READ_FILES,
  formatByteLimit,
  isBlockedPath,
  isTextExtension,
} = require("./agent-policy.cjs");
const { normalizeWorkspaceRelativePath } = require("./agent-core-utils.cjs");

const resolveResponseModel = (response) => {
  if (!response || typeof response !== "object") {
    return "";
  }
  const candidates = [
    response.resolvedModel,
    response.modelVersion,
    response.model,
    response.output?.model,
    response.usage?.model,
    response.usageMetadata?.model,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
};

const buildSystemPrompt = (context, rootPath, policy, options, extras = {}) => {
  const activeFilePath = context?.activeFilePath ?? "";
  const activeFileContentProvided = typeof context?.activeFileContent === "string";
  const activeFileContent =
    typeof context?.activeFileContent === "string" ? context.activeFileContent : "";
  const activeFileIsDirty = Boolean(context?.activeFileIsDirty);
  const activeFileContentTruncated = Boolean(context?.activeFileContentTruncated);
  const activeFileContentLength =
    typeof context?.activeFileContentLength === "number" ? context.activeFileContentLength : null;
  const openFiles = Array.isArray(context?.openFiles) ? context.openFiles : [];
  const openFileLabel = openFiles.length
    ? openFiles
        .map((entry) => {
          const dirty = entry.isDirty ? " *" : "";
          const active = entry.isActive ? " (active)" : "";
          return `${entry.path}${dirty}${active}`;
        })
        .join(", ")
    : "";
  const dirtyOpenCount = openFiles.filter((entry) => entry.isDirty).length;
  const blockedList = policy?.blockedTopLevel ? Array.from(policy.blockedTopLevel) : [];
  const allowedList = policy?.allowedTopLevel ? Array.from(policy.allowedTopLevel) : [];
  const blockedLabel = blockedList.length > 0 ? blockedList.join(" / ") : "(なし)";
  const allowedLabel = allowedList.length > 0 ? allowedList.join(" / ") : "";
  const fileSizeLabel = formatByteLimit(policy?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
  const readFilesLimit = policy?.maxReadFiles ?? DEFAULT_MAX_READ_FILES;
  const contextControls =
    context?.contextControls && typeof context.contextControls === "object"
      ? context.contextControls
      : null;
  const includeSelection =
    contextControls && typeof contextControls.includeSelection === "boolean"
      ? contextControls.includeSelection
      : false;
  const includeOpenFiles =
    contextControls && typeof contextControls.includeOpenFiles === "boolean"
      ? contextControls.includeOpenFiles
      : true;
  const includeIssues =
    contextControls && typeof contextControls.includeIssues === "boolean"
      ? contextControls.includeIssues
      : true;
  const explicitContextPaths = Array.isArray(context?.explicitContextPaths)
    ? context.explicitContextPaths.filter((entry) => typeof entry === "string" && entry.trim())
    : [];
  const rootFileInfo =
    extras?.rootFileInfo && typeof extras.rootFileInfo === "object" ? extras.rootFileInfo : null;
  const projectInstructions =
    typeof extras?.projectInstructions === "string" ? extras.projectInstructions.trim() : "";
  const agentMemory =
    typeof extras?.agentMemory === "string" ? extras.agentMemory.trim() : "";
  const scratchpadRaw = typeof extras?.scratchpad === "string" ? extras.scratchpad : "";
  const scratchpadLimit = 8000;
  const scratchpad =
    scratchpadRaw.length > scratchpadLimit
      ? scratchpadRaw.slice(scratchpadRaw.length - scratchpadLimit)
      : scratchpadRaw;
  const scratchpadTruncated = scratchpadRaw.length > scratchpad.length;

  const canIncludeContextForPath = (value) => {
    const normalized = normalizeWorkspaceRelativePath(rootPath, value);
    if (!normalized) {
      // When the file isn't on disk yet (unsaved buffer), allow snapshot.
      return !value;
    }
    if (normalized.startsWith("../")) {
      return false;
    }
    if (isBlockedPath(normalized, policy)) {
      return false;
    }
    if (!isTextExtension(normalized, policy)) {
      return false;
    }
    return true;
  };

  // --- Build document context block early so it appears near the top ---
  const documentContextLines = [];
  if (activeFileContentProvided && canIncludeContextForPath(activeFilePath)) {
    documentContextLines.push(
      "",
      `## 現在のドキュメント（${activeFilePath || "unknown"}）`,
      "以下はエディタで開いているファイルの内容です。執筆・編集指示ではこの内容からテーマ・構成・文体を判断してください。",
    );
    if (activeFileIsDirty) {
      documentContextLines.push("- 状態: 未保存の変更あり");
    }
    if (activeFileContentTruncated) {
      const fullLength = activeFileContentLength ?? activeFileContent.length;
      documentContextLines.push(`- 先頭${activeFileContent.length}文字のみ（全${fullLength}文字）`);
    }
    documentContextLines.push("```", activeFileContent, "```");
  }

  const lines = [
    "あなたは TeX64 に統合されたAI自律エージェントです。",
    "目的: ユーザーのLaTeX文書（論文/レポート等）を、壊さず・最小変更で・確実に前進させること。",
    "あなたは自律的に執筆するエージェントです。人間は承認するだけで、あなたが主体的に論文を書き進めます。",
    ...documentContextLines,
    "",
    "## ルール",
    "- ユーザーの最新の指示を最優先する（古い指示に引っ張られない）。",
    "- 編集が必要な場合は、必要な変更を即時適用して前進する。適用後は必要に応じて検証し、失敗時は修正を継続する。",
    "- **執筆/章生成では、必ず patch_file / replace_lines / write_file ツールを使って対象の .tex に直接書き込む。** チャットにLaTeXコードやドキュメント本文を出力してはならない。チャットは短い変更サマリのみ。",
    "- 引用は捏造しない。\\cite{...} を追加するなら既存の .bib/キーを確認し、必要なら search_web→read_url で根拠を取ってから追加する。",
    "- 変更は取り消せる前提で進める（やり直しが必要な場合は取り消し案も提示する）。",
    "- 内部の機能名/実装詳細（ツール名・関数名・型など）はユーザーに出さない。",
    "- 不変条件（数値/意味/編集範囲など）を厳守する。守れない場合は理由と代替案を2案以上出す。",
    "- 推測は推測と明記するが、確認質問は返さない。不明点はドキュメントを読んで自分で判断する。",
    "",
    "## 自律エージェントとしての行動原則",
    "- あなたは自律エージェントです。指示を受けたら、完了するまで自分で考え、調べ、書き、検証し続けます。",
    "- **質問を返さず、即座に行動する。** ユーザーはあなたに実行を求めている。選択肢の提示や確認は不要。",
    "- 執筆・章生成・加筆の指示があったら: Active file snapshot（エディタで開いているファイル）が既に提供されているので、まずそれを読んで文書の構造・テーマ・文体を把握し、自分の判断で書き始める。不足があれば read_file で関連ファイルも読む。テーマや内容についてユーザーに聞き返さない。",
    "- 情報が不足していると感じても、既存のドキュメントから推測して最善の結果を出す。質問するより、書いてから確認してもらう方がユーザーにとって速い。",
    "- 長いタスクは最初に計画を立てる: write_scratchpad に Plan（全体方針）/ Steps（段階）/ Done条件 を記録する。",
    "- 各ステップ完了ごとに scratchpad の進捗を更新する。これにより、中断・再開時も迷子にならない。",
    "- 中途半端な状態で終わらない: 執筆を始めたら、ビルドが通るまで責任を持って完了させる。",
    "",
    "## 進め方（重要）",
    "- まず状況把握: read_file / read_files で必要なファイルを読み、根拠を集める（一度に最大16ファイル）。search_files で検索も可。",
    "- 編集は最小差分で: patch_file（search/replace）か replace_lines（行指定）で正確に更新する。",
    "- 大きな新規セクション追加: write_file でファイル全体を書き出すか、replace_lines で挿入位置を特定して追記する。",
    "- 編集後は検証: run_build（autoBuildも走るが、必要なら明示的に実行）で必ず確認する。",
    "- ビルド失敗時は継続: issues を読み、修正→再ビルドを成功まで繰り返す。途中で止めない。",
    "- 章生成/改稿: Active file snapshot から既存の構成・文体・トーンを把握する。\\input で分割されている場合は関連ファイルも read_file で読む。既存構成（\\section 等）と文体を揃え、差し込み位置を特定してから .tex に直接反映する。ユーザーに「何を書くか」を聞き返さず、文脈から判断して書く。",
    "- Web調査が必要なら search_web → read_url で本文を読み、必要部分だけを根拠として使う。",
    "- 端末は execute_bash_command を優先（複雑なコマンド/パイプ/リダイレクト）。出力が途切れたら read_terminal_output を繰り返す。",
    "- Git管理されている場合は、変更確認に git status / git diff を execute_bash_command で使う。",
    "- 長いタスクは scratchpad を使う: Plan / 進捗 / Done条件 を write_scratchpad で更新し、迷子にならない。",
    "",
    `- ブロック対象: ${blockedLabel}${allowedLabel ? `（許可: ${allowedLabel}）` : ""}`,
    fileSizeLabel === "無制限"
      ? "- ファイルサイズ制限なし"
      : `- 1ファイル最大${fileSizeLabel}まで読み書き可能`,
    "",
    "## ワークスペース",
    `- Root: ${rootPath}`,
    rootFileInfo?.path
      ? `- Root main tex: ${rootFileInfo.path}${
          typeof rootFileInfo.source === "string" && rootFileInfo.source
            ? ` (${rootFileInfo.source})`
            : ""
        }`
      : "- Root main tex: (unknown)",
    `- Active file: ${activeFilePath || "(none)"}`,
    `- Context controls: selection=${includeSelection ? "on" : "off"}, openFiles=${
      includeOpenFiles ? "on" : "off"
    }, issues=${includeIssues ? "on" : "off"}`,
  ];

  if (explicitContextPaths.length > 0) {
    lines.push(`- User referenced files: ${explicitContextPaths.join(", ")}`);
  }

  if (projectInstructions) {
    const MAX_INSTRUCTIONS_CHARS = 8000;
    const trimmed =
      projectInstructions.length > MAX_INSTRUCTIONS_CHARS
        ? projectInstructions.slice(0, MAX_INSTRUCTIONS_CHARS) + "\n\n(以降省略)"
        : projectInstructions;
    lines.push("", "## Project Instructions (user-defined)", "```", trimmed, "```");
  }

  if (agentMemory) {
    const MAX_MEMORY_CHARS = 6000;
    const trimmedMemory =
      agentMemory.length > MAX_MEMORY_CHARS
        ? agentMemory.slice(0, MAX_MEMORY_CHARS) + "\n\n(以降省略)"
        : agentMemory;
    lines.push(
      "",
      "## Agent Memory (persistent across sessions)",
      "このメモリは `.tex64/agent-memory.md` に保存されており、セッション間で共有されます。",
      "ユーザーの好みや文体規約など、次回以降も覚えておくべき情報は write_file で `.tex64/agent-memory.md` に追記してください。",
      "```",
      trimmedMemory,
      "```"
    );
  } else {
    lines.push(
      "",
      "## Agent Memory",
      "- (empty) セッション間で記憶を残すには、`.tex64/agent-memory.md` に write_file で書き込んでください。",
      "- 例: ユーザーの文体の好み、略語規約、引用スタイルなど。"
    );
  }

  lines.push("", "## Scratchpad");
  if (scratchpad.trim()) {
    if (scratchpadTruncated) {
      lines.push("- Note: 末尾のみ抜粋（長すぎるため省略）");
    }
    lines.push("```", scratchpad, "```");
  } else {
    lines.push("- (empty) 長いタスクでは Plan / 進捗 / Done条件 を write_scratchpad で記録する。");
  }

  if (openFileLabel) {
    lines.push(`- Open files: ${openFileLabel}`);
    if (dirtyOpenCount > 0) {
      lines.push(`- Unsaved buffers: ${dirtyOpenCount}件`);
    }
  }

  // Active file snapshot is already included near the top of the prompt.
  // Only add a note here if it was omitted (blocked path or non-text).
  if (activeFileContentProvided && !canIncludeContextForPath(activeFilePath)) {
    lines.push("", "## Active file snapshot", "- Omitted (blocked path or non-text).");
  }

  const activeSelection =
    context?.activeSelection && typeof context.activeSelection === "object"
      ? context.activeSelection
      : null;
  if (
    includeSelection &&
    activeSelection &&
    typeof activeSelection.text === "string" &&
    activeSelection.text
  ) {
    const pathLabel =
      typeof activeSelection.path === "string" && activeSelection.path.trim()
        ? activeSelection.path.trim()
        : "(unknown)";
    const startLine =
      typeof activeSelection.startLine === "number" ? activeSelection.startLine : null;
    const startColumn =
      typeof activeSelection.startColumn === "number" ? activeSelection.startColumn : null;
    const endLine = typeof activeSelection.endLine === "number" ? activeSelection.endLine : null;
    const endColumn =
      typeof activeSelection.endColumn === "number" ? activeSelection.endColumn : null;
    const rangeLabel =
      startLine && startColumn && endLine && endColumn
        ? `${startLine}:${startColumn}-${endLine}:${endColumn}`
        : "(range unknown)";
    lines.push("", "## Active selection", `- File: ${pathLabel}`, `- Range: ${rangeLabel}`);
    if (canIncludeContextForPath(pathLabel)) {
      if (activeSelection.truncated) {
        const fullLength =
          typeof activeSelection.textLength === "number"
            ? activeSelection.textLength
            : activeSelection.text.length;
        lines.push(
          `- Selection note: 先頭${activeSelection.text.length}文字のみ（全${fullLength}文字）`
        );
      }
      lines.push("```", activeSelection.text, "```");
    } else {
      lines.push("- Omitted (blocked path or non-text).");
    }
  } else if (context?.activeSelectionRequested === true) {
    lines.push("", "## Active selection", "- Selection requested but no active selection was found.");
  }

  const openSnapshots = Array.isArray(context?.openFileSnapshots)
    ? context.openFileSnapshots
    : [];
  if (includeOpenFiles && openSnapshots.length > 0) {
    const seenPaths = new Set();
    const usableSnapshots = openSnapshots.filter((snapshot) => {
      if (!snapshot || typeof snapshot.path !== "string" || typeof snapshot.content !== "string") {
        return false;
      }
      if (snapshot.path === activeFilePath) {
        return false;
      }
      if (!canIncludeContextForPath(snapshot.path)) {
        return false;
      }
      if (seenPaths.has(snapshot.path)) {
        return false;
      }
      seenPaths.add(snapshot.path);
      return true;
    });
    if (usableSnapshots.length > 0) {
      lines.push("", "## Open file snapshots");
      usableSnapshots.forEach((snapshot) => {
        const dirtyLabel = snapshot.isDirty ? " (未保存)" : "";
        lines.push(`### ${snapshot.path}${dirtyLabel}`);
        if (snapshot.truncated) {
          const fullLength =
            typeof snapshot.contentLength === "number"
              ? snapshot.contentLength
              : snapshot.content.length;
          lines.push(`- Snapshot note: 先頭${snapshot.content.length}文字のみ（全${fullLength}文字）`);
        }
        lines.push("```", snapshot.content, "```");
      });
    }
  }

  const recentIssues = Array.isArray(context?.recentIssues) ? context.recentIssues : [];
  const recentIssueSummary =
    typeof context?.recentIssueSummary === "string" ? context.recentIssueSummary : "";
  const recentIssueStatus =
    typeof context?.recentIssueStatus === "string" ? context.recentIssueStatus : "";
  const recentIssuesUpdatedAt =
    typeof context?.recentIssuesUpdatedAt === "string" ? context.recentIssuesUpdatedAt : "";
  if (includeIssues && recentIssues.length > 0) {
    lines.push("", "## Recent issues");
    if (recentIssueSummary) {
      lines.push(`- Summary: ${recentIssueSummary}${recentIssueStatus ? ` (${recentIssueStatus})` : ""}`);
    }
    if (recentIssuesUpdatedAt) {
      lines.push(`- Updated: ${recentIssuesUpdatedAt}`);
    }
    recentIssues.forEach((issue) => {
      if (!issue || typeof issue.message !== "string") {
        return;
      }
      const location = issue.path
        ? `${issue.path}${issue.line ? `:${issue.line}` : ""}`
        : issue.line
        ? `line ${issue.line}`
        : "location unknown";
      const severity = issue.severity || "error";
      const resolution =
        typeof issue.resolution === "string" && issue.resolution.trim()
          ? ` / fix: ${issue.resolution.trim()}`
          : "";
      lines.push(`- [${severity}] ${issue.message} (${location})${resolution}`);
    });
  }

  lines.push(
    "",
    "必要に応じて情報を確認し、編集・検証・再修正を同一ラン内で完了させてください。変更は Undo で取り消せます。"
  );
  return lines.join("\n");
};

module.exports = {
  resolveResponseModel,
  buildSystemPrompt,
};
