import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger, setLogStream, setLogLevel, getLogLevel } from '../src/utils/logger.js';

// ---------------------------------------------------------------------------
// `steptix mcp` speaks JSON-RPC over stdout. One stray log line corrupts the
// frame and the host drops the connection — a failure that shows up as "the
// MCP server doesn't work" with nothing in it pointing at logging.
//
// The subtlety worth a test: `setLogLevel('silent')` is NOT enough. Four of
// the logger's methods write unconditionally, because they are the run's
// headline output and were never meant to be silenceable by level. So this
// asserts on every method, not a representative sample.
// ---------------------------------------------------------------------------

let stdoutWrites: string[];
let stderrWrites: string[];
let restoreLevel: ReturnType<typeof getLogLevel>;

beforeEach(() => {
  stdoutWrites = [];
  stderrWrites = [];
  restoreLevel = getLogLevel();
  // Lowest threshold, so the guarded methods emit too and a passing test
  // can't be an artefact of filtering.
  setLogLevel('debug');
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdoutWrites.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderrWrites.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  setLogStream('stdout');
  setLogLevel(restoreLevel);
});

/** Every method that can put bytes on a stream. */
function callEveryLoggerMethod(): void {
  logger.debug('d');
  logger.info('i');
  logger.success('s');
  logger.subAction('sub');
  logger.step(1, 2, 'a step');
  logger.assertion(true, 'actual', 'expected');
  logger.testStart('a test');
  logger.testEnd('a test', true, 1000);
  logger.warn('w');
  logger.error('e');
  logger.tokenWarning(10, 100);
}

describe('setLogStream', () => {
  it('puts nothing on stdout once switched to stderr', () => {
    setLogStream('stderr');
    callEveryLoggerMethod();

    expect(stdoutWrites).toEqual([]);
    expect(stderrWrites.length).toBeGreaterThan(0);
  });

  it('still routes the four unguarded methods, which setLogLevel cannot silence', () => {
    // step / assertion / testStart / testEnd have no shouldEmit guard, so a
    // level-based approach would have left exactly these on stdout.
    setLogStream('stderr');
    setLogLevel('silent');

    logger.step(1, 2, 'unguarded step');
    logger.assertion(true, 'a', 'b');
    logger.testStart('t');
    logger.testEnd('t', true, 5);

    expect(stdoutWrites).toEqual([]);
    expect(stderrWrites.join('')).toContain('unguarded step');
  });

  it('stops writing to stderr when switched back', () => {
    // Asserted as "no longer on stderr" rather than "now on stdout": the
    // default target is `globalThis.console`, which vitest replaces with its
    // own capturing console, so a process.stdout spy never sees it. Keeping
    // the default as the global console is deliberate — an explicit
    // Console(process.stdout) would bypass that capture and break every other
    // test that asserts on logged output.
    setLogStream('stderr');
    logger.info('while on stderr');
    const beforeSwitch = stderrWrites.length;

    setLogStream('stdout');
    logger.info('after switching back');

    expect(stderrWrites.length).toBe(beforeSwitch);
    expect(stderrWrites.join('')).not.toContain('after switching back');
  });

  it('keeps format substitution and extra args intact', () => {
    // The reason this is a private Console rather than a stream.write at each
    // call site: a hand-rolled write would drop %s substitution and the
    // util.inspect of trailing args, silently degrading every log line.
    setLogStream('stderr');
    logger.info('value=%s', 'forty-two');
    logger.info('object follows', { nested: { a: 1 } });

    const out = stderrWrites.join('');
    expect(out).toContain('value=forty-two');
    expect(out).toContain('nested');
  });
});
