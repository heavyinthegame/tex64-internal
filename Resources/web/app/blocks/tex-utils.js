export const isEscapedAt = (text, index) => {
    let count = 0;
    for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
        count += 1;
    }
    return count % 2 === 1;
};
export const consumeBracketArg = (text, startIndex) => {
    if (text[startIndex] !== "[") {
        return startIndex;
    }
    let depth = 0;
    for (let i = startIndex; i < text.length; i += 1) {
        const char = text[i];
        if (char === "[" && !isEscapedAt(text, i)) {
            depth += 1;
        }
        else if (char === "]" && !isEscapedAt(text, i)) {
            depth -= 1;
            if (depth === 0) {
                return i + 1;
            }
        }
    }
    return startIndex;
};
