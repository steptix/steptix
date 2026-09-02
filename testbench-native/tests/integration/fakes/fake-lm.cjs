/**
 * FakeLm — drop-in for the `vscode.lm` namespace, injected through
 * `__testHooks.configureLmBridge` (the FakeApiClient pattern).
 *
 * The real namespace cannot be driven from a test: `selectChatModels` needs a
 * signed-in Copilot seat, `sendRequest` spends it, and the first call raises a
 * consent dialog that would sit on screen for the rest of the suite. What is
 * substituted here is the NAMESPACE only — every rule about what goes on the
 * wire still runs for real.
 *
 * See tests/integration/suite/lm-bridge.test.cjs.
 */

/** A `vscode.LanguageModelError`-alike: what the bridge's mapper reads is `code`. */
class FakeLmError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LanguageModelError';
    this.code = code;
  }
}

class FakeLm {
  constructor() {
    /** Models this "seat" offers, as {id, vendor, family, name}. */
    this.models = [
      { id: 'gpt-4.1', vendor: 'copilot', family: 'gpt-4.1', name: 'GPT-4.1' },
      { id: 'claude-sonnet-4', vendor: 'copilot', family: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
    ];
    /** False makes the bridge answer as an older host would. */
    this.isAvailable = true;
    /** Text fragments the next sendRequest yields, in order. */
    this.reply = ['{"entry":', '"ok"}'];
    /** When set, sendRequest rejects with it instead of replying. */
    this.failWith = null;
    /** Every sendRequest: { messages, options }. */
    this.requests = [];
    /** Every selector selectChatModels was called with, in order. */
    this.selectors = [];
  }

  /** Reject the next request the way a revoked consent does. */
  denyConsent(message = 'Permission denied') {
    this.failWith = new FakeLmError('NoPermissions', message);
  }

  /** Reject the way an exhausted seat does (the API's documented code). */
  exhaustQuota(message = 'Quota exceeded') {
    this.failWith = new FakeLmError('Blocked', message);
  }

  available() {
    return this.isAvailable;
  }

  async selectChatModels(selector) {
    this.selectors.push(selector ?? null);
    const matches = this.models.filter(
      (m) =>
        (selector?.id === undefined || selector.id === m.id) &&
        (selector?.vendor === undefined || selector.vendor === m.vendor) &&
        (selector?.family === undefined || selector.family === m.family),
    );
    return matches.map((m) => this.handleFor(m));
  }

  handleFor(model) {
    const fake = this;
    return {
      id: model.id,
      vendor: model.vendor,
      family: model.family,
      name: model.name,
      async sendRequest(messages, options) {
        fake.requests.push({ model: model.id, messages, options });
        if (fake.failWith) {
          const err = fake.failWith;
          fake.failWith = null;
          throw err;
        }
        const fragments = fake.reply;
        return (async function* () {
          for (const fragment of fragments) yield fragment;
        })();
      },
    };
  }
}

module.exports = { FakeLm, FakeLmError };
