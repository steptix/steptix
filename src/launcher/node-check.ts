/**
 * The Node.js a `steptix` command needs (docs/specs/SPEC-install.md §4.6,
 * §5.1). Checked before anything else loads, so an older Node says what to do
 * instead of failing on syntax or a missing API it does not have.
 *
 * Kept to syntax and APIs that old Node versions understand.
 */

export const REQUIRED_NODE = '22.21';

/** The refusal for `nodeVersion` (`process.versions.node`), or null when it is new enough. */
export function nodeVersionProblem(nodeVersion: string): string | null {
  const parts = nodeVersion.split('.').map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const [needMajor, needMinor] = REQUIRED_NODE.split('.').map(Number) as [number, number];
  if (major > needMajor || (major === needMajor && minor >= needMinor)) return null;
  return (
    `Steptix needs Node.js ${REQUIRED_NODE} or later. You have ${major}.${minor}. ` +
    'Install a newer Node.js from nodejs.org and run this again.'
  );
}
