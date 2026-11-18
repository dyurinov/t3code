import * as Schema from "effect/Schema";

import { EnvironmentId } from "./baseSchemas.ts";

/** An error or warning a client showed or caught, kept on its host so it can be read later. */
export const ClientIssue = Schema.Struct({
  level: Schema.Literals(["error", "warning"]),
  source: Schema.Literals(["toast", "window-error", "unhandled-rejection", "error-screen"]),
  title: Schema.String.check(Schema.isMaxLength(500)),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
  stack: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8_000))),
  environmentId: Schema.optionalKey(EnvironmentId),
  threadId: Schema.optionalKey(Schema.String),
  route: Schema.optionalKey(Schema.String),
  occurredAt: Schema.String,
});
export type ClientIssue = typeof ClientIssue.Type;
