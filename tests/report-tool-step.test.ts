import { describe, it, expect } from 'vitest';
import { renderToolStep } from '../src/report/generator.js';

describe('renderToolStep — HTML rendering of [tool: ...] step details', () => {
  it('renders tool name, args, outputs, and logs in distinct sections', () => {
    const html = renderToolStep({
      name: 'fetch_csrf_token',
      args: { baseUrl: 'http://127.0.0.1:8787', timeoutMs: 30000 },
      outputs: { csrf: 'abc123def456' },
      logs: [
        { level: 'info', message: 'GET http://127.0.0.1:8787/api/csrf-token' },
        { level: 'info', message: 'captured token (32 chars)' },
      ],
    });
    // Tool name surfaces in the header
    expect(html).toContain('fetch_csrf_token');
    // Section labels are present
    expect(html).toContain('Args');
    expect(html).toContain('Outputs');
    expect(html).toContain('Logs');
    // Args appear with both keys and values
    expect(html).toContain('baseUrl');
    expect(html).toContain('http://127.0.0.1:8787');
    expect(html).toContain('timeoutMs');
    expect(html).toContain('30000');
    // Output appears
    expect(html).toContain('csrf');
    expect(html).toContain('abc123def456');
    // Logs are rendered, with the level prefix
    expect(html).toContain('[info]');
    expect(html).toContain('GET http://127.0.0.1:8787/api/csrf-token');
    expect(html).toContain('captured token (32 chars)');
  });

  it('uses an empty-state placeholder when there are no args', () => {
    const html = renderToolStep({
      name: 'uuid',
      args: {},
      outputs: { uuid: '550e8400-e29b-41d4-a716-446655440000' },
      logs: [],
    });
    expect(html).toContain('(no args)');
    expect(html).toContain('uuid');
    expect(html).toContain('550e8400-e29b-41d4-a716-446655440000');
  });

  it('uses an empty-state placeholder when no outputs were captured', () => {
    const html = renderToolStep({
      name: 'side_effect_only',
      args: { x: 'y' },
      outputs: {},
      logs: [{ level: 'info', message: 'did the thing' }],
    });
    expect(html).toContain('(no outputs captured)');
  });

  it('omits the Logs section entirely when no logs were emitted', () => {
    const html = renderToolStep({
      name: 'silent',
      args: {},
      outputs: { silent: 'ok' },
      logs: [],
    });
    expect(html).not.toContain('Logs');
    expect(html).not.toContain('tool-logs');
  });

  it('renders warn and error log levels with distinct CSS classes', () => {
    const html = renderToolStep({
      name: 'noisy',
      args: {},
      outputs: {},
      logs: [
        { level: 'info', message: 'starting' },
        { level: 'warn', message: 'hmm' },
        { level: 'error', message: 'broke' },
      ],
    });
    expect(html).toContain('tool-log-info');
    expect(html).toContain('tool-log-warn');
    expect(html).toContain('tool-log-error');
    expect(html).toContain('[warn]');
    expect(html).toContain('[error]');
  });

  it('escapes HTML in args, outputs, and logs to prevent injection', () => {
    const html = renderToolStep({
      name: 'evil',
      args: { payload: '<script>alert("x")</script>' },
      outputs: { result: '<img src=x onerror=alert(1)>' },
      logs: [{ level: 'info', message: '<b>not bold</b>' }],
    });
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>not bold</b>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x');
    expect(html).toContain('&lt;b&gt;');
  });

  it('JSON-stringifies non-primitive arg values', () => {
    const html = renderToolStep({
      name: 'with_obj',
      args: { config: { nested: true, count: 7 } },
      outputs: {},
      logs: [],
    });
    expect(html).toContain('{&quot;nested&quot;:true,&quot;count&quot;:7}');
  });

  it('renders boolean and number arg values as-is', () => {
    const html = renderToolStep({
      name: 'mixed',
      args: { flag: true, count: 42 },
      outputs: {},
      logs: [],
    });
    expect(html).toContain('true');
    expect(html).toContain('42');
  });
});
