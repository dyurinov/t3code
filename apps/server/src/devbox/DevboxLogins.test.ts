import * as NodeServices from "@effect/platform-node/NodeServices";
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
import * as TestClock from "effect/testing/TestClock";

import * as ProcessRunner from "../processRunner.ts";
import * as DevboxLogins from "./DevboxLogins.ts";

const DAY = 24 * 60 * 60 * 1000;

const setup = Effect.fn("test.setup")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  yield* fs.makeDirectory(path.join(root, "master"));
  yield* fs.writeFileString(
    path.join(root, "master", "claude.json"),
    JSON.stringify({
      oauth: {
        accessToken: "sk-ant-oat01-mac",
        refreshToken: "sk-ant-ort01-mac",
        expiresAt: DAY,
        scopes: ["user:inference"],
        subscriptionType: "enterprise",
      },
      oauthAccount: { emailAddress: "me@example.com" },
    }),
  );
  yield* fs.writeFileString(
    path.join(root, "master", "codex.json"),
    JSON.stringify({
      auth: {
        auth_mode: "chatgpt",
        OPENAI_API_KEY: "sk-long-lived",
        tokens: { id_token: "id", access_token: "access", refresh_token: "rt.1.codex" },
      },
      expiresAt: 10 * DAY,
    }),
  );
  return yield* DevboxLogins.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ T3CODE_DEVBOX_CREDS_DIR: root, PATH: "" }),
        ),
        Layer.mock(ProcessRunner.ProcessRunner)({}),
        Layer.mock(Digest.Digest)({ digest: () => Effect.succeed(new Uint8Array(32)) }),
      ),
    ),
  );
});

describe("devbox sign-ins", () => {
  it.effect(
    "seals a fresh Claude sign-in once, even with two boxes renewing it at the same time",
    () =>
      Effect.gen(function* () {
        const logins = yield* setup();
        let relayed = 0;
        const relay = (request: DevboxLogins.DevboxRefreshRequest) =>
          Effect.sync(() => {
            relayed++;
            expect(request).toEqual({
              provider: "claude",
              refreshToken: "sk-ant-ort01-mac",
              scopes: ["user:inference"],
              requireFormal: true,
            });
            return {
              access_token: "formalsealed:v2:access",
              refresh_token: "formalsealed:v2:refresh",
              expires_in: 28_800,
            };
          });
        const renewed = yield* Effect.all(
          [logins.refresh("claude", relay), logins.refresh("claude", relay)],
          { concurrency: "unbounded" },
        );
        expect(renewed.toSorted()).toEqual([false, true]);
        expect(relayed).toBe(1);
        expect(yield* logins.info("claude")).toEqual({
          signedIn: true,
          account: "me@example.com",
          expiresAt: 28_800_000,
          sealed: true,
        });
        expect(Option.isNone(yield* logins.due("claude"))).toBe(true);
        // Codex is not due for another week.
        expect(Option.isNone(yield* logins.due("codex"))).toBe(true);
        const payload = yield* logins.payload;
        expect(payload.claude?.oauth).toEqual({
          accessToken: "formalsealed:v2:access",
          expiresAt: 28_800_000,
          scopes: ["user:inference"],
          subscriptionType: "enterprise",
        });
        expect(payload.codex?.tokens.refresh_token).toBe("");
        expect(payload.codex?.OPENAI_API_KEY).toBeNull();
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect("saves a renewed token even when the caller is interrupted while the box relays", () =>
    Effect.gen(function* () {
      const logins = yield* setup();
      const answered = yield* Deferred.make<void>();
      const relaying = yield* Deferred.make<void>();
      const renewal = yield* Effect.forkChild(
        logins.refresh("claude", () =>
          Deferred.succeed(relaying, undefined).pipe(
            Effect.andThen(Deferred.await(answered)),
            Effect.as({
              access_token: "formalsealed:v2:access",
              refresh_token: "formalsealed:v2:refresh",
            }),
          ),
        ),
      );
      yield* Deferred.await(relaying);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(renewal));
      yield* Deferred.succeed(answered, undefined);
      yield* Fiber.join(interrupting);
      expect((yield* logins.info("claude")).sealed).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("leaves an expired sign-in out of what boxes get", () =>
    Effect.gen(function* () {
      const logins = yield* setup();
      yield* TestClock.adjust("2 days");
      const payload = yield* logins.payload;
      expect(payload.claude).toBeNull();
      expect(payload.codex).not.toBeNull();
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect("treats a refused sign-in as signed out: not due, not handed to boxes", () =>
    Effect.gen(function* () {
      const logins = yield* setup();
      yield* logins.reject("claude", "sk-ant-ort01-mac");
      expect((yield* logins.info("claude")).signedIn).toBe(false);
      expect(Option.isNone(yield* logins.due("claude"))).toBe(true);
      expect((yield* logins.payload).claude).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
