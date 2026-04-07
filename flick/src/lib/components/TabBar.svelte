<script lang="ts">
  import {
    sortedSessions,
    activeSessionId,
    createSession,
    deleteSession,
    renameSession,
    staleSessions,
  } from "../stores/sessions";
  import { deleteServerSession } from "../api/client";
  import { settings } from "../stores/settings";
  import { confirmDialog } from "../stores/ui";
  import { get } from "svelte/store";

  let editingId: string | null = $state(null);
  let editValue = $state("");
  let tabsContainer: HTMLDivElement | undefined = $state();

  function handleTabClick(id: string) {
    $activeSessionId = id;
  }

  function handleNewSession() {
    createSession();
    if (tabsContainer) {
      setTimeout(() => {
        tabsContainer!.scrollLeft = tabsContainer!.scrollWidth;
      }, 50);
    }
  }

  function handleDelete(e: MouseEvent, id: string, name: string) {
    e.stopPropagation();
    $confirmDialog = {
      message: `Delete "${name}"? This will close the browser session.`,
      onConfirm: async () => {
        const s = get(settings);
        try {
          await deleteServerSession(s.apiUrl, s.apiKey, id);
        } catch {
          // session may already be closed on the server
        }
        deleteSession(id);
      },
    };
  }

  function handleDoubleClick(id: string, name: string) {
    editingId = id;
    editValue = name;
  }

  function handleRenameKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && editingId) {
      renameSession(editingId, editValue);
      editingId = null;
    } else if (e.key === "Escape") {
      editingId = null;
    }
  }

  function handleRenameBlur() {
    if (editingId) {
      renameSession(editingId, editValue);
      editingId = null;
    }
  }
</script>

<div class="tab-bar">
  <div class="tabs" bind:this={tabsContainer}>
    {#each $sortedSessions as session (session.id)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="tab"
        class:active={$activeSessionId === session.id}
        class:stale={$staleSessions.has(session.id)}
        onclick={() => handleTabClick(session.id)}
        ondblclick={() => handleDoubleClick(session.id, session.name)}
        title={session.id}
        role="tab"
        tabindex="0"
      >
        {#if editingId === session.id}
          <input
            class="tab-rename"
            type="text"
            bind:value={editValue}
            onkeydown={handleRenameKeydown}
            onblur={handleRenameBlur}
            autofocus
          />
        {:else}
          <span class="tab-name">{session.name}</span>
        {/if}
        <button
          class="tab-close"
          onclick={(e: MouseEvent) => handleDelete(e, session.id, session.name)}
          title="Delete session"
        >
          &times;
        </button>
      </div>
    {/each}
  </div>
  <button class="tab-new" onclick={handleNewSession} title="New session">+</button>
</div>

<style>
  .tab-bar {
    display: flex;
    align-items: center;
    background: #f5f5f5;
    border-bottom: 1px solid #e5e5e5;
    height: 36px;
    flex-shrink: 0;
  }

  .tabs {
    display: flex;
    overflow-x: auto;
    flex: 1;
    scrollbar-width: none;
  }

  .tabs::-webkit-scrollbar {
    display: none;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 12px;
    height: 36px;
    background: transparent;
    cursor: pointer;
    white-space: nowrap;
    font-size: 13px;
    color: #666;
    border-right: 1px solid #e5e5e5;
    flex-shrink: 0;
  }

  .tab:hover {
    background: #eee;
  }

  .tab.active {
    background: #fff;
    color: #1a1a1a;
    font-weight: 500;
  }

  .tab.stale {
    font-style: italic;
  }

  .tab-name {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tab-rename {
    width: 100px;
    font-size: 13px;
    padding: 1px 4px;
    border: 1px solid #2563eb;
    border-radius: 3px;
    outline: none;
  }

  .tab-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 14px;
    color: #999;
    border-radius: 3px;
    padding: 0;
    line-height: 1;
  }

  .tab-close:hover {
    background: #ddd;
    color: #333;
  }

  .tab-new {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 36px;
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 18px;
    color: #666;
    flex-shrink: 0;
  }

  .tab-new:hover {
    background: #eee;
    color: #333;
  }
</style>
