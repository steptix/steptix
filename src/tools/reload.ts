import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { logger } from '../utils/logger.js';

/**
 * Hot-reload mechanism for tool files on the long-lived server (issue 033).
 *
 * A plain re-`import()` of an edited `.ts` returns **stale** code: tsx caches
 * its transpile output keyed by file *path*, in memory, and nothing public
 * (a `?t=` query, `tsImport`, `register({namespace})`, `TSX_DISABLE_CACHE`)
 * busts it — verified on tsx 4.21 / Node 22.22. The only thing that yields a
 * fresh transpile is a genuinely distinct file *path*.
 *
 * So we esbuild-bundle the tool to a uniquely-named temp `.mjs` and import
 * that. `bundle:true` inlines the tool's relative helpers *fresh* (a unique
 * entry path alone wouldn't reload an unchanged-path helper); `packages:
 * 'external'` leaves bare deps (`steptix/tools`, playwright, …) for
 * Node to resolve at import time. ~20 ms warm, in-process — so the live
 * Playwright `page` handle is preserved (a worker/subprocess couldn't receive
 * it). The CLI is one-shot and keeps the direct import; only `serve`/Steptix
 * needs this.
 */

/** A freshly-imported tool module plus the source files that produced it. */
export interface BundledModule {
  /** The imported module namespace (default + named exports). */
  module: Record<string, unknown>;
  /**
   * Absolute paths of every file esbuild bundled — the entry tool file **and**
   * its relative helpers. The change signature ([signatureOf]) is taken over
   * this set so editing a bundled helper also counts as "the tool changed".
   */
  inputs: string[];
}

/** The raw bundle output (before it's written + imported). */
export interface BundledOutput {
  /** Bundled ESM source with an inline sourcemap, ready to write as `.mjs`. */
  contents: Uint8Array;
  /** Absolute paths of every bundled input (entry + relative helpers). */
  inputs: string[];
}

// esbuild ships as a transitive dependency (via tsx) and is directly
// resolvable. Import it lazily the first time a reload is needed so the
// one-shot CLI path — which never hot-reloads — doesn't pay the load cost.
/** The framework's own package name — what generated files import. */
const FRAMEWORK_PACKAGE = 'steptix';

/**
 * Resolve `steptix` and its subpaths to the running framework when
 * the project cannot.
 *
 * A generated `.steps.ts` (or a tool) imports `steptix/codebehind`,
 * and `packages: 'external'` leaves that for Node to resolve from the temp
 * module's location — which is the project's cache dir. A tests-only project
 * driven from Steptix has no `node_modules` and no reason to have one, and
 * the import then fails, the loader warns, and every step falls back to AI.
 * Caught live on a project with a freshly compiled, correct `.steps.ts`.
 *
 * The server (or CLI) loading the file IS the framework, and knows where its
 * own modules are. So: when the package resolves from the cache dir — a real
 * install, or the framework's own checkout self-referencing — the bare
 * specifier stays and Node resolves it as before. When it does not, the
 * specifier is rewritten to the file URL of the framework's own export, read
 * off its `package.json`. One module instance either way; a project with a
 * `package.json` dependency still gets editor types, and a project without
 * one still runs as code.
 */
function frameworkSelfResolvePlugin(cacheDir: string): import('esbuild').Plugin {
  return {
    name: 'steptix-self-resolve',
    setup(build) {
      build.onResolve({ filter: /^steptix(\/.*)?$/ }, async (args) => {
        if (await frameworkResolvesFrom(cacheDir)) return undefined;
        const target = await frameworkExportPath(args.path);
        if (!target) return undefined;
        logger.debug(
          `${args.path} does not resolve from ${cacheDir}; using the framework's own ${target}`,
        );
        return { path: pathToFileURL(target).href, external: true };
      });
    },
  };
}

/**
 * Would Node find `steptix` from `dir`? True for an installed (or
 * linked) package in any `node_modules` above it, and for the framework's own
 * checkout, where the nearest `package.json` IS the package (self-reference
 * through `exports`).
 */
async function frameworkResolvesFrom(dir: string): Promise<boolean> {
  let current = path.resolve(dir);
  for (let i = 0; i < 64; i++) {
    if (await exists(path.join(current, 'node_modules', FRAMEWORK_PACKAGE, 'package.json'))) return true;
    const manifest = path.join(current, 'package.json');
    if (await exists(manifest)) {
      try {
        const { name } = JSON.parse(await fs.readFile(manifest, 'utf-8')) as { name?: string };
        if (name === FRAMEWORK_PACKAGE) return true;
      } catch {
        // An unreadable package.json on the way up is not ours to judge.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

let frameworkRootPromise: Promise<string | null> | undefined;

/** The framework's own package root: the nearest `package.json` above this
 *  module named `steptix`. Works from `dist/` and from `src/`. */
function frameworkRoot(): Promise<string | null> {
  if (!frameworkRootPromise) {
    frameworkRootPromise = (async () => {
      let current = path.dirname(fileURLToPath(import.meta.url));
      for (let i = 0; i < 16; i++) {
        const manifest = path.join(current, 'package.json');
        if (await exists(manifest)) {
          try {
            const { name } = JSON.parse(await fs.readFile(manifest, 'utf-8')) as { name?: string };
            if (name === FRAMEWORK_PACKAGE) return current;
          } catch {
            // keep walking
          }
        }
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
      }
      return null;
    })();
  }
  return frameworkRootPromise;
}

/** The absolute path the framework's `package.json` exports for a specifier —
 *  `steptix/codebehind` → `<root>/dist/codebehind/index.js`. */
async function frameworkExportPath(specifier: string): Promise<string | null> {
  const root = await frameworkRoot();
  if (!root) return null;
  const subpath = specifier === FRAMEWORK_PACKAGE ? '.' : `./${specifier.slice(FRAMEWORK_PACKAGE.length + 1)}`;
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf-8')) as {
      exports?: Record<string, string | Record<string, string>>;
    };
    const entry = manifest.exports?.[subpath];
    const target = typeof entry === 'string' ? entry : (entry?.['import'] ?? entry?.['default']);
    return target ? path.resolve(root, target) : null;
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

let esbuildPromise: Promise<typeof import('esbuild')> | undefined;
function getEsbuild(): Promise<typeof import('esbuild')> {
  if (!esbuildPromise) esbuildPromise = import('esbuild');
  return esbuildPromise;
}

/**
 * Bundle `toolFile` (and its relative helpers) and import the result, defeating
 * tsx's path-keyed transpile cache. Writes a content-addressed temp `.mjs`
 * under `cacheDir`, imports that unique URL, then deletes the temp file.
 * Returns the imported module and the list of bundled inputs (for change
 * detection). Throws on a bundle/import failure — the caller confines that to
 * the referencing tool.
 */
export async function bundleAndImport(
  toolFile: string,
  cacheDir: string,
): Promise<BundledModule> {
  const { contents, inputs } = await bundleToolModule(toolFile, cacheDir);

  // Unique temp filename per call. A content-hash-only name would collide when
  // two concurrent sessions sharing one toolsDir bundle the *same* content into
  // the *same* `.steptix-tool-cache` — the first finisher's delete (below) would
  // yank the file out from under the others' import(), surfacing the exact
  // "cannot find module" failure this feature set out to kill. The randomUUID
  // suffix makes each write independent; the hash prefix is kept only as a
  // human-readable tag. Cost: one ESM-registry entry per reload (bounded by
  // edits-per-session; there's no evict API regardless) — negligible for a dev
  // server.
  const hash = createHash('sha256').update(contents).digest('hex').slice(0, 16);
  const tempFile = path.join(cacheDir, `${hash}-${randomUUID()}.mjs`);
  await fs.writeFile(tempFile, contents);

  try {
    const module = (await import(pathToFileURL(tempFile).href)) as Record<string, unknown>;
    return { module, inputs };
  } finally {
    // The import has fully read the file into V8, so the on-disk temp is no
    // longer needed. Best-effort delete to keep the cache dir tidy; the file is
    // never re-imported (every reload re-bundles to a fresh unique name), so
    // deleting it can't strand a later import.
    await fs.rm(tempFile, { force: true }).catch(() => {});
  }
}

/**
 * The pure bundling step: esbuild-bundle `toolFile` and return the output bytes
 * + the absolute input set, without writing/importing. Split from
 * `bundleAndImport` so the sourcemap-anchoring (the step-into-critical bit) is
 * testable directly.
 */
export async function bundleToolModule(
  toolFile: string,
  cacheDir: string,
): Promise<BundledOutput> {
  const esbuild = await getEsbuild();
  // Create the cache dir first: it's both esbuild's working dir (below) and the
  // write target for the temp module.
  await fs.mkdir(cacheDir, { recursive: true });
  const result = await esbuild.build({
    entryPoints: [toolFile],
    bundle: true,
    format: 'esm',
    platform: 'node',
    // Leave bare specifiers (framework + native deps) for Node to resolve at
    // import time; only the tool's own relative graph is inlined. The temp
    // file lives where those bare deps resolve (see resolveToolCacheDir).
    packages: 'external',
    write: false,
    // Map the bundled temp `.mjs` back to the original `.ts` so a step-into
    // debugger pause lands in the author's source, not the generated bundle.
    sourcemap: 'inline',
    // Emit sourcemap `sources` (and metafile input keys) relative to cacheDir —
    // where the temp `.mjs` is written. A debugger resolves `sources` against
    // the `.mjs`'s own location, so anchoring esbuild there makes them point at
    // the author's real `.ts`. The default (process.cwd(), the server's launch
    // dir) would resolve to a bogus path and break step-into.
    absWorkingDir: cacheDir,
    // Pin `import.meta.*` to the tool's *original* location, not the temp `.mjs`
    // in cacheDir. A tool that resolves a sibling resource via
    // `new URL('./data', import.meta.url)` then behaves identically on the
    // server (bundled) and the CLI (direct import); without this it would
    // resolve inside `.steptix-tool-cache/` and ENOENT. (The framework's own tool
    // subgraph uses no `import.meta`, so this is safe even when a tool imports
    // it by absolute path and esbuild inlines it.)
    //
    // `define` is a global substitution, so this pins the *entry* file's
    // location. A bundled relative helper reading `import.meta.url` also reports
    // the entry's URL (not its own) — full CLI parity holds only for the entry.
    // Fine for the common same-dir case; a helper in a *different* dir doing its
    // own `new URL('./x', import.meta.url)` would diverge. Rare; revisit if a
    // tool needs per-module `import.meta` in helpers.
    define: {
      'import.meta.url': JSON.stringify(pathToFileURL(toolFile).href),
      'import.meta.dirname': JSON.stringify(path.dirname(toolFile)),
      'import.meta.filename': JSON.stringify(toolFile),
    },
    // The metafile lists every bundled input, which becomes the change
    // signature's file set (so helper edits are detected too).
    metafile: true,
    logLevel: 'silent',
    plugins: [frameworkSelfResolvePlugin(cacheDir)],
  });

  const output = result.outputFiles[0]!;
  const inputs = Object.keys(result.metafile.inputs).map((key) =>
    // Metafile keys are relative to absWorkingDir (cacheDir); resolve back to
    // absolute for stat/hash in signatureOf.
    path.resolve(cacheDir, key),
  );
  return { contents: output.contents, inputs };
}

/**
 * Content-based change signature over a set of source files (a bundle's input
 * set). Content rather than mtime so a "save and re-run" within one filesystem
 * mtime tick — or a coarse-mtime filesystem — still busts the cached load
 * (cf. issue 026's data-bundle hazard). A file that can't be read contributes
 * a sentinel, so deleting a still-imported helper registers as a change (and
 * the ensuing rebundle surfaces the now-broken import as a clean error).
 *
 * Cost: reads + hashes every input on each call — O(total source bytes), run
 * once per `resolve` in reload mode. Negligible for the handful of small files
 * a tool bundles, but not free; if a tool ever pulled in a large input set,
 * an mtime pre-filter (hash only when mtimes move) would cut it.
 */
export async function signatureOf(inputs: string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const file of [...inputs].sort()) {
    hash.update(file);
    hash.update('\0');
    try {
      hash.update(await fs.readFile(file));
    } catch {
      hash.update('<unreadable>');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Name of the temp-module cache directory created inside the tools dir. */
export const TOOL_CACHE_DIRNAME = '.steptix-tool-cache';

/**
 * Where to write temp tool modules for `toolsDir`: a dot-directory **inside**
 * the tools dir itself.
 *
 * Co-locating is what makes bare-specifier resolution work everywhere. A
 * temp `.mjs` resolves `steptix/tools` (and playwright, …) by the same
 * walk-up the tool file uses — whether the package is found via a real
 * `node_modules` entry (installed dep or a symlink, as the fixtures use) *or*
 * via package self-reference (tools living inside the framework repo). A
 * `node_modules/.cache` location would break the **self-reference** case:
 * Node's `LOOKUP_PACKAGE_SCOPE` returns null once a `node_modules` segment is
 * in the path, so the package's own `exports` are unreachable from under it.
 *
 * The dot prefix keeps the dir out of the catalogue walk (`listToolFiles`
 * skips dot-directories), so temp modules are never mistaken for tools.
 */
export function resolveToolCacheDir(toolsDir: string): string {
  return path.join(path.resolve(toolsDir), TOOL_CACHE_DIRNAME);
}
