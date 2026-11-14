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
    const connected = await connect({
      host: claimed.value.url,
      pairingCode: claimed.value.pairingCode,
      expectedEnvironmentId: claimed.value.environmentId,
    });
    if (connected._tag === "Failure")
      return fail(`${claimed.value.name} is ready, but connecting to it failed`);
    setState((current) => ({
      kind: "ready",
      environmentId: claimed.value.environmentId,
      name: claimed.value.name,
      queuedSend: current.kind === "idle" ? false : current.queuedSend,
    }));
  };

  return { available, state, start };
}

/** What the Run on control says while a devbox is being taken, or null. */
export function devboxClaimLabel(state: ReturnType<typeof useNewDevbox>["state"]): string | null {
  if (state.kind === "preparing") return "Preparing devbox…";
  if (state.kind === "ready") return `Connecting ${state.name}…`;
  return null;
}
