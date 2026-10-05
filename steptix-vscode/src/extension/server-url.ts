import {
  readMachineServerUrl,
  userRootEnvPath,
  type UserRootDeps,
} from 'steptix-runner-core';

/**
 * Which Sessions API server a request goes to.
 *
 * One chain, the same shape as the API key's (stories/machine-key.md):
 *
 *   project `.env` (walk-up, `.env.<name>` laid over it)
 *     →  the `STEPTIX_SERVER_URL` environment variable
 *     →  `STEPTIX_SERVER_URL` in the user root's `.env`
 *     →  {@link DEFAULT_STEPTIX_SERVER_URL}
 *
 * so a project needs no `.env` at all. The machine file is where a user who
 * runs the server somewhere other than the default says so once, for every
 * project; the default is where `steptix serve` listens when nobody says
 * anything, which is what lets a fresh install run a test with nothing
 * configured.
 *
 * Kept free of `vscode` so the `node --test` suite can load it.
 */

/** Where `steptix serve` listens by default — `server.host` and `server.port`
 *  in src/config/defaults.ts. Nothing links the two copies (the extension
 *  bundles separately from the framework), so change both together. */
export const DEFAULT_STEPTIX_SERVER_URL = 'http://127.0.0.1:3100';

export type ServerUrlOrigin =
  /** The project's `.env` or the active `.env.<name>` — `path` is the file. */
  | { kind: 'project'; path: string }
  | { kind: 'environment' }
  /** The user root's `.env` — `path` is that file. */
  | { kind: 'machine'; path: string }
  | { kind: 'default' };

export interface ResolvedServerUrl {
  serverUrl: string;
  origin: ServerUrlOrigin;
}

/**
 * Walk the chain. `project` is the value the project's composed env gives,
 * with the file it came from; pass null when the project names none.
 *
 * Throws only what reading the user root's `.env` throws — an unreadable or
 * malformed file, where the URL may well be in there. Callers on the run path
 * report that (STX007); callers with no run to fail treat it as unresolvable.
 */
export function resolveServerUrl(
  project: { value: string | undefined; path: string } | null,
  deps?: UserRootDeps,
): ResolvedServerUrl {
  const fromProject = project?.value?.trim();
  if (project && fromProject) {
    return { serverUrl: fromProject, origin: { kind: 'project', path: project.path } };
  }
  const fromEnvironment = (deps?.env ?? process.env)['STEPTIX_SERVER_URL']?.trim();
  if (fromEnvironment) return { serverUrl: fromEnvironment, origin: { kind: 'environment' } };
  const fromMachine = readMachineServerUrl(deps);
  if (fromMachine) {
    return { serverUrl: fromMachine, origin: { kind: 'machine', path: userRootEnvPath(deps) } };
  }
  return { serverUrl: DEFAULT_STEPTIX_SERVER_URL, origin: { kind: 'default' } };
}

/** Where a URL came from, as the run log and STX004 name it. */
export function describeServerUrlOrigin(origin: ServerUrlOrigin, deps?: UserRootDeps): string {
  switch (origin.kind) {
    case 'project':
    case 'machine':
      return origin.path;
    case 'environment':
      return 'the VS Code process environment';
    case 'default':
      return (
        `the default — neither the project's .env, the environment nor ` +
        `${userRootEnvPath(deps)} sets STEPTIX_SERVER_URL`
      );
  }
}
