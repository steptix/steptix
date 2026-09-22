# Signing in to Bitwarden from the broker, not a terminal

## In plain terms

Bitwarden has two locks. **Signing in** tells Bitwarden's servers this machine
may hold a copy of your vault: email, master password, and any two-step code —
once per machine, and it lasts until someone signs out. **Unlocking** decrypts
that copy for a session: master password only.

The broker already handles the second lock itself — a locked vault raises its
own unlock dialog (SPEC 29 §5, §10). It does not handle the first. A signed-out
`bw` is a dead end today, and a confusing one: the agent is told only

> Bitwarden is installed but no account is signed in.

which names neither the command-line tool nor what to do, so an agent fills the
gap — observed 2026-09-22: *"Sign in to the Bitwarden Chrome extension, then ask
me to try again."* The extension is a separate app with its own sign-in, so
following that advice changes nothing. The real remedy was `bw login` in a
terminal, which nobody would guess.

This story makes the first lock work like the second: **a signed-out vault
raises a native sign-in dialog**, the broker drives `bw login` with what the
user typed, and the same `log_into_site` call carries straight on to the
approval prompt. Signing in unlocks as well — `bw login --raw` returns a session
key — so there is no second dialog.

Before: `log_into_site` → "no account is signed in" → the agent guesses → the
user finds a terminal and runs `bw login` → asks the agent to try again.

After: `log_into_site` → a *Sign in to Bitwarden* dialog → (a code dialog, only
if the account asks for one) → the usual *Approve sign-in* dialog → filled.
Once per machine.

> **Verification rule for this story.** "Done" means: (1) from a machine where
> `bw status` reports `unauthenticated`, ONE `log_into_site` call on a real
> sign-in page raises the sign-in dialog; after the user signs in there, the
> same call reaches the approval dialog with no unlock dialog in between, and
> `bw status` afterwards reports a logged-in account; (2) the master password
> appears in no argv, no child environment, no log, and no tool result — shown
> by the unit tests of §10 AND by a canary run through the real driver against
> the real `bw` (§10.3); (3) every test named in §10 exists, runs, and fails
> when the rule it names is removed (§10.4). Step (1) needs a human at the
> keyboard — the user's own credentials are the input — and is reported as
> such, never claimed from a stub.

---

## Review convergence contract

Reviewers hunt **blocking** defects only, in these classes:

- **B1 — secret exposure.** The master password, a two-step code, or the
  email can reach argv, a child environment, a log line, disk, the model, or
  any tool result.
- **B2 — contradicts real behaviour.** A claim about this repo's code or about
  `bw` 2026.6.0 that is false. §1 records what was measured; a reviewer who
  disputes it must say what they ran.
- **B3 — contradicts a binding SPEC 29 decision** (agent-fleet-poc
  `docs/spec-29-credential-broker.md`), other than the three amendments §9
  makes on purpose.
- **B4 — unverifiable.** A criterion no test or run can check, or a named test
  that cannot fail.
- **B5 — hang, double prompt, or lost state.** Any sequence that leaves a
  dialog or a `bw` process open forever, raises two sign-in dialogs for one
  sign-in, or leaves the broker believing a vault is open when it is not.

Style, naming, and alternatives already decided in §2–§8 are out of scope: note
once, never loop-triggering. **Exit:** one round in which every reviewer reports
zero blocking findings. **Cap:** 5 rounds; what remains goes to Paul.

**Round log.** R1 (2026-09-22): 12 blocking findings across two reviewers, all
accepted; one non-blocking note (Node's `requestTimeout`) measured and
rejected (§6). R2: the fidelity reviewer 0 blocking (all nine resolved); the security reviewer 1 — the SSO state cannot be stopped by ending stdin, and measured here, not by killing the wrapper either (fact 10) — fixed by the recorded-PID stop (§4.4), with five non-blocking notes also taken. R3: **both reviewers 0 blocking — converged.** Taken afterwards from their non-blocking notes, without a further round: the lookup covers shim `.exe`s too, has a 10s timeout, and the recorded PID is killed only while our child lives (§4.4); an accepted-risk line for a stop mid-sync; the delimiter-split case (§4.2); `killPid` and `platform` as named seams, and test 41 skips when CIM is blocked (§10).

**Code review log.** CR1 (2026-09-22), two fresh reviewers: 8 blocking. A
spaced install path could never launch `bw` (§4.1 — a pre-existing defect the
driver made central); the partial-escape rule and stdin's `'error'` listener
had no test that could fail; the masked prompt's echo was mis-measured (§1
fact 4 — the probe used an empty password), so no test fed the driver the real
stream; the canary test could not tell an early stop from the refused
connection (43); the recorded-PID cutoff keyed on `close`/`error`, never
`exit`, while its comment and this story said "exit" (§4.4); a `QUIET_MS`
comment contradicted §4.6; and §10.2 named a test file that did not exist. All
fixed, each fix mutation-tested. CR2: **both reviewers 0 blocking —
converged.** Taken afterwards from their notes, each with a test and a
mutation: `/v:off` on the cmd.exe line (a `!` under registry-enabled delayed
expansion); `bwLaunch` checking its own arguments; and a re-entry guard on
stop(), whose `kill()` can emit `error` synchronously and so call stop again.

---

## 1. Ground truth (measured 2026-09-22, `bw` 2026.6.0)

Everything below was read from the installed CLI
(`@bitwarden/cli/build/bw.js`) or run against it. The design stands on these;
it is not a guess about how `bw` probably behaves.

1. **`bw login` has no non-interactive route that covers every account.**
   Password sources are: positional argv, `--passwordfile`, `--passwordenv`, or
   an interactive prompt. Two-step codes can be passed with `--method`/`--code`,
   but the **new-device verification code** — which Bitwarden emails to an
   account *without* two-step login when it signs in from a new device — has
   **no flag at all**: `bw` asks for it only at an interactive prompt
   (`"New device verification required. Enter OTP sent to login email:"`).
   Email two-step is similar: `bw` sends the email itself, mid-login, and then
   prompts. A flags-only design cannot sign such an account in.
2. **Interactivity is controlled by `BW_NOINTERACTION`** (`canInteract =
   process.env.BW_NOINTERACTION !== "true"`). The vault today sets
   `BITWARDENCLI_NOINTERACTION`, a name `bw` never reads (0 occurrences in the
   bundle). That is a separate defect, split off and since fixed (§11); this story only needs
   to be immune to it. Other ambient variables also change what `bw` prints or
   how it exits: `BW_QUIET`, `BW_RESPONSE`, `BW_CLEANEXIT`, `BW_PRETTY`,
   `BW_RAW` (all read by the bundle). An ambient `BW_QUIET=true` would suppress
   the session key a successful login prints.
3. **The prompts can be answered over a pipe, one at a time.** Probe
   (throwaway `BITWARDENCLI_APPDATA_DIR`, no network): `bw login --raw` with
   piped stdio printed `Email address:` on **stderr** ~2.1s after spawn; the
   piped answer was accepted; `Master password:` followed 10ms later; an empty
   piped answer produced `Master password is required.` and exit 1 — a local
   refusal that can only happen if the second prompt read the second answer.
4. **`bw` re-renders the prompt as it echoes, AFTER it reads our answer.** The
   probe's stderr, ANSI stripped, was:
   `? Email address: ? Email address: p? Email address: pr? … ? Email address: probe@example.invalid`
   then `? Master password: [input is hidden] ? Master password: [hidden]`.
   That probe sent an EMPTY password; with a real one the masked prompt echoes
   too — measured in code review, reproduced: a 14-character password gave 15
   `? Master password: [input is hidden]` renders (the first draw, then one per
   character) and then one `[hidden]`. So every prompt's own text reappears on
   stderr *after* the driver has answered it, once per character, masked or not. Two consequences: an echo is not a re-ask (§4.2 tells
   them apart), and plain answers — the email and any two-step or new-device
   code — are on stderr in clear, so stderr is never logged or relayed (§4.5).
   The master password itself is never echoed.
5. **A successful password login under `--raw` prints the session key alone**
   on stdout (`res.raw = process.env.BW_SESSION`). Signing in leaves the vault
   unlocked; no `bw unlock` follows. The key is generated by `bw` itself
   (`validatedParams`, bundle line ~33109), whatever `BW_SESSION` the child
   inherited.
6. **Wrong credentials** produce `Invalid master password. Confirm your email
   is correct and your account was created on <host>.` (i18n key
   `invalidMasterPasswordConfirmEmailAndHost`) — the host clause matters for an
   account on the EU cloud. **Already signed in** produces `You are already
   logged in as <email>.` — which carries the email, one more reason for §4.5.
   A **wrong verification code** is reported by the *server*, so its wording is
   not in the bundle and cannot be measured without a real account; the
   bundle's own strings are `Invalid verification code.` and `Invalid email or
   verification code`. §4.4 matches those plus the obvious variants, and an
   unmatched rejection degrades to `failed`, whose advice (§5) still works.
7. **What `LoginCommand` can ask for** (bundle lines 32989–33517, plus the
   commands it calls). Prompts, each an inquirer prompt beginning `? ` on
   stderr: `Email address:`, `Master password:`, `Two-step login method:` (a
   *list*, driven by arrow keys — not answerable by writing a line),
   `Two-step login code:`, `New device verification required. Enter OTP sent
   to login email:`, and — from `ConfirmKeyConnectorDomainCommand` (~32645) —
   a *list* prompt confirming a Key Connector domain. `client_id:` /
   `client_secret:` appear only with `--apikey`, which the driver never passes.
   **One step asks nothing on stderr:** when the server answers a password
   login with `requiresSso`, `bw` starts a callback listener on localhost
   (ports 8065–8070), opens the user's browser at the SSO page, and waits
   (~33124–33138, ~33410–33455) — no prompt, no output. §4.4's quiet timer is
   what ends that case.
8. **No captcha.** 0 occurrences of "captcha" in this build.
9. **The dialog-to-Node pipe corrupts non-ASCII on a default Windows install.**
   Probe: the value `pässwörd-é-€-日本` written with `[Console]::Out.Write` from
   PowerShell 5.1 arrived intact on this machine — whose code pages are all
   65001 (Windows' system-wide UTF-8 option is on) — and arrived as
   `p�ssw�rd-�-?-??` once the script set `[Console]::OutputEncoding` to 437, a
   default console code page. The existing unlock dialog uses exactly that
   write, so on an ordinary machine **a master password with any non-ASCII
   character cannot unlock today.** §7 fixes it for both dialogs.
10. **How `bw` stops depends on what it is doing.** On Windows an npm-installed
    `bw` runs as `cmd.exe /d /s /c bw.cmd login --raw`; the shim's child is a
    `node` process running `bw.js`, so the process that matters is a
    **grandchild** of the one we spawned.
    - **At a prompt** (probe: throwaway appdata, stopped at `Email address:`):
      ending our stdin made `bw` exit in ~21ms with code 1, and killing the
      `cmd.exe` wrapper alone also left the grandchild dead 8s later.
    - **Not reading stdin** — fact 7's SSO step, where the prompts are closed
      and `bw` holds a localhost listener with no timeout of its own. Probe (a
      stand-in with the same shape, spawned the same way: reads one line,
      closes readline, listens, heartbeats every 250ms): **ending stdin left it
      running, and so did killing the `cmd.exe` wrapper** — heartbeat still
      fresh 4s after each. Only `process.kill(<grandchild pid>)` stopped it.
      (First found by review; the reviewer could not run the kill half, so it
      was measured here.)

    So stopping `bw` reliably means knowing the grandchild's PID. §4.4 gets it
    before `bw` can enter the state where nothing else works.
11. **A throwaway `bw` can be kept off the network.** With a throwaway
    `BITWARDENCLI_APPDATA_DIR`, `bw config server https://127.0.0.1:9` is a
    local write; a login with a real-looking password then fails its first
    request (`/identity/accounts/prelogin/password`) with `ECONNREFUSED` in
    ~2.5s. (`http://` is refused outright: "Insecure URL not allowed.") This is
    what lets §10.3 feed a canary password to the real `bw` safely.
12. **Why the observed message said "no account is signed in" and not
    "locked".** No `BW_SESSION` is set at user, machine or shell level on the
    machine it happened on. The key was held **in memory** by a long-running
    Sessions API server that unlocked successfully earlier; `bw` was later
    signed out underneath it. `vaultUnlocked` is `vault.unlocked` — "a key is
    held", not "the vault is open" — so Gate 3 passed and the lookup failed.
    §2.3 covers this path.

---

## 2. When sign-in runs

### 2.1 The seams

`LoginBroker` gains two optional dependencies beside the existing
`vaultUnlocked` and `unlockVault` (`src/credentials/broker.ts` `BrokerDeps`):

```ts
/** `bw status`, for deciding between sign-in and unlock. May throw. */
vaultStatus?: () => Promise<'unlocked' | 'locked' | 'unauthenticated' | 'cli-missing'>;
/** Raise the sign-in dialog and drive `bw login`. Never throws. */
signIn?: () => Promise<SignInResult>;
```

`SignInResult` is `{ ok: true } | { ok: false; reason: SignInFailure }`, and
`SignInFailure` is the closed set `'cancelled' | 'rejected' | 'code-rejected' |
'unsupported-step' | 'timed-out' | 'failed' | 'no-dialog'` — categories, never
text (§4.5). Both types live in `types.ts`. `unlockVault` keeps its signature.

`createLoginBroker()` in `index.ts` builds these from the real vault and
dialogs, and gains an optional argument for tests —
`createLoginBroker({ vault?, approval?, driveLogin? })` — so the wiring
itself (the platform check, what `signIn` does with each driver result) is
testable without a real `bw` or a real dialog.

### 2.2 No key held (Gate 3)

Gate 3 keeps its synchronous first question: **if `vaultUnlocked()` is true,
proceed** — no `bw` spawn on the path of a call whose vault is open. Otherwise
it calls `openVault()`, the broker's single-flight procedure (§6), which does,
in order:

1. **Re-check `vaultUnlocked()`.** A flight that finished between this call's
   check and now has already done the work.
2. **`vaultStatus()`**, one `bw` start (~2s, fact 3). If it **throws** — a
   timeout, a spawn error, a refused argument; `status()` rethrows everything
   except `cli-missing` (`vault.ts:289-295`) — the result is `status-failed`:
   `vault-unavailable` with §5's "did not answer" text, **no dialog**. A `bw`
   that cannot answer `status` would not answer a login either, and asking the
   user for a master password it cannot use is worse than saying so.
3. By status:

| status | `openVault` does |
|---|---|
| `unauthenticated` | `signIn()` (§3–§4) |
| `locked` | `unlockVault()`, unchanged |
| `unlocked` | `unlockVault()` — see below |
| `cli-missing` | stop: `vault-unavailable`, the existing "not installed" text |

`unlocked` with no key held is not a state this process can use: `bw status`
reports `unlocked` only for a child whose environment carries a valid
`BW_SESSION` (bundle ~33863–33865). An ambient `BW_SESSION` is adopted as the
held key in the constructor (`vault.ts:275`), so "no key held" means either
there never was one or §2.3 dropped it as dead. `childEnv()` does spread the
ambient environment (`vault.ts:280`), so a dropped ambient key still reaches the
child — but it belongs to a signed-out `bw` and cannot open anything. Treating
`unlocked` as `locked` is the conservative reading `status()` already uses for
an unparsable answer.

### 2.3 A key is held but `bw` is signed out (Gate 4)

The lookup throws `VaultError('not-logged-in')`. Today that ends the call. Now:

1. **The vault drops the key — if it is still the key that failed.** Each vault
   call captures the key it ran with; on a `not-logged-in` classification it
   clears `session` only if `session` still equals that captured key. A lookup
   that started with a stale key and finished after a concurrent sign-in stored
   a fresh one must not throw the fresh one away.
2. The broker runs `openVault()` (§2.2; status now reports `unauthenticated`,
   so this is the sign-in), and on success **retries the lookup once.** Exactly
   once: a second `not-logged-in` straight after a successful sign-in is a vault
   we do not understand, and it ends the call (§5) rather than looping.

Step 1 is also what makes the *next* call correct when this one's sign-in is
cancelled: with no key held, it goes through §2.2 and asks `bw`.

### 2.4 Order within the broker is unchanged

Sign-in sits exactly where unlock sits: after the page scan and the https
gate, before any vault read. A call on a page that is not a sign-in form still
returns `not-a-login-page` having opened nothing — SPEC 29 §9's "a mistaken
call is free" holds, and a news article never raises a sign-in dialog.

---

## 3. The sign-in dialog

One native window, raised by the Sessions API server process, same family as
the unlock dialog (SPEC 29 §10: never inside a web page, never on the phone).

- Title **Sign in to Bitwarden**; a line saying why: *"An agent needs your
  Bitwarden vault. Sign in once on this computer."*
- **Email** (plain), **Master password** (masked). **Sign in** / **Cancel**.
  Cancel and Escape refuse; Enter submits only when both fields are non-empty.
- A small note: *"This signs in the Bitwarden command-line tool on this PC.
  Your browser extension is separate."* — the confusion that started this.
- Timeout **120s**, the unlock dialog's figure: no answer = cancelled.
- Always-on-top and revealed with the existing `DIALOG_PREAMBLE` /
  `AiuiWin.Reveal` (the `SW_HIDE` trap is already solved there; the new dialog
  reuses it, not a copy of it).

**The code dialog** appears only if `bw` asks (§4.2): one plain field,
**Verify** / **Cancel**, timeout **180s** — longer, because the email has to
arrive first. Its heading depends on which prompt `bw` showed:

- two-step: *"Enter your two-step login code, from your authenticator app or
  the email Bitwarden just sent."*
- new device: *"Bitwarden emailed a verification code to your account's email
  address because this is a new device. Enter it here."*

Both dialogs return their values through the encoding of §7.

---

## 4. The login driver

A small state machine that runs **one** `bw login --raw` process and answers
its prompts. Its own module, `src/credentials/bw-login.ts`, taking its child
process through an injected `spawn` so that every branch below is testable
against a scripted fake child, with no `bw` and no dialog anywhere near it.

### 4.1 Launch

- **Credentials first, then `bw`.** The sign-in dialog is answered before any
  process starts, so Cancel costs nothing and leaves nothing to kill.
- **argv is fixed: `['login', '--raw']`.** Nothing the user typed goes on a
  command line — not the password, and not the email either: answering the
  email *prompt* instead of passing it positionally means the one field an
  attacker might shape never meets `SAFE_ARG` or `cmd.exe`.
- **One launch rule, shared.** The `.cmd`-through-`cmd.exe` wrapping is
  today inline in the private `runBw` (`vault.ts:140-142`). It moves into an
  exported `bwLaunch(binary, args, env, platform) → { command, args,
  verbatim }` in `vault.ts`, which `runBw` and the driver both call;
  `resolveBinary` stays resolution only. **The line it builds changed in code
  review:** the old `cmd.exe /d /s /c <binary> <args>` let Node quote a spaced
  path and `/s` strip those quotes again, so `cmd.exe` split the path at the
  space — and the default npm-global location, `%APPDATA%\npm`, sits under a
  profile folder that often has one (`C:\Users\First Last`). Every `bw` call
  failed for such a user, `status` included, which read as `locked` and raised
  the wrong dialog. The line is now built the way Node builds its own
  `shell: true` line — `/d /s /c ""<binary>" <args>"`, passed with
  `windowsVerbatimArguments` — so `/s` strips only the outer pair and the path
  stays quoted. Inside those quotes `&|^<>` are literal; a path containing
  `"`, `%` or a line break, which `cmd.exe` would still act on, is refused.
  `/v:off` joins `/d`: delayed expansion can be switched on machine-wide in
  the registry, `/d` does not undo it, and with it on a `!` in the path would
  expand even inside quotes. The arguments stand OUTSIDE the quotes once `/s`
  has stripped them, so `bwLaunch` itself refuses any argument that fails
  `SAFE_ARG`, rather than trusting its callers to have checked. The driver does **not** reuse `runBw` itself: `runBw` ends stdin at
  once and kills after 30s (`vault.ts:163-168`, `198-199`), and fact 10 shows
  that ending stdin ends a login.
- **Environment:** a copy of the vault's ambient environment with these names
  removed **case-insensitively** (a copied `process.env` is an ordinary object,
  so on Windows `Bw_NoInteraction` would survive an exact-key `delete`):
  `BW_NOINTERACTION` (the driver needs prompts; fact 2), `BW_QUIET`,
  `BW_RESPONSE`, `BW_CLEANEXIT`, `BW_PRETTY`, `BW_RAW` (fact 2: each changes
  what the driver reads), and `BW_SESSION` — not for correctness, since `bw
  login` makes its own key (fact 5), but so a key is never handed to a process
  that has no use for it. Never `--passwordenv`, `--passwordfile`, or any
  variable carrying a secret.

### 4.2 Reading prompts

The driver ANSI-strips stderr and splits it into **renders** at each `? `.
Each render is either a known prompt (by the table below) or an unknown one.
A render is judged only once it is **complete**: it contains a `:` (every
prompt in fact 7 ends in one), or another render follows it. A trailing render
that is neither — a chunk boundary falling mid-prompt, `? Email ad` | `dress:`
— waits for more stderr rather than being called unknown. Splitting runs over
everything not yet consumed, not chunk by chunk, so a boundary inside the
delimiter itself (`…?` | ` Email address:`) simply joins up on the next chunk. Renders are read **in
order**, and each is handled by these rules:

- **Echo.** A render of the prompt most recently answered is an echo (fact 4).
  Ignored. The code prompt needs no rule of its own: while its dialog is open
  the driver reads no stderr at all — it queues — so the prompt's echoes are
  read only after the code is written, as echoes of the prompt answered last.
- **New.** A known prompt not yet seen is answered per the table.
- **Re-ask.** A prompt answered earlier, reappearing after a *different* prompt
  has been answered since, is `bw` asking again. No current code path does
  this; if one ever does, it means an answer was rejected. Kill (§4.4), and
  report `failed`.
- **Unknown.** A render matching nothing in the table: kill at once,
  `unsupported-step`. A prompt the driver does not know is a prompt it cannot
  answer, and it says so immediately instead of waiting out a timer.

| Render starts with | The driver writes |
|---|---|
| `Email address:` | the email, then `\n` |
| `Master password:` | the master password, then `\n` |
| `Two-step login code:` | raises the code dialog (two-step) → the code, then `\n` |
| `New device verification required` | raises the code dialog (new device) → the code, then `\n` |
| `Two-step login method:` | nothing: kill, `unsupported-step` (fact 7) |
| anything else | nothing: kill, `unsupported-step` |

A user-typed email containing `? ` would split into an extra render and end the
sign-in as `unsupported-step`. That is a failure with a clear remedy on an
address Bitwarden would reject anyway, not a leak: the render is classified,
never repeated.

### 4.3 Declined, deliberately

Several two-step methods (the list prompt), SSO (fact 7's silent step), a Key
Connector domain confirmation, API-key login, and choosing a self-hosted or EU
server are out of scope. Each ends as `unsupported-step` with the terminal
fallback (§5), whose text names them so the user is not left guessing.

### 4.4 Ending

**Knowing what to stop.** The process that must be stopped may not be the one
we spawned: an npm `bw.cmd` runs inside a `cmd.exe` wrapper (fact 10), and a
Scoop or Chocolatey `bw.exe` is a *shim* that starts the real CLI as its own
child (`vault.ts:264-266` expects Scoop). So on Windows, when the **first**
render appears — `Email address:`, before anything is written — the driver asks
for the children of **the process it spawned**, excluding `conhost.exe`, and
created **at or after that process's own creation time**. The time filter is
what makes this safe where a bare parent-PID match is not: a stale process
whose dead parent once had the same PID was necessarily created before our
child existed, since Windows does not reuse a PID while its holder lives.

| Candidates found | Meaning |
|---|---|
| exactly one | that PID is `bw`; recorded |
| none, and we spawned an `.exe` | the spawned process *is* `bw` (the standalone CLI) |
| none, and we spawned `cmd.exe` | anomalous — a wrapper always has the program as a child: not found |
| two or more | not found |

The lookup is one CIM query (a comparable query measured ~1.1s) with a **10s
timeout of its own**; on timeout its PowerShell child is killed and the answer
is "not found". Not found, or the lookup failing, **stops the driver at the
email prompt** with `failed`. Nothing has been written; `bw` is reading stdin;
ending it is enough (fact 10's first case). So the driver never writes a
password to a `bw` it could not later stop. Off Windows there is no wrapper
and no shim to see through: the child is `bw`, and no lookup runs.

Every "kill" in this section then means: **end `bw`'s stdin**; **kill the
recorded `bw` PID** — only until the process we spawned emits `exit`. A
wrapper or shim waits for its child and exits after it, so from then on the
recorded PID may already belong to someone else. (Not `close`: a `close`
settles the driver, so no stop can follow it. Not `error`: that is a spawn or
signal failure and says nothing about `bw` having ended.) Then **`kill()`
the child we spawned**. Each step covers a case the others do not (fact 10),
and none walks a process tree.

If a stop comes before `bw` was ever identified — it hung before drawing its
first prompt — the lookup runs then, BEFORE the spawned process is killed (a
lookup finds children of a live parent), and the stop finishes in the
background after the call has already settled.

A stop cannot re-enter itself. When a signal fails, Node emits the child's
`error` synchronously from inside `kill()`, and the driver's `error` handler
calls stop — which, before the first stop had settled, would begin again, and
again, until the stack overflowed.

Accepted risk: a stop during the post-login sync (the `quiet` case below)
interrupts `bw` while it writes its data file. If that ever left the file
unreadable, `status()` reads it as `locked` (its conservative fallback), the
unlock with the password in hand fails, and the call ends `rejected` — a
misleading word, but an ended call, not a hang or a leak.
Once the driver has settled, **nothing more is written**: a code dialog that
answers after a kill has its answer discarded, and the child's stdin carries an
`'error'` listener so a write racing the exit cannot surface as an unhandled
stream error.

- **Quiet timer — 60s after each write.** If, 60s after the driver last wrote
  an answer, `bw` has shown no new prompt and has not exited: kill, and report
  `quiet`. Two things look like this. One is fact 7's SSO step, which opens a
  browser and prints nothing; without the timer it would sit until the
  deadline. The other is a login the server *accepted*, still in the
  post-login sync (bundle ~33271–33296) on a large vault or a slow link. The
  driver cannot tell them apart, so §4.6 asks `bw status` afterwards and treats
  them differently. The timer does not run while a code dialog is open, because
  nothing has been written since the prompt that opened it.
- **Deadline — 6 minutes from spawn.** The code dialog's 180s, `bw`'s start
  and its network calls, and a wide margin; the sign-in dialog's 120s is spent
  before spawn (§4.1) and is not inside it. On expiry: kill, `timed-out`.
  `runBw`'s 30s per-call timeout does not apply; a login legitimately waits on
  a person.
- **A code dialog cancelled or timed out:** kill, `cancelled`.
- **Exit 0 with a non-empty stdout that is one token:** that is the session
  key. Anything else on exit 0 is `failed`.
- **Non-zero exit:** classified from ANSI-stripped stderr + stdout into
  `rejected` (fact 6's wrong-password text, or "Username or password is
  incorrect"), `code-rejected` (`Invalid verification code`, `Invalid email or
  verification code`, or a message naming an invalid/incorrect two-step code or
  token), `already-signed-in` ("You are already logged in"), or `failed`.

### 4.5 What the driver never does

It never logs, stores, or returns `bw`'s stderr or stdout — fact 4 means stderr
contains the email and any code. What leaves the driver is: a category from
§4.4 (`quiet` among them, which never reaches the agent — §4.6 resolves it), and
on success the session key. The categories are an enum; the words the
agent sees are fixed strings in the broker (§5), chosen without looking at
anything `bw` printed.

For tests only, the driver accepts an `onEvent` observer that receives
**kinds, never values**: `{ answered: 'email' | 'password' | 'two-step' |
'new-device' }` and `{ stopped: <category> }`. Production passes none.

The master password lives in: the dialog's text box → one pipe to the server
(§7) → one JavaScript string → one `stdin.write`. It is not retained past the
call; as `index.ts` already says of unlock, JavaScript strings cannot be
zeroed, so "forgotten" means "no binding outlives the call", and that is the
guarantee stated rather than implied.

### 4.6 What `signIn` does with the result (`index.ts`)

- Not a `WindowsDialogApproval` → `{ ok: false, reason: 'no-dialog' }`,
  **without starting the driver**.
- Sign-in dialog cancelled or timed out → `cancelled`, without starting it.
- Driver success → `vault.adoptSession(key)`, a new public method: holds the
  key in memory as `unlock()` does today and resets the sync clock →
  `{ ok: true }`.
- Driver `already-signed-in` → `bw` has an account but this process holds no
  key, which is the *locked* state. The credentials are still in hand, so the
  wiring calls `vault.unlock(password)` with the password the user just typed —
  **no second master-password dialog** — and returns `ok` or `rejected` by
  its result.
- Driver `quiet` → ask `vault.status()`. `locked` means the server accepted
  the login and `bw` saved it before being stopped mid-sync: handled exactly as
  `already-signed-in`, with the password in hand. `unauthenticated` means it
  never signed in — the SSO case — → `unsupported-step`. A throw, or anything
  else → `failed`.
- Any other driver category → returned as the reason.

---

## 5. What the agent is told

No new `LoginOutcome`: every sign-in failure is `vault-unavailable` and the
`detail` carries the difference. That keeps `src/mcp/schemas.ts`'s outcome enum
— and every MCP client's cached tool schema — unchanged.

| Reason | `detail` (fixed text) |
|---|---|
| `cancelled` (either dialog, cancelled or timed out) | The user was asked to sign in to Bitwarden and did not. Do not ask them for any password. Ask whether they want to try again. |
| `rejected` | Bitwarden rejected the sign-in: the email or master password was wrong, or the account is on a different Bitwarden server (for example the EU cloud). Ask the user to try again — never ask them to type a password to you. |
| `code-rejected` | Bitwarden rejected the verification code. Ask the user to try again with a fresh code. |
| `unsupported-step` | This Bitwarden account needs a sign-in step the dialog cannot handle (several two-step methods, single sign-on, Key Connector, or a self-hosted server). Ask the user to run `bw login` once in a terminal, then try again. |
| `timed-out`, `failed`, a rejected flight (§6) | Signing in to Bitwarden did not complete. Ask the user to run `bw login` once in a terminal, then try again. |
| `no-dialog` | The Bitwarden command-line tool (not the browser extension) is signed out, and this machine cannot show a sign-in prompt. Ask the user to run `bw login` in a terminal, then try again. |
| `status-failed` (§2.2) | The Bitwarden command-line tool did not answer, so the vault could not be opened. Ask the user to check that `bw status` works in a terminal. |
| `not-logged-in` reached any other way | The Bitwarden command-line tool (not the browser extension) is signed out. Ask the user to run `bw login` in a terminal, then try again. |
| `cli-missing` | unchanged (it already says to install the CLI) |

The `not-logged-in` row replaces the string that started this story. It
survives as the fallback after §2.3's one retry.

The `log_into_site` tool description gains one sentence so an agent reading it
cold is not surprised: *"The first time on a machine, the user may be asked to
sign in to Bitwarden before approving."*

---

## 6. One prompt at a time

Two `log_into_site` calls arriving while the vault is not open must not raise
two dialogs — two live prompts for one decision is what SPEC 29 §10's "first
surface wins" exists to prevent. `openVault()` (§2.2) is a **single-flight** on
`LoginBroker`:

- **Join.** A call that finds a flight in progress awaits it and takes its
  result. The status check is *inside* the flight, so a joiner never runs its
  own `vaultStatus()` — there is no window in which a second caller reads a
  status from before the first caller's sign-in and opens a second dialog.
- **Release.** The flight is cleared when it settles — whether it resolves or
  rejects (a `finally`, not a `then`). A call that arrives **after** that starts
  a fresh flight: one cancelled or failed sign-in never becomes a permanent
  "did not sign in" for the life of the server. Only callers that joined the
  flight share its result.
- **Reject.** `signIn` and the wiring never throw by contract, but a flight
  that rejects anyway (a bug, an unexpected spawn error) is reported as the
  `failed` row of §5 — to its joiners too — rather than as a 500.

This covers unlock as well: today two concurrent calls on a locked vault raise
two unlock dialogs, and the same flight closes that.

**A cancelled tool call does not cancel the sign-in.** `logIntoSite` in
`src/mcp/api-client.ts` sets no timeout of its own; it aborts only on the MCP
client's signal, and aborting the HTTP request does not stop the server-side
broker. So an agent whose client gives up after 60s (Codex's default) leaves
the dialog up, and the user can still finish signing in. That is deliberate: a
completed sign-in serves the agent's next call, and a dialog that vanished
because some other process lost patience would teach the user the dialog is
unreliable. The driver's own deadline (§4.4) still bounds it.

The server does not cut a long answer short either. Node's default
`server.requestTimeout` (300s) bounds *receiving* a request, not the handler:
probe — a server with `requestTimeout = 1000` whose handler answered a small
POST after 3s returned `200` after 3025ms.

---

## 7. Getting values out of a dialog intact

PowerShell 5.1 writes redirected stdout in the console code page, which on a
default install is not UTF-8 (fact 9). So:

- `DIALOG_PREAMBLE` gains one function, `Write-AiuiFields`, which writes each
  value as **Base64 of its UTF-8 bytes**, one per line. Base64 is ASCII and
  survives any code page; a value can contain anything, including newlines.
- It writes with `[Console]::Out.Write`, as the unlock script does today, and
  **never** through PowerShell's output stream (`Write-Output`, or a bare
  expression). PowerShell transcription — a Group Policy option on managed
  machines — records the output stream to files on disk; `[Console]::Out`
  bypasses the host, so a Base64 master password is not transcribed.
- Node decodes with an exported `decodeDialogFields(stdout): string[]` in
  `approval.ts`.
- The sign-in dialog emits `[email, password]`, the code dialog `[code]`, and
  **the unlock dialog `[password]`** — its script and `askMasterPassword` move
  to the same pair, because fact 9 is a live defect there, not a hypothetical,
  and a shared helper with one caller left on the broken path would be the
  worst of both.

---

## 8. What does not change

- SPEC 29's gate order, the approval dialog, grants, the domain rule, and every
  outcome name.
- **`BW_SESSION` stays the preferred path** (SPEC 29 §5): a user who unlocks in
  their own terminal is never shown our dialog, and a user who would rather not
  type a master password into our window can still `bw login` + `bw unlock`
  themselves.
- **The sign-in dialog never moves to the phone**, for SPEC 29 §10's reason
  about the unlock prompt: a master password typed into a relay-forwarded web
  view is a materially worse place for it. The phone-approval pill (SPEC 29 Q1)
  is unaffected.
- Non-Windows platforms still get `DenyingApproval`; with no dialog, sign-in
  reports `no-dialog` (§5), and never fills.

---

## 9. SPEC 29 amendments

- **§4**, "The only password Paul ever types into anything fleet-adjacent is
  the Bitwarden **master password**, at unlock time (§5)." becomes: "The only
  secrets Paul ever types into anything fleet-adjacent are Bitwarden's own — the
  master password at sign-in and unlock time, and at sign-in the account email
  and any verification code — and only into the broker's own dialogs (§5, §10)."
- **§5**, "One-time setup: install the Bitwarden CLI on the PC and `bw login`
  once." becomes: "install the Bitwarden CLI. The first broker use signs it in
  through the broker's own dialog (this story); `bw login` in a terminal remains
  available and is the fallback for accounts the dialog declines."
- **§15**, the row "`bw` absent or signed out → `vault-unavailable` — tell the
  user to install/sign in" splits into: absent → unchanged; signed out → the
  sign-in dialog, then `vault-unavailable` with §5's detail if it does not
  complete.

All three are recorded in agent-fleet-poc's `docs/spec-29-credential-broker.md`
when this ships.

---

## 10. Tests and verification

### 10.1 Driver (`tests/credential-bw-login.test.ts`, fake child, no `bw`)

The driver takes five seams: `spawn` (the child), `findBwProcess(childPid)`
(the §4.4 lookup; resolves a PID, `'self'`, or `null`, may reject),
`killPid(pid)` (so no test can ever signal a real PID on the machine running
it), `platform` (so the Windows-only branches run on any machine), and its
timers (a fake clock). A scripted fake child emits stderr chunks and records
stdin writes, stdin end, kills, exit, and the command/argv/env it was spawned
with; the fake `killPid` records the PIDs it was asked to kill. Where a script says
"echo", the fake emits fact 4's exact shape — the prompt re-rendered once per
character of the answer — immediately after the driver's write.

1. **Happy path, no two-step:** email and password prompts answered in order;
   exit 0 with a key on stdout → success carrying that key; `onEvent` saw
   `answered: email`, `answered: password`, in that order.
2. **Echo is not a re-ask:** the same run, with echo after both writes and the
   password's two renders → **success**, the password prompt answered, nothing
   killed, each value written exactly once. (A driver that treats the echo as a
   repeat kills before `Master password:` and fails here.)
3. **A chunk boundary mid-prompt:** `? Email ad` then, in a later chunk,
   `dress:` → the email is answered and the run succeeds; nothing is judged
   unknown. Same again with the boundary inside the delimiter: `?` then
   ` Email address:`. And inside an ESCAPE sequence — `…\x1b[2` then
   `K\x1b[G? Master password:` — the password is still answered (the
   half-escape must not be read as text, or the next `? ` is skipped).
4. **Two-step:** `Two-step login code:` → the code dialog is asked with kind
   `two-step` → the code is written, then echoed → success.
5. **New device:** the new-device prompt → kind `new-device` → success.
6. **Method list:** `Two-step login method:` → stopped, `unsupported-step`,
   nothing written after it.
7. **Unknown prompt:** `? Something new:` after the password → stopped at
   once, `unsupported-step` — asserted with a fake clock advanced by less than
   a second, so a driver that merely times out fails.
8. **Re-ask:** email, password, then `Email address:` again → stopped,
   `failed`, the email not written a second time.
9. **Code dialog cancelled** → stopped, `cancelled`.
10. **Quiet timer:** after the password is written the fake prints nothing and
    does not exit → stopped at 60s (fake clock), `quiet`; and **not** stopped
    at 59s. Second case: a code dialog held open for 170s is not stopped by
    the quiet timer.
11. **Deadline:** a code dialog that never answers → stopped at 6 minutes,
    `timed-out`; the dialog's late answer, delivered after, is **not written**.
    Separately: an `'error'` emitted on the child's stdin (EPIPE, a write
    racing `bw`'s exit) does not throw — the fake stdin is a real
    `EventEmitter`, whose `emit('error')` throws when nobody listens.
12. **Classification:** fact 6's wrong-password text → `rejected`; `Invalid
    verification code.` → `code-rejected`; `You are already logged in as
    x@y.` → `already-signed-in`; exit 0 with empty stdout → `failed`; exit 0
    with two tokens → `failed`.
13. **The launch is exactly `login --raw`** — for a `.cmd`, `cmd.exe /d /s /c
    ""<binary>" login --raw"` with `verbatim` — and neither the email nor the
    password is in the command or any arg. A binary path containing `%` is
    refused before anything is spawned.
14. **env**, given an ambient environment containing `BW_SESSION`,
    `Bw_NoInteraction=true` (a case variant), `BW_QUIET=true`, `BW_RESPONSE`,
    `BW_CLEANEXIT`, `BW_PRETTY`, `BW_RAW`: none of them survives in any casing,
    and no value in the env equals the password or the email.
15. **stderr never escapes:** a failing run whose fake stderr includes a canary
    string → the canary is in no field of the result and in no `onEvent`
    payload.
16. **Stop means all three steps:** `platform: 'win32'`, `findBwProcess`
    resolved PID 4242; any stop (the quiet timer, here) ends stdin, calls
    `killPid(4242)`, then `kill()`s the spawned child — in that order. After
    the spawned child emits **`exit`** (its stdio still open, so the driver
    has not settled), a stop does **not** call `killPid`. After an **`error`**
    from the child, it still does — an error is not an exit. And a stop before
    `bw` was ever identified runs the lookup first: `killPid(999)`, then the
    spawned child. And a `kill()` that fails by emitting `error`
    synchronously does not restart the stop: `kill()` once, `killPid` once.
17. **No PID, no password:** `platform: 'win32'`, `findBwProcess` resolving
    `null`, then separately rejecting → each stopped at the email prompt,
    `failed`, **nothing written at all** — not the email, not the password. A
    lookup that never settles writes nothing either, and ends at the deadline.
    The lookup's own 10s timeout is pinned where it lives, on the real
    `findBwProcess` (Windows): given 1ms, it answers "not found".
18. **Shims and platforms:** on `win32`, a spawned `.exe` with
    `findBwProcess` → `'self'` records the child itself, and one → PID 77
    records 77 (a Scoop-style shim); a spawned `cmd.exe` resolving `'self'`
    is treated as not found (§4.4's table). On `linux`, `findBwProcess` is
    never called and a stop kills the child directly.

### 10.2 Broker, wiring, dialogs, vault

In `tests/credential-broker.test.ts` (fake `vaultStatus`, `signIn`,
`unlockVault`, `vaultUnlocked`), unless noted:

19. No key, status `unauthenticated` → `signIn` runs, `unlockVault` does not;
    success → the approval dialog is asked next.
20. No key, status `locked` → `unlockVault` runs, `signIn` does not.
21. No key, status `unlocked` → `unlockVault` runs (§2.2's table).
22. No key, status `cli-missing` → `vault-unavailable`, neither runs.
23. No key, `vaultStatus` **rejects** → `vault-unavailable` with the
    `status-failed` text, neither dialog runs, no throw out of `attemptLogin`.
24. Key held, lookup throws `not-logged-in` → `openVault` → `signIn` → the
    lookup is retried **once**; a second `not-logged-in` → `vault-unavailable`
    with the `not-logged-in` text, and the lookup ran exactly twice.
25. **Join:** two concurrent attempts while signed out → `vaultStatus` once,
    `signIn` once; both calls get its result.
26. **No stale status:** call B arrives while call A's `signIn` is pending.
    The fakes keep `vaultUnlocked()` **false** throughout and A's `signIn`
    ends `cancelled` — so §2.2's re-check cannot mask anything. Asserted:
    `vaultStatus` ran **exactly once** in total, `signIn` once, `unlockVault`
    never, and B got the `cancelled` text. (Run the status outside the flight
    and B runs its own: the count is 2.)
27. **Release:** after a flight settles `cancelled`, a new call raises exactly
    one new `signIn`; after a flight **rejects**, likewise — and the rejected
    flight's own callers got the `failed` text, not a throw.
28. Same join rule for unlock: two concurrent attempts on a locked vault → one
    `unlockVault`.
29. Every §5 row: each `SignInFailure`, and `status-failed`, maps to its exact
    `detail`.

In `tests/credential-vault.test.ts` (the existing `BwRunner` seam):

30. A call that classifies `not-logged-in` clears the held key; a call that ran
    with key A and fails **after** the key was replaced by B — the fake runner
    calls the public `vault.adoptSession(B)` while the lookup is in flight —
    leaves B in place.
31. `bwLaunch(binary, args, env, platform)`: on `win32` a `.cmd` or `.bat`
    binary is wrapped `cmd.exe /d /s /c ""<binary>" <args>"` with `verbatim`,
    honouring `COMSPEC`, with `/v:off`; a path with a space stays whole inside
    that line; a path with `%`, `"` or a line break is refused, and so is an
    argument that fails `SAFE_ARG` (`a&b`, `%PATH%`); an `.exe` is returned
    unwrapped; on `linux` nothing is wrapped. Path literals are `String.raw`:
    in a plain literal `'C:\npm\bw.cmd'` contains a newline, and a test
    comparing two equally mangled paths proves nothing.
    (`runBw` has no spawn seam; that it calls `bwLaunch` is a code-review
    check, and every existing vault test keeps passing.)

In a new `tests/credential-bw-process.test.ts`, the pure picker behind the
real `findBwProcess` — `pickBwChild(rows, wrapper)`, over rows of `{ pid,
parentPid, name, created }`:

32. One child of the spawned process, created after it → that PID. A
    `conhost.exe` child alongside it is ignored.
33. A row whose `parentPid` is the spawned process's but whose `created` is
    **before** it → excluded (the stale-PID case §4.4 exists for).
34. Zero candidates → `'self'`; two → `null`. (Whether `'self'` is usable is
    the driver's call, by what it spawned — test 18.)

In `tests/credential-broker.test.ts`, `describe('the sign-in wiring')`, against
`createLoginBroker({ vault, approval, driveLogin })` — in that file rather than
a new one because the wiring is reached through `attemptLogin`, which needs the
browser page, and a second real-browser test file for one feature is what
destabilised this suite before:

35. A non-Windows approval → `no-dialog`, and the injected `driveLogin` was
    **never called**.
36. Driver `already-signed-in` → `vault.unlock` is called with the password
    from the sign-in dialog, and no unlock dialog is raised.
37. Driver `quiet`: then status `locked` → `vault.unlock(password)`, no unlock
    dialog, `ok`; status `unauthenticated` → `unsupported-step`; status throws
    → `failed`.

In a new `tests/credential-dialog-fields.test.ts`:

38. `decodeDialogFields` round-trips `pässwörd-é-€-日本`, an empty value, and a
    value containing a newline.
39. **Windows only (skipped elsewhere):** the `Write-AiuiFields` function from
    `DIALOG_PREAMBLE`, run through `powershell.exe` with
    `[Console]::OutputEncoding` set to 437 as fact 9's probe did, emits a value
    that `decodeDialogFields` returns intact — with no window shown (the
    function runs alone, not a dialog).
40. The sign-in, code and unlock scripts each call `Write-AiuiFields`; none
    writes a field with `[Console]::Out.Write` directly or through
    `Write-Output`; and `Write-AiuiFields` itself writes with
    `[Console]::Out.Write`.

### 10.3 Real processes (opt-in: Windows, and `bw` where named)

41. **The SSO state is stoppable — no `bw` needed.** A stub `fake-bw.cmd`
    runs a node script shaped like fact 10's second case: it prints `? Email
    address: `, reads a line, prints `? Master password: `, reads a line,
    closes readline, then listens on localhost with no timeout, having written
    its own PID to a file. The **real** driver runs it through the real
    `bwLaunch` and the real `findBwProcess`, with the quiet timer injected at
    2s. Asserted: the result is `quiet`, and the stub's PID is **not alive**
    afterwards. Without the recorded-PID kill, it survives (fact 10) and this
    fails. The test kills that PID itself in `afterEach` if it is ever found
    alive, so a failure cannot leak a process. If the CIM lookup itself errors
    on the machine (blocked WMI), the test is **skipped with that reason**
    rather than failed: it proves the stop, not the lookup.
42. **Prompt pinning (`bw` required):** throwaway `BITWARDENCLI_APPDATA_DIR`;
    the real driver, email + **empty** password → exactly `failed`, and
    `onEvent` recorded `answered: email` then `answered: password`. No
    network: the empty password is refused locally (fact 3). Fails if a `bw`
    upgrade renames either prompt or changes the echo so that §4.2 misreads it
    — the driver's one real fragility.
43. **Canary (`bw` required):** a throwaway appdata that first runs `bw config
    server https://127.0.0.1:9` (fact 11), then the real driver with a canary
    master password, the spawn observed. `onEvent` recorded `answered: email`,
    `answered: password`, `stopped: failed` — so the canary really was typed
    into bw's prompt, through its per-character masked echo, and the `failed`
    is the refused connection and not an early stop. The canary is in no
    command, no arg, and no env value, and it never left the machine, because
    the first request `bw` made was refused locally.
44. **A spaced install path, for real (Windows):** a `bw.cmd` under a folder
    named `with space` that prints `{"status":"unauthenticated"}` → a
    `BitwardenVault` pointed at it answers `status()` with `unauthenticated`.
    Test 41's stub also lives under `with space`, so the driver's launch is
    exercised on a spaced path too. Revert `bwLaunch` to the old line and both
    fail.

### 10.4 Mutation check

Each rule is removed in turn and the named test must fail: treat an echo as a
re-ask (2); match renders across the whole buffer (2, 8); judge a trailing
render before it is complete (3); drop the unknown-prompt stop (7); drop the
quiet timer (10); write a late code (11); pass the email as argv (13); delete
env names case-sensitively (14); put stderr in a result field (15); skip the
recorded-PID kill (16, 41); write when no PID was found (17); drop the lookup timeout (17); treat a
wrapper's `'self'` as `bw` (18); kill the recorded PID after the spawned
process's `exit` (16); treat a child `error` as an exit (16); skip the lookup
when stopping an unidentified `bw` (16); drop the partial-escape rule (3); drop
stdin's `'error'` listener (11); restore the old `cmd.exe` line (31, 44);
refuse nothing in the binary path (31); make the driver stop at the email
prompt, before the password is ever written (43 — whose `failed` alone would
have passed); drop stop()'s re-entry guard (16); let `bwLaunch` trust its
callers' arguments (31); drop `/v:off` (31); drop the
creation-time filter (33); run `vaultStatus` outside the flight (26); never
release the flight (27); clear the key without comparing (30); retry
`not-logged-in` without bound (24); map `quiet` straight to `unsupported-step`
without asking status (37); skip Base64 in the unlock script (40); write fields
through the output stream (40); write fields with plain `[Console]::Out.Write`
in the helper (39). A rule whose mutation leaves the suite green has no test,
whatever the file says.

### 10.5 Live

- Each dialog is shown for real and **seen** — a screenshot of each, since a
  dialog that opens hidden is SPEC 29's known trap — and cancelled.
- The end-to-end sign-in of the verification rule, step (1), is done by Paul
  with his own account. It is also how his machine gets signed back in.

**Done 2026-09-22** (the first bullet): each of the sign-in, code (both
kinds) and unlock dialogs was raised through `WindowsDialogApproval`, found by
its exact title from a second process, confirmed `IsWindowVisible`, captured
with `PrintWindow`, then driven with window messages. The sign-in and unlock
dialogs returned `pässwörd-é-€-日本` intact; a new-device code typed as
`123 456` came back `123456`; closing either kind of dialog returned null; the
Sign in and Verify buttons stayed disabled until their fields had text. A
trap for whoever repeats this: `FindWindow($null, …)` from PowerShell passes
an EMPTY class name, not null, and finds nothing — use `[NullString]::Value`.
The first attempt tripped on exactly that, reported every dialog "not
visible", and left real dialogs open on screen until their timers ran out.

---

## 11. Found while designing, split off

`BitwardenVault.childEnv()` sets `BITWARDENCLI_NOINTERACTION`, which `bw`
never reads (fact 2). Fixing it is not a rename: `unlock()` writes the password
to an interactive prompt that exists only *because* the guard is broken. That
is its own change with its own tests. This story only ensures the new driver
is immune to both the bug and its eventual fix.

**Fixed on `claude/bw-nointeraction`** (stacked on this branch). `childEnv`
now takes a mode: status, sync, list and get set `BW_NOINTERACTION=true`;
unlock REMOVES it in any casing, including one the user set themselves, and
now goes through the `BwRunner` seam so what it receives is tested. Reading
the bundle corrected one prediction above: with prompts off, a lookup on a
locked vault does not answer "Master password is required…" — that text comes
only from the unlock command (`CliUtils.getPassword`). A lookup takes
`BaseProgram.handleLockedUser` and answers `Vault is locked.`, which `LOCKED`
already matched; with prompts ON, as before the fix, it instead ran an inline
unlock and drew a password prompt on a closed stdin. Not measurable offline —
`bw unlock` checks for an account before it asks for a password — so the
unlock half rests on the bundle's code until a real account is used.
