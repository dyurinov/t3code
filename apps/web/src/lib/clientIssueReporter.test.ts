import { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentRegistry as EnvironmentRegistryModule } from "@t3tools/client-runtime/connection";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, vi } from "vite-plus/test";

const key = "t3code:pending-client-issues";

function setup() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => {
      values.set(name, value);
    },
    removeItem: (name: string) => {
      values.delete(name);
    },
  };
  vi.stubGlobal("window", {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    sessionStorage: storage,
    location: { pathname: "/", hash: "#/viewed-host/thread" },
  });
  return { storage, [Symbol.dispose]: () => vi.unstubAllGlobals() };
}

async function reloadReporter() {
  vi.resetModules();
  return import("./clientIssueReporter");
}

describe("client issue persistence", () => {
  it("keeps unsent reports and their host attribution across reloads", async () => {
    using browser = setup();
    const first = await reloadReporter();
    first.recordClientIssue({
      level: "warning",
      source: "toast",
      title: "Remote host froze",
      environmentId: EnvironmentId.make("frozen-host"),
    });

    const reloaded = await reloadReporter();
    reloaded.recordClientIssue({ level: "error", source: "window-error", title: "After reload" });

    expect(JSON.parse(browser.storage.getItem(key) ?? "[]")).toMatchObject([
      { title: "Remote host froze", environmentId: "frozen-host", route: "/#/viewed-host/thread" },
      { title: "After reload" },
    ]);
  });

  it.each(["invalid JSON", "[null,{}]"])("discards invalid stored reports: %s", async (stored) => {
    using browser = setup();
    browser.storage.setItem(key, stored);
    const reporter = await reloadReporter();
    reporter.recordClientIssue({ level: "error", source: "window-error", title: "New error" });
    expect(JSON.parse(browser.storage.getItem(key) ?? "[]")).toMatchObject([
      { title: "New error" },
    ]);
  });

  it("bounds the restored backlog and keeps the newest reports", async () => {
    using browser = setup();
    const reporter = await reloadReporter();
    for (let index = 0; index < 201; index++) {
      reporter.recordClientIssue({ level: "error", source: "toast", title: String(index) });
    }
    const restored = await reloadReporter();
    restored.recordClientIssue({ level: "error", source: "toast", title: "latest" });
    const reports = JSON.parse(browser.storage.getItem(key) ?? "[]");
    expect(reports).toHaveLength(200);
    expect(reports[0]).toMatchObject({ title: "2" });
    expect(reports[199]).toMatchObject({ title: "latest" });
  });

  it.effect("removes acknowledged reports and retries unsent ones after a reload", () =>
    Effect.gen(function* () {
      using browser = setup();
      const reporter = yield* Effect.promise(reloadReporter);
      const { EnvironmentRegistry } = yield* Effect.promise(
        () => import("@t3tools/client-runtime/connection"),
      );
      const entries = yield* SubscriptionRef.make(
        new Map([
          [EnvironmentId.make("primary-host"), { target: { _tag: "PrimaryConnectionTarget" } }],
        ]),
      );
      const registry = (run: () => Effect.Effect<void, "offline">) =>
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
          entries,
          run,
        } as unknown as EnvironmentRegistryModule.EnvironmentRegistry["Service"]);
      reporter.recordClientIssue({ level: "error", source: "toast", title: "Delivered" });
      reporter.recordClientIssue({ level: "error", source: "toast", title: "Retry me" });
      let attempts = 0;
      yield* Layer.build(
        reporter.layer.pipe(
          Layer.provide(
            registry(() => {
              attempts++;
              return attempts === 1 ? Effect.void : Effect.fail("offline" as const);
            }),
          ),
        ),
      ).pipe(Effect.andThen(TestClock.adjust("1 second")), Effect.scoped);
      expect(attempts).toBe(2);
      expect(JSON.parse(browser.storage.getItem(key) ?? "[]")).toMatchObject([
        { title: "Retry me" },
      ]);

      const reloaded = yield* Effect.promise(reloadReporter);
      let retried = 0;
      yield* Layer.build(
        reloaded.layer.pipe(
          Layer.provide(
            registry(() => {
              retried++;
              return Effect.void;
            }),
          ),
        ),
      ).pipe(Effect.andThen(TestClock.adjust("1 second")), Effect.scoped);
      expect(retried).toBe(1);
      expect(browser.storage.getItem(key)).toBeNull();
    }),
  );
});
