<script lang="ts">
  import { confirmDialog } from "../stores/ui";

  function handleConfirm() {
    $confirmDialog?.onConfirm();
    $confirmDialog = null;
  }

  function handleCancel() {
    $confirmDialog = null;
  }
</script>

{#if $confirmDialog}
  <div class="overlay" onclick={handleCancel}>
    <div class="dialog" onclick={(e: MouseEvent) => e.stopPropagation()}>
      <p>{$confirmDialog.message}</p>
      <div class="actions">
        <button class="btn-cancel" onclick={handleCancel}>Cancel</button>
        <button class="btn-confirm" onclick={handleConfirm}>Delete</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
  }

  .dialog {
    background: #fff;
    border-radius: 8px;
    padding: 20px;
    max-width: 340px;
    width: 90%;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  }

  p {
    margin: 0 0 16px;
    font-size: 14px;
    color: #1a1a1a;
    line-height: 1.4;
  }

  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }

  button {
    padding: 6px 16px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    border: none;
  }

  .btn-cancel {
    background: #f5f5f5;
    color: #666;
  }

  .btn-cancel:hover {
    background: #e5e5e5;
  }

  .btn-confirm {
    background: #dc2626;
    color: #fff;
  }

  .btn-confirm:hover {
    background: #b91c1c;
  }
</style>
