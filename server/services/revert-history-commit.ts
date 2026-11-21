/**
 * CAPABILITY BOUNDARY: SQLite indexed/rowid scans capture bounded, explicit history
 * projections and fixed membership targets. Batched checks reject changes to those
 * consumed values, not unrelated database writes. Foreign keys, short busy waits,
 * selected narrator versions and direct `SELECT changes()` row counts remain required.
 *
 * History uses ordinary row-level DML in the caller's real transaction. Enabled
 * SQLite foreign keys and application-owned triggers execute normally, including
 * FTS maintenance; SQL failures propagate so history and the caller's journal
 * roll back together. This module never rebuilds tables or manages triggers.
 */
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { setTimeout as yieldToEventLoop } from "node:timers/promises";
import { FILE_CHANGE_LIMITS, type FileChangeRevertSelector } from "@shared/file-change-protocol";
import { getTableColumns } from "drizzle-orm";
import { type BunSQLiteDatabase, SQLiteBunTransaction } from "drizzle-orm/bun-sqlite";
import { narratorBufferedMessages, narratorMessages, narratorToolCalls } from "../db/schema";
import { connectCompiledWorker } from "../lib/compiled-worker";
import { AppError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import { generateId } from "../lib/id";
import {
	bodyLengthSql,
	boundedBodyText,
	hasBlockStorage,
	hasRowsOnlyBodies,
} from "../lib/narrator-bodies";
import { settings } from "../lib/settings";
import type { WorkerHandle } from "../lib/worker-runtime/lifecycle";
import { type PoolWorker, WorkerPool, type WorkerTaskContext } from "../lib/worker-runtime/pool";
import {
	nextCurrentRevision,
	recipientDeletedReceiptPatch,
	semanticEditReceiptPatch,
} from "./agent-runtime/mailbox-shared";
import type { NarratorPrincipal } from "./narrator-acl";
import {
	buildQuestionHistoryInboxProgram,
	buildQuestionHistoryProgram,
	QUESTION_HISTORY_BYTES,
	QUESTION_HISTORY_COLUMNS,
	QUESTION_HISTORY_LIMIT,
	type QuestionHistoryEvent,
	type QuestionHistoryInboxRow,
	type QuestionHistoryRow,
} from "./narrator-question-history";
import {
	isSnapshotSelectionComplete,
	REVERT_LAZY_CHILD_DEPENDENCY_QUERY,
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
	/** Trusted executor verified explicit snapshot consent and every enumerated target. */
	snapshotRecovery?: boolean;
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
	/** Send sources whose receipt pages changed; refresh only, never reset upstream sessions. */
	refreshedNarratorIds: string[];
	affectedQuestionIds: string[];
	replacements: { refId: string; previousMessageId: string; messageId: string }[];
}

type Value = string | number | null;
type Row = Record<string, Value>;
type Statement = { text: string; values: SQLQueryBindings[] };
type Check = Statement & { count: number; code?: "HISTORY_LAZY_DEPENDENCY_CHANGED" };
type Target = { row: Row; count: number };
type StoredColumns = { message: string[]; tool: string[] };
type Snapshot = {
	versions: { narratorId: string; messageVersion: number }[];
	signal: AbortSignal;
	expiresAt: number;
	statements: Statement[];
	checks: Check[];
	result: RevertHistoryApplyResult;
};
type Ref = {
	id: string;
	narrator_id: string;
	message_id: string;
	seq: number;
	segment_compact_id: string | null;
	is_compact: number;
};
type Narrator = {
	id: string;
	message_version: number;
	fork_message_id: string | null;
};
type Tool = {
	id: string;
	message_id: string;
	narrator_id: string;
	tool_use_id: string;
	is_file_history_checkpoint: number;
	status: string;
	execution_attempt: number | null;
	file_change_operation_id: string | null;
	tool_name: string;
	inputBytes: number | null;
	outputBytes: number | null;
};
type Association = RevertSelectionResult["history"]["associations"][number];
type RecipientMailbox = {
	id: string;
	narrator_id: string;
	recipient_ref_id: string;
	state: "materialized";
	source_narrator_id: string | null;
	/** Consumed by the semantic-edit max(current, content)+1 rule; A-checked like the rest. */
	current_revision: number;
	content_revision: number;
};
/** A received ref's fixed fate: removed, or edited to the given current message ID. */
type RecipientChange = { ref: Ref } & ({ kind: "deleted" } | { kind: "edited"; messageId: string });
type SourceNarrator = { id: string; type: string; parent_narrator_id: string | null };
type AssociationRule = {
	table: string;
	column: string;
	index: string;
	target: "narrator_messages" | "narrator_tool_calls";
	action: "delete" | "null";
	idColumn?: string;
};
/** Explicit interpretation of the collector's MESSAGE/TOOL_ASSOCIATIONS, not SQL supplied
 * by a manifest. In particular segment_compact_id is a logical edge, NOT a schema FK. */
const ASSOCIATIONS: readonly AssociationRule[] = [
	{
		table: "permission_rule_requests",
		column: "tool_call_id",
		index: "uq_permission_rule_request_attempt",
		target: "narrator_tool_calls",
		action: "delete",
	},
	{
		table: "narrator_question_events",
		column: "message_id",
		index: "sqlite_autoindex_narrator_question_events_1",
		target: "narrator_messages",
		action: "delete",
		idColumn: "message_id",
	},
	{
		table: "narrators",
		column: "fork_message_id",
		index: "idx_narrators_fork_message",
		target: "narrator_messages",
		action: "null",
	},
	{
		table: "spec_file_revisions",
		column: "source_message_id",
		index: "idx_spec_file_revisions_source_message",
		target: "narrator_messages",
		action: "null",
	},
	{
		table: "narrator_patches",
		column: "message_id",
		index: "idx_patches_message",
		target: "narrator_messages",
		action: "delete",
	},
	{
		table: "api_requests",
		column: "message_id",
		index: "idx_api_requests_message",
		target: "narrator_messages",
		action: "null",
	},
	{
		table: "knowledge_injection_events",
		column: "trigger_message_id",
		index: "idx_kie_trigger_message",
		target: "narrator_messages",
		action: "null",
	},
	{
		table: "narrator_message_refs",
		column: "segment_compact_id",
		index: "idx_narrator_refs_segment_compact",
		target: "narrator_messages",
		action: "null",
	},
	{
		table: "narrator_questions",
		column: "tool_call_id",
		index: "idx_narrator_questions_tool_call",
		target: "narrator_tool_calls",
		action: "delete",
	},
	{
		table: "narrator_tool_continuations",
		column: "tool_call_id",
		index: "idx_tool_continuations_tool_call",
		target: "narrator_tool_calls",
		action: "delete",
	},
	{
		table: "knowledge_injection_events",
		column: "trigger_tool_call_id",
		index: "idx_kie_trigger_tool_call",
		target: "narrator_tool_calls",
		action: "null",
	},
];
const MESSAGE_COLUMNS = Object.values(getTableColumns(narratorMessages))
	.filter((column) => !column.generated)
	.map((column) => column.name);
const TOOL_COLUMNS = Object.values(getTableColumns(narratorToolCalls))
	.filter((column) => !column.generated)
	.map((column) => column.name);
const PAGE = REVERT_SELECTION_PAGE_ITEMS;
/** Whether bodies are read from block rows (`narrator-bodies.ts`); the database is SQLite. */
const bodiesFromBlocks = (db: Database) =>
	hasBlockStorage(db) && (settings.narratorBlocks.read || hasRowsOnlyBodies(db));
const MAILBOX_FIELDS: Record<string, { name: string }> = getTableColumns(narratorBufferedMessages);
/** The shared runtime patch uses schema field names; map them to stored SQL columns. */
function mailboxPatch(patch: Record<string, Value>): Row {
	return Object.fromEntries(
		Object.entries(patch).map(([field, value]) => {
			const column = MAILBOX_FIELDS[field];
			if (!column) throw fail("UNSUPPORTED_SCHEMA", "Unknown mailbox receipt field");
			return [column.name, value];
		}),
	);
}

/** Prepare bounded COW/history SQL outside the transaction. The caller applies it only
 * after every required file succeeds. Selected message versions and bounded read predicates
 * protect the program; unrelated database writes remain independent. Applying is synchronous,
 * one-shot and shares the journal commit transaction. File effects stay as original history.
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
		const snapshotRecovery = request.snapshotRecovery === true;
		const fixed = fixSelection(request.fixedSelection, snapshotRecovery);
		const principal = { ...request.principal };
		if (fixed.userId !== principal.userId)
			throw fail("STALE", "The fixed plan belongs to a different principal");
		const signal = AbortSignal.any([
			...(request.signal ? [request.signal] : []),
			AbortSignal.timeout(this.timeoutMs),
		]);
		const snapshot: Snapshot = {
			// Bind only after the final selected-history recheck, not to the old plan version.
			versions: [],
			signal,
			expiresAt: Date.now() + this.timeoutMs,
			statements: [],
			checks: [],
			result: {
				affectedNarratorIds: [],
				refreshedNarratorIds: [],
				affectedQuestionIds: [],
				replacements: [],
			},
		};
		this.active++;
		try {
			const current = await this.selection.collect({
				principal,
				narratorId: fixed.narratorId,
				selector: fixed.selector,
				signal,
			});
			this.check(snapshot);
			if (
				(!current.evidenceComplete || current.issues.length) &&
				!(snapshotRecovery && isSnapshotSelectionComplete(current))
			)
				throw fail("EVIDENCE_INCOMPLETE", "The complete fixed selection is not settled");
			await compareSelection(fixed, current, () => this.pause(snapshot));
			const columns = await this.storedColumns(snapshot);
			await this.build(snapshot, current, columns);
			const latest = await this.selection.collect({
				principal,
				narratorId: fixed.narratorId,
				selector: fixed.selector,
				signal,
			});
			await compareSelection(fixed, latest, () => this.pause(snapshot));
			// Current versions are a short prepare→apply CAS only. The complete selected
			// sources above, not a session-wide old counter, bind the user's consent.
			snapshot.versions = latest.messageVersions.map((row) => {
				bound(row.messageVersion, Number.MAX_SAFE_INTEGER - 1, "narrator mutation version");
				return { ...row };
			});
		} finally {
			this.active--;
			this.report("prepare", started, snapshot.statements.length);
		}
		// Check after the final source verification await and observer callback too.
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
		if (Date.now() >= snapshot.expiresAt) throw fail("STALE", "History preparation expired");
		this.checkVersions(snapshot);
		const timeout = this.root.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout;
		if (timeout === undefined || timeout > 250)
			throw fail("UNSAFE_CONNECTION", "History commit requires short SQLite waits");
		let checked = 0;
		for (const check of snapshot.checks) {
			if (checked++ % PAGE === 0) {
				snapshot.signal.throwIfAborted();
				if (Date.now() >= snapshot.expiresAt)
					throw fail("TIMEOUT", "History checks exceeded their deadline");
			}
			const actual = this.root
				.query<{ n: number }, SQLQueryBindings[]>(check.text)
				.get(...check.values);
			if (actual?.n !== check.count) {
				if (check.code)
					throw new AppError("Inherited child history changed after preview", 409, check.code);
				throw fail("STALE", "Selected history changed after preparation");
			}
		}
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
				refreshedNarratorIds: [...snapshot.result.refreshedNarratorIds],
				affectedQuestionIds: [...snapshot.result.affectedQuestionIds],
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
	private checkVersions(work: Snapshot) {
		for (const expected of work.versions) {
			const current = this.root
				.query<{ version: number }, [string]>(
					"SELECT message_version AS version FROM narrators WHERE id=? LIMIT 1",
				)
				.get(expected.narratorId);
			if (current?.version !== expected.messageVersion)
				throw fail("STALE", "Selected message history changed");
		}
	}
	private check(work: Snapshot) {
		work.signal.throwIfAborted();
		this.assertRoot();
		this.checkVersions(work);
	}
	private async pause(work: Snapshot) {
		await yieldToEventLoop(0);
		this.check(work);
	}
	private one<T>(work: Snapshot, text: string, values: SQLQueryBindings[]): T {
		this.check(work);
		const row = this.root.query<T, SQLQueryBindings[]>(text).get(...values);
		if (!row) throw fail("STALE", "A fixed row disappeared");
		return row;
	}
	private rows<T>(work: Snapshot, text: string, values: SQLQueryBindings[]): T[] {
		this.check(work);
		return this.root.query<T, SQLQueryBindings[]>(text).all(...values);
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
			const rows = this.rows<T & { cursor: number }>(
				work,
				`${select} INDEXED BY ${index} WHERE ${column} = ? AND rowid > ? ORDER BY rowid LIMIT ?`,
				[target, cursor, PAGE + 1],
			);
			for (const row of rows.slice(0, PAGE)) result.push(row);
			bound(result.length, FILE_CHANGE_LIMITS.historyToolRelatedChanges, "association rows");
			if (rows.length <= PAGE) return result;
			cursor = rows[PAGE - 1].cursor;
			await this.pause(work);
		}
	}

	private async storedColumns(work: Snapshot): Promise<StoredColumns> {
		// Row-length commitments and COW copies follow the live stored columns, so fields
		// unknown to this build (e.g. left by a newer version) are fixed and copied verbatim
		// instead of vetoing the revert. A missing known field is still unsupported.
		const result: StoredColumns = { message: [], tool: [] };
		for (const [key, table, expected] of [
			["message", "narrator_messages", MESSAGE_COLUMNS],
			["tool", "narrator_tool_calls", TOOL_COLUMNS],
		] as const) {
			const columns = this.root
				.query<{ name: string; hidden: number }, [string]>(
					"SELECT name,hidden FROM pragma_table_xinfo(?) LIMIT 257",
				)
				.all(table);
			bound(columns.length, 256, "stored/generated columns");
			const stored = columns.filter((column) => column.hidden === 0).map((column) => column.name);
			if (expected.some((column) => !stored.includes(column)))
				throw fail("UNSUPPORTED_SCHEMA", "A known history column is missing from storage");
			result[key] = stored;
			await this.pause(work);
		}
		return result;
	}

	private async build(work: Snapshot, selection: RevertSelectionResult, stored: StoredColumns) {
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
		const authorizationRows = new Map<string, Row>();
		for (const id of versions.keys())
			capture(
				authorizationRows,
				id,
				this.one<Row>(
					work,
					"SELECT id,owner_user_id,visibility,write_audience,type,acl_root_narrator_id,context_project_id,parent_narrator_id,origin_tool_call_id FROM narrators WHERE id=? LIMIT 1",
					[id],
				),
			);
		for (const id of versions.keys())
			work.checks.push({
				text: "SELECT CASE WHEN (refs_inherited_from IS NULL AND refs_backfill_cursor IS NULL) OR (refs_inherited_from IS NOT NULL AND typeof(refs_backfill_cursor)='integer' AND refs_backfill_cursor>=0) THEN 1 ELSE 0 END AS n FROM narrators WHERE id=? LIMIT 1",
				values: [id],
				count: 1,
			});
		const lazyParents = new Map<string, number>();
		for (const message of messages)
			lazyParents.set(
				message.narratorId,
				Math.min(lazyParents.get(message.narratorId) ?? message.seq, message.seq),
			);
		for (const [id, minSeq] of lazyParents)
			work.checks.push({
				text: `SELECT EXISTS(${REVERT_LAZY_CHILD_DEPENDENCY_QUERY}) AS n`,
				values: [id, minSeq, id, minSeq],
				count: 0,
				code: "HISTORY_LAZY_DEPENDENCY_CHANGED",
			});
		const affected = new Set<string>();
		const narratorPatches = new Map<string, Row>();
		const refPatches = new Map<string, { ref: Ref; patch: Row; remove: boolean }>();
		const changes = new Map(selection.history.toolChanges.map((row) => [row.id, row.action]));
		if (changes.size !== selection.history.toolChanges.length)
			throw fail("MANIFEST_INVALID", "Repeated tool mutation");
		const allTools = new Map<string, Tool>();
		// These maps live only for preparation. Checks are compiled from the values at
		// consumption, never from a fresh baseline after an await or the final collector.
		const messageRows = new Map<string, Row>();
		const refRows = new Map<string, Ref>();
		const toolRows = new Map<string, Row>();
		const toolTargets: Target[] = [];
		const sharedTargets: Target[] = [];
		const hiddenGlobal: Target[] = [];
		const hiddenOwner: Target[] = [];
		const copies = new Map<string, Row>();
		const bodies = new Map<string, Row>();
		const bodyTexts = new Map<string, string>();
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
			refRows.get(id) ??
			capture(
				refRows,
				id,
				this.one<Ref>(
					work,
					"SELECT id,narrator_id,message_id,seq,segment_compact_id,is_compact FROM narrator_message_refs WHERE id=? LIMIT 1",
					[id],
				),
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
		const reserveRow = (bytes: number) => {
			rowBytes += bytes;
			bound(rowBytes, FILE_CHANGE_LIMITS.historyCowBytes, "complete rewrite/COW row bytes");
			return bytes;
		};
		const messageSizes = new Map<string, number>();
		const toolSizes = new Map<string, number>();
		// What fixes a message's body for the apply-time checks: its revisions (every body or
		// state write moves one), or the stored column on a schema without them.
		const bodyRevisions = ["body_revision", "state_revision"];
		const fixedBody = bodyRevisions.every((column) => stored.message.includes(column))
			? bodyRevisions
			: ["content_json"];
		for (const message of messages) {
			const whole = message.action === "delete" || message.action === "unlink";
			if (whole) reserveRow(message.contentBytes);
			// Combine the consumed message metadata and FTS size observation. Copy bodies
			// remain deferred until every full-row admission check has passed.
			// A removed message's body is fixed by `fixedBody` and its size as readers
			// measure it.
			const observed = this.one<Row & { ftsBytes: number; rowBytes: number }>(
				work,
				`SELECT id,role,tree_hash_after,snapshot_commit_sha,coalesce(octet_length(content_text),0) AS ftsBytes,${whole ? fixedBody.map(quote).join(",") : `${rowLength(stored.message)} AS rowBytes`} FROM narrator_messages m WHERE id=?${whole ? ` AND ${bodyLengthSql("m", bodiesFromBlocks(this.root))}=?` : ""} LIMIT 1`,
				whole ? [message.id, message.contentBytes] : [message.id],
			);
			capture(messageRows, message.id, observed);
			indexBytes += observed.ftsBytes;
			bound(indexBytes, FILE_CHANGE_LIMITS.blobBytes, "search-index source bytes");
			if (!whole) messageSizes.set(message.id, reserveRow(observed.rowBytes));
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
			const { shared } = this.one<{ shared: number }>(
				work,
				"SELECT EXISTS(SELECT 1 FROM narrator_message_refs INDEXED BY idx_narrator_refs_message WHERE message_id=? AND narrator_id!=?) AS shared",
				[message.id, message.narratorId],
			);
			if (!!shared !== message.isShared) throw fail("STALE", "Shared ownership changed");
			sharedTargets.push({
				row: { message_id: message.id, owner_id: message.narratorId, shared },
				count: 1,
			});
			const inventory = await this.page<Tool & { cursor: number }>(
				work,
				"SELECT id,message_id,narrator_id,tool_use_id,is_file_history_checkpoint,status,execution_attempt,file_change_operation_id,tool_name,octet_length(input_json) AS inputBytes,octet_length(output_json) AS outputBytes,rowid AS cursor FROM narrator_tool_calls",
				"idx_toolcalls_message",
				"message_id",
				message.id,
			);
			toolTargets.push({ row: { message_id: message.id }, count: inventory.length });
			for (const { cursor: _cursor, ...tool } of inventory) {
				capture(allTools, tool.id, tool);
				capture(toolRows, tool.id, tool);
				bound(allTools.size, FILE_CHANGE_LIMITS.historyToolRelatedChanges, "inspected tool rows");
				const action = changes.get(tool.id);
				if (!action)
					throw fail("MANIFEST_INVALID", "A message tool is absent from the fixed manifest");
				if (action === "copy") {
					const size = this.one<{ id: string; rowBytes: number }>(
						work,
						`SELECT id,${rowLength(stored.tool)} AS rowBytes FROM narrator_tool_calls WHERE id=? LIMIT 1`,
						[tool.id],
					);
					capture(toolRows, tool.id, size);
					toolSizes.set(tool.id, reserveRow(size.rowBytes));
				}
			}
			if (message.action === "rewrite" || message.action === "copy_on_write") {
				// Partial compact edits/COW would have to retarget other hidden refs, an action
				// the current collector does not authorize. Do not guess a larger selection.
				const { hidden } = this.one<{ hidden: number }>(
					work,
					"SELECT EXISTS(SELECT 1 FROM narrator_message_refs INDEXED BY idx_narrator_refs_segment_compact WHERE segment_compact_id=?) AS hidden",
					[message.id],
				);
				hiddenGlobal.push({ row: { message_id: message.id }, count: 1 });
				if (hidden)
					throw fail(
						"UNSUPPORTED_COMPACT",
						"Partial compact boundaries require a richer fixed ref manifest",
					);
			}
			if (message.action === "unlink") {
				const { hidden } = this.one<{ hidden: number }>(
					work,
					"SELECT EXISTS(SELECT 1 FROM narrator_message_refs INDEXED BY idx_narrator_refs_segment_compact WHERE segment_compact_id=? AND narrator_id=?) AS hidden",
					[message.id, message.narratorId],
				);
				hiddenOwner.push({
					row: { message_id: message.id, owner_id: message.narratorId },
					count: 1,
				});
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
		// The authorized manifest already contains every member. Compile identity and
		// bounded membership checks directly; do not re-enumerate each target here.
		for (const rule of ASSOCIATIONS) {
			const targets = new Map<string, Target>();
			for (const id of rule.target === "narrator_messages"
				? messages.filter((m) => m.action === "delete").map((m) => m.id)
				: [...changes].filter(([, action]) => action === "delete").map(([id]) => id))
				targets.set(id, { row: { target_id: id }, count: 0 });
			const members: Row[] = [];
			const key = rule.idColumn ?? "id";
			for (const edge of selection.history.associations) {
				if (edge.table !== rule.table || edge.column !== rule.column) continue;
				const target = targets.get(edge.targetId);
				if (!target) throw fail("MANIFEST_INVALID", "Unbound association target");
				target.count++;
				members.push({ [key]: edge.id, [rule.column]: edge.targetId });
			}
			work.checks.push(
				...rowChecks(rule.table, key, members),
				...targetChecks(
					targets.values(),
					`CROSS JOIN ${quote(rule.table)} a INDEXED BY ${quote(rule.index)} ON a.${quote(rule.column)}=t.target_id`,
				),
			);
		}
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
			} else if (edge.table !== "narrator_question_events") {
				const rule = ASSOCIATIONS.find((r) => r.table === edge.table && r.column === edge.column);
				const where = {
					[rule?.idColumn ?? "id"]: edge.id,
					...Object.fromEntries(edges.map((e) => [e.column, e.targetId])),
				};
				associationProgram.push(
					rule?.action === "delete"
						? deletion(edge.table, where)
						: update(edge.table, Object.fromEntries(edges.map((e) => [e.column, null])), where),
				);
			}
		}
		const { program: questionProgram, inboxIds } = await this.prepareQuestions(
			work,
			selection,
			allTools,
		);
		// Every fixed owner ref this program changes is a recipient target: removed refs become
		// deletions; a rewrite keeps its message ID and a COW retargets its same ref to a new
		// one (allocated here so the receipt and the inserted copy share one identity).
		const cowIds = new Map<string, string>();
		const recipientChanges: RecipientChange[] = [];
		for (const message of messages) {
			const entry = refPatches.get(message.refId);
			if (!entry) throw fail("MANIFEST_INVALID", "A fixed message has no owner ref");
			if (entry.remove) recipientChanges.push({ ref: entry.ref, kind: "deleted" });
			else if (message.action === "rewrite")
				recipientChanges.push({ ref: entry.ref, kind: "edited", messageId: message.id });
			else if (message.action === "copy_on_write") {
				const id = generateId();
				cowIds.set(message.id, id);
				recipientChanges.push({ ref: entry.ref, kind: "edited", messageId: id });
			}
		}
		const recipient = await this.prepareRecipientReceipts(
			work,
			recipientChanges,
			affected,
			inboxIds,
		);
		for (const id of affected) {
			const narrator = this.one<Narrator>(
				work,
				"SELECT id,message_version,fork_message_id FROM narrators WHERE id=? LIMIT 1",
				[id],
			);
			bound(narrator.message_version, Number.MAX_SAFE_INTEGER - 1, "narrator mutation version");
			narrators.set(id, narrator);
		}

		// All full-row admission checks have now passed. Only rewrites and retained COW
		// tools get raw strings; deleting a 32MB tool output never fetches or JSON parses it.
		// COW rows read every live stored field, including ones unknown to this build, so
		// the copy keeps them and the consumed-row checks still fix each one.
		for (const [id, bytes] of messageSizes) {
			const message = messageById.get(id);
			if (!message) throw fail("MANIFEST_INVALID", "Unknown rewrite");
			const columns =
				message.action === "copy_on_write"
					? stored.message
					: ["id", "role", "tree_hash_after", "snapshot_commit_sha", ...fixedBody];
			const row = this.one<Row>(
				work,
				`SELECT ${columns.map(quote).join(",")},coalesce(octet_length(content_text),0) AS ftsBytes,${rowLength(stored.message)} AS rowBytes FROM narrator_messages WHERE id=? AND ${rowLength(stored.message)}=? LIMIT 1`,
				[id, bytes],
			);
			capture(messageRows, id, row);
			// The body as readers read it (its rows when they hold it), at the size selected.
			this.check(work);
			const text = boundedBodyText(this.root, id, bodiesFromBlocks(this.root), {
				exactBytes: message.contentBytes,
				maxBytes: FILE_CHANGE_LIMITS.historyCowBytes,
			});
			if (text === undefined) throw fail("STALE", "A selected message body changed");
			bodies.set(id, row);
			bodyTexts.set(id, text);
			await this.pause(work);
		}
		for (const [id, bytes] of toolSizes) {
			const copy = this.one<Row>(
				work,
				`SELECT ${stored.tool.map(quote).join(",")},octet_length(input_json) AS inputBytes,octet_length(output_json) AS outputBytes,${rowLength(stored.tool)} AS rowBytes FROM narrator_tool_calls WHERE id=? AND ${rowLength(stored.tool)}=? LIMIT 1`,
				[id, bytes],
			);
			capture(toolRows, id, copy);
			copies.set(id, copy);
			await this.pause(work);
		}
		const messageProgram: Statement[] = [];
		let producedBytes = 0;
		for (const message of messages) {
			if (message.action !== "rewrite" && message.action !== "copy_on_write") continue;
			const original = bodies.get(message.id);
			const text = bodyTexts.get(message.id);
			if (!original || text === undefined) throw fail("BODY_INVALID", "No raw body");
			const selectedBlocks = blocks.get(message.id) ?? [];
			const rewritten = await rewriteBody(
				work,
				message,
				selectedBlocks,
				text,
				String(original.role),
			);
			this.check(work);
			producedBytes += rewritten.bytes;
			bound(producedBytes, FILE_CHANGE_LIMITS.historyCowBytes, "rewritten body bytes");
			const invalidBoundary = selectedBlocks.some(
				(b) => b.action === "remove" && b.type === "tool_use",
			);
			const patch: Row = {
				content_json: rewritten.body,
				content_text: rewritten.text,
				context_chars_json: rewritten.contextCharsJson,
				// The column holds the rewritten body again; the sync queue rebuilds the rows.
				...(stored.message.includes("body_rows_only") ? { body_rows_only: 0 } : {}),
				...(invalidBoundary ? { tree_hash_after: null, snapshot_commit_sha: null } : {}),
			};
			if (message.action === "rewrite") {
				messageProgram.push(update("narrator_messages", patch, { id: message.id }));
			} else {
				const id = cowIds.get(message.id);
				if (!id) throw fail("MANIFEST_INVALID", "COW has no allocated identity");
				// Keep message role, actor and every other raw field. The copy belongs to the
				// ref's holder; its author stays the narrator that wrote it (§6.3).
				messageProgram.push(
					insert(
						"narrator_messages",
						{
							...original,
							...patch,
							id,
							narrator_id: message.narratorId,
							author_narrator_id: original.author_narrator_id ?? original.narrator_id,
						},
						stored.message,
					),
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
								stored.tool,
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
		// As the legacy semantic_edit rule: every edited ref needs a fresh input-adoption
		// fact, with or without a mailbox row (pre-mailbox Send receipts live on the ref).
		for (const change of recipientChanges) {
			if (change.kind !== "edited") continue;
			const entry = refPatches.get(change.ref.id);
			if (!entry || entry.remove) throw fail("MANIFEST_INVALID", "An edited ref is not kept");
			entry.patch.injection_consumed_at = null;
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
		for (const id of narrators.keys())
			narratorProgram.push(
				update(
					"narrators",
					{
						...narratorPatches.get(id),
						api_conversation_id: null,
						updated_at: now,
					},
					{ id },
					["message_version"],
				),
			);
		// Count actual unique row mutations too: the collector's conservative budget is a
		// lower admission gate, never permission to omit narrator/ref/clone side effects.
		const messageChanges = refProgram.length + messages.filter((m) => m.action !== "unlink").length;
		const relatedChanges =
			associationProgram.length +
			questionProgram.length +
			recipient.program.length +
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
			...questionProgram,
			...associationProgram,
			...messageProgram,
			// Same order as deleteRecipientMessageRefs: receipt first, while the ref exists.
			...recipient.program,
			...refProgram,
			...narratorProgram,
			// Source refresh is a metadata side effect, never a CAS on the sender's version.
			...recipient.refreshes,
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
		work.result.refreshedNarratorIds = recipient.refreshedIds;
		const selector = selection.selector;
		if (
			selector.kind === "all" ||
			selector.kind === "from_seq" ||
			selector.kind === "after_block"
		) {
			let minSeq = selector.kind === "from_seq" ? selector.minSeq : -Number.MAX_SAFE_INTEGER;
			let retainedBoundary = 0;
			if (selector.kind === "after_block") {
				const boundary = this.one<Ref>(
					work,
					"SELECT id,narrator_id,message_id,seq,segment_compact_id,is_compact FROM narrator_message_refs WHERE narrator_id=? AND message_id=? LIMIT 1",
					[selection.narratorId, selector.messageId],
				);
				capture(refRows, boundary.id, boundary);
				minSeq = boundary.seq;
				if (!messageById.has(selector.messageId)) retainedBoundary = 1;
			}
			work.checks.push({
				text: "SELECT CASE WHEN refs_inherited_from IS NULL OR refs_backfill_cursor<=? THEN 1 ELSE 0 END AS n FROM narrators WHERE id=? LIMIT 1",
				values: [minSeq, selection.narratorId],
				count: 1,
			});
			work.checks.push({
				// Bounded indexed membership check: even an unversioned suffix insertion
				// cannot be silently excluded from an already confirmed rollback range.
				text: "SELECT count(*) AS n FROM (SELECT id FROM narrator_message_refs INDEXED BY idx_narrator_refs_seq WHERE narrator_id=? AND seq>=? LIMIT ?)",
				values: [selection.narratorId, minSeq, FILE_CHANGE_LIMITS.historyMessageRefChanges + 1],
				count:
					messages.filter(
						(message) => message.narratorId === selection.narratorId && message.seq >= minSeq,
					).length + retainedBoundary,
			});
		}
		work.checks.push(
			...rowChecks("narrator_messages", "id", messageRows.values(), {
				ftsBytes: "coalesce(octet_length(a.content_text),0)",
				rowBytes: rowLength(stored.message, "a."),
			}),
			...rowChecks("narrator_message_refs", "id", refRows.values()),
			...rowChecks("narrator_tool_calls", "id", toolRows.values(), {
				inputBytes: "octet_length(a.input_json)",
				outputBytes: "octet_length(a.output_json)",
				rowBytes: rowLength(stored.tool, "a."),
			}),
			...rowChecks("narrators", "id", authorizationRows.values()),
			...rowChecks(
				"narrators",
				"id",
				[...narrators.values()].map(({ message_version: _version, ...row }) => row),
			),
			...targetChecks(
				toolTargets,
				"CROSS JOIN narrator_tool_calls a INDEXED BY idx_toolcalls_message ON a.message_id=t.message_id",
			),
			...targetChecks(
				sharedTargets,
				"WHERE EXISTS(SELECT 1 FROM narrator_message_refs a INDEXED BY idx_narrator_refs_message WHERE a.message_id=t.message_id AND a.narrator_id!=t.owner_id) IS t.shared",
			),
			...targetChecks(
				hiddenGlobal,
				"WHERE NOT EXISTS(SELECT 1 FROM narrator_message_refs a INDEXED BY idx_narrator_refs_segment_compact WHERE a.segment_compact_id=t.message_id)",
			),
			...targetChecks(
				hiddenOwner,
				"WHERE NOT EXISTS(SELECT 1 FROM narrator_message_refs a INDEXED BY idx_narrator_refs_segment_compact WHERE a.segment_compact_id=t.message_id AND a.narrator_id=t.owner_id)",
			),
		);
		bound(
			work.checks.length,
			FILE_CHANGE_LIMITS.historyToolRelatedChanges * 8,
			"history read checks",
		);
		this.check(work);
	}
	/** Equivalent of updateRecipientMessageRef for every fixed owner ref this program
	 * removes (deleted) or edits (rewrite keeps its ID; COW retargets the same ref). Each
	 * (owner, ref) is a membership target even when it has no mailbox, so a receipt bound
	 * after preparation is rejected; captured receipts are then updated by exact PK. */
	private async prepareRecipientReceipts(
		work: Snapshot,
		changes: RecipientChange[],
		affected: ReadonlySet<string>,
		cancelled: ReadonlySet<string>,
	) {
		const receipts = new Map<string, RecipientMailbox & { change: RecipientChange }>();
		const projections = new Map<string, RecipientMailbox>();
		const refTargets: Target[] = [];
		const sources = new Map<string, SourceNarrator>();
		const sourceTargets: Target[] = [];
		for (let i = 0; i < changes.length; i++) {
			const change = changes[i];
			const { ref } = change;
			const rows = this.rows<RecipientMailbox>(
				work,
				"SELECT id,narrator_id,recipient_ref_id,state,source_narrator_id,current_revision,content_revision FROM narrator_buffered_messages INDEXED BY idx_nbm_ref WHERE narrator_id=? AND recipient_ref_id=? AND state='materialized' LIMIT ?",
				[ref.narrator_id, ref.id, PAGE + 1],
			);
			bound(rows.length, PAGE, "recipient receipts per ref");
			refTargets.push({ row: { owner_id: ref.narrator_id, ref_id: ref.id }, count: rows.length });
			for (const row of rows) {
				bound(row.current_revision, Number.MAX_SAFE_INTEGER - 1, "receipt current revision", 1);
				bound(row.content_revision, Number.MAX_SAFE_INTEGER - 1, "receipt content revision", 1);
				capture(projections, row.id, row);
				receipts.set(row.id, { ...row, change });
			}
			bound(receipts.size, FILE_CHANGE_LIMITS.historyToolRelatedChanges, "recipient receipts");
			if ((i + 1) % PAGE === 0) await this.pause(work);
		}
		// The question program runs first and leaves its notices non-materialized, so the
		// helper's state='materialized' update is then a no-op for exactly those rows: they
		// neither change nor trigger a source refresh. Skip them rather than match zero rows.
		const updated = [...receipts.values()].filter((row) => !cancelled.has(row.id));
		// The legacy helper refreshes each source of a CHANGED receipt and, for a subagent
		// source, its parent. Capture only that relationship and existence, never a version
		// or body. A missing narrator is a fixed empty target, as the helper's inArray skip.
		const refreshed = new Set<string>();
		const seen = new Set<string>();
		const resolve = (id: string) => {
			if (seen.has(id)) return sources.get(id);
			seen.add(id);
			const row = this.rows<SourceNarrator>(
				work,
				"SELECT id,type,parent_narrator_id FROM narrators WHERE id=? LIMIT 1",
				[id],
			)[0];
			sourceTargets.push({ row: { source_id: id }, count: row ? 1 : 0 });
			if (!row) return undefined;
			capture(sources, row.id, row);
			refreshed.add(row.id);
			return row;
		};
		for (const row of updated) {
			const source = row.source_narrator_id ? resolve(row.source_narrator_id) : undefined;
			if (source?.type === "subagent" && source.parent_narrator_id)
				resolve(source.parent_narrator_id);
			bound(seen.size, FILE_CHANGE_LIMITS.historyToolRelatedChanges, "receipt source narrators");
		}
		// Owners already in this program get exactly one CAS increment of their own.
		for (const id of affected) refreshed.delete(id);
		const refreshedIds = [...refreshed];
		const at = new Date().toISOString();
		const program = updated.map((row) =>
			update(
				"narrator_buffered_messages",
				mailboxPatch(
					row.change.kind === "deleted"
						? recipientDeletedReceiptPatch(at)
						: semanticEditReceiptPatch(
								row.change.messageId,
								nextCurrentRevision(row.current_revision, row.content_revision),
								at,
							),
				),
				{
					id: row.id,
					narrator_id: row.narrator_id,
					recipient_ref_id: row.recipient_ref_id,
					state: "materialized",
				},
			),
		);

		const refreshes = refreshedIds.map((id) => ({
			text: 'UPDATE "narrators" SET "message_version"="message_version"+1,"updated_at"=? WHERE "id" IS ?',
			values: [at, id],
		}));
		work.checks.push(
			...rowChecks("narrator_buffered_messages", "id", projections.values()),
			...rowChecks("narrators", "id", sources.values()),
			...targetChecks(
				refTargets,
				"CROSS JOIN narrator_buffered_messages a INDEXED BY idx_nbm_ref ON a.narrator_id=t.owner_id AND a.recipient_ref_id=t.ref_id AND a.state='materialized'",
			),
			...targetChecks(sourceTargets, "CROSS JOIN narrators a ON a.id=t.source_id"),
		);
		return { program, refreshes, refreshedIds };
	}
	/** Materialize every question/event write before issuing the capability. Apply does
	 * not call the ordinary reconciliation helper or discover any new history rows. */
	private async prepareQuestions(
		work: Snapshot,
		selection: RevertSelectionResult,
		allTools: ReadonlyMap<string, Tool>,
	) {
		const questions = new Map<string, QuestionHistoryRow>();
		const eventRows = new Map<string, Row>();
		const requests = new Set<string>();
		const physicallyDeleted = new Set<string>();
		const deletedByOwner = new Map<string, Set<string>>();
		const requestTargets: Target[] = [];
		const eventTargets: Target[] = [];
		const answerTargets: Target[] = [];
		const historyTargets: Target[] = [];
		const inboxTargets = new Map<string, Target>();
		const authorized = new Set(selection.messageVersions.map((row) => row.narratorId));
		const add = (row: QuestionHistoryRow, requestRemoved = false) => {
			if (!authorized.has(row.narrator_id))
				throw fail(
					"UNAUTHORIZED_ASSOCIATION",
					"Question owner is outside the fixed history manifest",
				);
			const { id, narrator_id, tool_call_id, answer_message_id, status } = row;
			capture(questions, id, { id, narrator_id, tool_call_id, answer_message_id, status });
			if (requestRemoved) requests.add(id);
			bound(questions.size, QUESTION_HISTORY_LIMIT, "question history rows");
		};
		type EventCandidate = QuestionHistoryRow & { eventMessageId: string; eventCursor: number };
		const addEvent = (row: EventCandidate) => {
			add(row);
			capture(eventRows, row.eventMessageId, {
				question_id: row.id,
				message_id: row.eventMessageId,
				cursor: row.eventCursor,
			});
		};
		const read = <T>(text: string, values: SQLQueryBindings[]) => {
			const rows = this.rows<T>(work, text, values);
			bound(rows.length, QUESTION_HISTORY_LIMIT, "question candidates");
			return rows;
		};
		const toolsByMessage = new Map<string, Tool[]>();
		for (const tool of allTools.values()) {
			const tools = toolsByMessage.get(tool.message_id) ?? [];
			tools.push(tool);
			toolsByMessage.set(tool.message_id, tools);
		}
		const removedBlocks = new Map<string, Set<string>>();
		for (const block of selection.history.blocks) {
			if (block.action !== "remove" || block.type !== "tool_use" || !block.toolUseId) continue;
			const ids = removedBlocks.get(block.messageId) ?? new Set<string>();
			ids.add(block.toolUseId);
			removedBlocks.set(block.messageId, ids);
		}
		const deletedTools = new Set(
			selection.history.toolChanges.filter((row) => row.action === "delete").map((row) => row.id),
		);
		for (const message of selection.history.messages) {
			const whole = message.action === "delete" || message.action === "unlink";
			// Full inventory, not only physical deletes: unlink and COW must also withdraw
			// the original owner's request when its creation block disappears.
			for (const tool of toolsByMessage.get(message.id) ?? []) {
				if (!whole && !removedBlocks.get(message.id)?.has(tool.tool_use_id)) continue;
				const physical = Number(deletedTools.has(tool.id));
				const rows = read<QuestionHistoryRow>(
					`SELECT ${QUESTION_HISTORY_COLUMNS} FROM narrator_questions q INDEXED BY idx_narrator_questions_tool_call WHERE q.tool_call_id=? AND (q.narrator_id=? OR ?=1) LIMIT ?`,
					[tool.id, message.narratorId, physical, QUESTION_HISTORY_LIMIT + 1],
				);
				requestTargets.push({
					row: { owner_id: message.narratorId, tool_call_id: tool.id, physical_delete: physical },
					count: rows.length,
				});
				for (const row of rows) {
					add(row, true);
					if (physical) physicallyDeleted.add(row.id);
				}
			}
			if (whole) {
				const ids = deletedByOwner.get(message.narratorId) ?? new Set<string>();
				ids.add(message.id);
				deletedByOwner.set(message.narratorId, ids);
				const physical = Number(message.action === "delete");
				const events = read<EventCandidate>(
					`SELECT ${QUESTION_HISTORY_COLUMNS},e.message_id AS eventMessageId,e.rowid AS eventCursor FROM narrator_question_events e CROSS JOIN narrator_questions q ON q.id=e.question_id WHERE e.message_id=? AND (q.narrator_id=? OR ?=1) LIMIT 1`,
					[message.id, message.narratorId, physical],
				);
				eventTargets.push({
					row: { owner_id: message.narratorId, message_id: message.id, physical_delete: physical },
					count: events.length,
				});
				for (const row of events) addEvent(row);
				const answers = read<QuestionHistoryRow>(
					`SELECT ${QUESTION_HISTORY_COLUMNS} FROM narrator_questions q INDEXED BY idx_narrator_questions_answer_message WHERE q.narrator_id=? AND q.answer_message_id=? LIMIT ?`,
					[message.narratorId, message.id, QUESTION_HISTORY_LIMIT + 1],
				);
				answerTargets.push({
					row: { owner_id: message.narratorId, message_id: message.id },
					count: answers.length,
				});
				for (const row of answers) add(row);
			}
			await this.pause(work);
		}
		// Physical cascade leaves may belong to another authorized owner; preserve the
		// explicit manifest path and its ACL check rather than guessing ownership.
		for (const edge of selection.history.associations) {
			if (edge.table === "narrator_questions") {
				const row = this.one<QuestionHistoryRow>(
					work,
					`SELECT ${QUESTION_HISTORY_COLUMNS} FROM narrator_questions q WHERE q.id=? LIMIT 1`,
					[edge.id],
				);
				add(row, true);
				physicallyDeleted.add(row.id);
			} else if (edge.table === "narrator_question_events") {
				const row = this.one<EventCandidate>(
					work,
					`SELECT ${QUESTION_HISTORY_COLUMNS},e.message_id AS eventMessageId,e.rowid AS eventCursor FROM narrator_question_events e CROSS JOIN narrator_questions q ON q.id=e.question_id WHERE e.message_id=? LIMIT 1`,
					[edge.id],
				);
				addEvent(row);
				const ids = deletedByOwner.get(row.narrator_id) ?? new Set<string>();
				ids.add(edge.id);
				deletedByOwner.set(row.narrator_id, ids);
			}
		}
		const program: Statement[] = [];
		const inboxRows = new Map<string, QuestionHistoryInboxRow>();
		let count = 0;
		let bytes = 0;
		for (const question of questions.values()) {
			const sizes = await this.page<{
				question_id: string;
				message_id: string;
				cursor: number;
				resolutionBytes: number;
			}>(
				work,
				"SELECT question_id,message_id,coalesce(octet_length(resolution_json),0) AS resolutionBytes,rowid AS cursor FROM narrator_question_events",
				"idx_question_events_question_rowid",
				"question_id",
				question.id,
			);
			count += sizes.length;
			bytes += sizes.reduce((sum, row) => sum + row.resolutionBytes, 0);
			bound(count, QUESTION_HISTORY_LIMIT, "question history events");
			bound(bytes, QUESTION_HISTORY_BYTES, "question resolution bytes");
			historyTargets.push({ row: { question_id: question.id }, count: sizes.length });
			for (const size of sizes) capture(eventRows, size.message_id, size);
			const events: QuestionHistoryEvent[] = [];
			for (const size of sizes) {
				// Bind the preflight to this exact PK, insertion order and byte count before
				// materializing resolution_json. Equal length is admission, not equality:
				// capture the actual full value for the subsequent commit check.
				const event = this.one<QuestionHistoryEvent & { cursor: number; resolutionBytes: number }>(
					work,
					"SELECT question_id,message_id,kind,created_at,resolution_json,rowid AS cursor,coalesce(octet_length(resolution_json),0) AS resolutionBytes FROM narrator_question_events WHERE question_id=? AND message_id=? AND rowid=? AND coalesce(octet_length(resolution_json),0)=? LIMIT 1",
					[question.id, size.message_id, size.cursor, size.resolutionBytes],
				);
				capture(eventRows, event.message_id, event);
				events.push(event);
				if (events.length % PAGE === 0) await this.pause(work);
			}
			const deleted = deletedByOwner.get(question.narrator_id) ?? new Set<string>();
			for (const eventId of new Set([
				...events
					.filter(
						(event) =>
							requests.has(question.id) ||
							physicallyDeleted.has(question.id) ||
							deleted.has(event.message_id),
					)
					.map((event) => event.message_id),
				...(question.answer_message_id &&
				(requests.has(question.id) || deleted.has(question.answer_message_id))
					? [question.answer_message_id]
					: []),
			])) {
				const key = JSON.stringify([question.narrator_id, eventId]);
				if (inboxTargets.has(key)) continue;
				const rows = this.rows<QuestionHistoryInboxRow>(
					work,
					"SELECT id,narrator_id,recipient_message_id FROM narrator_buffered_messages INDEXED BY idx_nbm_reserved WHERE narrator_id=? AND recipient_message_id=? AND kind='task_notice' AND source_key=? LIMIT ?",
					[question.narrator_id, eventId, `question-answer:${eventId}`, QUESTION_HISTORY_LIMIT + 1],
				);
				inboxTargets.set(key, {
					row: { owner_id: question.narrator_id, event_message_id: eventId },
					count: rows.length,
				});
				for (const row of rows) capture(inboxRows, row.id, row);
				bound(inboxRows.size, QUESTION_HISTORY_LIMIT, "question inbox rows");
			}
			const plan = buildQuestionHistoryProgram(
				question,
				events,
				deleted,
				requests.has(question.id),
				physicallyDeleted.has(question.id),
			);
			if (plan.statements.length || physicallyDeleted.has(question.id))
				work.result.affectedQuestionIds.push(question.id);
			program.push(...plan.statements);
			await this.pause(work);
		}
		work.checks.push(
			...rowChecks("narrator_questions", "id", questions.values()),
			...rowChecks("narrator_question_events", "message_id", eventRows.values(), {
				cursor: "a.rowid",
				resolutionBytes: "coalesce(octet_length(a.resolution_json),0)",
			}),
			...rowChecks(
				"narrator_buffered_messages",
				"id",
				[...inboxRows.values()].map((row) => ({
					...row,
					kind: "task_notice",
					source_key: `question-answer:${row.recipient_message_id}`,
				})),
			),
			...targetChecks(
				requestTargets,
				"CROSS JOIN narrator_questions q INDEXED BY idx_narrator_questions_tool_call ON q.tool_call_id=t.tool_call_id AND (q.narrator_id=t.owner_id OR t.physical_delete=1)",
			),
			...targetChecks(
				eventTargets,
				"CROSS JOIN narrator_question_events e ON e.message_id=t.message_id CROSS JOIN narrator_questions q ON q.id=e.question_id AND (q.narrator_id=t.owner_id OR t.physical_delete=1)",
			),
			...targetChecks(
				answerTargets,
				"CROSS JOIN narrator_questions q INDEXED BY idx_narrator_questions_answer_message ON q.answer_message_id=t.message_id AND q.narrator_id=t.owner_id",
			),
			...targetChecks(
				historyTargets,
				"CROSS JOIN narrator_question_events e INDEXED BY idx_question_events_question_rowid ON e.question_id=t.question_id",
			),
			...targetChecks(
				inboxTargets.values(),
				"CROSS JOIN narrator_buffered_messages a INDEXED BY idx_nbm_reserved ON a.narrator_id=t.owner_id AND a.recipient_message_id=t.event_message_id AND a.kind='task_notice' AND a.source_key='question-answer:'||t.event_message_id",
			),
		);
		program.push(...buildQuestionHistoryInboxProgram([...inboxRows.values()]));
		return { program, inboxIds: new Set(inboxRows.keys()) as ReadonlySet<string> };
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
function rowLength(columns: string[], prefix = "") {
	// octet_length(column) can use SQLite record metadata for TEXT/BLOB without loading
	// the whole value. length(CAST(column AS BLOB)) would unnecessarily materialize it.
	return columns.map((name) => `coalesce(octet_length(${prefix}${quote(name)}),0)`).join("+");
}
/** Only add newly consumed fields; a later read must never rebaseline an earlier value. */
function capture<T extends Row>(records: Map<string, T>, key: string, row: T): T {
	const previous = records.get(key);
	if (previous) {
		for (const [column, value] of Object.entries(row))
			if (Object.hasOwn(previous, column) && previous[column] !== value)
				throw fail("STALE", "Selected history changed during preparation");
	}
	const captured = { ...previous, ...row };
	records.set(key, captured);
	return captured;
}
/** A: exact, null-safe projection equality by the fixed primary key. Expressions are
 * explicit local aliases (byte lengths/rowid), never parsed from a remembered query. */
function rowChecks(
	table: string,
	key: string,
	rows: Iterable<Row>,
	expressions: Record<string, string> = {},
): Check[] {
	const groups = new Map<string, { columns: string[]; rows: Row[] }>();
	for (const row of rows) {
		const columns = Object.keys(row).sort();
		const signature = columns.join(",");
		const group = groups.get(signature) ?? { columns, rows: [] };
		group.rows.push(row);
		groups.set(signature, group);
	}
	const checks: Check[] = [];
	for (const { columns, rows: expected } of groups.values()) {
		bound(columns.length, 32_000, "history projection columns", 1);
		const size = Math.min(PAGE, Math.floor(32_000 / columns.length));
		for (let i = 0; i < expected.length; i += size) {
			const batch = expected.slice(i, i + size);
			const tuple = `(${columns.map(() => "?").join(",")})`;
			checks.push({
				text: `WITH expected(${columns.map(quote).join(",")}) AS (VALUES ${batch.map(() => tuple).join(",")}) SELECT count(*) AS n FROM expected e CROSS JOIN ${quote(table)} a ON a.${quote(key)} IS e.${quote(key)} WHERE ${columns.map((column) => `${expressions[column] ?? `a.${quote(column)}`} IS e.${quote(column)}`).join(" AND ")}`,
				values: batch.flatMap((row) => columns.map((column) => row[column])),
				count: batch.length,
			});
		}
	}
	return checks;
}
/** B: bounded membership over fixed targets, including targets whose original count was
 * zero. Pair with A for identity/pointer equality so a same-count replacement also fails. */
function targetChecks(targets: Iterable<Target>, join: string): Check[] {
	const expected = [...targets];
	if (!expected.length) return [];
	const columns = Object.keys(expected[0].row);
	bound(columns.length, 32_000, "history target columns", 1);
	const size = Math.min(PAGE, Math.floor(32_000 / columns.length));
	const checks: Check[] = [];
	for (let i = 0; i < expected.length; i += size) {
		const batch = expected.slice(i, i + size);
		const count = batch.reduce((sum, target) => sum + target.count, 0);
		bound(count, FILE_CHANGE_LIMITS.historyToolRelatedChanges, "history target members");
		const tuple = `(${columns.map(() => "?").join(",")})`;
		checks.push({
			text: `WITH targets(${columns.map(quote).join(",")}) AS (VALUES ${batch.map(() => tuple).join(",")}) SELECT count(*) AS n FROM (SELECT 1 FROM targets t ${join} LIMIT ${count + 1})`,
			values: batch.flatMap(({ row }) => columns.map((column) => row[column])),
			count,
		});
	}
	return checks;
}
function conditions(where: Row) {
	return Object.keys(where)
		.map((name) => `${quote(name)} IS ?`)
		.join(" AND ");
}
function update(table: string, patch: Row, where: Row, increments: string[] = []): Statement {
	return {
		text: `UPDATE ${quote(table)} SET ${[
			...Object.keys(patch).map((name) => `${quote(name)}=?`),
			...increments.map((name) => `${quote(name)}=${quote(name)}+1`),
		].join(",")} WHERE ${conditions(where)}`,
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
function fixSelection(selection: RevertSelectionResult, snapshotRecovery = false) {
	if (
		selection.version !== 1 ||
		!selection.selectionComplete ||
		((!selection.evidenceComplete || selection.issues.length) &&
			!(snapshotRecovery && isSnapshotSelectionComplete(selection)))
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
	const narrators = selection.messageVersions.map((row) => {
		bound(row.messageVersion, Number.MAX_SAFE_INTEGER, "message version");
		return smallCommitment(fixedText(row.narratorId));
	});
	const rootVersion = selection.messageVersions.find(
		(row) => row.narratorId === selection.narratorId,
	)?.messageVersion;
	if (rootVersion === undefined) throw fail("MANIFEST_INVALID", "Missing root version");
	bound(rootVersion, Number.MAX_SAFE_INTEGER, "message version");
	return {
		narratorId: fixedText(selection.narratorId),
		userId: fixedText(selection.requestedByUserId),
		digest: fixedText(selection.metadataDigest),
		selector: fixSelector(selection.selector),
		narrators,
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
		[fixed.narrators, current.messageVersions.map((row) => row.narratorId)],
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

type Rewritten = { body: string; text: string | null; bytes: number; contextCharsJson: string };
type RewriteRequest = {
	message: RevertSelectionMessage;
	blocks: RevertSelectionBlock[];
	body: string;
	role: string;
};
class RewritePoolWorker implements PoolWorker<RewriteRequest, Rewritten> {
	private stopping = false;
	private pending:
		| {
				requestId: string;
				resolve: (result: Rewritten) => void;
				reject: (error: unknown) => void;
		  }
		| undefined;
	constructor(private readonly handle: WorkerHandle<import("node:worker_threads").Worker>) {
		handle.resource.on("message", this.message);
		handle.resource.on("error", this.error);
		handle.resource.on("messageerror", this.error);
		handle.resource.on("exit", this.exit);
		handle.resource.unref();
	}
	get closed() {
		return this.stopping || this.handle.closed;
	}
	private message = (reply: unknown) => {
		if (
			reply &&
			typeof reply === "object" &&
			!Array.isArray(reply) &&
			"ready" in reply &&
			reply.ready === true &&
			!("requestId" in reply) &&
			!("result" in reply) &&
			!("error" in reply)
		)
			return;
		if (
			!reply ||
			typeof reply !== "object" ||
			Array.isArray(reply) ||
			!("requestId" in reply) ||
			typeof reply.requestId !== "string" ||
			!reply.requestId
		) {
			this.error(fail("BODY_INVALID", "Invalid rewrite worker response"));
			return;
		}
		const pending = this.pending;
		// A late success OR error cannot settle a subsequent rewrite on this worker.
		if (!pending || reply.requestId !== pending.requestId) return;
		if ("error" in reply && typeof reply.error === "string" && !("result" in reply)) {
			this.pending = undefined;
			this.handle.resource.unref();
			pending.reject(fail("BODY_INVALID", reply.error));
			return;
		}
		const result = "result" in reply ? reply.result : undefined;
		// Shape checks stay constant-time; commitments were verified off-thread.
		if (
			"error" in reply ||
			!result ||
			typeof result !== "object" ||
			Array.isArray(result) ||
			!("body" in result) ||
			typeof result.body !== "string" ||
			!("text" in result) ||
			(result.text !== null && typeof result.text !== "string") ||
			!("bytes" in result) ||
			typeof result.bytes !== "number" ||
			!Number.isSafeInteger(result.bytes) ||
			result.bytes < 0 ||
			!("contextCharsJson" in result) ||
			typeof result.contextCharsJson !== "string"
		) {
			this.error(fail("BODY_INVALID", "Invalid rewrite worker response"));
			return;
		}
		this.pending = undefined;
		this.handle.resource.unref();
		pending.resolve(result as Rewritten);
	};
	private error = (error: unknown) => {
		this.pending?.reject(error);
		this.pending = undefined;
		void this.close().catch(() => {});
	};
	private exit = () => this.error(fail("BODY_INVALID", "Rewrite worker exited"));
	run(request: RewriteRequest, context: WorkerTaskContext): Promise<Rewritten> {
		context.signal.throwIfAborted();
		if (this.closed) return Promise.reject(fail("BODY_INVALID", "Rewrite worker unavailable"));
		this.handle.resource.ref();
		return new Promise((resolve, reject) => {
			this.pending = { requestId: context.requestId, resolve, reject };
			try {
				this.handle.resource.postMessage({
					...request,
					requestId: context.requestId,
					limit: FILE_CHANGE_LIMITS.historyCowBytes,
				});
			} catch (error) {
				this.error(error);
			}
		});
	}
	async close(): Promise<void> {
		this.stopping = true;
		this.pending?.reject(fail("BODY_INVALID", "Rewrite worker closed"));
		this.pending = undefined;
		await this.handle.close();
		this.handle.resource.off("message", this.message);
		this.handle.resource.off("error", this.error);
		this.handle.resource.off("messageerror", this.error);
		this.handle.resource.off("exit", this.exit);
	}
}
function createRewritePool() {
	return new WorkerPool<RewriteRequest, Rewritten>({
		concurrency: 2,
		maxQueued: 32,
		maxQueuedBytes: 64 * 1024 * 1024,
		timeoutMs: 30_000,
		create: async (context) => {
			const { handle } = await connectCompiledWorker([REWRITE_WORKER], {
				signal: context.signal,
				deadlineAt: context.deadlineAt,
				workerOptions: { eval: true },
			});
			return new RewritePoolWorker(handle);
		},
	});
}
const rewriteWorkers = hotSafe("revert-rewrite:pool", () => ({ pool: createRewritePool() }));
/** Final production shutdown: no new admission; resolves only after native exit. */
export function closeRevertRewriteWorkers(): Promise<void> {
	return rewriteWorkers.pool.close();
}
export async function resetRevertRewriteWorkersForTests(): Promise<void> {
	if (process.env.NARRAFORK_TEST !== "1") throw new Error("Test-only rewrite pool reset");
	await closeRevertRewriteWorkers();
	rewriteWorkers.pool = createRewritePool();
}
async function rewriteBody(
	scope: Pick<Snapshot, "signal" | "expiresAt">,
	message: RevertSelectionMessage,
	blocks: RevertSelectionBlock[],
	body: string,
	role: string,
): Promise<Rewritten> {
	try {
		// UTF-8 upper bound + bounded fixed block metadata, without scanning/encoding a body.
		return await rewriteWorkers.pool.run(
			{ message, blocks, body, role },
			{
				signal: scope.signal,
				deadlineAt: scope.expiresAt,
				requestId: generateId(),
				bytes:
					body.length * 3 +
					blocks.length * (message.id.length * 3 + 2048) +
					(message.id.length +
						message.refId.length +
						message.narratorId.length +
						(message.segmentCompactId?.length ?? 0) +
						(message.treeHashAfter?.length ?? 0) +
						(message.snapshotCommitSha?.length ?? 0) +
						role.length) *
						3 +
					1024,
			},
		);
	} catch (error) {
		scope.signal.throwIfAborted();
		if (
			error instanceof Error &&
			(error.name === "TaskQueueError" || error.name === "WorkerPoolError")
		)
			throw fail("BODY_INVALID", error.message);
		throw error;
	}
}
/** Parsing and hashing even a single 4MiB message runs off the main thread. Retained JSON
 * element substrings are copied verbatim (large numbers, escapes, whitespace and key order
 * survive); all other SQL JSON strings are copied without decoding/re-encoding at all. */
export const REWRITE_WORKER = `
const { parentPort } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
// Fixed worker implementation: no source-file imports or executable request payloads.
// Representative block/role cases are compared against context-characters.ts in tests.
function measureCharacters(role, blocks, contentText) {
 if (role === 'disp') return {segments: []};
 const segments = [];
 const userTextParts = [];
 const addChars = (category, chars) => {
  if (!Number.isSafeInteger(chars) || chars <= 0) return;
  const previous = segments[segments.length - 1];
  if (previous && previous.category === category && !previous.toolUseId) previous.chars += chars;
  else segments.push({category, chars});
 };
 const add = (category, text) => { if (typeof text === 'string') { if (category === 'user') userTextParts.push(text); addChars(category, text.length); } };
 const category = role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : role === 'sys' || role === 'system' ? 'system' : 'other';
 for (const block of blocks) {
  if (!block || typeof block !== 'object') continue;
  switch (block.type) {
   case 'tool_use': {
    const toolUseId = typeof block.id === 'string' ? block.id : block.toolUseId;
    if (typeof toolUseId === 'string') segments.push({category: 'toolCall', chars: 0, toolUseId});
    break;
   }
   case 'tool_result': case 'image': case 'redacted_thinking': case 'info': case 'error': case 'compact':
    break;
   case 'segment_compact':
    if (block.status !== 'compacting' && block.status !== 'failed') add('summary', block.summary);
    break;
   case 'file_reference':
    add('attachment', block.snapshotText);
    break;
   case 'text_file': {
    const text = block.text ?? block.content;
    const chars = block.contentChars ?? block.chars;
    if (typeof text === 'string') add('attachment', text);
    else if (typeof chars === 'number') addChars('attachment', chars);
    break;
   }
   case 'attachment': case 'document':
    add('attachment', block.text ?? block.content ?? block.source?.text);
    break;
   case 'thinking':
    add('reasoning', block.thinking ?? block.text);
    break;
   case 'reasoning': case 'reasoning_text': case 'thought':
    add('reasoning', block.modelText ?? block.text);
    break;
   default:
    add(category, block.modelText ?? block.text);
  }
 }
 if (role === 'user' && typeof contentText === 'string' && blocks.some(block => block?.type === 'text_file')) {
  const body = userTextParts.join('\\n');
  if (contentText.startsWith(body)) addChars('attachment', contentText.length - body.length);
 }
 return {segments};
}
parentPort.on('message', ({action, requestId, message, blocks, body, role, limit}) => {
 if (action === 'ping') { parentPort.postMessage({ready: true}); return; }
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
  const retainedBlocks = parsed.filter((_, i) => blocks[i].action === 'retain');
  const contextCharsJson = JSON.stringify(measureCharacters(role, retainedBlocks, text));
  parentPort.postMessage({requestId, result: {body: rewritten, text, bytes, contextCharsJson}});
 } catch (error) { parentPort.postMessage({requestId, error: error.message}); }
});
`;
