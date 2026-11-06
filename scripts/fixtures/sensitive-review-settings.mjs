// Regression fixtures from /tmp/kx-review.JexY/probes/probe2.mjs (2026-11-06).
const S = (src, extra = {}, messages = {}) => [{ id: 'x', permissions: [], contributes: { settingsProvider: './settings.js' }, ...extra }, [{ file: 'settings.js', source: src }], { messages }];
const ctl = (c) => `export default class S { getSettings(){ const t = this.t; return { sections: [{ controls: [${c}] }] }; } }`;
const cases = {
  'manifest config slack_webhook_url': [{ id: 'x', config: { slack_webhook_url: { type: 'string', default: '' } } }, [], {}],
  'manifest config calendar_ics_url': [{ id: 'x', config: { calendar_ics_url: { type: 'string', default: '' } } }, [], {}],
  'manifest config icsUrl': [{ id: 'x', config: { icsUrl: { type: 'string', default: '' } } }, [], {}],
  'storage key slack_webhook_url': [{ id: 'x' }, [{ file: 'a.js', source: `export async function s(ctx, v){ await ctx.invoke('save_extension_data', { key: 'slack_webhook_url', data: v }); }` }], {}],
  'storage value slackWebhookUrl': [{ id: 'x' }, [{ file: 'a.js', source: `export async function s(ctx, slackWebhookUrl){ await ctx.invoke('save_extension_data', { key: 'hooks', data: JSON.stringify({ slackWebhookUrl }) }); }` }], {}],
  'storage value config.slack_webhook_url': [{ id: 'x' }, [{ file: 'a.js', source: `export async function s(ctx){ await ctx.invoke('save_extension_data', { key: 'hooks', data: JSON.stringify({ u: ctx.config.slack_webhook_url }) }); }` }], {}],
  'settings text id=key label t(API key)': S(ctl(`{ type: 'text', id: 'key', label: t('k.label') }`), {}, { 'k.label': { message: 'API key' } }),
  'settings helper factory': S(`function field(id, type, label){ return { id, type, label }; }\n` + ctl(`field('key', 'text', 'API key')`)),
  'settings unresolved type': S(`export default class S { getSettings(kind){ return { sections: [{ controls: [{ id: 'key', type: kind, label: 'API key' }] }] }; } }`),
  'settings t alias': S(`export default class S { getSettings(){ const tr = this.t; return { sections: [{ controls: [{ id: 'key', type: 'text', label: tr('k.label') }] }] }; } }`, {}, { 'k.label': { message: 'API key' } }),
  'settings label key missing in en': S(ctl(`{ type: 'text', id: 'key', label: t('k.missing') }`)),
  'settings controls via spread array': S(`const SECRET = [{ type: 'text', id: 'key', label: 'API key' }];\n` + ctl(`...SECRET`)),
  'settings controls in non-imported (dynamic) module': [{ id: 'x', contributes: { settingsProvider: './settings.js' } }, [{ file: 'settings.js', source: `export default class S { async getSettings(){ const m = await import('./controls.js'); return m.default; } }` }, { file: 'controls.js', source: `export default { sections: [{ controls: [{ type: 'text', id: 'key', label: 'API key' }] }] };` }], {}],
  'FP: text home_location description mentions API key': S(ctl(`{ type: 'text', id: 'home_location', label: 'Home location', description: 'No API key required.' }`), { config: { home_location: { type: 'string', default: '' } } }),
  'FP: select Access level': S(ctl(`{ type: 'select', id: 'mode', label: 'Access level', options: [] }`), { config: { mode: { type: 'string', default: 'a' } } }),
  'FP: text label Token limit': S(ctl(`{ type: 'text', id: 'limit', label: 'Token limit' }`), { config: { limit: { type: 'string', default: '' } } }),
  'FP: text label Quick access keyword': S(ctl(`{ type: 'text', id: 'trigger', label: 'Quick access keyword' }`), { config: { trigger: { type: 'string', default: 'x' } } }),
  'FP: text label Pat (name)': S(ctl(`{ type: 'text', id: 'greeting', label: 'Greeting', description: 'e.g. Hi Pat!' }`), { config: { greeting: { type: 'string', default: '' } } }),
  'FP: config auth_mode boolean': [{ id: 'x', config: { use_oauth: { type: 'boolean', default: false } } }, [], {}],
  'FP: storage tokens (lexer) value': [{ id: 'x' }, [{ file: 'a.js', source: `export async function s(ctx, expr){ const tokens = expr.split(' '); await ctx.invoke('save_extension_data', { key: 'history', data: JSON.stringify({ expr, tokens }) }); }` }], {}],
  'FP: storage hasApiKey boolean': [{ id: 'x' }, [{ file: 'a.js', source: `export async function s(ctx, hasApiKey){ await ctx.invoke('save_extension_data', { key: 'status', data: JSON.stringify({ hasApiKey }) }); }` }], {}],
  'FP: storage maxTokens': [{ id: 'x' }, [{ file: 'a.js', source: `export async function s(ctx, n){ await ctx.invoke('save_extension_data', { key: 'prefs', data: JSON.stringify({ tokens: n }) }); }` }], {}],
  'FP: storage key session_history': [{ id: 'x' }, [{ file: 'a.js', source: `export async function s(ctx, v){ await ctx.invoke('save_extension_data', { key: 'focus_sessions', data: v }); }` }], {}],
};

export default cases;
