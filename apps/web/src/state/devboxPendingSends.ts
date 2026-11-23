import type { DevboxSendWait } from "./devboxes";

/** A message still waiting on its devbox, as kept across a restart of this client. */
export interface PendingDevboxSend {
  readonly draftId: string | null;
  readonly title: string;
  readonly text: string;
  readonly createdAt: string;
}

const STORAGE_KEY = "t3code:devbox-pending-sends";

export function pendingDevboxSends(
  waits: ReadonlyMap<string, DevboxSendWait>,
): ReadonlyArray<PendingDevboxSend> {
  return [...waits.values()].map((wait) => ({
    draftId: wait.draftId,
    title: wait.title,
    text: wait.message.text,
    createdAt: wait.createdAt,
  }));
}

export function parsePendingDevboxSends(raw: string | null): ReadonlyArray<PendingDevboxSend> {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is PendingDevboxSend =>
        typeof entry === "object" &&
        entry !== null &&
        (entry.draftId === null || typeof entry.draftId === "string") &&
        typeof entry.title === "string" &&
        typeof entry.text === "string" &&
        typeof entry.createdAt === "string",
    );
  } catch {
    return [];
  }
}

export function savePendingDevboxSends(sends: ReadonlyArray<PendingDevboxSend>) {
  try {
    if (sends.length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(sends));
  } catch {
    // Storage can be unavailable; the waits still work, they just do not survive a restart.
  }
}

/** Sends a previous run of this client left waiting; reading them clears them. */
export function takePendingDevboxSends(): ReadonlyArray<PendingDevboxSend> {
  try {
    const sends = parsePendingDevboxSends(localStorage.getItem(STORAGE_KEY));
    localStorage.removeItem(STORAGE_KEY);
    return sends;
  } catch {
    return [];
  }
}
