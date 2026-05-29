/**
 * Timer settings provider (sandboxed).
 */
export default class TimerSettingsProvider {
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
                    label: t('settings.section.on_complete'),
                    controls: [
                        {
                            type: 'checkbox',
                            id: 'notify_on_complete',
                            label: t('settings.notify_on_complete.label'),
                            description: t('settings.notify_on_complete.description'),
                            default: true,
                        },
                        {
                            type: 'checkbox',
                            id: 'sound_on_complete',
                            label: t('settings.sound_on_complete.label'),
                            description: t('settings.sound_on_complete.description'),
                            default: true,
                        },
                        {
                            type: 'select',
                            id: 'sound_id',
                            label: t('settings.sound_id.label'),
                            description: t('settings.sound_id.description'),
                            default: 'two-tone',
                            maxWidth: 200,
                            showWhen: { id: 'sound_on_complete', equals: true },
                            options: [
                                { value: 'two-tone', label: t('settings.sound_id.option_two_tone') },
                                { value: 'chime',    label: t('settings.sound_id.option_chime') },
                                { value: 'alert',    label: t('settings.sound_id.option_alert') },
                                { value: 'gentle',   label: t('settings.sound_id.option_gentle') },
                                { value: 'bell',     label: t('settings.sound_id.option_bell') },
                                { value: 'success',  label: t('settings.sound_id.option_success') },
                                { value: 'custom',   label: t('settings.sound_id.option_custom') },
                            ],
                        },
                        {
                            type: 'text',
                            id: 'custom_sound_path',
                            label: t('settings.custom_sound_path.label'),
                            description: t('settings.custom_sound_path.description'),
                            default: '',
                            placeholder: 'C:\\path\\to\\sound.wav',
                            maxWidth: 350,
                            showWhen: { id: 'sound_id', equals: 'custom' },
                        },
                        {
                            type: 'range',
                            id: 'sound_repeats',
                            label: t('settings.sound_repeats.label'),
                            default: 3,
                            min: 1,
                            max: 10,
                            step: 1,
                            unit: '×',
                            showWhen: { id: 'sound_on_complete', equals: true },
                        },
                        {
                            type: 'action',
                            id: 'preview',
                            label: t('settings.preview.label'),
                            action: 'preview_sound',
                            showWhen: { id: 'sound_on_complete', equals: true },
                        },
                        {
                            type: 'checkbox',
                            id: 'show_window_on_complete',
                            label: t('settings.show_window_on_complete.label'),
                            description: t('settings.show_window_on_complete.description'),
                            default: true,
                        },
                    ],
                },
            ],
        };
    }

    async runAction(action, values) {
        if (action === 'preview_sound') {
            // Defer the actual playback to the host — the sandbox has no
            // access to our shared timer-sounds module.
            return {
                host: {
                    type: 'play_timer_sound',
                    soundId: values.sound_id || 'two-tone',
                    customPath: values.custom_sound_path || '',
                    repeats: values.sound_repeats || 3,
                },
            };
        }
        return {};
    }

    normalize(values) {
        // Custom path should normalize to null when empty so the stored
        // shape matches what the sound player expects.
        const custom = String(values.custom_sound_path || '').trim();
        return {
            values: {
                ...values,
                custom_sound_path: custom || null,
            },
        };
    }
}
