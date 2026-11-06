// Non-executing, scope-aware analysis. Only explicit imports within this
// extension supply constants and wrappers; unrelated names never match.
import { parse } from 'acorn';
import path from 'node:path';
import { SENSITIVE_NAME, declaresSensitiveKey, validSensitivePattern } from './sensitive-data.mjs';
import { jsonLine } from './json-lines.mjs';

const SECRET_VALUE = /^(?:_*(?:(?:(?:access|refresh|auth|oauth|bearer|id)[_-]?)?tokens?|secret|client_?secret|api_?key|password|passwd|credentials|creds|session_?cookie|cookies?|private_?url|ics_?url|subscription_?url|webhook_?url)_*|__.*(?:token|secret|password|api_?key).*|.*(?:AccessToken|RefreshToken|ClientSecret|ApiKey|Password))$/i;
const PRIVATE_URL = /(?:^|[_.-])(?:private|secret|ics|subscription|webhook)[_-]?(?:url|uri|address|endpoint)$/i;
const PRIVATE_URL_CAMEL = /(?:^|[a-z])(?:Private|Secret|Ics|ICS|Subscription|Webhook)(?:Url|URL|Uri|URI|Address|Endpoint)$|^(?:private|secret|ics|subscription|webhook)(?:Url|URL|Uri|URI|Address|Endpoint)$/;
const privateUrl = (name) => PRIVATE_URL.test(name) || PRIVATE_URL_CAMEL.test(name);
// Mirrors the host's indirect-name exclusions: flags, bounds and quantities
// describe a secret rather than containing one. Bare plural tokens are also
// commonly lexer output or a numeric budget; access/refresh tokens still match.
const INDIRECT_NAME = /^(?:has|is|use|uses|enable|enabled|disable|disabled|allow|show|require|max|min|default|num|number|count|total)[A-Z_-]|(?:Count|Limit|Length|Size|Enabled|Disabled|Required|Status|Mode|Type)$|(?:^|[_-])(?:count|limit|length|size|enabled|disabled|required|status|mode|type)$/;
const secretName = (name) => name !== 'tokens' && !INDIRECT_NAME.test(name) && SECRET_VALUE.test(name);
const SECRET_LABEL = /\b(?:bearer|api[\s_-]*key|tokens?(?![\s_-]+(?:limit|count|length|budget)\b)|secret|credentials?|password|client[\s_-]*secret|webhook|(?:private|secret|subscription|ics).*(?:url|address))\b/i;
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
    const item = { file, source, ast, comments, scopes: new WeakMap(), parents: new WeakMap(), functions: new Map(), calls: [], exports: new Map(), classMembers: new WeakMap() };
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
    function visit(node, scope, parent = null) {
        item.scopes.set(node, scope);
        item.parents.set(node, parent);
        if (node.type === 'FunctionDeclaration' && node.id) bind(scope, node.id.name, { node, scope });
        if (node.type === 'ClassDeclaration' && node.id) bind(scope, node.id.name, { node, scope });
        if (FUNCTION_TYPES.has(node.type)) {
            const inner = { ...scope, parent: scope, bindings: new Map(), fn: node };
            item.functions.set(node, { node, scope: inner, calls: [] });
            if (node.id) bind(inner, node.id.name, { node, scope });
            for (const param of node.params) bindPattern(param, null, inner, true);
            for (const child of children(node)) visit(child, inner, node);
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
        for (const child of children(node)) visit(child, scope, node);
    }
    visit(ast, root);
    item.nodes = allNodes(ast);
    // Never silently choose the first value after a reassignment.
    for (const node of item.nodes) {
        if (node.type !== 'AssignmentExpression' && node.type !== 'UpdateExpression') continue;
        const left = node.left || node.argument;
        const scope = item.scopes.get(node);
        if (left.type === 'Identifier') {
            const binding = lookup(scope, left.name);
            if (binding) {
                if (node.operator !== '=') binding.invalid = true;
                else binding.values.push({ node: node.right, scope });
            }
        } else if (left.type === 'MemberExpression' && left.object.type === 'Identifier') {
            const binding = lookup(scope, left.object.name);
            if (binding) binding.invalid = true;
        } else if (left.type.endsWith('Pattern')) {
            for (const part of allNodes(left).filter((n) => n.type === 'Identifier')) {
                const binding = lookup(scope, part.name);
                if (binding) binding.invalid = true;
            }
        }
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
    const report = (file, line, message, pattern = 'undeclared-sensitive-data', severity = 'error') => {
        const id = `${file}:${line}:${message}`;
        if (severity === 'error' && reported.has(id)) return;
        reported.add(id);
        results.push({ file, line, severity, pattern, message });
    };
    const requireConfig = (field, file, line, reason) => {
        if (manifest.config?.[field]?.sensitive !== true) {
            report(file, line, `config.${field} is sensitive (${reason}); declare config.${field}.sensitive: true.`);
        }
    };
    for (const [field] of Object.entries(manifest.config || {})) {
        if ((!INDIRECT_NAME.test(field) && SENSITIVE_NAME.test(field)) || privateUrl(field)) {
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
    // Imports must stay inside the exact set of analyzed, packaged modules.
    // Checking re-exports and dynamic imports closes the same boundary.
    for (const item of modules.values()) {
        for (const node of item.nodes) {
            const source = node.type === 'ImportExpression' ? node.source :
                ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) ? node.source : null;
            for (const from of source ? strings(ref(source, item.scopes.get(node))) || [] : []) {
                if (from.startsWith('.') && !modules.has(modulePath(item, from))) report(item.file, node.loc.start.line,
                    `Relative import '${from}' is not an analyzed module; import packaged JavaScript (test/spec files are excluded).`, 'sensitive-data-analysis');
            }
        }
        for (const comment of item.comments) {
            if (/kage-sensitive-data:/.test(comment.value)) report(item.file, comment.loc.start.line,
                `Reviewed annotation: ${comment.value.trim()}`, 'sensitive-data-annotation', 'warn');
        }
    }
    function exportedValues(mod, name, seen = new Set()) {
        if (!mod || seen.has(mod)) return [];
        const exported = mod.exports.get(name);
        if (exported) return [exported.name ? { binding: lookup(mod.root, exported.name) } : exported];
        return mod.ast.body.filter((n) => n.type === 'ExportAllDeclaration')
            .flatMap((n) => exportedValues(modules.get(modulePath(mod, n.source.value)), name, new Set([...seen, mod])));
    }
    function exportedNames(mod, seen = new Set()) {
        if (!mod || seen.has(mod)) return [];
        return [...mod.exports.keys(), ...mod.ast.body.filter((n) => n.type === 'ExportAllDeclaration')
            .flatMap((n) => exportedNames(modules.get(modulePath(mod, n.source.value)), new Set([...seen, mod])))];
    }
    function imported(value) {
        const mod = modules.get(modulePath(value.item, value.from));
        if (!mod) return null;
        if (value.imported === '*') return { namespace: mod };
        return { alternatives: exportedValues(mod, value.imported) };
    }
    // Lexical/import resolution retains argument environments through wrappers.
    function deref(value, seen = new Set()) {
        if (!value) return [];
        if (value.alternatives) return value.alternatives.flatMap((v) => deref(v, seen));
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
            if (binding.invalid) return [{ ...value, node: null, unknownMember: true }];
            if (env.has(binding)) return deref(env.get(binding), next);
            if (binding.param) return [{ ...value, binding, unresolvedParam: true }];
            return binding.values.flatMap((v) => deref({ env, ...v }, next));
        }
        if (node?.type === 'MemberExpression') {
            if (seen.has(node)) return [{ ...value, unknownMember: true }];
            const next = new Set([...seen, node]);
            const names = node.computed ? strings(ref(node.property, scope, env)) : [node.property.name];
            const resolved = names?.flatMap((name) => members(ref(node.object, scope, env), name, next)) || [];
            return resolved.length ? resolved.map((v) => v.unknownMember ? { ...v, node, scope, env } : v) : [value];
        }
        if (node?.type === 'ChainExpression' || node?.type === 'AwaitExpression') return deref(ref(node.expression || node.argument, scope, env), seen);
        if (node?.type === 'ConditionalExpression') return [node.consequent, node.alternate].flatMap((n) => deref(ref(n, scope, env), seen));
        if (node?.type === 'LogicalExpression') return [node.left, node.right].flatMap((n) => deref(ref(n, scope, env), seen));
        if (node?.type === 'ThisExpression') return scope.classNode ? [ref(scope.classNode, scope, env)] : [];
        if (node?.type === 'NewExpression') return deref(ref(node.callee, scope, env), seen);
        if (node?.type === 'ImportExpression') {
            const targets = strings(ref(node.source, scope, env));
            return (targets || []).flatMap((target) => {
                const mod = modules.get(modulePath(scope.item, target));
                return mod ? [{ namespace: mod, env }] : [];
            });
        }
        return [value];
    }
    function members(value, name, seen = new Set()) {
        return deref(value, seen).flatMap((v) => {
            if (v.namespace) {
                return exportedValues(v.namespace, name).flatMap((exported) => deref({ ...exported, env: v.env }, seen));
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
                let fields = v.scope.item.classMembers.get(v.node);
                if (!fields) {
                    fields = new Map();
                    for (const p of allNodes(v.node)) {
                        if (p.type !== 'AssignmentExpression' || p.left.type !== 'MemberExpression' ||
                            p.left.object.type !== 'ThisExpression' || p.left.computed) continue;
                        const key = p.left.property.name;
                        if (!fields.has(key)) fields.set(key, []);
                        fields.get(key).push(p);
                    }
                    v.scope.item.classMembers.set(v.node, fields);
                }
                const methods = v.node.body.body.filter((p) => propertyName(p) === name)
                    .map((p) => ref(p.value, v.scope.item.scopes.get(p.value) || v.scope, v.env));
                // Settings providers use instance fields for transient IDs.
                const assignments = fields.get(name) || [];
                return [...methods, ...assignments.flatMap((p) => p.operator === '='
                    ? deref(ref(p.right, v.scope.item.scopes.get(p), v.env), seen) : [{ unknownMember: true }])];
            }
            return v.node || v.unknownMember ? [{ ...v, unknownMember: true }] : [];
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
            if (v.unknownMember) return null;
            if (origins && node) origins.add(node);
            if (node?.type === 'Literal' && typeof node.value === 'string') out.push(node.value);
            else if (node?.type === 'TemplateLiteral') {
                let alternatives = [node.quasis[0].value.cooked || ''];
                for (let i = 0; i < node.expressions.length; i++) {
                    const part = strings(ref(node.expressions[i], scope, env), next, origins);
                    if (!part) {
                        if (alternatives.some((p) => p && !/[_-]$/.test(p) && !SENSITIVE_NAME.test(p))) return null;
                        alternatives = alternatives.filter(Boolean).map((p) => `${p}*`);
                        // Preserve every literal fragment. An interior wildcard
                        // is unresolved rather than pretending to be a prefix.
                        if (node.quasis.slice(i + 1).some((q) => q.value.cooked)) return null;
                        break;
                    }
                    if (part.some((s) => s.includes('*')) && node.quasis.slice(i + 1).some((q) => q.value.cooked)) return null;
                    alternatives = alternatives.flatMap((p) => part.map((s) => p + s + node.quasis[i + 1].value.cooked));
                }
                out.push(...alternatives);
            } else if (node?.type === 'BinaryExpression' && node.operator === '+') {
                const left = strings(ref(node.left, scope, env), next, origins);
                const right = strings(ref(node.right, scope, env), next, origins);
                if (!left) return null;
                if (!right && left.some((l) => l && !/[_-]$/.test(l) && !SENSITIVE_NAME.test(l))) return null;
                if (left.some((l) => l.includes('*')) && right?.some(Boolean)) return null;
                out.push(...left.flatMap((l) => l.endsWith('*') ? [l] :
                    right ? right.map((r) => l + r) : l ? [l + '*'] : []));
            } else if (node?.type === 'CallExpression' &&
                translator(ref(node.callee, scope, env))) {
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
    function translator(value, seen = new Set()) {
        if (!value?.node || seen.has(value.node)) return false;
        const { node, scope } = value;
        if (node.type === 'MemberExpression' && node.property.name === 't') return true;
        if (node.type !== 'Identifier') return false;
        const binding = lookup(scope, node.name);
        if (!binding) return node.name === 't';
        return binding.values.some((v) => translator(v, new Set([...seen, node])));
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
        if (node.type === 'Identifier' && (secretName(node.name) || privateUrl(node.name))) return true;
        if (node.type === 'MemberExpression') {
            const names = node.computed ? strings(ref(node.property, scope, env)) : [node.property.name];
            if (names?.some((n) => secretName(n) || privateUrl(n))) return true;
        }
        if (node.type === 'Property' && (secretName(propertyName(node) || '') || privateUrl(propertyName(node) || ''))) return true;
        const invocation = node.type === 'CallExpression' ? invokeCall({ node, scope }, env) : null;
        if (invocation && strings(ref(invocation.node.arguments[0], scope, env))
            ?.some((s) => /^oauth_(?:exchange|loopback_await)$/.test(s))) return true;
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
        return comment?.value.match(/kage-sensitive-data:\s*(\S+)/)?.[1]?.replace(/[.,;:]+$/, '');
    }
    // Normalize indirect invocation so the command is always argument zero.
    // These forms are checked, but remain indirect references for wrappers.
    function invokeCall(call, env = new Map()) {
        const { node, scope } = call;
        const isInvoke = (value, seen = new Set()) => {
            const n = value?.node;
            if (!n || seen.has(n)) return false;
            const next = new Set([...seen, n]);
            if (n.type === 'ChainExpression') return isInvoke(ref(n.expression, value.scope, env), next);
            if (n.type === 'MemberExpression') {
                const names = n.computed ? strings(ref(n.property, value.scope, env)) : [n.property.name];
                if (names?.some((name) => /^_*invoke$/.test(name))) return true;
                return deref(value).some((v) => v.node !== n && isInvoke(v, next));
            }
            if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property.name === 'bind') {
                return isInvoke(ref(n.callee.object, value.scope, env), next);
            }
            if (n.type === 'Identifier') {
                if (/^_*invoke$/.test(n.name)) return true;
                return deref(value).some((v) => v.node !== n && isInvoke(v, next));
            }
            return false;
        };
        let callee = node.callee;
        let args = node.arguments;
        if (callee.type === 'MemberExpression' && callee.object.name === 'Reflect' && callee.property.name === 'apply') {
            if (!isInvoke(ref(args[0], scope, env))) return null;
            const array = deref(ref(args[2], scope, env));
            args = array.length === 1 && array[0].node?.type === 'ArrayExpression' ? array[0].node.elements : [];
        } else if (callee.type === 'MemberExpression' && ['call', 'apply'].includes(callee.property.name)) {
            if (!isInvoke(ref(callee.object, scope, env))) return null;
            if (callee.property.name === 'call') args = args.slice(1);
            else {
                const array = deref(ref(args[1], scope, env));
                args = array.length === 1 && array[0].node?.type === 'ArrayExpression' ? array[0].node.elements : [];
            }
        } else if (!isInvoke(ref(callee, scope, env))) return null;
        return { ...call, node: { ...node, arguments: args } };
    }
    const deferred = [];
    const paths = new Map();
    function defer(call, site, chain, reason, allowNoReferences = false) {
        const entry = { call, site, chain, reason, allowNoReferences };
        deferred.push(entry);
        paths.get(chain[0].node).push(entry);
    }
    function checkWrite(call, env, site, chain) {
        const object = ref(call.node.arguments[1], call.scope, env);
        const keys = members(object, 'key');
        const data = members(object, 'data');
        const note = annotation(site) || annotation(call);
        if (note && note !== 'not-sensitive' && !validSensitivePattern(note)) {
            report(site.item.file, site.node.loc.start.line, `Invalid kage-sensitive-data annotation '${note}'; use a storage key, trailing-* prefix, or not-sensitive.`);
            return;
        }
        const alternatives = keys.flatMap((key) => deref(key));
        const resolvedPatterns = alternatives.flatMap((key) => strings(key) || []);
        const unresolved = !resolvedPatterns.length || alternatives.some((key) => !strings(key));
        // An annotation fills an analysis gap; it must not replace a known
        // storage key with a different, already-declared one.
        const patterns = note && note !== 'not-sensitive' && unresolved ? [...resolvedPatterns, note] : resolvedPatterns;
        if (!note && unresolved) {
            if (parameterDependent(object) || keys.some((key) => parameterDependent(key))) {
                defer(call, site, chain, 'Storage write has an unresolved (computed key) or options object');
            } else report(site.item.file, site.node.loc.start.line,
                "Storage write has an unresolved (computed key) or options object; use resolvable constants/ternaries, or annotate the call with // kage-sensitive-data: <key|not-sensitive> after reviewing it.");
        }
        const secretData = data.some((v) => secret(v));
        for (const key of patterns) {
            if (((note && note !== 'not-sensitive') || SENSITIVE_NAME.test(key) || privateUrl(key) || secretData) && !declaresSensitiveKey(manifest, key)) {
                report(site.item.file, site.node.loc.start.line,
                    `Storage key '${key}' is sensitive (${note && note !== 'not-sensitive' ? 'reviewed annotation' : secretData ? 'secret-bearing value' : 'secret-bearing key name'}); add it to sensitiveData.`);
            }
        }
        // A fixed ordinary key does not make a helper's opaque parameter safe:
        // its callers can pass accessToken through an innocuous parameter name.
        if (!unresolved && !secretData && patterns.some((key) => !declaresSensitiveKey(manifest, key)) &&
            data.some((v) => parameterDependent(v))) {
            defer(call, site, chain, 'Storage value has an unresolved wrapper argument', true);
        }
    }
    function expand(call, env = new Map(), site = call, stack = new Set(), chain = [call]) {
        const invocation = invokeCall(call, env);
        const origins = new Set();
        const commands = invocation ? strings(ref(invocation.node.arguments[0], call.scope, env), new Set(), origins) : null;
        if (invocation && (!commands || commands.some((s) => s.includes('*')))) {
            const value = ref(invocation.node.arguments[0], call.scope, env);
            if (parameterDependent(value)) defer(call, site, chain, 'Invoke command has an unresolved wrapper argument');
            else report(site.item.file, site.node.loc.start.line,
                'Invoke command is unresolved; commands must be literals or resolvable constants, including .call/.apply/Reflect.apply.', 'sensitive-data-analysis');
            return;
        }
        if (invocation && commands?.includes('save_extension_data')) {
            for (const origin of origins) commandOrigins.add(origin);
            checkWrite(invocation, env, site, chain);
            return;
        }
        if (invocation) return;
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
            for (const nested of fn.calls) expand(nested, inner, site, new Set([...stack, fn.node]), [...chain, nested]);
        }
    }
    const references = new Map();
    const addReference = (fn, reference) => {
        if (!references.has(fn)) references.set(fn, []);
        references.get(fn).push(reference);
    };
    for (const item of modules.values()) {
        const calls = new Map(item.calls.map((c) => [c.node, c]));
        for (const node of item.nodes) {
            const parent = item.parents.get(node);
            const scope = item.scopes.get(node);
            if (node.type === 'Identifier') {
                if ((parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
                    (parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) ||
                    (parent?.type === 'VariableDeclarator' && parent.id === node) ||
                    parent?.type?.startsWith('Import') || parent?.type?.startsWith('Export') ||
                    (FUNCTION_TYPES.has(parent?.type) && (parent.id === node || parent.params.includes(node)))) continue;
            } else if (node.type !== 'MemberExpression' && !FUNCTION_TYPES.has(node.type)) continue;
            if (FUNCTION_TYPES.has(node.type) && (node.type === 'FunctionDeclaration' ||
                parent?.type === 'VariableDeclarator' || parent?.type === 'MethodDefinition' ||
                parent?.type === 'PropertyDefinition' || parent?.type === 'Property' ||
                parent?.type === 'ExportDefaultDeclaration')) continue;
            let at = node;
            let container = parent;
            if (container?.type === 'ChainExpression') {
                at = container;
                container = item.parents.get(container);
            }
            for (const value of deref(ref(node, scope))) {
                if (!value.scope?.item.functions.has(value.node)) continue;
                const direct = container?.type === 'CallExpression' && container.callee === at;
                addReference(value.node, direct ? { call: calls.get(container) } : { escaped: true });
            }
        }
        // A dynamically loaded namespace cannot establish direct references
        // to every exported wrapper. Do not let a safe static caller cover it.
        for (const node of item.nodes.filter((n) => n.type === 'ImportExpression')) {
            for (const target of strings(ref(node.source, item.scopes.get(node))) || []) {
                const mod = modules.get(modulePath(item, target));
                for (const name of exportedNames(mod)) for (const value of exportedValues(mod, name)) {
                    for (const v of deref(value)) if (v.scope?.item.functions.has(v.node)) addReference(v.node, { escaped: true });
                }
            }
        }
        for (const call of item.calls) {
            paths.set(call.node, []);
            expand(call);
        }
    }
    function resolvedPath(entry, seen = new Set()) {
        const root = entry.chain[0];
        const fn = root.scope.fn;
        if (!fn || seen.has(fn)) return false;
        const refs = references.get(fn) || [];
        if (!refs.length && entry.allowNoReferences) return true;
        return refs.length > 0 && refs.every((r) => !r.escaped && r.call &&
            (paths.get(r.call.node) || []).every((p) => resolvedPath(p, new Set([...seen, fn]))));
    }
    for (const entry of deferred) {
        if (resolvedPath(entry)) continue;
        const remedy = entry.reason.startsWith('Invoke command')
            ? 'Commands must be literals or resolvable constants at every direct caller; annotations cannot bypass command resolution.'
            : 'Expose every caller as a direct call with resolvable arguments, or annotate its storage call with // kage-sensitive-data: <key|not-sensitive> after review.';
        report(entry.site.item.file, entry.site.node.loc.start.line,
            `${entry.reason}; storage wrapper has no resolvable call sites for this path, or has an escaped/indirect reference. ${remedy}`, 'sensitive-data-analysis');
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
        for (const node of item?.nodes || []) {
            if (node.type === 'ImportDeclaration' || node.type === 'ImportExpression' || node.source) {
                for (const from of node.source ? strings(ref(node.source, item.scopes.get(node))) || [] : []) {
                    const target = modulePath(item, from);
                    if (target) visitSettings(target);
                }
            }
        }
    }
    if (manifest.contributes?.settingsProvider) visitSettings(manifest.contributes.settingsProvider.replace(/^\.\//, ''));
    // Check schema/collection boundaries as well as literal control objects.
    // Otherwise controls: await factory() would leave no object to inspect.
    function settingsShape(value, kind, seen = new Set()) {
        if (!value?.node || seen.has(value.node)) return false;
        const next = new Set([...seen, value.node]);
        const values = deref(value);
        if (!values.length) return false;
        return values.every((v) => {
            const { node, scope, env } = v;
            if (!node || v.unknownMember) return false;
            if (node.type === 'ArrayExpression') return node.elements.every((element) =>
                element && settingsShape(ref(element.type === 'SpreadElement' ? element.argument : element, scope, env),
                    kind === 'sections' ? 'section' : 'control', next));
            if (node.type === 'ObjectExpression') {
                if (kind === 'schema') {
                    const sections = members(v, 'sections');
                    return sections.length > 0 && sections.every((s) => settingsShape(s, 'sections', next));
                }
                if (kind === 'section') {
                    const controls = members(v, 'controls');
                    return !controls.length || controls.every((c) => settingsShape(c, 'controls', next));
                }
                const types = members(v, 'type');
                return types.length > 0 && types.every((t) => strings(t)?.every((s) => INPUT_TYPES.has(s) || ['action', 'info'].includes(s)));
            }
            if (node.type !== 'CallExpression') return false;
            // Filtering cannot introduce an unexamined control. A mapping
            // that only copies a control and adds presentation fields cannot
            // change its id/type/label either (Spotify's legacy showWhen copy).
            if (node.callee.type === 'MemberExpression' && ['map', 'filter'].includes(node.callee.property.name)) {
                const callback = node.arguments[0];
                const copy = callback?.type === 'ArrowFunctionExpression' && callback.body.type === 'ObjectExpression' &&
                    callback.body.properties.some((p) => p.type === 'SpreadElement' && p.argument.name === callback.params[0]?.name) &&
                    callback.body.properties.every((p) => p.type === 'SpreadElement'
                        ? p.argument.name === callback.params[0]?.name
                        : p.type === 'Property' && !p.computed && ['showWhen', 'disabled', 'hidden', 'maxWidth', 'description'].includes(propertyName(p)));
                if (node.callee.property.name === 'filter' || copy) {
                    return settingsShape(ref(node.callee.object, scope, env), kind, next);
                }
            }
            const callees = deref(ref(node.callee, scope, env));
            return callees.length > 0 && callees.every((callee) => {
                const fn = callee.scope?.item.functions.get(callee.node);
                if (!fn) return false;
                const returns = fn.node.body.type === 'BlockStatement'
                    ? callee.scope.item.nodes.filter((n) => n.type === 'ReturnStatement' && callee.scope.item.scopes.get(n).fn === fn.node)
                        .map((n) => ref(n.argument, callee.scope.item.scopes.get(n), env))
                    : [ref(fn.node.body, fn.scope, env)];
                return returns.length > 0 && returns.every((r) => settingsShape(r, kind, next));
            });
        });
    }
    for (const file of settings) {
        const item = modules.get(file);
        if (!item) {
            report(file, 1, 'Settings provider is not an analyzed module; use a packaged JavaScript module.', 'sensitive-data-analysis');
            continue;
        }
        const schemaGap = (node, value, kind) => {
            if (settingsShape(value, kind)) return;
            const note = annotation({ node, item });
            if (note && note !== 'not-sensitive' && validSensitivePattern(note)) {
                requireConfig(note, file, node.loc.start.line, 'reviewed settings annotation');
            } else if (note !== 'not-sensitive') report(file, node.loc.start.line,
                `Settings ${kind} cannot be analyzed; use literal arrays/objects or local helpers with visible returns, or annotate with // kage-sensitive-data: <config-field|not-sensitive> after review.`,
                'sensitive-data-analysis');
        };
        for (const node of item.nodes) {
            if (node.type === 'Property' && propertyName(node) === 'controls') {
                schemaGap(node, ref(node.value, item.scopes.get(node)), 'controls');
            }
            if (node.type === 'ReturnStatement') {
                const fn = item.scopes.get(node).fn;
                const parent = item.parents.get(fn);
                if (propertyName(parent || {}) === 'getSettings' || fn?.id?.name === 'getSettings') {
                    schemaGap(node, ref(node.argument, item.scopes.get(node)), 'schema');
                }
            }
        }
        for (const node of item.nodes.filter((n) => n.type === 'ObjectExpression')) {
            if (!node.properties.some((p) => p.type === 'Property' && propertyName(p) === 'type')) continue;
            const object = ref(node, item.scopes.get(node));
            const idValues = members(object, 'id');
            const typeValues = members(object, 'type');
            if (!typeValues.length) continue;
            const ids = idValues.flatMap((v) => strings(v) || []);
            const types = typeValues.flatMap((v) => strings(v) || []);
            const unresolved = (values) => !values.length || values.some((v) => !strings(v));
            const settingsGap = (reason) => report(file, node.loc.start.line,
                `Settings control has unresolved ${reason}; restructure it with literal/constant id, type and English label (including EN translation keys), or annotate it with // kage-sensitive-data: <config-field|not-sensitive> after review.`,
                'sensitive-data-analysis');
            const note = annotation({ node, item });
            if (note && note !== 'not-sensitive' && !validSensitivePattern(note)) settingsGap('annotation');
            for (const id of ids) {
                if (!id.startsWith('__') && (unresolved(typeValues) || types.some((t) => INPUT_TYPES.has(t))) &&
                    (SENSITIVE_NAME.test(id) || privateUrl(id))) {
                    requireConfig(id, file, node.loc.start.line, 'secret settings input name');
                }
            }
            if (unresolved(typeValues)) {
                if (!note) settingsGap('type');
                else if (note !== 'not-sensitive') requireConfig(note, file, node.loc.start.line, 'reviewed settings annotation');
                continue;
            }
            if (!types.some((t) => INPUT_TYPES.has(t))) continue;
            if (unresolved(idValues)) {
                if (!note) settingsGap('id');
                else if (note !== 'not-sensitive') requireConfig(note, file, node.loc.start.line, 'reviewed settings annotation');
            }
            const labelValues = members(object, 'label');
            const labels = labelValues.flatMap((v) => deref(v).flatMap((alternative) => strings(alternative) || []));
            if (types.includes('text') && unresolved(labelValues) && !(ids.length && ids.every((id) => id.startsWith('__')))) {
                if (!note) settingsGap('text label');
                else if (note !== 'not-sensitive') requireConfig(note, file, node.loc.start.line, 'reviewed settings annotation');
            }
            for (const id of ids) {
                if (id.startsWith('__')) continue;
                if (types.includes('text') && labels.some((l) => SECRET_LABEL.test(l))) {
                    requireConfig(id, file, node.loc.start.line, 'secret settings input');
                }
            }
        }
    }
    return results.sort((a, b) => (a.severity === 'warn') - (b.severity === 'warn'));
}
