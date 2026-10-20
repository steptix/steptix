/**
 * Which build of the extension this is (docs/specs/SPEC-install.md §3.1).
 * esbuild.extension.js stamps the commit in at bundle time; run unbundled (the
 * `node --test` suite) there is no stamp, and the build reads as unknown.
 */

declare const __STEPTIX_EXTENSION_BUILD__: { commit: string | null; modified: boolean | null } | undefined;

export interface ExtensionBuild {
  /** Short commit, or null when unknown. */
  commit: string | null;
  /** True for a build with uncommitted changes; null when unknown. */
  modified: boolean | null;
}

export function extensionBuild(): ExtensionBuild {
  return typeof __STEPTIX_EXTENSION_BUILD__ === 'undefined' ? { commit: null, modified: null } : __STEPTIX_EXTENSION_BUILD__;
}

/** `Steptix 1.0.0 · 3f9a1c2`, with ` · modified` for a build with
 *  uncommitted changes, and the version alone when the commit is unknown. */
export function describeExtensionBuild(version: string, build: ExtensionBuild): string {
  if (!build.commit) return `Steptix ${version}`;
  return `Steptix ${version} · ${build.commit}${build.modified ? ' · modified' : ''}`;
}
