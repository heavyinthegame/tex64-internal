const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SynctexService } = require('/Users/wedd/tex64/electron/services/synctex.cjs');
const { _electron: electron } = require('playwright');

const repoRoot = '/Users/wedd/tex64';
const sourceWorkspace = path.join(repoRoot, 'test-workspace');

const cleanupBuildArtifacts = async (workspacePath) => {
  const staleExtensions = new Set(['.aux','.bbl','.blg','.fdb_latexmk','.fls','.lof','.log','.lot','.nav','.out','.pdf','.snm','.synctex.gz','.toc']);
  const skipDirs = new Set(['.git','.tex64','node_modules']);
  const stack=[workspacePath];
  while(stack.length){
    const current=stack.pop();
    let entries=[];
    try { entries=await fs.readdir(current,{withFileTypes:true}); } catch { continue; }
    for (const entry of entries) {
      if(entry.name.startsWith('.')) continue;
      const p=path.join(current,entry.name);
      if(entry.isDirectory()) {
        if(skipDirs.has(entry.name)) continue;
        stack.push(p);
        continue;
      }
      if(!entry.isFile()) continue;
      if(staleExtensions.has(path.extname(entry.name).toLowerCase())) await fs.rm(p,{force:true});
    }
  }
};

const createWorkspaceCopy = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(),'tex64-forward-compare-'));
  const workspacePath = path.join(tempDir, 'workspace');
  await fs.cp(sourceWorkspace, workspacePath, { recursive: true });
  return {tempDir,workspacePath};
};

const postToBridge = async (page,payload)=>page.evaluate((v)=>window.tex64Bridge.postMessage(v),payload);
const waitForWorkspaceReady = async (page)=>{
  await page.waitForSelector('body.is-ready', { timeout: 15000});
  await page.waitForSelector('#editor-tabs-list .editor-tab.is-active[data-path="main.tex"]', { timeout: 20000});
};
const waitForBuildIdle = async (page)=>{
  await page.waitForFunction(() => { const b=document.getElementById('build-button'); return b instanceof HTMLButtonElement && !b.classList.contains('is-busy'); }, undefined, { timeout: 120000 });
};
const initBridgeCollector = async (page)=>{
  await page.evaluate(() => {
    window.__synctexDebugCompareMessages = [];
    if (!window.__synctexBridgeInstalled) {
      window.tex64Bridge.onMessage((message) => {
        window.__synctexDebugCompareMessages.push({ type: message?.type, payload: message?.payload ?? null, at: Date.now() });
      });
      window.__synctexBridgeInstalled = true;
    }
  });
};
const waitForBridgeMessage = async (page,type,timeoutMs=12000)=>{
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const message=await page.evaluate((expectedType)=>{
      const messages=window.__synctexDebugCompareMessages;
      const index=messages.findIndex((item)=>item?.type===expectedType);
      if(index===-1) return null;
      const item=messages[index]; messages.splice(index,1); return { type:item.type, payload:item.payload };
    }, type);
    if(message) return message.payload;
    await page.waitForTimeout(10);
  }
  throw new Error('timeout '+type);
};

const isSkippableLine = (lineText)=>{const t=(lineText||'').trim(); return !t || t.startsWith('%');};
const isStructuralLine = (lineText)=>{
  const t=(lineText||'').trim();
  if(!t) return false;
  if(/^\\(?:begin|end|label|caption|centering|toprule|midrule|bottomrule|hline|cline)\b/.test(t)) return true;
  if(/\\\\\s*$/.test(t)) return true;
  if(/(^|[^\\])&/.test(t)) return true;
  if (/^\\(?:input|include|subfile|import|includeonly)\b/.test(t) || /^\\(?:begin\{document\}|end\{document\}|maketitle|tableofcontents|listoffigures|listoftables|appendix|bibliography|bibliographystyle|printbibliography)\b/.test(t)) return true;
  return false;
};
const collectSectionsCases = async (workspacePath)=>{
  const base = path.join(workspacePath,'sections');
  const raw = await fs.readdir(base,{withFileTypes:true});
  const files = raw.filter((e)=>e.isFile()&&e.name.endsWith('.tex')).map((e)=>path.join(base,e.name)).sort();
  const cases=[];
  for(const source of files){
    const lines = (await fs.readFile(source,'utf8')).split(/\r?\n/);
    lines.forEach((line,index)=>{
      if(isSkippableLine(line)||isStructuralLine(line)) return;
      const i = line.search(/\S/);
      const column = i>=0 ? i+1 : 1;
      cases.push({ sourcePath: source, rel: path.relative(workspacePath,source).split(path.sep).join('/'), line:index+1, column });
    });
  }
  return cases;
};

(async()=>{
  const { tempDir, workspacePath } = await createWorkspaceCopy();
  await cleanupBuildArtifacts(workspacePath);
  const app = await electron.launch({ args:['.'], cwd: repoRoot, env:{...process.env} });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1600, height: 980});
  await initBridgeCollector(page);
  await postToBridge(page,{ type:'openRecentProject', path: workspacePath});
  await waitForWorkspaceReady(page);
  await postToBridge(page,{ type:'build' });
  await waitForBuildIdle(page);

  const service = new SynctexService();
  const cases = await collectSectionsCases(workspacePath);
  const pdfPath = path.join(workspacePath,'main.pdf');

  for (const item of cases.slice(0,25)) {
    const expected = `(${item.rel}:${item.line})`;
    const fApp = await (async()=>{
      await postToBridge(page,{type:'synctex:forward', path:item.rel, line:item.line, column:item.column, fallbackToTop:false});
      const p=await waitForBridgeMessage(page,'synctex:forwardResult');
      return p;
    })();
    const fSvc = await service.forward({
      sourcePath:item.sourcePath,
      line:item.line,
      column:item.column,
      pdfPath,
      hintLine:item.line,
      hintColumn:item.column,
    });

    if (!fApp?.ok || !fSvc.ok) {
      console.log('INVALID', expected, fApp?.error, fSvc?.error);
      continue;
    }
    const same = fApp.page === fSvc.page && fApp.x === fSvc.x && fApp.y === fSvc.y;
    if (!same) {
      console.log('DIFF', expected, 'app', fApp, 'svc', { page:fSvc.page, x:fSvc.x, y:fSvc.y });
    }
  }

  await app.close();
  await fs.rm(tempDir,{recursive:true,force:true});
})();
