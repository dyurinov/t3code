/**
 * Coder devboxes as environments of this one. Each box runs its own T3 server as a systemd user
 * service; this machine keeps an SSH forward from a fixed loopback port to it and a peer link
 * over that port, so the address never changes across sleep and wake. Boxes stop on Coder's
 * schedule; a running turn on a box extends it.
 */
import * as NodeOS from "node:os";

import {
  DevboxError,
  EnvironmentId as EnvironmentIdSchema,
  ProviderDriverKind,
  ProviderInstanceEnvironmentVariableName,
  ProviderInstanceId,
  UsageDay,
  type DeletedDevbox,
  type DevboxClientPairing,
  type DevboxCreateInput,
  type DevboxDeleteResult,
  type DevboxLogin,
  type DevboxLoginProvider,
  type DevboxCredentialState,
  type DevboxState,
  type DevboxSummary,
  type DevboxUsageInput,
  type DevboxUsageResult,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ServerSettings,
  WS_METHODS,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as NetService from "@t3tools/shared/Net";
import { waitForHttpReady } from "@t3tools/shared/httpReadiness";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as ServerConfig from "../config.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderCredentialStore from "../provider/ProviderCredentialStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as DevboxLogins from "./DevboxLogins.ts";
import * as DevboxThreadMigration from "./DevboxThreadMigration.ts";
import * as DevboxUsageArchive from "./DevboxUsageArchive.ts";
import * as DevboxVertexMetadata from "./DevboxVertexMetadata.ts";
import { environmentRpc } from "./devboxRpc.ts";
import {
  ACTIVE_RUN_SCRIPT,
  EXPORT_DEVBOX_USAGE_SCRIPT,
  FENCE_T3_SCRIPT,
  INSTALL_CREDENTIALS_SCRIPT,
  INSTALL_PERSONALIZATION_SCRIPT,
  PREPARE_ANTIGRAVITY_SCRIPT,
  REFRESH_LOGIN_SCRIPT,
  PAIR_SCRIPT,
  PROVISION_REVISION,
  PROVISION_SCRIPT,
  REMOTE_T3_PORT,
  HOST_PORT_ON_BOX,
  VERTEX_METADATA_PORT_ON_BOX,
  LINK_TOKEN_SCRIPT,
  SETTINGS_TOKEN_SCRIPT,
  SIBLING_REMOVE_SCRIPT,
  SIBLING_SCRIPT,
  USAGE_TOKEN_SCRIPT,
  parseCoderList,
  isCurrentProvisionRevision,
  parsePairingToken,
  CoderBuild,
  devboxSpans,
  goneFromCoder,
  hoursWithin,
  nextDevboxNumber,
  shownDevboxState,
  type TimeSpan,
  randomDevboxName,
  BROWSER_FILTER_SCRIPT,
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
  // `pool-empty` is what the per-box login pool wrote; it reads as `no-login`.
  credentials: Schema.Struct({
    claude: Schema.Literals(["installed", "not-installed", "no-login", "unbound", "pool-empty"]),
    codex: Schema.Literals(["installed", "not-installed", "no-login", "unbound", "pool-empty"]),
  }),
  /** Prepared ahead of time, waiting for `claim`. */
  spare: Schema.optionalKey(Schema.Boolean),
  /** Which provisioning script last set the box up; a newer one runs again on connect. */
  provisioned: Schema.optionalKey(Schema.String),
  /** True while this host manages the box's Antigravity instance; cleared only once cleanup succeeds. */
  antigravityManaged: Schema.optionalKey(Schema.Boolean),
});
type DevboxRecord = typeof DevboxRecord.Type;
const Span = Schema.Tuple([Schema.Number, Schema.Number]);
const DeletedDevboxRecord = Schema.Struct({
  name: Schema.String,
  environmentId: Schema.optionalKey(Schema.String),
  awake: Schema.Array(Span),
  existed: Span,
});
type DeletedDevboxRecord = typeof DeletedDevboxRecord.Type;
const decodeBuilds = Schema.decodeUnknownEffect(Schema.Array(CoderBuild));
const decodeWhoami = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ url: Schema.String }))),
);

// AWS list prices in eu-central-1, where the boxes run: r8i.4xlarge, 200 GiB gp3, one IPv4.
const DISK_RATE = (200 * 0.0952) / 730;
const AWAKE_RATE = 1.3406 + 0.005 + DISK_RATE;
const USAGE_TOKEN_NAME = "t3-devbox-usage";

const DevboxFile = Schema.Struct({
  devboxes: Schema.Array(DevboxRecord),
  /** The number the next box gets; numbers are never reused, even after a delete. */
  nextNumber: Schema.optionalKey(Schema.Number),
  /** Deleted boxes' running and lifetime spans; Coder forgets a box's builds once it is gone. */
  history: Schema.optionalKey(Schema.Array(DeletedDevboxRecord)),
});
const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(DevboxFile));
const encodeFile = Schema.encodeEffect(Schema.fromJsonString(DevboxFile));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeDescriptor = Schema.decodeUnknownEffect(
  Schema.Struct({ environmentId: EnvironmentIdSchema }),
);
const decodeCursorCredentials = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ apiKey: Schema.String, apiKeyExpiresAtMs: Schema.optionalKey(Schema.Finite) }),
  ),
);
const decodeDescriptorId = (value: unknown) =>
  decodeDescriptor(value).pipe(Effect.map((descriptor) => descriptor.environmentId));

const decodeRelayOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      response: Schema.optionalKey(Schema.Unknown),
      error: Schema.optionalKey(Schema.Literals(["unbound", "rejected", "unreachable"])),
      status: Schema.optionalKey(Schema.Number),
    }),
  ),
);
const decodeInstallResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      claude: Schema.optionalKey(Schema.Literals(["installed", "unbound", "failed"])),
      codex: Schema.optionalKey(Schema.Literals(["installed", "unbound", "failed"])),
    }),
  ),
);

interface Transient {
  readonly state: DevboxState;
  readonly lastError: string | null;
}

export class DevboxService extends Context.Service<
  DevboxService,
  {
    readonly list: Effect.Effect<ReadonlyArray<DevboxSummary>, DevboxError>;
    /** This machine's sign-in per provider, which every devbox gets an access token from. */
    readonly logins: Effect.Effect<ReadonlyArray<DevboxLogin>>;
    /** Starts signing in, replacing the current sign-in once the browser approves it. */
    readonly startLogin: (provider: DevboxLoginProvider) => Effect.Effect<DevboxLogin>;
    readonly cancelLogin: (provider: DevboxLoginProvider) => Effect.Effect<DevboxLogin>;
    /** Forgets the sign-in. Boxes keep the access token they hold until it runs out. */
    readonly signOut: (provider: DevboxLoginProvider) => Effect.Effect<DevboxLogin>;
    readonly submitLoginCode: (
      provider: "claude" | "codex",
      code: string,
    ) => Effect.Effect<void, DevboxError>;
    /** Claims a spare or starts creating a box, returning without waiting for setup. */
    readonly create: (input: DevboxCreateInput) => Effect.Effect<DevboxSummary, DevboxError>;
    /** Waits for setup and optionally a login, at most `timeout`. */
    readonly awaitReady: (
      name: string,
      timeout: Duration.Input,
      options?: { readonly waitForLogin: boolean },
    ) => Effect.Effect<DevboxSummary, DevboxError>;
    /** Starts waking a stopped box and returns at once in state `starting`. */
    readonly wake: (name: string) => Effect.Effect<DevboxSummary, DevboxError>;
    readonly stop: (name: string) => Effect.Effect<DevboxSummary, DevboxError>;
    readonly remove: (
      name: string,
      options: { readonly force: boolean; readonly skipMigration?: boolean },
    ) => Effect.Effect<DevboxDeleteResult, DevboxError>;
    /**
     * Takes a prepared spare (or creates a box when there is none), wakes and links it, and
     * returns a one-time code for this client. Starts preparing the next spare.
     */
    readonly claim: Effect.Effect<DevboxClientPairing & { readonly name: string }, DevboxError>;
    /** A one-time code for a client to connect to the box at its loopback URL. */
    readonly pairClient: (name: string) => Effect.Effect<DevboxClientPairing, DevboxError>;
    /** Boxes T3 deleted, so every client can drop its saved environment for them. */
    readonly deleted: Effect.Effect<ReadonlyArray<DeletedDevbox>>;
    /** Each box's running and stopped time inside the window, with an estimated cost. */
    readonly usage: (input: DevboxUsageInput) => Effect.Effect<DevboxUsageResult, DevboxError>;
    /** The devbox an environment id belongs to, if any. */
    readonly byEnvironment: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<DevboxSummary>, DevboxError>;
  }
>()("t3/devbox/DevboxService") {}

const PORT_BASE = 13800;
const HOST_LINK_ACCESS = "auto";
const CURSOR_INSTANCE_ID = ProviderInstanceId.make("cursor");
const CURSOR_DRIVER_KIND = ProviderDriverKind.make("cursor");
const CURSOR_API_KEY_ENV_NAME = ProviderInstanceEnvironmentVariableName.make("CURSOR_API_KEY");
const ANTIGRAVITY_INSTANCE_ID = ProviderInstanceId.make("antigravity");
const ANTIGRAVITY_DRIVER_KIND = ProviderDriverKind.make("antigravity");
const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const USAGE_ACCESS_SYNC_DRIVERS = [
  CODEX_DRIVER_KIND,
  CLAUDE_DRIVER_KIND,
  CURSOR_DRIVER_KIND,
  ANTIGRAVITY_DRIVER_KIND,
] as const;
const VERTEX_METADATA_ENV_NAME = ProviderInstanceEnvironmentVariableName.make("GCE_METADATA_HOST");
const VERTEX_OWNER_ENV_NAME =
  ProviderInstanceEnvironmentVariableName.make("T3_DEVBOX_VERTEX_OWNER");
const VERTEX_METADATA_HOST_ON_BOX = `127.0.0.1:${VERTEX_METADATA_PORT_ON_BOX}`;
const KEEP_ALIVE_INTERVAL = Duration.minutes(10);
const LOGIN_SYNC_INTERVAL = Duration.minutes(10);
const KEEP_ALIVE_EXTENSION = "1h";
const CREATE_TIMEOUT = Duration.minutes(60);
const BIND_RETRY_AFTER = Duration.minutes(30);
const SSH_NOISE = /startup script|troubleshooting|incomplete/iu;

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : String(error);

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const peerLinks = yield* PeerLinks.PeerLinks;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const logins = yield* DevboxLogins.DevboxLogins;
  const threadMigration = yield* DevboxThreadMigration.DevboxThreadMigration;
  const vertexMetadata = yield* DevboxVertexMetadata.DevboxVertexMetadata;
  const settings = yield* ServerSettingsService.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const httpClient = yield* HttpClient.HttpClient;
  const net = yield* NetService.NetService;

  const storePath = path.join(config.stateDir, "devboxes.json");
  const codezDir = yield* Config.String("T3CODE_DEVBOX_CODEZ_DIR").pipe(
    Config.withDefault(path.join(NodeOS.homedir(), "sandbox", "asana")),
  );
  const namePrefix = yield* Config.String("T3CODE_DEVBOX_NAME_PREFIX").pipe(
    Config.option,
    Effect.map(Option.getOrUndefined),
  );
  const pinnedT3Version = yield* Config.String("T3CODE_DEVBOX_T3_VERSION").pipe(Config.option);
  const pythonPath = yield* Config.String("PYTHONPATH").pipe(Config.withDefault(""));
  // How many prepared boxes to keep waiting. Off unless set, so dev servers never create boxes.
  const spareCount = yield* Config.Int("T3CODE_DEVBOX_SPARES").pipe(Config.withDefault(0));
  const browserFilter = path.join(config.stateDir, "devbox-browser.sh");
  yield* fs
    .writeFileString(browserFilter, BROWSER_FILTER_SCRIPT, { mode: 0o755 })
    .pipe(Effect.ignore);
  const records = yield* Ref.make<ReadonlyMap<string, DevboxRecord>>(new Map());
  const changes = yield* PubSub.unbounded<void>();
  const allocation = yield* Semaphore.make(1);
  const nextNumber = yield* Ref.make<number | undefined>(undefined);
  const history = yield* Ref.make<ReadonlyArray<DeletedDevboxRecord>>([]);
  const transient = yield* Ref.make<ReadonlyMap<string, Transient>>(new Map());
  const locks = yield* KeyedLock.make<string>();
  const tunnels = yield* FiberMap.make<string>();
  const vertexTunnels = yield* FiberMap.make<string>();
  const antigravitySyncs = yield* FiberMap.make<string>();
  const creations = yield* FiberMap.make<string>();
  const background = yield* FiberSet.make();
  const loginWorkers = yield* FiberMap.make<DevboxLoginProvider>();
  const loginErrors = yield* Ref.make<Record<DevboxLoginProvider, string | null>>({
    claude: null,
    codex: null,
  });
  // The access tokens each box last got, so the sync only writes to boxes that are behind.
  const pushed = new Map<string, string>();
  const pushedCursorKeys = new Map<string, string>();
  const pushedUsageAccess = new Map<string, string>();
  const pushedAntigravity = new Map<
    string,
    { readonly key: string; readonly outcome: "enabled" | "declined" }
  >();
  // Box names whose `antigravityManaged: true` flag is confirmed persisted to devboxes.json.
  const persistedAntigravityManaged = new Set<string>();
  // The last renewal outcomes, so a box left with no usable token says why: the provider
  // refused the sign-in (user signs in again), or the box has no Formal (user binds it).
  const refused = new Set<DevboxLoginProvider>();
  const unboundBoxes = new Set<string>();
  const bindAttempts = new Map<string, number>();

  const devboxError = (reason: DevboxError["reason"]) => (cause: unknown) =>
    new DevboxError({ reason, message: errorText(cause) });

  // ── storage ──────────────────────────────────────────────────────────────
  const load = fs.readFileString(storePath).pipe(
    Effect.flatMap(decodeFile),
    Effect.orElseSucceed((): typeof DevboxFile.Type => ({ devboxes: [] })),
  );
  // Snapshot, write and rename as one step: two saves at once would share the temp file.
  const storeLock = yield* Semaphore.make(1);
  const save = Effect.fn("DevboxService.save")(
    function* () {
      const current = yield* Ref.get(records);
      const number = yield* Ref.get(nextNumber);
      const deleted = yield* Ref.get(history);
      const text = `${yield* encodeFile({
        devboxes: [...current.values()],
        ...(number === undefined ? {} : { nextNumber: number }),
        ...(deleted.length === 0 ? {} : { history: deleted }),
      })}\n`;
      yield* fs.writeFileString(`${storePath}.tmp`, text);
      yield* fs.rename(`${storePath}.tmp`, storePath);
    },
    (effect) => storeLock.withPermits(1)(effect),
    Effect.mapError(devboxError("storage")),
  );
  const putRecord = (record: DevboxRecord) =>
    Ref.update(records, (current) => new Map(current).set(record.name, record)).pipe(
      Effect.andThen(save()),
      Effect.tap(() => PubSub.publish(changes, undefined)),
    );
  // Background setup, the sign-in handout and claims all touch the same record; each changes
  // only its own fields on the current copy, so none of them undoes another.
  const updateRecord = (name: string, change: (record: DevboxRecord) => DevboxRecord) =>
    Ref.modify(records, (current) => {
      const existing = current.get(name);
      if (existing === undefined) return [undefined, current] as const;
      const next = change(existing);
      return [next, new Map(current).set(name, next)] as const;
    }).pipe(
      Effect.flatMap((next) =>
        next === undefined
          ? Effect.fail(
              new DevboxError({ reason: "not_found", message: `No devbox named ${name}.` }),
            )
          : save().pipe(Effect.andThen(PubSub.publish(changes, undefined)), Effect.as(next)),
      ),
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
    }).pipe(Effect.tap(() => PubSub.publish(changes, undefined)));

  // ── processes ────────────────────────────────────────────────────────────
  const run = (
    command: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly stdin?: string;
      readonly timeout?: Duration.Input;
      readonly cwd?: string;
      readonly env?: NodeJS.ProcessEnv;
    },
  ) =>
    runner
      .run({
        command,
        args,
        ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        timeout: options?.timeout ?? "2 minutes",
        env: { BROWSER: browserFilter, ...options?.env },
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
  const z = (args: ReadonlyArray<string>, timeout: Duration.Input) =>
    run(
      "bash",
      [
        "-c",
        'source "$CODEZ/admin/mac.bashrc" >/dev/null 2>&1; exec "$CODEZ/asana2/asana/tools/zoe/bin/z" "$@"',
        "t3-devbox",
        ...args,
      ],
      {
        cwd: codezDir,
        timeout,
        env: {
          CODEZ: codezDir,
          PYTHONPATH: [codezDir, pythonPath].filter(Boolean).join(":"),
        },
      },
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

  const MAX_SSH_BINARY_BYTES = 256 * 1024 * 1024;
  const sshBinary = Effect.fn("DevboxService.sshBinary")(function* (
    name: string,
    remote: string,
    options?: { readonly stdin?: string; readonly timeout?: Duration.Input },
  ) {
    const chunks: Array<Uint8Array> = [];
    let totalBytes = 0;
    let overflow = false;
    const overflowSignal = yield* Deferred.make<never, DevboxError>();
    const runProcess = runner
      .run({
        command: "ssh",
        args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=30", `coder.${name}`, remote],
        ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
        timeout: options?.timeout ?? "5 minutes",
        env: { BROWSER: browserFilter },
        maxOutputBytes: 4096,
        outputMode: "truncate",
        onStdoutChunk: (chunk) => {
          if (overflow) return;
          totalBytes += chunk.byteLength;
          if (totalBytes > MAX_SSH_BINARY_BYTES) {
            overflow = true;
            chunks.length = 0;
            Deferred.doneUnsafe(
              overflowSignal,
              Effect.fail(
                devboxError("migration")(
                  `ssh output from ${name} exceeded ${MAX_SSH_BINARY_BYTES} bytes.`,
                ),
              ),
            );
            return;
          }
          chunks.push(chunk.slice());
        },
      })
      .pipe(Effect.mapError(devboxError("provision")));

    const result = yield* Effect.raceFirst(runProcess, Deferred.await(overflowSignal));
    if (overflow) {
      return yield* new DevboxError({
        reason: "migration",
        message: `ssh output from ${name} exceeded ${MAX_SSH_BINARY_BYTES} bytes.`,
      });
    }
    if (result.code !== 0) {
      const stderr = result.stderr
        .split("\n")
        .filter((line) => !SSH_NOISE.test(line))
        .join("\n")
        .trim()
        .slice(-800);
      if (result.code === 42 && stderr.includes("ACTIVE_RUNS:")) {
        return yield* new DevboxError({
          reason: "busy",
          message: `${name} has an active turn. Stop it first, or delete with force.`,
        });
      }
      return yield* new DevboxError({
        reason: "provision",
        message: stderr
          ? `ssh ${name} exited with ${String(result.code)}: ${stderr}`
          : `ssh ${name} exited with ${String(result.code)}.`,
      });
    }
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    chunks.length = 0;
    return combined;
  });

  const workspaces = coder(["list", "--output", "json"], "1 minute").pipe(
    Effect.flatMap((stdout) =>
      Effect.try({ try: () => parseCoderList(stdout), catch: devboxError("coder") }),
    ),
    Effect.map((list) => new Map(list.map((workspace) => [workspace.name, workspace]))),
  );

  // Boxes download T3 from upstream releases, which never carry this fork's own version.
  const t3Version = Effect.succeed(Option.getOrElse(pinnedT3Version, () => "latest-nightly"));

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
    state: shownDevboxState(current?.state, coderState(workspace)),
    environmentId: record.environmentId as EnvironmentId | null,
    url: `http://127.0.0.1:${record.localPort}`,
    task: record.task,
    spare: record.spare === true,
    createdAt: record.createdAt,
    deadline: workspace?.latest_build.deadline ?? null,
    credentials: {
      claude: shownCredential(record.credentials.claude),
      codex: shownCredential(record.credentials.codex),
    },
    loginRequired:
      shownCredential(record.credentials.claude) === "no-login" &&
      shownCredential(record.credentials.codex) === "no-login"
        ? {
            settingsUrl: "/settings/devboxes",
          }
        : null,
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
  const sshForward = (record: DevboxRecord, spec: ReadonlyArray<string>) =>
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
        ...spec,
        `coder.${record.name}`,
      ],
      { timeout: Duration.infinity },
    ).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("devbox forward exited", { name: record.name, spec, error }),
      ),
      // The forward lives while the box runs; a stopped box ends it until the next wake.
      Effect.retry(Schedule.spaced("5 seconds")),
      Effect.ignore,
    );
  const forward = (record: DevboxRecord) =>
    sshForward(record, ["-L", `127.0.0.1:${record.localPort}:127.0.0.1:${REMOTE_T3_PORT}`]);
  // Separate from `forward`: a box port still held by an old session must not take down the
  // forward this machine depends on.
  const reverse = (record: DevboxRecord) =>
    sshForward(record, ["-R", `127.0.0.1:${HOST_PORT_ON_BOX}:127.0.0.1:${config.port}`]);
  // Only this box's own environment counts: another box (or T3) may hold the port.
  const answersHere = (record: DevboxRecord) =>
    record.environmentId === null
      ? Effect.succeed(false)
      : httpClient.get(`http://127.0.0.1:${record.localPort}/.well-known/t3/environment`).pipe(
          Effect.flatMap((response) => response.json),
          Effect.flatMap(decodeDescriptorId),
          Effect.map((environmentId) => environmentId === record.environmentId),
          Effect.timeout("3 seconds"),
          Effect.orElseSucceed(() => false),
        );
  // A forward left over from a server that was killed keeps the port; reuse it instead of
  // retrying a forward that can never bind.
  const startTunnel = (record: DevboxRecord) =>
    answersHere(record).pipe(
      Effect.flatMap((up) =>
        FiberMap.run(
          tunnels,
          record.name,
          up
            ? reverse(record)
            : Effect.all([forward(record), reverse(record)], {
                concurrency: "unbounded",
                discard: true,
              }),
          { onlyIfMissing: true },
        ),
      ),
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

  const mintPairingCode = Effect.fn("DevboxService.mintPairingCode")(function* (
    name: string,
    label: string,
  ) {
    const paired = yield* ssh(name, `sh -s -- ${shellQuote(label)}`, PAIR_SCRIPT);
    const code = parsePairingToken(paired);
    if (!code)
      return yield* new DevboxError({
        reason: "link",
        message: "The box did not return a pairing code.",
      });
    return code;
  });

  const link = Effect.fn("DevboxService.link")(function* (record: DevboxRecord) {
    const url = `http://127.0.0.1:${record.localPort}`;
    if (record.environmentId !== null) {
      const existing = yield* peerLinks
        .get(record.environmentId as EnvironmentId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isSome(existing) && existing.value.urls.includes(url)) return record;
    }
    // A link to this box at an older address (its port changed) blocks linking it here.
    const answering = yield* httpClient.get(`${url}/.well-known/t3/environment`).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(decodeDescriptorId),
      Effect.option,
    );
    if (Option.isSome(answering)) {
      const stale = yield* peerLinks
        .get(answering.value)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isSome(stale) && !stale.value.urls.includes(url))
        yield* peerLinks.unlink(answering.value).pipe(Effect.ignore);
    }
    const label = (yield* environment.getDescriptor).label;
    const pairingCode = yield* mintPairingCode(record.name, label);
    const linked = yield* peerLinks
      .link({
        url: `http://127.0.0.1:${record.localPort}`,
        pairingCode,
        access: "full-access",
        expectedLabel: record.name,
      })
      .pipe(Effect.mapError(devboxError("link")));
    return yield* updateRecord(record.name, (current) => ({
      ...current,
      environmentId: linked.environmentId,
    }));
  });

  // ── sibling links ────────────────────────────────────────────────────────
  // Boxes link each other directly over Coder so their agents can delegate to one another
  // without this machine in the path. A box reaches a sibling at the port this machine uses
  // for it. Boxes run upstream T3, so this machine makes the links through each box's RPC.
  const siblingLocks = yield* KeyedLock.make<string>();
  const boxRpc = <A, E>(
    record: DevboxRecord,
    token: string,
    use: (client: Effect.Success<ReturnType<typeof environmentRpc>>) => Effect.Effect<A, E>,
  ) =>
    Effect.scoped(
      environmentRpc(`http://127.0.0.1:${record.localPort}`, token).pipe(Effect.flatMap(use)),
    ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
  const lastLine = (stdout: string) => stdout.trim().split("\n").at(-1)?.trim() ?? "";

  const linkSibling = Effect.fn("DevboxService.linkSibling")(
    function* (from: DevboxRecord, to: DevboxRecord) {
      const environmentId = to.environmentId as EnvironmentId;
      const token = lastLine(
        yield* ssh(from.name, `sh -s -- ${shellQuote(to.name)} ${to.localPort}`, SIBLING_SCRIPT),
      );
      const url = `http://127.0.0.1:${to.localPort}`;
      yield* boxRpc(from, token, (client) =>
        Effect.gen(function* () {
          const { links } = yield* client[WS_METHODS.peerLinksList]({});
          const existing = links.find((entry) => entry.environmentId === environmentId);
          if (
            existing !== undefined &&
            existing.status !== "expired" &&
            existing.urls.includes(url)
          )
            return;
          if (existing !== undefined) yield* client[WS_METHODS.peerLinksUnlink]({ environmentId });
          const pairingCode = yield* mintPairingCode(to.name, from.name);
          // Naming the expected environment makes T3 refuse a loopback address outright, so the
          // answering one is checked after linking instead.
          const linked = yield* client[WS_METHODS.peerLinksLink]({
            url,
            pairingCode,
            access: "full-access",
            expectedLabel: to.name,
          });
          if (linked.environmentId !== environmentId) {
            yield* client[WS_METHODS.peerLinksUnlink]({ environmentId: linked.environmentId });
            return yield* new DevboxError({
              reason: "link",
              message: `${url} on ${from.name} answered as ${linked.label}, not ${to.name}.`,
            });
          }
          yield* Effect.logInfo("devbox linked to sibling", { from: from.name, to: to.name });
        }),
      );
    },
    (effect, from, to) =>
      siblingLocks
        .withLock(`${from.name}>${to.name}`, effect)
        .pipe(Effect.mapError(devboxError("link"))),
  );

  /** Links `name` and every other running box both ways. Safe to repeat. */
  const linkSiblings = Effect.fn("DevboxService.linkSiblings")(function* (name: string) {
    const all = yield* workspaces;
    const current = yield* Ref.get(records);
    const usable = (record: DevboxRecord | undefined): record is DevboxRecord =>
      record !== undefined &&
      record.spare !== true &&
      record.environmentId !== null &&
      all.get(record.name)?.latest_build.status === "running";
    const self = current.get(name);
    if (!usable(self)) return;
    const others = [...current.values()].filter((record) => record.name !== name && usable(record));
    yield* Effect.forEach(
      others.flatMap((other) => [[self, other] as const, [other, self] as const]),
      ([from, to]) =>
        linkSibling(from, to).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("devbox sibling link failed", {
              from: from.name,
              to: to.name,
              cause,
            }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  });

  /** Links the box to this machine over the reverse forward, so its agents can work here. */
  const linkHost = Effect.fn("DevboxService.linkHost")(
    function* (record: DevboxRecord) {
      const self = yield* environment.getDescriptor;
      const url = `http://127.0.0.1:${HOST_PORT_ON_BOX}`;
      const token = lastLine(yield* ssh(record.name, "sh -s", LINK_TOKEN_SCRIPT));
      yield* boxRpc(record, token, (client) =>
        Effect.gen(function* () {
          const { links } = yield* client[WS_METHODS.peerLinksList]({});
          const existing = links.find((entry) => entry.environmentId === self.environmentId);
          if (
            existing !== undefined &&
            existing.status !== "expired" &&
            existing.access === HOST_LINK_ACCESS &&
            existing.urls.includes(url)
          )
            return;
          if (existing !== undefined)
            yield* client[WS_METHODS.peerLinksUnlink]({ environmentId: self.environmentId });
          const { credential } = yield* auth.issuePairingCredential({
            access: HOST_LINK_ACCESS,
            purpose: "peer-link",
            label: `Link · ${record.name}`,
          });
          const linked = yield* client[WS_METHODS.peerLinksLink]({
            url,
            pairingCode: credential,
            access: HOST_LINK_ACCESS,
            expectedLabel: self.label,
          });
          if (linked.environmentId !== self.environmentId) {
            yield* client[WS_METHODS.peerLinksUnlink]({ environmentId: linked.environmentId });
            return yield* new DevboxError({
              reason: "link",
              message: `${url} on ${record.name} answered as ${linked.label}, not this machine.`,
            });
          }
          yield* Effect.logInfo("devbox linked to this machine", { name: record.name });
        }),
      );
    },
    // The reverse forward starts with the tunnel and may not be listening yet.
    Effect.retry({ times: 5, schedule: Schedule.spaced("5 seconds") }),
    Effect.mapError(devboxError("link")),
  );

  /** Removes every running box's tunnel and link to a box that is going away. */
  const unlinkSiblings = Effect.fn("DevboxService.unlinkSiblings")(function* (gone: DevboxRecord) {
    const all = yield* workspaces;
    const others = [...(yield* Ref.get(records)).values()].filter(
      (record) =>
        record.name !== gone.name && all.get(record.name)?.latest_build.status === "running",
    );
    yield* Effect.forEach(
      others,
      (other) =>
        ssh(
          other.name,
          `sh -s -- ${shellQuote(gone.name)}`,
          SIBLING_REMOVE_SCRIPT,
          "1 minute",
        ).pipe(
          Effect.flatMap((stdout) =>
            gone.environmentId === null || other.environmentId === null
              ? Effect.void
              : boxRpc(other, lastLine(stdout), (client) =>
                  client[WS_METHODS.peerLinksUnlink]({
                    environmentId: gone.environmentId as EnvironmentId,
                  }),
                ),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("devbox sibling unlink failed", {
              from: other.name,
              to: gone.name,
              cause,
            }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  });

  // ── provisioning ─────────────────────────────────────────────────────────
  const readPersonalFile = Effect.fn("DevboxService.readPersonalFile")((relative: string) =>
    fs.readFileString(path.join(NodeOS.homedir(), relative)).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
      Effect.mapError(devboxError("provision")),
    ),
  );
  const installPersonalization = Effect.fn("DevboxService.installPersonalization")(function* (
    name: string,
  ) {
    const { cleantest, council, dig, digPolicy } = yield* Effect.all({
      cleantest: readPersonalFile(".agents/skills/cleantest/SKILL.md"),
      council: readPersonalFile(".agents/skills/council/SKILL.md"),
      dig: readPersonalFile(".agents/skills/dig/SKILL.md"),
      digPolicy: readPersonalFile(".agents/skills/dig/agents/openai.yaml"),
    });
    const skills = {
      ...(cleantest?.trim() ? { cleantest: { "SKILL.md": cleantest } } : {}),
      ...(council?.trim() ? { council: { "SKILL.md": council } } : {}),
      ...(dig?.trim() && digPolicy?.trim()
        ? { dig: { "agents/openai.yaml": digPolicy, "SKILL.md": dig } }
        : {}),
    };
    if (Object.keys(skills).length === 0) return;
    const instructions = yield* Effect.all({
      codexInstructions: readPersonalFile(".codex/AGENTS.md"),
      claudeInstructions: readPersonalFile(".claude/CLAUDE.md"),
    });
    const body = yield* encodeJson({ skills, ...instructions }).pipe(
      Effect.mapError(devboxError("provision")),
    );
    yield* ssh(name, `python3 -c ${shellQuote(INSTALL_PERSONALIZATION_SCRIPT)}`, body, "1 minute");
  });

  /**
   * Tags the box with formal:owner from this machine, then signs Formal in on it. `z devbox
   * create` binds as its last step, but a failure there (an expired SSO session) only logs.
   */
  const bindFormal = Effect.fn("DevboxService.bindFormal")(function* (name: string) {
    const now = yield* Clock.currentTimeMillis;
    const last = bindAttempts.get(name);
    if (last !== undefined && now - last < Duration.toMillis(BIND_RETRY_AFTER)) return false;
    bindAttempts.set(name, now);
    return yield* z(
      ["devbox", "ssh", "--enable-formal", name, "--", "formal", "auth", "login"],
      "3 minutes",
    ).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("devbox Formal binding failed", { name, error }).pipe(Effect.as(false)),
      ),
    );
  });

  // Writes this machine's access tokens to a box. Its refresh tokens never leave this machine.
  const pushLogins = Effect.fn("DevboxService.pushLogins")(function* (record: DevboxRecord) {
    const payload = yield* logins.payload;
    let result: {
      readonly claude?: "installed" | "unbound" | "failed";
      readonly codex?: "installed" | "unbound" | "failed";
    } = {};
    if (payload.claude !== null || payload.codex !== null) {
      const body = yield* encodeJson(payload).pipe(Effect.mapError(devboxError("provision")));
      const install = ssh(
        record.name,
        `python3 -c ${shellQuote(INSTALL_CREDENTIALS_SCRIPT)}`,
        body,
        "1 minute",
      ).pipe(
        Effect.flatMap((stdout) => decodeInstallResult(stdout.trim().split("\n").at(-1) ?? "")),
        Effect.mapError(devboxError("provision")),
      );
      result = yield* install;
      if (
        (result.claude === "unbound" || result.codex === "unbound") &&
        (yield* bindFormal(record.name))
      )
        result = yield* install;
      // A box that skipped a token (no Formal yet) gets it again on the next sync.
      const complete = (["claude", "codex"] as const).every(
        (provider) => result[provider] !== "unbound" && result[provider] !== "failed",
      );
      // Only a skipped sealed token says the box lacks Formal; one that installed proves it has it.
      if (result.claude === "unbound" || result.codex === "unbound") unboundBoxes.add(record.name);
      else if (
        (result.claude === "installed" &&
          payload.claude?.oauth.accessToken.startsWith("formalsealed:")) ||
        (result.codex === "installed" &&
          payload.codex?.tokens.access_token.startsWith("formalsealed:"))
      )
        unboundBoxes.delete(record.name);
      // A box that skipped or failed a token gets it again on the next sync.
      if (complete) pushed.set(record.name, loginsKey(payload));
      else pushed.delete(record.name);
    }
    // Signed in but not sent means the token expired and renewal has not reached a box yet.
    const state = Effect.fn("DevboxService.credentialState")(function* (
      provider: DevboxLoginProvider,
    ): Effect.fn.Return<DevboxCredentialState> {
      const installed = result[provider];
      if (installed === "installed" || installed === "unbound") return installed;
      if (installed === "failed") return "not-installed";
      const info = yield* logins.info(provider);
      if (!info.signedIn || refused.has(provider)) return "no-login";
      // Claude renews only through Formal; Codex needs it once sealed.
      const needsFormal = provider === "claude" || info.sealed;
      return needsFormal && unboundBoxes.has(record.name) ? "unbound" : "not-installed";
    });
    const credentials = { claude: yield* state("claude"), codex: yield* state("codex") };
    const current = yield* getRecord(record.name);
    if (
      current.credentials.claude === credentials.claude &&
      current.credentials.codex === credentials.codex
    )
      return current;
    return yield* updateRecord(record.name, (latest) => ({ ...latest, credentials }));
  });

  // Refreshes due sign-ins on this box: with Formal on it, Asana's connector seals the answer.
  // Its output carries tokens, so failures report fixed text, never what ssh or the box printed.
  const relayThrough = (name: string) => (request: DevboxLogins.DevboxRefreshRequest) =>
    Effect.gen(function* () {
      const body = yield* encodeJson(request);
      // Kept as it arrives and read whatever ssh does next (error exit, timeout): once the
      // provider answered, it holds the only live refresh token.
      let streamed = "";
      const stdout = yield* runner
        .run({
          command: "ssh",
          args: [
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=30",
            `coder.${name}`,
            `python3 -c ${shellQuote(REFRESH_LOGIN_SCRIPT)}`,
          ],
          stdin: body,
          timeout: "2 minutes",
          env: { BROWSER: browserFilter },
          onStdoutChunk: (chunk) => {
            streamed += new TextDecoder().decode(chunk);
          },
        })
        .pipe(
          Effect.map((result) => result.stdout),
          Effect.orElseSucceed(() => streamed),
        );
      return yield* decodeRelayOutput(stdout.trim().split("\n").at(-1) ?? "");
    }).pipe(
      Effect.mapError(
        () =>
          new DevboxError({
            reason: "provision",
            message: `Could not reach ${name} to renew the ${request.provider} sign-in.`,
          }),
      ),
      Effect.tap((output) =>
        Effect.sync(() => {
          if (output.error === "unbound") {
            unboundBoxes.add(name);
            // Its cached push predates losing Formal; the next sync checks the box again.
            pushed.delete(name);
          } else if (request.requireFormal) unboundBoxes.delete(name);
        }),
      ),
      Effect.flatMap((output) => {
        if (output.error === undefined) return Effect.succeed(output.response);
        if (output.error === "rejected")
          return (
            // An unsealed token went to the provider as is, so its refusal is final; a sealed one
            // may only have met a box whose proxy did not unseal it.
            (
              request.refreshToken.startsWith("formalsealed:")
                ? Effect.void
                : logins.reject(request.provider, request.refreshToken)
            ).pipe(
              Effect.andThen(
                Effect.fail(
                  new DevboxError({
                    reason: "invalid",
                    message: `The ${request.provider} sign-in was rejected${output.status === undefined ? "" : ` (HTTP ${output.status})`}. Sign in again.`,
                  }),
                ),
              ),
            )
          );
        return Effect.fail(
          new DevboxError({
            reason: "provision",
            message:
              output.error === "unbound"
                ? `${name} has no Formal sign-in, so it cannot renew the ${request.provider} sign-in.`
                : `${name} could not reach the ${request.provider} sign-in service.`,
          }),
        );
      }),
    );
  // What a box was last given, including outcomes that change its shown state.
  const loginsKey = (payload: DevboxLogins.DevboxLoginPayload) =>
    `${tokensKey(payload)}|${[...refused].toSorted().join(",")}`;
  const setLoginError = (provider: DevboxLoginProvider, message: string | null) =>
    Ref.update(loginErrors, (current) => ({ ...current, [provider]: message }));

  /**
   * Renews each due sign-in through the first of `boxes` that manages it. `report` shows a
   * failure in Settings; one box failing during its own connect is not news there.
   */
  const refreshLogins = Effect.fn("DevboxService.refreshLogins")(function* (
    boxes: ReadonlyArray<string>,
    report: boolean,
    // Box lock first, provider lock inside: the order `connect` takes them in.
    onBox: <A, E>(
      name: string,
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | DevboxError> = (_name, effect) => effect,
  ) {
    let renewed = false;
    // With no box running nothing can renew; the next box to connect does it.
    if (boxes.length === 0) return renewed;
    for (const provider of DevboxLogins.DEVBOX_LOGIN_PROVIDERS) {
      if (Option.isNone(yield* logins.due(provider))) continue;
      // A sign-in, sign-out or another renewal meanwhile makes this pass's failure stale.
      const generation = yield* logins.generation(provider);
      let lastError: string | null = `No running devbox could renew the ${provider} sign-in.`;
      let refusal: string | null = null;
      let outcome: "renewed" | "settled" | "failed" = "failed";
      for (const name of boxes) {
        const attempt = yield* onBox(name, logins.refresh(provider, relayThrough(name))).pipe(
          Effect.result,
        );
        if (attempt._tag === "Success") {
          // `false`: another caller renewed it first and reports the outcome itself.
          outcome = attempt.success ? "renewed" : "settled";
          renewed ||= attempt.success;
          break;
        }
        lastError = attempt.failure.message;
        // The provider answered but the answer could not be saved: another box would only send
        // the token it already rotated.
        if (attempt.failure._tag !== "DevboxError") break;
        if (attempt.failure.reason !== "invalid") continue;
        refusal = attempt.failure.message;
        // `relayThrough` marked an unsealed token dead, so it is no longer due. A sealed one may
        // only have met a proxy that did not unseal it; the next box tries.
        if (Option.isNone(yield* logins.due(provider))) break;
      }
      if (outcome === "settled") continue;
      if (outcome !== "renewed" && (yield* logins.generation(provider)) !== generation) continue;
      if (outcome === "renewed") {
        refused.delete(provider);
        yield* setLoginError(provider, null);
        continue;
      }
      if (refusal !== null) {
        // A refused sign-in needs the user wherever it was found.
        refused.add(provider);
        yield* setLoginError(provider, refusal);
      } else if (report && !refused.has(provider)) {
        // A known refusal stays shown until a renewal or the user clears it.
        yield* setLoginError(provider, lastError);
      }
      yield* Effect.logWarning("devbox sign-in renewal failed", {
        provider,
        lastError: refusal ?? lastError,
      });
    }
    return renewed;
  });

  /** Renews due sign-ins through any running box, then gives every running box the new tokens. */
  const syncLogins = Effect.gen(function* () {
    const all = yield* workspaces;
    const running = [...(yield* Ref.get(records)).values()].filter(
      (record) => all.get(record.name)?.latest_build.status === "running",
    );
    // A box being stopped or deleted holds its lock, so a renewal never relays through one
    // going away; a box being set up renews through its own `connect`.
    const busy = new Set(yield* locks.activeKeys);
    const relays: Array<string> = [];
    for (const record of running)
      if (!busy.has(record.name) && !(yield* FiberMap.has(creations, record.name)))
        relays.push(record.name);
    yield* refreshLogins(relays, true, (name, effect) =>
      locks.withLock(
        name,
        Effect.gen(function* () {
          // It may have started stopping or deleting while this pass waited for the lock.
          const state = (yield* Ref.get(transient)).get(name)?.state;
          if (state === "stopping" || state === "deleting" || state === "creating")
            return yield* new DevboxError({
              reason: "busy",
              message: `${name} is busy and cannot renew sign-ins now.`,
            });
          return yield* effect;
        }),
      ),
    );
    const key = loginsKey(yield* logins.payload);
    const held = new Set(yield* locks.activeKeys);
    for (const record of running) {
      // A box being set up, stopped or deleted gets its tokens later; waiting on its lock would
      // stall the rest.
      if (
        pushed.get(record.name) === key ||
        held.has(record.name) ||
        (yield* FiberMap.has(creations, record.name))
      )
        continue;
      yield* locks
        .withLock(record.name, pushLogins(record))
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("devbox sign-ins could not be pushed", { name: record.name, cause }),
          ),
        );
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("devbox sign-in sync failed", { cause })),
    Effect.withSpan("DevboxService.syncLogins"),
  );

  // Every box uses this machine's Cursor sign-in: Cursor keys are per account, not per machine.
  const cursorCredentials = yield* ProviderCredentialStore.make("cursor", "cursor");
  const browserCursorApiKey = cursorCredentials.get.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeedNone,
        onSome: (bytes) =>
          decodeCursorCredentials(new TextDecoder().decode(bytes)).pipe(Effect.asSome),
      }),
    ),
    Effect.flatMap((credentials) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) =>
          Option.filter(
            credentials,
            (entry) => entry.apiKeyExpiresAtMs === undefined || entry.apiKeyExpiresAtMs > now,
          ).pipe(Option.map((entry) => entry.apiKey)),
        ),
      ),
    ),
  );
  const inheritedCursorApiKey = yield* Config.String("CURSOR_API_KEY").pipe(
    Config.option,
    Effect.map(Option.getOrUndefined),
  );
  const cursorSetting = (snapshot: ServerSettings) =>
    snapshot.providerInstances[CURSOR_INSTANCE_ID]?.environment?.findLast(
      ({ name }) => name === "CURSOR_API_KEY",
    )?.value;
  const readCursorApiKey = Effect.fn("DevboxService.readCursorApiKey")(function* () {
    const configured = cursorSetting(yield* settings.getSettings);
    if (configured !== undefined && typeof configured !== "string") {
      const [key] = yield* secrets.read([configured]);
      return key?.trim() || undefined;
    }
    const key = (configured ?? inheritedCursorApiKey)?.trim();
    return key || Option.getOrUndefined(yield* browserCursorApiKey);
  });
  const hostAllowedUsageDrivers = (snapshot: ServerSettings): ReadonlyArray<ProviderDriverKind> => {
    const allowed = new Set<ProviderDriverKind>();
    for (const instance of Object.values(snapshot.providerInstances)) {
      if (instance.enabled !== false && instance.usageAccess === "allowed") {
        allowed.add(instance.driver);
      }
    }
    return USAGE_ACCESS_SYNC_DRIVERS.filter((driver) => allowed.has(driver));
  };
  const usageAccessSettingKey = (snapshot: ServerSettings) =>
    hostAllowedUsageDrivers(snapshot).join(",");

  const installCursor = Effect.fn("DevboxService.installCursor")(
    function* (record: DevboxRecord) {
      // Read under the box lock so a delayed push cannot overwrite a newer key.
      const key = yield* readCursorApiKey();
      if (!key || pushedCursorKeys.get(record.name) === key) return;
      const allowCursorUsage = hostAllowedUsageDrivers(yield* settings.getSettings).includes(
        CURSOR_DRIVER_KIND,
      );
      pushedCursorKeys.delete(record.name);
      const token = lastLine(yield* ssh(record.name, "sh -s", SETTINGS_TOKEN_SCRIPT));
      if (!token) {
        return yield* new DevboxError({
          reason: "provision",
          message: "The box did not return a settings token.",
        });
      }
      // Apply through the box's serialized RPC so CURSOR_API_KEY lands in ServerSecretStore
      // immediately (redacted on disk) instead of writing plaintext settings.json over SSH.
      yield* boxRpc(record, token, (rpc) =>
        Effect.gen(function* () {
          const boxSettings = yield* rpc[WS_METHODS.serverGetSettings]({});
          const current = boxSettings.providerInstances[CURSOR_INSTANCE_ID];
          const remainingEnv = (current?.environment ?? []).filter(
            (entry) => entry.name !== CURSOR_API_KEY_ENV_NAME,
          );
          const nextUsageAccess =
            current?.usageAccess ?? (allowCursorUsage ? ("allowed" as const) : undefined);
          yield* rpc[WS_METHODS.serverUpdateSettings]({
            patch: {},
            providerInstanceMutation: {
              operation: current === undefined ? "create" : "upsert",
              instanceId: CURSOR_INSTANCE_ID,
              instance: {
                ...current,
                driver: CURSOR_DRIVER_KIND,
                displayName: current?.displayName ?? "Cursor",
                enabled: true,
                ...(nextUsageAccess === undefined ? {} : { usageAccess: nextUsageAccess }),
                environment: [
                  ...remainingEnv,
                  {
                    name: CURSOR_API_KEY_ENV_NAME,
                    value: key,
                    sensitive: true,
                  },
                ],
              },
            },
          });
        }),
      );
      pushedCursorKeys.set(record.name, key);
    },
    (effect, record) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("devbox Cursor key could not be synced", {
            name: record.name,
            error,
          }),
        ),
      ),
  );

  // Propagates this machine's usageAccess: "allowed" grants to devboxes so Usage counts running
  // boxes automatically, while never overriding an explicit "denied" on a box.
  const syncUsageAccessBox = Effect.fn("DevboxService.syncUsageAccessBox")(
    function* (record: DevboxRecord) {
      const allowed = hostAllowedUsageDrivers(yield* settings.getSettings);
      const key = allowed.join(",");
      if (allowed.length === 0 || pushedUsageAccess.get(record.name) === key) return;
      pushedUsageAccess.delete(record.name);
      const token = lastLine(yield* ssh(record.name, "sh -s", SETTINGS_TOKEN_SCRIPT));
      if (!token) return;
      yield* boxRpc(record, token, (rpc) =>
        Effect.gen(function* () {
          const boxSettings = yield* rpc[WS_METHODS.serverGetSettings]({});
          for (const driver of allowed) {
            const instanceId = ProviderInstanceId.make(driver);
            const current = boxSettings.providerInstances[instanceId];
            if (current?.usageAccess !== undefined) continue;
            const optionalProvider =
              driver === CURSOR_DRIVER_KIND || driver === ANTIGRAVITY_DRIVER_KIND;
            if (optionalProvider && (current === undefined || current.enabled === false)) continue;
            yield* rpc[WS_METHODS.serverUpdateSettings]({
              patch: {},
              providerInstanceMutation: {
                operation: current === undefined ? "create" : "upsert",
                instanceId,
                instance: {
                  ...current,
                  driver,
                  enabled: current?.enabled ?? true,
                  usageAccess: "allowed",
                },
              },
            });
          }
        }),
      );
      pushedUsageAccess.set(record.name, key);
    },
    (effect, record) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("devbox usage access could not be synced", {
            name: record.name,
            error,
          }),
        ),
      ),
  );
  const syncUsageAccess = Effect.fn("DevboxService.syncUsageAccess")(
    function* (all: ReadonlyMap<string, CoderWorkspace> | undefined) {
      const allowed = hostAllowedUsageDrivers(yield* settings.getSettings);
      if (allowed.length === 0) return;
      const key = allowed.join(",");
      const inventory = all ?? (yield* workspaces);
      const held = new Set(yield* locks.activeKeys);
      const running = [...(yield* Ref.get(records)).values()].filter(
        (record) =>
          record.environmentId !== null &&
          inventory.get(record.name)?.latest_build.status === "running" &&
          pushedUsageAccess.get(record.name) !== key &&
          !held.has(record.name),
      );
      yield* Effect.forEach(
        running,
        (record) =>
          locks.withLock(
            record.name,
            Effect.gen(function* () {
              const latest = (yield* Ref.get(records)).get(record.name);
              const state = (yield* Ref.get(transient)).get(record.name)?.state;
              if (
                latest !== undefined &&
                latest.environmentId !== null &&
                state !== "stopping" &&
                state !== "deleting"
              ) {
                yield* syncUsageAccessBox(latest);
              }
            }),
          ),
        { concurrency: 4, discard: true },
      );
    },
    (effect, _all) =>
      effect.pipe(Effect.catch(() => Effect.logWarning("devbox usage access sync failed"))),
  );

  // Archives a box's local usage records onto this machine so stopped and deleted boxes stay
  // counted in Usage without double-counting when the box is running.
  const triggerBoxUsageRefresh = Effect.fn("DevboxService.triggerBoxUsageRefresh")(
    function* (record: DevboxRecord) {
      if (record.environmentId === null) return;
      const token = lastLine(yield* ssh(record.name, "sh -s", USAGE_TOKEN_SCRIPT));
      if (!token) return;
      const nowMs = yield* Clock.currentTimeMillis;
      const untilDay = DateTime.formatIsoDateUtc(DateTime.makeUnsafe(nowMs));
      const sinceDay = DateTime.formatIsoDateUtc(
        DateTime.makeUnsafe(nowMs - 90 * 24 * 60 * 60 * 1000),
      );
      yield* boxRpc(record, token, (rpc) =>
        rpc[WS_METHODS.serverGetUsageSummary]({
          sinceDay: UsageDay.make(sinceDay),
          untilDay: UsageDay.make(untilDay),
          timeZone: "UTC",
          awaitRefresh: true,
        }),
      );
      // Give the box server's detached scan-cache persist fiber a moment to flush to disk.
      yield* Effect.sleep("300 millis");
    },
    (effect) => effect.pipe(Effect.ignore),
  );

  const snapshotBoxUsage = Effect.fn("DevboxService.snapshotBoxUsage")(
    function* (record: DevboxRecord, options?: { readonly triggerSummary?: boolean }) {
      if (options?.triggerSummary !== false && (yield* FiberMap.has(tunnels, record.name))) {
        yield* triggerBoxUsageRefresh(record);
      }
      const gzippedBytes = yield* sshBinary(
        record.name,
        `python3 -c ${shellQuote(EXPORT_DEVBOX_USAGE_SCRIPT)}`,
        { timeout: "2 minutes" },
      );
      if (gzippedBytes.byteLength === 0) return;
      const nowMs = yield* Clock.currentTimeMillis;
      yield* DevboxUsageArchive.saveDevboxUsageArchive({
        stateDir: config.stateDir,
        boxName: record.name,
        environmentId: record.environmentId,
        gzippedBytes,
        capturedAtMs: nowMs,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    },
    (effect, record, _options?) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("devbox usage snapshot failed", { name: record.name, cause }),
        ),
      ),
  );
  const syncCursor = Effect.fn("DevboxService.syncCursor")(
    function* (all: ReadonlyMap<string, CoderWorkspace> | undefined) {
      const key = yield* readCursorApiKey();
      if (!key) return;
      const inventory = all ?? (yield* workspaces);
      const held = new Set(yield* locks.activeKeys);
      const running = [...(yield* Ref.get(records)).values()].filter(
        (record) =>
          record.environmentId !== null &&
          inventory.get(record.name)?.latest_build.status === "running" &&
          pushedCursorKeys.get(record.name) !== key &&
          !held.has(record.name),
      );
      yield* Effect.forEach(
        running,
        (record) =>
          locks.withLock(
            record.name,
            Effect.gen(function* () {
              const latest = (yield* Ref.get(records)).get(record.name);
              const state = (yield* Ref.get(transient)).get(record.name)?.state;
              if (
                latest !== undefined &&
                latest.environmentId !== null &&
                state !== "stopping" &&
                state !== "deleting"
              )
                yield* installCursor(latest);
            }),
          ),
        { concurrency: 4, discard: true },
      );
    },
    (effect, _all) =>
      effect.pipe(Effect.catch(() => Effect.logWarning("devbox Cursor key sync failed"))),
  );

  // Shares this machine's Vertex AI ADC with devboxes over a dedicated SSH reverse tunnel to the
  // host's owner-only Unix-socket metadata broker; the Google refresh token never leaves this host.
  const antigravitySettingKey = (snapshot: ServerSettings) => {
    const cfg = DevboxVertexMetadata.readHostAntigravityConfig(snapshot);
    return cfg ? `${cfg.gcpProject}|${cfg.gcpLocation}` : undefined;
  };
  const vertexOwnerPaused = (hostId: string) => `${hostId}:paused`;
  const vertexOwnerOptOut = (hostId: string) => `${hostId}:opt-out`;
  const readVertexOwner = (instance: ProviderInstanceConfig | undefined) => {
    const value = instance?.environment?.find(
      (entry) => entry.name === VERTEX_OWNER_ENV_NAME,
    )?.value;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const ownerBelongsToHost = (owner: string | undefined, hostId: string) =>
    owner === hostId || owner === vertexOwnerPaused(hostId) || owner === vertexOwnerOptOut(hostId);
  const hasMetadataHostEnv = (instance: ProviderInstanceConfig | undefined) =>
    instance?.environment?.some(
      (entry) =>
        entry.name === VERTEX_METADATA_ENV_NAME &&
        typeof entry.value === "string" &&
        entry.value === VERTEX_METADATA_HOST_ON_BOX,
    ) ?? false;
  const hasCustomAntigravityConfig = (instance: ProviderInstanceConfig) => {
    if (instance.enabled === true) return true;
    if ((instance.environment?.length ?? 0) > 0) return true;
    return (
      typeof instance.config === "object" &&
      instance.config !== null &&
      !Array.isArray(instance.config) &&
      Object.keys(instance.config).length > 0
    );
  };
  const isUserCustomAntigravityConfig = (instance: ProviderInstanceConfig | undefined) => {
    if (
      typeof instance?.config !== "object" ||
      instance.config === null ||
      Array.isArray(instance.config)
    ) {
      return false;
    }
    const cfg = instance.config as Record<string, unknown>;
    const hasApiKey =
      cfg.apiKey !== undefined &&
      cfg.apiKey !== null &&
      (typeof cfg.apiKey !== "string" || cfg.apiKey.trim().length > 0);
    if (hasApiKey) return true;
    if (
      typeof cfg.authMethod === "string" &&
      cfg.authMethod.length > 0 &&
      cfg.authMethod !== "agent-platform"
    ) {
      return true;
    }
    return false;
  };
  const classifyAntigravityEligibility = (
    current: ProviderInstanceConfig | undefined,
    hostOwnerId: string,
  ): "eligible" | "declined" => {
    if (current === undefined) return "eligible";
    if (current.driver !== ANTIGRAVITY_DRIVER_KIND) return "declined";
    const owner = readVertexOwner(current);
    const ownedByUs = ownerBelongsToHost(owner, hostOwnerId);
    // Never overwrite another host's managed instance or any unowned custom config (even disabled).
    if (!ownedByUs && (owner !== undefined || hasCustomAntigravityConfig(current))) {
      return "declined";
    }
    // Never overwrite a user's own API key or non-agent-platform auth added while paused.
    if (isUserCustomAntigravityConfig(current)) {
      return "declined";
    }
    // Respect explicit on-box opt-out across re-syncs and host off/on toggles.
    if (ownedByUs && current.enabled === false && owner !== vertexOwnerPaused(hostOwnerId)) {
      return "declined";
    }
    return "eligible";
  };
  const ensureVertexTunnel = (record: DevboxRecord) =>
    FiberMap.run(
      vertexTunnels,
      record.name,
      sshForward(record, [
        "-R",
        `127.0.0.1:${VERTEX_METADATA_PORT_ON_BOX}:${vertexMetadata.socketPath}`,
      ]),
      { onlyIfMissing: true },
    );
  const readAntigravitySyncState = Effect.fn("DevboxService.readAntigravitySyncState")(
    function* () {
      const cfg = DevboxVertexMetadata.readHostAntigravityConfig(yield* settings.getSettings);
      if (!cfg) return { _tag: "disabled" as const };
      if (!vertexMetadata.socketPath || !(yield* vertexMetadata.hasAdcCredentials)) {
        // Host still wants Vertex ADC, but the broker or ADC file is temporarily unavailable;
        // skip pushes without tearing down tunnels or disabling boxes.
        return { _tag: "waiting-adc" as const };
      }
      return {
        _tag: "enabled" as const,
        ...cfg,
        key: `${cfg.gcpProject}|${cfg.gcpLocation}|${VERTEX_METADATA_PORT_ON_BOX}|${vertexMetadata.brokerId}`,
      };
    },
  );
  const syncAntigravityBox = Effect.fn("DevboxService.syncAntigravityBox")(
    function* (record: DevboxRecord) {
      const transientState = (yield* Ref.get(transient)).get(record.name)?.state;
      if (transientState === "stopping" || transientState === "deleting") return;
      const syncState = yield* readAntigravitySyncState();
      if (syncState._tag === "waiting-adc") return;
      if (syncState._tag === "disabled") {
        const latest = (yield* Ref.get(records)).get(record.name) ?? record;
        const needsCleanup =
          persistedAntigravityManaged.has(record.name) ||
          latest.antigravityManaged === true ||
          (yield* FiberMap.has(vertexTunnels, record.name));
        yield* FiberMap.remove(vertexTunnels, record.name);
        pushedAntigravity.delete(record.name);
        if (!needsCleanup) return;
        const hostOwnerId = yield* environment.getEnvironmentId;
        const token = lastLine(yield* ssh(record.name, "sh -s", SETTINGS_TOKEN_SCRIPT));
        if (!token) {
          return yield* new DevboxError({
            reason: "provision",
            message: "The box did not return a settings token for Antigravity cleanup.",
          });
        }
        yield* boxRpc(latest, token, (rpc) =>
          Effect.gen(function* () {
            const boxSettings = yield* rpc[WS_METHODS.serverGetSettings]({});
            const current = boxSettings.providerInstances[ANTIGRAVITY_INSTANCE_ID];
            const owner = readVertexOwner(current);
            if (
              current === undefined ||
              current.driver !== ANTIGRAVITY_DRIVER_KIND ||
              !ownerBelongsToHost(owner, hostOwnerId) ||
              isUserCustomAntigravityConfig(current)
            ) {
              return;
            }
            // Distinguish host pause from explicit on-box opt-out; retrying a pause must stay paused.
            const nextOwner =
              current.enabled === false && owner !== vertexOwnerPaused(hostOwnerId)
                ? vertexOwnerOptOut(hostOwnerId)
                : vertexOwnerPaused(hostOwnerId);
            if (current.enabled === false && owner === nextOwner && !hasMetadataHostEnv(current)) {
              return;
            }
            const remainingEnv = (current.environment ?? []).filter(
              (entry) =>
                entry.name !== VERTEX_METADATA_ENV_NAME && entry.name !== VERTEX_OWNER_ENV_NAME,
            );
            yield* rpc[WS_METHODS.serverUpdateSettings]({
              patch: {},
              providerInstanceMutation: {
                operation: "upsert",
                instanceId: ANTIGRAVITY_INSTANCE_ID,
                instance: {
                  ...current,
                  enabled: false,
                  environment: [
                    ...remainingEnv,
                    { name: VERTEX_OWNER_ENV_NAME, value: nextOwner, sensitive: false },
                  ],
                },
              },
            });
          }),
        );
        const currentRecord = (yield* Ref.get(records)).get(record.name);
        if (
          persistedAntigravityManaged.has(record.name) ||
          currentRecord?.antigravityManaged === true
        ) {
          yield* updateRecord(record.name, ({ antigravityManaged: _managed, ...rest }) => rest);
          persistedAntigravityManaged.delete(record.name);
        }
        return;
      }

      const cachedSync = pushedAntigravity.get(record.name);
      if (
        cachedSync?.key === syncState.key &&
        (cachedSync.outcome === "declined" || (yield* FiberMap.has(vertexTunnels, record.name)))
      ) {
        return;
      }
      const hostOwnerId = yield* environment.getEnvironmentId;
      const token = lastLine(yield* ssh(record.name, "sh -s", SETTINGS_TOKEN_SCRIPT));
      if (!token) {
        return yield* new DevboxError({
          reason: "provision",
          message: "The box did not return a settings token.",
        });
      }
      // Check ownership and opt-out before opening a reverse tunnel or downloading agy.
      const precheckSettings = yield* boxRpc(record, token, (rpc) =>
        rpc[WS_METHODS.serverGetSettings]({}),
      );
      if (
        classifyAntigravityEligibility(
          precheckSettings.providerInstances[ANTIGRAVITY_INSTANCE_ID],
          hostOwnerId,
        ) === "declined"
      ) {
        yield* FiberMap.remove(vertexTunnels, record.name);
        pushedAntigravity.set(record.name, { key: syncState.key, outcome: "declined" });
        return;
      }

      const hadTunnel = yield* FiberMap.has(vertexTunnels, record.name);
      pushedAntigravity.delete(record.name);
      yield* ensureVertexTunnel(record);
      yield* Effect.gen(function* () {
        const prepareBody = yield* encodeJson({
          gcpProject: syncState.gcpProject,
          metadataHost: VERTEX_METADATA_HOST_ON_BOX,
          brokerId: vertexMetadata.brokerId,
        }).pipe(Effect.mapError(devboxError("provision")));
        const binaryPath = lastLine(
          yield* ssh(
            record.name,
            `python3 -c ${shellQuote(PREPARE_ANTIGRAVITY_SCRIPT)}`,
            prepareBody,
            "10 minutes",
          ),
        );
        if (!binaryPath) {
          return yield* new DevboxError({
            reason: "provision",
            message: "Antigravity binary preparation did not return an executable path.",
          });
        }
        // Persist cleanup intent durably before the post-prepare read/write, and mint a fresh
        // token in case the first-time agy download outlasted the 5-minute pre-check token.
        if (!persistedAntigravityManaged.has(record.name)) {
          yield* updateRecord(record.name, (entry) => ({
            ...entry,
            antigravityManaged: true,
          }));
          persistedAntigravityManaged.add(record.name);
        }
        const applyToken = lastLine(yield* ssh(record.name, "sh -s", SETTINGS_TOKEN_SCRIPT));
        if (!applyToken) {
          return yield* new DevboxError({
            reason: "provision",
            message: "The box did not return a settings token.",
          });
        }
        const allowAntigravityUsage = hostAllowedUsageDrivers(yield* settings.getSettings).includes(
          ANTIGRAVITY_DRIVER_KIND,
        );
        const outcome = yield* boxRpc(record, applyToken, (rpc) =>
          Effect.gen(function* () {
            const boxSettings = yield* rpc[WS_METHODS.serverGetSettings]({});
            const current = boxSettings.providerInstances[ANTIGRAVITY_INSTANCE_ID];
            if (classifyAntigravityEligibility(current, hostOwnerId) === "declined") {
              return "declined" as const;
            }
            const owner = readVertexOwner(current);
            const existingConfig =
              typeof current?.config === "object" &&
              current.config !== null &&
              !Array.isArray(current.config)
                ? { ...(current.config as Record<string, unknown>) }
                : {};
            const nextUsageAccess =
              current?.usageAccess ?? (allowAntigravityUsage ? ("allowed" as const) : undefined);
            if (
              owner === hostOwnerId &&
              hasMetadataHostEnv(current) &&
              current?.enabled === true &&
              current?.usageAccess === nextUsageAccess &&
              existingConfig.authMethod === "agent-platform" &&
              existingConfig.gcpProject === syncState.gcpProject &&
              existingConfig.gcpLocation === syncState.gcpLocation &&
              existingConfig.binaryPath === binaryPath &&
              !("apiKey" in existingConfig)
            ) {
              // On box restart/reconnect, settings already match but Antigravity's in-memory auth
              // starts as "unknown" until providerAuthStart runs the non-interactive ADC handshake.
              const boxConfig = yield* rpc[WS_METHODS.serverGetConfig]({}).pipe(
                Effect.orElseSucceed(() => undefined),
              );
              const providerState = boxConfig?.providers.find(
                (entry) => entry.instanceId === ANTIGRAVITY_INSTANCE_ID,
              );
              if (
                providerState?.auth.status !== "authenticated" ||
                providerState.models.length === 0
              ) {
                yield* rpc[WS_METHODS.providerAuthStart]({
                  instanceId: ANTIGRAVITY_INSTANCE_ID,
                }).pipe(Effect.ignore);
              }
              return "enabled" as const;
            }
            delete existingConfig.apiKey;
            const remainingEnv = (current?.environment ?? []).filter(
              (entry) =>
                entry.name !== VERTEX_METADATA_ENV_NAME && entry.name !== VERTEX_OWNER_ENV_NAME,
            );
            yield* rpc[WS_METHODS.serverUpdateSettings]({
              patch: {},
              providerInstanceMutation: {
                // Use atomic "create" when absent so a concurrent user-created entry is never overwritten.
                operation: current === undefined ? "create" : "upsert",
                instanceId: ANTIGRAVITY_INSTANCE_ID,
                instance: {
                  ...current,
                  driver: ANTIGRAVITY_DRIVER_KIND,
                  displayName: current?.displayName ?? "Antigravity",
                  enabled: true,
                  ...(nextUsageAccess === undefined ? {} : { usageAccess: nextUsageAccess }),
                  config: {
                    ...existingConfig,
                    authMethod: "agent-platform",
                    gcpProject: syncState.gcpProject,
                    gcpLocation: syncState.gcpLocation,
                    binaryPath,
                  },
                  environment: [
                    ...remainingEnv,
                    {
                      name: VERTEX_METADATA_ENV_NAME,
                      value: VERTEX_METADATA_HOST_ON_BOX,
                      sensitive: false,
                    },
                    {
                      name: VERTEX_OWNER_ENV_NAME,
                      value: hostOwnerId,
                      sensitive: false,
                    },
                  ],
                },
              },
            });
            // Trigger non-interactive Agent Platform auth so models load immediately without UI clicks.
            yield* rpc[WS_METHODS.providerAuthStart]({
              instanceId: ANTIGRAVITY_INSTANCE_ID,
            }).pipe(Effect.ignore);
            return "enabled" as const;
          }),
        );
        if (outcome === "declined") {
          yield* FiberMap.remove(vertexTunnels, record.name);
        }
        pushedAntigravity.set(record.name, { key: syncState.key, outcome });
      }).pipe(
        Effect.tapError(() =>
          hadTunnel ? Effect.void : FiberMap.remove(vertexTunnels, record.name),
        ),
      );
    },
    (effect, record) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("devbox Antigravity setup could not be synced", {
            name: record.name,
            error,
          }),
        ),
      ),
  );
  const scheduleAntigravitySync = (record: DevboxRecord, onlyIfMissing: boolean) =>
    FiberMap.run(antigravitySyncs, record.name, syncAntigravityBox(record), { onlyIfMissing });
  const syncAntigravity = Effect.fn("DevboxService.syncAntigravity")(
    function* (all: ReadonlyMap<string, CoderWorkspace> | undefined, onlyIfMissing = false) {
      const syncState = yield* readAntigravitySyncState();
      if (syncState._tag === "waiting-adc") return;
      const inventory = all ?? (yield* workspaces);
      const held = new Set(yield* locks.activeKeys);
      const candidates = [...(yield* Ref.get(records)).values()].filter(
        (record) =>
          record.environmentId !== null &&
          inventory.get(record.name)?.latest_build.status === "running" &&
          !held.has(record.name),
      );
      for (const record of candidates) {
        const state = (yield* Ref.get(transient)).get(record.name)?.state;
        if (state === "stopping" || state === "deleting") continue;
        const hasTunnel = yield* FiberMap.has(vertexTunnels, record.name);
        const cachedSync = pushedAntigravity.get(record.name);
        const shouldSync =
          syncState._tag === "enabled"
            ? cachedSync?.key !== syncState.key || (cachedSync.outcome !== "declined" && !hasTunnel)
            : persistedAntigravityManaged.has(record.name) ||
              record.antigravityManaged === true ||
              hasTunnel;
        if (shouldSync) {
          yield* scheduleAntigravitySync(record, onlyIfMissing);
        }
      }
    },
    (effect, _all, _onlyIfMissing?: boolean) =>
      effect.pipe(Effect.catch(() => Effect.logWarning("devbox Antigravity sync failed"))),
  );

  /** Brings a running box to linked: T3 service, forward, link. Safe to repeat. */
  const connect = Effect.fn("DevboxService.connect")(
    function* (stored: DevboxRecord) {
      // The startup script (codez refresh, full redeploy) can run for over 30 minutes; agents
      // only need ssh and the checkout, so connect as soon as the box's agent answers.
      yield* coder(["ssh", "--wait=no", stored.name, "--", "true"], "10 minutes");
      yield* installPersonalization(stored.name);
      // This box can renew a due sign-in itself, so a waking box gets a fresh token at once.
      // A renewal here changes every box's token; the others get it in the background.
      // A refusal here may only be this box's proxy; the sync gives the other boxes a try.
      if ((yield* refreshLogins([stored.name], false)) || refused.size > 0)
        yield* FiberSet.run(background, syncLogins);
      // Sign-ins arriving late must not keep the box from connecting; the sync retries them.
      const record = yield* pushLogins(stored).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("devbox sign-ins could not be pushed", {
            name: stored.name,
            cause,
          }).pipe(Effect.andThen(getRecord(stored.name))),
        ),
      );
      // A box set up by this script starts T3 itself at boot: reconnecting is enough.
      if (isCurrentProvisionRevision(record.provisioned) && record.environmentId !== null) {
        const reached = yield* startTunnel(record).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (reached) {
          yield* installCursor(record);
          yield* syncUsageAccessBox(record);
          return yield* link(record);
        }
      }
      const version = yield* t3Version;
      yield* ssh(
        record.name,
        `sh -s -- ${shellQuote(version)} ${shellQuote(record.name)}`,
        PROVISION_SCRIPT,
        "15 minutes",
      );
      const provisioned = yield* updateRecord(record.name, (current) => ({
        ...current,
        provisioned: PROVISION_REVISION,
      }));
      yield* startTunnel(provisioned);
      yield* installCursor(provisioned);
      yield* syncUsageAccessBox(provisioned);
      return yield* link(provisioned);
    },
    (effect, stored) =>
      effect.pipe(
        Effect.tap(() => setTransient(stored.name, undefined)),
        Effect.tap(() =>
          FiberSet.run(
            background,
            linkSiblings(stored.name).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("devbox sibling links failed", { name: stored.name, cause }),
              ),
            ),
          ),
        ),
        Effect.tap((record) =>
          FiberSet.run(
            background,
            linkHost(record).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("devbox link to this machine failed", {
                  name: stored.name,
                  cause,
                }),
              ),
            ),
          ),
        ),
        Effect.tap((record) =>
          Effect.sync(() => {
            pushedAntigravity.delete(record.name);
          }).pipe(Effect.andThen(scheduleAntigravitySync(record, false))),
        ),
        Effect.tap((record) => FiberSet.run(background, snapshotBoxUsage(record))),
        Effect.tapError((error) =>
          FiberMap.remove(tunnels, stored.name).pipe(
            Effect.andThen(
              setTransient(stored.name, { state: "failed", lastError: error.message }),
            ),
          ),
        ),
      ),
  );

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
    yield* z(args, CREATE_TIMEOUT).pipe(
      Effect.mapError(devboxError("coder")),
      // z's later steps (SSO, commit-signing keys) can fail after the box itself is up.
      Effect.catch((error) =>
        workspaces.pipe(
          Effect.flatMap((all) =>
            all.has(record.name)
              ? Effect.logWarning("z devbox create failed after creating the box", {
                  name: record.name,
                  error: error.message,
                })
              : Effect.fail(error),
          ),
        ),
      ),
    );
    yield* coder(["autoupdate", record.name, "always"]).pipe(Effect.ignore);
    yield* connect(record);
  });

  // Skips ports any process listens on, such as another T3 instance's devbox forwards.
  const nextPort = Effect.gen(function* () {
    const used = new Set([...(yield* Ref.get(records)).values()].map((record) => record.localPort));
    let port = PORT_BASE;
    while (used.has(port) || !(yield* net.canListenOnHost(port, "127.0.0.1"))) port++;
    return port;
  });

  const startCreate = Effect.fn("DevboxService.startCreate")(function* (
    input: DevboxCreateInput,
    spare: boolean,
  ) {
    const taken = new Set([...(yield* workspaces).keys(), ...(yield* Ref.get(records)).keys()]);
    const seed = yield* Clock.currentTimeMillis;
    let state = seed;
    // Cheap deterministic generator: names only need to differ, not be unpredictable.
    const random = () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    const number = yield* Ref.modify(nextNumber, (stored) => {
      const picked = nextDevboxNumber(stored, taken, namePrefix);
      return [picked, picked + 1];
    });
    const name =
      input.name !== undefined
        ? uniqueDevboxName(slugifyDevboxName(input.name, namePrefix, number), taken)
        : randomDevboxName(namePrefix, taken, random, number);
    const record: DevboxRecord = {
      name,
      localPort: yield* nextPort,
      environmentId: null,
      task: input.task ?? null,
      createdAt: DateTime.formatIso(yield* DateTime.now),
      credentials: {
        claude: (yield* logins.info("claude")).signedIn ? "not-installed" : "no-login",
        codex: (yield* logins.info("codex")).signedIn ? "not-installed" : "no-login",
      },
      ...(spare ? { spare: true } : {}),
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
  });

  const awaitReady: DevboxService["Service"]["awaitReady"] = Effect.fn("DevboxService.awaitReady")(
    function* (name, timeout, options) {
      const settled = Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          while (true) {
            const summary = yield* summaryOf(name);
            if (
              summary.state !== "creating" &&
              summary.state !== "starting" &&
              (!options?.waitForLogin ||
                summary.state !== "running" ||
                summary.environmentId === null ||
                summary.credentials.claude === "installed" ||
                summary.credentials.codex === "installed" ||
                // Only the user can bind Formal on the box; with nothing else on its way,
                // waiting longer will not help.
                ((summary.credentials.claude === "unbound" ||
                  summary.credentials.codex === "unbound") &&
                  [summary.credentials.claude, summary.credentials.codex].every(
                    (state) => state === "unbound" || state === "no-login",
                  )))
            )
              return summary;
            yield* PubSub.take(subscription);
          }
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

  // An autoupdating box moves to the template's latest version, which requires the marker
  // z devbox create sends; a default is ignored by templates without it, and is only used
  // rather than prompted for with --use-parameter-defaults.
  const startWorkspace = (name: string) =>
    coder(
      [
        "start",
        name,
        "--yes",
        "--use-parameter-defaults",
        "--parameter-default",
        "created_via=z-devbox",
      ],
      "15 minutes",
    );

  /** Starts the box and reconnects it, returning once it answers here. */
  const wakeNow = Effect.fn("DevboxService.wakeNow")(function* (name: string) {
    const record = yield* getRecord(name);
    yield* locks.withLock(
      name,
      Effect.gen(function* () {
        yield* setTransient(name, { state: "starting", lastError: null });
        const workspace = (yield* workspaces).get(name);
        if (workspace?.latest_build.status === "deleting") {
          return yield* new DevboxError({
            reason: "busy",
            message: `${name} is currently being deleted.`,
          });
        }
        if (workspace?.latest_build.status !== "running") {
          pushedCursorKeys.delete(name);
          pushedAntigravity.delete(name);
          yield* FiberMap.remove(antigravitySyncs, name);
          yield* FiberMap.remove(vertexTunnels, name);
          yield* startWorkspace(name);
        }
        yield* connect(record);
      }).pipe(
        Effect.tapError((error) =>
          setTransient(name, { state: "failed", lastError: error.message }),
        ),
      ),
    );
    return yield* summaryOf(name);
  });

  // Waking takes minutes; callers follow the box's state instead of holding a request open.
  const wake: DevboxService["Service"]["wake"] = Effect.fn("DevboxService.wake")(function* (name) {
    yield* getRecord(name);
    if ((yield* Ref.get(transient)).get(name)?.state === "deleting") {
      return yield* new DevboxError({
        reason: "busy",
        message: `${name} is currently being deleted.`,
      });
    }
    yield* setTransient(name, { state: "starting", lastError: null });
    yield* FiberMap.run(creations, name, wakeNow(name).pipe(Effect.ignore), {
      onlyIfMissing: true,
    });
    return yield* summaryOf(name);
  });

  // Stopping takes about a minute; callers follow the box's state instead of waiting.
  const stop: DevboxService["Service"]["stop"] = Effect.fn("DevboxService.stop")(function* (name) {
    const record = yield* getRecord(name);
    if ((yield* Ref.get(transient)).get(name)?.state === "deleting") {
      return yield* new DevboxError({
        reason: "busy",
        message: `${name} is currently being deleted.`,
      });
    }
    yield* setTransient(name, { state: "stopping", lastError: null });
    yield* FiberMap.run(
      creations,
      name,
      locks
        .withLock(
          name,
          snapshotBoxUsage(record).pipe(
            Effect.andThen(FiberMap.remove(tunnels, name)),
            Effect.andThen(FiberMap.remove(antigravitySyncs, name)),
            Effect.andThen(FiberMap.remove(vertexTunnels, name)),
            Effect.andThen(coder(["stop", name, "--yes"], "10 minutes")),
          ),
        )
        .pipe(
          Effect.andThen(setTransient(name, undefined)),
          Effect.catchCause((cause) =>
            setTransient(name, { state: "failed", lastError: errorText(cause) }),
          ),
        ),
    );
    return yield* summaryOf(name);
  });

  const hasActiveRun = (name: string) =>
    ssh(name, `python3 -c ${shellQuote(ACTIVE_RUN_SCRIPT)}`, undefined, "1 minute").pipe(
      Effect.map((stdout) => stdout.trim().endsWith("1")),
    );

  const fenceLostError = (name: string, error?: DevboxError) =>
    error?.reason === "busy"
      ? error
      : new DevboxError({
          reason: "migration",
          message: error
            ? `Lost write fence on ${name} before deleting: ${error.message}`
            : `Lost write fence on ${name} before deleting; retry to ensure no new turns were missed.`,
        });

  // Stops t3code.service and holds remote server-owner.sqlite in a scoped SSH fiber.
  // Outer uninterruptibleMask + addFinalizer (not acquireRelease) keeps the pre-FENCED wait interruptible.
  const acquireRemoteT3Fence = (name: string, rejectActiveRuns: boolean) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const fenced = yield* Deferred.make<void, DevboxError>();
        const lost = yield* Deferred.make<DevboxError>();
        const decoder = new TextDecoder();
        let stdoutBuf = "";
        const command = rejectActiveRuns ? "python3 - --check-active --hold" : "python3 - --hold";
        const fenceRun = runner
          .run({
            command: "ssh",
            args: [
              "-o",
              "BatchMode=yes",
              "-o",
              "ConnectTimeout=30",
              "-o",
              "ServerAliveInterval=15",
              "-o",
              "ServerAliveCountMax=3",
              `coder.${name}`,
              command,
            ],
            stdin: FENCE_T3_SCRIPT,
            timeout: "35 minutes",
            env: { BROWSER: browserFilter },
            maxOutputBytes: 4096,
            outputMode: "truncate",
            onStdoutChunk: (chunk) => {
              if (Deferred.isDoneUnsafe(fenced)) return;
              stdoutBuf += decoder.decode(chunk, { stream: true });
              if (stdoutBuf.includes("FENCED\n")) {
                Deferred.doneUnsafe(fenced, Effect.void);
              }
            },
          })
          .pipe(
            Effect.mapError(devboxError("provision")),
            Effect.flatMap((result) => {
              const stderr = result.stderr
                .split("\n")
                .filter((line) => !SSH_NOISE.test(line))
                .join("\n")
                .trim()
                .slice(-800);
              if (result.code === 42 && stderr.includes("ACTIVE_RUNS:")) {
                return Effect.fail(
                  new DevboxError({
                    reason: "busy",
                    message: `${name} has an active turn. Stop it first, or delete with force.`,
                  }),
                );
              }
              if (result.code !== 0) {
                return Effect.fail(
                  new DevboxError({
                    reason: "provision",
                    message: stderr
                      ? `ssh ${name} fence exited with ${String(result.code)}: ${stderr}`
                      : `ssh ${name} fence exited with ${String(result.code)}.`,
                  }),
                );
              }
              if (!Deferred.isDoneUnsafe(fenced)) {
                return Effect.fail(
                  new DevboxError({
                    reason: "migration",
                    message: `ssh ${name} fence exited before confirming lock acquisition.`,
                  }),
                );
              }
              return Effect.void;
            }),
            Effect.tapError((error) =>
              Effect.sync(() => {
                Deferred.doneUnsafe(fenced, Effect.fail(error));
                Deferred.doneUnsafe(lost, Effect.succeed(fenceLostError(name, error)));
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                Deferred.doneUnsafe(lost, Effect.succeed(fenceLostError(name)));
              }),
            ),
          );

        const fiber = yield* Effect.forkChild(fenceRun);
        yield* Effect.addFinalizer(() => Fiber.interrupt(fiber));
        yield* restore(
          Effect.raceFirst(Deferred.await(fenced), Fiber.join(fiber)).pipe(
            Effect.timeoutOrElse({
              duration: "2 minutes",
              orElse: () =>
                Effect.fail(
                  new DevboxError({
                    reason: "migration",
                    message: `Timed out waiting to fence ${name} before deleting.`,
                  }),
                ),
            }),
          ),
        ).pipe(
          Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Fiber.interrupt(fiber))),
        );
        return { fiber, lost };
      }),
    );

  // Verifies the fence lock is still held, moves ~/.config/systemd/user/t3code.service aside
  // (avoiding shadowed --runtime masks), and chmods server-owner.sqlite to 000 so no T3 server
  // can start while `coder delete` tears down the workspace.
  const sealRemoteT3ForDelete = (name: string) =>
    ssh(
      name,
      `set -eu; export XDG_RUNTIME_DIR="/run/user/$(id -u)"; python3 -c 'import os, sqlite3, sys; p = os.path.expanduser("~/.t3/userdata/server-owner.sqlite"); db = sqlite3.connect(p, isolation_level=None); db.execute("PRAGMA busy_timeout = 0");
try:
    db.execute("BEGIN EXCLUSIVE")
except sqlite3.OperationalError as exc:
    if "locked" in str(exc).lower() or "busy" in str(exc).lower():
        sys.exit(0)
    raise
db.execute("ROLLBACK"); db.close(); sys.exit("write fence lock was no longer held")'; unit="$HOME/.config/systemd/user/t3code.service"; if [ -f "$unit" ]; then mv "$unit" "$unit.t3-sealed"; systemctl --user daemon-reload; fi; chmod 000 "$HOME/.t3/userdata/server-owner.sqlite"`,
      undefined,
      "1 minute",
    );

  const unsealRemoteT3 = (name: string) =>
    ssh(
      name,
      'set -eu; export XDG_RUNTIME_DIR="/run/user/$(id -u)"; unit="$HOME/.config/systemd/user/t3code.service"; if [ -f "$unit.t3-sealed" ]; then mv "$unit.t3-sealed" "$unit"; systemctl --user daemon-reload; fi; if [ -e "$HOME/.t3/userdata/server-owner.sqlite" ]; then chmod 0644 "$HOME/.t3/userdata/server-owner.sqlite"; fi',
      undefined,
      "1 minute",
    );

  const startRemoteT3Service = (name: string) =>
    ssh(
      name,
      'set -eu; export XDG_RUNTIME_DIR="/run/user/$(id -u)"; unit="$HOME/.config/systemd/user/t3code.service"; if [ -f "$unit.t3-sealed" ]; then mv "$unit.t3-sealed" "$unit"; systemctl --user daemon-reload; fi; if [ -e "$HOME/.t3/userdata/server-owner.sqlite" ]; then chmod 0644 "$HOME/.t3/userdata/server-owner.sqlite"; fi; load_state=$(systemctl --user show -p LoadState --value t3code.service); if [ "$load_state" = "loaded" ]; then systemctl --user start t3code.service; fi',
      undefined,
      "1 minute",
    );

  const isInFlightCoderBuild = (status: string | undefined) =>
    status === "starting" ||
    status === "stopping" ||
    status === "pending" ||
    status === "canceling";

  const isSafeToReopenAfterDeleteFailure = (status: string | undefined) =>
    status === "running" || status === "stopped" || status === "failed" || status === "canceled";

  const remove: DevboxService["Service"]["remove"] = Effect.fn("DevboxService.remove")(
    function* (name, options) {
      if (options.skipMigration && !options.force) {
        return yield* new DevboxError({
          reason: "invalid",
          message: "skipMigration requires force: true.",
        });
      }
      yield* getRecord(name);
      if (!options.force) {
        const preflightStatus = (yield* workspaces).get(name)?.latest_build.status;
        if (isInFlightCoderBuild(preflightStatus)) {
          return yield* new DevboxError({
            reason: "busy",
            message: `${name} is currently ${preflightStatus}. Wait a moment and retry deleting so its threads can be copied safely, or delete with force.`,
          });
        }
      }
      yield* FiberMap.remove(creations, name);
      return yield* locks.withLock(
        name,
        Effect.gen(function* () {
          // Re-read inside the per-box lock so a concurrent create/connect/remove cannot leave
          // us acting on a stale environmentId or an already-deleted record.
          const record = yield* getRecord(name);
          const workspace = (yield* workspaces).get(name);
          const status = workspace?.latest_build.status;
          yield* setTransient(name, { state: "deleting", lastError: null });
          let wokeForMigration = false;
          let stoppedServiceForMigration = false;
          let sealedForDelete = false;
          let deleteSubmitted = false;
          let deletedOnCoder = false;
          return yield* Effect.scoped(
            Effect.gen(function* () {
              let migratedThreads = 0;
              let skippedThreads = 0;
              let migratedAttachments = 0;
              let migrationWarning: string | undefined;
              let activeFenceLost: Deferred.Deferred<DevboxError> | undefined;

              const shouldMigrate =
                workspace !== undefined &&
                !(options.force && options.skipMigration) &&
                status !== "deleting" &&
                status !== "deleted";

              if (shouldMigrate) {
                // On force delete, skip waking only when the Coder workspace itself is failed;
                // stopped boxes (e.g. after a stopped -> busy -> force retry) are still woken & copied.
                if (options.force && status === "failed") {
                  migrationWarning = `Skipped copying threads from ${name} because its workspace is failed and force delete was requested.`;
                } else if (!options.force && isInFlightCoderBuild(status)) {
                  return yield* new DevboxError({
                    reason: "busy",
                    message: `${name} is currently ${status}. Wait a moment and retry deleting so its threads can be copied safely, or delete with force.`,
                  });
                } else {
                  const migrateEffect = Effect.gen(function* () {
                    if (status !== "running" && status !== "starting") {
                      // Mark before calling startWorkspace so an interrupt/timeout mid-start still stops the box.
                      wokeForMigration = true;
                      yield* startWorkspace(name);
                    }
                    yield* coder(["ssh", "--wait=no", name, "--", "true"], "5 minutes");
                    if (status === "running" && (yield* FiberMap.has(tunnels, name))) {
                      yield* triggerBoxUsageRefresh(record);
                    }
                    // Mark before fencing so an interrupt/timeout mid-stop still restarts t3code.service.
                    // The remote ownership lock stays held in this scope through coder delete.
                    stoppedServiceForMigration = true;
                    const fence = yield* acquireRemoteT3Fence(name, !options.force);
                    activeFenceLost = fence.lost;
                    const migrated = yield* Effect.raceFirst(
                      threadMigration.migrateFromDevbox({
                        name,
                        expectDatabase: record.environmentId !== null,
                        rejectActiveRuns: !options.force,
                        runSshBinary: (remote, sshOptions) => sshBinary(name, remote, sshOptions),
                      }),
                      Deferred.await(fence.lost).pipe(Effect.flatMap(Effect.fail)),
                    );
                    yield* snapshotBoxUsage(record, { triggerSummary: false });
                    return migrated;
                  });
                  const migrationResult = yield* migrateEffect.pipe(
                    Effect.map((result) => ({ ok: true as const, result })),
                    Effect.catch((error) =>
                      options.force
                        ? Effect.logWarning(
                            "devbox thread migration failed; continuing because force is set",
                            {
                              name,
                              error: error.message,
                            },
                          ).pipe(
                            Effect.as({
                              ok: false as const,
                              warning: `Could not copy threads from ${name}: ${error.message}`,
                            }),
                          )
                        : error.reason === "busy"
                          ? Effect.fail(error)
                          : Effect.fail(
                              new DevboxError({
                                reason: "migration",
                                message: `Could not copy threads from ${name} before deleting: ${error.message} Retry, or delete with force to discard its threads.`,
                              }),
                            ),
                    ),
                  );
                  if (migrationResult.ok) {
                    migratedThreads = migrationResult.result.migratedThreads;
                    skippedThreads = migrationResult.result.skippedThreads;
                    migratedAttachments = migrationResult.result.migratedAttachments;
                    if (migrationResult.result.warning !== undefined) {
                      migrationWarning = migrationResult.result.warning;
                    }
                  } else {
                    migrationWarning = migrationResult.warning;
                  }
                }
              }

              let pendingDeletedHistory: DeletedDevboxRecord | undefined;
              if (workspace !== undefined) {
                pendingDeletedHistory = yield* collectDeletedRecord(
                  name,
                  record.environmentId,
                  workspace.id,
                ).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("devbox usage could not be kept", { name, cause }).pipe(
                      Effect.as(undefined),
                    ),
                  ),
                );
                if (activeFenceLost !== undefined) {
                  if (!options.force && Deferred.isDoneUnsafe(activeFenceLost)) {
                    return yield* Deferred.await(activeFenceLost).pipe(Effect.flatMap(Effect.fail));
                  }
                  sealedForDelete = true;
                  const sealEffect = sealRemoteT3ForDelete(name);
                  if (options.force) {
                    yield* sealEffect.pipe(Effect.ignore);
                  } else {
                    yield* sealEffect.pipe(
                      Effect.mapError(
                        (error) =>
                          new DevboxError({
                            reason: "migration",
                            message: `Could not seal ${name} against new writes before deleting: ${error.message} Retry, or delete with force to discard its threads.`,
                          }),
                      ),
                    );
                    if (Deferred.isDoneUnsafe(activeFenceLost)) {
                      return yield* Deferred.await(activeFenceLost).pipe(
                        Effect.flatMap(Effect.fail),
                      );
                    }
                  }
                }
                deleteSubmitted = true;
                yield* coder(["delete", name, "--yes"], "15 minutes");
                deletedOnCoder = true;
                if (pendingDeletedHistory !== undefined) {
                  const entry = pendingDeletedHistory;
                  yield* Ref.update(history, (current) => [
                    ...current.filter((box) => box.name !== name),
                    entry,
                  ]);
                }
              }
              yield* FiberMap.remove(creations, name);
              yield* FiberMap.remove(tunnels, name);
              yield* FiberMap.remove(antigravitySyncs, name);
              yield* FiberMap.remove(vertexTunnels, name);
              if (record.environmentId !== null)
                yield* peerLinks.unlink(record.environmentId as EnvironmentId).pipe(Effect.ignore);
              yield* FiberSet.run(background, unlinkSiblings(record).pipe(Effect.ignore));
              pushed.delete(name);
              pushedCursorKeys.delete(name);
              pushedAntigravity.delete(name);
              persistedAntigravityManaged.delete(name);
              unboundBoxes.delete(name);
              bindAttempts.delete(name);
              yield* Ref.update(records, (current) => {
                const next = new Map(current);
                next.delete(name);
                return next;
              });
              yield* save();
              yield* setTransient(name, undefined);
              return {
                name,
                deleted: true,
                migratedThreads,
                skippedThreads,
                migratedAttachments,
                ...(migrationWarning === undefined ? {} : { migrationWarning }),
              };
            }),
          ).pipe(
            // Runs after Effect.scoped releases the remote fence SSH fiber. If coder delete was
            // submitted, keep the box sealed unless Coder confirms the delete did not stay active.
            Effect.onExit((exit) => {
              if (Exit.isSuccess(exit)) return Effect.void;
              return Effect.gen(function* () {
                yield* FiberMap.remove(creations, name);
                if (deletedOnCoder) return;
                if (deleteSubmitted) {
                  const refreshed = yield* workspaces.pipe(Effect.orElseSucceed(() => undefined));
                  const latestStatus = refreshed?.get(name)?.latest_build.status;
                  if (!isSafeToReopenAfterDeleteFailure(latestStatus)) {
                    // Tear down the SSH tunnel so if inventory later recovers with the box still
                    // running, periodic reconnect runs PROVISION_SCRIPT to unseal and restart T3.
                    yield* FiberMap.remove(tunnels, name);
                    yield* Effect.logWarning(
                      "keeping devbox sealed because Coder delete may still be in progress",
                      { name, latestStatus: latestStatus ?? "unknown" },
                    );
                    return;
                  }
                }
                if (wokeForMigration) {
                  if (sealedForDelete || stoppedServiceForMigration) {
                    yield* unsealRemoteT3(name).pipe(
                      Effect.catchCause((cause) =>
                        Effect.logWarning(
                          "could not unseal devbox woken for failed/interrupted delete",
                          { name, cause },
                        ),
                      ),
                    );
                  }
                  yield* coder(["stop", name, "--yes"], "2 minutes").pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning(
                        "could not stop devbox woken for failed/interrupted migration",
                        { name, cause },
                      ),
                    ),
                  );
                } else if (stoppedServiceForMigration) {
                  yield* startRemoteT3Service(name).pipe(
                    Effect.catchCause((cause) =>
                      FiberMap.remove(tunnels, name).pipe(
                        Effect.andThen(
                          Effect.logWarning(
                            "could not restart t3code.service after failed/interrupted delete",
                            { name, cause },
                          ),
                        ),
                      ),
                    ),
                  );
                }
              }).pipe(Effect.andThen(setTransient(name, undefined)));
            }),
          );
        }),
      );
    },
  );

  const pairClient: DevboxService["Service"]["pairClient"] = Effect.fn("DevboxService.pairClient")(
    function* (name) {
      const record = yield* getRecord(name);
      if (record.environmentId === null)
        return yield* new DevboxError({ reason: "invalid", message: `${name} is not linked yet.` });
      const pairingCode = yield* mintPairingCode(name, "T3 Code client");
      return {
        environmentId: record.environmentId as EnvironmentId,
        url: `http://127.0.0.1:${record.localPort}`,
        pairingCode,
      };
    },
  );

  const ensureSpares = allocation
    .withPermit(
      Effect.gen(function* () {
        if (spareCount <= 0) return;
        const spares = [...(yield* Ref.get(records)).values()].filter(
          (record) => record.spare === true,
        );
        for (let missing = spareCount - spares.length; missing > 0; missing--) {
          yield* startCreate({}, true);
        }
      }),
    )
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("devbox spare could not be started", { cause }),
      ),
    );

  const create: DevboxService["Service"]["create"] = Effect.fn("DevboxService.create")(
    function* (input) {
      const box = yield* allocation.withPermit(
        Effect.gen(function* () {
          if (input.branch !== undefined) return yield* startCreate(input, false);
          const all = yield* workspaces;
          const spares = [...(yield* Ref.get(records)).values()].filter(
            (record) => record.spare === true,
          );
          // A linked running spare is ready now; a stopped one wakes in about 90 seconds.
          const ranked = spares.toSorted(
            (a, b) =>
              Number(all.get(b.name)?.latest_build.status === "running") -
                Number(all.get(a.name)?.latest_build.status === "running") ||
              Number(b.environmentId !== null) - Number(a.environmentId !== null),
          );
          const picked = ranked[0];
          if (picked === undefined) return yield* startCreate(input, false);
          yield* updateRecord(picked.name, ({ spare: _spare, ...claimed }) => ({
            ...claimed,
            task: input.task ?? null,
          }));
          if (!(yield* FiberMap.has(creations, picked.name))) yield* wake(picked.name);
          return yield* summaryOf(picked.name);
        }),
      );
      yield* FiberSet.run(background, ensureSpares);
      return box;
    },
  );

  const claim: DevboxService["Service"]["claim"] = Effect.gen(function* () {
    const { name } = yield* create({});
    const settled = yield* awaitReady(name, CREATE_TIMEOUT);
    if (settled.state !== "running" || settled.environmentId === null) yield* wakeNow(name);
    // After a restart the forward to a running box may not be up yet; the client needs it now.
    else yield* startTunnel(yield* getRecord(name));
    const pairing = yield* pairClient(name);
    return { ...pairing, name };
  }).pipe(Effect.withSpan("DevboxService.claim"));

  const loginOf = Effect.fn("DevboxService.loginOf")(function* (provider: DevboxLoginProvider) {
    const info = yield* logins.info(provider);
    return {
      provider,
      ...info,
      signingIn: yield* FiberMap.has(loginWorkers, provider),
      pendingUrl: yield* logins.pendingUrl(provider),
      lastError: (yield* Ref.get(loginErrors))[provider],
    } satisfies DevboxLogin;
  });
  const loginList: DevboxService["Service"]["logins"] = Effect.forEach(
    DevboxLogins.DEVBOX_LOGIN_PROVIDERS,
    (provider) => loginOf(provider),
  );
  const startLogin: DevboxService["Service"]["startLogin"] = Effect.fn("DevboxService.startLogin")(
    function* (provider) {
      // A refusal stays shown until the new sign-in succeeds, even if this one is cancelled.
      if (!refused.has(provider)) yield* setLoginError(provider, null);
      yield* FiberMap.run(
        loginWorkers,
        provider,
        logins.signIn(provider).pipe(
          // A new sign-in replaces any refusal of the old one.
          Effect.tap(() =>
            Effect.sync(() => refused.delete(provider)).pipe(
              Effect.andThen(setLoginError(provider, null)),
            ),
          ),
          // Apart from the sign-in, so Cancel can never interrupt a renewal.
          Effect.andThen(FiberSet.run(background, syncLogins)),
          Effect.catch((error) => setLoginError(provider, error.message)),
        ),
        { onlyIfMissing: true },
      );
      return yield* loginOf(provider);
    },
  );
  const cancelLogin: DevboxService["Service"]["cancelLogin"] = Effect.fn(
    "DevboxService.cancelLogin",
  )(function* (provider) {
    yield* FiberMap.remove(loginWorkers, provider);
    return yield* loginOf(provider);
  });
  const signOut: DevboxService["Service"]["signOut"] = Effect.fn("DevboxService.signOut")(
    function* (provider) {
      yield* FiberMap.remove(loginWorkers, provider);
      const signedOut = yield* logins.signOut(provider).pipe(Effect.result);
      refused.delete(provider);
      yield* setLoginError(
        provider,
        signedOut._tag === "Failure" ? signedOut.failure.message : null,
      );
      // Boxes keep their token until it expires, but show the sign-out at once.
      pushed.clear();
      yield* FiberSet.run(background, syncLogins);
      return yield* loginOf(provider);
    },
  );

  const submitLoginCode: DevboxService["Service"]["submitLoginCode"] = Effect.fn(
    "DevboxService.submitLoginCode",
  )(function* (provider, code) {
    yield* logins.submitCode(provider, code).pipe(Effect.mapError(devboxError("invalid")));
  });

  // ── usage ────────────────────────────────────────────────────────────────
  // A token of its own for Coder's REST API; the CLI keeps its session in the OS keychain.
  const tokenPath = path.join(config.stateDir, "devbox-coder-token");
  const coderUrl = yield* Effect.cached(
    coder(["whoami", "--output", "json"], "1 minute").pipe(
      Effect.flatMap(decodeWhoami),
      Effect.flatMap((entries) =>
        entries[0] === undefined
          ? Effect.fail(new DevboxError({ reason: "coder", message: "Coder is not signed in." }))
          : Effect.succeed(entries[0].url),
      ),
      Effect.mapError(devboxError("coder")),
    ),
  );
  const tokenLock = yield* Semaphore.make(1);
  // Coder v2.37+ keeps expired tokens in the DB unless `--delete` is passed, which blocks reusing
  // the token name; fall back to plain `rm` for older CLIs that do not accept `--delete`.
  const mintToken = coder(["tokens", "rm", "--delete", USAGE_TOKEN_NAME]).pipe(
    Effect.catch(() => coder(["tokens", "rm", USAGE_TOKEN_NAME])),
    Effect.ignore,
    Effect.andThen(
      coder(["tokens", "create", "--name", USAGE_TOKEN_NAME, "--lifetime", "720h"], "1 minute"),
    ),
    Effect.map((stdout) => stdout.trim().split("\n").at(-1)?.trim() ?? ""),
    Effect.tap((token) =>
      fs.writeFileString(tokenPath, token, { mode: 0o600 }).pipe(Effect.ignore),
    ),
  );
  const coderGet = Effect.fn("DevboxService.coderGet")(function* (apiPath: string) {
    const base = yield* coderUrl;
    const send = (token: string) =>
      httpClient
        .execute(
          HttpClientRequest.get(`${base}${apiPath}`).pipe(
            HttpClientRequest.setHeader("Coder-Session-Token", token),
          ),
        )
        .pipe(Effect.mapError(devboxError("coder")));
    const readToken = fs.readFileString(tokenPath).pipe(
      Effect.map((text) => text.trim()),
      Effect.orElseSucceed(() => ""),
    );
    // Box histories load in parallel; one caller makes the token, the rest reuse it.
    const tokenOtherThan = (rejected: string) =>
      tokenLock.withPermit(
        readToken.pipe(
          Effect.filterOrElse(
            (token) => token !== "" && token !== rejected,
            () => mintToken,
          ),
        ),
      );
    const first = yield* tokenOtherThan("");
    let response = yield* send(first);
    // Expired or revoked: make a new one once.
    if (response.status === 401) response = yield* send(yield* tokenOtherThan(first));
    if (response.status >= 400)
      return yield* new DevboxError({
        reason: "coder",
        message: `Coder answered ${response.status} for ${apiPath}.`,
      });
    return yield* response.json.pipe(Effect.mapError(devboxError("coder")));
  });
  /** Newest first, back to the first build before `since` so the state at `since` is known. */
  const buildsSince = Effect.fn("DevboxService.buildsSince")(function* (
    workspaceId: string,
    since: number,
  ) {
    const builds: Array<CoderBuild> = [];
    for (let offset = 0; ; offset += 100) {
      const page = yield* coderGet(
        `/api/v2/workspaces/${workspaceId}/builds?limit=100&offset=${offset}`,
      ).pipe(Effect.flatMap(decodeBuilds), Effect.mapError(devboxError("coder")));
      builds.push(...page);
      if (page.length < 100 || page.some((build) => Date.parse(build.created_at) < since)) break;
    }
    return builds;
  });
  const entryOf = (
    name: string,
    managed: boolean,
    state: DevboxUsageResult["boxes"][number]["state"],
    awake: ReadonlyArray<TimeSpan>,
    existed: TimeSpan | null,
    since: number,
    until: number,
  ) => {
    const awakeHours = hoursWithin(awake, since, until);
    const existedHours = existed === null ? 0 : hoursWithin([existed], since, until);
    const asleepHours = Math.max(0, existedHours - awakeHours);
    return {
      name,
      managed,
      state,
      awakeHours,
      asleepHours,
      cost: awakeHours * AWAKE_RATE + asleepHours * DISK_RATE,
    };
  };
  const usage: DevboxService["Service"]["usage"] = Effect.fn("DevboxService.usage")(
    function* (input) {
      const since = Date.parse(input.since);
      const until = Date.parse(input.until);
      const now = yield* Clock.currentTimeMillis;
      const current = yield* Ref.get(records);
      const all = [...(yield* workspaces).values()];
      const live = yield* Effect.forEach(
        all.flatMap((workspace) =>
          workspace.id === undefined ? [] : [{ ...workspace, id: workspace.id }],
        ),
        (workspace) =>
          buildsSince(workspace.id, since).pipe(
            Effect.map((builds) => {
              const spans = devboxSpans(builds, now);
              const record = current.get(workspace.name);
              return entryOf(
                workspace.name,
                record !== undefined,
                record === undefined
                  ? coderState(workspace)
                  : summarize(record, workspace, undefined).state,
                spans.awake,
                spans.existed,
                since,
                until,
              );
            }),
          ),
        { concurrency: 4 },
      );
      const gone = (yield* Ref.get(history)).map((box) =>
        entryOf(box.name, true, null, box.awake, box.existed, since, until),
      );
      return {
        boxes: [...live, ...gone]
          .filter((entry) => entry.awakeHours + entry.asleepHours > 0)
          .toSorted((a, b) => b.cost - a.cost),
        awakeRate: AWAKE_RATE,
        asleepRate: DISK_RATE,
      };
    },
  );
  /** Captures a box's usage spans before Coder forgets them on delete. */
  const collectDeletedRecord = Effect.fn("DevboxService.collectDeletedRecord")(function* (
    name: string,
    environmentId: string | null,
    workspaceId: string | undefined,
  ) {
    if (workspaceId === undefined) return undefined;
    const builds = yield* buildsSince(workspaceId, 0);
    const spans = devboxSpans(builds, yield* Clock.currentTimeMillis);
    if (spans.existed === null) return undefined;
    const existed = spans.existed;
    return {
      name,
      ...(environmentId === null ? {} : { environmentId }),
      awake: spans.awake,
      existed,
    } satisfies DeletedDevboxRecord;
  });

  const deleted: DevboxService["Service"]["deleted"] = Ref.get(history).pipe(
    Effect.map((boxes) =>
      boxes.map((box) => ({
        name: box.name,
        environmentId: (box.environmentId ?? null) as EnvironmentId | null,
      })),
    ),
  );

  const byEnvironment: DevboxService["Service"]["byEnvironment"] = (environmentId) =>
    Ref.get(records).pipe(
      Effect.flatMap((current) => {
        const record = [...current.values()].find((entry) => entry.environmentId === environmentId);
        return record ? summaryOf(record.name).pipe(Effect.asSome) : Effect.succeedNone;
      }),
    );

  // ── background: reconnect running boxes, keep busy boxes awake ───────────
  const stored = yield* load;
  yield* Ref.set(records, new Map(stored.devboxes.map((record) => [record.name, record])));
  for (const record of stored.devboxes) {
    if (record.antigravityManaged === true) persistedAntigravityManaged.add(record.name);
  }
  yield* Ref.set(nextNumber, stored.nextNumber);
  yield* Ref.set(history, stored.history ?? []);
  const reconnect = Effect.gen(function* () {
    const all = yield* workspaces;
    const ordered = [...(yield* Ref.get(records)).values()].toSorted(
      (a, b) => Number(b.spare === true) - Number(a.spare === true),
    );
    const live: Array<DevboxRecord> = [];
    for (const record of ordered) {
      // A spare whose creation stopped before Coder made it would block every new spare.
      if (record.spare === true && record.environmentId === null && !all.has(record.name)) {
        yield* Ref.update(records, (current) => {
          const next = new Map(current);
          next.delete(record.name);
          return next;
        });
        yield* save().pipe(Effect.ignore);
        continue;
      }
      if (all.get(record.name)?.latest_build.status === "running") live.push(record);
    }
    // Spares first, all at once: a restart should not keep the next box offline for minutes.
    yield* Effect.forEach(
      live,
      (record) =>
        locks
          .withLock(record.name, connect(record))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("devbox reconnect failed", { name: record.name, cause }),
            ),
          ),
      { concurrency: 4, discard: true },
    );
  });
  const keepAwake = Effect.gen(function* () {
    const all = yield* workspaces;
    for (const record of (yield* Ref.get(records)).values()) {
      if (all.get(record.name)?.latest_build.status !== "running") continue;
      const busy = yield* hasActiveRun(record.name).pipe(Effect.orElseSucceed(() => false));
      if (busy)
        yield* coder(["schedule", "extend", record.name, KEEP_ALIVE_EXTENSION]).pipe(Effect.ignore);
      yield* FiberSet.run(background, snapshotBoxUsage(record));
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("devbox keep-awake failed", { cause })),
    Effect.repeat(Schedule.spaced(KEEP_ALIVE_INTERVAL)),
  );
  // A box deleted outside T3 (Coder's dashboard, `coder delete`, a cleanup job) goes the way a
  // delete here does, except that Coder already dropped the builds its cost came from.
  const goneMisses = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const forgetGone = Effect.fn("DevboxService.forgetGone")(function* (name: string) {
    const record = (yield* Ref.get(records)).get(name);
    if (record === undefined) return;
    yield* FiberMap.remove(tunnels, name);
    yield* FiberMap.remove(antigravitySyncs, name);
    yield* FiberMap.remove(vertexTunnels, name);
    if (record.environmentId !== null)
      yield* peerLinks.unlink(record.environmentId as EnvironmentId).pipe(Effect.ignore);
    yield* FiberSet.run(background, unlinkSiblings(record).pipe(Effect.ignore));
    pushed.delete(name);
    pushedCursorKeys.delete(name);
    pushedUsageAccess.delete(name);
    pushedAntigravity.delete(name);
    persistedAntigravityManaged.delete(name);
    unboundBoxes.delete(name);
    bindAttempts.delete(name);
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.update(history, (current) => [
      ...current.filter((box) => box.name !== name),
      {
        name,
        ...(record.environmentId === null ? {} : { environmentId: record.environmentId }),
        awake: [],
        existed: [Date.parse(record.createdAt), now] as const,
      },
    ]);
    yield* Ref.update(records, (current) => {
      const next = new Map(current);
      next.delete(name);
      return next;
    });
    yield* setTransient(name, undefined);
    yield* save();
    yield* Effect.logInfo("devbox deleted outside T3", { name });
  });
  const reconcileWithCoder = Effect.fn("DevboxService.reconcileWithCoder")(function* (
    all: ReadonlyMap<string, CoderWorkspace>,
  ) {
    const recorded = [...(yield* Ref.get(records)).keys()];
    const creating = new Set(
      yield* Effect.filter(recorded, (name) => FiberMap.has(creations, name)),
    );
    const result = goneFromCoder({
      recorded,
      listed: new Set(all.keys()),
      creating,
      misses: yield* Ref.get(goneMisses),
      confirmations: 2,
    });
    yield* Ref.set(goneMisses, result.misses);
    for (const name of result.gone) yield* locks.withLock(name, forgetGone(name));
    if (result.gone.length > 0) yield* FiberSet.run(background, ensureSpares);
  });

  // A running box left unconnected (a failed or interrupted setup, or one started outside
  // T3 after a sleep removed its forward) gets another try.
  const heal = Effect.gen(function* () {
    // Only a list Coder answered counts; a failed `coder list` fails this pass instead.
    const all = yield* workspaces;
    yield* reconcileWithCoder(all);
    yield* syncCursor(all);
    yield* syncUsageAccess(all);
    yield* syncAntigravity(all, true);
    const held = new Set(yield* locks.activeKeys);
    const currentTransient = yield* Ref.get(transient);
    for (const record of (yield* Ref.get(records)).values()) {
      if (all.get(record.name)?.latest_build.status !== "running") continue;
      if (held.has(record.name)) continue;
      const state = currentTransient.get(record.name)?.state;
      if (state === "deleting" || state === "stopping") continue;
      if (yield* FiberMap.has(creations, record.name)) continue;
      if (
        record.environmentId !== null &&
        ((yield* FiberMap.has(tunnels, record.name)) || (yield* answersHere(record)))
      )
        continue;
      yield* FiberMap.run(
        creations,
        record.name,
        locks
          .withLock(
            record.name,
            Effect.gen(function* () {
              const latestRecord = (yield* Ref.get(records)).get(record.name);
              if (latestRecord === undefined) return;
              const latestState = (yield* Ref.get(transient)).get(record.name)?.state;
              if (latestState === "deleting" || latestState === "stopping") return;
              const latestStatus = (yield* workspaces).get(record.name)?.latest_build.status;
              if (latestStatus !== "running") return;
              yield* connect(latestRecord);
            }),
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("devbox setup retry failed", { name: record.name, cause }),
            ),
          ),
      );
    }
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("devbox heal failed", { cause })));
  const settingsChanges = yield* settings.subscribeChanges;
  const initialSettings = yield* settings.getSettings;
  let lastCursorSetting = cursorSetting(initialSettings);
  let lastAntigravitySetting = antigravitySettingKey(initialSettings);
  let lastUsageAccessSetting = usageAccessSettingKey(initialSettings);
  yield* settingsChanges.pipe(
    Stream.map((snapshot) => ({
      cursor: cursorSetting(snapshot),
      antigravity: antigravitySettingKey(snapshot),
      usageAccess: usageAccessSettingKey(snapshot),
    })),
    Stream.changesWith(
      (a, b) =>
        a.cursor === b.cursor && a.antigravity === b.antigravity && a.usageAccess === b.usageAccess,
    ),
    Stream.runForEach(({ cursor, antigravity, usageAccess }) =>
      Effect.gen(function* () {
        if (cursor !== lastCursorSetting) {
          lastCursorSetting = cursor;
          yield* syncCursor(undefined);
        }
        if (antigravity !== lastAntigravitySetting) {
          lastAntigravitySetting = antigravity;
          yield* syncAntigravity(undefined, false);
        }
        if (usageAccess !== lastUsageAccessSetting) {
          lastUsageAccessSetting = usageAccess;
          yield* syncUsageAccess(undefined);
        }
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.logWarning("devbox settings sync failed", { cause }),
        ),
      ),
    ),
    Effect.forkScoped,
  );
  yield* forkParked(Effect.sleep(Duration.minutes(2)).pipe(Effect.andThen(heal), Effect.forever));
  // An idle tick is one `coder list`; a box that just got Formal gets its token within minutes.
  yield* forkParked(
    Effect.sleep(LOGIN_SYNC_INTERVAL).pipe(Effect.andThen(syncLogins), Effect.forever),
  );
  yield* forkParked(
    reconnect.pipe(
      Effect.catchCause((cause) => Effect.logWarning("devbox reconnect failed", { cause })),
      Effect.andThen(ensureSpares),
      Effect.andThen(keepAwake),
    ),
  );

  return DevboxService.of({
    list,
    logins: loginList,
    startLogin,
    cancelLogin,
    signOut,
    submitLoginCode,
    create,
    awaitReady,
    wake,
    stop,
    remove,
    claim,
    pairClient,
    usage,
    deleted,
    byEnvironment,
  });
});

// The `pool-empty` of older records means the same as `no-login`.
function shownCredential(state: DevboxCredentialState | "pool-empty"): DevboxCredentialState {
  return state === "pool-empty" ? "no-login" : state;
}

function tokensKey(payload: DevboxLogins.DevboxLoginPayload): string {
  return `${payload.claude?.oauth.accessToken ?? ""}|${payload.codex?.tokens.access_token ?? ""}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export const layer = Layer.effect(DevboxService, make).pipe(
  Layer.provide(DevboxLogins.layer),
  Layer.provide(DevboxThreadMigration.layer),
  Layer.provide(DevboxVertexMetadata.DevboxVertexMetadata.layer),
  Layer.provide(FetchHttpClient.layer),
);
