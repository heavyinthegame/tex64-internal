import { dedupeByKey, dedupeSections, pickCitationEntries } from "./index-utils.js";
export const initOutlineUi = (context, deps) => {
    const { outlineEmpty, outlineSections, outlineTodos, outlineLabels, outlineCitations, } = context.dom;
    const filterEntriesForCurrent = (entries) => {
        const activePath = deps.getActiveFilePath();
        if (!activePath) {
            return [];
        }
        return entries.filter((entry) => entry.path === activePath);
    };
    const renderOutlineList = (container, entries, kind) => {
        container.innerHTML = "";
        if (entries.length === 0) {
            return;
        }
        entries.forEach((entry) => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "outline-item";
            if (kind) {
                item.dataset.kind = kind;
            }
            const key = document.createElement("div");
            key.textContent = entry.key;
            item.append(key);
            item.addEventListener("click", () => {
                deps.onJumpToLocation(entry);
            });
            container.appendChild(item);
        });
    };
    const renderSectionList = (container, entries) => {
        container.innerHTML = "";
        if (entries.length === 0) {
            return;
        }
        const baseLevel = Math.min(...entries.map((entry) => entry.level));
        const counters = new Array(8).fill(0);
        const sectionLabels = ["章", "節", "小節", "項", "小項", "段落", "小段落"];
        entries.forEach((entry) => {
            var _a;
            const depth = Math.max(entry.level - baseLevel, 0);
            counters[depth] += 1;
            for (let i = depth + 1; i < counters.length; i += 1) {
                counters[i] = 0;
            }
            const numberParts = counters.slice(0, depth + 1).filter((value) => value > 0);
            const label = (_a = sectionLabels[depth]) !== null && _a !== void 0 ? _a : "節";
            const prefix = `${numberParts.join(".")}${label}`;
            const item = document.createElement("button");
            item.type = "button";
            item.className = "outline-item";
            item.dataset.kind = "section";
            item.style.paddingLeft = `${8 + depth * 12}px`;
            const title = document.createElement("div");
            title.textContent = `${prefix} ${entry.title}`;
            item.append(title);
            item.addEventListener("click", () => {
                deps.onJumpToSection(entry);
            });
            container.appendChild(item);
        });
    };
    const render = () => {
        if (!(outlineLabels instanceof HTMLElement) ||
            !(outlineCitations instanceof HTMLElement) ||
            !(outlineSections instanceof HTMLElement) ||
            !(outlineTodos instanceof HTMLElement)) {
            return;
        }
        const sectionEntries = dedupeSections(filterEntriesForCurrent(deps.getIndexSections()));
        const todoEntries = dedupeByKey(filterEntriesForCurrent(deps.getIndexTodos()));
        const labelEntries = dedupeByKey(filterEntriesForCurrent(deps.getIndexLabels()));
        const citationEntries = pickCitationEntries(filterEntriesForCurrent(deps.getIndexCitations()));
        renderSectionList(outlineSections, sectionEntries);
        renderOutlineList(outlineTodos, todoEntries, "todo");
        renderOutlineList(outlineLabels, labelEntries);
        renderOutlineList(outlineCitations, citationEntries);
        if (outlineEmpty instanceof HTMLElement) {
            const hasItems = sectionEntries.length > 0 ||
                todoEntries.length > 0 ||
                labelEntries.length > 0 ||
                citationEntries.length > 0;
            outlineEmpty.classList.toggle("is-hidden", hasItems);
            if (!hasItems) {
                outlineEmpty.textContent =
                    deps.getWorkspaceRootKey() === null
                        ? "ワークスペースが未選択です。"
                        : deps.getActiveFilePath() === null
                            ? "ファイルが未選択です。"
                            : "インデックス項目が見つかりません。";
            }
        }
    };
    return { render };
};
