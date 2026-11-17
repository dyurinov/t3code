import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HttpClient from "effect/http/HttpClient";

import * as NetService from "@t3tools/shared/Net";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as DevboxCredentialPool from "./DevboxCredentialPool.ts";
import * as DevboxService from "./DevboxService.ts";

const spare = (name: string, installed = true, linked = true) => ({
  name,
  localPort: 13800,
  environmentId: linked ? EnvironmentId.make(`environment-${name}`) : null,
  task: null,
  createdAt: "2026-11-01T00:00:00Z",
  credentials: {
    claude: installed ? "installed" : "pool-empty",
    codex: installed ? "installed" : "pool-empty",
  },
  spare: true,
});

const setup = Effect.fn("test.setup")(function* (
  stored: ReadonlyArray<ReturnType<typeof spare>> = [],
  failSetup = false,
) {
  const launches = yield* Queue.unbounded<ProcessRunner.ProcessRunInput>();
  const reads = yield* Queue.unbounded<void>();
  const login = yield* Deferred.make<void>();
  const setupAttempts = yield* Queue.unbounded<string>();
  const files = new Map([["/state/userdata/devboxes.json", JSON.stringify({ devboxes: stored })]]);
  const filesystem = FileSystem.layerNoop({
    readFileString: (file) => Effect.sync(() => files.get(file) ?? ""),
    writeFileString: (file, text) => Effect.sync(() => void files.set(file, text)),
    rename: (from, to) => Effect.sync(() => void files.set(to, files.get(from) ?? "")),
    makeDirectory: () => Effect.void,
  });
  let minted = false;
  const service = yield* DevboxService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              T3CODE_DEVBOX_CODEZ_DIR: "/checkout/codez with spaces",
              T3CODE_DEVBOX_SPARES: "1",
              PYTHONPATH: "/other/python",
            },
          }),
        ),
        filesystem,
        Path.layer,
        ServerConfig.layerTest("/checkout", "/state").pipe(Layer.provide([filesystem, Path.layer])),
        Layer.mock(ServerEnvironment.ServerEnvironment)({}),
        Layer.mock(PeerLinks.PeerLinks)({}),
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: () => Effect.succeedNone,
        }),
        Layer.mock(Digest.Digest)({ digest: () => Effect.succeed(new Uint8Array(32)) }),
        Layer.mock(NetService.NetService)({ canListenOnHost: () => Effect.succeed(true) }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Unexpected HTTP request")),
        ),
        Layer.succeed(ServerActivation, Effect.never),
        Layer.mock(DevboxCredentialPool.DevboxCredentialPool)({
          freeCount: () => Effect.succeed(0),
          assignedCount: () => Effect.succeed(0),
          pendingLogins: Effect.succeed([]),
          mint: () =>
            Deferred.await(login).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  minted = true;
                }),
              ),
              Effect.as("login"),
            ),
          claim: () =>
            Effect.succeed({
              claude: Option.none(),
              codex: minted ? Option.some("test-auth") : Option.none(),
              commit: Effect.void,
            }),
        }),
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: (input) =>
            Effect.gen(function* () {
              if (failSetup && input.command === "coder" && input.args[0] === "ssh") {
                yield* Queue.offer(setupAttempts, input.args[2]!);
                return {
                  stdout: "",
                  stderr:
                    "Formal sign-in required: https://catalog.formal.ai/catalog/resource/resource_fixture",
                  code: ChildProcessSpawner.ExitCode(1),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                };
              }
              if (input.command === "coder" && input.args[0] === "list") {
                yield* Queue.offer(reads, undefined);
                return {
                  stdout: JSON.stringify(
                    stored.map(({ name }) => ({ name, latest_build: { status: "running" } })),
                  ),
                  stderr: "",
                  code: ChildProcessSpawner.ExitCode(0),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                };
              }
              if (input.command === "ssh" && input.args.at(-1)?.startsWith("python3 -c")) {
                return {
                  stdout: "",
                  stderr: "",
                  code: ChildProcessSpawner.ExitCode(0),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                };
              }
              if (input.command === "bash") yield* Queue.offer(launches, input);
              return yield* Effect.never;
            }),
        }),
      ),
    ),
  );
  return { service, launches, reads, login, setupAttempts };
});

describe("devbox allocation", () => {
  it.effect("keeps a running VM's setup error visible and retries setup on the same box", () =>
    Effect.gen(function* () {
      const name = "06-kept";
      const { service, setupAttempts } = yield* setup(
        [{ ...spare(name, true, false), spare: false }],
        true,
      );
      for (const _ of [0, 1]) {
        yield* service.wake(name);
        expect(yield* Queue.take(setupAttempts)).toBe(name);
        const failed = yield* service.awaitReady(name, "1 minute");
        expect(failed.state).toBe("failed");
        expect(failed.lastError).toContain(
          "https://catalog.formal.ai/catalog/resource/resource_fixture",
        );
      }
      expect((yield* service.list).map((box) => box.name)).toEqual([name]);
    }),
  );
  it.effect("claims a spare for an agent task and starts its replacement immediately", () =>
    Effect.gen(function* () {
      const { service, launches } = yield* setup([spare("01-ready")]);
      const box = yield* service.create({ name: "poem", task: "Write a poem" });
      expect(box).toMatchObject({ name: "01-ready", task: "Write a poem", spare: false });
      yield* Queue.take(launches);
      expect((yield* service.list).filter((item) => item.spare)).toHaveLength(1);
    }),
  );

  it.effect("gives simultaneous callers different spares without overfilling the pool", () =>
    Effect.gen(function* () {
      const { service, launches } = yield* setup([spare("01-ready"), spare("02-ready")]);
      const boxes = yield* Effect.all(
        [service.create({ task: "First" }), service.create({ task: "Second" })],
        { concurrency: "unbounded" },
      );
      expect(new Set(boxes.map((box) => box.name))).toEqual(new Set(["01-ready", "02-ready"]));
      expect(boxes.every((box) => !box.spare)).toBe(true);
      yield* Queue.take(launches);
      expect((yield* service.list).filter((box) => box.spare)).toHaveLength(1);
    }),
  );

  it.effect("reserves a fresh box when an explicit branch cannot use a prepared spare", () =>
    Effect.gen(function* () {
      const { service, launches } = yield* setup([spare("01-ready")]);
      const box = yield* service.create({ branch: "feature/poem" });
      expect(box.name).not.toBe("01-ready");
      expect((yield* service.list).find((item) => item.name === "01-ready")?.spare).toBe(true);
      expect(box.loginRequired?.settingsUrl).toBe("/settings/devboxes");
      const launch = yield* Queue.take(launches);
      expect(launch.env).toMatchObject({
        CODEZ: "/checkout/codez with spaces",
        PYTHONPATH: "/checkout/codez with spaces:/other/python",
      });
    }),
  );

  it.effect("reports the Settings link and waits until a newly added login reaches the box", () =>
    Effect.gen(function* () {
      const { service, reads, login } = yield* setup([spare("01-ready", false)]);
      const [box] = yield* service.list;
      expect(box).toHaveProperty("loginRequired.settingsUrl", "/settings/devboxes");
      yield* Queue.take(reads);
      const waiting = yield* Effect.forkChild(
        service.awaitReady("01-ready", "1 minute", { waitForLogin: true }),
      );
      yield* Queue.take(reads);
      expect(waiting.pollUnsafe()).toBeUndefined();
      yield* service.startLogin("codex", 1);
      yield* Deferred.succeed(login, undefined);
      const ready = yield* Fiber.join(waiting);
      expect(ready.credentials.codex).toBe("installed");
      expect(ready.loginRequired).toBeNull();
    }),
  );
});
