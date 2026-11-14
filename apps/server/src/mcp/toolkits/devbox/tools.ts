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
    "Create a Coder devbox for one task and link it as an environment. Returns at once in state `creating`; it takes 3–40 minutes. Then call `devbox_wait`. One box per task; no worktrees on boxes.",
  parameters: DevboxCreateInput,
  success: DevboxSummary,
})
  .annotate(Tool.Title, "Create a devbox")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const DevboxWaitTool = Tool.make("devbox_wait", {
  ...shared,
  description:
    "Wait up to `seconds` (default 240) for a devbox to finish creating or waking. Returns its summary; `running` with an `environmentId` is ready. Call again while it is still `creating`.",
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
    "Start a stopped devbox and reconnect it (about 2 minutes). Needed before working on a box that went to sleep.",
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
    "Delete a devbox, its environment link and its logins. Its threads and any unpushed work are lost; push first. Refuses while a turn runs unless `force`.",
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
