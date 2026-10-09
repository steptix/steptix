/**
 * When a cached RunController is rebound to a new document, replaced, or kept
 * (issue 50). The rules live in controller-binding-core.ts (no VS Code) so
 * they can be pinned here; the integration suite's reopen-rename.test.cjs
 * drives them through the registry.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  bindingFor,
  isCheckCurrent,
  isDifferentFile,
  isSameOrInside,
  readFileIdentity,
} from '../src/extension/controller-binding-core.ts';

/** A scratch directory of its own, removed afterwards. */
function withScratch(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stx-binding-'));
  try {
    return body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

const A = { dev: 1n, ino: 10n };
const B = { dev: 1n, ino: 11n };

test('a renamed file keeps its identity; the file at its old name is a different one', () => {
  withScratch((dir) => {
    const one = path.join(dir, 'one.md');
    const two = path.join(dir, 'two.md');
    fs.writeFileSync(one, '# one\n');
    fs.writeFileSync(two, '# two\n');
    const oneBefore = readFileIdentity(one);
    const twoBefore = readFileIdentity(two);
    assert.ok(oneBefore && twoBefore, 'both identities readable');
    assert.equal(isDifferentFile(oneBefore, twoBefore), true);

    // two.md → three.md, then one.md → two.md: what is called two.md now is
    // the old one.md.
    const three = path.join(dir, 'three.md');
    fs.renameSync(two, three);
    fs.renameSync(one, two);
    assert.equal(isDifferentFile(twoBefore, readFileIdentity(two)), true, 'two.md is a different file now');
    assert.equal(isDifferentFile(oneBefore, readFileIdentity(two)), false, 'it is the old one.md');
    assert.equal(isDifferentFile(twoBefore, readFileIdentity(three)), false, 'three.md is the old two.md');
  });
});

test('a file written in place keeps its identity', () => {
  withScratch((dir) => {
    const file = path.join(dir, 'test.md');
    fs.writeFileSync(file, '# before\n');
    const before = readFileIdentity(file);
    fs.writeFileSync(file, '# after, and longer than before\n');
    assert.equal(isDifferentFile(before, readFileIdentity(file)), false);
  });
});

test('a file replaced by renaming another over it is a different file', () => {
  // How some editors and tools save, and what a rename onto an existing name
  // does: the path is the same, the file is not.
  withScratch((dir) => {
    const file = path.join(dir, 'test.md');
    const temp = path.join(dir, 'test.md.tmp');
    fs.writeFileSync(file, '# before\n');
    const before = readFileIdentity(file);
    fs.writeFileSync(temp, '# after\n');
    fs.renameSync(temp, file);
    assert.equal(isDifferentFile(before, readFileIdentity(file)), true);
  });
});

test('no file at the path reads as unknown, and unknown is never a different file', () => {
  withScratch((dir) => {
    assert.equal(readFileIdentity(path.join(dir, 'missing.md')), null);
  });
  assert.equal(isDifferentFile(null, A), false);
  assert.equal(isDifferentFile(A, null), false);
  assert.equal(isDifferentFile(null, null), false);
});

test('identities compare by device and inode', () => {
  assert.equal(isDifferentFile(A, { dev: 1n, ino: 10n }), false);
  assert.equal(isDifferentFile(A, B), true);
  assert.equal(isDifferentFile(A, { dev: 2n, ino: 10n }), true, 'same inode on another device');
  // Past 2^53, where a `number` would round two ids together.
  const big = 2n ** 60n;
  assert.equal(isDifferentFile({ dev: 1n, ino: big }, { dev: 1n, ino: big + 1n }), true);
});

test('the same document object, the same file: keep', () => {
  assert.equal(
    bindingFor({ sameDocument: true, recorded: A, current: A, inFlight: false, replaceable: true }),
    'keep',
  );
});

test('a new document object for the same file: rebind, in flight or not', () => {
  for (const inFlight of [false, true]) {
    assert.equal(
      bindingFor({ sameDocument: false, recorded: A, current: A, inFlight, replaceable: true }),
      'rebind',
      `inFlight=${inFlight}`,
    );
  }
});

test('a different file at the path, nothing in flight: replace — whether or not the document object changed', () => {
  // "Nothing in flight" includes a run parked at a breakpoint: replacing the
  // controller ends the pause rather than continue it into the other file.
  for (const sameDocument of [false, true]) {
    assert.equal(
      bindingFor({ sameDocument, recorded: A, current: B, inFlight: false, replaceable: true }),
      'replace',
      `sameDocument=${sameDocument}`,
    );
  }
});

test('a different file at the path while a run is in flight: keep the document it started with', () => {
  // Never `rebind`: the rest of the run would read the other file's steps.
  for (const replaceable of [true, false]) {
    for (const sameDocument of [false, true]) {
      assert.equal(
        bindingFor({ sameDocument, recorded: A, current: B, inFlight: true, replaceable }),
        'keep',
        `replaceable=${replaceable} sameDocument=${sameDocument}`,
      );
    }
  }
});

test('a batch controller is never replaced: its run counter keeps batch session ids distinct', () => {
  for (const sameDocument of [false, true]) {
    assert.equal(
      bindingFor({ sameDocument, recorded: A, current: B, inFlight: false, replaceable: false }),
      'rebind',
      `sameDocument=${sameDocument}`,
    );
  }
});

test('an identity that cannot be read never replaces', () => {
  for (const [recorded, current] of [[null, B], [A, null], [null, null]]) {
    assert.equal(
      bindingFor({ sameDocument: false, recorded, current, inFlight: false, replaceable: true }),
      'rebind',
    );
  }
});

test('isCheckCurrent: the same document at the version last checked needs no new check', () => {
  const doc = { version: 3 };
  const check = { identity: A, document: doc, version: 3 };
  assert.equal(isCheckCurrent(check, doc, doc), true);
});

test('isCheckCurrent: an edit, a new document object or no check at all means checking again', () => {
  const doc = { version: 3 };
  const reopened = { version: 1 };
  assert.equal(isCheckCurrent(undefined, doc, doc), false, 'never checked');
  assert.equal(
    isCheckCurrent({ identity: A, document: doc, version: 2 }, doc, doc),
    false,
    'edited, or reloaded from disk, since',
  );
  assert.equal(
    isCheckCurrent({ identity: A, document: doc, version: 3 }, doc, reopened),
    false,
    'asked about a new document object',
  );
  assert.equal(
    isCheckCurrent({ identity: A, document: reopened, version: 1 }, doc, reopened),
    false,
    'the controller still holds another document (kept while its run is in flight)',
  );
});

test('isSameOrInside: the file itself and files under a folder, not a sibling sharing a prefix', () => {
  const folder = 'file:///c%3A/proj/tests';
  assert.equal(isSameOrInside(folder, folder), true);
  assert.equal(isSameOrInside(`${folder}/a.md`, folder), true);
  assert.equal(isSameOrInside(`${folder}/deep/b.md`, folder), true);
  assert.equal(isSameOrInside(`${folder}/a.md`, `${folder}/`), true, 'a target ending in a slash');
  assert.equal(isSameOrInside('file:///c%3A/proj/tests-old/a.md', folder), false);
  assert.equal(isSameOrInside('file:///c%3A/proj/tests.md', folder), false);
  assert.equal(isSameOrInside(folder, `${folder}/a.md`), false, 'a folder is not inside its file');
});
