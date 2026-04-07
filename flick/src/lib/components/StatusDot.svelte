<script lang="ts">
  import { connectionStatus } from "../stores/connection";
</script>

<span
  class="status-dot"
  class:connected={$connectionStatus === "connected"}
  class:disconnected={$connectionStatus === "disconnected"}
  title={$connectionStatus === "connected"
    ? "Connected to server"
    : $connectionStatus === "disconnected"
      ? "Cannot connect to server"
      : "Checking connection..."}
></span>

<style>
  .status-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #999;
    flex-shrink: 0;
  }

  .status-dot.connected {
    background: #16a34a;
  }

  .status-dot.disconnected {
    background: #dc2626;
  }
</style>
