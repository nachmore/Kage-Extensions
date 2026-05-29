export default class EmojiSettingsProvider {
    initialize(context) { this.config = context.config || {}; }
    onConfigUpdate(config) { this.config = config || {}; }

    getSettings() {
        return {
            description:
                'Search ~250 of the most-used emojis by name. Two trigger styles work: ' +
                '<code>emoji fire</code> or just <code>:fire</code>. Pick one and Enter to copy it to your clipboard.',
            sections: [
                {
                    controls: [
                        { type: 'checkbox', id: 'enabled', label: 'Enable', default: true },
                        {
                            type: 'text', id: 'trigger', label: 'Trigger word',
                            default: 'emoji', maxWidth: 140,
                        },
                        {
                            type: 'checkbox', id: 'shortcode_trigger',
                            label: 'Also match shortcodes (e.g. ":fire")',
                            default: true,
                        },
                    ],
                },
            ],
        };
    }
}
