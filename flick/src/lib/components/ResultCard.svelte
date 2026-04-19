<script lang="ts">
  import StepRow from "./StepRow.svelte";

  interface StepResult {
    step: string;
    status: string;
    actions: unknown[];
    screenshotFile: string | null;
    reasoning: string;
    outputs: Record<string, string>;
  }

  interface BatchResult {
    status: string;
    stepsCompleted: number;
    stepsTotal: number;
    results: StepResult[];
    outputs: Record<string, string>;
    error: { step: number; message: string } | null;
  }

  interface Props {
    result: BatchResult;
    sessionId: string;
    timestamp: string;
  }

  let { result, sessionId, timestamp }: Props = $props();
</script>

<div class="result-card">
  <div class="steps">
    {#each result.results as stepResult, i}
      <StepRow
        result={stepResult}
        index={i}
        {sessionId}
        autoExpand={stepResult.status !== "passed"}
      />
    {/each}
  </div>

  <div class="footer">
    <span class="step-count">
      {result.stepsCompleted} / {result.stepsTotal} steps
    </span>
    <span
      class="badge"
      class:passed={result.status === "passed"}
      class:failed={result.status === "failed"}
      class:error={result.status === "error"}
    >
      {result.status.toUpperCase()}
    </span>
  </div>

  {#if result.error}
    <div class="error-banner">
      Step {result.error.step + 1}: {result.error.message}
    </div>
  {/if}

  <span class="time">{new Date(timestamp).toLocaleTimeString()}</span>
</div>

<style>
  .result-card {
    margin: 8px 12px;
    background: #f5f5f5;
    border-radius: 12px 12px 12px 2px;
    overflow: hidden;
    max-width: 85%;
  }

  .steps {
    padding: 4px 0;
  }

  .footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    border-top: 1px solid #e5e5e5;
    font-size: 11px;
    color: #666;
  }

  .step-count {
    font-weight: 500;
  }

  .badge {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 3px;
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

  .error-banner {
    padding: 6px 10px;
    background: #fef2f2;
    color: #dc2626;
    font-size: 12px;
    border-top: 1px solid #fecaca;
    user-select: text;
  }

  .time {
    display: block;
    font-size: 10px;
    color: #999;
    padding: 2px 10px 6px;
  }
</style>
