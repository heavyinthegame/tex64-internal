const AUX_COMMAND_SPECS = [
    { source: "label", escaped: "txlbl", argMode: "brace" },
    { source: "tag", escaped: "txtag", argMode: "brace" },
    { source: "tag*", escaped: "txtgs", argMode: "brace" },
    { source: "notag", escaped: "txntg", argMode: "none" },
    { source: "nonumber", escaped: "txnnum", argMode: "none" },
    { source: "eqref", escaped: "txeqr", argMode: "brace" },
    { source: "ref", escaped: "txref", argMode: "brace" },
    { source: "pageref", escaped: "txpgrf", argMode: "brace" },
    { source: "autoref", escaped: "txatrf", argMode: "brace" },
    { source: "intertext", escaped: "txintr", argMode: "brace" },
    { source: "shortintertext", escaped: "txshintr", argMode: "brace" },
];
const ENCODE_LOOKUP = new Map(AUX_COMMAND_SPECS.map((spec) => [spec.source, { target: spec.escaped, argMode: spec.argMode }]));
const DECODE_LOOKUP = new Map(AUX_COMMAND_SPECS.map((spec) => [spec.escaped, { target: spec.source, argMode: spec.argMode }]));
const isAsciiLetter = (ch) => /[A-Za-z]/.test(ch);
const LBRACE_TOKEN = "\\lbrace";
const RBRACE_TOKEN = "\\rbrace";
const INTERTEXT_COMMANDS = new Set(["intertext", "shortintertext"]);
const isEscapedAt = (text, index) => {
    let slashCount = 0;
    for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
        slashCount += 1;
    }
    return slashCount % 2 === 1;
};
const findBalancedBraceEnd = (text, start) => {
    if (text[start] !== "{") {
        return -1;
    }
    let depth = 0;
    for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === "{" && !isEscapedAt(text, i)) {
            depth += 1;
            continue;
        }
        if (ch === "}" && !isEscapedAt(text, i)) {
            depth -= 1;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
};
const clampCursor = (cursorIndex, length) => Math.max(0, Math.min(length, Math.floor(cursorIndex)));
const hasBoundaryBefore = (text, index, argStart) => {
    var _a;
    if (index <= argStart) {
        return true;
    }
    const prev = (_a = text[index - 1]) !== null && _a !== void 0 ? _a : "";
    return /\s|[&{}]/.test(prev);
};
const shouldBreakIntertextAmpersand = (text, index) => {
    var _a, _b, _c, _d;
    if (index < 0 || index >= text.length || text[index] !== "&") {
        return false;
    }
    const prev = (_a = text[index - 1]) !== null && _a !== void 0 ? _a : "";
    const next = (_b = text[index + 1]) !== null && _b !== void 0 ? _b : "";
    const prevWhitespace = /\s/.test(prev);
    const nextWhitespace = /\s/.test(next);
    if (!prevWhitespace || !nextWhitespace) {
        return true;
    }
    let lookahead = index + 1;
    while (lookahead < text.length && /\s/.test((_c = text[lookahead]) !== null && _c !== void 0 ? _c : "")) {
        lookahead += 1;
    }
    const marker = (_d = text[lookahead]) !== null && _d !== void 0 ? _d : "";
    return marker === "=" || marker === "\\" || marker === "{" || marker === "}";
};
const readBareArgument = (commandName, text, argStart) => {
    if (argStart >= text.length) {
        return null;
    }
    if (INTERTEXT_COMMANDS.has(commandName)) {
        let end = argStart;
        while (end < text.length) {
            if (text[end] === "\\" && text[end + 1] === "\\" && !isEscapedAt(text, end)) {
                break;
            }
            if (text[end] === "&" &&
                !isEscapedAt(text, end) &&
                shouldBreakIntertextAmpersand(text, end)) {
                break;
            }
            if ((text.startsWith("\\begin{", end) || text.startsWith("\\end{", end)) &&
                !isEscapedAt(text, end) &&
                hasBoundaryBefore(text, end, argStart)) {
                break;
            }
            end += 1;
        }
        let trimmedEnd = end;
        while (trimmedEnd > argStart && /\s/.test(text[trimmedEnd - 1])) {
            trimmedEnd -= 1;
        }
        if (trimmedEnd <= argStart) {
            return null;
        }
        return {
            argument: text.slice(argStart, trimmedEnd),
            consumedEnd: trimmedEnd,
        };
    }
    let end = argStart;
    while (end < text.length) {
        const ch = text[end];
        if (/\s/.test(ch)) {
            break;
        }
        if (ch === "{" || ch === "}" || ch === "&") {
            break;
        }
        if (ch === "\\" && !isEscapedAt(text, end)) {
            break;
        }
        end += 1;
    }
    if (end <= argStart) {
        return null;
    }
    return {
        argument: text.slice(argStart, end),
        consumedEnd: end,
    };
};
const rewriteAuxCommands = (value, lookup, cursorIndex = null, options = {}) => {
    if (!value) {
        return { value, cursorIndex: 0, changed: false };
    }
    const finalizeBare = options.finalizeBare === true;
    const deferBare = options.deferBare === true;
    const deferCommandArgs = options.deferCommandArgs === true;
    const hasCursor = Number.isFinite(cursorIndex);
    const sourceCursor = hasCursor ? clampCursor(Number(cursorIndex), value.length) : 0;
    let cursorResolved = !hasCursor;
    let cursorDelta = 0;
    let nextCursor = sourceCursor;
    let changed = false;
    let output = "";
    for (let i = 0; i < value.length;) {
        if (value[i] !== "\\") {
            output += value[i];
            i += 1;
            continue;
        }
        let nameEnd = i + 1;
        while (nameEnd < value.length && isAsciiLetter(value[nameEnd])) {
            nameEnd += 1;
        }
        if (nameEnd === i + 1) {
            output += value[i];
            i += 1;
            continue;
        }
        const baseCommandName = value.slice(i + 1, nameEnd);
        let commandName = baseCommandName;
        let commandEnd = nameEnd;
        if (lookup.has(`${baseCommandName}*`)) {
            if (value[nameEnd] === "*") {
                commandName = `${baseCommandName}*`;
                commandEnd = nameEnd + 1;
            }
            else {
                let starIndex = nameEnd;
                while (starIndex < value.length && /\s/.test(value[starIndex])) {
                    starIndex += 1;
                }
                if (value[starIndex] === "*") {
                    commandName = `${baseCommandName}*`;
                    commandEnd = starIndex + 1;
                }
            }
        }
        const entry = lookup.get(commandName);
        if (!entry) {
            output += value.slice(i, commandEnd);
            i = commandEnd;
            continue;
        }
        let replacement = `\\${entry.target}`;
        let consumedEnd = commandEnd;
        let wrappedBareArgument = false;
        if (entry.argMode === "brace") {
            let argStart = commandEnd;
            while (argStart < value.length && /\s/.test(value[argStart])) {
                argStart += 1;
            }
            if (value[argStart] === "{") {
                const argEnd = findBalancedBraceEnd(value, argStart);
                if (argEnd < 0) {
                    output += value.slice(i, commandEnd);
                    i = commandEnd;
                    continue;
                }
                if (hasCursor && !finalizeBare && deferCommandArgs) {
                    const consumedEnd = argEnd + 1;
                    output += value.slice(i, consumedEnd);
                    i = consumedEnd;
                    continue;
                }
                const spacing = value.slice(commandEnd, argStart);
                const argument = value.slice(argStart, argEnd + 1);
                replacement += spacing + argument;
                consumedEnd = argEnd + 1;
            }
            else if (value.startsWith(LBRACE_TOKEN, argStart)) {
                const innerStart = argStart + LBRACE_TOKEN.length;
                const closeIndex = value.indexOf(RBRACE_TOKEN, innerStart);
                if (closeIndex < 0) {
                    output += value.slice(i, commandEnd);
                    i = commandEnd;
                    continue;
                }
                if (hasCursor && !finalizeBare && deferCommandArgs) {
                    const consumedEnd = closeIndex + RBRACE_TOKEN.length;
                    output += value.slice(i, consumedEnd);
                    i = consumedEnd;
                    continue;
                }
                const rawInner = value.slice(innerStart, closeIndex);
                const normalizedInner = rawInner.replace(/^\s+/, "").replace(/\s+$/, "");
                replacement += `{${normalizedInner}}`;
                consumedEnd = closeIndex + RBRACE_TOKEN.length;
            }
            else {
                const bare = readBareArgument(commandName, value, argStart);
                if (!bare) {
                    output += value.slice(i, commandEnd);
                    i = commandEnd;
                    continue;
                }
                if (hasCursor && !finalizeBare && deferCommandArgs) {
                    output += value.slice(i, bare.consumedEnd);
                    i = bare.consumedEnd;
                    continue;
                }
                if (hasCursor &&
                    !finalizeBare &&
                    (deferBare || (sourceCursor >= argStart && sourceCursor <= bare.consumedEnd))) {
                    output += value.slice(i, bare.consumedEnd);
                    i = bare.consumedEnd;
                    continue;
                }
                replacement += `{${bare.argument}}`;
                consumedEnd = bare.consumedEnd;
                wrappedBareArgument = true;
            }
        }
        changed = true;
        const originalLength = consumedEnd - i;
        const delta = replacement.length - originalLength;
        if (!cursorResolved && hasCursor) {
            if (wrappedBareArgument && sourceCursor >= consumedEnd) {
                nextCursor = output.length + replacement.length - 1;
                cursorResolved = true;
            }
            else if (sourceCursor >= consumedEnd) {
                cursorDelta += delta;
            }
            else if (sourceCursor > i) {
                nextCursor = output.length + Math.min(sourceCursor - i, replacement.length);
                cursorResolved = true;
            }
        }
        output += replacement;
        i = consumedEnd;
    }
    if (!changed) {
        return {
            value,
            cursorIndex: hasCursor ? sourceCursor : 0,
            changed: false,
        };
    }
    if (!cursorResolved && hasCursor) {
        nextCursor = sourceCursor + cursorDelta;
    }
    return {
        value: output,
        cursorIndex: hasCursor ? clampCursor(nextCursor, output.length) : 0,
        changed: true,
    };
};
export const encodeMathAuxCommands = (value) => rewriteAuxCommands(value, ENCODE_LOOKUP).value;
export const decodeMathAuxCommands = (value) => rewriteAuxCommands(value, DECODE_LOOKUP).value;
export const encodeMathAuxCommandsWithCursor = (value, cursorIndex, options = {}) => rewriteAuxCommands(value, ENCODE_LOOKUP, cursorIndex, options);
export const AUXILIARY_MATH_MACROS = {
    ...Object.fromEntries(AUX_COMMAND_SPECS.map((spec) => [
        spec.escaped,
        { def: "", args: spec.argMode === "none" ? 0 : 1 },
    ])),
    // Hidden markers for environments MathLive cannot keep editable directly.
    txalnat: { def: "", args: 0 },
    txflaln: { def: "", args: 0 },
    txarrcf: { def: "", args: 0 },
    txarrayc: { def: "#1#2", args: 2 },
};
