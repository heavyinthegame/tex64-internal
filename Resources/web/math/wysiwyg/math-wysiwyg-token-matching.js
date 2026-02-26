import { OPERATOR_MAX_LENGTH, OPERATOR_MIN_LENGTH, OPERATOR_TRIGGERS, } from "./math-wysiwyg-candidates.js";
export const isWordToken = (value) => /^(?=.*[A-Za-z])[A-Za-z0-9]+$/.test(value);
export const isCommandToken = (value) => /^[A-Za-z]+$/.test(value);
export const AUTO_REPLACE_OPERATORS = new Set([
    "=>",
    "<=>",
    "<=",
    ">=",
    "!=",
    "+-",
    "-+",
    "->",
    "<-",
    "<->",
    "...",
    "d/dx",
    "∂/∂x",
]);
const AUTO_REPLACE_OPERATOR_CORRECTIONS = [
    { token: "<=>", suffix: "\\leq>" },
    { token: "<->", suffix: "\\leftarrow>" },
];
export const findOperatorToken = (text, cursorIndex) => {
    const maxLength = OPERATOR_MAX_LENGTH;
    const minLength = Math.max(1, OPERATOR_MIN_LENGTH);
    for (let length = maxLength; length >= minLength; length -= 1) {
        const start = cursorIndex - length;
        if (start < 0) {
            continue;
        }
        const token = text.slice(start, cursorIndex);
        if (token in OPERATOR_TRIGGERS) {
            return { token, range: { start, end: cursorIndex }, kind: "operator" };
        }
    }
    return null;
};
export const findAutoReplaceCorrection = (text, cursorIndex) => {
    for (const correction of AUTO_REPLACE_OPERATOR_CORRECTIONS) {
        const { suffix, token } = correction;
        if (cursorIndex < suffix.length) {
            continue;
        }
        const start = cursorIndex - suffix.length;
        if (text.slice(start, cursorIndex) === suffix) {
            return { token, range: { start, end: cursorIndex }, kind: "operator" };
        }
    }
    return null;
};
export const findWordToken = (text, cursorIndex) => {
    let start = cursorIndex;
    while (start > 0) {
        const char = text[start - 1];
        if (!/[A-Za-z0-9]/.test(char)) {
            break;
        }
        start -= 1;
    }
    if (start === cursorIndex) {
        return null;
    }
    const token = text.slice(start, cursorIndex);
    if (!isWordToken(token)) {
        return null;
    }
    let backslashCount = 0;
    for (let i = start - 1; i >= 0 && text[i] === "\\"; i -= 1) {
        backslashCount += 1;
    }
    if (backslashCount % 2 === 1 && isCommandToken(token)) {
        return {
            token,
            range: { start: start - 1, end: cursorIndex },
            kind: "command",
        };
    }
    return { token, range: { start, end: cursorIndex }, kind: "word" };
};
export const findSlashCommandToken = (text, cursorIndex) => {
    let start = cursorIndex;
    while (start > 0) {
        const char = text[start - 1];
        if (!/[A-Za-z*]/.test(char)) {
            break;
        }
        start -= 1;
    }
    if (start < 2 || text[start - 2] !== "/" || text[start - 1] !== "/") {
        return null;
    }
    if (start > 2 && text[start - 3] === "/") {
        return null;
    }
    const token = text.slice(start, cursorIndex);
    if (!/^[A-Za-z*]*$/.test(token)) {
        return null;
    }
    return { token, range: { start: start - 2, end: cursorIndex }, kind: "slash-command" };
};
