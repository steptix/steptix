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
  // Anchored to a node_modules path segment: a bare substring match counts
  // every module in a checkout whose own path contains "playwright" (e.g. a
  // worktree named playwright-typescript-tests-*) as browsery.
  const browsery = keys.filter((k) =>
    /[\\/]node_modules[\\/](playwright|puppeteer)/.test(k),
  );
  process.stderr.write(
    `\n__GRAPH_PROBE__ ${JSON.stringify({ cjs: keys.length, browsery: browsery.length })}\n`,
  );
});
