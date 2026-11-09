// Mind Map's message formatter: `[mm:ID]` citation chips and
// `[mm-card:…]` cards (SPEC §10). Entry module — a thin wrapper around
// view.formatHtml, which does the parsing, rendering and staleness checks.
//
// Card and chip clicks arrive at the search provider's onResultAction
// (search.js), which updates the shared per-window UI state and asks the
// host to re-run this formatter.

import { getMind } from './mind.js';
import { formatHtml } from './view.js';
import { LIMITS, triggerOf } from './defaults.js';

const QUICK = /\[mm:|\[mm-card:|class="mm-/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default class MindMapFormatter {
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

  get canReformat() {
    return typeof this.context.formatter?.requestReformat === 'function';
  }

  // The map explorer opens from card buttons only where the host offers
  // views and the user approved them (EXTENSION_VIEWS §9.4, §24.8).
  get canExplore() {
    const features = this.context.hostFeatures;
    return Array.isArray(features) && features.includes('views');
  }

  async format(html, ctx = {}) {
    if (ctx?.streaming) return null;
    if (typeof html !== 'string' || !QUICK.test(html)) return null;
    if (this.config.enabled === false) return null;
    const mind = this.mind;
    const canReformat = this.canReformat;
    try {
      if (!mind.loaded && !canReformat) {
        // Older hosts can't be asked to re-run us: wait (briefly) instead.
        await Promise.race([mind.ready().catch(() => {}), sleep(LIMITS.formatterWaitMs)]);
      } else if (mind.loaded) {
        await mind.syncIfStale();
      }
    } catch (error) {
      this.log?.warn?.(`mindmap: formatter sync failed (${error?.code || error?.name || 'error'})`);
    }
    const i18n = this.context.i18n;
    let locale = 'en';
    let rtl = false;
    try {
      locale = i18n?.language?.() || 'en';
      rtl = !!i18n?.isRtl?.();
    } catch {
      // Defaults are fine.
    }
    return formatHtml(html, mind.port, {
      t: this.t,
      locale,
      rtl,
      now: mind.now(),
      trigger: triggerOf(this.config),
      canReformat,
      canExplore: this.canExplore,
      requestReformat: () => mind.requestReformat(),
      log: this.log,
    });
  }

  destroy() {}
}
