import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Coder devboxes the host environment creates and links, one task per box. */
export function createDevboxEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:devboxes:list",
    tag: WS_METHODS.devboxesList,
    // Listing asks Coder for every box's state; creating and waking poll it.
    staleTimeMs: 3_000,
  });
  return {
    list,
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:devboxes:create",
      tag: WS_METHODS.devboxesCreate,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
    wake: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:devboxes:wake",
      tag: WS_METHODS.devboxesWake,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.name}`,
      },
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:devboxes:stop",
      tag: WS_METHODS.devboxesStop,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:devboxes:delete",
      tag: WS_METHODS.devboxesDelete,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
    // Takes a prepared box: can take minutes when it has to wake or none is ready.
    claim: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:devboxes:claim",
      tag: WS_METHODS.devboxesClaim,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
    startLogin: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:devboxes:start-login",
      tag: WS_METHODS.devboxesStartLogin,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
    submitLoginCode: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:devboxes:submit-login-code",
      tag: WS_METHODS.devboxesSubmitLoginCode,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
    pairClient: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:devboxes:pair-client",
      tag: WS_METHODS.devboxesPairClient,
    }),
  };
}
