<script lang="ts">
  import { settings, saveSettings, type Settings } from "../stores/settings";
  import { settingsOpen } from "../stores/ui";
  import { checkNow } from "../stores/connection";

  let form: Settings = $state({ ...$settings });

  $effect(() => {
    if ($settingsOpen) {
      form = { ...$settings };
    }
  });

  function handleSave() {
    saveSettings(form);
    $settingsOpen = false;
    checkNow();
  }

  function handleCancel() {
    $settingsOpen = false;
  }
</script>

{#if $settingsOpen}
  <div class="overlay" onclick={handleCancel}>
    <div class="modal" onclick={(e: MouseEvent) => e.stopPropagation()}>
      <h2>Settings</h2>

      <label>
        <span>API URL</span>
        <input type="text" bind:value={form.apiUrl} placeholder="http://127.0.0.1:3100" />
      </label>

      <label>
        <span>API Key</span>
        <input type="password" bind:value={form.apiKey} placeholder="Enter API key" />
      </label>

      <label>
        <span>Default Base URL</span>
        <input type="text" bind:value={form.defaultBaseUrl} placeholder="Optional" />
      </label>

      <label>
        <span>Default Timeout</span>
        <input type="text" bind:value={form.defaultTimeout} placeholder="e.g. 30s" />
      </label>

      <div class="actions">
        <button class="btn-cancel" onclick={handleCancel}>Cancel</button>
        <button class="btn-save" onclick={handleSave}>Save</button>
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
    z-index: 1500;
  }

  .modal {
    background: #fff;
    border-radius: 8px;
    padding: 24px;
    max-width: 380px;
    width: 90%;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  }

  h2 {
    margin: 0 0 16px;
    font-size: 16px;
    font-weight: 600;
    color: #1a1a1a;
  }

  label {
    display: block;
    margin-bottom: 12px;
  }

  label span {
    display: block;
    font-size: 12px;
    font-weight: 500;
    color: #666;
    margin-bottom: 4px;
  }

  input {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid #e5e5e5;
    border-radius: 6px;
    font-size: 13px;
    outline: none;
    box-sizing: border-box;
  }

  input:focus {
    border-color: #2563eb;
  }

  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 16px;
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

  .btn-save {
    background: #2563eb;
    color: #fff;
  }

  .btn-save:hover {
    background: #1d4ed8;
  }
</style>
