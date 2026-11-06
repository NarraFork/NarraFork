import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { narrators } from "../db/schema";
import { logger } from "../lib/logger";
import {
	getProviderPrefixChanges,
	migrateProviderPrefixReferences,
	type NarraForkSettings,
	narraforkDir,
	normalizeCustomApiProviderSettings,
	type ProviderPrefixChange,
	rewriteModelReference,
	saveSettings,
	settings,
} from "../lib/settings";
import { allRows, applyUpdates, firstRow, type PlannedUpdate, selectFrom } from "./migration-db";

const JOURNAL_VERSION = 1;
const JOURNAL_PATH = `${narraforkDir}/provider-prefix-migration.json`;
const SCAN_BATCH_SIZE = 250;
const MAX_SCANNED_NARRATORS = 100_000;
const MAX_CHANGED_NARRATORS = 10_000;

export interface ProviderPrefixNarratorChange {
	id: string;
	beforeModel: string | null;
	afterModel: string | null;
	beforePendingModelRestore: string | null;
	afterPendingModelRestore: string | null;
}

export interface ProviderPrefixMigrationPlan {
	changes: ProviderPrefixChange[];
	narrators: ProviderPrefixNarratorChange[];
}

interface ProviderPrefixMigrationJournal extends ProviderPrefixMigrationPlan {
	version: typeof JOURNAL_VERSION;
}

function rewriteNullableModel(value: string | null, prefixMap: Map<string, string>): string | null {
	return value == null ? null : rewriteModelReference(value, prefixMap);
}

export async function planProviderPrefixNarratorMigration(
	changes: ProviderPrefixChange[],
): Promise<ProviderPrefixMigrationPlan> {
	const prefixMap = new Map(changes.map((change) => [change.from, change.to]));
	if (prefixMap.size === 0) return { changes, narrators: [] };

	const affected: ProviderPrefixNarratorChange[] = [];
	let lastId: string | null = null;
	let scanned = 0;
	for (;;) {
		const rows: Array<{
			id: string;
			model: string | null;
			pendingModelRestore: string | null;
		}> = await allRows(
			selectFrom(narrators, {
				id: narrators.id,
				model: narrators.model,
				pendingModelRestore: narrators.pendingModelRestore,
			})
				.where(lastId ? gt(narrators.id, lastId) : undefined)
				.orderBy(narrators.id)
				.limit(SCAN_BATCH_SIZE),
		);
		if (rows.length === 0) break;
		scanned += rows.length;
		if (scanned > MAX_SCANNED_NARRATORS) {
			throw new Error(`Provider prefix migration scan exceeded ${MAX_SCANNED_NARRATORS} narrators`);
		}
		for (const row of rows) {
			const afterModel = rewriteNullableModel(row.model, prefixMap);
			const afterPendingModelRestore = rewriteNullableModel(row.pendingModelRestore, prefixMap);
			if (afterModel === row.model && afterPendingModelRestore === row.pendingModelRestore)
				continue;
			affected.push({
				id: row.id,
				beforeModel: row.model,
				afterModel,
				beforePendingModelRestore: row.pendingModelRestore,
				afterPendingModelRestore,
			});
			if (affected.length > MAX_CHANGED_NARRATORS) {
				throw new Error(
					`Provider prefix migration exceeded ${MAX_CHANGED_NARRATORS} affected narrators`,
				);
			}
		}
		lastId = rows.at(-1)?.id ?? null;
		if (rows.length < SCAN_BATCH_SIZE) break;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	return { changes, narrators: affected };
}

function writeJournal(plan: ProviderPrefixMigrationPlan): void {
	mkdirSync(narraforkDir, { recursive: true });
	const tempPath = `${JOURNAL_PATH}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(
			tempPath,
			JSON.stringify({
				version: JOURNAL_VERSION,
				...plan,
			} satisfies ProviderPrefixMigrationJournal),
			{ mode: 0o600 },
		);
		renameSync(tempPath, JOURNAL_PATH);
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
}

/** `= value`, or IS NULL for a nullable model column (null never equals null in SQL). */
function matches(column: SQLiteColumn, value: string | null) {
	return value === null ? isNull(column) : eq(column, value);
}

async function applyNarratorChanges(
	rows: ProviderPrefixNarratorChange[],
	direction: "before" | "after",
): Promise<void> {
	if (rows.length === 0) return;
	const updates: PlannedUpdate[] = [];
	for (const row of rows) {
		const current = await firstRow<{
			model: string | null;
			pendingModelRestore: string | null;
		}>(
			selectFrom(narrators, {
				model: narrators.model,
				pendingModelRestore: narrators.pendingModelRestore,
			}).where(eq(narrators.id, row.id)),
		);
		if (!current) continue;
		const sourceModel = direction === "after" ? row.beforeModel : row.afterModel;
		const sourcePending =
			direction === "after" ? row.beforePendingModelRestore : row.afterPendingModelRestore;
		const targetModel = direction === "after" ? row.afterModel : row.beforeModel;
		const targetPending =
			direction === "after" ? row.afterPendingModelRestore : row.beforePendingModelRestore;
		if (current.model === targetModel && current.pendingModelRestore === targetPending) continue;
		if (current.model !== sourceModel || current.pendingModelRestore !== sourcePending) {
			throw new Error(`Narrator ${row.id} changed while provider prefixes were being migrated`);
		}
		updates.push({
			table: narrators,
			set: { model: targetModel, pendingModelRestore: targetPending },
			// The guard is in the UPDATE too, so a row changed after the read is not overwritten.
			where: and(
				eq(narrators.id, row.id),
				matches(narrators.model, sourceModel),
				matches(narrators.pendingModelRestore, sourcePending),
			),
		});
	}
	const applied = await applyUpdates(updates);
	if (applied !== updates.length) {
		throw new Error("A narrator changed while provider prefixes were being migrated");
	}
}

export async function commitProviderPrefixMigration(
	previousSettings: NarraForkSettings,
	nextSettings: NarraForkSettings,
	plan: ProviderPrefixMigrationPlan,
): Promise<ProviderPrefixNarratorChange[]> {
	if (plan.changes.length === 0 || plan.narrators.length === 0) {
		saveSettings(nextSettings);
		return [];
	}
	writeJournal(plan);
	try {
		await applyNarratorChanges(plan.narrators, "after");
		saveSettings(nextSettings);
		rmSync(JOURNAL_PATH, { force: true });
		return plan.narrators;
	} catch (error) {
		try {
			await applyNarratorChanges(plan.narrators, "before");
			// saveSettings is atomic; this is only needed if a future implementation can
			// fail after replacing the file but before updating the in-memory singleton.
			if (settings !== previousSettings) saveSettings(previousSettings);
			rmSync(JOURNAL_PATH, { force: true });
		} catch (rollbackError) {
			logger.error("Provider prefix migration rollback failed; journal retained", {
				error: String(error),
				rollbackError: String(rollbackError),
				journalPath: JOURNAL_PATH,
			});
		}
		throw error;
	}
}

/**
 * `auto` became a reserved prefix (`auto:<model>`). A provider created before that keeps
 * working as an ordinary prefix until renamed; this renames it on startup to the first
 * free `auto-N`, moving every settings and narrator reference with it (same journal and
 * rollback as a rename from the settings page). Returns the changes made.
 */
export async function migrateReservedAutoPrefixOnStartup(): Promise<ProviderPrefixChange[]> {
	const custom = settings.customApiProviders ?? [];
	const nug = settings.nugProviders ?? [];
	if (![...custom, ...nug].some((provider) => provider.prefix === "auto")) return [];

	const taken = new Set(
		[...custom, ...nug].map((provider) => provider.prefix).filter((prefix) => !!prefix),
	);
	let n = 2;
	while (taken.has(`auto-${n}`)) n++;
	const renamed = `auto-${n}`;
	const rename = <T extends { prefix?: string }>(provider: T): T =>
		provider.prefix === "auto" ? { ...provider, prefix: renamed } : provider;

	const next = structuredClone(settings) as NarraForkSettings;
	next.customApiProviders = custom.map(rename);
	next.nugProviders = nug.map(rename);
	// Rebuilds the split openai/anthropic/gemini arrays from the renamed customApiProviders.
	normalizeCustomApiProviderSettings(next);

	const changes = getProviderPrefixChanges(
		[settings.customApiProviders, settings.nugProviders],
		[next.customApiProviders, next.nugProviders],
	);
	migrateProviderPrefixReferences(next, changes);
	const plan = await planProviderPrefixNarratorMigration(changes);
	await commitProviderPrefixMigration(settings, next, plan);
	logger.warn("Renamed a provider prefixed `auto`, which is now reserved for auto:<model>", {
		to: renamed,
		changes,
		narrators: plan.narrators.length,
	});
	return changes;
}

function providerPrefixForId(config: NarraForkSettings, id: string): string | null {
	for (const provider of [...(config.customApiProviders ?? []), ...(config.nugProviders ?? [])]) {
		if (provider.id === id) return provider.prefix ?? null;
	}
	return null;
}

function parseJournal(value: unknown): ProviderPrefixMigrationJournal {
	if (!value || typeof value !== "object") throw new Error("Invalid provider prefix journal");
	const journal = value as Partial<ProviderPrefixMigrationJournal>;
	if (
		journal.version !== JOURNAL_VERSION ||
		!Array.isArray(journal.changes) ||
		!Array.isArray(journal.narrators)
	) {
		throw new Error("Invalid provider prefix journal");
	}
	return journal as ProviderPrefixMigrationJournal;
}

export async function recoverProviderPrefixMigrationOnStartup(): Promise<void> {
	if (!existsSync(JOURNAL_PATH)) return;
	const journal = parseJournal(JSON.parse(readFileSync(JOURNAL_PATH, "utf8")));
	const usesAfter = journal.changes.every(
		(change) => providerPrefixForId(settings, change.id) === change.to,
	);
	const usesBefore = journal.changes.every(
		(change) => providerPrefixForId(settings, change.id) === change.from,
	);
	if (usesAfter) {
		await applyNarratorChanges(journal.narrators, "after");
	} else if (usesBefore) {
		await applyNarratorChanges(journal.narrators, "before");
	} else {
		throw new Error("Provider prefix migration journal does not match current settings");
	}
	rmSync(JOURNAL_PATH, { force: true });
	logger.info("Recovered interrupted provider prefix migration", {
		direction: usesAfter ? "after" : "before",
		changes: journal.changes,
		narrators: journal.narrators.length,
	});
}
