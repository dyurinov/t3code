// @effect-diagnostics nodeBuiltinImport:off - bounded gunzip uses node:zlib.
import * as NodeZlib from "node:zlib";

import { UsageProviderKind, type UsageSource } from "@t3tools/contracts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { BUILT_IN_USAGE_DRIVERS } from "../provider/builtInDrivers.ts";
import { antigravityRateModel } from "../provider/Drivers/antigravityUsageReader.ts";
import { decodeScanCache } from "../usage/usageScanCache.ts";

const DEVBOX_USAGE_ARCHIVE_DIR = "devbox-usage";
const DEVBOX_USAGE_ARCHIVE_PREFIX = "devbox://";
const MAX_USAGE_EXPORT_BYTES = 64 * 1024 * 1024;

const transcriptFormats = new Map(
  BUILT_IN_USAGE_DRIVERS.flatMap((driver) =>
    driver.usage?.kind === "transcripts"
      ? [[driver.usage.provider, driver.usage.format] as const]
      : [],
  ),
);

export function devboxArchiveDirPath(boxName: string, remoteDir: string): string {
  const normalized = remoteDir.startsWith("/") ? remoteDir : `/${remoteDir}`;
  return `${DEVBOX_USAGE_ARCHIVE_PREFIX}${boxName}${normalized}`;
}

const ArchiveTokenTotalsSchema = Schema.Struct({
  uncachedInputTokens: Schema.Number,
  cachedInputTokens: Schema.Number,
  cacheCreationTokens: Schema.Number,
  outputTokens: Schema.Number,
  reasoningTokens: Schema.Number,
});

const ArchiveSpeedSchema = Schema.Literals(["standard", "fast", "ultrafast"]);

const ArchiveUsageRecordSchema = Schema.Struct({
  provider: UsageProviderKind,
  timestampMs: Schema.Number,
  model: Schema.String,
  rateModel: Schema.optionalKey(Schema.String),
  sessionId: Schema.String,
  totals: ArchiveTokenTotalsSchema,
  cacheCreation1hTokens: Schema.optionalKey(Schema.Number),
  reportedCostUsd: Schema.NullOr(Schema.Number),
  speed: ArchiveSpeedSchema,
  regionalEndpoint: Schema.optionalKey(Schema.Boolean),
  modelCalls: Schema.optionalKey(Schema.Number),
  dedupeKey: Schema.NullOr(Schema.String),
});

const ArchiveSourceSchema = Schema.Struct({
  provider: UsageProviderKind,
  hostId: Schema.String,
  dir: Schema.String,
  volumeId: Schema.String,
  records: Schema.Array(ArchiveUsageRecordSchema),
});

const DevboxUsageArchiveSchema = Schema.Struct({
  version: Schema.Literal(1),
  boxName: Schema.String,
  environmentId: Schema.NullOr(Schema.String),
  capturedAtMs: Schema.Number,
  sources: Schema.Array(ArchiveSourceSchema),
});
type DevboxUsageArchive = typeof DevboxUsageArchiveSchema.Type;
type DevboxUsageArchiveSource = typeof ArchiveSourceSchema.Type;

const decodeArchiveJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(DevboxUsageArchiveSchema),
);
const encodeArchiveJson = Schema.encodeEffect(Schema.fromJsonString(DevboxUsageArchiveSchema));

const ExportAntigravitySourceSchema = Schema.Struct({
  dir: Schema.String,
  volumeId: Schema.String,
  records: Schema.Array(ArchiveUsageRecordSchema),
});

const ExportPayloadSchema = Schema.Struct({
  hostId: Schema.String,
  scanCache: Schema.NullOr(Schema.Unknown),
  antigravity: Schema.Array(ExportAntigravitySourceSchema),
});

const decodeExportPayload = Schema.decodeUnknownOption(Schema.fromJsonString(ExportPayloadSchema));

const ScanCacheSourcesSchema = Schema.Struct({
  sources: Schema.Record(
    Schema.String,
    Schema.Struct({
      dir: Schema.String,
      volumeId: Schema.String,
    }),
  ),
});
const decodeScanCacheSources = Schema.decodeUnknownOption(ScanCacheSourcesSchema);

function recordMergeKey(record: UsageRecord): string {
  if (record.dedupeKey !== null && record.dedupeKey.length > 0) return `k:${record.dedupeKey}`;
  return `v:${record.provider}:${record.sessionId}:${record.timestampMs}:${record.model}:${record.totals.uncachedInputTokens}:${record.totals.cachedInputTokens}:${record.totals.cacheCreationTokens}:${record.totals.outputTokens}:${record.totals.reasoningTokens}`;
}

function toStoredRecord(record: UsageRecord): typeof ArchiveUsageRecordSchema.Type {
  return {
    provider: record.provider,
    timestampMs: record.timestampMs,
    model: record.model,
    ...(record.rateModel === undefined ? {} : { rateModel: record.rateModel }),
    sessionId: record.sessionId,
    totals: {
      uncachedInputTokens: record.totals.uncachedInputTokens,
      cachedInputTokens: record.totals.cachedInputTokens,
      cacheCreationTokens: record.totals.cacheCreationTokens,
      outputTokens: record.totals.outputTokens,
      reasoningTokens: record.totals.reasoningTokens,
    },
    ...(record.cacheCreation1hTokens === undefined
      ? {}
      : { cacheCreation1hTokens: record.cacheCreation1hTokens }),
    reportedCostUsd: record.reportedCostUsd,
    speed: record.speed,
    ...(record.regionalEndpoint === true ? { regionalEndpoint: true } : {}),
    ...(record.modelCalls === undefined ? {} : { modelCalls: record.modelCalls }),
    dedupeKey: record.dedupeKey,
  };
}

function isWithinDir(filePath: string, dir: string): boolean {
  if (filePath === dir) return true;
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  return filePath.startsWith(prefix);
}

function mergeSources(
  existing: ReadonlyArray<DevboxUsageArchiveSource>,
  incoming: ReadonlyArray<DevboxUsageArchiveSource>,
): ReadonlyArray<DevboxUsageArchiveSource> {
  const byKey = new Map<
    string,
    {
      provider: UsageProviderKind;
      hostId: string;
      dir: string;
      volumeId: string;
      records: Map<string, typeof ArchiveUsageRecordSchema.Type>;
    }
  >();
  const add = (source: DevboxUsageArchiveSource) => {
    const key = `${source.provider}\u0000${source.dir}`;
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = {
        provider: source.provider,
        hostId: source.hostId,
        dir: source.dir,
        volumeId: source.volumeId,
        records: new Map(),
      };
      byKey.set(key, entry);
    } else {
      entry.hostId = source.hostId;
      if (source.volumeId) entry.volumeId = source.volumeId;
    }
    for (const record of source.records) {
      entry.records.set(recordMergeKey(record), record);
    }
  };
  for (const source of existing) add(source);
  for (const source of incoming) add(source);
  return [...byKey.values()]
    .filter((entry) => entry.records.size > 0)
    .map((entry) => ({
      provider: entry.provider,
      hostId: entry.hostId,
      dir: entry.dir,
      volumeId: entry.volumeId,
      records: [...entry.records.values()],
    }));
}

export function extractArchiveSourcesFromExport(
  gzippedBytes: Uint8Array,
): ReadonlyArray<DevboxUsageArchiveSource> | null {
  let jsonText: string;
  try {
    jsonText = NodeZlib.gunzipSync(gzippedBytes, {
      maxOutputLength: MAX_USAGE_EXPORT_BYTES,
    }).toString("utf8");
  } catch {
    return null;
  }
  const parsed = decodeExportPayload(jsonText);
  if (Option.isNone(parsed)) return null;
  const { hostId, scanCache, antigravity } = parsed.value;
  const sources: Array<DevboxUsageArchiveSource> = [];

  for (const agy of antigravity) {
    if (agy.records.length === 0) continue;
    sources.push({
      provider: "antigravity",
      hostId,
      dir: agy.dir,
      volumeId: agy.volumeId,
      records: agy.records.map((record) => {
        const rateModel = antigravityRateModel(record.model);
        return rateModel === record.model ? record : { ...record, rateModel };
      }),
    });
  }

  if (scanCache !== null) {
    const decodedFiles = decodeScanCache(scanCache, transcriptFormats);
    const decodedSources = decodeScanCacheSources(scanCache);
    const sourceMeta: Array<{
      readonly provider: UsageProviderKind;
      readonly dir: string;
      readonly volumeId: string;
    }> = [];
    if (Option.isSome(decodedSources)) {
      for (const [key, value] of Object.entries(decodedSources.value.sources)) {
        const sep = key.indexOf("\0");
        if (sep <= 0) continue;
        const provider = key.slice(0, sep) as UsageProviderKind;
        // Cursor usage is account-global via cursor.com, so archiving per-box is unnecessary.
        if (provider === "cursor") continue;
        sourceMeta.push({ provider, dir: value.dir, volumeId: value.volumeId });
      }
    }
    const recordsBySource = new Map<
      string,
      {
        readonly provider: UsageProviderKind;
        readonly dir: string;
        readonly volumeId: string;
        readonly records: Array<typeof ArchiveUsageRecordSchema.Type>;
      }
    >();
    for (const [filePath, entry] of decodedFiles) {
      if (entry.provider === "cursor") continue;
      const matched = sourceMeta.find(
        (candidate) =>
          candidate.provider === entry.provider && isWithinDir(filePath, candidate.dir),
      );
      const dir = matched?.dir ?? filePath.slice(0, Math.max(1, filePath.lastIndexOf("/")));
      const volumeId = matched?.volumeId ?? "";
      const key = `${entry.provider}\u0000${dir}`;
      let bucket = recordsBySource.get(key);
      if (bucket === undefined) {
        bucket = { provider: entry.provider, dir, volumeId, records: [] };
        recordsBySource.set(key, bucket);
      }
      for (const record of entry.records) bucket.records.push(toStoredRecord(record));
      for (const record of entry.tailRecords) bucket.records.push(toStoredRecord(record));
    }
    for (const bucket of recordsBySource.values()) {
      if (bucket.records.length === 0) continue;
      sources.push({
        provider: bucket.provider,
        hostId,
        dir: bucket.dir,
        volumeId: bucket.volumeId,
        records: bucket.records,
      });
    }
  }

  return sources;
}

const safeBoxFileName = (boxName: string) => `${boxName.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;

export const saveDevboxUsageArchive = Effect.fn("DevboxUsageArchive.save")(function* (input: {
  readonly stateDir: string;
  readonly boxName: string;
  readonly environmentId: string | null;
  readonly gzippedBytes: Uint8Array;
  readonly capturedAtMs: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const incoming = extractArchiveSourcesFromExport(input.gzippedBytes);
  if (incoming === null || incoming.length === 0) return false;
  const dir = path.join(input.stateDir, DEVBOX_USAGE_ARCHIVE_DIR);
  const filePath = path.join(dir, safeBoxFileName(input.boxName));
  const existing = yield* fs.readFileString(filePath).pipe(
    Effect.map((raw) => Option.getOrUndefined(decodeArchiveJson(raw))?.sources ?? []),
    Effect.orElseSucceed((): ReadonlyArray<DevboxUsageArchiveSource> => []),
  );
  const merged = mergeSources(existing, incoming);
  if (merged.length === 0) return false;
  const archive: DevboxUsageArchive = {
    version: 1,
    boxName: input.boxName,
    environmentId: input.environmentId,
    capturedAtMs: input.capturedAtMs,
    sources: merged,
  };
  const encoded = yield* encodeArchiveJson(archive);
  yield* writeFileStringAtomically({ filePath, contents: `${encoded}\n` });
  return true;
});

interface ArchivedScannedDir {
  readonly provider: UsageProviderKind;
  readonly dir: string;
  readonly volumeId: string;
  readonly hostId: string;
  readonly files: readonly {
    readonly path: string;
    readonly records: readonly UsageRecord[];
    readonly malformedRecords: readonly number[];
  }[];
  readonly status: UsageSource["status"];
}

export const readDevboxUsageArchives = Effect.fn("DevboxUsageArchive.readAll")(function* (input: {
  readonly stateDir: string;
  readonly allowedProviders: ReadonlySet<UsageProviderKind>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (input.allowedProviders.size === 0) return [];
  const dir = path.join(input.stateDir, DEVBOX_USAGE_ARCHIVE_DIR);
  const names = yield* fs
    .readDirectory(dir)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const scanned: Array<ArchivedScannedDir> = [];
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(dir, name);
    const raw = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => null));
    if (raw === null) continue;
    const parsed = decodeArchiveJson(raw);
    if (Option.isNone(parsed)) continue;
    const archive = parsed.value;
    for (const source of archive.sources) {
      if (!input.allowedProviders.has(source.provider)) continue;
      if (source.records.length === 0) continue;
      scanned.push({
        provider: source.provider,
        dir: devboxArchiveDirPath(archive.boxName, source.dir),
        volumeId: source.volumeId,
        hostId: source.hostId,
        files: [
          {
            path: filePath,
            records: source.records as ReadonlyArray<UsageRecord>,
            malformedRecords: [],
          },
        ],
        status: "ok",
      });
    }
  }
  return scanned;
});
