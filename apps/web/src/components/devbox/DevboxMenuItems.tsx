import { T, useGT } from "gt-react";
import { RegistryContext } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { DevboxError, EnvironmentId } from "@t3tools/contracts";
import { useContext } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { ensureLocalApi } from "../../localApi";
import {
  devboxEnvironment,
  devboxForEnvironment,
  useDevboxes,
  useWakeDevbox,
} from "../../state/devboxes";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { useAtomCommand } from "../../state/use-atom-command";
import { MenuItem, MenuSeparator } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";

// Persists across MenuPopup unmount/remount while a multi-minute migration+delete is in flight.
const inFlightDevboxDeletes = new Set<string>();

function devboxErrorReason(error: unknown): DevboxError["reason"] | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "DevboxError" &&
    "reason" in error &&
    typeof error.reason === "string"
  ) {
    return error.reason as DevboxError["reason"];
  }
  return null;
}

/** Sleep, wake and delete for an environment that is one of this machine's devboxes. */
export function DevboxMenuItems({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const { hostEnvironmentId, devboxes, migratesThreadsOnDelete } = useDevboxes();
  const devbox = devboxForEnvironment(devboxes, environmentId);
  const stop = useAtomCommand(devboxEnvironment.stop, { reportFailure: false });
  const wake = useWakeDevbox();
  const remove = useAtomCommand(devboxEnvironment.remove, { reportFailure: false });
  const forget = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const registry = useContext(RegistryContext);
  if (devbox === null || hostEnvironmentId === null) return null;

  const isDeleting = devbox.state === "deleting" || inFlightDevboxDeletes.has(devbox.name);

  const report = (title: string) => (result: { readonly _tag: string }) => {
    if (result._tag === "Failure") toastManager.add(stackedThreadToast({ type: "error", title }));
  };
  const target = { environmentId: hostEnvironmentId, input: { name: devbox.name } };
  const deleteDevbox = async () => {
    if (inFlightDevboxDeletes.has(devbox.name)) return;
    inFlightDevboxDeletes.add(devbox.name);
    try {
      const confirmed = await ensureLocalApi().dialogs.confirm(
        migratesThreadsOnDelete
          ? gt(
              "Delete the devbox {name}? Its threads will be moved to this machine first, while any unpushed code on the box will be lost.",
              { name: devbox.name },
            )
          : gt("Delete the devbox {name}? Its threads and any unpushed work on it are lost.", {
              name: devbox.name,
            }),
        { variant: "destructive" },
      );
      if (!confirmed) return;
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: migratesThreadsOnDelete
            ? gt("Moving threads and deleting {name}…", { name: devbox.name })
            : gt("Deleting {name}…", { name: devbox.name }),
        }),
      );
      let deleted = await remove({
        environmentId: hostEnvironmentId,
        input: { name: devbox.name, force: false },
      });
      if (deleted._tag === "Failure") {
        const failure = squashAtomCommandFailure(deleted);
        const errorReason = devboxErrorReason(failure);
        if (errorReason !== "busy" && errorReason !== "migration") {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: gt("Could not delete {name}", { name: devbox.name }),
              description: thrownErrorMessage(failure),
            }),
          );
          return;
        }
        const reason = thrownErrorMessage(failure);
        const forceConfirmed = await ensureLocalApi().dialogs.confirm(
          errorReason === "busy" && migratesThreadsOnDelete
            ? gt(
                "{reason}\n\nDelete {name} anyway? Its threads will be copied first if possible, but if copying fails the box will still be deleted and uncopied threads, attachments, and unpushed code will be lost.",
                { reason, name: devbox.name },
              )
            : gt(
                "{reason}\n\nDelete {name} anyway? Any uncopied threads or attachments and unpushed work on it will be lost.",
                { reason, name: devbox.name },
              ),
          { variant: "destructive" },
        );
        if (!forceConfirmed) return;
        deleted = await remove({
          environmentId: hostEnvironmentId,
          input: {
            name: devbox.name,
            force: true,
            ...(errorReason === "migration" ? { skipMigration: true } : {}),
          },
        });
      }
      if (deleted._tag === "Failure") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not delete {name}", { name: devbox.name }),
            description: thrownErrorMessage(squashAtomCommandFailure(deleted)),
          }),
        );
        return;
      }
      await forget(environmentId);
      registry.refresh(peerLinkEnvironment.list({ environmentId: hostEnvironmentId, input: {} }));
      const moved = deleted.value.migratedThreads ?? 0;
      toastManager.add(
        stackedThreadToast({
          type: deleted.value.migrationWarning ? "warning" : "success",
          title:
            moved > 0
              ? gt("Deleted {name} (moved {count} {count, plural, one {thread} other {threads}})", {
                  name: devbox.name,
                  count: moved,
                })
              : gt("Deleted {name}", { name: devbox.name }),
          ...(deleted.value.migrationWarning
            ? { description: deleted.value.migrationWarning }
            : {}),
        }),
      );
    } finally {
      inFlightDevboxDeletes.delete(devbox.name);
    }
  };

  return (
    <>
      <MenuSeparator />
      {devbox.state === "running" ? (
        <MenuItem
          disabled={isDeleting}
          onClick={() =>
            void stop(target).then(report(gt("Could not stop {name}", { name: devbox.name })))
          }
        >
          <T>Sleep devbox</T>
        </MenuItem>
      ) : (
        <MenuItem
          disabled={isDeleting}
          onClick={() =>
            void wake(devbox.name).then(
              (result) =>
                result && report(gt("Could not wake {name}", { name: devbox.name }))(result),
            )
          }
        >
          <T>Wake devbox</T>
        </MenuItem>
      )}
      <MenuItem variant="destructive" disabled={isDeleting} onClick={() => void deleteDevbox()}>
        <T>Delete devbox…</T>
      </MenuItem>
    </>
  );
}
