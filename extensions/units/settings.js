export default class UnitsSettingsProvider {
    initialize(context) { this.config = context.config || {}; }
    onConfigUpdate(config) { this.config = config || {}; }

    getSettings() {
        return {
            description:
                'Inline unit conversion. Try: <code>5 miles to km</code>, <code>200 lb in kg</code>, ' +
                '<code>100F in C</code>, <code>500MB to GB</code>, <code>3 cups in ml</code>.',
            sections: [
                {
                    label: 'Categories',
                    controls: [
                        { type: 'checkbox', id: 'enabled', label: 'Enable', default: true },
                        {
                            type: 'info',
                            html:
                                '<p>Supported categories:</p>' +
                                '<ul>' +
                                '<li><strong>Length</strong>: mm, cm, m, km, in, ft, yd, mi, nmi</li>' +
                                '<li><strong>Weight</strong>: mg, g, kg, t, oz, lb, st</li>' +
                                '<li><strong>Temperature</strong>: C, F, K</li>' +
                                '<li><strong>Volume</strong>: ml, l, dl, cl, m3, tsp, tbsp, fl-oz, cup, pt, qt, gal</li>' +
                                '<li><strong>Time</strong>: ms, s, min, h, d, wk, yr</li>' +
                                '<li><strong>Data</strong>: b, kb, mb, gb, tb, kib, mib, gib, tib, bit, kbit, mbit, gbit</li>' +
                                '</ul>',
                        },
                    ],
                },
            ],
        };
    }
}
