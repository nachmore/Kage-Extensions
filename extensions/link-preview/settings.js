/**
 * Link Preview settings provider (sandboxed).
 *
 * Schema-only; the actual rendering happens in the host's
 * settings-renderer. Cache-management buttons round-trip through
 * `runSettingsAction` and return a `link_metadata` host effect — the
 * renderer recognises it and runs the corresponding Tauri command.
 * The extension itself doesn't need any new capability.
 */
export default class LinkPreviewSettingsProvider {
    initialize(context) {
        this.config = context.config || {};
        this.t = context.i18n?.t?.bind(context.i18n) || ((k) => k);
    }
    onConfigUpdate(config) {
        this.config = config || {};
    }

    getSettings() {
        const t = this.t;
        return {
            description: t('settings.description'),
            sections: [
                {
                    controls: [
                        {
                            type: 'checkbox',
                            id: 'enabled',
                            label: t('settings.enabled.label'),
                            description: t('settings.enabled.description'),
                            default: true,
                        },
                        {
                            type: 'checkbox',
                            id: 'show_images',
                            label: t('settings.show_images.label'),
                            description: t('settings.show_images.description'),
                            default: true,
                        },
                        {
                            type: 'number',
                            id: 'max_previews',
                            label: t('settings.max_previews.label'),
                            description: t('settings.max_previews.description'),
                            default: 5,
                            min: 1,
                            max: 20,
                            maxWidth: 80,
                        },
                    ],
                },
                {
                    title: t('settings.section.cache'),
                    controls: [
                        {
                            type: 'info',
                            html: t('settings.cache.info_html'),
                        },
                        {
                            type: 'action',
                            id: 'cacheStats',
                            label: t('settings.cache_stats.label'),
                            action: 'cache_stats',
                            description: t('settings.cache_stats.description'),
                        },
                        {
                            type: 'action',
                            id: 'cacheClear',
                            label: t('settings.cache_clear.label'),
                            action: 'cache_clear',
                            variant: 'danger',
                            confirm: t('settings.cache_clear.confirm'),
                            description: t('settings.cache_clear.description'),
                        },
                    ],
                },
            ],
        };
    }

    /**
     * Action dispatcher. Renderer calls this when the user clicks one
     * of the action buttons; the return value's `host` field tells the
     * renderer to run a host-side effect we can't run from inside the
     * sandbox.
     */
    runSettingsAction({ action }) {
        if (action === 'cache_clear') {
            return { host: { type: 'link_metadata', op: 'clear' } };
        }
        if (action === 'cache_stats') {
            return { host: { type: 'link_metadata', op: 'stats' } };
        }
        return { error: `Unknown action: ${action}` };
    }
}
