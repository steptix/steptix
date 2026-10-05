import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import Ajv2020 from 'ajv/dist/2020.js';
import * as z4mini from 'zod/v4-mini';
import { z } from 'zod';
import { createMcpServer } from '../src/mcp/server.js';
import * as schemas from '../src/mcp/schemas.js';
import type { McpDeps } from '../src/mcp/types.js';

// ---------------------------------------------------------------------------
// Our tool schemas claim no JSON Schema dialect, and that silence is honest.
//
// This exists because of a real outage: the SDK converts our Zod schemas with a
// hardcoded draft-07 target, and the MCP client bundled in opencode-ai >= 1.18.8
// refuses to build a validator for any `outputSchema` whose `$schema` is not
// 2020-12 — so every tool call failed with "JSON Schema declares an unsupported
// dialect" while nothing in this repo had changed. `schemas.toolSchema` drops
// the key with `.meta({$schema: undefined})`, and that client's gate
// (`"$schema" in schema && ...`) skips absent keys entirely.
//
// Omitting means the body must read the same under any dialect a client picks,
// so the second suite below is the load-bearing one: it asserts the draft-07
// body and the 2020-12 body are identical for every schema. The day someone adds
// a construct where the two targets diverge (tuple `items`, `definitions`/
// `$defs`, boolean `exclusiveMinimum`), that test fails rather than the silence
// quietly starting to hide a real ambiguity.
// ---------------------------------------------------------------------------

/** Deps that are never reached: nothing here calls a tool, it only lists them. */
const unusedDeps: McpDeps = {
  createApiClient: () => {
    throw new Error('not reached');
  },
  ensureServerReady: () => {
    throw new Error('not reached');
  },
  assertServerRecognized: () => {
    throw new Error('not reached');
  },
  resolveProject: () => {
    throw new Error('not reached');
  },
} as unknown as McpDeps;

async function listToolsOverTheWire() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(unusedDeps);
  const client = new Client({ name: 'dialect-test', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  return tools;
}

describe('tool schemas as they go out on the wire', () => {
  it('omits $schema entirely on every input and output schema', async () => {
    const tools = await listToolsOverTheWire();

    // Guards the guard: an empty list would make every assertion below vacuous.
    // Not the exact names — mcp-seam.test.ts pins the registered set, and a
    // third copy here made every new tool a three-file edit for no coverage.
    expect(tools.length).toBeGreaterThan(0);

    for (const tool of tools) {
      // `in`, not `=== undefined`. The gate we care about is `"$schema" in
      // schema`, which a key present-but-undefined would still trip — and
      // InMemoryTransport hands the object over without a JSON round trip, so
      // unlike the stdio path it would not quietly drop such a key for us.
      expect('$schema' in tool.inputSchema, `${tool.name} inputSchema`).toBe(false);
      expect('$schema' in tool.outputSchema!, `${tool.name} outputSchema`).toBe(false);
    }
  });

  it('skips the dialect gate the opencode client applies', async () => {
    const tools = await listToolsOverTheWire();

    // The client's own check, reproduced from its bundle: it throws unless the
    // key is absent, or spells 2020-12 (either scheme, optional trailing `#`).
    const accepted = new Set([
      'https://json-schema.org/draft/2020-12/schema',
      'http://json-schema.org/draft/2020-12/schema',
    ]);
    function getValidator(schema: Record<string, unknown>): void {
      if (
        '$schema' in schema &&
        typeof schema.$schema === 'string' &&
        !accepted.has(schema.$schema.replace(/#$/, ''))
      ) {
        throw new Error(`JSON Schema declares an unsupported dialect ("$schema": "${schema.$schema}")`);
      }
    }

    for (const tool of tools) {
      expect(() => getValidator(tool.inputSchema), `${tool.name} inputSchema`).not.toThrow();
      expect(
        () => getValidator(tool.outputSchema as Record<string, unknown>),
        `${tool.name} outputSchema`,
      ).not.toThrow();
    }
  });

  it('compiles under Ajv2020, which is the validator that rejected us', async () => {
    const tools = await listToolsOverTheWire();
    // `validateSchema:false` matches the client's own Ajv configuration — the
    // point is that the body compiles into a working validator, not that Ajv
    // approves of the meta-schema.
    const ajv = new Ajv2020({
      strict: false,
      validateFormats: true,
      validateSchema: false,
      allErrors: true,
    });

    for (const tool of tools) {
      expect(() => ajv.compile(tool.inputSchema), `${tool.name} inputSchema`).not.toThrow();
      expect(() => ajv.compile(tool.outputSchema!), `${tool.name} outputSchema`).not.toThrow();
    }
  });

  it('still validates a real result, so dropping the key disarmed nothing', () => {
    const good = schemas.closeSessionOutput.safeParse({ sessionId: 'mcp:x', closed: true });
    expect(good.success).toBe(true);

    // A missing key is the failure mode the handlers' `safeParse` exists to
    // catch; `.meta()` must not have made the schema permissive.
    const missing = schemas.closeSessionOutput.safeParse({ sessionId: 'mcp:x' });
    expect(missing.success).toBe(false);
  });
});

describe('the draft-07 body is what 2020-12 would have produced', () => {
  // Every schema handed to `registerTool`, paired with the `io` the SDK uses
  // for it — `registerTool` passes `pipeStrategy: 'input'` for inputSchema and
  // `'output'` for outputSchema, and the two can render differently.
  const cases: [name: string, schema: z.ZodType, io: 'input' | 'output'][] = [
    ['runStepsInput', schemas.runStepsInput, 'input'],
    ['runTestFileInput', schemas.runTestFileInput, 'input'],
    ['runErrandInput', schemas.runErrandInput, 'input'],
    ['listTestFilesInput', schemas.listTestFilesInput, 'input'],
    ['listSessionsInput', schemas.listSessionsInput, 'input'],
    ['closeSessionInput', schemas.closeSessionInput, 'input'],
    ['getLastRunInput', schemas.getLastRunInput, 'input'],
    ['getPageContentInput', schemas.getPageContentInput, 'input'],
    ['getRunSettingsInput', schemas.getRunSettingsInput, 'input'],
    ['serverStatusInput', schemas.serverStatusInput, 'input'],
    ['listCdpBrowsersInput', schemas.listCdpBrowsersInput, 'input'],
    ['startCdpBrowserInput', schemas.startCdpBrowserInput, 'input'],
    ['closeCdpTabInput', schemas.closeCdpTabInput, 'input'],
    ['focusCdpTabInput', schemas.focusCdpTabInput, 'input'],
    ['logIntoSiteInput', schemas.logIntoSiteInput, 'input'],
    ['peekTabInput', schemas.peekTabInput, 'input'],
    ['navigateTabInput', schemas.navigateTabInput, 'input'],
    ['runResultOutput', schemas.runResultOutput, 'output'],
    ['runErrandOutput', schemas.runErrandOutput, 'output'],
    ['listTestFilesOutput', schemas.listTestFilesOutput, 'output'],
    ['listSessionsOutput', schemas.listSessionsOutput, 'output'],
    ['closeSessionOutput', schemas.closeSessionOutput, 'output'],
    ['getLastRunOutput', schemas.getLastRunOutput, 'output'],
    ['getPageContentOutput', schemas.getPageContentOutput, 'output'],
    ['getRunSettingsOutput', schemas.getRunSettingsOutput, 'output'],
    ['serverStatusOutput', schemas.serverStatusOutput, 'output'],
    ['listCdpBrowsersOutput', schemas.listCdpBrowsersOutput, 'output'],
    ['startCdpBrowserOutput', schemas.startCdpBrowserOutput, 'output'],
    ['closeCdpTabOutput', schemas.closeCdpTabOutput, 'output'],
    ['focusCdpTabOutput', schemas.focusCdpTabOutput, 'output'],
    ['logIntoSiteOutput', schemas.logIntoSiteOutput, 'output'],
    ['peekTabOutput', schemas.peekTabOutput, 'output'],
    ['navigateTabOutput', schemas.navigateTabOutput, 'output'],
  ];

  /** The schema minus its dialect declaration — the part that must not differ. */
  function body(schema: z.ZodType, target: 'draft-7' | 'draft-2020-12', io: 'input' | 'output') {
    const { $schema: _dialect, ...rest } = z4mini.toJSONSchema(schema, { target, io }) as Record<
      string,
      unknown
    >;
    return rest;
  }

  it.each(cases)('%s renders identically under both targets', (_name, schema, io) => {
    expect(body(schema, 'draft-7', io)).toEqual(body(schema, 'draft-2020-12', io));
  });

  it('covers every schema registerTool is given', () => {
    // `schemas.ts` exports exactly the schemas the tools register, plus the
    // `RunResult` type (erased at runtime). A new one must land in `cases`
    // above, or it would go unchecked.
    const exported = Object.entries(schemas)
      .filter(([, v]) => v instanceof z.ZodType)
      .map(([k]) => k)
      .sort();
    expect(exported).toEqual(cases.map(([n]) => n).sort());
  });
});
