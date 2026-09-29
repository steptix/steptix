#!/usr/bin/env node
/**
 * `steptix mcp` deliberately bypasses the commander program.
 *
 * Two reasons, both load-bearing:
 *
 * 1. Speed. Registering the command inside `createCli()` would make
 *    `cli/index.ts → serve.ts → api-server.ts → session-manager.ts →
 *    browser/manager.ts` a static value-import chain, so every MCP startup
 *    would eagerly load playwright, playwright-extra and the stealth plugin —
 *    measured at 1.0–1.5 s against ~250 ms for the MCP SDK and ~91 ms for the
 *    parser. Only `browser/manager.ts` value-imports playwright (the other
 *    thirteen are `import type` and erase), so branching away from the CLI
 *    really does keep it out of the graph.
 *
 * 2. stdout hygiene. `cli/index.ts` runs `loadDefaultEnvFileSync()` at module
 *    scope and pulls in every command module. On a stdio transport stdout is
 *    the JSON-RPC channel, so the fewer modules that could print at load, the
 *    better.
 *
 * The dynamic `import()`s are what make this work at all: ESM hoists static
 * imports, so a guard placed above `import { createCli }` would run *after*
 * that whole graph had already evaluated. Keep them dynamic.
 */
if (process.argv[2] === 'mcp') {
  // Both redirects happen BEFORE the MCP module graph is imported. `main()`
  // used to do the global one, which left a window: the SDK, zod and ajv all
  // evaluate during that dynamic import, and an import-time `console.log` in
  // any of them would land on the JSON-RPC channel before we had moved it.
  const { Console } = await import('node:console');
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
  const { setLogStream } = await import('./utils/logger.js');
  setLogStream('stderr');

  // `steptix mcp --help` (or `-h`, `--version`, `help`) must not start a server —
  // it would silently block a human's terminal on a stdio transport that
  // nobody is speaking to.
  const rest = process.argv[3];
  if (rest === 'help' || (rest !== undefined && rest.startsWith('-'))) {
    const { MCP_USAGE } = await import('./mcp/usage.js');
    process.stderr.write(MCP_USAGE);
    // Not `process.exit(0)`: stderr to a pipe is asynchronous on Windows, so
    // an immediate exit can truncate the text.
    process.exitCode = 0;
  } else {
    const { main } = await import('./mcp/server.js');
    await main();
  }
} else {
  const { createCli } = await import('./cli/index.js');
  createCli().parse(process.argv);
}
