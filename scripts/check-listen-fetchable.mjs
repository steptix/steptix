// Fail if any code binds an OS-picked port without `listenFetchable`.
//
// A bare `listen(0)` lets the OS pick the port, and on a machine whose dynamic
// range starts low it can pick one `fetch` and Chromium refuse ("bad port"),
// so every request to that server fails (#22). It passes on almost every
// machine and run, which is why a check catches it and review does not.
//
// A static check of the source, so it runs from `npm run lint` and as its own
// CI step rather than inside `npm test`: the source does not change between
// test runs. tests/listen-fetchable-guard.test.ts unit-tests the pattern.
//
//   node scripts/check-listen-fetchable.mjs
//
// Text, not syntax: it sees a bind written on one line. `const p = 0;
// server.listen(p)` gets past it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Product and test code in every package, plus the scripts and fixtures. */
const SCANNED_DIRS = [
  'src',
  'tests',
  'fixtures',
  'scripts',
  'runner-core/src',
  'runner-core/tests',
  'flick-vscode/src',
  'flick-vscode/tests',
  'steptix-vscode/src',
  'steptix-vscode/tests',
];

const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'dist-test', 'out', '.vscode-test', '.live-shards']);

/** Files skipped outright: they are the pattern, not uses of it. */
const SKIPPED_FILES = new Set([
  'tests/listen-fetchable.cjs',
  'tests/listen-fetchable-guard.test.ts',
  'scripts/check-listen-fetchable.mjs',
]);

/**
 * The bare binds these files may keep, and why nothing ever connects to them.
 * A count, not a pass for the whole file, so a second bind added beside an
 * allowed one is still caught. Paths are repo-relative with `/`.
 */
export const ALLOWED = {
  'tests/credential-real-processes.test.ts': {
    binds: 1,
    why: 'a listener inside a child-process stub, there only to keep the child alive; nothing connects',
  },
  'tests/env-server-url.test.ts': {
    binds: 1,
    why: 'holds a port so `serve` fails with EADDRINUSE; serve binds it, nothing fetches it',
  },
};

/** `.listen(0…`, `.listen()` (which is port 0 too) and `.listen({ … port: 0 … })`. */
export const BARE_LISTEN = /\.listen\(\s*(?:0\s*[,)]|\)|\{[^}]*\bport\s*:\s*0\b)/;

/** Lines that are code, not a `//` or block comment explaining the pattern. */
export function isCommentLine(line) {
  return /^\s*(?:\/\/|\/\*|\*)/.test(line);
}

function* sourceFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // A package without that folder.
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* sourceFiles(full);
    } else if (/\.(?:ts|js|cjs|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      yield full;
    }
  }
}

/** Every bare bind in code, keyed by repo-relative file. */
function findBareListens() {
  const hits = new Map();
  for (const dir of SCANNED_DIRS) {
    for (const file of sourceFiles(path.join(repoRoot, dir))) {
      const rel = path.relative(repoRoot, file).split(path.sep).join('/');
      if (SKIPPED_FILES.has(rel)) continue;
      fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (isCommentLine(line) || !BARE_LISTEN.test(line)) return;
          hits.set(rel, [...(hits.get(rel) ?? []), `${rel}:${i + 1}: ${line.trim()}`]);
        });
    }
  }
  return hits;
}

/** What is wrong, as lines to print; empty when nothing is. */
export function check() {
  const hits = findBareListens();
  const problems = [];
  for (const [rel, lines] of hits) {
    if (lines.length !== (ALLOWED[rel]?.binds ?? 0)) problems.push(...lines);
  }
  // A wrong count in a file with binds is reported above. One with none left
  // is a stale entry, which would let a new bind there through unnoticed.
  for (const [rel, { binds }] of Object.entries(ALLOWED)) {
    if (!hits.has(rel)) problems.push(`${rel}: ALLOWED expects ${binds} bare bind(s), found none; remove the entry`);
  }
  return problems;
}

// Run directly, not imported by the unit test. Compared as real paths: Node
// resolves this module's own URL through symlinks and junctions while argv[1]
// keeps the path as typed, and a plain comparison then skips the check
// silently.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const problems = check();
  if (problems.length === 0) {
    console.log('check-listen-fetchable: no bare listen(0)');
  } else {
    console.error('check-listen-fetchable: OS-picked ports must be bound through listenFetchable (#22):\n');
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      "\nBind with `await listenFetchable(server, '127.0.0.1')` from tests/listen-fetchable.cjs, or\n" +
        '`freeFetchablePort()` when the number must go to another process. If nothing ever\n' +
        'connects to the server, add it to ALLOWED in scripts/check-listen-fetchable.mjs with why.',
    );
    process.exitCode = 1;
  }
}
