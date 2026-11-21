/**
 * One sign-in per provider on this machine. Devboxes get its access token only: the refresh
 * token is never stored on a box. DevboxService renews it through a running box, where Asana's
 * Formal connector seals what the provider returns. Files live in `<root>/master/`.
 */
import * as NodeOS from "node:os";

import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";

export class DevboxCredentialError extends Schema.TaggedError<DevboxCredentialError>()(
  "DevboxCredentialError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export type DevboxLoginProvider = "claude" | "codex";
export const DEVBOX_LOGIN_PROVIDERS = ["claude", "codex"] as const;

const ClaudeOauth = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
  refreshTokenExpiresAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  scopes: Schema.Array(Schema.String),
  subscriptionType: Schema.optionalKey(Schema.NullOr(Schema.String)),
  subscriptionTypeSource: Schema.optionalKey(Schema.String),
  rateLimitTier: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const ClaudeLogin = Schema.Struct({ oauth: ClaudeOauth, oauthAccount: Schema.Unknown });
export type ClaudeLogin = typeof ClaudeLogin.Type;

const CodexAuth = Schema.Struct({
  auth_mode: Schema.String,
  OPENAI_API_KEY: Schema.optionalKey(Schema.NullOr(Schema.String)),
  tokens: Schema.Struct({
    id_token: Schema.String,
    access_token: Schema.String,
    refresh_token: Schema.String,
    account_id: Schema.optionalKey(Schema.String),
    login_owner_id: Schema.optionalKey(Schema.String),
    oauth_provenance: Schema.optionalKey(Schema.Unknown),
  }),
  last_refresh: Schema.optionalKey(Schema.String),
});
const CodexLogin = Schema.Struct({
  auth: CodexAuth,
  expiresAt: Schema.Number,
  /** OpenAI refuses refreshes before this. */
  earliestRefreshAt: Schema.optionalKey(Schema.Number),
});
export type CodexLogin = typeof CodexLogin.Type;

/** What a box gets: access tokens, never a refresh token. */
export interface DevboxLoginPayload {
  readonly claude: {
    readonly oauth: Omit<ClaudeLogin["oauth"], "refreshToken" | "refreshTokenExpiresAt">;
    readonly oauthAccount: unknown;
  } | null;
  /** Codex rejects a missing `refresh_token`, so it is an empty string. */
  readonly codex: CodexLogin["auth"] | null;
}

/** Sent to `REFRESH_LOGIN_SCRIPT` on the box doing the refresh. */
export interface DevboxRefreshRequest {
  readonly provider: DevboxLoginProvider;
  readonly refreshToken: string;
  readonly scopes: ReadonlyArray<string>;
  /** Sealed tokens only work through Formal, and Claude logins get sealed on first refresh. */
  readonly requireFormal: boolean;
}

export interface DevboxLoginInfo {
  readonly signedIn: boolean;
  readonly account: string | null;
  readonly expiresAt: number | null;
  readonly sealed: boolean;
}

export class DevboxLogins extends Context.Service<
  DevboxLogins,
  {
    readonly info: (provider: DevboxLoginProvider) => Effect.Effect<DevboxLoginInfo>;
    readonly payload: Effect.Effect<DevboxLoginPayload>;
    /** The refresh due now, if any: near expiry, or a Claude login not yet sealed. */
    readonly due: (
      provider: DevboxLoginProvider,
    ) => Effect.Effect<Option.Option<DevboxRefreshRequest>>;
    /**
     * Refreshes through `relay` if still due, one refresh per provider at a time, and saves the
     * rotated login before returning: the old refresh token is dead once the provider answers.
     */
    readonly refresh: <E>(
      provider: DevboxLoginProvider,
      relay: (request: DevboxRefreshRequest) => Effect.Effect<unknown, E>,
    ) => Effect.Effect<boolean, DevboxCredentialError | E>;
    /** Signs in, opening the browser on this machine, and keeps the result as the login. */
    readonly signIn: (provider: DevboxLoginProvider) => Effect.Effect<void, DevboxCredentialError>;
    readonly signOut: (provider: DevboxLoginProvider) => Effect.Effect<void, DevboxCredentialError>;
    /**
     * Marks `refreshToken` as refused by the provider, so it is no longer due and never sent
     * again. A new sign-in brings a new token and so clears it.
     */
    readonly reject: (provider: DevboxLoginProvider, refreshToken: string) => Effect.Effect<void>;
    /** Changes on every sign-in, sign-out and renewal, so a late failure can tell it is stale. */
    readonly generation: (provider: DevboxLoginProvider) => Effect.Effect<number>;
    /** Hands a waiting sign-in the code its approval page showed. */
    readonly submitCode: (
      provider: DevboxLoginProvider,
      code: string,
    ) => Effect.Effect<void, DevboxCredentialError>;
    /** Where the user approves the running sign-in, once its CLI printed the link. */
    readonly pendingUrl: (provider: DevboxLoginProvider) => Effect.Effect<string | null>;
  }
>()("t3/devbox/DevboxLogins") {}

const CLAUDE_REFRESH_BEFORE = Duration.hours(2);
const CODEX_REFRESH_BEFORE = Duration.days(3);
// An answer without a lifetime gets one just past the renewal window, so it is not due at once.
const CLAUDE_FALLBACK_SECONDS = 3 * 60 * 60;
const CODEX_FALLBACK_SECONDS = 3 * 24 * 60 * 60 + 60 * 60;

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const SEALED_PREFIX = "formalsealed:";

const decodeClaudeLogin = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeLogin));
const decodeCodexLogin = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexLogin));
const encodeClaudeLogin = Schema.encodeEffect(Schema.fromJsonString(ClaudeLogin));
const encodeCodexLogin = Schema.encodeEffect(Schema.fromJsonString(CodexLogin));
const decodeKeychainCredentials = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ claudeAiOauth: ClaudeOauth })),
);
const decodeClaudeConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ oauthAccount: Schema.Unknown })),
);
const decodeCodexAuth = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexAuth));
const decodeClaudeAccount = Schema.decodeUnknownOption(
  Schema.Struct({ emailAddress: Schema.String }),
);
const decodeJwtClaims = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      exp: Schema.optionalKey(Schema.Number),
      email: Schema.optionalKey(Schema.String),
    }),
  ),
);
const decodeClaudeRefresh = Schema.decodeUnknownEffect(
  Schema.Struct({
    // Only the tokens must decode: a rotated refresh token is saved whatever the rest looks like.
    access_token: Schema.String,
    refresh_token: Schema.optionalKey(Schema.NullOr(Schema.String)),
    expires_in: Schema.optionalKey(Schema.Unknown),
    refresh_token_expires_in: Schema.optionalKey(Schema.Unknown),
    scope: Schema.optionalKey(Schema.Unknown),
  }),
);
const decodeCodexRefresh = Schema.decodeUnknownEffect(
  Schema.Struct({
    access_token: Schema.String,
    id_token: Schema.optionalKey(Schema.NullOr(Schema.String)),
    refresh_token: Schema.optionalKey(Schema.NullOr(Schema.String)),
    expires_in: Schema.optionalKey(Schema.Unknown),
    earliest_refresh_at: Schema.optionalKey(Schema.Unknown),
  }),
);

const jwtClaims = (token: string) => {
  const body = token.split(".")[1];
  if (body === undefined) return Option.none();
  return Result.match(Base64Url.decodeString(body), {
    onFailure: () => Option.none(),
    onSuccess: decodeJwtClaims,
  });
};

/**
 * Runs a login command in a terminal, which `claude auth login` needs, and types in the code
 * the user pastes back (written to `.login-code` in the working directory). Passes the exit code.
 */
const PTY_RUNNER = String.raw`import os, pty, select, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
sent = False
while True:
    ready, _, _ = select.select([fd], [], [], 0.5)
    if ready:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if not sent and os.path.exists(".login-code"):
        code = open(".login-code").read().strip()
        if code:
            os.write(fd, (code + "\r").encode())
            sent = True
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        sys.exit(os.waitstatus_to_exitcode(status))
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const digest = yield* Digest.Digest;
  const root = yield* Config.String("T3CODE_DEVBOX_CREDS_DIR").pipe(
    Config.withDefault(path.join(NodeOS.homedir(), ".config", "devbox-creds")),
  );
  const masterDir = path.join(root, "master");
  const configuredBins = {
    claude: yield* Config.String("T3CODE_DEVBOX_CLAUDE_BIN").pipe(Config.option),
    codex: yield* Config.String("T3CODE_DEVBOX_CODEX_BIN").pipe(Config.option),
  };
  const searchPath = yield* Config.String("PATH").pipe(Config.withDefault(""));
  const pending = new Map<DevboxLoginProvider, string>();
  const pendingDirs = new Map<DevboxLoginProvider, string>();
  const rejected = new Map<DevboxLoginProvider, string>();
  const generations: Record<DevboxLoginProvider, number> = { claude: 0, codex: 0 };
  const bump = (provider: DevboxLoginProvider) =>
    Effect.sync(() => {
      generations[provider]++;
    });
  const refreshLocks = {
    claude: yield* Semaphore.make(1),
    codex: yield* Semaphore.make(1),
  };

  const fail = (message: string) => (cause: unknown) =>
    new DevboxCredentialError({ message, cause });
  const fileOf = (provider: DevboxLoginProvider) => path.join(masterDir, `${provider}.json`);

  const readClaude = fs
    .readFileString(fileOf("claude"))
    .pipe(Effect.flatMap(decodeClaudeLogin), Effect.option);
  const readCodex = fs
    .readFileString(fileOf("codex"))
    .pipe(Effect.flatMap(decodeCodexLogin), Effect.option);

  // Written whole and renamed, so a crash never leaves half a login with the old one gone.
  const writeMaster = Effect.fn("DevboxLogins.writeMaster")(function* (
    provider: DevboxLoginProvider,
    text: string,
  ) {
    yield* fs.makeDirectory(masterDir, { recursive: true, mode: 0o700 });
    const target = fileOf(provider);
    const temporary = `${target}.tmp`;
    yield* fs.writeFileString(temporary, text, { mode: 0o600 });
    yield* fs.rename(temporary, target);
  });
  // A renewed token is the only live one, so a failed write is retried before giving up.
  const saveClaude = (login: ClaudeLogin) =>
    encodeClaudeLogin(login).pipe(
      Effect.flatMap((text) => writeMaster("claude", text)),
      Effect.retry({ times: 3 }),
      Effect.mapError(fail("Could not save the Claude sign-in")),
    );
  const saveCodex = (login: CodexLogin) =>
    encodeCodexLogin(login).pipe(
      Effect.flatMap((text) => writeMaster("codex", text)),
      Effect.retry({ times: 3 }),
      Effect.mapError(fail("Could not save the Codex sign-in")),
    );

  // A refused sign-in reads as signed out, so boxes and agents point to Settings.
  const info: DevboxLogins["Service"]["info"] = (provider) =>
    provider === "claude"
      ? readClaude.pipe(
          Effect.map(
            Option.match({
              onNone: () => ({ signedIn: false, account: null, expiresAt: null, sealed: false }),
              onSome: (login) => ({
                signedIn: rejected.get("claude") !== login.oauth.refreshToken,
                account: Option.getOrNull(
                  Option.map(decodeClaudeAccount(login.oauthAccount), (a) => a.emailAddress),
                ),
                expiresAt: login.oauth.expiresAt,
                sealed: login.oauth.refreshToken.startsWith(SEALED_PREFIX),
              }),
            }),
          ),
        )
      : readCodex.pipe(
          Effect.map(
            Option.match({
              onNone: () => ({ signedIn: false, account: null, expiresAt: null, sealed: false }),
              onSome: (login) => ({
                signedIn: rejected.get("codex") !== login.auth.tokens.refresh_token,
                account: Option.getOrNull(
                  Option.flatMap(jwtClaims(login.auth.tokens.id_token), (claims) =>
                    Option.fromUndefinedOr(claims.email),
                  ),
                ),
                expiresAt: login.expiresAt,
                sealed: login.auth.tokens.refresh_token.startsWith(SEALED_PREFIX),
              }),
            }),
          ),
        );

  // An expired token would only fail on the box; leaving it out reports the box as signed out.
  const payload: DevboxLogins["Service"]["payload"] = Effect.all({
    claude: readClaude,
    codex: readCodex,
    now: Clock.currentTimeMillis,
  }).pipe(
    Effect.map(({ claude, codex, now }) => ({
      claude: Option.getOrNull(
        Option.map(
          // A refused sign-in is not handed out either.
          Option.filter(
            claude,
            (login) =>
              login.oauth.expiresAt > now && rejected.get("claude") !== login.oauth.refreshToken,
          ),
          (login) => {
            const {
              refreshToken: _refresh,
              refreshTokenExpiresAt: _expires,
              ...oauth
            } = login.oauth;
            return { oauth, oauthAccount: login.oauthAccount };
          },
        ),
      ),
      codex: Option.getOrNull(
        Option.map(
          Option.filter(
            codex,
            (login) =>
              login.expiresAt > now && rejected.get("codex") !== login.auth.tokens.refresh_token,
          ),
          (login) => ({
            ...login.auth,
            OPENAI_API_KEY: null,
            tokens: { ...login.auth.tokens, refresh_token: "" },
          }),
        ),
      ),
    })),
  );

  const requestFor = (login: ClaudeLogin | CodexLogin): DevboxRefreshRequest =>
    "oauth" in login
      ? {
          provider: "claude",
          refreshToken: login.oauth.refreshToken,
          scopes: login.oauth.scopes,
          requireFormal: true,
        }
      : {
          provider: "codex",
          refreshToken: login.auth.tokens.refresh_token,
          scopes: [],
          requireFormal: login.auth.tokens.refresh_token.startsWith(SEALED_PREFIX),
        };

  const isDue = (provider: DevboxLoginProvider, now: number) => {
    const login: Effect.Effect<Option.Option<ClaudeLogin | CodexLogin>> =
      provider === "claude"
        ? readClaude.pipe(
            Effect.map(
              Option.filter(
                (claude) =>
                  !claude.oauth.refreshToken.startsWith(SEALED_PREFIX) ||
                  claude.oauth.expiresAt - now <= Duration.toMillis(CLAUDE_REFRESH_BEFORE),
              ),
            ),
          )
        : readCodex.pipe(
            Effect.map(
              Option.filter(
                (codex) =>
                  codex.expiresAt - now <= Duration.toMillis(CODEX_REFRESH_BEFORE) &&
                  (codex.earliestRefreshAt === undefined || now >= codex.earliestRefreshAt),
              ),
            ),
          );
    return login.pipe(
      Effect.map((found) =>
        Option.filter(found, (value) => rejected.get(provider) !== requestFor(value).refreshToken),
      ),
    );
  };

  const due: DevboxLogins["Service"]["due"] = Effect.fn("DevboxLogins.due")(function* (provider) {
    const login = yield* isDue(provider, yield* Clock.currentTimeMillis);
    return Option.map(login, requestFor);
  });

  const applyClaude = Effect.fn("DevboxLogins.applyClaude")(function* (
    login: ClaudeLogin,
    response: unknown,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const answer = yield* decodeClaudeRefresh(response).pipe(
      Effect.mapError(fail("Claude answered the refresh with something unexpected")),
    );
    const { oauth } = login;
    yield* saveClaude({
      ...login,
      oauth: {
        ...oauth,
        accessToken: answer.access_token,
        refreshToken: answer.refresh_token ?? oauth.refreshToken,
        expiresAt: now + numberOr(answer.expires_in, CLAUDE_FALLBACK_SECONDS) * 1000,
        refreshTokenExpiresAt:
          typeof answer.refresh_token_expires_in === "number"
            ? now + answer.refresh_token_expires_in * 1000
            : (oauth.refreshTokenExpiresAt ?? null),
        scopes:
          typeof answer.scope === "string" ? answer.scope.split(" ").filter(Boolean) : oauth.scopes,
      },
    });
  });

  const applyCodex = Effect.fn("DevboxLogins.applyCodex")(function* (
    login: CodexLogin,
    response: unknown,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const answer = yield* decodeCodexRefresh(response).pipe(
      Effect.mapError(fail("Codex answered the refresh with something unexpected")),
    );
    const { auth } = login;
    const tokens = {
      ...auth.tokens,
      access_token: answer.access_token,
      id_token: answer.id_token ?? auth.tokens.id_token,
      refresh_token: answer.refresh_token ?? auth.tokens.refresh_token,
    };
    yield* saveCodex({
      auth: { ...auth, tokens, last_refresh: DateTime.formatIso(DateTime.makeUnsafe(now)) },
      expiresAt: codexExpiry(
        tokens.access_token,
        now,
        numberOr(answer.expires_in, CODEX_FALLBACK_SECONDS),
      ),
      ...(typeof answer.earliest_refresh_at === "number"
        ? { earliestRefreshAt: answer.earliest_refresh_at * 1000 }
        : {}),
    });
  });

  // The lock covers sign-in's save too, so a renewal never lands on a newer sign-in. Once the
  // provider answers the old refresh token is dead, so relay and save run uninterrupted.
  const refresh: DevboxLogins["Service"]["refresh"] = (provider, relay) =>
    refreshLocks[provider].withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const login = yield* isDue(provider, yield* Clock.currentTimeMillis);
          if (Option.isNone(login)) return false;
          const response = yield* relay(requestFor(login.value));
          if ("oauth" in login.value) yield* applyClaude(login.value, response);
          else yield* applyCodex(login.value, response);
          yield* bump(provider);
          return true;
        }),
      ),
    );

  /**
   * The provider's own CLI. Asana's checkout puts `claude` and `codex` wrappers first on PATH
   * (and mise shims fall through to them); they need a terminal's environment, so skip them.
   */
  const resolveCli = Effect.fn("DevboxLogins.resolveCli")(function* (name: DevboxLoginProvider) {
    const home = NodeOS.homedir();
    const nodeInstalls = path.join(home, ".local", "share", "mise", "installs", "node");
    const nodeVersions = yield* fs.readDirectory(nodeInstalls).pipe(Effect.orElseSucceed(() => []));
    const candidates = [
      ...Option.toArray(configuredBins[name]),
      ...searchPath
        .split(":")
        .filter(
          (dir) => dir.length > 0 && !dir.includes("sandbox/asana") && !dir.includes("mise/shims"),
        )
        .map((dir) => path.join(dir, name)),
      path.join(home, ".local", "bin", name),
      ...nodeVersions
        .toSorted((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .map((version) => path.join(nodeInstalls, version, "bin", name)),
      path.join(home, ".local", name, name),
    ];
    for (const candidate of candidates) {
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return candidate;
    }
    return name;
  });

  const claudeKeychainService = (configDir: string) =>
    digest.digest(Digest.sha256, new TextEncoder().encode(configDir)).pipe(
      Effect.orDie,
      Effect.map((bytes) => `Claude Code-credentials-${Hex.encode(bytes).slice(0, 8)}`),
    );

  // macOS keeps a session's token in the Keychain; Linux in a file.
  const readSessionClaude = Effect.fn("DevboxLogins.readSessionClaude")(function* (
    sessionDir: string,
  ) {
    const config = yield* fs
      .readFileString(path.join(sessionDir, ".claude.json"))
      .pipe(Effect.flatMap(decodeClaudeConfig), Effect.option);
    if (Option.isNone(config)) return Option.none<ClaudeLogin>();
    const service = yield* claudeKeychainService(sessionDir);
    const fromFile = yield* fs
      .readFileString(path.join(sessionDir, ".credentials.json"))
      .pipe(Effect.option);
    const stored = Option.isSome(fromFile)
      ? fromFile.value
      : yield* runner
          .run({
            command: "security",
            args: ["find-generic-password", "-s", service, "-w"],
            timeout: "15 seconds",
          })
          .pipe(
            Effect.map((result) => (result.code === 0 ? result.stdout.trim() : "")),
            Effect.orElseSucceed(() => ""),
          );
    const credentials = yield* decodeKeychainCredentials(stored).pipe(Effect.option);
    return Option.map(credentials, (value) => ({
      oauth: value.claudeAiOauth,
      oauthAccount: config.value.oauthAccount,
    }));
  });

  const discardSession = Effect.fn("DevboxLogins.discardSession")(function* (
    provider: DevboxLoginProvider,
    sessionDir: string,
  ) {
    // Only the saved login may refresh this session; a second copy would sign it out.
    if (provider === "claude")
      yield* runner
        .run({
          command: "security",
          args: ["delete-generic-password", "-s", yield* claudeKeychainService(sessionDir)],
          timeout: "15 seconds",
        })
        .pipe(Effect.ignore);
    yield* fs.remove(sessionDir, { recursive: true, force: true }).pipe(Effect.ignore);
  });

  const signIn: DevboxLogins["Service"]["signIn"] = Effect.fn("DevboxLogins.signIn")(
    function* (provider) {
      yield* fs
        .makeDirectory(masterDir, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError(fail(`Could not create ${masterDir}`)));
      const sessionDir = path.join(
        masterDir,
        `.signin-${provider}-${yield* Clock.currentTimeMillis}`,
      );
      yield* fs
        .makeDirectory(sessionDir, { mode: 0o700 })
        .pipe(Effect.mapError(fail(`Could not create ${sessionDir}`)));
      pendingDirs.set(provider, sessionDir);
      const cli = yield* resolveCli(provider);
      const login =
        provider === "claude"
          ? { args: [cli, "auth", "login", "--claudeai"], env: { CLAUDE_CONFIG_DIR: sessionDir } }
          : { args: [cli, "login"], env: { CODEX_HOME: sessionDir } };
      let output = "";
      yield* Effect.gen(function* () {
        const result = yield* runner
          .run({
            command: "python3",
            args: ["-c", PTY_RUNNER, ...login.args],
            cwd: sessionDir,
            env: login.env,
            timeout: "10 minutes",
            onStdoutChunk: (chunk) => {
              if (pending.has(provider)) return;
              output += new TextDecoder().decode(chunk);
              const url =
                /https:\/\/[^\s\u0007\u001b"']*(?:authorize|oauth)[^\s\u0007\u001b"']*/u.exec(
                  output,
                )?.[0];
              if (url) pending.set(provider, url);
            },
          })
          .pipe(Effect.mapError(fail(`The ${provider} sign-in did not finish`)));
        const now = yield* Clock.currentTimeMillis;
        if (provider === "claude") {
          const signedIn = yield* readSessionClaude(sessionDir);
          if (result.code !== 0 || Option.isNone(signedIn))
            return yield* new DevboxCredentialError({
              message: "The Claude sign-in was not completed.",
            });
          yield* refreshLocks.claude.withPermits(1)(
            Effect.uninterruptible(saveClaude(signedIn.value).pipe(Effect.andThen(bump("claude")))),
          );
        } else {
          const auth = yield* fs
            .readFileString(path.join(sessionDir, "auth.json"))
            .pipe(
              Effect.flatMap(decodeCodexAuth),
              Effect.mapError(fail("The Codex sign-in was not completed.")),
            );
          if (result.code !== 0)
            return yield* new DevboxCredentialError({
              message: "The Codex sign-in was not completed.",
            });
          yield* refreshLocks.codex.withPermits(1)(
            Effect.uninterruptible(
              saveCodex({ auth, expiresAt: codexExpiry(auth.tokens.access_token, now) }).pipe(
                Effect.andThen(bump("codex")),
              ),
            ),
          );
        }
      }).pipe(
        // Also on interrupt: a cancelled sign-in must not leave a session behind.
        Effect.ensuring(
          discardSession(provider, sessionDir).pipe(
            Effect.andThen(
              Effect.sync(() => {
                pending.delete(provider);
                pendingDirs.delete(provider);
              }),
            ),
          ),
        ),
      );
    },
  );

  const signOut: DevboxLogins["Service"]["signOut"] = (provider) =>
    refreshLocks[provider].withPermits(1)(
      fs
        .remove(fileOf(provider), { force: true })
        .pipe(
          Effect.mapError(fail(`Could not remove the ${provider} sign-in`)),
          Effect.andThen(bump(provider)),
        ),
    );

  const submitCode: DevboxLogins["Service"]["submitCode"] = Effect.fn("DevboxLogins.submitCode")(
    function* (provider, code) {
      const sessionDir = pendingDirs.get(provider);
      if (sessionDir === undefined)
        return yield* new DevboxCredentialError({
          message: `No ${provider} sign-in is waiting for a code.`,
        });
      yield* fs
        .writeFileString(path.join(sessionDir, ".login-code"), code.trim(), { mode: 0o600 })
        .pipe(Effect.mapError(fail("Could not hand the code to the sign-in")));
    },
  );

  const reject: DevboxLogins["Service"]["reject"] = (provider, refreshToken) =>
    Effect.sync(() => void rejected.set(provider, refreshToken));

  const generation: DevboxLogins["Service"]["generation"] = (provider) =>
    Effect.sync(() => generations[provider]);

  const pendingUrl: DevboxLogins["Service"]["pendingUrl"] = (provider) =>
    Effect.sync(() => pending.get(provider) ?? null);

  return DevboxLogins.of({
    info,
    payload,
    due,
    refresh,
    signIn,
    signOut,
    reject,
    generation,
    submitCode,
    pendingUrl,
  });
});

/** The access token's own expiry; the refresh answer's `expires_in` when the token has none. */
function codexExpiry(accessToken: string, now: number, expiresIn = CODEX_FALLBACK_SECONDS): number {
  const exp = Option.flatMap(jwtClaims(accessToken), (claims) =>
    Option.fromUndefinedOr(claims.exp),
  );
  if (Option.isSome(exp)) return exp.value * 1000;
  return now + expiresIn * 1000;
}

export const layer = Layer.effect(DevboxLogins, make);
