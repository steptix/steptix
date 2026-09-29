// Writes dist/THIRD-PARTY-NOTICES.txt: the licence text of every third-party
// package whose code ended up in the extension's bundles.
//
// MIT, BSD and ISC require their copyright notice to travel with every copy
// of the code, and Apache-2.0 adds any NOTICE file. The bundles are copies —
// and the minified webview strips the licence comments — so the .vsix has to
// carry the texts itself.
//
// The list comes from the bundles' source maps, not from package.json: a map
// names every file that contributed code, so a dependency that is declared but
// tree-shaken away is not listed, and one pulled in transitively is. Run after
// both bundles are built; `npm run build` does.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Our own packages — bundled, but not third-party. */
const OWN_PACKAGES = new Set(['steptix', 'steptix-runner-core']);

/** Licences a bundled package may carry without someone deciding first. */
const ALLOWED_LICENSES = new Set([
  '0BSD', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MIT',
]);

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

/**
 * The package root a bundled source file belongs to, or null for a file that
 * is not under node_modules. Nested installs resolve to the innermost package.
 */
export function packageRootOf(sourcePath) {
  const parts = sourcePath.split(/[\\/]/);
  const i = parts.lastIndexOf('node_modules');
  if (i < 0 || i + 1 >= parts.length) return null;
  const nameParts = parts[i + 1].startsWith('@') ? 2 : 1;
  return parts.slice(0, i + 1 + nameParts).join(path.sep);
}

/** Absolute package roots of every third-party file named in the given maps. */
export function bundledPackageRoots(mapFiles) {
  const roots = new Set();
  for (const mapFile of mapFiles) {
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    const base = path.resolve(path.dirname(mapFile), map.sourceRoot ?? '');
    for (const source of map.sources ?? []) {
      const root = packageRootOf(path.resolve(base, source));
      if (root) roots.add(root);
    }
  }
  return roots;
}

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses) && pkg.licenses[0]?.type) return pkg.licenses[0].type;
  return 'UNKNOWN';
}

/**
 * Name, version, licence and licence files of each package, sorted by name.
 * Throws — naming every offender — when a package is missing its licence
 * text or carries a licence outside ALLOWED_LICENSES.
 */
export function describePackages(roots) {
  const byId = new Map();
  const problems = [];
  for (const root of roots) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (OWN_PACKAGES.has(pkg.name)) continue;
    const id = `${pkg.name}@${pkg.version}`;
    if (byId.has(id)) continue;
    const license = licenseOf(pkg);
    // LICENSE before NOTICE, so a reader meets the terms first.
    const files = fs.readdirSync(root)
      .filter((f) => LICENSE_FILE.test(f) && fs.statSync(path.join(root, f)).isFile())
      .sort((a, b) => Number(/^notice/i.test(a)) - Number(/^notice/i.test(b)) || a.localeCompare(b));
    if (files.length === 0) problems.push(`${id} has no LICENSE file in ${root}`);
    if (!ALLOWED_LICENSES.has(license)) {
      problems.push(`${id} is licensed "${license}", which is not on the allowed list — decide before shipping it`);
    }
    byId.set(id, {
      name: pkg.name,
      version: pkg.version,
      license,
      homepage: pkg.homepage ?? null,
      texts: files.map((f) => ({ file: f, text: fs.readFileSync(path.join(root, f), 'utf8').trim() })),
    });
  }
  if (problems.length > 0) {
    throw new Error(`Third-party notices:\n  ${problems.join('\n  ')}`);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const RULE = '='.repeat(72);

export function renderNotices(packages) {
  const lines = [
    'Steptix for VS Code includes the following third-party software. Each',
    'package is distributed under its own licence, reproduced below.',
    '',
  ];
  for (const p of packages) {
    lines.push(RULE, `${p.name} ${p.version} (${p.license})`);
    if (p.homepage) lines.push(p.homepage);
    for (const t of p.texts) lines.push('', `--- ${t.file} ---`, '', t.text);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

function mapFilesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js.map'))
    .map((e) => path.join(e.parentPath ?? e.path, e.name));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  const maps = mapFilesUnder(dist);
  if (maps.length === 0) {
    console.error(`third-party-notices: no source maps under ${dist} — build first`);
    process.exit(1);
  }
  try {
    const packages = describePackages(bundledPackageRoots(maps));
    fs.writeFileSync(path.join(dist, 'THIRD-PARTY-NOTICES.txt'), renderNotices(packages));
    console.log(
      `third-party-notices: ${packages.length} package(s) — ` +
        packages.map((p) => `${p.name}@${p.version} (${p.license})`).join(', '),
    );
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
