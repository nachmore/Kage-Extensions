/**
 * Dictionary settings provider (sandboxed).
 */

const LANGUAGES = [
    { code: 'auto', name: null }, // localized below
    { code: 'en', name: 'English' },
    { code: 'la', name: 'Latin' },
    { code: 'es', name: 'Spanish' },
    { code: 'it', name: 'Italian' },
    { code: 'ru', name: 'Russian' },
    { code: 'pt', name: 'Portuguese' },
    { code: 'fr', name: 'French' },
    { code: 'de', name: 'German' },
    { code: 'sv', name: 'Swedish' },
    { code: 'fi', name: 'Finnish' },
    { code: 'zh', name: 'Chinese' },
    { code: 'pl', name: 'Polish' },
    { code: 'nl', name: 'Dutch' },
    { code: 'ro', name: 'Romanian' },
    { code: 'ja', name: 'Japanese' },
    { code: 'el', name: 'Greek' },
    { code: 'hu', name: 'Hungarian' },
    { code: 'cs', name: 'Czech' },
    { code: 'uk', name: 'Ukrainian' },
    { code: 'da', name: 'Danish' },
    { code: 'bg', name: 'Bulgarian' },
    { code: 'ko', name: 'Korean' },
    { code: 'tr', name: 'Turkish' },
    { code: 'vi', name: 'Vietnamese' },
    { code: 'hi', name: 'Hindi' },
    { code: 'ar', name: 'Arabic' },
    { code: 'th', name: 'Thai' },
    { code: 'fa', name: 'Persian' },
    { code: 'he', name: 'Hebrew' },
    { code: 'id', name: 'Indonesian' },
];

export default class DictionarySettingsProvider {
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
                        {
                            type: 'text',
                            id: 'trigger',
                            label: t('settings.trigger.label'),
                            description: t('settings.trigger.description'),
                            default: 'dict',
                            placeholder: 'dict',
                            maxWidth: 100,
                        },
                        {
                            type: 'select',
                            id: 'language',
                            label: t('settings.language.label'),
                            description: t('settings.language.description'),
                            default: 'auto',
                            options: LANGUAGES.map(l => ({
                                value: l.code,
                                label: l.code === 'auto' ? t('settings.language.auto') : l.name,
                            })),
                        },
                        { type: 'checkbox', id: 'show_pronunciation', label: t('settings.show_pronunciation.label'), description: t('settings.show_pronunciation.description'), default: true },
                        { type: 'checkbox', id: 'show_examples',      label: t('settings.show_examples.label'),      description: t('settings.show_examples.description'),      default: true },
                        { type: 'checkbox', id: 'show_synonyms',      label: t('settings.show_synonyms.label'),      description: t('settings.show_synonyms.description'),      default: true },
                        {
                            type: 'info',
                            html: t('settings.attribution.html'),
                        },
                    ],
                },
            ],
        };
    }
}
