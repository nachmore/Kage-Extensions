// Mind Map's settings page (SPEC §13). Entry module: the settings window
// loads only this provider and what it imports, so it imports mind.js
// directly for the statistics, exports, import, delete and repair.

import { getMind } from './mind.js';
import { DEFAULTS, LIMITS, TRIGGER_RE, WEEK_STARTS, snippetChars, triggerOf } from './defaults.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const KIND_ORDER = ['note', 'link', 'doc', 'action', 'meeting'];

function today(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The map explorer's controls (EXTENSION_VIEWS §24.2, §24.8): Open and
// Reset with views; on a newer Kage that has views but no approval yet, a
// hint; on an older Kage, nothing.
function explorerControls(t, features) {
  if (features.includes('views')) {
    return [
      { type: 'action', id: 'open_explorer', action: 'open_explorer', label: t('settings.open_explorer'), description: t('settings.open_explorer_hint'), variant: 'primary' },
      { type: 'action', id: 'reset_layout', action: 'reset_layout', label: t('settings.reset_layout'), description: t('settings.reset_layout_hint'), confirm: t('settings.reset_layout_confirm') },
    ];
  }
  if (features.includes('storage.change_events')) {
    return [{ type: 'info', html: `<p>${esc(t('settings.approve_views'))}</p>` }];
  }
  return [];
}

export default class MindMapSettingsProvider {
  initialize(context) {
    this.context = context;
    this.mind = getMind(context);
    this.config = context.config || {};
    this.log = context.log;
    this.t = context.i18n?.t?.bind(context.i18n) || ((key) => key);
  }

  onConfigUpdate(config) {
    this.config = config || {};
    this.mind.setConfig(this.config);
  }

  locale() {
    try {
      return this.context.i18n?.language?.() || 'en';
    } catch {
      return 'en';
    }
  }

  hostFeatures() {
    const features = this.context.hostFeatures;
    return Array.isArray(features) ? features : [];
  }

  async loadForPage() {
    try {
      await this.mind.ready();
      await this.mind.syncIfStale(0);
      return null;
    } catch (error) {
      this.log?.warn?.(`mindmap: settings could not load data (${error?.code || error?.name || 'error'})`);
      return error?.code || 'io';
    }
  }

  statsHtml(stats) {
    const t = this.t;
    const locale = this.locale();
    const num = (n) => Number(n || 0).toLocaleString(locale);
    // i18n-keys: settings.kind_*
    const kinds = KIND_ORDER.map((k) => `<li>${esc(t(`settings.kind_${k}`, { n: Number(stats.byKind[k] || 0) }))}</li>`).join('');
    const kb = Math.max(1, Math.round(stats.bytes / 1024));
    let last = t('settings.never');
    if (Number.isFinite(stats.lastSaved)) {
      try {
        last = new Intl.DateTimeFormat(locale, { calendar: 'gregory', dateStyle: 'medium', timeStyle: 'short' }).format(stats.lastSaved);
      } catch {
        last = new Date(stats.lastSaved).toISOString();
      }
    }
    return `<p><strong>${esc(t('settings.stats_title'))}</strong></p>`
      + `<ul>${kinds}`
      + `<li>${esc(t('settings.stat_entities', { n: stats.entities }))}</li>`
      + `<li>${esc(t('settings.stat_open', { n: stats.openActions }))}</li>`
      + `<li>${esc(t('settings.stat_review', { n: stats.suggestions }))}</li>`
      + `<li>${esc(t('settings.stat_size', { kb: num(kb) }))}</li>`
      + `<li>${esc(t('settings.stat_last', { when: last }))}</li></ul>`;
  }

  async getSettings() {
    const t = this.t;
    const loadError = await this.loadForPage();
    const mind = this.mind;
    const readOnly = mind.readOnly;
    const stats = mind.stats();
    const trigger = triggerOf(this.config);
    const data = [];
    if (readOnly || loadError) {
      // i18n-keys: settings.readonly_unreadable, settings.readonly_future_schema, settings.readonly_io
      const why = readOnly?.code === 'future_schema' ? 'future_schema' : readOnly ? 'unreadable' : 'io';
      data.push({ type: 'info', html: `<p><strong>⚠️ ${esc(t('row.readonly'))}</strong></p><p>${esc(t(`settings.readonly_${why}`))}</p>` });
      data.push({ type: 'action', id: 'export_raw', action: 'export_raw', label: t('settings.export_raw'), description: t('settings.export_raw_hint') });
      if (readOnly && readOnly.code !== 'future_schema') {
        data.push({ type: 'action', id: 'repair', action: 'repair', label: t('settings.repair'), description: t('settings.repair_hint'), variant: 'primary', confirm: t('settings.repair_confirm') });
      }
    }
    data.push({ type: 'info', html: this.statsHtml(stats) });
    data.push({ type: 'action', id: 'export_json', action: 'export_json', label: t('settings.export_json'), description: t('settings.export_json_hint') });
    data.push({ type: 'action', id: 'export_md', action: 'export_md', label: t('settings.export_md'), description: t('settings.export_md_hint') });
    data.push({ type: 'action', id: 'import_json', action: 'import_json', label: t('settings.import_json'), description: t('settings.import_json_hint'), disabled: !!readOnly });
    data.push({ type: 'action', id: 'delete_all', action: 'delete_all', label: t('settings.delete_all'), description: t('settings.delete_all_hint'), variant: 'danger', confirm: t('settings.delete_all_confirm') });
    const explorer = explorerControls(t, this.hostFeatures());
    const sections = [
      {
        label: t('settings.section_privacy'),
        controls: [
          { type: 'info', html: `<p>${esc(t('settings.disclosure'))}</p><p>${esc(t('settings.no_credentials'))}</p>` },
        ],
      },
      {
        label: t('settings.section_you'),
        controls: [
          { type: 'text', id: 'my_names', label: t('settings.my_names'), default: DEFAULTS.my_names, placeholder: t('settings.my_names_placeholder'), description: t('settings.my_names_hint') },
          {
            type: 'select', id: 'week_start', label: t('settings.week_start'), default: DEFAULTS.week_start,
            // i18n-keys: settings.week_*
            options: WEEK_STARTS.map((value) => ({ value, label: t(`settings.week_${value}`) })),
          },
        ],
      },
      {
        label: t('settings.section_capture'),
        controls: [
          { type: 'checkbox', id: 'fetch_link_titles', label: t('settings.fetch_link_titles'), default: DEFAULTS.fetch_link_titles, description: t('settings.fetch_link_titles_hint') },
          { type: 'checkbox', id: 'record_source_window', label: t('settings.record_source_window'), default: DEFAULTS.record_source_window, description: t('settings.record_source_window_hint') },
          { type: 'info', html: `<p>${esc(t('settings.macos_titles'))}</p>` },
          { type: 'checkbox', id: 'new_items_private', label: t('settings.new_items_private'), default: DEFAULTS.new_items_private, description: t('settings.new_items_private_hint') },
          { type: 'checkbox', id: 'auto_accept_inferred', label: t('settings.auto_accept_inferred'), default: DEFAULTS.auto_accept_inferred, description: t('settings.auto_accept_inferred_hint') },
          { type: 'info', html: `<p>${esc(t('settings.documents_note'))}</p>` },
        ],
      },
      {
        label: t('settings.section_agent'),
        controls: [
          { type: 'checkbox', id: 'agent_tools', label: t('settings.agent_tools'), default: DEFAULTS.agent_tools, description: t('settings.agent_tools_hint') },
          {
            type: 'number', id: 'agent_snippet_chars', label: t('settings.agent_snippet_chars'), default: DEFAULTS.agent_snippet_chars,
            min: LIMITS.snippetMin, max: LIMITS.snippetMax, step: 20, maxWidth: 120,
            description: t('settings.agent_snippet_chars_hint', { min: LIMITS.snippetMin, max: LIMITS.snippetMax }),
          },
        ],
      },
      {
        label: t('settings.section_launcher'),
        controls: [
          { type: 'text', id: 'trigger', label: t('settings.trigger'), default: DEFAULTS.trigger, placeholder: DEFAULTS.trigger, maxWidth: 120, description: t('settings.trigger_hint', { trigger }) },
          { type: 'info', html: `<p>${esc(t('settings.language_note'))}</p>` },
        ],
      },
      { label: t('settings.section_data'), controls: data },
    ];
    // The map explorer's section sits just before "Your data".
    if (explorer.length) sections.splice(sections.length - 1, 0, { label: t('settings.section_explorer'), controls: explorer });
    return { description: t('settings.description', { trigger }), sections };
  }

  validate(values = {}) {
    const t = this.t;
    if (values.trigger !== undefined) {
      const trigger = String(values.trigger ?? '').trim().toLowerCase();
      if (!TRIGGER_RE.test(trigger)) return { valid: false, error: t('settings.trigger_error') };
    }
    if (values.agent_snippet_chars !== undefined) {
      const n = Number(values.agent_snippet_chars);
      if (!Number.isFinite(n) || n < LIMITS.snippetMin || n > LIMITS.snippetMax) {
        return { valid: false, error: t('settings.snippet_error', { min: LIMITS.snippetMin, max: LIMITS.snippetMax }) };
      }
    }
    if (values.week_start !== undefined && !WEEK_STARTS.includes(values.week_start)) {
      return { valid: false, error: t('settings.week_error') };
    }
    return { valid: true };
  }

  normalize(values = {}) {
    const clean = {};
    for (const key of Object.keys(DEFAULTS)) if (Object.hasOwn(values, key)) clean[key] = values[key];
    if (Object.hasOwn(clean, 'my_names')) clean.my_names = String(clean.my_names ?? '').trim();
    if (Object.hasOwn(clean, 'trigger')) clean.trigger = String(clean.trigger ?? '').trim().toLowerCase();
    if (Object.hasOwn(clean, 'agent_snippet_chars')) {
      const n = Number(clean.agent_snippet_chars);
      if (Number.isFinite(n) && n >= LIMITS.snippetMin && n <= LIMITS.snippetMax) clean.agent_snippet_chars = snippetChars({ agent_snippet_chars: n });
    }
    return { values: clean };
  }

  async runAction(action) {
    const t = this.t;
    const mind = this.mind;
    try {
      if (action === 'export_json') {
        await mind.ready();
        // The explorer's pins go in the export too (layout.pins).
        await mind.loadLayout().catch(() => null);
        const data = mind.exportJson({ note: t('settings.export_note') });
        return {
          status: t('settings.exported', { n: data.items.length }),
          host: { type: 'download', filename: `mindmap-${today(mind.now())}.json`, content: JSON.stringify(data, null, 2), mime: 'application/json' },
        };
      }
      if (action === 'export_md') {
        await mind.ready();
        const counts = {};
        const content = mind.exportMarkdown(t, counts);
        return {
          status: t('settings.exported_md', { n: counts.items || 0 }),
          host: { type: 'download', filename: `mindmap-${today(mind.now())}.md`, content, mime: 'text/markdown' },
        };
      }
      if (action === 'export_raw') {
        const raw = await mind.exportRaw();
        return {
          status: t('settings.exported_raw', { n: Object.keys(raw).length }),
          host: { type: 'download', filename: `mindmap-raw-${today(mind.now())}.json`, content: JSON.stringify(raw, null, 2), mime: 'application/json' },
        };
      }
      if (action === 'import_json') {
        return { host: { type: 'pick_file', accept: '.json', action: 'import_json' } };
      }
      if (action === 'open_explorer') {
        // permissions: views
        return this.hostFeatures().includes('views') ? { host: { type: 'open_view', view: 'explorer' } } : {};
      }
      if (action === 'reset_layout') {
        await mind.resetLayout();
        return { status: t('settings.layout_reset') };
      }
      if (action === 'delete_all') {
        const out = await mind.deleteAll();
        return { status: t('settings.deleted', { n: out.keys }), host: { type: 'refresh' } };
      }
      if (action === 'repair') {
        const out = await mind.repair();
        // i18n-keys: settings.repair_*
        return { status: out.ok ? t('settings.repaired') : t(`settings.repair_${out.code || 'failed'}`), host: { type: 'refresh' } };
      }
      return {};
    } catch (error) {
      this.log?.warn?.(`mindmap: settings action failed (${error?.code || error?.name || 'error'})`);
      return { status: this.errText(error?.code) };
    }
  }

  errText(code) {
    const known = new Set(['readonly', 'busy', 'conflict', 'io', 'unreadable', 'bad_format', 'future_schema']);
    // i18n-keys: err.*
    return this.t(known.has(code) ? `err.${code}` : 'err.generic');
  }

  async onFileSelected({ action, content } = {}) {
    if (action !== 'import_json') return {};
    const t = this.t;
    try {
      if (typeof content !== 'string' || content.length > 64 * 1024 * 1024) return { status: t('err.bad_format') };
      const out = await this.mind.importJson(content);
      const unreadable = out.invalid ? ` ${t('settings.import_skipped', { n: out.invalid })}` : '';
      // A file whose every record is already here (or older) changes nothing.
      if (!out.ok && out.code === 'noop') return { status: out.invalid ? t('settings.import_unreadable', { n: out.invalid }) : t('settings.import_nothing') };
      if (!out.ok) return { status: this.errText(out.code) };
      const counts = { added: out.added || 0, updated: out.updated || 0, cmd: `${triggerOf(this.config)} undo` };
      // i18n-keys: settings.imported, settings.imported_no_undo
      const done = t(out.undoable === false ? 'settings.imported_no_undo' : 'settings.imported', counts);
      return { status: `${done}${unreadable}`, host: { type: 'refresh' } };
    } catch (error) {
      return { status: this.errText(error?.code) };
    }
  }
}
