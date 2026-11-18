import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { request } from "@t3tools/client-runtime/rpc";
import { type ClientIssue, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

type ClientIssueInput = Omit<ClientIssue, "occurredAt" | "route">;

// Issues raised while the host is unreachable wait here; the oldest go first past the cap.
const MAX_PENDING = 200;
const pending: ClientIssue[] = [];
const wakers = new Set<() => void>();

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Keeps an error or warning this client showed or caught in the host's `client-issues.ndjson`. */
export function recordClientIssue(issue: ClientIssueInput): void {
  pending.push({
    ...issue,
    title: clip(issue.title, 500),
    ...(issue.description === undefined ? {} : { description: clip(issue.description, 4_000) }),
    ...(issue.stack === undefined ? {} : { stack: clip(issue.stack, 8_000) }),
    route: clip(`${window.location.pathname}${window.location.hash}`, 500),
    occurredAt: new Date().toISOString(),
  });
  if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING);
  for (const wake of wakers) wake();
}

const errorText = (value: unknown) =>
  value instanceof Error ? value.message : typeof value === "string" ? value : String(value);

/** Sends recorded issues to this machine's own server, the primary environment, never a remote. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const flushRequests = yield* Queue.sliding<void>(1);
    const requestFlush = () => Queue.offerUnsafe(flushRequests, undefined);

    const onError = (event: ErrorEvent) =>
      recordClientIssue({
        level: "error",
        source: "window-error",
        title: errorText(event.error ?? event.message),
        ...(event.error instanceof Error && event.error.stack ? { stack: event.error.stack } : {}),
      });
    const onRejection = (event: PromiseRejectionEvent) =>
      recordClientIssue({
        level: "error",
        source: "unhandled-rejection",
        title: errorText(event.reason),
        ...(event.reason instanceof Error && event.reason.stack
          ? { stack: event.reason.stack }
          : {}),
      });
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        wakers.add(requestFlush);
        window.addEventListener("error", onError);
        window.addEventListener("unhandledrejection", onRejection);
      }),
      () =>
        Effect.sync(() => {
          wakers.delete(requestFlush);
          window.removeEventListener("error", onError);
          window.removeEventListener("unhandledrejection", onRejection);
        }),
    );

    const flush = Effect.gen(function* () {
      const entries = yield* SubscriptionRef.get(registry.entries);
      const primary = [...entries].find(
        ([, entry]) => entry.target._tag === "PrimaryConnectionTarget",
      );
      if (primary === undefined) return;
      while (pending.length > 0) {
        const sent = yield* registry
          .run(primary[0], request(WS_METHODS.serverRecordClientIssue, pending[0]!))
          .pipe(Effect.timeout("10 seconds"), Effect.exit);
        if (sent._tag === "Failure") return;
        pending.shift();
      }
    });

    yield* Stream.fromQueue(flushRequests).pipe(
      Stream.debounce("500 millis"),
      Stream.runForEach(() => flush),
      Effect.forkScoped,
    );
    // Retries what a disconnected host could not take.
    yield* Effect.sync(requestFlush).pipe(
      Effect.repeat(Schedule.spaced("30 seconds")),
      Effect.forkScoped,
    );
  }),
);
