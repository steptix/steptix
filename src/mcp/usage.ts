/**
 * Help text for `aiui mcp`.
 *
 * Its own module so `src/index.ts` can load it lazily inside the `--help`
 * guard. A static import of anything under `src/mcp/` from the entry point
 * would defeat the CLI bypass on every ordinary `aiui` invocation, and a
 * string literal in the entry would drift from the README.
 */
export const MCP_USAGE = `
aiui mcp — run this project's tests from an MCP client over stdio

  Speaks the Model Context Protocol on stdin/stdout. Agent hosts spawn it;
  you do not normally run it by hand.

Tools
  run_steps         run ad-hoc natural-language steps in a browser session
  run_test_file     run a .md test file end to end
  list_test_files   list the project's test files
  list_sessions     list open browser sessions on the server
  close_session     close a session and its browser
  get_last_run      report path and token totals for a finished run
  server_status     health of the Sessions API server

Environment
  AIUI_MCP_ROOTS    ${'`'}${'$'}{path.delimiter}${'`'}-separated directories the server may
                    touch. Defaults to the process working directory.
                    REQUIRED for hosts whose config is machine-global
                    (Codex CLI, Copilot CLI), whose spawn directory is not
                    your project.
  SERVER_URL        Sessions API base URL. Normally read from the project's
                    .env / .env.<name>; this is a lowest-precedence fallback.
  SERVER_API_KEY    Sessions API key. Same precedence as SERVER_URL.

Host configuration
  See the "MCP server" section of the README for copy-paste config for
  Claude Code, Copilot (VS Code and CLI) and Codex (CLI and VS Code).

Notes
  Hosts execute dist/, so run \`npm run build\` after changing the source.
  If you let this server auto-start the API server, use
  \`aiui status --url $SERVER_URL\` — plain \`aiui status\` reads
  aiui.config.json, which can name a different host or port.
`.trimStart();
