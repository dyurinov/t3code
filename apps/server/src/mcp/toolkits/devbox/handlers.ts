import { type DevboxError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as DevboxService from "../../../devbox/DevboxService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { DevboxToolkit } from "./tools.ts";

const toFailure = (error: DevboxError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "not_found" || error.reason === "invalid" || error.reason === "busy"
        ? "invalid_request"
        : "orchestration_error",
    message: error.message,
  });

const withService = <A>(
  use: (service: DevboxService.DevboxService["Service"]) => Effect.Effect<A, DevboxError>,
) => DevboxService.DevboxService.pipe(Effect.flatMap(use), Effect.mapError(toFailure));

// Boxes cost money and hold credentials, so changing them is an environment setting.
export const layer = McpToolAccess.toLayer(DevboxToolkit, {
  devbox_list: McpToolAccess.reads(() =>
    withService((service) =>
      Effect.all([service.list, service.logins, service.deleted]).pipe(
        Effect.map(([devboxes, logins, deleted]) => ({
          devboxes,
          logins,
          deleted,
          migratesThreadsOnDelete: true,
        })),
      ),
    ),
  ),
  devbox_create: McpToolAccess.writesEnvironment((input) =>
    withService((service) => service.create(input)),
  ),
  devbox_wait: McpToolAccess.reads(({ name, seconds }) =>
    withService((service) =>
      service.awaitReady(name, Duration.seconds(Math.min(280, Math.max(5, seconds ?? 240))), {
        waitForLogin: true,
      }),
    ),
  ),
  devbox_wake: McpToolAccess.writesEnvironment(({ name }) =>
    withService((service) => service.wake(name)),
  ),
  devbox_stop: McpToolAccess.writesEnvironment(({ name }) =>
    withService((service) => service.stop(name)),
  ),
  devbox_delete: McpToolAccess.writesEnvironment(({ name, force, skipMigration }) =>
    withService((service) =>
      service.remove(name, { force: force ?? false, skipMigration: skipMigration ?? false }),
    ),
  ),
});
