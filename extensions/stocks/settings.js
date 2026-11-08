import { DEFAULTS, MIN_REFRESH_SECONDS, MAX_REFRESH_SECONDS, MAX_PER_MINUTE, refreshSeconds } from './defaults.js';
import { FREE_KEY_URL, getClient, validKey } from './client.js';
import { MAX_SYMBOLS, parseSymbols } from './symbols.js';
import { errorText, escapeHtml } from './format.js';

export default class StocksSettingsProvider {
  initialize(context) {
    this.client = getClient(context);
    this.invoke = context.invoke;
    this.config = context.config || {};
    this.hostFeatures = context.hostFeatures;
    this.t = context.i18n?.t?.bind(context.i18n) || ((key) => key);
    this.keyRevision = 0;
    this.scratchId = '__api_key';
  }

  onConfigUpdate(config) { this.config = config || {}; }

  async getSettings() {
    const t = this.t;
    let hasKey = false, unreadableKey = false;
    try { hasKey = !!(await this.client.key()); } catch { unreadableKey = true; }
    this.scratchId = hasKey ? `__replacement_key_${this.keyRevision}`
      : this.keyRevision ? `__api_key_${this.keyRevision}` : '__api_key';
    return {
      description: t('settings.description'),
      sections: [
        {
          label: t('settings.connection'),
          controls: [
            { type: 'info', html: `<p>${escapeHtml(t('setup.intro'))}</p><p>${escapeHtml(t('setup.terms'))}</p>` },
            { type: 'info', html: `<p>${escapeHtml(hasKey ? t('setup.saved') : t('setup.steps'))}</p>` },
            { type: 'action', id: 'free_key', action: 'free_key', label: t('setup.free_key') },
            // Scratch field never goes into config or back into the schema.
            // The host has no password control type; an empty text field is
            // the compatible input, as in Spotify's guided setup.
            { type: 'text', id: this.scratchId, default: '', label: t('setup.key'), description: t('setup.key_hint') },
            { type: 'action', id: 'test_key', action: 'test_key', label: t('setup.test'), variant: 'primary' },
            { type: 'action', id: 'remove_key', action: 'remove_key', label: t('setup.remove'), disabled: !hasKey && !unreadableKey },
          ],
        },
        {
          label: t('settings.watchlist_section'),
          controls: [
            { type: 'text', id: 'watchlist', label: t('settings.watchlist'), default: DEFAULTS.watchlist, description: t('settings.watchlist_hint', { max: MAX_SYMBOLS }) },
            { type: 'checkbox', id: 'show_watchlist', label: t('settings.show'), default: DEFAULTS.show_watchlist },
            {
              type: 'number', id: 'refresh_seconds', label: t('settings.refresh'),
              default: DEFAULTS.refresh_seconds, min: MIN_REFRESH_SECONDS, max: MAX_REFRESH_SECONDS,
              description: t('settings.refresh_hint', { min: MIN_REFRESH_SECONDS, default: DEFAULTS.refresh_seconds, budget: MAX_PER_MINUTE }),
            },
            { type: 'checkbox', id: 'agent_tools', label: t('settings.agent_tools'), default: DEFAULTS.agent_tools, description: t('settings.agent_tools_hint') },
            { type: 'action', id: 'delete_quotes', action: 'delete_quotes', label: t('settings.delete_quotes') },
            { type: 'info', html: `<p>${escapeHtml(t('result.help'))}</p><p>${escapeHtml(t('quote.sampled'))}</p>` },
          ],
        },
      ],
    };
  }

  validate(values = {}) {
    try {
      if (values.watchlist !== undefined) parseSymbols(values.watchlist, { allowEmpty: true });
      if (values.refresh_seconds !== undefined) {
        const n = Number(values.refresh_seconds);
        if (!Number.isFinite(n) || n < MIN_REFRESH_SECONDS || n > MAX_REFRESH_SECONDS) {
          return { valid: false, error: this.t('settings.refresh_error', { min: MIN_REFRESH_SECONDS, max: MAX_REFRESH_SECONDS }) };
        }
      }
      return { valid: true };
    } catch (error) { return { valid: false, error: errorText(error.code, this.t) }; }
  }

  normalize(values = {}) {
    const clean = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (Object.hasOwn(values, key)) clean[key] = values[key];
    }
    // Older hosts merge normalized values into saved config. Reset the
    // retired provider field to Finnhub; runtime no longer consults it.
    if (Object.hasOwn(values, 'provider')) clean.provider = 'finnhub';
    if (Object.hasOwn(clean, 'watchlist')) {
      clean.watchlist = parseSymbols(clean.watchlist, { allowEmpty: true }).join(' ');
    }
    if (Object.hasOwn(clean, 'refresh_seconds')) clean.refresh_seconds = refreshSeconds(clean);
    // Older hosts merge normalized fields into controls before saving. Return
    // explicit blanks so their generic Save cannot persist typed credentials.
    if (!this.hostFeatures) {
      for (const key of Object.keys(values)) if (key.startsWith('__')) clean[key] = '';
    }
    return { values: clean };
  }

  async runAction(action, values = {}) {
    try {
      if (action === 'free_key') {
        await this.invoke('open_url', { url: FREE_KEY_URL });
        return {};
      }
      if (action === 'remove_key') {
        await this.client.removeKey();
        this.keyRevision++;
        return { status: this.t('setup.removed'), host: { type: 'refresh' } };
      }
      if (action === 'delete_quotes') {
        const counts = await this.client.deleteQuotes(parseSymbols(this.config.watchlist ?? DEFAULTS.watchlist, { allowEmpty: true }));
        return { status: this.t('settings.quotes_deleted', counts), host: { type: 'refresh' } };
      }
      if (action === 'test_key') {
        const key = String(values[this.scratchId] || '').trim() || await this.client.key();
        if (!validKey(key)) return { status: this.t('error.invalid_key') };
        await this.client.testKey(key);
        await this.client.saveKey(key);
        this.keyRevision++;
        return { status: this.t('setup.success'), host: { type: 'refresh' } };
      }
      return {};
    } catch (error) { return { status: errorText(error.code, this.t) }; }
  }
}
