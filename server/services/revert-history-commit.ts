import type { Database, SQLQueryBindings } from "bun:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { FILE_CHANGE_LIMITS, type FileChangeRevertSelector } from "@shared/file-change-protocol";
import { getTableColumns } from "drizzle-orm";
import { type BunSQLiteDatabase, SQLiteBunTransaction } from "drizzle-orm/bun-sqlite";
import { narratorMessages, narratorToolCalls } from "../db/schema";
import { AppError } from "../lib/errors";
import { generateId } from "../lib/id";
import type { NarratorPrincipal } from "./narrator-acl";
import {
	REVERT_SELECTION_PAGE_ITEMS,
	type RevertSelectionBlock,
	type RevertSelectionMessage,
	type RevertSelectionOptions,
	type RevertSelectionResult,
	RevertSelectionService,
} from "./revert-selection-service";

type RootDatabase = Pick<BunSQLiteDatabase, "run"> & { readonly $client: Database };
export type RevertHistoryTransaction = Pick<BunSQLiteDatabase, "run">;
declare const preparedBrand: unique symbol;
/** Process-local capability. Never serialize, reconstruct from JSON, or expose over HTTP. */
export interface PreparedRevertHistory {
	readonly [preparedBrand]: true;
}
export interface PrepareRevertHistory {
	principal: NarratorPrincipal;
	/** Complete original selection recovered from the trusted, verified plan manifest.
	 * NOT a new selector supplied by the client after files have already been changed. */
	fixedSelection: RevertSelectionResult;
	signal?: AbortSignal;
}
export interface RevertHistoryCommitOptions {
	/** Mandatory real ACL assertion; use the SAME root's authenticated project/narrator ACL.
	 * No default permission, subject-hash authorization, or application DB singleton. */
	authorize: RevertSelectionOptions["authorize"];
	timeoutMs?: number;
	onSlow?: (event: {
		service: "revert-history-commit";
		phase: "prepare" | "apply";
		durationMs: number;
		statements: number;
	}) => void;
}
export interface RevertHistoryApplyResult {
	/** Only emit context invalidations/broadcasts AFTER the caller commits. */
	affectedNarratorIds: string[];
	replacements: { refId: string; previousMessageId: string; messageId: string }[];
}

type Value = string | number | null;
type Row = Record<string, Value>;
type Statement = { text: string; values: SQLQueryBindings[] };
type Snapshot = {
	stamp: string;
	signal: AbortSignal;
	expiresAt: number;
	statements: Statement[];
	result: RevertHistoryApplyResult;
};
type Ref = {
	id: string;
	narrator_id: string;
	message_id: string;
	seq: number;
	segment_compact_id: string | null;
};
type Narrator = {
	id: string;
	message_version: number;
	fork_message_id: string | null;
	prune_boundary_message_id: string | null;
};
type Tool = {
	id: string;
	message_id: string;
	narrator_id: string;
	tool_use_id: string;
	is_file_history_checkpoint: number;
};
type Association = RevertSelectionResult["history"]["associations"][number];
type AssociationRule = {
	table: string;
	column: string;
	index: string;
	target: "narrator_messages" | "narrator_tool_calls";
	action: "delete" | "null";
	fk: "NO ACTION" | "CASCADE" | "SET NULL" | null;
};
/** Explicit interpretation of the collector's MESSAGE/TOOL_ASSOCIATIONS, not SQL supplied
 * by a manifest. In particular segment_compact_id is a logical edge, NOT a schema FK. */
const ASSOCIATIONS: readonly AssociationRule[] = [
	{
		table: "narrators",
		column: "fork_message_id",
		index: "idx_narrators_fork_message",
		target: "narrator_messages",
		action: "null",
		fk: "NO ACTION",
	},
	{
		table: "narrators",
		column: "prune_boundary_message_id",
		index: "idx_narrators_prune_boundary_message",
		target: "narrator_messages",
		action: "null",
		fk: "NO ACTION",
	},
	{
		table: "chapter_commits",
		column: "narrator_message_id",
		index: "idx_chapter_commits_narrator_message",
		target: "narrator_messages",
		action: "null",
		fk: "SET NULL",
	},
	{
		table: "spec_file_revisions",
		column: "source_message_id",
		index: "idx_spec_file_revisions_source_message",
		target: "narrator_messages",
		action: "null",
		fk: "SET NULL",
	},
	{
		table: "narrator_patches",
		column: "message_id",
		index: "idx_patches_message",
		target: "narrator_messages",
		action: "delete",
		fk: "CASCADE",
	},
	{
		table: "api_requests",
		column: "message_id",
		index: "idx_api_requests_message",
		target: "narrator_messages",
		action: "null",
		fk: "SET NULL",
	},
	{
		table: "knowledge_injection_events",
		column: "trigger_message_id",
		index: "idx_kie_trigger_message",
		target: "narrator_messages",
		action: "null",
		fk: "SET NULL",
	},
	{
		table: "narrator_message_refs",
		column: "segment_compact_id",
		index: "idx_narrator_refs_segment_compact",
		target: "narrator_messages",
		action: "null",
		fk: null,
	},
	{
		table: "narrator_questions",
		column: "tool_call_id",
		index: "idx_narrator_questions_tool_call",
		target: "narrator_tool_calls",
		action: "delete",
		fk: "CASCADE",
	},
	{
		table: "narrator_tool_continuations",
		column: "tool_call_id",
		index: "idx_tool_continuations_tool_call",
		target: "narrator_tool_calls",
		action: "delete",
		fk: "CASCADE",
	},
	{
		table: "knowledge_injection_events",
		column: "trigger_tool_call_id",
		index: "idx_kie_trigger_tool_call",
		target: "narrator_tool_calls",
		action: "null",
		fk: "SET NULL",
	},
];
const MESSAGE_COLUMNS = Object.values(getTableColumns(narratorMessages))
	.filter((column) => !column.generated)
	.map((column) => column.name);
const TOOL_COLUMNS = Object.values(getTableColumns(narratorToolCalls))
	.filter((column) => !column.generated)
	.map((column) => column.name);
const PAGE = REVERT_SELECTION_PAGE_ITEMS;
const MAX_SCHEMA_TABLES = 512;
const MAX_SCHEMA_FKS = 4096;
// Reviewed index-maintenance triggers from db/fts.ts. Custom mutation triggers cannot
// smuggle unmanifested cascades/writes into an otherwise bounded SQL program.
const INDEX_TRIGGERS = new Set(
	[
		`CREATE TRIGGER narrator_messages_fts_insert AFTER INSERT ON narrator_messages BEGIN
	 INSERT INTO narrator_messages_fts(rowid, content_text) VALUES (NEW.rowid, NEW.content_text); END`,
		`CREATE TRIGGER narrator_messages_fts_update AFTER UPDATE ON narrator_messages BEGIN
	 INSERT INTO narrator_messages_fts(narrator_messages_fts, rowid, content_text) VALUES ('delete', OLD.rowid, OLD.content_text);
	 INSERT INTO narrator_messages_fts(rowid, content_text) VALUES (NEW.rowid, NEW.content_text); END`,
		`CREATE TRIGGER narrator_messages_fts_delete AFTER DELETE ON narrator_messages BEGIN
	 INSERT INTO narrator_messages_fts(narrator_messages_fts, rowid, content_text) VALUES ('delete', OLD.rowid, OLD.content_text); END`,
		`CREATE TRIGGER narrators_fts_insert AFTER INSERT ON narrators WHEN NEW.title IS NOT NULL BEGIN
	 INSERT INTO narrators_fts(rowid, title) VALUES (NEW.rowid, NEW.title); END`,
		`CREATE TRIGGER narrators_fts_update AFTER UPDATE OF title ON narrators WHEN OLD.title IS NOT NULL OR NEW.title IS NOT NULL BEGIN
	 INSERT INTO narrators_fts(narrators_fts, rowid, title) SELECT 'delete', OLD.rowid, OLD.title WHERE OLD.title IS NOT NULL;
	 INSERT OR IGNORE INTO narrators_fts(rowid, title) SELECT NEW.rowid, NEW.title WHERE NEW.title IS NOT NULL; END`,
		`CREATE TRIGGER narrators_fts_delete AFTER DELETE ON narrators WHEN OLD.title IS NOT NULL BEGIN
	 INSERT INTO narrators_fts(narrators_fts, rowid, title) VALUES ('delete', OLD.rowid, OLD.title); END`,
	].map(normalizeTrigger),
);
function normalizeTrigger(text: string) {
	return text
		.replace(/\bIF NOT EXISTS\s+/gi, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Dormant M3 history component. It does NOT apply/replay files, claim files_verified,
 * commit a revert journal, invoke old async deletion adapters, or start a transaction.
 *
 * Caller contract: verify ALL files under coordination, THEN await prepare(); immediately
 * enter a same-root synchronous transaction, call applyToTransaction FIRST, and mark the
 * revert journal committed in that SAME callback. No await inside the callback. Propagate
 * any error out of the transaction, then let the caller's compensation protocol run.
 * No broadcast/context reset/generation is safe until that transaction actually commits.
 *
 * total_changes/data_version/schema_version conservatively reject EVERY intervening write
 * (including unrelated sessions, ACL changes and rolled-back root writes). A WAL snapshot
 * that loses a writer race cannot upgrade to a write transaction; SQLite must fail it.
 * The capability is one-shot even if the caller later rolls back: prepare again, don't
 * replay a partially used program. No mutation material or original body escapes WeakMap.
 *
 * Collector policy still applies: running tools/compacts, ambiguous legacy subagents,
 * unmaterialized inherited refs and incomplete evidence are refused. Extra FK edges and
 * compact rewrites requiring refs outside the fixed collector manifest are refused too.
 * File effects/operations/attributions are retained, never duplicated or re-attributed.
 */
export class RevertHistoryCommitService {
	private readonly root: Database;
	private readonly session: object;
	private readonly selection: RevertSelectionService;
	private readonly timeoutMs: number;
	readonly #prepared = new WeakMap<PreparedRevertHistory, Snapshot>();
	private active = 0;
	constructor(
		database: RootDatabase,
		private readonly options: RevertHistoryCommitOptions,
	) {
		if (!database?.$client || typeof options?.authorize !== "function")
			throw fail("AUTHORIZATION_REQUIRED", "A root database and real ACL adapter are mandatory");
		this.root = database.$client;
		this.session = sessionOf(database);
		if (database instanceof SQLiteBunTransaction || clientOf(this.session) !== this.root)
			throw fail("ROOT_REQUIRED", "Inject the real root Bun SQLite database");
		this.assertRoot();
		this.timeoutMs = options.timeoutMs ?? 30_000;
		bound(this.timeoutMs, FILE_CHANGE_LIMITS.planLifetimeMs, "timeout", 1);
		this.selection = new RevertSelectionService(
			{ $client: this.root },
			{
				authorize: options.authorize,
				timeoutMs: this.timeoutMs,
			},
		);
	}

	async prepare(request: PrepareRevertHistory): Promise<PreparedRevertHistory> {
		const started = performance.now();
		this.assertRoot();
		if (this.active >= 2) throw fail("BUSY", "Too many history preparations");
		// Capture only bounded scalar commitments before the first await. Subsequent caller
		// mutations of its manifest/principal cannot alter our selector or comparisons.
		const fixed = fixSelection(request.fixedSelection);
		const principal = { ...request.principal };
		if (fixed.userId !== principal.userId)
			throw fail("STALE", "The fixed plan belongs to a different principal");
		const signal = AbortSignal.any([
			...(request.signal ? [request.signal] : []),
			AbortSignal.timeout(this.timeoutMs),
		]);
		const snapshot: Snapshot = {
			stamp: this.stamp(),
			signal,
			expiresAt: Date.now() + this.timeoutMs,
			statements: [],
			result: { affectedNarratorIds: [], replacements: [] },
		};
		const worker = new RewriteWorker(signal);
		this.active++;
		try {
			const current = await this.selection.collect({
				principal,
				narratorId: fixed.narratorId,
				expectedMessageVersion: fixed.rootVersion,
				selector: fixed.selector,
				signal,
			});
			this.check(snapshot);
			if (!current.evidenceComplete || current.issues.length)
				throw fail("EVIDENCE_INCOMPLETE", "The complete fixed selection is not settled");
			await compareSelection(fixed, current, () => this.pause(snapshot));
			await this.verifyForeignKeys(snapshot);
			await this.build(snapshot, current, worker);
		} finally {
			await worker.close();
			this.active--;
			this.report("prepare", started, snapshot.statements.length);
		}
		// Check after the final worker shutdown await and observer callback too.
		this.check(snapshot);
		const token = Object.freeze(Object.create(null)) as PreparedRevertHistory;
		this.#prepared.set(token, snapshot);
		return token;
	}

	applyToTransaction(
		tx: RevertHistoryTransaction,
		prepared: PreparedRevertHistory,
	): RevertHistoryApplyResult {
		const started = performance.now();
		const snapshot = this.#prepared.get(prepared);
		if (!snapshot)
			throw fail("INVALID_PREPARED", "Unknown, foreign or consumed history capability");
		if (
			!(tx instanceof SQLiteBunTransaction) ||
			sessionOf(tx) !== this.session ||
			clientOf(sessionOf(tx)) !== this.root ||
			!this.root.inTransaction
		)
			throw fail(
				"TRANSACTION_REQUIRED",
				"Use the caller's active transaction on the injected root",
			);
		snapshot.signal.throwIfAborted();
		if (Date.now() >= snapshot.expiresAt || this.stamp() !== snapshot.stamp)
			throw fail("STALE", "Database changed after preparation; rebuild the fixed selection");
		this.#prepared.delete(prepared);
		try {
			// No select of history, JSON mapping, async ACL, root transaction, file IO or
			// implicit toolUseId expansion is permitted in this synchronous program.
			let applied = 0;
			for (const statement of snapshot.statements) {
				if (applied++ % PAGE === 0) {
					snapshot.signal.throwIfAborted();
					if (Date.now() >= snapshot.expiresAt)
						throw fail("TIMEOUT", "History apply exceeded its deadline");
				}
				this.root.query(statement.text).run(...statement.values);
				// Bun's run().changes includes trigger/FTS maintenance writes. SQLite's
				// changes() is the direct matched-row count; do not mistake index work
				// for an expanded history mutation (or reject every live FTS rewrite).
				const changed = this.root.query<{ n: number }, []>("SELECT changes() AS n").get()?.n;
				if (changed !== 1)
					throw fail("STALE", "A fixed mutation no longer matches exactly one row");
			}
			return {
				affectedNarratorIds: [...snapshot.result.affectedNarratorIds],
				replacements: snapshot.result.replacements.map((row) => ({ ...row })),
			};
		} finally {
			this.report("apply", started, snapshot.statements.length);
		}
	}

	private assertRoot() {
		if (this.root.inTransaction)
			throw fail("AMBIENT_TRANSACTION", "Prepare cannot span an ambient transaction");
		const timeout = this.root.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout;
		if (timeout === undefined || timeout < 0 || timeout > 250)
			throw fail(
				"UNSAFE_CONNECTION",
				"History preparation requires SQLite busy_timeout between 0 and 250ms",
			);
		if (
			this.root.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys !== 1
		)
			throw fail("FOREIGN_KEYS_REQUIRED", "Foreign key enforcement is mandatory");
	}
	private stamp() {
		const changes = this.root.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n;
		const data = this.root
			.query<{ data_version: number }, []>("PRAGMA data_version")
			.get()?.data_version;
		const schema = this.root
			.query<{ schema_version: number }, []>("PRAGMA schema_version")
			.get()?.schema_version;
		const fk = this.root
			.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
			.get()?.foreign_keys;
		const timeout = this.root.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout;
		return `${changes}:${data}:${schema}:${fk}:${timeout}`;
	}
	private check(work: Snapshot) {
		work.signal.throwIfAborted();
		this.assertRoot();
		if (this.stamp() !== work.stamp) throw fail("STALE", "Database changed during preparation");
	}
	private async pause(work: Snapshot) {
		await yieldToEventLoop();
		this.check(work);
	}
	private one<T>(work: Snapshot, text: string, values: SQLQueryBindings[]): T {
		this.check(work);
		const row = this.root.query<T, SQLQueryBindings[]>(text).get(...values);
		if (!row) throw fail("STALE", "A fixed row disappeared");
		return row;
	}
	private async page<T>(
		work: Snapshot,
		select: string,
		index: string,
		column: string,
		target: string,
	): Promise<T[]> {
		const result: T[] = [];
		let cursor = 0;
		for (;;) {
			this.check(work);
			const rows = this.root
				.query<T & { cursor: number }, SQLQueryBindings[]>(
					`${select} INDEXED BY ${index} WHERE ${column} = ? AND rowid > ? ORDER BY rowid LIMIT ?`,
				)
				.all(target, cursor, PAGE + 1);
			for (const row of rows.slice(0, PAGE)) result.push(row);
			bound(result.length, FILE_CHANGE_LIMITS.historyToolRelatedChanges, "association rows");
			if (rows.length <= PAGE) return result;
			cursor = rows[PAGE - 1].cursor;
			await this.pause(work);
		}
	}

	private async verifyForeignKeys(work: Snapshot) {
		const mutatedTables = new Set([
			"narrator_messages",
			"narrator_tool_calls",
			"narrator_message_refs",
			"narrators",
			...ASSOCIATIONS.map((rule) => rule.table),
		]);
		const triggers = this.root
			.query<{ name: string; tbl_name: string; bytes: number }, []>(
				"SELECT name,tbl_name,octet_length(sql) AS bytes FROM sqlite_schema WHERE type='trigger' ORDER BY name LIMIT 129",
			)
			.all();
		bound(triggers.length, 128, "schema triggers");
		for (const trigger of triggers) {
			if (!mutatedTables.has(trigger.tbl_name)) continue;
			bound(trigger.bytes, 4096, "trigger metadata bytes");
			const row = this.one<{ sql: string }>(
				work,
				"SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=? AND octet_length(sql)<=4096 LIMIT 1",
				[trigger.name],
			);
			if (!INDEX_TRIGGERS.has(normalizeTrigger(row.sql)))
				throw fail(
					"UNSUPPORTED_ASSOCIATION",
					"An unreviewed trigger can mutate rows outside the fixed history manifest",
				);
			await this.pause(work);
		}
		for (const [table, expected] of [
			["narrator_messages", MESSAGE_COLUMNS],
			["narrator_tool_calls", TOOL_COLUMNS],
		] as const) {
			const columns = this.root
				.query<{ name: string; hidden: number }, [string]>(
					"SELECT name,hidden FROM pragma_table_xinfo(?) LIMIT 257",
				)
				.all(table);
			bound(columns.length, 256, "stored/generated columns");
			const stored = columns.filter((column) => column.hidden === 0).map((column) => column.name);
			if (stored.length !== expected.length || stored.some((column) => !expected.includes(column)))
				throw fail(
					"UNSUPPORTED_SCHEMA",
					"Stored columns differ from the explicit non-generated copy projection",
				);
			await this.pause(work);
		}
		// Schema metadata only, never global application IDs/large columns. Unknown inbound
		// edges (including a cascade from one of our cascade leaves) fail closed, even empty.
		const deletedTables = new Set([
			"narrator_messages",
			"narrator_message_refs",
			"narrator_tool_calls",
			"narrator_patches",
			"narrator_questions",
			"narrator_tool_continuations",
		]);
		const allowed = new Map<string, string>();
		for (const rule of ASSOCIATIONS)
			if (rule.fk) allowed.set(`${rule.table}:${rule.column}:${rule.target}:id`, rule.fk);
		allowed.set("narrator_message_refs:message_id:narrator_messages:id", "NO ACTION");
		allowed.set("narrator_tool_calls:message_id:narrator_messages:id", "NO ACTION");
		const found = new Set<string>();
		let cursor = "";
		let tableCount = 0;
		let fkCount = 0;
		for (;;) {
			this.check(work);
			const tables = this.root
				.query<{ name: string }, SQLQueryBindings[]>(
					"SELECT name FROM sqlite_schema WHERE type='table' AND name > ? ORDER BY name LIMIT ?",
				)
				.all(cursor, PAGE + 1);
			for (const table of tables.slice(0, PAGE)) {
				bound(++tableCount, MAX_SCHEMA_TABLES, "schema tables");
				const fks = this.root
					.query<{ table: string; from: string; to: string; on_delete: string }, [string]>(
						'SELECT "table", "from", "to", on_delete FROM pragma_foreign_key_list(?) LIMIT 4097',
					)
					.all(table.name);
				fkCount += fks.length;
				bound(fkCount, MAX_SCHEMA_FKS, "schema foreign keys");
				for (const fk of fks) {
					if (!deletedTables.has(fk.table)) continue;
					const key = `${table.name}:${fk.from}:${fk.table}:${fk.to}`;
					if (allowed.get(key) !== fk.on_delete)
						throw fail(
							"UNSUPPORTED_ASSOCIATION",
							"A database FK is not covered by the collector action whitelist",
						);
					found.add(key);
				}
			}
			if (tables.length <= PAGE) break;
			cursor = tables[PAGE - 1].name;
			await this.pause(work);
		}
		for (const key of allowed.keys())
			if (!found.has(key))
				throw fail(
					"UNSUPPORTED_SCHEMA",
					"A required history FK is missing from the injected database",
				);
	}

	private async build(work: Snapshot, selection: RevertSelectionResult, worker: RewriteWorker) {
		const messages = selection.history.messages;
		const messageById = new Map<string, RevertSelectionMessage>();
		const blocks = new Map<string, RevertSelectionBlock[]>();
		for (const block of selection.history.blocks) {
			const list = blocks.get(block.messageId) ?? [];
			list.push(block);
			blocks.set(block.messageId, list);
		}
		for (const message of messages) {
			if (messageById.has(message.id))
				throw fail(
					"UNSUPPORTED_SHARED_SELECTION",
					"A message selected through multiple owners needs an explicit combined manifest",
				);
			messageById.set(message.id, message);
		}
		const versions = new Map(
			selection.messageVersions.map((row) => [row.narratorId, row.messageVersion]),
		);
		const narrators = new Map<string, Narrator>();
		const affected = new Set<string>();
		const narratorPatches = new Map<string, Row>();
		const refPatches = new Map<string, { ref: Ref; patch: Row; remove: boolean }>();
		const changes = new Map(selection.history.toolChanges.map((row) => [row.id, row.action]));
		if (changes.size !== selection.history.toolChanges.length)
			throw fail("MANIFEST_INVALID", "Repeated tool mutation");
		const allTools = new Map<string, Tool>();
		const copies = new Map<string, Row>();
		const bodies = new Map<string, Row>();
		let rowBytes = 0;
		let indexBytes = 0;
		const addAffected = (id: string) => {
			if (!versions.has(id))
				throw fail(
					"UNAUTHORIZED_ASSOCIATION",
					"A pointer owner is absent from the authorized collector manifest",
				);
			affected.add(id);
		};
		const refFor = (id: string) =>
			this.one<Ref>(
				work,
				"SELECT id,narrator_id,message_id,seq,segment_compact_id FROM narrator_message_refs WHERE id=? LIMIT 1",
				[id],
			);
		const patchRef = (ref: Ref) => {
			let entry = refPatches.get(ref.id);
			if (!entry) {
				entry = { ref, patch: {}, remove: false };
				refPatches.set(ref.id, entry);
			}
			return entry;
		};
		// Full row lengths are checked before fetching ANY copy body. Include every stored
		// field (error text, owned paths, permission suggestions, usage JSON, etc.), not just
		// the collector's content/input/output estimates. Generated columns are never read.
		const reserveRow = (table: string, columns: string[], id: string) => {
			const { bytes } = this.one<{ bytes: number }>(
				work,
				`SELECT ${rowLength(columns)} AS bytes FROM ${table} WHERE id=? LIMIT 1`,
				[id],
			);
			rowBytes += bytes;
			bound(rowBytes, FILE_CHANGE_LIMITS.historyCowBytes, "complete rewrite/COW row bytes");
			return bytes;
		};
		const messageSizes = new Map<string, number>();
		const toolSizes = new Map<string, number>();
		for (const message of messages) {
			// Reviewed FTS triggers also touch OLD.content_text on update/delete. Gate its
			// complete size without selecting the text, including for full deletions.
			const textSize = this.one<{ bytes: number }>(
				work,
				"SELECT coalesce(octet_length(content_text),0) AS bytes FROM narrator_messages WHERE id=? LIMIT 1",
				[message.id],
			);
			indexBytes += textSize.bytes;
			bound(indexBytes, FILE_CHANGE_LIMITS.blobBytes, "search-index source bytes");
			addAffected(message.narratorId);
			const ref = refFor(message.refId);
			if (
				ref.message_id !== message.id ||
				ref.narrator_id !== message.narratorId ||
				ref.seq !== message.seq ||
				ref.segment_compact_id !== message.segmentCompactId
			)
				throw fail("STALE", "The fixed owner ref changed");
			patchRef(ref).remove = message.action === "delete" || message.action === "unlink";
			const other = this.root
				.query<{ id: string }, [string, string]>(
					"SELECT id FROM narrator_message_refs INDEXED BY idx_narrator_refs_message WHERE message_id=? AND narrator_id!=? LIMIT 1",
				)
				.get(message.id, message.narratorId);
			if (!!other !== message.isShared) throw fail("STALE", "Shared ownership changed");
			const toolRows = await this.page<Tool>(
				work,
				"SELECT id,message_id,narrator_id,tool_use_id,is_file_history_checkpoint,rowid AS cursor FROM narrator_tool_calls",
				"idx_toolcalls_message",
				"message_id",
				message.id,
			);
			for (const tool of toolRows) {
				allTools.set(tool.id, tool);
				bound(allTools.size, FILE_CHANGE_LIMITS.historyToolRelatedChanges, "inspected tool rows");
				const action = changes.get(tool.id);
				if (!action)
					throw fail("MANIFEST_INVALID", "A message tool is absent from the fixed manifest");
				if (action === "copy")
					toolSizes.set(tool.id, reserveRow("narrator_tool_calls", TOOL_COLUMNS, tool.id));
			}
			if (message.action === "rewrite" || message.action === "copy_on_write") {
				messageSizes.set(message.id, reserveRow("narrator_messages", MESSAGE_COLUMNS, message.id));
				// Partial compact edits/COW would have to retarget other hidden refs, an action
				// the current collector does not authorize. Do not guess a larger selection.
				const hidden = this.root
					.query<{ id: string }, [string]>(
						"SELECT id FROM narrator_message_refs INDEXED BY idx_narrator_refs_segment_compact WHERE segment_compact_id=? LIMIT 1",
					)
					.get(message.id);
				if (hidden)
					throw fail(
						"UNSUPPORTED_COMPACT",
						"Partial compact boundaries require a richer fixed ref manifest",
					);
			}
			if (message.action === "unlink") {
				const hidden = this.root
					.query<{ id: string }, [string, string]>(
						"SELECT id FROM narrator_message_refs INDEXED BY idx_narrator_refs_segment_compact WHERE segment_compact_id=? AND narrator_id=? LIMIT 1",
					)
					.get(message.id, message.narratorId);
				if (hidden)
					throw fail("UNSUPPORTED_COMPACT", "Unlinking this compact would leave hidden owner refs");
			}
			await this.pause(work);
		}
		if (allTools.size !== changes.size) throw fail("MANIFEST_INVALID", "Unbound tool mutations");

		const associations = new Map<string, Association[]>();
		const manifestEdges = new Set<string>();
		for (const edge of selection.history.associations) {
			const rule = ASSOCIATIONS.find(
				(rule) => rule.table === edge.table && rule.column === edge.column,
			);
			if (
				!rule ||
				!(rule.target === "narrator_messages"
					? messageById.get(edge.targetId)?.action === "delete"
					: changes.get(edge.targetId) === "delete")
			)
				throw fail(
					"UNSUPPORTED_ASSOCIATION",
					"An association action is outside the fixed delete set",
				);
			const key = edgeKey(edge);
			if (manifestEdges.has(key)) throw fail("MANIFEST_INVALID", "Repeated association edge");
			manifestEdges.add(key);
			const rowKey = `${edge.table}:${edge.id}`;
			const list = associations.get(rowKey) ?? [];
			list.push(edge);
			associations.set(rowKey, list);
		}
		// Re-enumerate only the fixed indexed target edges. New cascades cannot slip through
		// by being absent from the collector manifest, and no unrelated ID expansion is used.
		let actualEdges = 0;
		for (const rule of ASSOCIATIONS) {
			const targets =
				rule.target === "narrator_messages"
					? messages.filter((m) => m.action === "delete").map((m) => m.id)
					: [...changes].filter(([, action]) => action === "delete").map(([id]) => id);
			for (const targetId of targets) {
				const rows = await this.page<{ id: string }>(
					work,
					`SELECT id,rowid AS cursor FROM ${rule.table}`,
					rule.index,
					rule.column,
					targetId,
				);
				for (const row of rows) {
					if (!manifestEdges.has(edgeKey({ ...rule, id: row.id, targetId })))
						throw fail("STALE", "An unplanned cascade or pointer appeared");
					actualEdges++;
				}
				await this.pause(work);
			}
		}
		if (actualEdges !== manifestEdges.size) throw fail("STALE", "The fixed associations changed");
		const associationProgram: Statement[] = [];
		for (const edges of associations.values()) {
			const edge = edges[0];
			if (edge.table === "narrators") {
				addAffected(edge.id);
				const patch = narratorPatches.get(edge.id) ?? {};
				for (const e of edges) patch[e.column] = null;
				narratorPatches.set(edge.id, patch);
			} else if (edge.table === "narrator_message_refs") {
				const ref = refFor(edge.id);
				addAffected(ref.narrator_id);
				patchRef(ref).patch.segment_compact_id = null;
			} else {
				const rule = ASSOCIATIONS.find((r) => r.table === edge.table && r.column === edge.column);
				const where = {
					id: edge.id,
					...Object.fromEntries(edges.map((e) => [e.column, e.targetId])),
				};
				associationProgram.push(
					rule?.action === "delete"
						? deletion(edge.table, where)
						: update(edge.table, Object.fromEntries(edges.map((e) => [e.column, null])), where),
				);
			}
		}
		for (const id of affected) {
			const narrator = this.one<Narrator>(
				work,
				"SELECT id,message_version,fork_message_id,prune_boundary_message_id FROM narrators WHERE id=? LIMIT 1",
				[id],
			);
			if (narrator.message_version !== versions.get(id))
				throw fail("STALE", "Authorized narrator version changed");
			bound(narrator.message_version, Number.MAX_SAFE_INTEGER - 1, "narrator mutation version");
			narrators.set(id, narrator);
		}

		// All full-row admission checks have now passed. Only rewrites and retained COW
		// tools get raw strings; deleting a 32MB tool output never fetches or JSON parses it.
		for (const [id, bytes] of messageSizes) {
			const message = messageById.get(id);
			if (!message) throw fail("MANIFEST_INVALID", "Unknown rewrite");
			const columns = message.action === "copy_on_write" ? MESSAGE_COLUMNS : ["content_json"];
			bodies.set(
				id,
				this.one<Row>(
					work,
					`SELECT ${columns.map(quote).join(",")} FROM narrator_messages WHERE id=? AND ${rowLength(MESSAGE_COLUMNS)}=? LIMIT 1`,
					[id, bytes],
				),
			);
			await this.pause(work);
		}
		for (const [id, bytes] of toolSizes) {
			copies.set(
				id,
				this.one<Row>(
					work,
					`SELECT ${TOOL_COLUMNS.map(quote).join(",")} FROM narrator_tool_calls WHERE id=? AND ${rowLength(TOOL_COLUMNS)}=? LIMIT 1`,
					[id, bytes],
				),
			);
			await this.pause(work);
		}
		const messageProgram: Statement[] = [];
		let producedBytes = 0;
		for (const message of messages) {
			if (message.action !== "rewrite" && message.action !== "copy_on_write") continue;
			const original = bodies.get(message.id);
			if (!original || typeof original.content_json !== "string")
				throw fail("BODY_INVALID", "No raw body");
			const selectedBlocks = blocks.get(message.id) ?? [];
			const rewritten = await worker.rewrite(message, selectedBlocks, original.content_json);
			this.check(work);
			producedBytes += rewritten.bytes;
			bound(producedBytes, FILE_CHANGE_LIMITS.historyCowBytes, "rewritten body bytes");
			const invalidBoundary = selectedBlocks.some(
				(b) => b.action === "remove" && b.type === "tool_use",
			);
			const patch: Row = {
				content_json: rewritten.body,
				content_text: rewritten.text,
				...(invalidBoundary ? { tree_hash_after: null, snapshot_commit_sha: null } : {}),
			};
			if (message.action === "rewrite") {
				messageProgram.push(update("narrator_messages", patch, { id: message.id }));
			} else {
				const id = generateId();
				// Keep message role, historical narrator/actor and every other raw field.
				// Ref ownership moves; historical authorship does NOT move to the fork owner.
				messageProgram.push(
					insert("narrator_messages", { ...original, ...patch, id }, MESSAGE_COLUMNS),
				);
				const ref = refPatches.get(message.refId);
				if (!ref) throw fail("MANIFEST_INVALID", "COW has no owner ref");
				ref.patch.message_id = id;
				const narrator = narrators.get(message.narratorId);
				if (narrator?.fork_message_id === message.id) {
					const p = narratorPatches.get(message.narratorId) ?? {};
					p.fork_message_id = id;
					narratorPatches.set(message.narratorId, p);
				}
				for (const [toolId, copy] of copies)
					if (copy.message_id === message.id) {
						messageProgram.push(
							insert(
								"narrator_tool_calls",
								{
									...copy,
									id: generateId(),
									message_id: id,
									execution_origin_tool_call_id: copy.execution_origin_tool_call_id ?? toolId,
								},
								TOOL_COLUMNS,
							),
						);
					}
				work.result.replacements.push({
					refId: message.refId,
					previousMessageId: message.id,
					messageId: id,
				});
			}
			await this.pause(work);
		}
		// The rewritten contentText can grow relative to the source row; cap the complete
		// prepared copy/rewrite payload as well as the original rows, before any apply.
		let materialBytes = 0;
		for (let i = 0; i < messageProgram.length; i++) {
			for (const value of messageProgram[i].values)
				materialBytes += value == null ? 0 : Buffer.byteLength(String(value));
			bound(materialBytes, FILE_CHANGE_LIMITS.historyCowBytes, "prepared rewrite/COW row bytes");
			if ((i + 1) % PAGE === 0) await this.pause(work);
		}
		const refProgram: Statement[] = [];
		for (const { ref, patch, remove } of refPatches.values()) {
			const where = { id: ref.id, narrator_id: ref.narrator_id, message_id: ref.message_id };
			if (remove) refProgram.push(deletion("narrator_message_refs", where));
			else if (Object.keys(patch).length)
				refProgram.push(update("narrator_message_refs", patch, where));
		}
		const narratorProgram: Statement[] = [];
		const now = new Date().toISOString();
		for (const [id, narrator] of narrators)
			narratorProgram.push(
				update(
					"narrators",
					{
						...narratorPatches.get(id),
						api_conversation_id: null,
						prune_boundary_message_id: null,
						pruned_percent: null,
						message_version: narrator.message_version + 1,
						updated_at: now,
					},
					{ id, message_version: narrator.message_version },
				),
			);
		// Count actual unique row mutations too: the collector's conservative budget is a
		// lower admission gate, never permission to omit narrator/ref/clone side effects.
		const messageChanges = refProgram.length + messages.filter((m) => m.action !== "unlink").length;
		const relatedChanges =
			associationProgram.length +
			narratorProgram.length +
			[...changes.values()].filter((action) => action !== "retain").length;
		bound(
			messageChanges,
			FILE_CHANGE_LIMITS.historyMessageRefChanges,
			"actual message/ref mutations",
		);
		bound(
			relatedChanges,
			FILE_CHANGE_LIMITS.historyToolRelatedChanges,
			"actual tool/related mutations",
		);
		work.statements.push(
			...associationProgram,
			...messageProgram,
			...refProgram,
			...narratorProgram,
		);
		for (const [id, action] of changes)
			if (action === "delete") {
				const tool = allTools.get(id);
				if (!tool) throw fail("MANIFEST_INVALID", "Unbound delete");
				work.statements.push(deletion("narrator_tool_calls", { id, message_id: tool.message_id }));
			}
		for (const message of messages)
			if (message.action === "delete")
				work.statements.push(deletion("narrator_messages", { id: message.id }));
		work.result.affectedNarratorIds = [...affected];
		this.check(work);
	}
	private report(phase: "prepare" | "apply", started: number, statements: number) {
		const durationMs = performance.now() - started;
		if (durationMs < (phase === "apply" ? 100 : 1000)) return;
		const event = { service: "revert-history-commit" as const, phase, durationMs, statements };
		// Observability must never turn a committed history program into a reported failure.
		try {
			if (this.options.onSlow) this.options.onSlow(event);
			else console.warn("[revert-history-commit] slow", event);
		} catch {
			/* observer only */
		}
	}
}

function sessionOf(value: object): object {
	const session = (value as { session?: object }).session;
	if (!session) throw fail("ROOT_REQUIRED", "A real Bun SQLite session is required");
	return session;
}
function clientOf(session: object) {
	return (session as { client?: Database }).client;
}
function quote(name: string) {
	return `"${name.replaceAll('"', '""')}"`;
}
function rowLength(columns: string[]) {
	// octet_length(column) can use SQLite record metadata for TEXT/BLOB without loading
	// the whole value. length(CAST(column AS BLOB)) would unnecessarily materialize it.
	return columns.map((name) => `coalesce(octet_length(${quote(name)}),0)`).join("+");
}
function conditions(where: Row) {
	return Object.keys(where)
		.map((name) => `${quote(name)} IS ?`)
		.join(" AND ");
}
function update(table: string, patch: Row, where: Row): Statement {
	return {
		text: `UPDATE ${quote(table)} SET ${Object.keys(patch)
			.map((name) => `${quote(name)}=?`)
			.join(",")} WHERE ${conditions(where)}`,
		values: [...Object.values(patch), ...Object.values(where)],
	};
}
function deletion(table: string, where: Row): Statement {
	return {
		text: `DELETE FROM ${quote(table)} WHERE ${conditions(where)}`,
		values: Object.values(where),
	};
}
function insert(table: string, row: Row, columns: string[]): Statement {
	return {
		text: `INSERT INTO ${quote(table)} (${columns.map(quote).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
		values: columns.map((name) => row[name] ?? null),
	};
}
function edgeKey(edge: Association) {
	return JSON.stringify([edge.table, edge.id, edge.column, edge.targetId]);
}
function bound(value: number, max: number, name: string, min = 0) {
	if (!Number.isSafeInteger(value) || value < min || value > max)
		throw fail("BUDGET_EXCEEDED", `Invalid or excessive ${name}`);
}
function fixedText(value: string) {
	if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value) > 256)
		throw fail("MANIFEST_INVALID", "Invalid fixed identifier/digest");
	return value;
}
function fixSelector(selector: FileChangeRevertSelector): FileChangeRevertSelector {
	switch (selector.kind) {
		case "all":
			return { kind: "all" };
		case "from_seq":
			bound(selector.minSeq, Number.MAX_SAFE_INTEGER, "sequence");
			return { kind: "from_seq", minSeq: selector.minSeq };
		case "messages":
			bound(
				selector.messageIds.length,
				FILE_CHANGE_LIMITS.historyMessageRefChanges,
				"selector messages",
				1,
			);
			return { kind: "messages", messageIds: selector.messageIds.map(fixedText) };
		case "tool_calls":
			bound(
				selector.toolCallIds.length,
				FILE_CHANGE_LIMITS.historyToolRelatedChanges,
				"selector tools",
				1,
			);
			return { kind: "tool_calls", toolCallIds: selector.toolCallIds.map(fixedText) };
		case "after_block":
			bound(
				selector.keepThroughBlockIndex,
				FILE_CHANGE_LIMITS.historyToolRelatedChanges,
				"block boundary",
				-1,
			);
			return {
				kind: "after_block",
				messageId: fixedText(selector.messageId),
				keepThroughBlockIndex: selector.keepThroughBlockIndex,
			};
		default:
			throw fail("MANIFEST_INVALID", "Unknown fixed selector");
	}
}
function messageKey(message: RevertSelectionMessage) {
	return [
		message.id,
		message.refId,
		message.narratorId,
		message.seq,
		message.contentDigest,
		message.contentBytes,
		message.isShared,
		message.action,
		message.blockCount,
		message.removedBlockCount,
		message.segmentCompactId,
		message.treeHashAfter,
		message.snapshotCommitSha,
	];
}
function blockKey(block: RevertSelectionBlock) {
	return [block.messageId, block.key, block.digest, block.type, block.toolUseId, block.action];
}
function smallCommitment(row: unknown) {
	// Every commitment is a flat bounded metadata row, never a body/object tree.
	const values = row === null ? [] : Array.isArray(row) ? row : Object.values(row as object);
	for (const value of values) {
		if (typeof value === "string") fixedText(value);
		else if (value !== null && typeof value !== "number" && typeof value !== "boolean")
			throw fail("MANIFEST_INVALID", "Non-scalar fixed metadata");
	}
	const text = JSON.stringify(row);
	bound(Buffer.byteLength(text), FILE_CHANGE_LIMITS.metadataBytes, "commitment row");
	return text;
}
function fixSelection(selection: RevertSelectionResult) {
	if (
		selection.version !== 1 ||
		!selection.selectionComplete ||
		!selection.evidenceComplete ||
		selection.issues.length
	)
		throw fail("MANIFEST_INVALID", "A complete original plan selection is required");
	bound(
		selection.messageVersions.length,
		FILE_CHANGE_LIMITS.historyToolRelatedChanges,
		"narrator versions",
	);
	bound(
		selection.history.messages.length,
		FILE_CHANGE_LIMITS.historyMessageRefChanges,
		"fixed messages",
	);
	bound(
		selection.history.blocks.length,
		FILE_CHANGE_LIMITS.historyToolRelatedChanges,
		"fixed blocks",
	);
	bound(
		selection.history.toolChanges.length,
		FILE_CHANGE_LIMITS.historyToolRelatedChanges,
		"fixed tool mutations",
	);
	// A row may have two inventoried pointers (e.g. knowledge event message + tool).
	bound(
		selection.history.associations.length,
		2 *
			(FILE_CHANGE_LIMITS.historyMessageRefChanges + FILE_CHANGE_LIMITS.historyToolRelatedChanges),
		"fixed association edges",
	);
	bound(
		selection.history.budget.messageRefChanges,
		FILE_CHANGE_LIMITS.historyMessageRefChanges,
		"manifest message/ref budget",
	);
	bound(
		selection.history.budget.relatedRows,
		FILE_CHANGE_LIMITS.historyToolRelatedChanges,
		"manifest related budget",
	);
	bound(
		selection.history.budget.cowBytes,
		FILE_CHANGE_LIMITS.historyCowBytes,
		"manifest COW budget",
	);
	const versions = selection.messageVersions.map((row) =>
		smallCommitment([fixedText(row.narratorId), row.messageVersion]),
	);
	const rootVersion = selection.messageVersions.find(
		(row) => row.narratorId === selection.narratorId,
	)?.messageVersion;
	if (rootVersion === undefined) throw fail("MANIFEST_INVALID", "Missing root version");
	bound(rootVersion, Number.MAX_SAFE_INTEGER, "message version");
	return {
		narratorId: fixedText(selection.narratorId),
		userId: fixedText(selection.requestedByUserId),
		digest: fixedText(selection.metadataDigest),
		rootVersion,
		selector: fixSelector(selection.selector),
		versions,
		messages: selection.history.messages.map((row) => smallCommitment(messageKey(row))),
		blocks: selection.history.blocks.map((row) => smallCommitment(blockKey(row))),
		toolChanges: selection.history.toolChanges.map((row) => smallCommitment(row)),
		associations: selection.history.associations.map((row) => smallCommitment(row)),
		budget: smallCommitment(selection.history.budget),
		boundary: smallCommitment(selection.boundary),
	};
}
async function compareSelection(
	fixed: ReturnType<typeof fixSelection>,
	current: RevertSelectionResult,
	pause: () => Promise<void>,
) {
	if (
		fixed.digest !== current.metadataDigest ||
		fixed.budget !== smallCommitment(current.history.budget) ||
		fixed.boundary !== smallCommitment(current.boundary)
	)
		throw fail("STALE", "The original plan metadata or boundary changed");
	for (const [left, right] of [
		[fixed.versions, current.messageVersions.map((row) => [row.narratorId, row.messageVersion])],
		[fixed.messages, current.history.messages.map(messageKey)],
		[fixed.blocks, current.history.blocks.map(blockKey)],
		[fixed.toolChanges, current.history.toolChanges],
		[fixed.associations, current.history.associations],
	] as const) {
		if (left.length !== right.length) throw fail("STALE", "The fixed history coverage changed");
		for (let i = 0; i < left.length; i++) {
			if (left[i] !== smallCommitment(right[i]))
				throw fail("STALE", "A fixed version/ref/block key changed");
			if ((i + 1) % PAGE === 0) await pause();
		}
	}
}
export class RevertHistoryCommitError extends AppError {
	constructor(code: string, message: string) {
		super(message, 409, `REVERT_HISTORY_${code}`);
		this.name = "RevertHistoryCommitError";
	}
}
function fail(code: string, message: string) {
	return new RevertHistoryCommitError(code, message);
}

type Rewritten = { body: string; text: string | null; bytes: number };
class RewriteWorker {
	private worker: Worker | undefined;
	private termination: Promise<number> | undefined;
	private pending:
		| { resolve: (result: Rewritten) => void; reject: (error: unknown) => void }
		| undefined;
	constructor(private readonly signal: AbortSignal) {}
	rewrite(
		message: RevertSelectionMessage,
		blocks: RevertSelectionBlock[],
		body: string,
	): Promise<Rewritten> {
		this.signal.throwIfAborted();
		if (!this.worker) {
			this.worker = new Worker(REWRITE_WORKER, { eval: true });
			this.worker.on("message", (result: Rewritten & { error?: string }) => {
				const pending = this.pending;
				this.pending = undefined;
				if (result.error) pending?.reject(fail("BODY_INVALID", result.error));
				else pending?.resolve(result);
			});
			this.worker.on("error", (error) => {
				this.pending?.reject(error);
				this.pending = undefined;
			});
			this.worker.on("exit", () => {
				this.pending?.reject(fail("BODY_INVALID", "Rewrite worker exited"));
				this.pending = undefined;
			});
			this.signal.addEventListener("abort", this.abort, { once: true });
		}
		return new Promise((resolve, reject) => {
			this.pending = { resolve, reject };
			this.worker?.postMessage({
				message,
				blocks,
				body,
				limit: FILE_CHANGE_LIMITS.historyCowBytes,
			});
		});
	}
	private abort = () => {
		this.pending?.reject(this.signal.reason);
		this.pending = undefined;
		this.termination ??= this.worker?.terminate();
	};
	async close() {
		this.signal.removeEventListener("abort", this.abort);
		this.termination ??= this.worker?.terminate();
		await this.termination;
	}
}
/** Parsing and hashing even a single 4MiB message runs off the main thread. Retained JSON
 * element substrings are copied verbatim (large numbers, escapes, whitespace and key order
 * survive); all other SQL JSON strings are copied without decoding/re-encoding at all. */
const REWRITE_WORKER = `
const { parentPort } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
parentPort.on('message', ({message, blocks, body, limit}) => {
 try {
  if (Buffer.byteLength(body) > limit || hash(body) !== message.contentDigest) throw Error('Raw body commitment changed');
  const parsed = JSON.parse(body);
  if (!Array.isArray(parsed) || parsed.length !== blocks.length || parsed.length !== message.blockCount) throw Error('Block coverage changed');
  const kept = []; const texts = []; let removed = 0;
  // JSON.parse already validated syntax. Scan just the top-level array separators,
  // accounting for nested containers and string escapes; never stringify kept blocks.
  const slices = []; let start = body.indexOf('[') + 1, depth = 0, quoted = false, escaped = false;
  for (let i = start; i < body.length; i++) {
   const c = body[i];
   if (quoted) { if (escaped) escaped = false; else if (c === String.fromCharCode(92)) escaped = true; else if (c === '"') quoted = false; continue; }
   if (c === '"') { quoted = true; continue; }
   if (c === '[' || c === '{') depth++;
   else if (c === ']' && depth === 0) { if (i > start) slices.push(body.slice(start, i)); break; }
   else if (c === ']' || c === '}') depth--;
   else if (c === ',' && depth === 0) { slices.push(body.slice(start, i)); start = i + 1; }
  }
  if (slices.length !== parsed.length) throw Error('Raw block boundaries unavailable');
  for (let i=0; i<parsed.length; i++) {
   const block = parsed[i], fixed = blocks[i];
   const digest = hash(JSON.stringify(block));
   const key = hash(JSON.stringify([message.id, message.contentDigest, i, digest]));
   if (fixed.key !== key || fixed.digest !== digest || fixed.type !== block.type || fixed.toolUseId !== (block.type === 'tool_use' ? block.id : null)) throw Error('Stable block key changed');
   if (fixed.action === 'remove') { if (block.type === 'compact') throw Error('Partial compact marker removal is unsupported'); removed++; }
   else if (fixed.action === 'retain') { kept.push(slices[i]); if (block.type === 'text') { if (block.text != null && typeof block.text !== 'string') throw Error('Invalid text block'); texts.push(block.text ?? ''); } }
   else throw Error('Unknown block action');
  }
  if (!kept.length || removed !== message.removedBlockCount) throw Error('Rewrite coverage changed');
  const rewritten = '[' + kept.join(',') + ']'; const text = texts.join('\\n') || null;
  const bytes = Buffer.byteLength(rewritten) + (text ? Buffer.byteLength(text) : 0);
  if (bytes > limit) throw Error('Rewritten body exceeds byte budget');
  parentPort.postMessage({body: rewritten, text, bytes});
 } catch (error) { parentPort.postMessage({error: error.message}); }
});
`;
