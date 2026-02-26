import type { WysiwygPackId } from "./math-wysiwyg-packs.js";
import type { MathKey } from "../../app/types.js";

export type Candidate = {
  id: string;
  key: MathKey;
  label: string;
  hint: string;
  displayLatex?: string;
  priority: number;
  apply?: (mathfield: any) => void;
};

export type TriggerGroup = {
  trigger: string;
  candidates: Candidate[];
  priority: number;
  pack: WysiwygPackId;
};
