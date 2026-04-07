<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { convertFileSrc } from "@tauri-apps/api/core";

  interface Props {
    sessionId: string;
    filename: string;
  }

  let { sessionId, filename }: Props = $props();
  let fullscreen = $state(false);
  let imgSrc = $state("");

  $effect(() => {
    loadImage();
  });

  async function loadImage() {
    try {
      const path = await invoke<string>("get_screenshot_path", {
        sessionId,
        filename,
      });
      imgSrc = convertFileSrc(path);
    } catch {
      imgSrc = "";
    }
  }

  function openFull() {
    fullscreen = true;
  }

  function closeFull() {
    fullscreen = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") closeFull();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if imgSrc}
  <button class="thumbnail-btn" onclick={openFull}>
    <img class="thumbnail" src={imgSrc} alt="Screenshot" />
  </button>

  {#if fullscreen}
    <div class="fullscreen-overlay" onclick={closeFull}>
      <img class="fullscreen-img" src={imgSrc} alt="Screenshot (full)" />
    </div>
  {/if}
{/if}

<style>
  .thumbnail-btn {
    display: block;
    border: none;
    background: none;
    padding: 0;
    cursor: pointer;
    margin-top: 6px;
  }

  .thumbnail {
    width: 280px;
    border-radius: 4px;
    border: 1px solid #e5e5e5;
  }

  .fullscreen-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 3000;
    cursor: pointer;
  }

  .fullscreen-img {
    max-width: 95vw;
    max-height: 95vh;
    border-radius: 4px;
  }
</style>
