/**
 * One pre-made login per devbox, so a box refreshing its token never signs another out.
 * `<provider>/free/<id>/` waits; `<provider>/assigned/<box>/` went to that box. Claude sessions
 * minted here keep their token in the Keychain under `Claude Code-credentials-<sha256(dir)[:8]>`.
 */
import * as NodeOS from "node:os";

import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

export class DevboxCredentialError extends Schema.TaggedError<DevboxCredentialError>()(
  "DevboxCredentialError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export type DevboxCredentialProvider = "claude" | "codex";

export interface ClaudeLogin {
  readonly credentials: unknown;
  readonly oauthAccount: unknown;
}

/** Logins picked for one box. `commit` marks them used once the box has them. */
export interface DevboxCredentialClaim {
  readonly claude: Option.Option<ClaudeLogin>;
  readonly codex: Option.Option<string>;
  readonly commit: Effect.Effect<void, DevboxCredentialError>;
}

export class DevboxCredentialPool extends Context.Service<
  DevboxCredentialPool,
  {
    /** Picks one free login of each of `providers` for `box`. */
    readonly claim: (
      box: string,
      providers: ReadonlyArray<DevboxCredentialProvider>,
    ) => Effect.Effect<DevboxCredentialClaim, DevboxCredentialError>;
    /** Forgets the logins a deleted box held; they cannot be reused. */
    readonly release: (box: string) => Effect.Effect<void>;
    readonly freeCount: (
      provider: DevboxCredentialProvider,
    ) => Effect.Effect<number, DevboxCredentialError>;
    /**
     * Signs in one new pool session. Opens the browser on this machine and waits for the user
     * to approve it.
     */
    readonly mint: (
      provider: DevboxCredentialProvider,
    ) => Effect.Effect<string, DevboxCredentialError>;
  }
>()("t3/devbox/DevboxCredentialPool") {}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeClaudeConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ oauthAccount: Schema.optional(Schema.Unknown) })),
);

/** Gives a login command a terminal, which `claude auth login` needs, and passes its exit code. */
const PTY_RUNNER = String.raw`import os, pty, sys
status = pty.spawn(sys.argv[1:])
sys.exit(os.waitstatus_to_exitcode(status))
`;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const digest = yield* Digest.Digest;
  const root = yield* Config.String("T3CODE_DEVBOX_CREDS_DIR").pipe(
    Config.withDefault(path.join(NodeOS.homedir(), ".config", "devbox-creds")),
  );
  const claudeBin = yield* Config.String("T3CODE_DEVBOX_CLAUDE_BIN").pipe(
    Config.withDefault("claude"),
  );
  const codexBin = yield* Config.String("T3CODE_DEVBOX_CODEX_BIN").pipe(
    Config.withDefault("codex"),
  );

  const claudeKeychainService = (configDir: string) =>
    digest.digest(Digest.sha256, new TextEncoder().encode(configDir)).pipe(
      Effect.orDie,
      Effect.map((bytes) => `Claude Code-credentials-${Hex.encode(bytes).slice(0, 8)}`),
    );

  const fail = (message: string) => (cause: unknown) =>
    new DevboxCredentialError({ message, cause });
  const dir = (provider: DevboxCredentialProvider, bucket: "free" | "assigned") =>
    path.join(root, provider, bucket);

  const freeIds = Effect.fn("DevboxCredentialPool.freeIds")(function* (
    provider: DevboxCredentialProvider,
  ) {
    const free = dir(provider, "free");
    if (!(yield* fs.exists(free).pipe(Effect.orElseSucceed(() => false)))) return [];
    const entries = yield* fs
      .readDirectory(free)
      .pipe(Effect.mapError(fail(`Could not read ${free}`)));
    return entries.filter((entry) => !entry.startsWith(".")).toSorted();
  });

  const readClaude = Effect.fn("DevboxCredentialPool.readClaude")(function* (id: string) {
    const configDir = path.join(dir("claude", "free"), id);
    const account = yield* fs.readFileString(path.join(configDir, ".claude.json")).pipe(
      Effect.flatMap(decodeClaudeConfig),
      Effect.map((config) => config.oauthAccount),
      Effect.orElseSucceed(() => undefined),
    );
    if (account === undefined) return Option.none<ClaudeLogin>();
    // A session minted on Linux keeps its token in a file; on macOS it is in the Keychain.
    const file = path.join(configDir, ".credentials.json");
    const fromFile = yield* fs.readFileString(file).pipe(Effect.option);
    const credentials = Option.isSome(fromFile)
      ? fromFile.value
      : yield* runner
          .run({
            command: "security",
            args: ["find-generic-password", "-s", yield* claudeKeychainService(configDir), "-w"],
            timeout: "15 seconds",
          })
          .pipe(
            Effect.map((result) => (result.code === 0 ? result.stdout.trim() : "")),
            Effect.orElseSucceed(() => ""),
          );
    if (credentials.length === 0) return Option.none<ClaudeLogin>();
    const parsed = yield* decodeJson(credentials).pipe(Effect.option);
    return Option.map(parsed, (value) => ({ credentials: value, oauthAccount: account }));
  });

  const assign = Effect.fn("DevboxCredentialPool.assign")(function* (
    provider: DevboxCredentialProvider,
    id: string,
    box: string,
  ) {
    const from = path.join(dir(provider, "free"), id);
    const assigned = dir(provider, "assigned");
    yield* fs.makeDirectory(assigned, { recursive: true, mode: 0o700 });
    const to = path.join(assigned, box);
    yield* fs.remove(to, { recursive: true, force: true });
    yield* fs.rename(from, to);
    if (provider === "claude") {
      // The box owns the session now; a Mac copy refreshing it would sign the box out.
      yield* runner
        .run({
          command: "security",
          args: ["delete-generic-password", "-s", yield* claudeKeychainService(from)],
          timeout: "15 seconds",
        })
        .pipe(Effect.ignore);
      yield* fs.remove(path.join(to, ".credentials.json"), { force: true });
    }
  });

  const claim: DevboxCredentialPool["Service"]["claim"] = Effect.fn("DevboxCredentialPool.claim")(
    function* (box, providers) {
      const claudeIds = providers.includes("claude") ? yield* freeIds("claude") : [];
      const codexIds = providers.includes("codex") ? yield* freeIds("codex") : [];
      let claudeId: string | undefined;
      let claude = Option.none<ClaudeLogin>();
      for (const id of claudeIds) {
        claude = yield* readClaude(id);
        if (Option.isSome(claude)) {
          claudeId = id;
          break;
        }
      }
      const codexId = codexIds[0];
      const codex =
        codexId === undefined
          ? Option.none<string>()
          : yield* fs
              .readFileString(path.join(dir("codex", "free"), codexId, "auth.json"))
              .pipe(Effect.option);
      const commit = Effect.gen(function* () {
        if (claudeId !== undefined) yield* assign("claude", claudeId, box);
        if (codexId !== undefined && Option.isSome(codex)) yield* assign("codex", codexId, box);
      }).pipe(Effect.mapError(fail(`Could not mark ${box}'s logins as used`)));
      return { claude, codex, commit };
    },
  );

  const release: DevboxCredentialPool["Service"]["release"] = (box) =>
    Effect.forEach(
      ["claude", "codex"] as const,
      (provider) =>
        fs.remove(path.join(dir(provider, "assigned"), box), { recursive: true, force: true }),
      { discard: true },
    ).pipe(Effect.ignore);

  // Only finished sign-ins count; a login still waiting for its browser leaves a bare folder.
  const freeCount: DevboxCredentialPool["Service"]["freeCount"] = (provider) =>
    freeIds(provider).pipe(
      Effect.flatMap((ids) =>
        Effect.filter(ids, (id) =>
          fs
            .exists(
              path.join(
                dir(provider, "free"),
                id,
                provider === "claude" ? ".claude.json" : "auth.json",
              ),
            )
            .pipe(Effect.orElseSucceed(() => false)),
        ),
      ),
      Effect.map((ids) => ids.length),
    );

  const mint: DevboxCredentialPool["Service"]["mint"] = Effect.fn("DevboxCredentialPool.mint")(
    function* (provider) {
      const free = dir(provider, "free");
      yield* fs
        .makeDirectory(free, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError(fail(`Could not create ${free}`)));
      const id = `${yield* Clock.currentTimeMillis}`;
      const sessionDir = path.join(free, id);
      yield* fs
        .makeDirectory(sessionDir, { mode: 0o700 })
        .pipe(Effect.mapError(fail(`Could not create ${sessionDir}`)));
      const login =
        provider === "claude"
          ? {
              args: [claudeBin, "auth", "login", "--claudeai"],
              env: { CLAUDE_CONFIG_DIR: sessionDir },
            }
          : { args: [codexBin, "login"], env: { CODEX_HOME: sessionDir } };
      const discard = fs.remove(sessionDir, { recursive: true, force: true }).pipe(Effect.ignore);
      const result = yield* runner
        .run({
          command: "python3",
          args: ["-c", PTY_RUNNER, ...login.args],
          cwd: sessionDir,
          env: login.env,
          // Claude approves a signed-in browser at once; Codex may wait for one click.
          timeout: "10 minutes",
        })
        .pipe(
          Effect.mapError(fail(`The ${provider} login did not finish`)),
          Effect.onError(() => discard),
        );
      const signedIn =
        provider === "claude"
          ? Option.isSome(yield* readClaude(id))
          : yield* fs
              .exists(path.join(sessionDir, "auth.json"))
              .pipe(Effect.orElseSucceed(() => false));
      if (result.code !== 0 || !signedIn) {
        yield* discard;
        return yield* new DevboxCredentialError({
          message: `The ${provider} login was not completed.`,
        });
      }
      return id;
    },
  );

  return DevboxCredentialPool.of({ claim, release, freeCount, mint });
});

export const layer = Layer.effect(DevboxCredentialPool, make);
