<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { loadSettings } from "./lib/stores/settings";
  import { loadSessions, activeSession, createSession } from "./lib/stores/sessions";
  import { startConnectionPolling } from "./lib/stores/connection";
  import { settingsOpen } from "./lib/stores/ui";
  import TabBar from "./lib/components/TabBar.svelte";
  import ChatView from "./lib/components/ChatView.svelte";
  import StatusDot from "./lib/components/StatusDot.svelte";
  import SettingsModal from "./lib/components/SettingsModal.svelte";
  import ConfirmDialog from "./lib/components/ConfirmDialog.svelte";
  import Toast from "./lib/components/Toast.svelte";

  let pinned = $state(false);

  onMount(async () => {
    await loadSettings();
    await loadSessions();
    startConnectionPolling();
  });

  $effect(() => {
    const session = $activeSession;
    try {
      const title = session ? `Flick \u2014 ${session.name}` : "Flick";
      getCurrentWindow().setTitle(title);
    } catch {
      // ignore
    }
  });

  async function togglePin() {
    pinned = !pinned;
    try {
      await invoke("set_always_on_top", { pinned });
    } catch {
      // ignore
    }
  }

  function handleNewSessionIfEmpty() {
    if (!$activeSession) {
      createSession();
    }
  }

  onMount(() => {
    // If no sessions exist, create one
    handleNewSessionIfEmpty();
  });
</script>

<div class="app">
  <div class="top-bar">
    <TabBar />
    <div class="top-actions">
      <button
        class="icon-btn pin-btn"
        class:active={pinned}
        onclick={togglePin}
        title={pinned ? "Unpin from top" : "Pin on top"}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill={pinned ? "currentColor" : "none"} stroke="currentColor" stroke-width="2">
          <path d="M12 2L12 12" />
          <path d="M18.5 8.5L17 15H7L5.5 8.5" />
          <path d="M8 15L8 22" />
          <path d="M16 15L16 22" />
        </svg>
      </button>
    </div>
  </div>

  <ChatView />

  <div class="status-bar">
    <StatusDot />
    <div class="status-spacer"></div>
    <button
      class="status-btn"
      onclick={() => ($settingsOpen = true)}
      title="Settings"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
      </svg>
    </button>
  </div>

  <SettingsModal />
  <ConfirmDialog />
  <Toast />
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: #fff;
  }

  .top-bar {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .top-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 6px;
    height: 36px;
    background: #f5f5f5;
    border-bottom: 1px solid #e5e5e5;
    flex-shrink: 0;
  }

  .icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    background: transparent;
    cursor: pointer;
    color: #666;
    border-radius: 4px;
    padding: 0;
  }

  .icon-btn:hover {
    background: #e5e5e5;
    color: #333;
  }

  .pin-btn.active {
    color: #2563eb;
  }

  .status-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 8px;
    height: 22px;
    background: #f5f5f5;
    border-top: 1px solid #e5e5e5;
    flex-shrink: 0;
  }

  .status-spacer {
    flex: 1;
  }

  .status-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 18px;
    border: none;
    background: transparent;
    cursor: pointer;
    color: #888;
    border-radius: 3px;
    padding: 0;
  }

  .status-btn:hover {
    background: #e5e5e5;
    color: #333;
  }
</style>
