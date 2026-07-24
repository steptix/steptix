// Preloaded with `node --import` to report what CJS modules a run pulled in.
//
// playwright and its plugins are CommonJS, so they land in createRequire's
// cache; this project's own ESM does not. That makes the cache a clean
// yes/no answer to "did a browser stack get loaded?" without needing to
// instrument module resolution.
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);

process.on('exit', () => {
  const keys = Object.keys(req.cache);
  const browsery = keys.filter(
    (k) => k.includes('playwright') || k.includes('puppeteer'),
  );
  process.stderr.write(
    `\n__GRAPH_PROBE__ ${JSON.stringify({ cjs: keys.length, browsery: browsery.length })}\n`,
  );
});
