# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) loosely; this project
does not yet use semantic version numbers, so entries are grouped by date.

## Unreleased

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
