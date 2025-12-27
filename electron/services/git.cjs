const { spawn } = require("child_process");

class GitService {
  async status(rootPath) {
    const result = await this.runGit(rootPath);
    if (!result.ok) {
      return { entries: [], message: "Gitリポジトリではありません。" };
    }
    const entries = result.output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
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

    return {
      entries,
      message: entries.length === 0 ? "変更はありません。" : null,
    };
  }

  async runGit(rootPath) {
    return new Promise((resolve) => {
      const proc = spawn("git", ["-C", rootPath, "status", "--porcelain"]);
      let output = "";
      proc.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      proc.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      proc.on("close", (code) => {
        resolve({ ok: code === 0, output });
      });
      proc.on("error", () => {
        resolve({ ok: false, output: "" });
      });
    });
  }
}

module.exports = {
  GitService,
};
