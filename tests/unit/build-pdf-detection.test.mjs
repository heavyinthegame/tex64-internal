import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { BuildService } = require("../../electron/services/build.cjs");

class StubBuildService extends BuildService {
  constructor(runLatexmkImpl) {
    super();
    this._runLatexmkImpl = runLatexmkImpl;
  }

  async runLatexmk(rootPath, mainFileName, engine, options = {}) {
    return await this._runLatexmkImpl({ rootPath, mainFileName, engine, options });
  }
}

const withTempWorkspace = async (fn) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-build-"));
  try {
    return await fn(rootPath);
  } finally {
    fs.rmSync(rootPath, { recursive: true, force: true });
  }
};

test("BuildService resolves PDF path from .fls when jobname differs", async () => {
  await withTempWorkspace(async (rootPath) => {
    fs.writeFileSync(path.join(rootPath, "main.tex"), "% dummy", "utf8");

    const service = new StubBuildService(async ({ rootPath: cwd }) => {
      fs.writeFileSync(path.join(cwd, "paper.pdf"), "%PDF-1.4\n", "utf8");
      fs.writeFileSync(
        path.join(cwd, "paper.fls"),
        `PWD ${cwd}\nOUTPUT paper.pdf\n`,
        "utf8"
      );
      return { output: "", status: 0 };
    });

    const result = await service.runBuild(rootPath, "main.tex", "lualatex", null);
    assert.equal(result.kind, "success");
    assert.ok(result.pdfPath.endsWith(path.join(path.sep, "paper.pdf")));
    assert.ok(fs.existsSync(result.pdfPath));
  });
});

test("BuildService resolves PDF path from .fdb_latexmk when jobname differs", async () => {
  await withTempWorkspace(async (rootPath) => {
    fs.writeFileSync(path.join(rootPath, "main.tex"), "% dummy", "utf8");

    const service = new StubBuildService(async ({ rootPath: cwd }) => {
      fs.writeFileSync(path.join(cwd, "paper.pdf"), "%PDF-1.4\n", "utf8");
      fs.writeFileSync(
        path.join(cwd, "paper.fdb_latexmk"),
        `# Fdb version 4\n[\"lualatex\"] 0 \"main.tex\" \"paper.pdf\" \"paper\" 0 0\n`,
        "utf8"
      );
      return { output: "", status: 0 };
    });

    const result = await service.runBuild(rootPath, "main.tex", "lualatex", null);
    assert.equal(result.kind, "success");
    assert.ok(result.pdfPath.endsWith(path.join(path.sep, "paper.pdf")));
    assert.ok(fs.existsSync(result.pdfPath));
  });
});

test("BuildService retries with pdflatex when lualatex hits xypdf engine mismatch", async () => {
  await withTempWorkspace(async (rootPath) => {
    fs.writeFileSync(path.join(rootPath, "main.tex"), "% dummy", "utf8");

    const engines = [];
    const service = new StubBuildService(async ({ rootPath: cwd, engine }) => {
      engines.push(engine);
      if (engine === "lualatex") {
        return {
          output:
            "Package xypdf Error: pdfTeX version 1.40.0 or higher is needed for the xypdf package with PDF output.",
          status: 1,
        };
      }
      fs.writeFileSync(path.join(cwd, "main.pdf"), "%PDF-1.4\n", "utf8");
      return { output: "", status: 0 };
    });

    const result = await service.runBuild(rootPath, "main.tex", "lualatex", null);
    assert.equal(result.kind, "success");
    assert.deepEqual(engines, ["lualatex", "pdflatex"]);
    assert.ok(fs.existsSync(result.pdfPath));
  });
});
