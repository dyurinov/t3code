import { T, useGT } from "gt-react";
import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
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

/** Sleep, wake and delete for an environment that is one of this machine's devboxes. */
export function DevboxMenuItems({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const { hostEnvironmentId, devboxes } = useDevboxes();
  const devbox = devboxForEnvironment(devboxes, environmentId);
  const stop = useAtomCommand(devboxEnvironment.stop, { reportFailure: false });
  const wake = useWakeDevbox();
  const remove = useAtomCommand(devboxEnvironment.remove, { reportFailure: false });
  const forget = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const registry = useContext(RegistryContext);
  if (devbox === null || hostEnvironmentId === null) return null;

  const report = (title: string) => (result: { readonly _tag: string }) => {
    if (result._tag === "Failure") toastManager.add(stackedThreadToast({ type: "error", title }));
  };
  const target = { environmentId: hostEnvironmentId, input: { name: devbox.name } };
  const deleteDevbox = async () => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      gt("Delete the devbox {name}? Its threads and any unpushed work on it are lost.", {
        name: devbox.name,
      }),
      { variant: "destructive" },
    );
    if (!confirmed) return;
    toastManager.add(
      stackedThreadToast({ type: "info", title: gt("Deleting {name}…", { name: devbox.name }) }),
    );
    const deleted = await remove({
      environmentId: hostEnvironmentId,
      input: { name: devbox.name, force: true },
    });
    if (deleted._tag === "Failure")
      return report(gt("Could not delete {name}", { name: devbox.name }))(deleted);
    await forget(environmentId);
    registry.refresh(peerLinkEnvironment.list({ environmentId: hostEnvironmentId, input: {} }));
    toastManager.add(
      stackedThreadToast({ type: "success", title: gt("Deleted {name}", { name: devbox.name }) }),
    );
  };

  return (
    <>
      <MenuSeparator />
      {devbox.state === "running" ? (
        <MenuItem
          onClick={() =>
            void stop(target).then(report(gt("Could not stop {name}", { name: devbox.name })))
          }
        >
          <T>Sleep devbox</T>
        </MenuItem>
      ) : (
        <MenuItem
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
      <MenuItem variant="destructive" onClick={() => void deleteDevbox()}>
        <T>Delete devbox…</T>
      </MenuItem>
    </>
  );
}
