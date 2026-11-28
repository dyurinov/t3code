// @effect-diagnostics nodeBuiltinImport:off - test runs local python3 against temp sqlite databases.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { describe, expect, it } from "@effect/vitest";
import {
  ContextTransferId,
  DevboxError,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  SourceControlProviderKind,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as EventSinkV2 from "../orchestration-v2/EventSink.ts";
import * as EventStoreV2 from "../orchestration-v2/EventStore.ts";
import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStoreV2 from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ThreadViewers from "../orchestration-v2/ThreadViewers.ts";
import { projectDomainEventForWire } from "../orchestration-v2/WireProjection.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as DevboxThreadMigration from "./DevboxThreadMigration.ts";
import {
  EXPORT_ATTACHMENTS_SCRIPT,
  EXPORT_THREADS_SCRIPT,
  FENCE_T3_SCRIPT,
} from "./devboxScripts.ts";

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 27, 10, minute));
const providerInstanceId = ProviderInstanceId.make("codex");

const makeDbLayer = (sqlitePath: string, stateDir: string) => {
  const persistence = SqlitePersistence.layerFromPath(sqlitePath).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(NodeCrypto.layer),
  );
  const configLayer = ServerConfig.layerTest("/laptop-checkout", stateDir).pipe(
    Layer.provide(NodeServices.layer),
  );
  const eventInfra = Layer.mergeAll(
    RuntimeLayer.layerEventInfrastructure,
    RuntimeLayer.layerEventSink,
  ).pipe(
    Layer.provideMerge(ThreadViewers.layer),
    Layer.provideMerge(ProjectStoreV2.layer),
    Layer.provideMerge(persistence),
  );
  return Layer.mergeAll(
    eventInfra,
    EventStoreV2.layer.pipe(Layer.provide(persistence)),
    ProjectionStoreV2.layer.pipe(Layer.provide(persistence)),
    ThreadSearch.layer.pipe(Layer.provide(persistence)),
    configLayer,
  );
};

const runPythonScript = (
  home: string,
  script: string,
  stdin?: string,
  extraArgs: ReadonlyArray<string> = [],
): Uint8Array => {
  const result = NodeChildProcess.spawnSync("python3", ["-c", script, ...extraArgs], {
    input: stdin,
    env: { ...process.env, HOME: home },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`python3 failed (${String(result.status)}): ${result.stderr.toString("utf8")}`);
  }
  return new Uint8Array(result.stdout);
};

describe("DevboxThreadMigration", () => {
  it.live(
    "exports threads and attachments from a devbox sqlite DB, imports them settled & searchable, and stays idempotent",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-devbox-migrate-"));
        using _cleanup = {
          [Symbol.dispose]: () => NodeFS.rmSync(tmpRoot, { recursive: true, force: true }),
        };

        const devboxHome = NodePath.join(tmpRoot, "devbox-home");
        const devboxUserdata = NodePath.join(devboxHome, ".t3", "userdata");
        const devboxAttachments = NodePath.join(devboxUserdata, "attachments");
        const devboxRepo = NodePath.join(tmpRoot, "devbox-codez");
        const devboxDbPath = NodePath.join(devboxUserdata, "statev2.sqlite");

        NodeFS.mkdirSync(devboxAttachments, { recursive: true });
        NodeFS.mkdirSync(devboxRepo, { recursive: true });
        NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: devboxRepo });
        NodeChildProcess.execFileSync(
          "git",
          ["remote", "add", "origin", "git@github.com:Asana/codez.git"],
          { cwd: devboxRepo },
        );

        const devboxProjectId = ProjectId.make("devbox-codez-proj");
        const devboxScratchId = ProjectId.make("devbox-scratch-proj");
        const parentThreadId = ThreadId.make("thread-devbox-parent");
        const childThreadId = ThreadId.make("thread-devbox-child");
        const scratchThreadId = ThreadId.make("thread-devbox-scratch");
        const deletedThreadId = ThreadId.make("thread-devbox-deleted");
        const runId = RunId.make("run:parent:1");
        const nodeId = NodeId.make("node:parent:1");
        const userMessageId = MessageId.make("msg:parent:user:1");
        const assistantMessageId = MessageId.make("msg:parent:assistant:1");
        const attachmentId = `${parentThreadId}-11111111-1111-4111-8111-111111111111`;
        const attachmentBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        NodeFS.writeFileSync(
          NodePath.join(devboxAttachments, `${attachmentId}.png`),
          attachmentBytes,
        );
        NodeFS.writeFileSync(
          NodePath.join(devboxAttachments, `${attachmentId}.png.txt`),
          "extracted OCR text",
        );
        NodeFS.writeFileSync(
          NodePath.join(devboxAttachments, "unrelated-unused.png"),
          new Uint8Array([1, 2, 3]),
        );

        // 1. Populate the devbox SQLite DB using the real server persistence/event pipeline.
        yield* Effect.gen(function* () {
          const projects = yield* ProjectStoreV2.ProjectStoreV2;
          const sink = yield* EventSinkV2.EventSinkV2;
          yield* projects.apply({
            sequence: 1,
            eventId: EventId.make("proj:devbox:codez"),
            aggregateKind: "project",
            aggregateId: devboxProjectId,
            occurredAt: DateTime.formatIso(at(0)),
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.created",
            payload: {
              projectId: devboxProjectId,
              title: "codez",
              workspaceRoot: devboxRepo,
              defaultModelSelection: null,
              scripts: [],
              createdAt: DateTime.formatIso(at(0)),
              updatedAt: DateTime.formatIso(at(0)),
            },
          });
          yield* projects.apply({
            sequence: 2,
            eventId: EventId.make("proj:devbox:scratch"),
            aggregateKind: "project",
            aggregateId: devboxScratchId,
            occurredAt: DateTime.formatIso(at(0)),
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.created",
            payload: {
              projectId: devboxScratchId,
              title: "No project",
              workspaceRoot: NodePath.join(devboxHome, ".t3", "scratch"),
              defaultModelSelection: null,
              scripts: [],
              createdAt: DateTime.formatIso(at(0)),
              updatedAt: DateTime.formatIso(at(0)),
            },
          });

          const parentEvents: ReadonlyArray<OrchestrationV2DomainEvent> = [
            {
              id: EventId.make("ev:parent:created"),
              threadId: parentThreadId,
              occurredAt: at(1),
              type: "thread.created",
              payload: {
                createdBy: "user",
                creationSource: "web",
                id: parentThreadId,
                projectId: devboxProjectId,
                title: "Investigate devbox latency",
                providerInstanceId,
                modelSelection: { instanceId: providerInstanceId, model: "gpt-6.2-sol" },
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "feature/latency",
                worktreePath: "/var/asana-config/asana/worktrees/latency",
                linkedPullRequest: {
                  projectId: devboxProjectId,
                  repository: "Asana/codez",
                  number: 470908,
                  url: "https://github.com/Asana/codez/pull/470908",
                },
                pullRequests: [
                  {
                    host: "github.com",
                    repository: "Asana/codez",
                    number: 470908,
                    url: "https://github.com/Asana/codez/pull/470908",
                    source: "created",
                    linkedAt: DateTime.formatIso(at(1)),
                    snapshot: null,
                    stack: null,
                    watch: {
                      startedAt: DateTime.formatIso(at(1)),
                      headSha: null,
                      failedChecks: [],
                      passed: false,
                      passedChecks: [],
                      remarksThrough: DateTime.formatIso(at(1)),
                      remarkIds: [],
                      conflicting: false,
                      wakes: 0,
                    },
                  },
                ],
                activeProviderThreadId: ProviderThreadId.make("devbox-native-session-1"),
                lineage: {
                  parentThreadId: null,
                  rootThreadId: parentThreadId,
                  relationshipToParent: null,
                },
                forkedFrom: null,
                createdAt: at(1),
                updatedAt: at(5),
                archivedAt: null,
                settledOverride: null,
                settledAt: null,
                lastVisitedAt: at(4),
                deletedAt: null,
              },
            },
            {
              id: EventId.make("ev:parent:run"),
              threadId: parentThreadId,
              runId,
              occurredAt: at(2),
              type: "run.created",
              payload: {
                id: runId,
                threadId: parentThreadId,
                ordinal: 1,
                providerInstanceId,
                modelSelection: { instanceId: providerInstanceId, model: "gpt-6.2-sol" },
                providerThreadId: ProviderThreadId.make("devbox-native-session-1"),
                userMessageId,
                rootNodeId: nodeId,
                activeAttemptId: null,
                status: "running",
                requestedAt: at(2),
                startedAt: at(2),
                completedAt: null,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            {
              id: EventId.make("ev:parent:user-msg"),
              threadId: parentThreadId,
              runId,
              nodeId,
              occurredAt: at(2),
              type: "message.updated",
              payload: {
                createdBy: "user",
                creationSource: "web",
                id: userMessageId,
                threadId: parentThreadId,
                runId,
                nodeId,
                role: "user",
                text: "Can you profile the quirky-flamingo bottleneck?",
                attachments: [
                  {
                    type: "image",
                    id: attachmentId,
                    name: "profile.png",
                    mimeType: "image/png",
                    sizeBytes: attachmentBytes.byteLength,
                  },
                ],
                streaming: false,
                createdAt: at(2),
                updatedAt: at(2),
              },
            },
            {
              id: EventId.make("ev:parent:assistant-msg"),
              threadId: parentThreadId,
              runId,
              nodeId,
              occurredAt: at(3),
              type: "message.updated",
              payload: {
                createdBy: "agent",
                creationSource: "provider",
                id: assistantMessageId,
                threadId: parentThreadId,
                runId,
                nodeId,
                role: "assistant",
                text: "Found the root cause in cluster_config_refresh with token sapphire-otter-991.",
                attachments: [],
                // Simulate a mid-stream message when the devbox died; migration must settle streaming=false so FTS5 indexes it.
                streaming: true,
                createdAt: at(3),
                updatedAt: at(3),
              },
            },
            {
              id: EventId.make("ev:parent:item-1"),
              threadId: parentThreadId,
              runId,
              nodeId,
              occurredAt: at(2),
              type: "turn-item.updated",
              payload: {
                createdBy: "user",
                creationSource: "web",
                id: TurnItemId.make("item:parent:1"),
                threadId: parentThreadId,
                runId,
                nodeId,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 1,
                status: "completed",
                title: null,
                startedAt: at(2),
                completedAt: at(2),
                updatedAt: at(2),
                type: "user_message",
                messageId: userMessageId,
                inputIntent: "turn_start",
                text: "Can you profile the quirky-flamingo bottleneck?",
                attachments: [
                  {
                    type: "image",
                    id: attachmentId,
                    name: "profile.png",
                    mimeType: "image/png",
                    sizeBytes: attachmentBytes.byteLength,
                  },
                ],
              },
            },
            {
              id: EventId.make("ev:parent:item-2"),
              threadId: parentThreadId,
              runId,
              nodeId,
              occurredAt: at(3),
              type: "turn-item.updated",
              payload: {
                id: TurnItemId.make("item:parent:2"),
                threadId: parentThreadId,
                runId,
                nodeId,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 2,
                status: "running",
                title: null,
                startedAt: at(3),
                completedAt: null,
                updatedAt: at(3),
                type: "assistant_message",
                messageId: assistantMessageId,
                text: "Found the root cause in cluster_config_refresh with token sapphire-otter-991.",
                streaming: true,
              },
            },
            {
              id: EventId.make("ev:parent:meta-at-5"),
              threadId: parentThreadId,
              occurredAt: at(5),
              type: "thread.metadata-updated",
              payload: {
                createdBy: "user",
                creationSource: "web",
                id: parentThreadId,
                projectId: devboxProjectId,
                title: "Investigate prod latency",
                providerInstanceId,
                modelSelection: { instanceId: providerInstanceId, model: "gpt-6.2-sol" },
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "dmytro/perf",
                worktreePath: "/home/vagrant/worktrees/perf",
                linkedPullRequest: {
                  projectId: devboxProjectId,
                  repository: "Asana/codez",
                  number: 470908,
                  url: "https://github.com/Asana/codez/pull/470908",
                },
                pullRequests: [
                  {
                    host: "github.com",
                    repository: "Asana/codez",
                    number: 470908,
                    url: "https://github.com/Asana/codez/pull/470908",
                    source: "created",
                    linkedAt: DateTime.formatIso(at(1)),
                    snapshot: null,
                    stack: null,
                    watch: {
                      startedAt: DateTime.formatIso(at(1)),
                      headSha: null,
                      failedChecks: [],
                      passed: false,
                      passedChecks: [],
                      remarksThrough: DateTime.formatIso(at(1)),
                      remarkIds: [],
                      conflicting: false,
                      wakes: 0,
                    },
                  },
                ],
                activeProviderThreadId: ProviderThreadId.make("devbox-native-session-1"),
                lineage: {
                  parentThreadId: null,
                  rootThreadId: parentThreadId,
                  relationshipToParent: null,
                },
                forkedFrom: null,
                createdAt: at(1),
                updatedAt: at(5),
                archivedAt: null,
                settledOverride: null,
                settledAt: null,
                lastVisitedAt: at(4),
                deletedAt: null,
              },
            },
          ];
          yield* sink.write({ events: parentEvents });

          // Child subagent thread referencing parentThreadId.
          yield* sink.write({
            events: [
              {
                id: EventId.make("ev:child:created"),
                threadId: childThreadId,
                occurredAt: at(4),
                type: "thread.created",
                payload: {
                  createdBy: "agent",
                  creationSource: "mcp",
                  id: childThreadId,
                  projectId: devboxProjectId,
                  title: "Subagent trace",
                  providerInstanceId,
                  modelSelection: { instanceId: providerInstanceId, model: "gpt-6.2-sol" },
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: null,
                  worktreePath: null,
                  activeProviderThreadId: null,
                  lineage: {
                    parentThreadId,
                    rootThreadId: parentThreadId,
                    relationshipToParent: "subagent",
                  },
                  forkedFrom: null,
                  createdAt: at(4),
                  updatedAt: at(4),
                  archivedAt: null,
                  settledOverride: "settled",
                  settledAt: at(4),
                  lastVisitedAt: null,
                  deletedAt: null,
                },
              },
            ],
          });

          // Scratch thread (should map to laptop's scratch project).
          yield* sink.write({
            events: [
              {
                id: EventId.make("ev:scratch:created"),
                threadId: scratchThreadId,
                occurredAt: at(5),
                type: "thread.created",
                payload: {
                  createdBy: "user",
                  creationSource: "web",
                  id: scratchThreadId,
                  projectId: devboxScratchId,
                  title: "Scratchpad notes",
                  providerInstanceId,
                  modelSelection: { instanceId: providerInstanceId, model: "gpt-6.2-sol" },
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: null,
                  worktreePath: null,
                  activeProviderThreadId: null,
                  lineage: {
                    parentThreadId: null,
                    rootThreadId: scratchThreadId,
                    relationshipToParent: null,
                  },
                  forkedFrom: null,
                  createdAt: at(5),
                  updatedAt: at(5),
                  archivedAt: at(6),
                  settledOverride: null,
                  settledAt: null,
                  lastVisitedAt: null,
                  deletedAt: null,
                },
              },
            ],
          });

          // Deleted thread (must NOT be exported or migrated).
          yield* sink.write({
            events: [
              {
                id: EventId.make("ev:deleted:created"),
                threadId: deletedThreadId,
                occurredAt: at(1),
                type: "thread.created",
                payload: {
                  createdBy: "user",
                  creationSource: "web",
                  id: deletedThreadId,
                  projectId: devboxProjectId,
                  title: "Deleted thread",
                  providerInstanceId,
                  modelSelection: { instanceId: providerInstanceId, model: "gpt-6.2-sol" },
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: null,
                  worktreePath: null,
                  activeProviderThreadId: null,
                  lineage: {
                    parentThreadId: null,
                    rootThreadId: deletedThreadId,
                    relationshipToParent: null,
                  },
                  forkedFrom: null,
                  createdAt: at(1),
                  updatedAt: at(2),
                  archivedAt: null,
                  settledOverride: null,
                  settledAt: null,
                  lastVisitedAt: null,
                  deletedAt: null,
                },
              },
              {
                id: EventId.make("ev:deleted:tombstone"),
                threadId: deletedThreadId,
                occurredAt: at(3),
                type: "thread.deleted",
                payload: {
                  createdBy: "user",
                  creationSource: "web",
                  id: deletedThreadId,
                  projectId: devboxProjectId,
                  title: "Deleted thread",
                  providerInstanceId,
                  modelSelection: { instanceId: providerInstanceId, model: "gpt-6.2-sol" },
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: null,
                  worktreePath: null,
                  activeProviderThreadId: null,
                  lineage: {
                    parentThreadId: null,
                    rootThreadId: deletedThreadId,
                    relationshipToParent: null,
                  },
                  forkedFrom: null,
                  createdAt: at(1),
                  updatedAt: at(3),
                  archivedAt: null,
                  settledOverride: null,
                  settledAt: null,
                  lastVisitedAt: null,
                  deletedAt: at(3),
                },
              },
            ],
          });
        }).pipe(Effect.provide(makeDbLayer(devboxDbPath, devboxUserdata)));

        // 2. Run DevboxThreadMigration against a fresh laptop SQLite DB.
        const laptopStateDir = NodePath.join(tmpRoot, "laptop-state");
        const laptopDbPath = NodePath.join(laptopStateDir, "userdata", "statev2.sqlite");
        const laptopCodezProjectId = ProjectId.make("laptop-asana-proj");
        const laptopScratchProjectId = ProjectId.make("laptop-scratch-proj");
        const laptopCodezRoot = "/Users/dev/sandbox/asana";
        const laptopScratchRoot = "/Users/dev/.t3/scratch";

        const laptopBaseLayer = makeDbLayer(laptopDbPath, laptopStateDir);
        const laptopLayer = DevboxThreadMigration.layer.pipe(
          Layer.provideMerge(laptopBaseLayer),
          Layer.provide(
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: NodePath.join(tmpRoot, "projects"),
              ensureScratchProject: Effect.succeed({
                projectId: laptopScratchProjectId,
                workspaceRoot: laptopScratchRoot,
              } as never),
            }),
          ),
          Layer.provide(
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: (cwd) =>
                Effect.succeed(
                  cwd === laptopCodezRoot
                    ? ({
                        canonicalKey: "github.com/asana/codez",
                        locator: {
                          source: "git-remote",
                          remoteName: "origin",
                          remoteUrl: "git@github.com:Asana/codez.git",
                        },
                        rootPath: laptopCodezRoot,
                        displayName: "Asana/codez",
                        provider: SourceControlProviderKind.make("github"),
                        owner: "Asana",
                        name: "codez",
                      } satisfies RepositoryIdentity)
                    : null,
                ),
            }),
          ),
        );

        const runSshBinary = (
          remoteCommand: string,
          options?: { readonly stdin?: string },
        ): Effect.Effect<Uint8Array, DevboxError> =>
          Effect.try({
            try: () => {
              if (remoteCommand.includes("orchestration_v2_projection_threads")) {
                return runPythonScript(devboxHome, EXPORT_THREADS_SCRIPT);
              }
              if (remoteCommand.includes("MAX_FILE_BYTES")) {
                return runPythonScript(devboxHome, EXPORT_ATTACHMENTS_SCRIPT, options?.stdin);
              }
              throw new Error(`Unexpected SSH command: ${remoteCommand.slice(0, 80)}`);
            },
            catch: (error) => new DevboxError({ reason: "provision", message: String(error) }),
          });

        yield* Effect.gen(function* () {
          const projects = yield* ProjectStoreV2.ProjectStoreV2;
          const projectionStore = yield* ProjectionStoreV2.ProjectionStoreV2;
          const search = yield* ThreadSearch.ThreadSearch;
          const config = yield* ServerConfig.ServerConfig;
          const migration = yield* DevboxThreadMigration.DevboxThreadMigration;

          yield* projects.apply({
            sequence: 1,
            eventId: EventId.make("proj:laptop:codez"),
            aggregateKind: "project",
            aggregateId: laptopCodezProjectId,
            occurredAt: DateTime.formatIso(at(0)),
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.created",
            payload: {
              projectId: laptopCodezProjectId,
              title: "asana",
              workspaceRoot: laptopCodezRoot,
              defaultModelSelection: null,
              scripts: [],
              createdAt: DateTime.formatIso(at(0)),
              updatedAt: DateTime.formatIso(at(0)),
            },
          });
          yield* projects.apply({
            sequence: 2,
            eventId: EventId.make("proj:laptop:scratch"),
            aggregateKind: "project",
            aggregateId: laptopScratchProjectId,
            occurredAt: DateTime.formatIso(at(0)),
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.created",
            payload: {
              projectId: laptopScratchProjectId,
              title: "No project",
              workspaceRoot: laptopScratchRoot,
              defaultModelSelection: null,
              scripts: [],
              createdAt: DateTime.formatIso(at(0)),
              updatedAt: DateTime.formatIso(at(0)),
            },
          });

          const first = yield* migration.migrateFromDevbox({
            name: "12-fancy-sparrow",
            expectDatabase: true,
            runSshBinary,
          });
          expect(first).toEqual({
            migratedThreads: 3,
            skippedThreads: 0,
            migratedAttachments: 2,
          });

          // Verify deleted thread was not imported.
          const deleted = yield* projectionStore.findThread(deletedThreadId);
          expect(deleted).toBeNull();

          // Verify parent thread mapped to laptop's Asana/codez project, preserved updatedAt/settledAt, settled, sanitized, and detached.
          const parentProjection = yield* projectionStore.getThreadProjection(parentThreadId);
          expect(parentProjection.thread.projectId).toBe(laptopCodezProjectId);
          expect(parentProjection.thread.worktreePath).toBeNull();
          expect(parentProjection.thread.activeProviderThreadId).toBeNull();
          expect(parentProjection.thread.settledOverride).toBe("settled");
          expect(DateTime.toEpochMillis(parentProjection.thread.updatedAt)).toBe(
            DateTime.toEpochMillis(at(5)),
          );
          expect(DateTime.toEpochMillis(parentProjection.thread.settledAt!)).toBe(
            DateTime.toEpochMillis(at(5)),
          );
          expect(parentProjection.thread.linkedPullRequest?.projectId).toBe(laptopCodezProjectId);
          expect(parentProjection.thread.pullRequests?.[0]?.watch).toBeUndefined();
          expect(parentProjection.thread.pullRequests?.[0]?.endedWatch).toBeDefined();
          expect(parentProjection.runs[0]?.status).toBe("interrupted");
          expect(parentProjection.runs[0]?.providerThreadId).toBeNull();
          expect(parentProjection.messages.every((m) => !m.streaming)).toBe(true);
          expect(parentProjection.turnItems).toHaveLength(2);
          expect(parentProjection.turnItems[1]?.status).toBe("interrupted");
          expect(parentProjection.turnItems[1]?.completedAt).not.toBeNull();

          // Verify child thread kept parent lineage and mapped project.
          const child = yield* projectionStore.getThread(childThreadId);
          expect(child.projectId).toBe(laptopCodezProjectId);
          expect(child.lineage.parentThreadId).toBe(parentThreadId);

          // Verify archived scratch thread mapped to laptop scratch project and stayed archived.
          const scratch = yield* projectionStore.getThread(scratchThreadId);
          expect(scratch.projectId).toBe(laptopScratchProjectId);
          expect(scratch.archivedAt).not.toBeNull();

          // Verify referenced attachment and its .txt sidecar copied, while unrelated attachment skipped.
          const copiedPath = NodePath.join(config.attachmentsDir, `${attachmentId}.png`);
          expect(NodeFS.existsSync(copiedPath)).toBe(true);
          expect(new Uint8Array(NodeFS.readFileSync(copiedPath))).toEqual(attachmentBytes);
          expect(
            NodeFS.readFileSync(
              NodePath.join(config.attachmentsDir, `${attachmentId}.png.txt`),
              "utf8",
            ),
          ).toBe("extracted OCR text");
          expect(
            NodeFS.existsSync(NodePath.join(config.attachmentsDir, "unrelated-unused.png")),
          ).toBe(false);

          // Verify FTS5 full-text search immediately finds the migrated thread by its assistant message.
          const searchResult = yield* search.search({
            query: "sapphire-otter-991",
            limit: 10,
          });
          expect(searchResult.matches.map((match) => match.threadId)).toContain(parentThreadId);

          // Verify idempotency on retry when source is unchanged.
          const second = yield* migration.migrateFromDevbox({
            name: "12-fancy-sparrow",
            expectDatabase: true,
            runSshBinary,
          });
          expect(second).toEqual({
            migratedThreads: 0,
            skippedThreads: 3,
            migratedAttachments: 0,
          });

          // Simulate a new message added on the devbox after a failed delete; retry must pull the delta.
          const followupMessageId = MessageId.make("msg:parent:followup:2");
          yield* Effect.gen(function* () {
            const devboxSink = yield* EventSinkV2.EventSinkV2;
            yield* devboxSink.write({
              events: [
                {
                  id: EventId.make("ev:parent:followup"),
                  threadId: parentThreadId,
                  runId,
                  nodeId,
                  occurredAt: at(10),
                  type: "message.updated",
                  payload: {
                    createdBy: "agent",
                    creationSource: "provider",
                    id: followupMessageId,
                    threadId: parentThreadId,
                    runId,
                    nodeId,
                    role: "assistant",
                    text: "Follow-up delta token emerald-walrus-772.",
                    attachments: [],
                    streaming: false,
                    createdAt: at(10),
                    updatedAt: at(10),
                  },
                },
              ],
            });
          }).pipe(Effect.provide(Layer.fresh(makeDbLayer(devboxDbPath, devboxUserdata))));

          const third = yield* migration.migrateFromDevbox({
            name: "12-fancy-sparrow",
            expectDatabase: true,
            runSshBinary,
          });
          expect(third).toEqual({
            migratedThreads: 1,
            skippedThreads: 2,
            migratedAttachments: 0,
          });
          const deltaSearch = yield* search.search({
            query: "emerald-walrus-772",
            limit: 10,
          });
          expect(deltaSearch.matches.map((match) => match.threadId)).toContain(parentThreadId);
        }).pipe(Effect.provide(laptopLayer));
      }),
  );

  it("fails strictly on path traversal, symlinks, and missing files in EXPORT_ATTACHMENTS_SCRIPT", () => {
    const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-devbox-att-"));
    using _cleanup = {
      [Symbol.dispose]: () => NodeFS.rmSync(tmpRoot, { recursive: true, force: true }),
    };
    const attachmentsDir = NodePath.join(tmpRoot, ".t3", "userdata", "attachments");
    NodeFS.mkdirSync(attachmentsDir, { recursive: true });
    const secretFile = NodePath.join(tmpRoot, "secret.txt");
    NodeFS.writeFileSync(secretFile, "top-secret");
    NodeFS.symlinkSync(secretFile, NodePath.join(attachmentsDir, "link.txt"));
    NodeFS.writeFileSync(NodePath.join(attachmentsDir, "ok.txt"), "hello");

    expect(() =>
      runPythonScript(tmpRoot, EXPORT_ATTACHMENTS_SCRIPT, JSON.stringify(["../secret.txt"])),
    ).toThrow(/invalid attachment filename/);
    expect(() =>
      runPythonScript(tmpRoot, EXPORT_ATTACHMENTS_SCRIPT, JSON.stringify(["link.txt"])),
    ).toThrow(/symlink/);
    expect(() =>
      runPythonScript(tmpRoot, EXPORT_ATTACHMENTS_SCRIPT, JSON.stringify(["missing.txt"])),
    ).toThrow(/could not open attachment/);

    const compressed = runPythonScript(
      tmpRoot,
      EXPORT_ATTACHMENTS_SCRIPT,
      JSON.stringify(["ok.txt"]),
    );
    const lines = NodeZlib.gunzipSync(compressed)
      .toString("utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line: string) =>
          JSON.parse(line) as { name: string; size: number; sha256: string; b64: string },
      );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.name).toBe("ok.txt");
    expect(lines[0]?.size).toBe(5);
    expect(Buffer.from(lines[0]!.b64, "base64").toString("utf8")).toBe("hello");
  });

  it.live(
    "persists thread transcripts even when a referenced attachment is missing, while failing migration to block non-force delete",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-devbox-missing-att-"),
        );
        using _cleanup = {
          [Symbol.dispose]: () => NodeFS.rmSync(tmpRoot, { recursive: true, force: true }),
        };
        const devboxHome = NodePath.join(tmpRoot, "devbox-home");
        const devboxUserdata = NodePath.join(devboxHome, ".t3", "userdata");
        const devboxDbPath = NodePath.join(devboxUserdata, "statev2.sqlite");
        NodeFS.mkdirSync(NodePath.join(devboxUserdata, "attachments"), { recursive: true });

        const threadId = ThreadId.make("thread-missing-att");
        const runId = RunId.make("run:missing-att:1");
        const nodeId = NodeId.make("node:missing-att:1");
        const msgId = MessageId.make("msg:missing-att:1");
        const projId = ProjectId.make("devbox-scratch");
        const missingAttachmentId = `${threadId}-22222222-2222-4222-8222-222222222222`;

        yield* Effect.gen(function* () {
          const sink = yield* EventSinkV2.EventSinkV2;
          yield* sink.write({
            events: [
              {
                id: EventId.make("ev:ma:created"),
                threadId,
                occurredAt: at(1),
                type: "thread.created",
                payload: {
                  createdBy: "user",
                  creationSource: "web",
                  id: threadId,
                  projectId: projId,
                  title: "Thread with missing attachment",
                  providerInstanceId,
                  modelSelection: { instanceId: providerInstanceId, model: "gpt-6.2-sol" },
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: null,
                  worktreePath: null,
                  activeProviderThreadId: null,
                  lineage: {
                    parentThreadId: null,
                    rootThreadId: threadId,
                    relationshipToParent: null,
                  },
                  forkedFrom: null,
                  createdAt: at(1),
                  updatedAt: at(2),
                  archivedAt: null,
                  settledOverride: null,
                  settledAt: null,
                  lastVisitedAt: null,
                  deletedAt: null,
                },
              },
              {
                id: EventId.make("ev:ma:msg"),
                threadId,
                runId,
                nodeId,
                occurredAt: at(2),
                type: "message.updated",
                payload: {
                  createdBy: "user",
                  creationSource: "web",
                  id: msgId,
                  threadId,
                  runId,
                  nodeId,
                  role: "user",
                  text: "Here is a missing image.",
                  attachments: [
                    {
                      type: "image",
                      id: missingAttachmentId,
                      name: "gone.png",
                      mimeType: "image/png",
                      sizeBytes: 128,
                    },
                  ],
                  streaming: false,
                  createdAt: at(2),
                  updatedAt: at(2),
                },
              },
            ],
          });
        }).pipe(Effect.provide(makeDbLayer(devboxDbPath, devboxUserdata)));

        const laptopStateDir = NodePath.join(tmpRoot, "laptop-state");
        const laptopDbPath = NodePath.join(laptopStateDir, "userdata", "statev2.sqlite");
        const laptopScratchProjectId = ProjectId.make("laptop-scratch-proj");
        const laptopLayer = DevboxThreadMigration.layer.pipe(
          Layer.provideMerge(makeDbLayer(laptopDbPath, laptopStateDir)),
          Layer.provide(
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: NodePath.join(tmpRoot, "projects"),
              ensureScratchProject: Effect.succeed({
                projectId: laptopScratchProjectId,
                workspaceRoot: "/Users/dev/.t3/scratch",
              } as never),
            }),
          ),
          Layer.provide(
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: () => Effect.succeed(null),
            }),
          ),
        );

        const runSshBinary = (
          remoteCommand: string,
          options?: { readonly stdin?: string },
        ): Effect.Effect<Uint8Array, DevboxError> =>
          Effect.try({
            try: () => {
              if (remoteCommand.includes("orchestration_v2_projection_threads")) {
                const extraArgs = remoteCommand.includes("--check-active")
                  ? ["--check-active"]
                  : [];
                return runPythonScript(devboxHome, EXPORT_THREADS_SCRIPT, undefined, extraArgs);
              }
              if (remoteCommand.includes("MAX_FILE_BYTES")) {
                return runPythonScript(devboxHome, EXPORT_ATTACHMENTS_SCRIPT, options?.stdin);
              }
              throw new Error(`Unexpected SSH command: ${remoteCommand.slice(0, 80)}`);
            },
            catch: (error) => new DevboxError({ reason: "provision", message: String(error) }),
          });

        yield* Effect.gen(function* () {
          const migration = yield* DevboxThreadMigration.DevboxThreadMigration;
          const projectionStore = yield* ProjectionStoreV2.ProjectionStoreV2;

          const failure = yield* Effect.flip(
            migration.migrateFromDevbox({
              name: "14-missing-att",
              expectDatabase: true,
              runSshBinary,
            }),
          );
          expect(failure.reason).toBe("migration");
          expect(failure.message).toContain(`${missingAttachmentId}.png`);

          // Even though migration failed to block deletion, the thread transcript itself was saved!
          const saved = yield* projectionStore.findThread(threadId);
          expect(saved).not.toBeNull();
          expect(saved?.title).toBe("Thread with missing attachment");

          // Missing DB when expectDatabase=true must also fail with reason="migration".
          const emptyHome = NodePath.join(tmpRoot, "empty-home");
          NodeFS.mkdirSync(emptyHome, { recursive: true });
          const missingDbFailure = yield* Effect.flip(
            migration.migrateFromDevbox({
              name: "15-missing-db",
              expectDatabase: true,
              runSshBinary: () =>
                Effect.sync(() => runPythonScript(emptyHome, EXPORT_THREADS_SCRIPT)),
            }),
          );
          expect(missingDbFailure.reason).toBe("migration");
        }).pipe(Effect.provide(laptopLayer));
      }),
  );

  it.live(
    "preserves deleted run-fork ancestors, disposes app_owned subagents, retires pending transfers, and rejects tombstones & tampered attachments",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-devbox-edge-"));
        using _cleanup = {
          [Symbol.dispose]: () => NodeFS.rmSync(tmpRoot, { recursive: true, force: true }),
        };
        const devboxHome = NodePath.join(tmpRoot, "devbox-home");
        const devboxUserdata = NodePath.join(devboxHome, ".t3", "userdata");
        const devboxAttachments = NodePath.join(devboxUserdata, "attachments");
        const devboxDbPath = NodePath.join(devboxUserdata, "statev2.sqlite");
        NodeFS.mkdirSync(devboxAttachments, { recursive: true });

        const projId = ProjectId.make("devbox-scratch");
        const ancestorId = ThreadId.make("thread-deleted-ancestor");
        const forkId = ThreadId.make("thread-live-fork");
        const ancestorRunId = RunId.make("run:ancestor:1");
        const ancestorPostForkRunId = RunId.make("run:ancestor:2");
        const ancestorNodeId = NodeId.make("node:ancestor:1");
        const ancestorPostForkNodeId = NodeId.make("node:ancestor:2");
        const ancestorMsgId = MessageId.make("msg:ancestor:1");
        const ancestorPostForkMsgId = MessageId.make("msg:ancestor:2");
        const ancestorAttId = `${ancestorId}-33333333-3333-4333-8333-333333333333`;
        const ancestorPostForkAttId = `${ancestorId}-44444444-4444-4444-8444-444444444444`;
        const ancestorAttBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
        NodeFS.writeFileSync(
          NodePath.join(devboxAttachments, `${ancestorAttId}.png`),
          ancestorAttBytes,
        );
        // Intentionally do NOT write `${ancestorPostForkAttId}.png`: ThreadDeletion cleans up
        // post-fork attachments when deleting the ancestor, so migration must not fail on it.

        const forkRunId = RunId.make("run:fork:1");
        const forkNodeId = NodeId.make("node:fork:1");
        const subagentId = NodeId.make("subagent:fork:1");
        const transferId = ContextTransferId.make("transfer:fork:pending");

        yield* Effect.gen(function* () {
          const sink = yield* EventSinkV2.EventSinkV2;
          yield* sink.write({
            events: [
              {
                id: EventId.make("ev:anc:created"),
                threadId: ancestorId,
                occurredAt: at(1),
                type: "thread.created",
                payload: {
                  createdBy: "user",
                  creationSource: "web",
                  id: ancestorId,
                  projectId: projId,
                  title: "Deleted fork source",
                  providerInstanceId,
                  modelSelection: { instanceId: providerInstanceId, model: "gpt-6.2-sol" },
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: null,
                  worktreePath: null,
                  activeProviderThreadId: null,
                  lineage: {
                    parentThreadId: null,
                    rootThreadId: ancestorId,
                    relationshipToParent: null,
                  },
                  forkedFrom: null,
                  createdAt: at(1),
                  updatedAt: at(2),
                  archivedAt: null,
                  settledOverride: null,
                  settledAt: null,
                  lastVisitedAt: null,
                  deletedAt: null,
                },
              },
              {
                id: EventId.make("ev:anc:run"),
                threadId: ancestorId,
                runId: ancestorRunId,
                occurredAt: at(2),
                type: "run.created",
                payload: {
                  id: ancestorRunId,
                  threadId: ancestorId,
                  ordinal: 1,
                  providerInstanceId,
                  modelSelection: { instanceId: providerInstanceId, model: "gpt-6.2-sol" },
                  providerThreadId: null,
                  userMessageId: ancestorMsgId,
                  rootNodeId: ancestorNodeId,
                  activeAttemptId: null,
                  status: "completed",
                  requestedAt: at(2),
                  startedAt: at(2),
                  completedAt: at(2),
                  checkpointId: null,
                  contextHandoffId: null,
                },
              },
              {
                id: EventId.make("ev:anc:msg"),
                threadId: ancestorId,
                runId: ancestorRunId,
                nodeId: ancestorNodeId,
                occurredAt: at(2),
                type: "message.updated",
                payload: {
                  createdBy: "user",
                  creationSource: "web",
                  id: ancestorMsgId,
                  threadId: ancestorId,
                  runId: ancestorRunId,
                  nodeId: ancestorNodeId,
                  role: "user",
                  text: "Inherited ancestor message.",
                  attachments: [
                    {
                      type: "image",
                      id: ancestorAttId,
                      name: "anc.png",
                      mimeType: "image/png",
                      sizeBytes: ancestorAttBytes.byteLength,
                    },
                  ],
                  streaming: false,
                  createdAt: at(2),
                  updatedAt: at(2),
                },
              },
              {
                id: EventId.make("ev:anc:run2"),
                threadId: ancestorId,
                runId: ancestorPostForkRunId,
                occurredAt: at(3),
                type: "run.created",
                payload: {
                  id: ancestorPostForkRunId,
                  threadId: ancestorId,
                  ordinal: 2,
                  providerInstanceId,
                  modelSelection: { instanceId: providerInstanceId, model: "gpt-6.2-sol" },
                  providerThreadId: null,
                  userMessageId: ancestorPostForkMsgId,
                  rootNodeId: ancestorPostForkNodeId,
                  activeAttemptId: null,
                  status: "completed",
                  requestedAt: at(3),
                  startedAt: at(3),
                  completedAt: at(3),
                  checkpointId: null,
                  contextHandoffId: null,
                },
              },
              {
                id: EventId.make("ev:anc:msg2"),
                threadId: ancestorId,
                runId: ancestorPostForkRunId,
                nodeId: ancestorPostForkNodeId,
                occurredAt: at(3),
                type: "message.updated",
                payload: {
                  createdBy: "user",
                  creationSource: "web",
                  id: ancestorPostForkMsgId,
                  threadId: ancestorId,
                  runId: ancestorPostForkRunId,
                  nodeId: ancestorPostForkNodeId,
                  role: "user",
                  text: "Post-fork message whose attachment was cleaned up on deletion.",
                  attachments: [
                    {
                      type: "image",
                      id: ancestorPostForkAttId,
                      name: "post-fork-deleted.png",
                      mimeType: "image/png",
                      sizeBytes: 64,
                    },
                  ],
                  streaming: false,
                  createdAt: at(3),
                  updatedAt: at(3),
                },
              },
              {
                id: EventId.make("ev:fork:created"),
                threadId: forkId,
                occurredAt: at(3),
                type: "thread.created",
                payload: {
                  createdBy: "user",
                  creationSource: "web",
                  id: forkId,
                  projectId: projId,
                  title: "Live fork",
                  providerInstanceId,
                  modelSelection: { instanceId: providerInstanceId, model: "gpt-6.2-sol" },
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: null,
                  worktreePath: null,
                  activeProviderThreadId: null,
                  lineage: {
                    parentThreadId: null,
                    rootThreadId: forkId,
                    relationshipToParent: null,
                  },
                  forkedFrom: { type: "run", threadId: ancestorId, runId: ancestorRunId },
                  createdAt: at(3),
                  updatedAt: at(4),
                  archivedAt: null,
                  settledOverride: null,
                  settledAt: null,
                  lastVisitedAt: null,
                  deletedAt: null,
                },
              },
              {
                id: EventId.make("ev:fork:subagent"),
                threadId: forkId,
                runId: forkRunId,
                nodeId: subagentId,
                driver: ProviderDriverKind.make("codex"),
                providerInstanceId,
                occurredAt: at(4),
                type: "subagent.updated",
                payload: {
                  id: subagentId,
                  threadId: forkId,
                  runId: forkRunId,
                  parentNodeId: forkNodeId,
                  origin: "app_owned",
                  createdBy: "agent",
                  driver: ProviderDriverKind.make("codex"),
                  providerInstanceId,
                  providerThreadId: null,
                  childThreadId: null,
                  remoteChild: {
                    environmentId: EnvironmentId.make("env-remote-peer"),
                    label: "Peer devbox",
                    threadId: ThreadId.make("remote-child-1"),
                    stoppedThere: false,
                  },
                  nativeTaskRef: null,
                  prompt: "Check remote peer",
                  title: "Remote check",
                  model: "gpt-6.2-sol",
                  status: "running",
                  result: null,
                  startedAt: at(4),
                  completedAt: null,
                  updatedAt: at(4),
                },
              },
              {
                id: EventId.make("ev:fork:transfer"),
                threadId: forkId,
                occurredAt: at(4),
                type: "context-transfer.created",
                payload: {
                  id: transferId,
                  type: "merge_back",
                  sourceThreadId: ancestorId,
                  targetThreadId: forkId,
                  sourcePoint: { threadId: ancestorId, runId: ancestorRunId },
                  basePoint: null,
                  sourceProviderInstanceId: providerInstanceId,
                  targetProviderInstanceId: providerInstanceId,
                  targetRunId: null,
                  status: "pending",
                  resolution: null,
                  createdBy: "user",
                  error: null,
                  createdAt: at(4),
                  updatedAt: at(4),
                  consumedAt: null,
                },
              },
              // Delete the ancestor AFTER forking; V2 retains it for the live fork.
              {
                id: EventId.make("ev:anc:deleted"),
                threadId: ancestorId,
                occurredAt: at(5),
                type: "thread.deleted",
                payload: {
                  createdBy: "user",
                  creationSource: "web",
                  id: ancestorId,
                  projectId: projId,
                  title: "Deleted fork source",
                  providerInstanceId,
                  modelSelection: { instanceId: providerInstanceId, model: "gpt-6.2-sol" },
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: null,
                  worktreePath: null,
                  activeProviderThreadId: null,
                  lineage: {
                    parentThreadId: null,
                    rootThreadId: ancestorId,
                    relationshipToParent: null,
                  },
                  forkedFrom: null,
                  createdAt: at(1),
                  updatedAt: at(5),
                  archivedAt: null,
                  settledOverride: null,
                  settledAt: null,
                  lastVisitedAt: null,
                  deletedAt: at(5),
                },
              },
            ],
          });
        }).pipe(Effect.provide(Layer.fresh(makeDbLayer(devboxDbPath, devboxUserdata))));

        const laptopStateDir = NodePath.join(tmpRoot, "laptop-state");
        const laptopDbPath = NodePath.join(laptopStateDir, "userdata", "statev2.sqlite");
        const laptopScratchProjectId = ProjectId.make("laptop-scratch-proj");
        const laptopLayer = DevboxThreadMigration.layer.pipe(
          Layer.provideMerge(Layer.fresh(makeDbLayer(laptopDbPath, laptopStateDir))),
          Layer.provide(
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: NodePath.join(tmpRoot, "projects"),
              ensureScratchProject: Effect.succeed({
                projectId: laptopScratchProjectId,
                workspaceRoot: "/Users/dev/.t3/scratch",
              } as never),
            }),
          ),
          Layer.provide(
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: () => Effect.succeed(null),
            }),
          ),
        );

        const runSshBinary = (
          remoteCommand: string,
          options?: { readonly stdin?: string },
        ): Effect.Effect<Uint8Array, DevboxError> =>
          Effect.try({
            try: () => {
              if (remoteCommand.includes("orchestration_v2_projection_threads")) {
                return runPythonScript(devboxHome, EXPORT_THREADS_SCRIPT);
              }
              if (remoteCommand.includes("MAX_FILE_BYTES")) {
                return runPythonScript(devboxHome, EXPORT_ATTACHMENTS_SCRIPT, options?.stdin);
              }
              throw new Error(`Unexpected SSH command: ${remoteCommand.slice(0, 80)}`);
            },
            catch: (error) => new DevboxError({ reason: "provision", message: String(error) }),
          });

        yield* Effect.gen(function* () {
          const migration = yield* DevboxThreadMigration.DevboxThreadMigration;
          const projectionStore = yield* ProjectionStoreV2.ProjectionStoreV2;
          const config = yield* ServerConfig.ServerConfig;

          const result = yield* migration.migrateFromDevbox({
            name: "16-fork-edge",
            expectDatabase: true,
            runSshBinary,
          });
          // Only the live fork counts as a migrated thread, while the deleted ancestor & its attachment are preserved.
          expect(result).toEqual({
            migratedThreads: 1,
            skippedThreads: 0,
            migratedAttachments: 1,
          });

          const importedFork = yield* projectionStore.getThreadProjection(forkId);
          expect(importedFork.thread.forkedFrom).toEqual({
            type: "run",
            threadId: ancestorId,
            runId: ancestorRunId,
          });
          expect(importedFork.subagents[0]?.remoteChild?.stoppedThere).toBe(true);
          expect(importedFork.subagents[0]?.completionDelivery).toEqual({
            state: "disposed",
            observedByRunId: null,
          });
          expect(importedFork.subagents[0]?.result).not.toBeNull();
          expect(importedFork.contextTransfers[0]?.status).toBe("superseded");

          const importedAncestor = yield* projectionStore.findThread(ancestorId);
          expect(importedAncestor?.deletedAt).not.toBeNull();
          expect(
            NodeFS.existsSync(NodePath.join(config.attachmentsDir, `${ancestorAttId}.png`)),
          ).toBe(true);

          // Verify key-order-independent idempotency on retry for a thread with normalized app_owned subagent & retired transfer.
          const retrySame = yield* migration.migrateFromDevbox({
            name: "16-fork-edge",
            expectDatabase: true,
            runSshBinary,
          });
          expect(retrySame).toEqual({
            migratedThreads: 0,
            skippedThreads: 1,
            migratedAttachments: 0,
          });

          // Tamper with the local attachment (same byte length, wrong contents) -> retry must fail SHA-256 verification.
          NodeFS.writeFileSync(
            NodePath.join(config.attachmentsDir, `${ancestorAttId}.png`),
            new Uint8Array(ancestorAttBytes.byteLength).fill(0x41),
          );
          const tamperFailure = yield* Effect.flip(
            migration.migrateFromDevbox({
              name: "16-fork-edge",
              expectDatabase: true,
              runSshBinary,
            }),
          );
          expect(tamperFailure.reason).toBe("migration");
          expect(tamperFailure.message).toContain("SHA-256");

          // Restore attachment, then simulate divergent runs on host vs devbox with the same RunId:
          // retry must fail rather than silently overwriting the host run.
          NodeFS.writeFileSync(
            NodePath.join(config.attachmentsDir, `${ancestorAttId}.png`),
            ancestorAttBytes,
          );
          const sharedRunId = RunId.make(`run:thread:${forkId}:ordinal:1`);
          const laptopSink = yield* EventSinkV2.EventSinkV2;
          yield* laptopSink.write({
            events: [
              {
                id: EventId.make("ev:host:divergent-run"),
                threadId: forkId,
                runId: sharedRunId,
                occurredAt: at(20),
                type: "run.created",
                payload: {
                  id: sharedRunId,
                  threadId: forkId,
                  ordinal: 1,
                  providerInstanceId,
                  modelSelection: { instanceId: providerInstanceId, model: "gpt-6.2-sol" },
                  providerThreadId: null,
                  userMessageId: MessageId.make("msg:host:divergent"),
                  rootNodeId: NodeId.make("node:host:divergent"),
                  activeAttemptId: null,
                  status: "completed",
                  requestedAt: at(20),
                  startedAt: at(20),
                  completedAt: at(20),
                  checkpointId: null,
                  contextHandoffId: null,
                },
              },
            ],
          });
          yield* Effect.gen(function* () {
            const devboxSink = yield* EventSinkV2.EventSinkV2;
            yield* devboxSink.write({
              events: [
                {
                  id: EventId.make("ev:devbox:divergent-run"),
                  threadId: forkId,
                  runId: sharedRunId,
                  occurredAt: at(21),
                  type: "run.created",
                  payload: {
                    id: sharedRunId,
                    threadId: forkId,
                    ordinal: 1,
                    providerInstanceId,
                    modelSelection: { instanceId: providerInstanceId, model: "gpt-6.2-sol" },
                    providerThreadId: null,
                    userMessageId: MessageId.make("msg:devbox:divergent"),
                    rootNodeId: NodeId.make("node:devbox:divergent"),
                    activeAttemptId: null,
                    status: "completed",
                    requestedAt: at(21),
                    startedAt: at(21),
                    completedAt: at(21),
                    checkpointId: null,
                    contextHandoffId: null,
                  },
                },
              ],
            });
          }).pipe(Effect.provide(Layer.fresh(makeDbLayer(devboxDbPath, devboxUserdata))));

          const divergeFailure = yield* Effect.flip(
            migration.migrateFromDevbox({
              name: "16-fork-edge",
              expectDatabase: true,
              runSshBinary,
            }),
          );
          expect(divergeFailure.reason).toBe("migration");
          expect(divergeFailure.message).toContain("diverged");
        }).pipe(Effect.provide(laptopLayer));
      }),
  );

  it("executes FENCE_T3_SCRIPT directly via python3 stdin, holds server-owner.sqlite lock, and catches active runs & shutdown races", async () => {
    const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-devbox-fence-"));
    using _cleanup = {
      [Symbol.dispose]: () => NodeFS.rmSync(tmpRoot, { recursive: true, force: true }),
    };
    const userdataDir = NodePath.join(tmpRoot, ".t3", "userdata");
    const dbPath = NodePath.join(userdataDir, "statev2.sqlite");
    const lockPath = NodePath.join(userdataDir, "server-owner.sqlite");
    NodeFS.mkdirSync(userdataDir, { recursive: true });
    const stubBin = NodePath.join(tmpRoot, "bin");
    NodeFS.mkdirSync(stubBin, { recursive: true });
    const systemctlStub = NodePath.join(stubBin, "systemctl");
    const stateFile = NodePath.join(tmpRoot, "unit-state");
    const loadFile = NodePath.join(tmpRoot, "load-state");
    const raceMarker = NodePath.join(tmpRoot, "trigger-race");

    // Seed a real SQLite DB with orchestration_v2_projection_runs.
    const sqlExec = (sqlText: string) => {
      const res = NodeChildProcess.spawnSync(
        "python3",
        [
          "-c",
          "import sqlite3, sys; db=sqlite3.connect(sys.argv[1]); db.executescript(sys.argv[2]); db.commit(); db.close()",
          dbPath,
          sqlText,
        ],
        { encoding: "utf8" },
      );
      if (res.status !== 0) throw new Error(res.stderr);
    };
    sqlExec(
      "CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, status TEXT NOT NULL);",
    );

    NodeFS.writeFileSync(
      systemctlStub,
      `#!/bin/sh
if [ "$2" = "show" ]; then
  cat "${loadFile}"
  exit 0
fi
if [ "$2" = "stop" ]; then
  if [ -f "${raceMarker}" ]; then
    python3 -c 'import sqlite3, sys; db=sqlite3.connect(sys.argv[1]); db.execute("INSERT OR REPLACE INTO orchestration_v2_projection_runs VALUES (?, ?)", ("run:raced", "cancelled")); db.commit(); db.close()' "${dbPath}"
  fi
  echo "inactive" > "${stateFile}"
  exit 0
fi
if [ "$2" = "is-active" ]; then
  state=$(cat "${stateFile}")
  echo "$state"
  [ "$state" = "active" ] && exit 0 || exit 3
fi
exit 1
`,
      { mode: 0o755 },
    );

    const runFence = (extraArgs: ReadonlyArray<string> = []) =>
      NodeChildProcess.spawnSync("python3", ["-", ...extraArgs], {
        input: FENCE_T3_SCRIPT,
        env: { ...process.env, HOME: tmpRoot, PATH: `${stubBin}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      });

    // 1. Active run pre-stop: exits 42 with ACTIVE_RUNS:1.
    sqlExec("INSERT INTO orchestration_v2_projection_runs VALUES ('run:active', 'running');");
    NodeFS.writeFileSync(loadFile, "loaded\n");
    NodeFS.writeFileSync(stateFile, "active\n");
    const busyRes = runFence(["--check-active"]);
    expect(busyRes.status).toBe(42);
    expect(busyRes.stderr).toContain("ACTIVE_RUNS:1");

    // 2. Idle DB + loaded unit: stops unit, acquires server-owner.sqlite lock, prints FENCED.
    sqlExec("UPDATE orchestration_v2_projection_runs SET status = 'completed';");
    const loadedRes = runFence(["--check-active"]);
    expect(loadedRes.status).toBe(0);
    expect(loadedRes.stdout.trim()).toBe("FENCED");
    expect(NodeFS.readFileSync(stateFile, "utf8").trim()).toBe("inactive");

    // 3. Shutdown race (a run appears/gets cancelled while systemctl stop runs): exits 42.
    NodeFS.writeFileSync(stateFile, "active\n");
    NodeFS.writeFileSync(raceMarker, "1");
    const racedRes = runFence(["--check-active"]);
    NodeFS.rmSync(raceMarker, { force: true });
    expect(racedRes.status).toBe(42);
    expect(racedRes.stderr).toContain("ACTIVE_RUNS:1");

    // 4. Another process holding server-owner.sqlite (e.g. unmanaged t3 start/serve): fails non-zero.
    const holder = NodeChildProcess.spawn(
      "python3",
      [
        "-c",
        "import sqlite3, sys, time; db=sqlite3.connect(sys.argv[1], isolation_level=None); db.execute('BEGIN EXCLUSIVE'); print('LOCKED', flush=True); time.sleep(30)",
        lockPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        let ready = "";
        holder.stdout.on("data", (chunk: Buffer) => {
          ready += chunk.toString("utf8");
          if (ready.includes("LOCKED")) resolve();
        });
        holder.once("exit", (code) => {
          reject(new Error(`holder exited early (${String(code)})`));
        });
      });
      NodeFS.writeFileSync(loadFile, "not-found\n");
      const lockedRes = runFence(["--check-active"]);
      expect(lockedRes.status).not.toBe(0);
      expect(lockedRes.stderr).toContain("server-owner.sqlite");
    } finally {
      holder.kill("SIGKILL");
    }

    // 5. Systemd D-Bus/unit failure: must fail non-zero.
    NodeFS.writeFileSync(loadFile, "error\n");
    const badLoadRes = runFence(["--check-active"]);
    expect(badLoadRes.status).not.toBe(0);

    // 5b. Leftover 000 seal on server-owner.sqlite from a crashed prior delete self-heals on retry.
    NodeFS.writeFileSync(loadFile, "not-found\n");
    NodeFS.chmodSync(lockPath, 0o000);
    const healedRes = runFence(["--check-active"]);
    expect(healedRes.status).toBe(0);
    expect(healedRes.stdout.trim()).toBe("FENCED");
    expect(NodeFS.statSync(lockPath).mode & 0o600).toBe(0o600);

    // 6. --hold acquires server-owner.sqlite and releases cleanly as soon as stdout closes
    // (simulating a non-PTY SSH disconnect like Coder's agentssh where no SIGHUP is delivered).
    NodeFS.writeFileSync(loadFile, "not-found\n");
    const heldChild = NodeChildProcess.spawn("python3", ["-", "--check-active", "--hold"], {
      env: { ...process.env, HOME: tmpRoot, PATH: `${stubBin}:${process.env.PATH ?? ""}` },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      heldChild.stdin.end(FENCE_T3_SCRIPT);
      await new Promise<void>((resolve, reject) => {
        let out = "";
        heldChild.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString("utf8");
          if (out.includes("FENCED\n")) resolve();
        });
        heldChild.once("exit", (code) => {
          reject(new Error(`fence --hold exited early (${String(code)})`));
        });
      });

      const probeLock = () =>
        NodeChildProcess.spawnSync(
          "python3",
          [
            "-c",
            "import sqlite3, sys; db=sqlite3.connect(sys.argv[1], isolation_level=None); db.execute('PRAGMA busy_timeout = 50'); db.execute('BEGIN EXCLUSIVE'); db.execute('ROLLBACK'); db.close()",
            lockPath,
          ],
          { encoding: "utf8" },
        );

      expect(probeLock().status).not.toBe(0);

      // Close stdout read end without sending SIGTERM/SIGHUP.
      const exitPromise = new Promise<number | null>((resolve) => {
        heldChild.once("exit", (code) => resolve(code));
      });
      heldChild.stdout.destroy();
      const exitCode = await exitPromise;
      expect(exitCode).toBe(0);
      expect(probeLock().status).toBe(0);
    } finally {
      if (heldChild.exitCode === null) heldChild.kill("SIGKILL");
    }
  });

  it.live(
    "preserves exact sibling-fork membership across parent rewinds on live import and full event replay, and re-roots grandchildren when a grandparent is missing",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-devbox-replay-"));
        using _cleanup = {
          [Symbol.dispose]: () => NodeFS.rmSync(tmpRoot, { recursive: true, force: true }),
        };

        const devboxUserdata = NodePath.join(tmpRoot, "devbox-home", ".t3", "userdata");
        const devboxDbPath = NodePath.join(devboxUserdata, "statev2.sqlite");
        NodeFS.mkdirSync(devboxUserdata, { recursive: true });

        const projId = ProjectId.make("devbox-proj-replay");
        const parentId = ThreadId.make("thread:replay-parent");
        const forkBeforeRewindId = ThreadId.make("thread:replay-fork-before");
        const forkAfterRewindId = ThreadId.make("thread:replay-fork-after");
        const missingGrandparentId = ThreadId.make("thread:missing-grandparent");
        const midParentId = ThreadId.make("thread:live-mid-parent");
        const grandChildId = ThreadId.make("thread:live-grandchild");

        const run1 = RunId.make("run:replay:1");
        const run2 = RunId.make("run:replay:2");
        const run3 = RunId.make("run:replay:3");
        const msg1 = MessageId.make("msg:replay:1");
        const msg2 = MessageId.make("msg:replay:2");
        const msg3 = MessageId.make("msg:replay:3");

        const baseThread = (
          id: ThreadId,
          title: string,
          minute: number,
          overrides: Partial<
            Extract<OrchestrationV2DomainEvent, { readonly type: "thread.created" }>["payload"]
          > = {},
        ) => ({
          createdBy: "user" as const,
          creationSource: "web" as const,
          id,
          projectId: projId,
          title,
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "gpt-6.2-sol" },
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            rootThreadId: id,
            relationshipToParent: null,
          },
          forkedFrom: null,
          createdAt: at(minute),
          updatedAt: at(minute),
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
          ...overrides,
        });

        const makeRun = (
          id: RunId,
          ordinal: number,
          userMessageId: MessageId,
          status: "completed" | "rolled_back",
          minute: number,
        ) => ({
          id,
          threadId: parentId,
          ordinal,
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "gpt-6.2-sol" },
          providerThreadId: null,
          userMessageId,
          rootNodeId: NodeId.make(`node:replay:${ordinal}`),
          activeAttemptId: null,
          status,
          requestedAt: at(minute),
          startedAt: at(minute),
          completedAt: at(minute + 1),
          checkpointId: null,
          contextHandoffId: null,
        });

        yield* Effect.gen(function* () {
          const eventSink = yield* EventSinkV2.EventSinkV2;
          // Parent executes run1 and run2; forkBeforeRewind forks at run2 ([run1, run2]);
          // parent then rewinds run2 to rolled_back and executes run3; forkAfterRewind forks at run3 ([run1, run3]).
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("ev:rp:parent"),
                threadId: parentId,
                occurredAt: at(1),
                type: "thread.created",
                payload: baseThread(parentId, "Parent with rewind", 1),
              },
              {
                id: EventId.make("ev:rp:r1"),
                threadId: parentId,
                runId: run1,
                occurredAt: at(2),
                type: "run.created",
                payload: makeRun(run1, 1, msg1, "completed", 2),
              },
              {
                id: EventId.make("ev:rp:r2"),
                threadId: parentId,
                runId: run2,
                occurredAt: at(3),
                type: "run.created",
                payload: makeRun(run2, 2, msg2, "completed", 3),
              },
              {
                id: EventId.make("ev:rp:f1"),
                threadId: forkBeforeRewindId,
                occurredAt: at(4),
                type: "thread.created",
                payload: baseThread(forkBeforeRewindId, "Fork before rewind", 4, {
                  lineage: {
                    parentThreadId: parentId,
                    rootThreadId: parentId,
                    relationshipToParent: "fork",
                  },
                  forkedFrom: { type: "run", threadId: parentId, runId: run2 },
                }),
              },
              {
                id: EventId.make("ev:rp:r2-rb"),
                threadId: parentId,
                runId: run2,
                occurredAt: at(5),
                type: "run.updated",
                payload: makeRun(run2, 2, msg2, "rolled_back", 3),
              },
              {
                id: EventId.make("ev:rp:r3"),
                threadId: parentId,
                runId: run3,
                occurredAt: at(6),
                type: "run.created",
                payload: makeRun(run3, 3, msg3, "completed", 6),
              },
              {
                id: EventId.make("ev:rp:f2"),
                threadId: forkAfterRewindId,
                occurredAt: at(7),
                type: "thread.created",
                payload: baseThread(forkAfterRewindId, "Fork after rewind", 7, {
                  lineage: {
                    parentThreadId: parentId,
                    rootThreadId: parentId,
                    relationshipToParent: "fork",
                  },
                  forkedFrom: { type: "run", threadId: parentId, runId: run3 },
                }),
              },
              // Live midParent + live grandChild whose grandparent does not exist in export.
              {
                id: EventId.make("ev:rp:mid"),
                threadId: midParentId,
                occurredAt: at(8),
                type: "thread.created",
                payload: baseThread(midParentId, "Mid parent", 8, {
                  lineage: {
                    parentThreadId: missingGrandparentId,
                    rootThreadId: missingGrandparentId,
                    relationshipToParent: "fork",
                  },
                }),
              },
              {
                id: EventId.make("ev:rp:gc"),
                threadId: grandChildId,
                occurredAt: at(9),
                type: "thread.created",
                payload: baseThread(grandChildId, "Grandchild", 9, {
                  lineage: {
                    parentThreadId: midParentId,
                    rootThreadId: missingGrandparentId,
                    relationshipToParent: "fork",
                  },
                }),
              },
            ],
          });
        }).pipe(Effect.provide(Layer.fresh(makeDbLayer(devboxDbPath, devboxUserdata))));

        const laptopStateDir = NodePath.join(tmpRoot, "laptop-state");
        const laptopDbPath = NodePath.join(laptopStateDir, "userdata", "statev2.sqlite");
        const laptopLayer = DevboxThreadMigration.layer.pipe(
          Layer.provideMerge(Layer.fresh(makeDbLayer(laptopDbPath, laptopStateDir))),
          Layer.provide(
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: NodePath.join(tmpRoot, "projects"),
              ensureScratchProject: Effect.succeed({
                projectId: ProjectId.make("laptop-scratch-replay"),
                workspaceRoot: "/Users/dev/.t3/scratch",
              } as never),
            }),
          ),
          Layer.provide(
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: () => Effect.succeed(null),
            }),
          ),
        );

        const runSshBinary = (
          remote: string,
          options?: { readonly stdin?: string },
        ): Effect.Effect<Uint8Array, DevboxError> =>
          Effect.try({
            try: () => {
              const pythonArgs = remote.includes("--check-active")
                ? ["-", "--check-active"]
                : ["-"];
              const script =
                options?.stdin ??
                (remote.includes("EXPORT_ATTACHMENTS")
                  ? EXPORT_ATTACHMENTS_SCRIPT
                  : EXPORT_THREADS_SCRIPT);
              const result = NodeChildProcess.spawnSync("python3", pythonArgs, {
                input: script,
                env: { ...process.env, HOME: NodePath.join(tmpRoot, "devbox-home") },
                maxBuffer: 64 * 1024 * 1024,
              });
              if (result.status !== 0) {
                throw new Error(result.stderr.toString("utf8"));
              }
              return new Uint8Array(result.stdout);
            },
            catch: (error) => new DevboxError({ reason: "migration", message: String(error) }),
          });

        yield* Effect.gen(function* () {
          const migration = yield* DevboxThreadMigration.DevboxThreadMigration;
          const projectionStore = yield* ProjectionStoreV2.ProjectionStoreV2;
          const eventStore = yield* EventStoreV2.EventStoreV2;
          const sql = yield* SqlClient.SqlClient;

          const res = yield* migration.migrateFromDevbox({
            name: "19-replay-box",
            expectDatabase: true,
            runSshBinary,
          });
          expect(res.migratedThreads).toBe(5);

          const readForkRunIds = (id: ThreadId) =>
            sql<{ readonly fork_run_ids_json: string | null }>`
              SELECT fork_run_ids_json
              FROM orchestration_v2_projection_threads
              WHERE thread_id = ${id}
            `.pipe(
              Effect.map((rows) =>
                rows[0]?.fork_run_ids_json
                  ? (JSON.parse(rows[0].fork_run_ids_json) as ReadonlyArray<string>)
                  : null,
              ),
            );

          // Live projections match source exactly, and live forkedFrom does not leak forkRunIds.
          expect(yield* readForkRunIds(forkBeforeRewindId)).toEqual([run1, run2]);
          expect(yield* readForkRunIds(forkAfterRewindId)).toEqual([run1, run3]);
          const liveF1 = yield* projectionStore.findThread(forkBeforeRewindId);
          expect(liveF1?.forkedFrom).toEqual({ type: "run", threadId: parentId, runId: run2 });

          // Grandchild re-rooted onto midParent when missingGrandparent was absent.
          const liveMid = yield* projectionStore.findThread(midParentId);
          const liveGc = yield* projectionStore.findThread(grandChildId);
          expect(liveMid?.lineage.rootThreadId).toBe(midParentId);
          expect(liveGc?.lineage.parentThreadId).toBe(midParentId);
          expect(liveGc?.lineage.rootThreadId).toBe(midParentId);

          // Wipe projection tables and rebuild purely from orchestration_events to prove replay fidelity.
          yield* sql`DELETE FROM orchestration_v2_projection_runs`;
          yield* sql`DELETE FROM orchestration_v2_projection_threads`;
          const storedEvents = yield* Stream.runCollect(eventStore.read());
          for (const stored of storedEvents) {
            yield* projectionStore.apply(stored.event);
          }

          expect(yield* readForkRunIds(forkBeforeRewindId)).toEqual([run1, run2]);
          expect(yield* readForkRunIds(forkAfterRewindId)).toEqual([run1, run3]);
          const replayedParentRuns = (yield* projectionStore.getThreadRecords(parentId, ["runs"]))
            .runs;
          expect(replayedParentRuns.find((run) => run.id === run2)?.status).toBe("rolled_back");

          // Simulate a stale/legacy local fork_run_ids_json on an existing copy, then re-run
          // migration to verify update-mode repair is event-sourced and survives a full replay.
          yield* sql`
            UPDATE orchestration_v2_projection_threads
            SET fork_run_ids_json = ${JSON.stringify([run1])}
            WHERE thread_id = ${forkBeforeRewindId}
          `;
          const repairRes = yield* migration.migrateFromDevbox({
            name: "19-replay-box",
            expectDatabase: true,
            runSshBinary,
          });
          expect(repairRes.migratedThreads).toBe(1);
          expect(yield* readForkRunIds(forkBeforeRewindId)).toEqual([run1, run2]);
          // ProjectionStore strips forkRunIds before writing payload_json, and WireProjection
          // strips forkRunIds from stored domain events before publishing over WebSocket.
          const repairedF1 = yield* projectionStore.findThread(forkBeforeRewindId);
          expect(repairedF1?.forkedFrom).toEqual({
            type: "run",
            threadId: parentId,
            runId: run2,
          });
          const rawEvents = yield* Stream.runCollect(
            eventStore.read({ threadId: forkBeforeRewindId }),
          );
          for (const stored of rawEvents) {
            const wired = projectDomainEventForWire(stored.event);
            if (
              wired.type === "thread.created" ||
              wired.type === "thread.metadata-updated" ||
              wired.type === "thread.deleted"
            ) {
              expect(
                wired.payload.forkedFrom?.type === "run"
                  ? wired.payload.forkedFrom.forkRunIds
                  : undefined,
              ).toBeUndefined();
            }
          }

          yield* sql`DELETE FROM orchestration_v2_projection_runs`;
          yield* sql`DELETE FROM orchestration_v2_projection_threads`;
          const repairedEvents = yield* Stream.runCollect(eventStore.read());
          for (const stored of repairedEvents) {
            yield* projectionStore.apply(stored.event);
          }
          expect(yield* readForkRunIds(forkBeforeRewindId)).toEqual([run1, run2]);

          // Delete parent on devbox after initial import and add a pending guest message: safe
          // migration blocks as busy; force migration clears guestShare and re-roots the unchanged fork.
          yield* Effect.gen(function* () {
            const devboxSink = yield* EventSinkV2.EventSinkV2;
            yield* devboxSink.write({
              events: [
                {
                  id: EventId.make("ev:rp:parent-del"),
                  threadId: parentId,
                  occurredAt: at(10),
                  type: "thread.deleted",
                  payload: baseThread(parentId, "Parent with rewind", 1, {
                    updatedAt: at(10),
                    deletedAt: at(10),
                  }),
                },
                {
                  id: EventId.make("ev:rp:gc-guest"),
                  threadId: grandChildId,
                  occurredAt: at(10),
                  type: "thread.metadata-updated",
                  payload: baseThread(grandChildId, "Grandchild", 9, {
                    updatedAt: at(10),
                    lineage: {
                      parentThreadId: midParentId,
                      rootThreadId: missingGrandparentId,
                      relationshipToParent: "fork",
                    },
                    guestShare: {
                      id: "share-1" as never,
                      host: "https://devbox.example",
                      createdAt: "2026-11-27T10:09:00.000Z" as never,
                      expiresAt: "2026-11-28T10:09:00.000Z" as never,
                      guestName: "Alice",
                      messages: [
                        {
                          id: "guest-msg-1" as never,
                          text: "Please check this before deleting!",
                          status: "pending",
                          submittedAt: "2026-11-27T10:10:00.000Z" as never,
                        },
                      ],
                    },
                  }),
                },
              ],
            });
          }).pipe(Effect.provide(Layer.fresh(makeDbLayer(devboxDbPath, devboxUserdata))));

          const guestBusy = yield* Effect.flip(
            migration.migrateFromDevbox({
              name: "19-replay-box",
              expectDatabase: true,
              rejectActiveRuns: true,
              runSshBinary,
            }),
          );
          expect(guestBusy.reason).toBe("busy");
          expect(guestBusy.message).toContain("pending guest");

          const retryRes = yield* migration.migrateFromDevbox({
            name: "19-replay-box",
            expectDatabase: true,
            rejectActiveRuns: false,
            runSshBinary,
          });
          expect(retryRes.migratedThreads).toBeGreaterThanOrEqual(2);
          const updatedParent = yield* projectionStore.findThread(parentId);
          const updatedFork = yield* projectionStore.findThread(forkBeforeRewindId);
          const updatedGc = yield* projectionStore.findThread(grandChildId);
          expect(updatedParent?.deletedAt).not.toBeNull();
          expect(updatedFork?.lineage).toEqual({
            parentThreadId: null,
            rootThreadId: forkBeforeRewindId,
            relationshipToParent: null,
          });
          expect(updatedGc?.guestShare).toBeNull();

          // Unhydrated legacy thread in orchestration_v2_legacy_imports blocks safe migration as
          // busy (so force delete still copies hydrated threads instead of skipping migration).
          yield* Effect.gen(function* () {
            const devboxSql = yield* SqlClient.SqlClient;
            yield* devboxSql`
              INSERT INTO orchestration_v2_legacy_imports (thread_id, source_updated_at, shell_imported_at, transcript_imported_at)
              VALUES (${grandChildId}, '2026-11-27T10:09:00.000Z', '2026-11-27T10:09:00.000Z', NULL)
            `;
          }).pipe(Effect.provide(Layer.fresh(makeDbLayer(devboxDbPath, devboxUserdata))));

          const unhydratedErr = yield* Effect.flip(
            migration.migrateFromDevbox({
              name: "19-replay-box",
              expectDatabase: true,
              rejectActiveRuns: true,
              runSshBinary,
            }),
          );
          expect(unhydratedErr.reason).toBe("busy");
          expect(unhydratedErr.message).toContain("hydrating");

          const forcedWithUnhydrated = yield* migration.migrateFromDevbox({
            name: "19-replay-box",
            expectDatabase: true,
            rejectActiveRuns: false,
            runSshBinary,
          });
          expect(forcedWithUnhydrated.skippedThreads).toBeGreaterThanOrEqual(1);
          expect(forcedWithUnhydrated.warning).toContain("had not finished hydrating");

          // A live V1 legacy row in projection_threads without any V2 shell also blocks safe delete.
          yield* Effect.gen(function* () {
            const devboxSql = yield* SqlClient.SqlClient;
            yield* devboxSql`
              DELETE FROM orchestration_v2_legacy_imports
            `;
            yield* devboxSql`
              INSERT INTO projection_threads (
                thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
                created_at, updated_at, deleted_at
              ) VALUES (
                'thread:unimported-v1', ${projId}, 'Unimported V1', '{}', 'full-access', 'default',
                '2026-11-27T10:00:00.000Z', '2026-11-27T10:00:00.000Z', NULL
              )
            `;
          }).pipe(Effect.provide(Layer.fresh(makeDbLayer(devboxDbPath, devboxUserdata))));

          const v1Busy = yield* Effect.flip(
            migration.migrateFromDevbox({
              name: "19-replay-box",
              expectDatabase: true,
              rejectActiveRuns: true,
              runSshBinary,
            }),
          );
          expect(v1Busy.reason).toBe("busy");
          expect(v1Busy.message).toContain("hydrating");
        }).pipe(Effect.provide(laptopLayer));
      }),
  );
});
