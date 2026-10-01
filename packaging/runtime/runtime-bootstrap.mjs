import { registerHooks, createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server');
const manifest = JSON.parse(fs.readFileSync(path.join(server, 'package.json'), 'utf8'));
// Standalone test projects need not install the framework just to import its
// tool API. Preserve project dependency resolution, with a runtime fallback.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      const entry = manifest.exports?.[`./${specifier.slice('steptix/'.length)}`];
      if (!specifier.startsWith('steptix/') || !entry || !['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(error.code)) throw error;
      return { url: pathToFileURL(path.join(server, entry.import ?? entry.default)).href, shortCircuit: true };
    }
  },
});
const require = createRequire(path.join(server, 'package.json'));
const { register } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
register();
