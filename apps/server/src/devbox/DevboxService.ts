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
  type DevboxPendingLogin,
  type DevboxCredentialState,
  type DevboxState,
  type DevboxSummary,
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
  PROVISION_REVISION,
  PROVISION_SCRIPT,
  REMOTE_T3_PORT,
  parseCoderList,
  parsePairingToken,
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
const DevboxFile = Schema.Struct({ devboxes: Schema.Array(DevboxRecord) });
const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(DevboxFile));
const encodeFile = Schema.encodeEffect(Schema.fromJsonString(DevboxFile));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeDescriptor = Schema.decodeUnknownEffect(
  Schema.Struct({ environmentId: EnvironmentIdSchema }),
);
const decodeDescriptorId = (value: unknown) =>
  decodeDescriptor(value).pipe(Effect.map((descriptor) => descriptor.environmentId));

interface Transient {
  readonly state: DevboxState;
  readonly lastError: string | null;
}

export class DevboxService extends Context.Service<
  DevboxService,
  {
    readonly list: Effect.Effect<ReadonlyArray<DevboxSummary>, DevboxError>;
    readonly pendingLogins: Effect.Effect<ReadonlyArray<DevboxPendingLogin>>;
    /** Starts one sign-in for `provider` (unless one waits) and returns where to approve it. */
    readonly startLogin: (provider: "claude" | "codex") => Effect.Effect<string, DevboxError>;
    /** Providers some devbox has no sign-in for while the pool holds none to give it. */
    readonly missingLogins: Effect.Effect<ReadonlyArray<"claude" | "codex">>;
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
  const transient = yield* Ref.make<ReadonlyMap<string, Transient>>(new Map());
  const locks = yield* KeyedLock.make<string>();
  const tunnels = yield* FiberMap.make<string>();
  const creations = yield* FiberMap.make<string>();
  const background = yield* FiberSet.make();

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
    const name =
      input.name !== undefined
        ? uniqueDevboxName(slugifyDevboxName(input.name, namePrefix), taken)
        : randomDevboxName(namePrefix, taken, random);
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
  // when the user asks (`startLogin`), so no browser window opens on its own.
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
  const pendingUrl = (provider: "claude" | "codex") =>
    pool.pendingLogins.pipe(
      Effect.map((logins) => logins.find((login) => login.provider === provider)?.url),
    );
  const startLogin: DevboxService["Service"]["startLogin"] = Effect.fn("DevboxService.startLogin")(
    function* (provider) {
      const waiting = yield* pendingUrl(provider);
      if (waiting !== undefined) return waiting;
      yield* FiberSet.run(
        background,
        pool.mint(provider).pipe(Effect.andThen(distributeLogins), Effect.ignore),
      );
      // The CLI prints its approval link within a few seconds of starting.
      const url = yield* pendingUrl(provider).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (found) => found !== undefined,
        }),
        Effect.timeoutOption("20 seconds"),
        Effect.map(Option.flatMap(Option.fromUndefinedOr)),
      );
      if (Option.isNone(url))
        return yield* new DevboxError({
          reason: "provision",
          message: `The ${provider} sign-in did not start.`,
        });
      return url.value;
    },
  );
  const missingLogins: DevboxService["Service"]["missingLogins"] = Effect.gen(function* () {
    const current = [...(yield* Ref.get(records)).values()];
    const missing: Array<"claude" | "codex"> = [];
    for (const provider of ["claude", "codex"] as const) {
      if (!current.some((record) => record.credentials[provider] !== "installed")) continue;
      const free = yield* pool.freeCount(provider).pipe(Effect.orElseSucceed(() => 0));
      if (free === 0) missing.push(provider);
    }
    return missing;
  });

  const submitLoginCode: DevboxService["Service"]["submitLoginCode"] = Effect.fn(
    "DevboxService.submitLoginCode",
  )(function* (provider, code) {
    yield* pool.submitCode(provider, code).pipe(Effect.mapError(devboxError("invalid")));
  });

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
  // A running box left unconnected (a failed or interrupted setup) gets another try.
  const heal = Effect.gen(function* () {
    const all = yield* workspaces;
    for (const record of (yield* Ref.get(records)).values()) {
      if (record.environmentId !== null) continue;
      if (all.get(record.name)?.latest_build.status !== "running") continue;
      if (yield* FiberMap.has(creations, record.name)) continue;
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
    pendingLogins: pool.pendingLogins,
    startLogin,
    missingLogins,
    submitLoginCode,
    create,
    awaitReady,
    wake,
    stop,
    remove,
    claim,
    pairClient,
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
