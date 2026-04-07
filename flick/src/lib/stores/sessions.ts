import { writable, derived, get } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import { generateGuid } from "../utils/guid";

export interface SessionMeta {
  id: string;
  name: string;
  tabOrder: number;
  firstRequestSent: boolean;
}

export const sessions = writable<SessionMeta[]>([]);
export const activeSessionId = writable<string | null>(null);
export const staleSessions = writable<Set<string>>(new Set());

export const activeSession = derived(
  [sessions, activeSessionId],
  ([$sessions, $activeId]) => $sessions.find((s) => s.id === $activeId) ?? null,
);

export const sortedSessions = derived(sessions, ($sessions) =>
  [...$sessions].sort((a, b) => a.tabOrder - b.tabOrder),
);

export async function loadSessions() {
  const list = await invoke<SessionMeta[]>("read_sessions");
  sessions.set(list);
  if (list.length > 0) {
    activeSessionId.set(list[0].id);
  }
}

async function persistSessions() {
  const list = get(sessions);
  await invoke("write_sessions", { sessions: list });
}

export async function createSession(): Promise<string> {
  const id = generateGuid();
  const list = get(sessions);
  const session: SessionMeta = {
    id,
    name: "New Session",
    tabOrder: list.length,
    firstRequestSent: false,
  };
  sessions.update((s) => [...s, session]);
  activeSessionId.set(id);
  await persistSessions();
  return id;
}

export async function deleteSession(id: string) {
  await invoke("delete_session_data", { sessionId: id });
  sessions.update((s) => s.filter((sess) => sess.id !== id));

  const list = get(sessions);
  const currentActive = get(activeSessionId);
  if (currentActive === id) {
    activeSessionId.set(list.length > 0 ? list[0].id : null);
  }

  staleSessions.update((set) => {
    set.delete(id);
    return new Set(set);
  });

  await persistSessions();
}

export async function renameSession(id: string, name: string) {
  sessions.update((s) =>
    s.map((sess) => (sess.id === id ? { ...sess, name } : sess)),
  );
  await persistSessions();
}

export async function markFirstRequestSent(id: string) {
  sessions.update((s) =>
    s.map((sess) =>
      sess.id === id ? { ...sess, firstRequestSent: true } : sess,
    ),
  );
  await persistSessions();
}

export function markStale(id: string) {
  staleSessions.update((set) => {
    set.add(id);
    return new Set(set);
  });
}

export function clearStale(id: string) {
  staleSessions.update((set) => {
    set.delete(id);
    return new Set(set);
  });
}
