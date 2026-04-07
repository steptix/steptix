<script lang="ts">
  interface Props {
    onsubmit: (text: string) => void;
    disabled?: boolean;
  }

  let { onsubmit, disabled = false }: Props = $props();
  let text = $state("");
  let textarea: HTMLTextAreaElement | undefined = $state();

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onsubmit(trimmed);
    text = "";
    if (textarea) {
      textarea.style.height = "auto";
    }
  }

  function handleInput() {
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 150) + "px";
    }
  }
</script>

<div class="input-box">
  <textarea
    bind:this={textarea}
    bind:value={text}
    onkeydown={handleKeydown}
    oninput={handleInput}
    placeholder="Type your steps here..."
    rows={2}
    {disabled}
  ></textarea>
  <button
    class="send-btn"
    onclick={submit}
    disabled={disabled || !text.trim()}
    title="Send steps"
  >
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M22 2L11 13" />
      <path d="M22 2L15 22L11 13L2 9L22 2Z" />
    </svg>
  </button>
</div>

<style>
  .input-box {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 8px 12px;
    border-top: 1px solid #e5e5e5;
    background: #fff;
    flex-shrink: 0;
  }

  textarea {
    flex: 1;
    resize: none;
    border: 1px solid #e5e5e5;
    border-radius: 8px;
    padding: 8px 12px;
    font-size: 13px;
    font-family: inherit;
    line-height: 1.4;
    outline: none;
    min-height: 36px;
    max-height: 150px;
    background: #fafafa;
  }

  textarea:focus {
    border-color: #2563eb;
    background: #fff;
  }

  textarea:disabled {
    opacity: 0.6;
  }

  .send-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: none;
    border-radius: 8px;
    background: #2563eb;
    color: #fff;
    cursor: pointer;
    flex-shrink: 0;
  }

  .send-btn:hover:not(:disabled) {
    background: #1d4ed8;
  }

  .send-btn:disabled {
    background: #ccc;
    cursor: default;
  }
</style>
