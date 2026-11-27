import { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import { createDevboxClaims, isDraftAwaitingNewDevbox } from "./devboxClaims";

it("keeps claims and startup completion on the draft that requested them", async () => {
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const claims = createDevboxClaims();
  claims.set(registry, "first", { kind: "preparing", submitted: true });
  claims.set(registry, "second", { kind: "preparing", submitted: false });
  const first = claims.wait(registry, "first");
  const second = claims.wait(registry, "second");
  expect(registry.get(claims.stateAtom("another-chat"))).toEqual({ kind: "idle" });
  expect(registry.get(claims.stateAtom(null))).toEqual({ kind: "idle" });
  claims.set(registry, "second", { kind: "failed", error: "Sign-in required" });
  await expect(second).rejects.toThrow("Sign-in required");
  expect(registry.get(claims.stateAtom("first"))).toEqual({ kind: "preparing", submitted: true });
  const ready = {
    kind: "ready" as const,
    environmentId: EnvironmentId.make("devbox"),
    name: "new-devbox",
    submitted: true,
  };
  claims.set(registry, "first", ready);
  await expect(first).resolves.toEqual(ready);
  claims.set(registry, "first", { kind: "idle" });
  expect(registry.get(claims.claimsAtom).has("first")).toBe(false);
  expect(registry.get(claims.stateAtom("second"))).toEqual({
    kind: "failed",
    error: "Sign-in required",
  });
});

it("identifies drafts awaiting a new devbox until they switch to its environment", () => {
  const local = EnvironmentId.make("local");
  const devbox = EnvironmentId.make("devbox");
  expect(isDraftAwaitingNewDevbox({ kind: "idle" }, local)).toBe(false);
  expect(isDraftAwaitingNewDevbox({ kind: "preparing", submitted: false }, local)).toBe(true);
  expect(isDraftAwaitingNewDevbox({ kind: "failed", error: "Could not prepare" }, local)).toBe(
    true,
  );
  expect(
    isDraftAwaitingNewDevbox(
      { kind: "ready", environmentId: devbox, name: "box", submitted: false },
      local,
    ),
  ).toBe(true);
  expect(
    isDraftAwaitingNewDevbox(
      { kind: "ready", environmentId: devbox, name: "box", submitted: false },
      devbox,
    ),
  ).toBe(false);
  expect(
    isDraftAwaitingNewDevbox(
      { kind: "switched", environmentId: devbox, name: "box", submitted: false },
      devbox,
    ),
  ).toBe(false);
});
