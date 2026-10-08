/**
 * Diagnostic (issue 022): ask the REAL AI — using the .env / config exactly as
 * the runner would, including the REAL cleaned DOM captured from a real browser
 * on the wait-fixture page — what action it returns for
 *   "Wait up to 50 seconds for the text 'Ready now' to appear"
 *
 * Run: npx tsx scripts/diag-wait-ai.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import http from 'node:http';
import { listenFetchable } from '../tests/listen-fetchable.cjs';
import { chromium } from 'playwright';
import { loadConfig } from '../src/config/loader.js';
import { AiClient } from '../src/ai/client.js';
import { TokenTracker } from '../src/utils/tokens.js';
import { captureDomSnapshot } from '../src/browser/dom-cleaner.js';
import { buildSystemPrompt, buildStepMessage } from '../src/ai/prompts.js';
import { parseAIResponse } from '../src/ai/action-parser.js';
import type { ChatMessage } from '../src/ai/types.js';

// Load root .env into process.env (so loadConfig picks up AI_MODEL/AI_API_KEY).
for (const line of readFileSync(resolve(process.cwd(), '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
  if (m) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
}

// Same fixture the live test serves — "Ready now" appears only after a delay.
const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Wait Fixture</title></head>
<body><h1>Wait fixture</h1><button id="go">Go</button>
<script>setTimeout(function(){var d=document.createElement('div');d.id='delayed';d.textContent='Ready now';document.body.appendChild(d);},35000);</script>
</body></html>`;

const instruction = "Wait up to 50 seconds for the text 'Ready now' to appear";

async function main(): Promise<void> {
  const config = await loadConfig();
  if (process.env['AI_MODEL']) config.ai.model = process.env['AI_MODEL'];
  if (process.env['AI_API_KEY']) config.ai.apiKey = process.env['AI_API_KEY'];

  const server = http.createServer((_q, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(FIXTURE_HTML); });
  const url = `http://127.0.0.1:${await listenFetchable(server, '127.0.0.1')}/`;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  const dom = await captureDomSnapshot(page, {
    ...config.browser.domNoiseReduction,
    maxIframeDepth: config.browser.maxIframeDepth,
    domSnapshotCharLimit: config.browser.domSnapshotCharLimit,
  });

  console.log('--- config ---');
  console.log('model:', config.ai.model, '| sendScreenshots:', config.ai.sendScreenshots);
  console.log('--- REAL cleaned DOM the AI sees (before "Ready now" exists) ---');
  console.log(dom);
  console.log('--- instruction ---');
  console.log(instruction);
  console.log('');

  const client = new AiClient(config.ai, new TokenTracker());
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt('', undefined, {}) },
    buildStepMessage(instruction, dom, null, []),
  ];
  const result = await client.complete(messages);

  console.log('--- raw AI response ---');
  console.log(result.text);
  console.log('--- parsed actions ---');
  console.log(JSON.stringify(parseAIResponse(result.text).actions, null, 2));

  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
}

main().catch((err) => { console.error('diag failed:', err); process.exit(1); });
