# Code-behind can read `${data.*}` and `${env.*}`

Builds on [step-codebehind.md](step-codebehind.md) (the `.steps.ts` file and
`step.getVar`) and [codebehind-compile.md](codebehind-compile.md) (the
compile that writes it). One gap, closed: a step that uses an environment
placeholder — `${data.url}`, `${env.BASE_URL}`, `${endpoints.api.url}` — can
now be compiled to code, and the code reads the placeholder the same way the
markdown does.

## What we're building

A test can say

```markdown
1. Navigate to ${data.url}
```

and `${data.url}` comes from `data/<env>.json` — a different URL for `uat`
and for `staging`, chosen by whichever environment the run is made against.
The run works: the parser substitutes the value before the first step runs,
and the AI navigates to `https://github.com/`.

The compile does not. It binds the step on its authored text,
`Navigate to ${data.url}`, and hands the generator exactly that — with
"(this step uses no parameters)", because the generator only knows the
`{{name}}` syntax, and with rules that say *never inline a value, read
variables with `step.getVar`*. So the model writes
`page.goto(step.getVar('url'))`, the variable does not exist, the replay
navigates to `undefined`, and the repair round gives up:

```ts
{
  // Kept as AI by `aiui compile`: The step requires the dynamic value ${data.url}, but no url or data
  // parameter is in scope, so a valid destination URL cannot be obtained via step.getVar.
  source: 'Navigate to ${data.url}',
  ai: true,
},
```

The model was right. `step.getVar` reads the run's variable map — the
`## Parameters` section, `[store as: x]` captures, data-file rows — and the
environment JSON is never in it. Nothing in the framework could have given
it the URL. The most compilable step there is — a plain navigate — stays AI
on every run, forever, in every test that parameterises its URL by
environment. Which is the tests that matter.

After this story, the same compile writes:

```ts
{
  source: 'Navigate to ${data.url}',
  async run({ page, step }) {
    const url = step.getVar('data.url');
    await page.goto(url);
    await page.waitForURL(url);
  },
},
```

and the rule for an author (or a model) reading a `.steps.ts` is one line
long: **whatever is inside `${...}` in the step is the name you pass to
`step.getVar`.** `{{username}}` → `step.getVar('username')`;
`${data.url}` → `step.getVar('data.url')`;
`${env.BASE_URL}` → `step.getVar('env.BASE_URL')`;
`${endpoints.api.url}` → `step.getVar('endpoints.api.url')` for a source the
test declares in its frontmatter; `${envName}` → `step.getVar('envName')`.
The value is resolved at run time against the environment the run is made
against, so the file is the same for `uat` and `staging` — which is the
whole point of writing `${data.url}` instead of the URL.

A few more examples of what the compile now does with a step:

| Step as authored | What the generator is told | What it writes |
|---|---|---|
| `Navigate to ${data.url}` | `${data.url}` resolved to `"https://github.com/"` on this run — read it with `step.getVar('data.url')` | `page.goto(step.getVar('data.url'))` |
| `Log in as ${data.users.admin.email}` | `${data.users.admin.email}` resolved to `"uat-admin@…"` — `step.getVar('data.users.admin.email')` | `fill(step.getVar('data.users.admin.email'))` |
| `Enter the password ${env.GITHUB_PASSWORD}` | `${env.GITHUB_PASSWORD}` resolved to `"***"` — `step.getVar('env.GITHUB_PASSWORD')` | `fill(step.getVar('env.GITHUB_PASSWORD'))`; the real value in the generated code is rejected, as a `{{password}}` leak is today |
| `Navigate to ${endpoints.api.url}/` inside a **skill** whose own frontmatter declares `endpoints` | declined: the reference is a skill-private data source, which code cannot read at run time | `ai: true` with that reason |

The last row is the one carve-out, and it is honest rather than wrong: a
skill's private data sources are resolved inside the skill at parse time and
exist under no run-time name. Today that step either fails its replay or —
worse — gets the resolved URL inlined, which passes in one environment and
navigates to the wrong place in every other. Now it stays AI and says why.

## Design

### The reference grammar, in one place

`${...}` placeholders are the parser's
([src/parser/interpolate-env-data.ts](../src/parser/interpolate-env-data.ts)):
`${env.NAME}`, `${data.path.to.value}`, `${<source>.path}` for a namespace the
test's frontmatter `dataSources` declares, and `${envName}`. The parser
resolves them against an `EnvDataContext` — the composed env map, the
`data/<env>.json` tree, the test's named sources, the env name — and rewrites
the run-time step text before the run starts. The raw text the code-behind
binds on keeps the placeholder, which is why `source: 'Navigate to
${data.url}'` matches the step in every environment.

This story adds the run-time counterpart, next to the parser's:

- `envDataRefsIn(text)` — every `${...}` reference in a step, as the bare
  name inside the braces: `['data.url']`.
- `resolveEnvDataRef(name, ctx)` — one reference, resolved the way the
  parser resolves it (same namespace rules, same path walk, same
  stringification of a non-string leaf), or `undefined` when nothing in the
  context defines it.

One grammar, one resolver, so the parser and the code-behind cannot drift
over what `${data.url}` means.

### The context rides on the parsed test

`parseTestFile` is the one place the full context is assembled — the env
bundle the caller resolved plus the test's own `dataSources`, loaded from
frontmatter. It now keeps that context on the result as `ParsedTest.envData`,
so every path that runs a parsed test has it without another argument:
`aiui run`, `aiui compile`'s own runs, and the compile's generator. The
server's step loop builds its context itself from the request (the client
forwards `dataSources` over the wire) and hands it to the executor the same
way it hands the code-behind binding.

### `step.getVar` falls through to the environment

`getVar(name)` keeps its three-step resolution — the frame's renames, the
frame's captured inputs, the bare name — and gains a fourth: when none of
those define `name`, it is resolved as an environment reference against the
run's context. Parameters win, so a `## Parameters` entry named `envName`
shadows the placeholder, as it would in the markdown.

The environment is read at run time, by the run's own context, so a
`.steps.ts` compiled against `uat` runs unchanged against `staging`: the
`getVar('data.url')` call is the same, the JSON behind it is not.

### The generator is told the mapping, and guarded on it

The generation and repair prompts list the step's environment references
beside its parameters, each with its value on this run and the `getVar`
call that reads it:

```
## Parameters in scope
- {{username}} resolved to "paul" on this run
- ${data.url} resolved to "https://github.com/" on this run — read it with step.getVar('data.url')
```

with the rule made explicit: these values differ per environment; read them
through `step.getVar`, never write the value the transcript shows. The
`step.getVar` line in the context description carries the mapping, so a
model that has only seen `{{name}}` before knows what to do with
`${data.url}`.

The guard that keeps a `{{password}}` value out of a committed file
([generate.ts](../src/codebehind/generate.ts), `findInlinedParameterValue`)
now covers the step's environment values too, in generation, repair and the
file review. A step that says `Enter the password ${env.GITHUB_PASSWORD}`
hands the model the real password in the transcript, and before this story
nothing stopped the model writing it into the file — the guard only knew
about `{{...}}` values. Same rule, same rejection message, same scope: the
step's own references, so a URL that legitimately appears in another step's
selector does not trip it.

A reference the run-time context cannot resolve — a skill-private source, a
namespace nothing declares, or a compile run without an environment — is
declined **before** the model is asked, with the reference named in the
reason. No replay round is spent discovering that `getVar` returns
`undefined`.

### The recording redacts environment secrets

The recording on disk ([codebehind-recording-on-disk.md](codebehind-recording-on-disk.md))
redacts the values of secret-named parameters from the actions and DOM it
writes. The same name rule (`password`, `secret`, `token`, `key`) now applies
to the environment: the value of every secret-named env var, and of every
data leaf under a secret-named key (`users.admin.password`), is redacted
wherever it appears in the recording and in a replay-failure capture. The
manifest still lists names only.

## Implementation outline

1. **`src/parser/interpolate-env-data.ts`** — export `envDataRefsIn(text)`,
   `resolveEnvDataRef(name, ctx)` and `envDataSecretValues(ctx)`, sharing the
   grammar and `stringifyDataValue` with `interpolateEnvData`.
2. **`src/parser/types.ts` / `markdown.ts`** — `ParsedTest.envData`, set by
   `parseTestFile` to the context it interpolated with.
3. **`src/codebehind/execute.ts`** — `RunCodeBehindOptions.envData`;
   `makeStepApi` resolves a miss as an environment reference.
4. **`src/runner/step-executor.ts`** — `StepExecutorOptions.envData`, passed
   through to the entry.
5. **`src/runner/test-runner.ts`** — passes `test.envData` to the executor
   and to the recording writer.
6. **`src/server/session-manager.ts`** — passes its `envDataCtx` to the
   executor and to the recording writer.
7. **`src/codebehind/generate.ts` / `repair.ts` / `src/ai/prompts.ts`** —
   `envRefs` beside `parameters` in both prompts; the guard covers both; an
   unresolvable reference declines up front.
8. **`src/codebehind/compile.ts`** — threads `test.envData` into generation,
   repair, the review guard and the replay-failure capture; the reviewer is
   shown the authored step text rather than the interpolated text (the file
   binds on the authored text, and the interpolated text would put resolved
   env values in a prompt that has no business seeing them).
9. **`src/codebehind/recording.ts`** — `RecordingInput.secrets` for the
   environment values to redact alongside the secret-named parameters.

No extension change: the client already forwards `envName` and
`dataSources`, and the server does the rest.

## Tests

- `resolveEnvDataRef`: `data.` path, nested path, `env.` name, a declared
  source, `envName`, a non-string leaf stringified as the parser would, and
  `undefined` for an unknown namespace, an unknown path, and a context with
  no `data`.
- `envDataRefsIn`: several references in one step, whitespace inside the
  braces, `{{name}}` ignored, none.
- `runCodeBehindEntry`: `getVar('data.url')` resolves through the context;
  a parameter of the same name wins; no context → `undefined`, as today.
- Generation prompt: lists the reference with its value and the `getVar`
  call; the guard rejects generated code containing the value; an
  unresolvable reference is declined without a model call.
- `runTest` end to end: a `.steps.ts` entry calling `step.getVar('data.url')`
  runs as code when the test was parsed with an environment.
- The server seam: a run through `POST /sessions/:id/steps` with `envName`
  and a `data/<env>.json` executes such an entry as code.
- Recording: a secret-named env var's value is redacted from a recorded
  action and from the DOM files.

## What was built

Built as specified; the outline above is the change. What the live proof
showed, and the few places the build went beyond the outline:

- **The live case compiles.** `aiui compile "tests/github with sections.md"
  --env uat --steps 1` against the project that surfaced this wrote

  ```ts
  {
    source: 'Navigate to ${data.url}',
    async run({ page, step, log }) {
      const url = String(step.getVar('data.url'));
      await page.goto(url);
      step.expect(page.url() === url, 'Page navigated to the requested URL');
    },
  },
  ```

  and the strict replay ran all four steps as code at 0 tokens. Before the
  fix the same compile wrote the step off with "no url or data parameter is
  in scope". The generation prompt's parameter block for that step read
  `- ${data.url} resolved to "https://github.com/" on this run — read it
  with step.getVar("data.url"); the value differs per environment`.
- **One secret-name rule.** `isSecretName` (`password|secret|token|key`)
  was copied in the parameter prompt, the log masker and the recording; it
  is now exported once from `src/parser/parameters.ts` and the others use it,
  so the environment values the recording redacts are chosen by the same
  rule that hides a parameter at the prompt.
- **The two prompts share one parameter block.** `formatParameterBlock` in
  `src/ai/prompts.ts` writes the "Parameters in scope" section for both
  generation and repair, so the repair prompt's wording changed from
  "resolves to" to "resolved to … on this run" — the generation wording.
- **The reviewer sees the authored steps.** The file review prompt listed
  `test.steps`, the interpolated text; it now lists the raw steps, which are
  what every `source` in the file has to match, and which carry no resolved
  environment value.
- **A compiler write-off is not re-selected.** The step that surfaced this
  had an `ai: true` entry the compiler wrote, and `selectSteps` keeps every
  `ai: true` entry — the author's opt-out — so the live proof deleted that
  entry first. A project with write-offs of this kind from before the fix
  compiles them again by deleting the entries; nothing in the file marks a
  compiler write-off apart from its comment.
- **Observed, not changed:** the CLI's step header line (`logger.step`)
  prints the interpolated instruction, so a step that types `{{password}}`
  prints the password to the console. Older than this story and outside it;
  noted here because it is the one place the live proof showed a secret.

## Non-goals (this story)

- **Skill-private data sources at run time.** A skill's `dataSources` are
  loaded and substituted inside the skill at parse time and attached to no
  run-time scope; making them readable means carrying the loaded trees on the
  expanded frame, which goes over the wire to the client in `frame:push`.
  Declining with the reason is the honest stop for now.
- **Tools.** `[tool:]` steps have their own `step` API and are not compiled.
- **Re-selecting a write-off.** An `ai: true` entry is never re-selected by a
  compile, including the ones the compiler wrote
  ([codebehind-compile.md](codebehind-compile.md), "Select"). A step written
  off for this reason before the fix is compiled again by deleting its entry.
