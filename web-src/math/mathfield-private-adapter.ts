type MathfieldMode = "math" | "text" | "latex";

type InternalMathfieldModel = {
  mode?: MathfieldMode | string;
  at?: (offset: number) => any;
  setSelection?: (start: number, end: number) => void;
  atoms?: any[];
  offsetOf?: (atom: any) => number;
  getBranchRange?: (offset: number, branch: string) => [number, number] | null;
  getCellRange?: (offset: number) => [number, number] | null;
  getSiblingsRange?: (offset: number) => [number, number] | null;
  selectionIsPlaceholder?: boolean;
  lastOffset?: number;
};

type InternalMathfieldMenu = {
  state?: string;
  element?: HTMLElement;
  hide?: () => void;
};

const SUPPORTED_INTERNAL_VERSION_PREFIX = "0.108.";

const normalizeMode = (value: unknown): MathfieldMode | null => {
  if (value === "math" || value === "text" || value === "latex") {
    return value;
  }
  return null;
};

const resolveMathfieldVersion = (mathfieldApi: any): string | null => {
  const globalScope = globalThis as any;
  const candidate =
    (mathfieldApi && typeof mathfieldApi.version === "string"
      ? mathfieldApi.version
      : globalScope?.MathLive?.version) ?? null;
  return typeof candidate === "string" ? candidate : null;
};

export const canUseMathfieldInternalApi = (mathfieldApi: any): boolean => {
  const version = resolveMathfieldVersion(mathfieldApi);
  if (!version) {
    return true;
  }
  return version.startsWith(SUPPORTED_INTERNAL_VERSION_PREFIX);
};

const getInternalMathfield = (mathfieldApi: any) => {
  if (!canUseMathfieldInternalApi(mathfieldApi)) {
    return null;
  }
  const internal = (mathfieldApi as { _mathfield?: unknown })?._mathfield;
  return internal && typeof internal === "object" ? internal : null;
};

export const getMathfieldInternalModel = (
  mathfieldApi: any
): InternalMathfieldModel | null => {
  const internal = getInternalMathfield(mathfieldApi) as { model?: unknown } | null;
  const model = internal?.model;
  return model && typeof model === "object" ? (model as InternalMathfieldModel) : null;
};

const getMathfieldInternalMenu = (
  mathfieldApi: any
): InternalMathfieldMenu | null => {
  const internal = getInternalMathfield(mathfieldApi) as { menu?: unknown } | null;
  const menu = internal?.menu;
  return menu && typeof menu === "object" ? (menu as InternalMathfieldMenu) : null;
};

export const closeMathfieldInternalMenu = (mathfieldApi: any): boolean => {
  const menu = getMathfieldInternalMenu(mathfieldApi);
  if (!menu || typeof menu.hide !== "function") {
    return false;
  }
  if (menu.state && menu.state !== "closed") {
    menu.hide();
    return true;
  }
  if (menu.element?.isConnected) {
    menu.hide();
    return true;
  }
  return false;
};

export const getMathfieldModeAtOffset = (
  mathfieldApi: any,
  offset: number
): MathfieldMode | null => {
  const model = getMathfieldInternalModel(mathfieldApi);
  if (!model || typeof model.at !== "function") {
    return null;
  }
  try {
    const atom = model.at(offset);
    return normalizeMode(atom?.mode);
  } catch {
    return null;
  }
};

export const setMathfieldMode = (
  mathfieldApi: any,
  nextMode: "math" | "text"
): boolean => {
  const model = getMathfieldInternalModel(mathfieldApi);
  if (model) {
    try {
      model.mode = nextMode;
      return true;
    } catch {
      // fallback to public mode setter
    }
  }
  try {
    mathfieldApi.mode = nextMode;
  } catch {
    return false;
  }
  return normalizeMode(mathfieldApi?.mode) === nextMode;
};

export const isMathfieldSelectionPlaceholder = (mathfieldApi: any): boolean => {
  const model = getMathfieldInternalModel(mathfieldApi);
  return Boolean(model?.selectionIsPlaceholder);
};
