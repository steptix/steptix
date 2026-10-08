/**
 * The project's context with a test's own `## Context` after it
 * (docs/specs/SPEC-web-survey-fixes.md §2.46). The test's block comes last
 * and says it is the test author's, so its selectors, frame ids and notes
 * read as the most specific thing the AI has been told. Either part may be
 * empty.
 */
export function withTestContext(projectContext: string, testContext: string | undefined): string {
  const own = testContext?.trim() ?? '';
  if (own === '') return projectContext;
  const block =
    "### Context: this test (from the test file's ## Context — the author's notes for every step, " +
    'including any selectors or frame ids to use)\n\n' + own;
  return projectContext === '' ? block : `${projectContext}\n\n---\n\n${block}`;
}
