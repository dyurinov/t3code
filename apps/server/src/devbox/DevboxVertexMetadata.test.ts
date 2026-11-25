// @effect-diagnostics nodeBuiltinImport:off - Tests exercise raw Unix socket HTTP requests and socket mode checks.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";

import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePathLayer from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import {
  DevboxVertexMetadata,
  isAllowedMetadataRequest,
  readHostAntigravityConfig,
} from "./DevboxVertexMetadata.ts";
import { VERTEX_METADATA_PORT_ON_BOX } from "./devboxScripts.ts";

const ANTIGRAVITY_ID = ProviderInstanceId.make("antigravity");
const BOX_METADATA_HOST = `127.0.0.1:${VERTEX_METADATA_PORT_ON_BOX}`;

function settingsWithAntigravity(
  overrides: Partial<{
    enabled: boolean;
    authMethod: string;
    gcpProject: string;
    gcpLocation: string;
    apiKey: string;
  }> = {},
): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      ...DEFAULT_SERVER_SETTINGS.providerInstances,
      [ANTIGRAVITY_ID]: {
        driver: ProviderDriverKind.make("antigravity"),
        displayName: "Antigravity",
        enabled: overrides.enabled ?? true,
        config: {
          authMethod: overrides.authMethod ?? "agent-platform",
          gcpProject: overrides.gcpProject ?? "demo-project-123",
          gcpLocation: overrides.gcpLocation ?? "eu",
          ...(overrides.apiKey === undefined ? {} : { apiKey: overrides.apiKey }),
        },
        environment: [],
      },
    },
  };
}

function rawUnixSocketGet(
  socketPath: string,
  requestPath: string,
  headers: Record<string, string>,
): Effect.Effect<{
  readonly status: number;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}> {
  return Effect.callback((resume) => {
    const req = NodeHttp.request(
      {
        socketPath,
        path: requestPath,
        method: "GET",
        headers,
      },
      (res) => {
        const chunks: Array<Buffer> = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resume(
            Effect.succeed({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          ),
        );
      },
    );
    req.on("error", (error) => resume(Effect.die(error)));
    req.end();
  });
}

describe("DevboxVertexMetadata", () => {
  it("reads host Antigravity config only for enabled Agent Platform ADC without an API key", () => {
    expect(readHostAntigravityConfig(DEFAULT_SERVER_SETTINGS)).toBeUndefined();
    expect(readHostAntigravityConfig(settingsWithAntigravity())).toEqual({
      gcpProject: "demo-project-123",
      gcpLocation: "eu",
    });
    expect(readHostAntigravityConfig(settingsWithAntigravity({ enabled: false }))).toBeUndefined();
    expect(
      readHostAntigravityConfig(settingsWithAntigravity({ authMethod: "oauth-business" })),
    ).toBeUndefined();
    expect(
      readHostAntigravityConfig(settingsWithAntigravity({ apiKey: "AIza-fake" })),
    ).toBeUndefined();
    expect(
      readHostAntigravityConfig(settingsWithAntigravity({ gcpProject: "   " })),
    ).toBeUndefined();
  });

  it("enforces exact Host allowlist, Metadata-Flavor, and rejects rebinding/fetch/proxy headers", () => {
    expect(
      isAllowedMetadataRequest({
        headers: { host: BOX_METADATA_HOST, "metadata-flavor": "Google" },
      }),
    ).toBe(true);
    // DNS rebinding: evil.com resolves to 127.0.0.1 with no Origin on same-origin GET.
    expect(
      isAllowedMetadataRequest({
        headers: { host: "evil.com:3773", "metadata-flavor": "Google" },
      }),
    ).toBe(false);
    // Browser fetch metadata header.
    expect(
      isAllowedMetadataRequest({
        headers: {
          host: BOX_METADATA_HOST,
          "metadata-flavor": "Google",
          "sec-fetch-site": "same-origin",
        },
      }),
    ).toBe(false);
    // Missing Metadata-Flavor or reverse-proxy / Origin headers.
    expect(
      isAllowedMetadataRequest({
        headers: { host: BOX_METADATA_HOST },
      }),
    ).toBe(false);
    expect(
      isAllowedMetadataRequest({
        headers: {
          host: BOX_METADATA_HOST,
          "metadata-flavor": "Google",
          "x-forwarded-for": "203.0.113.10",
        },
      }),
    ).toBe(false);
    expect(
      isAllowedMetadataRequest({
        headers: {
          host: BOX_METADATA_HOST,
          "metadata-flavor": "Google",
          origin: "https://evil.example",
        },
      }),
    ).toBe(false);
  });

  it.effect(
    "mints, caches with scaled refresh margin, measures fresh remaining time after delayed OAuth exchange, rotates on ADC change, and omits parse-error causes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vertex-adc-" });
        const adcPath = path.join(dir, "application_default_credentials.json");
        const writeAdc = (refreshToken: string) =>
          fs.writeFileString(
            adcPath,
            `{"type":"authorized_user","client_id":"client-id","client_secret":"client-secret","refresh_token":"${refreshToken}","account":"dev@example.com"}`,
          );
        yield* writeAdc("rt-first");

        let mintCount = 0;
        let nextLifetimeSeconds = 30;
        let exchangeDelaySeconds = 10;
        const fakeHttp = HttpClient.make((request) =>
          Effect.gen(function* () {
            if (exchangeDelaySeconds > 0) {
              yield* TestClock.adjust(Duration.seconds(exchangeDelaySeconds));
            }
            mintCount++;
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                `{"access_token":"ya29.token-${mintCount}","expires_in":${nextLifetimeSeconds}}`,
                { status: 200, headers: { "Content-Type": "application/json" } },
              ),
            );
          }),
        );

        const baseLayers = Layer.mergeAll(NodeFileSystem.layer, NodePathLayer.layer);
        const service = yield* DevboxVertexMetadata.make({ adcPath }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(HttpClient.HttpClient, fakeHttp),
              ServerConfig.layerTest(dir, dir).pipe(Layer.provide(baseLayers)),
              Layer.mock(ServerSettingsService.ServerSettingsService)({
                getSettings: Effect.succeed(settingsWithAntigravity()),
              }),
            ),
          ),
        );

        expect(yield* service.hasAdcCredentials).toBe(true);
        expect(yield* service.getAccount).toBe("dev@example.com");

        // Delayed 10s OAuth exchange for a 30s token must report <= 30s (never inflated to 40s) and stay cached.
        const first = yield* service.getToken;
        const second = yield* service.getToken;
        expect(first.accessToken).toBe("ya29.token-1");
        expect(first.expiresInSeconds).toBe(30);
        expect(second.accessToken).toBe("ya29.token-1");
        expect(mintCount).toBe(1);

        // Re-running gcloud auth application-default login updates refresh_token and invalidates cache.
        exchangeDelaySeconds = 0;
        nextLifetimeSeconds = 3600;
        yield* writeAdc("rt-second");
        const third = yield* service.getToken;
        expect(third.accessToken).toBe("ya29.token-2");
        expect(third.expiresInSeconds).toBe(3600);
        expect(mintCount).toBe(2);

        // Corrupt ADC file produces a fixed error message with no raw credential content in the error.
        yield* fs.writeFileString(adcPath, '{"refresh_token":"secret-leak-marker",');
        const failure = yield* service.getToken.pipe(Effect.flip);
        expect(failure.message).toBe("Local Google ADC file is not an authorized_user credential.");
        expect(JSON.stringify(failure)).not.toContain("secret-leak-marker");
      }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePathLayer.layer))),
  );

  it.effect(
    "serves owner-only 0600 Unix-socket broker endpoints including broker-id challenge and rejects bad Host, Sec-Fetch, or disabled settings",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vertex-broker-" });
        const adcPath = path.join(dir, "application_default_credentials.json");
        yield* fs.writeFileString(
          adcPath,
          '{"type":"authorized_user","client_id":"cid","client_secret":"csec","refresh_token":"rt","account":"dev@example.com"}',
        );

        let currentSettings = settingsWithAntigravity();
        let disableDuringMint = false;
        const fakeHttp = HttpClient.make((request) =>
          Effect.sync(() => {
            if (disableDuringMint) {
              disableDuringMint = false;
              currentSettings = DEFAULT_SERVER_SETTINGS;
            }
            return HttpClientResponse.fromWeb(
              request,
              new Response('{"access_token":"ya29.short-lived","expires_in":1800}', {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }),
            );
          }),
        );

        const baseLayers = Layer.mergeAll(NodeFileSystem.layer, NodePathLayer.layer);
        const service = yield* DevboxVertexMetadata.make({ adcPath }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(HttpClient.HttpClient, fakeHttp),
              ServerConfig.layerTest(dir, dir).pipe(Layer.provide(baseLayers)),
              Layer.mock(ServerSettingsService.ServerSettingsService)({
                getSettings: Effect.sync(() => currentSettings),
              }),
            ),
          ),
        );

        // Parent directory must be owner-only (0700) before bind, and socket must be 0600.
        expect(NodeFS.statSync(path.dirname(service.socketPath)).mode & 0o777).toBe(0o700);
        expect(NodeFS.statSync(service.socketPath).mode & 0o777).toBe(0o600);
        expect(service.brokerId.length).toBeGreaterThan(10);

        // DNS rebinding with no Origin must be rejected.
        const rebind = yield* rawUnixSocketGet(
          service.socketPath,
          "/computeMetadata/v1/instance/service-accounts/default/token",
          { Host: "evil.com:3773", "Metadata-Flavor": "Google" },
        );
        expect(rebind.status).toBe(404);

        // Browser Sec-Fetch-Site must be rejected even with the allowlisted Host.
        const secFetch = yield* rawUnixSocketGet(
          service.socketPath,
          "/computeMetadata/v1/project/project-id",
          {
            Host: BOX_METADATA_HOST,
            "Metadata-Flavor": "Google",
            "Sec-Fetch-Site": "same-origin",
          },
        );
        expect(secFetch.status).toBe(404);

        // Valid devbox-forwarded requests succeed on instance, broker-id, project-id, email, and token.
        const instanceRes = yield* rawUnixSocketGet(
          service.socketPath,
          "/computeMetadata/v1/instance",
          { Host: BOX_METADATA_HOST, "Metadata-Flavor": "Google" },
        );
        expect(instanceRes.status).toBe(200);
        expect(instanceRes.headers["metadata-flavor"]).toBe("Google");

        const brokerRes = yield* rawUnixSocketGet(
          service.socketPath,
          "/computeMetadata/v1/instance/attributes/t3-broker-id",
          { Host: BOX_METADATA_HOST, "Metadata-Flavor": "Google" },
        );
        expect(brokerRes.status).toBe(200);
        expect(brokerRes.body).toBe(service.brokerId);

        const projectRes = yield* rawUnixSocketGet(
          service.socketPath,
          "/computeMetadata/v1/project/project-id",
          { Host: BOX_METADATA_HOST, "Metadata-Flavor": "Google" },
        );
        expect(projectRes.status).toBe(200);
        expect(projectRes.body).toBe("demo-project-123");

        const emailRes = yield* rawUnixSocketGet(
          service.socketPath,
          "/computeMetadata/v1/instance/service-accounts/default/email",
          { Host: BOX_METADATA_HOST, "Metadata-Flavor": "Google" },
        );
        expect(emailRes.status).toBe(200);
        expect(emailRes.body).toBe("dev@example.com");

        const tokenRes = yield* rawUnixSocketGet(
          service.socketPath,
          "/computeMetadata/v1/instance/service-accounts/default/token?scopes=https://www.googleapis.com/auth/cloud-platform",
          { Host: BOX_METADATA_HOST, "Metadata-Flavor": "Google" },
        );
        expect(tokenRes.status).toBe(200);
        expect(tokenRes.headers["metadata-flavor"]).toBe("Google");
        expect(JSON.parse(tokenRes.body)).toEqual({
          access_token: "ya29.short-lived",
          expires_in: 1800,
          token_type: "Bearer",
        });

        // Disabling Antigravity while an OAuth refresh is in flight must NOT vend a token.
        yield* fs.writeFileString(
          adcPath,
          '{"type":"authorized_user","client_id":"cid","client_secret":"csec","refresh_token":"rt-inflight","account":"dev@example.com"}',
        );
        disableDuringMint = true;
        const inFlightDisabled = yield* rawUnixSocketGet(
          service.socketPath,
          "/computeMetadata/v1/instance/service-accounts/default/token",
          { Host: BOX_METADATA_HOST, "Metadata-Flavor": "Google" },
        );
        expect(inFlightDisabled.status).toBe(404);
        expect(inFlightDisabled.body).toBe("");

        // Disabling Antigravity on the host immediately shuts off metadata endpoints.
        currentSettings = DEFAULT_SERVER_SETTINGS;
        const disabledRes = yield* rawUnixSocketGet(
          service.socketPath,
          "/computeMetadata/v1/project/project-id",
          { Host: BOX_METADATA_HOST, "Metadata-Flavor": "Google" },
        );
        expect(disabledRes.status).toBe(404);
      }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePathLayer.layer))),
  );

  it.effect(
    "degrades cleanly on win32, dir prep failure, or live-socket conflict, and isolates /tmp sockets per stateDir",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vertex-degrade-" });
        const blockingFile = path.join(dir, "not-a-directory");
        yield* fs.writeFileString(blockingFile, "occupied");

        const baseLayers = Layer.mergeAll(NodeFileSystem.layer, NodePathLayer.layer);
        const makeEnv = (stateDir: string) =>
          Layer.mergeAll(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("unused")),
            ),
            ServerConfig.layerTest(stateDir, stateDir).pipe(Layer.provide(baseLayers)),
            Layer.mock(ServerSettingsService.ServerSettingsService)({
              getSettings: Effect.succeed(settingsWithAntigravity()),
            }),
          );
        const envLayers = makeEnv(dir);

        const winService = yield* DevboxVertexMetadata.make({
          adcPath: path.join(dir, "missing.json"),
        }).pipe(
          Effect.provide(Layer.merge(envLayers, Layer.succeed(HostProcess.Platform, "win32"))),
        );
        expect(winService.socketPath).toBe("");

        // Directory preparation failure degrades cleanly.
        const failedDir = yield* DevboxVertexMetadata.make({
          adcPath: path.join(dir, "missing.json"),
          socketPath: path.join(blockingFile, "broker.sock"),
        }).pipe(Effect.provide(envLayers));
        expect(failedDir.socketPath).toBe("");

        // Real srv.listen() failure (>104-byte explicit socketPath) degrades cleanly.
        const overlongSocket = path.join(dir, `${"x".repeat(110)}.sock`);
        const failedListen = yield* DevboxVertexMetadata.make({
          adcPath: path.join(dir, "missing.json"),
          socketPath: overlongSocket,
        }).pipe(Effect.provide(envLayers));
        expect(failedListen.socketPath).toBe("");

        // Real live-socket conflict degrades cleanly without replacing the live broker.
        const shortDir = yield* fs.makeTempDirectoryScoped({
          directory: "/tmp",
          prefix: "t3-live-",
        });
        const sharedSocket = path.join(shortDir, "broker.sock");
        const firstBroker = yield* DevboxVertexMetadata.make({
          adcPath: path.join(dir, "missing.json"),
          socketPath: sharedSocket,
        }).pipe(Effect.provide(envLayers));
        expect(firstBroker.socketPath).toBe(sharedSocket);

        const secondBroker = yield* DevboxVertexMetadata.make({
          adcPath: path.join(dir, "missing.json"),
          socketPath: sharedSocket,
        }).pipe(Effect.provide(envLayers));
        expect(secondBroker.socketPath).toBe("");

        const stillFirst = yield* rawUnixSocketGet(
          sharedSocket,
          "/computeMetadata/v1/instance/attributes/t3-broker-id",
          { Host: BOX_METADATA_HOST, "Metadata-Flavor": "Google" },
        );
        expect(stillFirst.status).toBe(200);
        expect(stillFirst.body).toBe(firstBroker.brokerId);

        // Concurrent startups sharing the same long stateDir bind distinct sockets with zero unlink races.
        const longState = path.join(dir, `${"a".repeat(95)}-shared`);
        const [brokerA, brokerB] = yield* Effect.all(
          [
            DevboxVertexMetadata.make({ adcPath: path.join(dir, "missing.json") }).pipe(
              Effect.provide(makeEnv(longState)),
            ),
            DevboxVertexMetadata.make({ adcPath: path.join(dir, "missing.json") }).pipe(
              Effect.provide(makeEnv(longState)),
            ),
          ],
          { concurrency: "unbounded" },
        );
        expect(brokerA.socketPath).not.toBe("");
        expect(brokerB.socketPath).not.toBe("");
        expect(brokerA.socketPath).not.toBe(brokerB.socketPath);
        expect(NodeFS.statSync(path.dirname(brokerA.socketPath)).mode & 0o777).toBe(0o700);
        const [resA, resB] = yield* Effect.all(
          [
            rawUnixSocketGet(
              brokerA.socketPath,
              "/computeMetadata/v1/instance/attributes/t3-broker-id",
              { Host: BOX_METADATA_HOST, "Metadata-Flavor": "Google" },
            ),
            rawUnixSocketGet(
              brokerB.socketPath,
              "/computeMetadata/v1/instance/attributes/t3-broker-id",
              { Host: BOX_METADATA_HOST, "Metadata-Flavor": "Google" },
            ),
          ],
          { concurrency: "unbounded" },
        );
        expect(resA.body).toBe(brokerA.brokerId);
        expect(resB.body).toBe(brokerB.brokerId);
      }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePathLayer.layer))),
  );
});
