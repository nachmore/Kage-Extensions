/**
 * Hello World search provider — sample extension.
 * Responds to "test" or "hello" with a configurable greeting.
 *
 * # i18n
 * User-visible strings are looked up via `context.i18n.t(key, vars?)`. The
 * extension ships its catalog in `_locales/<lang>/messages.json`; the host
 * loads it at sandbox init time and the t() proxy renders against the
 * active language with EN fallback. See docs/I18N.md (in the main Kage
 * repo) for the full contract.
 */
export default class HelloWorldSearchProvider {
    initialize(context) {
        this.config = context.config || {};
        this.t = context.i18n?.t || ((k) => k);
    }

    onConfigUpdate(config) {
        this.config = config || {};
    }

    match(query) {
        const lower = query.trim().toLowerCase();
        if (lower !== 'test' && lower !== 'hello' && !lower.startsWith('test ')) {
            return [];
        }

        // The greeting falls back to the localised default if the user hasn't
        // overridden it. That way a Japanese user who hasn't touched settings
        // sees a Japanese greeting rather than "Hello World".
        const greeting = this.config.greeting || this.t('settings.greeting.default');
        const timestamp = this.config.show_timestamp
            ? ` (${new Date().toLocaleTimeString()})`
            : '';

        return [{
            id: 'hello-world',
            type: 'hello',
            label: greeting + timestamp,
            description: this.t('result.description'),
            icon: '👋',
            score: 90,
            data: { value: greeting + timestamp },
        }];
    }

    execute(result) {
        return { type: 'copy', value: result.data.value };
    }

    destroy() {}
}
