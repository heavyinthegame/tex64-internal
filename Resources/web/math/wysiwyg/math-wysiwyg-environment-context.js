export const LATEX_ENV_TOKEN_RE = /\\(begin|end)\{([A-Za-z*]+)\}/g;
export const normalizeEnvironmentName = (name) => name.replace(/\*$/, "");
const normalizeMode = (value) => {
    if (value === "text" || value === "latex") {
        return value;
    }
    return "math";
};
const sanitizeEnvironmentList = (value) => {
    if (!Array.isArray(value)) {
        return [];
    }
    const items = value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item.length > 0);
    if (items.length === 0) {
        return [];
    }
    const seen = new Set();
    const result = [];
    items.forEach((item) => {
        if (seen.has(item)) {
            return;
        }
        seen.add(item);
        result.push(item);
    });
    return result;
};
export const readNativeMathfieldEnvironmentContext = (mathfieldApi, cursorOffset) => {
    if (typeof (mathfieldApi === null || mathfieldApi === void 0 ? void 0 : mathfieldApi.getEnvironmentContext) !== "function") {
        return null;
    }
    try {
        const raw = mathfieldApi.getEnvironmentContext(cursorOffset);
        if (!raw || typeof raw !== "object") {
            return null;
        }
        const record = raw;
        const nearestArray = record.nearestArray && typeof record.nearestArray === "object"
            ? record.nearestArray
            : null;
        const environmentName = nearestArray && typeof nearestArray.environmentName === "string"
            ? nearestArray.environmentName
            : null;
        const row = nearestArray && typeof nearestArray.row === "number" && Number.isFinite(nearestArray.row)
            ? Math.max(0, Math.floor(nearestArray.row))
            : null;
        const column = nearestArray &&
            typeof nearestArray.column === "number" &&
            Number.isFinite(nearestArray.column)
            ? Math.max(0, Math.floor(nearestArray.column))
            : null;
        return {
            mode: normalizeMode(record.mode),
            environments: sanitizeEnvironmentList(record.environments),
            nearestArrayEnvironment: environmentName,
            nearestArrayCell: row !== null && column !== null
                ? {
                    row,
                    column,
                }
                : null,
            nearestArrayIsMultiline: Boolean(nearestArray === null || nearestArray === void 0 ? void 0 : nearestArray.isMultiline),
        };
    }
    catch {
        return null;
    }
};
export const hasEnvironmentInContext = (context, allowedNames) => {
    if (!context) {
        return false;
    }
    if (context.nearestArrayEnvironment &&
        allowedNames.has(normalizeEnvironmentName(context.nearestArrayEnvironment))) {
        return true;
    }
    return context.environments.some((name) => allowedNames.has(normalizeEnvironmentName(name)));
};
export const findContainingEnvironmentAtCursor = (latex, cursorIndex, allowedNames) => {
    if (!latex || cursorIndex < 0) {
        return null;
    }
    const stack = [];
    let match = null;
    let bestMatch = null;
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
            const nextMatch = {
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
export const isCursorInsideEnvironmentBody = (latex, cursorIndex, allowedNames) => {
    return findContainingEnvironmentAtCursor(latex, cursorIndex, allowedNames) !== null;
};
