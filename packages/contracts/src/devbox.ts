import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A Coder devbox this environment created and manages: one task per box, linked
 * back here as an environment over an SSH forward to a fixed loopback port.
 */
export const DevboxState = Schema.Literals([
  "creating",
  "starting",
  "running",
  "stopping",
  "stopped",
  "deleting",
  "failed",
  "missing",
]);
export type DevboxState = typeof DevboxState.Type;

/**
 * `no-login`: this machine has no sign-in for the provider yet. `unbound`: the sign-in is
 * Formal-sealed and the box has no Formal, so it would only fail there.
 */
export const DevboxCredentialState = Schema.Literals([
  "installed",
  "not-installed",
  "no-login",
  "unbound",
]);
export type DevboxCredentialState = typeof DevboxCredentialState.Type;

export const DevboxSummary = Schema.Struct({
  name: Schema.String,
  state: DevboxState,
  /** The box's T3 environment once linked; null until then. */
  environmentId: Schema.NullOr(EnvironmentId),
  /** Loopback address this machine reaches the box's T3 server at. */
  url: Schema.String,
  task: Schema.NullOr(Schema.String),
  /** Prepared for the next claim and not yet anyone's. */
  spare: Schema.Boolean,
  createdAt: Schema.String,
  /** When Coder stops the box unless a running turn extends it. */
  deadline: Schema.NullOr(Schema.String),
  credentials: Schema.Struct({ claude: DevboxCredentialState, codex: DevboxCredentialState }),
  loginRequired: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        settingsUrl: Schema.Literal("/settings/devboxes"),
      }),
    ),
  ),
  lastError: Schema.NullOr(Schema.String),
});
export type DevboxSummary = typeof DevboxSummary.Type;

export class DevboxError extends Schema.TaggedError<DevboxError>()("DevboxError", {
  reason: Schema.Literals([
    "not_found",
    "busy",
    "invalid",
    "coder",
    "provision",
    "link",
    "migration",
    "storage",
  ]),
  message: Schema.String,
}) {}

export const DevboxCreateInput = Schema.Struct({
  task: Schema.optionalKey(
    TrimmedNonEmptyString.annotate({
      description: "What the box is for.",
    }),
  ),
  name: Schema.optionalKey(
    TrimmedNonEmptyString.annotate({
      description: "Preferred name for a fresh box; a claimed spare keeps its existing name.",
    }),
  ),
  branch: Schema.optionalKey(
    TrimmedNonEmptyString.annotate({ description: "Existing codez branch to check out." }),
  ),
});
export type DevboxCreateInput = typeof DevboxCreateInput.Type;

export const DevboxNameInput = Schema.Struct({
  name: TrimmedNonEmptyString.annotate({ description: "Box name from devbox_list." }),
});
export type DevboxNameInput = typeof DevboxNameInput.Type;

export const DevboxDeleteInput = Schema.Struct({
  name: TrimmedNonEmptyString.annotate({ description: "Box name from devbox_list." }),
  force: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Delete even with a running turn or if threads cannot be copied off the box. Unpushed work on the box is lost.",
    }),
  ),
  skipMigration: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Skip copying threads from the box before deleting (only used when force-deleting after an earlier migration attempt failed).",
    }),
  ),
});
export type DevboxDeleteInput = typeof DevboxDeleteInput.Type;

export const DevboxLoginProvider = Schema.Literals(["claude", "codex"]);
export type DevboxLoginProvider = typeof DevboxLoginProvider.Type;

/**
 * This machine's one sign-in for a provider. Devboxes get its access token; the sign-in itself
 * stays here and renews through a running box.
 */
export const DevboxLogin = Schema.Struct({
  provider: DevboxLoginProvider,
  signedIn: Schema.Boolean,
  account: Schema.NullOr(Schema.String),
  /** When the access token devboxes hold runs out, in epoch milliseconds. */
  expiresAt: Schema.NullOr(Schema.Number),
  /** Sealed by Asana's Formal connector, so it only works on boxes with Formal. */
  sealed: Schema.Boolean,
  signingIn: Schema.Boolean,
  /** Where the user approves the running sign-in, once its CLI printed the link. */
  pendingUrl: Schema.NullOr(Schema.String),
  /** Why the last sign-in or renewal failed. */
  lastError: Schema.NullOr(Schema.String),
});
export type DevboxLogin = typeof DevboxLogin.Type;

export const DevboxSubmitLoginCodeInput = Schema.Struct({
  provider: DevboxLoginProvider,
  code: TrimmedNonEmptyString,
});
export type DevboxSubmitLoginCodeInput = typeof DevboxSubmitLoginCodeInput.Type;

/** A box T3 deleted; clients drop their saved environment for it. */
export const DeletedDevbox = Schema.Struct({
  name: Schema.String,
  /** Unknown for boxes deleted before this was recorded. */
  environmentId: Schema.NullOr(EnvironmentId),
});
export type DeletedDevbox = typeof DeletedDevbox.Type;

export const DevboxListResult = Schema.Struct({
  devboxes: Schema.Array(DevboxSummary),
  logins: Schema.Array(DevboxLogin),
  deleted: Schema.Array(DeletedDevbox),
  migratesThreadsOnDelete: Schema.optionalKey(Schema.Boolean),
});
export type DevboxListResult = typeof DevboxListResult.Type;

export const DevboxLoginInput = Schema.Struct({ provider: DevboxLoginProvider });
export type DevboxLoginInput = typeof DevboxLoginInput.Type;

export const DevboxDeleteResult = Schema.Struct({
  name: Schema.String,
  deleted: Schema.Boolean,
  migratedThreads: Schema.optionalKey(Schema.Number),
  skippedThreads: Schema.optionalKey(Schema.Number),
  migratedAttachments: Schema.optionalKey(Schema.Number),
  migrationWarning: Schema.optionalKey(Schema.String),
});
export type DevboxDeleteResult = typeof DevboxDeleteResult.Type;

/** What a client needs to connect to a devbox directly: its loopback URL and a one-time code. */
export const DevboxClientPairing = Schema.Struct({
  environmentId: EnvironmentId,
  url: Schema.String,
  pairingCode: Schema.String,
});
export type DevboxClientPairing = typeof DevboxClientPairing.Type;

export const DevboxClaimResult = Schema.Struct({
  ...DevboxClientPairing.fields,
  name: Schema.String,
});
export type DevboxClaimResult = typeof DevboxClaimResult.Type;

export const DevboxUsageInput = Schema.Struct({
  /** ISO time the window starts. */
  since: Schema.String,
  /** ISO time the window ends. */
  until: Schema.String,
});
export type DevboxUsageInput = typeof DevboxUsageInput.Type;

/** One box's time and estimated cost inside the window, from its Coder build history. */
export const DevboxUsageEntry = Schema.Struct({
  name: Schema.String,
  /** Created and managed by T3; others are the user's own Coder boxes. */
  managed: Schema.Boolean,
  /** `null` once the box is deleted. */
  state: Schema.NullOr(DevboxState),
  awakeHours: Schema.Number,
  asleepHours: Schema.Number,
  cost: Schema.Number,
});
export type DevboxUsageEntry = typeof DevboxUsageEntry.Type;

export const DevboxUsageResult = Schema.Struct({
  boxes: Schema.Array(DevboxUsageEntry),
  /** Dollars per hour a running box costs: instance, disk and public IP. */
  awakeRate: Schema.Number,
  /** Dollars per hour a stopped box costs: its disk. */
  asleepRate: Schema.Number,
});
export type DevboxUsageResult = typeof DevboxUsageResult.Type;
