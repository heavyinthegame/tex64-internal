const { spawn } = require("child_process");

const NOT_REPO_PATTERN = /not a git repository/i;
const USER_MISSING_PATTERN = /(please tell me who you are|user\.name|user\.email)/i;
const AUTH_PATTERN =
  /(could not read username|authentication failed|terminal prompts disabled|password)/i;
const NETWORK_PATTERN =
  /(could not resolve host|failed to connect|connection timed out|network is unreachable)/i;
const UPSTREAM_MISSING_PATTERN =
  /(no configured push destination|no upstream configured|set upstream)/i;
const NO_COMMITS_PATTERN = /refspec .* does not match any/i;
const NO_HISTORY_PATTERN = /does not have any commits yet/i;
const BAD_REVISION_PATTERN = /(bad revision|ambiguous argument 'HEAD'|unknown revision)/i;
const NOTHING_TO_COMMIT_PATTERN = /nothing to commit/i;
const CONFLICT_PATTERN = /conflict/i;
const FF_ONLY_PATTERN = /(not possible to fast-forward|non-fast-forward)/i;

class GitService {
  async status(rootPath) {
    const result = await this.runGit(rootPath, ["status", "--porcelain", "-b"]);
    if (!result.ok) {
      const message = this.formatRepoMessage(result);
      return {
        entries: [],
        message,
        repo: { ok: false, reason: result.reason ?? "error" },
        history: [],
        historyMessage: message,
      };
    }
    const { entries, branch } = this.parseStatus(result.output);
    const remote = await this.getRemoteInfo(rootPath);
    const history = await this.getHistory(rootPath);
    return {
      entries,
      message: entries.length === 0 ? "変更はありません。" : null,
      repo: { ok: true },
      branch,
      remote,
      history: history.entries,
      historyMessage: history.message,
    };
  }

  async init(rootPath) {
    const repoCheck = await this.ensureRepo(rootPath);
    if (repoCheck.ok) {
      return { ok: true, status: "info", message: "すでに履歴管理が有効です。" };
    }
    if (repoCheck.reason === "git-missing") {
      return {
        ok: false,
        status: "error",
        message: "この環境では履歴管理を使えません。",
      };
    }
    const result = await this.runGit(rootPath, ["init"]);
    if (!result.ok) {
      return { ok: false, status: "error", message: "履歴管理の開始に失敗しました。" };
    }
    return { ok: true, status: "success", message: "履歴管理を開始しました。" };
  }

  async commit(rootPath, message) {
    const repoCheck = await this.ensureRepo(rootPath);
    if (!repoCheck.ok) {
      return {
        ok: false,
        status: "info",
        message: this.formatRepoMessage(repoCheck),
      };
    }
    const addResult = await this.runGit(rootPath, ["add", "-A"]);
    if (!addResult.ok) {
      return { ok: false, status: "error", message: "履歴の保存に失敗しました。" };
    }
    const diffResult = await this.runGit(rootPath, ["diff", "--cached", "--name-only"]);
    if (!diffResult.ok) {
      return { ok: false, status: "error", message: "履歴の保存に失敗しました。" };
    }
    if (!diffResult.output.trim()) {
      return { ok: false, status: "info", message: "変更がありません。" };
    }
    const commitMessage = (message ?? "").trim() || this.buildDefaultCommitMessage();
    const commitResult = await this.runGit(rootPath, ["commit", "-m", commitMessage]);
    if (!commitResult.ok) {
      const formatted = this.formatCommitMessage(commitResult);
      return { ok: false, status: "error", message: formatted };
    }
    return { ok: true, status: "success", message: "履歴を保存しました。" };
  }

  async setRemote(rootPath, url) {
    const trimmed = (url ?? "").trim();
    if (!trimmed) {
      return { ok: false, status: "info", message: "同期先のURLを入力してください。" };
    }
    const repoCheck = await this.ensureRepo(rootPath);
    if (!repoCheck.ok) {
      return {
        ok: false,
        status: "info",
        message: this.formatRepoMessage(repoCheck),
      };
    }
    const remotes = await this.listRemotes(rootPath);
    const targetName = remotes.includes("origin") ? "origin" : remotes[0] ?? "origin";
    const args = remotes.includes(targetName)
      ? ["remote", "set-url", targetName, trimmed]
      : ["remote", "add", targetName, trimmed];
    const result = await this.runGit(rootPath, args);
    if (!result.ok) {
      return { ok: false, status: "error", message: "同期先の保存に失敗しました。" };
    }
    return { ok: true, status: "success", message: "同期先を保存しました。" };
  }

  async pull(rootPath) {
    const repoCheck = await this.ensureRepo(rootPath);
    if (!repoCheck.ok) {
      return {
        ok: false,
        status: "info",
        message: this.formatRepoMessage(repoCheck),
      };
    }
    const changeCheck = await this.hasLocalChanges(rootPath);
    if (changeCheck.ok && changeCheck.hasChanges) {
      return {
        ok: false,
        status: "info",
        message: "変更があります。先に履歴に保存してください。",
      };
    }
    const remote = await this.getRemoteInfo(rootPath);
    if (!remote.exists) {
      return { ok: false, status: "info", message: "同期先が未設定です。" };
    }
    const branch = await this.getBranchName(rootPath);
    if (branch.detached) {
      return { ok: false, status: "info", message: "現在の状態では同期できません。" };
    }
    const upstream = await this.getUpstream(rootPath);
    const args = ["pull", "--ff-only"];
    if (!upstream) {
      args.push(remote.name, branch.name);
    }
    const result = await this.runGit(rootPath, args, {
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
    if (!result.ok) {
      const info = this.classifySyncError(result);
      return {
        ok: false,
        status: "error",
        message: info.message,
        hint: info.hint,
      };
    }
    return { ok: true, status: "success", message: "同期が完了しました。" };
  }

  async push(rootPath) {
    const repoCheck = await this.ensureRepo(rootPath);
    if (!repoCheck.ok) {
      return {
        ok: false,
        status: "info",
        message: this.formatRepoMessage(repoCheck),
      };
    }
    const changeCheck = await this.hasLocalChanges(rootPath);
    if (changeCheck.ok && changeCheck.hasChanges) {
      return {
        ok: false,
        status: "info",
        message: "変更があります。先に履歴に保存してください。",
      };
    }
    const remote = await this.getRemoteInfo(rootPath);
    if (!remote.exists) {
      return { ok: false, status: "info", message: "同期先が未設定です。" };
    }
    const branch = await this.getBranchName(rootPath);
    if (branch.detached) {
      return { ok: false, status: "info", message: "現在の状態では同期できません。" };
    }
    const hasCommit = await this.hasCommits(rootPath);
    if (!hasCommit.ok || !hasCommit.hasCommits) {
      return { ok: false, status: "info", message: "履歴がありません。先に保存してください。" };
    }
    const upstream = await this.getUpstream(rootPath);
    const args = upstream
      ? ["push"]
      : ["push", "-u", remote.name, branch.name];
    const result = await this.runGit(rootPath, args, {
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
    if (!result.ok) {
      const info = this.classifySyncError(result);
      return {
        ok: false,
        status: "error",
        message: info.message,
        hint: info.hint,
      };
    }
    return { ok: true, status: "success", message: "送信が完了しました。" };
  }

  async restore(rootPath, targetHash) {
    const repoCheck = await this.ensureRepo(rootPath);
    if (!repoCheck.ok) {
      return {
        ok: false,
        status: "info",
        message: this.formatRepoMessage(repoCheck),
      };
    }
    const normalized = (targetHash ?? "").trim();
    if (!normalized) {
      return { ok: false, status: "info", message: "戻す履歴が選択されていません。" };
    }
    const changeCheck = await this.hasLocalChanges(rootPath);
    if (changeCheck.ok && changeCheck.hasChanges) {
      return {
        ok: false,
        status: "info",
        message: "変更があります。先に履歴に保存してください。",
      };
    }
    const branch = await this.getBranchName(rootPath);
    if (branch.detached) {
      return { ok: false, status: "info", message: "現在の状態では戻せません。" };
    }
    const hasCommit = await this.hasCommits(rootPath);
    if (!hasCommit.ok || !hasCommit.hasCommits) {
      return { ok: false, status: "info", message: "履歴がありません。" };
    }
    const ancestorCheck = await this.runGit(rootPath, [
      "merge-base",
      "--is-ancestor",
      normalized,
      "HEAD",
    ]);
    if (!ancestorCheck.ok) {
      return { ok: false, status: "info", message: "この履歴には戻せません。" };
    }
    const countResult = await this.runGit(rootPath, [
      "rev-list",
      "--count",
      `${normalized}..HEAD`,
    ]);
    if (countResult.ok) {
      const count = Number.parseInt(countResult.output.trim(), 10);
      if (!Number.isFinite(count) || count <= 0) {
        return { ok: false, status: "info", message: "すでに最新の状態です。" };
      }
    }
    const mergeResult = await this.runGit(rootPath, [
      "rev-list",
      "--merges",
      `${normalized}..HEAD`,
    ]);
    if (mergeResult.ok && mergeResult.output.trim()) {
      return {
        ok: false,
        status: "info",
        message: "履歴が複雑なため、この操作は利用できません。",
      };
    }
    const revertResult = await this.runGit(rootPath, [
      "revert",
      "--no-commit",
      `${normalized}..HEAD`,
    ]);
    if (!revertResult.ok) {
      await this.runGit(rootPath, ["revert", "--abort"]);
      return {
        ok: false,
        status: "error",
        message: this.formatRestoreMessage(revertResult),
      };
    }
    const shortHash = normalized.length > 7 ? normalized.slice(0, 7) : normalized;
    const commitResult = await this.runGit(rootPath, [
      "commit",
      "-m",
      `履歴を戻しました (${shortHash})`,
    ]);
    if (!commitResult.ok) {
      return {
        ok: false,
        status: "error",
        message: this.formatCommitMessage(commitResult),
      };
    }
    return { ok: true, status: "success", message: "履歴を戻しました。" };
  }

  parseStatus(output) {
    const lines = output.split(/\r?\n/).filter(Boolean);
    let header = null;
    if (lines.length > 0 && lines[0].startsWith("##")) {
      header = lines.shift();
    }
    const branch = this.parseBranchHeader(header);
    const entries = lines
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        if (line.length < 3) {
          return null;
        }
        const status = line.slice(0, 2).trim();
        let filePath = line.slice(3).trim();
        const arrowIndex = filePath.indexOf("->");
        if (arrowIndex >= 0) {
          filePath = filePath.slice(arrowIndex + 2).trim();
        }
        return { status, path: filePath };
      })
      .filter(Boolean);
    return { entries, branch };
  }

  async getHistory(rootPath, limit = 20) {
    const result = await this.runGit(rootPath, [
      "log",
      "-n",
      String(limit),
      "--date=iso",
      "--pretty=format:%H%x09%h%x09%ad%x09%s",
    ]);
    if (!result.ok) {
      if (NO_HISTORY_PATTERN.test(result.output)) {
        return { entries: [], message: "履歴はまだありません。" };
      }
      return { entries: [], message: "履歴を取得できませんでした。" };
    }
    const entries = result.output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("\t");
        if (parts.length < 4) {
          return null;
        }
        const [hash, shortHash, date, ...rest] = parts;
        const message = rest.join("\t").trim();
        return {
          hash: hash.trim(),
          shortHash: shortHash.trim(),
          date: date.trim(),
          message,
        };
      })
      .filter(Boolean);
    return {
      entries,
      message: entries.length === 0 ? "履歴はまだありません。" : null,
    };
  }

  async getCommitDiff(rootPath) {
    const repoCheck = await this.ensureRepo(rootPath);
    if (!repoCheck.ok) {
      return { ok: false, patch: "", message: this.formatRepoMessage(repoCheck) };
    }
    const hasCommit = await this.hasCommits(rootPath);
    let trackedPatch = "";
    if (hasCommit.ok && hasCommit.hasCommits) {
      const result = await this.runGit(
        rootPath,
        ["diff", "--no-color", "HEAD"],
        { okCodes: [0, 1] }
      );
      if (result.ok) {
        trackedPatch = result.output;
      } else if (!BAD_REVISION_PATTERN.test(result.output ?? "")) {
        return { ok: false, patch: "", message: "差分を取得できませんでした。" };
      }
    }
    const untrackedFiles = await this.listUntrackedFiles(rootPath);
    const untrackedPatch = await this.buildUntrackedDiff(rootPath, untrackedFiles);
    const patch = [trackedPatch, untrackedPatch].filter(Boolean).join("\n");
    if (!patch.trim()) {
      return { ok: true, patch: "", message: "変更がありません。" };
    }
    return { ok: true, patch, message: null };
  }

  async getRestoreDiff(rootPath, targetHash) {
    const repoCheck = await this.ensureRepo(rootPath);
    if (!repoCheck.ok) {
      return { ok: false, patch: "", message: this.formatRepoMessage(repoCheck) };
    }
    const normalized = (targetHash ?? "").trim();
    if (!normalized) {
      return { ok: false, patch: "", message: "戻す履歴が選択されていません。" };
    }
    const branch = await this.getBranchName(rootPath);
    if (branch.detached) {
      return { ok: false, patch: "", message: "現在の状態では戻せません。" };
    }
    const hasCommit = await this.hasCommits(rootPath);
    if (!hasCommit.ok || !hasCommit.hasCommits) {
      return { ok: false, patch: "", message: "履歴がありません。" };
    }
    const ancestorCheck = await this.runGit(rootPath, [
      "merge-base",
      "--is-ancestor",
      normalized,
      "HEAD",
    ]);
    if (!ancestorCheck.ok) {
      return { ok: false, patch: "", message: "この履歴には戻せません。" };
    }
    const diffResult = await this.runGit(
      rootPath,
      ["diff", "--no-color", `${normalized}..HEAD`],
      { okCodes: [0, 1] }
    );
    if (!diffResult.ok) {
      return { ok: false, patch: "", message: "差分を取得できませんでした。" };
    }
    const patch = diffResult.output ?? "";
    if (!patch.trim()) {
      return { ok: true, patch: "", message: "すでに最新の状態です。" };
    }
    return { ok: true, patch, message: null };
  }

  async listUntrackedFiles(rootPath) {
    const result = await this.runGit(rootPath, ["status", "--porcelain", "-z", "-uall"]);
    if (!result.ok) {
      return [];
    }
    return result.output
      .split("\u0000")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .filter((entry) => entry.startsWith("?? "))
      .map((entry) => entry.slice(3).trim())
      .filter((entry) => entry && !entry.endsWith("/"));
  }

  async buildUntrackedDiff(rootPath, files) {
    if (!Array.isArray(files) || files.length === 0) {
      return "";
    }
    const patches = [];
    for (const filePath of files) {
      if (!filePath) {
        continue;
      }
      const result = await this.runGit(
        rootPath,
        ["diff", "--no-color", "--no-index", "--", "/dev/null", filePath],
        { okCodes: [0, 1] }
      );
      if (result.ok && result.output) {
        patches.push(result.output.trimEnd());
      }
    }
    return patches.join("\n");
  }

  parseBranchHeader(header) {
    if (!header) {
      return {};
    }
    const text = header.replace(/^##\s*/, "").trim();
    const detached = text.startsWith("HEAD") || text.includes("no branch");
    let ahead = 0;
    let behind = 0;
    let summaryText = text;
    const bracketIndex = text.indexOf("[");
    if (bracketIndex >= 0) {
      summaryText = text.slice(0, bracketIndex).trim();
      const extra = text.slice(bracketIndex);
      const aheadMatch = extra.match(/ahead\s+(\d+)/);
      const behindMatch = extra.match(/behind\s+(\d+)/);
      if (aheadMatch) {
        ahead = Number.parseInt(aheadMatch[1], 10);
      }
      if (behindMatch) {
        behind = Number.parseInt(behindMatch[1], 10);
      }
    }
    if (detached) {
      return { detached: true, ahead, behind };
    }
    const parts = summaryText.split("...");
    return {
      name: parts[0]?.trim() || null,
      upstream: parts[1]?.trim() || null,
      ahead,
      behind,
      detached: false,
    };
  }

  async ensureRepo(rootPath) {
    const result = await this.runGit(rootPath, ["rev-parse", "--is-inside-work-tree"]);
    if (result.ok && result.output.trim() === "true") {
      return { ok: true };
    }
    return { ok: false, reason: result.reason ?? "not-repo" };
  }

  async listRemotes(rootPath) {
    const result = await this.runGit(rootPath, ["remote"]);
    if (!result.ok) {
      return [];
    }
    return result.output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async getRemoteInfo(rootPath) {
    const remotes = await this.listRemotes(rootPath);
    if (remotes.length === 0) {
      return { exists: false };
    }
    const name = remotes.includes("origin") ? "origin" : remotes[0];
    const urlResult = await this.runGit(rootPath, ["remote", "get-url", name]);
    const url = urlResult.ok ? urlResult.output.trim() : null;
    return { exists: true, name, url };
  }

  async getBranchName(rootPath) {
    const result = await this.runGit(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!result.ok) {
      return { name: null, detached: true };
    }
    const name = result.output.trim();
    if (!name || name === "HEAD") {
      return { name: null, detached: true };
    }
    return { name, detached: false };
  }

  async getUpstream(rootPath) {
    const result = await this.runGit(rootPath, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{u}",
    ]);
    if (!result.ok) {
      return null;
    }
    return result.output.trim() || null;
  }

  async hasCommits(rootPath) {
    const result = await this.runGit(rootPath, ["rev-parse", "--verify", "HEAD"]);
    return { ok: result.ok, hasCommits: result.ok };
  }

  async hasLocalChanges(rootPath) {
    const result = await this.runGit(rootPath, ["status", "--porcelain"]);
    if (!result.ok) {
      return { ok: false, hasChanges: false };
    }
    return { ok: true, hasChanges: Boolean(result.output.trim()) };
  }

  buildDefaultCommitMessage() {
    const now = new Date();
    const iso = now.toISOString().slice(0, 16).replace("T", " ");
    return `更新 ${iso}`;
  }

  formatRepoMessage(result) {
    if (result.reason === "git-missing") {
      return "この環境では履歴管理を使えません。";
    }
    if (result.reason === "not-repo") {
      return "履歴管理がまだ有効ではありません。";
    }
    return "履歴管理の状態を確認できませんでした。";
  }

  formatCommitMessage(result) {
    const output = result.output ?? "";
    if (USER_MISSING_PATTERN.test(output)) {
      return "履歴の作成者が未設定です。名前とメールを設定してください。";
    }
    if (NOTHING_TO_COMMIT_PATTERN.test(output)) {
      return "変更がありません。";
    }
    return "履歴の保存に失敗しました。";
  }

  formatRestoreMessage(result) {
    const output = result.output ?? "";
    if (USER_MISSING_PATTERN.test(output)) {
      return "履歴の作成者が未設定です。名前とメールを設定してください。";
    }
    if (CONFLICT_PATTERN.test(output)) {
      return "復元中に競合が発生しました。";
    }
    return "履歴の復元に失敗しました。";
  }

  classifySyncError(result) {
    const output = result.output ?? "";
    if (AUTH_PATTERN.test(output)) {
      return {
        message: "同期先の認証が必要です。",
        hint: "初回は認証が必要です。ターミナルで一度だけ同期操作を行ってください。",
      };
    }
    if (NETWORK_PATTERN.test(output)) {
      return {
        message: "同期に失敗しました。ネットワークを確認してください。",
        hint: "ネットワーク接続や同期先の状態を確認してください。",
      };
    }
    if (FF_ONLY_PATTERN.test(output) || CONFLICT_PATTERN.test(output)) {
      return {
        message: "同期できませんでした。内容の調整が必要です。",
        hint: "内容の衝突があるため、別のツールで調整してください。",
      };
    }
    if (UPSTREAM_MISSING_PATTERN.test(output)) {
      return {
        message: "同期先が未設定です。",
        hint: "同期先URLを保存してください。",
      };
    }
    if (NO_COMMITS_PATTERN.test(output)) {
      return {
        message: "履歴がありません。先に保存してください。",
        hint: "先に履歴を保存してから同期してください。",
      };
    }
    if (NOT_REPO_PATTERN.test(output)) {
      return {
        message: "履歴管理が有効ではありません。",
        hint: "履歴管理を開始してください。",
      };
    }
    return {
      message: "同期に失敗しました。",
      hint: "認証やネットワークを確認してください。",
    };
  }

  formatSyncMessage(result) {
    return this.classifySyncError(result).message;
  }

  runGit(rootPath, args, options = {}) {
    return new Promise((resolve) => {
      const env = { ...process.env, ...(options.env ?? {}) };
      const proc = spawn("git", args, { cwd: rootPath, env });
      let output = "";
      const okCodes = Array.isArray(options.okCodes) ? options.okCodes : [0];
      proc.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      proc.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      proc.on("close", (code) => {
        if (okCodes.includes(code)) {
          resolve({ ok: true, output, code });
          return;
        }
        const reason = NOT_REPO_PATTERN.test(output) ? "not-repo" : "error";
        resolve({ ok: false, output, code, reason });
      });
      proc.on("error", (error) => {
        const reason = error?.code === "ENOENT" ? "git-missing" : "error";
        resolve({ ok: false, output: "", code: null, reason, error });
      });
    });
  }
}

module.exports = {
  GitService,
};
