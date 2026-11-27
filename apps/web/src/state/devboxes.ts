import { msg } from "gt-react";
import { m, type MessageResolver } from "../i18n/messages";
import { createDevboxEnvironmentAtoms } from "@t3tools/client-runtime/state/devboxes";
import type { DeletedDevbox, DevboxLogin, DevboxSummary, EnvironmentId } from "@t3tools/contracts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import type { ChatMessage } from "../types";
import { createDevboxClaims, type DevboxClaimState } from "./devboxClaims";

import { connectionAtomRuntime } from "../connection/runtime";
import { usePrimaryEnvironmentId } from "./environments";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

export const devboxEnvironment = createDevboxEnvironmentAtoms(connectionAtomRuntime);

/**
 * Boxes this client asked to wake. Until the host's list moves them off `stopped`, they show as
 * starting, so a list read from before the request cannot flash them back to asleep.
 */
const devboxWakeRequestsAtom = Atom.make<Readonly<Record<string, true>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("devboxes:wake-requests"),
);

/** Devboxes live on the primary environment, which creates them and keeps their forwards. */
export function useDevboxes(): {
  readonly hostEnvironmentId: EnvironmentId | null;
  /** Whether the host can manage devboxes: its list answered, which needs the Coder CLI. */
  readonly available: boolean;
  readonly devboxes: ReadonlyArray<DevboxSummary>;
  /** As the host reports them, before this client's pending wakes. */
  readonly listedDevboxes: ReadonlyArray<DevboxSummary>;
  /** This machine's sign-ins, which every devbox gets its access tokens from. */
  readonly logins: ReadonlyArray<DevboxLogin>;
  /** Boxes T3 deleted; their saved environments are dead ends. */
  readonly deleted: ReadonlyArray<DeletedDevbox>;
  /** Whether this host copies threads off a devbox before deleting it. */
  readonly migratesThreadsOnDelete: boolean;
  readonly refresh: () => void;
} {
  const wakeRequests = useAtomValue(devboxWakeRequestsAtom);
  const hostEnvironmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    hostEnvironmentId === null
      ? null
      : devboxEnvironment.list({ environmentId: hostEnvironmentId, input: {} }),
  );
  return {
    hostEnvironmentId,
    available: query.data !== null,
    listedDevboxes: query.data?.devboxes ?? [],
    devboxes: (query.data?.devboxes ?? []).map((devbox) =>
      devbox.state === "stopped" && wakeRequests[devbox.name] === true
        ? { ...devbox, state: "starting" as const }
        : devbox,
    ),
    logins: query.data?.logins ?? [],
    deleted: query.data?.deleted ?? [],
    migratesThreadsOnDelete: query.data?.migratesThreadsOnDelete === true,
    refresh: query.refresh,
  };
}

/** Wakes a box; it reads as starting from the click on, on every screen. */
export function useWakeDevbox() {
  const { hostEnvironmentId } = useDevboxes();
  const wake = useAtomCommand(devboxEnvironment.wake, { reportFailure: false });
  const setRequests = useAtomSet(devboxWakeRequestsAtom);
  const forget = (name: string) =>
    setRequests((current) => {
      if (current[name] !== true) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  return async (name: string) => {
    if (hostEnvironmentId === null) return null;
    setRequests((current) => ({ ...current, [name]: true }));
    const result = await wake({ environmentId: hostEnvironmentId, input: { name } });
    if (result._tag === "Failure") forget(name);
    return result;
  };
}

/** Drops wake requests the host's list has caught up with, so a box that sleeps again shows it. */
export function useSettleDevboxWakeRequests(listedDevboxes: ReadonlyArray<DevboxSummary>) {
  const requests = useAtomValue(devboxWakeRequestsAtom);
  const setRequests = useAtomSet(devboxWakeRequestsAtom);
  const settled = Object.keys(requests).filter((name) => {
    const devbox = listedDevboxes.find((entry) => entry.name === name);
    return devbox === undefined || devbox.state !== "stopped";
  });
  return () => {
    if (settled.length === 0) return;
    setRequests((current) =>
      Object.fromEntries(Object.entries(current).filter(([name]) => !settled.includes(name))),
    );
  };
}

export function devboxForEnvironment(
  devboxes: ReadonlyArray<DevboxSummary>,
  environmentId: EnvironmentId | null,
): DevboxSummary | null {
  if (environmentId === null) return null;
  return devboxes.find((devbox) => devbox.environmentId === environmentId) ?? null;
}

/** What a devbox's row says instead of its connection health, or null once it runs. */
export function devboxStatusLabel(
  devbox: DevboxSummary,
  resolve: MessageResolver = m,
): string | null {
  if (devbox.spare) return resolve(msg("Spare. New devbox takes it next."));
  switch (devbox.state) {
    case "running":
      return devbox.credentials.claude === "unbound" || devbox.credentials.codex === "unbound"
        ? resolve(msg("Needs a Formal sign-in on the box."))
        : null;
    case "stopped":
      return resolve(msg("Sleeping. Wake it to use it here."));
    case "starting":
      return resolve(msg("Starting… This takes a few minutes."));
    case "stopping":
      return resolve(msg("Going to sleep…"));
    case "creating":
      return resolve(msg("Being set up…"));
    case "deleting":
      return resolve(msg("Deleting…"));
    case "failed":
      return devbox.lastError ?? resolve(msg("Did not start."));
    case "missing":
      return resolve(msg("No longer exists in Coder."));
  }
}

/** Whether the environment is a devbox that is not running; sending to it wakes it. */
export function useDevboxAsleep(environmentId: EnvironmentId | null): boolean {
  const { devboxes } = useDevboxes();
  const state = devboxForEnvironment(devboxes, environmentId)?.state;
  return state !== undefined && state !== "running";
}

export const devboxClaims = createDevboxClaims();

export function useDevboxClaim(draftId: string | null) {
  const state = useAtomValue(devboxClaims.stateAtom(draftId));
  const set = (change: DevboxClaimState | ((current: DevboxClaimState) => DevboxClaimState)) => {
    if (draftId !== null) devboxClaims.set(appAtomRegistry, draftId, change);
  };
  return [state, set] as const;
}

/**
 * Sends shown as sent while their devbox starts, by `devboxSendKey`: what the working row says
 * until the box connects and the message goes out.
 */
export interface DevboxSendWait {
  /** Progress while the devbox is being prepared, connected, or woken. */
  readonly label: string;
  readonly title: string;
  /** The draft the send started from; its thread does not exist on the box yet. */
  readonly draftId: string | null;
  /** `environmentId:projectId`. */
  readonly projectKey: string;
  readonly createdAt: string;
  /** The sent message, so the thread shows it even after its view was left and reopened. */
  readonly message: ChatMessage;
}

export const devboxSendWaitsAtom = Atom.make<ReadonlyMap<string, DevboxSendWait>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("devboxes:send-waits"),
);

export function devboxSendKey(environmentId: EnvironmentId, threadId: string): string {
  return `${environmentId}:${threadId}`;
}
