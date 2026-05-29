/**
 * Todos & Reminders settings provider (sandboxed).
 */
const STORAGE_KEY = 'kage-todos';

export default class TodosSettingsProvider {
    initialize(context) {
        this.config = context.config || {};
        this.invoke = context.invoke;
        this.t = context.i18n?.t?.bind(context.i18n) || ((k) => k);
    }

    onConfigUpdate(config) { this.config = config || {}; }

    getSettings() {
        const t = this.t;
        return {
            description: t('settings.description'),
            sections: [
                {
                    label: t('settings.section.display'),
                    controls: [
                        {
                            type: 'text',
                            id: 'default_category',
                            label: t('settings.default_category.label'),
                            description: t('settings.default_category.description'),
                            default: '',
                            placeholder: t('settings.default_category.placeholder'),
                            maxWidth: 200,
                        },
                        {
                            type: 'select',
                            id: 'sort_by',
                            label: t('settings.sort_by.label'),
                            description: t('settings.sort_by.description'),
                            default: 'created',
                            maxWidth: 200,
                            options: [
                                { value: 'created', label: t('settings.sort_by.option_created') },
                                { value: 'due', label: t('settings.sort_by.option_due') },
                                { value: 'priority', label: t('settings.sort_by.option_priority') },
                                { value: 'status', label: t('settings.sort_by.option_status') },
                            ],
                        },
                        {
                            type: 'checkbox',
                            id: 'show_completed',
                            label: t('settings.show_completed.label'),
                            description: t('settings.show_completed.description'),
                            default: true,
                        },
                    ],
                },
                {
                    label: t('settings.section.behavior'),
                    controls: [
                        {
                            type: 'checkbox',
                            id: 'confirm_delete',
                            label: t('settings.confirm_delete.label'),
                            description: t('settings.confirm_delete.description'),
                            default: true,
                        },
                        {
                            type: 'checkbox',
                            id: 'show_due_banner',
                            label: t('settings.show_due_banner.label'),
                            description: t('settings.show_due_banner.description'),
                            default: true,
                        },
                    ],
                },
                {
                    label: t('settings.section.data'),
                    controls: [
                        {
                            type: 'info',
                            html: t('settings.data.info'),
                        },
                        { type: 'action', id: 'export',   label: t('settings.export.label'), action: 'export' },
                        { type: 'action', id: 'import',   label: t('settings.import.label'), action: 'import' },
                        { type: 'action', id: 'clearAll', label: t('settings.clear_all.label'), action: 'clear_all', variant: 'danger',
                          confirm: t('settings.clear_all.confirm') },
                    ],
                },
            ],
        };
    }

    async runAction(action, _values) {
        const t = this.t;
        if (action === 'export') {
            try {
                const raw = await this.invoke('load_extension_data', { key: STORAGE_KEY });
                const data = raw || '[]';
                return {
                    host: {
                        type: 'download',
                        filename: 'kage-todos.json',
                        content: data,
                        mime: 'application/json',
                    },
                    status: t('action.export.success'),
                };
            } catch (e) {
                return { status: t('action.export.error', { message: e?.message || e }) };
            }
        }
        if (action === 'import') {
            return { host: { type: 'pick_file', accept: '.json', action: 'import' } };
        }
        if (action === 'clear_all') {
            try {
                await this.invoke('delete_extension_data', { key: STORAGE_KEY });
                return { status: t('action.clear_all.success') };
            } catch (e) {
                return { status: t('action.clear_all.error', { message: e?.message || e }) };
            }
        }
        return {};
    }

    async onFileSelected(params) {
        const t = this.t;
        if (params.action !== 'import') return {};
        try {
            const data = JSON.parse(params.content);
            if (!Array.isArray(data)) throw new Error(t('action.import.invalid_format'));
            await this.invoke('save_extension_data', {
                key: STORAGE_KEY,
                data: JSON.stringify(data),
            });
            return { status: t('action.import.success', { count: data.length }) };
        } catch (e) {
            return { status: t('action.import.error', { message: e?.message || e }) };
        }
    }
}
