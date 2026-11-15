import { createDevboxEnvironmentAtoms } from "@t3tools/client-runtime/state/devboxes";
import type { DevboxLoginPool, DevboxSummary, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { usePrimaryEnvironmentId } from "./environments";
import { useEnvironmentQuery } from "./query";

export const devboxEnvironment = createDevboxEnvironmentAtoms(connectionAtomRuntime);

/** Devboxes live on the primary environment, which creates them and keeps their forwards. */
export function useDevboxes(): {
  readonly hostEnvironmentId: EnvironmentId | null;
  /** Whether the host can manage devboxes: its list answered, which needs the Coder CLI. */
  readonly available: boolean;
  readonly devboxes: ReadonlyArray<DevboxSummary>;
  readonly pools: ReadonlyArray<DevboxLoginPool>;
  readonly refresh: () => void;
} {
  const hostEnvironmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    hostEnvironmentId === null
      ? null
      : devboxEnvironment.list({ environmentId: hostEnvironmentId, input: {} }),
  );
  return {
    hostEnvironmentId,
    available: query.data !== null,
    devboxes: query.data?.devboxes ?? [],
    pools: query.data?.pools ?? [],
    refresh: query.refresh,
  };
}

export function devboxForEnvironment(
  devboxes: ReadonlyArray<DevboxSummary>,
  environmentId: EnvironmentId | null,
): DevboxSummary | null {
  if (environmentId === null) return null;
  return devboxes.find((devbox) => devbox.environmentId === environmentId) ?? null;
}

/** What a devbox's row says instead of its connection health, or null once it runs. */
export function devboxStatusLabel(devbox: DevboxSummary): string | null {
  if (devbox.spare) return "Spare. New devbox takes it next.";
  switch (devbox.state) {
    case "running":
      return null;
    case "stopped":
      return "Sleeping. Wake it to use it here.";
    case "starting":
      return "Starting… This takes a few minutes.";
    case "stopping":
      return "Going to sleep…";
    case "creating":
      return "Being set up…";
    case "deleting":
      return "Deleting…";
    case "failed":
      return devbox.lastError ?? "Did not start.";
    case "missing":
      return "No longer exists in Coder.";
  }
}

/** Whether the environment is a devbox that is not running; sending to it wakes it. */
export function useDevboxAsleep(environmentId: EnvironmentId | null): boolean {
  const { devboxes } = useDevboxes();
  const state = devboxForEnvironment(devboxes, environmentId)?.state;
  return state !== undefined && state !== "running";
}

/**
 * This client taking a devbox for the draft: preparing (the host claims and wakes a box),
 * ready (paired; waiting for its project to load so the draft can move), then switched.
 * `queuedSend` holds a send pressed meanwhile, made once the draft is on the box.
 */
export type DevboxClaimState =
  | { readonly kind: "idle" }
  | { readonly kind: "preparing"; readonly queuedSend: boolean }
  | {
      readonly kind: "ready" | "switched";
      readonly environmentId: EnvironmentId;
      readonly name: string;
      readonly queuedSend: boolean;
    };

/**
 * Sends shown as sent while their devbox wakes, by `devboxSendKey`: what the working row says
 * until the box connects and the message goes out.
 */
export interface DevboxSendWait {
  /** What the working row says, such as "Waking shiny-pine…". */
  readonly label: string;
  readonly title: string;
  /** The draft the send started from; its thread does not exist on the box yet. */
  readonly draftId: string | null;
  /** `environmentId:projectId`. */
  readonly projectKey: string;
  readonly createdAt: string;
}

export const devboxSendWaitsAtom = Atom.make<ReadonlyMap<string, DevboxSendWait>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("devboxes:send-waits"),
);

export function devboxSendKey(environmentId: EnvironmentId, threadId: string): string {
  return `${environmentId}:${threadId}`;
}

export const devboxClaimAtom = Atom.make<DevboxClaimState>({ kind: "idle" }).pipe(
  Atom.keepAlive,
  Atom.withLabel("devboxes:claim"),
);
