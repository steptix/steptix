// Finding and filling a login form, with no per-site knowledge anywhere.
//
// The scan itself lives in ../browser/scripts/find-login-fields.js and runs in
// the page; this module loads it, runs it once per frame, picks a winner, and
// owns the two things that must NOT be decided in the page: which frame's URL
// the domain rule is applied to, and whether an element is really a password
// box before a password goes into it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Frame, Page } from 'playwright';

/** Keyword lists handed to the scan. Lowercase, matched as substrings.
 *
 *  Multilingual on purpose — the Bitwarden extension's lists are, and a login
 *  page in German is not an edge case, it is Tuesday. */
const USERNAME_KEYWORDS = [
  'user', 'name', 'email', 'e-mail', 'mail', 'login', 'account', 'identifier',
  'benutzer', 'anmelden', 'correo', 'usuario', 'utilisateur', 'courriel',
  'gebruiker', 'utente', 'phone', 'mobile', 'msisdn',
];

/** Fields that look like a username by position but are not. */
const REJECT_KEYWORDS = [
  'search', 'suche', 'buscar', 'recherche', 'query', 'coupon', 'promo',
  'postcode', 'zip', 'card', 'cvv', 'captcha',
];

const OTP_KEYWORDS = [
  'otp', 'one-time', 'onetime', 'mfa', '2fa', 'twofactor', 'two-factor',
  'authcode', 'auth-code', 'verification', 'verificationcode', 'securitycode',
  'token', 'passcode',
];

const SUBMIT_KEYWORDS = [
  'sign in', 'signin', 'log in', 'login', 'continue', 'next', 'submit',
  'anmelden', 'weiter', 'iniciar', 'continuar', 'connexion', 'suivant',
  'verify', 'confirm',
];

/** How long the page gets to answer the scan before we call it wedged. */
const SCAN_TIMEOUT_MS = 10_000;

/** Per-field descriptor as the browser script reports it. */
export interface ScannedField {
  selector: string;
  type: string;
  autocomplete: string;
  name: string;
  id: string;
  inShadow: boolean;
  index: number;
}

export type ScanStatus =
  | 'login-form'
  | 'username-only'
  | 'password-only'
  | 'otp-only'
  | 'registration-form'
  | 'no-form'
  | 'scan-failed';

/** One frame's answer. */
export interface FrameScan {
  status: ScanStatus;
  password: ScannedField | null;
  username: ScannedField | null;
  usernameWhy?: string;
  otp: ScannedField | null;
  submit: { selector: string; text: string } | null;
  visibleInputs: number;
  note: string;
}

/** A frame's answer, plus which frame it came from. */
export interface LoginScan extends FrameScan {
  /** The frame holding the form. Its URL — not the top page's — is what the
   *  domain rule is applied to. */
  frame: Frame;
  /** The frame's own URL. */
  url: string;
  /** The top-level page URL, which differs when the form is in an iframe. */
  topUrl: string;
}

function loadScript(name: string): string {
  const url = new URL(`../browser/scripts/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), 'utf8');
}

function substitute(template: string, bindings: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(bindings)) out = out.split(`__${k}__`).join(v);
  return out;
}

const FIND_LOGIN_FIELDS_SCRIPT = substitute(loadScript('find-login-fields.js'), {
  USERNAME_KEYWORDS: JSON.stringify(USERNAME_KEYWORDS),
  REJECT_KEYWORDS: JSON.stringify(REJECT_KEYWORDS),
  OTP_KEYWORDS: JSON.stringify(OTP_KEYWORDS),
  SUBMIT_KEYWORDS: JSON.stringify(SUBMIT_KEYWORDS),
});

/** How good an answer is, for picking between frames. Higher wins. */
const STATUS_RANK: Record<ScanStatus, number> = {
  'login-form': 6,
  'password-only': 5,
  'otp-only': 4,
  'username-only': 3,
  'registration-form': 2,
  'no-form': 1,
  'scan-failed': 0,
};

async function evaluateWithTimeout(frame: Frame, ms: number): Promise<FrameScan> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      frame.evaluate(FIND_LOGIN_FIELDS_SCRIPT) as Promise<FrameScan>,
      new Promise<FrameScan>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`login scan timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Scan every frame and return the most login-like answer.
 *
 * Frames are scanned because embedded sign-in forms are ordinary — an SSO
 * widget, a checkout login, a banking iframe. The frame that wins carries its
 * OWN url, and §6's rule is applied to that: a Google form embedded in another
 * site matches the Google item, which is both correct and the behaviour that
 * makes SSO work without special-casing.
 *
 * The main frame wins ties, so a page with its own form is never displaced by
 * an advert iframe that happens to contain a password box.
 */
export async function scanForLogin(page: Page): Promise<LoginScan> {
  const topUrl = page.url();
  const frames = page.frames();
  let best: LoginScan | null = null;

  for (const frame of frames) {
    let scan: FrameScan;
    try {
      scan = await evaluateWithTimeout(frame, SCAN_TIMEOUT_MS);
    } catch (err) {
      // A frame that will not answer is not a failure of the whole scan — a
      // cross-origin advert frame that has torn down mid-evaluate must not
      // stop us reading the login form in the main frame.
      scan = {
        status: 'scan-failed',
        password: null,
        username: null,
        otp: null,
        submit: null,
        visibleInputs: 0,
        note: err instanceof Error ? err.message : String(err),
      };
    }
    const candidate: LoginScan = { ...scan, frame, url: frame.url(), topUrl };
    if (!best || STATUS_RANK[candidate.status] > STATUS_RANK[best.status]) best = candidate;
  }

  if (best) return best;
  // A page with no frames at all is not something Playwright produces, but the
  // type says it could, and inventing a "no form" answer for a page we never
  // read would be a lie of exactly the kind this feature cannot afford.
  return {
    status: 'scan-failed',
    password: null,
    username: null,
    otp: null,
    submit: null,
    visibleInputs: 0,
    note: 'The page reported no frames to scan.',
    frame: page.mainFrame(),
    url: topUrl,
    topUrl,
  };
}

/**
 * Re-verify, in the page, that `selector` still addresses a real, visible,
 * enabled `<input type="password">`.
 *
 * **This is the check that makes the optional field hint safe** (§7). The hint
 * lets an agent point at a field on a form our heuristics could not read; this
 * says the agent may point, but not at anything it likes. Between the scan and
 * the fill the page may also have re-rendered, so even an unhinted selector is
 * re-checked — a selector that resolved to the password box a second ago may
 * resolve to a search box now.
 *
 * "Is a password field" means **right now**, and that has one visible
 * consequence worth stating: a site whose show-password toggle is switched on
 * has flipped the field to `type="text"` (the property reflects to the
 * attribute, so there is no hidden original to consult), and this refuses it.
 * That is the correct direction — a field currently rendering its contents in
 * plain sight on screen is not somewhere a stored password should be typed —
 * and the recovery is for the user to toggle it back.
 */
export async function isRealPasswordField(frame: Frame, selector: string): Promise<boolean> {
  // A string script rather than a closure, matching every other browser-side
  // read in this repo: `tsconfig` carries no `dom` lib, so a callback would not
  // typecheck against `document` — and a stringified script cannot accidentally
  // close over server-side state either.
  const script = `(() => {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    if (el.tagName !== 'INPUT') return false;
    // Lowercased because the attribute is case-insensitive in HTML and a page
    // may well have written type="Password". Reading the attribute rather than
    // the property is not a way around a show-password toggle (type reflects,
    // so a toggle rewrites both) — it just avoids the property's silent
    // normalisation of unknown values to "text".
    var attr = (el.getAttribute('type') || '').toLowerCase();
    if (attr !== 'password') return false;
    if (el.disabled || el.readOnly) return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  })()`;
  try {
    return (await frame.evaluate(script)) === true;
  } catch {
    return false;
  }
}

/**
 * How long a single interaction with a form control may take.
 *
 * Fifteen seconds, not five. A login page is often the slowest page a site
 * has — third-party bot-detection scripts, a fonts round-trip, a field that
 * only becomes enabled once some SDK has initialised — and Playwright's
 * actionability wait covers all of that before the click lands, so the budget
 * has to cover the page settling rather than just the click.
 *
 * (Chosen on that reasoning alone. It is NOT the fix for the flake seen while
 * building this: those failures were vitest's own 5s per-test default, which
 * no Playwright setting affects. Recorded because the two look identical in a
 * log — both surface as "about 5000ms" — and the wrong one is easy to blame.)
 */
const INTERACT_TIMEOUT_MS = 15_000;
/** Typing is per-keystroke and a long passphrase is legitimately slow. */
const TYPE_TIMEOUT_MS = 30_000;

/** A click on the submit control, bounded well below the field budget so a
 *  refusal leaves time for the Enter fallback rather than failing the login. */
const SUBMIT_CLICK_TIMEOUT_MS = 5_000;

/**
 * Type a value into a field with real key events, after clearing it.
 *
 * `pressSequentially` rather than `fill` because sites that drive their state
 * from `keydown` — and there are many — see nothing at all from a value
 * assignment, then submit an empty form and report a wrong password.
 *
 * **`focus`, not `click`.** A live run against a CDP browser failed six times
 * in ten with `locator.click: Timeout 15000ms exceeded` here, on a fixture page
 * holding one visible text input. `click` waits for the whole actionability
 * set — visible, *stable across animation frames*, and hit-testable at a point
 * — and any of those can stall on a page we do not control. `focus` needs none
 * of them, and typing never needed the click: `pressSequentially` focuses the
 * element itself before sending keys.
 *
 * What is actually proven, since the difference matters: three controlled
 * reproductions — a backgrounded tab in a Playwright browser, the same in a
 * real Chrome over CDP, and an occluded/minimised Chrome window — all clicked
 * in under 90ms, so the original failure is NOT diagnosed. What was measured is
 * the cost of being wrong: `focus` took 6–16ms in every scenario where `click`
 * took 86–2001ms, and it cannot fail for any reason `focus` does not share. So
 * this deletes a step that was never load-bearing rather than fixing a
 * understood bug, and those six failures deserve watching for again.
 */
export async function typeInto(frame: Frame, selector: string, value: string): Promise<void> {
  const field = frame.locator(selector).first();
  await field.focus({ timeout: INTERACT_TIMEOUT_MS });
  await field.fill('');
  await field.pressSequentially(value, { delay: 12, timeout: TYPE_TIMEOUT_MS });
}

/**
 * Submit the form: click the control the scan found, else press Enter.
 *
 * The click is tried first because a submit button often carries its own
 * handler, and it is bounded-and-non-fatal for the same reason `typeInto` no
 * longer clicks at all: this is the one call left in the fill path needing full
 * actionability, and a login whose fields were both typed correctly must not be
 * reported as failed because a button would not take a click. Enter on the
 * field submits by the browser's own rules.
 */
export async function submitLogin(
  frame: Frame,
  submitSelector: string | null,
  fallbackFieldSelector: string,
): Promise<void> {
  if (submitSelector) {
    try {
      await frame.locator(submitSelector).first().click({ timeout: SUBMIT_CLICK_TIMEOUT_MS });
      return;
    } catch {
      // Fall through. The fields are filled either way, and Enter is a second
      // way to submit rather than a worse one.
    }
  }
  await frame.locator(fallbackFieldSelector).first().press('Enter', { timeout: INTERACT_TIMEOUT_MS });
}
