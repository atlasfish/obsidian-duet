// Loads the shipped CommonJS module without __filename, as Obsidian's plugin loader does.
// Host API stand-ins allow module evaluation without opening Obsidian or calling plugin.onload.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const realRequire = createRequire(import.meta.url);
const sdkAddresses = [];
function HostBase() {}
const obsidian = new Proxy({}, {
  get(target, key) { return target[key] ??= HostBase; },
});
const hostModule = {
  ...realRequire('node:module'),
  createRequire(address) {
    const filename = address instanceof URL ? fileURLToPath(address) : String(address).startsWith('file:') ? fileURLToPath(address) : address;
    assert.ok(path.isAbsolute(filename) && path.basename(filename), 'SDK createRequire needs an absolute file address');
    sdkAddresses.push(String(address));
    return createRequire(address);
  },
};
const module = { exports: {} };
const context = {
  module, exports: module.exports, console, process, Buffer,
  crypto: globalThis.crypto,
  URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, AbortSignal,
  DOMException,
  setTimeout, clearTimeout, setInterval, clearInterval, performance, structuredClone,
  require(name) {
    if (name === 'obsidian') return obsidian;
    if (name === 'electron') return {};
    if (name === 'module' || name === 'node:module') return hostModule;
    return realRequire(name);
  },
};
const bundlePath = process.argv[2] ? path.resolve(process.argv[2]) : new URL('../plugin/dist/main.js', import.meta.url);
const bundle = await readFile(bundlePath, 'utf8');
try {
  new Script(bundle, { filename: 'duet-main.js' }).runInNewContext(context);
  assert.equal(typeof module.exports.default, 'function', 'Bundle exports the plugin class');
  assert.ok(sdkAddresses.length > 0, 'Bundle evaluates the SDK module loader');
  console.log(`Plugin module load passed (${sdkAddresses.length} SDK module addresses, no __filename).`);
} catch (error) {
  console.error(`${error.name}: ${error.message}`);
  console.error(error.stack.split('\n').filter((line) => line.trim().startsWith('at ')).slice(0, 8).join('\n'));
  process.exitCode = 1;
}
