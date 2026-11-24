import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
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
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HttpClient from "effect/http/HttpClient";

import * as NetService from "@t3tools/shared/Net";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as DevboxLogins from "./DevboxLogins.ts";
import * as DevboxService from "./DevboxService.ts";

const CURSOR_INSTANCE_ID = ProviderInstanceId.make("cursor");

const spare = (name: string, installed = true, linked = true) => ({
  name,
  localPort: 13800,
  environmentId: linked ? EnvironmentId.make(`environment-${name}`) : null,
  task: null,
  createdAt: "2026-11-01T00:00:00Z",
  credentials: {
    claude: installed ? "installed" : "no-login",
    codex: installed ? "installed" : "no-login",
  },
  spare: true,
});

const codexAuth = {
  auth_mode: "chatgpt",
  tokens: { id_token: "id", access_token: "access", refresh_token: "" },
};

const setup = Effect.fn("test.setup")(function* (
  stored: ReadonlyArray<ReturnType<typeof spare>> = [],
  failSetup = false,
  // What each box's sign-in renewal prints (`stream:` prefixed: printed, then ssh times out);
  // set, a Codex renewal is due.
  renewals?: Record<string, string>,
  refreshToken = "rt.1.codex",
  // A sign-in lands while the box relays, so the renewal's outcome is about a replaced login.
  signInDuringRelay = false,
  // Boxes skip sealed sign-ins until this machine binds them to Formal.
  unbound = false,
) {
  let generation = 0;
  const binds = yield* Queue.unbounded<string>();
  const pushes = yield* Queue.unbounded<string>();
  const cursorPushes = yield* Queue.unbounded<{ box: string; key: string }>();
  const settingsChanges = yield* Queue.unbounded<ServerSettings>();
  let currentSettings = DEFAULT_SERVER_SETTINGS;
  const workspaceStates = new Map<string, "running" | "stopped">(
    stored.map(({ name }) => [name, "running"]),
  );
  const relayed = yield* Queue.unbounded<string>();
  const renewalDone = yield* Deferred.make<void>();
  const rejectedTokens: Array<string> = [];
  let renewalDue = renewals !== undefined;
  const renewal = {
    provider: "codex" as const,
    refreshToken,
    scopes: [],
    requireFormal: false,
  };
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
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
        Layer.mock(SecretResolver.SecretResolver)({}),
        Layer.mock(ServerSettingsService.ServerSettingsService)({
          getSettings: Effect.sync(() => currentSettings),
          subscribeChanges: Effect.succeed(Stream.fromQueue(settingsChanges)),
        }),
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
        Layer.mock(DevboxLogins.DevboxLogins)({
          info: () =>
            Effect.sync(() => ({
              signedIn: minted,
              account: null,
              expiresAt: null,
              sealed: false,
            })),
          payload: Effect.sync(() => ({
            claude: null,
            codex: minted ? codexAuth : null,
          })),
          due: () => Effect.sync(() => (renewalDue ? Option.some(renewal) : Option.none())),
          generation: () => Effect.sync(() => generation),
          // Always relays, so only the service's own loop decides which boxes are tried.
          refresh: (_provider, relay) =>
            relay(renewal).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  renewalDue = false;
                }),
              ),
              Effect.andThen(Deferred.succeed(renewalDone, undefined)),
              Effect.as(true),
            ),
          reject: (_provider, token) =>
            Effect.sync(() => {
              renewalDue = false;
              rejectedTokens.push(token);
            }).pipe(Effect.andThen(Deferred.succeed(renewalDone, undefined)), Effect.asVoid),
          pendingUrl: () => Effect.succeed(null),
          signIn: () =>
            Deferred.await(login).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  minted = true;
                }),
              ),
            ),
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
                    [...workspaceStates].map(([name, status]) => ({
                      name,
                      latest_build: { status },
                    })),
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
              if (input.command === "coder" && input.args[0] === "start") {
                workspaceStates.set(input.args[1]!, "running");
              }
              if (
                (input.command === "coder" && input.args[0] === "start") ||
                (input.command === "coder" &&
                  input.args[0] === "ssh" &&
                  currentSettings.providerInstances[CURSOR_INSTANCE_ID]?.enabled === true)
              ) {
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
              if (input.command === "ssh" && input.args.at(-1)?.includes("CURSOR_API_KEY")) {
                yield* Queue.offer(cursorPushes, {
                  box: input.args.find((arg) => arg.startsWith("coder."))!.slice(6),
                  key: typeof input.stdin === "string" ? input.stdin : "",
                });
                return {
                  stdout: "installed",
                  stderr: "",
                  code: ChildProcessSpawner.ExitCode(0),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                };
              }
              if (input.command === "ssh" && input.args.at(-1)?.includes("oauth/token")) {
                const box = input.args.find((arg) => arg.startsWith("coder."))!.slice(6);
                yield* Queue.offer(relayed, box);
                if (signInDuringRelay) generation++;
                const answer = renewals?.[box] ?? "";
                if (answer.startsWith("stream:")) {
                  input.onStdoutChunk?.(new TextEncoder().encode(answer.slice(7)));
                  return yield* new ProcessRunner.ProcessTimeoutError({
                    command: "ssh",
                    argumentCount: input.args.length,
                    timeoutMs: 120_000,
                  });
                }
                return {
                  stdout: answer,
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
                yield* Queue.offer(
                  pushes,
                  input.args.find((arg) => arg.startsWith("coder."))!,
                );
                return {
                  stdout: JSON.stringify({ codex: unbound ? "unbound" : "installed" }),
                  stderr: "",
                  code: ChildProcessSpawner.ExitCode(0),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                };
              }
              const bind = input.args.indexOf("--enable-formal");
              if (input.command === "bash" && bind !== -1) {
                yield* Queue.offer(binds, input.args[bind + 1]!);
                unbound = false;
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
  return {
    service,
    launches,
    reads,
    login,
    setupAttempts,
    relayed,
    renewalDone,
    rejectedTokens,
    pushes,
    binds,
    cursorPushes,
    sleepBox: (box: string) =>
      Effect.sync(() => {
        workspaceStates.set(box, "stopped");
      }),
    rotateCursorKey: (key: string) =>
      Effect.suspend(() => {
        currentSettings = {
          ...currentSettings,
          providerInstances: {
            ...currentSettings.providerInstances,
            [CURSOR_INSTANCE_ID]: {
              driver: ProviderDriverKind.make("cursor"),
              enabled: true,
              environment: [{ name: "CURSOR_API_KEY", sensitive: true, value: key }],
            },
          },
        };
        return Queue.offer(settingsChanges, currentSettings);
      }),
  };
});

describe("devbox Cursor keys", () => {
  it.effect("pushes the configured key to running boxes and the latest key on wake", () =>
    Effect.gen(function* () {
      const { service, sleepBox, rotateCursorKey, cursorPushes } = yield* setup([
        spare("01-awake"),
        spare("02-asleep"),
      ]);
      yield* sleepBox("02-asleep");
      yield* rotateCursorKey("first-key");
      expect(yield* Queue.take(cursorPushes)).toEqual({ box: "01-awake", key: "first-key" });
      yield* rotateCursorKey("new-key");
      expect(yield* Queue.take(cursorPushes)).toEqual({ box: "01-awake", key: "new-key" });
      yield* service.wake("02-asleep");
      expect(yield* Queue.take(cursorPushes)).toEqual({ box: "02-asleep", key: "new-key" });
    }),
  );
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
      yield* service.startLogin("codex");
      yield* Deferred.succeed(login, undefined);
      const ready = yield* Fiber.join(waiting);
      expect(ready.credentials.codex).toBe("installed");
      expect(ready.loginRequired).toBeNull();
    }),
  );
  it.effect("binds a box that lacks Formal to it, then gives it the sign-in", () =>
    Effect.gen(function* () {
      const { service, login, binds } = yield* setup(
        [spare("01-ready", false)],
        false,
        undefined,
        undefined,
        false,
        true,
      );
      const waiting = yield* Effect.forkChild(
        service.awaitReady("01-ready", "1 minute", { waitForLogin: true }),
      );
      yield* service.startLogin("codex");
      yield* Deferred.succeed(login, undefined);
      const ready = yield* Fiber.join(waiting);
      expect(ready.credentials.codex).toBe("installed");
      expect(yield* Queue.takeAll(binds)).toEqual(["01-ready"]);
    }),
  );
  it.effect(
    "renews through the next box when one lacks Formal, and stops once the provider refuses",
    () =>
      Effect.gen(function* () {
        const cases = [
          {
            renewals: {
              "01-a": '{"error": "unbound"}',
              "02-b": '{"response": {"access_token": "new"}}',
            },
            relayed: ["01-a", "02-b"],
            rejected: [],
          },
          {
            renewals: {
              "01-a": '{"error": "rejected", "status": 400}',
              "02-b": '{"response": {}}',
            },
            relayed: ["01-a"],
            rejected: ["rt.1.codex"],
          },
          // A sealed token refused by one box may only have met a proxy that did not unseal it.
          {
            renewals: {
              "01-a": '{"error": "rejected", "status": 400}',
              "02-b": '{"response": {}}',
            },
            refreshToken: "formalsealed:v2:codex",
            relayed: ["01-a", "02-b"],
            rejected: [],
          },
          // The answer arrived before ssh hung; it carries the only live refresh token.
          {
            renewals: { "01-a": 'stream:{"response": {"access_token": "new"}}', "02-b": "" },
            relayed: ["01-a"],
            rejected: [],
          },
        ];
        for (const expected of cases) {
          const { service, login, relayed, renewalDone, rejectedTokens } = yield* setup(
            [spare("01-a"), spare("02-b")],
            false,
            expected.renewals,
            "refreshToken" in expected ? expected.refreshToken : undefined,
          );
          yield* service.startLogin("codex");
          yield* Deferred.succeed(login, undefined);
          yield* Deferred.await(renewalDone);
          expect(yield* Queue.takeAll(relayed)).toEqual(expected.relayed);
          expect(rejectedTokens).toEqual(expected.rejected);
        }
      }),
  );
  it.effect("drops a renewal's refusal when a new sign-in landed during it", () =>
    Effect.gen(function* () {
      const { service, login, pushes, rejectedTokens } = yield* setup(
        [spare("01-a")],
        false,
        { "01-a": '{"error": "rejected", "status": 400}' },
        undefined,
        true,
      );
      yield* service.startLogin("codex");
      yield* Deferred.succeed(login, undefined);
      // The sync pushes only after the renewal pass has reported.
      yield* Queue.take(pushes);
      expect(rejectedTokens).toEqual(["rt.1.codex"]);
      const codex = (yield* service.logins).find((entry) => entry.provider === "codex");
      expect(codex?.lastError).toBeNull();
    }),
  );
});
