// `steptix` on PATH (packaging/runtime/README.md §On PATH). The installer
// copies this file and the steptix.cmd beside it into <user root>\bin and
// puts that one folder on the user's Path, whatever the version. Each version
// installs into runtimes\<version> and the older ones stay, so this runs the
// newest startable one there: the one the VS Code extension starts
// (findInstalledRuntime, steptix-vscode/src/extension/server-manager.ts).
//
// A deliberate copy of that choice, since this file ships in the runtime
// installer and not in the extension.
// steptix-vscode/tests/path-runtime-parity.test.js holds the two to the same
// answers.
const fs = require('node:fs');
const path = require('node:path');

/** The files a runtime folder must hold to be started (runtimeLaunchFiles). */
const LAUNCH_FILES = ['runtime-launcher.cjs', path.join('server', 'dist', 'index.js'), 'steptix.cmd'];

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Semver precedence: a prerelease sorts below its release, and prerelease
 * identifiers compare numerically when both are numbers. A folder name that is
 * not a version sorts below every one that is.
 */
function compareVersions(a, b) {
  const va = VERSION_PATTERN.exec(a);
  const vb = VERSION_PATTERN.exec(b);
  if (!va || !vb) {
    if (va || vb) return va ? 1 : -1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  for (let i = 1; i <= 3; i++) {
    const diff = Number(va[i]) - Number(vb[i]);
    if (diff !== 0) return diff;
  }
  const pa = va[4] ? va[4].split('.') : [];
  const pb = vb[4] ? vb[4].split('.') : [];
  // A release outranks every prerelease of itself.
  if (pa.length === 0 || pb.length === 0) return pb.length - pa.length;
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) - Number(y);
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
}

/** The newest startable runtime in `runtimesDir`, or null. */
function newestRuntime(runtimesDir) {
  let names;
  try {
    names = fs.readdirSync(runtimesDir);
  } catch {
    return null;
  }
  const newest = names
    .filter((name) => LAUNCH_FILES.every((file) => fs.existsSync(path.join(runtimesDir, name, file))))
    .sort(compareVersions)
    .pop();
  return newest === undefined ? null : { version: newest, dir: path.join(runtimesDir, newest) };
}

module.exports = { compareVersions, newestRuntime };

if (require.main === module) {
  const runtimesDir = path.join(__dirname, '..', 'runtimes');
  const runtime = newestRuntime(runtimesDir);
  if (runtime === null) {
    console.error(`No Steptix runtime is installed in ${runtimesDir}. Install one, or remove ${__dirname} from your PATH.`);
    process.exit(1);
  }
  // In this process: the launcher works from its own folder and from
  // process.argv, and starts the CLI or the server as its child, exactly as
  // when that runtime's own steptix.cmd runs it.
  require(path.join(runtime.dir, 'runtime-launcher.cjs'));
}
