# 025 — Step cache: hash is data-aware only for values that appear in step *text*; data used elsewhere can replay stale

**Status:** open / medium priority (completeness gap; not fully traced)
**Area:** [src/server/session-manager.ts:1548-1556](../src/server/session-manager.ts#L1548) (hash source interpolated — but only the *step* array), [src/server/session-manager.ts:1503-1534](../src/server/session-manager.ts#L1503) (`cacheHashSource` is the step list), [src/parser/interpolate-env-data.ts:53-92](../src/parser/interpolate-env-data.ts#L53) (`interpolateEnvData`)
**Related:** [issues/018-step-cache-blind-to-data-file-value-changes.md](018-step-cache-blind-to-data-file-value-changes.md) — this is the explicitly-named "Completeness gap" follow-up from 018, promoted to its own issue. [issues/011-env-bundle-cached-for-session-lifetime.md](011-env-bundle-cached-for-session-lifetime.md), [issues/026-cache-data-edit-missed-on-coarse-mtime.md](026-cache-data-edit-missed-on-coarse-mtime.md).
**Opened:** 2026-06-03

## Summary

Issue 018 made the bundle hash sensitive to `${data.*}` / `${env.*}` /
`${source.*}` values — but **only where those values are interpolated into the
step text that gets hashed**. A data value that influences the run through some
*other* channel — a `## Parameters` default, a `baseUrl` / config override, a
`dataSources` path, or a tool/skill argument that isn't inlined as visible step
text — is **not** in the hash. Editing such a value won't bust the cache, so a
cached plan can replay against stale data.

018 named this and deliberately scoped it out ("Some of those ride other
mechanisms; not yet traced"). This issue exists to **enumerate every channel,
verify which actually replay stale vs. ride another invalidation, and close or
document each.**

## Mechanism

The hash source is the **step list** and nothing else
([session-manager.ts:1533](../src/server/session-manager.ts#L1533)), then each
step string is run through `interpolateEnvData`
([session-manager.ts:1549](../src/server/session-manager.ts#L1549)). Data that
never lands in a step string is therefore invisible to the hash. The cache's
only whole-test invalidation lever is that hash, so an out-of-text data change
leaves every per-step entry valid → cache hit → stale replay.

## Candidate leak channels (need tracing)

Each of these references data but may not surface as hashed step text. Status
column is a hypothesis to confirm, **not** verified:

| Channel | Example | Hypothesis | Why uncertain |
|---|---|---|---|
| `## Parameters` default sourced from data | `region: ${data.region}` | Likely **rides safely** — params are re-resolved each run and forward-interpolated at read | But only if the param actually appears as `{{region}}` in a step; if it feeds targeting, see [024](024-cache-value-driven-element-targeting-rides-cache.md) |
| `baseUrl` / config override from data | `baseUrl: ${data.host}` | **Suspect stale** — a cached `navigate` whose absolute URL the AI built from the old host is frozen | `executeNavigate` *does* resolve **relative** URLs against baseUrl at exec time ([actions.ts:294-309](../src/browser/actions.ts#L294)) → safe; but the prompt actively offers "full **or** relative URL" ([prompts.ts:171](../src/ai/prompts.ts#L171)) and shows the AI the Base URL ([prompts.ts:65](../src/ai/prompts.ts#L65)), so an **absolute** emission is expected behaviour, and that URL is frozen → stale. The stale path is reachable, not a fluke. |
| `dataSources` *path* selection | `../data/${envName}-endpoints.json` | **Suspect stale** — switching which *file* is loaded changes values without changing step text if the referenced keys resolve to text that … | path interpolation is parse-time; need to confirm whether the resolved values reach hashed text. **Couldn't determine from code** — test-specific. |
| Tool / skill argument from data | `[skill: x cfg="${data.cfg}"]` | **Confirmed busts** ✅ | Skill args are interpolated into expanded step text ([expander.ts:458](../src/skills/expander.ts#L458)), which *is* `cacheHashSource` on the expand branches and then re-run through `interpolateEnvData` ([session-manager.ts:1548](../src/server/session-manager.ts#L1548)). Worth a regression test to pin it. |
| Assertion `expected`/`condition` derived from data | AI-emitted assert comparing to a data value | **Likely rides 018** — probably already covered | For the AI to put a data value into `expected`, that value had to appear in the resolved step text it saw — which means it's *also* in hashed text, so 018 already busts it. The fingerprint ([step-cache.ts:228](../src/cache/step-cache.ts#L228)) would freeze it only if a counter-example exists where the literal is data-derived *without* the data appearing in any step. Treat as open only with such a counter-example. |

## Worked example (the most likely real bug)

```
## Config
baseUrl: ${data.host}

## Steps
1. Go to the account settings page
```

- **Run 1** — `data.host = "https://dev.example.com"`. The AI emits
  `{ action: "navigate", value: "https://dev.example.com/account/settings" }`
  (absolute, built from the host it was told). Step text `"Go to the account
  settings page"` contains no data ref → hash source is `"Go to the account
  settings page"`.
- **Run 2** — edit data so `host = "https://qa.example.com"`. Step text is
  byte-identical → **hash unchanged** → cache HIT → replays the **dev** URL. The
  test silently exercises the wrong environment.

(Whether this exact case bites depends on whether the AI emitted an absolute URL
vs. a relative path resolved against baseUrl at execution time — hence the
"trace it" framing.)

## Fix sketches

**Option A — fold referenced data files' fingerprints into the cache meta
(backstop, recommended).** 018 already suggested this. When the run resolves
`${data.*}` / `${source.*}` / `dataSources`, record a content hash (or mtime —
see caveat in [026](026-cache-data-edit-missed-on-coarse-mtime.md)) of each
referenced file in `meta.json`. Any change to a file the test depends on busts
the bundle, regardless of *how* the value was consumed. Coarse (whole-file
granularity) but complete and channel-agnostic.

**Option B — trace and close per channel.** For each row above, either prove it
rides another invalidation (and add a regression test pinning that) or route its
resolved value into the hash source. Most faithful, most work; risks missing a
channel we didn't enumerate.

**Option C — narrow scope to confirmed-stale channels.** If tracing shows only
`baseUrl` and `dataSources` path are stale, fold just those resolved values into
the hash source array (append a synthetic hashed line). Targeted, but still
leaves "unknown unknowns".

**Recommended:** Option A as the safety net (one cache-meta field, channel-
agnostic), plus Option B's tracing to decide whether the net can be loosened
later.

## Open questions

1. Does `navigate` resolve relative URLs against `baseUrl` at **execution** time
   (making the baseUrl example safe), or does the AI typically emit absolute
   URLs (making it stale)? This determines whether the headline example is real.
2. Which `dataSources` path changes actually alter values *without* altering any
   hashed step text? Is `${envName}`-driven file selection already covered
   because env switches change other hashed content?
3. Are assertion conditions/expecteds ever populated from `${data.*}` such that
   the fingerprint freezes a stale comparison value?
4. For Option A, file content-hash vs. mtime: content-hash avoids
   [026](026-cache-data-edit-missed-on-coarse-mtime.md)'s coarse-mtime hole but
   costs a read+hash of every referenced data file per run. **Note the cost is
   smaller than it looks:** named & default dataSources are *already* parsed into
   `envDataCtx` (`ctx.data` / `extraData`) at hash time
   ([session-manager.ts ~1556](../src/server/session-manager.ts#L1556)), so
   hashing the already-loaded tree needs no extra file read — only the
   coarse-mtime-vs-content-hash choice from [026](026-cache-data-edit-missed-on-coarse-mtime.md)
   remains. Acceptable?
5. Should `## Parameters` defaults that resolve from data be reclassified as
   "data" (bust) rather than "param" (ride) when they don't appear as `{{x}}` in
   any step?

## Tests this would need

- Per confirmed-stale channel: edit the out-of-text data value, re-run, assert
  the cache is busted (or the stale value is *not* replayed).
- A skill-argument-from-data case: confirm it **does** bust (pins the safe path).
- A param-default-from-data case that appears as `{{x}}` in a step: confirm it
  rides correctly (new value forward-interpolated), proving we didn't over-bust.
- If Option A lands: editing any referenced data file busts the bundle even when
  no step text changed.
