import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { DevboxSummary } from "@t3tools/contracts";
import { PowerIcon } from "lucide-react";

import { useDevboxes, useWakeDevbox } from "../../state/devboxes";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Wake for a claimed devbox that sleeps or failed to start, and nothing otherwise.
 */
export function DevboxWakeButton({ devbox }: { readonly devbox: DevboxSummary }) {
  const { hostEnvironmentId } = useDevboxes();
  const wake = useWakeDevbox();

  if (devbox.spare || hostEnvironmentId === null) return null;
  if (devbox.state !== "stopped" && devbox.state !== "failed") return null;
  const onWake = async () => {
    const result = await wake(devbox.name);
    if (result?._tag === "Failure" && !isAtomCommandInterrupted(result)) {
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
    <Button size="xs" variant="outline" onClick={() => void onWake()}>
      <PowerIcon aria-hidden />
      {devbox.state === "failed" ? "Try again" : "Wake"}
    </Button>
  );
}
