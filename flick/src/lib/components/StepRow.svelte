<script lang="ts">
  import ScreenshotViewer from "./ScreenshotViewer.svelte";

  interface StepResult {
    step: string;
    status: string;
    actions: unknown[];
    screenshotFile: string | null;
    reasoning: string;
    outputs: Record<string, string>;
  }

  interface Props {
    result: StepResult;
    index: number;
    sessionId: string;
    autoExpand?: boolean;
  }

  let { result, index, sessionId, autoExpand = false }: Props = $props();
  let expanded = $state(autoExpand);
</script>

<div class="step-row">
  <button class="step-header" onclick={() => (expanded = !expanded)}>
    <span class="chevron" class:open={expanded}>&#9654;</span>
    <span class="step-num">Step {index + 1}</span>
    <span class="step-text">{result.step}</span>
    <span
      class="badge"
      class:passed={result.status === "passed"}
      class:failed={result.status === "failed"}
      class:error={result.status === "error"}
    >
      {result.status.toUpperCase()}
    </span>
  </button>

  {#if expanded}
    <div class="step-detail">
      {#if result.reasoning}
        <div class="detail-section">
          <span class="detail-label">Reasoning</span>
          <p>{result.reasoning}</p>
        </div>
      {/if}

      {#if result.actions && result.actions.length > 0}
        <div class="detail-section">
          <span class="detail-label">Actions</span>
          <pre class="actions-json">{JSON.stringify(result.actions, null, 2)}</pre>
        </div>
      {/if}

      {#if Object.keys(result.outputs).length > 0}
        <div class="detail-section">
          <span class="detail-label">Outputs</span>
          <div class="outputs">
            {#each Object.entries(result.outputs) as [key, value]}
              <div class="output-row">
                <span class="output-key">{key}:</span>
                <span class="output-value">{value}</span>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      {#if result.screenshotFile}
        <div class="detail-section">
          <span class="detail-label">Screenshot</span>
          <ScreenshotViewer {sessionId} filename={result.screenshotFile} />
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .step-row {
    border-bottom: 1px solid #f0f0f0;
  }

  .step-row:last-child {
    border-bottom: none;
  }

  .step-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 8px;
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 12px;
    text-align: left;
    color: #1a1a1a;
  }

  .step-header:hover {
    background: #fafafa;
  }

  .chevron {
    font-size: 8px;
    color: #999;
    transition: transform 0.15s;
    flex-shrink: 0;
  }

  .chevron.open {
    transform: rotate(90deg);
  }

  .step-num {
    font-weight: 500;
    flex-shrink: 0;
    color: #666;
  }

  .step-text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .badge {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 3px;
    flex-shrink: 0;
    text-transform: uppercase;
  }

  .badge.passed {
    background: #dcfce7;
    color: #16a34a;
  }

  .badge.failed {
    background: #fee2e2;
    color: #dc2626;
  }

  .badge.error {
    background: #fff7ed;
    color: #ea580c;
  }

  .step-detail {
    padding: 8px 12px 8px 24px;
    font-size: 12px;
  }

  .detail-section {
    margin-bottom: 8px;
  }

  .detail-label {
    font-size: 10px;
    font-weight: 600;
    color: #999;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    display: block;
    margin-bottom: 2px;
  }

  p {
    margin: 0;
    color: #333;
    line-height: 1.4;
  }

  .actions-json {
    margin: 0;
    font-size: 11px;
    background: #f5f5f5;
    padding: 6px 8px;
    border-radius: 4px;
    overflow-x: auto;
    color: #333;
  }

  .outputs {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .output-row {
    display: flex;
    gap: 4px;
  }

  .output-key {
    font-weight: 500;
    color: #666;
  }

  .output-value {
    color: #1a1a1a;
  }
</style>
