import type { EnvironmentId } from "@t3tools/contracts";

import { environmentCatalog } from "../../connection/catalog";
import { ensureLocalApi } from "../../localApi";
import { devboxEnvironment, devboxForEnvironment, useDevboxes } from "../../state/devboxes";
import { useAtomCommand } from "../../state/use-atom-command";
import { MenuItem, MenuSeparator } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** Sleep, wake and delete for an environment that is one of this machine's devboxes. */
export function DevboxMenuItems({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { hostEnvironmentId, devboxes } = useDevboxes();
  const devbox = devboxForEnvironment(devboxes, environmentId);
  const stop = useAtomCommand(devboxEnvironment.stop, { reportFailure: false });
  const wake = useAtomCommand(devboxEnvironment.wake, { reportFailure: false });
  const remove = useAtomCommand(devboxEnvironment.remove, { reportFailure: false });
  const forget = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  if (devbox === null || hostEnvironmentId === null) return null;

  const report = (title: string) => (result: { readonly _tag: string }) => {
    if (result._tag === "Failure") toastManager.add(stackedThreadToast({ type: "error", title }));
  };
  const target = { environmentId: hostEnvironmentId, input: { name: devbox.name } };
  const deleteDevbox = async () => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Delete the devbox ${devbox.name}? Its threads and any unpushed work on it are lost.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    const deleted = await remove({
      environmentId: hostEnvironmentId,
      input: { name: devbox.name, force: true },
    });
    if (deleted._tag === "Failure") return report(`Could not delete ${devbox.name}`)(deleted);
    await forget(environmentId);
    toastManager.add(stackedThreadToast({ type: "success", title: `Deleted ${devbox.name}` }));
  };

  return (
    <>
      <MenuSeparator />
      {devbox.state === "running" ? (
        <MenuItem onClick={() => void stop(target).then(report(`Could not stop ${devbox.name}`))}>
          Sleep devbox
        </MenuItem>
      ) : (
        <MenuItem onClick={() => void wake(target).then(report(`Could not wake ${devbox.name}`))}>
          Wake devbox
        </MenuItem>
      )}
      <MenuItem variant="destructive" onClick={() => void deleteDevbox()}>
        Delete devbox…
      </MenuItem>
    </>
  );
}
