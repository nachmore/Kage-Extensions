// Non-executing, scope-aware analysis. Only explicit imports within this
// extension supply constants and wrappers; unrelated names never match.
import { parse } from 'acorn';
import path from 'node:path';
import { SENSITIVE_NAME, declaresSensitiveKey, validSensitivePattern } from './sensitive-data.mjs';
import { jsonLine } from './json-lines.mjs';

const SECRET_VALUE = /^(?:_*(?:(?:(?:access|refresh|auth|oauth|bearer|id)[_-]?)?tokens?|secret|client_?secret|api_?key|password|passwd|credentials|creds|session_?cookie|cookies?|private_?url|ics_?url|subscription_?url|webhook_?url)_*|__.*(?:token|secret|password|api_?key).*|.*(?:AccessToken|RefreshToken|ClientSecret|ApiKey|Password))$/i;
const PRIVATE_URL = /^(?:private|secret|ics|subscription|webhook)[_-]?(?:url|uri|address|endpoint)$/i;
const SECRET_LABEL = /\b(?:pat|access|bearer|api[\s_-]*key|tokens?|secret|password|client[\s_-]*secret|webhook|(?:private|secret|subscription|ics).*(?:url|address))\b/i;
const INPUT_TYPES = new Set(['checkbox', 'text', 'number', 'select', 'range']);
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function children(node) {
    return Object.values(node).flatMap((value) =>
        Array.isArray(value) ? value.filter((v) => v?.type) : value?.type ? [value] : []);
}
function allNodes(node) {
    return [node, ...children(node).flatMap(allNodes)];
}
function propertyName(node) {
    return !node.computed && node.key?.type === 'Identifier' ? node.key.name
        : node.key?.type === 'Literal' ? String(node.key.value) : null;
}
function lookup(scope, name) {
    for (let at = scope; at; at = at.parent) {
        if (at.bindings.has(name)) return at.bindings.get(name);
    }
    return null;
}
function analyze(file, source) {
    const comments = [];
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, onComment: comments });
    const item = { file, source, ast, comments, scopes: new WeakMap(), functions: new Map(), calls: [], exports: new Map() };
    const root = { bindings: new Map(), parent: null, item, fn: null, classNode: null };
    item.root = root;
    const bind = (scope, name, value) => {
        const binding = scope.bindings.get(name) || { name, scope, values: [] };
        if (value) binding.values.push(value);
        scope.bindings.set(name, binding);
        return binding;
    };
    function bindPattern(pattern, value, scope, param = false) {
        if (!pattern) return;
        if (pattern.type === 'Identifier') {
            const binding = bind(scope, pattern.name, value);
            if (param) binding.param = true;
        } else if (pattern.type === 'AssignmentPattern') {
            bindPattern(pattern.left, { node: pattern.right, scope }, scope, param);
        } else if (pattern.type === 'ObjectPattern') {
            for (const prop of pattern.properties) {
                if (prop.type === 'Property') bindPattern(prop.value, { member: propertyName(prop), object: value }, scope, param);
                else bindPattern(prop.argument, null, scope, param);
            }
        } else {
            for (const child of children(pattern)) bindPattern(child, null, scope, param);
        }
    }
    function visit(node, scope) {
        item.scopes.set(node, scope);
        if (node.type === 'FunctionDeclaration' && node.id) bind(scope, node.id.name, { node, scope });
        if (node.type === 'ClassDeclaration' && node.id) bind(scope, node.id.name, { node, scope });
        if (FUNCTION_TYPES.has(node.type)) {
            const inner = { ...scope, parent: scope, bindings: new Map(), fn: node };
            item.functions.set(node, { node, scope: inner, calls: [] });
            if (node.id) bind(inner, node.id.name, { node, scope });
            for (const param of node.params) bindPattern(param, null, inner, true);
            for (const child of children(node)) visit(child, inner);
            return;
        }
        if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
            scope = { ...scope, parent: scope, bindings: new Map(), classNode: node };
            item.scopes.set(node, scope);
        } else if (node.type === 'BlockStatement' || node.type === 'CatchClause' ||
            ['ForStatement', 'ForInStatement', 'ForOfStatement'].includes(node.type)) {
            scope = { ...scope, parent: scope, bindings: new Map() };
            item.scopes.set(node, scope);
            if (node.type === 'CatchClause') bindPattern(node.param, null, scope);
        }
        if (node.type === 'VariableDeclaration') {
            let target = scope;
            if (node.kind === 'var') while (target.parent && target.parent.fn === target.fn) target = target.parent;
            for (const decl of node.declarations) bindPattern(decl.id, { node: decl.init, scope }, target);
        }
        if (node.type === 'ImportDeclaration') {
            for (const spec of node.specifiers) bind(scope, spec.local.name, {
                imported: spec.type === 'ImportNamespaceSpecifier' ? '*' :
                    spec.type === 'ImportDefaultSpecifier' ? 'default' : spec.imported.name || spec.imported.value,
                from: node.source.value, item,
            });
        }
        if (node.type === 'ExportNamedDeclaration') {
            if (node.declaration?.id) item.exports.set(node.declaration.id.name, { name: node.declaration.id.name });
            for (const decl of node.declaration?.declarations || []) {
                if (decl.id.type === 'Identifier') item.exports.set(decl.id.name, { name: decl.id.name });
            }
            for (const spec of node.specifiers) item.exports.set(spec.exported.name || spec.exported.value,
                node.source ? { imported: spec.local.name, from: node.source.value, item } : { name: spec.local.name });
        }
        if (node.type === 'ExportDefaultDeclaration') item.exports.set('default', { node: node.declaration, scope });
        if (node.type === 'CallExpression') {
            const call = { node, scope, item };
            item.calls.push(call);
            item.functions.get(scope.fn)?.calls.push(call);
        }
        for (const child of children(node)) visit(child, scope);
    }
    visit(ast, root);
    // Never silently choose the first value after a reassignment.
    for (const node of allNodes(ast).filter((n) => n.type === 'AssignmentExpression' && n.left.type === 'Identifier')) {
        lookup(item.scopes.get(node), node.left.name)?.values.push({ node: node.right, scope: item.scopes.get(node) });
    }
    return item;
}
function modulePath(item, from) {
    return from?.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(item.file), from)) : null;
}

/**
 * sources: JS modules relative to an extension. options supplies original
 * manifest text and English messages. Source is never imported or executed.
 */
export function checkSensitiveDeclarations(manifest, sources, options = {}) {
    const results = [];
    const reported = new Set();
    const report = (file, line, message, pattern = 'undeclared-sensitive-data') => {
        const id = `${file}:${line}:${message}`;
        if (reported.has(id)) return;
        reported.add(id);
        results.push({ file, line, severity: 'error', pattern, message });
    };
    const requireConfig = (field, file, line, reason) => {
        if (manifest.config?.[field]?.sensitive !== true) {
            report(file, line, `config.${field} is sensitive (${reason}); declare config.${field}.sensitive: true.`);
        }
    };
    for (const [field] of Object.entries(manifest.config || {})) {
        if (SENSITIVE_NAME.test(field) || PRIVATE_URL.test(field)) {
            requireConfig(field, 'manifest.json', jsonLine(options.manifestSource, ['config', field]), 'secret-bearing field name');
        }
    }
    const modules = new Map();
    for (const { file, source } of sources) {
        try { modules.set(file, analyze(file, source)); }
        catch (e) {
            report(file, e.loc?.line || 1, `Cannot analyze JavaScript: ${e.message}; fix the source so storage writes can be checked.`, 'sensitive-data-analysis');
        }
    }
    const ref = (node, scope, env = new Map()) => ({ node, scope, env });
    const commandOrigins = new Set();
    function imported(value) {
        const mod = modules.get(modulePath(value.item, value.from));
        if (!mod) return null;
        if (value.imported === '*') return { namespace: mod };
        const exported = mod.exports.get(value.imported);
        return exported?.name ? { binding: lookup(mod.root, exported.name) } : exported;
    }
    // Lexical/import resolution retains argument environments through wrappers.
    function deref(value, seen = new Set()) {
        if (!value) return [];
        if (value.imported) {
            if (seen.has(value)) return [];
            return deref(imported(value), new Set([...seen, value]));
        }
        if (value.member !== undefined) return members(value.object, value.member, seen);
        const { node, scope, env = new Map() } = value;
        const binding = value.binding || (node?.type === 'Identifier' ? lookup(scope, node.name) : null);
        if (binding) {
            if (seen.has(binding)) return [];
            const next = new Set([...seen, binding]);
            if (env.has(binding)) return deref(env.get(binding), next);
            if (binding.param) return [{ ...value, binding, unresolvedParam: true }];
            return binding.values.flatMap((v) => deref({ env, ...v }, next));
        }
        if (node?.type === 'MemberExpression') {
            const names = node.computed ? strings(ref(node.property, scope, env)) : [node.property.name];
            const resolved = names?.flatMap((name) => members(ref(node.object, scope, env), name, seen)) || [];
            return resolved.length ? resolved : [value];
        }
        if (node?.type === 'ChainExpression' || node?.type === 'AwaitExpression') return deref(ref(node.expression || node.argument, scope, env), seen);
        if (node?.type === 'ConditionalExpression') return [node.consequent, node.alternate].flatMap((n) => deref(ref(n, scope, env), seen));
        if (node?.type === 'LogicalExpression') return [node.left, node.right].flatMap((n) => deref(ref(n, scope, env), seen));
        if (node?.type === 'ThisExpression') return scope.classNode ? [ref(scope.classNode, scope, env)] : [];
        if (node?.type === 'NewExpression') return deref(ref(node.callee, scope, env), seen);
        return [value];
    }
    function members(value, name, seen = new Set()) {
        return deref(value, seen).flatMap((v) => {
            if (v.namespace) {
                const exported = v.namespace.exports.get(name);
                return exported?.name ? deref({ binding: lookup(v.namespace.root, exported.name), env: v.env }, seen) : deref(exported, seen);
            }
            if (v.node?.type === 'ObjectExpression') {
                let out = [];
                for (const prop of v.node.properties) {
                    if (prop.type === 'SpreadElement') {
                        const spread = ref(prop.argument, v.scope, v.env);
                        const values = members(spread, name, seen);
                        if (values.length) out = values;
                        else {
                            const resolved = deref(spread, seen);
                            if (!resolved.length || resolved.some((s) => s.node?.type !== 'ObjectExpression')) {
                                out = [{ ...spread, unknownMember: true }];
                            }
                        }
                    } else {
                        const names = prop.computed ? strings(ref(prop.key, v.scope, v.env)) : [propertyName(prop)];
                        if (names?.includes(name)) out = [ref(prop.value, v.scope, v.env)];
                        else if (!names) out = [{ ...ref(prop.key, v.scope, v.env), unknownMember: true }];
                    }
                }
                return out;
            }
            if (['ClassDeclaration', 'ClassExpression'].includes(v.node?.type)) {
                return v.node.body.body.filter((p) => propertyName(p) === name)
                    .map((p) => ref(p.value, v.scope.item.scopes.get(p.value) || v.scope, v.env));
            }
            return [];
        });
    }
    function strings(value, seen = new Set(), origins = null) {
        if (!value || value.unknownMember || seen.has(value.node)) return null;
        const next = new Set([...seen, value.node]);
        const values = deref(value);
        if (!values.length) return null;
        const out = [];
        for (const v of values) {
            const { node, scope, env } = v;
            if (origins && node) origins.add(node);
            if (node?.type === 'Literal' && typeof node.value === 'string') out.push(node.value);
            else if (node?.type === 'TemplateLiteral') {
                let alternatives = [node.quasis[0].value.cooked || ''];
                for (let i = 0; i < node.expressions.length; i++) {
                    const part = strings(ref(node.expressions[i], scope, env), next, origins);
                    if (!part) {
                        alternatives = alternatives.filter(Boolean).map((p) => `${p}*`);
                        break;
                    }
                    alternatives = alternatives.flatMap((p) => part.map((s) =>
                        p.endsWith('*') ? p : p + s + (s.endsWith('*') ? '' : node.quasis[i + 1].value.cooked)));
                }
                out.push(...alternatives);
            } else if (node?.type === 'BinaryExpression' && node.operator === '+') {
                const left = strings(ref(node.left, scope, env), next, origins);
                const right = strings(ref(node.right, scope, env), next, origins);
                if (!left) return null;
                out.push(...left.flatMap((l) => l.endsWith('*') ? [l] :
                    right ? right.map((r) => l + r) : l ? [l + '*'] : []));
            } else if (node?.type === 'CallExpression' &&
                (node.callee.name === 't' || node.callee.property?.name === 't')) {
                const keys = strings(ref(node.arguments[0], scope, env), next);
                if (!keys) return null;
                for (const key of keys) {
                    const message = options.messages?.[key]?.message;
                    if (typeof message !== 'string') return null;
                    out.push(message);
                }
            } else return null;
        }
        return out.length ? [...new Set(out)] : null;
    }
    function parameterDependent(value, seen = new Set()) {
        if (!value || seen.has(value.node)) return false;
        const next = new Set([...seen, value.node]);
        if (deref(value).some((v) => v.unresolvedParam)) return true;
        return children(value.node || {}).some((n) => parameterDependent(ref(n, value.scope, value.env), next));
    }
    function secret(value, seen = new Set()) {
        if (!value?.node || seen.has(value.node)) return false;
        const { node, scope, env } = value;
        const next = new Set([...seen, node]);
        if (node.type === 'Literal' || node.type === 'TemplateElement') return false;
        if (FUNCTION_TYPES.has(node.type) || ['ThisExpression', 'NewExpression', 'ClassDeclaration', 'ClassExpression'].includes(node.type)) return false;
        if (node.type === 'Identifier' && SECRET_VALUE.test(node.name)) return true;
        if (node.type === 'MemberExpression') {
            const names = node.computed ? strings(ref(node.property, scope, env)) : [node.property.name];
            if (names?.some((n) => SECRET_VALUE.test(n) || PRIVATE_URL.test(n))) return true;
        }
        if (node.type === 'Property' && (SECRET_VALUE.test(propertyName(node) || '') || PRIVATE_URL.test(propertyName(node) || ''))) return true;
        // A pasted client identifier may also be a syntactically valid client
        // secret (offline verification cannot distinguish them). Literal public
        // identifiers do not need this precaution.
        if (node.type === 'Property' && /^client_?id$/i.test(propertyName(node) || '') &&
            !strings(ref(node.value, scope, env))) return true;
        if (deref(value).some((v) => v.node !== node && secret(v, next))) return true;
        // A call's function name and an object's non-secret key are not values.
        const nested = node.type === 'CallExpression' ? node.arguments :
            node.type === 'Property' ? [node.value] :
                node.type === 'MemberExpression' ? [node.object] : children(node);
        return nested.some((n) => secret(ref(n, scope, env), next));
    }
    function annotation(call) {
        const { node, item } = call;
        const comment = item.comments.find((c) =>
            /kage-sensitive-data:/.test(c.value) && (
                (c.loc.start.line >= node.loc.start.line && c.loc.start.line <= node.loc.end.line && c.start >= node.start) ||
                (c.loc.end.line === node.loc.start.line - 1 &&
                    !/[;{}]/.test(item.source.slice(c.end, node.start)))
            ));
        return comment?.value.match(/kage-sensitive-data:\s*(\S+)/)?.[1];
    }
    const checked = new Set();
    const deferred = new Map();
    function checkWrite(call, env, site) {
        const object = ref(call.node.arguments[1], call.scope, env);
        const keys = members(object, 'key');
        const data = members(object, 'data');
        const note = annotation(site) || annotation(call);
        if (note === 'not-sensitive') { checked.add(call.node); return; }
        if (note && !validSensitivePattern(note)) {
            report(site.item.file, site.node.loc.start.line, `Invalid kage-sensitive-data annotation '${note}'; use a storage key, trailing-* prefix, or not-sensitive.`);
            checked.add(call.node);
            return;
        }
        const resolvedPatterns = keys.flatMap((key) => strings(key) || []);
        const unresolved = !resolvedPatterns.length || keys.some((key) => !strings(key));
        // An annotation fills an analysis gap; it must not replace a known
        // storage key with a different, already-declared one.
        const patterns = note && unresolved ? [note] : resolvedPatterns;
        if (!note && unresolved) {
            if (parameterDependent(object) || keys.some((key) => parameterDependent(key))) {
                deferred.set(call.node, call);
                return;
            }
            checked.add(call.node);
            report(site.item.file, site.node.loc.start.line,
                "Storage write has an unresolved (computed key) or options object; use resolvable constants/ternaries, or annotate the call with // kage-sensitive-data: <key|not-sensitive> after reviewing it.");
            return;
        }
        checked.add(call.node);
        const secretData = data.some((v) => secret(v));
        for (const key of patterns) {
            if ((note || SENSITIVE_NAME.test(key) || PRIVATE_URL.test(key) || secretData) && !declaresSensitiveKey(manifest, key)) {
                report(site.item.file, site.node.loc.start.line,
                    `Storage key '${key}' is sensitive (${note ? 'reviewed annotation' : secretData ? 'secret-bearing value' : 'secret-bearing key name'}); add it to sensitiveData.`);
            }
        }
    }
    function expand(call, env = new Map(), site = call, stack = new Set()) {
        const origins = new Set();
        const commands = strings(ref(call.node.arguments[0], call.scope, env), new Set(), origins);
        if (commands?.includes('save_extension_data')) {
            for (const origin of origins) commandOrigins.add(origin);
            checkWrite(call, env, site);
            return;
        }
        for (const callee of deref(ref(call.node.callee, call.scope, env))) {
            const fn = callee.scope?.item.functions.get(callee.node);
            if (!fn || stack.has(fn.node)) continue;
            const inner = new Map(callee.env || env);
            fn.node.params.forEach((param, i) => {
                const pattern = param.type === 'AssignmentPattern' ? param.left : param;
                if (pattern.type === 'Identifier' && call.node.arguments[i]) {
                    inner.set(lookup(fn.scope, pattern.name), ref(call.node.arguments[i], call.scope, env));
                }
            });
            for (const nested of fn.calls) expand(nested, inner, site, new Set([...stack, fn.node]));
        }
    }
    for (const item of modules.values()) for (const call of item.calls) expand(call);
    for (const [node, call] of deferred) {
        if (!checked.has(node)) report(call.item.file, node.loc.start.line,
            "Storage wrapper has no resolvable call sites; expose its callers to the analysis or annotate its storage call with // kage-sensitive-data: <key|not-sensitive>.");
    }
    // Fail closed on command occurrences not associated with storage calls.
    // Comments are documentation, not executable occurrences.
    for (const item of modules.values()) {
        const uncovered = [...item.source.matchAll(/\bsave_extension_data\b/g)].filter((match) =>
            !item.comments.some((c) => c.start <= match.index && c.end > match.index) &&
            ![...commandOrigins].some((n) => item.scopes.has(n) && n.start <= match.index && n.end > match.index));
        if (uncovered.length) report(item.file, item.source.slice(0, uncovered[0].index).split('\n').length,
            `${uncovered.length} save_extension_data occurrence(s) could not be resolved as storage calls; use a literal command or an imported constant and a resolvable options object.`, 'sensitive-data-analysis');
    }
    const settings = new Set();
    function visitSettings(file) {
        if (settings.has(file)) return;
        settings.add(file);
        const item = modules.get(file);
        for (const node of item?.ast.body || []) {
            if (node.type === 'ImportDeclaration' || node.source) {
                const target = modulePath(item, node.source?.value);
                if (target) visitSettings(target);
            }
        }
    }
    if (manifest.contributes?.settingsProvider) visitSettings(manifest.contributes.settingsProvider.replace(/^\.\//, ''));
    for (const file of settings) {
        const item = modules.get(file);
        if (!item) continue;
        for (const node of allNodes(item.ast).filter((n) => n.type === 'ObjectExpression')) {
            const object = ref(node, item.scopes.get(node));
            const ids = members(object, 'id').flatMap((v) => strings(v) || []);
            const types = members(object, 'type').flatMap((v) => strings(v) || []);
            if (!types.some((t) => INPUT_TYPES.has(t))) continue;
            const labels = ['label', 'description'].flatMap((name) => members(object, name).flatMap((v) => strings(v) || []));
            for (const id of ids) {
                if (id.startsWith('__')) continue;
                if (SENSITIVE_NAME.test(id) || PRIVATE_URL.test(id) ||
                    (types.some((t) => t === 'text' || t === 'select') && labels.some((l) => SECRET_LABEL.test(l)))) {
                    requireConfig(id, file, node.loc.start.line, 'secret settings input');
                }
            }
        }
    }
    return results;
}
