const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

class SynctexService {
  constructor() {
    this.forwardHints = [];
    this.sourceLineCache = new Map();
    this.debugHints = process.env.TEX64_SYNCTEX_DEBUG_HINTS === "1";
  }

  async forward({
    sourcePath,
    line,
    column,
    pdfPath,
    hintLine = null,
    hintColumn = null,
    registerHint = true,
  }) {
    const synctexPath = this.findSynctex();
    if (!synctexPath) {
      return { ok: false, error: "synctex が見つかりません。" };
    }
    if (!fs.existsSync(pdfPath)) {
      return { ok: false, error: "PDFが見つかりません。" };
    }
    if (!fs.existsSync(sourcePath)) {
      return { ok: false, error: "対象のTeXファイルが見つかりません。" };
    }
    const target = `${line}:${column}:${sourcePath}`;
    const args = ["view", "-i", target, "-o", pdfPath];
    const env = { ...process.env };
    env.PATH = this.extendPath(env.PATH);
    let result;
    try {
      result = await this.runProcess(synctexPath, args, path.dirname(pdfPath), env);
    } catch (_error) {
      return { ok: false, error: "SyncTeX の解析に失敗しました。" };
    }
    if (result.status !== 0) {
      return { ok: false, error: "SyncTeX の解析に失敗しました。" };
    }
    const blocks = this.parseForwardBlocks(result.output);
    if (!blocks.length) {
      return { ok: false, error: "SyncTeX の位置情報が見つかりません。" };
    }
    const targetLine = Number.isFinite(line) ? line : null;
    const targetColumn = Number.isFinite(column) ? column : null;
    const selected = await this.selectForwardPoint({
      blocks,
      targetLine,
      targetColumn,
      sourcePath,
      synctexPath,
      pdfPath,
      cwd: path.dirname(pdfPath),
      env,
    });
    if (!selected) {
      return { ok: false, error: "SyncTeX の位置情報が見つかりません。" };
    }
    if (
      registerHint !== false &&
      Number.isFinite(selected.page) &&
      Number.isFinite(selected.x) &&
      Number.isFinite(selected.y)
    ) {
      this.registerForwardHint({
        pdfPath,
        page: selected.page,
        x: selected.x,
        y: selected.y,
        sourcePath,
        line: Number.isFinite(hintLine) ? hintLine : Number.isFinite(line) ? line : 1,
        column: Number.isFinite(hintColumn)
          ? hintColumn
          : Number.isFinite(column)
          ? column
          : 1,
      });
    }
    return { ok: true, ...selected };
  }

  async reverse({
    page,
    x,
    y,
    pdfPath,
    refineLines = 3,
    bypassHint = false,
    allowExpandedOffsets = true,
  }) {
    const synctexPath = this.findSynctex();
    if (!synctexPath) {
      return { ok: false, error: "synctex が見つかりません。" };
    }
    if (!fs.existsSync(pdfPath)) {
      return { ok: false, error: "PDFが見つかりません。" };
    }
    const env = { ...process.env };
    env.PATH = this.extendPath(env.PATH);
    const cwd = path.dirname(pdfPath);
    const normalizedPdfForHint = this.normalizeComparePath(pdfPath);
    const hintCandidateCount = this.forwardHints.filter((hint) => {
      if (!hint || hint.page !== Math.floor(page)) {
        return false;
      }
      if (!normalizedPdfForHint) {
        return true;
      }
      return hint.pdfPath === normalizedPdfForHint;
    }).length;
    const hintPreview = this.forwardHints
      .filter((hint) => hint && hint.page === Math.floor(page))
      .slice(0, 3)
      .map((hint) => ({
        line: hint.line,
        x: hint.x,
        y: hint.y,
        ageMs: Date.now() - hint.timestamp,
        dx: Math.abs(hint.x - x),
        dy: Math.abs(hint.y - y),
      }));
    if (!bypassHint) {
      const hint = this.findForwardHint({
        pdfPath,
        page,
        x,
        y,
      });
      if (hint) {
        return {
          ok: true,
          path: hint.sourcePath,
          line: hint.line,
          column: hint.column,
          confidence: true,
          scoreGap: null,
          distance: 0,
          hinted: true,
          hintCandidateCount,
          hintPreview,
        };
      }
      const recentHint = this.findRecentPageHint({ page, x, y });
      if (recentHint) {
        return {
          ok: true,
          path: recentHint.sourcePath,
          line: recentHint.line,
          column: recentHint.column,
          confidence: true,
          scoreGap: null,
          distance: 0,
          hinted: true,
          hintCandidateCount,
          hintPreview,
        };
      }
    }
    let candidates = await this.collectReverseCandidates({
      page,
      x,
      y,
      pdfPath,
      synctexPath,
      cwd,
      env,
      expanded: false,
    });
    if (allowExpandedOffsets && candidates.length < 3) {
      const expandedCandidates = await this.collectReverseCandidates({
        page,
        x,
        y,
        pdfPath,
        synctexPath,
        cwd,
        env,
        expanded: true,
      });
      candidates = this.mergeReverseCandidates(candidates, expandedCandidates);
    }
    if (!candidates.length) {
      return { ok: false, error: "SyncTeX の参照先が見つかりません。" };
    }
    let selected = await this.selectReverseCandidate({
      candidates,
      click: { page, x, y },
      synctexPath,
      pdfPath,
      cwd,
      env,
    });
    if (allowExpandedOffsets && (!selected || selected.confidence !== true)) {
      const expandedCandidates = await this.collectReverseCandidates({
        page,
        x,
        y,
        pdfPath,
        synctexPath,
        cwd,
        env,
        expanded: true,
      });
      const mergedCandidates = this.mergeReverseCandidates(candidates, expandedCandidates);
      if (mergedCandidates.length > 0) {
        const rescored = await this.selectReverseCandidate({
          candidates: mergedCandidates,
          click: { page, x, y },
          synctexPath,
          pdfPath,
          cwd,
          env,
        });
        if (this.shouldPreferReverseSelection(rescored, selected)) {
          selected = rescored;
        }
      }
    }
    if (!selected) {
      return { ok: false, error: "SyncTeX の参照先が見つかりません。" };
    }
    const range = Number.isFinite(refineLines)
      ? Math.min(10, Math.max(0, Math.floor(refineLines)))
      : 0;
    if (range > 0) {
      selected = await this.refineReverseCandidate({
        candidate: selected,
        click: { page, x, y },
        synctexPath,
        pdfPath,
        cwd,
        env,
        range,
      });
    }
    return { ok: true, ...selected, hinted: false, hintCandidateCount, hintPreview };
  }

  registerForwardHint({ pdfPath, page, x, y, sourcePath, line, column }) {
    if (
      !Number.isFinite(page) ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(line) ||
      line < 1 ||
      !pdfPath ||
      !sourcePath
    ) {
      return;
    }
    const now = Date.now();
    const normalizedPdf = this.normalizeComparePath(pdfPath);
    const normalizedSource = this.normalizeComparePath(sourcePath);
    if (!normalizedPdf || !normalizedSource) {
      return;
    }
    const normalizedPage = Math.floor(page);
    this.cleanupForwardHints(now);
    // Keep only the newest hint per pdf/page to avoid stale same-page hits
    // stealing reverse matches after a fresh forward sync.
    this.forwardHints = this.forwardHints.filter(
      (hint) => !(hint.pdfPath === normalizedPdf && hint.page === normalizedPage)
    );
    this.forwardHints.unshift({
      pdfPath: normalizedPdf,
      sourcePath: normalizedSource,
      page: normalizedPage,
      x,
      y,
      line: Math.floor(line),
      column: Number.isFinite(column) && column >= 1 ? Math.floor(column) : 1,
      timestamp: now,
    });
    const maxHints = 400;
    if (this.forwardHints.length > maxHints) {
      this.forwardHints.length = maxHints;
    }
  }

  cleanupForwardHints(now = Date.now()) {
    const maxAgeMs = 30000;
    this.forwardHints = this.forwardHints.filter((hint) => now - hint.timestamp <= maxAgeMs);
  }

  findForwardHint({ pdfPath, page, x, y }) {
    if (
      !pdfPath ||
      !Number.isFinite(page) ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      return null;
    }
    const normalizedPdf = this.normalizeComparePath(pdfPath);
    if (!normalizedPdf) {
      return null;
    }
    const now = Date.now();
    this.cleanupForwardHints(now);
    const maxHintAgeMs = 8000;
    const maxDx = 240;
    const maxDy = 26;
    const targetPage = Math.floor(page);
    const recentSamePage = this.forwardHints.filter((hint) => {
      if (hint.page !== targetPage) {
        return false;
      }
      const ageMs = now - hint.timestamp;
      return ageMs <= maxHintAgeMs;
    });
    const pickBest = (hints, { allowAnyPdf = false, dxLimit = maxDx, dyLimit = maxDy } = {}) => {
      let best = null;
      let bestScore = Number.POSITIVE_INFINITY;
      for (const hint of hints) {
        if (!allowAnyPdf && hint.pdfPath !== normalizedPdf) {
          continue;
        }
        const ageMs = now - hint.timestamp;
        const dx = Math.abs(hint.x - x);
        const dy = Math.abs(hint.y - y);
        if (dx > dxLimit || dy > dyLimit) {
          continue;
        }
        const score = dy * 1000 + dx + ageMs * 0.01;
        if (score < bestScore) {
          best = hint;
          bestScore = score;
        }
      }
      return best;
    };
    let best = pickBest(recentSamePage, {
      allowAnyPdf: false,
      dxLimit: maxDx,
      dyLimit: maxDy,
    });
    if (!best) {
      // Fallback for cases where viewer path normalization differs between windows.
      best = pickBest(recentSamePage, {
        allowAnyPdf: true,
        dxLimit: 40,
        dyLimit: 40,
      });
    }
    if (this.debugHints) {
      const sample = recentSamePage
        .slice(0, 5)
        .map((hint) => ({
          pdfPath: hint.pdfPath,
          line: hint.line,
          x: hint.x,
          y: hint.y,
          ageMs: now - hint.timestamp,
          dx: Math.abs(hint.x - x),
          dy: Math.abs(hint.y - y),
        }));
      // eslint-disable-next-line no-console
      console.error(
        `[synctex-hint] page=${targetPage} x=${x} y=${y} matched=${best ? best.line : "none"} sample=${JSON.stringify(sample)}`
      );
    }
    return best;
  }

  findRecentPageHint({ page, x, y, maxAgeMs = 4000, maxDx = 40, maxDy = 40 }) {
    if (!Number.isFinite(page) || !Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    const now = Date.now();
    this.cleanupForwardHints(now);
    const targetPage = Math.floor(page);
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const hint of this.forwardHints) {
      if (!hint || hint.page !== targetPage) {
        continue;
      }
      const ageMs = now - hint.timestamp;
      if (ageMs > maxAgeMs) {
        continue;
      }
      const dx = Math.abs(hint.x - x);
      const dy = Math.abs(hint.y - y);
      if (dx > maxDx || dy > maxDy) {
        continue;
      }
      const score = dy * 1000 + dx + ageMs * 0.01;
      if (score < bestScore) {
        best = hint;
        bestScore = score;
      }
    }
    return best;
  }

  getSourceLines(sourcePath) {
    if (!sourcePath || typeof sourcePath !== "string") {
      return null;
    }
    const normalizedPath = this.normalizeComparePath(sourcePath) ?? path.resolve(sourcePath);
    if (this.sourceLineCache.has(normalizedPath)) {
      return this.sourceLineCache.get(normalizedPath);
    }
    let lines = null;
    try {
      const raw = fs.readFileSync(normalizedPath, "utf8");
      lines = raw.split(/\r?\n/);
    } catch {
      lines = null;
    }
    this.sourceLineCache.set(normalizedPath, lines);
    return lines;
  }

  getSourceLine(sourcePath, line) {
    if (!Number.isFinite(line) || line < 1) {
      return null;
    }
    const lines = this.getSourceLines(sourcePath);
    if (!Array.isArray(lines) || lines.length === 0) {
      return null;
    }
    const index = Math.floor(line) - 1;
    if (index < 0 || index >= lines.length) {
      return null;
    }
    return typeof lines[index] === "string" ? lines[index] : null;
  }

  isLowSignalTexLine(lineText) {
    if (typeof lineText !== "string") {
      return false;
    }
    const trimmed = lineText.trim();
    if (!trimmed) {
      return true;
    }
    if (/^\\(?:begin|end|hline|cline|toprule|midrule|bottomrule|centering)\b/.test(trimmed)) {
      return true;
    }
    return false;
  }

  getReverseLinePenalty({ sourcePath, line }) {
    const text = this.getSourceLine(sourcePath, line);
    if (!this.isLowSignalTexLine(text)) {
      return 0;
    }
    return 1200;
  }

  getRefineColumns({ sourcePath, line, baseColumn }) {
    const columns = new Set();
    if (Number.isFinite(baseColumn) && baseColumn >= 1) {
      columns.add(Math.floor(baseColumn));
    }
    columns.add(1);
    const lineText = this.getSourceLine(sourcePath, line);
    if (typeof lineText === "string" && lineText.length > 0) {
      const firstNonSpace = lineText.search(/\S/);
      if (firstNonSpace >= 0) {
        columns.add(firstNonSpace + 1);
      }
      const length = lineText.length;
      if (length >= 6) {
        columns.add(Math.max(1, Math.floor(length * 0.33)));
        columns.add(Math.max(1, Math.floor(length * 0.66)));
      }
    }
    return Array.from(columns)
      .filter((value) => Number.isFinite(value) && value >= 1)
      .sort((left, right) => left - right)
      .slice(0, 6);
  }

  async refineReverseCandidate({ candidate, click, synctexPath, pdfPath, cwd, env, range }) {
    if (!candidate || typeof candidate !== "object") {
      return candidate;
    }
    const sourcePath = candidate.path;
    const baseLine = candidate.line;
    const baseColumn = Number.isFinite(candidate.column) ? candidate.column : 1;
    if (!sourcePath || !Number.isFinite(baseLine) || baseLine < 1) {
      return candidate;
    }
    const startLine = Math.max(1, baseLine - range);
    const endLine = baseLine + range;
    let bestLine = baseLine;
    let bestDistance = Number.isFinite(candidate.distance) ? candidate.distance : null;
    let bestScore = Number.isFinite(bestDistance)
      ? bestDistance + this.getReverseLinePenalty({ sourcePath, line: baseLine })
      : Number.POSITIVE_INFINITY;
    for (let line = startLine; line <= endLine; line += 1) {
      let distance = null;
      const columns = this.getRefineColumns({ sourcePath, line, baseColumn });
      for (const column of columns) {
        const measured = await this.measureForwardDistance({
          synctexPath,
          pdfPath,
          sourcePath,
          line,
          column,
          click,
          cwd,
          env,
        });
        if (!Number.isFinite(measured)) {
          continue;
        }
        if (!Number.isFinite(distance) || measured < distance) {
          distance = measured;
        }
      }
      if (!Number.isFinite(distance)) {
        continue;
      }
      const score =
        distance + this.getReverseLinePenalty({ sourcePath, line });
      if (!Number.isFinite(bestScore) || score < bestScore) {
        bestScore = score;
        bestDistance = distance;
        bestLine = line;
      }
    }
    if (!Number.isFinite(bestScore)) {
      return candidate;
    }
    if (bestLine === baseLine) {
      if (Number.isFinite(bestDistance)) {
        return { ...candidate, distance: bestDistance };
      }
      return candidate;
    }
    return {
      ...candidate,
      line: bestLine,
      distance: Number.isFinite(bestDistance) ? bestDistance : candidate.distance ?? null,
      refined: true,
    };
  }

  parseForwardBlocks(output) {
    if (!output) {
      return [];
    }
    const blocks = [];
    const regex = /Output:[^\n]*\nPage:\d+[\s\S]*?(?=Output:|SyncTeX result end)/g;
    const matches = output.match(regex) ?? [];
    for (const block of matches) {
      const pageMatch = block.match(/Page:(\d+)/);
      const xMatch = block.match(/x:([+-]?\d+(?:\.\d+)?)/);
      const yMatch = block.match(/y:([+-]?\d+(?:\.\d+)?)/);
      if (!pageMatch || !xMatch || !yMatch) {
        continue;
      }
      const hMatch = block.match(/h:([+-]?\d+(?:\.\d+)?)/);
      const vMatch = block.match(/v:([+-]?\d+(?:\.\d+)?)/);
      const wMatch = block.match(/W:([+-]?\d+(?:\.\d+)?)/);
      const hSizeMatch = block.match(/H:([+-]?\d+(?:\.\d+)?)/);
      blocks.push({
        page: Number.parseInt(pageMatch[1], 10),
        x: Number.parseFloat(xMatch[1]),
        y: Number.parseFloat(yMatch[1]),
        h: hMatch ? Number.parseFloat(hMatch[1]) : null,
        v: vMatch ? Number.parseFloat(vMatch[1]) : null,
        width: wMatch ? Number.parseFloat(wMatch[1]) : null,
        height: hSizeMatch ? Number.parseFloat(hSizeMatch[1]) : null,
      });
    }
    return blocks;
  }

  buildForwardCandidates(block) {
    const candidates = [];
    const seen = new Set();
    const addCandidate = (x, y, geometryBias = 0) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return;
      }
      const key = `${x}:${y}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      candidates.push({ page: block.page, x, y, geometryBias });
    };
    addCandidate(block.x, block.y, 0);
    if (Number.isFinite(block.h) && Number.isFinite(block.v)) {
      addCandidate(block.h, block.v, 0.5);
    }
    if (Number.isFinite(block.width) && Number.isFinite(block.height)) {
      const centerX = block.x + block.width / 2;
      const centerY = block.y + block.height / 2;
      addCandidate(centerX, centerY, 0.75);
      const widthSign = Math.sign(block.width) || 1;
      const heightSign = Math.sign(block.height) || 1;
      const bumpX = widthSign * Math.min(2, Math.max(Math.abs(block.width) - 1, 0));
      const bumpY = heightSign * Math.max(Math.abs(block.height) - 1, 0);
      if (bumpX !== 0 || bumpY !== 0) {
        addCandidate(block.x + bumpX, block.y + bumpY, 1);
      }
    }
    return candidates;
  }

  normalizeComparePath(targetPath) {
    if (!targetPath || typeof targetPath !== "string") {
      return null;
    }
    let normalized = path.normalize(path.resolve(targetPath));
    try {
      if (typeof fs.realpathSync.native === "function") {
        normalized = fs.realpathSync.native(normalized);
      } else {
        normalized = fs.realpathSync(normalized);
      }
    } catch {
      // Keep the resolved path when realpath cannot be resolved.
    }
    normalized = path.normalize(normalized);
    if (process.platform === "win32") {
      return normalized.toLowerCase();
    }
    return normalized;
  }

  isSamePath(leftPath, rightPath) {
    const left = this.normalizeComparePath(leftPath);
    const right = this.normalizeComparePath(rightPath);
    return Boolean(left && right && left === right);
  }

  pickBestReverseResult({ entries, preferredPath, targetLine, targetColumn = null }) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return null;
    }
    let pool = entries;
    if (preferredPath) {
      const samePathEntries = entries.filter((entry) =>
        this.isSamePath(entry.path, preferredPath)
      );
      if (samePathEntries.length > 0) {
        pool = samePathEntries;
      }
    }
    if (!Number.isFinite(targetLine) && !Number.isFinite(targetColumn)) {
      return pool[0];
    }
    let selected = pool[0];
    const scoreFor = (entry) => {
      const lineScore = Number.isFinite(targetLine) ? Math.abs(entry.line - targetLine) : 0;
      const entryColumn = Number.isFinite(entry.column) ? entry.column : 1;
      const columnScore = Number.isFinite(targetColumn)
        ? Math.abs(entryColumn - targetColumn)
        : 0;
      return lineScore * 100 + columnScore;
    };
    let bestScore = scoreFor(selected);
    for (let index = 1; index < pool.length; index += 1) {
      const candidate = pool[index];
      const score = scoreFor(candidate);
      if (score < bestScore) {
        selected = candidate;
        bestScore = score;
        continue;
      }
      if (score > bestScore) {
        continue;
      }
      if (candidate.line < selected.line) {
        selected = candidate;
        continue;
      }
      if (candidate.line > selected.line) {
        continue;
      }
      const selectedColumn = Number.isFinite(selected.column) ? selected.column : 1;
      const candidateColumn = Number.isFinite(candidate.column) ? candidate.column : 1;
      if (candidateColumn < selectedColumn) {
        selected = candidate;
      }
    }
    return selected;
  }

  getDominantReversePath(candidates, minGap = 3, dominanceRatio = 1.8) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return null;
    }
    const pathTotals = new Map();
    for (const candidate of candidates) {
      if (!candidate || typeof candidate.path !== "string") {
        continue;
      }
      const normalizedPath = this.normalizeComparePath(candidate.path);
      if (!normalizedPath) {
        continue;
      }
      const count = Number.isFinite(candidate.count) && candidate.count > 0 ? candidate.count : 1;
      pathTotals.set(normalizedPath, (pathTotals.get(normalizedPath) ?? 0) + count);
    }
    const ranked = Array.from(pathTotals.entries())
      .map(([path, total]) => ({ path, total }))
      .sort((left, right) => {
        if (right.total !== left.total) {
          return right.total - left.total;
        }
        return 0;
      });
    if (ranked.length < 2) {
      return null;
    }
    const winner = ranked[0];
    const runner = ranked[1];
    if (winner.total >= runner.total + minGap && winner.total >= runner.total * dominanceRatio) {
      return winner.path;
    }
    return null;
  }

  async resolveReverseLine({
    synctexPath,
    pdfPath,
    cwd,
    env,
    point,
    preferredPath = null,
    targetLine = null,
    targetColumn = null,
  }) {
    const target = `${point.page}:${point.x}:${point.y}:${pdfPath}`;
    let result;
    try {
      result = await this.runProcess(synctexPath, ["edit", "-o", target], cwd, env);
    } catch (_error) {
      return null;
    }
    if (result.status !== 0) {
      return null;
    }
    const entries = this.parseReverseResults(result.output, cwd);
    const parsed = this.pickBestReverseResult({
      entries,
      preferredPath,
      targetLine,
      targetColumn,
    });
    if (!parsed || !Number.isFinite(parsed.line) || parsed.line < 1) {
      return null;
    }
    return parsed;
  }

  async selectForwardPoint({
    blocks,
    targetLine,
    targetColumn = null,
    sourcePath,
    synctexPath,
    pdfPath,
    cwd,
    env,
  }) {
    if (!blocks.length) {
      return null;
    }
    const fallback = blocks[0];
    const fallbackPoint = { page: fallback.page, x: fallback.x, y: fallback.y };
    if (!Number.isFinite(targetLine)) {
      return fallbackPoint;
    }
    let bestScore = null;
    const bestCandidates = [];
    const pathPenalty = 1000000;
    const lineWeight = 100;
    const columnWeight = 1;
    const geometryWeight = 2;
    for (const block of blocks) {
      const candidates = this.buildForwardCandidates(block);
      for (const candidate of candidates) {
        const reverse = await this.resolveReverseLine({
          synctexPath,
          pdfPath,
          cwd,
          env,
          point: candidate,
          preferredPath: sourcePath,
          targetLine,
          targetColumn,
        });
        if (!reverse || !Number.isFinite(reverse.line)) {
          continue;
        }
        const samePath = !sourcePath || this.isSamePath(reverse.path, sourcePath);
        const lineDiff = Math.abs(reverse.line - targetLine);
        const reverseColumn = Number.isFinite(reverse.column) ? reverse.column : 1;
        const columnDiff = Number.isFinite(targetColumn)
          ? Math.abs(reverseColumn - targetColumn)
          : 0;
        const geometryBias = Number.isFinite(candidate.geometryBias) ? candidate.geometryBias : 0;
        const score =
          lineDiff * lineWeight +
          columnDiff * columnWeight +
          geometryBias * geometryWeight +
          (samePath ? 0 : pathPenalty);
        if (bestScore === null || score < bestScore) {
          bestScore = score;
          bestCandidates.length = 0;
          bestCandidates.push({
            candidate,
            reverse,
            samePath,
            lineDiff,
            columnDiff,
            geometryBias,
          });
        } else if (score === bestScore) {
          bestCandidates.push({
            candidate,
            reverse,
            samePath,
            lineDiff,
            columnDiff,
            geometryBias,
          });
        }
      }
    }
    if (!bestCandidates.length) {
      return fallbackPoint;
    }
    if (bestCandidates.length === 1) {
      const selected = bestCandidates[0];
      return {
        ...selected.candidate,
        matchedPath: selected.reverse.path,
        matchedLine: selected.reverse.line,
        matchedColumn: Number.isFinite(selected.reverse.column) ? selected.reverse.column : 1,
        matchDiff: selected.lineDiff,
        matchColumnDiff: Number.isFinite(targetColumn) ? selected.columnDiff : null,
        sameSourcePath: selected.samePath === true,
      };
    }
    let selectedItem = bestCandidates[0];
    let bestStability = -1;
    for (const item of bestCandidates) {
      const stability = await this.measureForwardStability({
        candidate: item.candidate,
        sourcePath,
        targetLine,
        targetColumn,
        synctexPath,
        pdfPath,
        cwd,
        env,
      });
      if (
        stability > bestStability ||
        (stability === bestStability &&
          (item.columnDiff < selectedItem.columnDiff ||
            (item.columnDiff === selectedItem.columnDiff &&
              item.geometryBias < selectedItem.geometryBias)))
      ) {
        bestStability = stability;
        selectedItem = item;
      }
    }
    return {
      ...selectedItem.candidate,
      matchedPath: selectedItem.reverse.path,
      matchedLine: selectedItem.reverse.line,
      matchedColumn: Number.isFinite(selectedItem.reverse.column)
        ? selectedItem.reverse.column
        : 1,
      matchDiff: selectedItem.lineDiff,
      matchColumnDiff: Number.isFinite(targetColumn) ? selectedItem.columnDiff : null,
      sameSourcePath: selectedItem.samePath === true,
    };
  }

  async measureForwardStability({
    candidate,
    sourcePath,
    targetLine,
    targetColumn = null,
    synctexPath,
    pdfPath,
    cwd,
    env,
  }) {
    const offsets = [-4, 0, 4];
    let hits = 0;
    for (const dx of offsets) {
      for (const dy of offsets) {
        const reverse = await this.resolveReverseLine({
          synctexPath,
          pdfPath,
          cwd,
          env,
          point: { page: candidate.page, x: candidate.x + dx, y: candidate.y + dy },
          preferredPath: sourcePath,
          targetLine,
          targetColumn,
        });
        const columnAligned =
          !Number.isFinite(targetColumn) ||
          (Number.isFinite(reverse?.column) && Math.abs(reverse.column - targetColumn) <= 4);
        if (
          reverse &&
          Number.isFinite(reverse.line) &&
          columnAligned &&
          (!sourcePath || this.isSamePath(reverse.path, sourcePath)) &&
          Math.abs(reverse.line - targetLine) <= 1
        ) {
          hits += 1;
        }
      }
    }
    return hits;
  }

  estimateReverseOffsetMax({ x, y }) {
    const magnitude = Math.max(Math.abs(Number(x)), Math.abs(Number(y)));
    if (!Number.isFinite(magnitude)) {
      return 120;
    }
    if (magnitude >= 6000) {
      return 220;
    }
    if (magnitude >= 3500) {
      return 180;
    }
    if (magnitude >= 1800) {
      return 140;
    }
    return 120;
  }

  buildReverseOffsets({ x, y, expanded = false } = {}) {
    const xOffsets = new Set([-72, -56, -40, -32, -24, -16, -8, -4, 0, 4, 8, 16, 24, 32, 40, 56, 72]);
    const yOffsets = new Set([-12, -8, -4, 0, 4, 8, 12]);
    if (expanded) {
      yOffsets.add(-2);
      yOffsets.add(2);
      yOffsets.add(-6);
      yOffsets.add(6);
      const max = this.estimateReverseOffsetMax({ x, y });
      for (let delta = 80; delta <= max; delta += 8) {
        xOffsets.add(delta);
        xOffsets.add(-delta);
      }
      const verticalMax = Math.min(48, Math.max(16, Math.floor(max / 3)));
      for (let delta = 16; delta <= verticalMax; delta += 4) {
        yOffsets.add(delta);
        yOffsets.add(-delta);
      }
    }
    return {
      xOffsets: Array.from(xOffsets).sort((a, b) => a - b),
      yOffsets: Array.from(yOffsets).sort((a, b) => a - b),
    };
  }

  async collectReverseCandidates({
    page,
    x,
    y,
    pdfPath,
    synctexPath,
    cwd,
    env,
    expanded = false,
  }) {
    const { xOffsets, yOffsets } = this.buildReverseOffsets({ x, y, expanded });
    const candidates = new Map();
    for (const dx of xOffsets) {
      for (const dy of yOffsets) {
        const target = `${page}:${x + dx}:${y + dy}:${pdfPath}`;
        let result;
        try {
          result = await this.runProcess(synctexPath, ["edit", "-o", target], cwd, env);
        } catch (_error) {
          continue;
        }
        if (result.status !== 0) {
          continue;
        }
        const parsed = this.parseReverseResult(result.output, cwd);
        if (!parsed) {
          continue;
        }
        const normalizedPath = this.normalizeComparePath(parsed.path) ?? parsed.path;
        const key = `${normalizedPath}:${parsed.line}:${parsed.column ?? 1}`;
        const existing = candidates.get(key);
        const offsetDistance = Math.abs(dx) + Math.abs(dy);
        if (existing) {
          existing.count += 1;
          if (offsetDistance === 0) {
            existing.exactHit = true;
          }
          if (
            !Number.isFinite(existing.minOffsetDistance) ||
            offsetDistance < existing.minOffsetDistance
          ) {
            existing.minOffsetDistance = offsetDistance;
          }
        } else {
          candidates.set(key, {
            ...parsed,
            count: 1,
            exactHit: offsetDistance === 0,
            minOffsetDistance: offsetDistance,
          });
        }
      }
    }
    return Array.from(candidates.values());
  }

  mergeReverseCandidates(primary, secondary) {
    const merged = new Map();
    const add = (candidate) => {
      if (!candidate || !candidate.path || !Number.isFinite(candidate.line)) {
        return;
      }
      const normalizedPath = this.normalizeComparePath(candidate.path) ?? candidate.path;
      const column = Number.isFinite(candidate.column) && candidate.column >= 1 ? candidate.column : 1;
      const count = Number.isFinite(candidate.count) && candidate.count > 0 ? candidate.count : 1;
      const exactHit = candidate.exactHit === true;
      const minOffsetDistance = Number.isFinite(candidate.minOffsetDistance)
        ? candidate.minOffsetDistance
        : Number.POSITIVE_INFINITY;
      const key = `${normalizedPath}:${candidate.line}:${column}`;
      const existing = merged.get(key);
      if (existing) {
        existing.count += count;
        existing.exactHit = existing.exactHit === true || exactHit;
        if (minOffsetDistance < existing.minOffsetDistance) {
          existing.minOffsetDistance = minOffsetDistance;
        }
        return;
      }
      merged.set(key, {
        ...candidate,
        column,
        count,
        exactHit,
        minOffsetDistance,
      });
    };
    for (const candidate of Array.isArray(primary) ? primary : []) {
      add(candidate);
    }
    for (const candidate of Array.isArray(secondary) ? secondary : []) {
      add(candidate);
    }
    return Array.from(merged.values());
  }

  shouldPreferReverseSelection(next, current) {
    if (!next) {
      return false;
    }
    if (!current) {
      return true;
    }
    if (next.confidence === true && current.confidence !== true) {
      return true;
    }
    if (current.confidence === true && next.confidence !== true) {
      return false;
    }
    const nextDistance = Number.isFinite(next.distance) ? next.distance : Number.POSITIVE_INFINITY;
    const currentDistance = Number.isFinite(current.distance)
      ? current.distance
      : Number.POSITIVE_INFINITY;
    if (nextDistance !== currentDistance) {
      return nextDistance < currentDistance;
    }
    const nextGap = Number.isFinite(next.scoreGap) ? next.scoreGap : -1;
    const currentGap = Number.isFinite(current.scoreGap) ? current.scoreGap : -1;
    if (nextGap !== currentGap) {
      return nextGap > currentGap;
    }
    const nextCount = Number.isFinite(next.count) ? next.count : 0;
    const currentCount = Number.isFinite(current.count) ? current.count : 0;
    if (nextCount !== currentCount) {
      return nextCount > currentCount;
    }
    return next.line < current.line;
  }

  async selectReverseCandidate({ candidates, click, synctexPath, pdfPath, cwd, env }) {
    if (!candidates.length) {
      return null;
    }
    const dominantPath = this.getDominantReversePath(candidates);
    const selectionPool = dominantPath
      ? candidates.filter((candidate) => {
          if (!candidate || typeof candidate.path !== 'string') {
            return false;
          }
          return this.normalizeComparePath(candidate.path) === dominantPath;
        })
      : candidates;
    const pooledCandidates = selectionPool.length > 0 ? selectionPool : candidates;
    const exactCandidates = pooledCandidates.filter((candidate) => candidate?.exactHit === true);
    const activeCandidates = exactCandidates.length > 0 ? exactCandidates : pooledCandidates;
    const distanceEpsilon = 1e-3;
    const medianLine = this.getMedianLine(candidates);
    const medianWeight = 0;
    const countWeight = 4;
    const offsetWeight = 12;
    const scoredCandidates = [];
    for (const candidate of activeCandidates) {
      const distance = await this.measureForwardDistance({
        synctexPath,
        pdfPath,
        sourcePath: candidate.path,
        line: candidate.line,
        column: candidate.column ?? 1,
        click,
        cwd,
        env,
      });
      if (!Number.isFinite(distance)) {
        continue;
      }
      const medianDiff = medianLine === null ? 0 : Math.abs(candidate.line - medianLine);
      const offsetPenalty = Number.isFinite(candidate.minOffsetDistance)
        ? candidate.minOffsetDistance * offsetWeight
        : 0;
      const linePenalty = this.getReverseLinePenalty({
        sourcePath: candidate.path,
        line: candidate.line,
      });
      const score =
        distance +
        linePenalty +
        medianDiff * medianWeight +
        offsetPenalty -
        candidate.count * countWeight;
      scoredCandidates.push({ candidate, distance, score });
    }
    if (!scoredCandidates.length) {
      const fallback = candidates.reduce(
        (prev, next) => (next.count > prev.count ? next : prev),
        candidates[0]
      );
      return { ...fallback, confidence: false, scoreGap: null, distance: null };
    }
    scoredCandidates.sort((a, b) => {
      const scoreDiff = a.score - b.score;
      if (Math.abs(scoreDiff) > distanceEpsilon) {
        return scoreDiff;
      }
      if (this.isBetterReverseTie(a.candidate, b.candidate, medianLine)) {
        return -1;
      }
      if (this.isBetterReverseTie(b.candidate, a.candidate, medianLine)) {
        return 1;
      }
      return 0;
    });
    const best = scoredCandidates[0];
    const second = scoredCandidates.length > 1 ? scoredCandidates[1] : null;
    const scoreGap = second ? second.score - best.score : null;
    const confidence = this.isReverseConfidence(best, second);
    return {
      ...best.candidate,
      confidence,
      scoreGap: Number.isFinite(scoreGap) ? scoreGap : null,
      distance: best.distance,
    };
  }

  getMedianLine(candidates) {
    const lines = Array.from(new Set(candidates.map((candidate) => candidate.line))).sort(
      (a, b) => a - b
    );
    if (!lines.length) {
      return null;
    }
    const middle = Math.floor(lines.length / 2);
    if (lines.length % 2 === 1) {
      return lines[middle];
    }
    return (lines[middle - 1] + lines[middle]) / 2;
  }

  isBetterReverseTie(candidate, current, medianLine) {
    if (medianLine !== null) {
      const candidateDistance = Math.abs(candidate.line - medianLine);
      const currentDistance = Math.abs(current.line - medianLine);
      if (candidateDistance !== currentDistance) {
        return candidateDistance < currentDistance;
      }
    }
    if (candidate.count !== current.count) {
      return candidate.count > current.count;
    }
    return candidate.line < current.line;
  }

  isReverseConfidence(best, second) {
    if (!best || !Number.isFinite(best.distance)) {
      return false;
    }
    const maxDistance = 3600;
    const minScoreGap = 5;
    const minCount = 2;
    if (best.distance > maxDistance) {
      return false;
    }
    if (best.candidate.count < minCount) {
      return false;
    }
    if (!second) {
      return true;
    }
    return second.score - best.score >= minScoreGap;
  }

  async measureForwardDistance({
    synctexPath,
    pdfPath,
    sourcePath,
    line,
    column,
    click,
    cwd,
    env,
  }) {
    const maxBoxWidth = 200;
    const maxBoxHeight = 60;
    const target = `${line}:${column}:${sourcePath}`;
    let result;
    try {
      result = await this.runProcess(synctexPath, ["view", "-i", target, "-o", pdfPath], cwd, env);
    } catch (_error) {
      return null;
    }
    if (result.status !== 0) {
      return null;
    }
    const blocks = this.parseForwardBlocks(result.output);
    if (!blocks.length) {
      return null;
    }
    let best = null;
    for (const block of blocks) {
      if (Number.isFinite(click.page) && block.page !== click.page) {
        continue;
      }
      if (
        Number.isFinite(block.width) &&
        Number.isFinite(block.height) &&
        block.width > 0 &&
        block.height > 0 &&
        block.width <= maxBoxWidth &&
        block.height <= maxBoxHeight
      ) {
        const left = Math.min(block.x, block.x + block.width);
        const right = Math.max(block.x, block.x + block.width);
        const top = Math.min(block.y, block.y + block.height);
        const bottom = Math.max(block.y, block.y + block.height);
        const dx =
          click.x < left ? left - click.x : click.x > right ? click.x - right : 0;
        const dy =
          click.y < top ? top - click.y : click.y > bottom ? click.y - bottom : 0;
        const dist = dx * dx + dy * dy;
        if (best === null || dist < best) {
          best = dist;
        }
        continue;
      }
      const points = [
        { x: block.x, y: block.y },
        Number.isFinite(block.h) && Number.isFinite(block.v) ? { x: block.h, y: block.v } : null,
      ].filter(Boolean);
      for (const point of points) {
        const dx = point.x - click.x;
        const dy = point.y - click.y;
        const dist = dx * dx + dy * dy;
        if (best === null || dist < best) {
          best = dist;
        }
      }
    }
    return best;
  }

  resolveReverseEntryPath(targetPath, cwd = null) {
    if (!targetPath || typeof targetPath !== "string") {
      return null;
    }
    const trimmed = targetPath.trim();
    if (!trimmed) {
      return null;
    }
    if (path.isAbsolute(trimmed)) {
      return trimmed;
    }
    if (cwd && typeof cwd === "string") {
      return path.resolve(cwd, trimmed);
    }
    return path.resolve(trimmed);
  }

  parseReverseResults(output, cwd = null) {
    if (!output || typeof output !== "string") {
      return [];
    }
    const lines = output.split(/\r?\n/);
    const entries = [];
    let currentPath = null;
    let currentLine = null;
    let currentColumn = null;
    const flush = () => {
      if (!currentPath || !Number.isFinite(currentLine) || currentLine < 1) {
        currentPath = null;
        currentLine = null;
        currentColumn = null;
        return;
      }
      entries.push({
        path: currentPath,
        line: currentLine,
        column:
          Number.isFinite(currentColumn) && currentColumn >= 1
            ? currentColumn
            : 1,
      });
      currentPath = null;
      currentLine = null;
      currentColumn = null;
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith("Input:")) {
        flush();
        const parsedPath = line.slice("Input:".length).trim();
        currentPath = this.resolveReverseEntryPath(parsedPath, cwd);
        continue;
      }
      if (line.startsWith("Line:")) {
        const parsedLine = Number.parseInt(line.slice("Line:".length).trim(), 10);
        currentLine = Number.isFinite(parsedLine) ? parsedLine : null;
        continue;
      }
      if (line.startsWith("Column:")) {
        const parsedColumn = Number.parseInt(line.slice("Column:".length).trim(), 10);
        currentColumn = Number.isFinite(parsedColumn) ? parsedColumn : null;
      }
    }
    flush();
    return entries;
  }

  parseReverseResult(output, cwd = null) {
    const entries = this.parseReverseResults(output, cwd);
    if (!entries.length) {
      return null;
    }
    return entries[0];
  }

  async runProcess(command, args, cwd, env) {
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

  findSynctex() {
    const candidates = [];
    if (process.platform === "darwin") {
      candidates.push(
        "/Library/TeX/texbin/synctex",
        "/usr/local/bin/synctex",
        "/opt/homebrew/bin/synctex",
        "/usr/bin/synctex"
      );
    } else if (process.platform === "win32") {
      candidates.push(
        "C:\\texlive\\2024\\bin\\windows\\synctex.exe",
        "C:\\texlive\\2023\\bin\\windows\\synctex.exe",
        "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\synctex.exe",
        "C:\\Program Files (x86)\\MiKTeX\\miktex\\bin\\x64\\synctex.exe"
      );
    }
    const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
    for (const entry of pathEntries) {
      const name = process.platform === "win32" ? "synctex.exe" : "synctex";
      candidates.push(path.join(entry, name));
    }
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }
}

module.exports = { SynctexService };
