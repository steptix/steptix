<script lang="ts">
  interface Props {
    text: string;
    timestamp: string;
  }

  let { text, timestamp }: Props = $props();
</script>

<div class="user-message">
  <div class="message-body">
    <pre>{text}</pre>
  </div>
  <span class="time">{new Date(timestamp).toLocaleTimeString()}</span>
</div>

<style>
  .user-message {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    margin: 8px 12px;
  }

  .message-body {
    background: #2563eb;
    color: #fff;
    padding: 8px 12px;
    border-radius: 12px 12px 2px 12px;
    max-width: 85%;
  }

  pre {
    margin: 0;
    font-family: inherit;
    font-size: 13px;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.4;
  }

  .time {
    font-size: 10px;
    color: #999;
    margin-top: 2px;
  }
</style>
