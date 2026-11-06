// Tests contain executable attack fixtures and are development-only modules.
// Share this boundary between packaging and the security module inventory.
export function isTestModule(file) {
    return /\.(?:test|spec)\.[cm]?js$/.test(file);
}

export const PACKAGE_POLICY = 'exclude-test-modules-v1';
