import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { msg } from "gt-react";
import { useEffect } from "react";

import { DraftId, restoreFailedDraftThread, useComposerDraftStore } from "../../composerDraftStore";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { m } from "../../i18n/messages";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  pendingDevboxSends,
  savePendingDevboxSends,
  takePendingDevboxSends,
  type PendingDevboxSend,
} from "../../state/devboxPendingSends";
import { stackedThreadToast, toastManager } from "../ui/toast";

import { environmentCatalog } from "../../connection/catalog";
import { connectPairing } from "../../connection/onboarding";
import { clientHostEnvironmentAtom } from "../../state/clientHostEnvironment";
import {
  devboxClaims,
  devboxEnvironment,
  devboxSendWaitsAtom,
  useDevboxes,
  useSettleDevboxWakeRequests,
} from "../../state/devboxes";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

// Once per page load, so a box this client was removed from stays removed until a reload.
const attempted = new Set<EnvironmentId>();
// Boxes seen down; their provider status is from boot and gets checked again once they answer.
const woken = new Set<EnvironmentId>();
// Saved environments of deleted boxes this page already removed.
const forgotten = new Set<EnvironmentId>();
// Each box's sign-in states as last seen, to notice the host installing one.
const credentialsSeen = new Map<EnvironmentId, string>();
let pendingSendsTracked = false;

/** Puts a message a restart cut off while it waited on its devbox back in its draft. */
function restorePendingDevboxSend(send: PendingDevboxSend) {
  const store = useComposerDraftStore.getState();
  const draftId = send.draftId === null ? null : DraftId.make(send.draftId);
  const draftThread = draftId === null ? undefined : store.draftThreadsByThreadKey[draftId];
  let restored = false;
  if (draftId !== null && draftThread !== undefined) {
    restoreFailedDraftThread(draftId, draftThread, draftThread.threadId);
    if (send.text.length > 0 && !store.getComposerDraft(draftId)?.prompt.trim()) {
      store.setPrompt(draftId, send.text);
      restored = true;
    }
  }
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: m(msg("Message not sent")),
      description: restored
        ? m(
            msg(
              "T3 Code restarted while “{title}” waited for its devbox. It is back in its draft.",
            ),
            {
              title: send.title,
            },
          )
        : m(msg("T3 Code restarted while “{title}” waited for its devbox."), {
            title: send.title,
          }),
      timeout: 0,
      data: { hideCopyButton: true },
      ...(!restored && send.text.length > 0
        ? {
            actionProps: {
              children: m(msg("Copy message")),
              onClick: () => {
                void writeTextToClipboard(send.text, {
                  target: "failed message",
                  unavailableMessage: msg(
                    "Clipboard API is unavailable while copying failed message.",
                  ),
                  failureMessage: msg("Failed to copy failed message to the clipboard."),
                }).catch(() => undefined);
              },
            },
          }
        : {}),
    }),
  );
}

// A box just up is still running its startup script, which can starve the provider probe.
const PROVIDER_RECHECK_DELAY_MS = 20_000;

/**
 * Connects this client to the host's claimed devboxes it is not paired with yet, so a box
 * taken in one window shows up in every other one. A box answers only on the host's
 * loopback, so clients on another machine are skipped.
 */
export function DevboxPairingCoordinator() {
  const { hostEnvironmentId, available, devboxes, listedDevboxes, deleted, refresh } =
    useDevboxes();
  const settleWakeRequests = useSettleDevboxWakeRequests(listedDevboxes);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors waiting devbox sends into storage so a restart cannot drop them unseen
  useEffect(() => {
    if (pendingSendsTracked) return;
    pendingSendsTracked = true;
    const leftovers = takePendingDevboxSends();
    appAtomRegistry.subscribe(devboxSendWaitsAtom, (waits) =>
      savePendingDevboxSends(pendingDevboxSends(waits)),
    );
    for (const send of leftovers) restorePendingDevboxSend(send);
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops this client's wake requests once the host's list has caught up with them
  useEffect(() => {
    settleWakeRequests();
  }, [settleWakeRequests]);
  const onHost = useAtomValue(clientHostEnvironmentAtom(hostEnvironmentId));
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const { environments } = useEnvironments();
  const claiming = [...useAtomValue(devboxClaims.claimsAtom).values()].some(
    (claim) => claim.kind === "preparing",
  );
  const pairClient = useAtomCommand(devboxEnvironment.pairClient, { reportFailure: false });
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  // Box states change on the host (Coder auto-stop, a wake finishing) and nothing is pushed;
  // follow a changing box closely and the rest at a calm pace.
  const changing = devboxes.some(
    (devbox) =>
      devbox.state === "creating" ||
      devbox.state === "starting" ||
      devbox.state === "stopping" ||
      devbox.state === "deleting",
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the host's devbox list, which the server does not push
  useEffect(() => {
    if (!available) return;
    const timer = setInterval(refresh, changing ? 4_000 : 20_000);
    return () => clearInterval(timer);
  }, [available, changing, refresh]);

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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-probes a woken box's providers, which its server checked while booting
  useEffect(() => {
    for (const devbox of devboxes) {
      if (devbox.environmentId !== null && devbox.state !== "running")
        woken.add(devbox.environmentId);
    }
    for (const environment of environments) {
      if (!woken.has(environment.environmentId)) continue;
      if (environment.connection.phase !== "connected") continue;
      woken.delete(environment.environmentId);
      const environmentId = environment.environmentId;
      // Not cancelled on re-render: the box has left `woken`, so nothing would schedule it again.
      setTimeout(
        () => void refreshProviders({ environmentId, input: { refreshModels: true } }),
        PROVIDER_RECHECK_DELAY_MS,
      );
    }
  }, [devboxes, environments, refreshProviders]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a sign-in the host just installed on a box shows there only after its server re-probes providers
  useEffect(() => {
    for (const devbox of devboxes) {
      if (devbox.environmentId === null) continue;
      const signature = `${devbox.credentials.claude}:${devbox.credentials.codex}`;
      const previous = credentialsSeen.get(devbox.environmentId);
      credentialsSeen.set(devbox.environmentId, signature);
      if (previous === undefined || previous === signature) continue;
      void refreshProviders({
        environmentId: devbox.environmentId,
        input: { refreshModels: true },
      });
    }
  }, [devboxes, refreshProviders]);

  const forgetEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  // A box deleted from another window leaves this one's saved environment retrying forever.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- removes saved environments for boxes the host deleted
  useEffect(() => {
    if (!catalog.isReady || deleted.length === 0) return;
    for (const environment of environments) {
      if (forgotten.has(environment.environmentId)) continue;
      const gone = deleted.some((box) =>
        box.environmentId !== null
          ? box.environmentId === environment.environmentId
          : // Recorded before ids were kept: match by name, only while it fails to answer.
            box.name === environment.label && environment.connection.phase !== "connected",
      );
      if (!gone) continue;
      forgotten.add(environment.environmentId);
      void forgetEnvironment(environment.environmentId);
    }
  }, [catalog, deleted, environments, forgetEnvironment]);

  return null;
}
