export const LATEX_ENV_TOKEN_RE = /\\(begin|end)\{([A-Za-z*]+)\}/g;

export const normalizeEnvironmentName = (name: string) => name.replace(/\*$/, "");

type EnvEntry = {
  name: string;
  tokenStart: number;
  tokenEnd: number;
  bodyStart: number;
};

export type ContainingEnvironmentMatch = {
  name: string;
  beginStart: number;
  beginEnd: number;
  bodyStart: number;
  bodyEnd: number;
  endStart: number;
  endEnd: number;
};

export type NativeMathfieldEnvironmentContext = {
  mode: "math" | "text" | "latex";
  environments: string[];
  nearestArrayEnvironment: string | null;
  nearestArrayCell: { row: number; column: number } | null;
  nearestArrayIsMultiline: boolean;
};

const normalizeMode = (value: unknown): "math" | "text" | "latex" => {
  if (value === "text" || value === "latex") {
    return value;
  }
  return "math";
};

const sanitizeEnvironmentList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const items = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
  if (items.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  items.forEach((item) => {
    if (seen.has(item)) {
      return;
    }
    seen.add(item);
    result.push(item);
  });
  return result;
};

export const readNativeMathfieldEnvironmentContext = (
  mathfieldApi: any,
  cursorOffset: number
): NativeMathfieldEnvironmentContext | null => {
  if (typeof mathfieldApi?.getEnvironmentContext !== "function") {
    return null;
  }
  try {
    const raw = mathfieldApi.getEnvironmentContext(cursorOffset);
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const record = raw as {
      mode?: unknown;
      environments?: unknown;
      nearestArray?: {
        environmentName?: unknown;
        row?: unknown;
        column?: unknown;
        isMultiline?: unknown;
      } | null;
    };
    const nearestArray = record.nearestArray && typeof record.nearestArray === "object"
      ? record.nearestArray
      : null;
    const environmentName =
      nearestArray && typeof nearestArray.environmentName === "string"
        ? nearestArray.environmentName
        : null;
    const row =
      nearestArray && typeof nearestArray.row === "number" && Number.isFinite(nearestArray.row)
        ? Math.max(0, Math.floor(nearestArray.row))
        : null;
    const column =
      nearestArray &&
      typeof nearestArray.column === "number" &&
      Number.isFinite(nearestArray.column)
        ? Math.max(0, Math.floor(nearestArray.column))
        : null;
    return {
      mode: normalizeMode(record.mode),
      environments: sanitizeEnvironmentList(record.environments),
      nearestArrayEnvironment: environmentName,
      nearestArrayCell:
        row !== null && column !== null
          ? {
              row,
              column,
            }
          : null,
      nearestArrayIsMultiline: Boolean(nearestArray?.isMultiline),
    };
  } catch {
    return null;
  }
};

export const hasEnvironmentInContext = (
  context: NativeMathfieldEnvironmentContext | null,
  allowedNames: ReadonlySet<string>
): boolean => {
  if (!context) {
    return false;
  }
  if (
    context.nearestArrayEnvironment &&
    allowedNames.has(normalizeEnvironmentName(context.nearestArrayEnvironment))
  ) {
    return true;
  }
  return context.environments.some((name) =>
    allowedNames.has(normalizeEnvironmentName(name))
  );
};

export const findContainingEnvironmentAtCursor = (
  latex: string,
  cursorIndex: number,
  allowedNames?: ReadonlySet<string>
): ContainingEnvironmentMatch | null => {
  if (!latex || cursorIndex < 0) {
    return null;
  }

  const stack: EnvEntry[] = [];
  let match: RegExpExecArray | null = null;
  let bestMatch: ContainingEnvironmentMatch | null = null;
  LATEX_ENV_TOKEN_RE.lastIndex = 0;

  while ((match = LATEX_ENV_TOKEN_RE.exec(latex))) {
    const kind = match[1];
    const name = match[2];
    const tokenStart = match.index;
    const tokenText = match[0];
    const tokenEnd = tokenStart + tokenText.length;

    if (kind === "begin") {
      stack.push({
        name,
        tokenStart,
        tokenEnd,
        bodyStart: tokenEnd,
      });
      continue;
    }

    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i].name !== name) {
        continue;
      }
      const entry = stack.splice(i, 1)[0];
      const base = normalizeEnvironmentName(name);
      if (allowedNames && !allowedNames.has(base)) {
        break;
      }
      const bodyEnd = tokenStart;
      if (cursorIndex < entry.bodyStart || cursorIndex > bodyEnd) {
        break;
      }
      const nextMatch: ContainingEnvironmentMatch = {
        name,
        beginStart: entry.tokenStart,
        beginEnd: entry.tokenEnd,
        bodyStart: entry.bodyStart,
        bodyEnd,
        endStart: tokenStart,
        endEnd: tokenEnd,
      };
      if (!bestMatch || nextMatch.bodyStart >= bestMatch.bodyStart) {
        bestMatch = nextMatch;
      }
      break;
    }
  }

  return bestMatch;
};

export const isCursorInsideEnvironmentBody = (
  latex: string,
  cursorIndex: number,
  allowedNames: ReadonlySet<string>
): boolean => {
  return findContainingEnvironmentAtCursor(latex, cursorIndex, allowedNames) !== null;
};
