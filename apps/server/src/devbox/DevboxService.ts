/**
 * Coder devboxes as environments of this one. Each box runs its own T3 server as a systemd user
 * service; this machine keeps an SSH forward from a fixed loopback port to it and a peer link
 * over that port, so the address never changes across sleep and wake. Boxes stop on Coder's
 * schedule; a running turn on a box extends it.
 */
import * as NodeOS from "node:os";

import {
  DevboxError,
  type DevboxCreateInput,
  type DevboxCredentialState,
  type DevboxState,
  type DevboxSummary,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { waitForHttpReady } from "@t3tools/shared/httpReadiness";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ProcessRunner from "../processRunner.ts";
import { forkParked } from "../serverActivation.ts";
import * as DevboxCredentialPool from "./DevboxCredentialPool.ts";
import {
  ACTIVE_RUN_SCRIPT,
  INSTALL_CREDENTIALS_SCRIPT,
  PAIR_SCRIPT,
  PROVISION_SCRIPT,
  REMOTE_T3_PORT,
  parseCoderList,
  parsePairingToken,
  slugifyDevboxName,
  uniqueDevboxName,
  type CoderWorkspace,
} from "./devboxScripts.ts";

const DevboxRecord = Schema.Struct({
  name: Schema.String,
  localPort: Schema.Number,
  environmentId: Schema.NullOr(Schema.String),
  task: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  credentials: Schema.Struct({
    claude: Schema.Literals(["installed", "pool-empty", "not-installed"]),
    codex: Schema.Literals(["installed", "pool-empty", "not-installed"]),
  }),
});
type DevboxRecord = typeof DevboxRecord.Type;
const DevboxFile = Schema.Struct({ devboxes: Schema.Array(DevboxRecord) });
const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(DevboxFile));
const encodeFile = Schema.encodeEffect(Schema.fromJsonString(DevboxFile));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

interface Transient {
  readonly state: DevboxState;
  readonly lastError: string | null;
}

export class DevboxService extends Context.Service<
  DevboxService,
  {
    readonly list: Effect.Effect<ReadonlyArray<DevboxSummary>, DevboxError>;
    /** Starts creating a box and returns at once; it shows as `creating` until linked. */
    readonly create: (input: DevboxCreateInput) => Effect.Effect<DevboxSummary, DevboxError>;
    /** Waits until the box is linked or failed, at most `timeout`. */
    readonly awaitReady: (
      name: string,
      timeout: Duration.Input,
    ) => Effect.Effect<DevboxSummary, DevboxError>;
    /** Starts a stopped box and reconnects it. Returns once its T3 server answers here. */
    readonly wake: (name: string) => Effect.Effect<DevboxSummary, DevboxError>;
    readonly stop: (name: string) => Effect.Effect<DevboxSummary, DevboxError>;
    readonly remove: (
      name: string,
      options: { readonly force: boolean },
    ) => Effect.Effect<void, DevboxError>;
    /** The devbox an environment id belongs to, if any. */
    readonly byEnvironment: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<DevboxSummary>, DevboxError>;
  }
>()("t3/devbox/DevboxService") {}

const PORT_BASE = 13800;
const KEEP_ALIVE_INTERVAL = Duration.minutes(10);
const KEEP_ALIVE_EXTENSION = "1h";
const CREATE_TIMEOUT = Duration.minutes(60);
const SSH_NOISE = /startup script|troubleshooting|incomplete/iu;

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : String(error);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const peerLinks = yield* PeerLinks.PeerLinks;
  const pool = yield* DevboxCredentialPool.DevboxCredentialPool;
  const httpClient = yield* HttpClient.HttpClient;

  const storePath = path.join(config.stateDir, "devboxes.json");
  const codezDir = yield* Config.String("T3CODE_DEVBOX_CODEZ_DIR").pipe(
    Config.withDefault(path.join(NodeOS.homedir(), "sandbox", "asana")),
  );
  const namePrefix = yield* Config.String("T3CODE_DEVBOX_NAME_PREFIX").pipe(
    Config.option,
    Effect.map(Option.getOrUndefined),
  );
  const pinnedT3Version = yield* Config.String("T3CODE_DEVBOX_T3_VERSION").pipe(Config.option);
  const records = yield* Ref.make<ReadonlyMap<string, DevboxRecord>>(new Map());
  const transient = yield* Ref.make<ReadonlyMap<string, Transient>>(new Map());
  const locks = yield* KeyedLock.make<string>();
  const tunnels = yield* FiberMap.make<string>();
  const creations = yield* FiberMap.make<string>();

  const devboxError = (reason: DevboxError["reason"]) => (cause: unknown) =>
    new DevboxError({ reason, message: errorText(cause) });

  // ── storage ──────────────────────────────────────────────────────────────
  const load = fs.readFileString(storePath).pipe(
    Effect.flatMap(decodeFile),
    Effect.map((file) => new Map(file.devboxes.map((record) => [record.name, record]))),
    Effect.orElseSucceed(() => new Map<string, DevboxRecord>()),
  );
  const save = Effect.fn("DevboxService.save")(
    function* () {
      const current = yield* Ref.get(records);
      const text = `${yield* encodeFile({ devboxes: [...current.values()] })}\n`;
      yield* fs.writeFileString(`${storePath}.tmp`, text);
      yield* fs.rename(`${storePath}.tmp`, storePath);
    },
    Effect.mapError(devboxError("storage")),
  );
  const putRecord = (record: DevboxRecord) =>
    Ref.update(records, (current) => new Map(current).set(record.name, record)).pipe(
      Effect.andThen(save()),
    );
  const getRecord = (name: string) =>
    Ref.get(records).pipe(
      Effect.flatMap((current) => {
        const record = current.get(name);
        return record
          ? Effect.succeed(record)
          : Effect.fail(
              new DevboxError({ reason: "not_found", message: `No devbox named ${name}.` }),
            );
      }),
    );
  const setTransient = (name: string, value: Transient | undefined) =>
    Ref.update(transient, (current) => {
      const next = new Map(current);
      if (value === undefined) next.delete(name);
      else next.set(name, value);
      return next;
    });

  // ── processes ────────────────────────────────────────────────────────────
  const run = (
    command: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly stdin?: string;
      readonly timeout?: Duration.Input;
      readonly cwd?: string;
    },
  ) =>
    runner
      .run({
        command,
        args,
        ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        timeout: options?.timeout ?? "2 minutes",
        // `z` opens the Coder page and SSO in a browser; the user does not need either here.
        env: { BROWSER: "true" },
      })
      .pipe(
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed(result.stdout)
            : Effect.fail(
                `${command} ${args[0] ?? ""} exited with ${String(result.code)}: ${
                  result.stderr
                    .split("\n")
                    .filter((line) => !SSH_NOISE.test(line))
                    .join("\n")
                    .trim()
                    .slice(-800) || result.stdout.trim().slice(-800)
                }`,
              ),
        ),
      );
  const coder = (args: ReadonlyArray<string>, timeout?: Duration.Input) =>
    run("coder", args, { timeout: timeout ?? "5 minutes" }).pipe(
      Effect.mapError(devboxError("coder")),
    );
  /** `remote` is one shell command line; ssh would join separate words with spaces anyway. */
  const ssh = (name: string, remote: string, stdin?: string, timeout?: Duration.Input) =>
    run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=30", `coder.${name}`, remote], {
      ...(stdin === undefined ? {} : { stdin }),
      timeout: timeout ?? "5 minutes",
    }).pipe(Effect.mapError(devboxError("provision")));

  const workspaces = coder(["list", "--output", "json"], "1 minute").pipe(
    Effect.flatMap((stdout) =>
      Effect.try({ try: () => parseCoderList(stdout), catch: devboxError("coder") }),
    ),
    Effect.map((list) => new Map(list.map((workspace) => [workspace.name, workspace]))),
  );

  const t3Version = Option.isSome(pinnedT3Version)
    ? Effect.succeed(pinnedT3Version.value)
    : environment.getDescriptor.pipe(Effect.map((descriptor) => descriptor.serverVersion));

  // ── summaries ────────────────────────────────────────────────────────────
  const coderState = (workspace: CoderWorkspace | undefined): DevboxState => {
    switch (workspace?.latest_build.status) {
      case undefined:
        return "missing";
      case "running":
        return "running";
      case "starting":
      case "pending":
        return "starting";
      case "stopping":
        return "stopping";
      case "deleting":
      case "deleted":
        return "deleting";
      case "failed":
        return "failed";
      default:
        return "stopped";
    }
  };
  const summarize = (
    record: DevboxRecord,
    workspace: CoderWorkspace | undefined,
    current: Transient | undefined,
  ): DevboxSummary => ({
    name: record.name,
    state: current?.state ?? coderState(workspace),
    environmentId: record.environmentId as EnvironmentId | null,
    url: `http://127.0.0.1:${record.localPort}`,
    task: record.task,
    createdAt: record.createdAt,
    deadline: workspace?.latest_build.deadline ?? null,
    credentials: record.credentials,
    lastError: current?.lastError ?? null,
  });
  const summaryOf = Effect.fn("DevboxService.summaryOf")(function* (name: string) {
    const record = yield* getRecord(name);
    const all = yield* workspaces.pipe(
      Effect.orElseSucceed(() => new Map<string, CoderWorkspace>()),
    );
    return summarize(record, all.get(name), (yield* Ref.get(transient)).get(name));
  });

  const list: DevboxService["Service"]["list"] = Effect.gen(function* () {
    const all = yield* workspaces;
    const current = yield* Ref.get(transient);
    return [...(yield* Ref.get(records)).values()].map((record) =>
      summarize(record, all.get(record.name), current.get(record.name)),
    );
  }).pipe(Effect.withSpan("DevboxService.list"));

  // ── tunnel and link ──────────────────────────────────────────────────────
  const forward = (record: DevboxRecord) =>
    run(
      "ssh",
      [
        "-N",
        "-o",
        "BatchMode=yes",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-L",
        `127.0.0.1:${record.localPort}:127.0.0.1:${REMOTE_T3_PORT}`,
        `coder.${record.name}`,
      ],
      { timeout: Duration.infinity },
    ).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("devbox forward exited", { name: record.name, error }),
      ),
      // The forward lives while the box runs; a stopped box ends it until the next wake.
      Effect.retry(Schedule.spaced("5 seconds")),
      Effect.ignore,
    );
  const startTunnel = (record: DevboxRecord) =>
    FiberMap.run(tunnels, record.name, forward(record), { onlyIfMissing: true }).pipe(
      Effect.andThen(
        waitForHttpReady({
          baseUrl: `http://127.0.0.1:${record.localPort}`,
          path: "/.well-known/t3/environment",
          timeoutMs: 120_000,
          intervalMs: 1_000,
          makeError: ({ cause }) =>
            new DevboxError({
              reason: "provision",
              message: `The devbox's T3 server did not answer here: ${errorText(cause)}`,
            }),
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
      ),
    );

  const link = Effect.fn("DevboxService.link")(function* (record: DevboxRecord, version: string) {
    if (record.environmentId !== null) {
      const existing = yield* peerLinks
        .get(record.environmentId as EnvironmentId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isSome(existing)) return record;
    }
    const label = (yield* environment.getDescriptor).label;
    const paired = yield* ssh(
      record.name,
      `sh -s -- ${shellQuote(version)} ${shellQuote(label)}`,
      PAIR_SCRIPT,
    );
    const pairingCode = parsePairingToken(paired);
    if (!pairingCode)
      return yield* new DevboxError({
        reason: "link",
        message: "The box did not return a pairing code.",
      });
    const linked = yield* peerLinks
      .link({
        url: `http://127.0.0.1:${record.localPort}`,
        pairingCode,
        access: "full-access",
        expectedLabel: record.name,
      })
      .pipe(Effect.mapError(devboxError("link")));
    const next = { ...record, environmentId: linked.environmentId };
    yield* putRecord(next);
    return next;
  });

  // ── provisioning ─────────────────────────────────────────────────────────
  const installCredentials = Effect.fn("DevboxService.installCredentials")(function* (
    record: DevboxRecord,
  ) {
    const claim = yield* pool.claim(record.name).pipe(Effect.mapError(devboxError("provision")));
    const payload = {
      claude: Option.getOrNull(claim.claude),
      codex: Option.getOrNull(claim.codex),
    };
    if (payload.claude !== null || payload.codex !== null) {
      const body = yield* encodeJson(payload).pipe(Effect.mapError(devboxError("provision")));
      yield* ssh(record.name, `python3 -c ${shellQuote(INSTALL_CREDENTIALS_SCRIPT)}`, body);
      yield* claim.commit.pipe(Effect.mapError(devboxError("provision")));
    }
    const state = (claimed: Option.Option<unknown>): DevboxCredentialState =>
      Option.isSome(claimed) ? "installed" : "pool-empty";
    const next = {
      ...record,
      credentials: { claude: state(claim.claude), codex: state(claim.codex) },
    };
    yield* putRecord(next);
    return next;
  });

  /** Brings a running box to linked: T3 service, forward, link. Safe to repeat. */
  const connect = Effect.fn("DevboxService.connect")(function* (record: DevboxRecord) {
    yield* coder(["ssh", "--wait=yes", record.name, "--", "true"], "15 minutes");
    const version = yield* t3Version;
    yield* ssh(
      record.name,
      `sh -s -- ${shellQuote(version)} ${shellQuote(record.name)}`,
      PROVISION_SCRIPT,
      "15 minutes",
    );
    yield* startTunnel(record);
    return yield* link(record, version);
  });

  const provision = Effect.fn("DevboxService.provision")(function* (
    record: DevboxRecord,
    branch: string | undefined,
  ) {
    yield* setTransient(record.name, { state: "creating", lastError: null });
    const args = [
      "devbox",
      "create",
      "-n",
      record.name,
      "--parameter",
      "watcher_enabled=true",
      ...(branch ? ["--branch", branch] : []),
    ];
    yield* run(
      "bash",
      [
        "-c",
        `source admin/mac.bashrc >/dev/null 2>&1; exec asana2/asana/tools/zoe/bin/z ${args.map(shellQuote).join(" ")}`,
      ],
      { cwd: codezDir, timeout: CREATE_TIMEOUT },
    ).pipe(Effect.mapError(devboxError("coder")));
    yield* coder(["autoupdate", record.name, "always"]).pipe(Effect.ignore);
    yield* coder(["ssh", "--wait=yes", record.name, "--", "true"], "30 minutes");
    const withCredentials = yield* installCredentials(record);
    yield* connect(withCredentials);
    yield* setTransient(record.name, undefined);
  });

  const nextPort = Effect.gen(function* () {
    const used = new Set([...(yield* Ref.get(records)).values()].map((record) => record.localPort));
    let port = PORT_BASE;
    while (used.has(port)) port++;
    return port;
  });

  const create: DevboxService["Service"]["create"] = Effect.fn("DevboxService.create")(
    function* (input) {
      const requested =
        input.name ?? input.task ?? `task-${(yield* Clock.currentTimeMillis).toString(36)}`;
      const taken = new Set([...(yield* workspaces).keys(), ...(yield* Ref.get(records)).keys()]);
      const name = uniqueDevboxName(slugifyDevboxName(requested, namePrefix), taken);
      const record: DevboxRecord = {
        name,
        localPort: yield* nextPort,
        environmentId: null,
        task: input.task ?? null,
        createdAt: DateTime.formatIso(yield* DateTime.now),
        credentials: { claude: "not-installed", codex: "not-installed" },
      };
      yield* putRecord(record);
      yield* setTransient(name, { state: "creating", lastError: null });
      yield* FiberMap.run(
        creations,
        name,
        locks
          .withLock(name, provision(record, input.branch))
          .pipe(
            Effect.catchCause((cause) =>
              setTransient(name, { state: "failed", lastError: errorText(cause) }).pipe(
                Effect.andThen(Effect.logWarning("devbox create failed", { name, cause })),
              ),
            ),
          ),
      );
      return yield* summaryOf(name);
    },
  );

  const awaitReady: DevboxService["Service"]["awaitReady"] = Effect.fn("DevboxService.awaitReady")(
    function* (name, timeout) {
      const settled = summaryOf(name).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (summary) => summary.state !== "creating" && summary.state !== "starting",
        }),
      );
      return yield* settled.pipe(
        Effect.timeoutOption(timeout),
        Effect.flatMap((result) =>
          Option.isSome(result) ? Effect.succeed(result.value) : summaryOf(name),
        ),
      );
    },
  );

  const wake: DevboxService["Service"]["wake"] = Effect.fn("DevboxService.wake")(function* (name) {
    const record = yield* getRecord(name);
    yield* locks.withLock(
      name,
      Effect.gen(function* () {
        yield* setTransient(name, { state: "starting", lastError: null });
        const workspace = (yield* workspaces).get(name);
        if (workspace?.latest_build.status !== "running")
          yield* coder(["start", name, "--yes"], "15 minutes");
        yield* connect(record);
        yield* setTransient(name, undefined);
      }).pipe(
        Effect.tapError((error) =>
          setTransient(name, { state: "failed", lastError: error.message }),
        ),
      ),
    );
    return yield* summaryOf(name);
  });

  const stop: DevboxService["Service"]["stop"] = Effect.fn("DevboxService.stop")(function* (name) {
    yield* getRecord(name);
    yield* locks.withLock(
      name,
      FiberMap.remove(tunnels, name).pipe(
        Effect.andThen(coder(["stop", name, "--yes"], "10 minutes")),
      ),
    );
    return yield* summaryOf(name);
  });

  const hasActiveRun = (name: string) =>
    ssh(name, `python3 -c ${shellQuote(ACTIVE_RUN_SCRIPT)}`, undefined, "1 minute").pipe(
      Effect.map((stdout) => stdout.trim().endsWith("1")),
    );

  const remove: DevboxService["Service"]["remove"] = Effect.fn("DevboxService.remove")(
    function* (name, options) {
      const record = yield* getRecord(name);
      yield* FiberMap.remove(creations, name);
      yield* locks.withLock(
        name,
        Effect.gen(function* () {
          const workspace = (yield* workspaces).get(name);
          if (!options.force && workspace?.latest_build.status === "running") {
            const busy = yield* hasActiveRun(name).pipe(Effect.orElseSucceed(() => false));
            if (busy)
              return yield* new DevboxError({
                reason: "busy",
                message: `${name} has a turn running. Stop it first, or delete with force.`,
              });
          }
          yield* setTransient(name, { state: "deleting", lastError: null });
          yield* FiberMap.remove(tunnels, name);
          if (record.environmentId !== null)
            yield* peerLinks.unlink(record.environmentId as EnvironmentId).pipe(Effect.ignore);
          if (workspace !== undefined) yield* coder(["delete", name, "--yes"], "15 minutes");
          yield* pool.release(name);
          yield* Ref.update(records, (current) => {
            const next = new Map(current);
            next.delete(name);
            return next;
          });
          yield* save();
          yield* setTransient(name, undefined);
        }),
      );
    },
  );

  const byEnvironment: DevboxService["Service"]["byEnvironment"] = (environmentId) =>
    Ref.get(records).pipe(
      Effect.flatMap((current) => {
        const record = [...current.values()].find((entry) => entry.environmentId === environmentId);
        return record ? summaryOf(record.name).pipe(Effect.asSome) : Effect.succeedNone;
      }),
    );

  // ── background: reconnect running boxes, keep busy boxes awake ───────────
  yield* Ref.set(records, yield* load);
  const reconnect = Effect.gen(function* () {
    const all = yield* workspaces;
    for (const record of (yield* Ref.get(records)).values()) {
      if (all.get(record.name)?.latest_build.status !== "running") continue;
      yield* locks
        .withLock(record.name, connect(record))
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("devbox reconnect failed", { name: record.name, cause }),
          ),
        );
    }
  });
  const keepAwake = Effect.gen(function* () {
    const all = yield* workspaces;
    for (const record of (yield* Ref.get(records)).values()) {
      if (all.get(record.name)?.latest_build.status !== "running") continue;
      const busy = yield* hasActiveRun(record.name).pipe(Effect.orElseSucceed(() => false));
      if (busy)
        yield* coder(["schedule", "extend", record.name, KEEP_ALIVE_EXTENSION]).pipe(Effect.ignore);
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("devbox keep-awake failed", { cause })),
    Effect.repeat(Schedule.spaced(KEEP_ALIVE_INTERVAL)),
  );
  yield* forkParked(
    reconnect.pipe(
      Effect.catchCause((cause) => Effect.logWarning("devbox reconnect failed", { cause })),
      Effect.andThen(keepAwake),
    ),
  );

  return DevboxService.of({ list, create, awaitReady, wake, stop, remove, byEnvironment });
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export const layer = Layer.effect(DevboxService, make).pipe(
  Layer.provide(DevboxCredentialPool.layer),
  Layer.provide(FetchHttpClient.layer),
);
