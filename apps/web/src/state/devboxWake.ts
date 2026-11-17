import type { DevboxSummary } from "@t3tools/contracts";

/**
 * Follows a send's wake across polls of the host's list, which can still say `failed` from an
 * earlier attempt until it sees this wake. `failed` counts only after the box was seen otherwise.
 */
export function followDevboxWake(
  woke: boolean,
  devbox: Pick<DevboxSummary, "name" | "state" | "lastError"> | null,
): { readonly woke: boolean; readonly failure: string | null } {
  if (devbox === null) return { woke, failure: null };
  if (devbox.state !== "failed") return { woke: true, failure: null };
  return {
    woke,
    failure: woke ? `${devbox.name} did not start: ${devbox.lastError ?? "unknown error"}` : null,
  };
}
