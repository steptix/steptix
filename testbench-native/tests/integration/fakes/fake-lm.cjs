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
    /** Every input countTokens was called with, in order. */
    this.counted = [];
    /** When set, countTokens rejects with it — the usage-unavailable path. */
    this.countTokensFailsWith = null;
    /** When true, countTokens never settles — the wedged-tokenizer case the
     *  bridge bounds with MEASURE_BUDGET_MS. */
    this.countTokensHangs = false;
    /** Let this many countTokens calls succeed before failing. 0 = fail the
     *  first. Failing only the LAST call is what catches a try/catch narrowed
     *  to the prompt loop, leaving the response count outside it. */
    this.countTokensFailsAfter = 0;
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
      /**
       * Deliberately NOT a constant: 1 token per 4 characters plus 4 for a
       * message's role framing, mirroring the real tokenizer's measured shape.
       * A fake returning the same number for prompt and completion could not
       * catch the two being wired up the wrong way round.
       */
      async countTokens(input) {
        fake.counted.push(input);
        if (fake.countTokensHangs) return new Promise(() => {});
        if (fake.countTokensFailsWith && fake.counted.length > fake.countTokensFailsAfter) {
          throw fake.countTokensFailsWith;
        }
        const text = typeof input === 'string' ? input : input.text;
        const framing = typeof input === 'string' ? 0 : 4;
        return Math.ceil(text.length / 4) + framing;
      },
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
