import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const { SynctexService } = require(path.join(repoRoot, 'electron/services/synctex.cjs'));

const sourceWorkspace = path.join(repoRoot, 'tests/e2e/fixtures/synctex-precision');
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tex64-neigh-inspect-'));
const workspacePath = path.join(tempDir, 'workspace');
await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
await execFileAsync('latexmk', ['-lualatex', '-g', '-synctex=1', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-outdir=.', 'main.tex'], { cwd: workspacePath });

const pdfPath = path.join(workspacePath, 'main.pdf');
const service = new SynctexService();

const run = async (label, source, line) => {
  const fw = await service.forward({ sourcePath: source, line, column: 1, pdfPath, hintLine: line, hintColumn: 1 });
  const offsets = [-8, 4, 8];
  console.log('---', label, 'forward', fw);
  for (const dx of offsets) {
    for (const dy of offsets) {
      const rev = await service.reverse({
        page: fw.page,
        x: fw.x + dx,
        y: fw.y + dy,
        pdfPath,
        refineLines: 3,
        bypassHint: true,
        allowExpandedOffsets: true,
      });
      console.log(JSON.stringify({ dx, dy, rev: { path: rev.path, line: rev.line, count: rev.count } }));
    }
  }
};

await run('overview', path.join(workspacePath, 'sections/overview.tex'), 1);
await run('appendix', path.join(workspacePath, 'sections/appendix.tex'), 1);

await fs.rm(tempDir, { recursive: true, force: true });
