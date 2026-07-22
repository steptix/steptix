export interface TestFrontmatter {
  /** Tags for filtering test execution */
  tags: string[];
  /** Maximum test duration (e.g. "60s", "2m") */
  timeout?: string;
  /** Path to JSON/CSV data file for data-driven tests */
  dataFile?: string;
  /** Environment name override — when set, this test always runs against the
   *  named environment unless the CLI `--env` flag overrides it. Used as an
   *  escape hatch for tests pinned to a single env (e.g. a smoke test that
   *  must always hit prod). */
  env?: string;
  /** "skill" marks the file as a reusable step macro, not a runnable test */
  type?: 'test' | 'skill';
  /** "replace" ignores project-level defaultHooks for this test; "merge" (default)
   *  runs defaults before per-test hooks. */
  hooks?: 'merge' | 'replace';
  /**
   * Per-test named data-source files. Each entry registers a placeholder
   * namespace `${<name>.X.Y}` backed by an independent JSON file. Paths are
   * resolved relative to the test `.md` file's directory (or absolute / `~`).
   * The reserved names `env` and `data` cannot be used. See
   * stories/data-sources-namespaces.md.
   */
  dataSources?: Record<string, string>;
}

/**
 * Pre/post-step hook instructions, parsed from a `## Hooks` section in a test
 * markdown file. Each entry is a natural-language step that executes through
 * the same AI pipeline as a regular step.
 */
export interface TestHooks {
  before: string[];
  beforeEach: string[];
  afterEach: string[];
  after: string[];
}

export const EMPTY_HOOKS: TestHooks = {
  before: [],
  beforeEach: [],
  afterEach: [],
  after: [],
};

/** True when every hook scope is empty. */
export function hooksAreEmpty(hooks: TestHooks): boolean {
  return (
    hooks.before.length === 0 &&
    hooks.beforeEach.length === 0 &&
    hooks.afterEach.length === 0 &&
    hooks.after.length === 0
  );
}

export interface TestConfig {
  /** Base URL to navigate to before running steps */
  baseUrl?: string;
  /** Override test timeout */
  timeout?: string;
  /** Per-test console log threshold override: silent | error | warn | info | debug. */
  consoleLogLevel?: string;
  /** Per-test server-side log-file mode override: off | compact | full. */
  serverFileLogLevel?: string;
  /** Connect to a live Chrome over CDP instead of launching a fresh browser.
   *  Value is the port Chrome was started with (`--remote-debugging-port=<port>`).
   *  Presence of this key enables CDP mode for this test. */
  cdp?: string;
  /** Which tab to drive when connecting over CDP. One of:
   *   - `new` (default) — open a fresh tab.
   *   - `<integer>` — attach to the Nth existing tab (zero-indexed).
   *   - `url~<substring>` — first tab whose URL contains the substring.
   *   - `title~<substring>` — first tab whose title contains the substring.
   *   - `active` — the most recently focused tab. */
  cdpTab?: string;
}

/**
 * Parallel-to-`hooks` shape: a `(ToolCall | null)[]` per scope, recording
 * which hook instructions are `[tool: ...]` invocations (dispatched to the
 * tool executor) versus natural-language steps (dispatched to the AI loop).
 */
export interface HookToolCalls {
  before: (import('../tools/types.js').ToolCall | null)[];
  beforeEach: (import('../tools/types.js').ToolCall | null)[];
  afterEach: (import('../tools/types.js').ToolCall | null)[];
  after: (import('../tools/types.js').ToolCall | null)[];
}

/**
 * Parallel-to-`hooks` shape: a `(string | null)[]` per scope, attributing
 * each hook instruction to the outermost skill it came from (or null when
 * authored inline). Used by the report renderer to show provenance chips.
 */
export interface HookSourceSkills {
  before: (string | null)[];
  beforeEach: (string | null)[];
  afterEach: (string | null)[];
  after: (string | null)[];
}

/**
 * An inline section: a named block of steps defined by a `### Name` heading
 * inside `## Steps`, invoked by writing the bare name as a whole step. A
 * section is a macro, not a function — it shares the scope of the frame that
 * defines it and declares no parameters or outputs. See
 * stories/test-script-sections.md and the cross-package contract in
 * stories/test-script-sections-contract.md.
 */
export interface ParsedSection {
  /** Name from the raw heading line (original casing, trimmed). Map keys are
   *  `matchText(name)`; this field is for display and diagnostics. */
  name: string;
  /** 1-based line of the `### Name` heading in the raw file. */
  headingLine: number;
  /** Body steps, cleaned exactly like main-flow steps (for execution). */
  steps: string[];
  /**
   * Raw body-step line text (number prefix stripped, trimmed) — the
   * match-side input for bare-name calls nested inside this body. Parallel to
   * `steps`.
   *
   * Not redundant with `steps`: the expander recursion runs over
   * `applySkillScope` output and `extractPlainText`-normalised text, so
   * without the raw parallel a formatted body line could wrongly resolve to a
   * section. Match resolution uses `rawSteps?.[i] ?? steps[i]` (contract §2.1)
   * so the server — which has no raw parallel — stays correct too.
   */
  rawSteps: string[];
  /** 1-based raw-file line per body step, parallel to `steps`. */
  stepLines: number[];
}

/** A single parsed test file */
export interface ParsedTest {
  /** Absolute path to the .md file */
  filePath: string;
  /** Test title from H1 heading */
  title: string;
  /** Frontmatter fields */
  frontmatter: TestFrontmatter;
  /** Config section values */
  config: TestConfig;
  /** Resolved parameter key-value pairs */
  parameters: Record<string, string>;
  /** Ordered list of natural language step instructions (skills already expanded) */
  steps: string[];
  /**
   * Parallel to `steps` — 1-based source line in `filePath` for each step
   * before skill expansion. After `expandSkills` runs the array length will
   * exceed the count of inline test-file steps; entries that came from a
   * skill body keep the *invocation* line in the test file (so reports and
   * inline-mode runs can still point at a real line in the open test file).
   * The step-into wire trace carries the per-skill-body origin separately
   * via `frame:push` events.
   */
  stepLines: number[];
  /** Parallel to `steps` — true when the step was authored with `[no-hooks]`
   *  and should skip `beforeEach` / `afterEach` wrapping. */
  skipHooks: boolean[];
  /** Parallel to `steps` — when non-null, the step is a `[tool: ...]` call
   *  rather than a natural-language instruction. The runner dispatches these
   *  to the tool executor instead of the AI loop. */
  toolCalls: (import('../tools/types.js').ToolCall | null)[];
  /** Parallel to `steps` — when non-null, the step came from inside the
   *  named (outermost) skill. Surfaced by the report so each step row
   *  shows which skill it originated from. */
  sourceSkills: (string | null)[];
  /**
   * Parallel to `steps` — when non-null, the step came from inside the named
   * inline section. Set to the *outermost section that sits outside any skill
   * frame*, i.e. a section of this file.
   *
   * A skill's own internal sections are never surfaced here — the skill badge
   * already names what the author wrote, and skill-private names are noise in
   * a test report. But a step inside one still reports the enclosing *test*
   * section if there is one: for test → `### A` → skill S → S's `### B`, the
   * answer is "A". Only a skill invoked from the root flow yields null.
   * Both this and `sourceSkills` can be set at once.
   */
  sourceSections: (string | null)[];
  /**
   * Inline sections defined in this file, keyed by `matchText(name)`. Empty
   * for files with no `### Name` heading inside `## Steps` — which is every
   * file written before this feature.
   */
  sections: Record<string, ParsedSection>;
  /**
   * Parallel to the *pre-expansion* main-flow steps — the raw line text
   * (number prefix stripped, trimmed) used as the match side when deciding
   * whether a step is a section call. See `ParsedSection.rawSteps`.
   */
  rawSteps: string[];
  /** Pre/post-step hook instructions (skills already expanded). */
  hooks: TestHooks;
  /** Parallel to `hooks` — tool-call markers per hook instruction. */
  hookToolCalls: HookToolCalls;
  /** Parallel to `hooks` — source-skill attribution per hook instruction. */
  hookSourceSkills: HookSourceSkills;
}

/**
 * A parsed skill: a reusable, parameterised sequence of steps invoked from
 * a test via `[skill: name arg="value"]`. Skills expand at parse time —
 * the runner only ever sees the flattened step list on `ParsedTest.steps`.
 */
export interface ParsedSkill {
  /** Absolute path to the skill .md file */
  filePath: string;
  /** Skill name (from H1, used as the invocation key) */
  name: string;
  /** Declared input parameter names (with optional default/hint text) */
  parameters: Record<string, string>;
  /** Declared output names — only these leak back to the caller's scope */
  outputs: string[];
  /** Skill body — natural-language steps, may reference {{param}} and other skills */
  steps: string[];
  /** Parallel to `steps` — 1-based source line in `filePath`. Used by the
   *  step-into protocol (Phase 1) to attribute each expanded step to its
   *  origin file+line inside the skill .md. */
  stepLines: number[];
  /**
   * Inline sections defined in this skill's own `## Steps`, keyed by
   * `matchText(name)`. A skill body may define and invoke its own sections;
   * they live inside that skill instance's scope, so `applySkillScope`
   * transforms fresh copies of these bodies per invocation (never mutate the
   * cached `ParsedSkill`).
   */
  sections: Record<string, ParsedSection>;
  /** Parallel to `steps` — raw line text used as the match side for bare-name
   *  calls in this skill's body. See `ParsedSection.rawSteps`. */
  rawSteps: string[];
  /**
   * Skill-private named data-source files declared in frontmatter. Each
   * entry registers a placeholder namespace `${<name>.X.Y}` resolved locally
   * inside this skill's body — invisible to callers. Path strings may
   * reference `${env.X}` and `${envName}` only. See
   * stories/skill-data-sources.md.
   */
  dataSources?: Record<string, string>;
}

/** A test instance ready for execution (may be a data-driven row) */
export interface TestInstance {
  test: ParsedTest;
  /** Data row index for data-driven tests (0-based), undefined for single runs */
  dataRowIndex?: number;
  /** Parameter values merged with data row values */
  resolvedParameters: Record<string, string>;
}
