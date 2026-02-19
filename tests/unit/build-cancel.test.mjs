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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withTempWorkspace = async (fn) => {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "tex64-build-cancel-"));
  try {
    return await fn(rootPath);
  } finally {
    fs.rmSync(rootPath, { recursive: true, force: true });
  }
};

test("BuildService returns cancelled result when latexmk run is cancelled", async () => {
  await withTempWorkspace(async (rootPath) => {
    fs.writeFileSync(path.join(rootPath, "main.tex"), "% dummy", "utf8");

    const service = new StubBuildService(async () => {
      return { output: "", status: 1, cancelled: true };
    });

    const result = await service.runBuild(rootPath, "main.tex", "lualatex", null);
    assert.equal(result.kind, "cancelled");
    assert.equal(result.summary, "ビルドをキャンセルしました。");
  });
});

test("BuildService cancelCurrentRun stops spawned process", async () => {
  const service = new BuildService();
  service.isBuilding = true;
  const runPromise = service.runProcess(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    process.cwd(),
    process.env
  );
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (service.activeProcess) {
        break;
      }
      await wait(20);
    }
    assert.ok(service.activeProcess, "active process should exist before cancelling");
    const requested = service.cancelCurrentRun();
    assert.equal(requested, true);
    const result = await Promise.race([
      runPromise,
      wait(5000).then(() => {
        throw new Error("timed out waiting for cancelled process");
      }),
    ]);
    assert.equal(result.cancelled, true);
  } finally {
    service.cancelCurrentRun();
    service.isBuilding = false;
  }
});
