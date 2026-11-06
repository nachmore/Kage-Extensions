// Backup metadata shared by the schema and security checks. Mirrors
// Kage src/extensions.rs::validate_data_key, reached by the extension-data
// commands. A glob validates its nonempty prefix using the same rules.
export const SENSITIVE_NAME = /(token|secret|credential|creds|password|passwd|api[-_]?key|auth|oauth|session|cookie)/i;

export function validSensitivePattern(value) {
    if (typeof value !== 'string') return false;
    const key = value.endsWith('*') ? value.slice(0, -1) : value;
    return /^[A-Za-z0-9_.-]{1,128}$/.test(key) && !key.includes('..');
}

export function declaresSensitiveKey(manifest, key) {
    return (Array.isArray(manifest.sensitiveData) ? manifest.sensitiveData : []).some((pattern) =>
        validSensitivePattern(pattern) &&
        (pattern.endsWith('*')
            ? key.startsWith(pattern.slice(0, -1))
            : key === pattern)
    );
}

export function sensitiveMetadataIssues(manifest) {
    const issues = [];
    if (manifest.sensitiveData !== undefined) {
        if (!Array.isArray(manifest.sensitiveData)) {
            issues.push("'sensitiveData' must be an array of storage-key strings");
        } else {
            if (manifest.sensitiveData.length > 32) {
                issues.push("'sensitiveData' must contain at most 32 entries");
            }
            for (const value of manifest.sensitiveData) {
                if (!validSensitivePattern(value)) {
                    issues.push(
                        "'sensitiveData' entries must be exact keys or nonempty prefixes ending in '*': " +
                        "1–128 ASCII letters, digits, '-', '_', '.', without '..'"
                    );
                }
            }
        }
    }
    if (manifest.config !== undefined) {
        if (!manifest.config || typeof manifest.config !== 'object' || Array.isArray(manifest.config)) {
            issues.push("'config' must be an object of config field definitions");
        } else {
            for (const [field, definition] of Object.entries(manifest.config)) {
                if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
                    issues.push(`config.${field} must be an object`);
                } else if (definition.sensitive !== undefined && typeof definition.sensitive !== 'boolean') {
                    issues.push(`config.${field}.sensitive must be a boolean`);
                }
            }
        }
    }
    return issues;
}
