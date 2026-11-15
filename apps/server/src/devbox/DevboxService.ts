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
  type DevboxClientPairing,
  type DevboxCreateInput,
  type DevboxLoginPool,
  type DevboxLoginProvider,
  type DevboxCredentialState,
  type DevboxState,
  type DevboxSummary,
  type DevboxUsageInput,
  type DevboxUsageResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as NetService from "@t3tools/shared/Net";
import { waitForHttpReady } from "@t3tools/shared/httpReadiness";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
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
  PROVISION_REVISION,
  PROVISION_SCRIPT,
  REMOTE_T3_PORT,
  parseCoderList,
  parsePairingToken,
  CoderBuild,
  devboxSpans,
  hoursWithin,
  nextDevboxNumber,
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
  credentials: Schema.Struct({
    claude: Schema.Literals(["installed", "pool-empty", "not-installed"]),
    codex: Schema.Literals(["installed", "pool-empty", "not-installed"]),
  }),
  /** Prepared ahead of time, waiting for `claim`. */
  spare: Schema.optionalKey(Schema.Boolean),
  /** Which provisioning script last set the box up; a newer one runs again on connect. */
  provisioned: Schema.optionalKey(Schema.String),
});
type DevboxRecord = typeof DevboxRecord.Type;
const Span = Schema.Tuple([Schema.Number, Schema.Number]);
const DeletedDevbox = Schema.Struct({
  name: Schema.String,
  awake: Schema.Array(Span),
  existed: Span,
});
type DeletedDevbox = typeof DeletedDevbox.Type;
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
  history: Schema.optionalKey(Schema.Array(DeletedDevbox)),
});
const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(DevboxFile));
const encodeFile = Schema.encodeEffect(Schema.fromJsonString(DevboxFile));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeDescriptor = Schema.decodeUnknownEffect(
  Schema.Struct({ environmentId: EnvironmentIdSchema }),
);
const decodeDescriptorId = (value: unknown) =>
  decodeDescriptor(value).pipe(Effect.map((descriptor) => descriptor.environmentId));

interface LoginQueue {
  readonly queued: number;
  readonly lastError: string | null;
}

interface Transient {
  readonly state: DevboxState;
  readonly lastError: string | null;
}

export class DevboxService extends Context.Service<
  DevboxService,
  {
    readonly list: Effect.Effect<ReadonlyArray<DevboxSummary>, DevboxError>;
    /** Each provider's pool of sign-ins for new boxes. */
    readonly pools: Effect.Effect<ReadonlyArray<DevboxLoginPool>>;
    /** Queues `count` sign-ins for `provider`; they run one at a time, each waiting for approval. */
    readonly startLogin: (
      provider: DevboxLoginProvider,
      count: number,
    ) => Effect.Effect<DevboxLoginPool>;
    /** Drops the queued sign-ins and stops the one waiting for approval. */
    readonly cancelLogins: (provider: DevboxLoginProvider) => Effect.Effect<DevboxLoginPool>;
    readonly submitLoginCode: (
      provider: "claude" | "codex",
      code: string,
    ) => Effect.Effect<void, DevboxError>;
    /** Starts creating a box and returns at once; it shows as `creating` until linked. */
    readonly create: (input: DevboxCreateInput) => Effect.Effect<DevboxSummary, DevboxError>;
    /** Waits until the box is linked or failed, at most `timeout`. */
    readonly awaitReady: (
      name: string,
      timeout: Duration.Input,
    ) => Effect.Effect<DevboxSummary, DevboxError>;
    /** Starts waking a stopped box and returns at once in state `starting`. */
    readonly wake: (name: string) => Effect.Effect<DevboxSummary, DevboxError>;
    readonly stop: (name: string) => Effect.Effect<DevboxSummary, DevboxError>;
    readonly remove: (
      name: string,
      options: { readonly force: boolean },
    ) => Effect.Effect<void, DevboxError>;
    /**
     * Takes a prepared spare (or creates a box when there is none), wakes and links it, and
     * returns a one-time code for this client. Starts preparing the next spare.
     */
    readonly claim: Effect.Effect<DevboxClientPairing & { readonly name: string }, DevboxError>;
    /** A one-time code for a client to connect to the box at its loopback URL. */
    readonly pairClient: (name: string) => Effect.Effect<DevboxClientPairing, DevboxError>;
    /** Each box's running and stopped time inside the window, with an estimated cost. */
    readonly usage: (input: DevboxUsageInput) => Effect.Effect<DevboxUsageResult, DevboxError>;
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
  // How many prepared boxes to keep waiting. Off unless set, so dev servers never create boxes.
  const spareCount = yield* Config.Int("T3CODE_DEVBOX_SPARES").pipe(Config.withDefault(0));
  const browserFilter = path.join(config.stateDir, "devbox-browser.sh");
  yield* fs
    .writeFileString(browserFilter, BROWSER_FILTER_SCRIPT, { mode: 0o755 })
    .pipe(Effect.ignore);
  const records = yield* Ref.make<ReadonlyMap<string, DevboxRecord>>(new Map());
  const nextNumber = yield* Ref.make<number | undefined>(undefined);
  const history = yield* Ref.make<ReadonlyArray<DeletedDevbox>>([]);
  const transient = yield* Ref.make<ReadonlyMap<string, Transient>>(new Map());
  const locks = yield* KeyedLock.make<string>();
  const tunnels = yield* FiberMap.make<string>();
  const creations = yield* FiberMap.make<string>();
  const background = yield* FiberSet.make();
  const loginWorkers = yield* FiberMap.make<DevboxLoginProvider>();
  const loginQueues = yield* Ref.make<Record<DevboxLoginProvider, LoginQueue>>({
    claude: { queued: 0, lastError: null },
    codex: { queued: 0, lastError: null },
  });

  const devboxError = (reason: DevboxError["reason"]) => (cause: unknown) =>
    new DevboxError({ reason, message: errorText(cause) });

  // ── storage ──────────────────────────────────────────────────────────────
  const load = fs.readFileString(storePath).pipe(
    Effect.flatMap(decodeFile),
    Effect.orElseSucceed((): typeof DevboxFile.Type => ({ devboxes: [] })),
  );
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
    Effect.mapError(devboxError("storage")),
  );
  const putRecord = (record: DevboxRecord) =>
    Ref.update(records, (current) => new Map(current).set(record.name, record)).pipe(
      Effect.andThen(save()),
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
          : save().pipe(Effect.as(next)),
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
        env: { BROWSER: browserFilter },
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
    state: current?.state ?? coderState(workspace),
    environmentId: record.environmentId as EnvironmentId | null,
    url: `http://127.0.0.1:${record.localPort}`,
    task: record.task,
    spare: record.spare === true,
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
        up
          ? Effect.void
          : FiberMap.run(tunnels, record.name, forward(record), { onlyIfMissing: true }),
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

  // ── provisioning ─────────────────────────────────────────────────────────
  const installCredentials = Effect.fn("DevboxService.installCredentials")(function* (
    record: DevboxRecord,
  ) {
    const needed = (["claude", "codex"] as const).filter(
      (provider) => record.credentials[provider] !== "installed",
    );
    if (needed.length === 0) return record;
    const claim = yield* pool
      .claim(record.name, needed)
      .pipe(Effect.mapError(devboxError("provision")));
    const payload = {
      claude: Option.getOrNull(claim.claude),
      codex: Option.getOrNull(claim.codex),
    };
    if (payload.claude !== null || payload.codex !== null) {
      const body = yield* encodeJson(payload).pipe(Effect.mapError(devboxError("provision")));
      yield* ssh(record.name, `python3 -c ${shellQuote(INSTALL_CREDENTIALS_SCRIPT)}`, body);
      yield* claim.commit.pipe(Effect.mapError(devboxError("provision")));
    }
    const state = (
      current: DevboxRecord,
      provider: "claude" | "codex",
      claimed: Option.Option<unknown>,
    ): DevboxCredentialState =>
      current.credentials[provider] === "installed" || Option.isSome(claimed)
        ? "installed"
        : "pool-empty";
    return yield* updateRecord(record.name, (current) => ({
      ...current,
      credentials: {
        claude: state(current, "claude", claim.claude),
        codex: state(current, "codex", claim.codex),
      },
    }));
  });

  /** Brings a running box to linked: T3 service, forward, link. Safe to repeat. */
  const connect = Effect.fn("DevboxService.connect")(function* (stored: DevboxRecord) {
    // The startup script (codez refresh, full redeploy) can run for over 30 minutes; agents
    // only need ssh and the checkout, so connect as soon as the box's agent answers.
    yield* coder(["ssh", "--wait=no", stored.name, "--", "true"], "10 minutes");
    // A box whose creation stopped early, or that met an empty pool, still needs its logins.
    const record = yield* installCredentials(stored);
    // A box set up by this script starts T3 itself at boot: reconnecting is enough.
    if (record.provisioned === PROVISION_REVISION && record.environmentId !== null) {
      const reached = yield* startTunnel(record).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (reached) return yield* link(record);
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
    return yield* link(provisioned);
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
    ).pipe(
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
    yield* setTransient(record.name, undefined);
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
      credentials: { claude: "not-installed", codex: "not-installed" },
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

  const create: DevboxService["Service"]["create"] = (input) => startCreate(input, false);

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

  /** Starts the box and reconnects it, returning once it answers here. */
  const wakeNow = Effect.fn("DevboxService.wakeNow")(function* (name: string) {
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

  // Waking takes minutes; callers follow the box's state instead of holding a request open.
  const wake: DevboxService["Service"]["wake"] = Effect.fn("DevboxService.wake")(function* (name) {
    yield* getRecord(name);
    yield* setTransient(name, { state: "starting", lastError: null });
    yield* FiberMap.run(creations, name, wakeNow(name).pipe(Effect.ignore), {
      onlyIfMissing: true,
    });
    return yield* summaryOf(name);
  });

  // Stopping takes about a minute; callers follow the box's state instead of waiting.
  const stop: DevboxService["Service"]["stop"] = Effect.fn("DevboxService.stop")(function* (name) {
    yield* getRecord(name);
    yield* setTransient(name, { state: "stopping", lastError: null });
    yield* FiberMap.run(
      creations,
      name,
      locks
        .withLock(
          name,
          FiberMap.remove(tunnels, name).pipe(
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
          if (workspace !== undefined) {
            yield* rememberDeleted(name).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("devbox usage could not be kept", { name, cause }),
              ),
            );
            yield* coder(["delete", name, "--yes"], "15 minutes");
          }
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

  const ensureSpares = Effect.gen(function* () {
    if (spareCount <= 0) return;
    const spares = [...(yield* Ref.get(records)).values()].filter(
      (record) => record.spare === true,
    );
    for (let missing = spareCount - spares.length; missing > 0; missing--) {
      yield* startCreate({}, true);
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("devbox spare could not be started", { cause })),
  );

  const claim: DevboxService["Service"]["claim"] = Effect.gen(function* () {
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
    const name = picked === undefined ? (yield* startCreate({}, false)).name : picked.name;
    if (picked !== undefined)
      yield* updateRecord(picked.name, ({ spare: _spare, ...claimed }) => claimed);
    yield* FiberSet.run(background, ensureSpares);
    const settled = yield* awaitReady(name, CREATE_TIMEOUT);
    if (settled.state !== "running" || settled.environmentId === null) yield* wakeNow(name);
    // After a restart the forward to a running box may not be up yet; the client needs it now.
    else yield* startTunnel(yield* getRecord(name));
    const pairing = yield* pairClient(name);
    return { ...pairing, name };
  }).pipe(Effect.withSpan("DevboxService.claim"));

  // Hands pooled sign-ins to running boxes without them. Sign-ins are minted only
  // when the user queues them (`startLogin`), so no browser window opens on its own.
  const distributeLogins = Effect.gen(function* () {
    const all = yield* workspaces;
    // Boxes in use first: someone is waiting on them; spares get the next sign-in.
    const ordered = [...(yield* Ref.get(records)).values()].toSorted(
      (a, b) => Number(a.spare === true) - Number(b.spare === true),
    );
    for (const record of ordered) {
      const missing =
        record.credentials.claude !== "installed" || record.credentials.codex !== "installed";
      if (!missing || all.get(record.name)?.latest_build.status !== "running") continue;
      yield* locks
        .withLock(record.name, installCredentials(record))
        .pipe(Effect.catchCause((cause) => Effect.logWarning("devbox logins failed", { cause })));
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("devbox logins could not be handed out", { cause }),
    ),
  );
  const poolOf = Effect.fn("DevboxService.poolOf")(function* (provider: DevboxLoginProvider) {
    const pending = yield* pool.pendingLogins;
    const queue = (yield* Ref.get(loginQueues))[provider];
    return {
      provider,
      free: yield* pool.freeCount(provider).pipe(Effect.orElseSucceed(() => 0)),
      inUse: yield* pool.assignedCount(provider),
      queued: queue.queued,
      pendingUrl: pending.find((login) => login.provider === provider)?.url ?? null,
      lastError: queue.lastError,
    } satisfies DevboxLoginPool;
  });
  const pools: DevboxService["Service"]["pools"] = Effect.forEach(
    ["claude", "codex"] as const,
    (provider) => poolOf(provider),
  );
  const setQueue = (provider: DevboxLoginProvider, change: (queue: LoginQueue) => LoginQueue) =>
    Ref.update(loginQueues, (current) => ({ ...current, [provider]: change(current[provider]) }));
  // One sign-in at a time per provider: each waits for its own browser approval.
  const loginWorker = Effect.fn("DevboxService.loginWorker")(function* (
    provider: DevboxLoginProvider,
  ) {
    while ((yield* Ref.get(loginQueues))[provider].queued > 0) {
      const minted = yield* pool.mint(provider).pipe(Effect.result);
      if (minted._tag === "Failure") {
        yield* setQueue(provider, () => ({ queued: 0, lastError: minted.failure.message }));
        return;
      }
      yield* setQueue(provider, (queue) => ({ ...queue, queued: Math.max(0, queue.queued - 1) }));
      yield* FiberSet.run(background, distributeLogins);
    }
  });
  const startLogin: DevboxService["Service"]["startLogin"] = Effect.fn("DevboxService.startLogin")(
    function* (provider, count) {
      yield* setQueue(provider, (queue) => ({ queued: queue.queued + count, lastError: null }));
      yield* FiberMap.run(loginWorkers, provider, loginWorker(provider), { onlyIfMissing: true });
      return yield* poolOf(provider);
    },
  );
  const cancelLogins: DevboxService["Service"]["cancelLogins"] = Effect.fn(
    "DevboxService.cancelLogins",
  )(function* (provider) {
    yield* setQueue(provider, () => ({ queued: 0, lastError: null }));
    yield* FiberMap.remove(loginWorkers, provider);
    return yield* poolOf(provider);
  });

  const submitLoginCode: DevboxService["Service"]["submitLoginCode"] = Effect.fn(
    "DevboxService.submitLoginCode",
  )(function* (provider, code) {
    yield* pool.submitCode(provider, code).pipe(Effect.mapError(devboxError("invalid")));
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
  const mintToken = coder(["tokens", "rm", USAGE_TOKEN_NAME]).pipe(
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
  /** Keeps a box's spans before Coder forgets them with the box. */
  const rememberDeleted = Effect.fn("DevboxService.rememberDeleted")(function* (name: string) {
    const workspace = (yield* workspaces).get(name);
    if (workspace?.id === undefined) return;
    const builds = yield* buildsSince(workspace.id, 0);
    const spans = devboxSpans(builds, yield* Clock.currentTimeMillis);
    if (spans.existed === null) return;
    const existed = spans.existed;
    yield* Ref.update(history, (current) => [
      ...current.filter((box) => box.name !== name),
      { name, awake: spans.awake, existed },
    ]);
  });

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
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("devbox keep-awake failed", { cause })),
    Effect.repeat(Schedule.spaced(KEEP_ALIVE_INTERVAL)),
  );
  // A running box left unconnected (a failed or interrupted setup, or one started outside
  // T3 after a sleep removed its forward) gets another try.
  const heal = Effect.gen(function* () {
    const all = yield* workspaces;
    for (const record of (yield* Ref.get(records)).values()) {
      if (all.get(record.name)?.latest_build.status !== "running") continue;
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
          .withLock(record.name, connect(record))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("devbox setup retry failed", { name: record.name, cause }),
            ),
          ),
      );
    }
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("devbox heal failed", { cause })));
  yield* forkParked(Effect.sleep(Duration.minutes(2)).pipe(Effect.andThen(heal), Effect.forever));
  yield* forkParked(distributeLogins.pipe(Effect.repeat(Schedule.spaced(Duration.minutes(5)))));
  yield* forkParked(
    reconnect.pipe(
      Effect.catchCause((cause) => Effect.logWarning("devbox reconnect failed", { cause })),
      Effect.andThen(ensureSpares),
      Effect.andThen(keepAwake),
    ),
  );

  return DevboxService.of({
    list,
    pools,
    startLogin,
    cancelLogins,
    submitLoginCode,
    create,
    awaitReady,
    wake,
    stop,
    remove,
    claim,
    pairClient,
    usage,
    byEnvironment,
  });
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export const layer = Layer.effect(DevboxService, make).pipe(
  Layer.provide(DevboxCredentialPool.layer),
  Layer.provide(FetchHttpClient.layer),
);
