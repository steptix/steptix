/**
 * The MCP server itself: construction, transport, lifetime.
 *
 * Deliberately thin. Everything that could need faking in a test — the HTTP
 * client, auto-start, project resolution — arrives through `McpDeps`, so the
 * seam tests can drive the real tool handlers over a real in-memory transport
 * without a browser, a server or a filesystem.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Console } from 'node:console';
import { getPackageVersion } from '../utils/version.js';
import { registerTools } from './tools.js';
import type { McpDeps } from './types.js';

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'steptix', version: getPackageVersion() });
  registerTools(server, deps);
  return server;
}

/**
 * Point the *global* console at stderr.
 *
 * `setLogStream` covers this project's logger, which is most of the risk but
 * not all of it: a dependency that writes to stdout at import time, or any
 * stray `console.log` in code we don't own, would corrupt the JSON-RPC frame
 * just as effectively.
 *
 * `src/index.ts` does this too, before it imports this module — that is the
 * one that protects the SDK's own import. Repeating it here keeps `main()`
 * safe for a caller that reaches it another way (the seam tests do), and
 * re-assigning to an equivalent Console is free.
 */
function silenceGlobalConsole(): void {
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
}

export async function main(deps?: McpDeps): Promise<void> {
  silenceGlobalConsole();

  const resolved = deps ?? (await defaultDeps());
  const server = createMcpServer(resolved);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // The host owns our lifetime: when it closes stdin, we are done. Nothing
  // here needs to outlive it — any server we auto-started is detached and
  // unref'd, and reaps itself on its own idle timeout.
  await new Promise<void>((resolve) => {
    process.stdin.on('close', resolve);
    process.stdin.on('end', resolve);
  });
  await server.close();
}

/** Built lazily so importing this module costs nothing a test does not use. */
async function defaultDeps(): Promise<McpDeps> {
  const [{ createApiClient }, { ensureServerReady, assertServerRecognized }, { resolveProject }] =
    await Promise.all([
      import('./api-client.js'),
      import('./server-start.js'),
      import('./project.js'),
    ]);
  return { createApiClient, ensureServerReady, assertServerRecognized, resolveProject };
}
