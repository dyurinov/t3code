import {
  DevboxCreateInput,
  DevboxDeleteInput,
  DevboxDeleteResult,
  DevboxListResult,
  DevboxNameInput,
  DevboxSummary,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as DevboxService from "../../../devbox/DevboxService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    DevboxService.DevboxService,
  ],
};

const DevboxListTool = Tool.make("devbox_list", {
  ...shared,
  description:
    "List the user's Coder devboxes: state, linked `environmentId`, and logins. A linked running box takes `environmentId` in other tools, such as `delegate_task`'s `target.environmentId`.",
  success: DevboxListResult,
})
  .annotate(Tool.Title, "List devboxes")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const DevboxCreateTool = Tool.make("devbox_create", {
  ...shared,
  description:
    "Get a Coder devbox for one task: claims a prepared spare and starts its replacement, or creates a box if none fits. Use this, not a devbox CLI or `coder create`: only boxes made here link to T3. Returns at once; call devbox_wait. If loginRequired is set or both credentials are no-login, tell the user the task is waiting and show [Sign in for devboxes](/settings/devboxes) in chat. Keep waiting with devbox_wait until a login is installed. Open Settings only when the user clicks the link. One box per task; no worktrees on boxes.",
  parameters: DevboxCreateInput,
  success: DevboxSummary,
})
  .annotate(Tool.Title, "Create a devbox")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const DevboxWaitTool = Tool.make("devbox_wait", {
  ...shared,
  description:
    "Wait up to `seconds` (default 240) for a devbox to finish setup and receive an agent login. Ready means running with an environmentId and an installed credential. If loginRequired is set, show [Sign in for devboxes](/settings/devboxes) in chat and tell the user the task is waiting; keep calling this tool until a login is installed. Do not open Settings or a login browser automatically. When credentials are only `unbound` or `no-login`, with one `unbound`, the box lacks Formal for a sealed token: tell the user to sign in to Formal on the box rather than waiting. Report lastError instead of retrying failed setup indefinitely.",
  parameters: Schema.Struct({
    ...DevboxNameInput.fields,
    seconds: Schema.optionalKey(Schema.Number.annotate({ description: "At most 280." })),
  }),
  success: DevboxSummary,
})
  .annotate(Tool.Title, "Wait for a devbox")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const DevboxWakeTool = Tool.make("devbox_wake", {
  ...shared,
  description:
    "Wake a sleeping devbox or retry setup on an existing one, preserving its files and threads. Returns at once in state `starting`; then call `devbox_wait`.",
  parameters: DevboxNameInput,
  success: DevboxSummary,
})
  .annotate(Tool.Title, "Wake a devbox")
  .annotate(Tool.Destructive, false);

const DevboxStopTool = Tool.make("devbox_stop", {
  ...shared,
  description: "Stop a devbox now. Its files and threads stay; running turns end.",
  parameters: DevboxNameInput,
  success: DevboxSummary,
})
  .annotate(Tool.Title, "Stop a devbox")
  .annotate(Tool.Destructive, true);

const DevboxDeleteTool = Tool.make("devbox_delete", {
  ...shared,
  description:
    "Delete a devbox and its environment link. Its threads and any unpushed work are lost; push first. Refuses while a turn runs unless `force`.",
  parameters: DevboxDeleteInput,
  success: DevboxDeleteResult,
})
  .annotate(Tool.Title, "Delete a devbox")
  .annotate(Tool.Destructive, true);

export const DevboxToolkit = Toolkit.make(
  DevboxListTool,
  DevboxCreateTool,
  DevboxWaitTool,
  DevboxWakeTool,
  DevboxStopTool,
  DevboxDeleteTool,
);
