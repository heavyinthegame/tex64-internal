window.addEventListener("DOMContentLoaded", () => {
  requestAnimationFrame(() => {
    document.body.classList.add("is-ready");
  });

  type TabKey = "files" | "outline" | "blocks" | "git" | "search" | "settings";

  const tabConfig: Record<
    TabKey,
    {
      label: string;
      outline: string;
      title: string;
      desc: string;
      hint: string;
    }
  > = {
    files: {
      label: "ファイル",
      outline: "ミニアウトライン: main.tex",
      title: "編集エリア",
      desc: "Monacoで編集します。",
      hint: "ファイルタブが選択されています。",
    },
    outline: {
      label: "アウトライン",
      outline: "ラベル / 参考文献",
      title: "アウトライン",
      desc: "ラベルと参考文献キーを一覧で表示します。",
      hint: "クリックで定義に移動します。",
    },
    blocks: {
      label: "ブロック",
      outline: "ブロック一覧",
      title: "ブロック",
      desc: "数式と表をブロックとして挿入します。",
      hint: "プレビュー後に確定します。",
    },
    git: {
      label: "Git",
      outline: "Gitステータス",
      title: "Git",
      desc: "変更ファイルの一覧を表示します。",
      hint: "更新で再取得します。",
    },
    search: {
      label: "検索",
      outline: "検索結果",
      title: "検索",
      desc: "ワークスペース内を検索します。",
      hint: "Enterで検索できます。",
    },
    settings: {
      label: "設定",
      outline: "設定",
      title: "設定",
      desc: "最低限の設定を表示します。",
      hint: "自動ビルドはここでも切替可能です。",
    },
  };

  let monacoEditor: unknown = null;
  let monacoApi: Record<string, unknown> | null = null;
  let quickInsertDecorations: string[] = [];
  let quickInsertWidget: {
    getId: () => string;
    getDomNode: () => HTMLElement;
    getPosition: () => unknown;
  } | null = null;
  let quickInsertWidgetNode: HTMLDivElement | null = null;
  let quickInsertWidgetBody: HTMLPreElement | null = null;
  let quickInsertTarget = { lineNumber: 1, column: 1 };

  const tabs = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".tab[data-tab]")
  );
  const miniOutline = document.getElementById("mini-outline");
  const editorStatus = document.getElementById("editor-status");
  const editorTitle = document.getElementById("editor-title");
  const editorDesc = document.getElementById("editor-desc");
  const editorHint = document.getElementById("editor-hint");
  const quickInsertButton = document.getElementById("quick-insert-button");
  const quickInsertPanel = document.getElementById("quick-insert");
  const quickInsertTargetLabel = document.getElementById("quick-target");
  const quickInsertInput = document.getElementById("quick-input");
  const quickInsertHint = document.getElementById("quick-hint");
  const quickInsertAccept = document.getElementById("quick-accept");
  const quickInsertCancel = document.getElementById("quick-cancel");
  const buildButton = document.getElementById("build-button");
  const autoBuildButton = document.getElementById("auto-build-button");
  const issuesCount = document.getElementById("issues-count");
  const issuesHint = document.getElementById("issues-hint");
  const issuesBar = document.getElementById("issues-bar");
  const issuesPanel = document.getElementById("issues-panel");
  const issuesList = document.getElementById("issues-list");
  const issuesEmpty = document.getElementById("issues-empty");
  const issuesClose = document.getElementById("issues-close");
  const breadcrumbs = document.getElementById("breadcrumbs");
  const sidebarPanels = Array.from(
    document.querySelectorAll<HTMLElement>(".panel[data-panel]")
  );
  const outlineEmpty = document.getElementById("outline-empty");
  const outlineLabels = document.getElementById("outline-labels");
  const outlineCitations = document.getElementById("outline-citations");
  const workspaceLabel = document.getElementById("workspace-label");
  const fileTree = document.getElementById("file-tree");
  const newFileButton = document.getElementById("new-file-button");
  const newFolderButton = document.getElementById("new-folder-button");
  const saveFileButton = document.getElementById("save-file-button");
  const blockToggleButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".block-toggle-button")
  );
  const blockForms = Array.from(
    document.querySelectorAll<HTMLElement>(".block-form")
  );
  const blockTarget = document.getElementById("block-target");
  const blockMathInput = document.getElementById("block-math-input");
  const blockTableRows = document.getElementById("block-table-rows");
  const blockTableCols = document.getElementById("block-table-cols");
  const blockPreviewButton = document.getElementById("block-preview-button");
  const blockAcceptButton = document.getElementById("block-accept-button");
  const blockCancelButton = document.getElementById("block-cancel-button");
  const blockList = document.getElementById("block-list");
  const searchInput = document.getElementById("search-input");
  const searchButton = document.getElementById("search-button");
  const searchResults = document.getElementById("search-results");
  const gitStatus = document.getElementById("git-status");
  const gitRefreshButton = document.getElementById("git-refresh");
  const settingsAutoBuildButton = document.getElementById("settings-auto-build");
  const settingsWorkspace = document.getElementById("settings-workspace");

  const setText = (element: HTMLElement | null, text: string) => {
    if (element) {
      element.textContent = text;
    }
  };

  type BuildState = "idle" | "building" | "success" | "failed";
  type IssuesStatus = "success" | "error" | "info";
  type IssueItem = { severity: "error" | "warning"; message: string; line?: number };
  type IndexEntry = { key: string; path: string; line: number };
  type BlockType = "math" | "table";
  type BlockContent = { formula?: string; rows?: number; cols?: number };
  type BlockMeta = {
    id: string;
    type: BlockType;
    file: string;
    line: number;
    column: number;
    snippet: string;
    content: BlockContent;
    deps: string[];
    updatedAt: string;
  };
  type SearchResult = { path: string; line: number; preview: string };
  type GitEntry = { status: string; path: string };
  type FileNode = { name: string; path: string; type: "file" | "dir"; children: FileNode[] };

  type WebkitHandler = { postMessage: (message: unknown) => void };
  type WebkitBridge = { messageHandlers?: { tex180?: WebkitHandler } };
  type BridgeWindow = Window &
    typeof globalThis & {
      webkit?: WebkitBridge;
      tex180SetBuildState?: (payload: { state: BuildState; message?: string }) => void;
      tex180UpdateIssues?: (payload: {
        count: number;
        summary: string;
        status?: IssuesStatus;
        issues?: IssueItem[];
      }) => void;
      tex180UpdateWorkspace?: (payload: {
        rootName: string;
        rootPath: string;
        files: string[];
      }) => void;
      tex180UpdateIndex?: (payload: {
        labels: IndexEntry[];
        references?: IndexEntry[];
        citations: IndexEntry[];
      }) => void;
      tex180UpdateBlocks?: (payload: { blocks: BlockMeta[] }) => void;
      tex180UpdateSearch?: (payload: {
        query: string;
        results: SearchResult[];
        message?: string;
      }) => void;
      tex180UpdateGit?: (payload: { entries: GitEntry[]; message?: string }) => void;
      tex180OpenFileResult?: (payload: { path: string; content?: string; error?: string }) => void;
      tex180SaveResult?: (payload: { path: string; ok: boolean; error?: string }) => void;
    };

  const bridgeWindow = window as BridgeWindow;

  const setIssuesStatus = (status: IssuesStatus) => {
    if (issuesBar instanceof HTMLElement) {
      issuesBar.dataset.status = status;
    }
  };

  let currentIssues: IssueItem[] = [];
  let issuesOpen = false;
  let issueDecorations: string[] = [];
  let indexLabels: IndexEntry[] = [];
  let indexCitations: IndexEntry[] = [];
  let jumpDecorations: string[] = [];
  let pendingReveal: { path: string; line: number } | null = null;
  let completionRegistered = false;
  let workspaceFiles: string[] = [];
  let workspaceName = "ワークスペース未選択";
  let workspaceRootKey: string | null = null;
  let openFolders = new Set<string>();
  let openStateLoaded = false;
  let currentFilePath: string | null = null;
  let isDirty = false;
  let isApplyingFile = false;
  let pendingSave:
    | { path: string; resolve: (ok: boolean) => void; reject: (message: string) => void }
    | null = null;
  let blocks: BlockMeta[] = [];
  let activeBlockType: BlockType = "math";
  let blockPreviewActive = false;
  let activeBlockEditId: string | null = null;
  let activeBlockRange:
    | { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
    | null = null;
  let pendingBlockEdit: BlockMeta | null = null;
  let autoBuildEnabled = false;
  let autoBuildPending = false;
  let searchResultsData: SearchResult[] = [];
  let searchMessage = "検索結果はここに表示します。";
  let lastSearchQuery = "";
  let gitEntries: GitEntry[] = [];
  let gitMessage = "Gitステータスはここに表示します。";

  const setIssuesOpen = (open: boolean) => {
    issuesOpen = open;
    if (issuesPanel instanceof HTMLElement) {
      issuesPanel.classList.toggle("is-open", open);
      issuesPanel.setAttribute("aria-hidden", open ? "false" : "true");
    }
    if (issuesBar instanceof HTMLElement) {
      issuesBar.setAttribute("aria-expanded", open ? "true" : "false");
    }
  };

  const clearIssueHighlight = () => {
    if (!monacoEditor || issueDecorations.length === 0) {
      return;
    }
    const editor = monacoEditor as {
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
    };
    issueDecorations = editor.deltaDecorations(issueDecorations, []);
  };

  const focusIssue = (issue: IssueItem) => {
    if (!monacoEditor || !monacoApi || !issue.line) {
      return;
    }
    const monacoApiAny = monacoApi as {
      Range: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
    };
    const editor = monacoEditor as {
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
      revealLineInCenter: (lineNumber: number) => void;
      setPosition: (position: { lineNumber: number; column: number }) => void;
      focus: () => void;
    };
    const className =
      issue.severity === "warning" ? "issue-line-warning" : "issue-line-highlight";
    issueDecorations = editor.deltaDecorations(issueDecorations, [
      {
        range: new monacoApiAny.Range(issue.line, 1, issue.line, 1),
        options: {
          isWholeLine: true,
          className,
        },
      },
    ]);
    editor.revealLineInCenter(issue.line);
    editor.setPosition({ lineNumber: issue.line, column: 1 });
    editor.focus();
  };

  const clearJumpHighlight = () => {
    if (!monacoEditor || jumpDecorations.length === 0) {
      return;
    }
    const editor = monacoEditor as {
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
    };
    jumpDecorations = editor.deltaDecorations(jumpDecorations, []);
  };

  const revealLine = (line: number) => {
    if (!monacoEditor || !monacoApi) {
      return;
    }
    clearJumpHighlight();
    const monacoApiAny = monacoApi as {
      Range: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
    };
    const editor = monacoEditor as {
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
      revealLineInCenter: (lineNumber: number) => void;
      setPosition: (position: { lineNumber: number; column: number }) => void;
      focus: () => void;
    };
    jumpDecorations = editor.deltaDecorations(jumpDecorations, [
      {
        range: new monacoApiAny.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: "jump-line-highlight",
        },
      },
    ]);
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
  };

  const renderIssues = (issues: IssueItem[]) => {
    currentIssues = issues;
    if (!(issuesList instanceof HTMLElement) || !(issuesEmpty instanceof HTMLElement)) {
      return;
    }
    issuesList.innerHTML = "";
    if (issues.length === 0) {
      issuesList.style.display = "none";
      issuesEmpty.style.display = "block";
      return;
    }
    issuesEmpty.style.display = "none";
    issuesList.style.display = "grid";
    issues.forEach((issue) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "issue-item";
      item.dataset.severity = issue.severity;

      const message = document.createElement("div");
      message.className = "issue-message";
      message.textContent = issue.message;

      const meta = document.createElement("div");
      meta.className = "issue-meta";

      const severity = document.createElement("span");
      severity.textContent = issue.severity === "warning" ? "警告" : "エラー";
      meta.appendChild(severity);

      if (issue.line) {
        const line = document.createElement("span");
        line.className = "issue-line";
        line.textContent = `行 ${issue.line}`;
        meta.appendChild(line);
      }

      item.append(message, meta);
      item.addEventListener("click", () => {
        focusIssue(issue);
      });
      issuesList.appendChild(item);
    });
  };

  const dedupeByKey = (entries: IndexEntry[]) => {
    const map = new Map<string, IndexEntry>();
    entries.forEach((entry) => {
      if (!map.has(entry.key)) {
        map.set(entry.key, entry);
      }
    });
    return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key, "ja"));
  };

  const pickCitationEntries = () => {
    const bibEntries = indexCitations.filter((entry) => entry.path.endsWith(".bib"));
    if (bibEntries.length > 0) {
      return dedupeByKey(bibEntries);
    }
    return dedupeByKey(indexCitations);
  };

  const renderOutlineList = (
    container: HTMLElement,
    entries: IndexEntry[]
  ) => {
    container.innerHTML = "";
    if (entries.length === 0) {
      return;
    }
    entries.forEach((entry) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "outline-item";

      const key = document.createElement("div");
      key.textContent = entry.key;
      const meta = document.createElement("div");
      meta.className = "outline-meta";
      meta.textContent = `${entry.path} · 行 ${entry.line}`;

      item.append(key, meta);
      item.addEventListener("click", () => {
        jumpToLocation(entry);
      });
      container.appendChild(item);
    });
  };

  const renderOutline = () => {
    if (!(outlineLabels instanceof HTMLElement) || !(outlineCitations instanceof HTMLElement)) {
      return;
    }
    const labelEntries = dedupeByKey(indexLabels);
    const citationEntries = pickCitationEntries();

    renderOutlineList(outlineLabels, labelEntries);
    renderOutlineList(outlineCitations, citationEntries);

    if (outlineEmpty instanceof HTMLElement) {
      const hasItems = labelEntries.length > 0 || citationEntries.length > 0;
      outlineEmpty.classList.toggle("is-hidden", hasItems);
      if (!hasItems) {
        outlineEmpty.textContent =
          workspaceRootKey === null
            ? "ワークスペースが未選択です。"
            : "インデックス項目が見つかりません。";
      }
    }
  };

  const setActiveBlockType = (type: BlockType) => {
    activeBlockType = type;
    blockToggleButtons.forEach((button) => {
      const isActive = button.dataset.block === type;
      button.classList.toggle("is-active", isActive);
    });
    blockForms.forEach((form) => {
      const isActive = form.dataset.form === type;
      form.classList.toggle("is-active", isActive);
    });
    if (blockPreviewActive) {
      refreshBlockPreview();
    }
  };

  const buildMathSnippet = (formula: string) => {
    const trimmed = formula.trim();
    if (!trimmed) {
      return "";
    }
    return ["\\\\[", trimmed, "\\\\]", ""].join("\n");
  };

  const parseTableSize = () => {
    const rows =
      blockTableRows instanceof HTMLInputElement
        ? Number.parseInt(blockTableRows.value, 10)
        : NaN;
    const cols =
      blockTableCols instanceof HTMLInputElement
        ? Number.parseInt(blockTableCols.value, 10)
        : NaN;
    if (!Number.isFinite(rows) || rows < 1 || rows > 20) {
      return null;
    }
    if (!Number.isFinite(cols) || cols < 1 || cols > 12) {
      return null;
    }
    return { rows, cols };
  };

  const buildTableSnippet = (rows: number, cols: number) => {
    const columnSpec = `|${"c|".repeat(cols)}`;
    const rowCells = Array.from({ length: cols }, () => " ").join(" & ");
    const lines: string[] = [];
    lines.push(`\\\\begin{tabular}{${columnSpec}}`);
    for (let row = 0; row < rows; row += 1) {
      lines.push("\\\\hline");
      lines.push(`${rowCells} \\\\`);
    }
    lines.push("\\\\hline");
    lines.push("\\\\end{tabular}");
    lines.push("");
    return lines.join("\n");
  };

  const getBlockDraft = (): { snippet: string; content: BlockContent } | null => {
    if (activeBlockType === "math") {
      const formula =
        blockMathInput instanceof HTMLTextAreaElement ? blockMathInput.value : "";
      const snippet = buildMathSnippet(formula);
      if (!snippet.trim()) {
        return null;
      }
      return { snippet, content: { formula: formula.trim() } };
    }
    const size = parseTableSize();
    if (!size) {
      return null;
    }
    return {
      snippet: buildTableSnippet(size.rows, size.cols),
      content: { rows: size.rows, cols: size.cols },
    };
  };

  const refreshBlockPreview = () => {
    if (!blockPreviewActive) {
      return;
    }
    const draft = getBlockDraft();
    if (!draft) {
      setInsertPreviewText("");
      return;
    }
    setInsertPreviewText(draft.snippet);
  };

  const resetBlockSession = () => {
    blockPreviewActive = false;
    activeBlockEditId = null;
    activeBlockRange = null;
    pendingBlockEdit = null;
    clearInsertPreview();
    setText(blockTarget, "挿入先: 行 -");
  };

  const renderBlocksList = () => {
    if (!(blockList instanceof HTMLElement)) {
      return;
    }
    blockList.innerHTML = "";
    if (blocks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "panel-placeholder";
      empty.textContent = "ブロックはまだありません。";
      blockList.appendChild(empty);
      return;
    }
    const sorted = [...blocks].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    sorted.forEach((block) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "block-item";

      const title = document.createElement("div");
      title.textContent = block.type === "math" ? "数式" : "表";
      const meta = document.createElement("div");
      meta.className = "block-item-meta";
      meta.textContent = `${block.file} · 行 ${block.line}`;

      item.append(title, meta);
      item.addEventListener("click", () => {
        startBlockEdit(block);
      });
      blockList.appendChild(item);
    });
  };

  const saveBlocks = () => {
    if (!workspaceRootKey) {
      updateIssues(1, "起動時にフォルダを選択してください。", "error", [
        { severity: "error", message: "起動時にフォルダを選択してください。" },
      ]);
      return;
    }
    postToNative({ type: "saveBlocks", blocks });
  };

  const prepareBlockEdit = (block: BlockMeta) => {
    if (!monacoEditor) {
      return;
    }
    const editor = monacoEditor as { getModel?: () => unknown };
    const model = editor.getModel?.() as {
      findMatches?: (
        searchString: string,
        searchOnlyEditableRange: boolean,
        isRegex: boolean,
        matchCase: boolean,
        wordSeparators: string | null,
        captureMatches: boolean,
        limitResultCount: number
      ) => { range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } }[];
    };

    if (!model?.findMatches) {
      updateIssues(1, "ブロックの検索に失敗しました。", "error", [
        { severity: "error", message: "ブロックの検索に失敗しました。" },
      ]);
      return;
    }

    const matches = model.findMatches(block.snippet, false, false, false, null, true, 1);
    if (!matches || matches.length === 0) {
      updateIssues(1, "ブロックの本文が見つかりません。", "error", [
        { severity: "error", message: "ブロックの本文が見つかりません。" },
      ]);
      return;
    }

    const range = matches[0].range;
    activeBlockRange = {
      startLineNumber: range.startLineNumber,
      startColumn: range.startColumn,
      endLineNumber: range.endLineNumber,
      endColumn: range.endColumn,
    };

    const draft = getBlockDraft();
    if (!draft) {
      return;
    }
    startBlockPreview(draft.snippet, {
      lineNumber: range.startLineNumber,
      column: range.startColumn,
    });
  };

  const startBlockEdit = (block: BlockMeta) => {
    activeBlockEditId = block.id;
    if (block.type === "math") {
      if (blockMathInput instanceof HTMLTextAreaElement) {
        blockMathInput.value = block.content.formula ?? "";
      }
    } else {
      if (blockTableRows instanceof HTMLInputElement && block.content.rows) {
        blockTableRows.value = String(block.content.rows);
      }
      if (blockTableCols instanceof HTMLInputElement && block.content.cols) {
        blockTableCols.value = String(block.content.cols);
      }
    }
    setActiveBlockType(block.type);
    setText(blockTarget, `${block.file} · 行 ${block.line}`);

    if (currentFilePath === block.file) {
      prepareBlockEdit(block);
      return;
    }

    pendingBlockEdit = block;
    const requested = requestOpenFile(block.file);
    if (!requested) {
      pendingBlockEdit = null;
    }
  };

  const renderSearchResults = () => {
    if (!(searchResults instanceof HTMLElement)) {
      return;
    }
    searchResults.innerHTML = "";
    if (searchResultsData.length === 0) {
      const empty = document.createElement("div");
      empty.className = "panel-placeholder";
      empty.textContent = searchMessage;
      searchResults.appendChild(empty);
      return;
    }
    searchResultsData.forEach((result) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "search-item";

      const preview = document.createElement("div");
      preview.textContent = result.preview;
      const meta = document.createElement("div");
      meta.className = "search-item-meta";
      meta.textContent = `${result.path} · 行 ${result.line}`;

      item.append(preview, meta);
      item.addEventListener("click", () => {
        jumpToSearchResult(result);
      });
      searchResults.appendChild(item);
    });
  };

  const handleSearchUpdate = (payload: {
    query: string;
    results?: SearchResult[];
    message?: string;
  }) => {
    lastSearchQuery = payload.query;
    searchResultsData = Array.isArray(payload.results) ? payload.results : [];
    if (payload.message) {
      searchMessage = payload.message;
    } else if (searchResultsData.length === 0) {
      searchMessage =
        lastSearchQuery.trim().length === 0
          ? "検索語を入力してください。"
          : "一致する結果がありません。";
    }
    renderSearchResults();
  };

  const renderGitStatus = () => {
    if (!(gitStatus instanceof HTMLElement)) {
      return;
    }
    gitStatus.innerHTML = "";
    if (gitEntries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "panel-placeholder";
      empty.textContent = gitMessage;
      gitStatus.appendChild(empty);
      return;
    }
    gitEntries.forEach((entry) => {
      const item = document.createElement("div");
      item.className = "git-item";

      const title = document.createElement("div");
      title.textContent = `${entry.status}`;
      const meta = document.createElement("div");
      meta.className = "git-item-meta";
      meta.textContent = entry.path;

      item.append(title, meta);
      gitStatus.appendChild(item);
    });
  };

  const handleGitUpdate = (payload: { entries?: GitEntry[]; message?: string }) => {
    gitEntries = Array.isArray(payload.entries) ? payload.entries : [];
    if (payload.message) {
      gitMessage = payload.message;
    } else if (gitEntries.length === 0) {
      gitMessage = "変更はありません。";
    }
    renderGitStatus();
  };

  const requestSearch = (query: string) => {
    lastSearchQuery = query;
    if (!workspaceRootKey) {
      searchResultsData = [];
      searchMessage = "ワークスペースが未選択です。";
      renderSearchResults();
      return;
    }
    if (query.trim().length === 0) {
      searchResultsData = [];
      searchMessage = "検索語を入力してください。";
      renderSearchResults();
      return;
    }
    searchResultsData = [];
    searchMessage = "検索中...";
    renderSearchResults();
    postToNative({ type: "search", query });
  };

  const requestGitStatus = () => {
    if (!workspaceRootKey) {
      gitEntries = [];
      gitMessage = "ワークスペースが未選択です。";
      renderGitStatus();
      return;
    }
    gitMessage = "取得中...";
    renderGitStatus();
    postToNative({ type: "gitStatus" }, true);
  };

  const setWorkspaceLabel = (label: string) => {
    workspaceName = label;
    setText(workspaceLabel, label);
  };

  const autoBuildKey = () => {
    if (!workspaceRootKey) {
      return null;
    }
    return `tex180.autoBuild.${workspaceRootKey}`;
  };

  const updateAutoBuildUI = () => {
    if (autoBuildButton instanceof HTMLButtonElement) {
      autoBuildButton.disabled = false;
      autoBuildButton.classList.toggle("is-active", autoBuildEnabled);
      autoBuildButton.title = autoBuildEnabled ? "自動ビルド: ON" : "自動ビルド: OFF";
    }
    if (settingsAutoBuildButton instanceof HTMLButtonElement) {
      settingsAutoBuildButton.textContent = autoBuildEnabled ? "ON" : "OFF";
    }
  };

  const loadAutoBuildState = () => {
    const key = autoBuildKey();
    if (!key) {
      autoBuildEnabled = false;
      updateAutoBuildUI();
      return;
    }
    autoBuildEnabled = localStorage.getItem(key) === "true";
    updateAutoBuildUI();
  };

  const saveAutoBuildState = () => {
    const key = autoBuildKey();
    if (!key) {
      return;
    }
    localStorage.setItem(key, autoBuildEnabled ? "true" : "false");
  };

  const toggleAutoBuild = () => {
    autoBuildEnabled = !autoBuildEnabled;
    autoBuildPending = false;
    if (autoBuildEnabled && isDirty && currentFilePath?.endsWith(".tex")) {
      autoBuildPending = true;
    }
    saveAutoBuildState();
    updateAutoBuildUI();
  };

  const openStateKey = () => {
    if (!workspaceRootKey) {
      return null;
    }
    return `tex180.tree.${workspaceRootKey}`;
  };

  const loadOpenState = () => {
    openFolders = new Set<string>();
    const key = openStateKey();
    if (!key) {
      openStateLoaded = false;
      return;
    }
    const stored = localStorage.getItem(key);
    if (!stored) {
      openStateLoaded = false;
      return;
    }
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        parsed.forEach((entry) => {
          if (typeof entry === "string") {
            openFolders.add(entry);
          }
        });
      }
      openStateLoaded = true;
    } catch {
      openFolders = new Set<string>();
      openStateLoaded = false;
    }
  };

  const saveOpenState = () => {
    const key = openStateKey();
    if (!key) {
      return;
    }
    const data = JSON.stringify(Array.from(openFolders));
    localStorage.setItem(key, data);
    openStateLoaded = true;
  };

  const updateBreadcrumbs = () => {
    if (!(breadcrumbs instanceof HTMLElement)) {
      return;
    }
    const fileLabel = currentFilePath ?? "未選択";
    const dirtyMark = isDirty ? " ●" : "";
    breadcrumbs.textContent = `${fileLabel}${dirtyMark}`;
  };

  const updateMiniOutline = () => {
    if (!(miniOutline instanceof HTMLElement)) {
      return;
    }
    const fileLabel = currentFilePath ? currentFilePath.split("/").pop() : "未選択";
    miniOutline.textContent = `ミニアウトライン: ${fileLabel}`;
  };

  const sortNodes = (nodes: FileNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "dir" ? -1 : 1;
      }
      return a.name.localeCompare(b.name, "ja");
    });
    nodes.forEach((node) => {
      if (node.children.length > 0) {
        sortNodes(node.children);
      }
    });
  };

  const buildFileTree = (paths: string[]): FileNode[] => {
    const root: FileNode = { name: "", path: "", type: "dir", children: [] };
    paths.forEach((path) => {
      const parts = path.split("/").filter(Boolean);
      let cursor = root;
      parts.forEach((part, index) => {
        const isLast = index === parts.length - 1;
        let child = cursor.children.find((node) => node.name === part);
        if (!child) {
          const currentPath = parts.slice(0, index + 1).join("/");
          child = {
            name: part,
            path: currentPath,
            type: isLast ? "file" : "dir",
            children: [],
          };
          cursor.children.push(child);
        }
        if (!isLast) {
          child.type = "dir";
        }
        cursor = child;
      });
    });
    sortNodes(root.children);
    return root.children;
  };

  const setEditorLanguage = (path: string) => {
    if (!monacoApi || !monacoEditor) {
      return;
    }
    const editor = monacoEditor as { getModel?: () => unknown };
    if (!editor.getModel) {
      return;
    }
    const model = editor.getModel();
    const monacoApiAny = monacoApi as {
      editor?: { setModelLanguage?: (model: unknown, languageId: string) => void };
    };
    const languageId = path.endsWith(".tex")
      ? "latex"
      : path.endsWith(".bib")
        ? "bibtex"
        : "plaintext";
    if (model && monacoApiAny.editor?.setModelLanguage) {
      monacoApiAny.editor.setModelLanguage(model, languageId);
    }
  };

  const renderFileNodes = (nodes: FileNode[], container: HTMLElement, depth: number) => {
    nodes.forEach((node) => {
      if (node.type === "dir") {
        const details = document.createElement("details");
        details.className = "file-folder";
        details.dataset.path = node.path;
        if (openStateLoaded) {
          details.open = openFolders.has(node.path);
        } else {
          details.open = depth < 1;
        }
        const summary = document.createElement("summary");
        summary.textContent = node.name;
        summary.style.paddingLeft = `${6 + depth * 12}px`;
        const children = document.createElement("div");
        children.className = "file-folder-children";
        details.append(summary, children);
        details.addEventListener("toggle", () => {
          if (details.open) {
            openFolders.add(node.path);
          } else {
            openFolders.delete(node.path);
          }
          saveOpenState();
        });
        renderFileNodes(node.children, children, depth + 1);
        container.appendChild(details);
      } else {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "file-item";
        button.textContent = node.name;
        button.style.paddingLeft = `${18 + depth * 12}px`;
        button.dataset.path = node.path;
        if (node.path === currentFilePath) {
          button.classList.add("is-active");
          if (isDirty) {
            button.classList.add("is-dirty");
          }
        }
        button.addEventListener("click", () => {
          requestOpenFile(node.path);
        });
        container.appendChild(button);
      }
    });
  };

  const renderFileTree = () => {
    if (!(fileTree instanceof HTMLElement)) {
      return;
    }
    fileTree.innerHTML = "";
    if (workspaceFiles.length === 0) {
      const empty = document.createElement("div");
      empty.className = "panel-placeholder";
      empty.textContent =
        workspaceName === "ワークスペース未選択"
          ? "フォルダを開いてください。"
          : "ファイルが見つかりません。";
      fileTree.appendChild(empty);
      return;
    }
    const tree = buildFileTree(workspaceFiles);
    renderFileNodes(tree, fileTree, 0);
  };

  const applyFileContent = (path: string, content: string) => {
    if (!monacoEditor) {
      updateFallback("エディタの準備が完了していません。");
      return;
    }
    const editor = monacoEditor as { setValue: (value: string) => void };
    clearJumpHighlight();
    isApplyingFile = true;
    editor.setValue(content);
    isApplyingFile = false;
    currentFilePath = path;
    isDirty = false;
    setEditorLanguage(path);
    updateBreadcrumbs();
    updateMiniOutline();
    renderFileTree();
    blockPreviewActive = false;
    activeBlockRange = null;
    clearInsertPreview();
    if (!pendingBlockEdit) {
      setText(blockTarget, "挿入先: 行 -");
    }
    if (pendingReveal && pendingReveal.path === path) {
      revealLine(pendingReveal.line);
      pendingReveal = null;
    }
  };

  const requestOpenFile = (path: string) => {
    if (currentFilePath === path) {
      return false;
    }
    if (isDirty && currentFilePath) {
      const shouldDiscard = window.confirm(
        "未保存の変更があります。保存せずに切り替えますか？"
      );
      if (!shouldDiscard) {
        return false;
      }
    }
    const ok = postToNative({ type: "openFile", path });
    if (!ok) {
      updateIssues(1, "ファイルを開けません。", "error", [
        { severity: "error", message: "ファイルを開けません。" },
      ]);
    }
    return ok;
  };

  const jumpToFileLine = (path: string, line: number) => {
    if (currentFilePath === path) {
      revealLine(line);
      return;
    }
    const requested = requestOpenFile(path);
    if (requested) {
      pendingReveal = { path, line };
    }
  };

  const jumpToLocation = (entry: IndexEntry) => {
    if (!entry.path || !entry.line) {
      return;
    }
    jumpToFileLine(entry.path, entry.line);
  };

  const jumpToSearchResult = (result: SearchResult) => {
    jumpToFileLine(result.path, result.line);
  };

  const saveCurrentFile = () => {
    if (!currentFilePath || !monacoEditor) {
      updateIssues(1, "保存するファイルが選択されていません。", "error", [
        { severity: "error", message: "保存するファイルが選択されていません。" },
      ]);
      return Promise.resolve(false);
    }
    const editor = monacoEditor as { getValue: () => string };
    const content = editor.getValue();
    return new Promise<boolean>((resolve, reject) => {
      pendingSave = { path: currentFilePath as string, resolve, reject };
      const ok = postToNative({ type: "saveFile", path: currentFilePath, content });
      if (!ok) {
        pendingSave = null;
        reject("ネイティブ連携が利用できません。");
      }
    });
  };

  const normalizeInputPath = (value: string) => {
    return value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  };

  const validatePath = (value: string, kind: "file" | "folder") => {
    if (!value) {
      return "名前を入力してください。";
    }
    if (value.includes("..")) {
      return "親ディレクトリを含む名前は使えません。";
    }
    if (value.startsWith("/")) {
      return "絶対パスは使えません。";
    }
    if (kind === "file" && value.endsWith("/")) {
      return "ファイル名に末尾の / は使えません。";
    }
    return null;
  };

  const requestCreate = (kind: "file" | "folder") => {
    const title =
      kind === "file"
        ? "新規ファイル名を入力してください（例: chapter/intro.tex）"
        : "新規フォルダ名を入力してください（例: chapter）";
    const input = window.prompt(title);
    if (!input) {
      return;
    }
    const value = normalizeInputPath(input);
    const error = validatePath(value, kind);
    if (error) {
      updateIssues(1, error, "error", [{ severity: "error", message: error }]);
      return;
    }
    if (!workspaceRootKey) {
      updateIssues(1, "起動時にフォルダを選択してください。", "error", [
        { severity: "error", message: "起動時にフォルダを選択してください。" },
      ]);
      return;
    }
    const payload = { type: kind === "file" ? "createFile" : "createFolder", path: value };
    postToNative(payload);
  };

  const updateIssues = (
    count: number,
    summary: string,
    status: IssuesStatus,
    issues: IssueItem[]
  ) => {
    setText(issuesCount, String(count));
    setText(issuesHint, summary);
    setIssuesStatus(status);
    renderIssues(issues);
    if (count > 0) {
      setIssuesOpen(true);
    } else {
      setIssuesOpen(false);
      clearIssueHighlight();
    }
  };

  const setBuildState = (state: BuildState, message?: string) => {
    if (buildButton instanceof HTMLButtonElement) {
      const isBusy = state === "building";
      buildButton.disabled = isBusy;
      buildButton.classList.toggle("is-busy", isBusy);
      buildButton.textContent = isBusy ? "ビルド中..." : "ビルド";
    }
    if (message && state === "building") {
      updateIssues(0, message, "info", []);
    }
  };

  const postToNative = (
    payload: { type: string; [key: string]: unknown },
    silent = false
  ) => {
    const handler = bridgeWindow.webkit?.messageHandlers?.tex180;
    if (!handler) {
      if (!silent) {
        updateIssues(1, "ネイティブ連携が利用できません。", "error", [
          { severity: "error", message: "ネイティブ連携が利用できません。" },
        ]);
      }
      return false;
    }
    handler.postMessage(payload);
    return true;
  };

  const startBuild = () => {
    const mainFile =
      currentFilePath && currentFilePath.endsWith(".tex")
        ? currentFilePath
        : undefined;
    const payload: { type: string; mainFile?: string } = { type: "build" };
    if (mainFile) {
      payload.mainFile = mainFile;
    }
    if (postToNative(payload)) {
      setBuildState("building");
      updateIssues(0, "ビルドを開始します。", "info", []);
    }
  };

  const handleWorkspaceUpdate = (payload: {
    rootName: string;
    rootPath: string;
    files: string[];
  }) => {
    workspaceFiles = payload.files;
    workspaceRootKey = payload.rootPath;
    setWorkspaceLabel(payload.rootName);
    setText(settingsWorkspace, payload.rootPath);
    loadOpenState();
    renderFileTree();
    updateBreadcrumbs();
    renderOutline();
    blocks = [];
    renderBlocksList();
    postToNative({ type: "loadBlocks" }, true);
    searchResultsData = [];
    searchMessage = "検索結果はここに表示します。";
    renderSearchResults();
    gitEntries = [];
    gitMessage = "Gitステータスはここに表示します。";
    renderGitStatus();
    autoBuildPending = false;
    loadAutoBuildState();
  };

  const handleIndexUpdate = (payload: {
    labels?: IndexEntry[];
    references?: IndexEntry[];
    citations?: IndexEntry[];
  }) => {
    indexLabels = Array.isArray(payload.labels) ? payload.labels : [];
    indexCitations = Array.isArray(payload.citations) ? payload.citations : [];
    renderOutline();
  };

  const handleBlocksUpdate = (payload: { blocks?: BlockMeta[] }) => {
    blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
    renderBlocksList();
  };

  const handleOpenFileResult = (payload: {
    path: string;
    content?: string;
    error?: string;
  }) => {
    if (payload.error) {
      if (pendingReveal && pendingReveal.path === payload.path) {
        pendingReveal = null;
      }
      updateIssues(1, payload.error, "error", [
        { severity: "error", message: payload.error },
      ]);
      return;
    }
    applyFileContent(payload.path, payload.content ?? "");
    if (pendingBlockEdit && pendingBlockEdit.file === payload.path) {
      const block = pendingBlockEdit;
      pendingBlockEdit = null;
      prepareBlockEdit(block);
    }
  };

  const handleSaveResult = (payload: { path: string; ok: boolean; error?: string }) => {
    if (pendingSave && pendingSave.path === payload.path) {
      if (payload.ok) {
        pendingSave.resolve(true);
      } else {
        pendingSave.reject(payload.error ?? "保存に失敗しました。");
      }
      pendingSave = null;
    }
    if (!payload.ok) {
      updateIssues(1, payload.error ?? "保存に失敗しました。", "error", [
        { severity: "error", message: payload.error ?? "保存に失敗しました。" },
      ]);
      return;
    }
    isDirty = false;
    updateBreadcrumbs();
    renderFileTree();
    if (autoBuildEnabled && autoBuildPending && currentFilePath?.endsWith(".tex")) {
      autoBuildPending = false;
      startBuild();
    }
  };

  const normalizeTabKey = (key: string | undefined): TabKey => {
    if (key && key in tabConfig) {
      return key as TabKey;
    }
    return "files";
  };

  const setActiveTab = (tabKey: TabKey) => {
    const config = tabConfig[tabKey];

    tabs.forEach((tab) => {
      const isActive = tab.dataset.tab === tabKey;
      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-selected", isActive ? "true" : "false");
    });

    document.body.dataset.activeTab = tabKey;
    sidebarPanels.forEach((panel) => {
      const isActive = panel.dataset.panel === tabKey;
      panel.classList.toggle("is-active", isActive);
    });
    setText(miniOutline, config.outline);
    setText(editorStatus, `タブ: ${config.label}`);
    setText(editorTitle, config.title);
    setText(editorDesc, config.desc);
    setText(editorHint, config.hint);
    if (tabKey === "files") {
      updateMiniOutline();
    }
    if (tabKey === "git") {
      requestGitStatus();
    }
  };

  const initialTab = normalizeTabKey(
    tabs.find((tab) => tab.classList.contains("is-active"))?.dataset.tab
  );
  setActiveTab(initialTab);
  setWorkspaceLabel(workspaceName);
  updateBreadcrumbs();
  renderFileTree();
  renderOutline();
  setActiveBlockType(activeBlockType);
  renderBlocksList();
  renderSearchResults();
  renderGitStatus();
  updateIssues(0, "ビルド結果はここに要約します。", "info", []);
  postToNative({ type: "ready" }, true);

  if (autoBuildButton instanceof HTMLButtonElement) {
    updateAutoBuildUI();
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      setActiveTab(normalizeTabKey(tab.dataset.tab));
    });
  });

  const editorHost = document.getElementById("editor");
  const fallback = document.getElementById("editor-fallback");

  const updateFallback = (message: string) => {
    if (!fallback) {
      return;
    }
    const body = fallback.querySelector("p");
    if (body) {
      body.textContent = message;
    }
  };

  const registerCompletionProvider = (monaco: {
    languages?: {
      register?: (config: { id: string }) => void;
      registerCompletionItemProvider?: (
        languageId: string,
        provider: {
          triggerCharacters?: string[];
          provideCompletionItems: (
            model: { getLineContent: (lineNumber: number) => string },
            position: { lineNumber: number; column: number }
          ) => { suggestions: unknown[] };
        }
      ) => void;
      CompletionItemKind?: { Reference?: number; Value?: number };
    };
    Range?: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
  }) => {
    if (completionRegistered || !monaco.languages?.registerCompletionItemProvider) {
      return;
    }
    monaco.languages.register?.({ id: "latex" });
    monaco.languages.register?.({ id: "bibtex" });

    const provideItems = (
      model: { getLineContent: (lineNumber: number) => string },
      position: { lineNumber: number; column: number }
    ) => {
      if (!currentFilePath || !currentFilePath.endsWith(".tex")) {
        return { suggestions: [] };
      }
      const line = model.getLineContent(position.lineNumber);
      const linePrefix = line.slice(0, Math.max(position.column - 1, 0));
      const refMatch = linePrefix.match(/\\ref\{([^}]*)$/);
      const citeMatch = linePrefix.match(/\\cite\{([^}]*)$/);

      let entries: IndexEntry[] = [];
      let partial = "";

      if (refMatch) {
        entries = dedupeByKey(indexLabels);
        partial = refMatch[1] ?? "";
      } else if (citeMatch) {
        entries = pickCitationEntries();
        const raw = citeMatch[1] ?? "";
        const parts = raw.split(",");
        partial = parts.length > 0 ? parts[parts.length - 1].trimStart() : "";
      } else {
        return { suggestions: [] };
      }

      const range = monaco.Range
        ? new monaco.Range(
            position.lineNumber,
            position.column - partial.length,
            position.lineNumber,
            position.column
          )
        : undefined;

      const kind =
        monaco.languages?.CompletionItemKind?.Reference ??
        monaco.languages?.CompletionItemKind?.Value ??
        17;

      const suggestions = entries.map((entry) => ({
        label: entry.key,
        kind,
        insertText: entry.key,
        range,
        detail: entry.path,
      }));

      return { suggestions };
    };

    ["latex", "plaintext"].forEach((languageId) => {
      monaco.languages?.registerCompletionItemProvider?.(languageId, {
        triggerCharacters: ["{", ",", "\\"],
        provideCompletionItems: provideItems,
      });
    });

    completionRegistered = true;
  };

  const setQuickInsertOpen = (isOpen: boolean) => {
    if (quickInsertPanel) {
      quickInsertPanel.classList.toggle("is-open", isOpen);
      quickInsertPanel.setAttribute("aria-hidden", isOpen ? "false" : "true");
    }
    if (quickInsertButton instanceof HTMLElement) {
      quickInsertButton.classList.toggle("is-active", isOpen);
    }
  };

  const buildPreviewText = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return "プレビューなし";
    }
    const lines = trimmed.split(/\r?\n/);
    const maxLines = 6;
    if (lines.length <= maxLines) {
      return trimmed;
    }
    const visible = lines.slice(0, maxLines).join("\n");
    return `${visible}\n…（残り${lines.length - maxLines}行）`;
  };

  const clearInsertPreview = () => {
    clearQuickInsertDecorations();
    if (quickInsertWidget && monacoEditor) {
      const editor = monacoEditor as { removeContentWidget: (widget: unknown) => void };
      editor.removeContentWidget(quickInsertWidget);
      quickInsertWidget = null;
    }
  };

  const setInsertPreviewText = (text: string) => {
    const previewText = buildPreviewText(text);
    if (quickInsertWidgetBody) {
      quickInsertWidgetBody.textContent = previewText;
    }
    if (monacoEditor && quickInsertWidget) {
      const editor = monacoEditor as { layoutContentWidget: (widget: unknown) => void };
      editor.layoutContentWidget(quickInsertWidget);
    }
  };

  const updateQuickInsertPreview = () => {
    const value =
      quickInsertInput instanceof HTMLTextAreaElement
        ? quickInsertInput.value
        : "";
    setInsertPreviewText(value);
    if (quickInsertAccept instanceof HTMLButtonElement) {
      quickInsertAccept.disabled = value.trim().length === 0;
    }
  };

  const ensureQuickInsertWidget = () => {
    if (!monacoEditor || !monacoApi) {
      return;
    }
    if (!quickInsertWidgetNode) {
      const container = document.createElement("div");
      container.className = "quick-insert-preview";
      const title = document.createElement("div");
      title.className = "quick-insert-preview-title";
      title.textContent = "プレビュー";
      const body = document.createElement("pre");
      body.className = "quick-insert-preview-body";
      container.append(title, body);
      quickInsertWidgetNode = container;
      quickInsertWidgetBody = body;
    }
    if (!quickInsertWidget) {
      const monacoApiAny = monacoApi as {
        editor: { ContentWidgetPositionPreference: { ABOVE: number; BELOW: number } };
      };
      quickInsertWidget = {
        getId: () => "quick-insert-preview",
        getDomNode: () => quickInsertWidgetNode as HTMLDivElement,
        getPosition: () => ({
          position: {
            lineNumber: quickInsertTarget.lineNumber,
            column: quickInsertTarget.column,
          },
          preference: [
            monacoApiAny.editor.ContentWidgetPositionPreference.BELOW,
            monacoApiAny.editor.ContentWidgetPositionPreference.ABOVE,
          ],
        }),
      };
      const editor = monacoEditor as { addContentWidget: (widget: unknown) => void };
      editor.addContentWidget(quickInsertWidget);
    }
  };

  const startBlockPreview = (
    snippet: string,
    target?: { lineNumber: number; column: number }
  ) => {
    if (!monacoEditor || !monacoApi) {
      updateFallback("エディタの準備が完了していません。");
      return;
    }
    if (!currentFilePath || !currentFilePath.endsWith(".tex")) {
      updateIssues(1, "ブロックは .tex ファイルでのみ挿入できます。", "error", [
        { severity: "error", message: "ブロックは .tex ファイルでのみ挿入できます。" },
      ]);
      return;
    }
    closeQuickInsert();
    clearInsertPreview();
    const editor = monacoEditor as {
      getPosition: () => { lineNumber: number; column: number } | null;
    };
    const position = target ?? editor.getPosition();
    quickInsertTarget = position
      ? { lineNumber: position.lineNumber, column: position.column }
      : { lineNumber: 1, column: 1 };
    setText(blockTarget, `${currentFilePath} · 行 ${quickInsertTarget.lineNumber}`);
    applyQuickInsertDecorations();
    ensureQuickInsertWidget();
    setInsertPreviewText(snippet);
    blockPreviewActive = true;
  };

  const applyBlockInsert = () => {
    if (!blockPreviewActive) {
      updateIssues(1, "プレビューを確認してから確定してください。", "error", [
        { severity: "error", message: "プレビューを確認してから確定してください。" },
      ]);
      return;
    }
    const draft = getBlockDraft();
    if (!draft) {
      updateIssues(1, "ブロック内容が空です。", "error", [
        { severity: "error", message: "ブロック内容が空です。" },
      ]);
      return;
    }
    if (!monacoEditor || !monacoApi) {
      updateFallback("エディタの準備が完了していません。");
      return;
    }
    if (!currentFilePath || !currentFilePath.endsWith(".tex")) {
      updateIssues(1, "ブロックは .tex ファイルでのみ挿入できます。", "error", [
        { severity: "error", message: "ブロックは .tex ファイルでのみ挿入できます。" },
      ]);
      return;
    }

    const editor = monacoEditor as {
      executeEdits: (
        source: string,
        edits: { range: unknown; text: string; forceMoveMarkers: boolean }[]
      ) => void;
      focus: () => void;
      getPosition: () => { lineNumber: number; column: number } | null;
    };
    const monacoApiAny = monacoApi as {
      Range: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
    };

    let range: unknown;
    let line = quickInsertTarget.lineNumber;
    let column = quickInsertTarget.column;

    if (activeBlockEditId) {
      if (!activeBlockRange) {
        updateIssues(1, "ブロックの位置が見つかりません。", "error", [
          { severity: "error", message: "ブロックの位置が見つかりません。" },
        ]);
        return;
      }
      range = activeBlockRange;
      line = activeBlockRange.startLineNumber;
      column = activeBlockRange.startColumn;
    } else {
      range = new monacoApiAny.Range(line, column, line, column);
    }

    editor.executeEdits("block-insert", [
      {
        range,
        text: draft.snippet,
        forceMoveMarkers: true,
      },
    ]);
    editor.focus();

    const now = new Date().toISOString();
    if (activeBlockEditId) {
      const index = blocks.findIndex((item) => item.id === activeBlockEditId);
      if (index >= 0) {
        blocks[index] = {
          ...blocks[index],
          file: currentFilePath,
          line,
          column,
          snippet: draft.snippet,
          content: draft.content,
          updatedAt: now,
        };
      } else {
        blocks.push({
          id: activeBlockEditId,
          type: activeBlockType,
          file: currentFilePath,
          line,
          column,
          snippet: draft.snippet,
          content: draft.content,
          deps: [],
          updatedAt: now,
        });
      }
    } else {
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `block-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      blocks.push({
        id,
        type: activeBlockType,
        file: currentFilePath,
        line,
        column,
        snippet: draft.snippet,
        content: draft.content,
        deps: [],
        updatedAt: now,
      });
    }

    renderBlocksList();
    saveBlocks();
    resetBlockSession();
  };

  const applyQuickInsertDecorations = () => {
    if (!monacoEditor || !monacoApi) {
      return;
    }
    const monacoApiAny = monacoApi as {
      Range: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
    };
    const editor = monacoEditor as {
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
    };
    quickInsertDecorations = editor.deltaDecorations(quickInsertDecorations, [
      {
        range: new monacoApiAny.Range(
          quickInsertTarget.lineNumber,
          1,
          quickInsertTarget.lineNumber,
          1
        ),
        options: {
          isWholeLine: true,
          className: "quick-insert-line",
          glyphMarginClassName: "quick-insert-glyph",
        },
      },
    ]);
  };

  const clearQuickInsertDecorations = () => {
    if (!monacoEditor) {
      return;
    }
    const editor = monacoEditor as {
      deltaDecorations: (oldDecorations: string[], newDecorations: unknown[]) => string[];
    };
    quickInsertDecorations = editor.deltaDecorations(quickInsertDecorations, []);
  };

  const openQuickInsert = () => {
    if (!monacoEditor || !monacoApi) {
      updateFallback("エディタの準備が完了していません。");
      return;
    }
    resetBlockSession();
    const editor = monacoEditor as {
      getPosition: () => { lineNumber: number; column: number } | null;
      layoutContentWidget: (widget: unknown) => void;
    };
    const position = editor.getPosition();
    quickInsertTarget = position
      ? { lineNumber: position.lineNumber, column: position.column }
      : { lineNumber: 1, column: 1 };
    setText(quickInsertTargetLabel, `挿入先: 行 ${quickInsertTarget.lineNumber}`);
    setQuickInsertOpen(true);
    applyQuickInsertDecorations();
    ensureQuickInsertWidget();
    updateQuickInsertPreview();
    if (quickInsertInput instanceof HTMLTextAreaElement) {
      quickInsertInput.focus();
      quickInsertInput.select();
    }
  };

  const closeQuickInsert = () => {
    setQuickInsertOpen(false);
    clearInsertPreview();
    if (quickInsertInput instanceof HTMLTextAreaElement) {
      quickInsertInput.value = "";
    }
    updateQuickInsertPreview();
  };

  const acceptQuickInsert = () => {
    if (!monacoEditor || !monacoApi) {
      return;
    }
    const value =
      quickInsertInput instanceof HTMLTextAreaElement
        ? quickInsertInput.value
        : "";
    if (value.trim().length === 0) {
      if (quickInsertHint) {
        setText(quickInsertHint, "挿入内容が空のため確定できません。");
      }
      return;
    }
    const monacoApiAny = monacoApi as {
      Range: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
    };
    const editor = monacoEditor as {
      executeEdits: (
        source: string,
        edits: { range: unknown; text: string; forceMoveMarkers: boolean }[]
      ) => void;
      focus: () => void;
    };
    editor.executeEdits("quick-insert", [
      {
        range: new monacoApiAny.Range(
          quickInsertTarget.lineNumber,
          quickInsertTarget.column,
          quickInsertTarget.lineNumber,
          quickInsertTarget.column
        ),
        text: value,
        forceMoveMarkers: true,
      },
    ]);
    editor.focus();
    if (quickInsertHint) {
      setText(quickInsertHint, "確定しました。⌘Zで取り消せます。");
    }
    closeQuickInsert();
  };

  if (quickInsertButton instanceof HTMLButtonElement) {
    quickInsertButton.addEventListener("click", () => {
      const isOpen = quickInsertPanel?.classList.contains("is-open");
      if (isOpen) {
        closeQuickInsert();
      } else {
        if (quickInsertHint) {
          setText(quickInsertHint, "プレビュー中。確定後は⌘Zで取り消しできます。");
        }
        openQuickInsert();
      }
    });
  }

  if (quickInsertInput instanceof HTMLTextAreaElement) {
    quickInsertInput.addEventListener("input", () => {
      if (quickInsertHint) {
        setText(quickInsertHint, "プレビュー中。確定後は⌘Zで取り消しできます。");
      }
      ensureQuickInsertWidget();
      updateQuickInsertPreview();
    });
  }

  if (quickInsertCancel instanceof HTMLButtonElement) {
    quickInsertCancel.addEventListener("click", () => {
      closeQuickInsert();
    });
  }

  if (quickInsertAccept instanceof HTMLButtonElement) {
    quickInsertAccept.addEventListener("click", () => {
      acceptQuickInsert();
    });
  }

  blockToggleButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const type = button.dataset.block === "table" ? "table" : "math";
      setActiveBlockType(type);
    });
  });

  if (blockPreviewButton instanceof HTMLButtonElement) {
    blockPreviewButton.addEventListener("click", () => {
      const draft = getBlockDraft();
      if (!draft) {
        updateIssues(1, "ブロック内容を入力してください。", "error", [
          { severity: "error", message: "ブロック内容を入力してください。" },
        ]);
        return;
      }
      const target = activeBlockRange
        ? { lineNumber: activeBlockRange.startLineNumber, column: activeBlockRange.startColumn }
        : undefined;
      startBlockPreview(draft.snippet, target);
    });
  }

  if (blockAcceptButton instanceof HTMLButtonElement) {
    blockAcceptButton.addEventListener("click", () => {
      applyBlockInsert();
    });
  }

  if (blockCancelButton instanceof HTMLButtonElement) {
    blockCancelButton.addEventListener("click", () => {
      resetBlockSession();
    });
  }

  if (blockMathInput instanceof HTMLTextAreaElement) {
    blockMathInput.addEventListener("input", () => {
      refreshBlockPreview();
    });
  }

  if (blockTableRows instanceof HTMLInputElement) {
    blockTableRows.addEventListener("input", () => {
      refreshBlockPreview();
    });
  }

  if (blockTableCols instanceof HTMLInputElement) {
    blockTableCols.addEventListener("input", () => {
      refreshBlockPreview();
    });
  }

  if (autoBuildButton instanceof HTMLButtonElement) {
    autoBuildButton.addEventListener("click", () => {
      toggleAutoBuild();
    });
  }

  if (settingsAutoBuildButton instanceof HTMLButtonElement) {
    settingsAutoBuildButton.addEventListener("click", () => {
      toggleAutoBuild();
    });
  }

  if (searchButton instanceof HTMLButtonElement) {
    searchButton.addEventListener("click", () => {
      const value =
        searchInput instanceof HTMLInputElement ? searchInput.value.trim() : "";
      requestSearch(value);
    });
  }

  if (searchInput instanceof HTMLInputElement) {
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        requestSearch(searchInput.value.trim());
      }
    });
  }

  if (gitRefreshButton instanceof HTMLButtonElement) {
    gitRefreshButton.addEventListener("click", () => {
      requestGitStatus();
    });
  }

  if (newFileButton instanceof HTMLButtonElement) {
    newFileButton.addEventListener("click", () => {
      requestCreate("file");
    });
  }

  if (newFolderButton instanceof HTMLButtonElement) {
    newFolderButton.addEventListener("click", () => {
      requestCreate("folder");
    });
  }

  if (saveFileButton instanceof HTMLButtonElement) {
    saveFileButton.addEventListener("click", () => {
      saveCurrentFile().catch((message: string) => {
        updateIssues(1, message, "error", [{ severity: "error", message }]);
      });
    });
  }

  window.addEventListener("keydown", (event) => {
    if (event.metaKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveCurrentFile().catch((message: string) => {
        updateIssues(1, message, "error", [{ severity: "error", message }]);
      });
    }
  });

  if (buildButton instanceof HTMLButtonElement) {
    buildButton.addEventListener("click", () => {
      if (buildButton.disabled) {
        return;
      }
      if (isDirty && currentFilePath) {
        saveCurrentFile()
          .then((ok) => {
            if (ok) {
              startBuild();
            }
          })
          .catch((message: string) => {
            updateIssues(1, message, "error", [
              { severity: "error", message },
            ]);
          });
        return;
      }
      startBuild();
    });
  }

  if (issuesBar instanceof HTMLElement) {
    issuesBar.addEventListener("click", () => {
      if (currentIssues.length === 0) {
        return;
      }
      setIssuesOpen(!issuesOpen);
      if (!issuesOpen) {
        clearIssueHighlight();
      }
    });
    issuesBar.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (currentIssues.length === 0) {
          return;
        }
        setIssuesOpen(!issuesOpen);
        if (!issuesOpen) {
          clearIssueHighlight();
        }
      }
    });
  }

  if (issuesClose instanceof HTMLButtonElement) {
    issuesClose.addEventListener("click", () => {
      setIssuesOpen(false);
      clearIssueHighlight();
    });
  }

  bridgeWindow.tex180SetBuildState = (payload) => {
    setBuildState(payload.state, payload.message);
  };

  bridgeWindow.tex180UpdateIssues = (payload) => {
    const status =
      payload.status ?? (payload.count > 0 ? "error" : "success");
    updateIssues(payload.count, payload.summary, status, payload.issues ?? []);
  };

  bridgeWindow.tex180UpdateWorkspace = (payload) => {
    handleWorkspaceUpdate(payload);
  };

  bridgeWindow.tex180UpdateIndex = (payload) => {
    handleIndexUpdate(payload);
  };

  bridgeWindow.tex180UpdateBlocks = (payload) => {
    handleBlocksUpdate(payload);
  };

  bridgeWindow.tex180UpdateSearch = (payload) => {
    handleSearchUpdate(payload);
  };

  bridgeWindow.tex180UpdateGit = (payload) => {
    handleGitUpdate(payload);
  };

  bridgeWindow.tex180OpenFileResult = (payload) => {
    handleOpenFileResult(payload);
  };

  bridgeWindow.tex180SaveResult = (payload) => {
    handleSaveResult(payload);
  };

  if (!(editorHost instanceof HTMLElement)) {
    updateFallback("エディタ領域が見つかりません。");
    return;
  }

  const baseUrl = new URL("monaco/vs/", window.location.href).toString();
  const requireBase = baseUrl.replace(/\/$/, "");

  type RequireConfig = { paths: { vs: string } };
  type RequireFunction = ((
    deps: string[],
    onLoad: () => void,
    onError: () => void
  ) => void) & { config: (options: RequireConfig) => void };

  type MonacoWindow = Window &
    typeof globalThis & {
      MonacoEnvironment?: { getWorkerUrl: () => string };
      require?: RequireFunction;
      monaco?: {
        editor?: {
          create: (el: HTMLElement, options: Record<string, unknown>) => unknown;
        };
        languages?: {
          register?: (config: { id: string }) => void;
          registerCompletionItemProvider?: (
            languageId: string,
            provider: {
              triggerCharacters?: string[];
              provideCompletionItems: (
                model: { getLineContent: (lineNumber: number) => string },
                position: { lineNumber: number; column: number }
              ) => { suggestions: unknown[] };
            }
          ) => void;
          CompletionItemKind?: { Reference?: number; Value?: number };
        };
        Range?: new (line: number, column: number, endLine: number, endColumn: number) => unknown;
      };
    };

  const monacoWindow = window as MonacoWindow;

  monacoWindow.MonacoEnvironment = {
    getWorkerUrl: () => {
      const workerMain = `${baseUrl}base/worker/workerMain.js`;
      const workerBootstrap = [
        `self.MonacoEnvironment = { baseUrl: '${baseUrl}' };`,
        `importScripts('${workerMain}');`,
      ].join("\n");
      return URL.createObjectURL(
        new Blob([workerBootstrap], { type: "text/javascript" })
      );
    },
  };

  if (!monacoWindow.require || !monacoWindow.require.config) {
    updateFallback("Monacoのローダーが見つかりません。");
    return;
  }

  monacoWindow.require.config({ paths: { vs: requireBase } });
  monacoWindow.require(
    ["vs/editor/editor.main"],
    () => {
      if (!monacoWindow.monaco || !monacoWindow.monaco.editor) {
        updateFallback("Monacoの初期化に失敗しました。");
        return;
      }

      monacoApi = monacoWindow.monaco as Record<string, unknown>;
      registerCompletionProvider(monacoWindow.monaco);
      const editor = monacoWindow.monaco.editor.create(editorHost, {
        value: "",
        language: "latex",
        theme: "vs-dark",
        automaticLayout: true,
        glyphMargin: true,
        minimap: { enabled: false },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        fontFamily: '"SF Mono", Menlo, monospace',
        fontSize: 13,
        lineHeight: 20,
        scrollBeyondLastLine: false,
        wordWrap: "off",
      }) as {
        onDidChangeModelContent: (listener: () => void) => void;
      };
      monacoEditor = editor;

      editor.onDidChangeModelContent(() => {
        if (isApplyingFile) {
          return;
        }
        if (!currentFilePath) {
          return;
        }
        isDirty = true;
        if (autoBuildEnabled && currentFilePath.endsWith(".tex")) {
          autoBuildPending = true;
        }
        updateBreadcrumbs();
        renderFileTree();
      });

      document.body.classList.add("has-editor");
    },
    () => {
      updateFallback("Monacoの読み込みに失敗しました。");
    }
  );
});
