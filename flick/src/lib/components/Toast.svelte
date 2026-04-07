<script lang="ts">
  import { toasts } from "../stores/ui";
</script>

{#if $toasts.length > 0}
  <div class="toast-container">
    {#each $toasts as toast (toast.id)}
      <div class="toast toast-{toast.type}">
        {toast.message}
      </div>
    {/each}
  </div>
{/if}

<style>
  .toast-container {
    position: fixed;
    top: 44px;
    right: 8px;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 300px;
  }

  .toast {
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 12px;
    color: #fff;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    animation: slideIn 0.2s ease;
  }

  .toast-info {
    background: #1a1a1a;
  }

  .toast-error {
    background: #dc2626;
  }

  .toast-success {
    background: #16a34a;
  }

  @keyframes slideIn {
    from {
      opacity: 0;
      transform: translateX(20px);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }
</style>
