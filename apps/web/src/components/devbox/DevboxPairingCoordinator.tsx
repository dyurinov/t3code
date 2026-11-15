import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { connectPairing } from "../../connection/onboarding";
import { clientHostEnvironmentAtom } from "../../state/clientHostEnvironment";
import { devboxClaimAtom, devboxEnvironment, useDevboxes } from "../../state/devboxes";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

// Once per page load, so a box this client was removed from stays removed until a reload.
const attempted = new Set<EnvironmentId>();
// Boxes seen down; their provider status is from boot and gets checked again once they answer.
const woken = new Set<EnvironmentId>();
// Each box's sign-in states as last seen, to notice the host installing one.
const credentialsSeen = new Map<EnvironmentId, string>();
// A box just up is still running its startup script, which can starve the provider probe.
const PROVIDER_RECHECK_DELAY_MS = 20_000;

/**
 * Connects this client to the host's claimed devboxes it is not paired with yet, so a box
 * taken in one window shows up in every other one. A box answers only on the host's
 * loopback, so clients on another machine are skipped.
 */
export function DevboxPairingCoordinator() {
  const { hostEnvironmentId, devboxes } = useDevboxes();
  const onHost = useAtomValue(clientHostEnvironmentAtom(hostEnvironmentId));
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const { environments } = useEnvironments();
  const claiming = useAtomValue(devboxClaimAtom).kind !== "idle";
  const pairClient = useAtomCommand(devboxEnvironment.pairClient, { reportFailure: false });
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pairs with servers outside React as the host reports them
  useEffect(() => {
    if (hostEnvironmentId === null || !onHost || !catalog.isReady || claiming) return;
    for (const devbox of devboxes) {
      const environmentId = devbox.environmentId;
      if (devbox.spare || devbox.state !== "running" || environmentId === null) continue;
      if (catalog.entries.has(environmentId) || attempted.has(environmentId)) continue;
      attempted.add(environmentId);
      void pairClient({ environmentId: hostEnvironmentId, input: { name: devbox.name } }).then(
        (pairing) =>
          pairing._tag === "Success"
            ? connect({
                host: pairing.value.url,
                pairingCode: pairing.value.pairingCode,
                expectedEnvironmentId: pairing.value.environmentId,
              })
            : undefined,
      );
    }
  }, [hostEnvironmentId, onHost, catalog, claiming, devboxes, pairClient, connect]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-probes a woken box's providers, which its server checked while booting
  useEffect(() => {
    for (const devbox of devboxes) {
      if (devbox.environmentId !== null && devbox.state !== "running")
        woken.add(devbox.environmentId);
    }
    for (const environment of environments) {
      if (!woken.has(environment.environmentId)) continue;
      if (environment.connection.phase !== "connected") continue;
      woken.delete(environment.environmentId);
      const environmentId = environment.environmentId;
      // Not cancelled on re-render: the box has left `woken`, so nothing would schedule it again.
      setTimeout(
        () => void refreshProviders({ environmentId, input: { refreshModels: true } }),
        PROVIDER_RECHECK_DELAY_MS,
      );
    }
  }, [devboxes, environments, refreshProviders]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a sign-in the host just installed on a box shows there only after its server re-probes providers
  useEffect(() => {
    for (const devbox of devboxes) {
      if (devbox.environmentId === null) continue;
      const signature = `${devbox.credentials.claude}:${devbox.credentials.codex}`;
      const previous = credentialsSeen.get(devbox.environmentId);
      credentialsSeen.set(devbox.environmentId, signature);
      if (previous === undefined || previous === signature) continue;
      void refreshProviders({
        environmentId: devbox.environmentId,
        input: { refreshModels: true },
      });
    }
  }, [devboxes, refreshProviders]);

  return null;
}
