import { writable, get } from "svelte/store";
import { getSessions } from "../api/client";
import { settings } from "./settings";

export type ConnectionStatus = "connected" | "disconnected" | "unknown";

export const connectionStatus = writable<ConnectionStatus>("unknown");

let pollInterval: ReturnType<typeof setInterval> | null = null;

async function checkConnection() {
  const s = get(settings);
  if (!s.apiUrl) {
    connectionStatus.set("disconnected");
    return;
  }
  try {
    await getSessions(s.apiUrl, s.apiKey);
    connectionStatus.set("connected");
  } catch {
    connectionStatus.set("disconnected");
  }
}

export function startConnectionPolling() {
  checkConnection();
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(checkConnection, 15000);
}

export function stopConnectionPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

export function checkNow() {
  checkConnection();
}
