import { writable } from "svelte/store";

export interface Toast {
  id: number;
  message: string;
  type: "info" | "error" | "success";
}

let toastCounter = 0;

export const toasts = writable<Toast[]>([]);
export const settingsOpen = writable(false);
export const confirmDialog = writable<{
  message: string;
  onConfirm: () => void;
} | null>(null);

export function showToast(
  message: string,
  type: "info" | "error" | "success" = "info",
  duration = 4000,
) {
  const id = ++toastCounter;
  toasts.update((t) => [...t, { id, message, type }]);
  setTimeout(() => {
    toasts.update((t) => t.filter((toast) => toast.id !== id));
  }, duration);
}
