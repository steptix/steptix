/**
 * Start `fixtures/test-app` (SecureBank) for one test file.
 *
 * The child binds port 0 itself and prints the port it got; the test waits for
 * that line. Six suites used to pick a port by listening on 0 and closing it,
 * hand the number to the child and poll it against a fixed 15 s — and under a
 * loaded run that failed both ways: a cold `tsx` transform of the server took
 * longer than 15 s, and in the gap between the close and the child's bind,
 * another worker could be handed the same port.
 *
 * The wait is bounded only so the error is ours rather than the hook's, and it
 * ends at once if the child exits first, saying what it printed.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = path.join(repoRoot, 'fixtures', 'test-app', 'server.ts');

/** The server's first line, carrying the port it bound (fixtures/test-app/server.ts). */
const READY = /Fixture test server running at http:\/\/localhost:(\d+)/;

export interface FixtureServer {
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  baseUrl: string;
  port: number;
  /** Stop the server and wait for it to exit. Safe to call twice. */
  stop(): Promise<void>;
}

export async function startFixtureServer(readyTimeoutMs = 50_000): Promise<FixtureServer> {
  const child = spawn(process.execPath, ['--import', 'tsx', serverPath], {
    cwd: repoRoot,
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr!.on('data', (b: Buffer) => process.stderr.write(`[test-app] ${b.toString()}`));
  // For the server's whole life: an 'error' with no listener (a failed kill in
  // stop(), say) would be thrown as an uncaught exception into whichever test
  // happens to be running.
  child.on('error', (err) => process.stderr.write(`[test-app] ${String(err)}\n`));

  let printed = '';
  // Keep draining stdout for the server's whole life: a pipe nobody reads
  // fills up and blocks the server's next write.
  child.stdout!.on('data', (b: Buffer) => {
    if (printed.length < 4_000) printed += b.toString();
  });

  const port = await new Promise<number>((resolve, reject) => {
    const settle = (err: Error | null, value?: number): void => {
      clearTimeout(timer);
      child.stdout!.off('data', onData);
      child.off('close', onClose);
      child.off('error', onError);
      if (err) {
        child.kill();
        reject(err);
      } else {
        resolve(value!);
      }
    };
    const said = (): string => printed.trim() || '(nothing)';
    const onData = (): void => {
      const m = READY.exec(printed);
      if (m) settle(null, Number(m[1]));
    };
    // 'close', not 'exit': it waits for stdout to drain, so 'It printed' is whole.
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void =>
      settle(new Error(`fixtures/test-app exited before it was ready (code ${code}, signal ${signal}). It printed: ${said()}`));
    const onError = (err: Error): void => settle(err);
    const timer = setTimeout(
      () => settle(new Error(`fixtures/test-app did not report its port within ${readyTimeoutMs} ms. It printed: ${said()}`)),
      readyTimeoutMs,
    );
    child.stdout!.on('data', onData);
    child.on('close', onClose);
    child.on('error', onError);
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill();
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
