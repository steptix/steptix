// Stamp `dist/build-info.json` with the commit this build was made from, and
// whether the working tree had changes that commit does not hold.
//
// Stamped at build time, not read from `.git` when the server starts: the
// server runs `dist/`, so the commit checked out at start-up says nothing
// about a `dist/` built before a pull, a branch switch, or an edit. `modified`
// covers the edit — tracked changes and untracked files alike, since either
// can be in what tsc just compiled.
//
// Never fails the build. Without git (or outside a checkout) both fields are
// null, which every reader shows as "unknown", never as a guess.
//
// Run last in `npm run build`, so anything earlier steps regenerate into
// tracked files counts toward `modified`.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outPath = path.join(projectRoot, 'dist', 'build-info.json');

function git(...args) {
  return execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

let commit = null;
let modified = null;
try {
  // `--show-toplevel` first: inside someone else's repository (an npm install
  // under their checkout) git would happily answer with THEIR commit.
  // realpath both: a checkout reached through a symlink (macOS's /var) or a
  // differently-cased drive letter is still this one.
  const toplevel = fs.realpathSync.native(git('rev-parse', '--show-toplevel'));
  if (toplevel === fs.realpathSync.native(projectRoot)) {
    commit = git('rev-parse', 'HEAD').slice(0, 7);
    modified = git('status', '--porcelain') !== '';
  }
} catch {
  // No git, not a checkout, or an unborn branch: unknown.
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ commit, modified }, null, 2) + '\n');
console.log(`build-info: ${commit === null ? 'commit unknown' : `${commit}${modified ? ' (modified)' : ''}`}`);
