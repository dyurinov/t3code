// @effect-diagnostics nodeBuiltinImport:off - Dedicated owner-only Unix-socket GCE metadata broker for devbox SSH reverse tunnels.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import { AntigravitySettings, type ServerSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import { VERTEX_METADATA_PORT_ON_BOX } from "./devboxScripts.ts";

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAX_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
const DEFAULT_ALLOWED_HOST = `127.0.0.1:${VERTEX_METADATA_PORT_ON_BOX}`;
const MAX_UNIX_SOCKET_PATH_BYTES = 100;

export interface HostAntigravityAdcConfig {
  readonly gcpProject: string;
  readonly gcpLocation: string;
}

const decodeAntigravitySettings = Schema.decodeUnknownOption(AntigravitySettings);

const AuthorizedUserAdc = Schema.Struct({
  type: Schema.Literal("authorized_user"),
  client_id: Schema.String,
  client_secret: Schema.String,
  refresh_token: Schema.String,
  quota_project_id: Schema.optionalKey(Schema.String),
  account: Schema.optionalKey(Schema.String),
});
type AuthorizedUserAdc = typeof AuthorizedUserAdc.Type;
const decodeAuthorizedUserAdc = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AuthorizedUserAdc),
);

const OAuthTokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.optionalKey(Schema.Number),
});
const decodeOAuthTokenResponse = Schema.decodeUnknownEffect(OAuthTokenResponse);

const encodeMetadataTokenResponse = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      access_token: Schema.String,
      expires_in: Schema.Number,
      token_type: Schema.Literal("Bearer"),
    }),
  ),
);

export class DevboxVertexMetadataError extends Schema.TaggedError<DevboxVertexMetadataError>()(
  "DevboxVertexMetadataError",
  {
    message: Schema.String,
  },
) {}

/**
 * Returns the host's enabled Agent Platform (Vertex AI ADC) configuration when Antigravity is
 * configured with a GCP project/location and no static API key.
 */
export function readHostAntigravityConfig(
  snapshot: ServerSettings,
): HostAntigravityAdcConfig | undefined {
  const entries = Object.entries(snapshot.providerInstances).toSorted(([a], [b]) =>
    a === "antigravity" ? -1 : b === "antigravity" ? 1 : a.localeCompare(b),
  );
  for (const [, instance] of entries) {
    if (instance.driver !== "antigravity" || !instance.enabled) continue;
    const decoded = decodeAntigravitySettings(instance.config);
    if (decoded._tag !== "Some") continue;
    const cfg = decoded.value;
    const hasApiKey = typeof cfg.apiKey === "string" ? cfg.apiKey.trim().length > 0 : true;
    if (cfg.authMethod !== "agent-platform" || hasApiKey) continue;
    const gcpProject = cfg.gcpProject.trim();
    const gcpLocation = cfg.gcpLocation.trim();
    if (!gcpProject || !gcpLocation) continue;
    return { gcpProject, gcpLocation };
  }
  return undefined;
}

function headerValue(
  headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>,
  name: string,
): string | undefined {
  const raw = headers[name];
  if (typeof raw === "string") return raw;
  return undefined;
}

/**
 * Accepts only requests matching the exact allowlisted Host (`127.0.0.1:13798`), presenting
 * `Metadata-Flavor: Google`, and carrying no browser fetch metadata, Origin, or forwarding headers.
 */
export function isAllowedMetadataRequest(
  input: {
    readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
  },
  allowedHosts: ReadonlySet<string> = new Set([DEFAULT_ALLOWED_HOST]),
): boolean {
  if (headerValue(input.headers, "metadata-flavor") !== "Google") return false;
  const host = headerValue(input.headers, "host")?.trim().toLowerCase();
  if (!host || !allowedHosts.has(host)) return false;
  for (const key of Object.keys(input.headers)) {
    if (
      key === "origin" ||
      key === "x-forwarded-for" ||
      key === "forwarded" ||
      key === "x-real-ip" ||
      key.startsWith("sec-fetch-")
    ) {
      return false;
    }
  }
  return true;
}

export interface DevboxVertexMetadataOptions {
  readonly adcPath?: string;
  readonly tokenUrl?: string;
  readonly socketPath?: string;
  readonly allowedHosts?: ReadonlySet<string>;
}

const prepareOwnerOnlyDir = (dir: string, uid: number | undefined): boolean => {
  try {
    NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = NodeFS.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (uid !== undefined && stat.uid !== uid) return false;
    NodeFS.chmodSync(dir, 0o700);
    return true;
  } catch {
    return false;
  }
};

const isLiveUnixSocket = (socketPath: string): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    let settled = false;
    const finish = (live: boolean) => {
      if (settled) return;
      settled = true;
      client.destroy();
      resume(Effect.succeed(live));
    };
    const client = NodeNet.createConnection(socketPath);
    client.setTimeout(250, () => finish(true));
    client.once("connect", () => finish(true));
    // Only ECONNREFUSED/ENOENT prove the socket has no listener; treat inconclusive errors as live.
    client.once("error", (error: NodeJS.ErrnoException) =>
      finish(error.code !== "ECONNREFUSED" && error.code !== "ENOENT"),
    );
  });

const resolveBrokerSocketLocation = (
  path: Path.Path,
  stateDir: string,
  brokerId: string,
  explicitSocketPath: string | undefined,
): { readonly socketPath: string; readonly sweepDir?: string; readonly cleanupDir?: string } => {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (explicitSocketPath !== undefined) {
    const dir = path.dirname(explicitSocketPath);
    if (!prepareOwnerOnlyDir(dir, uid)) {
      throw new Error("Could not prepare owner-only Vertex metadata socket directory.");
    }
    return { socketPath: explicitSocketPath };
  }
  // Per-broker filename ensures concurrent startups never race on unlink/bind.
  const socketName = `b-${brokerId.slice(0, 12)}.sock`;
  const preferredDir = path.join(stateDir, "vertex");
  const preferredSocket = path.join(preferredDir, socketName);
  if (
    Buffer.byteLength(preferredSocket) <= MAX_UNIX_SOCKET_PATH_BYTES &&
    prepareOwnerOnlyDir(preferredDir, uid)
  ) {
    return { socketPath: preferredSocket, sweepDir: preferredDir };
  }
  const fixedTmpDir = path.join("/tmp", `t3-vm-${uid ?? "user"}`);
  if (prepareOwnerOnlyDir(fixedTmpDir, uid)) {
    return { socketPath: path.join(fixedTmpDir, socketName), sweepDir: fixedTmpDir };
  }
  const isolatedTmpDir = NodeFS.mkdtempSync(path.join("/tmp", "t3-vm-"));
  NodeFS.chmodSync(isolatedTmpDir, 0o700);
  return { socketPath: path.join(isolatedTmpDir, socketName), cleanupDir: isolatedTmpDir };
};

const STALE_SOCKET_MIN_AGE_MS = 60_000;

const sweepStaleBrokerSockets = Effect.fn("DevboxVertexMetadata.sweepStaleBrokerSockets")(
  function* (path: Path.Path, dir: string, ownSocketPath: string) {
    const entries = yield* Effect.sync((): ReadonlyArray<string> => {
      try {
        return NodeFS.readdirSync(dir);
      } catch {
        return [];
      }
    });
    const cutoffMs = (yield* Clock.currentTimeMillis) - STALE_SOCKET_MIN_AGE_MS;
    for (const name of entries) {
      if (!name.startsWith("b-") || !name.endsWith(".sock")) continue;
      const candidate = path.join(dir, name);
      if (candidate === ownSocketPath) continue;
      const stat = yield* Effect.sync(() => {
        try {
          return NodeFS.lstatSync(candidate);
        } catch {
          return undefined;
        }
      });
      if (!stat?.isSocket() || stat.mtimeMs > cutoffMs) continue;
      if (!(yield* isLiveUnixSocket(candidate))) {
        yield* Effect.sync(() => {
          try {
            NodeFS.rmSync(candidate, { force: true });
          } catch {
            // Best-effort cleanup of stale socket files.
          }
        });
      }
    }
  },
);

export interface DevboxVertexToken {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
}

/**
 * Owner-only (`0600`) Unix-socket GCE metadata broker for devbox SSH `-R` tunnels. Keeps the
 * Google refresh token on this host; any process on a linked devbox can fetch short-lived tokens
 * with the host ADC's scopes (matching box-local Claude/Codex/Cursor tokens on single-user boxes).
 */
export class DevboxVertexMetadata extends Context.Service<
  DevboxVertexMetadata,
  {
    readonly socketPath: string;
    readonly brokerId: string;
    readonly hasAdcCredentials: Effect.Effect<boolean>;
    readonly getToken: Effect.Effect<DevboxVertexToken, DevboxVertexMetadataError>;
    readonly getAccount: Effect.Effect<string | null>;
  }
>()("t3/devbox/DevboxVertexMetadata") {
  static readonly make = Effect.fn("DevboxVertexMetadata.make")(function* (
    options?: DevboxVertexMetadataOptions,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const settings = yield* ServerSettingsService.ServerSettingsService;
    const envAdcPath = yield* Config.String("GOOGLE_APPLICATION_CREDENTIALS").pipe(Config.option);
    const adcPath =
      options?.adcPath ??
      (envAdcPath._tag === "Some" && envAdcPath.value.trim().length > 0
        ? envAdcPath.value.trim()
        : path.join(NodeOS.homedir(), ".config", "gcloud", "application_default_credentials.json"));
    const tokenUrl = options?.tokenUrl ?? GOOGLE_OAUTH_TOKEN_URL;
    const allowedHosts = options?.allowedHosts ?? new Set([DEFAULT_ALLOWED_HOST]);
    const brokerId = NodeCrypto.randomUUID();
    const lock = yield* Semaphore.make(1);

    let cached:
      | {
          readonly refreshToken: string;
          readonly accessToken: string;
          readonly expiresAtMs: number;
          readonly refreshMarginMs: number;
        }
      | undefined;

    const readAdc = Effect.fn("DevboxVertexMetadata.readAdc")(function* () {
      const raw = yield* fs.readFileString(adcPath).pipe(
        Effect.mapError(
          () =>
            new DevboxVertexMetadataError({
              message: "Local Google ADC file could not be read.",
            }),
        ),
      );
      return yield* decodeAuthorizedUserAdc(raw).pipe(
        Effect.mapError(
          () =>
            new DevboxVertexMetadataError({
              message: "Local Google ADC file is not an authorized_user credential.",
            }),
        ),
      );
    });

    const mintAccessToken = Effect.fn("DevboxVertexMetadata.mintAccessToken")(function* (
      adc: AuthorizedUserAdc,
    ) {
      const form = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: adc.client_id,
        client_secret: adc.client_secret,
        refresh_token: adc.refresh_token,
      });
      const request = HttpClientRequest.post(tokenUrl).pipe(
        HttpClientRequest.setBody(
          HttpBody.text(form.toString(), "application/x-www-form-urlencoded"),
        ),
      );
      const response = yield* httpClient.execute(request).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((res) => res.json),
        Effect.flatMap(decodeOAuthTokenResponse),
        Effect.timeout("20 seconds"),
        Effect.mapError(
          () =>
            new DevboxVertexMetadataError({
              message: "Could not refresh Google ADC access token.",
            }),
        ),
      );
      const now = yield* Clock.currentTimeMillis;
      const lifetimeSeconds = Math.max(
        1,
        Math.floor(response.expires_in ?? DEFAULT_TOKEN_LIFETIME_SECONDS),
      );
      const lifetimeMs = lifetimeSeconds * 1000;
      const refreshMarginMs = Math.min(MAX_TOKEN_REFRESH_MARGIN_MS, Math.floor(lifetimeMs / 2));
      return {
        refreshToken: adc.refresh_token,
        accessToken: response.access_token,
        expiresAtMs: now + lifetimeMs,
        refreshMarginMs,
      };
    });

    const hasAdcCredentials = readAdc().pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

    const getAccount = readAdc().pipe(
      Effect.map((adc) => adc.account ?? null),
      Effect.orElseSucceed(() => null),
    );

    const getToken = lock.withPermits(1)(
      Effect.gen(function* () {
        const adc = yield* readAdc();
        const now = yield* Clock.currentTimeMillis;
        if (
          cached !== undefined &&
          cached.refreshToken === adc.refresh_token &&
          cached.expiresAtMs - now > cached.refreshMarginMs
        ) {
          return {
            accessToken: cached.accessToken,
            expiresInSeconds: Math.max(1, Math.floor((cached.expiresAtMs - now) / 1000)),
          } satisfies DevboxVertexToken;
        }
        const fresh = yield* mintAccessToken(adc);
        cached = fresh;
        const afterMint = yield* Clock.currentTimeMillis;
        return {
          accessToken: fresh.accessToken,
          expiresInSeconds: Math.max(1, Math.floor((fresh.expiresAtMs - afterMint) / 1000)),
        } satisfies DevboxVertexToken;
      }),
    );

    const handleRequest = Effect.fn("DevboxVertexMetadata.handleRequest")(function* (
      req: NodeHttp.IncomingMessage,
      res: NodeHttp.ServerResponse,
    ) {
      const send = (status: number, contentType: string, body: string) => {
        res.writeHead(status, {
          "Content-Type": contentType,
          "Metadata-Flavor": "Google",
          "Cache-Control": "no-store",
        });
        res.end(body);
      };

      if (
        req.method !== "GET" ||
        !isAllowedMetadataRequest({ headers: req.headers }, allowedHosts)
      ) {
        res.writeHead(404);
        res.end();
        return;
      }

      const hostConfig = readHostAntigravityConfig(yield* settings.getSettings);
      if (!hostConfig) {
        res.writeHead(404);
        res.end();
        return;
      }

      const rawUrl = req.url ?? "/";
      const queryIndex = rawUrl.indexOf("?");
      const pathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);

      if (pathname === "/computeMetadata/v1/" || pathname === "/computeMetadata/v1") {
        send(200, "text/plain; charset=utf-8", "instance/\nproject/\n");
        return;
      }
      if (
        pathname === "/computeMetadata/v1/instance" ||
        pathname === "/computeMetadata/v1/instance/"
      ) {
        send(200, "text/plain; charset=utf-8", "attributes/\nservice-accounts/\n");
        return;
      }
      if (pathname === "/computeMetadata/v1/instance/attributes/t3-broker-id") {
        send(200, "text/plain; charset=utf-8", brokerId);
        return;
      }
      if (pathname === "/computeMetadata/v1/project/project-id") {
        send(200, "text/plain; charset=utf-8", hostConfig.gcpProject);
        return;
      }
      if (pathname === "/computeMetadata/v1/instance/service-accounts/default/email") {
        send(200, "text/plain; charset=utf-8", (yield* getAccount) ?? "default");
        return;
      }
      if (pathname === "/computeMetadata/v1/instance/service-accounts/default/token") {
        const result = yield* getToken.pipe(Effect.result);
        if (result._tag === "Failure") {
          yield* Effect.logWarning("devbox Vertex metadata token mint failed", {
            message: result.failure.message,
          });
          send(502, "text/plain; charset=utf-8", "Could not mint Google ADC access token.");
          return;
        }
        // Recheck sharing after async OAuth refresh so disabling mid-flight never vends a token.
        if (!readHostAntigravityConfig(yield* settings.getSettings)) {
          res.writeHead(404);
          res.end();
          return;
        }
        const tokenBody = yield* encodeMetadataTokenResponse({
          access_token: result.success.accessToken,
          expires_in: result.success.expiresInSeconds,
          token_type: "Bearer",
        }).pipe(Effect.orDie);
        send(200, "application/json", tokenBody);
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const platform = yield* HostProcess.Platform;
    if (platform === "win32") {
      return { socketPath: "", brokerId, hasAdcCredentials, getToken, getAccount };
    }

    const bindBroker = Effect.gen(function* () {
      const location = yield* Effect.try({
        try: () =>
          resolveBrokerSocketLocation(path, serverConfig.stateDir, brokerId, options?.socketPath),
        catch: () =>
          new DevboxVertexMetadataError({
            message: "Could not prepare owner-only Vertex metadata socket directory.",
          }),
      });
      yield* Effect.acquireRelease(
        Effect.callback<NodeHttp.Server, DevboxVertexMetadataError>((resume) => {
          const srv = NodeHttp.createServer((req, res) => {
            void runPromise(
              handleRequest(req, res).pipe(
                Effect.catchCause(() =>
                  Effect.sync(() => {
                    if (!res.headersSent) {
                      res.writeHead(500);
                      res.end();
                    }
                  }),
                ),
              ),
            );
          });
          const onStartupError = () =>
            resume(
              Effect.fail(
                new DevboxVertexMetadataError({
                  message: "Could not start Vertex metadata socket server.",
                }),
              ),
            );
          srv.once("error", onStartupError);
          srv.listen(location.socketPath, () => {
            srv.off("error", onStartupError);
            srv.on("error", (error) => {
              void runPromise(
                Effect.logWarning("Devbox Vertex metadata socket error", {
                  message: error.message,
                }),
              );
            });
            try {
              NodeFS.chmodSync(location.socketPath, 0o600);
            } catch {
              srv.close();
              resume(
                Effect.fail(
                  new DevboxVertexMetadataError({
                    message: "Could not restrict Vertex metadata socket permissions.",
                  }),
                ),
              );
              return;
            }
            resume(Effect.succeed(srv));
          });
        }),
        (srv) =>
          Effect.callback<void>((resume) => {
            srv.close(() => {
              try {
                NodeFS.rmSync(location.socketPath, { force: true });
                if (location.cleanupDir) {
                  NodeFS.rmSync(location.cleanupDir, { recursive: true, force: true });
                }
              } catch {
                // Best-effort cleanup of the socket file on shutdown.
              }
              resume(Effect.void);
            });
          }),
      );
      if (location.sweepDir) {
        yield* sweepStaleBrokerSockets(path, location.sweepDir, location.socketPath);
      }
      return location.socketPath;
    });

    // Never fail host server startup if Unix-socket binding is unsupported or unwritable.
    const socketPath = yield* bindBroker.pipe(
      Effect.catch((error) =>
        Effect.logWarning("Devbox Vertex metadata broker unavailable", {
          message: error.message,
        }).pipe(Effect.as("")),
      ),
    );

    return { socketPath, brokerId, hasAdcCredentials, getToken, getAccount };
  });

  static readonly layer = Layer.effect(DevboxVertexMetadata, DevboxVertexMetadata.make()).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
}
