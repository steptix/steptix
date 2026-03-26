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
    .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
    .meta-item { display: flex; flex-direction: column; }
    .meta-label { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 2px; }
    .meta-value { font-size: 0.95rem; font-weight: 500; }

    /* Status badges */
    .badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: 999px; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
    .badge-pass { background: #dcfce7; color: var(--pass); }
    .badge-fail { background: #fee2e2; color: var(--fail); }
    .badge-skip { background: #fef9c3; color: var(--warn); }
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

    /* Sub-actions */
    .sub-actions { margin-top: 14px; }
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

    /* Reasoning */
    .reasoning-block { margin-top: 10px; font-size: 0.85rem; color: var(--muted); font-style: italic; padding: 8px 12px; background: var(--code-bg); border-radius: 5px; border-left: 3px solid var(--border); }

    /* Screenshots */
    .screenshot-container { margin-top: 10px; }
    .screenshot-label { font-size: 0.75rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
    .screenshot-img { max-width: 100%; border: 1px solid var(--border); border-radius: 6px; cursor: zoom-in; }

    /* DOM snapshot */
    .ai-responses { margin-top: 14px; }
    .ai-responses-title { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 6px; }
    .ai-response { margin-top: 6px; }
    .ai-response summary { font-size: 0.8rem; font-weight: 500; color: var(--muted); cursor: pointer; margin-bottom: 4px; }
    .ai-response pre { font-family: 'Cascadia Code', 'Fira Code', monospace; font-size: 0.75rem; background: var(--code-bg); padding: 12px; border-radius: 5px; overflow-x: auto; max-height: 400px; overflow-y: auto; border: 1px solid var(--border); white-space: pre-wrap; word-break: break-all; }

    .dom-snapshot { margin-top: 10px; }
    .dom-snapshot summary { font-size: 0.75rem; font-weight: 600; color: var(--muted); text-transform: uppercase; cursor: pointer; margin-bottom: 6px; }
    .dom-snapshot pre { font-family: 'Cascadia Code', 'Fira Code', monospace; font-size: 0.75rem; background: var(--code-bg); padding: 12px; border-radius: 5px; overflow-x: auto; max-height: 300px; overflow-y: auto; border: 1px solid var(--border); white-space: pre-wrap; word-break: break-all; }

    /* Failure block */
    .failure-block { margin-top: 14px; padding: 14px; border-radius: 6px; background: #fef2f2; border: 1px solid #fecaca; }
    .failure-title { font-weight: 700; color: var(--fail); margin-bottom: 6px; }
    .failure-message { font-size: 0.875rem; color: #7f1d1d; font-family: monospace; }

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
      {{#if baseUrl}}
      <div class="meta-item">
        <span class="meta-label">Base URL</span>
        <span class="meta-value">{{baseUrl}}</span>
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

  <div class="steps-section">
    <h2>Steps</h2>
    {{{stepsHtml}}}
  </div>

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

  // Auto-open first failed step
  var firstFailed = document.querySelector('.step .badge-fail');
  if (firstFailed) {
    firstFailed.closest('.step').classList.add('open');
  }
</script>
</body>
</html>`;
}
