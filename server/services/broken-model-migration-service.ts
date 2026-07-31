import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { and, eq, gt, ne, type SQL } from "drizzle-orm";
import { db } from "../db";
import { narrators } from "../db/schema";
import { resolveProviderAndModel } from "../lib/agent/provider";
import { ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";
import { isNugCachedModelAvailable } from "../lib/nug-model-cache";
import {
	FOLLOW_DEFAULT_MODEL,
	FOLLOW_SUMMARY_MODEL,
	getNugProviderConfig,
	getVisibleModels,
	narraforkDir,
	parseAggModelValue,
	parseModelId,
} from "../lib/settings";

/**
 * Batch repair for narrators pinned to a model that can no longer run.
 *
 * `narrators.model` is a soft reference to a `provider:model` string. Renaming a
 * provider prefix is already handled by `provider-prefix-migration-service`, but
 * deleting or disabling a provider leaves every narrator that referenced it
 * pointing at a prefix that no longer resolves. This module finds those
 * narrators, migrates them to a model the user picks, and keeps a single-slot
 * undo record so a disabled-then-re-enabled provider is recoverable.
 */

const UNDO_VERSION = 1;
const UNDO_PATH = `${narraforkDir}/broken-model-migration-undo.json`;
/** Matches provider-prefix-migration-service so both scans yield the event loop alike. */
const SCAN_BATCH_SIZE = 250;
const MAX_SCANNED_NARRATORS = 100_000;
const MAX_REPORTED_NARRATORS = 5_000;

/**
 * Why a narrator's model was flagged.
 *
 * - `provider_missing`: `resolveProviderAndModel()` throws. The prefix is gone
 *   from settings or disabled, so this narrator definitely cannot run.
 * - `model_not_listed`: the provider resolves but the model id is absent from
 *   the model catalog. This is a suspicion, not proof: OpenAI-compatible
 *   gateways pass model ids through verbatim, so a hand-typed id that never
 *   appears in `/models` can still work. Never migrated by default.
 */
export type BrokenModelReason = "provider_missing" | "model_not_listed";

export interface BrokenModelNarrator {
	id: string;
	title: string | null;
	model: string;
	status: string;
	chapterId: string | null;
	/** True when `pendingModelRestore` would resurrect a broken model after a restart. */
	hasBrokenPendingRestore: boolean;
}

export interface BrokenModelGroup {
	/** Provider prefix parsed from the model reference; null when the value carries no prefix. */
	providerPrefix: string | null;
	reason: BrokenModelReason;
	/** Human-readable cause, e.g. the resolver error message. */
	detail: string;
	narrators: BrokenModelNarrator[];
}

export interface BrokenModelScanResult {
	groups: BrokenModelGroup[];
	/** Narrators whose provider cannot be resolved at all. */
	totalBroken: number;
	/** Narrators whose model is merely absent from the catalog. */
	totalSuspect: number;
	scanned: number;
	/** True when the scan hit its row budget and the result is partial. */
	truncated: boolean;
}

export interface BrokenModelMigrationResult {
	migrated: number;
	skipped: number;
	targetModel: string;
	undoAvailable: boolean;
}

export interface BrokenModelUndoResult {
	restored: number;
	skipped: number;
}

interface UndoEntry {
	id: string;
	beforeModel: string;
	beforePendingModelRestore: string | null;
	afterModel: string;
	clearedPendingModelRestore: boolean;
}

interface UndoRecord {
	version: typeof UNDO_VERSION;
	migratedAt: string;
	targetModel: string;
	entries: UndoEntry[];
}

/**
 * Meta references follow global configuration instead of naming a provider, so
 * removing one provider can never break them: `__default__` / `__summary__`
 * re-resolve through settings, and an aggregation drops disabled members.
 */
function isMetaModelValue(model: string): boolean {
	if (model === FOLLOW_DEFAULT_MODEL || model === FOLLOW_SUMMARY_MODEL) return true;
	if (parseAggModelValue(model)) return true;
	const parsed = parseModelId(model);
	return (
		!!parsed.provider &&
		(parsed.model === FOLLOW_DEFAULT_MODEL || parsed.model === FOLLOW_SUMMARY_MODEL)
	);
}

/** Resolution outcome for one persisted model reference. */
type ModelHealth = { state: "ok" } | { state: "broken"; reason: BrokenModelReason; detail: string };

/**
 * Classify a NUG model that is not in the visible catalog.
 *
 * A model flagged `available: false` is a transient outage already handled by
 * `markNugCachedModelUnavailable` + the availability poller, which suspends the
 * narrator until the model returns. Treating that as "needs migration" would
 * fight that recovery path, so only a model completely absent from the cache
 * (availability `undefined`) counts as suspicious.
 */
function isNugModelTransientlyUnavailable(model: string, providerPrefix: string): boolean {
	const config = getNugProviderConfig(providerPrefix);
	if (!config) return false;
	const bareModel = parseModelId(model).model;
	return isNugCachedModelAvailable(config.id, bareModel) === false;
}

function classifyModel(model: string, visibleModels: ReadonlySet<string>): ModelHealth {
	try {
		resolveProviderAndModel(model);
	} catch (error) {
		return {
			state: "broken",
			reason: "provider_missing",
			detail: error instanceof Error ? error.message : String(error),
		};
	}

	if (visibleModels.has(model)) return { state: "ok" };

	const providerPrefix = parseModelId(model).provider;
	if (providerPrefix && isNugModelTransientlyUnavailable(model, providerPrefix)) {
		return { state: "ok" };
	}

	return {
		state: "broken",
		reason: "model_not_listed",
		detail: `Model "${model}" is not in the current model catalog.`,
	};
}

function groupKey(providerPrefix: string | null, reason: BrokenModelReason): string {
	return `${reason}\u0000${providerPrefix ?? ""}`;
}

export async function scanBrokenModelNarrators(
	options: { includeArchived?: boolean } = {},
): Promise<BrokenModelScanResult> {
	// Subagents are excluded: their `model` is a snapshot of a task that already ran
	// (or is running) and is derived from `settings.agent.subagentModels` or the parent
	// narrator, so rewriting it retroactively neither revives finished work nor changes
	// what future subagents use.
	const baseConditions = [eq(narrators.type, "primary")];
	if (!options.includeArchived) baseConditions.push(ne(narrators.status, "archived"));

	// getVisibleModels() walks every provider lister, so resolve it once per scan
	// rather than per row.
	const visibleModels = new Set(getVisibleModels());

	const groups = new Map<string, BrokenModelGroup>();
	let totalBroken = 0;
	let totalSuspect = 0;
	let scanned = 0;
	let truncated = false;
	let lastId: string | null = null;

	for (;;) {
		const where: SQL | undefined = lastId
			? and(...baseConditions, gt(narrators.id, lastId))
			: and(...baseConditions);
		const rows = db
			.select({
				id: narrators.id,
				title: narrators.title,
				model: narrators.model,
				pendingModelRestore: narrators.pendingModelRestore,
				status: narrators.status,
				chapterId: narrators.chapterId,
			})
			.from(narrators)
			.where(where)
			.orderBy(narrators.id)
			.limit(SCAN_BATCH_SIZE)
			.all();
		if (rows.length === 0) break;
		scanned += rows.length;

		for (const row of rows) {
			const model = row.model?.trim();
			if (!model || isMetaModelValue(model)) continue;

			const health = classifyModel(model, visibleModels);
			if (health.state === "ok") continue;

			if (health.reason === "provider_missing") totalBroken++;
			else totalSuspect++;

			if (totalBroken + totalSuspect > MAX_REPORTED_NARRATORS) {
				truncated = true;
				continue;
			}

			const pending = row.pendingModelRestore?.trim();
			const providerPrefix = parseModelId(model).provider ?? null;
			const key = groupKey(providerPrefix, health.reason);
			const group = groups.get(key);
			const entry: BrokenModelNarrator = {
				id: row.id,
				title: row.title,
				model,
				status: row.status,
				chapterId: row.chapterId,
				hasBrokenPendingRestore:
					!!pending &&
					!isMetaModelValue(pending) &&
					classifyModel(pending, visibleModels).state === "broken",
			};
			if (group) group.narrators.push(entry);
			else {
				groups.set(key, {
					providerPrefix,
					reason: health.reason,
					detail: health.detail,
					narrators: [entry],
				});
			}
		}

		lastId = rows.at(-1)?.id ?? null;
		if (rows.length < SCAN_BATCH_SIZE) break;
		if (scanned >= MAX_SCANNED_NARRATORS) {
			truncated = true;
			break;
		}
		// Keep the main thread responsive: this scan runs alongside HTTP/WS traffic.
		await new Promise<void>((resolve) => setImmediate(resolve));
	}

	return {
		// provider_missing first so the UI lists definite breakage above suspicions.
		groups: [...groups.values()].sort((a, b) =>
			a.reason === b.reason
				? (a.providerPrefix ?? "").localeCompare(b.providerPrefix ?? "")
				: a.reason === "provider_missing"
					? -1
					: 1,
		),
		totalBroken,
		totalSuspect,
		scanned,
		truncated,
	};
}

function writeUndoRecord(record: UndoRecord): void {
	mkdirSync(narraforkDir, { recursive: true });
	const tempPath = `${UNDO_PATH}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(tempPath, JSON.stringify(record), { mode: 0o600 });
		renameSync(tempPath, UNDO_PATH);
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
}

function readUndoRecord(): UndoRecord | null {
	if (!existsSync(UNDO_PATH)) return null;
	try {
		const parsed = JSON.parse(readFileSync(UNDO_PATH, "utf8")) as Partial<UndoRecord>;
		if (parsed.version !== UNDO_VERSION || !Array.isArray(parsed.entries)) return null;
		return parsed as UndoRecord;
	} catch (error) {
		logger.warn("Failed to read broken-model migration undo record", {
			path: UNDO_PATH,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

export function hasBrokenModelMigrationUndo(): boolean {
	return !!readUndoRecord();
}

/**
 * Durable half of a migration: rewrite each candidate under optimistic concurrency.
 *
 * A row whose `model` no longer matches what the scan observed was changed by
 * someone else in the meantime, so it is skipped rather than overwritten. This is a
 * user-initiated bulk edit, so one racing row must not roll back the whole batch.
 *
 * Exported for tests: it is the only place the concurrency rule lives, and driving
 * it directly is the only way to observe a mid-flight change deterministically.
 */
export function applyModelMigration(
	candidates: readonly BrokenModelNarrator[],
	targetModel: string,
): { entries: UndoEntry[]; skipped: number } {
	const entries: UndoEntry[] = [];
	let skipped = 0;

	db.transaction((tx) => {
		for (const candidate of candidates) {
			const current = tx
				.select({
					model: narrators.model,
					pendingModelRestore: narrators.pendingModelRestore,
				})
				.from(narrators)
				.where(eq(narrators.id, candidate.id))
				.get();
			if (!current || current.model !== candidate.model) {
				skipped++;
				continue;
			}
			// A broken pendingModelRestore must be cleared, otherwise the next restart's
			// restorePendingModelOverrides() writes the broken model back into `model`
			// and silently undoes this migration.
			const clearPending = candidate.hasBrokenPendingRestore;
			tx.update(narrators)
				.set({
					model: targetModel,
					...(clearPending ? { pendingModelRestore: null } : {}),
					updatedAt: new Date().toISOString(),
				})
				.where(eq(narrators.id, candidate.id))
				.run();
			entries.push({
				id: candidate.id,
				beforeModel: candidate.model,
				beforePendingModelRestore: current.pendingModelRestore ?? null,
				afterModel: targetModel,
				clearedPendingModelRestore: clearPending,
			});
		}
	});

	return { entries, skipped };
}

export async function migrateBrokenModelNarrators(input: {
	targetModel: string;
	narratorIds: string[];
	includeArchived?: boolean;
}): Promise<BrokenModelMigrationResult> {
	const targetModel = input.targetModel.trim();
	if (!targetModel) throw new ValidationError("targetModel is required");
	if (input.narratorIds.length === 0) {
		throw new ValidationError("At least one narrator must be selected");
	}

	// Never move narrators from one unusable model to another. Meta references are
	// accepted as-is: they follow global settings and are validated there.
	if (!isMetaModelValue(targetModel)) {
		try {
			resolveProviderAndModel(targetModel);
		} catch (error) {
			throw new ValidationError(
				`Target model "${targetModel}" cannot be used: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	// Re-scan and intersect: the user may have fixed or changed some narrators
	// between opening the dialog and confirming.
	const scan = await scanBrokenModelNarrators({ includeArchived: input.includeArchived });
	const stillBroken = new Map<string, BrokenModelNarrator>();
	for (const group of scan.groups) {
		for (const narrator of group.narrators) stillBroken.set(narrator.id, narrator);
	}

	const requested = new Set(input.narratorIds);
	const candidates = [...requested]
		.map((id) => stillBroken.get(id))
		.filter((entry): entry is BrokenModelNarrator => !!entry)
		.filter((entry) => entry.model !== targetModel);

	const applied = applyModelMigration(candidates, targetModel);
	const entries = applied.entries;
	const skipped = requested.size - candidates.length + applied.skipped;

	if (entries.length > 0) {
		writeUndoRecord({
			version: UNDO_VERSION,
			migratedAt: new Date().toISOString(),
			targetModel,
			entries,
		});
	}

	// Sync in-memory sessions and notify subscribers after the durable write.
	if (entries.length > 0) {
		const { updateNarratorModel } = await import("./narrator-session");
		for (const entry of entries) updateNarratorModel(entry.id, targetModel);
	}

	logger.info("Migrated narrators off an unusable model", {
		targetModel,
		migrated: entries.length,
		skipped,
	});

	return {
		migrated: entries.length,
		skipped,
		targetModel,
		undoAvailable: entries.length > 0,
	};
}

/**
 * Restore the most recent migration.
 *
 * Only rows still holding the migrated-to model are reverted: anything the user
 * changed afterwards is their newer choice and must not be overwritten. Exactly
 * one migration is retained — this is a mistake-undo, not a history feature.
 */
export async function undoLastBrokenModelMigration(): Promise<BrokenModelUndoResult> {
	const record = readUndoRecord();
	if (!record) throw new ValidationError("There is no migration to undo");

	const restoredIds: UndoEntry[] = [];
	let skipped = 0;

	db.transaction((tx) => {
		for (const entry of record.entries) {
			const current = tx
				.select({ model: narrators.model })
				.from(narrators)
				.where(eq(narrators.id, entry.id))
				.get();
			if (!current || current.model !== entry.afterModel) {
				skipped++;
				continue;
			}
			tx.update(narrators)
				.set({
					model: entry.beforeModel,
					...(entry.clearedPendingModelRestore
						? { pendingModelRestore: entry.beforePendingModelRestore }
						: {}),
					updatedAt: new Date().toISOString(),
				})
				.where(eq(narrators.id, entry.id))
				.run();
			restoredIds.push(entry);
		}
	});

	rmSync(UNDO_PATH, { force: true });

	if (restoredIds.length > 0) {
		const { updateNarratorModel } = await import("./narrator-session");
		for (const entry of restoredIds) updateNarratorModel(entry.id, entry.beforeModel);
	}

	logger.info("Undid a broken-model migration", {
		targetModel: record.targetModel,
		restored: restoredIds.length,
		skipped,
	});

	return { restored: restoredIds.length, skipped };
}
