import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	setSystemTime,
	test,
} from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVerdict } from "@shared/scheduled-task-status";
import { eq, getTableName, is, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getTableConfig, SQLiteSyncDialect, type SQLiteTable } from "drizzle-orm/sqlite-core";
import * as relations from "../../db/relations";
import { applyPendingMigrationsByHash, runMigrations } from "../../db/run-migrations";
import * as schema from "../../db/schema";
import { nextCronRun } from "../../lib/cron";
import { nextOccurrence } from "../../lib/schedule-engine";
import { closeFileWorkerDatabase, openFileWorkerDatabase } from "./file-worker-database";
import { captureWorkerRejection } from "./narrator-worker-fixture";

// Released baseline dd11a53e7d84ef706d002304845404298ae73d2a, the parent of 56e1f6e.
// Replay its historical SQL, insert its old columns, then use the production upgrader.
// No schema generated from today's Drizzle declarations is used to create this database.
const DRIZZLE = join(import.meta.dir, "../../../drizzle");
const BASELINE_TAG = "0256_outline_spec_loss";
const TABLES = [
	"users",
	"projects",
	"narrators",
	"scheduled_tasks",
	"scheduled_task_runs",
] as const;
type FixtureTable = (typeof TABLES)[number];
type Row = Record<string, string | number | null>;
type Snapshot = Record<FixtureTable, Row[]>;
const CREATED = "2026-01-02T03:04:05.000Z";
const FINISHED = "2026-01-02T03:04:06.000Z";
const UPGRADE_AT = "2026-11-27T09:00:20.000Z";
const NEXT_DAILY = "2026-11-28T09:00:00.000Z";
const OWNER = "upgrade-owner";
const PRINCIPAL = { userId: OWNER, isAdmin: false };
const sqlite = openFileWorkerDatabase();
const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
const dispatched = mock(async () => {
	throw new Error("An upgrade must not dispatch or replay a task");
});
const removed: string[] = [];

// Only runtime side effects are replaced. Migration, startup normalization, history ACL,
// run recovery, retention selection and all their database reads/writes remain production code.
mock.module("../../db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));
mock.module("../narrator-session", () => ({
	isLoopRunning: () => false,
	sendMessage: dispatched,
	sendScheduledTaskMessage: dispatched,
}));
mock.module("../agent-runtime/ownership", () => ({
	getRunControl: () => undefined,
	getExecutionOwner: () => undefined,
	getLastExecutionEpoch: () => undefined,
	getRunHold: () => undefined,
}));
mock.module("../narrator-session-state", () => ({
	isNarratorRuntimeBusy: () => false,
	withIdleNarratorCleanupAdmission: async <T>(_ids: string[], action: () => Promise<T>) => action(),
}));
mock.module("../narrator-service", () => ({
	narratorService: {
		getById: (id: string) => db.query.narrators.findFirst({ where: eq(schema.narrators.id, id) }),
		create: dispatched,
		remove: async (id: string) => {
			removed.push(id);
			await db.delete(schema.narrators).where(eq(schema.narrators.id, id));
		},
	},
}));

const { scheduledTaskService } = await import("../scheduled-task-service");
const { cleanupScheduledTaskNarrators } = await import("../scheduled-task-cleanup");
const { acceptScheduledTaskRun } = await import("../scheduled-task-waiting");
const { filterScheduledRecoveryNarrators, pollScheduledRuns, recoverScheduledRuns } = await import(
	"../scheduled-task-run-tracker"
);
const { getRegisteredScheduledRun, listRegisteredScheduledRuns, unregisterScheduledRun } =
	await import("../scheduled-run-registry");

let legacy: Snapshot;
let upgraded: Snapshot;
let oldMigrations: string | undefined;

function insert(table: FixtureTable, row: Row) {
	const columns = Object.keys(row);
	sqlite.run(
		`INSERT INTO "${table}" (${columns.map((key) => `"${key}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
		Object.values(row),
	);
}

function snapshot(): Snapshot {
	return Object.fromEntries(
		TABLES.map((table) => {
			// Fresh statements are essential across ALTER TABLE: Bun's cached SELECT *
			// retains its pre-upgrade result-column metadata on the first subsequent read.
			const statement = sqlite.prepare<Row, []>(`SELECT * FROM "${table}" ORDER BY id`);
			try {
				return [table, statement.all()];
			} finally {
				statement.finalize();
			}
		}),
	) as Snapshot;
}

function baselineMigrations(): string {
	const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8")) as {
		entries: Array<{ tag: string; idx: number }>;
	};
	const boundary = journal.entries.findIndex((entry) => entry.tag === BASELINE_TAG);
	expect(boundary).toBeGreaterThan(0);
	expect(journal.entries[boundary]?.idx).toBe(256);
	const redesign = journal.entries.findLastIndex((entry) =>
		entry.tag.endsWith("_scheduled_tasks_redesign"),
	);
	expect(redesign).toBeGreaterThan(boundary);
	expect(journal.entries[redesign]?.idx).toBeGreaterThan(256);
	const entries = journal.entries.slice(0, boundary + 1);
	const folder = mkdtempSync(join(tmpdir(), "nf-scheduled-upgrade-"));
	oldMigrations = folder;
	mkdirSync(join(folder, "meta"));
	writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
	for (const { tag } of entries)
		writeFileSync(join(folder, `${tag}.sql`), readFileSync(join(DRIZZLE, `${tag}.sql`)));
	return folder;
}

function seedLegacyRows() {
	for (const id of [OWNER, "deleted-creator"])
		insert("users", { id, username: id, password_hash: "test", role: "user", created_at: CREATED });
	insert("projects", {
		id: "legacy-project",
		name: "Old project",
		git_path: "C:\\legacy workspace\\project",
		owner_user_id: OWNER,
		created_at: CREATED,
		updated_at: CREATED,
	});
	for (const id of ["ordinary", "remembered", "created-root", "unknown-running"])
		insert("narrators", {
			id,
			title: id,
			owner_user_id: OWNER,
			traits: JSON.stringify(id === "created-root" ? ["scheduled"] : ["standalone"]),
			variant: "primary",
			status: id === "unknown-running" ? "running" : "idle",
			logical_run_id: id === "unknown-running" ? "unverified-old-execution" : null,
			cwd: "C:\\legacy workspace",
			model: "legacy:session-model",
			created_at: CREATED,
			updated_at: CREATED,
		});
	const defaults: Row = {
		name: "Legacy task",
		enabled: 0,
		cron_expr: "*/20 * * * *",
		timezone: "Asia/Kathmandu",
		prompt: "保留旧任务的提示词\nDo not repeat side effects.",
		system_prompt: "Original system instructions",
		model: "legacy:task-model",
		permission_mode: "bypassPermissions",
		locale: "zh-CN",
		run_context: "standalone",
		cwd: "C:\\legacy workspace\\task",
		project_id: null,
		narrator_mode: "new",
		cleanup_policy: JSON.stringify({ mode: "none" }),
		reuse_narrator_id: null,
		created_by: OWNER,
		last_run_at: FINISHED,
		next_run_at: null,
		last_narrator_id: "ordinary",
		last_status: "success",
		last_error: null,
		created_at: CREATED,
		updated_at: FINISHED,
	};
	const tasks: Row[] = [
		{ id: "legacy-new" },
		{
			id: "legacy-reuse",
			narrator_mode: "reuse",
			reuse_narrator_id: "remembered",
			cleanup_policy: JSON.stringify({ mode: "keepLatestN", keepLatestN: 3 }),
		},
		{
			id: "legacy-project-task",
			run_context: "project",
			project_id: "legacy-project",
			cron_expr: "0 9 * * 1-5",
			timezone: "America/New_York",
			permission_mode: "default",
		},
		{ id: "legacy-orphan", created_by: "deleted-creator", timezone: null, cwd: null },
		{ id: "legacy-unfired", last_run_at: null, last_status: null, last_narrator_id: null },
		{ id: "legacy-seconds", cron_expr: "*/30 * * * * *", timezone: "UTC" },
		{
			id: "legacy-active-daily",
			enabled: 1,
			cron_expr: "0 9 * * *",
			timezone: "UTC",
			created_at: "2026-11-20T08:00:00.000Z",
			updated_at: "2026-11-27T09:00:00.000Z",
			last_run_at: "2026-11-27T09:00:00.000Z",
			next_run_at: NEXT_DAILY,
		},
		{
			id: "legacy-cleanup",
			cleanup_policy: JSON.stringify({ mode: "olderThanDays", olderThanDays: 1 }),
		},
		{ id: "legacy-unknown", last_status: "running", last_narrator_id: "unknown-running" },
	];
	for (const row of tasks) insert("scheduled_tasks", { ...defaults, ...row });
	// Preserve a real account-deletion result, rather than manufacturing a dangling creator FK.
	sqlite.run("DELETE FROM users WHERE id = 'deleted-creator'");
	sqlite.run("UPDATE narrators SET scheduled_task_id = 'legacy-cleanup' WHERE id = 'created-root'");
	const runs: Row[] = [
		{
			id: "manual-success",
			task_id: "legacy-new",
			narrator_id: "ordinary",
			status: "success",
			manual: 1,
		},
		{
			id: "scheduled-success",
			task_id: "legacy-new",
			narrator_id: "ordinary",
			status: "success",
			manual: 0,
		},
		{
			id: "old-failed",
			task_id: "legacy-new",
			narrator_id: null,
			status: "failed",
			error: "original dispatch error",
			manual: 1,
		},
		{
			id: "old-skipped",
			task_id: "legacy-new",
			narrator_id: "already-deleted-narrator",
			status: "skipped",
			error: "Narrator is already running",
			manual: 0,
		},
		{
			id: "ordinary-history",
			task_id: "legacy-cleanup",
			narrator_id: "ordinary",
			status: "success",
			manual: 0,
		},
		// Old SQLite has no status CHECK. An unknown historical running row is not evidence
		// of a verified execution; it must not become eligible for automatic replay.
		{
			id: "unverified-running",
			task_id: "legacy-unknown",
			narrator_id: "unknown-running",
			status: "running",
			manual: 0,
			finished_at: null,
			duration_ms: null,
		},
	];
	for (const row of runs)
		insert("scheduled_task_runs", {
			run_context: "standalone",
			started_at: CREATED,
			finished_at: FINISHED,
			duration_ms: 1000,
			created_at: FINISHED,
			...row,
		});
}

beforeAll(async () => {
	sqlite.run("PRAGMA foreign_keys = ON");
	// Exercise the SQLite default that previously broke historical table rebuilds on macOS.
	sqlite.run("PRAGMA legacy_alter_table = ON");
	applyPendingMigrationsByHash(sqlite, baselineMigrations());
	const baseline = JSON.parse(readFileSync(join(DRIZZLE, "meta/0256_snapshot.json"), "utf8")) as {
		tables: Record<string, { columns: Record<string, unknown> }>;
	};
	for (const table of ["scheduled_tasks", "scheduled_task_runs"]) {
		const columns = sqlite.query<{ name: string }, []>(`PRAGMA table_info('${table}')`).all();
		expect(columns.map((column) => column.name).sort()).toEqual(
			Object.keys(baseline.tables[table]?.columns ?? {}).sort(),
		);
	}
	seedLegacyRows();
	legacy = snapshot();
	expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
	await runMigrations(sqlite);
	upgraded = snapshot();
}, 30_000);

beforeEach(() => {
	setSystemTime(new Date(UPGRADE_AT));
	for (const run of listRegisteredScheduledRuns()) unregisterScheduledRun(run.runId);
	dispatched.mockClear();
	removed.length = 0;
	// Replay the migration once, then reset only these bounded fixture rows per test.
	// Every restored row is the actual output of that upgrade, never current-schema seed data.
	sqlite.run("PRAGMA foreign_keys = OFF");
	try {
		sqlite.transaction(() => {
			for (const table of [...TABLES].reverse()) sqlite.run(`DELETE FROM "${table}"`);
			for (const table of TABLES) for (const row of upgraded[table]) insert(table, row);
		})();
	} finally {
		sqlite.run("PRAGMA foreign_keys = ON");
	}
});

afterEach(() => setSystemTime());

afterAll(async () => {
	for (const run of listRegisteredScheduledRuns()) unregisterScheduledRun(run.runId);
	await closeFileWorkerDatabase(sqlite);
	if (oldMigrations) rmSync(oldMigrations, { recursive: true, force: true });
	mock.restore();
});

function assertSchemaMatches(table: SQLiteTable) {
	const config = getTableConfig(table);
	const dialect = new SQLiteSyncDialect();
	const columns = sqlite
		.query<
			{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number },
			[]
		>(`PRAGMA table_info('${config.name}')`)
		.all();
	expect(columns.map((column) => column.name).sort()).toEqual(
		config.columns.map((column) => column.name).sort(),
	);
	for (const column of config.columns) {
		const actual = columns.find((item) => item.name === column.name);
		expect(actual).toMatchObject({
			type: column.getSQLType().toUpperCase(),
			notnull: Number(column.notNull),
			pk: Number(column.primary),
		});
		const expression = actual?.dflt_value;
		const actualDefault = expression
			? sqlite.query<{ value: string | number | null }, []>(`SELECT ${expression} AS value`).get()
					?.value
			: null;
		const expectedDefault =
			column.default === undefined
				? null
				: is(column.default, SQL)
					? sqlite
							.query<{ value: string | number | null }, []>(
								`SELECT ${dialect.sqlToQuery(column.default).sql} AS value`,
							)
							.get()?.value
					: column.mapToDriverValue(column.default);
		if (
			expectedDefault !== null &&
			typeof expectedDefault !== "string" &&
			typeof expectedDefault !== "number"
		)
			throw new Error(`Expected a scalar SQLite default for ${config.name}.${column.name}`);
		expect({ column: column.name, value: actualDefault }).toEqual({
			column: column.name,
			value: expectedDefault,
		});
	}
	const foreignKeys = sqlite
		.query<{ table: string; from: string; to: string; on_delete: string; on_update: string }, []>(
			`PRAGMA foreign_key_list('${config.name}')`,
		)
		.all()
		.map(({ table: name, from, to, on_delete, on_update }) => ({
			name,
			from,
			to,
			on_delete,
			on_update,
		}));
	const expectedKeys = config.foreignKeys.flatMap((key) => {
		const reference = key.reference();
		return reference.columns.map((column, index) => ({
			name: getTableName(reference.foreignTable),
			from: column.name,
			to: reference.foreignColumns[index]?.name,
			on_delete: (key.onDelete ?? "no action").toUpperCase(),
			on_update: (key.onUpdate ?? "no action").toUpperCase(),
		}));
	});
	expect(foreignKeys.sort((a, b) => a.from.localeCompare(b.from))).toEqual(
		expectedKeys.sort((a, b) => a.from.localeCompare(b.from)),
	);
	const indexes = sqlite
		.query<{ name: string; unique: number; origin: string; partial: number }, []>(
			`PRAGMA index_list('${config.name}')`,
		)
		.all()
		.filter((index) => index.origin === "c");
	expect(indexes.map((index) => index.name).sort()).toEqual(
		config.indexes.map((index) => index.config.name).sort(),
	);
	const normalize = (value: string) =>
		value
			.replaceAll(/["`]/g, "")
			.replaceAll(`${config.name}.`, "")
			.replaceAll(/\s+/g, " ")
			.replace(/;$/, "")
			.trim();
	for (const { config: index } of config.indexes) {
		expect(indexes.find((item) => item.name === index.name)).toMatchObject({
			unique: Number(index.unique),
			partial: Number(!!index.where),
		});
		expect(
			sqlite
				.query<{ name: string }, []>(`PRAGMA index_info('${index.name}')`)
				.all()
				.map((column) => column.name),
		).toEqual(
			index.columns.map((column) => {
				if (!("name" in column) || typeof column.name !== "string")
					throw new Error(`Expected a column index for ${index.name}`);
				return column.name;
			}),
		);
		const definition = sqlite
			.query<{ sql: string }, [string]>(
				"SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
			)
			.get(index.name);
		expect(normalize(definition?.sql.split(/\bWHERE\b/i)[1] ?? "")).toBe(
			index.where ? normalize(dialect.sqlToQuery(index.where).sql) : "",
		);
	}
}

describe("scheduled tasks: direct upgrade from the released 0256 baseline", () => {
	test("preserves every old task/run field, related rows and FK integrity", () => {
		for (const table of TABLES) {
			expect(upgraded[table]).toHaveLength(legacy[table].length);
			for (const row of legacy[table])
				expect(upgraded[table].find((candidate) => candidate.id === row.id)).toMatchObject(row);
		}
		expect(sqlite.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
		expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
		expect(sqlite.query("SELECT name FROM sqlite_master WHERE name GLOB '__new_*'").all()).toEqual(
			[],
		);
	});

	test("the upgraded tables match current columns, defaults, foreign keys and indexes", () => {
		assertSchemaMatches(schema.scheduledTasks);
		assertSchemaMatches(schema.scheduledTaskRuns);
	});

	test("editing before startup normalization preserves the legacy owner's authority and future cadence", async () => {
		expect(await scheduledTaskService.get("legacy-active-daily")).toMatchObject({
			schedule: null,
			ownerUserId: null,
			createdBy: OWNER,
		});
		const updated = await scheduledTaskService.update(
			"legacy-active-daily",
			{ name: "Renamed before startup recovery" },
			PRINCIPAL,
		);
		expect(updated).toMatchObject({
			ownerUserId: OWNER,
			createdBy: OWNER,
			creatorKind: "user",
			creatorSnapshot: { username: OWNER },
			nextRunAt: NEXT_DAILY,
			scheduleCursorAt: "2026-11-28T08:59:59.999Z",
		});
		expect(updated.schedule).not.toBeNull();
		await expect(scheduledTaskService.detail(updated.id, PRINCIPAL)).resolves.toBeDefined();
		await expect(
			scheduledTaskService.update(updated.id, { name: "Still editable" }, PRINCIPAL),
		).resolves.toMatchObject({
			ownerUserId: OWNER,
		});
		await scheduledTaskService.recoverOnStartup();
		expect((await scheduledTaskService.get(updated.id))?.ownerUserId).toBe(OWNER);
		expect(snapshot().scheduled_task_runs).toEqual(upgraded.scheduled_task_runs);
		expect(dispatched).not.toHaveBeenCalled();
	});

	test("allows non-schedule edits to a legacy seconds cron but rejects a new too-fast cadence", async () => {
		const taskId = "legacy-seconds";
		expect(await scheduledTaskService.get(taskId)).toMatchObject({
			cronExpr: "*/30 * * * * *",
			schedule: null,
			ownerUserId: null,
		});
		const renamed = await scheduledTaskService.update(
			taskId,
			{ name: "Renamed legacy seconds task" },
			PRINCIPAL,
		);
		expect(renamed).toMatchObject({
			name: "Renamed legacy seconds task",
			cronExpr: "*/30 * * * * *",
			ownerUserId: OWNER,
			createdBy: OWNER,
			schedule: { kind: "cron", expr: "*/30 * * * * *", end: { type: "never" } },
			scheduleRevision: 0,
			firedCount: 0,
		});
		const edited = await scheduledTaskService.update(
			taskId,
			{ prompt: "Updated instructions without changing when this task runs" },
			PRINCIPAL,
		);
		expect(edited).toMatchObject({
			prompt: "Updated instructions without changing when this task runs",
			cronExpr: renamed.cronExpr,
			schedule: renamed.schedule,
			scheduleCursorAt: renamed.scheduleCursorAt,
			scheduleRevision: 0,
			firedCount: 0,
		});
		expect(
			await captureWorkerRejection(
				scheduledTaskService.update(taskId, { cronExpr: "*/15 * * * * *" }, PRINCIPAL),
			),
		).toMatchObject({ statusCode: 400 });
		expect(await scheduledTaskService.get(taskId)).toEqual(edited);
		expect(
			await captureWorkerRejection(
				scheduledTaskService.update(
					taskId,
					{
						schedule: { kind: "cron", expr: "*/20 * * * * *", end: { type: "never" } },
					},
					PRINCIPAL,
				),
			),
		).toMatchObject({ statusCode: 400 });
		expect(await scheduledTaskService.get(taskId)).toEqual(edited);
		expect(snapshot().scheduled_task_runs).toEqual(upgraded.scheduled_task_runs);
		expect(dispatched).not.toHaveBeenCalled();
	});

	test("normalizes old ownership and cadence without changing configuration or creating runs", async () => {
		await scheduledTaskService.recoverOnStartup();
		for (const old of legacy.scheduled_tasks) {
			const task = await scheduledTaskService.get(String(old.id));
			expect(task).toMatchObject({
				cronExpr: old.cron_expr,
				timezone: old.timezone,
				cwd: old.cwd,
				projectId: old.project_id,
				runContext: old.run_context,
				narratorMode: old.narrator_mode,
				reuseNarratorId: old.reuse_narrator_id,
				createdBy: old.created_by,
				ownerUserId: old.created_by,
				prompt: old.prompt,
				systemPrompt: old.system_prompt,
				model: old.model,
				permissionMode: old.permission_mode,
				locale: old.locale,
				cleanupPolicy: JSON.parse(String(old.cleanup_policy)),
				creatorKind: "user",
				targetNarratorId: null,
				contextPolicy: "keep",
				onBusy: "skip",
				busyWaitMinutes: 30,
				requireReport: true,
				modelPolicy: "follow",
				onBlocked: "auto",
				blockedWaitMinutes: 30,
				maxRunMinutes: 60,
				notifyOnSuccess: false,
				firedCount: 0,
				scheduleRevision: 0,
				activeRunId: null,
				completedAt: null,
				pauseReason: null,
				consecutiveFailures: 0,
				scheduleCursorAt: old.next_run_at
					? new Date(Date.parse(String(old.next_run_at)) - 1).toISOString()
					: (old.last_run_at ?? UPGRADE_AT),
			});
			if (!task?.schedule) throw new Error(`Missing normalized schedule for ${old.id}`);
			expect(task.scheduleKind).toBe(task.schedule.kind);
			// Compare actual next instants, including a quarter-hour timezone, to the old cron engine.
			for (const date of ["2026-03-08T06:55:00.000Z", "2026-11-01T05:55:00.000Z"]) {
				const after = new Date(date);
				const expected = nextCronRun(task.cronExpr, task.timezone, after);
				const actual = nextOccurrence({
					schedule: task.schedule,
					timezone: task.timezone,
					after,
				});
				if (!expected || !actual)
					throw new Error(`Both schedule engines must produce an occurrence for ${task.id}`);
				expect(actual.toISOString()).toBe(expected);
			}
		}
		expect((await scheduledTaskService.get("legacy-new"))?.creatorSnapshot).toEqual({
			username: OWNER,
		});
		expect((await scheduledTaskService.get("legacy-orphan"))?.ownerUserId).toBeNull();
		expect(snapshot().scheduled_task_runs).toEqual(upgraded.scheduled_task_runs);
		expect(dispatched).not.toHaveBeenCalled();
		const normalized = snapshot();
		await runMigrations(sqlite);
		await scheduledTaskService.recoverOnStartup();
		expect(snapshot()).toEqual(normalized);
	});

	test("keeps a future occurrence when completion reconciliation runs before startup normalization", async () => {
		expect(await scheduledTaskService.get("legacy-active-daily")).toMatchObject({
			schedule: null,
			ownerUserId: null,
			nextRunAt: NEXT_DAILY,
		});
		// Run recovery settles before the scheduler's startup pass; it must not rewind
		// an unmigrated task while reconciling the old invocation's completion.
		await scheduledTaskService.reconcileCompletion("legacy-active-daily");
		expect(await scheduledTaskService.get("legacy-active-daily")).toMatchObject({
			ownerUserId: OWNER,
			createdBy: OWNER,
			nextRunAt: NEXT_DAILY,
			scheduleCursorAt: "2026-11-28T08:59:59.999Z",
		});
		await scheduledTaskService.recoverOnStartup();
		expect(await scheduledTaskService.get("legacy-active-daily")).toMatchObject({
			nextRunAt: NEXT_DAILY,
			lastRunAt: "2026-11-27T09:00:00.000Z",
			firedCount: 0,
			scheduleCursorAt: "2026-11-28T08:59:59.999Z",
		});
		expect(await scheduledTaskService.listDue(new Date(UPGRADE_AT))).toEqual([]);
		await scheduledTaskService.runTask("legacy-active-daily", { at: new Date(UPGRADE_AT) });
		expect(snapshot().scheduled_task_runs).toEqual(upgraded.scheduled_task_runs);
		expect(dispatched).not.toHaveBeenCalled();
	});

	test("continues reusing a legacy pointer with no creation provenance at admission and resolution", async () => {
		await scheduledTaskService.recoverOnStartup();
		const task = await scheduledTaskService.get("legacy-reuse");
		if (!task) throw new Error("Missing legacy reuse task");
		const before = snapshot().narrators.find((row) => row.id === "remembered");
		expect(before).toMatchObject({ scheduled_task_id: null, traits: '["standalone"]' });
		expect(await scheduledTaskService.resolveNarrator(task, PRINCIPAL)).toMatchObject({
			id: "remembered",
			scheduledTaskId: null,
		});
		const runId = await acceptScheduledTaskRun(task, { manual: true, at: new Date(UPGRADE_AT) });
		expect(runId).toBeDefined();
		expect(
			await db.query.scheduledTaskRuns.findFirst({
				where: eq(schema.scheduledTaskRuns.id, runId ?? ""),
			}),
		).toMatchObject({
			narratorId: "remembered",
			status: "waiting",
			trigger: "manual",
		});
		await db
			.update(schema.scheduledTasks)
			.set({
				cleanupPolicy: { mode: "olderThanDays", olderThanDays: 1 },
			})
			.where(eq(schema.scheduledTasks.id, task.id));
		expect(await cleanupScheduledTaskNarrators(task.id)).toMatchObject({ deletedRoots: 0 });
		expect(snapshot().narrators.find((row) => row.id === "remembered")).toEqual(before);
		expect((await scheduledTaskService.get(task.id))?.reuseNarratorId).toBe("remembered");
		expect(removed).toEqual([]);
		expect(dispatched).not.toHaveBeenCalled();
	});

	test("does not adopt a reuse pointer explicitly created by a different task", async () => {
		await scheduledTaskService.recoverOnStartup();
		sqlite.run(
			"UPDATE scheduled_tasks SET reuse_narrator_id = 'created-root' WHERE id = 'legacy-reuse'",
		);
		const task = await scheduledTaskService.get("legacy-reuse");
		if (!task) throw new Error("Missing legacy reuse task");
		const runId = await acceptScheduledTaskRun(task, { manual: true, at: new Date(UPGRADE_AT) });
		expect(runId).toBeDefined();
		expect(
			await db.query.scheduledTaskRuns.findFirst({
				where: eq(schema.scheduledTaskRuns.id, runId ?? ""),
			}),
		).toMatchObject({
			narratorId: null,
			status: "waiting",
		});
		// Creation is a failing side-effect sentinel: a foreign task's session cannot be returned.
		await expect(scheduledTaskService.resolveNarrator(task, PRINCIPAL)).rejects.toThrow(
			"An upgrade must not dispatch",
		);
		expect(snapshot().narrators.find((row) => row.id === "created-root")?.scheduled_task_id).toBe(
			"legacy-cleanup",
		);
	});

	test("old manual history stays manual and legacy success only means dispatched", async () => {
		await scheduledTaskService.recoverOnStartup();
		const { runs } = await scheduledTaskService.listRuns("legacy-new", { principal: PRINCIPAL });
		expect(runs).toHaveLength(4);
		for (const run of runs) {
			const old = legacy.scheduled_task_runs.find((row) => row.id === run.id);
			expect(old).toBeDefined();
			if (!old || (old.status !== "success" && old.status !== "failed" && old.status !== "skipped"))
				throw new Error(`Expected an original terminal status for ${run.id}`);
			expect(run.trigger).toBe(old.manual ? "manual" : "schedule");
			expect(run.manual).toBe(Boolean(old.manual));
			expect(run.status).toBe(old.status);
			expect(run.outcome).toBeNull();
			expect(run.triggerMessageId).toBeNull();
			if (run.status === "success") {
				expect(run.verdict).toBe("dispatched");
				expect(runVerdict(run.status, run.outcome, run.requireReport)).toBe("dispatched");
			}
		}
		expect(
			(
				await scheduledTaskService.listRuns("legacy-new", {
					principal: PRINCIPAL,
					result: "succeeded",
				})
			).runs,
		).toEqual([]);
		expect(
			(
				await scheduledTaskService.listRuns("legacy-new", {
					principal: PRINCIPAL,
					result: "dispatched",
				})
			).runs,
		).toHaveLength(2);
		expect(dispatched).not.toHaveBeenCalled();
	});

	test("unknown old running work is fenced and interrupted, never redispatched", async () => {
		await scheduledTaskService.recoverOnStartup();
		expect(await recoverScheduledRuns()).toEqual(new Set(["unknown-running"]));
		expect(getRegisteredScheduledRun("ordinary")).toBeUndefined();
		expect(await filterScheduledRecoveryNarrators(["unknown-running", "ordinary"])).toEqual(
			new Set(["ordinary"]),
		);
		const registration = getRegisteredScheduledRun("unknown-running");
		if (!registration) throw new Error("Expected a conservative recovery registration");
		// Advance only the watchdog's grace timestamp; do not wait for the production timeout.
		registration.recoveredAt = Date.now() - 31_000;
		await pollScheduledRuns();
		const run = await db.query.scheduledTaskRuns.findFirst({
			where: eq(schema.scheduledTaskRuns.id, "unverified-running"),
		});
		expect(run).toMatchObject({
			status: "interrupted",
			errorKind: "restart",
			outcome: null,
			nudged: false,
		});
		expect(dispatched).not.toHaveBeenCalled();
		expect(snapshot().scheduled_task_runs).toHaveLength(legacy.scheduled_task_runs.length);
		// Another cold start must retain the durable fence after the in-memory registration is gone.
		expect(await recoverScheduledRuns()).toEqual(new Set());
		expect(await filterScheduledRecoveryNarrators(["unknown-running", "ordinary"])).toEqual(
			new Set(["ordinary"]),
		);
	});

	test("retention uses creation provenance and never adopts or deletes ordinary reused sessions", async () => {
		await scheduledTaskService.recoverOnStartup();
		const ordinary = legacy.narrators.find((row) => row.id === "ordinary");
		const remembered = legacy.narrators.find((row) => row.id === "remembered");
		expect(snapshot().narrators.find((row) => row.id === "ordinary")).toEqual(ordinary);
		expect(snapshot().narrators.find((row) => row.id === "remembered")).toEqual(remembered);
		const history = snapshot().scheduled_task_runs;
		expect(await cleanupScheduledTaskNarrators("legacy-cleanup")).toMatchObject({
			deletedRoots: 1,
			deletedNarrators: 1,
		});
		await cleanupScheduledTaskNarrators("legacy-reuse");
		expect(removed).toEqual(["created-root"]);
		expect(snapshot().narrators.find((row) => row.id === "ordinary")).toEqual(ordinary);
		expect(snapshot().narrators.find((row) => row.id === "remembered")).toEqual(remembered);
		expect(snapshot().scheduled_task_runs).toEqual(history);
		expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
	});

	test("FK actions remain effective and task deletion preserves ordinary sessions", async () => {
		await scheduledTaskService.recoverOnStartup();
		sqlite.run(
			"UPDATE scheduled_tasks SET target_narrator_id = 'remembered' WHERE id = 'legacy-new'",
		);
		expect(() =>
			sqlite.run(
				"UPDATE scheduled_tasks SET owner_user_id = 'missing-user' WHERE id = 'legacy-new'",
			),
		).toThrow();
		expect(() =>
			sqlite.run(
				"UPDATE scheduled_task_runs SET task_id = 'missing-task' WHERE id = 'manual-success'",
			),
		).toThrow();
		sqlite.run("DELETE FROM narrators WHERE id = 'remembered'");
		expect((await scheduledTaskService.get("legacy-new"))?.targetNarratorId).toBeNull();
		expect((await scheduledTaskService.get("legacy-reuse"))?.reuseNarratorId).toBeNull();
		sqlite.run("DELETE FROM projects WHERE id = 'legacy-project'");
		expect((await scheduledTaskService.get("legacy-project-task"))?.projectId).toBeNull();
		await scheduledTaskService.delete("legacy-cleanup", PRINCIPAL);
		expect(
			await db.query.narrators.findFirst({ where: eq(schema.narrators.id, "created-root") }),
		).toMatchObject({ scheduledTaskId: null });
		expect(
			await db.query.narrators.findFirst({ where: eq(schema.narrators.id, "ordinary") }),
		).toMatchObject({ scheduledTaskId: null, traits: ["standalone"] });
		expect(
			await db.query.scheduledTaskRuns.findFirst({
				where: eq(schema.scheduledTaskRuns.id, "ordinary-history"),
			}),
		).toBeUndefined();
		sqlite.run("DELETE FROM users WHERE id = ?", [OWNER]);
		for (const task of await db.select().from(schema.scheduledTasks)) {
			expect(task.ownerUserId).toBeNull();
			expect(task.createdBy).toBeNull();
		}
		expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
	});
});
