import { getClient } from './client.js';
import { errorText } from './format.js';

export default class StocksToolProvider {
  initialize(context) {
    this.client = getClient(context);
    this.config = context.config || {};
    this.t = context.i18n?.t?.bind(context.i18n) || ((key) => key);
  }

  onConfigUpdate(config) { this.config = config || {}; }

  getTools() {
    return [
      {
        name: 'get_quote', description: this.t('tool.quote'),
        parameters: { symbols: { type: 'array', items: { type: 'string' }, description: this.t('tool.symbols') } },
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
    try {
      if (name === 'get_quote') return { result: await this.client.getQuotes(params.symbols, this.config) };
      if (name === 'get_history') {
        return { result: await this.client.getHistory(params.symbol, params.range) };
      }
      return { error: this.t('tool.unknown') };
    } catch (error) { return { error: errorText(error.code, this.t) }; }
  }
}
