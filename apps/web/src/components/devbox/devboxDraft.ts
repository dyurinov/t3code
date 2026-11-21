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
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

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
  const provider =
    config.providers.find(
      (entry) => entry.instanceId === input.selection.instanceId && entry.driver === input.driver,
    ) ?? config.providers.find((entry) => entry.driver === input.driver);
  if (
    !provider?.enabled ||
    !provider.installed ||
    provider.status === "error" ||
    provider.auth.status === "unauthenticated" ||
    provider.availability === "unavailable"
  )
    throw new Error(
      t(
        "Sign in to {provider} in Settings → Devboxes, or to Formal on the box, then retry this draft.",
        {
          provider: provider?.displayName || PROVIDER_DISPLAY_NAMES[input.driver] || input.driver,
        },
      ),
    );
  let project: EnvironmentProject | undefined;
  if (input.project.isScratch) {
    const opened = await projectEnvironment.openScratch.run(appAtomRegistry, {
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
