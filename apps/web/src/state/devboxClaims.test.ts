import { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import { createDevboxClaims } from "./devboxClaims";

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
