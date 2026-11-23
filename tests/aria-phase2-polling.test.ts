/**
 * Untimed, cross-platform unit tests for Phase 2 of
 * `docs/specs/SPEC-aria-ref-snapshots.md` (§6.1, §6.2, §10):
 *  - `normalizeSnapshotForDiff` & `diffNewInteractiveRef`
 *  - `waitForSnapshotChange` with injected `now` & `sleep` (zero real sleeps)
 *  - `executeStep` (`snapshotMode: 'aria'`) with `waitType: "change"`
 *    (multi-turn continuation, `## Active Poll Budget`, `STALL_LIMIT` &
 *    `maxTurns` immunity, timeout failure, immediate `AbortSignal` cancel)
 *  - Pre-resolved multi-action ref chains (`preResolveRefForChain` &
 *    `executeStep` surviving `innerHTML` DOM node replacement)
 */
import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import type { Config } from '../src/config/types.js';
import type { AiClient } from '../src/ai/client.js';
import { contentBlocksToText } from '../src/ai/prompts.js';
import type { ChatMessage } from '../src/ai/types.js';
import {
  ARIA_SNAPSHOT_TRUNCATION_MARKER,
  captureAriaPageSnapshot,
  diffNewInteractiveRef,
  normalizeSnapshotForDiff,
  waitForSnapshotChange,
} from '../src/browser/aria-snapshot.js';
import { preResolveRefForChain } from '../src/browser/actions.js';
import { executeStep } from '../src/runner/step-executor.js';
import { listenFetchable } from './listen-fetchable.cjs';

function messageText(msg: ChatMessage): string {
  return contentBlocksToText(msg.content);
}

function extractRef(snapshot: string, lineMatcher: RegExp): string {
  const line = snapshot.split('\n').find((l) => lineMatcher.test(l));
  expect(
    line,
    `expected snapshot line matching ${lineMatcher}\n--- snapshot ---\n${snapshot}`,
  ).toBeDefined();
  const match = /\[ref=((?:f\d+)?e\d+|s\d+)\]/.exec(line!);
  expect(match, `expected [ref=...] on line: ${line}`).not.toBeNull();
  return match![1]!;
}

interface VirtualClock {
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  sleeps: Array<{ at: number; ms: number }>;
  getTime: () => number;
}

function makeVirtualClock(
  startMs = 0,
  onSleep?: (info: { at: number; ms: number; callIndex: number; signal?: AbortSignal }) => void,
): VirtualClock {
  let time = startMs;
  const sleeps: Array<{ at: number; ms: number }> = [];
  let callIndex = 0;

  return {
    now: () => time,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) {
        throw new DOMException('Run aborted by client', 'AbortError');
      }
      const idx = ++callIndex;
      const at = time;
      sleeps.push({ at, ms });
      onSleep?.({ at, ms, callIndex: idx, ...(signal !== undefined && { signal }) });
      if (signal?.aborted) {
        throw new DOMException('Run aborted by client', 'AbortError');
      }
      time += ms;
    },
    sleeps,
    getTime: () => time,
  };
}

interface StubPollPageOptions {
  url: string | (() => string);
  onAriaSnapshot: (callIndex: number, opts?: { mode?: string; timeout?: number }) => string | Promise<string>;
  onWaitForLoadState?: (state: string, opts?: { timeout?: number }) => void | Promise<void>;
  isClosed?: () => boolean;
}

function makeStubPollPage(opts: StubPollPageOptions): Page {
  let ariaCalls = 0;
  const stub = {
    url: () => (typeof opts.url === 'function' ? opts.url() : opts.url),
    isClosed: () => opts.isClosed?.() ?? false,
    waitForLoadState: async (state: string, waitOpts?: { timeout?: number }) => {
      await opts.onWaitForLoadState?.(state, waitOpts);
    },
    locator: (selector: string) => {
      expect(selector).toBe('html');
      return {
        ariaSnapshot: async (snapOpts?: { mode?: string; timeout?: number }) => {
          ariaCalls++;
          return opts.onAriaSnapshot(ariaCalls, snapOpts);
        },
      };
    },
  };
  return stub as unknown as Page;
}

// ---------------------------------------------------------------------------
// 1. normalizeSnapshotForDiff & diffNewInteractiveRef
// ---------------------------------------------------------------------------

describe('normalizeSnapshotForDiff & diffNewInteractiveRef (SPEC §6.2, §7.2)', () => {
  it('strips [ref=eN], [ref=f1eN], [ref=sN], [active], HTML comments, and truncation markers', () => {
    const withRefsAndComments = [
      '- main:',
      '  - button "Continue" [ref=e15] [active]',
      '  - textbox "Email" [ref=f1e4]',
      '  - file-input "Upload" [ref=s1]',
      '<!-- Browser dialogs answered since the last snapshot. -->',
      ARIA_SNAPSHOT_TRUNCATION_MARKER,
    ].join('\n');

    const renumberedClean = [
      '- main:',
      '  - button "Continue" [ref=e99]',
      '  - textbox "Email" [ref=f3e8]',
      '  - file-input "Upload" [ref=s7]',
    ].join('\n');

    const a = normalizeSnapshotForDiff(withRefsAndComments);
    const b = normalizeSnapshotForDiff(renumberedClean);

    expect(a.normalized).toBe(b.normalized);
    expect(a.normalized).not.toContain('[ref=');
    expect(a.normalized).not.toContain('[active]');
    expect(a.normalized).not.toContain('<!--');
    expect(a.interactiveRefCount).toBe(3);
    expect([...a.interactiveSignatures].sort()).toEqual([
      'button:Continue',
      'file-input:Upload',
      'textbox:Email',
    ]);
  });

  it('collapses countdown ticks to identical normalized strings while keeping real differences distinct', () => {
    const sending14 = normalizeSnapshotForDiff(
      '- status: "Sending verification code... (14s remaining)"\n- button "Continue" [ref=e1]',
    );
    const sending3 = normalizeSnapshotForDiff(
      '- status: "Sending verification code... (3s remaining)"\n- button "Continue" [ref=e9]',
    );
    expect(sending14.normalized).toBe(sending3.normalized);

    const resend59 = normalizeSnapshotForDiff('- button "Resend in 59s" [ref=e4]');
    const resend1 = normalizeSnapshotForDiff('- button "Resend in 1s" [ref=e4]');
    expect(resend59.normalized).toBe(resend1.normalized);
    expect([...resend59.interactiveSignatures]).toEqual([...resend1.interactiveSignatures]);

    const clockHigh = normalizeSnapshotForDiff('- status: "Expires in 01:29"');
    const clockLow = normalizeSnapshotForDiff('- status: "Expires in 00:04"');
    expect(clockHigh.normalized).toBe(clockLow.normalized);

    const hmsHigh = normalizeSnapshotForDiff('- status: "Remaining 01:02:03"');
    const hmsLow = normalizeSnapshotForDiff('- status: "Remaining 00:00:09"');
    expect(hmsHigh.normalized).toBe(hmsLow.normalized);

    const remainingHigh = normalizeSnapshotForDiff('- status: "remaining: 12"');
    const remainingLow = normalizeSnapshotForDiff('- status: "remaining: 2"');
    expect(remainingHigh.normalized).toBe(remainingLow.normalized);

    // Real structural, label, and non-countdown numeric differences stay distinct.
    const failedStatus = normalizeSnapshotForDiff(
      '- status: "Verification code failed"\n- button "Continue" [ref=e1]',
    );
    expect(failedStatus.normalized).not.toBe(sending14.normalized);

    const withNewField = normalizeSnapshotForDiff(
      '- status: "Sending verification code... (3s remaining)"\n- button "Continue" [ref=e9]\n- textbox "One-time code" [ref=e12]',
    );
    expect(withNewField.normalized).not.toBe(sending3.normalized);
    expect(withNewField.interactiveSignatures.has('textbox:One-time code')).toBe(true);

    const renamedButton = normalizeSnapshotForDiff(
      '- status: "Sending verification code... (3s remaining)"\n- button "Submit" [ref=e9]',
    );
    expect(renamedButton.normalized).not.toBe(sending3.normalized);

    const order101 = normalizeSnapshotForDiff('- heading "Order 101" [level=2]');
    const order102 = normalizeSnapshotForDiff('- heading "Order 102" [level=2]');
    expect(order101.normalized).not.toBe(order102.normalized);
  });

  it('diffNewInteractiveRef returns { ref, role, name } for 1 new control and undefined for 0 or 2+', () => {
    const before = [
      '- main:',
      '  - button "Continue" [ref=e6]',
      '  - button "Resend in 59s" [ref=e8]',
    ].join('\n');

    // Exactly 1 new interactive control appears (even with ref renumbering and a countdown tick).
    const afterOne = [
      '- main:',
      '  - button "Continue" [ref=e7]',
      '  - button "Resend in 54s" [ref=e9]',
      '  - textbox "One-time code" [ref=e12]',
      '  - generic [ref=e13]',
    ].join('\n');
    expect(diffNewInteractiveRef(before, afterOne)).toEqual({
      ref: 'e12',
      role: 'textbox',
      name: 'One-time code',
    });

    // 0 new interactive controls (countdown tick + non-interactive generic/iframe/document only).
    const afterZero = [
      '- main:',
      '  - button "Continue" [ref=e6]',
      '  - button "Resend in 1s" [ref=e8]',
      '  - generic [ref=e10]',
      '  - iframe "Ad" [ref=e11]',
      '  - document "Frame" [ref=e12]',
    ].join('\n');
    expect(diffNewInteractiveRef(before, afterZero)).toBeUndefined();

    // 2+ new interactive controls -> ambiguous -> undefined.
    const afterTwo = [
      '- main:',
      '  - button "Continue" [ref=e6]',
      '  - button "Resend in 54s" [ref=e8]',
      '  - textbox "One-time code" [ref=e12]',
      '  - button "Verify" [ref=e13]',
    ].join('\n');
    expect(diffNewInteractiveRef(before, afterTwo)).toBeUndefined();

    // Duplicate signature inserted above an existing matching ref identifies the newly inserted ref.
    const beforeDup = '- list:\n  - button "Delete" [ref=e5]';
    const afterDup = '- list:\n  - button "Delete" [ref=e4]\n  - button "Delete" [ref=e5]';
    expect(diffNewInteractiveRef(beforeDup, afterDup)).toEqual({
      ref: 'e4',
      role: 'button',
      name: 'Delete',
    });

    // Escaped quotes inside accessible name are unescaped cleanly.
    const afterQuoted = [
      '- main:',
      '  - button "Continue" [ref=e6]',
      '  - button "Resend in 59s" [ref=e8]',
      '  - textbox "User \\"OTP\\"" [ref=e14]',
    ].join('\n');
    expect(diffNewInteractiveRef(before, afterQuoted)).toEqual({
      ref: 'e14',
      role: 'textbox',
      name: 'User "OTP"',
    });
  });

  it('excludes passive roles from interactiveSignatures and rejects supplementary or iframe refs in diffNewInteractiveRef', () => {
    const withPassiveRefs = [
      '- main:',
      '  - heading "Connecting..." [level=2] [ref=e2]',
      '  - status "Connecting..." [ref=e3]',
      '  - alert "Notice" [ref=e4]',
      '  - progressbar "Loading" [ref=e5]',
      '  - paragraph [ref=e6]: Working',
      '  - region "Details" [ref=e7]',
      '  - img "Logo" [ref=e8]',
      '  - cell "Row 1" [ref=e9]',
      '  - button "Cancel" [ref=e10]',
    ].join('\n');

    const diff = normalizeSnapshotForDiff(withPassiveRefs);
    expect(diff.interactiveRefCount).toBe(1);
    expect([...diff.interactiveSignatures]).toEqual(['button:Cancel']);

    const base = '- main:\n  - button "Cancel" [ref=e1]';
    // Passive role appearing -> undefined.
    expect(diffNewInteractiveRef(base, `${base}\n  - status "Authenticating..." [ref=e2]`)).toBeUndefined();
    expect(diffNewInteractiveRef(base, `${base}\n  - heading "Step 2" [level=2] [ref=e3]`)).toBeUndefined();
    // Supplementary sN refs and synthetic tags -> undefined (not valid page.getByRole roles).
    expect(diffNewInteractiveRef(base, `${base}\n  - file-input "Receipt" [ref=s1]`)).toBeUndefined();
    expect(diffNewInteractiveRef(base, `${base}\n  - custom-element "Widget" [ref=s2]`)).toBeUndefined();
    expect(diffNewInteractiveRef(base, `${base}\n  - button "Hidden" [ref=s3]`)).toBeUndefined();
    expect(diffNewInteractiveRef(base, `${base}\n  - input "Code" [ref=e4]`)).toBeUndefined();
    // Un-framed iframe f1eN ref -> undefined (no frame selector carried by diffNewInteractiveRef).
    expect(diffNewInteractiveRef(base, `${base}\n  - button "Approve" [ref=f1e4]`)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. waitForSnapshotChange with injected now & sleep (zero real sleeps)
// ---------------------------------------------------------------------------

describe('waitForSnapshotChange with injected now & sleep (SPEC §6.2)', () => {
  it('follows tiered cadence (200/500/1000ms), emits 15s heartbeats, polls purely locally, and times out at 90s', async () => {
    const rawBaselineYaml = [
      '- main:',
      '  - status: "Waiting for approval..."',
      '  - button "Cancel" [ref=e2]',
    ].join('\n');

    const clock = makeVirtualClock(0);
    const heartbeats: Array<{ elapsedMs: number; totalBudgetMs: number }> = [];
    let pollCount = 0;

    const page = makeStubPollPage({
      url: 'http://127.0.0.1/waiting',
      onAriaSnapshot: () => {
        pollCount++;
        return rawBaselineYaml;
      },
    });

    const result = await waitForSnapshotChange(page, {
      baselineSnapshot: rawBaselineYaml,
      baselineUrl: 'http://127.0.0.1/waiting',
      budgetMs: 90_000,
      now: clock.now,
      sleep: clock.sleep,
      onHeartbeat: (elapsedMs, totalBudgetMs) => {
        heartbeats.push({ elapsedMs, totalBudgetMs });
      },
    });

    expect(result).toEqual({
      changed: false,
      timedOut: true,
      urlChanged: false,
      newInteractiveControl: false,
      elapsedMs: 90_000,
    });

    // Verify exact tiered cadence across the full 90_000ms simulated budget:
    //   0..2800ms  -> 15 sleeps of 200ms (= 3_000ms)
    //   3000..14500ms -> 24 sleeps of 500ms (= 12_000ms)
    //   15000..89000ms -> 75 sleeps of 1000ms (= 75_000ms)
    const fastSleeps = clock.sleeps.filter((s) => s.at < 3_000);
    const mediumSleeps = clock.sleeps.filter((s) => s.at >= 3_000 && s.at < 15_000);
    const slowSleeps = clock.sleeps.filter((s) => s.at >= 15_000);

    expect(fastSleeps).toHaveLength(15);
    expect(fastSleeps.every((s) => s.ms === 200)).toBe(true);
    expect(mediumSleeps).toHaveLength(24);
    expect(mediumSleeps.every((s) => s.ms === 500)).toBe(true);
    expect(slowSleeps).toHaveLength(75);
    expect(slowSleeps.every((s) => s.ms === 1_000)).toBe(true);
    expect(pollCount).toBe(114);
    expect(clock.getTime()).toBe(90_000);

    // Heartbeats fire every 15s while waiting before the 90s deadline exits.
    expect(heartbeats).toEqual([
      { elapsedMs: 15_000, totalBudgetMs: 90_000 },
      { elapsedMs: 30_000, totalBudgetMs: 90_000 },
      { elapsedMs: 45_000, totalBudgetMs: 90_000 },
      { elapsedMs: 60_000, totalBudgetMs: 90_000 },
      { elapsedMs: 75_000, totalBudgetMs: 90_000 },
    ]);

    // When a wait crosses 90s (e.g. 91s budget), the 90s heartbeat also fires cleanly.
    const clock91 = makeVirtualClock(0);
    const heartbeats91: number[] = [];
    const res91 = await waitForSnapshotChange(
      makeStubPollPage({
        url: 'http://127.0.0.1/waiting',
        onAriaSnapshot: () => rawBaselineYaml,
      }),
      {
        baselineSnapshot: rawBaselineYaml,
        baselineUrl: 'http://127.0.0.1/waiting',
        budgetMs: 91_000,
        now: clock91.now,
        sleep: clock91.sleep,
        onHeartbeat: (elapsedMs) => heartbeats91.push(elapsedMs),
      },
    );
    expect(res91.timedOut).toBe(true);
    expect(heartbeats91).toEqual([15_000, 30_000, 45_000, 60_000, 75_000, 90_000]);

    // Continuation polls carrying `alreadyElapsedMs` stay in the 1000ms cadence tier
    // and schedule the next heartbeat without duplicating the 15s boundary.
    const contClock = makeVirtualClock(0);
    const contHeartbeats: number[] = [];
    const contRes = await waitForSnapshotChange(
      makeStubPollPage({
        url: 'http://127.0.0.1/waiting',
        onAriaSnapshot: () => rawBaselineYaml,
      }),
      {
        baselineSnapshot: rawBaselineYaml,
        baselineUrl: 'http://127.0.0.1/waiting',
        budgetMs: 46_000,
        totalBudgetMs: 90_000,
        alreadyElapsedMs: 15_000,
        now: contClock.now,
        sleep: contClock.sleep,
        onHeartbeat: (elapsedMs) => contHeartbeats.push(elapsedMs),
      },
    );
    expect(contRes.timedOut).toBe(true);
    expect(contClock.sleeps.every((s) => s.ms === 1_000)).toBe(true);
    expect(contHeartbeats).toEqual([30_000, 45_000, 60_000]);
  });

  it('strips each framework-appended supplementary baseline section (# Iframes, # File Inputs, # Supplementary Controls, # Stamped Table Rows) before diffing against raw ariaSnapshot', async () => {
    const rawBaselineYaml = [
      '- main:',
      '  - status: "Waiting for approval..."',
      '  - button "Cancel" [ref=e2]',
    ].join('\n');

    const supplementarySections = [
      '# Iframes\n- iframe [frame="#status-frame"]',
      '# File Inputs (hidden native upload targets)\n- file-input "Upload receipt" [ref=s1]',
      '# Supplementary Controls\n- checkbox "Notify me" [checked=false] [ref=s2]',
      '# Stamped Table Rows: table "Approvals" -> row 1 [ref=s3]',
    ];

    for (const section of supplementarySections) {
      const clock = makeVirtualClock(0);
      const fullBaseline = `${rawBaselineYaml}\n\n${section}\n<!-- Notifications that appeared and have since closed.\n- "Saved" (2 s ago)\n-->`;
      const page = makeStubPollPage({
        url: 'http://127.0.0.1/waiting',
        onAriaSnapshot: () => rawBaselineYaml,
      });

      const res = await waitForSnapshotChange(page, {
        baselineSnapshot: fullBaseline,
        baselineUrl: 'http://127.0.0.1/waiting',
        budgetMs: 600,
        now: clock.now,
        sleep: clock.sleep,
      });

      expect(res.changed, `supplementary section falsely triggered change:\n${section}`).toBe(false);
      expect(res.timedOut, `supplementary section did not stay unchanged until timeout:\n${section}`).toBe(true);
    }
  });

  it('ignores ticking countdowns on polls 1..5 and wakes on poll 6 when a new control appears after 150ms debounce', async () => {
    const baseline = [
      '- main:',
      '  - status: "Sending code... (60s remaining)"',
      '  - button "Resend in 60s" [ref=e4]',
    ].join('\n');

    const clock = makeVirtualClock(1_000);
    const page = makeStubPollPage({
      url: 'http://127.0.0.1/mfa',
      onAriaSnapshot: (callIndex) => {
        if (callIndex <= 5) {
          const secs = 60 - callIndex;
          return [
            '- main:',
            `  - status: "Sending code... (${secs}s remaining)"`,
            `  - button "Resend in ${secs}s" [ref=e4]`,
          ].join('\n');
        }
        return [
          '- main:',
          '  - status: "Enter the code we sent"',
          '  - textbox "One-time code" [ref=e12]',
          '  - button "Resend in 54s" [ref=e4]',
        ].join('\n');
      },
    });

    const result = await waitForSnapshotChange(page, {
      baselineSnapshot: baseline,
      baselineUrl: 'http://127.0.0.1/mfa',
      budgetMs: 90_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result).toEqual({
      changed: true,
      timedOut: false,
      urlChanged: false,
      newInteractiveControl: true,
      elapsedMs: 1_150,
    });
    // 5 poll sleeps (200ms each) while countdown ticked, then 150ms debounce once e12 appeared.
    expect(clock.sleeps.map((s) => s.ms)).toEqual([200, 200, 200, 200, 200, 150]);
  });

  it('enforces minTextChangeIntervalMs: 4000 for text-only mutations but wakes immediately at 400ms on a new control or URL change', async () => {
    const baseline = [
      '- main:',
      '  - status: "Starting job..."',
      '  - button "Cancel" [ref=e1]',
    ].join('\n');

    // (a) Text-only mutation: waits out the full 4000ms backoff + 150ms debounce.
    {
      const clock = makeVirtualClock(0);
      const page = makeStubPollPage({
        url: 'http://127.0.0.1/job',
        onAriaSnapshot: (callIndex) => [
          '- main:',
          `  - status: "Processing batch ${callIndex % 2 === 1 ? 'A' : 'B'}..."`,
          '  - button "Cancel" [ref=e1]',
        ].join('\n'),
      });

      const res = await waitForSnapshotChange(page, {
        baselineSnapshot: baseline,
        baselineUrl: 'http://127.0.0.1/job',
        budgetMs: 30_000,
        minTextChangeIntervalMs: 4_000,
        now: clock.now,
        sleep: clock.sleep,
      });

      expect(res).toEqual({
        changed: true,
        timedOut: false,
        urlChanged: false,
        newInteractiveControl: false,
        elapsedMs: 4_150,
      });
      expect(clock.sleeps[clock.sleeps.length - 1]!.ms).toBe(150);
      expect(clock.sleeps[clock.sleeps.length - 1]!.at).toBe(4_000);
    }

    // (b) New interactive button [ref=e9] at 400ms bypasses the 4000ms text backoff immediately.
    {
      const clock = makeVirtualClock(0);
      const page = makeStubPollPage({
        url: 'http://127.0.0.1/job',
        onAriaSnapshot: () => {
          if (clock.getTime() < 400) {
            return [
              '- main:',
              '  - status: "Processing batch A..."',
              '  - button "Cancel" [ref=e1]',
            ].join('\n');
          }
          return [
            '- main:',
            '  - status: "Processing batch B..."',
            '  - button "Cancel" [ref=e1]',
            '  - button "Download report" [ref=e9]',
          ].join('\n');
        },
      });

      const res = await waitForSnapshotChange(page, {
        baselineSnapshot: baseline,
        baselineUrl: 'http://127.0.0.1/job',
        budgetMs: 30_000,
        minTextChangeIntervalMs: 4_000,
        now: clock.now,
        sleep: clock.sleep,
      });

      expect(res).toEqual({
        changed: true,
        timedOut: false,
        urlChanged: false,
        newInteractiveControl: true,
        elapsedMs: 550,
      });
      expect(clock.sleeps.map((s) => s.ms)).toEqual([200, 200, 150]);
    }

    // (c) URL change at 400ms bypasses the 4000ms text backoff immediately.
    {
      const clock = makeVirtualClock(0);
      const page = makeStubPollPage({
        url: () => (clock.getTime() < 400 ? 'http://127.0.0.1/job' : 'http://127.0.0.1/job/done'),
        onAriaSnapshot: () => [
          '- main:',
          '  - status: "Processing batch A..."',
          '  - button "Cancel" [ref=e1]',
        ].join('\n'),
      });

      const res = await waitForSnapshotChange(page, {
        baselineSnapshot: baseline,
        baselineUrl: 'http://127.0.0.1/job',
        budgetMs: 30_000,
        minTextChangeIntervalMs: 4_000,
        now: clock.now,
        sleep: clock.sleep,
      });

      expect(res).toEqual({
        changed: true,
        timedOut: false,
        urlChanged: true,
        newInteractiveControl: false,
        elapsedMs: 550,
      });
      expect(clock.sleeps.map((s) => s.ms)).toEqual([200, 200, 150]);
    }
  });

  it('rejects immediately with AbortError when AbortSignal fires inside sleep, before entry, or mid-ariaSnapshot (issues/020)', async () => {
    const baseline = '- status: "Still working..."';

    // (a) Abort triggered inside injected sleep immediately aborts without another poll.
    {
      const controller = new AbortController();
      let polls = 0;
      const clock = makeVirtualClock(0, ({ callIndex }) => {
        if (callIndex === 2) controller.abort();
      });
      const page = makeStubPollPage({
        url: 'http://127.0.0.1/wait',
        onAriaSnapshot: () => {
          polls++;
          return baseline;
        },
      });

      await expect(
        waitForSnapshotChange(page, {
          baselineSnapshot: baseline,
          baselineUrl: 'http://127.0.0.1/wait',
          budgetMs: 90_000,
          signal: controller.signal,
          now: clock.now,
          sleep: clock.sleep,
        }),
      ).rejects.toSatisfy((err: unknown) => err instanceof Error && err.name === 'AbortError');
      expect(polls).toBe(2);
    }

    // (b) Pre-aborted signal fails immediately with 0 polls and 0 sleeps.
    {
      const controller = new AbortController();
      controller.abort();
      const clock = makeVirtualClock(0);
      let polls = 0;
      const page = makeStubPollPage({
        url: 'http://127.0.0.1/wait',
        onAriaSnapshot: () => {
          polls++;
          return baseline;
        },
      });

      await expect(
        waitForSnapshotChange(page, {
          baselineSnapshot: baseline,
          baselineUrl: 'http://127.0.0.1/wait',
          budgetMs: 90_000,
          signal: controller.signal,
          now: clock.now,
          sleep: clock.sleep,
        }),
      ).rejects.toSatisfy((err: unknown) => err instanceof Error && err.name === 'AbortError');
      expect(polls).toBe(0);
      expect(clock.sleeps).toHaveLength(0);
    }

    // (c) Abort fired while ariaSnapshot() is pending cancels immediately via raceAbort.
    {
      const controller = new AbortController();
      const clock = makeVirtualClock(0);
      const page = makeStubPollPage({
        url: 'http://127.0.0.1/wait',
        onAriaSnapshot: () =>
          new Promise<string>(() => {
            queueMicrotask(() => controller.abort());
          }),
      });

      await expect(
        waitForSnapshotChange(page, {
          baselineSnapshot: baseline,
          baselineUrl: 'http://127.0.0.1/wait',
          budgetMs: 90_000,
          signal: controller.signal,
          now: clock.now,
          sleep: clock.sleep,
        }),
      ).rejects.toSatisfy((err: unknown) => err instanceof Error && err.name === 'AbortError');
    }
  });

  it('recovers when a mid-poll navigation destroys the execution context and reports urlChanged: true', async () => {
    const baseline = '- button "Continue" [ref=e1]';
    const clock = makeVirtualClock(0);
    let currentUrl = 'http://127.0.0.1/step1';
    let waitedForLoad = false;

    const page = makeStubPollPage({
      url: () => currentUrl,
      onAriaSnapshot: () => {
        throw new Error('Execution context was destroyed, most likely because of a navigation');
      },
      onWaitForLoadState: (state) => {
        expect(state).toBe('domcontentloaded');
        waitedForLoad = true;
        currentUrl = 'http://127.0.0.1/step2';
      },
    });

    const result = await waitForSnapshotChange(page, {
      baselineSnapshot: baseline,
      baselineUrl: 'http://127.0.0.1/step1',
      budgetMs: 30_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(waitedForLoad).toBe(true);
    expect(result).toEqual({
      changed: true,
      timedOut: false,
      urlChanged: true,
      newInteractiveControl: false,
      elapsedMs: 150,
    });
    expect(clock.sleeps.map((s) => s.ms)).toEqual([150]);
  });
});

// ---------------------------------------------------------------------------
// 3 & 4. Browser-backed executeStep tests: waitType: "change" & preResolveRefForChain
// ---------------------------------------------------------------------------

describe('Phase 2 executeStep (waitType: "change") & pre-resolved ref chains', () => {
  let browser: Browser;
  let context: BrowserContext;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

      if (pathname === '/otp-flow') {
        res.end(`<!doctype html>
<html>
  <head><title>OTP Flow</title></head>
  <body>
    <main id="otp-root">
      <h1>Two-step verification</h1>
      <p id="stage" role="status">Ready to send code</p>
      <button id="continue-btn" type="button">Continue</button>
      <div id="dynamic-slot"></div>
    </main>
    <script>
      document.getElementById('continue-btn').addEventListener('click', () => {
        document.getElementById('stage').textContent = 'Sending verification code...';
      });
    </script>
  </body>
</html>`);
        return;
      }

      if (pathname === '/static-wait') {
        res.end(`<!doctype html>
<html>
  <head><title>Static Page</title></head>
  <body>
    <main>
      <p id="static-status" role="status">No updates pending</p>
      <button id="noop-btn" type="button">Refresh</button>
    </main>
  </body>
</html>`);
        return;
      }

      if (pathname === '/chain-rerender') {
        res.end(`<!doctype html>
<html>
  <head><title>Chain Rerender</title></head>
  <body>
    <main>
      <button id="start-btn" type="button">Start</button>
      <div id="controls">
        <div id="export-progress" role="progressbar" aria-label="Export progress" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">0%</div>
        <button id="stop-btn" type="button">Stop</button>
      </div>
      <p id="chain-status">idle</p>
    </main>
    <script>
      const controls = document.getElementById('controls');
      controls.addEventListener('click', (e) => {
        if (e.target && e.target.id === 'stop-btn') {
          window.__stopClicked = true;
          const bar = document.getElementById('export-progress');
          const val = bar ? bar.getAttribute('aria-valuenow') : 'missing';
          document.getElementById('chain-status').textContent = 'stopped-at-' + val;
        }
      });
      document.getElementById('start-btn').addEventListener('click', () => {
        window.__oldBar = document.getElementById('export-progress');
        window.__oldStop = document.getElementById('stop-btn');
        // Destroy and replace both DOM nodes via innerHTML, invalidating Turn-1 Playwright _ariaRef expandos.
        controls.innerHTML =
          '<div id="export-progress" role="progressbar" aria-label="Export progress" aria-valuenow="80" aria-valuemin="0" aria-valuemax="100">80%</div>' +
          '<button id="stop-btn" type="button">Stop</button>';
        window.__oldBarDetached = !window.__oldBar.isConnected;
        window.__oldStopDetached = !window.__oldStop.isConnected;
      });
    </script>
  </body>
</html>`);
        return;
      }

      if (pathname === '/chain-iframe-host') {
        res.end(`<!doctype html>
<html>
  <head><title>Chain Iframe Host</title></head>
  <body>
    <div id="controls">
      <div id="export-progress" role="progressbar" aria-label="Export progress" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">0%</div>
      <button id="stop-btn" type="button">Stop</button>
    </div>
    <iframe id="worker-frame" src="/chain-iframe-child" width="400" height="160"></iframe>
  </body>
</html>`);
        return;
      }

      if (pathname === '/chain-iframe-child') {
        res.end(`<!doctype html>
<html>
  <head><title>Chain Iframe Child</title></head>
  <body>
    <button id="frame-stop-btn" type="button">Frame Stop</button>
  </body>
</html>`);
        return;
      }

      if (pathname === '/password-poll') {
        res.end(`<!doctype html>
<html>
  <head><title>Password Poll</title></head>
  <body>
    <main>
      <label for="pw-input">Password</label>
      <input id="pw-input" type="password" value="poll-test-secret" />
      <p id="run-tag">Session: poll-run-secret</p>
      <p id="pw-status" role="status">Waiting for approval...</p>
      <button id="cancel-btn" type="button">Cancel</button>
      <div id="pw-slot"></div>
    </main>
  </body>
</html>`);
        return;
      }

      if (pathname === '/status-backoff') {
        res.end(`<!doctype html>
<html>
  <head><title>Status Backoff</title></head>
  <body>
    <main>
      <div id="conn-status" role="status" aria-label="Connecting...">Connecting...</div>
      <h2 id="conn-heading">Connecting...</h2>
      <button id="cancel-btn" type="button">Cancel</button>
      <div id="action-slot"></div>
    </main>
  </body>
</html>`);
        return;
      }

      res.end('<!doctype html><html><body>Empty</body></html>');
    });

    const port = await listenFetchable(server, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  }, 60_000);

  afterAll(async () => {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);

  function ariaConfig(maxTurns = 4): Config {
    return {
      ...DEFAULT_CONFIG,
      ai: { ...DEFAULT_CONFIG.ai, sendScreenshots: false },
      browser: {
        ...DEFAULT_CONFIG.browser,
        headed: false,
        snapshotMode: 'aria',
        captureScreenshotsPerAction: false,
      },
      execution: {
        ...DEFAULT_CONFIG.execution,
        retries: 0,
        maxTurns,
        promptOnAmbiguity: false,
      },
      reports: {
        ...DEFAULT_CONFIG.reports,
        includeDomSnapshots: true,
        includeScreenshots: false,
      },
    };
  }

  async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const page = await context.newPage();
    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => {});
    }
  }

  it('executeStep multi-turn waitType: "change" sends ## Active Poll Budget, does not trip STALL_LIMIT=2, and does not exhaust maxTurns: 2', async () => {
    await withPage(async (page) => {
      await page.goto(`${baseUrl}/otp-flow`, { waitUntil: 'load' });

      const userPrompts: string[] = [];
      let turnIndex = 0;

      const aiClient = {
        complete: async (messages: ChatMessage[]) => {
          const turn = ++turnIndex;
          const userText = messageText(messages[messages.length - 1]!);
          userPrompts.push(userText);

          if (turn === 1) {
            expect(userText).toContain('## Page Snapshot');
            expect(userText).not.toContain('## Active Poll Budget');
            const continueRef = extractRef(userText, /button "Continue"/);
            return {
              text: JSON.stringify({
                actions: [
                  { action: 'click', ref: continueRef, description: 'Click Continue' },
                  {
                    action: 'wait',
                    waitType: 'change',
                    timeout: 60_000,
                    description: 'Wait up to 60s for verification code input',
                  },
                ],
                reasoning: 'Click Continue and wait for verification code field',
                needs_reeval: true,
              }),
              model: 'stub-aria-phase2',
            };
          }

          if (turn === 2) {
            expect(userText).toContain('## Active Poll Budget');
            expect(userText).toContain('Sending verification code...');

            // Deterministically mutate DOM after Turn 2's snapshot was captured:
            // adds a new interactive button so waitForSnapshotChange wakes immediately
            // without waiting on text-only backoff.
            await page.evaluate(() => {
              const slot = document.getElementById('dynamic-slot')!;
              const btn = document.createElement('button');
              btn.id = 'resend-btn';
              btn.type = 'button';
              btn.textContent = 'Resend code';
              slot.appendChild(btn);
            });

            return {
              text: JSON.stringify({
                actions: [
                  {
                    action: 'wait',
                    waitType: 'change',
                    description: 'Still sending code, continue waiting',
                  },
                ],
                reasoning: 'Verification code input not rendered yet',
                needs_reeval: true,
              }),
              model: 'stub-aria-phase2',
            };
          }

          if (turn === 3) {
            expect(userText).toContain('## Active Poll Budget');
            expect(userText).toContain('Resend code');

            // Deterministically reveal the Verification code textbox before Turn 3's wait runs.
            await page.evaluate(() => {
              const slot = document.getElementById('dynamic-slot')!;
              const input = document.createElement('input');
              input.id = 'otp-input';
              input.type = 'text';
              input.setAttribute('aria-label', 'Verification code');
              slot.appendChild(input);
            });

            return {
              text: JSON.stringify({
                actions: [
                  {
                    action: 'wait',
                    waitType: 'change',
                    description: 'Continue waiting for verification code input',
                  },
                ],
                reasoning: 'Still waiting for Verification code textbox',
                needs_reeval: true,
              }),
              model: 'stub-aria-phase2',
            };
          }

          if (turn === 4) {
            expect(userText).toContain('## Active Poll Budget');
            const otpRef = extractRef(userText, /textbox "Verification code"/);
            return {
              text: JSON.stringify({
                actions: [
                  {
                    action: 'type',
                    ref: otpRef,
                    value: '482910',
                    description: 'Enter verification code',
                  },
                ],
                reasoning: 'Verification code textbox appeared; type code and finish',
                needs_reeval: false,
              }),
              model: 'stub-aria-phase2',
            };
          }

          throw new Error(`Unexpected AI turn ${turn}`);
        },
      } as unknown as AiClient;

      // maxTurns is deliberately 2: Turns 2 and 3 are single-action `waitType: "change"`
      // continuation turns, so they must increment `extraPollTurns` instead of starving Turn 4.
      const result = await executeStep(
        1,
        1,
        'Click Continue, wait up to 60 seconds for the Verification code field, and type 482910',
        {
          page,
          config: ariaConfig(2),
          aiClient,
          contextContent: '',
          testName: 'aria-phase2-otp-poll',
          baseUrl,
          conversationHistory: [],
          csrfTokens: {},
          resolvedParameters: {},
        },
      );

      expect(result.status, result.error).toBe('passed');
      expect(result.turns).toHaveLength(4);
      expect(userPrompts).toHaveLength(4);
      expect(await page.locator('#otp-input').inputValue()).toBe('482910');
    });
  });

  it('executeStep does not trip STALL_LIMIT=2 across consecutive waitType: "change" turns even when turn-start snapshots are identical', async () => {
    await withPage(async (page) => {
      await page.goto(`${baseUrl}/static-wait`, { waitUntil: 'load' });

      // Simulate a transient UI update seen during waitForSnapshotChange that disappears
      // before the next turn's captureAriaPageSnapshot, leaving identical turn-start fingerprints.
      let injectTransientOnNextPoll = false;
      const origLocator = page.locator.bind(page);
      const locatorSpy = vi.spyOn(page, 'locator').mockImplementation((selector, options) => {
        const loc = origLocator(selector, options);
        if (selector !== 'html') return loc;
        const origAria = loc.ariaSnapshot.bind(loc);
        return new Proxy(loc, {
          get(target, prop, receiver) {
            if (prop === 'ariaSnapshot') {
              return async (snapOpts?: Parameters<typeof origAria>[0]) => {
                const yaml = await origAria(snapOpts);
                if (injectTransientOnNextPoll) {
                  injectTransientOnNextPoll = false;
                  return `${yaml}\n- button "Syncing..." [ref=e99]`;
                }
                return yaml;
              };
            }
            const val = Reflect.get(target, prop, receiver);
            return typeof val === 'function' ? val.bind(target) : val;
          },
        });
      });

      let turnIndex = 0;
      const aiClient = {
        complete: async () => {
          const turn = ++turnIndex;
          if (turn <= 3) {
            injectTransientOnNextPoll = true;
            return {
              text: JSON.stringify({
                actions: [
                  {
                    action: 'wait',
                    waitType: 'change',
                    ...(turn === 1 && { timeout: 60_000 }),
                    description: `Wait poll ${turn}`,
                  },
                ],
                reasoning: `Still waiting (turn ${turn})`,
                needs_reeval: true,
              }),
              model: 'stub-aria-phase2-stall',
            };
          }
          return {
            text: JSON.stringify({
              actions: [{ action: 'noop', description: 'Done waiting' }],
              reasoning: 'Complete',
              needs_reeval: false,
            }),
            model: 'stub-aria-phase2-stall',
          };
        },
      } as unknown as AiClient;

      try {
        const result = await executeStep(1, 1, 'Wait for background sync to finish', {
          page,
          config: ariaConfig(2),
          aiClient,
          contextContent: '',
          testName: 'aria-phase2-stall-immunity',
          baseUrl,
          conversationHistory: [],
          csrfTokens: {},
          resolvedParameters: {},
        });

        expect(result.status, result.error).toBe('passed');
        expect(result.turns).toHaveLength(4);
      } finally {
        locatorSpy.mockRestore();
      }
    });
  });

  it('executeStep fails with "Timed out after ... waiting for page change" (not a stall error) when waitType: "change" expires', async () => {
    await withPage(async (page) => {
      await page.goto(`${baseUrl}/static-wait`, { waitUntil: 'load' });

      let calls = 0;
      const aiClient = {
        complete: async () => {
          calls++;
          return {
            text: JSON.stringify({
              actions: [
                {
                  action: 'wait',
                  waitType: 'change',
                  timeout: 500,
                  description: 'Wait for confirmation modal',
                },
              ],
              reasoning: 'Wait for modal to appear',
              needs_reeval: true,
            }),
            model: 'stub-aria-phase2-timeout',
          };
        },
      } as unknown as AiClient;

      const result = await executeStep(1, 1, 'Wait for the confirmation modal to appear', {
        page,
        config: ariaConfig(4),
        aiClient,
        contextContent: '',
        testName: 'aria-phase2-timeout',
        baseUrl,
        conversationHistory: [],
        csrfTokens: {},
        resolvedParameters: {},
      });

      expect(result.status).toBe('failed');
      expect(result.interrupted).toBeUndefined();
      expect(calls).toBe(1);
      expect(result.turns).toHaveLength(1);
      expect(result.error).toMatch(
        /Timed out after 1s waiting for page change \("Wait for confirmation modal"\)\./,
      );
      expect(result.error).not.toMatch(/Step stalled/i);
    });
  });

  it('executeStep aborts immediately when opts.signal fires during waitType: "change"', async () => {
    await withPage(async (page) => {
      await page.goto(`${baseUrl}/static-wait`, { waitUntil: 'load' });

      const controller = new AbortController();
      let abortOnNextPoll = false;
      const origLocator = page.locator.bind(page);
      const locatorSpy = vi.spyOn(page, 'locator').mockImplementation((selector, options) => {
        const loc = origLocator(selector, options);
        if (selector !== 'html') return loc;
        const origAria = loc.ariaSnapshot.bind(loc);
        return new Proxy(loc, {
          get(target, prop, receiver) {
            if (prop === 'ariaSnapshot') {
              return async (snapOpts?: Parameters<typeof origAria>[0]) => {
                if (abortOnNextPoll) {
                  abortOnNextPoll = false;
                  controller.abort();
                }
                return origAria(snapOpts);
              };
            }
            const val = Reflect.get(target, prop, receiver);
            return typeof val === 'function' ? val.bind(target) : val;
          },
        });
      });

      let calls = 0;
      const aiClient = {
        complete: async () => {
          calls++;
          abortOnNextPoll = true;
          return {
            text: JSON.stringify({
              actions: [
                {
                  action: 'wait',
                  waitType: 'change',
                  timeout: 60_000,
                  description: 'Wait up to 60s for update',
                },
              ],
              reasoning: 'Wait for page change',
              needs_reeval: true,
            }),
            model: 'stub-aria-phase2-abort',
          };
        },
      } as unknown as AiClient;

      try {
        const result = await executeStep(1, 1, 'Wait up to 60s for an update', {
          page,
          config: ariaConfig(4),
          aiClient,
          contextContent: '',
          testName: 'aria-phase2-abort',
          baseUrl,
          conversationHistory: [],
          csrfTokens: {},
          resolvedParameters: {},
          signal: controller.signal,
        });

        expect(result.status).toBe('failed');
        expect(result.interrupted).toBe(true);
        expect(result.error).toBe('Aborted by client');
        expect(calls).toBe(1);
      } finally {
        locatorSpy.mockRestore();
      }
    });
  });

  it('preResolveRefForChain returns durable locators across main frame & iframes that survive innerHTML DOM replacement', async () => {
    await withPage(async (page) => {
      await page.goto(`${baseUrl}/chain-iframe-host`, { waitUntil: 'load' });
      await page.frameLocator('#worker-frame').locator('#frame-stop-btn').waitFor({ state: 'visible' });

      const snapshot = await captureAriaPageSnapshot(page);
      const barRef = extractRef(snapshot, /progressbar "Export progress"/);
      const stopRef = extractRef(snapshot, /button "Stop"/);
      const frameStopRef = extractRef(snapshot, /button "Frame Stop"/);

      const preBar = await preResolveRefForChain(page, barRef);
      const preStop = await preResolveRefForChain(page, stopRef);
      const preFrameStop = await preResolveRefForChain(page, frameStopRef);
      const preStale = await preResolveRefForChain(page, 'e999');

      expect(preStale).toBeNull();
      expect(preBar).not.toBeNull();
      expect(preBar!.selector).not.toMatch(/^aria-ref=/);
      expect(preBar!.normalizedLocator).toBeDefined();
      expect(preBar!.normalizedLocator).not.toContain('aria-ref=');

      expect(preStop).not.toBeNull();
      expect(preStop!.selector).not.toMatch(/^aria-ref=/);
      expect(preStop!.normalizedLocator).toBe("getByRole('button', { name: 'Stop' })");
      expect(preStop!.normalizedBy).toBe('role');

      expect(preFrameStop).not.toBeNull();
      expect(preFrameStop!.frameSelector).toBe('#worker-frame');
      expect(preFrameStop!.normalizedLocator).toBe("getByRole('button', { name: 'Frame Stop' })");
      expect(preFrameStop!.normalizedLocator).not.toContain('contentFrame');

      // Destroy and replace the main-frame nodes via innerHTML.
      await page.evaluate(() => {
        document.getElementById('controls')!.innerHTML =
          '<div id="export-progress" role="progressbar" aria-label="Export progress" aria-valuenow="80" aria-valuemin="0" aria-valuemax="100">80%</div>' +
          '<button id="stop-btn" type="button">Stop</button>';
      });

      // Turn-1 aria-ref handles are now dead, while pre-resolved locators still match the replacement nodes.
      expect(await page.locator(`aria-ref=${barRef}`).count()).toBe(0);
      expect(await page.locator(`aria-ref=${stopRef}`).count()).toBe(0);
      expect(await page.locator(preBar!.selector).count()).toBe(1);
      expect(await page.locator(preBar!.selector).getAttribute('aria-valuenow')).toBe('80');
      expect(await page.locator(preStop!.selector).count()).toBe(1);
    });
  });

  it('executeStep succeeds on a 3-action ref chain [click Start, wait attribute barRef, click stopRef] when Start replaces the DOM via innerHTML and populates normalizedLocator', async () => {
    await withPage(async (page) => {
      await page.goto(`${baseUrl}/chain-rerender`, { waitUntil: 'load' });

      let capturedBarRef = '';
      let capturedStopRef = '';
      let turnIndex = 0;

      const aiClient = {
        complete: async (messages: ChatMessage[]) => {
          const turn = ++turnIndex;
          const userText = messageText(messages[messages.length - 1]!);
          if (turn !== 1) {
            throw new Error(`Expected single-turn chain execution, got turn ${turn}`);
          }

          const startRef = extractRef(userText, /button "Start"/);
          capturedBarRef = extractRef(userText, /progressbar "Export progress"/);
          capturedStopRef = extractRef(userText, /button "Stop"/);

          return {
            text: JSON.stringify({
              actions: [
                { action: 'click', ref: startRef, description: 'Click Start' },
                {
                  action: 'wait',
                  waitType: 'attribute',
                  ref: capturedBarRef,
                  expected: 'aria-valuenow>=75',
                  description: 'Wait for export progress to reach at least 75',
                },
                { action: 'click', ref: capturedStopRef, description: 'Click Stop' },
              ],
              reasoning: 'Start export, wait for progress >= 75, then click Stop',
              needs_reeval: false,
            }),
            model: 'stub-aria-phase2-chain',
          };
        },
      } as unknown as AiClient;

      const result = await executeStep(
        1,
        1,
        'Click Start, wait until Export progress reaches 75%, and click Stop',
        {
          page,
          config: ariaConfig(4),
          aiClient,
          contextContent: '',
          testName: 'aria-phase2-preresolved-chain',
          baseUrl,
          conversationHistory: [],
          csrfTokens: {},
          resolvedParameters: {},
          captureStepContext: true,
        },
      );

      expect(result.status, result.error).toBe('passed');
      expect(result.turns).toHaveLength(1);
      expect(result.turns[0]!.subActions).toHaveLength(3);
      for (const sub of result.turns[0]!.subActions) {
        expect(sub.error).toBeUndefined();
      }

      // Confirm clicking Start truly destroyed the Turn-1 DOM nodes and invalidated their _ariaRef handles.
      const domCheck = await page.evaluate(() => ({
        oldBarDetached: Boolean((window as unknown as { __oldBarDetached?: boolean }).__oldBarDetached),
        oldStopDetached: Boolean((window as unknown as { __oldStopDetached?: boolean }).__oldStopDetached),
        stopClicked: Boolean((window as unknown as { __stopClicked?: boolean }).__stopClicked),
        status: document.getElementById('chain-status')?.textContent?.trim(),
      }));
      expect(domCheck).toEqual({
        oldBarDetached: true,
        oldStopDetached: true,
        stopClicked: true,
        status: 'stopped-at-80',
      });
      expect(await page.locator(`aria-ref=${capturedBarRef}`).count()).toBe(0);
      expect(await page.locator(`aria-ref=${capturedStopRef}`).count()).toBe(0);

      // Verify subActions[2] (Stop click) carries normalizedLocator populated via pre-resolution.
      const stopSub = result.turns[0]!.subActions[2]!;
      expect(stopSub.targeting?.normalizedLocator).toBe("getByRole('button', { name: 'Stop' })");
      expect(stopSub.targeting?.normalizedLocator).not.toContain('aria-ref=');
      expect(stopSub.targeting?.normalizedBy).toBe('role');
    });
  });

  it('waitForSnapshotChange with a redacted baseline stays unchanged against a real password input (0 false wakes) until a real change happens', async () => {
    await withPage(async (page) => {
      await page.goto(`${baseUrl}/password-poll`, { waitUntil: 'load' });

      const baselineSnapshot = await captureAriaPageSnapshot(page, {
        secrets: ['poll-run-secret'],
      });
      expect(baselineSnapshot).toContain('textbox "Password"');
      expect(baselineSnapshot).toContain('***');
      expect(baselineSnapshot).not.toContain('poll-test-secret');
      expect(baselineSnapshot).not.toContain('poll-run-secret');

      // (a) Unchanged page with a live password input + run secret never false-triggers textChanged.
      const quietClock = makeVirtualClock(0);
      const quietRes = await waitForSnapshotChange(page, {
        baselineSnapshot,
        baselineUrl: page.url(),
        budgetMs: 600,
        secrets: ['poll-run-secret'],
        now: quietClock.now,
        sleep: quietClock.sleep,
      });
      expect(quietRes).toEqual({
        changed: false,
        timedOut: true,
        urlChanged: false,
        newInteractiveControl: false,
        elapsedMs: 600,
      });
      expect(quietClock.sleeps.map((s) => s.ms)).toEqual([200, 200, 200]);

      // (b) Even if the password field's live value changes while polling, it stays silent until a real control appears.
      let time = 0;
      const sleeps: Array<{ at: number; ms: number }> = [];
      let sleepCount = 0;
      const res = await waitForSnapshotChange(page, {
        baselineSnapshot,
        baselineUrl: page.url(),
        budgetMs: 10_000,
        secrets: ['poll-run-secret'],
        now: () => time,
        sleep: async (ms: number) => {
          sleeps.push({ at: time, ms });
          sleepCount++;
          time += ms;
          if (sleepCount === 1) {
            await page.evaluate(() => {
              (document.getElementById('pw-input') as HTMLInputElement).value = 'poll-test-secret-updated';
            });
          } else if (sleepCount === 2) {
            await page.evaluate(() => {
              const btn = document.createElement('button');
              btn.id = 'approved-btn';
              btn.type = 'button';
              btn.textContent = 'Continue';
              document.getElementById('pw-slot')!.appendChild(btn);
            });
          }
        },
      });

      expect(res).toEqual({
        changed: true,
        timedOut: false,
        urlChanged: false,
        newInteractiveControl: true,
        elapsedMs: 550,
      });
      expect(sleeps.map((s) => s.ms)).toEqual([200, 200, 150]);
    });
  });

  it('waitForSnapshotChange respects minTextChangeIntervalMs backoff for a mutating role="status" element but wakes immediately on a new button', async () => {
    await withPage(async (page) => {
      await page.goto(`${baseUrl}/status-backoff`, { waitUntil: 'load' });

      const baselineSnapshot = await captureAriaPageSnapshot(page);

      // (a) Mutate <div role="status"> and <h2> from "Connecting..." to "Authenticating...":
      // Playwright mode:'ai' stamps [ref=eN] on both, yet neither is an interactive control,
      // so waitForSnapshotChange must wait out the full 4000ms backoff with newInteractiveControl: false.
      await page.evaluate(() => {
        const status = document.getElementById('conn-status')!;
        status.setAttribute('aria-label', 'Authenticating...');
        status.textContent = 'Authenticating...';
        document.getElementById('conn-heading')!.textContent = 'Authenticating...';
      });

      const backoffClock = makeVirtualClock(0);
      const backoffRes = await waitForSnapshotChange(page, {
        baselineSnapshot,
        baselineUrl: page.url(),
        budgetMs: 30_000,
        minTextChangeIntervalMs: 4_000,
        now: backoffClock.now,
        sleep: backoffClock.sleep,
      });
      expect(backoffRes).toEqual({
        changed: true,
        timedOut: false,
        urlChanged: false,
        newInteractiveControl: false,
        elapsedMs: 4_150,
      });
      expect(backoffClock.sleeps[backoffClock.sleeps.length - 1]).toEqual({ at: 4_000, ms: 150 });

      // (b) Reset to "Connecting...", capture a fresh baseline, mutate status text immediately,
      // then append a real <button> at 400ms -> newInteractiveControl: true bypasses the 4000ms backoff.
      await page.evaluate(() => {
        const status = document.getElementById('conn-status')!;
        status.setAttribute('aria-label', 'Connecting...');
        status.textContent = 'Connecting...';
        document.getElementById('conn-heading')!.textContent = 'Connecting...';
      });
      const freshBaseline = await captureAriaPageSnapshot(page);
      await page.evaluate(() => {
        const status = document.getElementById('conn-status')!;
        status.setAttribute('aria-label', 'Authenticating...');
        status.textContent = 'Authenticating...';
        document.getElementById('conn-heading')!.textContent = 'Authenticating...';
      });

      let time = 0;
      const sleeps: Array<{ at: number; ms: number }> = [];
      let sleepCount = 0;
      const buttonRes = await waitForSnapshotChange(page, {
        baselineSnapshot: freshBaseline,
        baselineUrl: page.url(),
        budgetMs: 30_000,
        minTextChangeIntervalMs: 4_000,
        now: () => time,
        sleep: async (ms: number) => {
          sleeps.push({ at: time, ms });
          sleepCount++;
          time += ms;
          if (sleepCount === 2) {
            await page.evaluate(() => {
              const btn = document.createElement('button');
              btn.id = 'ready-btn';
              btn.type = 'button';
              btn.textContent = 'Continue';
              document.getElementById('action-slot')!.appendChild(btn);
            });
          }
        },
      });
      expect(buttonRes).toEqual({
        changed: true,
        timedOut: false,
        urlChanged: false,
        newInteractiveControl: true,
        elapsedMs: 550,
      });
      expect(sleeps.map((s) => s.ms)).toEqual([200, 200, 150]);
    });
  });
});
