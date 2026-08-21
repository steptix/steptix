/**
 * Returns the embedded HTML template for test reports.
 * Self-contained — no external dependencies required at runtime.
 */
export function getReportTemplate(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{testName}} — AI UI Test Report</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --pass: #16a34a;
      --fail: #dc2626;
      --warn: #d97706;
      --bg: #f9fafb;
      --surface: #ffffff;
      --border: #e5e7eb;
      --text: #111827;
      --muted: #6b7280;
      --code-bg: #f3f4f6;
      --radius: 8px;
      --shadow: 0 1px 3px rgba(0,0,0,0.1);
    }

    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; padding: 24px; }

    .container { max-width: 1200px; margin: 0 auto; }

    /* Header */
    .report-header { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; margin-bottom: 24px; box-shadow: var(--shadow); }
    .report-header h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 16px; }

    /* Session video (file-linked, not embedded) */
    .video-block { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border); }
    .video-label { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 6px; }
    .session-video { width: 100%; max-width: 720px; border: 1px solid var(--border); border-radius: var(--radius); background: #000; }
    .meta-grid { display: flex; flex-wrap: wrap; gap: 12px; }
    .meta-item { display: flex; flex-direction: column; min-width: 0; flex: 1 1 200px; }
    .meta-item-wide { flex: 1 0 100%; }
    .meta-item-grow { flex: 2 1 200px; }
    .meta-label { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 2px; }
    .meta-value { font-size: 0.95rem; font-weight: 500; min-width: 0; overflow-wrap: anywhere; }
    .meta-url-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .meta-url { font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; font-size: 0.82rem; color: #2563eb; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 0 1 auto; }
    .meta-url:hover { text-decoration: underline; }
    .meta-url-row .copy-btn { flex-shrink: 0; }

    /* Status badges */
    .badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: 999px; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
    .badge-pass { background: #dcfce7; color: var(--pass); }
    .badge-fail { background: #fee2e2; color: var(--fail); }
    .badge-skip { background: #fef9c3; color: var(--warn); }
    .badge-aborted { background: #ffedd5; color: #c2410c; }
    .badge-tag { background: #ede9fe; color: #7c3aed; font-size: 0.72rem; }

    /* Summary bar */
    .summary-bar { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 24px; margin-bottom: 24px; display: flex; gap: 32px; align-items: center; box-shadow: var(--shadow); }
    .summary-stat { display: flex; flex-direction: column; align-items: center; }
    .summary-stat .number { font-size: 1.75rem; font-weight: 700; line-height: 1; }
    .summary-stat .label { font-size: 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-top: 2px; }
    .stat-pass { color: var(--pass); }
    .stat-fail { color: var(--fail); }

    /* Steps */
    .steps-section h2 { font-size: 1.1rem; font-weight: 700; margin-bottom: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .step { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 16px; box-shadow: var(--shadow); overflow: hidden; }
    .step-header { display: flex; align-items: center; gap: 12px; padding: 14px 18px; cursor: pointer; user-select: none; }
    .step-header:hover { background: #f8fafc; }
    .step-number { font-size: 0.75rem; font-weight: 700; color: var(--muted); min-width: 60px; }
    .step-instruction { flex: 1; font-weight: 500; }
    .step-duration { font-size: 0.8rem; color: var(--muted); }
    .step-chevron { color: var(--muted); transition: transform 0.2s; font-size: 0.8rem; }
    .step.open .step-chevron { transform: rotate(180deg); }

    .step-body { display: none; padding: 0 18px 18px; border-top: 1px solid var(--border); }
    .step.open .step-body { display: block; }

    /* Turns */
    .turn { margin-top: 14px; }
    .turn + .turn { margin-top: 18px; padding-top: 14px; border-top: 2px dashed var(--border); }
    .turn-header { font-size: 0.8rem; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
    .turn-time { font-weight: 500; font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; font-size: 0.75rem; color: #6366f1; }
    .event-time { font-size: 0.7rem; font-weight: 500; font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; color: var(--muted); margin-left: auto; }
    .ai-model { font-size: 0.7rem; font-weight: 500; font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; color: #4338ca; background: #eef2ff; padding: 0.1rem 0.35rem; border-radius: 0.25rem; }

    /* Sub-actions */
    .sub-actions { margin-top: 10px; }
    .sub-action { border: 1px solid var(--border); border-radius: 6px; margin-bottom: 10px; overflow: hidden; }
    .sub-action-header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: var(--code-bg); cursor: pointer; }
    .sub-action-header:hover { background: #e9eaec; }
    .sub-action-index { font-size: 0.7rem; color: var(--muted); font-weight: 600; min-width: 30px; }
    .action-badge { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; padding: 2px 7px; border-radius: 4px; background: #dbeafe; color: #1d4ed8; }
    .sub-action-desc { flex: 1; font-size: 0.875rem; }
    .sub-action-body { display: none; padding: 12px 14px; }
    .sub-action.open .sub-action-body { display: block; }

    /* Assertion */
    .assertion-block { margin-top: 14px; padding: 14px; border-radius: 6px; border: 1px solid var(--border); }
    .assertion-block.pass { border-color: #bbf7d0; background: #f0fdf4; }
    .assertion-block.fail { border-color: #fecaca; background: #fef2f2; }
    .assertion-title { font-weight: 700; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
    .assertion-row { display: flex; gap: 12px; margin-bottom: 4px; font-size: 0.875rem; }
    .assertion-key { font-weight: 600; min-width: 90px; color: var(--muted); }
    .assertion-code { margin-top: 8px; font-size: 0.8rem; }
    .assertion-code summary { cursor: pointer; color: var(--muted); font-weight: 600; }
    .assertion-code pre { margin: 6px 0 0; padding: 8px; background: var(--code-bg); border-radius: 4px; overflow-x: auto; max-height: 200px; font-size: 0.78rem; }

    /* Reasoning */
    .reasoning-block { margin-top: 10px; font-size: 0.85rem; color: var(--muted); font-style: italic; padding: 8px 12px; background: var(--code-bg); border-radius: 5px; border-left: 3px solid var(--border); }

    /* Screenshots */
    .screenshot-container { margin-top: 10px; }
    .screenshot-label { font-size: 0.75rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px; }
    .screenshot-url { font-size: 0.75rem; color: #2563eb; font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; margin-bottom: 6px; word-break: break-all; }
    .screenshot-img { max-width: 280px; max-height: 180px; object-fit: contain; border: 1px solid var(--border); border-radius: 6px; cursor: zoom-in; transition: opacity 0.15s; }
    .screenshot-img:hover { opacity: 0.85; }
    .turn-screenshot { margin: 10px 0; padding: 10px; background: #f0f7ff; border: 1px solid #bfdbfe; border-radius: 6px; }
    .turn-screenshot .screenshot-label { color: #1d4ed8; }
    .step-end-screenshot { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); }
    .step .badge-fail ~ .step-body .step-end-screenshot .screenshot-label { color: var(--fail); }
    .screenshot-placeholder { font-size: 0.8rem; color: var(--muted); padding: 8px 10px; background: #f8fafc; border: 1px dashed var(--border); border-radius: 6px; max-width: 480px; }
    .screenshot-placeholder code { font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; font-size: 0.75rem; padding: 1px 4px; background: #e2e8f0; border-radius: 3px; }

    /* AI Responses */
    .ai-responses { margin-top: 14px; }
    .ai-responses-title { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 6px; }
    .ai-response { margin-top: 6px; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
    .ai-response summary { font-size: 0.8rem; font-weight: 600; color: #1d4ed8; background: #eff6ff; cursor: pointer; padding: 8px 12px; border-bottom: 1px solid var(--border); list-style: none; display: flex; align-items: center; gap: 6px; }
    .ai-response summary::-webkit-details-marker { display: none; }
    .ai-response summary::before { content: '▶'; font-size: 0.65rem; color: var(--muted); }
    .ai-response[open] summary::before { content: '▼'; }
    .ai-response pre { margin: 0; }
    .json-block { font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; font-size: 0.75rem; background: #1e1e2e; color: #cdd6f4; padding: 14px 16px; overflow-x: auto; max-height: 500px; overflow-y: auto; white-space: pre; line-height: 1.6; }
    .j-key  { color: #89b4fa; }
    .j-str  { color: #a6e3a1; }
    .j-num  { color: #fab387; }
    .j-kw   { color: #cba6f7; font-style: italic; }

    /* AI Request */
    .ai-request { margin: 8px 0; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
    .ai-request summary { font-size: 0.8rem; font-weight: 600; color: #92400e; background: #fffbeb; cursor: pointer; padding: 8px 12px; border-bottom: 1px solid var(--border); list-style: none; display: flex; align-items: center; gap: 6px; }
    .ai-request summary::-webkit-details-marker { display: none; }
    .ai-request summary::before { content: '▶'; font-size: 0.65rem; color: var(--muted); }
    .ai-request[open] summary::before { content: '▼'; }
    .ai-request-body { padding: 0; }
    .ai-request-message { border-bottom: 1px solid var(--border); }
    .ai-request-message:last-child { border-bottom: none; }
    .ai-request-role { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); background: var(--code-bg); padding: 4px 12px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .copy-btn { display: inline-flex; align-items: center; gap: 4px; font: inherit; font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); background: transparent; border: 1px solid var(--border); border-radius: 4px; padding: 2px 6px; cursor: pointer; transition: all 0.15s; }
    .copy-btn:hover { background: var(--surface); color: var(--text); border-color: var(--muted); }
    .copy-btn.copied { color: var(--pass); border-color: #bbf7d0; background: #f0fdf4; }
    .copy-btn svg { flex-shrink: 0; }
    .ai-request-content { font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; font-size: 0.75rem; padding: 10px 12px; margin: 0; white-space: pre-wrap; word-break: break-word; max-height: 400px; overflow-y: auto; background: var(--surface); color: var(--text); }

    .dom-snapshot { margin-top: 10px; }
    .dom-snapshot summary { font-size: 0.75rem; font-weight: 600; color: var(--muted); text-transform: uppercase; cursor: pointer; margin-bottom: 6px; display: flex; align-items: center; gap: 8px; list-style: none; }
    .dom-snapshot summary::-webkit-details-marker { display: none; }
    .dom-snapshot summary::before { content: '▶'; font-size: 0.7rem; color: var(--muted); line-height: 0.75rem; width: 0.8rem; display: inline-block; }
    .dom-snapshot[open] summary::before { content: '▼'; }
    .dom-snapshot summary .copy-btn { margin-left: auto; }
    .dom-snapshot pre { font-family: 'Cascadia Code', 'Fira Code', monospace; font-size: 0.75rem; background: var(--code-bg); padding: 12px; border-radius: 5px; overflow-x: auto; max-height: 300px; overflow-y: auto; border: 1px solid var(--border); white-space: pre-wrap; word-break: break-all; }

    /* Failure block */
    .failure-block { margin-top: 14px; padding: 14px; border-radius: 6px; background: #fef2f2; border: 1px solid #fecaca; }
    .failure-title { font-weight: 700; color: var(--fail); margin-bottom: 6px; }
    .failure-message { font-size: 0.875rem; color: #7f1d1d; font-family: monospace; }

    /* Aborted block — the step the user stopped on (issue 021) */
    .aborted-block { margin-top: 14px; padding: 14px; border-radius: 6px; background: #fff7ed; border: 1px solid #fed7aa; }
    .aborted-title { font-weight: 700; color: #c2410c; margin-bottom: 6px; }
    .aborted-message { font-size: 0.875rem; color: #9a3412; font-family: monospace; }

    /* Captures block — variables this step extracted (issue 042) */
    .captures-block { margin-top: 14px; padding: 10px 14px; border-radius: 6px; background: #f0fdf4; border: 1px solid #bbf7d0; }
    .captures-title { font-weight: 700; color: var(--pass); font-size: 0.8rem; margin-bottom: 6px; }
    .captures-block .tool-kv-key { color: var(--pass); }

    /* Source-skill chip — origin of an expanded step */
    .badge-skill { background: #e0e7ff; color: #3730a3; border: 1px solid #c7d2fe; font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; font-size: 0.72rem; padding: 1px 6px; border-radius: 4px; }
    .badge-skill::before { content: 'skill: '; opacity: 0.6; }
    /* Inline-section chip — a "### Name" block within the test file. Distinct
       from .badge-skill because the prefix below is baked into the rule. */
    .badge-section { background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; font-size: 0.72rem; padding: 1px 6px; border-radius: 4px; }
    .badge-section::before { content: 'section: '; opacity: 0.6; }
    /* How a step avoided the model: ⚙ its own code-behind, ⚡ the action
       cache. Same shape as the provenance chips beside them. */
    .badge-codebehind { background: #fef9c3; color: #854d0e; border: 1px solid #fde68a; font-size: 0.72rem; padding: 1px 6px; border-radius: 4px; }
    .badge-cached { background: #e0f2fe; color: #075985; border: 1px solid #bae6fd; font-size: 0.72rem; padding: 1px 6px; border-radius: 4px; }
    /* Which tab a step drove. Deliberately quiet — it is on every step, so a
       loud colour would compete with the pass/fail badge for attention. The
       unexpected variant is the one meant to catch the eye. */
    .badge-tab { background: #f1f5f9; color: #475569; border: 1px solid #e2e8f0; font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; font-size: 0.72rem; padding: 1px 6px; border-radius: 4px; }
    .badge-tab::before { content: 'tab: '; opacity: 0.6; }
    .badge-tab-unexpected { background: #fef3c7; color: #92400e; border-color: #fde68a; }
    .tab-timeline { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 20px; margin-bottom: 20px; }
    .tab-timeline h2 { margin: 0 0 4px; font-size: 1rem; }
    .tab-timeline .tab-timeline-note { color: #64748b; font-size: 0.82rem; margin: 0 0 12px; }
    .tab-timeline table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    .tab-timeline th { text-align: left; color: #64748b; font-weight: 600; padding: 4px 8px 4px 0; border-bottom: 1px solid #e2e8f0; }
    .tab-timeline td { padding: 5px 8px 5px 0; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
    .tab-timeline .tab-id { font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; color: #475569; }
    .tab-timeline .tab-url { color: #475569; word-break: break-all; }
    .tab-timeline tr.tab-row-unexpected td { background: #fffbeb; }

    /* Tool-step block — surfaces deterministic tool invocation details */
    .tool-block { margin-top: 14px; padding: 12px 14px; border-radius: 6px; background: #f5f3ff; border: 1px solid #ddd6fe; }
    .tool-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
    .tool-title { font-weight: 700; color: #5b21b6; font-size: 0.9rem; }
    .tool-name { font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; font-size: 0.85rem; color: #5b21b6; background: #ede9fe; padding: 2px 8px; border-radius: 4px; }
    .tool-section { margin-top: 10px; }
    .tool-section-label { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 4px; }
    .tool-kv { font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; font-size: 0.8rem; }
    .tool-kv-row { display: flex; gap: 8px; padding: 2px 0; align-items: baseline; }
    .tool-kv-key { color: #6d28d9; flex-shrink: 0; min-width: 80px; }
    .tool-kv-value { color: var(--text); word-break: break-all; }
    /* Code-behind reuses the tool block's chrome in its own colour — same
       kind of thing (deterministic code, live page), different author. */
    .codebehind-block { background: #fefce8; border-color: #fde68a; }
    .codebehind-block .tool-title, .codebehind-block .tool-name { color: #854d0e; }
    .codebehind-block .tool-name { background: #fef3c7; }
    .tool-empty { font-style: italic; color: var(--muted); font-size: 0.8rem; }
    .tool-logs { margin: 0; padding: 8px 12px; background: var(--code-bg); border-radius: 4px; font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; font-size: 0.78rem; color: var(--text); white-space: pre-wrap; max-height: 240px; overflow-y: auto; }
    .tool-log-info { color: var(--text); }
    .tool-log-warn { color: #b45309; }
    .tool-log-error { color: var(--fail); }
    .tool-log-line { padding: 1px 0; }

    /* "How to register a tool" callout — shown when a [tool: ...] step
       fails because the named tool isn't in the catalogue. */
    .tool-hint { margin-top: 14px; padding: 12px 14px; border-radius: 6px; background: #fffbeb; border: 1px solid #fde68a; }
    .tool-hint .tool-section-label { color: #92400e; }
    .tool-hint-body p { margin: 0 0 8px 0; font-size: 0.85rem; line-height: 1.55; color: #78350f; }
    .tool-hint-body p:last-child { margin-bottom: 0; }
    .tool-hint-body code { font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; font-size: 0.8rem; background: #fef3c7; color: #78350f; padding: 1px 6px; border-radius: 3px; }
    .tool-hint-recipe { margin: 8px 0; padding: 10px 12px; background: #fef3c7; border: 1px solid #fde68a; border-radius: 4px; font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; font-size: 0.78rem; color: #78350f; white-space: pre-wrap; overflow-x: auto; }
    .tool-hint-foot { font-style: italic; opacity: 0.85; }

    /* Diagnosis block */
    .diagnosis-block { margin-bottom: 24px; padding: 18px 20px; border-radius: var(--radius); background: #fffbeb; border: 1px solid #fde68a; box-shadow: var(--shadow); }
    .diagnosis-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
    .diagnosis-title { font-weight: 700; font-size: 1rem; color: #92400e; }
    .diagnosis-section { margin-top: 12px; }
    .diagnosis-section-label { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 4px; }
    .diagnosis-root-cause { font-size: 0.95rem; color: #78350f; line-height: 1.55; }
    .diagnosis-evidence { margin: 0; padding-left: 20px; font-size: 0.875rem; color: #78350f; }
    .diagnosis-evidence li { margin-bottom: 2px; }
    .diagnosis-fix { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 10px 14px; color: #14532d; font-size: 0.9rem; white-space: pre-wrap; font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; }
    .badge-cat-test-spec { background: #fef3c7; color: #92400e; }
    .badge-cat-application { background: #fee2e2; color: var(--fail); }
    .badge-cat-flake { background: #ede9fe; color: #7c3aed; }
    .badge-cat-environment { background: #dbeafe; color: #1d4ed8; }
    .badge-cat-unknown { background: #e5e7eb; color: var(--muted); }
    .badge-conf-high { background: #dcfce7; color: var(--pass); }
    .badge-conf-medium { background: #fef3c7; color: #92400e; }
    .badge-conf-low { background: #fee2e2; color: var(--fail); }

    /* Interactive banner — marks where an [interactive] prompt opened, followed by user-typed commands as numbered sub-steps. */
    .interactive-banner { display: flex; align-items: baseline; gap: 10px; margin: 6px 0 10px; padding: 8px 14px; background: #eef2ff; border: 1px solid #c7d2fe; border-left: 3px solid #6366f1; border-radius: 6px; }
    .interactive-banner-label { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #4338ca; }
    .interactive-banner-hint { font-size: 0.85rem; color: #3730a3; font-style: italic; }
    .step-interactive-child .step-number { min-width: 70px; }

    /* Test script */
    .script-block { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; }
    .script-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--code-bg); }
    .script-hint { font-size: 0.75rem; color: var(--muted); }
    .script-body { margin: 0; padding: 14px 16px; font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace; font-size: 0.85rem; white-space: pre-wrap; word-break: break-word; max-height: 500px; overflow-y: auto; }

    /* Footer */
    .report-footer { margin-top: 32px; text-align: center; font-size: 0.8rem; color: var(--muted); }

    /* Lightbox */
    .lightbox { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 9999; align-items: center; justify-content: center; cursor: zoom-out; }
    .lightbox.active { display: flex; }
    .lightbox img { max-width: 95vw; max-height: 95vh; border-radius: 4px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }

    /* Tags */
    .tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  </style>
</head>
<body>
<div class="container">
  <div class="report-header">
    <h1>{{testName}}</h1>
    <div class="meta-grid">
      <div class="meta-item">
        <span class="meta-label">Status</span>
        <span class="meta-value">
          <span class="badge {{statusClass}}">{{statusIcon}} {{statusText}}</span>
        </span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Date</span>
        <span class="meta-value">{{date}}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Duration</span>
        <span class="meta-value">{{duration}}</span>
      </div>
      {{#if modelSummary}}
      <div class="meta-item meta-item-grow">
        <span class="meta-label">AI Model</span>
        <span class="meta-value">{{modelSummary}}</span>
      </div>
      {{/if}}
      {{#if baseUrl}}
      <div class="meta-item meta-item-wide">
        <span class="meta-label">Base URL</span>
        <span class="meta-value meta-url-row">
          <a class="meta-url" href="{{baseUrl}}" target="_blank" rel="noopener" title="{{baseUrl}}">{{baseUrl}}</a>
          <button class="copy-btn" type="button" data-copy="{{baseUrl}}" title="Copy URL"><span class="copy-btn-label">Copy</span></button>
        </span>
      </div>
      {{/if}}
      {{#if filePath}}
      <div class="meta-item meta-item-wide">
        <span class="meta-label">Test file</span>
        <span class="meta-value meta-url-row">
          <span class="meta-url" title="{{filePath}}">{{filePath}}</span>
          <button class="copy-btn" type="button" data-copy="{{filePath}}" title="Copy path"><span class="copy-btn-label">Copy</span></button>
        </span>
      </div>
      {{/if}}
      {{#if dataRow}}
      <div class="meta-item">
        <span class="meta-label">Data Row</span>
        <span class="meta-value">{{dataRow}}</span>
      </div>
      {{/if}}
    </div>
    {{#if tags.length}}
    <div class="tags">
      {{#each tags}}<span class="badge badge-tag">{{this}}</span>{{/each}}
    </div>
    {{/if}}
    {{#if videoRelPath}}
    <div class="video-block">
      <div class="video-label">Session recording</div>
      <video class="session-video" src="{{videoRelPath}}" controls preload="metadata"></video>
    </div>
    {{/if}}
  </div>

  <div class="summary-bar">
    <div class="summary-stat">
      <span class="number">{{totalSteps}}</span>
      <span class="label">Steps</span>
    </div>
    <div class="summary-stat">
      <span class="number stat-pass">{{passedSteps}}</span>
      <span class="label">Passed</span>
    </div>
    <div class="summary-stat">
      <span class="number stat-fail">{{failedSteps}}</span>
      <span class="label">Failed</span>
    </div>
    <div class="summary-stat">
      <span class="number">{{totalSubActions}}</span>
      <span class="label">Sub-actions</span>
    </div>
    <div class="summary-stat">
      <span class="number">{{inputTokens}}</span>
      <span class="label">Input Tokens</span>
    </div>
    <div class="summary-stat">
      <span class="number">{{outputTokens}}</span>
      <span class="label">Output Tokens</span>
    </div>
    <div class="summary-stat">
      <span class="number">{{tokensUsed}}</span>
      <span class="label">Total Tokens</span>
    </div>
  </div>

  {{{diagnosisHtml}}}

  {{{tabTimelineHtml}}}

  <div class="steps-section">
    <h2>Steps</h2>
    {{{stepsHtml}}}
  </div>

  {{#if scriptText}}
  <div class="steps-section script-section">
    <h2>Test script</h2>
    <div class="script-block">
      <div class="script-header">
        <span class="script-hint">Copy into a .md test file to replay this run</span>
        <button class="copy-btn" type="button"><span class="copy-btn-label">Copy</span></button>
      </div>
      <pre class="script-body">{{scriptText}}</pre>
    </div>
  </div>
  {{/if}}

  <div class="report-footer">
    Generated by <strong>ai-ui-automation</strong> · {{date}}
  </div>
</div>

<div class="lightbox" id="lightbox">
  <img id="lightbox-img" src="" alt="Screenshot">
</div>

<script>
  // Toggle step bodies
  document.querySelectorAll('.step-header').forEach(function(header) {
    header.addEventListener('click', function() {
      var step = this.closest('.step');
      step.classList.toggle('open');
    });
  });

  // Toggle sub-action bodies
  document.querySelectorAll('.sub-action-header').forEach(function(header) {
    header.addEventListener('click', function(e) {
      e.stopPropagation();
      var sa = this.closest('.sub-action');
      sa.classList.toggle('open');
    });
  });

  // Lightbox for screenshots
  var lightbox = document.getElementById('lightbox');
  var lightboxImg = document.getElementById('lightbox-img');

  document.querySelectorAll('.screenshot-img').forEach(function(img) {
    img.addEventListener('click', function(e) {
      e.stopPropagation();
      lightboxImg.src = this.src;
      lightbox.classList.add('active');
    });
  });

  lightbox.addEventListener('click', function() {
    lightbox.classList.remove('active');
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') lightbox.classList.remove('active');
  });

  // Copy buttons
  document.querySelectorAll('.copy-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      e.preventDefault();
      var text = btn.getAttribute('data-copy');
      if (text == null) {
        var content = btn.parentElement.nextElementSibling;
        if (!content) return;
        text = content.textContent || '';
      }
      var done = function() {
        var label = btn.querySelector('.copy-btn-label');
        var original = label ? label.textContent : '';
        btn.classList.add('copied');
        if (label) label.textContent = 'Copied';
        setTimeout(function() {
          btn.classList.remove('copied');
          if (label) label.textContent = original;
        }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function() {
          var ta = document.createElement('textarea');
          ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); done(); } finally { document.body.removeChild(ta); }
        });
      } else {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } finally { document.body.removeChild(ta); }
      }
    });
  });

  // Auto-open the first failed OR aborted step (issue 021) so a stopped run's
  // interrupted step expands too.
  var firstNotable = document.querySelector('.step .badge-fail, .step .badge-aborted');
  if (firstNotable) {
    firstNotable.closest('.step').classList.add('open');
  }
</script>
</body>
</html>`;
}
