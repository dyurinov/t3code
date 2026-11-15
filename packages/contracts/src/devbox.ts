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

export const DevboxPendingLogin = Schema.Struct({
  provider: Schema.Literals(["claude", "codex"]),
  /** Where the user approves the sign-in. */
  url: Schema.String,
});
export type DevboxPendingLogin = typeof DevboxPendingLogin.Type;

export const DevboxSubmitLoginCodeInput = Schema.Struct({
  provider: Schema.Literals(["claude", "codex"]),
  code: TrimmedNonEmptyString,
});
export type DevboxSubmitLoginCodeInput = typeof DevboxSubmitLoginCodeInput.Type;

export const DevboxListResult = Schema.Struct({
  devboxes: Schema.Array(DevboxSummary),
  /** Sign-ins for new devboxes that wait for the user's approval. */
  pendingLogins: Schema.Array(DevboxPendingLogin),
  /** Providers a devbox has no sign-in for; `devboxes.startLogin` starts one. */
  missingLogins: Schema.Array(Schema.Literals(["claude", "codex"])),
});

export const DevboxStartLoginInput = Schema.Struct({
  provider: Schema.Literals(["claude", "codex"]),
});
export type DevboxStartLoginInput = typeof DevboxStartLoginInput.Type;
export const DevboxStartLoginResult = Schema.Struct({ url: Schema.String });
export type DevboxStartLoginResult = typeof DevboxStartLoginResult.Type;
export type DevboxListResult = typeof DevboxListResult.Type;

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
