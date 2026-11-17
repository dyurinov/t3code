import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ORCHESTRATION_V2_WS_METHODS, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { devboxClaims, devboxSendWaitsAtom } from "~/state/devboxes";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  answerRpc,
  dispatchedCommands,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { act, render } from "../../../test/render";

vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

class SetupFailure extends Schema.TaggedError<SetupFailure>()("SetupFailure", {}) {}

it("shows devbox creation in the sidebar and keeps sending after navigating to another chat", async () => {
  await page.viewport(1400, 900);
  const other = threadWithHistory("other-chat-during-devbox-creation", 1);
  using _environment = installFakeEnvironment([other], { acceptCommands: true });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    boringSidebarEnabled: true,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("devbox-submission");
  const threadId = ThreadId.make("devbox-thread");
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, { threadId });
  store.setPrompt(draftId, "Work on my new devbox");
  devboxClaims.set(appAtomRegistry, draftId, { kind: "preparing", submitted: false });
  using _claim = {
    [Symbol.dispose]: () => devboxClaims.set(appAtomRegistry, draftId, { kind: "idle" }),
  };
  const launches: Array<{ threadId: string; initialMessage: { text: string } }> = [];
  using _launch = answerRpc(
    ORCHESTRATION_V2_WS_METHODS.launchThread,
    (input: { threadId: string; initialMessage: { text: string } }) => {
      launches.push(input);
      return Effect.fail(new SetupFailure());
    },
  );
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using screen = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const editor = page.getByTestId("composer-editor");
  await expect.element(editor).toHaveTextContent("Work on my new devbox");
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();
  await userEvent.click(editor);
  await userEvent.keyboard("{Enter}");
  const row = screen.getByTestId("sidebar-devbox-send-row");
  await expect.element(row.getByText("Work on my new devbox", { exact: true })).toBeVisible();
  await expect.element(row.getByText("Setting up", { exact: true })).toBeVisible();
  await expect.element(row.getByText("Preparing devbox…", { exact: true })).toBeVisible();
  expect(screen.getByTestId("sidebar-draft-row").query()).toBeNull();
  expect(launches).toEqual([]);
  expect(page.getByText("Queued for the devbox").query()).toBeNull();

  await router.navigate({ to: `/${ENVIRONMENT_ID}/${other.id}` });
  await expect.element(page.getByText(`Answer 0 for ${other.id}.`)).toBeVisible();
  await userEvent.click(editor);
  await userEvent.keyboard("An independent message{Enter}");
  await vi.waitFor(() =>
    expect(dispatchedCommands()).toContainEqual(
      expect.objectContaining({
        type: "message.dispatch",
        threadId: other.id,
      }),
    ),
  );
  await expect.element(row).toBeVisible();
  await act(() =>
    devboxClaims.set(appAtomRegistry, draftId, {
      kind: "ready",
      environmentId: ENVIRONMENT_ID,
      name: "new-devbox",
      submitted: true,
    }),
  );
  await vi.waitFor(() => expect(launches).toHaveLength(1));
  expect(launches[0]).toMatchObject({
    threadId,
    initialMessage: { text: "Work on my new devbox" },
  });
  await vi.waitFor(() => expect(appAtomRegistry.get(devboxSendWaitsAtom).size).toBe(0));
  expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${other.id}`);
  expect(store.getComposerDraft(draftId)?.prompt).toBe("Work on my new devbox");
});
