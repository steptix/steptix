export interface TestFrontmatter {
  /** Tags for filtering test execution */
  tags: string[];
  /** Maximum test duration (e.g. "60s", "2m") */
  timeout?: string;
  /** Path to JSON/CSV data file for data-driven tests */
  dataFile?: string;
  /** "skill" marks the file as a reusable step macro, not a runnable test */
  type?: 'test' | 'skill';
}

export interface TestConfig {
  /** Base URL to navigate to before running steps */
  baseUrl?: string;
  /** Override test timeout */
  timeout?: string;
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
}

/** A test instance ready for execution (may be a data-driven row) */
export interface TestInstance {
  test: ParsedTest;
  /** Data row index for data-driven tests (0-based), undefined for single runs */
  dataRowIndex?: number;
  /** Parameter values merged with data row values */
  resolvedParameters: Record<string, string>;
}
