import { t } from "gt-react";
import {
  AuthOrchestrationOperateScope,
  PROVIDER_DISPLAY_NAMES,
  type ModelSelection,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";

import { getClientSettings } from "../../hooks/useSettings";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { devboxClaims } from "../../state/devboxes";
import { environmentProjects, projectEnvironment } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { environmentSession, readEnvironmentScope } from "../../state/session";
import { waitForAtomValue } from "../../state/waitForAtomValue";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

export async function prepareDevboxDraft(input: {
  readonly draftId: string;
  readonly project: EnvironmentProject;
  readonly selection: ModelSelection;
  readonly driver: ProviderDriverKind;
  readonly progress: (label: string) => void;
}) {
  const claim = await devboxClaims.wait(appAtomRegistry, input.draftId);
  const { environmentId, name } = claim;
  input.progress(t("Connecting {name}…", { name }));
  const configAtom = serverEnvironment.configValueAtom(environmentId);
  const connected = await waitForAtomValue({
    registry: appAtomRegistry,
    atom: environmentSession.sessionStateAtom(environmentId),
    predicate: () => readEnvironmentScope(environmentId, AuthOrchestrationOperateScope),
    timeoutMs: 90_000,
  });
  if (!connected) throw new Error(t("{name} did not connect in time.", { name }));
  const configured = await waitForAtomValue({
    registry: appAtomRegistry,
    atom: configAtom,
    predicate: (config) => config !== null,
    timeoutMs: 90_000,
  });
  const config = appAtomRegistry.get(configAtom);
  if (!configured || !config) throw new Error(t("{name} did not finish loading.", { name }));
  const findProvider = (current: typeof config) =>
    current.providers.find(
      (entry) => entry.instanceId === input.selection.instanceId && entry.driver === input.driver,
    ) ?? current.providers.find((entry) => entry.driver === input.driver);
  const usable = (
    entry: ReturnType<typeof findProvider>,
  ): entry is NonNullable<ReturnType<typeof findProvider>> =>
    entry !== undefined &&
    entry.enabled &&
    entry.installed &&
    entry.status !== "error" &&
    entry.auth.status !== "unauthenticated" &&
    entry.availability !== "unavailable";
  let provider = findProvider(config);
  if (!usable(provider)) {
    // The box checked its providers when it booted; the host may have installed a fresh
    // token since, which leaves its credential state "installed" and triggers no re-check.
    await runAtomCommand(appAtomRegistry, serverEnvironment.refreshProviders, {
      environmentId,
      input: { refreshModels: false },
    });
    await waitForAtomValue({
      registry: appAtomRegistry,
      atom: configAtom,
      predicate: (current) => current !== null && usable(findProvider(current)),
      timeoutMs: 20_000,
    });
    const refreshed = appAtomRegistry.get(configAtom);
    provider = refreshed === null ? provider : findProvider(refreshed);
  }
  if (!usable(provider))
    throw new Error(
      t(
        "Sign in to {provider} in Settings → Devboxes, or to Formal on the box, then retry this draft.",
        {
          provider:
            findProvider(config)?.displayName ||
            PROVIDER_DISPLAY_NAMES[input.driver] ||
            input.driver,
        },
      ),
    );
  let project: EnvironmentProject | undefined;
  if (input.project.isScratch) {
    const opened = await runAtomCommand(appAtomRegistry, projectEnvironment.openScratch, {
      environmentId,
      input: {},
    });
    if (opened._tag !== "Success") throw squashAtomCommandFailure(opened);
    project = opened.value;
  } else {
    const settings = selectProjectGroupingSettings(getClientSettings());
    const key = deriveLogicalProjectKeyFromSettings(input.project, settings);
    const found = await waitForAtomValue({
      registry: appAtomRegistry,
      atom: environmentProjects.projectsAtom,
      predicate: (projects) => {
        project = projects.find(
          (candidate) =>
            candidate.environmentId === environmentId &&
            deriveLogicalProjectKeyFromSettings(candidate, settings) === key,
        );
        return project !== undefined;
      },
      timeoutMs: 90_000,
    });
    if (!found || !project)
      throw new Error(t("This project is not available on {name}.", { name }));
  }
  input.progress(t("Starting on {name}…", { name }));
  return {
    environmentId,
    project,
    selection: { ...input.selection, instanceId: provider.instanceId },
  };
}
