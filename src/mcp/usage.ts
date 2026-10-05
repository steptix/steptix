/**
 * Help text for `steptix mcp`.
 *
 * Its own module so `src/index.ts` can load it lazily inside the `--help`
 * guard. A static import of anything under `src/mcp/` from the entry point
 * would defeat the CLI bypass on every ordinary `steptix` invocation, and a
 * string literal in the entry would drift from the README.
 */
export const MCP_USAGE = `
steptix mcp — drive browsers and run tests from an MCP client over stdio

  Speaks the Model Context Protocol on stdin/stdout. Agent hosts spawn it;
  you do not normally run it by hand.

  A project is optional. Inside one (a directory with steptix.config.json), you
  get its tests, skills, tools and environments. From anywhere else, the
  browser verbs, run_steps and run_errand still work against the user root
  (%LOCALAPPDATA%\\steptix, ~/.steptix elsewhere) — your own signed-in CDP browsers,
  reachable from any directory. Results say which via a "scope" field;
  [skill:]/[tool:] steps and the two test-file tools still need a project.

Tools
  run_steps         run ad-hoc natural-language steps in a browser session
  run_test_file     run a .md test file end to end (needs a project)
  run_errand        borrow a tab the user already has open, drive it, hand
                    it back — no session, nothing kept
  list_test_files   list the project's test files (needs a project)
  list_sessions     list open browser sessions on the server
  close_session     close a session and its browser
  get_last_run      report path and token totals for a finished run
  get_page_content  read a session's current page as text or cleaned DOM
  peek_tab          read a tab the user already has open — text, cleaned DOM
                    or a screenshot, changing nothing
  navigate_tab      open a URL — a new tab by default, no model involved
  list_cdp_browsers persistent CDP browsers — the project's and the user root's
  start_cdp_browser launch (or return) a CDP browser you can sign into by hand
  close_cdp_tab     close one tab in a CDP browser
  focus_cdp_tab     bring one tab of a CDP browser to the front
  server_status     health of the Sessions API server

Environment
  STEPTIX_MCP_ROOTS    ${'`'}${'$'}{path.delimiter}${'`'}-separated directories the server may
                    touch. Defaults to the process working directory.
                    REQUIRED for hosts whose config is machine-global
                    (Codex CLI, Copilot CLI), whose spawn directory is not
                    your project. The user root is always allowed on top,
                    and never counts as a project candidate.
  STEPTIX_SERVER_URL    Sessions API base URL. Normally read from the project's
                    .env / .env.<name>; this is a lowest-precedence fallback.
                    Project-less calls default to http://127.0.0.1:3141 —
                    a distinct port, so they never collide with a project
                    server on 3100.
  STEPTIX_SERVER_API_KEY    Sessions API key. Chain: project .env, then this
                    variable, then the machine key at %LOCALAPPDATA%\steptix\.env
                    (~/.steptix elsewhere) — which is generated on first need,
                    so most setups never set this anywhere.

Host configuration
  See the "MCP server" section of the README for copy-paste config for
  Claude Code, Copilot (VS Code and CLI) and Codex (CLI and VS Code).

Notes
  Hosts execute dist/, so run \`npm run build\` after changing the source.
  If you let this server auto-start the API server, use
  \`steptix status --url $STEPTIX_SERVER_URL\` — plain \`steptix status\` reads
  steptix.config.json, which can name a different host or port.
`.trimStart();
