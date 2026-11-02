// Minimal globals some bundled SDK dependencies expect from Node. Injected by
// esbuild only where referenced. No network, timers or storage are touched.
import { Buffer } from 'buffer';

const env = {};
export const process = {
  env,
  browser: true,
  version: '',
  versions: {},
  argv: [],
  platform: 'browser',
  cwd: () => '/',
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
};

export { Buffer };
