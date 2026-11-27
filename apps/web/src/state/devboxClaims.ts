import { t } from "gt-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { waitForAtomValue } from "./waitForAtomValue";

export type DevboxClaimState =
  | { readonly kind: "idle" }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "preparing"; readonly submitted: boolean }
  | {
      readonly kind: "ready" | "switched";
      readonly environmentId: EnvironmentId;
      readonly name: string;
      readonly submitted: boolean;
    };

const idle: DevboxClaimState = { kind: "idle" };

/** Whether a draft targets a new devbox rather than its current environment. */
export function isDraftAwaitingNewDevbox(
  claim: DevboxClaimState,
  environmentId: EnvironmentId,
): boolean {
  return (
    claim.kind === "preparing" ||
    claim.kind === "failed" ||
    (claim.kind === "ready" && claim.environmentId !== environmentId)
  );
}

export function createDevboxClaims() {
  const claimsAtom = Atom.make<ReadonlyMap<string, DevboxClaimState>>(new Map()).pipe(
    Atom.keepAlive,
  );
  const stateAtom = Atom.family((draftId: string | null) =>
    Atom.make((get) => (draftId === null ? idle : (get(claimsAtom).get(draftId) ?? idle))),
  );
  const set = (
    registry: AtomRegistry.AtomRegistry,
    draftId: string,
    change: DevboxClaimState | ((current: DevboxClaimState) => DevboxClaimState),
  ) => {
    registry.update(claimsAtom, (claims) => {
      const next = new Map(claims);
      const value = typeof change === "function" ? change(claims.get(draftId) ?? idle) : change;
      if (value.kind === "idle") next.delete(draftId);
      else next.set(draftId, value);
      return next;
    });
  };
  const wait = async (registry: AtomRegistry.AtomRegistry, draftId: string) => {
    const finished = await waitForAtomValue({
      registry,
      atom: stateAtom(draftId),
      predicate: (value) => value.kind !== "preparing",
      timeoutMs: 10 * 60_000,
    });
    if (!finished) throw new Error(t("Devbox setup did not finish in time."));
    const claim = registry.get(stateAtom(draftId));
    if (claim.kind === "failed") throw new Error(claim.error);
    if (claim.kind === "idle" || claim.kind === "preparing")
      throw new Error(t("Devbox setup was cancelled."));
    return claim;
  };
  return { claimsAtom, stateAtom, set, wait };
}
