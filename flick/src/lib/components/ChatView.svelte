<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { get } from "svelte/store";
  import {
    activeSessionId,
    activeSession,
    markFirstRequestSent,
    markStale,
    clearStale,
  } from "../stores/sessions";
  import { settings } from "../stores/settings";
  import { connectionStatus } from "../stores/connection";
  import { showToast } from "../stores/ui";
  import { postSteps, getSession } from "../api/client";
  import { parseSteps } from "../services/step-parser";
  import UserMessageCard from "./UserMessageCard.svelte";
  import ResultCard from "./ResultCard.svelte";
  import StaleBanner from "./StaleBanner.svelte";
  import InputBox from "./InputBox.svelte";
  import type { StepResponse } from "../api/types";

  interface ChatEntry {
    type: "userMessage" | "resultMessage" | "errorMessage";
    text?: string;
    result?: BatchResult;
    message?: string;
    timestamp: string;
  }

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

  let entries: ChatEntry[] = $state([]);
  let loading = $state(false);
  let scrollContainer: HTMLDivElement | undefined = $state();
  let hasExpanded = false;

  $effect(() => {
    const id = $activeSessionId;
    if (id) {
      loadHistory(id);
      checkStale(id);
    } else {
      entries = [];
    }
  });

  async function loadHistory(sessionId: string) {
    try {
      const data = await invoke<ChatEntry[]>("read_history", { sessionId });
      entries = data;
      scrollToBottom();
    } catch {
      entries = [];
    }
  }

  async function checkStale(sessionId: string) {
    const s = get(settings);
    if (!s.apiUrl) return;
    try {
      await getSession(s.apiUrl, s.apiKey, sessionId);
      clearStale(sessionId);
    } catch (e) {
      if (e instanceof Error && e.message.includes("not found")) {
        markStale(sessionId);
      }
    }
  }

  async function saveHistory(sessionId: string) {
    try {
      await invoke("write_history", { sessionId, entries });
    } catch {
      // ignore save errors
    }
  }

  function scrollToBottom() {
    setTimeout(() => {
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }
    }, 50);
  }

  async function expandWindow() {
    if (hasExpanded) return;
    hasExpanded = true;
    try {
      const monitor = await (
        await import("@tauri-apps/api/window")
      ).getCurrentWindow().currentMonitor();
      if (monitor) {
        const targetHeight = Math.floor(monitor.size.height * 0.85);
        await invoke("animate_expand", { targetHeight });
      }
    } catch {
      // ignore window errors in dev
    }
  }

  async function handleSubmit(text: string) {
    const session = get(activeSession);
    if (!session) return;

    const connStatus = get(connectionStatus);
    if (connStatus === "disconnected") {
      showToast(
        "Cannot reach the API server. Check your connection and settings.",
        "error",
      );
      return;
    }

    const steps = parseSteps(text);
    if (steps.length === 0) return;

    const userEntry: ChatEntry = {
      type: "userMessage",
      text,
      timestamp: new Date().toISOString(),
    };
    entries = [...entries, userEntry];
    scrollToBottom();

    loading = true;

    try {
      const s = get(settings);
      let config: { baseUrl?: string; timeout?: string } | undefined;
      if (!session.firstRequestSent) {
        if (s.defaultBaseUrl || s.defaultTimeout) {
          config = {};
          if (s.defaultBaseUrl) config.baseUrl = s.defaultBaseUrl;
          if (s.defaultTimeout) config.timeout = s.defaultTimeout;
        }
        markFirstRequestSent(session.id);
      }

      clearStale(session.id);

      const response: StepResponse = await postSteps(
        s.apiUrl,
        s.apiKey,
        session.id,
        steps,
        config,
      );

      const processedResults: StepResult[] = [];
      for (let i = 0; i < response.results.length; i++) {
        const r = response.results[i];
        let screenshotFile: string | null = null;
        if (r.screenshot) {
          try {
            screenshotFile = await invoke<string>("save_screenshot", {
              sessionId: session.id,
              stepIndex: i,
              base64Data: r.screenshot,
            });
          } catch {
            // ignore screenshot save errors
          }
        }
        processedResults.push({
          step: r.step,
          status: r.status,
          actions: r.actions,
          screenshotFile,
          reasoning: r.reasoning,
          outputs: r.outputs,
        });
      }

      const resultEntry: ChatEntry = {
        type: "resultMessage",
        result: {
          status: response.status,
          stepsCompleted: response.stepsCompleted,
          stepsTotal: response.stepsTotal,
          results: processedResults,
          outputs: response.outputs,
          error: response.error,
        },
        timestamp: new Date().toISOString(),
      };

      entries = [...entries, resultEntry];
      await expandWindow();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      const errorEntry: ChatEntry = {
        type: "errorMessage",
        message: msg,
        timestamp: new Date().toISOString(),
      };
      entries = [...entries, errorEntry];
      showToast(msg, "error");
    } finally {
      loading = false;
      scrollToBottom();
      await saveHistory(session.id);
    }
  }
</script>

<div class="chat-view">
  <StaleBanner />
  <div class="messages" bind:this={scrollContainer}>
    {#if entries.length === 0 && !loading}
      <div class="empty">
        <p>Type a step below to get started.</p>
      </div>
    {/if}

    {#each entries as entry}
      {#if entry.type === "userMessage" && entry.text}
        <UserMessageCard text={entry.text} timestamp={entry.timestamp} />
      {:else if entry.type === "resultMessage" && entry.result}
        <ResultCard
          result={entry.result}
          sessionId={$activeSessionId ?? ""}
          timestamp={entry.timestamp}
        />
      {:else if entry.type === "errorMessage"}
        <div class="error-entry">
          <span class="error-text">{entry.message}</span>
          <span class="time"
            >{new Date(entry.timestamp).toLocaleTimeString()}</span
          >
        </div>
      {/if}
    {/each}

    {#if loading}
      <div class="spinner-wrap">
        <div class="spinner"></div>
      </div>
    {/if}
  </div>

  <InputBox onsubmit={handleSubmit} disabled={loading || !$activeSessionId} />
</div>

<style>
  .chat-view {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
  }

  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #999;
    font-size: 13px;
  }

  .empty p {
    margin: 0;
  }

  .error-entry {
    margin: 8px 12px;
    padding: 8px 12px;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 8px;
    max-width: 85%;
  }

  .error-text {
    font-size: 13px;
    color: #dc2626;
    display: block;
  }

  .time {
    font-size: 10px;
    color: #999;
    margin-top: 2px;
    display: block;
  }

  .spinner-wrap {
    display: flex;
    justify-content: center;
    padding: 16px;
  }

  .spinner {
    width: 24px;
    height: 24px;
    border: 3px solid #e5e5e5;
    border-top-color: #2563eb;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
