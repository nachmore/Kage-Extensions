export default class EmojiSettingsProvider {
    initialize(context) {
        this.config = context.config || {};
        this.t = context.i18n?.t?.bind(context.i18n) || ((k) => k);
    }
    onConfigUpdate(config) { this.config = config || {}; }

    getSettings() {
        const t = this.t;
        return {
            description: t('settings.description'),
            sections: [
                {
                    controls: [
                        { type: 'checkbox', id: 'enabled', label: t('settings.enabled.label'), default: true },
                        {
                            type: 'text', id: 'trigger', label: t('settings.trigger.label'),
                            default: 'emoji', maxWidth: 140,
                        },
                        {
                            type: 'checkbox', id: 'shortcode_trigger',
                            label: t('settings.shortcode_trigger.label'),
                            default: true,
                        },
                    ],
                },
            ],
        };
    }
}
