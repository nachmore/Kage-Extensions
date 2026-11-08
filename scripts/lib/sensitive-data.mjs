// Backup metadata shared by the schema and security checks. Mirrors
// Kage src/extensions.rs::validate_data_key, reached by the extension-data
// commands. A glob validates its nonempty prefix using the same rules.
export const SENSITIVE_NAME = /(token|secret|credential|creds|password|passwd|api[-_]?key|auth|oauth|session|cookie)/i;

// Kage 3aedcc9 src/extensions.rs::SENSITIVE_NAME_PATTERN. Plain backups
// must refuse every credential-named field, even flags, numbers and enums.
export const BACKUP_SENSITIVE_NAME = /(token|secret|credential|creds|password|passwd|passphrase|passcode|api[-_\s]?key|license[-_]?key|account[-_]?key|private[-_]?key|access[-_]?key|auth|oauth|session|cookie|totp|otp[-_]?(secret|seed)|mnemonic|(^|[-_.])(pin|pass|pwd)$)/i;

export function validSensitivePattern(value) {
    if (typeof value !== 'string') return false;
    const key = value.endsWith('*') ? value.slice(0, -1) : value;
    return /^[A-Za-z0-9_.-]{1,128}$/.test(key) && !key.includes('..') && !/\.json$/i.test(key);
}

export function declaresSensitiveKey(manifest, key, { ignoreCase = false } = {}) {
    const normalize = (value) => ignoreCase ? value.replace(/[A-Z]/g, (c) => c.toLowerCase()) : value;
    const candidate = normalize(key);
    return (Array.isArray(manifest.sensitiveData) ? manifest.sensitiveData : []).some((pattern) =>
        validSensitivePattern(pattern) &&
        (pattern.endsWith('*')
            ? candidate.startsWith(normalize(pattern.slice(0, -1)))
            : candidate === normalize(pattern))
    );
}

export function sensitiveMetadataIssues(manifest, { locations = false } = {}) {
    const issues = [];
    const note = (message, path) => issues.push(locations ? { message, path } : message);
    if (manifest.sensitiveData !== undefined) {
        if (!Array.isArray(manifest.sensitiveData)) {
            note("'sensitiveData' must be an array of storage-key strings", ['sensitiveData']);
        } else {
            if (manifest.sensitiveData.length > 32) {
                note("'sensitiveData' must contain at most 32 entries", ['sensitiveData']);
            }
            for (const [i, value] of manifest.sensitiveData.entries()) {
                if (!validSensitivePattern(value)) {
                    note(
                        `'sensitiveData' entry ${JSON.stringify(value)} (index ${i}) is invalid; entries must be exact keys or nonempty prefixes ending in '*': ` +
                        "1–128 ASCII letters, digits, '-', '_', '.', without '..' or a '.json' suffix",
                        ['sensitiveData', i]);
                    continue;
                }
                for (const previous of manifest.sensitiveData.slice(0, i)) {
                    if (!validSensitivePattern(previous)) continue;
                    if (previous === value) {
                        note(`duplicate sensitiveData entry '${value}'`, ['sensitiveData', i]);
                    } else if ((previous.endsWith('*') && value.startsWith(previous.slice(0, -1))) ||
                        (value.endsWith('*') && previous.startsWith(value.slice(0, -1)))) {
                        note(`overlapping sensitiveData entries '${previous}' and '${value}'`, ['sensitiveData', i]);
                    }
                }
            }
        }
    }
    if (manifest.config !== undefined) {
        if (!manifest.config || typeof manifest.config !== 'object' || Array.isArray(manifest.config)) {
            note("'config' must be an object of config field definitions", ['config']);
        } else {
            for (const [field, definition] of Object.entries(manifest.config)) {
                if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
                    note(`config.${field} must be an object`, ['config', field]);
                } else if (definition.sensitive !== undefined && typeof definition.sensitive !== 'boolean') {
                    note(`config.${field}.sensitive must be a boolean`, ['config', field, 'sensitive']);
                }
            }
        }
    }
    function misplaced(object, parts = []) {
        if (!object || typeof object !== 'object') return;
        for (const [key, value] of Object.entries(object)) {
            const at = [...parts, key];
            const normalized = key.toLowerCase().replace(/[-_]/g, '');
            const typo = /^(?:sensitve|sensative|sensitvie|sensitivedata|sensitive)$/.test(normalized);
            const allowed = (key === 'sensitiveData' && parts.length === 0) ||
                (key === 'sensitive' && parts.length === 2 && parts[0] === 'config') ||
                (parts.length === 1 && parts[0] === 'config' && value && typeof value === 'object' && !Array.isArray(value));
            // Top-level unknown fields already have a precise validator error.
            if (typo && !allowed && parts.length > 0) {
                note(`misplaced or misspelled '${at.join('.')}' sensitive metadata; use top-level sensitiveData or config.<field>.sensitive`, at);
            }
            misplaced(value, at);
        }
    }
    misplaced(manifest);
    return issues;
}
