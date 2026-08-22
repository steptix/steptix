/**
 * FakeApiClient — drop-in for the runner-core ApiClient that lets tests
 * script the event stream a step batch produces. The RunController treats
 * it identically to the real client (calls streamSteps, iterates events,
 * checks AbortSignal); the test pushes events on demand to simulate
 * step:start / step:pass / breakpoint pauses / etc.
 *
 * Used via the test-only `__testHooks.setApiClientFactory` exported by
 * the extension activate(). See state-machine.test.cjs for usage.
 */
const { ApiClientError } = require('ai-ui-automation-runner-core');

class FakeApiClient {
  constructor() {
    /** @type {Stream | null} */
    this.activeStream = null;
    this.closeSessionCalls = 0;
    /** Session ids passed to closeSession(), in call order. Lets tests assert
     *  WHICH session was closed (e.g. a batch's unique `<path>::run-N`). */
    this.closeSessionIds = [];
    this.streamCallCount = 0;
    /** Session ids passed to streamSteps() (the run), in call order. Lets tests
     *  assert batch runs use distinct, unique-per-run session ids. */
    this.streamSessionIds = [];
    /** Each entry is the request body passed to streamSteps(). Tests can
     *  read `requests[n].sourceLines` to verify which steps a particular
     *  call covered (e.g. that Resume sent multiple steps, not one). */
    this.requests = [];
    /** Pre-scripted per-stream event flows. Each entry is an async function
     *  that receives this fake and is invoked exactly when streamSteps is
     *  called for that stream index. Avoids polling races. */
    this.streamScripts = [];
    /** Phase 3 — each call to runControl is appended here as
     *  { sessionId, mode, opts? }. Tests assert against this to check the
     *  extension dispatches Step Into / Over / Out with the right modes.
     *  `opts` carries Phase 5 fields like pauseAtNextTool. */
    this.runControlCalls = [];
    /** Phase 5 — each call to ackToolDebugger. */
    this.ackToolDebuggerCalls = [];
    /** "Re-run a skill step" liveness probe. `isSessionAlive` returns this by
     *  default; a test flips it to false to exercise the refusal path. Each
     *  call's sessionId is recorded so tests can assert the pre-flight ran. */
    this.sessionAlive = true;
    this.isSessionAliveCalls = [];
    /** issue 021 — getLastRun poll. Calls recorded here; result configurable. */
    this.getLastRunCalls = [];
    this.lastRunResult = {
      finalized: true,
      tokens: { total: 42, input: 30, output: 12 },
      reportPath: '/tmp/stopped-report.html',
    };
    /** Optional scripted sequence to exercise the not-finalized-then-finalized race. */
    this.lastRunSequence = null;
    /** Each compile request body passed to compileCodeBehind(), in call order. */
    this.compileRequests = [];
    /**
     * What the next compile streams. Replaced per test. The default is a green
     * one-file compile, which is the shape every caller has to handle; a test
     * that wants a red one sets its own.
     */
    this.compileEvents = null;
    /** Set to an ApiClientError kind to make the next compile throw. */
    this.compileThrows = null;
  }

  /** Liveness probe used by the re-run pre-flight (GET /sessions/:id). */
  async isSessionAlive(sessionId) {
    this.isSessionAliveCalls.push({ sessionId });
    return this.sessionAlive;
  }

  /**
   * issue 021: last-run info poll (GET /sessions/:id/last-run). Each call is
   * recorded. By default returns finalized info immediately; tests can set
   * `lastRunSequence` to an array of results to script the race (e.g. a couple
   * of {finalized:false} then a finalized one). When the sequence is exhausted
   * the last entry repeats.
   */
  async getLastRun(sessionId) {
    this.getLastRunCalls.push({ sessionId });
    if (this.lastRunSequence && this.lastRunSequence.length > 0) {
      const i = Math.min(this.getLastRunCalls.length - 1, this.lastRunSequence.length - 1);
      return this.lastRunSequence[i];
    }
    return this.lastRunResult;
  }

  /**
   * Async generator matching ApiClient.streamSteps. Yields whatever events
   * tests push() onto the active stream, or throws an aborted-kind
   * ApiClientError when the caller aborts.
   */
  async *streamSteps(sessionId, request, signal) {
    this.streamSessionIds.push(sessionId);
    /** @type {Stream} */
    const stream = {
      queue: [],
      waiters: [],
      ended: false,
      aborted: false,
    };
    this.activeStream = stream;
    const idx = this.streamCallCount;
    this.streamCallCount += 1;
    this.requests.push(request);

    // Fire any pre-scripted event flow for this stream index. Fire-and-
    // forget — the script pushes events and (usually) calls fake.end()
    // asynchronously, while this generator yields events to the consumer.
    const script = this.streamScripts[idx];
    if (script) {
      Promise.resolve().then(() => script(this)).catch(() => undefined);
    }

    const onAbort = () => {
      stream.aborted = true;
      const w = stream.waiters.shift();
      if (w) w.resolve();
    };
    if (signal.aborted) {
      this.activeStream = null;
      throw new ApiClientError('aborted', 'aborted');
    }
    signal.addEventListener('abort', onAbort);

    try {
      while (true) {
        if (stream.aborted) {
          throw new ApiClientError('aborted', 'aborted');
        }
        if (stream.queue.length > 0) {
          yield stream.queue.shift();
          continue;
        }
        if (stream.ended) return;
        // Wait for push() / end() / abort.
        await new Promise((resolve) => {
          stream.waiters.push({ resolve });
        });
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (this.activeStream === stream) this.activeStream = null;
    }
  }

  /**
   * Async generator matching ApiClient.compileCodeBehind. Streams whatever
   * `compileEvents` holds and finishes — a compile is not interactive, so
   * unlike streamSteps there is nothing for a test to push mid-flight.
   */
  async *compileCodeBehind(request, signal) {
    this.compileRequests.push(request);
    if (this.compileThrows) {
      throw new ApiClientError(this.compileThrows, `fake compile error: ${this.compileThrows}`);
    }
    const events = this.compileEvents ?? [
      { type: 'compile:phase', phase: 'select', message: '1 step(s) to generate, 0 kept, 0 already AI' },
      { type: 'compile:phase', phase: 'record', message: 'running 1 step(s) under AI' },
      { type: 'compile:step', phase: 'generate', step: 1, message: 'generated' },
      { type: 'compile:phase', phase: 'replay', round: 1, message: '1/1 passed as code' },
      { type: 'compile:done', status: 'green', message: 'Compiled' },
      {
        type: 'compile:result',
        status: 'green',
        files: {},
        summary: {
          test: request.testFilePath,
          totalSteps: 1,
          compiled: 1,
          kept: 0,
          keptAi: 0,
          rounds: 1,
          tokensUsed: 1234,
          written: [],
        },
      },
    ];
    for (const event of events) {
      if (signal.aborted) throw new ApiClientError('aborted', 'aborted');
      yield event;
    }
  }

  async closeSession(sessionId) {
    this.closeSessionCalls += 1;
    this.closeSessionIds.push(sessionId);
    if (this.closeSessionImpl) {
      await this.closeSessionImpl(sessionId);
    }
  }

  /**
   * Phase 3 — server delivers step-control via POST /sessions/:id/run-control.
   * The fake records each call so tests can assert the extension's
   * stepInto/stepOver/stepOut commands fire it with the right mode.
   * Default implementation is a no-op; tests can replace it with one
   * that drives the next event push.
   */
  async runControl(sessionId, mode, opts) {
    this.runControlCalls.push({ sessionId, mode, opts: opts ?? null });
    if (this.runControlImpl) {
      await this.runControlImpl(sessionId, mode, opts);
    }
  }

  /**
   * Phase 5 — extension calls this after VS Code's Node debugger has
   * attached in response to a tool:awaiting-debugger event. Records the
   * call so tests can assert the ack flow fired in the right order.
   */
  async ackToolDebugger(sessionId) {
    this.ackToolDebuggerCalls.push({ sessionId });
    if (this.ackToolDebuggerImpl) {
      await this.ackToolDebuggerImpl(sessionId);
    }
  }

  // -------------------- Test-driving API --------------------

  /** Push the next event the consumer will see. */
  push(event) {
    const stream = this.activeStream;
    if (!stream) throw new Error('FakeApiClient: push() called with no active stream');
    stream.queue.push(event);
    const w = stream.waiters.shift();
    if (w) w.resolve();
  }

  /** Mark the stream as complete — consumer's for-await loop ends cleanly. */
  end() {
    const stream = this.activeStream;
    if (!stream) return;
    stream.ended = true;
    const w = stream.waiters.shift();
    if (w) w.resolve();
  }

  get hasActiveStream() {
    return this.activeStream !== null;
  }
}

/**
 * @typedef {Object} Stream
 * @property {Array<unknown>} queue
 * @property {Array<{ resolve: () => void }>} waiters
 * @property {boolean} ended
 * @property {boolean} aborted
 */

module.exports = { FakeApiClient };
