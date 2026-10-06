/**
 * CAPABILITY BOUNDARY: this module is SQLite-only by design, and that is a
 * deliberate capability decision, not unfinished porting.
 *
 * Its query implementation uses SQLite-specific capabilities:
 *
 *   - `INDEXED BY` + `rowid` keyset scans, which pin both the index choice and a
 *     physical row order PostgreSQL does not expose;
 *   - raw `bun:sqlite` prepared statements against the root handle, including the
 *     worker-side collector.
 *
 * THE PG ALTERNATIVE (for whoever ports history selection): do not translate the
 * scans. Re-express the collector as set-oriented, keyset-paged SELECTs on the
 * PG schema (the same indexes exist; ordering is by the columns themselves, not
 * `rowid`). Preserve the target-scoped version and source commitments; unrelated
 * database writes do not invalidate a preview. The plan/journal/evidence paths that CONSUME this
 * selection already have their PG counterparts (`postgres-revert-plan-store.ts`,
 * `postgres-revert-journal-store.ts`, `postgres-file-change-evidence-store.ts`).
 */
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import { setTimeout as yieldToEventLoop } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import {
	FILE_CHANGE_LIMITS,
	type FileChangeExecutionBinding,
	type FileChangeRevertSelector,
	type FileChangeState,
	hasConfirmedNoFileChange,
	hasSettledMeasuredFileEffect,
	NON_OPERATION_ROLES,
} from "@shared/file-change-protocol";
import { AppError } from "../lib/errors";
import {
	createFileChangeIdentity,
	fileChangeExecutionBindingMatches,
	fileChangeIdentityKey,
} from "./file-change-identity";
import type { FileChangeReversalEffect } from "./file-change-reversal";
import type { NarratorAclRow, NarratorPrincipal } from "./narrator-acl";

export const REVERT_SELECTION_PAGE_ITEMS = 32;
/** Additional collector bounds, not a license to call a truncated selection complete. */
export const REVERT_SELECTION_LIMITS = Object.freeze({
	messageBytes: FILE_CHANGE_LIMITS.historyCowBytes,
	inspectedBodyBytes: FILE_CHANGE_LIMITS.blobBytes,
	manifestBytes: FILE_CHANGE_LIMITS.blobBytes,
	blockItems: FILE_CHANGE_LIMITS.historyToolRelatedChanges,
	timeoutMs: 30_000,
	concurrentCollectors: 2,
	/** Total candidate children inspected, including unselected origins. */
	childNarrators: 1000,
});

export interface RevertSelectionOptions {
	/** REQUIRED real ACL adapter, e.g. assertNarratorAccess(row, principal, need).
	 * The caller must use authenticated principals; a subject hash is not permission.
	 * Called on root, child and cross-narrator pointer owners before reading their history,
	 * and again before returning. No default allow, production DB import or implicit ACL. */
	authorize(
		principal: NarratorPrincipal,
		row: NarratorAclRow,
		need: "write",
		signal: AbortSignal,
	): Promise<void>;
	timeoutMs?: number;
	/** Structured timing only. No bodies, paths, actor names or selected IDs are logged. */
	onSlow?: (event: { service: "revert-selection"; durationMs: number; queries: number }) => void;
}
export interface RevertSelectionRequest {
	principal: NarratorPrincipal;
	narratorId: string;
	expectedMessageVersion: number;
	selector: FileChangeRevertSelector;
	signal?: AbortSignal;
}
export interface RevertSelectionBlock {
	messageId: string;
	/** Bound to message ID + complete content digest + occurrence, not a moving array index. */
	key: string;
	digest: string;
	type: string;
	toolUseId: string | null;
	action: "retain" | "remove";
}
export interface RevertSelectionMessage {
	id: string;
	refId: string;
	narratorId: string;
	seq: number;
	contentDigest: string;
	contentBytes: number;
	isShared: boolean;
	action: "unlink" | "delete" | "rewrite" | "copy_on_write";
	blockCount: number;
	removedBlockCount: number;
	segmentCompactId: string | null;
	treeHashAfter: string | null;
	snapshotCommitSha: string | null;
}
export interface RevertSelectionTool {
	id: string;
	narratorId: string;
	messageId: string;
	toolUseId: string;
	toolName: string;
	status: string;
	isBackground: number;
	executionIdentityVersion: number;
	executionOriginToolCallId: string | null;
	executionAttempt: number;
	fileChangeOperationId: string | null;
	executionDeviceId: string | null;
	executionPathFlavor: string | null;
	resolvedFilePath: string | null;
	canonicalFilePath: string | null;
	runtimeGeneration: number | null;
	isFileHistoryCheckpoint: number;
	executionSegmentId: string | null;
	/** Length metadata only; these large values are never read/copied by this collector. */
	copyBytes: number;
}
export interface RevertSelectionOperation {
	id: string;
	executionSegmentId: string | null;
	evidenceVersion: number;
	sourceInstanceId: string;
	sourceKind: string;
	sourceId: string;
	attempt: number;
	toolCallId: string | null;
	narratorId: string | null;
	projectId: string | null;
	requestDigest: string | null;
	/** Bounded immutable execution binding, not a live runtime lookup. */
	executionBindingJson: string | null;
	expectedEffectCount: number | null;
	preparedEffectCount: number;
	settledEffectCount: number;
	unresolvedEffectCount: number;
	evidenceBytes: number;
	executionOutcome: string;
	effectOutcome: string;
	settlement: string;
	coverage: string;
	attributionGrade: string;
	reason: string | null;
	finishedAt: string | null;
	updatedAt: string;
}
export interface RevertSelectionIssue {
	code: string;
	toolCallId?: string;
	operationId?: string;
	messageId?: string;
}
export interface RevertSelectionResult {
	version: 1;
	narratorId: string;
	requestedByUserId: string;
	selector: FileChangeRevertSelector;
	messageVersions: { narratorId: string; messageVersion: number }[];
	boundary: { messageId: string; contentDigest: string; retainedThroughKey: string | null } | null;
	/** Enumeration finished without truncation. This is NOT file preflight or a plan proof. */
	selectionComplete: true;
	evidenceComplete: boolean;
	/** Always false: reversal, publication, pinning and execution preflight are separate. */
	executable: false;
	history: {
		messages: RevertSelectionMessage[];
		blocks: RevertSelectionBlock[];
		toolChanges: { id: string; action: "delete" | "copy" | "retain" }[];
		associations: { table: string; id: string; column: string; targetId: string }[];
		budget: { messageRefChanges: number; relatedRows: number; cowBytes: number };
	};
	tools: RevertSelectionTool[];
	operations: RevertSelectionOperation[];
	effects: FileChangeReversalEffect[];
	noDiskTools: {
		toolCallId: string;
		reason:
			| "read_only"
			| "spec"
			| "no_dispatch"
			| "delegated"
			| "pending"
			| "non_file_change"
			| "outside_selected_call";
	}[];
	issues: RevertSelectionIssue[];
	metadataDigest: string;
}
interface NarratorRow extends NarratorAclRow {
	messageVersion: number;
	refsInheritedFrom: string | null;
	status: string;
	parentNarratorId: string | null;
	originToolCallId: string | null;
}
interface RefRow {
	rowid: number;
	refId: string;
	id: string;
	narratorId: string;
	seq: number;
	role: string;
	segmentCompactId: string | null;
	contentBytes: number;
	copyBytes: number;
	treeHashAfter: string | null;
	snapshotCommitSha: string | null;
}
interface BodyBlock {
	index: number;
	key: string;
	digest: string;
	type: string;
	toolUseId: string | null;
}
interface BodySummary {
	digest: string;
	blocks: BodyBlock[];
}
interface ScopeState {
	principal: NarratorPrincipal;
	signal: AbortSignal;
	/** Bounded source queries only; never a database-wide write counter. */
	commitments: Map<string, { query: string; params: SQLQueryBindings[]; digest: string }>;
	commitmentBytes: number;
	bodies: Map<string, { ref: RefRow; digest: string }>;
	queries: number;
	inspectedBytes: number;
	manifestBytes: number;
	evidenceBytes: number;
	evidenceRefs: Map<string, { algorithm: string; sizeBytes: number }>;
	result: RevertSelectionResult;
	narrators: Map<string, NarratorRow>;
	messages: Set<string>;
	tools: Set<string>;
	operations: Set<string>;
	associationRows: Set<string>;
	childRoots: Set<string>;
	selectedSegments: Map<string, Set<string>>;
	segmentRows: number;
	/** One complete bounded parent inventory per collection; never persisted across requests. */
	childCandidates: Map<string, ReadonlyMap<string, readonly string[]>>;
	childCandidateCount: number;
	files: Set<string>;
	worker: BodyWorker;
}

/**
 * Read-only metadata collector for ACTUAL refs, stable message blocks, PK-bound tool attempts
 * and their journals. It never guesses a latest toolUseId, filters failed calls out, mutates
 * history, publishes raw blobs or upgrades counts into proof of a successful reversal.
 *
 * All requested refs (including hidden file-history checkpoints) participate. Lazy inherited
 * refs must be materialized by the existing authorized backfill workflow first; this reader
 * refuses rather than enumerate a local prefix. Bodies are length-gated, one bounded message
 * at a time, then digested/parsed in a worker; inputJson/outputJson are never selected.
 * There is an additional 32MiB total inspection budget. Above it, a future DB worker/indexed
 * block projection is needed, NOT an incomplete manifest. Public results are internal bounded
 * manifests, NOT HTTP summaries; never dump the arrays into a model response or public route.
 *
 * Recheck selected narrator metadata and bounded source-query/body commitments, not unrelated
 * database writes. This is optimistic validation, NOT an atomic snapshot across await: normal
 * history writers must bump messageVersion, and execution must recheck returned versions/digests.
 * A direct unversioned write after its source's last verification can still race the preview.
 *
 * Current FK actions are inventoried explicitly, including spec revisions/chapter commits;
 * COW of a shared partial message counts retained tool payload bytes without loading them.
 * No record is physically deleted by this class. Device authorization/current-state checks,
 * history execution, reversal, blob publication and plan proof generation remain downstream.
 */
export class RevertSelectionService {
	private active = 0;
	private readonly timeoutMs: number;
	constructor(
		private readonly database: { $client: Database },
		private readonly options: RevertSelectionOptions,
	) {
		if (!database.$client || typeof options.authorize !== "function")
			throw fail(
				"AUTHORIZATION_REQUIRED",
				"A root database and real authorization callback are required",
			);
		this.timeoutMs = options.timeoutMs ?? REVERT_SELECTION_LIMITS.timeoutMs;
		integer(this.timeoutMs, 1, FILE_CHANGE_LIMITS.planLifetimeMs, "timeout");
		this.root();
	}

	async collect(request: RevertSelectionRequest): Promise<RevertSelectionResult> {
		const started = performance.now();
		const input = normalizeRequest(request);
		const signal = AbortSignal.any([
			...(request.signal ? [request.signal] : []),
			AbortSignal.timeout(this.timeoutMs),
		]);
		signal.throwIfAborted();
		if (this.active >= REVERT_SELECTION_LIMITS.concurrentCollectors)
			throw fail("BUSY", "Too many metadata collectors");
		this.active++;
		const state: ScopeState = {
			principal: input.principal,
			signal,
			commitments: new Map(),
			commitmentBytes: 0,
			bodies: new Map(),
			queries: 0,
			inspectedBytes: 0,
			manifestBytes: 0,
			evidenceBytes: 0,
			evidenceRefs: new Map(),
			narrators: new Map(),
			messages: new Set(),
			tools: new Set(),
			operations: new Set(),
			associationRows: new Set(),
			childRoots: new Set(),
			selectedSegments: new Map(),
			segmentRows: 0,
			childCandidates: new Map(),
			childCandidateCount: 0,
			files: new Set(),
			worker: new BodyWorker(signal),
			result: {
				version: 1,
				narratorId: input.narratorId,
				requestedByUserId: input.principal.userId,
				selector: input.selector,
				messageVersions: [],
				boundary: null,
				selectionComplete: true,
				evidenceComplete: false,
				executable: false,
				history: {
					messages: [],
					blocks: [],
					toolChanges: [],
					associations: [],
					budget: { messageRefChanges: 0, relatedRows: 0, cowBytes: 0 },
				},
				tools: [],
				operations: [],
				effects: [],
				noDiskTools: [],
				issues: [],
				metadataDigest: "",
			},
		};
		let completed = false;
		try {
			await this.authorize(state, input.narratorId);
			const root = state.narrators.get(input.narratorId);
			if (root?.messageVersion !== input.expectedMessageVersion)
				throw fail("STALE", "Message version changed before collection");
			await this.select(state, input.narratorId, input.selector);
			for (const narratorId of state.narrators.keys())
				await this.authorize(state, narratorId, true);
			this.check(state);
			state.result.evidenceComplete = state.result.issues.length === 0;
			// Incremental row digests avoid serializing a multi-megabyte manifest on the event loop.
			const hash = createHash("sha256").update("revert-selection-v1\n");
			let hashedRows = 0;
			for (const row of manifestRows(state.result)) {
				hash.update(JSON.stringify(row)).update("\n");
				if (++hashedRows % REVERT_SELECTION_PAGE_ITEMS === 0) await this.pause(state);
			}
			this.check(state);
			state.result.metadataDigest = hash.digest("hex");
			await this.verifySources(state);
			completed = true;
			return state.result;
		} finally {
			await state.worker.close();
			this.active--;
			const durationMs = performance.now() - started;
			if (durationMs >= 1000) {
				const event = { service: "revert-selection" as const, durationMs, queries: state.queries };
				if (this.options.onSlow) this.options.onSlow(event);
				else console.warn("[revert-selection] slow metadata collection", event);
			}
			if (completed) {
				this.check(state); // worker shutdown was the final await
				// Catch version/context changes even during ACL callbacks or worker shutdown.
				for (const narratorId of state.narrators.keys())
					this.one<NarratorRow>(state, `${NARRATOR_SELECT} WHERE id = ? LIMIT 1`, [narratorId]);
			}
		}
	}

	private root() {
		if (this.database.$client.inTransaction)
			throw fail(
				"AMBIENT_TRANSACTION",
				"Collection cannot hold an ambient transaction across yields",
			);
	}
	private check(state: ScopeState) {
		state.signal.throwIfAborted();
		this.root();
	}
	private rows<T>(
		state: ScopeState,
		query: string,
		params: SQLQueryBindings[],
		commit = true,
	): T[] {
		this.check(state);
		state.queries++;
		const rows = this.database.$client.query<T, SQLQueryBindings[]>(query).all(...params);
		if (commit) {
			const key = JSON.stringify([query, params]);
			const digest = sourceRowsDigest(rows);
			const old = state.commitments.get(key);
			if (old && old.digest !== digest)
				throw fail("STALE", "Selected source metadata changed during collection");
			if (!old) {
				state.commitmentBytes += Buffer.byteLength(key) + digest.length;
				integer(
					state.commitmentBytes,
					0,
					REVERT_SELECTION_LIMITS.manifestBytes,
					"source commitments",
				);
				state.commitments.set(key, { query, params: [...params], digest });
			}
		}
		return rows;
	}
	private one<T>(
		state: ScopeState,
		query: string,
		params: SQLQueryBindings[],
		commit = true,
	): T | undefined {
		return this.rows<T>(state, query, params, commit)[0];
	}
	private async verifySources(state: ScopeState) {
		// Reuse the original indexed/keyset SELECTs, including their empty/end pages:
		// row insertion/removal, sharing, tool bindings and FK associations all matter.
		// Raw bodies are rehashed off-thread, never included in main-thread row digests.
		for (const { ref, digest } of state.bodies.values()) {
			const content = this.readBody(state, ref);
			const current = await state.worker.inspect(ref.id, content, true);
			this.check(state);
			if (current.digest !== digest) throw fail("STALE", "Selected message body changed");
		}
		let verified = 0;
		for (const { query, params } of state.commitments.values()) {
			this.rows(state, query, params);
			if (++verified % REVERT_SELECTION_PAGE_ITEMS === 0) await this.pause(state);
		}
		for (const narratorId of state.narrators.keys()) await this.authorize(state, narratorId, true);
	}
	private async pause(state: ScopeState) {
		// A zero-delay timer avoids Bun's long immediate-poll waits while a body worker
		// is idle between pages. Still yield a real macrotask before rechecking drift.
		await yieldToEventLoop(0);
		this.check(state);
	}
	private add<T>(state: ScopeState, target: T[], row: T) {
		const bytes = Buffer.byteLength(JSON.stringify(row));
		integer(bytes, 0, FILE_CHANGE_LIMITS.metadataBytes, "metadata row");
		state.manifestBytes += bytes;
		integer(state.manifestBytes, 0, REVERT_SELECTION_LIMITS.manifestBytes, "manifest bytes");
		target.push(row);
	}
	private issue(state: ScopeState, issue: RevertSelectionIssue) {
		this.add(state, state.result.issues, issue);
	}
	private reserve(state: ScopeState, messages: number, related = 0, cowBytes = 0) {
		const budget = state.result.history.budget;
		budget.messageRefChanges += messages;
		budget.relatedRows += related;
		budget.cowBytes += cowBytes;
		integer(
			budget.messageRefChanges,
			0,
			FILE_CHANGE_LIMITS.historyMessageRefChanges,
			"message/ref changes",
		);
		integer(
			budget.relatedRows,
			0,
			FILE_CHANGE_LIMITS.historyToolRelatedChanges,
			"tool/related changes",
		);
		integer(budget.cowBytes, 0, FILE_CHANGE_LIMITS.historyCowBytes, "COW bytes");
	}

	private async authorize(state: ScopeState, narratorId: string, recheck = false) {
		const row = this.one<NarratorRow>(state, `${NARRATOR_SELECT} WHERE id = ? LIMIT 1`, [
			narratorId,
		]);
		if (!row) throw fail("NOT_FOUND", "Narrator not found");
		const authorized = await withSignal(
			this.options.authorize({ ...state.principal }, { ...row }, "write", state.signal),
			state.signal,
		);
		if (authorized !== undefined)
			throw fail("AUTHORIZATION_REQUIRED", "The ACL adapter must assert access or throw");
		this.check(state);
		if (row.refsInheritedFrom !== null)
			throw fail(
				"INHERITED_REFS_UNMATERIALIZED",
				"Backfill inherited refs before building a complete selector",
			);
		if (!Number.isSafeInteger(row.messageVersion)) throw fail("STALE", "Unknown message version");
		const old = state.narrators.get(narratorId);
		if (old && JSON.stringify(old) !== JSON.stringify(row))
			throw fail("STALE", "Narrator context changed");
		if (!recheck && !old) {
			state.narrators.set(narratorId, row);
			this.add(state, state.result.messageVersions, {
				narratorId,
				messageVersion: row.messageVersion,
			});
			if (row.status !== "idle" && row.status !== "archived")
				this.issue(state, { code: "NARRATOR_ACTIVE" });
		}
	}

	private ref(state: ScopeState, narratorId: string, messageId: string): RefRow {
		const ref = this.one<RefRow>(
			state,
			`${REF_SELECT} WHERE r.narrator_id = ? AND r.message_id = ? LIMIT 1`,
			[narratorId, messageId],
		);
		if (!ref) throw fail("NOT_FOUND", "Selected message has no actual owning ref");
		return ref;
	}
	private async select(state: ScopeState, narratorId: string, selector: FileChangeRevertSelector) {
		if (selector.kind === "messages") {
			for (const id of selector.messageIds) {
				await this.message(state, this.ref(state, narratorId, id));
				await this.pause(state);
			}
			return;
		}
		if (selector.kind === "tool_calls") {
			const grouped = new Map<string, Set<string>>();
			for (const id of selector.toolCallIds) {
				const tool = this.one<RevertSelectionTool>(state, `${TOOL_SELECT} WHERE id = ? LIMIT 1`, [
					id,
				]);
				if (!tool) throw fail("NOT_FOUND", "Selected tool-call PK is absent");
				this.ref(state, narratorId, tool.messageId);
				const selected = grouped.get(tool.messageId) ?? new Set<string>();
				selected.add(id);
				grouped.set(tool.messageId, selected);
			}
			for (const [messageId, toolIds] of grouped) {
				await this.message(state, this.ref(state, narratorId, messageId), { toolIds });
				await this.pause(state);
			}
			return;
		}
		let startSeq = selector.kind === "from_seq" ? selector.minSeq : -Number.MAX_SAFE_INTEGER;
		let boundaryId: string | null = null;
		if (selector.kind === "after_block") {
			const boundary = this.ref(state, narratorId, selector.messageId);
			startSeq = boundary.seq;
			boundaryId = boundary.id;
			// Same-seq siblings have no durable relative order: never silently pick an ID order.
			const ties = this.one<{ id: string }>(
				state,
				"SELECT id FROM narrator_message_refs INDEXED BY idx_narrator_refs_seq WHERE narrator_id = ? AND seq = ? AND message_id != ? LIMIT 1",
				[narratorId, startSeq, boundaryId],
			);
			if (ties)
				throw fail("ORDER_UNVERIFIED", "The after-block boundary shares its history sequence");
			await this.message(state, boundary, { after: selector.keepThroughBlockIndex });
		}
		let cursor = { seq: startSeq, rowid: 0 };
		for (;;) {
			const page = this.rows<RefRow>(
				state,
				`${REF_SELECT} WHERE r.narrator_id = ? AND (r.seq, r.rowid) >= (?, ?) ORDER BY r.seq, r.rowid LIMIT ?`,
				[narratorId, cursor.seq, cursor.rowid, REVERT_SELECTION_PAGE_ITEMS + 1],
			);
			for (const ref of page.slice(0, REVERT_SELECTION_PAGE_ITEMS))
				if (ref.id !== boundaryId) await this.message(state, ref);
			if (page.length <= REVERT_SELECTION_PAGE_ITEMS) break;
			const last = page[REVERT_SELECTION_PAGE_ITEMS - 1];
			cursor = { seq: last.seq, rowid: last.rowid + 1 };
			await this.pause(state);
		}
	}

	private async body(state: ScopeState, ref: RefRow): Promise<BodySummary> {
		integer(ref.contentBytes, 0, REVERT_SELECTION_LIMITS.messageBytes, "message inspection bytes");
		state.inspectedBytes += ref.contentBytes;
		integer(
			state.inspectedBytes,
			0,
			REVERT_SELECTION_LIMITS.inspectedBodyBytes,
			"total body inspection bytes",
		);
		const summary = await state.worker.inspect(ref.id, this.readBody(state, ref));
		this.check(state);
		const old = state.bodies.get(ref.id);
		if (old && old.digest !== summary.digest) throw fail("STALE", "Selected message body changed");
		state.bodies.set(ref.id, { ref, digest: summary.digest });
		return summary;
	}
	private readBody(state: ScopeState, ref: RefRow): string {
		const content = this.one<{ body: string }>(
			state,
			"SELECT content_json AS body FROM narrator_messages WHERE id = ? AND octet_length(content_json) = ? AND octet_length(content_json) <= ? LIMIT 1",
			[ref.id, ref.contentBytes, REVERT_SELECTION_LIMITS.messageBytes],
			false,
		);
		if (!content) throw fail("STALE", "Message changed before bounded inspection");
		return content.body;
	}

	private async message(
		state: ScopeState,
		ref: RefRow,
		partial?: { toolIds?: Set<string>; after?: number },
	) {
		const messageKey = `${ref.narratorId}:${ref.id}`;
		if (state.messages.has(messageKey)) return;
		state.messages.add(messageKey);
		integer(
			state.messages.size,
			0,
			FILE_CHANGE_LIMITS.historyMessageRefChanges,
			"selected messages",
		);
		const body = await this.body(state, ref);
		const tools = await this.loadTools(state, ref.id);
		const selectedIds = partial?.toolIds;
		const providerIds = selectedIds
			? new Set(tools.filter((tool) => selectedIds.has(tool.id)).map((tool) => tool.toolUseId))
			: null;
		if (selectedIds && tools.filter((tool) => selectedIds.has(tool.id)).length !== selectedIds.size)
			throw fail("NOT_FOUND", "Selected tool-call rows disappeared");
		if (
			providerIds &&
			tools.some((tool) => providerIds.has(tool.toolUseId) && !selectedIds?.has(tool.id))
		)
			throw fail(
				"AMBIGUOUS_ATTEMPT",
				"Deleting one tool block must explicitly select all of its actual attempt rows",
			);
		if (partial?.after !== undefined)
			integer(partial.after, -1, body.blocks.length - 1, "after-block boundary");
		const remove = (block: BodyBlock) =>
			partial?.after !== undefined
				? block.index > partial.after
				: providerIds
					? block.toolUseId !== null && providerIds.has(block.toolUseId)
					: true;
		const removed = body.blocks.filter(remove);
		if (selectedIds && removed.length !== providerIds?.size)
			throw fail("BLOCK_BINDING_MISSING", "A selected call has no unique stable tool block");
		if (partial?.after !== undefined)
			state.result.boundary = {
				messageId: ref.id,
				contentDigest: body.digest,
				retainedThroughKey: body.blocks.find((b) => b.index === partial.after)?.key ?? null,
			};
		const removedToolUses = new Set(
			removed.flatMap((block) => (block.toolUseId ? [block.toolUseId] : [])),
		);
		const full = removed.length === body.blocks.length;
		const shared = !!this.one<{ id: string }>(
			state,
			"SELECT id FROM narrator_message_refs INDEXED BY idx_narrator_refs_message WHERE message_id = ? AND narrator_id != ? LIMIT 1",
			[ref.id, ref.narratorId],
		);
		if (!full && !removed.length) return;
		this.reserve(state, full ? (shared ? 1 : 2) : shared ? 2 : 1, 0, full ? 0 : ref.copyBytes);
		this.add(state, state.result.history.messages, {
			id: ref.id,
			refId: ref.refId,
			narratorId: ref.narratorId,
			seq: ref.seq,
			contentDigest: body.digest,
			contentBytes: ref.contentBytes,
			isShared: shared,
			action: full ? (shared ? "unlink" : "delete") : shared ? "copy_on_write" : "rewrite",
			blockCount: body.blocks.length,
			removedBlockCount: removed.length,
			segmentCompactId: ref.segmentCompactId,
			treeHashAfter: ref.treeHashAfter,
			snapshotCommitSha: ref.snapshotCommitSha,
		});
		for (const block of body.blocks) {
			integer(
				state.result.history.blocks.length + 1,
				0,
				REVERT_SELECTION_LIMITS.blockItems,
				"stable blocks",
			);
			this.add(state, state.result.history.blocks, {
				messageId: ref.id,
				key: block.key,
				digest: block.digest,
				type: block.type,
				toolUseId: block.toolUseId,
				action: remove(block) ? "remove" : "retain",
			});
		}
		for (const providerId of removedToolUses)
			if (!tools.some((t) => t.toolUseId === providerId))
				this.issue(state, { code: "TOOL_CALL_MISSING", messageId: ref.id });
		const skipFileCoverage = NON_OPERATION_ROLES.has(ref.role) && !selectedIds;
		for (const tool of tools) {
			const selected = full || removedToolUses.has(tool.toolUseId);
			const action = shared
				? !full && !selected
					? "copy"
					: "retain"
				: selected
					? "delete"
					: "retain";
			this.add(state, state.result.history.toolChanges, { id: tool.id, action });
			this.reserve(state, 0, action === "retain" ? 0 : 1, action === "copy" ? tool.copyBytes : 0);
			if (action === "delete") await this.associations(state, TOOL_ASSOCIATIONS, tool.id);
			if (!selected) continue;
			if (
				!body.blocks.some((block) => block.toolUseId === tool.toolUseId) &&
				!tool.isFileHistoryCheckpoint
			)
				this.issue(state, { code: "UNREPRESENTED_TOOL_CALL", toolCallId: tool.id });
			// Hidden checkpoints carry real file evidence even on display-only messages.
			if (skipFileCoverage && !tool.isFileHistoryCheckpoint) continue;
			await this.tool(state, tool, ref.narratorId);
		}
		if (full && !shared) await this.associations(state, MESSAGE_ASSOCIATIONS, ref.id);
		if (!full && shared) this.reserve(state, 0, 1); // conservative current narrator fork-boundary update
	}

	private async loadTools(state: ScopeState, messageId: string): Promise<RevertSelectionTool[]> {
		const results: RevertSelectionTool[] = [];
		let cursor = 0;
		for (;;) {
			const page = this.rows<RevertSelectionTool & { cursor: number }>(
				state,
				`${TOOL_SELECT.replace("SELECT ", "SELECT rowid AS cursor, ")} INDEXED BY idx_toolcalls_message WHERE message_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`,
				[messageId, cursor, REVERT_SELECTION_PAGE_ITEMS + 1],
			);
			for (const { cursor: _cursor, ...tool } of page.slice(0, REVERT_SELECTION_PAGE_ITEMS)) {
				integer(
					results.length + 1,
					0,
					FILE_CHANGE_LIMITS.historyToolRelatedChanges,
					"message tool rows",
				);
				this.add(state, results, tool);
			}
			if (page.length <= REVERT_SELECTION_PAGE_ITEMS) break;
			cursor = page[REVERT_SELECTION_PAGE_ITEMS - 1].cursor;
			await this.pause(state);
		}
		return results;
	}

	private async tool(state: ScopeState, tool: RevertSelectionTool, owningNarratorId: string) {
		if (state.tools.has(tool.id)) return;
		state.tools.add(tool.id);
		integer(state.tools.size, 0, FILE_CHANGE_LIMITS.historyToolRelatedChanges, "selected tools");
		this.add(state, state.result.tools, tool);
		const allowed = state.selectedSegments.get(owningNarratorId);
		if (allowed && (!tool.executionSegmentId || !allowed.has(tool.executionSegmentId))) {
			this.add(state, state.result.noDiskTools, {
				toolCallId: tool.id,
				reason: "outside_selected_call",
			});
			return;
		}
		const isFileTool = ["Write", "Edit", "StructSed"].includes(tool.toolName);
		const isDelegationTool = ["Agent", "Task"].includes(tool.toolName);
		if (!isFileTool && !isDelegationTool) {
			this.add(state, state.result.noDiskTools, {
				toolCallId: tool.id,
				reason: READ_ONLY_TOOLS.has(tool.toolName) ? "read_only" : "non_file_change",
			});
			return;
		}
		if (isFileTool && (!["success", "fail"].includes(tool.status) || Boolean(tool.isBackground))) {
			this.add(state, state.result.noDiskTools, { toolCallId: tool.id, reason: "pending" });
			return;
		}
		if (!["success", "fail"].includes(tool.status))
			this.issue(state, { code: "TOOL_ACTIVE_OR_UNKNOWN", toolCallId: tool.id });
		const origin = tool.executionOriginToolCallId ?? tool.id;
		const task = this.one<{
			id: string;
			status: string;
			type: string;
			parentNarratorId: string;
			subagentNarratorId: string | null;
		}>(
			state,
			"SELECT id, status, type, parent_narrator_id AS parentNarratorId, subagent_narrator_id AS subagentNarratorId FROM background_tasks INDEXED BY idx_bg_tasks_tool_attempt WHERE tool_call_id = ? AND execution_attempt = ? LIMIT 1",
			[origin, tool.executionAttempt],
		);
		if (task && task.parentNarratorId !== tool.narratorId)
			this.issue(state, { code: "BACKGROUND_BINDING_MISMATCH", toolCallId: tool.id });
		if ((task && ["running", "paused"].includes(task.status)) || (tool.isBackground && !task))
			this.issue(state, { code: "BACKGROUND_UNRESOLVED", toolCallId: tool.id });
		let delegated = false;
		if (isDelegationTool) delegated = await this.children(state, tool, owningNarratorId);
		else await this.rejectUnboundChildren(state, tool, new Set([owningNarratorId]));
		if (delegated) {
			this.add(state, state.result.noDiskTools, { toolCallId: tool.id, reason: "delegated" });
			return;
		}
		if (!isFileTool) {
			this.add(state, state.result.noDiskTools, { toolCallId: tool.id, reason: "non_file_change" });
			return;
		}
		if (tool.fileChangeOperationId) {
			await this.operation(state, tool);
			return;
		}
		if (
			isFileTool &&
			tool.executionIdentityVersion === 1 &&
			tool.executionPathFlavor === "spec" &&
			tool.resolvedFilePath?.startsWith("spec://") &&
			(!tool.canonicalFilePath || tool.canonicalFilePath.startsWith("spec://"))
		) {
			this.add(state, state.result.noDiskTools, { toolCallId: tool.id, reason: "spec" });
			return;
		}
		this.issue(state, { code: "FILE_JOURNAL_MISSING", toolCallId: tool.id });
	}

	private async children(
		state: ScopeState,
		tool: RevertSelectionTool,
		ownerNarratorId: string,
	): Promise<boolean> {
		const origin = tool.executionOriginToolCallId ?? tool.id;
		const candidates = await this.loadChildCandidates(state, tool.narratorId);
		const childIds = new Set(candidates.get(origin) ?? []);
		if (childIds.size && (tool.executionIdentityVersion !== 1 || tool.executionAttempt !== 1))
			throw fail("CHILD_ATTEMPT_UNVERIFIED", "Child origin does not record a retry-attempt range");
		// Null is the legacy path. A non-null but missing segment is NOT permission
		// to fall back to narrator-wide file effects or a reused provider ID.
		const descendants =
			childIds.size && tool.executionSegmentId ? await this.descendantSegments(state, tool) : null;
		for (const childId of childIds) {
			if (!state.childRoots.has(childId)) {
				state.childRoots.add(childId);
				integer(
					state.childRoots.size,
					0,
					REVERT_SELECTION_LIMITS.childNarrators,
					"child narrators",
				);
				await this.authorize(state, childId);
				if (descendants) state.selectedSegments.set(childId, descendants.get(childId) ?? new Set());
				await this.select(state, childId, { kind: "all" });
			}
		}
		await this.rejectUnboundChildren(state, tool, childIds);
		void ownerNarratorId;
		return childIds.size > 0;
	}
	private async descendantSegments(
		state: ScopeState,
		tool: RevertSelectionTool,
	): Promise<Map<string, Set<string>>> {
		const result = new Map<string, Set<string>>();
		const root = tool.executionSegmentId;
		if (!root) return result;
		const rows = this.rows<{ id: string; narratorId: string }>(
			state,
			`WITH RECURSIVE descendants(id, narrator_id) AS (
				SELECT id, narrator_id FROM file_change_execution_segments WHERE parent_segment_id = ?
				UNION
				SELECT s.id, s.narrator_id FROM file_change_execution_segments s JOIN descendants d ON s.parent_segment_id = d.id
			)
			SELECT id, narrator_id AS narratorId FROM descendants LIMIT ?`,
			[root, FILE_CHANGE_LIMITS.historyToolRelatedChanges + 1],
		);
		if (rows.length > FILE_CHANGE_LIMITS.historyToolRelatedChanges)
			throw fail("BUDGET_EXCEEDED", "Execution segment descendants exceed the bounded inventory");
		for (const row of rows) {
			state.segmentRows++;
			integer(
				state.segmentRows,
				0,
				FILE_CHANGE_LIMITS.historyToolRelatedChanges,
				"execution segments",
			);
			const ids = result.get(row.narratorId) ?? new Set<string>();
			ids.add(row.id);
			result.set(row.narratorId, ids);
		}
		return result;
	}

	private async loadChildCandidates(
		state: ScopeState,
		parentNarratorId: string,
	): Promise<ReadonlyMap<string, readonly string[]>> {
		this.check(state);
		const cached = state.childCandidates.get(parentNarratorId);
		if (cached) return cached;
		const grouped = new Map<string, string[]>();
		let cursor = 0;
		for (;;) {
			const children = this.rows<{ id: string; origin: string | null; cursor: number }>(
				state,
				"SELECT id, origin_tool_call_id AS origin, rowid AS cursor FROM narrators INDEXED BY idx_narrators_parent WHERE parent_narrator_id = ? AND type = 'subagent' AND rowid > ? ORDER BY rowid LIMIT ?",
				[parentNarratorId, cursor, REVERT_SELECTION_PAGE_ITEMS + 1],
			);
			for (const child of children.slice(0, REVERT_SELECTION_PAGE_ITEMS)) {
				integer(
					++state.childCandidateCount,
					0,
					REVERT_SELECTION_LIMITS.childNarrators,
					"child candidates",
				);
				if (!child.origin)
					throw fail(
						"CHILD_ORIGIN_UNVERIFIED",
						"A legacy child lacks an actual originating tool-call PK",
					);
				integer(
					Buffer.byteLength(child.id) + Buffer.byteLength(child.origin),
					0,
					FILE_CHANGE_LIMITS.metadataBytes,
					"child identity metadata",
				);
				const siblings = grouped.get(child.origin) ?? [];
				siblings.push(child.id);
				grouped.set(child.origin, siblings);
			}
			if (children.length <= REVERT_SELECTION_PAGE_ITEMS) break;
			cursor = children[REVERT_SELECTION_PAGE_ITEMS - 1].cursor;
			await this.pause(state);
		}
		this.check(state);
		// Publish only a fully enumerated snapshot. A cancelled/over-budget prefix
		// can never masquerade as an empty or complete child origin map.
		state.childCandidates.set(parentNarratorId, grouped);
		return grouped;
	}

	private async rejectUnboundChildren(
		state: ScopeState,
		tool: RevertSelectionTool,
		allowed: Set<string>,
	) {
		// This legacy edge is only used as an ambiguity detector, NEVER as authority.
		const rows = this.rows<{ id: string; narratorId: string }>(
			state,
			"SELECT id, narrator_id AS narratorId FROM narrator_messages INDEXED BY idx_messages_parent_tool_use_lookup WHERE parent_tool_use_id = ? LIMIT ?",
			[tool.toolUseId, FILE_CHANGE_LIMITS.historyMessageRefChanges + 1],
		);
		integer(rows.length, 0, FILE_CHANGE_LIMITS.historyMessageRefChanges, "derived messages");
		if (rows.some((row) => !allowed.has(row.narratorId)))
			throw fail(
				"CHILD_ORIGIN_UNVERIFIED",
				"Provider IDs cannot authorize or uniquely bind derived history",
			);
		if (rows.some((row) => !state.messages.has(`${row.narratorId}:${row.id}`)))
			throw fail(
				"DERIVED_HISTORY_UNSELECTED",
				"Derived messages need a complete stable child selection",
			);
	}

	private async operation(state: ScopeState, tool: RevertSelectionTool) {
		const operation = this.one<RevertSelectionOperation>(
			state,
			`${OPERATION_SELECT} WHERE id = ? LIMIT 1`,
			[tool.fileChangeOperationId],
		);
		if (!operation) {
			this.issue(state, { code: "FILE_JOURNAL_MISSING", toolCallId: tool.id });
			return;
		}
		const origin = tool.executionOriginToolCallId ?? tool.id;
		const binding: FileChangeExecutionBinding | null = operation.executionBindingJson
			? JSON.parse(operation.executionBindingJson)
			: null;
		if (
			!binding ||
			binding.deviceId !== tool.executionDeviceId ||
			binding.runtimeGeneration !== tool.runtimeGeneration ||
			tool.executionIdentityVersion !== 1 ||
			operation.evidenceVersion !== 2 ||
			operation.sourceKind !== "tool" ||
			operation.sourceId !== origin ||
			operation.toolCallId !== origin ||
			operation.attempt !== tool.executionAttempt ||
			!operation.requestDigest ||
			operation.narratorId !== tool.narratorId
		)
			this.issue(state, {
				code: "ATTEMPT_BINDING_MISMATCH",
				toolCallId: tool.id,
				operationId: operation.id,
			});
		if (state.operations.has(operation.id)) return;
		state.operations.add(operation.id);
		integer(
			state.operations.size,
			0,
			FILE_CHANGE_LIMITS.historyToolRelatedChanges,
			"selected operations",
		);
		this.add(state, state.result.operations, operation);
		integer(
			operation.evidenceBytes,
			0,
			FILE_CHANGE_LIMITS.operationEvidenceBytes,
			"operation evidence bytes",
		);
		// Declarations remain bounded per operation; shared historical aliases are
		// accounted once by their immutable blob reference below.
		let cursor: { fileKey: string; phase: string } | null = null;
		let effectCount = 0;
		for (;;) {
			const rows: EffectRow[] = this.rows<EffectRow>(
				state,
				`${EFFECT_SELECT} WHERE operation_id = ? ${cursor ? "AND (file_key, phase) > (?, ?)" : ""} ORDER BY file_key, phase LIMIT ?`,
				[
					operation.id,
					...(cursor ? [cursor.fileKey, cursor.phase] : []),
					REVERT_SELECTION_PAGE_ITEMS + 1,
				],
			);
			for (const row of rows.slice(0, REVERT_SELECTION_PAGE_ITEMS)) {
				effectCount++;
				integer(effectCount, 0, FILE_CHANGE_LIMITS.revertFiles, "operation effects");
				integer(
					state.result.effects.length + 1,
					0,
					FILE_CHANGE_LIMITS.historyToolRelatedChanges,
					"selected effects",
				);
				const effect = decodeEffect(row, operation.attempt);
				integer(effect.scopeRevision, 0, Number.MAX_SAFE_INTEGER, "scope revision");
				const actualScope = this.one<{
					id: string;
					sourceInstanceId: string;
					deviceId: string;
					workspaceInstanceId: string;
					pathFlavor: "posix" | "windows";
					canonicalRoot: string;
					status: string;
				}>(
					state,
					"SELECT id,source_instance_id AS sourceInstanceId,device_id AS deviceId,workspace_instance_id AS workspaceInstanceId,path_flavor AS pathFlavor,canonical_root AS canonicalRoot,status FROM file_change_scopes WHERE id=? LIMIT 1",
					[row.scopeId],
				);
				if (
					!actualScope ||
					actualScope.status !== "active" ||
					JSON.stringify(
						Object.entries(createFileChangeIdentity(actualScope, effect.identity)).sort(),
					) !== JSON.stringify(Object.entries(effect.identity).sort())
				)
					this.issue(state, { code: "EFFECT_SCOPE_UNVERIFIED", operationId: operation.id });
				for (const fileState of [
					effect.before,
					effect.intendedAfter,
					effect.observedAfter,
					...(effect.executionReceipt ? [effect.executionReceipt.observedAfter] : []),
				]) {
					const ref =
						fileState.kind === "regular"
							? fileState.blob
							: fileState.kind === "symlink"
								? fileState.target
								: null;
					if (ref) {
						integer(ref.sizeBytes, 0, FILE_CHANGE_LIMITS.blobBytes, "raw ref bytes");
						const namespaceDigest = JSON.stringify([operation.sourceInstanceId, ref.digest]);
						const prior = state.evidenceRefs.get(namespaceDigest);
						if (prior && (prior.algorithm !== ref.algorithm || prior.sizeBytes !== ref.sizeBytes))
							throw new RevertSelectionError("INVALID_INPUT", "Conflicting blob metadata");
						if (!prior) {
							state.evidenceRefs.set(namespaceDigest, {
								algorithm: ref.algorithm,
								sizeBytes: ref.sizeBytes,
							});
							state.evidenceBytes += ref.sizeBytes;
						}
					}
				}
				integer(
					state.evidenceBytes,
					0,
					FILE_CHANGE_LIMITS.operationEvidenceBytes,
					"complete selected evidence bytes",
				);
				if (
					fileChangeIdentityKey(effect.identity) !== row.fileKey ||
					effect.identity.scopeId !== row.scopeId ||
					effect.identity.sourceInstanceId !== operation.sourceInstanceId ||
					effect.identity.deviceId !== tool.executionDeviceId ||
					effect.identity.pathFlavor !== tool.executionPathFlavor
				)
					this.issue(state, { code: "EFFECT_IDENTITY_MISMATCH", operationId: operation.id });
				if (
					stateRef(effect.before) !== row.beforeBlobDigest ||
					stateRef(effect.intendedAfter) !== row.intendedAfterBlobDigest ||
					stateRef(effect.observedAfter) !== row.observedAfterBlobDigest
				)
					this.issue(state, { code: "EFFECT_PIN_MISSING", operationId: operation.id });
				if (
					effect.phase !== "apply" ||
					!binding ||
					!effect.executionReceipt ||
					!fileChangeExecutionBindingMatches(binding, effect.executionReceipt.executionBinding) ||
					(!hasConfirmedNoFileChange(effect) && !hasSettledMeasuredFileEffect(effect))
				)
					this.issue(state, { code: "EFFECT_UNRESOLVED", operationId: operation.id });
				state.files.add(row.fileKey);
				integer(state.files.size, 0, FILE_CHANGE_LIMITS.revertFiles, "selected file identities");
				this.add(state, state.result.effects, effect);
			}
			if (rows.length <= REVERT_SELECTION_PAGE_ITEMS) break;
			const last = rows[REVERT_SELECTION_PAGE_ITEMS - 1];
			cursor = { fileKey: last.fileKey, phase: last.phase };
			await this.pause(state);
		}
		if (effectCount === 0 && isNoDispatch(operation)) {
			this.add(state, state.result.noDiskTools, { toolCallId: tool.id, reason: "no_dispatch" });
			return;
		}
		if (
			effectCount === 0 ||
			operation.expectedEffectCount !== effectCount ||
			operation.preparedEffectCount !== effectCount ||
			operation.settledEffectCount !== effectCount ||
			operation.unresolvedEffectCount !== 0 ||
			operation.settlement !== "settled" ||
			operation.coverage !== "complete" ||
			!["succeeded", "failed", "interrupted"].includes(operation.executionOutcome) ||
			!operation.finishedAt
		)
			this.issue(state, { code: "OPERATION_UNRESOLVED", operationId: operation.id });
		integer(
			operation.evidenceBytes,
			0,
			FILE_CHANGE_LIMITS.operationEvidenceBytes,
			"operation evidence bytes",
		);
	}

	private async associations(
		state: ScopeState,
		specs: readonly AssociationSpec[],
		targetId: string,
	) {
		for (const [table, column, index, idColumn = "id"] of specs) {
			let cursor = 0;
			for (;;) {
				const rows = this.rows<{ id: string; cursor: number }>(
					state,
					`SELECT ${idColumn} AS id, rowid AS cursor FROM ${table} INDEXED BY ${index} WHERE ${column} = ? AND rowid > ? ORDER BY rowid LIMIT ?`,
					[targetId, cursor, REVERT_SELECTION_PAGE_ITEMS + 1],
				);
				for (const row of rows.slice(0, REVERT_SELECTION_PAGE_ITEMS)) {
					if (table === "narrators" && !state.narrators.has(row.id))
						await this.authorize(state, row.id);
					const key = `${table}:${row.id}`;
					if (!state.associationRows.has(key)) {
						state.associationRows.add(key);
						this.reserve(
							state,
							table === "narrator_message_refs" ? 1 : 0,
							table === "narrator_message_refs" ? 0 : 1,
						);
					}
					this.add(state, state.result.history.associations, {
						table,
						id: row.id,
						column,
						targetId,
					});
				}
				if (rows.length <= REVERT_SELECTION_PAGE_ITEMS) break;
				cursor = rows[REVERT_SELECTION_PAGE_ITEMS - 1].cursor;
				await this.pause(state);
			}
		}
	}
}

function sourceRowsDigest(rows: unknown[]): string {
	const hash = createHash("sha256");
	for (const row of rows) hash.update(JSON.stringify(row)).update("\n");
	return hash.digest("hex");
}

const NARRATOR_SELECT = `SELECT id, owner_user_id AS ownerUserId, visibility, write_audience AS writeAudience, type,
 acl_root_narrator_id AS aclRootNarratorId, chapter_id AS chapterId, context_project_id AS contextProjectId,
 message_version AS messageVersion, refs_inherited_from AS refsInheritedFrom, status,
 parent_narrator_id AS parentNarratorId, origin_tool_call_id AS originToolCallId FROM narrators`;
const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "StructView", "WebSearch", "WebFetch"]);
const REF_SELECT = `SELECT r.rowid, r.id AS refId, r.message_id AS id, r.narrator_id AS narratorId, r.seq,
 coalesce(m.role,'assistant') AS role, r.segment_compact_id AS segmentCompactId, octet_length(m.content_json) AS contentBytes,
 octet_length(m.content_json) + coalesce(octet_length(m.content_text),0) + coalesce(octet_length(m.original_content_json),0) AS copyBytes,
 m.tree_hash_after AS treeHashAfter, m.snapshot_commit_sha AS snapshotCommitSha
 FROM narrator_message_refs r LEFT JOIN narrator_messages m ON m.id = r.message_id`;
const TOOL_SELECT = `SELECT id, narrator_id AS narratorId, message_id AS messageId, tool_use_id AS toolUseId, tool_name AS toolName, status,
 is_background AS isBackground, execution_identity_version AS executionIdentityVersion, execution_origin_tool_call_id AS executionOriginToolCallId,
 execution_attempt AS executionAttempt, file_change_operation_id AS fileChangeOperationId, execution_device_id AS executionDeviceId,
 execution_path_flavor AS executionPathFlavor, resolved_file_path AS resolvedFilePath, canonical_file_path AS canonicalFilePath,
 runtime_generation AS runtimeGeneration, is_file_history_checkpoint AS isFileHistoryCheckpoint, execution_segment_id AS executionSegmentId,
 coalesce(octet_length(input_json),0) + coalesce(octet_length(output_json),0) + coalesce(octet_length(execution_targets_json),0) AS copyBytes
 FROM narrator_tool_calls`;
const OPERATION_SELECT = `SELECT id, execution_segment_id AS executionSegmentId, evidence_version AS evidenceVersion, source_instance_id AS sourceInstanceId, source_kind AS sourceKind, source_id AS sourceId,
 attempt, tool_call_id AS toolCallId, narrator_id AS narratorId, project_id AS projectId, request_digest AS requestDigest,
 CASE WHEN octet_length(execution_binding_json) <= ${FILE_CHANGE_LIMITS.metadataBytes} THEN execution_binding_json END AS executionBindingJson,
 expected_effect_count AS expectedEffectCount, prepared_effect_count AS preparedEffectCount, settled_effect_count AS settledEffectCount,
 unresolved_effect_count AS unresolvedEffectCount, evidence_bytes AS evidenceBytes, execution_outcome AS executionOutcome,
 effect_outcome AS effectOutcome, settlement, coverage, attribution_grade AS attributionGrade, reason, finished_at AS finishedAt, updated_at AS updatedAt FROM file_change_operations`;
const EFFECT_SELECT = `SELECT id, operation_id AS operationId, scope_id AS scopeId, file_key AS fileKey, scope_revision AS scopeRevision, mutation_id AS mutationId,
 request_digest AS requestDigest, phase, outcome, settlement, attribution_grade AS attribution, execution_confirmed AS executionConfirmed,
 lines_added AS linesAdded, lines_removed AS linesRemoved, before_blob_digest AS beforeBlobDigest, intended_after_blob_digest AS intendedAfterBlobDigest,
 observed_after_blob_digest AS observedAfterBlobDigest,
 CASE WHEN octet_length(identity_json) <= ${FILE_CHANGE_LIMITS.metadataBytes} THEN identity_json END AS identity,
 CASE WHEN octet_length(before_state_json) <= ${FILE_CHANGE_LIMITS.metadataBytes} THEN before_state_json END AS beforeState,
 CASE WHEN octet_length(intended_after_state_json) <= ${FILE_CHANGE_LIMITS.metadataBytes} THEN intended_after_state_json END AS intendedAfter,
 CASE WHEN octet_length(observed_after_state_json) <= ${FILE_CHANGE_LIMITS.metadataBytes} THEN observed_after_state_json END AS observedAfter,
 CASE WHEN octet_length(execution_receipt_json) <= ${FILE_CHANGE_LIMITS.metadataBytes} THEN execution_receipt_json END AS receipt
 FROM file_change_effects INDEXED BY idx_fc_effect_operation_file`;
interface EffectRow {
	id: string;
	operationId: string;
	scopeId: string;
	fileKey: string;
	scopeRevision: number;
	mutationId: string;
	requestDigest: string;
	phase: FileChangeReversalEffect["phase"];
	outcome: FileChangeReversalEffect["outcome"];
	settlement: FileChangeReversalEffect["settlement"];
	attribution: FileChangeReversalEffect["attribution"];
	executionConfirmed: number;
	linesAdded: number | null;
	linesRemoved: number | null;
	beforeBlobDigest: string | null;
	intendedAfterBlobDigest: string | null;
	observedAfterBlobDigest: string | null;
	identity: string | null;
	beforeState: string | null;
	intendedAfter: string | null;
	observedAfter: string | null;
	receipt: string | null;
}
function decodeEffect(row: EffectRow, attempt: number): FileChangeReversalEffect {
	if (!row.identity || !row.beforeState || !row.intendedAfter || !row.observedAfter)
		throw fail("METADATA_INVALID", "Missing or oversized effect metadata");
	return {
		id: row.id,
		operationId: row.operationId,
		attempt,
		mutationId: row.mutationId,
		requestDigest: row.requestDigest,
		phase: row.phase,
		identity: JSON.parse(row.identity),
		before: JSON.parse(row.beforeState),
		intendedAfter: JSON.parse(row.intendedAfter),
		observedAfter: JSON.parse(row.observedAfter),
		outcome: row.outcome,
		settlement: row.settlement,
		attribution: row.attribution,
		executionConfirmed: row.executionConfirmed === 1,
		executionReceipt: row.receipt ? JSON.parse(row.receipt) : null,
		linesAdded: row.linesAdded,
		linesRemoved: row.linesRemoved,
		scopeRevision: row.scopeRevision,
	};
}
function isNoDispatch(op: RevertSelectionOperation) {
	return (
		op.expectedEffectCount === 0 &&
		op.preparedEffectCount === 0 &&
		op.settledEffectCount === 0 &&
		op.unresolvedEffectCount === 0 &&
		op.evidenceBytes === 0 &&
		op.settlement === "settled" &&
		op.coverage === "complete" &&
		op.effectOutcome === "no_change" &&
		op.finishedAt !== null &&
		(((op.reason === "no_dispatch:validation_rejected" ||
			op.reason === "no_dispatch:invocation_rejected") &&
			op.executionOutcome === "failed") ||
			(op.reason === "no_dispatch:preview" && op.executionOutcome === "succeeded") ||
			(op.reason === "no_dispatch:cancelled_before_dispatch" &&
				op.executionOutcome === "interrupted"))
	);
}
function stateRef(state: FileChangeState) {
	return state.kind === "regular"
		? state.blob.digest
		: state.kind === "symlink"
			? state.target.digest
			: null;
}
type AssociationSpec = readonly [table: string, column: string, index: string, idColumn?: string];
const MESSAGE_ASSOCIATIONS: readonly AssociationSpec[] = [
	["narrators", "fork_message_id", "idx_narrators_fork_message"],
	["chapter_commits", "narrator_message_id", "idx_chapter_commits_narrator_message"],
	["spec_file_revisions", "source_message_id", "idx_spec_file_revisions_source_message"],
	["narrator_patches", "message_id", "idx_patches_message"],
	["api_requests", "message_id", "idx_api_requests_message"],
	["knowledge_injection_events", "trigger_message_id", "idx_kie_trigger_message"],
	["narrator_message_refs", "segment_compact_id", "idx_narrator_refs_segment_compact"],
	[
		"narrator_question_events",
		"message_id",
		"sqlite_autoindex_narrator_question_events_1",
		"message_id",
	],
];
const TOOL_ASSOCIATIONS: readonly AssociationSpec[] = [
	["permission_rule_requests", "tool_call_id", "uq_permission_rule_request_attempt"],
	["narrator_questions", "tool_call_id", "idx_narrator_questions_tool_call"],
	["narrator_tool_continuations", "tool_call_id", "idx_tool_continuations_tool_call"],
	["knowledge_injection_events", "trigger_tool_call_id", "idx_kie_trigger_tool_call"],
];
function normalizeRequest(input: RevertSelectionRequest) {
	text(input.narratorId);
	text(input.principal.userId);
	if (typeof input.principal.isAdmin !== "boolean")
		throw fail("INVALID_INPUT", "An authenticated principal is required");
	integer(input.expectedMessageVersion, 0, Number.MAX_SAFE_INTEGER, "message version");
	const selector = input.selector;
	let fixed: FileChangeRevertSelector;
	if (selector.kind === "all") fixed = { kind: "all" };
	else if (selector.kind === "from_seq") {
		integer(selector.minSeq, 0, Number.MAX_SAFE_INTEGER, "sequence");
		fixed = { kind: "from_seq", minSeq: selector.minSeq };
	} else if (selector.kind === "messages")
		fixed = {
			kind: "messages",
			messageIds: ids(selector.messageIds, FILE_CHANGE_LIMITS.historyMessageRefChanges),
		};
	else if (selector.kind === "tool_calls")
		fixed = {
			kind: "tool_calls",
			toolCallIds: ids(selector.toolCallIds, FILE_CHANGE_LIMITS.historyToolRelatedChanges),
		};
	else if (selector.kind === "after_block") {
		text(selector.messageId);
		integer(
			selector.keepThroughBlockIndex,
			-1,
			REVERT_SELECTION_LIMITS.blockItems - 1,
			"block index",
		);
		fixed = {
			kind: "after_block",
			messageId: selector.messageId,
			keepThroughBlockIndex: selector.keepThroughBlockIndex,
		};
	} else throw fail("INVALID_INPUT", "Unknown selector");
	return {
		narratorId: input.narratorId,
		principal: { ...input.principal },
		expectedMessageVersion: input.expectedMessageVersion,
		selector: fixed,
	};
}
function ids(values: string[], max: number) {
	integer(values.length, 1, max, "selector targets");
	for (const value of values) text(value);
	return [...new Set(values)].sort();
}
function text(value: string) {
	if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value) > 256)
		throw fail("INVALID_INPUT", "Invalid stable identifier");
}
function integer(value: number, min: number, max: number, name: string) {
	if (!Number.isSafeInteger(value) || value < min || value > max)
		throw fail("BUDGET_EXCEEDED", `Invalid or over-budget ${name}`);
}
function* manifestRows(result: RevertSelectionResult) {
	yield {
		version: result.version,
		narratorId: result.narratorId,
		requestedByUserId: result.requestedByUserId,
		selector:
			result.selector.kind === "messages" || result.selector.kind === "tool_calls"
				? { kind: result.selector.kind }
				: result.selector,
		boundary: result.boundary,
		budget: result.history.budget,
	};
	if (result.selector.kind === "messages")
		for (const id of result.selector.messageIds) yield { selectedMessageId: id };
	if (result.selector.kind === "tool_calls")
		for (const id of result.selector.toolCallIds) yield { selectedToolCallId: id };
	for (const values of [
		result.messageVersions,
		result.history.messages,
		result.history.blocks,
		result.history.toolChanges,
		result.history.associations,
		result.tools,
		result.operations,
		result.effects,
		result.noDiskTools,
		result.issues,
	])
		for (const row of values) yield row;
}
export class RevertSelectionError extends AppError {
	constructor(code: string, message: string) {
		super(message, 409, `REVERT_SELECTION_${code}`);
		this.name = "RevertSelectionError";
	}
}
function fail(code: string, message: string) {
	return new RevertSelectionError(code, message);
}

function withSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		void pending.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

/** One worker per bounded collection; no code/input from a model is executed. */
class BodyWorker {
	private worker: Worker | null = null;
	private termination: Promise<number> | undefined;
	private pending: {
		resolve: (summary: BodySummary) => void;
		reject: (error: Error) => void;
	} | null = null;
	constructor(private readonly signal: AbortSignal) {}
	async inspect(id: string, body: string, digestOnly = false): Promise<BodySummary> {
		this.signal.throwIfAborted();
		if (!this.worker) {
			this.worker = new Worker(BODY_WORKER, { eval: true });
			this.worker.on("message", (result: BodySummary & { error?: string }) => {
				const pending = this.pending;
				this.pending = null;
				if (result.error) pending?.reject(fail("BODY_UNVERIFIED", result.error));
				else pending?.resolve(result);
			});
			this.worker.on("error", (error) => {
				this.pending?.reject(error instanceof Error ? error : new Error("Body worker failed"));
				this.pending = null;
			});
			this.signal.addEventListener("abort", this.abort, { once: true });
		}
		return new Promise((resolve, reject) => {
			this.pending = { resolve, reject };
			this.worker?.postMessage({
				id,
				body,
				digestOnly,
				maxBlocks: REVERT_SELECTION_LIMITS.blockItems,
				maxOutput: FILE_CHANGE_LIMITS.summaryBytes,
			});
		});
	}
	private abort = () => {
		this.pending?.reject(this.signal.reason);
		this.pending = null;
		this.termination ??= this.worker?.terminate();
	};
	async close() {
		this.signal.removeEventListener("abort", this.abort);
		this.termination ??= this.worker?.terminate();
		await this.termination;
		this.worker = null;
	}
}
const BODY_WORKER = `
const { parentPort } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
parentPort.on('message', ({id, body, digestOnly, maxBlocks, maxOutput}) => {
 try {
  if (digestOnly) { parentPort.postMessage({digest: hash(body), blocks: []}); return; }
  const parsed = JSON.parse(body);
  if (!Array.isArray(parsed) || parsed.length > maxBlocks) throw Error('Message block coverage is unavailable or over budget');
  const digest = hash(body); const seen = new Set(); const blocks = [];
  for (let index = 0; index < parsed.length; index++) {
   const block = parsed[index];
   if (!block || typeof block.type !== 'string' || block.type.length > 100) throw Error('Invalid message block');
   if (block.type === 'compact' && (block.status === 'compacting' || block.status === 'running' || block.attempts?.at(-1)?.status === 'running')) throw Error('A live compact cannot be selected');
   const toolUseId = block.type === 'tool_use' ? block.id : null;
   if (block.type === 'tool_use' && (typeof toolUseId !== 'string' || !toolUseId || toolUseId.length > 256 || seen.has(toolUseId))) throw Error('Tool block identity is missing or repeated');
   if (toolUseId) seen.add(toolUseId);
   const blockDigest = hash(JSON.stringify(block));
   blocks.push({ index, key: hash(JSON.stringify([id, digest, index, blockDigest])), digest: blockDigest, type: block.type, toolUseId });
  }
  const result = {digest, blocks};
  if (Buffer.byteLength(JSON.stringify(result)) > maxOutput) throw Error('Block metadata exceeds the worker output budget');
  parentPort.postMessage(result);
 } catch (error) { parentPort.postMessage({error: error.message}); }
});
`;
