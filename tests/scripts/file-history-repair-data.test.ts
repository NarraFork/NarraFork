import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileChangeScopes, revertOperations } from "@server/db/schema";
import { FileChangeBlobCatalog } from "@server/services/file-change-blob-catalog";
import { FileChangeBlobStore } from "@server/services/file-change-blob-store";
import { FileChangeEvidenceService } from "@server/services/file-change-evidence";
import { createFileChangeIdentity } from "@server/services/file-change-identity";
import { RevertPlanService } from "@server/services/revert-plan-service";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	applyFileHistoryRepair,
	FileHistoryRepairDataError,
	preflightFileHistoryRepair,
	type RepairDataOptions,
	verifyFileHistoryRepair,
} from "../../scripts/lib/file-history-repair-data";
import {
	addFixtureEffect,
	createFileHistoryRepairFixture,
	FIXTURE_CONTENT,
	FIXTURE_DIGEST,
	FIXTURE_NEW_KEY,
	FIXTURE_NOW,
	FIXTURE_REF,
	fixtureSnapshot,
} from "./file-history-repair-data-fixture";

let root: string;
let path: string;
let db: Database;
let restores: (() => void)[];
const identity = { namespaceKey: FIXTURE_NEW_KEY };
const repairedAt = Date.parse("2026-11-07T01:00:00.000Z");
const options: RepairDataOptions = { batchSize: 2, now: () => repairedAt };
const expired = { kind: "unknown", reason: "expired" };
const protectedTables = [
	"users",
	"narrators",
	"projects",
	"narrator_messages",
	"narrator_message_refs",
	"narrator_tool_calls",
	"unrelated_business",
	"file_attributions",
	"file_change_rollups",
	"file_change_operations",
	"file_change_scopes",
	"file_change_execution_segments",
	"workspace_write_leases",
	"workspace_execution_owners",
	"file_change_scope_recoveries",
	"file_history_clock",
];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "file-history-repair-data-"));
	path = join(root, "fixture.sqlite");
	db = new Database(path, { create: true });
	restores = [];
	createFileHistoryRepairFixture(db);
});
afterEach(async () => {
	for (const restore of restores.reverse()) restore();
	db.close();
	await rm(root, { recursive: true, force: true });
});

function failure(run: () => unknown, code?: string, commitState = "not_committed") {
	let caught: unknown;
	try {
		run();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(FileHistoryRepairDataError);
	expect(caught).toMatchObject({ commitState, ...(code ? { code } : {}) });
	return caught;
}
function traceSql(): string[] {
	const statements: string[] = [];
	const originalQuery = db.query.bind(db);
	const originalExec = db.exec.bind(db);
	const query = spyOn(db, "query").mockImplementation((sql: string) => {
		statements.push(sql);
		return originalQuery(sql);
	});
	const exec = spyOn(db, "exec").mockImplementation((sql: string) => {
		statements.push(sql);
		return originalExec(sql);
	});
	restores.push(
		() => query.mockRestore(),
		() => exec.mockRestore(),
	);
	return statements;
}

function removeColumns(row: Record<string, unknown>, omitted: string[]): Record<string, unknown> {
	return Object.fromEntries(Object.entries(row).filter(([key]) => !omitted.includes(key)));
}

describe("bounded offline file history data maintenance", () => {
	test("preflight and verification are read-only and can inspect an existing nonempty WAL", async () => {
		expect((await stat(`${path}-wal`)).size).toBeGreaterThan(0);
		const before = fixtureSnapshot(db);
		const statements = traceSql();
		const result = preflightFileHistoryRepair(db, identity, options);
		expect(result).toMatchObject({
			namespaceMatches: false,
			blobReferenceRoots: 12,
			budget: { generation: 41, quotaBytes: 987654321 },
		});
		expect(result.counts).toMatchObject({
			file_change_effects: 1,
			revert_operation_files: 2,
			revert_operations: 8,
			file_change_blobs: 1,
		});
		failure(() => verifyFileHistoryRepair(db, identity, options), "verification_failed");
		expect(fixtureSnapshot(db)).toEqual(before);
		expect(
			statements.some((sql) => /^(?:BEGIN|COMMIT|ROLLBACK|UPDATE|DELETE|INSERT)\b/i.test(sql)),
		).toBe(false);
	});

	test.each([
		"regular",
		"symlink",
	] as const)("expires unpinned %s revert fingerprints through check, apply and verify", (kind) => {
		const state = JSON.stringify(
			kind === "regular"
				? { kind, blob: FIXTURE_REF, mode: 0o644 }
				: { kind, target: FIXTURE_REF, mode: null },
		);
		db.query(
			`UPDATE revert_operation_files SET expected_state_json = ?, desired_state_json = ?,
			observed_after_state_json = ?, compensation_after_state_json = ?,
			before_blob_digest = NULL, desired_blob_digest = NULL,
			observed_after_blob_digest = NULL, compensation_after_blob_digest = NULL
			WHERE id = 'revert-file'`,
		).run(state, state, state, state);
		const before = fixtureSnapshot(db);
		expect(preflightFileHistoryRepair(db, identity, options).counts.revert_operation_files).toBe(2);
		expect(fixtureSnapshot(db)).toEqual(before);
		expect(applyFileHistoryRepair(db, identity, options)).toMatchObject({
			committed: true,
			verified: true,
		});
		expect(() => verifyFileHistoryRepair(db, identity, options)).not.toThrow();
		const row = db
			.query<Record<string, string | null>, []>(
				"SELECT * FROM revert_operation_files WHERE id = 'revert-file'",
			)
			.get();
		for (const column of [
			"expected_state_json",
			"desired_state_json",
			"observed_after_state_json",
			"compensation_after_state_json",
		])
			expect(JSON.parse(row?.[column] ?? "null")).toEqual(expired);
		for (const column of [
			"before_blob_digest",
			"desired_blob_digest",
			"observed_after_blob_digest",
			"compensation_after_blob_digest",
		])
			expect(row?.[column]).toBeNull();
	});

	test("atomically expires all JSON/root references while preserving every unrelated fixture row and physical byte", async () => {
		const source = join(root, "file-change-source.json");
		const workspace = join(root, "workspace.txt");
		await writeFile(source, '{"version":1,"id":"11111111-1111-1111-1111-111111111111"}');
		await writeFile(workspace, "actual workspace bytes\n");
		const objects = new FileChangeBlobStore({ root: join(root, "objects"), minimumFreeBytes: 0 });
		await objects.putBytes(Buffer.from(FIXTURE_CONTENT), { expectedSize: FIXTURE_REF.sizeBytes });
		const objectPath = join(root, "objects", "sha256", FIXTURE_DIGEST.slice(0, 2), FIXTURE_DIGEST);
		const physical = await Promise.all(
			[source, workspace, objectPath].map((file) => readFile(file)),
		);
		const before = fixtureSnapshot(db);
		const protectedBefore = fixtureSnapshot(db, protectedTables);
		const statements = traceSql();
		const serialize = spyOn(db, "serialize").mockImplementation(() => {
			throw new Error("Serialization is forbidden");
		});
		restores.push(() => serialize.mockRestore());
		const result = applyFileHistoryRepair(db, identity, options);
		const maintenanceStatements = statements.slice();
		expect(result).toMatchObject({
			committed: true,
			verified: true,
			afterBudget: {
				namespaceKey: FIXTURE_NEW_KEY,
				status: "ready",
				generation: 42,
				quotaBytes: 987654321,
				usedBytes: 0,
				reservedBytes: 0,
				reconciledAt: new Date(repairedAt).toISOString(),
			},
		});
		expect(fixtureSnapshot(db, protectedTables)).toEqual(protectedBefore);
		expect(serialize).not.toHaveBeenCalled();
		for (const column of [
			"before_state_json",
			"intended_after_state_json",
			"observed_after_state_json",
		]) {
			const row = db
				.query<Record<string, string>, []>(`SELECT ${column} FROM file_change_effects`)
				.get();
			expect(JSON.parse(row?.[column] ?? "null")).toEqual(expired);
		}
		for (const row of db
			.query<Record<string, string | null>, []>("SELECT * FROM revert_operation_files")
			.all()) {
			for (const column of [
				"expected_state_json",
				"desired_state_json",
				"observed_after_state_json",
				"compensation_after_state_json",
			]) {
				if (
					row.id === "revert-file-null" &&
					["observed_after_state_json", "compensation_after_state_json"].includes(column)
				)
					expect(row[column]).toBeNull();
				else expect(JSON.parse(row[column] ?? "null")).toEqual(expired);
			}
			for (const column of [
				"before_blob_digest",
				"desired_blob_digest",
				"observed_after_blob_digest",
				"compensation_after_blob_digest",
			])
				expect(row[column]).toBeNull();
		}
		expect(db.query("SELECT * FROM file_change_blobs").all()).toEqual([]);
		expect(db.query("SELECT * FROM file_change_blob_reservations").all()).toEqual([]);
		expect(
			db.query("SELECT manifest_blob_digest, coverage, reason FROM snapshot_captures").get(),
		).toEqual({ manifest_blob_digest: null, coverage: "unavailable", reason: "expired" });
		for (const row of db
			.query<Record<string, unknown>, []>("SELECT * FROM revert_operations")
			.all()) {
			expect(row.selector_blob_digest).toBeNull();
			expect(row.plan_blob_digest).toBeNull();
			expect(row.history_manifest_blob_digest).toBeNull();
			if (row.id === "revert-planned" || row.id === "revert-prepared") {
				expect(row.status).toBe("expired");
				expect(row.expires_at).toBe(new Date(repairedAt).toISOString());
			} else {
				const original = before.revert_operations.find(
					(value) => (value as { id: string }).id === row.id,
				) as Record<string, unknown>;
				expect(
					removeColumns(row, [
						"selector_blob_digest",
						"plan_blob_digest",
						"history_manifest_blob_digest",
					]),
				).toEqual(
					removeColumns(original, [
						"selector_blob_digest",
						"plan_blob_digest",
						"history_manifest_blob_digest",
					]),
				);
			}
		}
		const effectBefore = before.file_change_effects[0] as Record<string, unknown>;
		const effectAfter = db
			.query<Record<string, unknown>, []>("SELECT * FROM file_change_effects")
			.get();
		const effectFields = [
			"before_state_json",
			"intended_after_state_json",
			"observed_after_state_json",
			"before_blob_digest",
			"intended_after_blob_digest",
			"observed_after_blob_digest",
		];
		expect(removeColumns(effectAfter ?? {}, effectFields)).toEqual(
			removeColumns(effectBefore, effectFields),
		);
		expect(
			await Promise.all([source, workspace, objectPath].map((file) => readFile(file))),
		).toEqual(physical);
		expect((await readdir(root)).some((name) => /backup|copy|dump|snapshot/i.test(name))).toBe(
			false,
		);
		expect(maintenanceStatements.filter((sql) => /^BEGIN/i.test(sql))).toEqual(["BEGIN IMMEDIATE"]);
		expect(maintenanceStatements.filter((sql) => /^COMMIT/i.test(sql))).toEqual(["COMMIT"]);
		expect(
			maintenanceStatements.some((sql) =>
				/integrity_check|foreign_key_check|dbstat|VACUUM|ATTACH|COUNT\s*\(/i.test(sql),
			),
		).toBe(false);
		expect(
			maintenanceStatements.some((sql) => /PRAGMA\s+(?:journal_mode|synchronous)\s*=/i.test(sql)),
		).toBe(false);
		expect(
			maintenanceStatements.filter((sql) =>
				/\bFROM\s+"?(?:narrator_messages|narrator_message_refs)\b/i.test(sql),
			).length,
		).toBe(0);
		expect(verifyFileHistoryRepair(db, identity, options).verified).toBe(true);
	});

	test.each([
		"UPDATE file_change_operations SET execution_outcome='running'",
		"UPDATE file_change_operations SET settlement='reconcile_required'",
		"UPDATE file_change_operations SET unresolved_effect_count=1",
		"UPDATE file_change_effects SET settlement='applying'",
		"UPDATE file_change_effects SET outcome='pending'",
		"UPDATE file_change_blob_reservations SET status='reserved'",
		"UPDATE file_change_blob_reservations SET status='reconcile_required'",
		"UPDATE workspace_write_leases SET status='executing'",
		"UPDATE workspace_write_leases SET status='quarantined'",
		"UPDATE file_change_scopes SET active_mutation_count=1",
		"UPDATE revert_operations SET status='applying' WHERE id='revert-planned'",
		"UPDATE revert_operations SET status='files_verified' WHERE id='revert-planned'",
		"UPDATE revert_operations SET status='compensating' WHERE id='revert-planned'",
		"UPDATE revert_operations SET status='recovery_required' WHERE id='revert-planned'",
		"UPDATE revert_operation_files SET status='applying'",
		"UPDATE revert_operation_files SET status='compensating'",
		"UPDATE file_change_blobs SET status='future_state'",
		"UPDATE file_change_storage_budgets SET status='future_state'",
	])("refuses unsettled or unknown business state without mutation: %s", (sql) => {
		db.exec(sql);
		const before = fixtureSnapshot(db);
		failure(() => applyFileHistoryRepair(db, identity, options));
		expect(fixtureSnapshot(db)).toEqual(before);
		expect(db.inTransaction).toBe(false);
	});

	test.each([
		"ALTER TABLE file_change_effects ADD COLUMN future_blob_digest TEXT",
		"CREATE TRIGGER unsafe_history_update AFTER UPDATE ON file_change_effects BEGIN UPDATE unrelated_business SET payload='damaged'; END",
		"CREATE TABLE future_blob_root (id TEXT PRIMARY KEY, blob_digest TEXT REFERENCES file_change_blobs(digest) ON DELETE CASCADE)",
		"CREATE UNIQUE INDEX future_reason ON snapshot_captures(reason); CREATE TABLE future_capture_root (id TEXT PRIMARY KEY, reason TEXT REFERENCES snapshot_captures(reason) ON UPDATE CASCADE)",
		"CREATE UNIQUE INDEX future_state ON file_change_effects(before_state_json); CREATE TABLE future_effect_root (id TEXT PRIMARY KEY, state TEXT REFERENCES file_change_effects(before_state_json) ON UPDATE CASCADE); INSERT INTO future_effect_root VALUES ('protected',(SELECT before_state_json FROM file_change_effects LIMIT 1))",
		"CREATE INDEX future_expression ON file_change_effects(length(before_state_json))",
	])("refuses unknown schema, triggers and cascading reference roots: %s", (sql) => {
		db.exec(sql);
		const before = fixtureSnapshot(db);
		failure(() => preflightFileHistoryRepair(db, identity, options), "unsupported_schema");
		failure(() => applyFileHistoryRepair(db, identity, options), "unsupported_schema");
		expect(fixtureSnapshot(db)).toEqual(before);
	});

	test("rejects an altered existing FK action before cascades can touch protected records", () => {
		db.exec(
			"PRAGMA foreign_keys=OFF; ALTER TABLE file_attributions RENAME TO prior_attributions; CREATE TABLE file_attributions (id TEXT PRIMARY KEY, effect_id TEXT REFERENCES file_change_effects(id) ON UPDATE CASCADE, operation_id TEXT, payload TEXT); INSERT INTO file_attributions SELECT * FROM prior_attributions; DROP TABLE prior_attributions; PRAGMA foreign_keys=ON;",
		);
		const before = fixtureSnapshot(db);
		failure(() => applyFileHistoryRepair(db, identity, options), "unsupported_schema");
		expect(fixtureSnapshot(db)).toEqual(before);
	});

	test("detects targeted dangling history FKs without scanning application message tables", () => {
		db.exec(
			"PRAGMA foreign_keys=OFF; UPDATE file_change_effects SET operation_id='missing'; PRAGMA foreign_keys=ON;",
		);
		const before = fixtureSnapshot(db);
		failure(() => applyFileHistoryRepair(db, identity, options), "foreign_key_violation");
		expect(fixtureSnapshot(db)).toEqual(before);
	});

	test.each([
		"UPDATE file_change_effects SET before_state_json='not json'",
		'UPDATE file_change_effects SET before_state_json=\'{"kind":"future"}\'',
		"UPDATE file_change_effects SET before_blob_digest=NULL",
		'UPDATE file_change_effects SET before_state_json=\'{"kind":"unknown","reason":"expired","blob":{}}\'',
		"UPDATE revert_operation_files SET observed_after_state_json=NULL WHERE id='revert-file'",
		"UPDATE file_change_effects SET before_state_json=replace(printf('%9000s','x'),' ','x')",
		"UPDATE file_change_scopes SET active_lease_id=replace(printf('%9000s','x'),' ','x')",
	])("rejects malformed, mismatched and oversized state metadata: %s", (sql) => {
		db.exec(sql);
		const before = fixtureSnapshot(db);
		failure(() => applyFileHistoryRepair(db, identity, options));
		expect(fixtureSnapshot(db)).toEqual(before);
	});

	test.each([
		"expected_state_json",
		"desired_state_json",
		"observed_after_state_json",
		"compensation_after_state_json",
	])("rejects a non-null reverse digest mismatch for revert %s", (column) => {
		db.query(
			`UPDATE revert_operation_files SET ${column} = replace(${column}, ?, ?)
			WHERE id = 'revert-file'`,
		).run(FIXTURE_DIGEST, "b".repeat(64));
		const before = fixtureSnapshot(db);
		failure(() => preflightFileHistoryRepair(db, identity, options), "invalid_state");
		failure(() => applyFileHistoryRepair(db, identity, options), "invalid_state");
		expect(fixtureSnapshot(db)).toEqual(before);
	});

	test("rolls back completed batches on cancellation and can recover through a fresh connection", () => {
		for (let i = 0; i < 7; i++) addFixtureEffect(db, `effect-${i}`);
		const before = fixtureSnapshot(db);
		let writes = 0;
		failure(
			() =>
				applyFileHistoryRepair(db, identity, {
					...options,
					guard: (phase) => {
						if (phase === "write_batch" && ++writes === 3) throw new Error("fixture cancellation");
					},
				}),
			"maintenance_interrupted",
		);
		expect(writes).toBe(3);
		expect(fixtureSnapshot(db)).toEqual(before);
		db.close();
		db = new Database(path, { readwrite: true, create: false });
		db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;");
		expect(fixtureSnapshot(db)).toEqual(before);
		expect(applyFileHistoryRepair(db, identity, options).committed).toBe(true);
	});

	test("rejects insufficient row budget, unsafe connection and precommit identity changes atomically", () => {
		const before = fixtureSnapshot(db);
		failure(
			() => applyFileHistoryRepair(db, identity, { ...options, maxRows: 1 }),
			"row_budget_exceeded",
		);
		failure(
			() =>
				applyFileHistoryRepair(db, identity, {
					...options,
					beforeCommit: () => {
						throw new Error("identity changed");
					},
				}),
			"maintenance_interrupted",
		);
		db.exec("PRAGMA foreign_keys=OFF;");
		failure(() => applyFileHistoryRepair(db, identity, options), "unsafe_connection");
		db.exec("PRAGMA foreign_keys=ON;");
		expect(fixtureSnapshot(db)).toEqual(before);
	});

	test("keeps ownership of transaction boundaries and rejects nested transactions", () => {
		const before = fixtureSnapshot(db);
		db.exec("BEGIN");
		failure(() => applyFileHistoryRepair(db, identity, options), "transaction_owned");
		expect(db.inTransaction).toBe(true);
		db.exec("ROLLBACK");
		expect(fixtureSnapshot(db)).toEqual(before);
	});

	test("does not misreport committed or ambiguous commit failures as a rollback", () => {
		failure(
			() =>
				applyFileHistoryRepair(db, identity, {
					...options,
					afterCommit: () => {
						throw new Error("guard failed after commit");
					},
				}),
			"maintenance_interrupted",
			"committed",
		);
		expect(verifyFileHistoryRepair(db, identity, options).verified).toBe(true);
	});

	test("retains an unknown commit outcome even when COMMIT actually completed", () => {
		const original = db.exec.bind(db);
		const injected = spyOn(db, "exec").mockImplementation((sql: string) => {
			const result = original(sql);
			if (sql === "COMMIT") throw new Error("lost commit acknowledgement");
			return result;
		});
		restores.push(() => injected.mockRestore());
		failure(
			() => applyFileHistoryRepair(db, identity, options),
			"maintenance_interrupted",
			"unknown",
		);
		expect(verifyFileHistoryRepair(db, identity, options).verified).toBe(true);
	});

	test("a postcommit targeted verification failure is a committed failure", () => {
		failure(
			() =>
				applyFileHistoryRepair(db, identity, {
					...options,
					afterCommit: () => {
						db.exec("UPDATE file_change_storage_budgets SET used_bytes=1");
					},
				}),
			"verification_failed",
			"committed",
		);
		failure(() => verifyFileHistoryRepair(db, identity, options), "verification_failed");
	});

	test("keeps quota and checks generation overflow before mutation", () => {
		db.query("UPDATE file_change_storage_budgets SET generation=?").run(Number.MAX_SAFE_INTEGER);
		const before = fixtureSnapshot(db);
		failure(() => applyFileHistoryRepair(db, identity, options), "generation_overflow");
		expect(fixtureSnapshot(db)).toEqual(before);
	});

	test("revalidates an existing same-digest physical blob, accounts it once and records new history without reviving expired states", async () => {
		const objectRoot = join(root, "objects");
		const oldStore = new FileChangeBlobStore({ root: objectRoot, minimumFreeBytes: 0 });
		await oldStore.putBytes(Buffer.from(FIXTURE_CONTENT), { expectedSize: FIXTURE_REF.sizeBytes });
		applyFileHistoryRepair(db, identity, options);
		const orm = drizzle(db);
		const catalog = new FileChangeBlobCatalog({ db: orm, namespaceKey: FIXTURE_NEW_KEY });
		expect(catalog.initializeNamespace().quotaBytes).toBe(987654321);
		const publications: boolean[] = [];
		const admission = catalog.admission({ ownerEpoch: "new-writer" });
		const store = new FileChangeBlobStore({
			root: objectRoot,
			minimumFreeBytes: 0,
			admission: {
				reserve: async (request) => {
					const lease = await admission.reserve(request);
					return {
						release: (result) => {
							publications.push(result.published);
							return lease.release(result);
						},
					};
				},
			},
		});
		expect(
			await store.putBytes(Buffer.from(FIXTURE_CONTENT), { expectedSize: FIXTURE_REF.sizeBytes }),
		).toEqual(FIXTURE_REF);
		expect(publications).toEqual([false]);
		expect(
			db.query("SELECT used_bytes, quota_bytes, generation FROM file_change_storage_budgets").get(),
		).toEqual({ used_bytes: FIXTURE_REF.sizeBytes, quota_bytes: 987654321, generation: 42 });
		await store.putBytes(Buffer.from(FIXTURE_CONTENT), { expectedSize: FIXTURE_REF.sizeBytes });
		expect(
			db
				.query<{ used_bytes: number }, []>("SELECT used_bytes FROM file_change_storage_budgets")
				.get()?.used_bytes,
		).toBe(FIXTURE_REF.sizeBytes);
		const scope = orm.select().from(fileChangeScopes).get();
		if (!scope) throw new Error("Missing fixture scope");
		const target = createFileChangeIdentity(scope, {
			deviceId: "local",
			pathFlavor: "posix",
			lexicalPath: "/fixture/workspace/new.txt",
			canonicalPath: "/fixture/workspace/new.txt",
			objectRole: "referent",
		});
		const evidence = new FileChangeEvidenceService(orm);
		const operation = evidence.beginOperation({
			sourceInstanceId: "source",
			sourceKind: "tool",
			sourceId: "new-tool-call",
			attempt: 1,
			requestDigest: "9".repeat(64),
			expectedEffectCount: 1,
			actor: {
				kind: "human",
				subjectKey: "human:user",
				userId: "user",
				narratorId: null,
				label: "Fixture",
				deleted: false,
				parentSubjectKey: null,
			},
			narratorId: "narrator",
			projectId: "project",
			ownerUserId: "user",
		});
		const nextState = { kind: "regular" as const, blob: FIXTURE_REF, mode: 0o644 };
		const effect = evidence.recordEffect({
			operationId: operation.id,
			identity: target,
			before: { kind: "absent" },
			intendedAfter: nextState,
			observedAfter: nextState,
			outcome: "applied",
		});
		expect(effect.observedAfterBlobDigest).toBe(FIXTURE_DIGEST);
		expect(evidence.finishOperation(operation.id, "succeeded").settlement).toBe("settled");
		expect(
			JSON.parse(
				db
					.query<{ before_state_json: string }, []>(
						"SELECT before_state_json FROM file_change_effects WHERE id='effect'",
					)
					.get()?.before_state_json ?? "null",
			),
		).toEqual(expired);
		const plans = new RevertPlanService(orm, {
			namespaceKey: FIXTURE_NEW_KEY,
			now: () => new Date(repairedAt + 1).toISOString(),
		});
		const oldPlan = orm
			.select()
			.from(revertOperations)
			.where(eq(revertOperations.id, "revert-planned"))
			.get();
		if (!oldPlan) throw new Error("Missing fixture plan");
		// summary() uses only the supplied row; no worker connection or application DB is opened.
		const summary = Reflect.apply(Reflect.get(plans, "summary"), plans, [oldPlan]);
		expect(summary).toMatchObject({
			status: "expired",
			expired: true,
			manifestDigests: { selector: null, plan: null, history: null },
		});
	});

	test("refuses a corrupted retained object without publishing catalog metadata or reviving a preview", async () => {
		const objectRoot = join(root, "objects");
		const store = new FileChangeBlobStore({ root: objectRoot, minimumFreeBytes: 0 });
		await store.putBytes(Buffer.from(FIXTURE_CONTENT), { expectedSize: FIXTURE_REF.sizeBytes });
		applyFileHistoryRepair(db, identity, options);
		await writeFile(
			join(objectRoot, "sha256", FIXTURE_DIGEST.slice(0, 2), FIXTURE_DIGEST),
			"x".repeat(FIXTURE_REF.sizeBytes),
		);
		const catalog = new FileChangeBlobCatalog({ db: drizzle(db), namespaceKey: FIXTURE_NEW_KEY });
		const next = new FileChangeBlobStore({
			root: objectRoot,
			minimumFreeBytes: 0,
			admission: catalog.admission({ ownerEpoch: "new-writer" }),
		});
		await expect(
			next.putBytes(Buffer.from(FIXTURE_CONTENT), { expectedSize: FIXTURE_REF.sizeBytes }),
		).rejects.toMatchObject({ code: "hash_mismatch" });
		expect(db.query("SELECT * FROM file_change_blobs").all()).toEqual([]);
		expect(db.query("SELECT used_bytes FROM file_change_storage_budgets").get()).toEqual({
			used_bytes: 0,
		});
		expect(
			db
				.query("SELECT status, plan_blob_digest FROM revert_operations WHERE id='revert-planned'")
				.get(),
		).toEqual({ status: "expired", plan_blob_digest: null });
	});

	test("readonly check uses an explicitly opened existing DB without changing fixture bytes", () => {
		const reader = new Database(path, { readonly: true, create: false });
		try {
			reader.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;");
			expect(preflightFileHistoryRepair(reader, identity, options).budget.updatedAt).toBe(
				FIXTURE_NOW,
			);
		} finally {
			reader.close();
		}
	});
});
