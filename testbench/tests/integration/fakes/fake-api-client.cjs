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
    this.streamCallCount = 0;
    /** Each entry is the request body passed to streamSteps(). Tests can
     *  read `requests[n].sourceLines` to verify which steps a particular
     *  call covered (e.g. that Resume sent multiple steps, not one). */
    this.requests = [];
    /** Pre-scripted per-stream event flows. Each entry is an async function
     *  that receives this fake and is invoked exactly when streamSteps is
     *  called for that stream index. Avoids polling races. */
    this.streamScripts = [];
  }

  /**
   * Async generator matching ApiClient.streamSteps. Yields whatever events
   * tests push() onto the active stream, or throws an aborted-kind
   * ApiClientError when the caller aborts.
   */
  async *streamSteps(_sessionId, request, signal) {
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

  async closeSession(sessionId) {
    this.closeSessionCalls += 1;
    if (this.closeSessionImpl) {
      await this.closeSessionImpl(sessionId);
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
