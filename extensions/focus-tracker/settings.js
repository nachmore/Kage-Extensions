/**
 * Focus Tracker settings provider (sandboxed).
 */
export default class FocusTrackerSettingsProvider {
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
                            default: 'focus',
                            placeholder: 'focus',
                            maxWidth: 120,
                        },
                        {
                            type: 'number',
                            id: 'poll_interval',
                            label: t('settings.poll_interval.label'),
                            description: t('settings.poll_interval.description'),
                            default: 5,
                            min: 2,
                            max: 60,
                            maxWidth: 80,
                        },
                        {
                            type: 'checkbox',
                            id: 'auto_start',
                            label: t('settings.auto_start.label'),
                            description: t('settings.auto_start.description'),
                            default: true,
                        },
                    ],
                },
                {
                    label: t('settings.section.data_to_track'),
                    controls: [
                        { type: 'checkbox', id: 'track_screen_time', label: t('settings.track_screen_time.label'), description: t('settings.track_screen_time.description'), default: true },
                        { type: 'checkbox', id: 'track_switches',    label: t('settings.track_switches.label'),    description: t('settings.track_switches.description'),    default: true },
                        { type: 'checkbox', id: 'track_streaks',     label: t('settings.track_streaks.label'),     description: t('settings.track_streaks.description'),     default: true },
                    ],
                },
            ],
        };
    }

    validate(values) {
        const n = Number(values.poll_interval);
        if (!Number.isFinite(n) || n < 2 || n > 60) {
            return { valid: false, error: this.t('settings.validate.poll_interval_range') };
        }
        return { valid: true };
    }
}
