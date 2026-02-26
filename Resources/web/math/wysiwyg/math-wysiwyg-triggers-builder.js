import { collectKeyVariants, extractCommand, getKeyByLatex, normalizeLatexKey } from "./math-wysiwyg-keymap.js";
import { ALIAS_TRIGGERS, MANUAL_TRIGGERS } from "./math-wysiwyg-triggers-data.js";
const isWordToken = (value) => /^[A-Za-z]+$/.test(value);
const buildMathKeyDisplayLatex = (key) => {
    var _a, _b;
    const source = (_b = (_a = key.displayLatex) !== null && _a !== void 0 ? _a : key.latex) !== null && _b !== void 0 ? _b : key.fallback;
    if (!source) {
        return null;
    }
    const placeholders = ["x", "y", "z", "a", "b", "c"];
    let index = 0;
    return source.replace(/#\?/g, () => {
        var _a;
        const value = (_a = placeholders[index]) !== null && _a !== void 0 ? _a : "x";
        index += 1;
        return value;
    });
};
export const makeCandidate = (trigger, key, priority, labelOverride, displayLatexOverride) => {
    var _a, _b;
    const label = (_a = labelOverride !== null && labelOverride !== void 0 ? labelOverride : key.label) !== null && _a !== void 0 ? _a : trigger;
    const displayLatex = (_b = displayLatexOverride !== null && displayLatexOverride !== void 0 ? displayLatexOverride : buildMathKeyDisplayLatex(key)) !== null && _b !== void 0 ? _b : undefined;
    const id = `${normalizeLatexKey(key.latex)}|${label}`;
    return {
        id,
        key,
        label,
        hint: trigger,
        displayLatex,
        priority,
    };
};
export const buildTriggerMap = () => {
    const map = new Map();
    const candidateIdsByTrigger = new Map();
    const ensureGroup = (trigger, groupPriority, pack) => {
        const normalizedTrigger = trigger.toLowerCase();
        let group = map.get(normalizedTrigger);
        if (!group) {
            group = {
                trigger: normalizedTrigger,
                candidates: [],
                priority: groupPriority !== null && groupPriority !== void 0 ? groupPriority : 0,
                pack,
            };
            map.set(normalizedTrigger, group);
            candidateIdsByTrigger.set(normalizedTrigger, new Set());
        }
        else if (groupPriority !== undefined) {
            group.priority = Math.max(group.priority, groupPriority);
        }
        return group;
    };
    const addCandidate = (trigger, key, priority, labelOverride, displayLatexOverride, groupPriority, pack = "core") => {
        const normalizedTrigger = trigger.toLowerCase();
        const candidate = makeCandidate(normalizedTrigger, key, priority, labelOverride, displayLatexOverride);
        const group = ensureGroup(normalizedTrigger, groupPriority, pack);
        const seenIds = candidateIdsByTrigger.get(normalizedTrigger);
        if (!seenIds) {
            return;
        }
        if (!seenIds.has(candidate.id)) {
            group.candidates.push(candidate);
            seenIds.add(candidate.id);
        }
    };
    MANUAL_TRIGGERS.forEach((entry) => {
        entry.candidates.forEach((candidate, index) => {
            var _a;
            const key = getKeyByLatex(candidate.latex, candidate.label, candidate.displayLatex);
            addCandidate(entry.trigger, key, entry.priority - index * 2, candidate.label, candidate.displayLatex, entry.priority, (_a = entry.pack) !== null && _a !== void 0 ? _a : "core");
        });
    });
    const variants = collectKeyVariants();
    variants.forEach((key) => {
        const command = extractCommand(key.latex);
        if (command) {
            addCandidate(command, key, 30, undefined, undefined, undefined, "core");
        }
        if (isWordToken(key.label)) {
            addCandidate(key.label, key, 20, undefined, undefined, undefined, "core");
        }
    });
    const addAliasCandidates = (alias, canonical, priorityBoost = 0) => {
        const canonicalKey = canonical.toLowerCase();
        const aliasKey = alias.toLowerCase();
        const canonicalGroup = map.get(canonicalKey);
        if (!canonicalGroup) {
            return;
        }
        const aliasGroup = ensureGroup(aliasKey, canonicalGroup.priority + priorityBoost, canonicalGroup.pack);
        const aliasSeenIds = candidateIdsByTrigger.get(aliasKey);
        if (!aliasSeenIds) {
            return;
        }
        canonicalGroup.candidates.forEach((candidate) => {
            const aliasCandidate = {
                ...candidate,
                hint: canonicalGroup.trigger,
                priority: candidate.priority + priorityBoost,
            };
            if (!aliasSeenIds.has(aliasCandidate.id)) {
                aliasGroup.candidates.push(aliasCandidate);
                aliasSeenIds.add(aliasCandidate.id);
            }
        });
        aliasGroup.priority = Math.max(aliasGroup.priority, canonicalGroup.priority + priorityBoost);
        aliasGroup.pack = canonicalGroup.pack;
    };
    ALIAS_TRIGGERS.forEach((entry) => {
        var _a;
        addAliasCandidates(entry.alias, entry.canonical, (_a = entry.priorityBoost) !== null && _a !== void 0 ? _a : 0);
    });
    return map;
};
