import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseFrontmatter, parseTitleHeading } from '../dist/frontmatter.js';

test('parseFrontmatter: empty input returns empty object', () => {
  assert.deepEqual(parseFrontmatter(''), {});
  assert.deepEqual(parseFrontmatter('# No frontmatter here\nSome prose.'), {});
});

test('parseFrontmatter: reads type field', () => {
  const text = '---\ntype: skill\n---\n# Skill name\n';
  assert.deepEqual(parseFrontmatter(text), { type: 'skill' });
});

test('parseFrontmatter: disabled true', () => {
  const text = '---\ndisabled: true\n---\n# Heading\n';
  assert.deepEqual(parseFrontmatter(text), { disabled: true });
});

test('parseFrontmatter: disabled false / missing returns no disabled key', () => {
  assert.deepEqual(parseFrontmatter('---\ndisabled: false\n---\n'), { disabled: false });
  assert.deepEqual(parseFrontmatter('---\nfoo: bar\n---\n'), {});
});

test('parseFrontmatter: env field', () => {
  const text = '---\nenv: prod\n---\n';
  assert.deepEqual(parseFrontmatter(text), { env: 'prod' });
});

test('parseFrontmatter: tags as flow list', () => {
  const text = '---\ntags: [smoke, slow, "needs-network"]\n---\n';
  assert.deepEqual(parseFrontmatter(text), { tags: ['smoke', 'slow', 'needs-network'] });
});

test('parseFrontmatter: tags normalize to lowercase for reliable matching', () => {
  const text = '---\ntags: [Smoke, SLOW, "Needs-Network"]\n---\n';
  assert.deepEqual(parseFrontmatter(text), { tags: ['smoke', 'slow', 'needs-network'] });
});

test('parseFrontmatter: tolerates unknown keys', () => {
  const text = '---\nauthor: Paul\ntype: skill\ndate: 2026-01-01\n---\n';
  assert.deepEqual(parseFrontmatter(text), { type: 'skill' });
});

test('parseFrontmatter: comments stripped, quoted values preserved', () => {
  const text = '---\ntype: skill # this is a comment\nenv: "prod#1"\n---\n';
  assert.deepEqual(parseFrontmatter(text), { type: 'skill', env: 'prod#1' });
});

test('parseFrontmatter: malformed frontmatter (no closing ---) returns empty', () => {
  const text = '---\ntype: skill\n# never closes\n';
  assert.deepEqual(parseFrontmatter(text), {});
});

test('parseFrontmatter: multiple fields together', () => {
  const text = [
    '---',
    'type: skill',
    'disabled: false',
    'env: staging',
    'tags: [smoke]',
    '---',
    '# Title',
  ].join('\n');
  assert.deepEqual(parseFrontmatter(text), {
    type: 'skill',
    disabled: false,
    env: 'staging',
    tags: ['smoke'],
  });
});

test('parseTitleHeading: reads first # heading after frontmatter', () => {
  const text = '---\ntype: skill\n---\n\n# My Test\n\n## Steps\n1. go\n';
  assert.equal(parseTitleHeading(text), 'My Test');
});

test('parseTitleHeading: works without frontmatter', () => {
  assert.equal(parseTitleHeading('# Just a Title\n'), 'Just a Title');
});

test('parseTitleHeading: returns null when first non-blank line is prose', () => {
  const text = 'Some prose\n# Later heading\n';
  assert.equal(parseTitleHeading(text), null);
});

test('parseTitleHeading: ignores ## headings, only matches level 1', () => {
  const text = '## Steps\n# Title\n';
  // First non-blank line is ##, starts with #, scan continues; then #
  assert.equal(parseTitleHeading(text), 'Title');
});

test('parseTitleHeading: null when no heading at all', () => {
  assert.equal(parseTitleHeading(''), null);
  assert.equal(parseTitleHeading('---\nfoo: bar\n---\n\nJust prose.\n'), null);
});
