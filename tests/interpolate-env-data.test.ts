/**
 * Tests for `${env.X}` / `${data.X.Y}` parse-time interpolation.
 *
 * The interpolator is the substitution stage between skill expansion and the
 * existing `{{parameter}}` runtime substitution. These tests cover the
 * surface contract that step authors and the parser depend on.
 */
import { describe, it, expect } from 'vitest';
import {
  interpolateEnvData,
  interpolateEnvDataDeep,
  type EnvDataContext,
} from '../src/parser/interpolate-env-data.js';

const ctx = (overrides: Partial<EnvDataContext> = {}): EnvDataContext => ({
  env: { BASE_URL: 'https://uat.example.com', REGION: 'au' },
  data: {
    users: { admin: { email: 'a@uat.example.com', password: 'pw' } },
    fixtures: { count: 5, currency: 'AUD', tags: ['smoke', 'login'] },
    nullable: null,
  },
  ...overrides,
});

describe('interpolateEnvData — env namespace', () => {
  it('substitutes a single ${env.X} reference', () => {
    expect(interpolateEnvData('Go to ${env.BASE_URL}/admin', ctx())).toBe(
      'Go to https://uat.example.com/admin',
    );
  });

  it('substitutes multiple ${env.X} references in one string', () => {
    expect(interpolateEnvData('${env.BASE_URL}/${env.REGION}', ctx())).toBe(
      'https://uat.example.com/au',
    );
  });

  it('throws with file context on unknown ${env.X}', () => {
    expect(() =>
      interpolateEnvData('Visit ${env.UNKNOWN}/x', { ...ctx(), filePath: '/t/foo.md' }),
    ).toThrow(/Unknown environment variable 'UNKNOWN'.*\/t\/foo\.md/);
  });
});

describe('interpolateEnvData — data namespace', () => {
  it('substitutes a nested ${data.X.Y.Z} path', () => {
    expect(
      interpolateEnvData('Login as ${data.users.admin.email}', ctx()),
    ).toBe('Login as a@uat.example.com');
  });

  it('stringifies number leaves', () => {
    expect(interpolateEnvData('Want ${data.fixtures.count} rows', ctx())).toBe(
      'Want 5 rows',
    );
  });

  it('stringifies array leaves as JSON', () => {
    expect(interpolateEnvData('tags=${data.fixtures.tags}', ctx())).toBe(
      'tags=["smoke","login"]',
    );
  });

  it('renders null leaves as empty string', () => {
    expect(interpolateEnvData('x=${data.nullable}y', ctx())).toBe('x=y');
  });

  it('throws on unknown ${data.X.Y} path', () => {
    expect(() =>
      interpolateEnvData(
        'Login as ${data.users.admin.emial}',
        { ...ctx(), filePath: 'tests/foo.md' },
      ),
    ).toThrow(/Unknown data path 'users.admin.emial'.*tests\/foo\.md/);
  });

  it('error message includes the surrounding step text', () => {
    let thrown: Error | undefined;
    try {
      interpolateEnvData('Click "Approve ${data.missing.thing}"', ctx());
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain('Click "Approve ${data.missing.thing}"');
  });
});

describe('interpolateEnvData — interaction with other syntax', () => {
  it('leaves `{{parameters}}` untouched (handled at runtime)', () => {
    expect(
      interpolateEnvData('Hello {{name}} at ${env.BASE_URL}', ctx()),
    ).toBe('Hello {{name}} at https://uat.example.com');
  });

  it('leaves dollar amounts untouched (no `${`)', () => {
    expect(
      interpolateEnvData('Approve $5,000 against ${env.BASE_URL}', ctx()),
    ).toBe('Approve $5,000 against https://uat.example.com');
  });

  it('returns input unchanged when no ${...} markers present', () => {
    expect(interpolateEnvData('Plain step text', ctx())).toBe('Plain step text');
  });

  it('mixes env + data refs in one step', () => {
    expect(
      interpolateEnvData(
        'POST ${env.BASE_URL}/api/users with ${data.users.admin.email}',
        ctx(),
      ),
    ).toBe('POST https://uat.example.com/api/users with a@uat.example.com');
  });
});

describe('interpolateEnvDataDeep', () => {
  it('walks a nested object and substitutes every string leaf', () => {
    const out = interpolateEnvDataDeep(
      {
        outer: {
          url: '${env.BASE_URL}/x',
          count: 7,
          inner: { who: '${data.users.admin.email}' },
        },
      },
      ctx(),
    );
    expect(out).toEqual({
      outer: {
        url: 'https://uat.example.com/x',
        count: 7,
        inner: { who: 'a@uat.example.com' },
      },
    });
  });

  it('walks arrays', () => {
    const out = interpolateEnvDataDeep(['${env.REGION}', '${env.BASE_URL}'], ctx());
    expect(out).toEqual(['au', 'https://uat.example.com']);
  });

  it('returns primitives unchanged', () => {
    expect(interpolateEnvDataDeep(42, ctx())).toBe(42);
    expect(interpolateEnvDataDeep(true, ctx())).toBe(true);
    expect(interpolateEnvDataDeep(null, ctx())).toBe(null);
  });
});
