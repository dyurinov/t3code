// @effect-diagnostics nodeBuiltinImport:off - gzip decompression, SHA-256 digest, atomic hardlink publish, and UUID generation for devbox thread migration.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeZlib from "node:zlib";

import {
  DevboxError,
  EventId,
  OrchestrationV2AppThreadJson,
  OrchestrationV2ContextHandoffJson,
  OrchestrationV2ContextTransferJson,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2ExecutionNodeJson,
  OrchestrationV2PlanArtifact,
  OrchestrationV2RunAttemptJson,
  OrchestrationV2RunJson,
  OrchestrationV2SubagentJson,
  OrchestrationV2TurnItemJson,
  ProjectId,
  RunId,
  ThreadId,
  type ChatAttachment,
  type OrchestrationV2AppThread,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  attachmentCandidateRelativePaths,
  attachmentRelativePath,
  threadHtmlRenderAttachmentIds,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as EventSinkV2 from "../orchestration-v2/EventSink.ts";
import * as ProjectStoreV2 from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { EXPORT_ATTACHMENTS_SCRIPT, EXPORT_THREADS_SCRIPT } from "./devboxScripts.ts";

const MAX_ATTACHMENT_FILE_BYTES = 50 * 1024 * 1024;
/** Target raw bytes per attachment SSH batch so base64 NDJSON stays well under gunzip/memory caps. */
const ATTACHMENT_BATCH_TARGET_BYTES = 24 * 1024 * 1024;
/** Allows a single 50 MiB file encoded as base64 NDJSON (~67 MiB) with headroom. */
const MAX_DECOMPRESSED_ATTACHMENT_BATCH_BYTES = 96 * 1024 * 1024;
const MAX_DECOMPRESSED_EXPORT_BYTES = 256 * 1024 * 1024;

export interface DevboxThreadMigrationResult {
  readonly migratedThreads: number;
  readonly skippedThreads: number;
  readonly migratedAttachments: number;
  readonly warning?: string;
}

export interface DevboxExportProject {
  readonly projectId: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly remoteUrl: string | null;
}

interface RemoteAttachmentMeta {
  readonly size: number;
  readonly sha256: string | null;
}

const DevboxExportPayloadSchema = Schema.Struct({
  missing: Schema.Boolean,
  schemaMissing: Schema.optionalKey(Schema.Boolean),
  projects: Schema.Array(
    Schema.Struct({
      projectId: Schema.String,
      title: Schema.String,
      workspaceRoot: Schema.String,
      remoteUrl: Schema.NullOr(Schema.String),
    }),
  ),
  threads: Schema.Array(
    Schema.Struct({
      thread: Schema.String,
      forkRunIdsJson: Schema.optionalKey(Schema.NullOr(Schema.String)),
      runs: Schema.Array(Schema.String),
      attempts: Schema.Array(Schema.String),
      nodes: Schema.Array(Schema.String),
      subagents: Schema.Array(Schema.String),
      messages: Schema.Array(Schema.String),
      plans: Schema.Array(Schema.String),
      turnItems: Schema.Array(Schema.String),
      contextHandoffs: Schema.Array(Schema.String),
      contextTransfers: Schema.Array(Schema.String),
    }),
  ),
  attachmentFiles: Schema.Record(
    Schema.String,
    Schema.Struct({
      size: Schema.Number,
      sha256: Schema.NullOr(Schema.String),
    }),
  ),
  invalidAttachmentFiles: Schema.optionalKey(Schema.Array(Schema.String)),
  deletedThreadIds: Schema.optionalKey(Schema.Array(Schema.String)),
  unhydratedLegacyThreadIds: Schema.optionalKey(Schema.Array(Schema.String)),
});

const AttachmentRecordSchema = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    size: Schema.Number,
    sha256: Schema.String,
    b64: Schema.String,
  }),
);

const decodeExportJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DevboxExportPayloadSchema),
);
const encodeFilenameList = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeForkRunIdsJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(RunId)));
const encodeForkRunIdsJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(RunId)));
const decodeAttachmentRecord = Schema.decodeUnknownEffect(AttachmentRecordSchema);
const decodeThreadJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeRunJson = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2RunJson));
const decodeAttemptJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RunAttemptJson),
);
const decodeNodeJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ExecutionNodeJson),
);
const decodeSubagentJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2SubagentJson),
);
const decodeMessageJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJson),
);
const decodePlanJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2PlanArtifact),
);
const decodeTurnItemJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJson),
);
const decodeContextHandoffJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ContextHandoffJson),
);
const decodeContextTransferJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ContextTransferJson),
);

export class DevboxThreadMigration extends Context.Service<
  DevboxThreadMigration,
  {
    readonly migrateFromDevbox: (input: {
      readonly name: string;
      /** True when the devbox was linked/provisioned, so a missing SQLite DB is an error. */
      readonly expectDatabase?: boolean;
      /** When true, fail with reason `busy` if the consistent DB snapshot has any active run. */
      readonly rejectActiveRuns?: boolean;
      readonly runSshBinary: (
        remoteCommand: string,
        options?: { readonly stdin?: string; readonly timeout?: Duration.Input },
      ) => Effect.Effect<Uint8Array, DevboxError>;
    }) => Effect.Effect<DevboxThreadMigrationResult, DevboxError>;
  }
>()("t3/devbox/DevboxThreadMigration") {}

const isDevboxError = Schema.is(DevboxError);

function migrationError(message: string): DevboxError {
  return new DevboxError({ reason: "migration", message });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function isSafeAttachmentFilename(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0")
  );
}

function canonicalKeyFromRemoteUrl(remoteUrl: string | null | undefined): string | null {
  const trimmed = remoteUrl?.trim();
  if (!trimmed) return null;
  return sourceControlDefinitions.repositoryKeyFromRemote(trimmed) || null;
}

function isDevboxScratchProject(project: DevboxExportProject): boolean {
  const normalizedRoot = project.workspaceRoot.replace(/\\/gu, "/").replace(/\/+$/u, "");
  return normalizedRoot.endsWith("/.t3/scratch") || project.title === "No project";
}

function gunzipBounded(
  bytes: Uint8Array,
  maxOutputLength: number,
): Effect.Effect<string, DevboxError> {
  return Effect.try({
    try: () => NodeZlib.gunzipSync(bytes, { maxOutputLength }).toString("utf8"),
    catch: (error) => migrationError(`Could not decompress devbox export: ${errorText(error)}`),
  });
}

function isActiveRunStatus(status: OrchestrationV2Run["status"]): boolean {
  return (
    status === "preparing" ||
    status === "queued" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting"
  );
}

function normalizeRun(run: OrchestrationV2Run, now: DateTime.Utc): OrchestrationV2Run {
  const active = isActiveRunStatus(run.status);
  const {
    delegatedCompletion: _delegatedCompletion,
    queuePosition: _queuePosition,
    queueHeld: _queueHeld,
    explicitQueue: _explicitQueue,
    steerWhenReadyRunId: _steerWhenReadyRunId,
    ...rest
  } = run;
  return {
    ...rest,
    providerThreadId: null,
    checkpointId: null,
    status: active ? "interrupted" : run.status,
    completedAt: active ? (run.completedAt ?? now) : run.completedAt,
  };
}

function normalizeAttempt(
  attempt: OrchestrationV2RunAttempt,
  now: DateTime.Utc,
): OrchestrationV2RunAttempt {
  const active = attempt.status === "pending" || attempt.status === "running";
  return {
    ...attempt,
    status: active ? "interrupted" : attempt.status,
    completedAt: active ? (attempt.completedAt ?? now) : attempt.completedAt,
  };
}

function normalizeNode(
  node: OrchestrationV2ExecutionNode,
  now: DateTime.Utc,
): OrchestrationV2ExecutionNode {
  const active =
    node.status === "pending" || node.status === "running" || node.status === "waiting";
  return {
    ...node,
    status: active ? "interrupted" : node.status,
    completedAt: active ? (node.completedAt ?? now) : node.completedAt,
  };
}

function normalizeSubagent(
  subagent: OrchestrationV2Subagent,
  now: DateTime.Utc,
): OrchestrationV2Subagent {
  const active =
    subagent.status === "pending" || subagent.status === "running" || subagent.status === "waiting";
  const remoteChild =
    subagent.remoteChild === undefined
      ? undefined
      : { ...subagent.remoteChild, stoppedThere: true };
  // Keep terminal delivery state or mark disposed so neither RemoteDelegation nor
  // ProviderRuntimeRecoveryService / finalizeAppOwnedSubagentTask auto-wakes settled parents.
  const completionDelivery =
    subagent.origin === "app_owned"
      ? subagent.completionDelivery !== undefined &&
        (subagent.completionDelivery.state === "acknowledged" ||
          subagent.completionDelivery.state === "delivered" ||
          subagent.completionDelivery.state === "disposed")
        ? subagent.completionDelivery
        : { state: "disposed" as const, observedByRunId: null }
      : subagent.completionDelivery;
  const result =
    subagent.origin === "app_owned"
      ? (subagent.result ?? "Interrupted when devbox was deleted.")
      : subagent.result;
  return {
    ...subagent,
    ...(remoteChild === undefined ? {} : { remoteChild }),
    ...(completionDelivery === undefined ? {} : { completionDelivery }),
    result,
    status: active ? "interrupted" : subagent.status,
    completedAt: active ? (subagent.completedAt ?? now) : subagent.completedAt,
  };
}

function normalizeMessage(
  message: OrchestrationV2ConversationMessage,
): OrchestrationV2ConversationMessage {
  return message.streaming ? { ...message, streaming: false } : message;
}

function normalizeTurnItem(
  item: OrchestrationV2TurnItem,
  now: DateTime.Utc,
): OrchestrationV2TurnItem {
  const active =
    item.status === "pending" || item.status === "running" || item.status === "waiting";
  const withStatus = active
    ? { ...item, status: "interrupted" as const, completedAt: item.completedAt ?? now }
    : item;
  if ("streaming" in withStatus && withStatus.streaming) {
    return { ...withStatus, streaming: false };
  }
  return withStatus;
}

function normalizeContextHandoff(
  handoff: OrchestrationV2ContextHandoff,
  now: DateTime.Utc,
): OrchestrationV2ContextHandoff {
  return handoff.status === "pending"
    ? { ...handoff, status: "superseded", updatedAt: now }
    : handoff;
}

function normalizeContextTransfer(
  transfer: OrchestrationV2ContextTransfer,
  now: DateTime.Utc,
): OrchestrationV2ContextTransfer {
  return transfer.status === "pending"
    ? { ...transfer, status: "superseded", updatedAt: now }
    : transfer;
}

function normalizeThread(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly projectId: ProjectId;
  readonly liveParentThreadIds: ReadonlySet<ThreadId>;
  readonly liveParentRoots: ReadonlyMap<ThreadId, ThreadId>;
  readonly knownForkThreadIds: ReadonlySet<ThreadId>;
  readonly existingLocal?: OrchestrationV2AppThread;
}): OrchestrationV2AppThread {
  const {
    thread,
    projectId,
    liveParentThreadIds,
    liveParentRoots,
    knownForkThreadIds,
    existingLocal,
  } = input;
  const hasParent =
    thread.lineage.parentThreadId !== null &&
    liveParentThreadIds.has(thread.lineage.parentThreadId);
  const isDetachedSideChat = thread.lineage.sideChat === true && !hasParent;
  const forkedFrom =
    thread.forkedFrom === null
      ? null
      : thread.forkedFrom.type === "provider_thread"
        ? null
        : isDetachedSideChat
          ? null
          : thread.forkedFrom.type === "run"
            ? knownForkThreadIds.has(thread.forkedFrom.threadId)
              ? {
                  type: "run" as const,
                  threadId: thread.forkedFrom.threadId,
                  runId: thread.forkedFrom.runId,
                }
              : null
            : thread.forkedFrom.type === "node" && !hasParent
              ? null
              : thread.forkedFrom;
  const pullRequests = thread.pullRequests?.map((pr) => {
    const { watch, ...rest } = pr;
    return watch === undefined ? pr : { ...rest, endedWatch: pr.endedWatch ?? watch };
  });
  const {
    delegatedFrom: _delegatedFrom,
    workflowRun: _workflowRun,
    activeOrderKey: _activeOrderKey,
    tags: _devboxTags,
    ...restThread
  } = thread;
  const isDeletedAncestor = thread.deletedAt !== null;
  return {
    ...restThread,
    projectId,
    // Preserve local user customizations when updating a previously imported thread on retry.
    ...(existingLocal === undefined
      ? {
          ...(thread.tags === undefined ? {} : { tags: thread.tags }),
          pinnedAt: null,
          pinOrderKey: null,
          snoozedUntil: null,
          snoozedAt: null,
        }
      : {
          title: existingLocal.title,
          pinnedAt: existingLocal.pinnedAt ?? null,
          pinOrderKey: existingLocal.pinOrderKey ?? null,
          snoozedUntil: existingLocal.snoozedUntil ?? null,
          snoozedAt: existingLocal.snoozedAt ?? null,
          ...(existingLocal.tags === undefined ? {} : { tags: existingLocal.tags }),
        }),
    worktreePath: null,
    activeProviderThreadId: null,
    guestShare: null,
    titleRegeneration: null,
    limitRecovery: null,
    settledOverride:
      isDeletedAncestor || thread.archivedAt !== null ? thread.settledOverride : "settled",
    // Keep chronological settled order so old devbox threads do not crowd recent local settled work.
    settledAt:
      isDeletedAncestor || thread.archivedAt !== null
        ? thread.settledAt
        : (thread.settledAt ?? thread.updatedAt),
    ...(thread.linkedPullRequest === undefined
      ? {}
      : {
          linkedPullRequest:
            thread.linkedPullRequest === null ? null : { ...thread.linkedPullRequest, projectId },
        }),
    ...(thread.branchPullRequest === undefined
      ? {}
      : {
          branchPullRequest:
            thread.branchPullRequest === null ? null : { ...thread.branchPullRequest, projectId },
        }),
    ...(pullRequests === undefined ? {} : { pullRequests }),
    forkedFrom,
    lineage:
      hasParent && thread.lineage.parentThreadId !== null
        ? {
            ...thread.lineage,
            rootThreadId:
              liveParentRoots.get(thread.lineage.parentThreadId) ?? thread.lineage.rootThreadId,
          }
        : {
            parentThreadId: null,
            rootThreadId: thread.id,
            relationshipToParent: null,
            ...(thread.lineage.sideChat === true ? { sideChat: true } : {}),
          },
  };
}

interface DecodedThreadBundle {
  readonly thread: OrchestrationV2AppThread;
  readonly forkRunIdsJson: string | null;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly attempts: ReadonlyArray<OrchestrationV2RunAttempt>;
  readonly nodes: ReadonlyArray<OrchestrationV2ExecutionNode>;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly plans: ReadonlyArray<OrchestrationV2PlanArtifact>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly contextHandoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
  readonly contextTransfers: ReadonlyArray<OrchestrationV2ContextTransfer>;
}

/** Orders parent and fork-source threads ahead of children so lineage & fork references resolve. */
function orderThreadsTopologically(
  bundles: ReadonlyArray<DecodedThreadBundle>,
): ReadonlyArray<DecodedThreadBundle> {
  const byId = new Map(bundles.map((bundle) => [bundle.thread.id, bundle]));
  const visited = new Set<ThreadId>();
  const visiting = new Set<ThreadId>();
  const ordered: Array<DecodedThreadBundle> = [];

  const visit = (bundle: DecodedThreadBundle) => {
    const id = bundle.thread.id;
    if (visited.has(id) || visiting.has(id)) return;
    visiting.add(id);
    const dependencies: Array<ThreadId> = [];
    if (bundle.thread.lineage.parentThreadId !== null) {
      dependencies.push(bundle.thread.lineage.parentThreadId);
    }
    if (bundle.thread.forkedFrom?.type === "run") {
      dependencies.push(bundle.thread.forkedFrom.threadId);
    }
    for (const depId of dependencies) {
      const dep = byId.get(depId);
      if (dep !== undefined) visit(dep);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(bundle);
  };

  for (const bundle of bundles) visit(bundle);
  return ordered;
}

interface RequiredAttachment {
  readonly size: number;
  readonly sha256: string;
}

interface AttachmentManifest {
  /** Required regular filenames that must exist locally with their exact byte size and SHA-256. */
  readonly required: ReadonlyMap<string, RequiredAttachment>;
  /** Attachment IDs referenced by required files (used to guard against queued attachment.cleanup). */
  readonly requiredIds: ReadonlySet<string>;
  /** Problems found while resolving references against the devbox attachment directory. */
  readonly errors: ReadonlyArray<string>;
}

/**
 * Computes which run IDs on each deleted ancestor thread are still retained by a live run-fork.
 * Attachments from post-fork runs of a deleted thread were intentionally purged by ThreadDeletion.
 */
function retainedRunIdsForDeletedAncestors(
  bundles: ReadonlyArray<DecodedThreadBundle>,
): ReadonlyMap<ThreadId, ReadonlySet<RunId>> {
  const byId = new Map(bundles.map((bundle) => [bundle.thread.id, bundle]));
  const retained = new Map<ThreadId, Set<RunId>>();

  const addRetained = (ancestorId: ThreadId, runIds: Iterable<RunId>) => {
    let set = retained.get(ancestorId);
    if (set === undefined) {
      set = new Set<RunId>();
      retained.set(ancestorId, set);
    }
    for (const id of runIds) set.add(id);
  };

  for (const bundle of bundles) {
    if (bundle.thread.lineage.sideChat === true) continue;
    const forkedFrom = bundle.thread.forkedFrom;
    if (forkedFrom?.type !== "run") continue;
    const ancestorId = forkedFrom.threadId;
    const ancestor = byId.get(ancestorId);
    if (ancestor === undefined || ancestor.thread.deletedAt === null) continue;
    if (bundle.forkRunIdsJson !== null) {
      try {
        const parsed = JSON.parse(bundle.forkRunIdsJson) as ReadonlyArray<RunId>;
        addRetained(ancestorId, parsed);
        continue;
      } catch {
        // Fallback to ordinal cutoff below.
      }
    }
    const cutoffRun = ancestor.runs.find((run) => run.id === forkedFrom.runId);
    if (cutoffRun !== undefined) {
      addRetained(
        ancestorId,
        ancestor.runs
          .filter((run) => run.ordinal <= cutoffRun.ordinal && run.status !== "rolled_back")
          .map((run) => run.id),
      );
    }
  }
  return retained;
}

function collectAttachmentManifest(
  bundles: ReadonlyArray<DecodedThreadBundle>,
  availableFiles: Readonly<Record<string, RemoteAttachmentMeta>>,
  invalidFiles: ReadonlyArray<string>,
): AttachmentManifest {
  const invalidSet = new Set(invalidFiles);
  const retainedAncestorRuns = retainedRunIdsForDeletedAncestors(bundles);
  const required = new Map<string, RequiredAttachment>();
  const requiredIds = new Set<string>();
  const errors: Array<string> = [];
  const seenErrors = new Set<string>();

  const recordError = (message: string) => {
    if (seenErrors.has(message)) return;
    seenErrors.add(message);
    errors.push(message);
  };

  const requireFilename = (
    filename: string,
    threadId: ThreadId,
    options: { readonly isSidecar?: boolean; readonly allowMissing?: boolean } = {},
  ) => {
    const isSidecar = options.isSidecar === true;
    const allowMissing = options.allowMissing === true;
    if (!isSafeAttachmentFilename(filename)) {
      recordError(`Unsafe attachment filename "${filename}" referenced by thread ${threadId}.`);
      return;
    }
    if (invalidSet.has(filename)) {
      recordError(
        `Refusing non-regular attachment "${filename}" referenced by thread ${threadId}.`,
      );
      return;
    }
    const meta = availableFiles[filename];
    if (meta === undefined) {
      if (!isSidecar && !allowMissing) {
        recordError(
          `Attachment "${filename}" referenced by thread ${threadId} is missing on devbox.`,
        );
      }
      return;
    }
    if (meta.size < 0) {
      recordError(
        `Attachment "${filename}" referenced by thread ${threadId} is unreadable on devbox.`,
      );
      return;
    }
    if (meta.size > MAX_ATTACHMENT_FILE_BYTES || meta.sha256 === null) {
      recordError(
        `Attachment "${filename}" (${meta.size} bytes) exceeds the ${MAX_ATTACHMENT_FILE_BYTES}-byte limit.`,
      );
      return;
    }
    required.set(filename, { size: meta.size, sha256: meta.sha256 });
    if (!isSidecar) {
      const sidecar = `${filename}.txt`;
      if (invalidSet.has(sidecar) || availableFiles[sidecar] !== undefined) {
        requireFilename(sidecar, threadId, { isSidecar: true, allowMissing });
      }
    }
  };

  const addAttachment = (attachment: ChatAttachment, threadId: ThreadId, allowMissing: boolean) => {
    const relative = attachmentRelativePath(attachment);
    if (relative !== null) {
      requireFilename(relative, threadId, { allowMissing });
      if (!allowMissing || required.has(relative)) requiredIds.add(attachment.id);
    }
  };

  for (const bundle of bundles) {
    const threadId = bundle.thread.id;
    const isDeletedAncestor = bundle.thread.deletedAt !== null;
    const retainedRuns = isDeletedAncestor ? retainedAncestorRuns.get(threadId) : undefined;
    // Live forks still display runless V1-imported rows on a deleted ancestor (ProjectionStore.ts),
    // so only post-fork or non-V1 runless rows on deleted ancestors may be missing attachments.
    const isOptionalDeletedRun = (runId: RunId | null) =>
      isDeletedAncestor &&
      (runId === null
        ? bundle.thread.historyOrigin !== "v1_import"
        : retainedRuns === undefined || !retainedRuns.has(runId));

    for (const message of bundle.messages) {
      const allowMissing = isOptionalDeletedRun(message.runId);
      for (const attachment of message.attachments)
        addAttachment(attachment, threadId, allowMissing);
    }
    const requiredToolItems: Array<{
      readonly toolName: string | null | undefined;
      readonly output?: unknown;
    }> = [];
    const optionalToolItems: Array<{
      readonly toolName: string | null | undefined;
      readonly output?: unknown;
    }> = [];
    for (const item of bundle.turnItems) {
      const allowMissing = isOptionalDeletedRun(item.runId);
      if (item.type === "user_message") {
        for (const attachment of item.attachments)
          addAttachment(attachment, threadId, allowMissing);
      } else if (item.type === "assistant_message" && item.attachments !== undefined) {
        for (const attachment of item.attachments)
          addAttachment(attachment, threadId, allowMissing);
      } else if (item.type === "user_input_request") {
        const byQuestion = item.questionAnswer?.attachmentsByQuestionId;
        if (byQuestion !== undefined) {
          for (const attachments of Object.values(byQuestion)) {
            for (const attachment of attachments) addAttachment(attachment, threadId, allowMissing);
          }
        }
      } else if (item.type === "dynamic_tool") {
        (allowMissing ? optionalToolItems : requiredToolItems).push({
          toolName: item.toolName,
          output: item.output,
        });
      }
    }
    for (const [items, allowMissing] of [
      [requiredToolItems, false] as const,
      [optionalToolItems, true] as const,
    ]) {
      const htmlAttachmentIds = threadHtmlRenderAttachmentIds(threadId, items);
      for (const attachmentId of htmlAttachmentIds) {
        // Match only the exact candidate filenames resolveAttachmentPathById accepts (not .part or .txt).
        const candidates = attachmentCandidateRelativePaths(attachmentId);
        const matched = candidates.filter((file) => availableFiles[file] !== undefined);
        const matchedInvalid = candidates.filter((file) => invalidSet.has(file));
        for (const invalid of matchedInvalid) {
          recordError(
            `Refusing non-regular attachment "${invalid}" referenced by thread ${threadId}.`,
          );
        }
        if (matched.length === 0 && matchedInvalid.length === 0 && !allowMissing) {
          recordError(
            `Tool output attachment "${attachmentId}" referenced by thread ${threadId} is missing on devbox.`,
          );
        }
        for (const file of matched) requireFilename(file, threadId, { allowMissing });
        if (!allowMissing || matched.some((file) => required.has(file))) {
          requiredIds.add(attachmentId);
        }
      }
    }
  }

  return { required, requiredIds, errors };
}

function batchAttachmentsBySize(
  entries: ReadonlyArray<readonly [string, RequiredAttachment]>,
): ReadonlyArray<ReadonlyArray<string>> {
  const batches: Array<Array<string>> = [];
  let current: Array<string> = [];
  let currentBytes = 0;
  for (const [name, meta] of entries) {
    if (current.length > 0 && currentBytes + meta.size > ATTACHMENT_BATCH_TARGET_BYTES) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(name);
    currentBytes += meta.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function makeEventId(): EventId {
  return EventId.make(NodeCrypto.randomUUID());
}

function parseForkRunIds(json: string | null): ReadonlyArray<RunId> | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) return null;
    return parsed.map((item) => RunId.make(item));
  } catch {
    return null;
  }
}

function forkRunIdsEqual(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  const parsedA = parseForkRunIds(a);
  const parsedB = parseForkRunIds(b);
  if (parsedA === null || parsedB === null) return false;
  if (parsedA.length !== parsedB.length) return false;
  const sortedA = [...parsedA].toSorted();
  const sortedB = [...parsedB].toSorted();
  return sortedA.every((id, index) => id === sortedB[index]);
}

function stripForkRunIds(
  forkedFrom: OrchestrationV2AppThread["forkedFrom"],
): OrchestrationV2AppThread["forkedFrom"] {
  if (forkedFrom?.type !== "run") return forkedFrom;
  return { type: "run", threadId: forkedFrom.threadId, runId: forkedFrom.runId };
}

function buildImportEvents(
  bundle: DecodedThreadBundle,
  thread: OrchestrationV2AppThread,
  now: DateTime.Utc,
  mode: "create" | "update",
  repairForkRunIds = false,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const threadId = thread.id;
  const isDeletedAncestor = thread.deletedAt !== null;
  const baseCreatePayload = isDeletedAncestor ? { ...thread, deletedAt: null } : thread;
  const parsedForkRunIds = parseForkRunIds(bundle.forkRunIdsJson);
  const attachForkRunIds = (target: OrchestrationV2AppThread): OrchestrationV2AppThread =>
    target.forkedFrom?.type === "run" && parsedForkRunIds !== null
      ? {
          ...target,
          forkedFrom: { ...target.forkedFrom, forkRunIds: parsedForkRunIds },
        }
      : target;
  // Carry exact forkRunIds on `thread.created` (or on the trailing `thread.metadata-updated`
  // when repairing an existing copy) so ProjectionStore records and replays the exact fork
  // membership natively across interleaved sibling forks and parent rewinds.
  const createPayload = mode === "create" ? attachForkRunIds(baseCreatePayload) : baseCreatePayload;
  const events: Array<OrchestrationV2DomainEvent> = [
    mode === "create"
      ? {
          id: makeEventId(),
          threadId,
          occurredAt: thread.createdAt,
          type: "thread.created",
          payload: createPayload,
        }
      : {
          id: makeEventId(),
          threadId,
          occurredAt: thread.updatedAt,
          type: "thread.metadata-updated",
          payload: createPayload,
        },
  ];

  for (const run of bundle.runs) {
    const normalized = normalizeRun(run, now);
    events.push({
      id: makeEventId(),
      threadId,
      runId: normalized.id,
      occurredAt: normalized.requestedAt,
      type: "run.created",
      payload: normalized,
    });
  }

  for (const attempt of bundle.attempts) {
    const normalized = normalizeAttempt(attempt, now);
    events.push({
      id: makeEventId(),
      threadId,
      runId: normalized.runId,
      providerInstanceId: normalized.providerInstanceId,
      occurredAt: normalized.startedAt ?? thread.updatedAt,
      type: "run-attempt.created",
      payload: normalized,
    });
  }

  for (const node of bundle.nodes) {
    const normalized = normalizeNode(node, now);
    events.push({
      id: makeEventId(),
      threadId,
      ...(normalized.runId === null ? {} : { runId: normalized.runId }),
      nodeId: normalized.id,
      occurredAt: normalized.startedAt ?? thread.updatedAt,
      type: "node.updated",
      payload: normalized,
    });
  }

  for (const subagent of bundle.subagents) {
    const normalized = normalizeSubagent(subagent, now);
    events.push({
      id: makeEventId(),
      threadId,
      ...(normalized.runId === null ? {} : { runId: normalized.runId }),
      nodeId: normalized.id,
      driver: normalized.driver,
      providerInstanceId: normalized.providerInstanceId,
      occurredAt: normalized.updatedAt,
      type: "subagent.updated",
      payload: normalized,
    });
  }

  for (const message of bundle.messages) {
    const normalized = normalizeMessage(message);
    events.push({
      id: makeEventId(),
      threadId,
      ...(normalized.runId === null ? {} : { runId: normalized.runId }),
      ...(normalized.nodeId === null ? {} : { nodeId: normalized.nodeId }),
      occurredAt: normalized.updatedAt,
      type: "message.updated",
      payload: normalized,
    });
  }

  for (const plan of bundle.plans) {
    events.push({
      id: makeEventId(),
      threadId,
      ...(plan.runId === null ? {} : { runId: plan.runId }),
      nodeId: plan.nodeId,
      occurredAt: thread.updatedAt,
      type: "plan.updated",
      payload: plan,
    });
  }

  for (const item of bundle.turnItems) {
    const normalized = normalizeTurnItem(item, now);
    events.push({
      id: makeEventId(),
      threadId,
      ...(normalized.runId === null ? {} : { runId: normalized.runId }),
      ...(normalized.nodeId === null ? {} : { nodeId: normalized.nodeId }),
      occurredAt: normalized.updatedAt,
      type: "turn-item.updated",
      payload: normalized,
    });
  }

  for (const handoff of bundle.contextHandoffs) {
    const normalized = normalizeContextHandoff(handoff, now);
    events.push({
      id: makeEventId(),
      threadId,
      occurredAt: normalized.updatedAt,
      type: "context-handoff.updated",
      payload: normalized,
    });
  }

  for (const transfer of bundle.contextTransfers) {
    const normalized = normalizeContextTransfer(transfer, now);
    events.push({
      id: makeEventId(),
      threadId,
      occurredAt: normalized.createdAt,
      type: "context-transfer.created",
      payload: normalized,
    });
  }

  // Restore exact thread updatedAt (or deleted tombstone state for deleted run-fork ancestors)
  // after child events, which bump threadTouches via occurredAt. When repairing fork membership
  // on an existing thread, attach forkRunIds to the trailing event so replay preserves the repair.
  const trailingThread = mode === "update" && repairForkRunIds ? attachForkRunIds(thread) : thread;
  events.push(
    isDeletedAncestor
      ? {
          id: makeEventId(),
          threadId,
          occurredAt: thread.deletedAt ?? thread.updatedAt,
          type: "thread.deleted",
          payload: trailingThread,
        }
      : {
          id: makeEventId(),
          threadId,
          occurredAt: thread.updatedAt,
          type: "thread.metadata-updated",
          payload: trailingThread,
        },
  );

  return events;
}

const decodeListStrict = <A>(
  items: ReadonlyArray<string>,
  decode: (input: string) => Effect.Effect<A, Schema.SchemaError>,
  label: string,
  threadId: string,
  devboxName: string,
) =>
  Effect.forEach(items, (raw) =>
    decode(raw).pipe(
      Effect.mapError((error) =>
        migrationError(
          `Could not decode ${label} in thread ${threadId} from ${devboxName}: ${errorText(error)}`,
        ),
      ),
    ),
  );

function fileSha256Sync(filePath: string): string {
  const hash = NodeCrypto.createHash("sha256");
  const fd = NodeFS.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(65536);
    while (true) {
      const read = NodeFS.readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    NodeFS.closeSync(fd);
  }
  return hash.digest("hex");
}

function checkExistingLocalAttachment(input: {
  readonly targetPath: string;
  readonly filename: string;
  readonly expected: RequiredAttachment;
}): Effect.Effect<"match" | "missing" | { readonly error: string }> {
  return Effect.sync(() => {
    let stat: NodeFS.Stats;
    try {
      stat = NodeFS.lstatSync(input.targetPath);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return "missing" as const;
      }
      return {
        error: `Could not inspect local attachment "${input.filename}": ${errorText(error)}`,
      };
    }
    if (!stat.isFile()) {
      return {
        error: `Local attachment "${input.filename}" exists but is not a regular file (symlink or directory).`,
      };
    }
    if (stat.size !== input.expected.size) {
      return {
        error: `Local attachment "${input.filename}" size mismatch (${String(stat.size)} vs ${String(input.expected.size)} bytes).`,
      };
    }
    try {
      const digest = fileSha256Sync(input.targetPath);
      if (digest !== input.expected.sha256) {
        return {
          error: `Local attachment "${input.filename}" SHA-256 differs from devbox copy.`,
        };
      }
      return "match" as const;
    } catch (error) {
      return {
        error: `Could not hash local attachment "${input.filename}": ${errorText(error)}`,
      };
    }
  });
}

const UNSUPPORTED_DIR_FSYNC_CODES = new Set([
  "EINVAL",
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EROFS",
  "EBADF",
]);

function fsyncDir(dirPath: string): Effect.Effect<void, DevboxError> {
  return Effect.try({
    try: () => {
      let fd: number | undefined;
      try {
        fd = NodeFS.openSync(dirPath, "r");
        NodeFS.fsyncSync(fd);
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { readonly code?: unknown }).code)
            : "";
        if (!UNSUPPORTED_DIR_FSYNC_CODES.has(code)) throw error;
      } finally {
        if (fd !== undefined) {
          try {
            NodeFS.closeSync(fd);
          } catch {
            // Ignore close errors after fsync.
          }
        }
      }
    },
    catch: (error) =>
      migrationError(`Could not fsync attachments directory ${dirPath}: ${errorText(error)}`),
  });
}

/** Atomic no-clobber write: fsyncs temp file before hardlinking so a concurrent writer is never overwritten. */
function writeAttachmentAtomicNoClobber(input: {
  readonly dir: string;
  readonly targetPath: string;
  readonly bytes: Uint8Array;
  readonly expectedSha256: string;
}): Effect.Effect<"written" | "exists", DevboxError> {
  return Effect.try({
    try: () => {
      const tempPath = `${input.dir}/.devbox-migrate-${NodeCrypto.randomUUID()}.tmp`;
      try {
        const fd = NodeFS.openSync(tempPath, "wx", 0o600);
        try {
          NodeFS.writeFileSync(fd, input.bytes);
          NodeFS.fsyncSync(fd);
        } finally {
          NodeFS.closeSync(fd);
        }
        try {
          NodeFS.linkSync(tempPath, input.targetPath);
          return "written" as const;
        } catch (linkError) {
          if (
            typeof linkError === "object" &&
            linkError !== null &&
            "code" in linkError &&
            linkError.code === "EEXIST"
          ) {
            const stat = NodeFS.lstatSync(input.targetPath);
            if (!stat.isFile()) {
              throw new Error(`Existing path ${input.targetPath} is not a regular file.`, {
                cause: linkError,
              });
            }
            const existingDigest = fileSha256Sync(input.targetPath);
            if (existingDigest !== input.expectedSha256) {
              throw new Error(
                `Existing attachment ${input.targetPath} has different contents than devbox copy.`,
                { cause: linkError },
              );
            }
            return "exists" as const;
          }
          throw linkError;
        }
      } finally {
        NodeFS.rmSync(tempPath, { force: true });
      }
    },
    catch: (error) =>
      migrationError(`Could not save attachment ${input.targetPath}: ${errorText(error)}`),
  });
}

function stripRequiredIdsFromCleanupPayload(
  payloadJson: string,
  requiredIds: ReadonlySet<string>,
):
  | { readonly overlaps: false }
  | { readonly overlaps: true; readonly nextPayloadJson: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return { overlaps: false };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("attachmentIds" in parsed) ||
    !Array.isArray((parsed as { readonly attachmentIds?: unknown }).attachmentIds)
  ) {
    return { overlaps: false };
  }
  const record = parsed as Record<string, unknown> & {
    readonly attachmentIds: ReadonlyArray<unknown>;
  };
  const overlaps = record.attachmentIds.some((id) => typeof id === "string" && requiredIds.has(id));
  if (!overlaps) return { overlaps: false };
  const remaining = record.attachmentIds.filter(
    (id) => !(typeof id === "string" && requiredIds.has(id)),
  );
  return {
    overlaps: true,
    nextPayloadJson:
      remaining.length === 0 ? null : JSON.stringify({ ...record, attachmentIds: remaining }),
  };
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (value !== null && typeof value === "object") {
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value as Record<string, unknown>).toSorted()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) {
        sorted[key] = canonicalizeValue(entry);
      }
    }
    return sorted;
  }
  return value;
}

/** Key-order-independent JSON comparison (handles DateTime.Utc and schema re-serialization order). */
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeValue(JSON.parse(JSON.stringify(value))));
}

function compareLocalCopy(input: {
  readonly existing: OrchestrationV2AppThread;
  readonly expectedThread: OrchestrationV2AppThread;
  readonly existingForkRunIdsJson: string | null;
  readonly localRuns: ReadonlyArray<OrchestrationV2Run>;
  readonly localAttempts: ReadonlyArray<OrchestrationV2RunAttempt>;
  readonly localNodes: ReadonlyArray<OrchestrationV2ExecutionNode>;
  readonly localMessages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly localTurnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly localPlans: ReadonlyArray<OrchestrationV2PlanArtifact>;
  readonly localSubagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly localContextHandoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
  readonly localContextTransfers: ReadonlyArray<OrchestrationV2ContextTransfer>;
  readonly bundle: DecodedThreadBundle;
  readonly now: DateTime.Utc;
}): "up_to_date" | "needs_update" | { readonly diverged: string } {
  const {
    existing,
    expectedThread,
    existingForkRunIdsJson,
    localRuns,
    localAttempts,
    localNodes,
    localMessages,
    localTurnItems,
    localPlans,
    localSubagents,
    localContextHandoffs,
    localContextTransfers,
    bundle,
    now,
  } = input;

  // Detect divergent runs: if both host and devbox created a run with the same ordinal/ID
  // for different user messages or request timestamps, or if the host rolled back a shared run,
  // updating from the devbox would clobber local work.
  const localRunById = new Map(localRuns.map((run) => [run.id, run]));
  const bundleRunIds = new Set(bundle.runs.map((run) => run.id));
  for (const run of bundle.runs) {
    const local = localRunById.get(run.id);
    if (local === undefined) continue;
    const expectedStatus = isActiveRunStatus(run.status) ? "interrupted" : run.status;
    if (
      local.userMessageId !== run.userMessageId ||
      DateTime.toEpochMillis(local.requestedAt) !== DateTime.toEpochMillis(run.requestedAt)
    ) {
      return {
        diverged: `Run ${run.id} in thread ${bundle.thread.id} diverged between devbox and this machine; refusing to overwrite local work.`,
      };
    }
    if (local.status === "rolled_back" && expectedStatus !== "rolled_back") {
      return {
        diverged: `Run ${run.id} in thread ${bundle.thread.id} was rewound on this machine; refusing to overwrite local rewind.`,
      };
    }
  }

  let needsUpdate = false;
  if (
    DateTime.toEpochMillis(existing.updatedAt) < DateTime.toEpochMillis(bundle.thread.updatedAt)
  ) {
    needsUpdate = true;
  }
  if (
    bundle.forkRunIdsJson !== null &&
    expectedThread.forkedFrom?.type === "run" &&
    !forkRunIdsEqual(existingForkRunIdsJson, bundle.forkRunIdsJson)
  ) {
    needsUpdate = true;
  }
  if (
    !needsUpdate &&
    (canonicalJson(existing.lineage) !== canonicalJson(expectedThread.lineage) ||
      canonicalJson(stripForkRunIds(existing.forkedFrom)) !==
        canonicalJson(stripForkRunIds(expectedThread.forkedFrom)) ||
      (existing.deletedAt === null) !== (expectedThread.deletedAt === null))
  ) {
    needsUpdate = true;
  }
  if (!needsUpdate) {
    for (const run of bundle.runs) {
      const local = localRunById.get(run.id);
      if (local === undefined) {
        needsUpdate = true;
        break;
      }
      const normalized = normalizeRun(run, now);
      if (
        canonicalJson(local) !== canonicalJson({ ...normalized, completedAt: local.completedAt })
      ) {
        needsUpdate = true;
        break;
      }
    }
  }
  if (!needsUpdate) {
    const localAttemptById = new Map(localAttempts.map((attempt) => [attempt.id, attempt]));
    for (const attempt of bundle.attempts) {
      const local = localAttemptById.get(attempt.id);
      if (local === undefined) {
        needsUpdate = true;
        break;
      }
      const normalized = normalizeAttempt(attempt, now);
      if (
        canonicalJson(local) !== canonicalJson({ ...normalized, completedAt: local.completedAt })
      ) {
        needsUpdate = true;
        break;
      }
    }
  }
  if (!needsUpdate) {
    const localNodeById = new Map(localNodes.map((node) => [node.id, node]));
    for (const node of bundle.nodes) {
      const local = localNodeById.get(node.id);
      if (local === undefined) {
        needsUpdate = true;
        break;
      }
      const normalized = normalizeNode(node, now);
      if (
        canonicalJson(local) !== canonicalJson({ ...normalized, completedAt: local.completedAt })
      ) {
        needsUpdate = true;
        break;
      }
    }
  }
  if (!needsUpdate) {
    const localMsgById = new Map(localMessages.map((message) => [message.id, message]));
    for (const message of bundle.messages) {
      const local = localMsgById.get(message.id);
      if (
        local === undefined ||
        canonicalJson(local) !== canonicalJson(normalizeMessage(message))
      ) {
        needsUpdate = true;
        break;
      }
    }
  }
  if (!needsUpdate) {
    const localItemById = new Map(localTurnItems.map((item) => [item.id, item]));
    for (const item of bundle.turnItems) {
      const local = localItemById.get(item.id);
      if (local === undefined) {
        needsUpdate = true;
        break;
      }
      const normalized = normalizeTurnItem(item, now);
      // EventSink normalizes turn item ordinals via TurnItemPositionStore, so compare ignoring ordinal.
      if (
        canonicalJson(local) !==
        canonicalJson({
          ...normalized,
          ordinal: local.ordinal,
          completedAt: local.completedAt,
        })
      ) {
        needsUpdate = true;
        break;
      }
    }
  }
  if (!needsUpdate) {
    const localPlanById = new Map(localPlans.map((plan) => [plan.id, plan]));
    for (const plan of bundle.plans) {
      const local = localPlanById.get(plan.id);
      if (local === undefined || canonicalJson(local) !== canonicalJson(plan)) {
        needsUpdate = true;
        break;
      }
    }
  }
  if (!needsUpdate) {
    const localSubagentById = new Map(localSubagents.map((sub) => [sub.id, sub]));
    for (const sub of bundle.subagents) {
      const local = localSubagentById.get(sub.id);
      if (local === undefined) {
        needsUpdate = true;
        break;
      }
      const normalized = normalizeSubagent(sub, now);
      if (
        canonicalJson(local) !== canonicalJson({ ...normalized, completedAt: local.completedAt })
      ) {
        needsUpdate = true;
        break;
      }
    }
  }
  if (!needsUpdate) {
    const localHandoffById = new Map(localContextHandoffs.map((h) => [h.id, h]));
    for (const handoff of bundle.contextHandoffs) {
      const local = localHandoffById.get(handoff.id);
      if (local === undefined) {
        needsUpdate = true;
        break;
      }
      const normalized = normalizeContextHandoff(handoff, now);
      if (canonicalJson(local) !== canonicalJson({ ...normalized, updatedAt: local.updatedAt })) {
        needsUpdate = true;
        break;
      }
    }
  }
  if (!needsUpdate) {
    const localTransferById = new Map(localContextTransfers.map((t) => [t.id, t]));
    for (const transfer of bundle.contextTransfers) {
      const local = localTransferById.get(transfer.id);
      if (local === undefined) {
        needsUpdate = true;
        break;
      }
      const normalized = normalizeContextTransfer(transfer, now);
      if (canonicalJson(local) !== canonicalJson({ ...normalized, updatedAt: local.updatedAt })) {
        needsUpdate = true;
        break;
      }
    }
  }

  const hasLocalOnlyRuns = localRuns.some((run) => !bundleRunIds.has(run.id));
  if (needsUpdate && hasLocalOnlyRuns) {
    return {
      diverged: `Thread ${bundle.thread.id} has new turns on both this machine and the devbox; refusing to merge or discard automatically.`,
    };
  }
  return needsUpdate ? "needs_update" : "up_to_date";
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const eventSink = yield* EventSinkV2.EventSinkV2;
  const threadDispatch = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const projectionStore = yield* ProjectionStoreV2.ProjectionStoreV2;
  const projectStore = yield* ProjectStoreV2.ProjectStoreV2;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;

  const buildProjectMapper = (devboxProjects: ReadonlyArray<DevboxExportProject>) => {
    const devboxProjectById = new Map(
      devboxProjects.map((project) => [project.projectId, project]),
    );
    let localByCanonicalKey: Map<string, ProjectId> | undefined;
    const ensureCanonicalIndex = Effect.fn("DevboxThreadMigration.ensureCanonicalIndex")(
      function* () {
        if (localByCanonicalKey !== undefined) return localByCanonicalKey;
        const localProjects = yield* projectStore
          .list()
          .pipe(
            Effect.mapError((error) =>
              migrationError(`Could not read local projects: ${errorText(error)}`),
            ),
          );
        const index = new Map<string, ProjectId>();
        for (const project of localProjects) {
          const identity = yield* repositoryIdentities
            .resolve(project.workspaceRoot)
            .pipe(Effect.orElseSucceed(() => null));
          const key = identity?.canonicalKey?.toLowerCase();
          if (key && !index.has(key)) {
            index.set(key, project.projectId);
          }
        }
        localByCanonicalKey = index;
        return index;
      },
    );

    let cachedScratchProjectId: ProjectId | undefined;
    const ensureScratchProjectId = Effect.fn("DevboxThreadMigration.ensureScratchProjectId")(
      function* () {
        if (cachedScratchProjectId !== undefined) return cachedScratchProjectId;
        const scratch = yield* managedFolders.ensureScratchProject.pipe(
          Effect.mapError((error) =>
            migrationError(`Could not resolve local scratch project: ${errorText(error)}`),
          ),
        );
        cachedScratchProjectId = scratch.projectId;
        return cachedScratchProjectId;
      },
    );

    const resolveProjectId = Effect.fn("DevboxThreadMigration.resolveProjectId")(function* (
      sourceProjectId: ProjectId,
    ) {
      const source = devboxProjectById.get(sourceProjectId);
      if (source !== undefined && !isDevboxScratchProject(source)) {
        const canonicalKey = canonicalKeyFromRemoteUrl(source.remoteUrl);
        if (canonicalKey !== null) {
          const index = yield* ensureCanonicalIndex();
          const matched = index.get(canonicalKey.toLowerCase());
          if (matched !== undefined) return matched;
        }
      }
      return yield* ensureScratchProjectId();
    });

    return { resolveProjectId };
  };

  const importAttachments = Effect.fn("DevboxThreadMigration.importAttachments")(function* (input: {
    readonly missing: ReadonlyArray<readonly [string, RequiredAttachment]>;
    readonly runSshBinary: (
      remoteCommand: string,
      options?: { readonly stdin?: string; readonly timeout?: Duration.Input },
    ) => Effect.Effect<Uint8Array, DevboxError>;
  }) {
    if (input.missing.length === 0) return 0;
    yield* fs
      .makeDirectory(config.attachmentsDir, { recursive: true })
      .pipe(
        Effect.mapError((error) =>
          migrationError(`Could not prepare attachments directory: ${errorText(error)}`),
        ),
      );
    const expectedByName = new Map(input.missing);
    const batches = batchAttachmentsBySize(input.missing);
    let written = 0;

    for (const batch of batches) {
      const batchExpected = new Set(batch);
      const stdin = yield* encodeFilenameList(batch).pipe(
        Effect.mapError((error) =>
          migrationError(`Could not encode attachment list: ${errorText(error)}`),
        ),
      );
      const compressed = yield* input.runSshBinary(
        `python3 -c ${shellQuote(EXPORT_ATTACHMENTS_SCRIPT)}`,
        {
          stdin,
          timeout: "5 minutes",
        },
      );
      const ndjson = yield* gunzipBounded(compressed, MAX_DECOMPRESSED_ATTACHMENT_BATCH_BYTES);
      const received = new Set<string>();

      for (const line of ndjson.split("\n")) {
        if (!line.trim()) continue;
        const record = yield* decodeAttachmentRecord(line).pipe(
          Effect.mapError((error) =>
            migrationError(`Could not decode attachment record: ${errorText(error)}`),
          ),
        );
        if (!isSafeAttachmentFilename(record.name) || !batchExpected.has(record.name)) {
          return yield* migrationError(
            `Unexpected attachment "${record.name}" returned by devbox export.`,
          );
        }
        const expected = expectedByName.get(record.name);
        const bytes = Buffer.from(record.b64, "base64");
        if (
          bytes.byteLength !== record.size ||
          (expected !== undefined && bytes.byteLength !== expected.size)
        ) {
          return yield* migrationError(
            `Attachment "${record.name}" size mismatch (expected ${String(expected?.size ?? record.size)}, got ${String(bytes.byteLength)}).`,
          );
        }
        const actualSha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
        if (
          actualSha256 !== record.sha256 ||
          (expected !== undefined && actualSha256 !== expected.sha256)
        ) {
          return yield* migrationError(`Attachment "${record.name}" failed SHA-256 verification.`);
        }
        const targetPath = path.join(config.attachmentsDir, record.name);
        const outcome = yield* writeAttachmentAtomicNoClobber({
          dir: config.attachmentsDir,
          targetPath,
          bytes,
          expectedSha256: record.sha256,
        });
        if (outcome === "written") written += 1;
        received.add(record.name);
      }

      const missingFromBatch = batch.filter((name) => !received.has(name));
      if (missingFromBatch.length > 0) {
        return yield* migrationError(
          `Devbox attachment export omitted ${missingFromBatch.length} requested file(s): ${missingFromBatch.slice(0, 5).join(", ")}`,
        );
      }
    }
    return written;
  });

  const migrateFromDevbox: DevboxThreadMigration["Service"]["migrateFromDevbox"] = Effect.fn(
    "DevboxThreadMigration.migrateFromDevbox",
  )(function* ({ name, expectDatabase = false, rejectActiveRuns = false, runSshBinary }) {
    const command = rejectActiveRuns
      ? `python3 -c ${shellQuote(EXPORT_THREADS_SCRIPT)} --check-active`
      : `python3 -c ${shellQuote(EXPORT_THREADS_SCRIPT)}`;
    const compressed = yield* runSshBinary(command, { timeout: "3 minutes" });
    const text = yield* gunzipBounded(compressed, MAX_DECOMPRESSED_EXPORT_BYTES);
    const payload = yield* decodeExportJson(text).pipe(
      Effect.mapError((error) =>
        migrationError(`Could not decode thread export from ${name}: ${errorText(error)}`),
      ),
    );
    if (payload.missing) {
      if (expectDatabase) {
        return yield* migrationError(
          `Could not find statev2.sqlite on ${name}; refusing to assume it has no threads.`,
        );
      }
      return { migratedThreads: 0, skippedThreads: 0, migratedAttachments: 0 };
    }
    if (payload.schemaMissing) {
      return yield* migrationError(
        `Devbox ${name} database is missing required V2 projection tables; refusing to skip migration.`,
      );
    }
    const unhydratedCount = payload.unhydratedLegacyThreadIds?.length ?? 0;
    if (rejectActiveRuns && unhydratedCount > 0) {
      return yield* new DevboxError({
        reason: "busy",
        message: `${name} still has ${unhydratedCount} legacy ${unhydratedCount === 1 ? "thread" : "threads"} hydrating in the background. Wake the devbox and wait a moment for hydration to finish, or delete with force to copy what is already hydrated.`,
      });
    }
    const migrationWarning =
      unhydratedCount > 0
        ? `${unhydratedCount} legacy ${unhydratedCount === 1 ? "thread" : "threads"} on ${name} had not finished hydrating into V2 and may be missing or have incomplete transcripts.`
        : undefined;
    if (payload.threads.length === 0) {
      return {
        migratedThreads: 0,
        skippedThreads: 0,
        migratedAttachments: 0,
        ...(migrationWarning === undefined ? {} : { warning: migrationWarning }),
      };
    }

    const decodedBundles: Array<DecodedThreadBundle> = [];
    for (const raw of payload.threads) {
      const thread = yield* decodeThreadJson(raw.thread).pipe(
        Effect.mapError((error) =>
          migrationError(`Could not decode thread from ${name}: ${errorText(error)}`),
        ),
      );
      let validatedForkRunIdsJson: string | null = null;
      if (raw.forkRunIdsJson !== undefined && raw.forkRunIdsJson !== null) {
        const decodedForkRunIds = yield* decodeForkRunIdsJson(raw.forkRunIdsJson).pipe(
          Effect.mapError((error) =>
            migrationError(
              `Could not decode fork_run_ids_json in thread ${thread.id} from ${name}: ${errorText(error)}`,
            ),
          ),
        );
        validatedForkRunIdsJson = yield* encodeForkRunIdsJson(decodedForkRunIds).pipe(
          Effect.mapError((error) =>
            migrationError(
              `Could not encode fork_run_ids_json in thread ${thread.id}: ${errorText(error)}`,
            ),
          ),
        );
      }
      const [
        runs,
        attempts,
        nodes,
        subagents,
        messages,
        plans,
        turnItems,
        contextHandoffs,
        contextTransfers,
      ] = yield* Effect.all([
        decodeListStrict(raw.runs, decodeRunJson, "run", thread.id, name),
        decodeListStrict(raw.attempts, decodeAttemptJson, "run-attempt", thread.id, name),
        decodeListStrict(raw.nodes, decodeNodeJson, "node", thread.id, name),
        decodeListStrict(raw.subagents, decodeSubagentJson, "subagent", thread.id, name),
        decodeListStrict(raw.messages, decodeMessageJson, "message", thread.id, name),
        decodeListStrict(raw.plans, decodePlanJson, "plan", thread.id, name),
        decodeListStrict(raw.turnItems, decodeTurnItemJson, "turn-item", thread.id, name),
        decodeListStrict(
          raw.contextHandoffs,
          decodeContextHandoffJson,
          "context-handoff",
          thread.id,
          name,
        ),
        decodeListStrict(
          raw.contextTransfers,
          decodeContextTransferJson,
          "context-transfer",
          thread.id,
          name,
        ),
      ]);
      decodedBundles.push({
        thread,
        forkRunIdsJson: validatedForkRunIdsJson,
        runs,
        attempts,
        nodes,
        subagents,
        messages,
        plans,
        turnItems,
        contextHandoffs,
        contextTransfers,
      });
    }

    const ordered = orderThreadsTopologically(decodedBundles);
    if (rejectActiveRuns) {
      for (const bundle of ordered) {
        if (bundle.thread.deletedAt !== null) continue;
        const pendingGuest = bundle.thread.guestShare?.messages.filter(
          (message) => message.status === "pending",
        );
        if (pendingGuest !== undefined && pendingGuest.length > 0) {
          return yield* new DevboxError({
            reason: "busy",
            message: `${name} has ${pendingGuest.length} pending guest ${pendingGuest.length === 1 ? "message" : "messages"} on "${bundle.thread.title}". Review or dismiss them first, or delete with force to discard them.`,
          });
        }
      }
    }

    const exportedThreadIds = new Set<ThreadId>(ordered.map((bundle) => bundle.thread.id));
    const deletedRemoteThreadIds = new Set<ThreadId>([
      ...(payload.deletedThreadIds ?? []).map((id) => ThreadId.make(id)),
      ...ordered
        .filter((bundle) => bundle.thread.deletedAt !== null)
        .map((bundle) => bundle.thread.id),
    ]);
    const liveParentThreadIds = new Set<ThreadId>(
      ordered
        .filter((bundle) => bundle.thread.deletedAt === null)
        .map((bundle) => bundle.thread.id),
    );
    const liveParentRoots = new Map<ThreadId, ThreadId>();
    const knownForkThreadIds = new Set<ThreadId>(exportedThreadIds);
    for (const bundle of ordered) {
      const parentId = bundle.thread.lineage.parentThreadId;
      // Do not fall back to a stale local copy if the parent was deleted on the devbox.
      if (
        parentId !== null &&
        !liveParentThreadIds.has(parentId) &&
        !deletedRemoteThreadIds.has(parentId)
      ) {
        const parent = yield* projectionStore
          .findThread(parentId)
          .pipe(Effect.orElseSucceed(() => null));
        if (parent !== null && parent.deletedAt === null) {
          liveParentThreadIds.add(parentId);
          liveParentRoots.set(parentId, parent.lineage.rootThreadId);
        }
      }
      if (bundle.thread.forkedFrom?.type === "run") {
        const forkThreadId = bundle.thread.forkedFrom.threadId;
        if (!knownForkThreadIds.has(forkThreadId)) {
          const forkParent = yield* projectionStore
            .findThread(forkThreadId)
            .pipe(Effect.orElseSucceed(() => null));
          if (forkParent !== null) {
            knownForkThreadIds.add(forkThreadId);
          }
        }
      }
    }
    // Resolve effective rootThreadId topologically so grandchildren of a deleted/missing
    // grandparent re-root onto their highest live ancestor instead of keeping a dangling root.
    for (const bundle of ordered) {
      if (bundle.thread.deletedAt !== null) continue;
      const parentId = bundle.thread.lineage.parentThreadId;
      const rootId =
        parentId !== null && liveParentThreadIds.has(parentId)
          ? (liveParentRoots.get(parentId) ?? bundle.thread.id)
          : bundle.thread.id;
      liveParentRoots.set(bundle.thread.id, rootId);
    }

    // Group each live thread with any uncommitted deleted run-fork ancestors it depends on so
    // tombstones and their live fork commit in one atomic SQLite transaction (preventing a
    // background ProjectionMaintenance purge sweep from deleting an ancestor in between).
    const bundleById = new Map(ordered.map((bundle) => [bundle.thread.id, bundle]));
    const plannedIds = new Set<ThreadId>();
    const commitGroups: Array<ReadonlyArray<DecodedThreadBundle>> = [];
    const collectDeletedAncestors = (
      bundle: DecodedThreadBundle,
      visiting: Set<ThreadId>,
      out: Array<DecodedThreadBundle>,
    ) => {
      if (bundle.thread.lineage.sideChat === true) return;
      const forkedFrom = bundle.thread.forkedFrom;
      if (forkedFrom?.type !== "run") return;
      const ancestor = bundleById.get(forkedFrom.threadId);
      if (
        ancestor === undefined ||
        ancestor.thread.deletedAt === null ||
        plannedIds.has(ancestor.thread.id) ||
        visiting.has(ancestor.thread.id)
      ) {
        return;
      }
      visiting.add(ancestor.thread.id);
      collectDeletedAncestors(ancestor, visiting, out);
      plannedIds.add(ancestor.thread.id);
      out.push(ancestor);
    };
    for (const bundle of ordered) {
      if (bundle.thread.deletedAt !== null) continue;
      const group: Array<DecodedThreadBundle> = [];
      collectDeletedAncestors(bundle, new Set([bundle.thread.id]), group);
      plannedIds.add(bundle.thread.id);
      group.push(bundle);
      commitGroups.push(group);
    }

    // Validate and commit each group under the shared ThreadCommandExecutor lock hierarchy
    // (withDeletionLock -> fork-source lock -> thread locks) and one eventSink.withProviderBatch.
    const mapper = buildProjectMapper(payload.projects);
    const now = yield* DateTime.now;
    // Flush host WAL frames with PASSIVE checkpoints (non-blocking for host writers, with
    // Sqlite.ts's checkpoint_fullfsync = ON) under a hard 10s deadline until all frames land.
    const flushHostWal = Effect.gen(function* () {
      const checkpointDeadline = (yield* Clock.currentTimeMillis) + 10_000;
      for (;;) {
        const rows = yield* sql<{
          readonly busy: number;
          readonly log: number;
          readonly checkpointed: number;
        }>`PRAGMA wal_checkpoint(PASSIVE)`.pipe(
          Effect.mapError((error) =>
            migrationError(`Could not flush migrated threads to disk: ${errorText(error)}`),
          ),
        );
        const row = rows[0];
        if (row !== undefined && row.busy === 0 && row.log === row.checkpointed) {
          return;
        }
        if ((yield* Clock.currentTimeMillis) >= checkpointDeadline) {
          return yield* migrationError(
            `Could not complete SQLite WAL checkpoint before deleting ${name} (database busy).`,
          );
        }
        yield* Effect.sleep("25 millis");
      }
    });

    // Guard against any queued/running attachment.cleanup outbox effect (whether owned by a
    // deleted ancestor OR a previously deleted sibling fork) erasing files needed by migrated threads.
    const guardRequiredAttachmentCleanups = (requiredIds: ReadonlySet<string>) =>
      requiredIds.size === 0
        ? Effect.void
        : sql
            .withTransaction(
              Effect.gen(function* () {
                const nowIso = DateTime.formatIso(now);
                const rows = yield* sql<{
                  readonly effect_id: string;
                  readonly status: string;
                  readonly payload_json: string;
                }>`
                  SELECT effect_id, status, payload_json
                  FROM orchestration_v2_effect_outbox
                  WHERE effect_type = 'attachment.cleanup'
                    AND status IN ('pending', 'running')
                `;
                for (const row of rows) {
                  const check = stripRequiredIdsFromCleanupPayload(row.payload_json, requiredIds);
                  if (!check.overlaps) continue;
                  if (row.status === "running") {
                    return yield* new DevboxError({
                      reason: "busy",
                      message: `Attachment cleanup is currently running on this machine for files referenced by threads from ${name}; retry in a moment.`,
                    });
                  }
                  if (check.nextPayloadJson === null) {
                    yield* sql`
                      UPDATE orchestration_v2_effect_outbox
                      SET
                        status = 'cancelled',
                        lease_owner = NULL,
                        completed_at = ${nowIso},
                        updated_at = ${nowIso},
                        last_error = 'Preserved by devbox thread migration.'
                      WHERE effect_id = ${row.effect_id}
                        AND status = 'pending'
                    `;
                    wroteSqlite = true;
                  } else {
                    yield* sql`
                      UPDATE orchestration_v2_effect_outbox
                      SET payload_json = ${check.nextPayloadJson}, updated_at = ${nowIso}
                      WHERE effect_id = ${row.effect_id}
                        AND status = 'pending'
                    `;
                    wroteSqlite = true;
                  }
                }
              }),
            )
            .pipe(
              Effect.mapError((error) =>
                isDevboxError(error)
                  ? error
                  : migrationError(
                      `Could not guard queued attachment cleanups: ${errorText(error)}`,
                    ),
              ),
            );

    let migratedThreads = 0;
    let skippedThreads = 0;
    let migratedAttachments = 0;
    let hadRequiredAttachments = false;
    let wroteSqlite = false;

    const runMigrationBody = Effect.gen(function* () {
      for (const group of commitGroups) {
        const fallbackProjects = new Map<ThreadId, ProjectId>();
        for (const bundle of group) {
          fallbackProjects.set(
            bundle.thread.id,
            yield* mapper.resolveProjectId(bundle.thread.projectId),
          );
        }

        const groupIds = new Set<ThreadId>(group.map((bundle) => bundle.thread.id));
        const lockOrder: Array<ThreadId> = [];
        const addLock = (id: ThreadId) => {
          if (!lockOrder.includes(id)) lockOrder.push(id);
        };
        for (const bundle of group) {
          if (
            bundle.thread.lineage.sideChat !== true &&
            bundle.thread.forkedFrom?.type === "run" &&
            !groupIds.has(bundle.thread.forkedFrom.threadId)
          ) {
            addLock(bundle.thread.forkedFrom.threadId);
          }
        }
        for (const bundle of group) addLock(bundle.thread.id);

        const commitGroup = eventSink.withProviderBatch(
          Effect.gen(function* () {
            let groupMigrated = 0;
            let groupSkipped = 0;
            for (const bundle of group) {
              const isDeletedAncestor = bundle.thread.deletedAt !== null;
              const fallbackProjectId = fallbackProjects.get(bundle.thread.id)!;
              const existing = yield* projectionStore.findThread(bundle.thread.id);
              const projectId = existing?.projectId ?? fallbackProjectId;
              const normalizedThread = normalizeThread({
                thread: bundle.thread,
                projectId,
                liveParentThreadIds,
                liveParentRoots,
                knownForkThreadIds,
                ...(existing === null ? {} : { existingLocal: existing }),
              });
              let mode: "create" | "update" = "create";
              let repairForkRunIds = false;
              if (existing !== null) {
                if (!isDeletedAncestor && existing.deletedAt !== null) {
                  return yield* migrationError(
                    `Thread ${bundle.thread.id} ("${bundle.thread.title}") was previously deleted on this machine; refusing to discard the devbox copy.`,
                  );
                }
                if (
                  DateTime.toEpochMillis(existing.createdAt) !==
                  DateTime.toEpochMillis(bundle.thread.createdAt)
                ) {
                  return yield* migrationError(
                    `Thread ${bundle.thread.id} collides with an unrelated local thread; refusing to overwrite or discard.`,
                  );
                }
                const [existingRecords, forkRow] = yield* Effect.all([
                  projectionStore.getThreadRecords(bundle.thread.id, [
                    "runs",
                    "attempts",
                    "nodes",
                    "messages",
                    "turnItems",
                    "plans",
                    "subagents",
                    "contextHandoffs",
                    "contextTransfers",
                  ]),
                  sql<{ readonly fork_run_ids_json: string | null }>`
                    SELECT fork_run_ids_json
                    FROM orchestration_v2_projection_threads
                    WHERE thread_id = ${bundle.thread.id}
                    LIMIT 1
                  `.pipe(Effect.map((rows) => rows[0]?.fork_run_ids_json ?? null)),
                ]);
                const comparison = compareLocalCopy({
                  existing,
                  expectedThread: normalizedThread,
                  existingForkRunIdsJson: forkRow,
                  localRuns: existingRecords.runs,
                  localAttempts: existingRecords.attempts,
                  localNodes: existingRecords.nodes,
                  localMessages: existingRecords.messages,
                  localTurnItems: existingRecords.turnItems,
                  localPlans: existingRecords.plans,
                  localSubagents: existingRecords.subagents,
                  localContextHandoffs: existingRecords.contextHandoffs,
                  localContextTransfers: existingRecords.contextTransfers,
                  bundle,
                  now,
                });
                if (typeof comparison !== "string") {
                  return yield* migrationError(comparison.diverged);
                }
                if (comparison === "up_to_date") {
                  if (!isDeletedAncestor) groupSkipped += 1;
                  continue;
                }
                mode = "update";
                repairForkRunIds =
                  bundle.forkRunIdsJson !== null &&
                  normalizedThread.forkedFrom?.type === "run" &&
                  !forkRunIdsEqual(forkRow, bundle.forkRunIdsJson);
              }

              const events = buildImportEvents(
                bundle,
                normalizedThread,
                now,
                mode,
                repairForkRunIds,
              );
              yield* eventSink.write({ events });
              wroteSqlite = true;
              if (!isDeletedAncestor) groupMigrated += 1;
            }
            return { groupMigrated, groupSkipped };
          }),
        );
        const mappedCommit = commitGroup.pipe(
          Effect.mapError((error) =>
            isDevboxError(error)
              ? error
              : migrationError(
                  `Could not import thread ${group.at(-1)?.thread.id ?? name}: ${errorText(error)}`,
                ),
          ),
        );
        const outcome = yield* threadDispatch.withDeletionLock(
          lockOrder.reduceRight<
            Effect.Effect<
              { readonly groupMigrated: number; readonly groupSkipped: number },
              DevboxError
            >
          >((acc, threadId) => threadDispatch.withLock(threadId, acc), mappedCommit),
        );
        migratedThreads += outcome.groupMigrated;
        skippedThreads += outcome.groupSkipped;
      }

      // Verify attachments across ALL exported threads (including skipped retries and retained runs of
      // deleted run-fork ancestors) using lstat + SHA-256 so earlier failures or stale files cannot slip by.
      const manifest = collectAttachmentManifest(
        ordered,
        payload.attachmentFiles,
        payload.invalidAttachmentFiles ?? [],
      );
      hadRequiredAttachments = manifest.required.size > 0;
      yield* guardRequiredAttachmentCleanups(manifest.requiredIds);

      const attachmentErrors = [...manifest.errors];
      const missingAttachments: Array<readonly [string, RequiredAttachment]> = [];
      for (const [filename, expected] of manifest.required.entries()) {
        const targetPath = path.join(config.attachmentsDir, filename);
        const check = yield* checkExistingLocalAttachment({ targetPath, filename, expected });
        if (check === "missing") {
          missingAttachments.push([filename, expected]);
        } else if (check !== "match") {
          attachmentErrors.push(check.error);
        }
      }

      if (missingAttachments.length > 0) {
        migratedAttachments = yield* importAttachments({
          missing: missingAttachments,
          runSshBinary,
        });
      }

      if (attachmentErrors.length > 0) {
        return yield* migrationError(
          `Could not verify ${attachmentErrors.length} attachment(s) from ${name}: ${attachmentErrors.slice(0, 3).join(" ")}`,
        );
      }

      // Sync the attachments directory whenever any attachment is required (including retries
      // where files were published by an earlier failed attempt before directory fsync ran).
      if (hadRequiredAttachments) {
        yield* fsyncDir(config.attachmentsDir);
      }

      yield* flushHostWal;
    });

    // On any partial failure (mid-commitGroups, mid-importAttachments, or attachmentErrors), do a
    // best-effort durability flush for already-rescued threads/attachments before failing, in case
    // a `force: true` caller catches the error and proceeds with `coder delete`.
    yield* runMigrationBody.pipe(
      Effect.onError(() =>
        Effect.gen(function* () {
          if (hadRequiredAttachments || migratedAttachments > 0) {
            yield* fsyncDir(config.attachmentsDir).pipe(Effect.ignore);
          }
          if (wroteSqlite) {
            yield* flushHostWal.pipe(Effect.ignore);
          }
        }),
      ),
    );

    yield* Effect.logInfo("migrated devbox threads to host", {
      name,
      migratedThreads,
      skippedThreads,
      migratedAttachments,
    });
    return {
      migratedThreads,
      skippedThreads,
      migratedAttachments,
      ...(migrationWarning === undefined ? {} : { warning: migrationWarning }),
    };
  });

  return { migrateFromDevbox };
});

export const layer = Layer.effect(DevboxThreadMigration, make).pipe(
  Layer.provide(
    Layer.mergeAll(
      RuntimeLayer.layerEventSink,
      ProjectionStoreV2.layer,
      ThreadCommandExecutor.layer,
    ),
  ),
);
