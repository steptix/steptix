# R12_skills_parser_env

## Summary
- Files: 35 · tests (approx): ~630 `it`/`it.each` declarations (more at runtime from table loops) · High ~430 · Medium ~140 · Low ~56 · Defects 7 · Flake risks 5 (all medium, none high)
- The batch is mostly strong. The parity files are real: both sides exist and ship (`runner-core/src/{use-step,whole-step-bracket,section-index,step-lines,data-rows}.ts` are consumed by `steptix-vscode/src`, `src/ui/step-skip.ts` is used by the Electron renderer), they import runner-core from `src/` rather than a stale `dist/`, and each one checks that its corpus actually reaches the branches it claims to cover. The env/config loaders cover real precedence and edge branches, not trivial ones.
- The low-value tests follow three patterns. (1) Longhand duplicates of one branch: four `isConditionalStep` cases that all hit `if\s`, five `## Config` keys that all go through the same generic `parseKeyValueList`, subfolder variants of skill-expander tests, and the whole expandSkills half of source-skill-attribution. (2) Two dead subjects with no production caller: `summarizeSpec` and `interpolateEnvDataDeep`. (3) A few seam tests that re-check a pure function's vocabulary, such as INTERACTIVE_ON_FAILURE truthiness and parser syntax errors re-run through expandSkills.
- The defects are mostly test names or comments that claim more than the test asserts. Examples: "names both files when a section cycles", which asserts there is no cycle, and "pins a test to an env", which re-implements the CLI's pin decision inline.
- Flakiness is low overall. Nothing in the batch spawns a process, opens a port or starts a browser. process.env and cwd are restored in every file that changes them, and vitest's default `forks` pool with `isolate` keeps those changes per file. What is left: one date time-bomb (fails from 2031), a 5 s polling deadline, two fixed in-repo temp dirs keyed by a per-process counter, and two assertions that assume the developer's shell has no `ADMIN_PWD`.

## Flakiness risks

Context checked for every file: vitest 4 runs with the default `forks` pool and `isolate`, so changes to `process.env`, `process.cwd()` and module singletons such as `addLogCallback` and the skill cache stay inside one file's process. Within a file, every test in this batch that changes `process.env` or the cwd restores it (config-loader, env-data-loader, resolve-env-bundle, multi-env-integration, data-sources-integration, data-rows-runner, ui-runner-adapter-*). No test in the batch spawns a child process, binds a port, launches Chromium, reads `dist/`, or uses `Math.random`. The section-index fuzz uses a seeded LCG. config-loader points `LOCALAPPDATA`/`XDG_CONFIG_HOME` at a per-test tmp dir, and env-user-root injects deps, so neither touches the real `%LOCALAPPDATA%\steptix`. Parser line splitting is `/\r?\n/` in both the CLI and runner-core, so a CRLF checkout of the read-only fixtures is safe.

### `tests/use-ai-step-runner.test.ts:188` — "exactly the resolved text: one system message, one user message, nothing else from the test"
- Mechanism: the fixture date is a fixed future year (`const scope = { today: '2031-01-05', ... }`), and the test then asserts `expect(all).not.toContain(String(new Date().getFullYear()))`, where `all` is the JSON of the request and holds the user message `Today is 2031-01-05. ...`. From 2031-01-01 the current year is `'2031'`, so this assertion fails on every run. On 2031-01-05 `realToday` matches too.
- Risk: medium (deterministic time-bomb rather than intermittent, but certain)
- Fix: build the fixture year from the clock so it can never equal it, e.g. `const year = new Date().getFullYear() + 5; const scope = { today: `${year}-01-05`, ... }`, and expect `${year+5}0108`-style values accordingly. Or drop the `getFullYear` check and keep only the `realToday` one.
- Evidence: read the line. `buildUseAiPrompt` (src/ai/prompts.ts) contains no digits, so the user message is the only source of a year.

### `tests/ui-runner-adapter-env-data.test.ts:323` (helper at `:138`) — "a steer resolves against the same environment; ..."
- Mechanism: polling with a wall-clock deadline: `async function waitFor(condition, timeoutMs = 5000) { const deadline = Date.now() + timeoutMs; ... setTimeout(resolve, 5) }`, used as `await waitFor(() => events.some((e) => e.channel === 'runner:paused'))`. Before it pauses, the adapter must parse the file, resolve the env bundle and walk to breakpoint 1. vitest.config.ts itself says a test that takes a second alone "can take several" while every worker starts, and testTimeout was raised to 30 s for that reason. This helper keeps its own 5 s budget.
- Risk: medium (a loaded CI box at suite start-up)
- Fix: resolve a promise from the emit callback instead of polling, e.g. `const paused = new Promise<void>((r) => { emit = (ch, d) => { events.push(...); if (ch === 'runner:paused') r(); } })`. Or at least raise the default to ~20 s so the test timeout, not this helper, is the limit.
- Evidence: reasoning from vitest.config.ts:14-20. No flake commit in this file's history (69dc5d4, 3f933c9, d72393f).

### `tests/use-ai-step.test.ts:33` — file-level temp dir (affects every test in the file that calls `write`)
- Mechanism: a fixed path inside the repo plus a per-process counter: `const tmpBase = path.join(repoRoot, 'tests', '.tmp-use-ai-step'); ... dir = path.join(tmpBase, `t${counter++}`)`, and `afterAll` does `fs.rm(tmpBase, { recursive: true, ... })`. Two runs of this file from one checkout at the same time (watch mode plus `npm test`, or two agents in one worktree) use the same `t0…tN` directories, and whichever finishes first deletes the other's tree mid-run. A run that dies before `afterAll` leaves `t*` directories that the next run reuses without emptying. EBUSY on Windows is already handled (`maxRetries: 10, retryDelay: 100`, commit 5e61f46).
- Risk: medium (needs concurrent runs in one checkout)
- Fix: `beforeAll(async () => { tmpBase = await fs.mkdtemp(path.join(repoRoot, 'tests', '.tmp-use-ai-step-')); })`. This keeps the in-repo location the code-behind bundle needs and makes each run unique.
- Evidence: 5e61f46 "Retry removing in-repo temp dirs that Windows briefly locks" names 28 suites with this `tests/.tmp-*` pattern. It hardened the delete but not the fixed path.

### `tests/use-ai-runner-cli.test.ts:128` — file-level temp dir (all 9 tests)
- Mechanism: same as above: `const tmpBase = path.join(repoRoot, 'tests', '.tmp-use-ai-runner-cli'); ... dir = path.join(tmpBase, `t${counter++}`)`, and `afterAll` removes the whole base.
- Risk: medium
- Fix: `fs.mkdtemp(path.join(repoRoot, 'tests', '.tmp-use-ai-runner-cli-'))` in a `beforeAll`.
- Evidence: same as above (5e61f46 touched this file).

### `tests/resolve-env-bundle.test.ts:92` — "resolves $VAR leaves in the data file against the composed map (no global mutation)" (also `:40`)
- Mechanism: the test assumes the ambient environment never defines these names. `expect(process.env['ADMIN_PWD']).toBeUndefined()` at :103, and `expect(process.env['BASE_URL_PURE']).toBeUndefined()` at :49, run without deleting the key first. The afterEach only removes keys the test added. `ADMIN_PWD` is the name the repo's own fixtures reference (`fixtures/data/uat.json`, `staging.json` use `$ADMIN_PWD`), so a developer who has exported their project `.env` into the shell fails this test with no code change.
- Risk: medium
- Fix: `delete process.env['ADMIN_PWD']` (and `BASE_URL_PURE`) at the top of each test, as `env-data-loader.test.ts:67`/`:79` already do. Or use a name nobody would export, such as `RESOLVE_BUNDLE_TEST_PWD`.
- Evidence: reading. `afterEach` restores from a snapshot taken at module load, so it cannot help with a value that was already present.

Already guarded and not flagged: data-sources-integration (sets HOME/USERPROFILE in `beforeAll` and restores them in `afterAll`), ui-runner-adapter-* (`process.chdir` per test, restored in `afterEach`; valid because the pool is `forks`), config-loader (user root redirected, env restored, `chdir` inside try/finally), and use-ai-step's MCP block (mkdtemp, with `rmSync` retries).

## Per-file verdicts
| File | Tests | Verdict (High/Medium/Mixed/Low) | One-line note |
|---|---|---|---|
| config-loader.test.ts | 42 | Mixed (mostly High) | Real precedence chain (env > file > machine .env > default), deep merge, retired-section warn, schema checks. Some INTERACTIVE_ON_FAILURE cases re-test parseBoolEnv, one cannot fail, and the default literals broke once on a model rename. The first describe reads the repo's own steptix.config.json. |
| env-loader.test.ts | 13 | Mixed (mostly High) | Tight branch coverage of parseEnvFile/parseBoolEnv. One combined "multiple lines" case reaches no new branch. |
| env-data-loader.test.ts | 19 | High | Every branch of loadDataFile, resolveSecrets and lookupDataPath. Two near-duplicate one-liners. |
| env-user-root.test.ts | 12 | High | Platform branches injected through deps, so the real user root is never touched. The append-joiner, never-rewrite and blank-key cases are real edges. |
| interpolate-env-data.test.ts | 23 | Mixed | Good edge coverage (null leaf, arrays, unknown namespaces, shared-pattern parity). The 3 `interpolateEnvDataDeep` tests cover dead code, and 2 mixed-namespace cases are duplicates. |
| resolve-env-bundle.test.ts | 12 | High | Pure-vs-mutating paths and layering precedence. Two assertions assume `ADMIN_PWD`/`BASE_URL_PURE` are unset in the shell (flake section). |
| multi-env-integration.test.ts | 5 | High/Medium | A real seam from file to resolver to parser. The frontmatter-pin test re-implements the CLI's decision itself (defect). |
| data-sources-integration.test.ts | 7 | High/Medium | Absolute, `~`, relative, missing and array sources through the real parser. The "relative" test duplicates the first test's `./overrides.json`, and its comment about cwd is wrong. |
| skill-data-sources.test.ts | 8 | High | Skill-private sources, `${envName}` routing, cache key including envName. One test is subsumed by the cache-key test. |
| parser.test.ts | 47 | Mixed (mostly High) | Data-row table refusals and env-token preservation are high value. Five `## Config` key tests all hit one generic `parseKeyValueList`. |
| parser-inert-headings.test.ts | 8 | High | Regression for absorbed `####` items. One test name contradicts its assertion, and the `write` helper leaks two tmp dirs per run. |
| parser-section-linespans.test.ts | 20 | High | The two-pass alignment check, including the cancelling-divergence and continuation cases. |
| parser-sections.test.ts | 18 | Mixed (mostly High) | The shared frozen fixture plus name validation. `:69` is a near copy of linespans:91, and `:154` can only see the fixture's first heading. |
| section-index-cli-parity.test.ts | ~9 (+26 table rows, 10 control rows, 8 wrap rows) | High | A true cross-package parity test (runner-core index vs CLI parser and expander) with a seeded fuzz and guards against passing vacuously. The table loop has an uncounted early-return path. |
| step-line-span-parity.test.ts | 6 (x2 fixtures) | High | Holds the server's span scanner to the frozen table that runner-core and the extension also assert. |
| sections-integration.test.ts | 10 | Mixed | The internal-fixture block is high value. The shipped-template block pins exact template wording and line numbers. |
| skill-call-parser.test.ts | 55 | Mixed (mostly High) | Traversal, link-not-call, caret columns and the colon/colon-less split are high value. About 7 longhand duplicates of happy-path shapes. |
| skill-expander.test.ts | 33 | Mixed (mostly High) | Cycles, namespacing, alias errors and containment are high value. The subfolder variants and the syntax errors re-run through expandSkills are duplicates. |
| skill-expander-frame-id-uniqueness.test.ts | 3 | High | Regression for the shared `seq` counter bug. |
| skill-expander-frames.test.ts | 5 | High | Frame/origin shape. One test name says "omits" but asserts `[]`. |
| skill-expander-sections.test.ts | 51 | High | Shared match table, scope transparency, the `runSteps` occurrence-offset suite. One test name contradicts its assertion. |
| skill-shorthand-integration.test.ts | 2 | Medium/High | The shorthand == long-form equivalence on real fixtures is the valuable half. |
| source-skill-attribution.test.ts | 7 | Mixed | The hook toolCall/sourceSkill alignment tests are high value. All four expandSkills attribution tests duplicate skill-expander. |
| spec-loader.test.ts | 10 | Mixed | `extractSpecUrlsFromContext` (used by `steptix specs`) is fine. `summarizeSpec` has no production caller. |
| step-grouper.test.ts | 23 | Mixed (mostly High) | The control-line-vs-watch section is high value. Four `If …` prefix cases hit one regex alternative, and the MFA case repeats `:62`. |
| ui-runner-adapter-env-data.test.ts | 5 | High | Regression for issue 052 through the real adapter loop. The polling deadline is a medium flake risk. |
| ui-runner-adapter-use-ai.test.ts | 4 | High | Per-loop coverage of `[use ai]` in the Electron runner. |
| ui-skip-line-parity.test.ts | 10 | High/Medium | Both sides exist and ship. The source-text regex pins are loose but correct. |
| use-ai-runner-cli.test.ts | 9 | High | The CLI loop is real (dispatch, value flow, masking of row/skill secrets); only the executor, browser and model are seams. In-repo tmp dir with counter (flake section). |
| use-ai-step.test.ts | 19 | High | Parser, skill rule, grouper, computer lock, three compile classifiers, MCP pre-flight. In-repo tmp dir with counter (flake section). |
| use-ai-step-runner.test.ts | 54 | High | Exhaustive wire, masking and retry contract for the shared runner. Has the 2031 time-bomb. |
| use-step.test.ts | 42 | High (2 Low) | Grammar accept/refuse tables with caret columns. One constant-literal pin and one repeated refusal. |
| use-step-parity.test.ts | 8 | High | CLI vs runner-core grammar compared answer for answer, including message text and a branch-coverage guard. Two lines hold invisible NBSP literals. |

## Low-value tests

### `tests/config-loader.test.ts:83` — "sets execution.interactiveOnFailure=false when INTERACTIVE_ON_FAILURE=false"
- Category: L2
- Evidence: the default is already `interactiveOnFailure: false` (`src/config/defaults.ts:68`), and the test asserts `expect(config.execution.interactiveOnFailure).toBe(false)`. If the loader ignored `INTERACTIVE_ON_FAILURE=false` entirely (the `parseBoolEnv` branch at `src/config/loader.ts:113-119`), the test would still pass. It cannot tell "parsed false" from "ignored".
- Recommendation: rewrite so the base is `true` (a config file with `execution: { interactiveOnFailure: true }`, then env `false` must win), or delete.
- Confidence: high

### `tests/config-loader.test.ts:89` — "accepts 1/yes/on as truthy" and `:97` — "ignores garbage values and falls through to default"
- Category: L3
- Evidence: the truthy/garbage vocabulary belongs to `parseBoolEnv` and is already table-tested at `tests/env-loader.test.ts:71` (`it.each(['true','TRUE','1','yes','Yes','on','ON'])`) and `:79` (`parseBoolEnv('maybe')` → undefined). The loader's only logic is `if (interactiveOnFailure !== undefined)` (`src/config/loader.ts:114`), which the seam test at `:77` already covers. These two are extra seam tests that differ only in the input string.
- Recommendation: delete both. Keep `:72` (default) and `:77` (seam).
- Confidence: high

### `tests/config-loader.test.ts:143` — "deep-merges a single domNoiseReduction flag, keeping the other six"
- Category: L3
- Evidence: the same generic `deepMerge` recursion (`src/config/loader.ts:28`) and the same input class (a partial object one level below `browser`) as `:134` "deep-merges a partial nested object, keeping sibling defaults". Sibling preservation under `browser` is asserted again at `:173` and `:185-186`.
- Recommendation: delete, or fold the `dnr.collapseRepetitiveDom` assertion into `:134`.
- Confidence: medium

### `tests/config-loader.test.ts:381` — "no machine values leaves the built-in default model untouched" (also `:388`, `:415`, `:456`)
- Category: L4 (partial; the behaviour is real, the literal is not)
- Evidence: `expect(config.ai.model).toBe('openai/gpt-5.6-luna')` and `toBe('https://llm.corp.example')` pin the current built-in defaults. `git log -- tests/config-loader.test.ts` shows `14944e2 Default model: openai/gpt-5.4-mini -> openai/gpt-5.6-luna` had to edit this file, so a harmless default change broke it.
- Recommendation: rewrite to compare against `DEFAULT_CONFIG.ai.model` / `DEFAULT_CONFIG.ai.gatewayUrl` (exported, `src/config/defaults.ts:4`). Keep the tests.
- Confidence: high

### `tests/env-loader.test.ts:47` — "parses multiple lines correctly"
- Category: L3
- Evidence: a blank line, `#` comments and plain `KEY=value` lines hit the same branches as `:5` (simple pairs), `:11` (blank lines) and `:16` (comments). No new branch of `parseEnvFile` is reached.
- Recommendation: delete (or move its `toHaveLength(3)` into `:11`).
- Confidence: high

### `tests/env-data-loader.test.ts:40` — "loads a nested JSON object" and `:130` — "returns the leaf type unchanged (boolean)"
- Category: L3
- Evidence: `:40` exercises the same parse-and-resolve path as `:54`, which also loads a nested object (`users.admin.password`) and reads a nested leaf. `:130` is the same `lookupDataPath` return path as `:126` (number). Neither reaches a new branch of `src/env/data-loader.ts`.
- Recommendation: delete `:40`; merge `:126`/`:130` into one `it.each`.
- Confidence: medium

### `tests/interpolate-env-data.test.ts:119`, `:139`, `:144` — the `interpolateEnvDataDeep` describe (3 tests)
- Category: L7
- Evidence: `grep -rn "interpolateEnvDataDeep" --include=*.ts --include=*.js .` (excluding node_modules/dist) finds only its definition and its two recursive self-calls (`src/parser/interpolate-env-data.ts:260,265,270`), this test file, and a regex name list in `tests/substitution-sites.test.ts:53`. There is no production caller in `src/`, `runner-core/src`, `steptix-vscode/src` or `flick-vscode/src`.
- Recommendation: delete the tests together with the export, or keep them only if a caller is planned.
- Confidence: high

### `tests/interpolate-env-data.test.ts:108` — "mixes env + data refs in one step" and `:202` — "still resolves env/data when extras are registered"
- Category: L3
- Evidence: `:167` "resolves multiple distinct namespaces in one step" already resolves `${env.BASE_URL} | ${data.users.admin.email} | ${vip…} | ${local…}` in one string with extras registered. That covers both an env+data mix and env/data resolution alongside extras.
- Recommendation: delete both.
- Confidence: high

### `tests/parser.test.ts:93`, `:100`, `:107`, `:423`, `:431` — `## Config` cdp / cdpTab / viewport / unmask (present and absent)
- Category: L3 (table-driven tests written longhand)
- Evidence: Config parsing is fully generic. `parseKeyValueList` (`src/parser/markdown.ts:1488-1501`) splits on the first `:` and stores every key, with no key-specific handling, as the comment at `:108` concedes ("The Config scan is generic"). `:86` "parses ## Config section key-value pairs" already covers that branch. The "cdp port shorthand" test asserts no shorthand at all (`toBe('9222')`, `cdpTab` undefined). `:431` asserts an undeclared key is `undefined`, which is true of any object.
- Recommendation: replace with one `it.each` over the keys, or delete and keep `:86` + `:192` (colon in value).
- Confidence: high

### `tests/parser-sections.test.ts:69` — "a #### heading with text opens an ignored region inside a body"
- Category: L3
- Evidence: the input `['# T','','## Steps','1. One','','### S','1. A','','#### Note','','2. B']` is byte-for-byte `tests/parser-section-linespans.test.ts:92` apart from `One`/`Call`. Both assert `sections['s'].steps` equals `['A']`, and linespans also checks the raw scan. The same rule is the subject of `tests/parser-inert-headings.test.ts:54`.
- Recommendation: delete (keep parser-section-linespans:91 and parser-inert-headings:54/62).
- Confidence: high

### `tests/parser-sections.test.ts:154` — "refuses every hashes-only depth in the shared fixture"
- Category: L3 (and the name over-claims)
- Evidence: `classification-hashes.md` has `###` (line 10), `####` (14) and `#######` (18). `parseTestContent` throws on the first, so only `###` is ever checked, and that is already `:145`'s `it.each([['###',3],['####',4],['#######',7]])`. The fixture refusal is also asserted for the scanner at `tests/step-line-span-parity.test.ts:110`.
- Recommendation: delete, or rename to "refuses the shared hashes-only fixture".
- Confidence: high

### `tests/skill-data-sources.test.ts:53` — "routes ${envName} in a path string to the matching JSON file"
- Category: L3
- Evidence: `:91` "skill cache key includes envName…" writes the same files, runs the same two expansions (local, staging) and asserts the same URLs, but without `clearSkillCache()` between them. `:91` passing implies `:53` passes, and `:53` reaches no branch that `:91` does not.
- Recommendation: delete `:53` (or merge its exact `toEqual` into `:91`).
- Confidence: high

### `tests/data-sources-integration.test.ts:140` — "resolves a relative dataSources path against the test file directory, not cwd"
- Category: L3 (and the comment is wrong)
- Evidence: `:101` already declares `local: ./overrides.json` and asserts `resolveStep(parsed, 3)` is `'Place order 50000 USD'`, which resolves through the same relative path. The comment's premise, "cwd is the project root (tmpRoot)", is false: nothing chdirs, so cwd is the repo root. The test still discriminates, but for a different reason than it states.
- Recommendation: delete. `:101` already proves that relative paths resolve against the test file's directory.
- Confidence: medium

### `tests/skill-call-parser.test.ts` — longhand duplicates: `:82`, `:128`, `:133`, `:143`, `:148`, `:226`, `:280`
- Category: L3
- Evidence:
  - `:82` "the COLON form still commits and throws" uses exactly the inputs of `:306` (`'[skill: ]'` → name missing) and `:350` (`'[skill: foo bar="x"baz="y"]'`).
  - `:128` "omits the label when the call sits at start-of-line" is implied by `:176`'s full `toEqual` (no `label` key).
  - `:133` "omits the label when only whitespace precedes the call" uses the same input `'   [skill: foo]'` as `:189`.
  - `:143` "preserves internal whitespace inside the label" has input `'Click and verify  [skill: foo]'`, whose label contains only single spaces, so no internal whitespace is tested. It is `:138`'s trim case again (and a name/claim mismatch).
  - `:148` "combines label, args, output alias, and trailing comment" is the colon twin of `:49`, and `:236` covers the same combination path-qualified.
  - `:226` "deeply nested path-qualified name" is `:221` with one more segment; the name class has no depth rule.
  - `:280` "mixes shorthand and explicit args" is already covered by `:49` and `:236`.
- Recommendation: delete `:82`, `:128`, `:133`, `:148`, `:226`, `:280`. Rewrite `:143` with a real double space inside the label (e.g. `'Click  and verify [skill: foo]'` → `'Click  and verify'`) or delete it.
- Confidence: high

### `tests/skill-expander.test.ts:293`, `:333`, `:413` — subfolder variants of flat tests
- Category: L3
- Evidence: `src/skills/expander.ts` resolves `path.resolve(skillsDir, name + '.md')` the same way for any depth, and `:223` already proves subfolder resolution.
  - `:293` "expands a subfolder skill that calls another subfolder skill" is `:506` "expands nested skills recursively" with `flows/` prefixed. Same steps, same outermost-attribution assertion.
  - `:333` "renames a subfolder skill output when the caller aliases it" is `:158` with `flows/` prefixed.
  - `:413` "expands a deeply nested skill" (`a/b/c/d`) is `:223` with more segments.
- Recommendation: delete all three.
- Confidence: high

### `tests/skill-expander.test.ts:644` — "bare `out.<name>` for an undeclared output throws (catches typos)"
- Category: L3
- Evidence: after `parseSkillCall` desugars `out.resultcount` to the alias map `{resultcount:'resultcount'}`, the expander takes the same undeclared-output branch as `:200` (`out.bogus="x"` → `/no declared output "bogus"/`). The desugaring itself is unit-tested at `tests/skill-call-parser.test.ts:275`.
- Recommendation: delete.
- Confidence: medium

### `tests/skill-expander.test.ts:671`, `:677` — "throws on missing closing bracket", "throws on an unquoted `key=value` argument"
- Category: L3
- Evidence: these re-run `parseSkillCall` syntax errors through `expandSkills` and differ only in which error is triggered. The errors are unit-tested at `tests/skill-call-parser.test.ts:294` and `:330`, and `:665` already proves the seam (a SkillCallSyntaxError propagates out of expandSkills).
- Recommendation: delete both, keep `:665`.
- Confidence: high

### `tests/source-skill-attribution.test.ts:24`, `:32`, `:50`, `:87` — the whole `expandSkills — source-skill attribution` describe
- Category: L3
- Evidence:
  - `:24` (inline steps → `[null, null]`) duplicates `tests/skill-expander.test.ts:29-33`, which has the same assertion `expect(result.sourceSkills).toEqual([null, null])`.
  - `:32` and `:87` (inline steps around a skill, tagged correctly) are covered by `tests/skill-expander.test.ts:36-62` (`['search','search',null]`).
  - `:50` (nested skill → outermost name) duplicates `tests/skill-expander.test.ts:541-543` (`['outer','outer','outer']`). The same rule is asserted a third time at `:330`.
- Recommendation: delete the describe. Keep the `parseTestFile` describe (`:108`, `:138`, `:181`), which is the only coverage of `hookToolCalls`/`hookSourceSkills` alignment.
- Confidence: high

### `tests/step-grouper.test.ts:9`, `:13`, `:17` — "If asked to…", "If you see…", "If there is…"; and `:144` — "handles the MFA test case from mfa-conditional.md"
- Category: L3
- Evidence: `isConditionalStep` is `/^(if\s|when\s(prompted|asked))/i` (`src/runner/step-grouper.ts:82`). `:5`, `:9`, `:13` and `:17` all match the single `if\s` alternative. `:144` uses the same three-step shape (conditional, continuation, plain step) and the same assertions as `:62`.
- Recommendation: keep `:5`, `:21` and `:25` (one per alternative); delete `:9`, `:13`, `:17` and `:144`.
- Confidence: high

### `tests/spec-loader.test.ts:5`, `:30`, `:36`, `:42`, `:48` — the `summarizeSpec` describe (5 tests)
- Category: L7
- Evidence: `grep -rn "summarizeSpec" --include=*.ts --include=*.js --include=*.tsx --include=*.cjs --include=*.mjs .` (excluding node_modules/dist) finds only `src/api/spec-loader.ts:150` (the definition) and this test file. `src/cli/commands/specs.ts` imports `downloadSpec, listCachedSpecs, extractSpecUrlsFromContext`, but not `summarizeSpec`.
- Recommendation: delete the tests and the dead export, or wire it into the API prompt if that was the intent.
- Confidence: high

### `tests/use-step.test.ts:67` — "the closed set is exactly the two surfaces"
- Category: L5
- Evidence: `expect(USE_SURFACES).toEqual(['computer', 'browser'])` asserts a constant equals its literal. A third surface added by accident would already fail the PROSE/refusal tables (`'[use phone]'` must refuse, `:131`), and the CLI/runner-core agreement is pinned at `tests/use-step-parity.test.ts:180`.
- Recommendation: delete.
- Confidence: medium

### `tests/use-step.test.ts:589` — "[use computer] and click Save — keeps its whole-step refusal"
- Category: L3
- Evidence: `expect(useStepError('[use computer] and click Save')).toContain('is the whole step')` is a subset of `:146`, which asserts the same line, the same phrase, the fix text and the caret column.
- Recommendation: delete.
- Confidence: high

### `tests/sections-integration.test.ts:158`, `:172`, `:186` — the shipped-template block's exact-text and line pins
- Category: L4 (`:158`, `:186`) / L3 (`:172`)
- Evidence:
  - `:158` pins the template's exact step wording (`'Navigate to the login page'`, `'Change the display name to "Demo User" and save'`, …).
  - `:186` pins its line numbers (`[25, 29]`, `26, 27, 28, 30`). Any harmless rewording or added comment line in `templates/init/tests/sections-demo.md` breaks these without any parsing or provenance regression.
  - `:172` (body tagged, main flow null) is the same behaviour as the fixture block's `:56`.
  - The real contract stated in the header ("self-contained, one section called twice") is what `:150` already guards.
- Recommendation: keep `:150`. Rewrite `:158` to assert the structure: `sourceSkills` all null, the 5-step body appears twice, and `steps.length === 2*body + main`. Drop the line-number pins and `:172`.
- Confidence: medium

## Test defects

### `tests/multi-env-integration.test.ts:181` — "frontmatter env: pins a test to a specific env when no CLI flag"
- Category: Defect (the claim does not match what is tested)
- Evidence: the pin decision is coded in the test itself: `// Simulate CLI behaviour: parse first to read frontmatter, then re-parse with that env's bundle`, followed by `resolveEnvBundle({ envName: initial.frontmatter.env!, … })`. The production rule `if (!cliEnvName && initial.frontmatter.env)` (`src/cli/commands/run.ts:121-122`) never runs, so a regression there (e.g. frontmatter overriding `--env`) would pass. What the test actually checks is that `env:` frontmatter parses and the second parse resolves. The Electron path's version of this rule is covered for real by `tests/ui-runner-adapter-env-data.test.ts:223`.
- Recommendation: rename to "frontmatter `env:` is parsed and a re-parse with that env resolves", or drive the real run.ts selection.
- Confidence: high

### `tests/skill-expander-sections.test.ts:429` — "names both files when a section cycles across a skill boundary"
- Category: Defect (name contradicts the assertion)
- Evidence: the test asserts no cycle at all: `expect(parsed.steps).toEqual(['from skill'])`. Its comment says "Two files may define same-named sections without colliding". No error is raised and no file is named.
- Recommendation: rename to "same-named sections in a test and a skill do not collide (cycle key is per file)".
- Confidence: high

### `tests/parser-inert-headings.test.ts:110` — "leaves a depth-≥4 heading with no items beneath it exactly as it was"
- Category: Defect (name contradicts the assertion)
- Evidence: there is an item after the heading (`'2. Check the header'`), and the assertion `toEqual(['Open the dashboard'])` shows it is dropped. The comment says "the item after it is inert too", so the behaviour changed and the name did not.
- Recommendation: rename to "a #### heading followed by prose still makes later items inert".
- Confidence: high

### `tests/skill-expander-frames.test.ts:118` — "omits frame.outputs detail for skills with no declared outputs"
- Category: Defect (minor naming)
- Evidence: asserts `expect(frame.outputs).toEqual([])`, which means present and empty, not omitted. Section frames, by contrast, do omit it (`tests/skill-expander-sections.test.ts:153`, `toBeUndefined()`), so the name invites confusion.
- Recommendation: rename to "records an empty outputs list for a skill with no declared outputs".
- Confidence: high

### `tests/section-index-cli-parity.test.ts:118` — the SHAPES table loop (26 generated tests)
- Category: Defect (a pass with no assertion is possible and nothing guards against it)
- Evidence: `if (cli === null) { return; }` makes a row the CLI refuses pass with no assertion. The `agree: false` rows are protected because `:129` requires `cliCalls(text)` to be `true` for them. No guard covers the 18 `agree: true` rows, unlike the fuzz test, which counts `compared > 500`. I could not prove from reading alone whether any row currently hits the escape, so this is a weakness rather than an L2 finding.
- Recommendation: assert `expect(cli).not.toBeNull()` for table rows (the table claims "marked's real answer measured"), or add a refused-count guard.
- Confidence: medium

### `tests/use-step-parity.test.ts:236-237` — inside "the corpus reaches every branch on both sides"
- Category: Defect (fragile fixture)
- Evidence: `l.includes(' ')` and `cliClaims('[use computer]')` contain a literal U+00A0 (confirmed with `od -c`: bytes `302 240`), which looks like an ordinary space. An editor or formatter that normalises NBSP to a space would turn `:236` into `l.includes(' ')`, which is true for any corpus, so its guard would silently pass. `:237` would then fail with a confusing message. The corpus line itself (`:82`) correctly uses `' '`.
- Recommendation: write both as `' '` / `'[use computer]'`.
- Confidence: high

### `tests/config-loader.test.ts:72-101` — the `INTERACTIVE_ON_FAILURE` describe
- Category: Defect (non-hermetic fixture)
- Evidence: `loadConfig()` is called with no path, so it auto-discovers `<cwd>/steptix.config.json`, which is the repo's own tracked config (`resolveConfigPath`, `src/config/loader.ts:59-68`). The tests pass only because that file sets no `execution.interactiveOnFailure`. Adding one there would fail "defaults to false" for a reason unrelated to the loader. The later describes correctly use a tmp `writeConfig({})`.
- Recommendation: pass `await writeConfig({})` from a tmp dir (or a `projectRoot` tmp dir) as the other describes do.
- Confidence: high

## Duplication clusters
- `####` items inert inside a section body: `tests/parser-inert-headings.test.ts:54`, `:62`, `tests/parser-sections.test.ts:69`, `tests/parser-section-linespans.test.ts:91`, `:290` → keep inert-headings:54/62 and linespans:91/290; drop parser-sections:69.
- Hashes-only heading refusal: `tests/parser-sections.test.ts:145` (it.each), `:154` (fixture), `tests/step-line-span-parity.test.ts:110` (scanner) → keep :145 and step-line-span-parity:110; drop parser-sections:154.
- Outermost-skill attribution: `tests/skill-expander.test.ts:506`, `:293`, `tests/source-skill-attribution.test.ts:50` → keep skill-expander:506; drop the other two.
- Inline/skill sourceSkills tagging: `tests/skill-expander.test.ts:29`, `:36`, `tests/source-skill-attribution.test.ts:24`, `:32`, `:87`, `tests/skill-expander-frames.test.ts:45` → keep skill-expander:29/36; drop source-skill-attribution:24/32/87.
- Output alias rename: `tests/skill-expander.test.ts:158`, `:333`; undeclared alias: `:200`, `:644` → keep :158 and :200.
- Skill-call syntax errors: `tests/skill-call-parser.test.ts:294/306/330/350`, `:82`, `tests/skill-expander.test.ts:665/671/677` → keep the parser unit tests and skill-expander:665 as the single seam test.
- parseBoolEnv vocabulary: `tests/env-loader.test.ts:71/75/79`, `tests/config-loader.test.ts:89/97` → keep env-loader; drop config-loader:89/97.
- Generic `## Config` keys: `tests/parser.test.ts:86`, `:93`, `:100`, `:107`, `:423`, `:431` → keep :86 (plus :192 for a colon in the value).
- `If …` watch prefix: `tests/step-grouper.test.ts:5/9/13/17` → keep :5.
- Mixed env/data/extra namespaces: `tests/interpolate-env-data.test.ts:108`, `:167`, `:202` → keep :167.
- `${envName}` skill source routing: `tests/skill-data-sources.test.ts:53`, `:91` → keep :91.
- Relative dataSources path: `tests/data-sources-integration.test.ts:101`, `:140` → keep :101.

## Cost concerns
- `tests/section-index-cli-parity.test.ts:243`: the fuzz parses 4000 generated documents through both `parseTestContent` (marked) and `buildSectionIndex`. That is probably a few seconds of CPU and well inside the 30 s test timeout, but it is the heaviest test in the batch and grows with any `seedCount` bump. It is deterministic (seeded LCG), so it is not a flake. Worth timing once in a full parallel run (confidence: medium).
- `tests/parser-inert-headings.test.ts:158-165`: the `write` helper calls `fs.mkdtemp(path.join(os.tmpdir(), 'inert-'))` on every call and never removes the directory, so it leaks two tmp dirs per run. This is hygiene, not a flake.
