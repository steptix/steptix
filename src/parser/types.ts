export interface TestFrontmatter {
  /** Tags for filtering test execution */
  tags: string[];
  /** Maximum test duration (e.g. "60s", "2m") */
  timeout?: string;
  /** Path to JSON/CSV data file for data-driven tests */
  dataFile?: string;
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
  /** Ordered list of natural language step instructions */
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
