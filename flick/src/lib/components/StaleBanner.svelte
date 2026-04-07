<script lang="ts">
  import { staleSessions, activeSessionId, clearStale } from "../stores/sessions";

  let show = $derived(
    $activeSessionId !== null && $staleSessions.has($activeSessionId),
  );

  function dismiss() {
    if ($activeSessionId) {
      clearStale($activeSessionId);
    }
  }
</script>

{#if show}
  <div class="stale-banner">
    <span>Server session was reset. A new browser will start on the next step.</span>
    <button onclick={dismiss}>&times;</button>
  </div>
{/if}

<style>
  .stale-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: #fef3c7;
    border-bottom: 1px solid #fde68a;
    font-size: 12px;
    color: #92400e;
    flex-shrink: 0;
  }

  button {
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 16px;
    color: #92400e;
    padding: 0 4px;
    line-height: 1;
  }

  button:hover {
    color: #78350f;
  }
</style>
