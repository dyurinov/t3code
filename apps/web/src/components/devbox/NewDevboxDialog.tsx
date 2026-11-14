import type { DevboxSummary, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { connectPairing } from "../../connection/onboarding";
import { devboxEnvironment, useDevboxes } from "../../state/devboxes";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";

type Phase =
  | { readonly kind: "form" }
  | { readonly kind: "creating"; readonly name: string }
  | { readonly kind: "connecting"; readonly name: string }
  | { readonly kind: "failed"; readonly message: string };

const POLL_INTERVAL_MS = 5_000;

/**
 * Creates a Coder devbox for one task, then connects this client to it and hands back its
 * environment, so the composer can run the task there.
 */
export function NewDevboxDialog({
  open,
  initialTask,
  onClose,
  onReady,
}: {
  readonly open: boolean;
  readonly initialTask: string;
  readonly onClose: () => void;
  readonly onReady: (environmentId: EnvironmentId) => void;
}) {
  const { hostEnvironmentId, devboxes, refresh } = useDevboxes();
  const create = useAtomCommand(devboxEnvironment.create, { reportFailure: false });
  const pairClient = useAtomCommand(devboxEnvironment.pairClient, { reportFailure: false });
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  const [task, setTask] = useState(initialTask);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  const pendingName = phase.kind === "creating" ? phase.name : null;
  const pending: DevboxSummary | null =
    pendingName === null ? null : (devboxes.find((devbox) => devbox.name === pendingName) ?? null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the host's Coder state while a box is being created; nothing pushes it.
  useEffect(() => {
    if (pendingName === null) return;
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pendingName, refresh]);

  const ready =
    pending !== null && pending.state === "running" && pending.environmentId !== null
      ? pending
      : null;
  const failedMessage =
    pending?.state === "failed" ? (pending.lastError ?? "Creating failed.") : null;
  if (failedMessage !== null && phase.kind === "creating") {
    setPhase({ kind: "failed", message: failedMessage });
  }
  const readyName = phase.kind === "creating" && ready !== null ? ready.name : null;
  const connectReady = useEffectEvent(async (name: string) => {
    if (hostEnvironmentId === null) return;
    const pairing = await pairClient({ environmentId: hostEnvironmentId, input: { name } });
    if (pairing._tag === "Failure") {
      setPhase({
        kind: "failed",
        message: "The devbox is up, but this client could not pair with it.",
      });
      return;
    }
    const connected = await connect({
      host: pairing.value.url,
      pairingCode: pairing.value.pairingCode,
      expectedEnvironmentId: pairing.value.environmentId,
    });
    if (connected._tag === "Failure") {
      setPhase({ kind: "failed", message: "The devbox is up, but connecting to it failed." });
      return;
    }
    setPhase({ kind: "form" });
    onReady(pairing.value.environmentId);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pairs with the box once the host reports it linked; that arrives through polling, not a user action.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- connectReady sets state only after awaiting the host.
    if (readyName !== null) void connectReady(readyName);
  }, [readyName]);

  const start = async () => {
    if (hostEnvironmentId === null) return;
    const result = await create({
      environmentId: hostEnvironmentId,
      input: task.trim().length > 0 ? { task: task.trim() } : {},
    });
    if (result._tag === "Failure") {
      setPhase({ kind: "failed", message: "Coder refused to create the devbox." });
      return;
    }
    setPhase({ kind: "creating", name: result.value.name });
  };

  const busy = phase.kind === "creating" || phase.kind === "connecting";
  const shown: Phase = readyName !== null ? { kind: "connecting", name: readyName } : phase;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        // Creating continues on the host; closing only hides the progress.
        if (!busy) setPhase({ kind: "form" });
        onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New devbox</DialogTitle>
          <DialogDescription>
            A Coder devbox for one task, signed in to Claude and Codex from your login pool. It
            sleeps after 8 hours without a running turn.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {shown.kind === "form" ? (
            <Textarea
              id="new-devbox-task"
              value={task}
              onChange={(event) => setTask(event.target.value)}
              placeholder="What is this devbox for? It names the box."
              rows={3}
            />
          ) : shown.kind === "creating" ? (
            <p className="text-sm">
              Creating <span className="font-medium">{shown.name}</span>. From the warm pool this
              takes about 3 minutes; a cold box takes up to 40. You can close this window; the box
              is selected when it is ready.
            </p>
          ) : shown.kind === "connecting" ? (
            <p className="text-sm">
              <span className="font-medium">{shown.name}</span> is up. Connecting…
            </p>
          ) : (
            <p className="text-destructive text-sm">{shown.message}</p>
          )}
        </DialogPanel>
        <DialogFooter>
          {phase.kind === "form" || phase.kind === "failed" ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setPhase({ kind: "form" });
                  onClose();
                }}
              >
                Cancel
              </Button>
              <Button onClick={() => void start()} disabled={hostEnvironmentId === null}>
                Create devbox
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
