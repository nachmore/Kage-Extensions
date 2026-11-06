// Small, non-executing source scanner. Follow literal keys, constants,
// trailing-template prefixes, and storage wrapper parameters. This is a
// static gate, not a complete JavaScript data-flow engine; review computed
// keys and opaque transformations as part of the sensitive-data audit.
import { SENSITIVE_NAME, declaresSensitiveKey } from './sensitive-data.mjs';

// Payload names are narrower than the host's key-name safety net: auth_revoked
// and session_count describe state, not access. No extension/key allowlist.
const SECRET_VALUE = /^(?:_*(?:(?:(?:access|refresh|auth|oauth|bearer|id)[_-]?)?tokens?|secret|client_?secret|api_?key|password|passwd|credentials|creds|session_?cookie|cookies?|private_?url|ics_?url|subscription_?url|webhook_?url)_*|__.*(?:token|secret|password|api_?key).*|.*(?:AccessToken|RefreshToken|ClientSecret|ApiKey|Password))$/i;
const PRIVATE_URL = /(?:private|secret|ics|subscription|webhook)[_-]?(?:url|uri|address|endpoint)/i;
const CONFIG_ONLY_TYPES = new Set(['action', 'info', 'heading', 'refresh', 'button']);

function tokenize(source) {
    const tokens = [];
    const re = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|=>|\?\.|[^\s]/g;
    for (const match of source.matchAll(re)) {
        const raw = match[0];
        if (raw.startsWith('//') || raw.startsWith('/*')) continue;
        const quote = raw[0];
        const string = quote === "'" || quote === '"' || quote === '`';
        tokens.push({
            raw,
            value: string ? raw.slice(1, -1).replace(/\\(['"`\\])/g, '$1') : raw,
            string,
            template: quote === '`',
            offset: match.index,
        });
    }
    return tokens;
}

function pairsFor(tokens) {
    const pairs = new Map();
    const stack = [];
    const closer = { ')': '(', ']': '[', '}': '{' };
    for (let i = 0; i < tokens.length; i++) {
        const value = tokens[i].raw;
        if (['(', '[', '{'].includes(value)) stack.push(i);
        else if (closer[value] && tokens[stack.at(-1)]?.raw === closer[value]) {
            const start = stack.pop();
            pairs.set(start, i);
            pairs.set(i, start);
        }
    }
    return pairs;
}

function split(tokens, start, end, pairs) {
    const parts = [];
    let from = start;
    for (let i = start; i < end; i++) {
        if (tokens[i].raw === ',') {
            parts.push(tokens.slice(from, i));
            from = i + 1;
        } else if (pairs.get(i) > i) i = pairs.get(i);
    }
    parts.push(tokens.slice(from, end));
    return parts;
}

function properties(expression) {
    if (expression[0]?.raw !== '{') return new Map();
    const pairs = pairsFor(expression);
    const end = pairs.get(0);
    if (end === undefined) return new Map();
    return new Map(split(expression, 1, end, pairs).filter((p) => p.length).map((p) =>
        [p[0].value, p[1]?.raw === ':' ? p.slice(2) : p.slice(0, 1)]
    ));
}

function analyzeSource(file, source) {
    const tokens = tokenize(source);
    const pairs = pairsFor(tokens);
    const constants = new Map();
    const functions = [];
    const calls = [];
    for (let i = 0; i < tokens.length; i++) {
        if (['const', 'let', 'var'].includes(tokens[i].raw) &&
            tokens[i + 2]?.raw === '=') {
            let end = i + 3;
            while (end < tokens.length && ![';', ','].includes(tokens[end].raw)) {
                if (pairs.get(end) > end) end = pairs.get(end);
                end++;
            }
            constants.set(tokens[i + 1].value, tokens.slice(i + 3, end));
        }
        if (tokens[i].raw !== '(' || !pairs.has(i)) continue;
        const end = pairs.get(i);
        const name = tokens[i - 1]?.value;
        const args = split(tokens, i + 1, end, pairs);
        const body = tokens[end + 1]?.raw === '=>' ? end + 2 : end + 1;
        if (tokens[body]?.raw === '{' && pairs.has(body) &&
            !['if', 'while', 'for', 'switch', 'catch', 'with'].includes(name)) {
            let functionName = name;
            if (tokens[end + 1]?.raw === '=>') {
                functionName = tokens[i - 1]?.raw === '=' ? tokens[i - 2]?.value : undefined;
            }
            if (functionName) functions.push({
                name: functionName, args: args.map((a) => a[0]?.value),
                start: body, end: pairs.get(body),
            });
        } else if (/^[A-Za-z_$][\w$]*$/.test(name || '')) {
            calls.push({ name, args, index: i, offset: tokens[i].offset });
        }
    }
    return { file, source, tokens, pairs, constants, functions, calls };
}

function resolve(expression, constants, seen = new Set()) {
    if (expression?.length !== 1) return expression || [];
    const token = expression[0];
    if (!token.string && constants.has(token.value) && !seen.has(token.value)) {
        return resolve(constants.get(token.value), constants, new Set([...seen, token.value]));
    }
    return expression;
}

function keyPattern(expression, constants) {
    const resolved = resolve(expression, constants);
    const first = resolved[0];
    if (!first?.string) return null;
    if (first.template && first.value.includes('${')) {
        const prefix = first.value.split('${')[0];
        return prefix ? `${prefix}*` : null;
    }
    if (resolved.length === 1) return first.value;
    if (resolved[1]?.raw === '+' && first.value) return `${first.value}*`;
    return null;
}

function hasSecretValue(expression, constants, seen = new Set()) {
    for (const token of expression || []) {
        // String values containing prose or URLs aren't secret variable names.
        // Object property names such as 'access_token' do count.
        if (SECRET_VALUE.test(token.value) || PRIVATE_URL.test(token.value)) return true;
        if (!token.string && constants.has(token.value) && !seen.has(token.value) &&
            hasSecretValue(constants.get(token.value), constants, new Set([...seen, token.value]))) return true;
    }
    return false;
}

function lineAt(source, offset) {
    return source.slice(0, offset).split('\n').length;
}

/**
 * sources: [{ file: path relative to the extension, source: JavaScript text }].
 * Results use the same file/line/severity/pattern/message shape as check:security.
 */
export function checkSensitiveDeclarations(manifest, sources) {
    const results = [];
    const reported = new Set();
    const report = (file, line, kind, name, reason) => {
        const id = `${file}:${kind}:${name}`;
        if (reported.has(id)) return;
        reported.add(id);
        results.push({
            file, line, severity: 'error', pattern: 'undeclared-sensitive-data',
            message: kind === 'config'
                ? `config.${name} is sensitive (${reason}); declare config.${name}.sensitive: true.`
                : `Storage key '${name}' is sensitive (${reason}); add it to sensitiveData.`,
        });
    };
    const requireConfig = (field, file, line, reason) => {
        if (manifest.config?.[field]?.sensitive !== true) report(file, line, 'config', field, reason);
    };
    for (const [field, definition] of Object.entries(manifest.config || {})) {
        if (SENSITIVE_NAME.test(field) || PRIVATE_URL.test(field) || definition?.type === 'password') {
            requireConfig(field, 'manifest.json', 1, 'secret-bearing field name or type');
        }
    }

    const analyzed = sources.map(({ file, source }) => analyzeSource(file, source));
    // A named import may use a storage-key constant from another local module.
    // Keep only unambiguous literal values; never guess when modules disagree.
    const shared = new Map();
    const conflicts = new Set();
    for (const item of analyzed) {
        for (const [name, expression] of item.constants) {
            const key = keyPattern(expression, item.constants);
            if (key === null) continue;
            if (shared.has(name) && keyPattern(shared.get(name), shared) !== key) conflicts.add(name);
            else shared.set(name, expression);
        }
    }
    for (const name of conflicts) shared.delete(name);

    const writes = [];
    const wrappers = [];
    for (const item of analyzed) {
        item.constants = new Map([...shared, ...item.constants]);
        for (const call of item.calls) {
            if (call.args[0]?.[0]?.value !== 'save_extension_data') continue;
            const object = properties(resolve(call.args[1], item.constants));
            if (!object.has('key')) continue;
            const write = { item, call, key: object.get('key'), data: object.get('data') || [] };
            const fn = item.functions.filter((f) => f.start < call.index && f.end > call.index)
                .sort((a, b) => b.start - a.start)[0];
            const keyArg = fn?.args.indexOf(write.key.length === 1 && !write.key[0].string ? write.key[0].value : undefined);
            // Defer a generic storage wrapper to its call sites: the key and
            // payload parameters alone don't reveal the stored data.
            if (keyArg >= 0) wrappers.push({ name: fn.name, keyArg, dataArg: fn.args.indexOf(write.data[0]?.value), write });
            else {
                writes.push(write);
                // A fixed-key helper can receive a secret through an innocuous
                // parameter, e.g. writeState(response.access_token).
                if (fn) wrappers.push({ name: fn.name, keyArg: -1, dataArg: -1, write });
            }
        }
    }
    for (const item of analyzed) {
        for (const call of item.calls) {
            for (const wrapper of wrappers.filter((w) => w.name === call.name)) {
                writes.push({
                    item, call,
                    key: wrapper.keyArg >= 0 ? call.args[wrapper.keyArg] : wrapper.write.key,
                    data: wrapper.dataArg >= 0 ? call.args[wrapper.dataArg] : call.args.flat(),
                });
            }
        }
    }
    for (const write of writes) {
        const key = keyPattern(write.key, write.item.constants);
        const secret = hasSecretValue(write.data, write.item.constants);
        const namedKey = key
            ? SENSITIVE_NAME.test(key) || PRIVATE_URL.test(key)
            : write.key.some((token) => !token.string && SENSITIVE_NAME.test(token.value));
        if (namedKey || secret) {
            if (key && declaresSensitiveKey(manifest, key)) continue;
            report(write.item.file, lineAt(write.item.source, write.call.offset), 'storage',
                key || '(computed key)', secret ? 'secret-bearing value' : 'secret-bearing key name');
        }
    }

    // Inspect only settings modules and their local imports: password
    // generation search results are not config controls.
    const settingsFiles = new Set();
    const visitSettings = (file) => {
        if (settingsFiles.has(file)) return;
        settingsFiles.add(file);
        const item = analyzed.find((s) => s.file === file);
        if (!item) return;
        for (const match of item.source.matchAll(/\b(?:from\s*|import\s*)['"](\.\/[^'"]+)['"]/g)) {
            const prefix = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
            visitSettings(prefix + match[1].slice(2));
        }
    };
    if (manifest.contributes?.settingsProvider) visitSettings(manifest.contributes.settingsProvider.replace(/^\.\//, ''));
    for (const item of analyzed.filter((s) => settingsFiles.has(s.file))) {
        for (let i = 0; i < item.tokens.length; i++) {
            if (item.tokens[i].raw !== '{') continue;
            const end = item.pairs.get(i);
            if (end === undefined) continue;
            const object = properties(item.tokens.slice(i, end + 1));
            const id = keyPattern(object.get('id'), item.constants);
            const type = keyPattern(object.get('type'), item.constants);
            if (!id || !type || CONFIG_ONLY_TYPES.has(type)) continue;
            // __ fields are transient action inputs stripped by normalize();
            // their eventual storage writes are checked above.
            if (id.startsWith('__')) continue;
            const secretInput = type === 'password' ||
                object.get('secret')?.[0]?.value === 'true' ||
                object.get('sensitive')?.[0]?.value === 'true' ||
                keyPattern(object.get('inputType'), item.constants) === 'password' ||
                SENSITIVE_NAME.test(id) || PRIVATE_URL.test(id) ||
                [...(object.get('label') || []), ...(object.get('description') || [])]
                    .some((t) => /(?:api key|client secret|private.*url|secret.*url|webhook|subscription.*url|ics.*url)/i.test(t.value));
            if (secretInput) requireConfig(id, item.file, lineAt(item.source, item.tokens[i].offset), 'secret settings input');
        }
    }
    return results;
}
