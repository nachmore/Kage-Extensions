import { defineConfig } from 'vitest/config';

// Functional tests for the extensions themselves. Each extension's provider
// is exercised through a mocked host `context` (see test-helpers/mock-context.mjs)
// so authors can verify behaviour without standing up the full Kage sandbox.
//
// Tests live next to the source they cover: extensions/<id>/*.test.js.
// Run everything:        npm test
// Run one extension:     npx vitest run extensions/math
export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        include: ['extensions/**/*.test.js'],
    },
});
