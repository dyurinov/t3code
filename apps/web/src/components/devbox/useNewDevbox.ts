import { useAtom } from "@effect/atom-react";

import { connectPairing } from "../../connection/onboarding";
import { devboxClaimAtom, devboxEnvironment, useDevboxes } from "../../state/devboxes";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Takes a prepared devbox for the draft: the host hands over a spare (waking it if it
 * sleeps) and this client pairs with it. The toolbar moves the draft once the box's
 * project loads; see `useDevboxDraftSwitch`.
 */
export function useNewDevbox() {
  const { hostEnvironmentId, available } = useDevboxes();
  const claim = useAtomCommand(devboxEnvironment.claim, { reportFailure: false });
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  const pairClient = useAtomCommand(devboxEnvironment.pairClient, { reportFailure: false });
  const [state, setState] = useAtom(devboxClaimAtom);

  const fail = (title: string) => {
    setState({ kind: "idle" });
    toastManager.add(stackedThreadToast({ type: "error", title }));
  };

  const start = async () => {
    if (hostEnvironmentId === null || state.kind !== "idle") return;
    setState({ kind: "preparing", queuedSend: false });
    const claimed = await claim({ environmentId: hostEnvironmentId, input: {} });
    if (claimed._tag === "Failure") return fail("Could not prepare a devbox");
    // The pairing code works once, so retry with a fresh one if the first try finds no answer.
    let pairing = claimed.value;
    let connected = await connect({
      host: pairing.url,
      pairingCode: pairing.pairingCode,
      expectedEnvironmentId: pairing.environmentId,
    });
    for (let attempt = 1; connected._tag === "Failure" && attempt < 4; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const fresh = await pairClient({
        environmentId: hostEnvironmentId,
        input: { name: claimed.value.name },
      });
      if (fresh._tag === "Failure") continue;
      pairing = { ...fresh.value, name: claimed.value.name };
      connected = await connect({
        host: pairing.url,
        pairingCode: pairing.pairingCode,
        expectedEnvironmentId: pairing.environmentId,
      });
    }
    if (connected._tag === "Failure")
      return fail(`${claimed.value.name} is ready, but connecting to it failed`);
    setState((current) => ({
      kind: "ready",
      environmentId: claimed.value.environmentId,
      name: claimed.value.name,
      queuedSend: current.kind === "idle" ? false : current.queuedSend,
    }));
    // The draft moves once the box lists this project; one that never does must not hang.
    setTimeout(() => {
      let stuck = false;
      setState((current) => {
        stuck = current.kind === "ready" && current.environmentId === claimed.value.environmentId;
        return stuck ? { kind: "idle" } : current;
      });
      if (stuck)
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `${claimed.value.name} is connected, but this project is not on it`,
            description: "Pick it under Run on once its project appears.",
          }),
        );
    }, 90_000);
  };

  return { available, state, start };
}

/** What the Run on control says while a devbox is being taken, or null. */
export function devboxClaimLabel(state: ReturnType<typeof useNewDevbox>["state"]): string | null {
  if (state.kind === "preparing") return "Preparing devbox…";
  if (state.kind === "ready") return `Connecting ${state.name}…`;
  return null;
}
