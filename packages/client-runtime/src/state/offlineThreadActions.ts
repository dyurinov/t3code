import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  CommandId,
  EnvironmentId,
  IsoDateTime,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import { ConnectionTransientError } from "../connection/model.ts";
import { EnvironmentRpcUnavailableError, isRpcClientError } from "../rpc/client.ts";
import { runAtomCommand, type AtomCommand } from "./runtime.ts";

export class OfflineThreadActionError extends Schema.TaggedError<OfflineThreadActionError>()(
  "OfflineThreadActionError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

const isUnavailable = Schema.is(
  Schema.Union([ConnectionTransientError, EnvironmentRpcUnavailableError]),
);

const Action = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  occurredAt: IsoDateTime,
  kind: Schema.Literals([
    "settle",
    "unsettle",
    "snooze",
    "unsnooze",
    "pin",
    "unpin",
    "reorderActive",
  ]),
  snoozedUntil: Schema.optionalKey(IsoDateTime),
  restoreUnsettledAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
  orderKey: Schema.optionalKey(Schema.String),
  sequence: Schema.optionalKey(Schema.Number),
});
type Action = typeof Action.Type;
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Action)));

export interface OfflineThreadActionStorage {
  readonly load: (environmentId: EnvironmentId) => Promise<string | null>;
  readonly save: (environmentId: EnvironmentId, value: string) => Promise<void>;
  readonly uuid: () => string;
  readonly onError: (error: unknown) => void;
}

function applyOfflineThreadAction(
  thread: OrchestrationV2ThreadShell,
  action: Action,
): OrchestrationV2ThreadShell {
  const now = DateTime.makeUnsafe(action.occurredAt);
  switch (action.kind) {
    case "settle":
      return {
        ...thread,
        settledOverride: "settled",
        settledAt: thread.settledOverride === "settled" ? (thread.settledAt ?? now) : now,
        unsettledAt: null,
        activeOrderKey: null,
        pinnedAt: null,
        pinOrderKey: null,
        snoozedAt: null,
        snoozedUntil: null,
      };
    case "unsettle":
      return {
        ...thread,
        settledOverride: "active",
        settledAt: null,
        unsettledAt:
          thread.settledOverride === "active"
            ? (thread.unsettledAt ?? null)
            : action.restoreUnsettledAt === undefined
              ? now
              : action.restoreUnsettledAt === null
                ? null
                : DateTime.makeUnsafe(action.restoreUnsettledAt),
      };
    case "snooze":
      return {
        ...thread,
        snoozedAt: now,
        snoozedUntil: action.snoozedUntil ? DateTime.makeUnsafe(action.snoozedUntil) : null,
      };
    case "unsnooze":
      return { ...thread, snoozedAt: null, snoozedUntil: null };
    case "pin":
      return {
        ...thread,
        pinnedAt: thread.pinnedAt ?? now,
        pinOrderKey: thread.pinnedAt == null ? (action.orderKey ?? null) : thread.pinOrderKey,
        ...(thread.settledOverride === "settled"
          ? { settledOverride: "active" as const, settledAt: null, unsettledAt: now }
          : {}),
        snoozedUntil: null,
        snoozedAt: null,
      };
    case "unpin":
      return { ...thread, pinnedAt: null, pinOrderKey: null };
    case "reorderActive":
      return { ...thread, activeOrderKey: action.orderKey ?? null };
  }
}

type Input = {
  readonly threadId: ThreadId;
  readonly commandId?: CommandId;
  readonly snoozedUntil?: string;
  readonly restoreUnsettledAt?: string | null;
  readonly orderKey?: string;
};

export function createOfflineThreadActions(options: {
  readonly storage: OfflineThreadActionStorage;
  readonly snapshotAtom: (id: EnvironmentId) => Atom.Atom<OrchestrationV2ShellSnapshot | null>;
  readonly connectedAtom: (id: EnvironmentId) => Atom.Atom<boolean>;
  readonly allowedAtom: (id: EnvironmentId) => Atom.Atom<boolean>;
  readonly onQueued: (registry: AtomRegistry.AtomRegistry, id: EnvironmentId) => void;
}) {
  const pendingAtom = Atom.family((_id: EnvironmentId) =>
    Atom.make<ReadonlyArray<Action>>([]).pipe(Atom.keepAlive),
  );
  const handlers = new Map<
    Action["kind"],
    (
      registry: AtomRegistry.AtomRegistry,
      id: EnvironmentId,
      action: Action,
    ) => Promise<AsyncResult.AsyncResult<{ readonly sequence: number }, unknown>>
  >();
  const states = new WeakMap<
    AtomRegistry.AtomRegistry,
    Map<
      EnvironmentId,
      {
        ready: Promise<void>;
        writes: Promise<void>;
        flushing: Promise<void> | null;
      }
    >
  >();

  const state = (registry: AtomRegistry.AtomRegistry, id: EnvironmentId) => {
    let environments = states.get(registry);
    if (!environments) {
      environments = new Map();
      states.set(registry, environments);
    }
    let value = environments.get(id);
    if (!value) {
      const ready = options.storage.load(id).then((json) => {
        registry.set(pendingAtom(id), json === null ? [] : decode(json));
      });
      value = { ready, writes: ready, flushing: null };
      environments.set(id, value);
    }
    return value;
  };

  const update = (
    registry: AtomRegistry.AtomRegistry,
    id: EnvironmentId,
    change: (current: ReadonlyArray<Action>) => ReadonlyArray<Action>,
  ) => {
    const current = state(registry, id);
    const write = current.writes.then(async () => {
      await current.ready;
      const next = change(registry.get(pendingAtom(id)));
      await options.storage.save(id, JSON.stringify(next));
      registry.set(pendingAtom(id), next);
    });
    current.writes = write.catch(() => undefined);
    return write;
  };

  const flush = (registry: AtomRegistry.AtomRegistry, id: EnvironmentId): Promise<void> => {
    const current = state(registry, id);
    if (current.flushing) return current.flushing;
    current.flushing = (async () => {
      await current.ready;
      while (registry.get(options.connectedAtom(id))) {
        const snapshot = registry.get(options.snapshotAtom(id));
        if (snapshot === null) return;
        const action = registry.get(pendingAtom(id))[0];
        if (!action) return;
        const remove = () =>
          update(registry, id, (queue) =>
            queue.filter((entry) => entry.commandId !== action.commandId),
          );
        if (action.sequence !== undefined) {
          if (snapshot.snapshotSequence < action.sequence) return;
          await remove();
          continue;
        }
        if (
          !snapshot.threads.some((thread) => thread.id === action.threadId) ||
          (action.kind === "snooze" &&
            Date.parse(action.snoozedUntil ?? "") <= DateTime.toEpochMillis(DateTime.nowUnsafe()))
        ) {
          await remove();
          continue;
        }
        const handler = handlers.get(action.kind);
        if (!handler) return;
        const result = await handler(registry, id, action);
        if (result._tag === "Failure") {
          const error = Cause.squash(result.cause);
          if (
            !registry.get(options.connectedAtom(id)) ||
            Cause.hasInterruptsOnly(result.cause) ||
            isUnavailable(error) ||
            isRpcClientError(error)
          )
            return;
          await remove();
          options.storage.onError(error);
        } else if (result._tag === "Success") {
          await update(registry, id, (queue) =>
            queue.map((entry) =>
              entry.commandId === action.commandId
                ? { ...entry, sequence: result.value.sequence }
                : entry,
            ),
          );
        } else return;
      }
    })()
      .catch(options.storage.onError)
      .finally(() => {
        current.flushing = null;
      });
    return current.flushing;
  };

  const syncAtom = Atom.family((id: EnvironmentId) =>
    Atom.make((get) => {
      const registry = get.registry;
      const sync = () => {
        void flush(registry, id);
      };
      get.subscribe(options.connectedAtom(id), sync);
      get.subscribe(options.snapshotAtom(id), sync);
      get.subscribe(pendingAtom(id), sync);
      void state(registry, id).ready.then(sync, options.storage.onError);
    }),
  );

  const snapshotAtom = Atom.family((id: EnvironmentId) =>
    Atom.make((get) => {
      get(syncAtom(id));
      const snapshot = get(options.snapshotAtom(id));
      const pending = get(pendingAtom(id));
      if (!snapshot || pending.length === 0) return snapshot;
      const byThread = new Map<ThreadId, Action[]>();
      for (const action of pending) {
        if (action.sequence !== undefined && action.sequence <= snapshot.snapshotSequence) continue;
        const actions = byThread.get(action.threadId);
        if (actions) actions.push(action);
        else byThread.set(action.threadId, [action]);
      }
      return {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          (byThread.get(thread.id) ?? []).reduce(applyOfflineThreadAction, thread),
        ),
      };
    }),
  );

  function wrap<W extends Input, E>(
    kind: Action["kind"],
    command: AtomCommand<
      { readonly environmentId: EnvironmentId; readonly input: W },
      { readonly sequence: number },
      E
    >,
    restore: (action: Action) => NoInfer<W>,
  ): AtomCommand<
    { readonly environmentId: EnvironmentId; readonly input: W },
    { readonly sequence: number },
    E | EnvironmentAuthorizationError | OfflineThreadActionError
  > {
    handlers.set(kind, (registry, environmentId, action) =>
      runAtomCommand(registry, command, { environmentId, input: restore(action) }),
    );
    return {
      label: command.label,
      run: (registry, target) => {
        const id = target.environmentId;
        if (!registry.get(options.allowedAtom(id)))
          return Effect.fail(
            new EnvironmentAuthorizationError({
              requiredScope: AuthOrchestrationOperateScope,
              message: "This connection cannot organize threads.",
            }),
          );
        const toError = (cause: unknown) =>
          new OfflineThreadActionError({
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          });
        const queue = async () => {
          const { threadId, snoozedUntil, restoreUnsettledAt, orderKey } = target.input;
          const action: Action = {
            commandId: target.input.commandId ?? CommandId.make(options.storage.uuid()),
            threadId,
            kind,
            occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
            ...(snoozedUntil === undefined ? {} : { snoozedUntil }),
            ...(restoreUnsettledAt === undefined ? {} : { restoreUnsettledAt }),
            ...(orderKey === undefined ? {} : { orderKey }),
          };
          await update(registry, id, (queued) => [...queued, action]);
          options.onQueued(registry, id);
          void flush(registry, id);
          return { sequence: registry.get(options.snapshotAtom(id))?.snapshotSequence ?? 0 };
        };
        return Effect.tryPromise({ try: () => state(registry, id).ready, catch: toError }).pipe(
          Effect.flatMap(
            (): Effect.Effect<{ readonly sequence: number }, E | OfflineThreadActionError> =>
              registry.get(options.connectedAtom(id)) && registry.get(pendingAtom(id)).length === 0
                ? command.run(registry, target)
                : Effect.tryPromise({ try: queue, catch: toError }),
          ),
        );
      },
    };
  }
  return { snapshotAtom, wrap, flush };
}
