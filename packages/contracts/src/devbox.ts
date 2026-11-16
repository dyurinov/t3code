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

export const DevboxCredentialState = Schema.Literals(["installed", "pool-empty", "not-installed"]);
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
    "storage",
  ]),
  message: Schema.String,
}) {}

export const DevboxCreateInput = Schema.Struct({
  task: Schema.optionalKey(
    TrimmedNonEmptyString.annotate({
      description: "What the box is for. Names the box when `name` is omitted.",
    }),
  ),
  name: Schema.optionalKey(
    TrimmedNonEmptyString.annotate({
      description:
        "Box name; lowercase letters, digits and hyphens. Derived from `task` if omitted.",
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
      description: "Delete even with a running turn. Unpushed work on the box is lost.",
    }),
  ),
});
export type DevboxDeleteInput = typeof DevboxDeleteInput.Type;

export const DevboxLoginProvider = Schema.Literals(["claude", "codex"]);
export type DevboxLoginProvider = typeof DevboxLoginProvider.Type;

/** One provider's pool of pre-made sign-ins: each new devbox takes one. */
export const DevboxLoginPool = Schema.Struct({
  provider: DevboxLoginProvider,
  /** Signed in and waiting for a box. */
  free: Schema.Number,
  /** Handed to boxes that still exist. */
  inUse: Schema.Number,
  /** Sign-ins asked for and not yet started; they run one at a time. */
  queued: Schema.Number,
  /** Where the user approves the sign-in running now, once its CLI printed the link. */
  pendingUrl: Schema.NullOr(Schema.String),
  /** Why the last sign-in failed; cleared by the next request. */
  lastError: Schema.NullOr(Schema.String),
});
export type DevboxLoginPool = typeof DevboxLoginPool.Type;

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
  pools: Schema.Array(DevboxLoginPool),
  deleted: Schema.Array(DeletedDevbox),
});
export type DevboxListResult = typeof DevboxListResult.Type;

export const DevboxStartLoginInput = Schema.Struct({
  provider: DevboxLoginProvider,
  /** How many sign-ins to add to the pool; they run one after another. */
  count: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(20)),
  ),
});
export type DevboxStartLoginInput = typeof DevboxStartLoginInput.Type;

export const DevboxCancelLoginsInput = Schema.Struct({ provider: DevboxLoginProvider });
export type DevboxCancelLoginsInput = typeof DevboxCancelLoginsInput.Type;

export const DevboxDeleteResult = Schema.Struct({ name: Schema.String, deleted: Schema.Boolean });
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
