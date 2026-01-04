const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const ensureDirectory = async (dirPath) => {
  await fsp.mkdir(dirPath, { recursive: true });
};

const safeUnlink = async (filePath) => {
  if (!filePath) {
    return;
  }
  await fsp.unlink(filePath).catch(() => null);
};

class FormatterService {
  extendPath(existingPath) {
    const base = existingPath ?? "";
    const extra = [];
    if (process.platform === "darwin") {
      extra.push("/Library/TeX/texbin", "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin");
    } else if (process.platform === "win32") {
      extra.push(
        "C:\\texlive\\2024\\bin\\windows",
        "C:\\texlive\\2023\\bin\\windows",
        "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64",
        "C:\\Program Files (x86)\\MiKTeX\\miktex\\bin\\x64"
      );
    }
    const parts = [...extra, base].filter(Boolean);
    return parts.join(path.delimiter);
  }

  findLatexindent() {
    const candidates = [];
    if (process.platform === "darwin") {
      candidates.push(
        "/Library/TeX/texbin/latexindent",
        "/usr/local/bin/latexindent",
        "/opt/homebrew/bin/latexindent",
        "/usr/bin/latexindent"
      );
    } else if (process.platform === "win32") {
      candidates.push(
        "C:\\texlive\\2024\\bin\\windows\\latexindent.exe",
        "C:\\texlive\\2023\\bin\\windows\\latexindent.exe",
        "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\latexindent.exe",
        "C:\\Program Files (x86)\\MiKTeX\\miktex\\bin\\x64\\latexindent.exe"
      );
    }
    const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
    pathEntries.forEach((entry) => {
      if (!entry) {
        return;
      }
      candidates.push(path.join(entry, process.platform === "win32" ? "latexindent.exe" : "latexindent"));
    });
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  runProcess(command, args, cwd, env) {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { cwd, env });
      let output = "";
      proc.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      proc.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      proc.on("error", (err) => {
        reject(err);
      });
      proc.on("close", (code) => {
        resolve({ output, status: code ?? 1 });
      });
    });
  }

  async formatContent(rootPath, relativePath, content) {
    if (!rootPath || !relativePath) {
      return { ok: false, error: "format target missing" };
    }
    if (path.extname(relativePath).toLowerCase() !== ".tex") {
      return { ok: true, content, skipped: true };
    }
    const latexindentPath = this.findLatexindent();
    if (!latexindentPath) {
      return { ok: false, error: "latexindent が見つかりません。" };
    }
    const tempDir = path.join(rootPath, ".tex180", ".format");
    await ensureDirectory(tempDir);
    const baseName = path.basename(relativePath, path.extname(relativePath)) || "document";
    const tempName = `${baseName}-${Date.now()}-${Math.random().toString(16).slice(2)}.tex`;
    const tempPath = path.join(tempDir, tempName);
    await fsp.writeFile(tempPath, content ?? "", "utf8");
    const env = { ...process.env };
    env.PATH = this.extendPath(env.PATH);
    const result = await this.runProcess(latexindentPath, ["-w", "-l", tempPath], rootPath, env)
      .catch((error) => ({ output: error?.message ?? String(error), status: 1 }));
    let formatted = null;
    if (result.status === 0) {
      formatted = await fsp.readFile(tempPath, "utf8").catch(() => null);
    }
    await safeUnlink(tempPath);
    await safeUnlink(`${tempPath}.bak`);
    await safeUnlink(path.join(tempDir, "indent.log"));
    await safeUnlink(path.join(rootPath, "indent.log"));
    if (result.status !== 0 || formatted === null) {
      const message = result.output?.trim() || "latexindent の実行に失敗しました。";
      return { ok: false, error: message };
    }
    return { ok: true, content: formatted, formatted: formatted !== content };
  }

  async formatFile(rootPath, relativePath) {
    if (!rootPath || !relativePath) {
      return { ok: false, error: "format target missing" };
    }
    const absPath = path.join(rootPath, relativePath);
    const content = await fsp.readFile(absPath, "utf8");
    const result = await this.formatContent(rootPath, relativePath, content);
    if (result.ok && typeof result.content === "string" && result.content !== content) {
      await fsp.writeFile(absPath, result.content, "utf8");
    }
    return result;
  }
}

module.exports = FormatterService;
