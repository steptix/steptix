<script lang="ts">
  import { onDestroy } from "svelte";

  interface Props {
    onsubmit: (text: string) => void;
    disabled?: boolean;
  }

  let { onsubmit, disabled = false }: Props = $props();
  let text = $state("");
  let textarea: HTMLTextAreaElement | undefined = $state();

  const SpeechRecognitionCtor: any =
    typeof window !== "undefined"
      ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      : undefined;
  const speechSupported = !!SpeechRecognitionCtor;

  let recognition: any = null;
  let recording = $state(false);
  let baseText = "";

  function resizeTextarea() {
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 150) + "px";
    }
  }

  function startRecording() {
    if (!speechSupported || recording) return;
    try {
      recognition = new SpeechRecognitionCtor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || "en-US";

      baseText = text ? text.replace(/\s+$/, "") + (text.trim() ? " " : "") : "";

      recognition.onresult = (event: any) => {
        let finalChunk = "";
        let interimChunk = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) {
            finalChunk += result[0].transcript;
          } else {
            interimChunk += result[0].transcript;
          }
        }
        if (finalChunk) {
          baseText = (baseText + finalChunk).replace(/\s+/g, " ");
          if (!baseText.endsWith(" ")) baseText += " ";
        }
        text = (baseText + interimChunk).trimStart();
        resizeTextarea();
      };

      recognition.onerror = () => stopRecording();
      recognition.onend = () => {
        recording = false;
        recognition = null;
      };

      recognition.start();
      recording = true;
    } catch {
      recording = false;
      recognition = null;
    }
  }

  function stopRecording() {
    if (!recognition) {
      recording = false;
      return;
    }
    try {
      recognition.stop();
    } catch {
      // ignore
    }
  }

  function toggleRecording() {
    if (recording) {
      stopRecording();
    } else {
      startRecording();
    }
  }

  onDestroy(() => {
    if (recognition) {
      try {
        recognition.abort();
      } catch {
        // ignore
      }
    }
  });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    if (recording) stopRecording();
    onsubmit(trimmed);
    text = "";
    if (textarea) {
      textarea.style.height = "auto";
    }
  }

  function handleInput() {
    resizeTextarea();
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
    class="mic-btn"
    class:active={recording}
    onclick={toggleRecording}
    disabled={disabled || !speechSupported}
    title={speechSupported
      ? recording
        ? "Stop recording"
        : "Start voice input"
      : "Speech-to-text is not supported on this platform at this time."}
    aria-label="Toggle voice input"
    aria-pressed={recording}
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill={recording ? "currentColor" : "none"} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
      <path d="M8 21h8" />
    </svg>
  </button>
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

  .mic-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: 1px solid #e5e5e5;
    border-radius: 8px;
    background: #fff;
    color: #666;
    cursor: pointer;
    flex-shrink: 0;
  }

  .mic-btn:hover:not(:disabled):not(.active) {
    background: #f5f5f5;
    color: #333;
  }

  .mic-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .mic-btn.active {
    background: #dc2626;
    border-color: #dc2626;
    color: #fff;
    animation: mic-pulse 1.4s ease-in-out infinite;
  }

  @keyframes mic-pulse {
    0%, 100% {
      box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.55);
    }
    50% {
      box-shadow: 0 0 0 6px rgba(220, 38, 38, 0);
    }
  }
</style>
