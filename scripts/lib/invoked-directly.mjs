import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function invokedDirectly(url) {
    if (!process.argv[1]) return false;
    try {
        return realpathSync(fileURLToPath(url)) === realpathSync(process.argv[1]);
    } catch { return false; }
}
