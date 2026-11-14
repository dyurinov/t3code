import { createDevboxEnvironmentAtoms } from "@t3tools/client-runtime/state/devboxes";
import type { DevboxSummary, EnvironmentId } from "@t3tools/contracts";
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

export const devboxClaimAtom = Atom.make<DevboxClaimState>({ kind: "idle" }).pipe(
  Atom.keepAlive,
  Atom.withLabel("devboxes:claim"),
);
