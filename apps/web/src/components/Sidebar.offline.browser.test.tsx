import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import { threadEnvironment } from "~/state/threads";
import { appAtomRegistry } from "~/rpc/atomRegistry";

const transport = vi.hoisted(() => ({ offline: false, close: () => {} }));

import { AppRoot } from "~/AppRoot";
// The thread route loads ChatView lazily; its first transform would eat the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  dispatchedCommands,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return {
    ...actual,
    layer: Layer.succeed(actual.ConnectionDriver, {
      ...fakeDriver,
      connect: (entry: Parameters<typeof fakeDriver.connect>[0]) =>
        Effect.gen(function* () {
          if (transport.offline) return yield* Effect.never;
          const lease = yield* fakeDriver.connect(entry);
          const closed = yield* Deferred.make<never, ConnectionTransientError>();
          transport.close = () => {
            transport.offline = true;
            Deferred.doneUnsafe(
              closed,
              Effect.fail(
                new ConnectionTransientError({ reason: "transport", detail: "Devbox is sleeping" }),
              ),
            );
          };
          return { ...lease, session: { ...lease.session, closed: Deferred.await(closed) } };
        }),
    }),
  };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("snoozes and settles cached threads while their environment sleeps", async () => {
  await page.viewport(1400, 900);
  const target = threadWithHistory("sleeping-devbox-work", 1);
  const other = threadWithHistory("other-work", 1);
  using _environment = installFakeEnvironment([target, other]);
  const key = `t3code:offline-thread-actions:${ENVIRONMENT_ID}`;
  const prior = localStorage.getItem(key);
  localStorage.removeItem(key);
  using _restore = {
    [Symbol.dispose]: () => {
      transport.offline = false;
      if (prior === null) localStorage.removeItem(key);
      else localStorage.setItem(key, prior);
    },
  };
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    boringSidebarEnabled: true,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${other.id}`] }),
  );
  await router.load();
  await using screen = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const row = screen.getByTestId("sidebar-row-folder").filter({ hasText: target.title });
  await expect.element(row).toBeInTheDocument();
  await act(() => transport.close());
  await vi.waitFor(() =>
    expect(appAtomRegistry.get(threadEnvironment.offlineAtom(ENVIRONMENT_ID))).toBe(true),
  );
  await userEvent.click(row, { button: "right" });
  await userEvent.hover(page.getByRole("menuitem", { name: "Snooze", exact: true }));
  await userEvent.click(page.getByRole("menuitem", { name: /In 1 hour/ }));
  await expect.element(screen.getByText("Snoozed", { exact: true }).first()).toBeVisible();
  await vi.waitFor(() =>
    expect(JSON.parse(localStorage.getItem(key) ?? "[]")).toEqual([
      expect.objectContaining({ kind: "snooze", threadId: target.id }),
    ]),
  );
  expect(
    dispatchedCommands().filter((command) =>
      ["thread.snooze", "thread.unsnooze", "thread.settle", "thread.unsettle"].includes(
        command.type,
      ),
    ),
  ).toEqual([]);
  await userEvent.click(page.getByRole("button", { name: /undo/i }));
  await expect.element(row).toBeInTheDocument();
  await userEvent.click(row.getByRole("button", { name: "Settle thread" }));
  await expect.element(screen.getByText("Settled", { exact: true }).first()).toBeVisible();
  await vi.waitFor(() =>
    expect(JSON.parse(localStorage.getItem(key) ?? "[]")).toEqual([
      expect.objectContaining({ kind: "snooze" }),
      expect.objectContaining({ kind: "unsnooze" }),
      expect.objectContaining({ kind: "settle" }),
    ]),
  );
  expect(
    dispatchedCommands().filter((command) =>
      ["thread.snooze", "thread.unsnooze", "thread.settle", "thread.unsettle"].includes(
        command.type,
      ),
    ),
  ).toEqual([]);
});
