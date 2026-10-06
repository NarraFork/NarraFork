import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import * as schema from "@server/db/schema";
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import {
	FileChangeRetentionInventory,
	type FileChangeRetentionInventoryCursor,
	type FileChangeRetentionInventoryOptions,
	type FileChangeRetentionInventoryPage,
	type FileChangeRetentionInventoryRoot,
	FILE_CHANGE_RETENTION_INVENTORY_LIMITS as LIMITS,
} from "./file-change-retention-inventory";

// All current blob FK roots and typed state columns are present. Deliberately no
// app DB import, filesystem/blob-store access, migrations or production connection.
// Enum declarations in Drizzle are not SQL CHECKs: corruption tests need this fact.
const DDL = `
CREATE TABLE file_change_blobs (
 id TEXT PRIMARY KEY NOT NULL, digest TEXT NOT NULL, size_bytes INTEGER NOT NULL,
 storage_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'staging', lease_until TEXT,
 gc_generation INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_fc_blob_digest ON file_change_blobs(digest);
CREATE INDEX idx_fc_blob_gc ON file_change_blobs(status,lease_until,updated_at);
CREATE TABLE file_change_storage_budgets (
 id TEXT PRIMARY KEY NOT NULL, namespace_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unverified',
 used_bytes INTEGER NOT NULL DEFAULT 0, reserved_bytes INTEGER NOT NULL DEFAULT 0,
 quota_bytes INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 0, reconciled_at TEXT, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_fc_storage_namespace ON file_change_storage_budgets(namespace_key);
CREATE TABLE file_change_blob_reservations (
 id TEXT PRIMARY KEY NOT NULL, budget_id TEXT NOT NULL REFERENCES file_change_storage_budgets(id),
 owner_epoch TEXT NOT NULL DEFAULT 'writer', generation INTEGER NOT NULL DEFAULT 1,
 expected_size INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'reserved',
 blob_digest TEXT REFERENCES file_change_blobs(digest), published INTEGER,
 created_at TEXT NOT NULL, settled_at TEXT
);
CREATE INDEX idx_fc_reservation_budget ON file_change_blob_reservations(budget_id,status,created_at,id);
CREATE INDEX idx_fc_reservation_owner ON file_change_blob_reservations(owner_epoch,status);
CREATE INDEX idx_fc_reservation_blob ON file_change_blob_reservations(blob_digest);
CREATE TABLE file_change_operations (
 id TEXT PRIMARY KEY NOT NULL, source_instance_id TEXT NOT NULL DEFAULT 'source',
 source_kind TEXT NOT NULL DEFAULT 'tool', source_id TEXT NOT NULL DEFAULT 'attempt',
 narrator_id TEXT, execution_outcome TEXT NOT NULL DEFAULT 'succeeded',
 settlement TEXT NOT NULL DEFAULT 'settled'
);
CREATE TABLE file_change_effects (
 id TEXT PRIMARY KEY NOT NULL, operation_id TEXT REFERENCES file_change_operations(id),
 before_state_json TEXT NOT NULL DEFAULT '{"kind":"absent"}',
 intended_after_state_json TEXT NOT NULL DEFAULT '{"kind":"absent"}',
 observed_after_state_json TEXT NOT NULL DEFAULT '{"kind":"unknown","reason":"missing_after"}',
 before_blob_digest TEXT REFERENCES file_change_blobs(digest),
 intended_after_blob_digest TEXT REFERENCES file_change_blobs(digest),
 observed_after_blob_digest TEXT REFERENCES file_change_blobs(digest),
 settlement TEXT NOT NULL DEFAULT 'settled', phase TEXT NOT NULL DEFAULT 'apply'
);
CREATE INDEX idx_fc_effect_before_blob ON file_change_effects(before_blob_digest);
CREATE INDEX idx_fc_effect_intended_blob ON file_change_effects(intended_after_blob_digest);
CREATE INDEX idx_fc_effect_observed_blob ON file_change_effects(observed_after_blob_digest);
CREATE TABLE snapshot_captures (
 id TEXT PRIMARY KEY NOT NULL, manifest_blob_digest TEXT REFERENCES file_change_blobs(digest),
 coverage TEXT NOT NULL DEFAULT 'partial'
);
CREATE INDEX idx_snapshot_capture_manifest ON snapshot_captures(manifest_blob_digest);
CREATE TABLE revert_operations (
 id TEXT PRIMARY KEY NOT NULL,
 selector_blob_digest TEXT REFERENCES file_change_blobs(digest),
 plan_blob_digest TEXT REFERENCES file_change_blobs(digest),
 history_manifest_blob_digest TEXT REFERENCES file_change_blobs(digest),
 kind TEXT NOT NULL DEFAULT 'revert', status TEXT NOT NULL DEFAULT 'planned',
 expires_at TEXT NOT NULL DEFAULT '2025-01-01T00:00:00.000Z',
 created_at TEXT NOT NULL DEFAULT '2025-01-01T00:00:00.000Z'
);
CREATE INDEX idx_revert_operation_plan_blob ON revert_operations(plan_blob_digest);
CREATE INDEX idx_revert_operation_selector_blob ON revert_operations(selector_blob_digest);
CREATE INDEX idx_revert_operation_history_blob ON revert_operations(history_manifest_blob_digest);
CREATE TABLE revert_operation_files (
 id TEXT PRIMARY KEY NOT NULL, revert_operation_id TEXT REFERENCES revert_operations(id),
 expected_state_json TEXT NOT NULL DEFAULT '{"kind":"absent"}',
 desired_state_json TEXT NOT NULL DEFAULT '{"kind":"absent"}', observed_after_state_json TEXT,
 before_blob_digest TEXT REFERENCES file_change_blobs(digest),
 desired_blob_digest TEXT REFERENCES file_change_blobs(digest),
 observed_after_blob_digest TEXT REFERENCES file_change_blobs(digest),
 compensation_after_state_json TEXT,
 compensation_after_blob_digest TEXT REFERENCES file_change_blobs(digest),
 status TEXT NOT NULL DEFAULT 'prepared'
);
CREATE INDEX idx_revert_file_before_blob ON revert_operation_files(before_blob_digest);
CREATE INDEX idx_revert_file_desired_blob ON revert_operation_files(desired_blob_digest);
CREATE INDEX idx_revert_file_observed_blob ON revert_operation_files(observed_after_blob_digest);
CREATE INDEX idx_revert_file_compensation_blob ON revert_operation_files(compensation_after_blob_digest);
`;
const NOW = "2026-09-07T12:00:00.000Z";
const OLD = "2025-01-01T00:00:00.000Z";
const NAMESPACE = "isolated-physical-store";
const ROOTS = [
	["file_change_effects", "before_blob_digest", "before_state_json"],
	["file_change_effects", "intended_after_blob_digest", "intended_after_state_json"],
	["file_change_effects", "observed_after_blob_digest", "observed_after_state_json"],
	["snapshot_captures", "manifest_blob_digest", null],
	["revert_operations", "selector_blob_digest", null],
	["revert_operations", "plan_blob_digest", null],
	["revert_operations", "history_manifest_blob_digest", null],
	["revert_operation_files", "before_blob_digest", "expected_state_json"],
	["revert_operation_files", "desired_blob_digest", "desired_state_json"],
	["revert_operation_files", "observed_after_blob_digest", "observed_after_state_json"],
	["file_change_blob_reservations", "blob_digest", null],
	["revert_operation_files", "compensation_after_blob_digest", "compensation_after_state_json"],
] as const;
type Root = (typeof ROOTS)[number];
interface ReadRecord {
	sql: string;
	bindings: SQLQueryBindings[];
}
let sqlite: Database;
let inventory: FileChangeRetentionInventory;
let queries: ReadRecord[];
let afterRead: ((record: ReadRecord) => void) | undefined;
let serial: number;

beforeEach(() => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	setSystemTime(new Date(NOW));
	sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;");
	sqlite.exec(DDL);
	sqlite
		.query(`INSERT INTO file_change_storage_budgets
	 (id,namespace_key,status,quota_bytes,generation,reconciled_at,updated_at)
	 VALUES ('file-change-blobs',?,'ready',?,1,?,?)`)
		.run(NAMESPACE, FILE_CHANGE_LIMITS.blobSoftQuotaBytes, NOW, NOW);
	queries = [];
	afterRead = undefined;
	serial = 0;
	inventory = createInventory();
});
afterEach(() => {
	sqlite.close();
	setSystemTime();
});

function createInventory(overrides: Partial<FileChangeRetentionInventoryOptions> = {}) {
	// A transparent read-only surface records actual SQL + parameters, not a fake DB.
	const query = new Proxy(sqlite.query.bind(sqlite), {
		apply(target, receiver, args) {
			const statement = Reflect.apply(target, receiver, args);
			return new Proxy(statement, {
				get(target, property) {
					if (property === "all")
						return (...bindings: SQLQueryBindings[]) => {
							const record = { sql: args[0] as string, bindings };
							queries.push(record);
							const result = target.all(...bindings);
							afterRead?.(record);
							return result;
						};
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		},
	});
	return new FileChangeRetentionInventory({
		db: {
			query,
			get inTransaction() {
				return sqlite.inTransaction;
			},
		},
		maintenanceCaller: { kind: "maintenance", subjectKey: "trusted-test-maintainer" },
		namespaceKey: NAMESPACE,
		expectedGeneration: 1,
		durationMs: LIMITS.maximumDurationMs,
		...overrides,
	});
}
function digest(n: number): string {
	return n.toString(16).padStart(64, "0");
}
function blob(
	n: number,
	options: {
		createdAt?: string;
		updatedAt?: string;
		status?: string;
		lease?: string;
		generation?: number;
		id?: string;
	} = {},
) {
	const hash = digest(n);
	sqlite
		.query(`INSERT INTO file_change_blobs
	 (id,digest,size_bytes,storage_key,status,lease_until,gc_generation,created_at,updated_at)
	 VALUES (?,?,3,?,?,?,?,?,?)`)
		.run(
			options.id ?? `blob-${n}`,
			hash,
			`sha256/${hash.slice(0, 2)}/${hash}`,
			options.status ?? "ready",
			options.lease ?? null,
			options.generation ?? 1,
			options.createdAt ?? OLD,
			options.updatedAt ?? options.createdAt ?? OLD,
		);
	return hash;
}
function state(hash: string, kind: "regular" | "symlink" = "regular") {
	return JSON.stringify({
		kind,
		[kind === "regular" ? "blob" : "target"]: { algorithm: "sha256", digest: hash, sizeBytes: 3 },
		mode: 0o644,
	});
}
function pin(root: Root, hash: string, fields: Record<string, string | number | null> = {}) {
	const [table, column, stateColumn] = root;
	const record: Record<string, string | number | null> = { id: `root-${serial++}`, [column]: hash };
	if (stateColumn) record[stateColumn] = state(hash);
	if (table === "file_change_blob_reservations")
		Object.assign(record, {
			budget_id: "file-change-blobs",
			created_at: OLD,
			status: "settled",
			published: 1,
			settled_at: OLD,
		});
	Object.assign(record, fields);
	sqlite
		.query(
			`INSERT INTO ${table} (${Object.keys(record).join(",")}) VALUES (${Object.keys(record)
				.map(() => "?")
				.join(",")})`,
		)
		.run(...Object.values(record));
}
function readPage(cursor?: FileChangeRetentionInventoryCursor, limit?: number) {
	return inventory.listPage({
		signal: new AbortController().signal,
		...(cursor ? { cursor } : {}),
		...(limit ? { limit } : {}),
	});
}
function names(roots: FileChangeRetentionInventoryRoot[]) {
	return roots.map((root) => `${root.table}.${root.column}`).sort();
}
function assertNoAuthority(page: FileChangeRetentionInventoryPage) {
	expect(page).toMatchObject({
		readOnly: true,
		noDeletionAuthority: true,
		physicalInventory: "not_checked",
		temporaryInventory: "not_checked",
		referenceCompleteness: "unknown",
	});
	expect(page.items.every((item) => item.candidate === false)).toBe(true);
	expect(page.metrics.metadataBytes).toBeLessThanOrEqual(LIMITS.metadataBytes);
	expect(page.metrics.responseBytes).toBe(Buffer.byteLength(JSON.stringify(page)));
	expect(page.metrics.responseBytes).toBeLessThanOrEqual(LIMITS.summaryBytes);
	expect(page.metrics.queries).toBeLessThanOrEqual(LIMITS.queries);
}

describe("read-only blob retention inventory", () => {
	test("fixture covers EVERY blob digest FK in the current schema, including reservation journals", async () => {
		const actual: string[] = [];
		for (const table of Object.values(schema)) {
			if (!is(table, SQLiteTable)) continue;
			const config = getTableConfig(table);
			for (const fk of config.foreignKeys) {
				const reference = fk.reference();
				if (reference.foreignTable !== schema.fileChangeBlobs) continue;
				for (let i = 0; i < reference.columns.length; i++) {
					expect(reference.foreignColumns[i]?.name).toBe("digest");
					actual.push(`${config.name}.${reference.columns[i]?.name}`);
				}
			}
		}
		const page = await readPage();
		expect(page.status).toBe("exhausted");
		expect(names(page.referenceRoots)).toEqual(actual.sort());
		expect(page.referenceRoots).toHaveLength(12);
		expect(page.referenceRoots).toContainEqual({
			table: "revert_operation_files",
			column: "compensation_after_blob_digest",
			index: "idx_revert_file_compensation_blob",
			stateColumn: "compensation_after_state_json",
		});
		expect(page.issues.map((issue) => issue.code)).toContain(
			"typed_state_reverse_constraints_missing",
		);
		assertNoAuthority(page);
	});

	for (const root of ROOTS)
		test(`pins ${root[0]}.${root[1]} without a lifecycle filter`, async () => {
			pin(root, blob(1));
			const page = await readPage();
			expect(page.status).toBe("exhausted");
			expect(page.items[0]).toMatchObject({
				retention: "retained",
				indexedReferences: "present",
				potentiallyUnreferenced: false,
				inconsistentStateSamples: [],
			});
			expect(page.items[0]?.references.map((i) => page.referenceRoots[i]?.column)).toContain(
				root[1],
			);
			assertNoAuthority(page);
		});

	test("retained/reverted/compensating/failed/unsettled and detached skipRevert/COW effects still pin", async () => {
		for (const [i, scenario] of [
			"retained",
			"reverted",
			"compensating",
			"failed",
			"skipRevert",
			"COW",
			"unsettled",
		].entries()) {
			const id = `operation-${i}`;
			sqlite
				.query(`INSERT INTO file_change_operations (id,source_kind,source_id,narrator_id,execution_outcome,settlement)
			 VALUES (?,?,?,NULL,?,?)`)
				.run(
					id,
					scenario === "reverted" ? "revert" : "tool",
					scenario,
					scenario === "failed" ? "failed" : "succeeded",
					scenario === "unsettled" ? "reconcile_required" : "settled",
				);
			pin(ROOTS[i % 3] as Root, blob(i + 1), {
				operation_id: id,
				settlement: scenario === "unsettled" ? "applying" : "settled",
				phase: scenario === "compensating" ? "compensate" : "apply",
			});
		}
		const page = await readPage();
		expect(page.items).toHaveLength(7);
		expect(page.items.every((item) => item.retention === "retained")).toBe(true);
		expect(
			queries.every(({ sql }) => !/JOIN|narrator_messages|file_change_operations\b/.test(sql)),
		).toBe(true);
		assertNoAuthority(page);
	});

	for (const status of ["compensating", "compensated", "unknown"])
		test(`compensation third-state evidence stays pinned alongside original apply roots (${status})`, async () => {
			const before = blob(1);
			const desired = blob(2);
			const applied = blob(3);
			const thirdState = blob(4);
			sqlite
				.query("INSERT INTO revert_operations(id,status) VALUES ('revert',?)")
				.run(status === "unknown" ? "recovery_required" : status);
			pin(ROOTS[9], applied, {
				id: "compensation-file",
				revert_operation_id: "revert",
				expected_state_json: state(before),
				before_blob_digest: before,
				desired_state_json: state(desired),
				desired_blob_digest: desired,
				compensation_after_state_json: state(thirdState),
				compensation_after_blob_digest: thirdState,
				status,
			});
			// The third observation must not replace/unpin the earlier apply evidence.
			const unchanged = sqlite.serialize();
			sqlite.exec("PRAGMA query_only = ON");
			const page = await readPage();
			expect(page.items).toHaveLength(4);
			for (const [hash, column] of [
				[before, "before_blob_digest"],
				[desired, "desired_blob_digest"],
				[applied, "observed_after_blob_digest"],
				[thirdState, "compensation_after_blob_digest"],
			]) {
				const item = page.items.find((item) => item.digest === hash);
				expect(item).toMatchObject({
					retention: "retained",
					indexedReferences: "present",
					potentiallyUnreferenced: false,
					inconsistentStateSamples: [],
					candidate: false,
				});
				expect(item?.references.map((i) => page.referenceRoots[i]?.column)).toEqual([column]);
			}
			expect(sqlite.serialize()).toEqual(unchanged);
			assertNoAuthority(page);
		});

	test("a mismatched compensation typed pin remains unknown without releasing the apply pin", async () => {
		const applied = blob(1);
		const pinnedCompensation = blob(2);
		const jsonOnlyCompensation = blob(3);
		pin(ROOTS[9], applied, {
			compensation_after_blob_digest: pinnedCompensation,
			compensation_after_state_json: state(jsonOnlyCompensation),
			status: "unknown",
		});
		const page = await readPage();
		expect(page.items[0]).toMatchObject({ digest: applied, retention: "retained" });
		expect(page.items[1]).toMatchObject({
			digest: pinnedCompensation,
			retention: "unknown",
			indexedReferences: "present",
		});
		expect(
			page.items[1]?.inconsistentStateSamples.map((i) => page.referenceRoots[i]?.column),
		).toEqual(["compensation_after_blob_digest"]);
		expect(page.items[2]).toMatchObject({
			digest: jsonOnlyCompensation,
			retention: "unknown",
			indexedReferences: "none_observed",
			candidate: false,
		});
		assertNoAuthority(page);
	});

	test("multi-source shared hash is one metadata item, not duplicate accounting", async () => {
		const hash = blob(1);
		for (let n = 0; n < 120; n++) pin(ROOTS[n % ROOTS.length] as Root, hash);
		const before = sqlite.serialize();
		sqlite.exec("PRAGMA query_only = ON");
		const page = await readPage();
		expect(page.items).toHaveLength(1);
		expect(page.items[0]?.references).toHaveLength(ROOTS.length);
		expect(page.metrics.referenceProbes).toBe(ROOTS.length);
		expect(sqlite.serialize()).toEqual(before);
		expect(
			queries.every(
				({ sql }) => !/\b(COUNT|SUM|GROUP BY|DELETE|UPDATE|INSERT|REPLACE)\b/i.test(sql),
			),
		).toBe(true);
		assertNoAuthority(page);
	});

	test("manifest-only expired/cancelled/old completed revert and unrevert remain pinned", async () => {
		for (const [i, status] of [
			"expired",
			"cancelled",
			"committed",
			"compensating",
			"recovery_required",
		].entries()) {
			pin(ROOTS[4 + (i % 3)] as Root, blob(i + 1), { status, kind: i % 2 ? "unrevert" : "revert" });
		}
		pin(ROOTS[3], blob(9));
		const page = await readPage();
		expect(page.items).toHaveLength(6);
		expect(page.items.every((item) => item.retention === "retained")).toBe(true);
		assertNoAuthority(page);
	});

	test("old reverse misses are UNKNOWN, not candidates or proof of file absence", async () => {
		blob(1);
		blob(2, { status: "missing" });
		blob(3, { status: "expired" });
		blob(4, { status: "staging" });
		const page = await readPage();
		expect(page.items[0]).toMatchObject({
			indexedReferences: "none_observed",
			retention: "unknown",
			potentiallyUnreferenced: true,
			candidate: false,
		});
		expect(page.items.slice(1).every((item) => item.reasons.includes("catalog_not_ready"))).toBe(
			true,
		);
		expect("delete" in inventory || "readBytes" in inventory || "getByDigest" in inventory).toBe(
			false,
		);
		assertNoAuthority(page);
	});

	test("new objects, renewed metadata, leases and generation gaps cannot become candidates", async () => {
		const recent = new Date(
			Date.parse(NOW) - FILE_CHANGE_LIMITS.unreferencedGraceMs + 1,
		).toISOString();
		blob(1, { createdAt: recent });
		blob(2, { updatedAt: recent });
		blob(3, { lease: NOW });
		blob(4, { generation: 0 });
		const page = await readPage();
		expect(page.items[0]?.reasons).toContain("within_grace_period");
		expect(page.items[1]?.reasons).toContain("within_grace_period");
		expect(page.items[2]?.reasons).toContain("active_blob_lease");
		expect(page.items[3]?.reasons).toContain("blob_generation_unverified");
		assertNoAuthority(page);
	});

	for (const status of ["reserved", "reconcile_required"])
		test(`zero-byte ${status} reservation without a digest still holds the whole namespace`, async () => {
			blob(1);
			sqlite
				.query(
					"INSERT INTO file_change_blob_reservations(id,budget_id,status,created_at) VALUES ('pending','file-change-blobs',?,?)",
				)
				.run(status, OLD);
			const page = await readPage();
			expect(page.pendingReservations).toBe("present");
			expect(page.issues.map((issue) => issue.code)).toContain(
				"pending_or_unacknowledged_reservation",
			);
			assertNoAuthority(page);
		});

	for (const status of ["unverified", "reconciling"] as const)
		test(`${status} namespace does not acquire deletion authority`, async () => {
			blob(1);
			sqlite.query("UPDATE file_change_storage_budgets SET status = ?").run(status);
			const page = await readPage();
			expect(page.namespaceStatus).toBe(status);
			expect(page.issues.map((issue) => issue.code)).toContain("namespace_unverified");
			assertNoAuthority(page);
		});

	test("new pending reservation arriving during a page is kept by the final fence", async () => {
		blob(1);
		afterRead = ({ sql }) => {
			if (!sql.includes(" AS r0")) return;
			afterRead = undefined;
			sqlite
				.query(
					"INSERT INTO file_change_blob_reservations(id,budget_id,status,created_at) VALUES ('pending','file-change-blobs','reserved',?)",
				)
				.run(OLD);
		};
		const page = await readPage();
		expect(page.pendingReservations).toBe("present");
		assertNoAuthority(page);
	});

	test("namespace key switching and an extra singleton row cannot bypass the guard", async () => {
		blob(1);
		await expect(
			createInventory({ namespaceKey: "another-source" }).listPage({
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: "namespace_mismatch" });
		sqlite
			.query(`INSERT INTO file_change_storage_budgets(id,namespace_key,status,quota_bytes,generation,reconciled_at,updated_at)
		 VALUES ('extra','another-source','ready',0,1,?,?)`)
			.run(NOW, NOW);
		await expect(readPage()).rejects.toMatchObject({ code: "namespace_mismatch" });
		await expect(
			createInventory({ namespaceKey: "another-source" }).listPage({
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: "namespace_mismatch" });
	});

	test("generation drift within a page and between pages rejects the observation", async () => {
		blob(1);
		blob(2);
		const first = await readPage(undefined, 1);
		expect(first.nextCursor).not.toBeNull();
		afterRead = ({ sql }) => {
			if (!sql.includes(" AS r0")) return;
			afterRead = undefined;
			sqlite.exec("UPDATE file_change_storage_budgets SET generation = generation + 1");
		};
		await expect(
			readPage(first.nextCursor as FileChangeRetentionInventoryCursor),
		).rejects.toMatchObject({ code: "generation_changed" });
		await expect(
			readPage(first.nextCursor as FileChangeRetentionInventoryCursor),
		).rejects.toMatchObject({ code: "generation_changed" });
	});

	test("aborted pages stop reads, preserve incomplete information, and carry no candidate", async () => {
		blob(1);
		blob(2);
		const controller = new AbortController();
		controller.abort();
		const empty = await inventory.listPage({ signal: controller.signal });
		expect(empty.status).toBe("cancelled");
		expect(queries).toHaveLength(0);
		const middle = new AbortController();
		let probes = 0;
		afterRead = ({ sql }) => {
			if (sql.includes(" AS r0") && ++probes === 2) middle.abort();
		};
		const partial = await inventory.listPage({ signal: middle.signal });
		expect(partial.status).toBe("cancelled");
		expect(partial.catalogWindowExhausted).toBe(false);
		expect(partial.items[0]?.retention).toBe("unknown");
		expect(partial.issues.some((issue) => issue.code === "cancelled")).toBe(true);
		assertNoAuthority(partial);
	});

	test("time budget stops after bounded work and reports a structured slow event", async () => {
		blob(1);
		const events: unknown[] = [];
		inventory = createInventory({ durationMs: 60, onSlow: (event) => events.push(event) });
		afterRead = () => {
			afterRead = undefined;
			const deadline = performance.now() + 65;
			while (performance.now() < deadline) {
				/* Simulate one delayed read, no production lock. */
			}
		};
		const page = await readPage();
		expect(page.status).toBe("budget_exceeded");
		expect(page.metrics.queries).toBe(1);
		expect(events).toHaveLength(1);
		expect(JSON.stringify(events)).not.toContain(NAMESPACE);
		assertNoAuthority(page);
	});

	test("NULL reverse pins, wrong typed digests, malformed and oversized JSON never produce false candidates", async () => {
		const a = blob(1),
			b = blob(2),
			c = blob(3),
			d = blob(4);
		pin(ROOTS[0], a, { before_state_json: state(b) });
		// b is referred to only by JSON; querying only reverse IS NULL would lose it.
		pin(ROOTS[1], b, { intended_after_blob_digest: null, intended_after_state_json: state(b) });
		pin(ROOTS[7], c, { expected_state_json: "not json" });
		pin(ROOTS[9], d, {
			observed_after_state_json: JSON.stringify({
				kind: "regular",
				blob: { digest: d },
				padding: "x".repeat(FILE_CHANGE_LIMITS.previewFileBytes),
			}),
		});
		const page = await readPage();
		expect(page.items.every((item) => item.retention === "unknown")).toBe(true);
		expect(page.items[0]?.inconsistentStateSamples.length).toBeGreaterThan(0);
		expect(page.items[1]?.indexedReferences).toBe("none_observed");
		expect(page.items[2]?.inconsistentStateSamples.length).toBeGreaterThan(0);
		expect(page.items[3]?.inconsistentStateSamples.length).toBeGreaterThan(0);
		expect(JSON.stringify(page)).not.toContain("padding");
		assertNoAuthority(page);
	});

	test("symlink state refs are witnesses too, but LIMIT 1 never certifies every row", async () => {
		const hash = blob(1);
		pin(ROOTS[0], hash, { before_state_json: state(hash, "symlink") });
		pin(ROOTS[0], hash, { before_state_json: state(digest(999)) });
		const page = await readPage();
		expect(page.items[0]?.references.length).toBeGreaterThan(0);
		expect(page.typedStateReverseIntegrity).toBe("not_enforced");
		assertNoAuthority(page);
	});

	test("future indexed FK tables are discovered automatically, not just a hardcoded list", async () => {
		const hash = blob(1);
		sqlite.exec(
			"CREATE TABLE future_export_pins(id TEXT PRIMARY KEY, blob_digest TEXT REFERENCES file_change_blobs(digest)); CREATE INDEX idx_future_blob ON future_export_pins(blob_digest);",
		);
		sqlite.query("INSERT INTO future_export_pins VALUES ('export',?)").run(hash);
		const page = await readPage();
		expect(page.referenceRoots).toHaveLength(ROOTS.length + 1);
		expect(page.items[0]?.retention).toBe("retained");
		expect(page.items[0]?.references.map((i) => page.referenceRoots[i]?.table)).toContain(
			"future_export_pins",
		);
		assertNoAuthority(page);
	});

	test("unindexed, partial and non-BINARY FK roots are UNKNOWN with no table-scan fallback", async () => {
		const hash = blob(1);
		sqlite.exec(`CREATE TABLE future_unindexed(id TEXT PRIMARY KEY, blob_digest TEXT REFERENCES file_change_blobs(digest));
		 CREATE INDEX idx_partial ON future_unindexed(blob_digest) WHERE id = 'one';
		 CREATE INDEX idx_nocase ON future_unindexed(blob_digest COLLATE NOCASE);`);
		sqlite.query("INSERT INTO future_unindexed VALUES ('export',?)").run(hash);
		const page = await readPage();
		expect(page.issues).toContainEqual({
			code: "missing_reference_index",
			root: "future_unindexed.blob_digest",
		});
		expect(page.items[0]).toMatchObject({
			indexedReferences: "unknown",
			potentiallyUnreferenced: false,
			candidate: false,
		});
		expect(queries.every(({ sql }) => !sql.includes('FROM main."future_unindexed"'))).toBe(true);
		assertNoAuthority(page);
	});

	test("missing current indexes and missing FK tables are reported, not omitted", async () => {
		blob(1);
		sqlite.exec("DROP INDEX idx_fc_effect_before_blob; DROP TABLE snapshot_captures;");
		const page = await readPage();
		expect(page.issues).toContainEqual({
			code: "missing_reference_index",
			root: "file_change_effects.before_blob_digest",
		});
		expect(page.issues).toContainEqual({
			code: "missing_reference_root",
			root: "snapshot_captures.manifest_blob_digest",
		});
		expect(page.items[0]?.indexedReferences).toBe("unknown");
		assertNoAuthority(page);
	});

	test("SQL status values and oversized metadata are validated rather than interpolated", async () => {
		blob(1, {
			status: "ready'; DROP TABLE file_change_blobs;--",
			id: "x".repeat(FILE_CHANGE_LIMITS.previewFileBytes),
		});
		sqlite
			.query(
				"INSERT INTO file_change_blob_reservations(id,budget_id,status,created_at) VALUES ('bad','file-change-blobs',?,?)",
			)
			.run("unknown'; SELECT 1;--", OLD);
		const page = await readPage();
		expect(page.items[0]).toMatchObject({
			id: null,
			catalogStatus: "unknown",
			retention: "unknown",
		});
		expect(page.pendingReservations).toBe("present");
		expect(page.issues.map((issue) => issue.code)).toContain("invalid_reservation_status");
		assertNoAuthority(page);
	});

	test("embedded NUL in a stored namespace cannot pass through a truncated string guard", async () => {
		blob(1);
		sqlite
			.query("UPDATE file_change_storage_budgets SET namespace_key = ?")
			.run(`${NAMESPACE}\u0000another-source`);
		await expect(readPage()).rejects.toMatchObject({ code: "namespace_mismatch" });
	});

	test("temporary tables cannot shadow the root database namespace", async () => {
		blob(1);
		sqlite.exec(
			"CREATE TEMP TABLE file_change_storage_budgets AS SELECT * FROM main.file_change_storage_budgets;",
		);
		sqlite
			.query("UPDATE temp.file_change_storage_budgets SET namespace_key = ?")
			.run("other-namespace");
		await expect(
			createInventory({ namespaceKey: "other-namespace" }).listPage({
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: "namespace_mismatch" });
		const page = await readPage();
		expect(page.items).toHaveLength(1);
		assertNoAuthority(page);
	});

	test("SQLite affinity corruption never returns oversized numeric metadata", async () => {
		blob(1);
		const huge = "not-a-number".repeat(FILE_CHANGE_LIMITS.previewFileBytes / 4);
		sqlite
			.query("UPDATE file_change_blobs SET size_bytes = ?, gc_generation = ?, created_at = ?")
			.run(huge, huge, huge);
		const page = await readPage();
		expect(page.items[0]).toMatchObject({
			sizeBytes: null,
			gcGeneration: null,
			createdAt: null,
			retention: "unknown",
		});
		expect(page.metrics.metadataBytes).toBeLessThan(FILE_CHANGE_LIMITS.metadataBytes * 4);
		assertNoAuthority(page);
	});

	test("same-named wrong paging indexes are rejected before a corpus scan", async () => {
		blob(1);
		sqlite.exec(
			"DROP INDEX idx_fc_blob_digest; CREATE UNIQUE INDEX idx_fc_blob_digest ON file_change_blobs(status);",
		);
		const page = await readPage();
		expect(page.status).toBe("read_failed");
		expect(page.issues).toContainEqual({ code: "read_failed", stage: "required_paging_index" });
		expect(queries.every(({ sql }) => !/FROM main\.file_change_blobs\b/.test(sql))).toBe(true);
		assertNoAuthority(page);
	});

	test("typed-state metadata budget is bounded independently of the response size", async () => {
		// A lookahead row keeps pagination independent of how many typed roots fit the budget.
		for (let n = 1; n <= 101; n++) {
			const hash = blob(n);
			for (const root of ROOTS.filter((root) => root[2])) {
				const padded = JSON.stringify({ ...JSON.parse(state(hash)), padding: "x".repeat(4000) });
				pin(root, hash, { [root[2] as string]: padded });
			}
		}
		const page = await readPage();
		expect(page.items.length).toBeGreaterThan(0);
		expect(page.items.length).toBeLessThanOrEqual(100);
		expect(page.nextCursor).not.toBeNull();
		expect(page.metrics.metadataBytes).toBeGreaterThan(200 * 1024);
		assertNoAuthority(page);
	});

	test("hard query count bound includes schema/index discovery", async () => {
		blob(1);
		for (let n = 0; n < 9; n++) {
			sqlite.exec(
				`CREATE TABLE query_budget_${n}(id TEXT PRIMARY KEY, blob_digest TEXT REFERENCES file_change_blobs(digest)); CREATE INDEX pin_${n} ON query_budget_${n}(blob_digest);`,
			);
			for (let i = 0; i < 62; i++)
				sqlite.exec(`CREATE INDEX dummy_${n}_${i} ON query_budget_${n}(id);`);
		}
		const page = await readPage();
		expect(page.status).toBe("budget_exceeded");
		expect(page.catalogWindowExhausted).toBe(false);
		expect(page.metrics.queries).toBe(LIMITS.queries);
		expect(queries).toHaveLength(LIMITS.queries);
		assertNoAuthority(page);
	});

	test("strict cursor and page input validation happens before any SQL", async () => {
		blob(1);
		blob(2);
		const cursor = (await readPage(undefined, 1)).nextCursor as FileChangeRetentionInventoryCursor;
		const bad = [
			{ ...cursor, cutoff: "2026-02-30T00:00:00.000Z" },
			{ ...cursor, cutoff: "2030-01-01T00:00:00.000Z" },
			{ ...cursor, afterDigest: "'; DELETE FROM file_change_blobs; --" },
			{ ...cursor, upperDigest: "F".repeat(64) },
			{ ...cursor, version: 2 },
			{ ...cursor, schemaVersion: 1.5 },
			{ ...cursor, status: "ready" },
		];
		queries = [];
		for (const value of bad)
			await expect(readPage(value as FileChangeRetentionInventoryCursor)).rejects.toMatchObject({
				code: "invalid_input",
			});
		for (const limit of [0, -1, 101, 1.5, NaN])
			await expect(
				inventory.listPage({ signal: new AbortController().signal, limit }),
			).rejects.toMatchObject({ code: "invalid_input" });
		await expect(readPage({ ...cursor, namespaceKey: "other" })).rejects.toMatchObject({
			code: "namespace_mismatch",
		});
		await expect(readPage({ ...cursor, generation: 2 })).rejects.toMatchObject({
			code: "generation_changed",
		});
		expect(queries).toHaveLength(0);
	});

	test("201 equal-millisecond blobs page without loss, fixed cutoff, and event-loop yields", async () => {
		const recent = new Date(
			Date.parse(NOW) - FILE_CHANGE_LIMITS.unreferencedGraceMs + 1,
		).toISOString();
		for (let n = 201; n >= 1; n--) blob(n, { createdAt: recent, id: `same-ms-${202 - n}` });
		let yielded = false;
		setImmediate(() => {
			yielded = true;
		});
		const first = await readPage();
		expect(yielded).toBe(true);
		expect(first.items).toHaveLength(100);
		setSystemTime(new Date(Date.parse(NOW) + 30 * 86400000));
		const second = await readPage(first.nextCursor as FileChangeRetentionInventoryCursor);
		const third = await readPage(second.nextCursor as FileChangeRetentionInventoryCursor);
		expect(second.items).toHaveLength(100);
		expect(third.items).toHaveLength(1);
		expect(third.nextCursor).toBeNull();
		const all = [...first.items, ...second.items, ...third.items];
		expect(new Set(all.map((item) => item.digest)).size).toBe(201);
		expect(all.every((item) => item.reasons.includes("within_grace_period"))).toBe(true);
		expect(second.cutoff).toBe(NOW);
		expect(third.graceCutoff).toBe(first.graceCutoff);
		for (const page of [first, second, third]) assertNoAuthority(page);
	});

	test("schema drift invalidates a cursor, while a fresh page rediscovers new roots", async () => {
		blob(1);
		blob(2);
		const first = await readPage(undefined, 1);
		sqlite.exec(
			"CREATE TABLE future_pin(blob_digest TEXT REFERENCES file_change_blobs(digest)); CREATE INDEX idx_future_pin ON future_pin(blob_digest);",
		);
		await expect(
			readPage(first.nextCursor as FileChangeRetentionInventoryCursor),
		).rejects.toMatchObject({ code: "schema_changed" });
		const fresh = await readPage();
		expect(fresh.referenceRoots).toHaveLength(ROOTS.length + 1);
	});

	test("10,000 blobs: bounded read-only pages, query counts, payload budgets and EXPLAIN indexes", async () => {
		sqlite.transaction(() => {
			for (let n = 1; n <= 10000; n++) blob(n);
		})();
		for (let n = 1; n <= 100; n++) for (const root of ROOTS) pin(root, digest(n));
		const before = sqlite.serialize();
		sqlite.exec("PRAGMA query_only = ON");
		const first = await readPage();
		expect(first.items).toHaveLength(100);
		expect(first.status).toBe("page");
		expect(first.metrics.queries).toBe(queries.length);
		expect(first.metrics.referenceProbes).toBe(100 * ROOTS.length);
		const unique = new Map<string, ReadRecord>();
		for (const record of queries)
			if (
				/FROM main\.file_change_(blobs|blob_reservations|storage_budgets)|FROM main\.sqlite_schema| AS r0/.test(
					record.sql,
				)
			)
				unique.set(record.sql, record);
		const plans: string[] = [];
		for (const { sql, bindings } of unique.values()) {
			const plan = sqlite
				.query<{ detail: string }, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${sql}`)
				.all(...bindings)
				.map((row) => row.detail)
				.join("\n");
			expect(plan).not.toContain("USE TEMP B-TREE");
			expect(plan).not.toMatch(
				/SCAN (?:main\.)?(file_change_effects|snapshot_captures|revert_operations|revert_operation_files|file_change_blob_reservations)\b/,
			);
			plans.push(plan);
		}
		for (const root of first.referenceRoots)
			expect(plans.join("\n")).toContain(`INDEX ${root.index}`);
		expect(plans.join("\n")).toContain(
			"SEARCH main.file_change_blobs USING INDEX idx_fc_blob_digest",
		);
		queries = [];
		const second = await readPage(first.nextCursor as FileChangeRetentionInventoryCursor);
		expect(second.items).toHaveLength(100);
		expect(second.metrics.queries).toBe(queries.length);
		expect(second.metrics.queries).toBeLessThanOrEqual(116);
		expect(queries.every(({ sql }) => /^\s*(SELECT|PRAGMA)/.test(sql))).toBe(true);
		expect(sqlite.serialize()).toEqual(before);
		assertNoAuthority(first);
		assertNoAuthority(second);
		console.info(
			"[retention-inventory 10000-blob fixture]",
			JSON.stringify({ firstPage: first.metrics, secondPage: second.metrics }),
		);
	});

	test("bounded schema discovery and read faults never masquerade as an empty catalog", async () => {
		blob(1);
		for (let n = 0; n < LIMITS.schemaTables; n++)
			sqlite.exec(`CREATE TABLE extra_${n}(id TEXT PRIMARY KEY);`);
		const page = await readPage();
		expect(page.status).toBe("budget_exceeded");
		expect(page.catalogWindowExhausted).toBe(false);
		assertNoAuthority(page);
		sqlite.exec("DROP INDEX idx_fc_reservation_budget;");
		const failed = await readPage();
		expect(failed.status).toBe("read_failed");
		expect(failed.issues.map((issue) => issue.code)).toContain("read_failed");
		expect(failed.catalogWindowExhausted).toBe(false);
		assertNoAuthority(failed);
	});

	test("blocking connection settings and outer transactions are rejected without changing them", async () => {
		sqlite.exec("PRAGMA busy_timeout = 5000");
		await expect(readPage()).rejects.toMatchObject({ code: "connection_not_supported" });
		expect(sqlite.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
		sqlite.exec("PRAGMA busy_timeout = 0; PRAGMA foreign_keys = OFF;");
		await expect(readPage()).rejects.toMatchObject({ code: "connection_not_supported" });
		sqlite.exec("PRAGMA foreign_keys = ON; BEGIN;");
		try {
			await expect(readPage()).rejects.toMatchObject({ code: "root_connection_required" });
		} finally {
			sqlite.exec("ROLLBACK");
		}
	});
});
