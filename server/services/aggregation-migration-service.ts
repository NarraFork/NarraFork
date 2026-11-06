/**
 * Move every `__agg__:<id>` model value to `auto:<model>` or `<prefix>:<model>`
 * (docs/PROVIDER-SOURCING-DESIGN.md §11; rules in shared/aggregation-migration.ts).
 *
 * Runs once at startup, in the background. Covered: the model fields of settings.agent and
 * search channels, `narrators.model` / `pending_model_restore`, `scheduled_tasks.model` and
 * `hooks.model`. The aggregations themselves stay in settings (read-only in the UI) so a
 * value that could not move — its aggregation was deleted — keeps resolving as before.
 *
 * Rows are scanned in id-ordered batches that yield to the event loop. The plan is written to
 * a journal before anything changes; table rows are updated in one transaction that checks
 * each row still holds the value it was planned from, then settings are saved. If either
 * step fails the rows are put back. A journal left by a crash is replayed or undone on the
 * next start, depending on whether settings were already saved.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import {
	AGGREGATION_VALUE_PREFIX,
	type AggregationForMigration,
	type AggregationMigration,
	migrateAggregationValue,
} from "@shared/aggregation-migration";
import { and, eq, gt, like } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { hooks, narrators, scheduledTasks } from "../db/schema";
import { logger } from "../lib/logger";
import { identifyModelValue } from "../lib/model-catalog";
import {
	type NarraForkSettings,
	narraforkDir,
	parseModelId,
	saveSettings,
	settings,
} from "../lib/settings";
import { allRows, applyUpdates, type PlannedUpdate, selectFrom } from "./migration-db";

const JOURNAL_VERSION = 1;
const JOURNAL_PATH = `${narraforkDir}/aggregation-migration.json`;
const SCAN_BATCH_SIZE = 250;
const MAX_CHANGED_ROWS = 50_000;

type TableName = "narrators" | "scheduled_tasks" | "hooks";
type ColumnName = "model" | "pending_model_restore";

export interface AggregationRowChange {
	table: TableName;
	column: ColumnName;
	id: string;
	before: string;
	after: string;
}

export interface AggregationMigrationPlan {
	rows: AggregationRowChange[];
	/** Settings with every movable aggregation value replaced; null when nothing changes. */
	settings: NarraForkSettings | null;
	/** Values whose aggregation no longer exists; left as they are. */
	unresolved: number;
}

interface Journal {
	version: typeof JOURNAL_VERSION;
	rows: AggregationRowChange[];
}

interface ColumnTarget {
	table: TableName;
	column: ColumnName;
	source: SQLiteTable;
	id: SQLiteColumn;
	value: SQLiteColumn;
	/** The Drizzle property that `value` maps to, for `.set()`. */
	property: "model" | "pendingModelRestore";
}

const TARGETS: readonly ColumnTarget[] = [
	{
		table: "narrators",
		column: "model",
		source: narrators,
		id: narrators.id,
		value: narrators.model,
		property: "model",
	},
	{
		table: "narrators",
		column: "pending_model_restore",
		source: narrators,
		id: narrators.id,
		value: narrators.pendingModelRestore,
		property: "pendingModelRestore",
	},
	{
		table: "scheduled_tasks",
		column: "model",
		source: scheduledTasks,
		id: scheduledTasks.id,
		value: scheduledTasks.model,
		property: "model",
	},
	{
		table: "hooks",
		column: "model",
		source: hooks,
		id: hooks.id,
		value: hooks.model,
		property: "model",
	},
];

function migrator(config: NarraForkSettings): (value: string) => AggregationMigration {
	const aggregations = new Map<string, AggregationForMigration>(
		(config.agent.modelAggregations ?? []).map((aggregation) => [aggregation.id, aggregation]),
	);
	const disabled = new Set(config.agent.disabledProviders ?? []);
	for (const provider of [...(config.customApiProviders ?? []), ...(config.nugProviders ?? [])]) {
		if (provider.disabled && provider.prefix) disabled.add(provider.prefix);
	}
	const identify = (member: string) => {
		const identity = identifyModelValue(member);
		const strong = identity.matchedVia === "exact" || identity.matchedVia === "alias";
		const prefix = parseModelId(member).provider;
		return {
			...(strong && identity.modelId ? { strongModelId: identity.modelId } : {}),
			...(prefix && disabled.has(prefix) ? { disabled: true } : {}),
		};
	};
	return (value) => migrateAggregationValue(value, aggregations, identify);
}

/** The settings with every movable aggregation value replaced, and how many could not move. */
function migrateSettings(
	config: NarraForkSettings,
	migrate: (value: string) => AggregationMigration,
): { next: NarraForkSettings | null; unresolved: number } {
	const next = structuredClone(config);
	const agent = next.agent;
	let changed = false;
	let unresolved = 0;
	const move = (value: string | undefined): string | undefined => {
		if (!value) return value;
		const result = migrate(value);
		if (result.kind === "missing") unresolved++;
		if (result.kind === "unchanged" || result.kind === "missing") return value;
		changed = true;
		return result.value;
	};
	const moveAll = (values: readonly string[]): string[] => {
		const seen = new Set<string>();
		return values.flatMap((value) => {
			const moved = move(value) ?? value;
			if (seen.has(moved)) return [];
			seen.add(moved);
			return [moved];
		});
	};

	agent.defaultModel = move(agent.defaultModel) ?? agent.defaultModel;
	agent.summaryModel = move(agent.summaryModel) ?? agent.summaryModel;
	agent.translationModel = move(agent.translationModel) ?? agent.translationModel;
	agent.promptOptimizeModel = move(agent.promptOptimizeModel) ?? agent.promptOptimizeModel;
	for (const key of Object.keys(agent.subagentModels) as Array<keyof typeof agent.subagentModels>) {
		const value = agent.subagentModels[key];
		if (value) agent.subagentModels[key] = move(value) ?? value;
	}
	for (const key of Object.keys(agent.subagentAllowedModels) as Array<
		keyof typeof agent.subagentAllowedModels
	>) {
		const pool = agent.subagentAllowedModels[key];
		if (pool) agent.subagentAllowedModels[key] = moveAll(pool);
	}
	const efforts = agent.subagentModelReasoningEfforts;
	if (efforts) {
		for (const key of Object.keys(efforts) as Array<keyof typeof efforts>) {
			const pool = efforts[key];
			if (!pool) continue;
			// A fixed tier stays with the entry it was set on; the first one wins on collision.
			const movedPool: typeof pool = {};
			for (const [model, effort] of Object.entries(pool)) {
				const moved = move(model) ?? model;
				if (!(moved in movedPool)) movedPool[moved] = effort;
			}
			efforts[key] = movedPool;
		}
	}
	if (next.search?.channels) {
		next.search.channels = next.search.channels.map((channel) =>
			channel.model ? { ...channel, model: move(channel.model) } : channel,
		);
	}
	return { next: changed ? next : null, unresolved };
}

export async function planAggregationMigration(
	config: NarraForkSettings = settings,
): Promise<AggregationMigrationPlan> {
	const migrate = migrator(config);
	const { next, unresolved: settingsUnresolved } = migrateSettings(config, migrate);
	const rows: AggregationRowChange[] = [];
	let unresolved = settingsUnresolved;
	// LIKE narrows the scan; `_` is a LIKE wildcard, so the prefix check below is the real test.
	const matchesPrefix = (column: SQLiteColumn) => like(column, `${AGGREGATION_VALUE_PREFIX}%`);
	for (const target of TARGETS) {
		let lastId: string | null = null;
		for (;;) {
			const batch: Array<{ id: string; value: string | null }> = await allRows(
				selectFrom(target.source, { id: target.id, value: target.value })
					.where(
						lastId
							? and(matchesPrefix(target.value), gt(target.id, lastId))
							: matchesPrefix(target.value),
					)
					.orderBy(target.id)
					.limit(SCAN_BATCH_SIZE),
			);
			if (batch.length === 0) break;
			for (const row of batch) {
				if (!row.value?.startsWith(AGGREGATION_VALUE_PREFIX)) continue;
				const result = migrate(row.value);
				if (result.kind === "missing") unresolved++;
				if (result.kind === "unchanged" || result.kind === "missing") continue;
				rows.push({
					table: target.table,
					column: target.column,
					id: row.id,
					before: row.value,
					after: result.value,
				});
				if (rows.length > MAX_CHANGED_ROWS) {
					throw new Error(`Aggregation migration exceeded ${MAX_CHANGED_ROWS} rows`);
				}
			}
			lastId = batch.at(-1)?.id ?? null;
			if (batch.length < SCAN_BATCH_SIZE) break;
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}
	return { rows, settings: next, unresolved };
}

function targetOf(row: AggregationRowChange): ColumnTarget {
	const target = TARGETS.find((t) => t.table === row.table && t.column === row.column);
	if (!target) throw new Error(`Unknown aggregation migration target ${row.table}.${row.column}`);
	return target;
}

/** Set each row to `after` (or back to `before`); a row someone changed since is skipped. */
async function applyRows(
	rows: readonly AggregationRowChange[],
	direction: "after" | "before",
): Promise<number> {
	const updates: PlannedUpdate[] = rows.map((row) => {
		const target = targetOf(row);
		const from = direction === "after" ? row.before : row.after;
		const to = direction === "after" ? row.after : row.before;
		return {
			table: target.source,
			set: { [target.property]: to },
			where: and(eq(target.id, row.id), eq(target.value, from)),
		};
	});
	return applyUpdates(updates);
}

function writeJournal(rows: AggregationRowChange[]): void {
	mkdirSync(narraforkDir, { recursive: true });
	const temp = `${JOURNAL_PATH}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify({ version: JOURNAL_VERSION, rows } satisfies Journal), {
			mode: 0o600,
		});
		renameSync(temp, JOURNAL_PATH);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/** Apply a plan: rows, then settings; on failure the rows are put back. */
export async function commitAggregationMigration(plan: AggregationMigrationPlan): Promise<number> {
	if (plan.rows.length === 0) {
		if (plan.settings) saveSettings(plan.settings);
		return 0;
	}
	writeJournal(plan.rows);
	try {
		const applied = await applyRows(plan.rows, "after");
		if (plan.settings) saveSettings(plan.settings);
		rmSync(JOURNAL_PATH, { force: true });
		return applied;
	} catch (error) {
		try {
			await applyRows(plan.rows, "before");
			rmSync(JOURNAL_PATH, { force: true });
		} catch (rollbackError) {
			logger.error("Aggregation migration rollback failed; journal retained", {
				error: String(error),
				rollbackError: String(rollbackError),
				journalPath: JOURNAL_PATH,
			});
		}
		throw error;
	}
}

/**
 * A journal left by a crash: if settings no longer hold aggregation values the save went
 * through, so the rows are finished; otherwise they are put back and the migration reruns.
 */
async function recoverJournal(): Promise<void> {
	if (!existsSync(JOURNAL_PATH)) return;
	const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as Partial<Journal>;
	if (journal.version !== JOURNAL_VERSION || !Array.isArray(journal.rows)) {
		throw new Error("Invalid aggregation migration journal");
	}
	const saved = migrateSettings(settings, migrator(settings)).next === null;
	await applyRows(journal.rows, saved ? "after" : "before");
	rmSync(JOURNAL_PATH, { force: true });
	logger.info("Recovered interrupted aggregation migration", {
		direction: saved ? "after" : "before",
		rows: journal.rows.length,
	});
}

/**
 * A provider still prefixed `auto` (its rename failed, or came back with an import) makes every
 * `auto:` value a plain provider value. Writing `auto:<model>` then would pin that provider,
 * and its later rename would freeze the value as `auto-N:<model>`.
 */
function reservedAutoPrefixInUse(config: NarraForkSettings): boolean {
	return [...(config.customApiProviders ?? []), ...(config.nugProviders ?? [])].some(
		(provider) => provider.prefix === "auto",
	);
}

/** Startup entry: recover, plan, apply. Never throws; a failure is logged and retried next start. */
export async function migrateAggregationsOnStartup(): Promise<void> {
	if (reservedAutoPrefixInUse(settings)) {
		logger.warn("Model aggregation migration postponed: a provider is still prefixed `auto`");
		return;
	}
	try {
		await recoverJournal();
		const plan = await planAggregationMigration();
		if (!plan.settings && plan.rows.length === 0) {
			if (plan.unresolved > 0) {
				logger.warn("Model values name aggregations that no longer exist; left unchanged", {
					count: plan.unresolved,
				});
			}
			return;
		}
		const applied = await commitAggregationMigration(plan);
		logger.info("Migrated model aggregation values to auto:/provider values", {
			settingsChanged: !!plan.settings,
			rows: applied,
			skippedRows: plan.rows.length - applied,
			unresolved: plan.unresolved,
		});
	} catch (error) {
		logger.error("Model aggregation migration failed; will retry on next start", {
			error: String(error),
		});
	}
}
