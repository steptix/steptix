import { writable } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";

export interface Settings {
  apiUrl: string;
  apiKey: string;
  defaultBaseUrl: string;
  defaultTimeout: string;
}

const defaults: Settings = {
  apiUrl: "http://127.0.0.1:3100",
  apiKey: "",
  defaultBaseUrl: "",
  defaultTimeout: "",
};

export const settings = writable<Settings>(defaults);

export async function loadSettings() {
  const s = await invoke<Settings>("read_settings");
  settings.set(s);
}

export async function saveSettings(s: Settings) {
  await invoke("write_settings", { settings: s });
  settings.set(s);
}
