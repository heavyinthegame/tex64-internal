import type { IndexEntry, SectionEntry } from "./types.js";

export const dedupeByKey = (entries: IndexEntry[]) => {
  const map = new Map<string, IndexEntry>();
  entries.forEach((entry) => {
    if (!map.has(entry.key)) {
      map.set(entry.key, entry);
    }
  });
  return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key, "ja"));
};

export const dedupeSections = (entries: SectionEntry[]) => {
  const map = new Map<string, SectionEntry>();
  entries.forEach((entry) => {
    const token = `${entry.title}|${entry.path}|${entry.line}|${entry.level}`;
    if (!map.has(token)) {
      map.set(token, entry);
    }
  });
  return Array.from(map.values()).sort((a, b) => {
    if (a.path !== b.path) {
      return a.path.localeCompare(b.path, "ja");
    }
    return a.line - b.line;
  });
};

export const pickCitationEntries = (entries: IndexEntry[]) => {
  const bibEntries = entries.filter((entry) => entry.path.endsWith(".bib"));
  if (bibEntries.length > 0) {
    return dedupeByKey(bibEntries);
  }
  return dedupeByKey(entries);
};
