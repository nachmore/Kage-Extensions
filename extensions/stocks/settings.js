import { DEFAULTS, MIN_REFRESH_SECONDS, MAX_REFRESH_SECONDS, MAX_PER_MINUTE, refreshSeconds } from './defaults.js';
import { FREE_KEY_URL, STOCKLAKE_KEY_URL, getClient, migrateProvider, validKey } from './client.js';
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
    let credentials = {};
    try {
      await this.client.connection(this.config);
      credentials = await this.client.read('credentials') || {};
    } catch { unreadableKey = true; }
    this.activeProvider = migrateProvider(this.config, credentials);
    hasKey = validKey(this.activeProvider === 'stocklake' ? credentials.stocklake_key : credentials.api_key);
    this.scratchId = hasKey ? `__replacement_key_${this.keyRevision}`
      : this.keyRevision ? `__api_key_${this.keyRevision}` : '__api_key';
    return {
      description: t('settings.description'),
      sections: [
        {
          label: t('settings.connection'),
          controls: [
            // Scratch selection reflects migration even on hosts overlaying
            // manifest defaults. Test/use persists the provider independently
            // of generic settings Save, just like the keys.
            { type: 'select', id: '__provider', default: this.activeProvider, label: t('settings.provider'),
              options: [{ value: 'stocklake', label: 'Stocklake' }, { value: 'finnhub', label: 'Finnhub' }] },
            { type: 'info', html: `<p>${escapeHtml(t('setup.stocklake'))}</p>`,
              showWhen: { id: '__provider', equals: 'stocklake' } },
            { type: 'info', html: `<p>${escapeHtml(t('setup.intro'))}</p>`, showWhen: { id: '__provider', equals: 'finnhub' } },
            { type: 'info', html: `<p>${escapeHtml(t('setup.terms'))}</p>` },
            { type: 'info', html: `<p>${escapeHtml(hasKey ? t('setup.saved') : t('setup.steps'))}</p>` },
            { type: 'action', id: 'free_key', action: 'free_key', label: t('setup.free_key'), showWhen: { id: '__provider', equals: 'finnhub' } },
            { type: 'action', id: 'stocklake_key', action: 'free_key', label: t('setup.stocklake_key'), showWhen: { id: '__provider', equals: 'stocklake' } },
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
            { type: 'info', html: `<p>${escapeHtml(t('result.help'))}</p><p>${escapeHtml(t('quote.history'))}</p>` },
          ],
        },
      ],
    };
  }

  validate(values = {}) {
    try {
      if (values.watchlist !== undefined) parseSymbols(values.watchlist, {
        allowEmpty: true, provider: values.__provider || this.activeProvider || 'stocklake',
      });
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
    values = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
    const clean = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (Object.hasOwn(values, key)) clean[key] = values[key];
    }
    // Canonicalize every retired provider/config shape without resurrecting
    // an old cache-only provider. The selection action owns modern changes.
    if (Object.hasOwn(values, 'provider')) clean.provider = this.activeProvider || migrateProvider(values);
    // Retired config credential fields must never survive another Save.
    for (const key of ['api_key', 'finnhub_key', 'stocklake_key']) if (Object.hasOwn(values, key)) clean[key] = '';
    if (Object.hasOwn(clean, 'watchlist')) {
      clean.watchlist = parseSymbols(clean.watchlist, { allowEmpty: true }).join(' ');
    }
    if (Object.hasOwn(clean, 'refresh_seconds')) clean.refresh_seconds = refreshSeconds(clean);
    // Older hosts merge normalized fields into controls before saving. Return
    // explicit blanks so their generic Save cannot persist typed credentials.
    if (!this.hostFeatures) {
      for (const key of Object.keys(values)) if (key.startsWith('__') && key !== '__provider') clean[key] = '';
    }
    if (Object.hasOwn(values, '__provider')) clean.__provider = ['stocklake', 'finnhub'].includes(values.__provider)
      ? values.__provider : this.activeProvider || 'stocklake';
    return { values: clean };
  }

  async runAction(action, values = {}) {
    try {
      const provider = ['stocklake', 'finnhub'].includes(values.__provider)
        ? values.__provider : this.activeProvider || (await this.client.connection(this.config)).provider;
      if (action === 'free_key') {
        await this.invoke('open_url', { url: provider === 'stocklake' ? STOCKLAKE_KEY_URL : FREE_KEY_URL });
        return {};
      }
      if (action === 'remove_key') {
        await this.client.removeKey(provider);
        this.keyRevision++;
        return { status: this.t('setup.removed'), host: { type: 'refresh' } };
      }
      if (action === 'delete_quotes') {
        const counts = await this.client.deleteQuotes(parseSymbols(this.config.watchlist ?? DEFAULTS.watchlist, { allowEmpty: true }));
        return { status: this.t('settings.quotes_deleted', counts), host: { type: 'refresh' } };
      }
      if (action === 'test_key') {
        const key = String(values[this.scratchId] || '').trim() || await this.client.providerKey(provider);
        if ((provider === 'finnhub' || key) && !validKey(key)) return { status: this.t('error.invalid_key') };
        await this.client.testKey(key, provider);
        if (key) await this.client.saveKey(key, provider);
        else await this.client.useProvider(provider);
        this.keyRevision++;
        return { status: this.t('setup.success'), host: { type: 'refresh' } };
      }
      return {};
    } catch (error) { return { status: errorText(error.code, this.t, { retryAt: error.retryAt }) }; }
  }
}
