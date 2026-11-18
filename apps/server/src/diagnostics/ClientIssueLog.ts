import { ClientIssue } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

/** Past this size the log moves to `.1`, replacing the previous one. */
const MAX_BYTES = 5 * 1024 * 1024;

const encodeEntry = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ ...ClientIssue.fields, recordedAt: Schema.String, clientId: Schema.String }),
  ),
);

/**
 * Errors and warnings this machine's clients showed or caught, one JSON line each in
 * `logs/client-issues.ndjson`. The client's own UI keeps none of them once dismissed.
 */
export class ClientIssueLog extends Context.Service<
  ClientIssueLog,
  { readonly record: (issue: ClientIssue, clientId: string) => Effect.Effect<void> }
>()("t3/diagnostics/ClientIssueLog") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const file = path.join(config.logsDir, "client-issues.ndjson");
  const writes = yield* Semaphore.make(1);

  const record = Effect.fn("ClientIssueLog.record")(
    function* (issue: ClientIssue, clientId: string) {
      const line = yield* encodeEntry({
        ...issue,
        recordedAt: DateTime.formatIso(yield* DateTime.now),
        clientId,
      });
      yield* writes.withPermit(
        Effect.gen(function* () {
          const size = yield* fs.stat(file).pipe(
            Effect.map((info) => Number(info.size)),
            Effect.orElseSucceed(() => 0),
          );
          if (size > MAX_BYTES) yield* fs.rename(file, `${file}.1`);
          yield* fs.writeFileString(file, `${line}\n`, { flag: "a" });
        }),
      );
    },
    Effect.catchCause((cause) => Effect.logWarning("client issue not recorded", { cause })),
  );

  return ClientIssueLog.of({ record });
});

export const layer = Layer.effect(ClientIssueLog, make);
