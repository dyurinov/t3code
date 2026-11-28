import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  USAGE_CONTRACT_VERSION,
} from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  mutateProviderInstance: vi.fn(),
  useUsage: vi.fn<typeof import("../../state/usage").useUsage>(),
  config: null as unknown,
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: (() => state.config) as never,
      mutateProviderInstance: "mutateProviderInstance" as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: "mutateProviderInstance") => state[command]) as never,
}));

vi.mock(import("../../state/usage"), () => ({ useUsage: state.useUsage }));
vi.mock(import("./usagePagePreferences"), () => ({
  readUsagePagePreferences: () => ({ metric: "cost", windowDays: 30 }),
  saveUsagePagePreferences: () => undefined,
}));

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { UsageAccessQuestion, type UsageAccessPrompt } from "./UsageAccessDialog";
import { UsagePage } from "./UsagePage";
import type { EnvironmentUsageStatus } from "../../state/usage";

const environmentId = EnvironmentId.make("primary");
const prompt = (driver: string): UsageAccessPrompt => ({
  environmentId,
  environmentLabel: "cups",
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
});

it("says what each agent's access reads and saves only the agents left on", async () => {
  state.config = Atom.make({ settings: { providerInstances: {} } });
  state.mutateProviderInstance.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  await using screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <UsageAccessQuestion prompts={[prompt("claudeAgent"), prompt("codex")]} />
    </RegistryContext.Provider>,
  );
  await expect.element(screen.getByText("Session history and sign-in")).toBeVisible();
  await expect.element(screen.getByText("Session history", { exact: true })).toBeVisible();

  await screen.getByRole("switch", { name: /Codex/ }).click();
  await screen.getByRole("button", { name: "Allow", exact: true }).click();
  await vi.waitFor(() => expect(state.mutateProviderInstance).toHaveBeenCalledTimes(2));

  const saved = state.mutateProviderInstance.mock.calls.map(
    ([call]) => call.input.providerInstanceMutation.instance,
  );
  expect(saved).toEqual([
    { driver: "claudeAgent", usageAccess: "allowed" },
    { driver: "codex", usageAccess: "denied" },
  ]);
});

it("keeps Devbox usage available while provider usage access is unanswered", async () => {
  state.config = Atom.make({ settings: { providerInstances: {} } });
  const { environmentId, environmentLabel, instanceId, driver } = prompt("codex");
  const environment: EnvironmentUsageStatus = {
    environmentId,
    label: environmentLabel,
    canReadDiagnostics: true,
    accessRequests: [{ instanceId, driver, provider: "codex", paths: [] }],
    isConnected: true,
    isPending: false,
    error: null,
    summary: null,
  };
  state.useUsage.mockReset().mockReturnValue({
    environments: [environment],
    selectedEnvironments: [environment],
    merged: mergeUsage([], USAGE_CONTRACT_VERSION),
    isPending: false,
    isPartial: false,
    shown: null,
    refresh: async () => {},
  });

  await using _screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <UsagePage />
    </RegistryContext.Provider>,
    { router: "/usage" },
  );
  const consent = page.getByRole("heading", { name: "Show agent usage?" });
  await expect.element(consent).toBeVisible();

  await userEvent.keyboard("d");
  await expect
    .element(page.getByText("Devboxes need the Coder CLI, signed in, on this machine."))
    .toBeVisible();
  await expect.element(consent).not.toBeInTheDocument();

  await userEvent.keyboard("c");
  await expect.element(consent).toBeVisible();
});
