const path = require("path");
const fsp = require("fs/promises");
const { normalizeRelativePath } = require("./workspace.cjs");
const {
  ALWAYS_IGNORED_DIRECTORIES,
  isPathAllowed,
  isTextExtension,
  normalizePath,
} = require("./agent-policy.cjs");

const MAX_SEARCH_RESULTS = 200;

const buildSearchResults = (content, lowerQuery, relPath, results, limit) => {
  if (!content) {
    return;
  }
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (results.length >= limit) {
      return;
    }
    const line = lines[index];
    if (line.toLowerCase().includes(lowerQuery)) {
      results.push({
        path: relPath,
        line: index + 1,
        preview: line.trim(),
      });
    }
  }
};

const handleSearchFiles = async (service, args, policy, conversationId) => {
  const query = typeof args.query === "string" ? args.query : "";
  const rootPath = service.workspace.getRootPath();
  if (!rootPath) {
    return { error: "ワークスペースが選択されていません。" };
  }
  const trimmed = query.trim();
  if (!trimmed) {
    return { results: [] };
  }
  const lowerQuery = trimmed.toLowerCase();
  const results = [];
  const seenPaths = new Set();
  const context = service.contextByConversation.get(conversationId);
  const activePath =
    typeof context?.activeFilePath === "string" ? normalizePath(context.activeFilePath) : "";
  if (
    activePath &&
    typeof context?.activeFileContent === "string" &&
    results.length < MAX_SEARCH_RESULTS &&
    isPathAllowed(activePath, policy) &&
    isTextExtension(activePath, policy)
  ) {
    seenPaths.add(activePath);
    buildSearchResults(
      context.activeFileContent,
      lowerQuery,
      activePath,
      results,
      MAX_SEARCH_RESULTS
    );
  }
  if (context?.openFileSnapshots && Array.isArray(context.openFileSnapshots)) {
    context.openFileSnapshots.forEach((snapshot) => {
      if (
        typeof snapshot?.path === "string" &&
        typeof snapshot?.content === "string" &&
        results.length < MAX_SEARCH_RESULTS
      ) {
        const snapshotPath = normalizePath(snapshot.path);
        if (!snapshotPath) {
          return;
        }
        if (!isPathAllowed(snapshotPath, policy) || !isTextExtension(snapshotPath, policy)) {
          return;
        }
        seenPaths.add(snapshotPath);
        buildSearchResults(
          snapshot.content,
          lowerQuery,
          snapshotPath,
          results,
          MAX_SEARCH_RESULTS
        );
      }
    });
  }
  const walk = async (dirPath) => {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (results.length >= MAX_SEARCH_RESULTS) {
        return;
      }
      if (entry.isDirectory() && ALWAYS_IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const absPath = path.join(dirPath, entry.name);
      const relPath = normalizeRelativePath(path.relative(rootPath, absPath));
      if (!isPathAllowed(relPath, policy)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!isTextExtension(relPath, policy)) {
        continue;
      }
      if (seenPaths.has(relPath)) {
        continue;
      }
      const stat = await fsp.stat(absPath).catch(() => null);
      if (!stat || !stat.isFile() || stat.size > policy.maxFileBytes) {
        continue;
      }
      const content = await fsp.readFile(absPath, "utf8").catch(() => null);
      if (content === null) {
        continue;
      }
      buildSearchResults(content, lowerQuery, relPath, results, MAX_SEARCH_RESULTS);
    }
  };
  await walk(rootPath);
  return { results };
};

module.exports = {
  buildSearchResults,
  handleSearchFiles,
};
