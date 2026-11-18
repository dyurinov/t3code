import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ClientIssueLog from "./ClientIssueLog.ts";

const layer = ClientIssueLog.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-client-issues-" })),
  Layer.provideMerge(NodeServices.layer),
);

describe("ClientIssueLog", () => {
  it.effect("appends each issue as a line and starts a new file past the size cap", () =>
    Effect.gen(function* () {
      const log = yield* ClientIssueLog.ClientIssueLog;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { logsDir } = yield* ServerConfig.ServerConfig;
      const file = path.join(logsDir, "client-issues.ndjson");
      const issue = {
        level: "warning" as const,
        source: "toast" as const,
        title: "06-mcp-stack froze for 7s",
        description: "Its CPU is overloaded (load 40 on 16 cores).",
        occurredAt: "2026-11-18T22:00:00.000Z",
      };

      yield* log.record(issue, "1");
      yield* log.record({ ...issue, level: "error", title: "Second" }, "1");
      const lines = (yield* fs.readFileString(file)).trim().split("\n");
      expect(lines.map((line) => JSON.parse(line).title)).toEqual([
        "06-mcp-stack froze for 7s",
        "Second",
      ]);
      expect(JSON.parse(lines[0]!)).toMatchObject({ level: "warning", clientId: "1" });

      yield* fs.writeFileString(file, "x".repeat(5 * 1024 * 1024 + 1));
      yield* log.record({ ...issue, title: "After rotation" }, "2");
      expect((yield* fs.readFileString(file)).trim().split("\n")).toHaveLength(1);
      expect(yield* fs.exists(`${file}.1`)).toBe(true);
    }).pipe(Effect.provide(layer)),
  );
});
