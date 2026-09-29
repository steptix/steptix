/**
 * FakeLm — drop-in for the `vscode.lm` namespace, injected through
 * `__testHooks.configureLmBridge({ lm })` (the FakeApiClient pattern).
 *
 * The real namespace cannot be driven from a test: `selectChatModels` needs a
 * signed-in Copilot seat, `sendRequest` spends it, and the first call raises a
 * consent dialog that would sit on screen for the rest of the suite. What is
 * substituted here is the NAMESPACE only — every rule about what goes on the
 * wire still runs for real, including the bridge's own `vscode` layer: the
 * models this returns are shaped like `vscode.LanguageModelChat`, so what
 * `sendRequest` and `countTokens` receive are the real
 * `vscode.LanguageModelChatMessage` objects the bridge built, text parts,
 * data parts and all.
 *
 * See tests/integration/suite/lm-bridge.test.cjs.
 */
const vscode = require('vscode');

/** A `vscode.LanguageModelError`-alike: what the bridge's mapper reads is `code`. */
class FakeLmError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LanguageModelError';
    this.code = code;
  }
}

/**
 * `vscode.LanguageModelDataPart` for a host that predates it — the harness's
 * VS Code is 1.95, which has none. Same fields as the real class (`mimeType`,
 * `data`), and `image` has the real signature, so it can be handed to the
 * bridge as its image-part factory: `configureLmBridge({ imagePart: FakeDataPart.image })`.
 */
class FakeDataPart {
  constructor(data, mimeType) {
    this.data = data;
    this.mimeType = mimeType;
  }
  static image(data, mime) {
    return new FakeDataPart(data, mime);
  }
}

/** A data part from either class: the host's real one, or {@link FakeDataPart}. */
function isDataPart(part) {
  return (
    part instanceof FakeDataPart ||
    (typeof vscode.LanguageModelDataPart === 'function' && part instanceof vscode.LanguageModelDataPart)
  );
}

function roleName(message) {
  return message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
}

/** A message's content as an array, whatever the host's shape for it. */
function contentOf(message) {
  return typeof message.content === 'string' ? [new vscode.LanguageModelTextPart(message.content)] : message.content;
}

/**
 * A recorded `vscode.LanguageModelChatMessage`, as plain data a test can
 * `deepEqual`: `{role, text}` for a text-only message (what the bridge has
 * always sent), `{role, parts}` once a data part is in it — each image as
 * `{image: {mime, base64}}` so the exact bytes are compared.
 */
function plain(message) {
  const content = contentOf(message);
  const role = roleName(message);
  if (content.every((p) => p instanceof vscode.LanguageModelTextPart)) {
    return { role, text: content.map((p) => p.value).join('') };
  }
  return {
    role,
    parts: content.map((p) =>
      p instanceof vscode.LanguageModelTextPart
        ? { text: p.value }
        : isDataPart(p)
          ? { image: { mime: p.mimeType, base64: Buffer.from(p.data).toString('base64') } }
          : { unknown: String(p?.constructor?.name) },
    ),
  };
}

class FakeLm {
  constructor() {
    /** Models this "seat" offers, as {id, vendor, family, name, capabilities?}.
     *  No `capabilities` by default — the 1.95 consumer object has none, so
     *  `image_input` is null. Set `capabilities: { supportsImageToText }` (the
     *  1.138 shape) or `{ imageInput }` to model a host that says. */
    this.models = [
      { id: 'gpt-4.1', vendor: 'copilot', family: 'gpt-4.1', name: 'GPT-4.1' },
      { id: 'claude-sonnet-4', vendor: 'copilot', family: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
    ];
    /** False makes the bridge answer as an older host would: `selectChatModels` goes missing. */
    this.isAvailable = true;
    /** Text fragments the next sendRequest yields, in order. */
    this.reply = ['{"entry":', '"ok"}'];
    /** When set, sendRequest rejects with it instead of replying. */
    this.failWith = null;
    /**
     * How a text-only model answers a request carrying a data part: `false`
     * (it does not — accepts it), `'send'` (sendRequest rejects), or `'stream'`
     * (the response starts, then the stream errors). Both are plain `Error`s,
     * not a LanguageModelError code: nothing documents what a provider throws
     * for an image it cannot read, which is the case the bridge has to handle.
     */
    this.rejectImages = false;
    this.imageRejectionMessage = 'Request Failed: 400 This model does not support image input';
    /** Every sendRequest: { model, messages, options } — messages are the real vscode objects. */
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

  /**
   * `vscode.lm.selectChatModels`, or `undefined` while `isAvailable` is false
   * — which is what a host below the 1.90 floor looks like to the bridge's
   * `available()` check.
   */
  get selectChatModels() {
    if (!this.isAvailable) return undefined;
    return async (selector) => {
      this.selectors.push(selector ?? null);
      const matches = this.models.filter(
        (m) =>
          (selector?.id === undefined || selector.id === m.id) &&
          (selector?.vendor === undefined || selector.vendor === m.vendor) &&
          (selector?.family === undefined || selector.family === m.family),
      );
      return matches.map((m) => this.chatFor(m));
    };
  }

  /** The last request's messages as plain data; see {@link plain}. */
  sentMessages(index = this.requests.length - 1) {
    return this.requests[index].messages.map(plain);
  }

  /** A `vscode.LanguageModelChat`-shaped object for one model. */
  chatFor(model) {
    const fake = this;
    return {
      id: model.id,
      vendor: model.vendor,
      family: model.family,
      name: model.name,
      version: '1',
      maxInputTokens: 128_000,
      ...(model.capabilities !== undefined && { capabilities: model.capabilities }),
      /**
       * Deliberately NOT a constant: 1 token per 4 characters plus 4 for a
       * message's role framing, mirroring the real tokenizer's measured shape.
       * A fake returning the same number for prompt and completion could not
       * catch the two being wired up the wrong way round.
       *
       * Throws on a data part, as a tokenizer that only knows text might: the
       * bridge promises to count text parts only, and a served completion with
       * measured (non-zero) usage is the proof it kept that promise.
       */
      async countTokens(input) {
        fake.counted.push(input);
        if (fake.countTokensHangs) return new Promise(() => {});
        if (fake.countTokensFailsWith && fake.counted.length > fake.countTokensFailsAfter) {
          throw fake.countTokensFailsWith;
        }
        if (typeof input === 'string') return Math.ceil(input.length / 4);
        const content = contentOf(input);
        if (content.some((p) => !(p instanceof vscode.LanguageModelTextPart))) {
          throw new Error('fake tokenizer: countTokens was given a non-text part');
        }
        const text = content.map((p) => p.value).join('');
        return Math.ceil(text.length / 4) + 4;
      },
      async sendRequest(messages, options, _token) {
        fake.requests.push({ model: model.id, messages, options });
        if (fake.failWith) {
          const err = fake.failWith;
          fake.failWith = null;
          throw err;
        }
        const carriesImage = messages.some((m) => contentOf(m).some(isDataPart));
        if (carriesImage && fake.rejectImages === 'send') {
          throw new Error(fake.imageRejectionMessage);
        }
        const fragments = fake.reply;
        const failMidStream = carriesImage && fake.rejectImages === 'stream';
        const text = (async function* () {
          for (const fragment of fragments) {
            yield fragment;
            if (failMidStream) throw new Error(fake.imageRejectionMessage);
          }
        })();
        return { text, stream: text };
      },
    };
  }
}

module.exports = { FakeLm, FakeLmError, FakeDataPart, plain };
