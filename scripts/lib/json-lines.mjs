import { parseExpressionAt } from 'acorn';

// JSON has no executable expressions; Acorn supplies exact property/entry
// locations without another hand-written string/escape tokenizer.
export function jsonLine(source, parts) {
    if (!source) return 1;
    try {
        let node = parseExpressionAt(source, 0, { ecmaVersion: 'latest', locations: true });
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (node.type === 'ArrayExpression') node = node.elements[Number(part)];
            else {
                const prop = node.properties?.find((p) => p.key.value === part);
                if (!prop) return node.loc.start.line;
                if (i === parts.length - 1) return prop.key.loc.start.line;
                node = prop.value;
            }
            if (!node) return 1;
        }
        return node.loc.start.line;
    } catch { return 1; }
}
