import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { eq, gt } from "drizzle-orm";
import { db } from "../db";
import { narrators } from "../db/schema";
import { logger } from "../lib/logger";
import {
	type NarraForkSettings,
	narraforkDir,
	type ProviderPrefixChange,
	rewriteModelReference,
	saveSettings,
	settings,
} from "../lib/settings";

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
		const rows = db
			.select({
				id: narrators.id,
				model: narrators.model,
				pendingModelRestore: narrators.pendingModelRestore,
			})
			.from(narrators)
			.where(lastId ? gt(narrators.id, lastId) : undefined)
			.orderBy(narrators.id)
			.limit(SCAN_BATCH_SIZE)
			.all();
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

function applyNarratorChanges(
	rows: ProviderPrefixNarratorChange[],
	direction: "before" | "after",
): void {
	if (rows.length === 0) return;
	db.transaction((tx) => {
		for (const row of rows) {
			const current = tx
				.select({
					model: narrators.model,
					pendingModelRestore: narrators.pendingModelRestore,
				})
				.from(narrators)
				.where(eq(narrators.id, row.id))
				.get();
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
			tx.update(narrators)
				.set({ model: targetModel, pendingModelRestore: targetPending })
				.where(eq(narrators.id, row.id))
				.run();
		}
	});
}

export function commitProviderPrefixMigration(
	previousSettings: NarraForkSettings,
	nextSettings: NarraForkSettings,
	plan: ProviderPrefixMigrationPlan,
): ProviderPrefixNarratorChange[] {
	if (plan.changes.length === 0 || plan.narrators.length === 0) {
		saveSettings(nextSettings);
		return [];
	}
	writeJournal(plan);
	try {
		applyNarratorChanges(plan.narrators, "after");
		saveSettings(nextSettings);
		rmSync(JOURNAL_PATH, { force: true });
		return plan.narrators;
	} catch (error) {
		try {
			applyNarratorChanges(plan.narrators, "before");
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

function providerPrefixForId(config: NarraForkSettings, id: string): string | null {
	for (const provider of [
		...(config.customApiProviders ?? []),
		...(config.nugProviders ?? []),
		...(config.clineProviders ?? []),
	]) {
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

export function recoverProviderPrefixMigrationOnStartup(): void {
	if (!existsSync(JOURNAL_PATH)) return;
	const journal = parseJournal(JSON.parse(readFileSync(JOURNAL_PATH, "utf8")));
	const usesAfter = journal.changes.every(
		(change) => providerPrefixForId(settings, change.id) === change.to,
	);
	const usesBefore = journal.changes.every(
		(change) => providerPrefixForId(settings, change.id) === change.from,
	);
	if (usesAfter) {
		applyNarratorChanges(journal.narrators, "after");
	} else if (usesBefore) {
		applyNarratorChanges(journal.narrators, "before");
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
