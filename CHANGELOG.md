# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) loosely; this project
does not yet use semantic version numbers, so entries are grouped by date.

## Unreleased

### Changed — the colon in `[skill: ...]` / `[tool: ...]` is now optional

`[skill login]` is the same call as `[skill: login]`, and `[tool seed_cart
items=2]` the same as `[tool: seed_cart items=2]` — every arg form, output
alias, path-qualified name, and prose label works identically under both
spellings. The keyword must be followed by the colon or whitespace, so
bracketed prose such as `[skills]` or `[skillful]` is never mistaken for an
invocation. Everything that keys off the token moved in lockstep: the
server's tokenizer, the MCP errand/prose scan, code-behind's
never-generate rule, and TestBench's F12 targets and tool-line detection.

### Added — TestBench: Renumber Steps

Right-click the line-number gutter in a test file and pick **TestBench:
Renumber Steps** to fix the ordinals after inserting a step in the middle.
With step lines selected, only those are renumbered, each continuing from the
step above it; with nothing selected, the whole file goes sequential — the
main flow 1..N, every `### Section` body restarting at 1. Only the leading
digits change, so the instruction text, its spacing, and any code-behind
binding are byte-identical afterwards. What counts as a step is runner-core's
classifier, so numbered items that never run — those under a `####` heading,
inside a ``` fence, or outside the `## Steps` span — are left alone rather
than being claimed as steps; fenced example lines don't shift real steps'
numbers either. A selection that ends at column 0 of a line (the shape
gutter drags, Shift+Down and Ctrl+L produce) doesn't renumber that trailing
line — only what you visibly selected changes.

### Added — per-test viewport

A test file can now declare the page size it runs at:

```markdown
## Config
- viewport: mobile
```

`mobile` (390×844), `tablet` (768×1024), `desktop` (1440×900), or an explicit
`<width>x<height>` such as `390x844`. The size applies to that test only —
other tests on the same server keep the default — and it is exact in both
headed and headless modes, unlike `browser.viewport`, which headed runs
ignore. Aimed at sites that branch on CSS breakpoints; it is not device
emulation (no touch, mobile user agent, or devicePixelRatio change).

TestBench restarts the browser session automatically when the value changes
between runs, so an edited size takes effect on the next Run. Combining
`viewport:` with `cdp:` is refused — a viewport cannot be imposed on an
attached browser. A whole project can be pinned with `browser.fixedViewport`
in `aiui.config.json`; a test's own key overrides it. See
stories/per-test-viewport.md.

### Added — inline sections

A `### Name` heading inside `## Steps` now defines a named block of steps,
invoked by writing the bare name as a whole step:

```markdown
## Steps
1. Login
2. Buy something

### Login
1. Go to the login page
2. Type "{{username}}"
3. Click Sign in
```

A section is a macro, not a function: it shares the scope of whatever defines
it, declares no parameters or outputs, and expands inline at parse time — the
runner sees a flat step list, exactly as it does for skills. Sections may
invoke other sections and skills; skill files may define and invoke their own.
Reports badge section-expanded steps with a `section:` chip, alongside the
skill chip rather than instead of it.

Matching is on the raw text as authored, case-insensitively: `1. **Login**`
does *not* invoke `### Login`, and neither does `Login.`. Names that are
reserved H2 keywords, begin with `[`, contain `{{`, are empty, or duplicate an
earlier name are refused at parse time. A section that is never invoked
produces a warning — the tripwire for a call site left behind by a rename.

Sections work everywhere a test runs:

- **CLI** (`aiui run`) — expands and reports them, badging section-expanded
  steps with a `section:` chip alongside the skill chip.
- **Server** — expands sectioned files sent by TestBench over HTTP, with
  section frames, breakpoints on body lines, and re-run anchoring.
- **TestBench (Native)** — full debug parity: gutter status on body lines,
  breakpoints inside a body, step-into a section, a call stack that names it,
  and re-run-with-variables. Plus authoring affordances: go-to-definition and
  document links between a call and its `### Name` heading, section-name
  completion after a step number, and diagnostics for duplicates, dead
  sections, and near-miss typos ("Did you mean section X?").
- **TestBench (Monaco)**, the legacy variant, has no sections support and
  **refuses** to run a sectioned file (error `TB026`) rather than mis-run it —
  use TestBench (Native) or the CLI.

Documented in [SPEC.md](SPEC.md#inline-sections) and the README; a runnable
example ships in new projects at `tests/sections-demo.md` (`aiui init`).

### Changed — `[no-hooks]` on a skill invocation now covers the whole body

`parseTestFile` padded the `skipHooks` array to the expanded step count
instead of remapping it through expansion origins, so `[no-hooks] [skill:
multi_step]` applied to roughly the first expanded step and left the rest
hook-wrapped. It now covers every step the invocation expands to — the
behaviour the hooks story always described. Sections made this the common case
rather than an edge one.

### Changed — expansion now runs for files that define sections

`parseTestFile` expanded only when `skillsDir` was set. It now also expands
when the file defines sections, so a project with no skills directory still
resolves bare-name calls. Consequence for direct `parseTestFile` consumers: in
a **sectioned** file parsed without `skillsDir`, a `[skill: ...]` step that
previously shipped to the AI as raw text now raises a clear error naming the
missing configuration. Sectionless files without `skillsDir` are unchanged,
and the CLI always passes its `./skills` default.

### Fixed — skill frame ids and internal variable namespaces could collide

`expandSkills` minted duplicate instance ids whenever a **nested** skill call
was followed by a **sibling** call at the same level (e.g. a test invoking
`[skill: outer]`, whose body invokes `[skill: inner]`, then invoking
`[skill: sibling]`). The recursion passes nested levels a spread copy of its
context, and the `seq` counter was a bare `number` — copied by value — so
increments inside a nested body never reached the parent, and the next sibling
re-minted an id the nested frame already held.

Two things went wrong as a result:

- **Frames were overwritten.** The nested skill's frame was replaced in the
  shared map by the sibling's, so its steps reported an unrelated skill —
  wrong `sourceSkill` chip in reports, wrong rows in TestBench's call stack,
  and colliding per-step cache keys (`frameScopedStepKey`).
- **Skill isolation broke.** The same id drives the `__skill<N>_` prefix used
  to namespace a skill's internal variables, so two unrelated instances shared
  one namespace and a `[store as:]` in one clobbered the other's value in
  session scope.

The counter is now boxed so every recursion level shares it, matching how the
`frames` map was already shared. Regression coverage in
`tests/skill-expander-frame-id-uniqueness.test.ts`.

Instance numbering changes for tests that nest skills, so `__skill<N>_` names
differ from before. These are internal, per-run names that never appear in
test files or reports — but a snapshot asserting on the literal text will need
updating.

### Breaking — config is now JSON-only (`aiui.config.json`)

`aiui.config.json` is now the **only** config format the framework reads. All
TypeScript/JavaScript config support — `aiui.config.ts`, `aiui.config.js`,
`aiui.config.mjs`, the legacy `ai-ui-auto.config.*` names — and the
`defineConfig` helper have been **removed**. Both consumers (the CLI/server
loader and TestBench-native) now read the same file via `JSON.parse`.

A project that still ships only an `aiui.config.ts` is treated as
**unconfigured**: the CLI silently falls back to defaults and TestBench reports
"no config found" (no skills/tools, F12 warns). There is no shim or
auto-migration.

**Migration — one step.** Rename your config to `aiui.config.json` and reshape
the exported object to a plain JSON object: drop the `import { defineConfig }`
line and the `export default defineConfig(...)` wrapper, quote every key,
replace numeric separators (`1_000_000` → `1000000`), and remove any
`process.env.*` references — secrets such as `AI_API_KEY` belong in `.env` and
are injected at load time, never in the committed config.

While reshaping, **nest `skillsDir` / `toolsDir` under `tests`** — the
canonical location is `tests.skillsDir` / `tests.toolsDir`. Older configs (and
some older docs) placed these at the top level or under a `tools` key; those
are no longer recognized.

| Before (`aiui.config.ts`)                                  | After (`aiui.config.json`)                                  |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| `import { defineConfig } from 'ai-ui-automation';`         | _(removed)_                                                 |
| `export default defineConfig({ ... });`                    | `{ ... }`                                                   |
| `skillsDir: './skills'` / top-level or under `tools`       | `"tests": { "skillsDir": "./skills" }`                      |
| `toolsDir: './tools/src'` / `tools.dir`                    | `"tests": { "toolsDir": "./tools/src" }`                    |
| `maxInputTokens: 1_000_000`                                | `"maxInputTokens": 1000000`                                 |
| `apiKey: process.env.AI_API_KEY`                           | _(removed — set `AI_API_KEY` in `.env`)_                    |

Example:

```json
{
  "ai": { "gatewayUrl": "https://aiapi.example.com", "model": "gpt-5.4-mini" },
  "browser": { "headed": true },
  "tests": {
    "dir": "./tests",
    "contextDir": "./context",
    "skillsDir": "./skills",
    "toolsDir": "./tools/src"
  },
  "reports": { "outputDir": "./reports" }
}
```

Two behavior notes:

- **Deep merge of nested objects.** Config now merges over the defaults with a
  recursive deep merge, so a partial nested object inherits its sibling
  defaults — `"browser": { "viewport": { "width": 800 } }` now keeps the
  default `height` instead of dropping it. Arrays still replace wholesale.
- **Editor autocomplete + validation.** The TestBench VS Code extension ships
  the JSON schema and binds it to `aiui.config.json`, so editing the file in
  VS Code gives autocomplete, enum-checking, and hover docs with no setup.
  Outside the extension, add an optional top-level `"$schema"` key pointing at
  `./node_modules/ai-ui-automation/schema/aiui.config.schema.json`. The loader
  strips `"$schema"` before merging, so it never affects the resolved config.
  Malformed JSON is now a hard error (fails loudly with the file path); a
  *missing* file still falls back to defaults silently.

### Breaking — `BrowserConfig` shape

The seven DOM-snapshot noise-reduction toggles have been grouped under a new
`browser.domNoiseReduction` sub-object instead of living flat on
`BrowserConfig`. This consolidates a related family of flags and leaves room
for further reductions to land alongside them.

**Migration.** If your project's `defineConfig({ browser: { ... } })` was
setting any of the flags below, move them inside a `domNoiseReduction: { ... }`
block:

| Before                                          | After                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `browser.collapseRepetitiveDom`                 | `browser.domNoiseReduction.collapseRepetitiveDom`                  |
| `browser.compactSvg`                            | `browser.domNoiseReduction.compactSvg`                             |
| `browser.hideHiddenInputs`                      | `browser.domNoiseReduction.hideHiddenInputs`                       |
| `browser.hideDisplayNoneElements`               | `browser.domNoiseReduction.hideDisplayNoneElements`                |
| `browser.hideAriaHiddenElements`                | `browser.domNoiseReduction.hideAriaHiddenElements`                 |
| `browser.useDomAttributeAllowlist`              | `browser.domNoiseReduction.useDomAttributeAllowlist`               |
| `browser.dropUnstableIds`                       | `browser.domNoiseReduction.dropUnstableIds`                        |

`browser.maxIframeDepth`, `browser.domSnapshotCharLimit`, and
`browser.captureScreenshotsPerAction` stay flat — they're hard caps / capture
controls rather than noise filters.

The programmatic `CaptureDomOptions` shape passed to `captureDomSnapshot()`
is unchanged: it still accepts the flags flat. Only the user-facing
`BrowserConfig` shape changed.

TypeScript will flag any missed migration as a type error on the old field
names.

### Added

- `browser.domNoiseReduction.useDomAttributeAllowlist` (default `true`):
  emit only a curated set of DOM attributes (`id`, `data-testid`, `name`,
  `type`, `role`, `aria-*`, `alt`, `label`, `placeholder`, `href`, `src`,
  `value`, `checked`, `selected`, `disabled`, `readonly`, `for`, `action`,
  `method`, `title`) — drops framework noise like `data-react-*`,
  `data-emotion`, `data-v-*`, long Tailwind/Bootstrap class strings, verbose
  inline `style`. Significant token reduction on framework-heavy pages.
- `browser.domNoiseReduction.dropUnstableIds` (default `false`, opt-in):
  strip `id` attributes matching React 18 useId, Radix UI, Headless UI, MUI,
  and React server-streaming patterns so the AI can't propose a selector
  that won't survive the next render. Element is still emitted; only the
  unstable `id` attribute is removed.
- `browser.captureScreenshotsPerAction` (default `false`): gate screenshot
  capture across the per-turn / post-action / polling-loop / end-of-step
  sites. On-failure and diagnose captures are unaffected. Per-site precise
  gating: pre-turn and polling-loop sites OR-couple with `ai.sendScreenshots`
  since the AI consumes those frames; the post-action site gates only on
  this flag (it's report-only).
- `browser.maxIframeDepth` (default `5`): previously hard-coded to `3`.
- `browser.domSnapshotCharLimit` (default `300_000`): previously hard-coded
  to `100_000`.
- `browser.domNoiseReduction.hideHiddenInputs` (default `true`): drop
  `<input type="hidden">` elements.
- `browser.domNoiseReduction.hideDisplayNoneElements` (default `true`): drop
  elements (and subtrees) whose computed `display` is `none`. Uses
  `getComputedStyle` so class-based hiding is caught, not just inline style.
- `browser.domNoiseReduction.hideAriaHiddenElements` (default `true`): drop
  elements (and subtrees) marked `aria-hidden="true"`.
- Hidden elements are emitted as a tag-only placeholder
  (`<div><!-- hidden: display:none --></div>`) so DOM structure (and
  `nth-of-type` / `nth-child` positions) remains intact for selector
  generation.
- HTML report renders a placeholder for missing per-action screenshots
  naming `browser.captureScreenshotsPerAction` so users know which flag
  controls it.
- `expandDomSubtree` now walks all `aria-*` and all `data-*` attributes (in
  addition to the curated list) for full fidelity in the targeted view.
- New test-app fixture page `/dom-noise` (`fixtures/test-app/dom-noise.html`)
  exercising every DOM-cleaner flag in one place: hidden-input,
  `display:none`, `aria-hidden`, framework attribute noise, the five
  unstable-id patterns alongside stable IDs, a 60-row table for collapse,
  and a decorative SVG for compaction.

### Changed

- The curated DOM-attribute list is now a single shared
  `ALLOWED_DOM_ATTRIBUTES` constant in `src/browser/dom-cleaner.ts` reused
  by both `captureDomSnapshot` and `expandDomSubtree` so the two paths
  can't drift.
- `expandDomSubtree`'s curated list now includes `alt` and `label` in
  addition to the existing primitives.
- `ai.sendScreenshots` default flipped to `false` in `DEFAULT_CONFIG` to
  match the lower-cost default profile.

### Fixed

- Hard timeouts on page/frame `evaluate` so a stuck-JS page can't hang the
  whole runner during DOM capture.
