/**
 * In-memory stand-in for the host side of an extension's `invoke()`, for the
 * Mind Map tests (lib/store.js, mind.js, the acceptance suite).
 *
 * It implements the three extension-data commands the way Kage does
 * (src/commands/extensions/files.rs + src/extensions.rs::validate_data_key):
 *   - load_extension_data({key})        → the stored string, or null when missing
 *   - save_extension_data({key, data})  → stores the string
 *   - delete_extension_data({key})      → removes it; a missing key is not an error
 * Keys must match ^[A-Za-z0-9._-]{1,128}$ and must not contain '..'.
 *
 * Like the sandbox host (ui/js/shared/extension-sandbox-host.js), it rejects
 * more than 100 invokes in any rolling second with the host's exact error
 * text ("... invoke rate limit exceeded (max 100/s)"). Rejected calls don't
 * count against the window. The window uses performance.now(), so tests that
 * pin Date with vi.useFakeTimers({ toFake: ['Date'] }) still see it slide.
 *
 * Options:
 *   atomic   - true models a host whose save is atomic (temp + rename): a
 *              simulated crash leaves the previous value. false models a
 *              plain fs::write: a crash mid-write leaves a torn (truncated)
 *              value.
 *   latency  - (command, args) => ms, awaited before the command runs. Use a
 *              random function to interleave two clients.
 *   handlers - { [command]: (args) => value | Promise } for other commands
 *              (fetch_link_metadata, get_source_window, …). Unlisted
 *              commands reject.
 *
 * Returns { invoke, files, calls, corrupt(key), crashAfterWrites(n), revive(), connect() }:
 *   invoke              - the first window's invoke(command, args)
 *   files               - Map<key, string>, the "disk"; tests may read or seed it
 *   calls               - [{ command, args, window }] in call order (rate-limited
 *                         ones included); window is 0 for `invoke`, 1.. for connect()
 *   corrupt(key, how)   - replace a stored value with a torn copy ('torn', the
 *                         default), an empty file ('empty') or valid JSON that
 *                         isn't an object ('null')
 *   crashAfterWrites(n) - let n more saves succeed; the next save tears its
 *                         target (unless atomic) and rejects, and every later
 *                         invoke rejects until revive()
 *   revive()            - the host "restarts": invokes work again
 *   connect()           - another Kage window on the same disk: returns
 *                         { invoke } with its own 100/s rate window, the way
 *                         every window runs its own sandbox
 */

const KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;
const RATE_MAX = 100;
const RATE_WINDOW_MS = 1000;
const EXTENSION_ID = 'mindmap';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function validateKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key) || key.includes('..')) {
    throw new Error(`Invalid data key: ${JSON.stringify(key)}`);
  }
}

function torn(value) {
  // Cut inside the value so it never parses (JSON objects need their '}').
  const cut = Math.max(1, Math.floor(value.length / 2));
  return value.slice(0, Math.min(cut, value.length - 1));
}

export function createMemoryHost({ atomic = false, latency = () => 0, handlers = {} } = {}) {
  const files = new Map();
  const calls = [];
  let writesLeft = Infinity;
  let crashed = false;
  let windows = 0;

  function rateLimiter() {
    const times = [];
    return () => {
      const now = performance.now();
      while (times.length && times[0] <= now - RATE_WINDOW_MS) times.shift();
      if (times.length >= RATE_MAX) return true;
      times.push(now);
      return false;
    };
  }

  function makeInvoke(index) {
    const overRateLimit = rateLimiter();
    return async (command, args = {}) => {
      calls.push({ command, args, window: index });
      if (overRateLimit()) {
        throw new Error(`Extension '${EXTENSION_ID}': invoke rate limit exceeded (max ${RATE_MAX}/s)`);
      }
      return run(command, args);
    };
  }

  async function run(command, args) {
    const delay = Number(latency(command, args)) || 0;
    if (delay > 0) await sleep(delay);
    if (crashed) throw new Error('simulated host crash');
    switch (command) {
      case 'load_extension_data': {
        validateKey(args?.key);
        return files.has(args.key) ? files.get(args.key) : null;
      }
      case 'save_extension_data': {
        validateKey(args?.key);
        if (typeof args.data !== 'string') throw new Error('invalid args: data must be a string');
        if (writesLeft <= 0) {
          crashed = true;
          if (!atomic) files.set(args.key, torn(args.data));
          throw new Error('simulated host crash');
        }
        writesLeft -= 1;
        files.set(args.key, args.data);
        return null;
      }
      case 'delete_extension_data': {
        validateKey(args?.key);
        files.delete(args.key);
        return null;
      }
      default: {
        const handler = handlers[command];
        if (typeof handler !== 'function') throw new Error(`memory host: no handler for '${command}'`);
        return handler(args);
      }
    }
  }

  return {
    invoke: makeInvoke(windows++),
    files,
    calls,
    corrupt(key, how = 'torn') {
      const value = files.get(key) ?? '{"rev":1}';
      files.set(key, how === 'empty' ? '' : how === 'null' ? 'null' : torn(value));
    },
    crashAfterWrites(n) {
      writesLeft = Number.isFinite(n) ? Math.max(0, n) : Infinity;
      crashed = false;
    },
    revive() {
      crashed = false;
      writesLeft = Infinity;
    },
    connect() {
      return { invoke: makeInvoke(windows++) };
    },
  };
}
