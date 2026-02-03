const ALIGNED_ENV_BEGIN = "\\begin{aligned}";
const ALIGNED_ENV_END = "\\end{aligned}";
const isEscapedAt = (text, index) => {
    let count = 0;
    for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
        count += 1;
    }
    return count % 2 === 1;
};
const hasUnescapedAmpersand = (text) => {
    for (let i = 0; i < text.length; i += 1) {
        if (text[i] === "&" && !isEscapedAt(text, i)) {
            return true;
        }
    }
    return false;
};
const hasLineBreak = (text) => {
    for (let i = 0; i < text.length - 1; i += 1) {
        if (text[i] === "\\" && text[i + 1] === "\\" && !isEscapedAt(text, i)) {
            return true;
        }
    }
    return false;
};
export const shouldWrapAligned = (text) => {
    if (!text) {
        return false;
    }
    if (text.includes("\\begin{") || text.includes("\\end{")) {
        return false;
    }
    return hasUnescapedAmpersand(text) || hasLineBreak(text);
};
export const wrapAligned = (text) => `${ALIGNED_ENV_BEGIN}\n${text}\n${ALIGNED_ENV_END}`;
export const unwrapAligned = (text) => {
    const start = text.indexOf(ALIGNED_ENV_BEGIN);
    const end = text.lastIndexOf(ALIGNED_ENV_END);
    if (start === -1 || end === -1) {
        return { value: text, didUnwrap: false };
    }
    const before = text.slice(0, start).trim();
    const after = text.slice(end + ALIGNED_ENV_END.length).trim();
    if (before || after) {
        return { value: text, didUnwrap: false };
    }
    let inner = text.slice(start + ALIGNED_ENV_BEGIN.length, end);
    if (inner.startsWith("\n")) {
        inner = inner.slice(1);
    }
    if (inner.endsWith("\n")) {
        inner = inner.slice(0, -1);
    }
    return { value: inner, didUnwrap: true };
};
const splitAlignedRows = (text) => {
    const rows = [];
    let current = "";
    for (let i = 0; i < text.length; i += 1) {
        if (text[i] === "\\" && text[i + 1] === "\\" && !isEscapedAt(text, i)) {
            rows.push(current);
            current = "";
            i += 1;
            continue;
        }
        current += text[i];
    }
    rows.push(current);
    return rows;
};
const isEmptyAlignedRow = (row) => {
    const cleaned = row.replace(/\\placeholder\{\}/g, "").replace(/\s+/g, "");
    return cleaned === "" || cleaned === "&";
};
export const stripEmptyAlignedRows = (text) => {
    const rows = splitAlignedRows(text);
    if (rows.length <= 1) {
        return text;
    }
    const hasNonEmpty = rows.some((row) => !isEmptyAlignedRow(row));
    return hasNonEmpty ? text : "";
};
export const normalizeMatrixSyntax = (value) => {
    if (!value) {
        return value;
    }
    return value.replace(/\\begin\{((?:[p|b|B|v|V])?matrix)\}([\s\S]*?)\\end\{\1\}/g, (match, env, body) => {
        if (body.includes("&") || body.includes("\\\\")) {
            return match;
        }
        const cells = [];
        let i = 0;
        let valid = true;
        while (i < body.length) {
            const ch = body[i];
            if (ch === "{") {
                let depth = 0;
                const start = i + 1;
                for (; i < body.length; i += 1) {
                    const inner = body[i];
                    if (inner === "{")
                        depth += 1;
                    if (inner === "}") {
                        depth -= 1;
                        if (depth === 0) {
                            cells.push(body.slice(start, i).trim());
                            i += 1;
                            break;
                        }
                    }
                }
                if (depth !== 0) {
                    valid = false;
                    break;
                }
                continue;
            }
            if (!/\s/.test(ch)) {
                const start = i;
                while (i < body.length && !/\s/.test(body[i])) {
                    i += 1;
                }
                cells.push(body.slice(start, i).trim());
                continue;
            }
            i += 1;
        }
        if (!valid) {
            return match;
        }
        const filtered = cells.filter((cell) => cell.length > 0);
        if (filtered.length === 0) {
            return match;
        }
        const size = Math.sqrt(filtered.length);
        const n = Math.round(size);
        if (!Number.isFinite(size) || n * n !== filtered.length) {
            return match;
        }
        const rows = [];
        for (let r = 0; r < n; r += 1) {
            const row = filtered.slice(r * n, (r + 1) * n);
            rows.push(row.join("&"));
        }
        return `\\begin{${env}}${rows.join("\\\\")}\\end{${env}}`;
    });
};
