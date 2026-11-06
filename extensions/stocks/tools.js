import { getClient } from './client.js';
import { DEFAULTS } from './defaults.js';
import { MAX_SYMBOLS } from './symbols.js';
import { errorText } from './format.js';

export default class StocksToolProvider {
  initialize(context) {
    this.client = getClient(context);
    this.config = context.config || {};
    this.t = context.i18n?.t?.bind(context.i18n) || ((key) => key);
  }

  onConfigUpdate(config) { this.config = config || {}; }

  getTools() {
    if (!(this.config.agent_tools ?? DEFAULTS.agent_tools) || this.config.enabled === false) return [];
    return [
      {
        name: 'get_quote', description: this.t('tool.quote'),
        parameters: { symbols: { type: 'array', items: { type: 'string' }, description: this.t('tool.symbols', { max: MAX_SYMBOLS }) } },
      },
      {
        name: 'get_history', description: this.t('tool.history'),
        parameters: {
          symbol: { type: 'string', description: this.t('tool.symbol') },
          range: { type: 'string', enum: ['1d', '1w', '1m'], description: this.t('tool.range') },
        },
      },
    ];
  }

  async execute(name, params = {}) {
    if (this.config.enabled === false) return { error: this.t('tool.disabled') };
    if (!(this.config.agent_tools ?? DEFAULTS.agent_tools)) return { error: this.t('tool.opt_in') };
    try {
      if (name === 'get_quote') {
        const quotes = await this.client.getQuotes(params.symbols, this.config);
        const result = quotes.map(({ timestamp, fetchedAt, retryAt, samples, ...quote }) => ({
          ...quote,
          ...(quote.error ? { message: errorText(quote.error, this.t) } : { tradeTime: iso(timestamp * 1000), fetchedAt: iso(fetchedAt) }),
          ...(retryAt ? { retryAt: iso(retryAt) } : {}),
        }));
        const connection = quotes.findIndex((quote) => ['setup', 'auth', 'cache_only', 'storage'].includes(quote.error));
        if (connection >= 0 && quotes.every((quote) => quote.error)) {
          return { error: result[connection].message, result };
        }
        if (quotes.every((quote) => quote.error) && !(await this.client.key())) return { error: errorText('setup', this.t), result };
        return { result };
      }
      if (name === 'get_history') {
        const history = await this.client.getHistory(params.symbol, params.range);
        return { result: { ...history, fetchedAt: iso(history.fetchedAt),
          samples: history.samples.map((sample) => ({ ...sample, timestamp: iso(sample.timestamp * 1000) })) } };
      }
      return { error: this.t('tool.unknown') };
    } catch (error) { return { error: errorText(error.code, this.t) }; }
  }
}

function iso(milliseconds) {
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}
