/**
 * Version numbers as the launcher and the extension compare them
 * (docs/specs/SPEC-install.md §4.2).
 *
 * The extension and the `steptix` package share `major.minor` and keep their
 * own patch. A client needs a server of its own `major.minor` with at least a
 * given patch, and runs the newest such server.
 */

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifiers, empty for a release. */
  pre: string[];
}

export function parseVersion(version: string): ParsedVersion | null {
  const m = VERSION_PATTERN.exec(version);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4]?.split('.') ?? [] };
}

/**
 * Semver precedence: a pre-release sorts below its release, and pre-release
 * identifiers compare numerically when both are numbers. A name that is not a
 * version sorts below every one that is.
 *
 * The same order as `compareVersions` in
 * steptix-vscode/src/extension/install-core.ts, which picks the server the
 * extension starts; tests/install-core-parity.test.ts holds the two together.
 */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) {
    if (va || vb) return va ? 1 : -1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const core = va.major - vb.major || va.minor - vb.minor || va.patch - vb.patch;
  if (core !== 0) return core;
  // A release outranks every pre-release of itself.
  if (va.pre.length === 0 || vb.pre.length === 0) return vb.pre.length - va.pre.length;
  for (let i = 0; i < Math.min(va.pre.length, vb.pre.length); i++) {
    const x = va.pre[i]!;
    const y = vb.pre[i]!;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) - Number(y);
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return va.pre.length - vb.pre.length;
}

/** `1.4` for `1.4.3`, or null for a name that is not a version. */
export function majorMinor(version: string): string | null {
  const v = parseVersion(version);
  return v ? `${v.major}.${v.minor}` : null;
}

/**
 * Does server `version` serve a client that needs `requires`? The same
 * `major.minor`, and not older than `requires` (normally `<major>.<minor>.0`).
 */
export function satisfies(version: string, requires: string): boolean {
  const mm = majorMinor(version);
  return mm !== null && mm === majorMinor(requires) && compareVersions(version, requires) >= 0;
}

/** What a client of version `version` needs when it asks for no particular
 *  patch: its own `major.minor`, any patch (§4.2). */
export function defaultRequirement(version: string): string | null {
  const v = parseVersion(version);
  return v ? `${v.major}.${v.minor}.0` : null;
}
