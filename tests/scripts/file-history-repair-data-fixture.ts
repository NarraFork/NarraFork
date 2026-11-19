import type { Database, SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const FIXTURE_NOW = "2026-11-07T00:00:00.000Z";
export const FIXTURE_OLD_KEY = "a".repeat(64);
export const FIXTURE_NEW_KEY = "b".repeat(64);
export const FIXTURE_CONTENT = "retained file history bytes\n";
export const FIXTURE_DIGEST = createHash("sha256").update(FIXTURE_CONTENT).digest("hex");
export const FIXTURE_REF = {
	algorithm: "sha256" as const,
	digest: FIXTURE_DIGEST,
	sizeBytes: Buffer.byteLength(FIXTURE_CONTENT),
};
export const FIXTURE_STATE = { kind: "regular", blob: FIXTURE_REF, mode: 0o644 };

const MIGRATIONS = [
	"0150_complex_red_skull.sql",
	"0151_certain_namor.sql",
	"0152_black_the_order.sql",
	"0155_premium_squadron_supreme.sql",
	"0157_tranquil_radioactive_man.sql",
	"0159_huge_hammerhead.sql",
	"0171_chunky_fixer.sql",
	"0177_jittery_wendigo.sql",
	"0179_left_mephisto.sql",
	"0183_watery_titania.sql",
	"0211_editor_operation_recovery.sql",
	"0212_file_write_redesign.sql",
];
const HISTORY_TABLE =
	/^(?:__new_)?(?:file_change_[a-z_]+|file_history_clock|workspace_write_leases|workspace_execution_owners|snapshot_captures|revert_operations|revert_operation_files)$/;

/** Replay only reviewed history DDL into a caller-owned, empty, isolated fixture. */
export function createFileHistoryRepairFixture(db: Database): void {
	if (db.query("SELECT 1 FROM sqlite_master LIMIT 1").get())
		throw new Error("History fixture requires an empty isolated database");
	db.exec(`
		PRAGMA foreign_keys = ON;
		PRAGMA busy_timeout = 0;
		PRAGMA synchronous = FULL;
		PRAGMA journal_mode = WAL;
		PRAGMA wal_autocheckpoint = 0;
		CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, display_name TEXT NOT NULL, secret TEXT);
		CREATE TABLE narrators (id TEXT PRIMARY KEY NOT NULL, user_id TEXT REFERENCES users(id), title TEXT NOT NULL);
		CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL);
		CREATE TABLE narrator_messages (id TEXT PRIMARY KEY NOT NULL, content_json TEXT NOT NULL);
		CREATE TABLE narrator_message_refs (id TEXT PRIMARY KEY NOT NULL, narrator_id TEXT REFERENCES narrators(id), message_id TEXT REFERENCES narrator_messages(id), seq INTEGER NOT NULL);
		CREATE TABLE narrator_tool_calls (id TEXT PRIMARY KEY NOT NULL, output_json TEXT NOT NULL);
		CREATE TABLE unrelated_business (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL);
	`);
	for (const file of MIGRATIONS) {
		const text = readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), "utf8");
		for (const raw of text.split("--> statement-breakpoint")) {
			const statement = raw.trim();
			if (!statement) continue;
			if (/^PRAGMA foreign_keys\s*=/i.test(statement)) {
				db.exec(statement);
				continue;
			}
			const table =
				/^(?:CREATE TABLE|ALTER TABLE|DROP TABLE|INSERT INTO)\s+[`"]?([a-z_0-9]+)/i.exec(
					statement,
				)?.[1] ??
				/^CREATE (?:UNIQUE )?INDEX\s+[`"]?[a-z_0-9]+[`"]?\s+ON\s+[`"]?([a-z_0-9]+)/i.exec(
					statement,
				)?.[1];
			const droppedIndex =
				/^DROP INDEX\s+`?(idx_(?:fc_|revert_|snapshot_|workspace_)[a-z_0-9]+)`?/i.test(statement);
			if ((table && HISTORY_TABLE.test(table)) || droppedIndex) db.exec(statement);
		}
	}
	db.exec(`
		CREATE TABLE file_attributions (
			id TEXT PRIMARY KEY NOT NULL,
			effect_id TEXT REFERENCES file_change_effects(id) ON DELETE SET NULL,
			operation_id TEXT REFERENCES file_change_operations(id),
			payload TEXT NOT NULL
		);
	`);
	insertFixtureRow(db, "users", {
		id: "user",
		display_name: "Fixture user",
		secret: "private fixture secret",
	});
	insertFixtureRow(db, "narrators", { id: "narrator", user_id: "user", title: "Fixture session" });
	insertFixtureRow(db, "projects", { id: "project", title: "Fixture project" });
	insertFixtureRow(db, "narrator_messages", {
		id: "message",
		content_json: JSON.stringify({ text: "business body must remain" }),
	});
	insertFixtureRow(db, "narrator_message_refs", {
		id: "message-ref",
		narrator_id: "narrator",
		message_id: "message",
		seq: 17,
	});
	insertFixtureRow(db, "narrator_tool_calls", {
		id: "tool-call",
		output_json: JSON.stringify({ body: "immutable output" }),
	});
	insertFixtureRow(db, "unrelated_business", {
		id: "business",
		payload: "unrelated protected record",
	});
	insertFixtureRow(db, "file_change_storage_budgets", {
		id: "file-change-blobs",
		namespace_key: FIXTURE_OLD_KEY,
		status: "unverified",
		used_bytes: FIXTURE_REF.sizeBytes,
		reserved_bytes: 0,
		quota_bytes: 987654321,
		generation: 41,
		reconciled_at: null,
		updated_at: FIXTURE_NOW,
	});
	insertFixtureRow(db, "file_change_blobs", {
		id: "blob",
		digest: FIXTURE_DIGEST,
		size_bytes: FIXTURE_REF.sizeBytes,
		storage_key: `sha256/${FIXTURE_DIGEST.slice(0, 2)}/${FIXTURE_DIGEST}`,
		status: "ready",
		created_at: FIXTURE_NOW,
		updated_at: FIXTURE_NOW,
	});
	insertFixtureRow(db, "file_change_blob_reservations", {
		id: "reservation",
		budget_id: "file-change-blobs",
		owner_epoch: "ended-owner",
		generation: 41,
		expected_size: FIXTURE_REF.sizeBytes,
		status: "settled",
		blob_digest: FIXTURE_DIGEST,
		published: 1,
		created_at: FIXTURE_NOW,
		settled_at: FIXTURE_NOW,
	});
	insertFixtureRow(db, "file_change_scopes", {
		id: "scope",
		source_instance_id: "source",
		device_id: "local",
		workspace_instance_id: "workspace",
		canonical_root: "/fixture/workspace",
		display_root: "/fixture/workspace",
		path_flavor: "posix",
		status: "active",
		revision: 7,
		fencing_token: 11,
		created_at: FIXTURE_NOW,
		updated_at: FIXTURE_NOW,
	});
	insertFixtureRow(db, "file_change_operations", {
		id: "operation",
		journal_seq: 31,
		execution_segment_id: "segment",
		evidence_version: 3,
		source_instance_id: "source",
		source_kind: "tool",
		source_id: "tool-call",
		attempt: 1,
		request_digest: "c".repeat(64),
		expected_effect_count: 1,
		prepared_effect_count: 1,
		settled_effect_count: 1,
		narrator_id: "narrator",
		project_id: "project",
		owner_user_id: "user",
		actor_subject_key: "human:user",
		actor_json: JSON.stringify({ kind: "human", subjectKey: "human:user" }),
		execution_outcome: "succeeded",
		effect_outcome: "changed",
		settlement: "settled",
		attribution_grade: "measured",
		coverage: "complete",
		started_at: FIXTURE_NOW,
		finished_at: FIXTURE_NOW,
		updated_at: FIXTURE_NOW,
	});
	insertFixtureRow(db, "file_change_execution_segments", {
		id: "segment",
		narrator_id: "narrator",
		source_tool_call_id: "tool-call",
		created_at: FIXTURE_NOW,
	});
	insertFixtureRow(db, "file_history_clock", { id: 1, last_seq: 31 });
	addFixtureEffect(db, "effect");
	insertFixtureRow(db, "workspace_write_leases", {
		lease_id: "lease",
		scope_id: "scope",
		device_id: "local",
		owner_epoch: "ended-owner",
		execution_class: "local_file_io",
		runtime_epoch: "runtime",
		runtime_generation: 1,
		fencing_token: 11,
		scope_revision: 7,
		path_flavor: "posix",
		status: "settled",
		ranges_json: '{"version":1,"ranges":[]}',
		mutation_manifest_json: '{"version":1,"mutations":[]}',
		execution_ended_at: FIXTURE_NOW,
		created_at: FIXTURE_NOW,
		updated_at: FIXTURE_NOW,
	});
	for (const status of [
		"planned",
		"prepared",
		"committed",
		"partial",
		"failed",
		"compensated",
		"cancelled",
		"expired",
	])
		insertFixtureRow(db, "revert_operations", {
			id: `revert-${status}`,
			protocol_version: 3,
			narrator_id: "narrator",
			project_id: "project",
			requested_by_subject_key: "human:user",
			idempotency_key: `request-${status}`,
			request_digest: "d".repeat(64),
			kind: "revert",
			scope: "narrator",
			selector_kind: "all",
			selector_blob_digest: FIXTURE_DIGEST,
			plan_blob_digest: FIXTURE_DIGEST,
			history_manifest_blob_digest: FIXTURE_DIGEST,
			plan_hash: "e".repeat(64),
			status,
			file_count: 1,
			applied_file_count: status === "committed" ? 1 : 0,
			coverage_complete: 1,
			reason: `audit-${status}`,
			expires_at: "2099-01-01T00:00:00.000Z",
			created_at: FIXTURE_NOW,
			updated_at: FIXTURE_NOW,
		});
	for (const nullable of [false, true]) {
		const id = nullable ? "revert-file-null" : "revert-file";
		insertFixtureRow(db, "revert_operation_files", {
			id,
			revert_operation_id: "revert-planned",
			scope_id: "scope",
			file_key: id,
			identity_json: '{"displayPath":"fixture.txt"}',
			sequence: nullable ? 1 : 0,
			expected_state_json: JSON.stringify(FIXTURE_STATE),
			desired_state_json: JSON.stringify(FIXTURE_STATE),
			observed_after_state_json: nullable ? null : JSON.stringify(FIXTURE_STATE),
			compensation_after_state_json: nullable
				? null
				: JSON.stringify({ kind: "symlink", target: FIXTURE_REF, mode: null }),
			before_blob_digest: FIXTURE_DIGEST,
			desired_blob_digest: FIXTURE_DIGEST,
			observed_after_blob_digest: nullable ? null : FIXTURE_DIGEST,
			compensation_after_blob_digest: nullable ? null : FIXTURE_DIGEST,
			apply_mutation_id: `apply-${id}`,
			apply_request_digest: "f".repeat(64),
			status: "prepared",
			receipt_json: '{"version":1,"apply":null,"compensate":null}',
			updated_at: FIXTURE_NOW,
		});
	}
	insertFixtureRow(db, "snapshot_captures", {
		id: "capture",
		scope_id: "scope",
		operation_id: "operation",
		tree_hash: "tree-hash",
		snapshot_commit_sha: "git-commit",
		coverage: "complete",
		temporal_consistency: "platform_quiescent",
		policy_version: 1,
		manifest_blob_digest: FIXTURE_DIGEST,
		omitted_count: 0,
		started_at: FIXTURE_NOW,
		finished_at: FIXTURE_NOW,
	});
	insertFixtureRow(db, "file_attributions", {
		id: "attribution",
		effect_id: "effect",
		operation_id: "operation",
		payload: "unchanged ownership",
	});
	insertFixtureRow(db, "file_change_rollups", {
		id: "rollup",
		scope_id: "scope",
		file_key: "effect",
		actor_subject_key: "human:user",
		projection_kind: "history",
		last_effect_id: "effect",
		updated_at: FIXTURE_NOW,
	});
}

export function addFixtureEffect(db: Database, id: string): void {
	insertFixtureRow(db, "file_change_effects", {
		id,
		operation_id: "operation",
		journal_seq: 31,
		scope_id: "scope",
		file_key: id,
		identity_json: '{"displayPath":"fixture.txt"}',
		mutation_id: `mutation-${id}`,
		request_digest: "c".repeat(64),
		phase: "apply",
		before_state_json: JSON.stringify(FIXTURE_STATE),
		intended_after_state_json: JSON.stringify({ kind: "symlink", target: FIXTURE_REF, mode: null }),
		observed_after_state_json: JSON.stringify(FIXTURE_STATE),
		before_blob_digest: FIXTURE_DIGEST,
		intended_after_blob_digest: FIXTURE_DIGEST,
		observed_after_blob_digest: FIXTURE_DIGEST,
		disk_outcome: "applied",
		outcome: "changed",
		settlement: "settled",
		attribution_grade: "measured",
		execution_confirmed: 1,
		execution_receipt_json: JSON.stringify({ observedAfter: FIXTURE_STATE, immutableAudit: true }),
		created_at: FIXTURE_NOW,
		updated_at: FIXTURE_NOW,
	});
}

export function insertFixtureRow(
	db: Database,
	table: string,
	row: Record<string, SQLQueryBindings>,
): void {
	if (!/^[a-z_]+$/.test(table) || Object.keys(row).some((key) => !/^[a-z_]+$/.test(key)))
		throw new Error("Invalid fixture identifier");
	const columns = Object.keys(row);
	db.query(
		`INSERT INTO "${table}" (${columns.map((key) => `"${key}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
	).run(...Object.values(row));
}

/** Whole-fixture snapshots are intentionally test-only, never a production maintenance step. */
export function fixtureSnapshot(db: Database, tables?: string[]): Record<string, unknown[]> {
	const names =
		tables ??
		db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all()
			.map((row) => row.name);
	return Object.fromEntries(
		names.map((table) => [table, db.query(`SELECT * FROM "${table}" ORDER BY rowid`).all()]),
	);
}
