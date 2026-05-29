export default class JsonToolsSettingsProvider {
    initialize(context) { this.config = context.config || {}; }
    onConfigUpdate(config) { this.config = config || {}; }

    getSettings() {
        return {
            description:
                'Reads JSON from your clipboard, transforms it, and writes the result back. ' +
                'Three commands: <code>json fmt</code> (pretty), <code>json min</code> (compact), ' +
                '<code>json check</code> (validate-and-pass-through).',
            sections: [
                {
                    controls: [
                        { type: 'checkbox', id: 'enabled', label: 'Enable', default: true },
                        { type: 'text', id: 'trigger', label: 'Trigger', default: 'json', maxWidth: 100 },
                        {
                            type: 'number', id: 'indent_spaces', label: 'Indent (spaces)',
                            default: 2, min: 0, max: 8,
                        },
                    ],
                },
            ],
        };
    }
}
