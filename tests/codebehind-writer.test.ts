import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createFile,
  spliceEntry,
  stampSection,
  findEntrySpans,
  formatCodeBehindSource,
  writeCodeBehindEntry,
} from '../src/codebehind/writer.js';
import { scan } from '../src/codebehind/tokenizer.js';

/**
 * The writer's job is to change one entry and nothing else, and to never
 * leave a file it broke (stories/step-codebehind.md, "The writer").
 *
 * The hazards these cases pin: braces inside strings, template literals,
 * comments and regexes elsewhere in the file (naive brace-matching splices
 * the wrong span), and a generation that doesn't compile (the file must come
 * back byte-for-byte).
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(repoRoot, 'tests', '.tmp-codebehind-writer');

let counter = 0;
let dir: string;

beforeEach(async () => {
  dir = path.join(tmpBase, `t${counter++}`);
  await fs.mkdir(dir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpBase, { recursive: true, force: true });
});

/** A file with every brace hazard sprinkled around the entry to be replaced. */
const HAZARDOUS = `import { defineSteps } from 'ai-ui-automation/codebehind';

// A hand-written helper. Its braces { } must survive untouched: "} ] )"
function money(text) {
  const cleaned = text.replace(/[^0-9.{}]/g, '');
  const label = \`total: \${'{'} \${cleaned} \${'}'}\`;
  /* block comment with a stray } and a ' quote */
  return { value: Number(cleaned), label };
}

export default defineSteps([
  {
    source: 'Open the cart',
    async run({ page }) {
      await page.locator('#cart').click();
    },
  },
  {
    source: 'Read the total',
    async run({ page, step }) {
      // a comment containing } and 'quotes'
      const raw = await page.locator('#total').innerText();
      step.setVar('total', String(money(raw).value));
    },
  },
]);
`;

describe('code-behind writer — locating an entry', () => {
  it('finds the entry span past braces in strings, templates, comments and regexes', () => {
    const spans = findEntrySpans(scan(HAZARDOUS), 'Read the total', undefined);
    expect(spans).toHaveLength(1);
    const text = HAZARDOUS.slice(spans[0]!.start, spans[0]!.end);
    expect(text.startsWith('{')).toBe(true);
    expect(text.endsWith('}')).toBe(true);
    expect(text).toContain("source: 'Read the total'");
    expect(text).not.toContain('function money');
    expect(text).not.toContain('Open the cart');
  });

  it('does not mistake a repeat of the step text inside a run body for the entry', () => {
    const src = `import { defineSteps } from 'ai-ui-automation/codebehind';
export default defineSteps([
  {
    source: 'Click Pay now',
    async run({ page }) {
      await page.getByText('Click Pay now').click();
    },
  },
]);
`;
    expect(findEntrySpans(scan(src), 'Click Pay now', undefined)).toHaveLength(1);
  });

  it('separates same-text entries by their section scope', () => {
    const src = `import { defineSteps } from 'ai-ui-automation/codebehind';
export default defineSteps([
  { source: 'Click Next', async run() { /* main flow */ } },
  { section: 'Checkout', source: 'Click Next', async run() { /* scoped */ } },
]);
`;
    const s = scan(src);
    const main = findEntrySpans(s, 'Click Next', undefined);
    const scoped = findEntrySpans(s, 'Click Next', 'Checkout');
    expect(main).toHaveLength(1);
    expect(scoped).toHaveLength(1);
    expect(src.slice(main[0]!.start, main[0]!.end)).toContain('main flow');
    expect(src.slice(scoped[0]!.start, scoped[0]!.end)).toContain('scoped');
    // `matchText` on the scope: casing and a [no-hooks] prefix don't matter.
    expect(findEntrySpans(s, 'Click Next', 'checkout')).toHaveLength(1);
  });
});

describe('code-behind writer — splice', () => {
  it('replaces only the target entry and leaves hand-written code byte-for-byte', () => {
    const { text, action } = spliceEntry(HAZARDOUS, {
      file: 'x.steps.ts',
      source: 'Read the total',
      occurrence: 0,
      entryCode: `{
  source: 'Read the total',
  async run({ page, step }) {
    step.setVar('total', await page.locator('#total').innerText());
  },
}`,
    });

    expect(action).toBe('replaced');
    // The helper, its regex, its template literal and its comments are
    // untouched — compared as a whole block, not by fragments.
    const helper = HAZARDOUS.slice(HAZARDOUS.indexOf('// A hand-written'), HAZARDOUS.indexOf('export default'));
    expect(text).toContain(helper);
    // The sibling entry is untouched.
    expect(text).toContain(`    source: 'Open the cart',`);
    // The target's old body is gone, the new one is in.
    expect(text).not.toContain('const raw = await page');
    expect(text).toContain(`step.setVar('total', await page.locator('#total').innerText());`);
    // Still one entry with this source, and the array still closes.
    expect(findEntrySpans(scan(text), 'Read the total', undefined)).toHaveLength(1);
    expect(text.trimEnd().endsWith(']);')).toBe(true);
  });

  it('replaces the nth duplicate, by occurrence', () => {
    const src = `import { defineSteps } from 'ai-ui-automation/codebehind';
export default defineSteps([
  { source: 'Click Next', async run() { /* first */ } },
  { source: 'Click Next', async run() { /* second */ } },
]);
`;
    const { text } = spliceEntry(src, {
      file: 'x.steps.ts',
      source: 'Click Next',
      occurrence: 1,
      entryCode: `{ source: 'Click Next', async run() { /* replaced-second */ } }`,
    });
    expect(text).toContain('/* first */');
    expect(text).not.toContain('/* second */');
    expect(text).toContain('/* replaced-second */');
  });

  it('appends before the closing `])` when the entry is new', () => {
    const { text, action } = spliceEntry(HAZARDOUS, {
      file: 'x.steps.ts',
      source: 'Click Pay now',
      occurrence: 0,
      entryCode: `{
  source: 'Click Pay now',
  async run({ page }) {
    await page.locator('[data-testid="pay-now"]').click();
  },
}`,
    });
    expect(action).toBe('appended');
    expect(text).toContain(`    source: 'Read the total',`);
    const payAt = text.indexOf("source: 'Click Pay now'");
    const totalAt = text.indexOf("source: 'Read the total'");
    expect(payAt).toBeGreaterThan(totalAt);
    expect(text.trimEnd().endsWith(']);')).toBe(true);
    expect(findEntrySpans(scan(text), 'Click Pay now', undefined)).toHaveLength(1);
  });

  it('appends into an empty array', () => {
    const empty = `import { defineSteps } from 'ai-ui-automation/codebehind';

export default defineSteps([
]);
`;
    const { text } = spliceEntry(empty, {
      file: 'x.steps.ts',
      source: 'Alpha',
      occurrence: 0,
      entryCode: `{ source: 'Alpha', async run() {} }`,
    });
    expect(findEntrySpans(scan(text), 'Alpha', undefined)).toHaveLength(1);
    expect(text.trimEnd().endsWith(']);')).toBe(true);
  });
});

describe('code-behind writer — section stamping', () => {
  it('stamps the runner\'s scope onto an entry that had none', () => {
    const out = stampSection(`{ source: 'Click Pay now', async run() {} }`, 'Checkout');
    expect(out).toContain(`section: "Checkout"`);
    expect(findEntrySpans(scan(`export default defineSteps([\n${out},\n]);`), 'Click Pay now', 'Checkout'))
      .toHaveLength(1);
  });

  it('overrides a scope the model invented — scope is never the model\'s to choose', () => {
    const out = stampSection(
      `{\n  section: 'WrongGuess',\n  source: 'Click Pay now',\n  async run() {},\n}`,
      'Checkout',
    );
    expect(out).toContain('"Checkout"');
    expect(out).not.toContain('WrongGuess');
  });

  it('strips a model-invented scope when the step has none', () => {
    const out = stampSection(
      `{\n  section: 'WrongGuess',\n  source: 'Click Pay now',\n  async run() {},\n}`,
      undefined,
    );
    expect(out).not.toContain('section');
    expect(out).toContain(`source: 'Click Pay now'`);
  });

  it('trims trailing commas and anything after the entry', () => {
    expect(stampSection(`{ source: 'A', async run() {} },`, undefined))
      .toBe(`{ source: 'A', async run() {} }`);
    expect(stampSection(`{ source: 'A', async run() {} }\n// chatter`, undefined))
      .toBe(`{ source: 'A', async run() {} }`);
  });
});

describe('code-behind writer — files on disk', () => {
  it('creates a file from the header template when there is none', async () => {
    const file = path.join(dir, 'booking.steps.ts');
    const action = await writeCodeBehindEntry({
      file,
      source: 'Enter todays date as a 6 digit code in ddmmyy format',
      occurrence: 0,
      markdownFile: path.join(dir, 'booking.md'),
      entryCode: `{
  source: 'Enter todays date as a 6 digit code in ddmmyy format',
  async run({ page }) {
    const d = new Date();
    await page.locator('#booking-code').fill(String(d.getDate()));
  },
}`,
    });

    expect(action).toBe('created');
    const written = await fs.readFile(file, 'utf-8');
    expect(written).toContain('// Generated by ai-ui-automation — code-behind for booking.md.');
    expect(written).toContain(`import { defineSteps } from 'ai-ui-automation/codebehind';`);
    expect(written).toContain('export default defineSteps([');
    expect(written.trimEnd().endsWith(']);')).toBe(true);
    // The created header is what `createFile` produces — no drift between the
    // two paths.
    expect(written).toBe(createFile({
      file,
      source: 'Enter todays date as a 6 digit code in ddmmyy format',
      occurrence: 0,
      markdownFile: path.join(dir, 'booking.md'),
      entryCode: `{
  source: 'Enter todays date as a 6 digit code in ddmmyy format',
  async run({ page }) {
    const d = new Date();
    await page.locator('#booking-code').fill(String(d.getDate()));
  },
}`,
    }));
  });

  it('appends to an existing file, then replaces in place on the next write', async () => {
    const file = path.join(dir, 'x.steps.ts');
    await fs.writeFile(file, HAZARDOUS, 'utf-8');

    expect(await writeCodeBehindEntry({
      file, source: 'Click Pay now', occurrence: 0,
      entryCode: `{ source: 'Click Pay now', async run({ page }) { await page.click('#pay'); } }`,
    })).toBe('appended');

    expect(await writeCodeBehindEntry({
      file, source: 'Click Pay now', occurrence: 0,
      entryCode: `{ source: 'Click Pay now', async run({ page }) { await page.click('#pay-now'); } }`,
    })).toBe('replaced');

    const written = await fs.readFile(file, 'utf-8');
    expect(findEntrySpans(scan(written), 'Click Pay now', undefined)).toHaveLength(1);
    expect(written).toContain("#pay-now");
    expect(written).not.toContain("page.click('#pay')");
    // Never deletes: both original entries are still there.
    expect(findEntrySpans(scan(written), 'Open the cart', undefined)).toHaveLength(1);
    expect(findEntrySpans(scan(written), 'Read the total', undefined)).toHaveLength(1);
  });

  it('restores the previous bytes when the generated code does not compile', async () => {
    const file = path.join(dir, 'x.steps.ts');
    await fs.writeFile(file, HAZARDOUS, 'utf-8');
    const before = await fs.readFile(file);

    await expect(writeCodeBehindEntry({
      file,
      source: 'Read the total',
      occurrence: 0,
      // Braces balance (so the span logic accepts it) but the body is not
      // parseable — exactly the shape a bad generation takes.
      entryCode: `{ source: 'Read the total', async run() { const x = ; } }`,
    })).rejects.toThrow(/did not compile/);

    const after = await fs.readFile(file);
    expect(after.equals(before)).toBe(true);
  });

  it('removes a file it created when the very first entry does not compile', async () => {
    const file = path.join(dir, 'fresh.steps.ts');
    await expect(writeCodeBehindEntry({
      file,
      source: 'Alpha',
      occurrence: 0,
      entryCode: `{ source: 'Alpha', async run() { const x = ; } }`,
    })).rejects.toThrow(/did not compile/);
    await expect(fs.access(file)).rejects.toThrow();
  });
});

describe('formatCodeBehindSource', () => {
  it('turns a one-line entry into code an author would write', async () => {
    const oneLine = [
      "import { defineSteps } from 'ai-ui-automation/codebehind';",
      'export default defineSteps([',
      `  { source: "Enter the code", async run({ page, step, log }) { const code = step.getVar('code'); await page.locator('#code').fill(code); step.expect(await page.locator('#code').inputValue() === code, 'code entered'); } },`,
      ']);',
      '',
    ].join('\n');
    const formatted = await formatCodeBehindSource(oneLine);
    expect(formatted).toBe(
      [
        "import { defineSteps } from 'ai-ui-automation/codebehind';",
        'export default defineSteps([',
        '  {',
        "    source: 'Enter the code',",
        '    async run({ page, step, log }) {',
        "      const code = step.getVar('code');",
        "      await page.locator('#code').fill(code);",
        // Prettier parenthesises the awaited operand — the one change it makes
        // beyond whitespace and quotes, and a clarifying one.
        "      step.expect((await page.locator('#code').inputValue()) === code, 'code entered');",
        '    },',
        '  },',
        ']);',
        '',
      ].join('\n'),
    );
    // Idempotent: formatting the formatted file changes nothing.
    expect(await formatCodeBehindSource(formatted)).toBe(formatted);
  });

  it("follows the project's own Prettier config when the file has one above it", async () => {
    // A project that runs Prettier has a style; the compiled file is theirs
    // and must not churn under their formatter. Double quotes and 60 columns
    // here, against the house single quotes and 100.
    await fs.writeFile(path.join(dir, '.prettierrc'), JSON.stringify({ singleQuote: false, printWidth: 60 }));
    const file = path.join(dir, 'tests', 'checkout.steps.ts');
    const formatted = await formatCodeBehindSource(
      "export default defineSteps([{ source: 'Enter the code', async run({ page }) { await page.locator('#code').fill('x'); } }]);\n",
      file,
    );
    expect(formatted).toContain('source: "Enter the code"');
    expect(formatted).toContain("await page.locator(\"#code\").fill(\"x\");");
    // And without a file to anchor on, the house style stands.
    const house = await formatCodeBehindSource(
      "export default defineSteps([{ source: 'Enter the code', async run({ page }) { await page.locator('#code').fill('x'); } }]);\n",
    );
    expect(house).toContain("source: 'Enter the code'");
  });

  it('hands back code it cannot parse unchanged, for the validator to report', async () => {
    const broken = "export default defineSteps([{ source: 'x', async run() { const y = ; } }]);";
    expect(await formatCodeBehindSource(broken)).toBe(broken);
  });
});
