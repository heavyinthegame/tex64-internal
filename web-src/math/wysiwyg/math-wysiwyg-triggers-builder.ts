import { collectKeyVariants, extractCommand, getKeyByLatex, normalizeLatexKey } from "./math-wysiwyg-keymap.js";
import { MANUAL_TRIGGERS } from "./math-wysiwyg-triggers-data.js";
import type { Candidate, TriggerGroup } from "./math-wysiwyg-triggers-types.js";
import type { MathKey } from "../../app/types.js";

const isWordToken = (value: string) => /^[A-Za-z]+$/.test(value);

const buildMathKeyDisplayLatex = (key: MathKey) => {
  const source = key.displayLatex ?? key.latex ?? key.fallback;
  if (!source) {
    return null;
  }
  const placeholders = ["x", "y", "z", "a", "b", "c"];
  let index = 0;
  return source.replace(/#\?/g, () => {
    const value = placeholders[index] ?? "x";
    index += 1;
    return value;
  });
};

export const makeCandidate = (
  trigger: string,
  key: MathKey,
  priority: number,
  labelOverride?: string,
  displayLatexOverride?: string
): Candidate => {
  const label = labelOverride ?? key.label ?? trigger;
  const displayLatex = displayLatexOverride ?? buildMathKeyDisplayLatex(key) ?? undefined;
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
  const map = new Map<string, TriggerGroup>();
  const candidateIdsByTrigger = new Map<string, Set<string>>();

  const ensureGroup = (
    trigger: string,
    groupPriority: number | undefined
  ): TriggerGroup => {
    const normalizedTrigger = trigger.toLowerCase();
    let group = map.get(normalizedTrigger);
    if (!group) {
      group = {
        trigger: normalizedTrigger,
        candidates: [],
        priority: groupPriority ?? 0,
      };
      map.set(normalizedTrigger, group);
      candidateIdsByTrigger.set(normalizedTrigger, new Set<string>());
    } else if (groupPriority !== undefined) {
      group.priority = Math.max(group.priority, groupPriority);
    }
    return group;
  };

  const addCandidate = (
    trigger: string,
    key: MathKey,
    priority: number,
    labelOverride?: string,
    displayLatexOverride?: string,
    groupPriority?: number
  ) => {
    const normalizedTrigger = trigger.toLowerCase();
    const candidate = makeCandidate(
      normalizedTrigger,
      key,
      priority,
      labelOverride,
      displayLatexOverride
    );
    const group = ensureGroup(normalizedTrigger, groupPriority);
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
      const key = getKeyByLatex(candidate.latex, candidate.label, candidate.displayLatex);
      addCandidate(
        entry.trigger,
        key,
        entry.priority - index * 2,
        candidate.label,
        candidate.displayLatex,
        entry.priority
      );
    });
  });

  const variants = collectKeyVariants();
  variants.forEach((key) => {
    const command = extractCommand(key.latex);
    if (command) {
      addCandidate(command, key, 30);
    }
    if (isWordToken(key.label)) {
      addCandidate(key.label, key, 20);
    }
  });

  return map;
};
