import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { DevboxSummary } from "@t3tools/contracts";
import { useEffect } from "react";

import { devboxEnvironment, useDevboxes } from "../../state/devboxes";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Wake for a claimed devbox that sleeps or failed to start, and nothing otherwise. Follows the
 * box while it starts or stops, since the host does not push its state.
 */
export function DevboxWakeButton({ devbox }: { readonly devbox: DevboxSummary }) {
  const { hostEnvironmentId, refresh } = useDevboxes();
  const wake = useAtomCommand(devboxEnvironment.wake, { reportFailure: false });
  const changing = devbox.state === "starting" || devbox.state === "stopping";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the host does not push devbox state; follow a box while it starts or stops.
  useEffect(() => {
    if (!changing) return;
    const timer = setInterval(refresh, 5_000);
    return () => clearInterval(timer);
  }, [changing, refresh]);

  if (devbox.spare || hostEnvironmentId === null) return null;
  if (devbox.state !== "stopped" && devbox.state !== "failed") return null;
  const onWake = async () => {
    const result = await wake({ environmentId: hostEnvironmentId, input: { name: devbox.name } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not wake ${devbox.name}`,
          description: error instanceof Error ? error.message : "Waking failed.",
        }),
      );
    }
  };
  return (
    <Button size="xs" onClick={() => void onWake()}>
      {devbox.state === "failed" ? "Try again" : "Wake devbox"}
    </Button>
  );
}
