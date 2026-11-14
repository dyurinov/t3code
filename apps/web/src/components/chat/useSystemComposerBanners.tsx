import { useStableCallback } from "../../hooks/useStableCallback";
import { type EnvironmentId } from "@t3tools/contracts";
import { type EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { KeyRoundIcon, WifiOffIcon } from "lucide-react";
import { DevboxLoginActions } from "../devbox/DevboxLoginActions";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { environmentCatalog } from "../../connection/catalog";
import { ConnectionDiagnosisHeadline } from "../settings/ConnectionDiagnosisDetails";
import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import {
  useEnvironmentDisconnectDelay,
  useEnvironmentStateHeldFor,
} from "../../hooks/useEnvironmentDisconnectDelay";
import { serverEnvironment } from "../../state/server";
import { type EnvironmentPresentation } from "../../state/environments";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { ENVIRONMENT_RECONNECT_WARNING_GRACE_MS } from "../ChatView.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { ServerUpdateAction, serverUpdateStageLabel } from "../ServerUpdateAction";
import { useAutoBalanceUpdateBanner } from "./useAutoBalanceUpdateBanner";
import { devboxEnvironment, devboxForEnvironment, useDevboxes } from "../../state/devboxes";
import { ComposerServerUpdateIcon } from "./ComposerServerUpdateStatus";
import {
  dismissServerUpdateFailure,
  isServerUpdateFailureDismissed,
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
} from "../../versionSkew";

export type EnvironmentUnavailableState = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: EnvironmentConnectionPresentation;
};

interface SystemComposerBannersInput {
  readonly activeEnvironment: EnvironmentPresentation | null;
  readonly activeEnvironmentUnavailable: boolean;
  readonly activeEnvironmentUnavailableState: EnvironmentUnavailableState | null;
  readonly activeThreadEnvironmentId: EnvironmentId | null;
  readonly serverConfig: EnvironmentPresentation["serverConfig"] | null;
  readonly hasMultipleRegisteredEnvironments: boolean;
  readonly automaticEnvironment: boolean;
  readonly autoUpdateEnvironments: ReadonlyArray<EnvironmentPresentation>;
}

/**
 * The composer banners about the machine itself: offline or reconnecting,
 * a server update, and auto-balanced machines that need one.
 */
export function useSystemComposerBanners(input: SystemComposerBannersInput) {
  const {
    activeEnvironment,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableState,
    activeThreadEnvironmentId,
    serverConfig,
    hasMultipleRegisteredEnvironments,
    automaticEnvironment,
    autoUpdateEnvironments,
  } = input;
  const navigate = useNavigate();
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const setEnvironmentEnabled = useAtomCommand(environmentCatalog.setEnabled, {
    reportFailure: false,
  });
  const {
    hostEnvironmentId: devboxHostId,
    available: devboxesAvailable,
    devboxes,
    pendingLogins,
    refresh: refreshDevboxes,
  } = useDevboxes();
  // Sign-ins and box states change on the host with nothing pushed; poll faster while one waits.
  const devboxesBusy =
    pendingLogins.length > 0 ||
    devboxes.some((devbox) => devbox.state === "creating" || devbox.state === "starting");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls host-side devbox and sign-in state, which the server does not push.
  useEffect(() => {
    if (!devboxesAvailable) return;
    const timer = setInterval(refreshDevboxes, devboxesBusy ? 4_000 : 20_000);
    return () => clearInterval(timer);
  }, [devboxesAvailable, devboxesBusy, refreshDevboxes]);
  const wakeDevbox = useAtomCommand(devboxEnvironment.wake, { reportFailure: false });
  const [wakingDevbox, setWakingDevbox] = useState(false);
  const unavailableDevbox = devboxForEnvironment(
    devboxes,
    activeEnvironmentUnavailableState?.environmentId ?? null,
  );
  const handleWakeDevbox = async (name: string, environmentId: EnvironmentId) => {
    if (devboxHostId === null) return;
    setWakingDevbox(true);
    const woke = await wakeDevbox({ environmentId: devboxHostId, input: { name } });
    setWakingDevbox(false);
    if (woke._tag === "Failure") {
      if (!isAtomCommandInterrupted(woke)) {
        const error = squashAtomCommandFailure(woke);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not wake ${name}`,
            description: error instanceof Error ? error.message : "Waking failed.",
          }),
        );
      }
      return;
    }
    await retryEnvironment(environmentId);
  };
  const handleWakeDevboxStable = useStableCallback(handleWakeDevbox);
  const activeEnvironmentConnectionPhase = activeEnvironment?.connection.phase ?? "available";
  const activeReconnectingEnvironmentId =
    activeEnvironmentConnectionPhase === "connecting" ||
    activeEnvironmentConnectionPhase === "reconnecting"
      ? (activeEnvironment?.environmentId ?? null)
      : null;
  // Each reconnect attempt gets its own grace period, including a later one to
  // the same environment.
  const reconnectWarningGraceElapsed = useEnvironmentStateHeldFor(
    activeReconnectingEnvironmentId,
    ENVIRONMENT_RECONNECT_WARNING_GRACE_MS,
  );
  const handleReconnectActiveEnvironment = async (environmentId: EnvironmentId) => {
    // A retry does nothing while the environment is switched off.
    const result =
      activeEnvironment?.entry.enabled === false
        ? await setEnvironmentEnabled({ environmentId, enabled: true })
        : await retryEnvironment(environmentId);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not reconnect environment",
          description: error instanceof Error ? error.message : "Failed to reconnect.",
        }),
      );
    }
  };
  const handleReconnectActiveEnvironmentStable = useStableCallback(
    handleReconnectActiveEnvironment,
  );
  const disconnectDelayElapsed = useEnvironmentDisconnectDelay(
    activeEnvironmentUnavailable && activeEnvironment ? activeEnvironment.environmentId : null,
  );
  const canDisconnectActiveEnvironment =
    disconnectDelayElapsed &&
    activeEnvironment !== null &&
    activeEnvironment.entry.target._tag !== "PrimaryConnectionTarget" &&
    !isDesktopLocalConnectionTarget(activeEnvironment.entry.target);
  const [disconnectingEnvironment, setDisconnectingEnvironment] = useState(false);
  const handleDisconnectActiveEnvironment = async (environmentId: EnvironmentId) => {
    setDisconnectingEnvironment(true);
    const result = await setEnvironmentEnabled({ environmentId, enabled: false });
    setDisconnectingEnvironment(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not disconnect server",
            description: error instanceof Error ? error.message : "Failed to disconnect.",
          }),
        );
      }
      return;
    }
    void navigate({ to: "/", replace: true });
  };
  const handleDisconnectActiveEnvironmentStable = useStableCallback(
    handleDisconnectActiveEnvironment,
  );
  const autoBalanceUpdateBanner = useAutoBalanceUpdateBanner(autoUpdateEnvironments);
  const versionMismatch = resolveServerConfigVersionMismatch(serverConfig);
  const versionMismatchServerLabel =
    hasMultipleRegisteredEnvironments && activeThreadEnvironmentId !== null
      ? `${activeEnvironment?.label ?? serverConfig?.environment.label ?? activeThreadEnvironmentId} server`
      : "server";
  const serverUpdateEnvironmentId = activeThreadEnvironmentId;
  const versionMismatchSelfUpdate = resolveServerSelfUpdateCapability(serverConfig);
  const versionMismatchInstallation = serverConfig?.environment.capabilities.serverInstallation;
  const versionMismatchDesktopAppUpdate = supportsDesktopAppUpdate(serverConfig);
  const serverUpdateState = useAtomValue(
    serverEnvironment.updateStateAtom(serverUpdateEnvironmentId),
  );
  const [dismissedServerUpdateState, setDismissedServerUpdateState] = useState<
    typeof serverUpdateState | null
  >(null);
  const serverUpdateFailureDismissed =
    serverUpdateState === dismissedServerUpdateState ||
    isServerUpdateFailureDismissed(serverUpdateState);
  return (() => {
    const items: ComposerBannerStackItem[] = [];
    const updateRunning = serverUpdateState.status === "running";
    const unavailableConnection = activeEnvironmentUnavailableState?.connection ?? null;
    const disconnectAction =
      canDisconnectActiveEnvironment && activeEnvironmentUnavailableState ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={disconnectingEnvironment}
          title="Hide this server's threads. Switch it on again in Environments."
          onClick={() =>
            void handleDisconnectActiveEnvironmentStable(
              activeEnvironmentUnavailableState.environmentId,
            )
          }
        >
          Disconnect server
        </Button>
      ) : undefined;
    const environmentReconnecting =
      unavailableConnection !== null &&
      (unavailableConnection.phase === "connecting" ||
        unavailableConnection.phase === "reconnecting");
    const awaitingApproval = unavailableConnection?.awaitingApproval === true;
    const suppressUnavailableBanner =
      environmentReconnecting &&
      !awaitingApproval &&
      (updateRunning || !reconnectWarningGraceElapsed);
    const showUnavailableBanner =
      activeEnvironmentUnavailableState !== null &&
      unavailableConnection !== null &&
      !suppressUnavailableBanner;
    if (showUnavailableBanner) {
      items.push({
        id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
        variant: unavailableConnection.phase === "error" ? "error" : "warning",
        group: "environment",
        icon: <WifiOffIcon />,
        title:
          unavailableDevbox !== null && unavailableDevbox.state !== "running"
            ? `${unavailableDevbox.name} is ${wakingDevbox || unavailableDevbox.state === "starting" ? "waking up" : "sleeping"}`
            : awaitingApproval
              ? `${activeEnvironmentUnavailableState.label} is waiting to approve this device`
              : `${activeEnvironmentUnavailableState.label} is ${environmentReconnecting ? "reconnecting" : "offline"}`,
        description:
          unavailableDevbox !== null && unavailableDevbox.state !== "running" ? (
            "Wake it to continue. Starting a sleeping devbox takes about 2 minutes."
          ) : awaitingApproval ? (
            (unavailableConnection.error ?? undefined)
          ) : activeEnvironment ? (
            <ConnectionDiagnosisHeadline environment={activeEnvironment} />
          ) : undefined,
        actions: (
          <>
            {unavailableDevbox !== null && unavailableDevbox.state !== "running" ? (
              <Button
                size="xs"
                disabled={wakingDevbox || unavailableDevbox.state === "starting"}
                onClick={() =>
                  void handleWakeDevboxStable(
                    unavailableDevbox.name,
                    activeEnvironmentUnavailableState.environmentId,
                  )
                }
              >
                {wakingDevbox ? "Waking…" : "Wake devbox"}
              </Button>
            ) : null}
            {unavailableConnection.phase !== "connecting" ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  void handleReconnectActiveEnvironmentStable(
                    activeEnvironmentUnavailableState.environmentId,
                  )
                }
              >
                {environmentReconnecting ? "Retry now" : "Reconnect"}
              </Button>
            ) : null}
            {disconnectAction}
          </>
        ),
      });
    }
    for (const login of pendingLogins) {
      const providerName = login.provider === "codex" ? "Codex" : "Claude";
      items.push({
        id: `devbox-login:${login.provider}`,
        variant: "warning",
        group: "environment",
        icon: <KeyRoundIcon />,
        title: `${providerName} needs one sign-in for your devboxes`,
        description:
          login.provider === "claude"
            ? "Approve, then paste the code here."
            : "Approve it in the browser so new devboxes come signed in to Codex.",
        actions:
          devboxHostId === null ? undefined : (
            <DevboxLoginActions login={login} hostEnvironmentId={devboxHostId} />
          ),
      });
    }
    // An available update is offered by the sidebar's update pill; the composer only shows one
    // that is running or failed, since either explains what this thread's server is doing.
    if (
      !automaticEnvironment &&
      serverUpdateEnvironmentId &&
      serverUpdateState.status !== "idle" &&
      !serverUpdateFailureDismissed
    ) {
      const updateFailed = serverUpdateState.status === "failed";
      items.push({
        id: `server-version:${serverUpdateEnvironmentId}`,
        variant: updateFailed ? "error" : "default",
        group: "environment",
        icon: <ComposerServerUpdateIcon status={serverUpdateState.status} />,
        title: `${updateFailed ? "Could not update" : "Updating"} ${versionMismatchServerLabel}`,
        description:
          serverUpdateState.status === "failed"
            ? serverUpdateState.message
            : serverUpdateStageLabel(serverUpdateState.stage),
        actions: !updateFailed ? (
          disconnectAction
        ) : !versionMismatch ||
          (versionMismatchSelfUpdate === "desktop-managed" &&
            !versionMismatchDesktopAppUpdate) ? undefined : (
          <ServerUpdateAction
            environmentId={serverUpdateEnvironmentId}
            serverLabel={versionMismatchServerLabel}
            selfUpdate={versionMismatchSelfUpdate}
            installation={versionMismatchInstallation}
            desktopAppUpdate={versionMismatchDesktopAppUpdate}
            targetVersion={versionMismatch.clientVersion}
            label="Retry"
            variant="ghost"
          />
        ),
        ...(updateFailed
          ? {
              dismissLabel: "Dismiss update notice",
              onDismiss: () => {
                dismissServerUpdateFailure(serverUpdateState);
                setDismissedServerUpdateState(serverUpdateState);
              },
            }
          : {}),
      });
    }
    if (autoBalanceUpdateBanner) items.push(autoBalanceUpdateBanner);
    return items;
  })() as ComposerBannerStackItem[];
}
