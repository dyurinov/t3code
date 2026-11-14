import { useAtom } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectPairing } from "../../connection/onboarding";
import { devboxEnvironment, devboxPreparingAtom, useDevboxes } from "../../state/devboxes";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Takes a prepared devbox for the draft: the host hands over a spare (waking it when it
 * sleeps), this client pairs with it, and the draft switches to it once it answers.
 */
export function useNewDevbox(onReady: (environmentId: EnvironmentId) => void) {
  const { hostEnvironmentId, available } = useDevboxes();
  const claim = useAtomCommand(devboxEnvironment.claim, { reportFailure: false });
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  const [preparing, setPreparing] = useAtom(devboxPreparingAtom);

  const start = async () => {
    if (hostEnvironmentId === null || preparing) return;
    setPreparing(true);
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: "Preparing a devbox",
        description: "Keep typing. Your draft moves to the devbox when it is ready.",
      }),
    );
    const claimed = await claim({ environmentId: hostEnvironmentId, input: {} });
    if (claimed._tag === "Failure") {
      setPreparing(false);
      toastManager.add(stackedThreadToast({ type: "error", title: "Could not prepare a devbox" }));
      return;
    }
    const connected = await connect({
      host: claimed.value.url,
      pairingCode: claimed.value.pairingCode,
      expectedEnvironmentId: claimed.value.environmentId,
    });
    setPreparing(false);
    if (connected._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `${claimed.value.name} is ready, but connecting to it failed`,
        }),
      );
      return;
    }
    onReady(claimed.value.environmentId);
    toastManager.add(
      stackedThreadToast({ type: "success", title: `Running on ${claimed.value.name}` }),
    );
  };

  return { available, preparing, start };
}
