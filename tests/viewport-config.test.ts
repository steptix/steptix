/**
 * The `## Config: viewport:` resolver (stories/per-test-viewport.md §1/§10).
 *
 * This is the one validator the CLI, the server and MCP all share, so its
 * behaviour is the feature's contract rather than an implementation detail.
 * Every refusal below asserts the offending value appears in the message: an
 * author staring at `Invalid viewport` with fifteen test files open learns
 * nothing, and that is the failure mode §1 spends a bullet on.
 *
 * The parser half is here too — the `## Config` scan is generic, so what needs
 * proving is not that a key-value pair parses but that `${env.X}` reaches this
 * value before validation does (§1: "validation runs on the resolved string").
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { loadConfig } from '../src/config/loader.js';
import {
  MAX_VIEWPORT_DIMENSION,
  MIN_VIEWPORT_DIMENSION,
  VIEWPORT_PRESETS,
  describeViewportSource,
  formatViewport,
  resolveViewportSpec,
  viewportCdpConflictError,
} from '../src/config/viewport.js';
import { parseTestFile } from '../src/parser/markdown.js';

describe('resolveViewportSpec — presets (§1)', () => {
  it('resolves the three named sizes', () => {
    expect(resolveViewportSpec('mobile')).toEqual({ width: 390, height: 844 });
    expect(resolveViewportSpec('tablet')).toEqual({ width: 768, height: 1024 });
    expect(resolveViewportSpec('desktop')).toEqual({ width: 1440, height: 900 });
  });

  it('hands back a COPY, so one test cannot resize the preset for the next', () => {
    // The presets are module-level and every run in a long-lived server reads
    // the same object. Returning it directly would let a single mutation
    // downstream change what `mobile` means for every session after it.
    const first = resolveViewportSpec('mobile')!;
    first.width = 1;
    expect(resolveViewportSpec('mobile')).toEqual({ width: 390, height: 844 });
    expect(VIEWPORT_PRESETS['mobile']).toEqual({ width: 390, height: 844 });
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(resolveViewportSpec('Mobile')).toEqual({ width: 390, height: 844 });
    expect(resolveViewportSpec('  TABLET  ')).toEqual({ width: 768, height: 1024 });
  });
});

describe('resolveViewportSpec — explicit <width>x<height> (§1)', () => {
  it('resolves positive integers joined by x', () => {
    expect(resolveViewportSpec('390x844')).toEqual({ width: 390, height: 844 });
    // The breakpoint-edge case the explicit form exists for: 767 vs 768.
    expect(resolveViewportSpec('767x1024')).toEqual({ width: 767, height: 1024 });
  });

  it('accepts an upper-case X and surrounding whitespace', () => {
    expect(resolveViewportSpec(' 390X844 ')).toEqual({ width: 390, height: 844 });
  });

  it('refuses the multiplication sign, even though the log prints one', () => {
    // `390×844` is a copy-paste of our own output, not something a keyboard
    // types. One spelling of the key beats two that silently differ.
    expect(() => resolveViewportSpec('390×844')).toThrow(/390×844/);
  });

  it('refuses inner whitespace — the accepted form has none', () => {
    expect(() => resolveViewportSpec('390 x 844')).toThrow(/390 x 844/);
  });

  it('refuses a width with no height', () => {
    // §1's worked example, verbatim.
    expect(() => resolveViewportSpec('390')).toThrow(
      "Invalid '## Config: viewport: 390' — expected a preset " +
        '(mobile | tablet | desktop) or `<width>x<height>` (e.g. `390x844`).',
    );
  });

  it('refuses decimals, negatives and trailing junk', () => {
    for (const bad of ['390.5x844', '-390x844', '390x844px', 'x844', '390x', 'phone']) {
      expect(() => resolveViewportSpec(bad), bad).toThrow(new RegExp(escape(bad)));
    }
  });
});

describe('resolveViewportSpec — bounds (§1)', () => {
  it('accepts both ends of the inclusive range', () => {
    expect(resolveViewportSpec(`${MIN_VIEWPORT_DIMENSION}x${MIN_VIEWPORT_DIMENSION}`)).toEqual({
      width: 100,
      height: 100,
    });
    expect(resolveViewportSpec(`${MAX_VIEWPORT_DIMENSION}x${MAX_VIEWPORT_DIMENSION}`)).toEqual({
      width: 10_000,
      height: 10_000,
    });
  });

  it('refuses a dimension below the floor, on either axis', () => {
    expect(() => resolveViewportSpec('99x844')).toThrow(/99x844/);
    expect(() => resolveViewportSpec('390x99')).toThrow(/390x99/);
  });

  it('refuses a dimension above the ceiling, on either axis', () => {
    expect(() => resolveViewportSpec('10001x844')).toThrow(/10001x844/);
    expect(() => resolveViewportSpec('390x10001')).toThrow(/390x10001/);
  });

  it('says WHY a well-formed value was refused', () => {
    // `50x50` IS `<width>x<height>`, so the base sentence alone reads like a
    // parser bug. The accepted forms are still listed — the story's
    // requirement — with the range appended.
    const message = attemptError('50x50');
    expect(message).toContain("Invalid '## Config: viewport: 50x50'");
    expect(message).toContain('`<width>x<height>`');
    expect(message).toContain('between 100 and 10000');
  });
});

describe('resolveViewportSpec — absence', () => {
  it('an absent key is undefined, not an error', () => {
    // The no-viewport path has to stay byte-for-byte today's behaviour (§2),
    // and that starts with the resolver not throwing at every call site that
    // has nothing to resolve.
    expect(resolveViewportSpec(undefined)).toBeUndefined();
  });

  it('a present-but-blank key is treated as absent, like `cdp:`', () => {
    expect(resolveViewportSpec('')).toBeUndefined();
    expect(resolveViewportSpec('   ')).toBeUndefined();
  });
});

describe('every refusal names the offending value (§10)', () => {
  for (const bad of ['390', 'phone', '390×844', '50x50', '99999x99999', 'MOBILEE']) {
    it(`names ${JSON.stringify(bad)}`, () => {
      expect(attemptError(bad)).toContain(bad);
    });
  }

  it('and lists the accepted forms every time', () => {
    for (const bad of ['390', 'phone', '50x50']) {
      const message = attemptError(bad);
      expect(message, bad).toContain('mobile | tablet | desktop');
      expect(message, bad).toContain('`390x844`');
    }
  });
});

describe('viewportCdpConflictError (§1)', () => {
  it('names both keys, so the author knows which two lines to look at', () => {
    const message = viewportCdpConflictError('mobile', '9222');
    expect(message).toContain("'## Config: viewport: mobile'");
    expect(message).toContain("'## Config: cdp: 9222'");
  });
});

describe('log helpers (§4)', () => {
  it('formats the size with the display ×', () => {
    expect(formatViewport({ width: 390, height: 844 })).toBe('390×844');
  });

  it('attributes a test-declared size to the test, a pinned one to the project', () => {
    // The parenthetical is the half that stops `390×844` being ambiguous
    // between "this test asked for it" and "the whole project is pinned" (§8).
    expect(describeViewportSource('mobile')).toBe('mobile, from test config');
    expect(describeViewportSource('  390x844 ')).toBe('390x844, from test config');
    expect(describeViewportSource(undefined)).toBe('from project config');
  });
});

// ---------------------------------------------------------------------------
// Parser (§10)
// ---------------------------------------------------------------------------

const tmpRoots: string[] = [];

afterAll(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeTest(body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'aiui-viewport-'));
  tmpRoots.push(dir);
  const file = path.join(dir, 'viewport.md');
  writeFileSync(file, body, 'utf8');
  return file;
}

describe('parser — ${env.X} reaches the viewport value before validation does', () => {
  it('interpolates the Config value, and the resolver sees the RESOLVED string', async () => {
    // §1 promises `viewport: ${env.VIEWPORT}` works with no new code, because
    // Config values are already interpolated. The assertion that matters is the
    // second one: an implementation that validated the literal would refuse
    // `${env.VIEWPORT}` as unparseable and this feature would be unusable from
    // a `.env`.
    const file = writeTest(
      '# Interpolated viewport\n\n## Config\n- viewport: ${env.VIEWPORT}\n\n## Steps\n1. Open the home page\n',
    );
    const parsed = await parseTestFile(file, {
      envData: { env: { VIEWPORT: 'mobile' }, data: {} },
    });

    expect(parsed.config.viewport).toBe('mobile');
    expect(resolveViewportSpec(parsed.config.viewport)).toEqual({ width: 390, height: 844 });
  });
});

// ---------------------------------------------------------------------------
// The project-wide pin (§8)
// ---------------------------------------------------------------------------

describe('browser.fixedViewport in aiui.config.json (§8)', () => {
  it('is absent by default — absence stays absence through deepMerge', async () => {
    // Deliberately NOT in defaults.ts, the same treatment as
    // `server.idleTimeoutMinutes`: a default would make every launch take the
    // fixed-viewport path, which is the opposite of "byte-for-byte today's
    // behaviour when nobody asked" (§2).
    const config = await loadConfig();
    expect(config.browser.fixedViewport).toBeUndefined();
  });

  it('survives the loader with its siblings intact', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiui-viewport-cfg-'));
    tmpRoots.push(dir);
    const file = path.join(dir, 'aiui.config.json');
    writeFileSync(file, JSON.stringify({ browser: { fixedViewport: { width: 390, height: 844 } } }), 'utf8');

    const config = await loadConfig(file);
    expect(config.browser.fixedViewport).toEqual({ width: 390, height: 844 });
    // deepMerge keeps the other browser defaults rather than dropping them.
    expect(config.browser.headed).toBe(true);
    expect(config.browser.viewport).toEqual({ width: 1440, height: 900 });
  });
});

describe('aiui.config.schema.json — browser.fixedViewport', () => {
  // The schema is a committed artifact regenerated by `npm run build:schema`
  // (part of `npm run build`). These assertions fail if it was not re-run —
  // which is the only signal a reader gets that the editor's autocomplete and
  // the code have drifted apart.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let validate: any;

  beforeAll(async () => {
    const schemaText = await readFile(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../schema/aiui.config.schema.json'),
      'utf8',
    );
    const ajv = new Ajv({ strict: false, allErrors: true });
    validate = ajv.compile(JSON.parse(schemaText));
  });

  it('accepts a complete size', () => {
    expect(validate({ browser: { fixedViewport: { width: 390, height: 844 } } })).toBe(true);
  });

  it('rejects a half-specified one', () => {
    // A width with no height is not a viewport, and the editor should say so
    // rather than leaving it to a run.
    expect(validate({ browser: { fixedViewport: { width: 390 } } })).toBe(false);
  });

  it('rejects a preset NAME here — this key is the resolved size, not the spec', () => {
    // `viewport: mobile` is a test-file key; `browser.fixedViewport` is the
    // project pin and takes numbers. Conflating them is the likeliest
    // hand-edit mistake, so the schema catches it.
    expect(validate({ browser: { fixedViewport: 'mobile' } })).toBe(false);
  });
});

/** The message a refusal carried, or a failure if there wasn't one. */
function attemptError(raw: string): string {
  try {
    resolveViewportSpec(raw);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error(`expected ${JSON.stringify(raw)} to be refused, but it resolved`);
}

/** Escape a raw value for use inside a RegExp — the bad inputs include `.` and
 *  `-`, which would otherwise match more than themselves. */
function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
