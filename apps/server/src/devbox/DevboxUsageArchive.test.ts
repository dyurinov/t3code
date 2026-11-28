// @effect-diagnostics nodeBuiltinImport:off - test invokes python3 and zlib directly against temp fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { EXPORT_DEVBOX_USAGE_SCRIPT } from "./devboxScripts.ts";
import {
  devboxArchiveDirPath,
  extractArchiveSourcesFromExport,
  readDevboxUsageArchives,
  saveDevboxUsageArchive,
} from "./DevboxUsageArchive.ts";

function protoNumber(field: number, value: number): number[] {
  const varint = (number: number) => {
    const bytes: number[] = [];
    do {
      const byte = number % 128;
      number = Math.floor(number / 128);
      bytes.push(byte + (number > 0 ? 128 : 0));
    } while (number > 0);
    return bytes;
  };
  return [...varint(field * 8), ...varint(value)];
}

function protoBytes(field: number, bytes: readonly number[]): number[] {
  const encoded = protoNumber(field, bytes.length);
  encoded[0] = encoded[0]! + 2;
  return [...encoded, ...bytes];
}

function protoText(field: number, value: string): number[] {
  return protoBytes(field, [...Buffer.from(value)]);
}

const seedAntigravityDb = Effect.fn("test.seedAntigravityDb")(function* (filename: string) {
  yield* Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(NodeSqliteClient.layer({ filename }));
      const sql = Context.get(context, SqlClient.SqlClient);
      yield* sql.unsafe("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
      yield* sql.unsafe("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
      const usageBlob = [
        ...protoNumber(1, 1467),
        ...protoNumber(2, 1_200),
        ...protoNumber(3, 450),
        ...protoNumber(5, 8_000),
        ...protoNumber(9, 300),
        ...protoNumber(10, 150),
        ...protoText(11, "resp-shared-1"),
      ];
      const tsBlob = protoNumber(1, 1_780_000_000);
      // Both steps and gen_metadata carry the same response ID -> should deduplicate into 1 record.
      yield* sql.unsafe("INSERT INTO steps VALUES (?, ?)", [
        0,
        new Uint8Array([...protoBytes(8, tsBlob), ...protoBytes(9, usageBlob)]),
      ]);
      yield* sql.unsafe("INSERT INTO gen_metadata VALUES (?, ?)", [
        0,
        new Uint8Array(
          protoBytes(1, [
            ...protoNumber(3, 1467),
            ...protoBytes(4, usageBlob),
            ...protoBytes(9, protoBytes(4, tsBlob)),
          ]),
        ),
      ]);
    }),
  );
});

describe("DevboxUsageArchive", () => {
  it.effect(
    "exports scan cache and Antigravity DBs, skips Cursor, merges incrementally, and filters by allowed providers",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fakeHome = yield* fs.makeTempDirectoryScoped({ prefix: "devbox-home-" });
        const hostStateDir = yield* fs.makeTempDirectoryScoped({ prefix: "host-state-" });

        const t3Dir = path.join(fakeHome, ".t3");
        const userdataDir = path.join(t3Dir, "userdata");
        const convDir = path.join(
          userdataDir,
          "providers",
          "antigravity",
          "default",
          "antigravity-acp",
          "conversations",
        );
        yield* fs.makeDirectory(convDir, { recursive: true });
        yield* fs.writeFileString(path.join(t3Dir, "usage-host-id"), "box-host-uuid-1\n");
        yield* fs.writeFileString(
          path.join(userdataDir, "settings.json"),
          JSON.stringify({
            providerInstances: {
              antigravity: {
                driver: "antigravity",
                enabled: true,
                config: {
                  authMethod: "agent-platform",
                  gcpProject: "proj-1",
                  gcpLocation: "eu",
                },
              },
            },
          }),
        );

        const claudeDir = "/home/vagrant/.claude/projects";
        const claudeFile = `${claudeDir}/proj/session-1.jsonl`;
        yield* fs.writeFileString(
          path.join(userdataDir, "usage-scan-cache-v18.json"),
          JSON.stringify({
            version: 18,
            models: ["claude-sonnet-4-6"],
            sessions: ["sess-1"],
            sources: {
              [`claude\0${claudeDir}`]: { dir: claudeDir, volumeId: "dev:100" },
              "cursor\0cursor-account:acct": { dir: "cursor-account:acct", volumeId: "acct" },
            },
            files: {
              [claudeFile]: {
                s: 128,
                m: 1_780_000_000_000,
                p: "claude",
                r: [
                  [1_780_000_000_000, 0, 0, 500, 1_000, 200, 300, 0, "claude:req-1", null, 0, null],
                ],
                t: [],
                mr: 0,
                o: 128,
                gl: 0,
                gh: 0,
                cs: null,
              },
            },
          }),
        );
        yield* seedAntigravityDb(path.join(convDir, "conv-1.db"));

        const exported = NodeChildProcess.execFileSync(
          "python3",
          ["-c", EXPORT_DEVBOX_USAGE_SCRIPT],
          {
            env: { ...process.env, HOME: fakeHome },
            maxBuffer: 16 * 1024 * 1024,
          },
        );
        const extracted = extractArchiveSourcesFromExport(exported);
        expect(extracted).not.toBeNull();
        expect(extracted?.map((source) => source.provider).sort()).toEqual([
          "antigravity",
          "claude",
        ]);
        const agySource = extracted?.find((source) => source.provider === "antigravity");
        expect(agySource?.hostId).toBe("box-host-uuid-1");
        expect(agySource?.records).toHaveLength(1);
        expect(agySource?.records[0]).toMatchObject({
          model: "gemini-4-neon",
          regionalEndpoint: true,
          totals: {
            uncachedInputTokens: 1_200,
            cachedInputTokens: 8_000,
            outputTokens: 450,
            reasoningTokens: 300,
          },
        });

        const saved = yield* saveDevboxUsageArchive({
          stateDir: hostStateDir,
          boxName: "26-lively-glacier",
          environmentId: "env-26",
          gzippedBytes: exported,
          capturedAtMs: 1_780_000_100_000,
        });
        expect(saved).toBe(true);

        // Saving a newer snapshot with an extra Antigravity record merges rather than dropping older ones.
        const secondExport = NodeZlib.gzipSync(
          Buffer.from(
            JSON.stringify({
              hostId: "box-host-uuid-1",
              scanCache: null,
              antigravity: [
                {
                  dir: agySource!.dir,
                  volumeId: agySource!.volumeId,
                  records: [
                    agySource!.records[0],
                    {
                      ...agySource!.records[0],
                      dedupeKey: "antigravity:11:resp-second-2",
                      timestampMs: 1_780_000_200_000,
                    },
                  ],
                },
              ],
            }),
          ),
        );
        yield* saveDevboxUsageArchive({
          stateDir: hostStateDir,
          boxName: "26-lively-glacier",
          environmentId: "env-26",
          gzippedBytes: secondExport,
          capturedAtMs: 1_780_000_300_000,
        });

        const all = yield* readDevboxUsageArchives({
          stateDir: hostStateDir,
          allowedProviders: new Set(["antigravity", "claude"]),
        });
        expect(all.map((entry) => entry.provider).sort()).toEqual(["antigravity", "claude"]);
        const archivedAgy = all.find((entry) => entry.provider === "antigravity");
        expect(archivedAgy?.dir).toBe(devboxArchiveDirPath("26-lively-glacier", agySource!.dir));
        expect(archivedAgy?.hostId).toBe("box-host-uuid-1");
        expect(archivedAgy?.files[0]?.records).toHaveLength(2);
        const archivedClaude = all.find((entry) => entry.provider === "claude");
        expect(archivedClaude?.dir).toBe(devboxArchiveDirPath("26-lively-glacier", claudeDir));
        expect(archivedClaude?.volumeId).toBe("dev:100");
        expect(archivedClaude?.files[0]?.records).toHaveLength(1);

        const onlyAgy = yield* readDevboxUsageArchives({
          stateDir: hostStateDir,
          allowedProviders: new Set(["antigravity"]),
        });
        expect(onlyAgy.map((entry) => entry.provider)).toEqual(["antigravity"]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
