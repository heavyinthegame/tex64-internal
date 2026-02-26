import { buildTriggerMap, makeCandidate } from "./math-wysiwyg-triggers-builder.js";

export type { Candidate } from "./math-wysiwyg-triggers-types.js";
export { makeCandidate };

export const TRIGGER_MAP = buildTriggerMap();
export const TRIGGER_KEYS = Array.from(TRIGGER_MAP.keys());
