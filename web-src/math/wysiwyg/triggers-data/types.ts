export type WysiwygTriggerCandidate = {
  latex: string;
  label: string;
  displayLatex?: string;
};

export type WysiwygManualTrigger = {
  trigger: string;
  priority: number;
  candidates: WysiwygTriggerCandidate[];
};
