import type {
  BuildState,
  BridgeWindow,
  GitActionResultPayload,
  GitDiffPayload,
  GitStatusPayload,
  IndexEntry,
  IssueItem,
  IssuesStatus,
  RootSource,
  SearchResult,
  SectionEntry,
} from "./types.js";

type BridgeHandlersDeps = {
  bridgeWindow: BridgeWindow;
  updateIssues: (
    count: number,
    summary: string,
    status: IssuesStatus,
    issues: IssueItem[]
  ) => void;
  handleWorkspaceUpdate: (payload: {
    rootName: string;
    rootPath: string;
    files: string[];
    folders?: string[];
    rootFile?: string;
    rootSource?: RootSource;
  }) => void;
  handleIndexUpdate: (payload: {
    labels?: IndexEntry[];
    references?: IndexEntry[];
    citations?: IndexEntry[];
    sections?: SectionEntry[];
    figures?: IndexEntry[];
    tables?: IndexEntry[];
    todos?: IndexEntry[];
  }) => void;
  handleLauncherStatus: (payload: { isBusy?: boolean; message?: string }) => void;
  search: {
    handleSearchUpdate: (payload: {
      query: string;
      results?: SearchResult[];
      message?: string;
    }) => void;
  };
  git: {
    handleUpdate: (payload: GitStatusPayload) => void;
    handleDiff: (payload: GitDiffPayload) => void;
    handleActionResult: (payload: GitActionResultPayload) => void;
  };
  build: {
    setBuildState: (state: BuildState, message?: string) => void;
    handleFormatResult: (payload: {
      path: string;
      ok: boolean;
      content?: string;
      error?: string;
      source?: string;
    }) => void;
    handleBuildLog: (log: string | null) => void;
    handleSynctexForwardResult: (payload: { ok?: boolean; error?: string }) => void;
  };
  editorSession: {
    handleOpenFileResult: (payload: {
      path: string;
      content?: string;
      error?: string;
      kind?: "text" | "image" | "pdf" | "unsupported";
      data?: string;
      mimeType?: string;
    }) => void;
    handleSaveResult: (payload: {
      path: string;
      ok: boolean;
      error?: string;
      content?: string;
      formatError?: string;
    }) => void;
    handleRenameResult: (payload: {
      oldPath: string;
      newPath: string;
      isDirectory: boolean;
    }) => void;
  };
};

export const initBridgeHandlers = (deps: BridgeHandlersDeps) => {
  const { bridgeWindow } = deps;

  bridgeWindow.tex180SetBuildState = (payload) => {
    deps.build.setBuildState(payload.state, payload.message);
  };

  bridgeWindow.tex180UpdateIssues = (payload) => {
    const status = payload.status ?? (payload.count > 0 ? "error" : "success");
    deps.updateIssues(payload.count, payload.summary, status, payload.issues ?? []);
  };

  bridgeWindow.tex180UpdateWorkspace = (payload) => {
    deps.handleWorkspaceUpdate(payload);
  };

  bridgeWindow.tex180UpdateIndex = (payload) => {
    deps.handleIndexUpdate(payload);
  };

  bridgeWindow.tex180UpdateSearch = (payload) => {
    deps.search.handleSearchUpdate(payload);
  };

  bridgeWindow.tex180UpdateGit = (payload) => {
    deps.git.handleUpdate(payload);
  };

  bridgeWindow.tex180UpdateGitDiff = (payload) => {
    deps.git.handleDiff(payload);
  };

  bridgeWindow.tex180UpdateGitActionResult = (payload) => {
    deps.git.handleActionResult(payload);
  };

  bridgeWindow.tex180OpenFileResult = (payload) => {
    deps.editorSession.handleOpenFileResult(payload);
  };

  bridgeWindow.tex180SaveResult = (payload) => {
    deps.editorSession.handleSaveResult(payload);
  };

  bridgeWindow.tex180FormatResult = (payload) => {
    deps.build.handleFormatResult(payload);
  };

  bridgeWindow.tex180RenameResult = (payload) => {
    deps.editorSession.handleRenameResult(payload);
  };

  const handleBridgeMessage = (message: { type?: string; payload?: unknown }) => {
    if (!message?.type) {
      return;
    }
    switch (message.type) {
      case "setBuildState":
        bridgeWindow.tex180SetBuildState?.(message.payload as {
          state: BuildState;
          message?: string;
        });
        break;
      case "updateIssues":
        bridgeWindow.tex180UpdateIssues?.(message.payload as {
          count: number;
          summary: string;
          status?: IssuesStatus;
          issues?: IssueItem[];
        });
        break;
      case "updateWorkspace":
        bridgeWindow.tex180UpdateWorkspace?.(message.payload as {
          rootName: string;
          rootPath: string;
          files: string[];
          folders?: string[];
          rootFile?: string;
          rootSource?: RootSource;
        });
        break;
      case "updateIndex":
        bridgeWindow.tex180UpdateIndex?.(message.payload as {
          labels: IndexEntry[];
          references?: IndexEntry[];
          citations: IndexEntry[];
          sections?: SectionEntry[];
          figures?: IndexEntry[];
          tables?: IndexEntry[];
          todos?: IndexEntry[];
        });
        break;
      case "updateSearch":
        bridgeWindow.tex180UpdateSearch?.(message.payload as {
          query: string;
          results: SearchResult[];
          message?: string;
        });
        break;
      case "updateGit":
        bridgeWindow.tex180UpdateGit?.(message.payload as GitStatusPayload);
        break;
      case "updateGitDiff":
        bridgeWindow.tex180UpdateGitDiff?.(message.payload as GitDiffPayload);
        break;
      case "gitActionResult":
        bridgeWindow.tex180UpdateGitActionResult?.(
          message.payload as GitActionResultPayload
        );
        break;
      case "openFileResult":
        bridgeWindow.tex180OpenFileResult?.(message.payload as {
          path: string;
          content?: string;
          error?: string;
        });
        break;
      case "saveResult":
        bridgeWindow.tex180SaveResult?.(message.payload as {
          path: string;
          ok: boolean;
          error?: string;
          content?: string;
          formatError?: string;
        });
        break;
      case "formatResult":
        bridgeWindow.tex180FormatResult?.(message.payload as {
          path: string;
          ok: boolean;
          content?: string;
          error?: string;
          source?: string;
        });
        break;
      case "buildLog":
        deps.build.handleBuildLog((message.payload as { log?: string | null })?.log ?? null);
        break;
      case "synctex:forwardResult":
        deps.build.handleSynctexForwardResult(
          message.payload as { ok?: boolean; error?: string }
        );
        break;
      case "renameResult":
        bridgeWindow.tex180RenameResult?.(message.payload as {
          oldPath: string;
          newPath: string;
          isDirectory: boolean;
        });
        break;
      case "launcherStatus":
        deps.handleLauncherStatus(message.payload as { isBusy?: boolean; message?: string });
        break;
      default:
        break;
    }
  };

  if (bridgeWindow.tex180Bridge?.onMessage) {
    bridgeWindow.tex180Bridge.onMessage(handleBridgeMessage);
  }
};
