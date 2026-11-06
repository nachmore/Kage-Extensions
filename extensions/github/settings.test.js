import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeContext } from '../../test-helpers/mock-context.mjs';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

function store() {
    let data = null;
    const invokes = {
        load_extension_data: () => data,
        save_extension_data: ({ key, data: value }) => {
            expect(key).toBe('token');
            data = value;
        },
    };
    return { invokes, read: () => JSON.parse(data || '{}') };
}

describe('GitHub settings token actions', () => {
    it('saves and forgets a token without ever initializing search', async () => {
        vi.resetModules();
        const { default: Settings } = await import('./settings.js');
        const backing = store();
        const { context, invoke } = makeContext({ invokes: backing.invokes });
        const settings = new Settings();
        settings.initialize(context);
        await expect(settings.runAction('save_token', { __token_input: '  ghp_test_personal_access_token  ' }))
            .resolves.toMatchObject({ status: 'action.save_token.success' });
        expect(backing.read().token).toBe('ghp_test_personal_access_token');
        await expect(settings.runAction('clear_token', {}))
            .resolves.toMatchObject({ status: 'action.clear_token.success' });
        expect(backing.read().token).toBe('');
        expect(invoke.mock.calls.filter(([command]) => command === 'save_extension_data')).toHaveLength(2);
    });

    it('search reads token saves and clears from a separate module instance', async () => {
        vi.resetModules();
        const { default: Search } = await import('./search.js');
        const backing = store();
        const search = new Search();
        search.initialize(makeContext({ invokes: backing.invokes }).context);
        vi.resetModules();
        const { default: Settings } = await import('./settings.js');
        const settings = new Settings();
        settings.initialize(makeContext({ invokes: backing.invokes }).context);
        const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) }));
        vi.stubGlobal('fetch', fetch);
        await search.matchAsync('gh private');
        expect(fetch.mock.calls.at(-1)[1].headers.Authorization).toBeUndefined();
        await settings.runAction('save_token', { __token_input: 'github_pat_private_token' });
        await search.matchAsync('gh private');
        expect(fetch.mock.calls.at(-1)[1].headers.Authorization).toBe('Bearer github_pat_private_token');
        await settings.runAction('clear_token', {});
        await search.matchAsync('gh private');
        expect(fetch.mock.calls.at(-1)[1].headers.Authorization).toBeUndefined();
    });

    it.each([undefined, []])('keeps scratch secrets out of Save with hostFeatures %j', async (hostFeatures) => {
        const { default: Settings } = await import('./settings.js');
        const settings = new Settings();
        settings.initialize(makeContext({ hostFeatures }).context);
        const values = { trigger: ' GH ', personal_token: 'legacy', __token_input: 'scratch', __future_secret: 'secret' };
        const normalized = settings.normalize(values).values;
        expect(normalized).toEqual({ trigger: 'gh', personal_token: 'legacy',
            ...(!hostFeatures ? { __token_input: '', __future_secret: '' } : {}) });
        // Older hosts patch the controls, then serialize them on generic Save.
        const persisted = hostFeatures ? normalized : { ...values, ...normalized };
        expect(JSON.stringify(persisted)).not.toContain('scratch');
        expect(JSON.stringify(persisted)).not.toContain('\"secret\"');
    });
});
