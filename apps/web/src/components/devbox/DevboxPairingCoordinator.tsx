import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { connectPairing } from "../../connection/onboarding";
import { clientHostEnvironmentAtom } from "../../state/clientHostEnvironment";
import { devboxClaimAtom, devboxEnvironment, useDevboxes } from "../../state/devboxes";
import { useAtomCommand } from "../../state/use-atom-command";

// Once per page load, so a box this client was removed from stays removed until a reload.
const attempted = new Set<EnvironmentId>();

/**
 * Connects this client to the host's claimed devboxes it is not paired with yet, so a box
 * taken in one window shows up in every other one. A box answers only on the host's
 * loopback, so clients on another machine are skipped.
 */
export function DevboxPairingCoordinator() {
  const { hostEnvironmentId, devboxes } = useDevboxes();
  const onHost = useAtomValue(clientHostEnvironmentAtom(hostEnvironmentId));
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const claiming = useAtomValue(devboxClaimAtom).kind !== "idle";
  const pairClient = useAtomCommand(devboxEnvironment.pairClient, { reportFailure: false });
  const connect = useAtomCommand(connectPairing, { reportFailure: false });

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

  return null;
}
