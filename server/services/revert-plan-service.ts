import {
	assertFileValues,
	assertParent,
	assertPinnedRefsStillReady,
	assertPlanned,
	assertSameRevision,
	assertScope,
	boundedPage,
	digest,
	equal,
	evidenceBudget,
	fail,
	fileCursor,
	fileValues,
	fingerprintNormalizedFiles,
	HEADER_KEYS,
	headerFromRow,
	integer,
	keys,
	metadata,
	normalizeFile,
	normalizeHeader,
	normalizeOwner,
	normalizeProof,
	normalizeRef,
	normalizeState,
	nullableId,
	orderedDigest,
	pageLimit,
	planHash,
	refBytes,
	requireOwner,
	requireReadyRef,
	selectFiles,
	sha256,
	stateBytes,
	stateRef,
	text,
} from "./revert-plan-read";

export {
	fingerprintRevertPlanFiles,
	RevertPlanError,
	revertPlanHeaderDigest,
} from "./revert-plan-read";

import type { Database } from "bun:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
	FILE_CHANGE_EVIDENCE_VERSION,
	FILE_CHANGE_LIMITS,
	type FileChangeBlobRef,
	type FileChangeIdentity,
	type FileChangeState,
} from "@shared/file-change-protocol";
import { and, asc, eq, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { revertOperationFiles, revertOperations } from "../db/schema";
import { readQuery, readTransactionTask } from "../db/worker-read";
import { generateId } from "../lib/id";
import {
	assertRevertPlanNamespace,
	assertRevertPlanProof,
	type RevertPlanAppendRead,
	type RevertPlanReadPage,
	type RevertPlanReadTask,
	readRevertPlanRefs,
	readRevertPlanTask,
} from "./revert-plan-read-task";

export const REVERT_PLAN_BATCH_ITEMS = 32;
type Executor = Pick<BunSQLiteDatabase, "select" | "insert" | "update">;
type PlanDatabase = Executor & {
	readonly $client: Database;
	transaction<T>(work: (tx: Executor) => T): T;
};
type PlanRecord = typeof revertOperations.$inferSelect;
type FileRecord = typeof revertOperationFiles.$inferSelect;

/** The trusted caller authorizes this exact context before EVERY call; this is not an ACL. */
export interface RevertPlanOwner {
	subjectKey: string;
	narratorId: string | null;
	projectId: string | null;
}

export interface RevertPlanHeader extends RevertPlanOwner {
	idempotencyKey: string;
	/** Digest of the complete original request, never a sampled selector/toolUseId. */
	requestDigest: string;
	kind: PlanRecord["kind"];
	revertScope: PlanRecord["scope"];
	selectorKind: PlanRecord["selectorKind"];
	selector: FileChangeBlobRef;
	historyManifest: FileChangeBlobRef;
	expectedMessageVersion: number;
	expectedFileCount: number;
	parentRevertId?: string | null;
}

/**
 * A receipt supplied ONLY by the trusted, fully computing planner/published-blob IO.
 * It attests that the published plan contains the canonical header (without its own
 * self-reference), the COMPLETE ordered file list and selector/history coverage.
 * This module validates catalog readiness/size and the commitment, NOT object bytes
 * or selector enumeration. A digest, these booleans, and row counts are not an ACL
 * or independent proof of source coverage. Never construct this from a truncated page.
 */
export interface RevertPlanManifestProof {
	source: "trusted_published_planner_v1";
	headerDigest: string;
	orderedFilesDigest: string;
	/** Sum of every expected + desired raw ref, conservatively counting repeats. */
	fileEvidenceBytes: number;
	computation: "complete" | "partial";
	selectorCoverage: "complete" | "partial";
	historyCoverage: "complete" | "partial";
	omittedFiles: number;
	unknownFiles: number;
}

export interface BeginRevertPlan extends RevertPlanHeader {
	plan: FileChangeBlobRef;
	manifestProof: RevertPlanManifestProof;
}

export interface AppendRevertPlanFile {
	/** Unique, contiguous, zero-based order in the fixed manifest. */
	sequence: number;
	identity: FileChangeIdentity;
	expected: FileChangeState;
	desired: FileChangeState;
}

export interface RevertPlanOptions {
	/** The same physical namespace used by verified published-blob IO. */
	namespaceKey: string;
	now?: () => string;
	/** May shorten, never extend the shared ten-minute preparation lifetime. */
	ttlMs?: number;
}

export interface RevertPlanFileCursor {
	/** Unique within a plan; sequence/timestamp ties cannot lose rows. */
	fileKey: string;
}
export interface RevertPlanSummaryCursor {
	/** Unique within the owner; seeks the existing actor/idempotency index. */
	idempotencyKey: string;
}
export interface RevertPlanPage<T, C> {
	items: T[];
	hasMore: boolean;
	nextCursor: C | null;
}
export interface RevertPlanSummary {
	id: string;
	kind: PlanRecord["kind"];
	revertScope: PlanRecord["scope"];
	selectorKind: PlanRecord["selectorKind"];
	status: PlanRecord["status"];
	/** Declaration, NOT a count of the currently appended prefix. */
	expectedFileCount: number;
	coverageComplete: boolean;
	planHash: string | null;
	/** Owner-bound pointers, not a public digest-to-content capability. */
	manifestDigests: {
		selector: string | null;
		plan: string | null;
		history: string | null;
	};
	expectedMessageVersion: number | null;
	expiresAt: string;
	expired: boolean;
	createdAt: string;
	updatedAt: string;
}
export type RevertPlanFileMetadata = Pick<
	FileRecord,
	| "id"
	| "fileKey"
	| "sequence"
	| "identityJson"
	| "expectedStateJson"
	| "desiredStateJson"
	| "applyMutationId"
	| "applyRequestDigest"
	| "compensateMutationId"
	| "compensateRequestDigest"
	| "status"
>;

/**
 * Internal, dormant metadata preparation layer. No import opens the application DB;
 * no method applies files, commits/deletes history, settles a journal, or reads raw bodies.
 *
 * fileCount is the immutable DECLARED count (the schema has no separate expected count).
 * planHash is a commitment even while planned, NOT execution permission. The proof's
 * complete ordered-list digest is bound alongside every fixed header field and all three
 * original refs INCLUDING their sizes. Finalization recomputes the full ordered-list digest.
 *
 * Catalog ready is meaningful only after trusted IO has verified/published those bytes.
 * SQL FKs pin selector, plan, history and raw expected/desired objects; TTL, cancellation,
 * and failures NEVER remove pins. An executor must separately reauthorize/revalidate TTL,
 * history, coordination fences, current files and physical objects. There is deliberately
 * no execution-admission API here, including for prepared plans.
 *
 * All journal writers must update the owning updatedAt revision when appending/changing
 * files. Optimistic checks reject overlapping preparation across page yields; no ambient
 * transaction or await-held transaction is allowed. Reads are owner/context bound, not
 * public digest lookups. They reveal metadata only, not manifest content/storage paths.
 */
export class RevertPlanService {
	private readonly now: () => string;
	private readonly ttlMs: number;
	private readonly namespaceKey: string;

	constructor(
		private readonly database: PlanDatabase,
		options: RevertPlanOptions,
	) {
		this.now = options.now ?? (() => new Date().toISOString());
		this.ttlMs = options.ttlMs ?? FILE_CHANGE_LIMITS.planLifetimeMs;
		integer(this.ttlMs, "ttlMs", 1, FILE_CHANGE_LIMITS.planLifetimeMs);
		text(options.namespaceKey, "namespaceKey");
		this.namespaceKey = options.namespaceKey;
		this.assertRoot();
	}

	private assertRoot() {
		if (!this.database.$client || this.database.$client.inTransaction)
			throw fail(
				"DURABILITY_BOUNDARY",
				"A root connection outside ambient transactions is required",
			);
		const pragma = this.database.$client
			.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
			.get();
		if (pragma?.foreign_keys !== 1)
			throw fail("DURABILITY_BOUNDARY", "Foreign-key reference protection must be enabled");
	}

	private transaction<T>(work: (tx: Executor) => T): T {
		this.assertRoot();
		return this.database.transaction(work);
	}

	private timestamp(previous?: string): string {
		const now = Date.parse(this.now());
		if (!Number.isFinite(now)) throw fail("INVALID_INPUT", "Invalid clock");
		return new Date(Math.max(now, previous ? Date.parse(previous) + 1 : now)).toISOString();
	}

	private assertFresh(row: PlanRecord) {
		const expiresAt = Date.parse(row.expiresAt);
		if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(this.timestamp()))
			throw fail("EXPIRED", "The fixed plan expired; rebuild it without deleting its journal");
	}

	private assertNamespace(tx: Executor) {
		assertRevertPlanNamespace(tx, this.namespaceKey);
	}

	private refs(tx: Executor, row: PlanRecord) {
		return readRevertPlanRefs(tx, row, this.namespaceKey);
	}

	private assertProof(tx: Executor, row: PlanRecord, proof: RevertPlanManifestProof) {
		return assertRevertPlanProof(tx, row, this.namespaceKey, proof);
	}

	private async readTask<T>(task: RevertPlanReadTask, signal?: AbortSignal): Promise<T> {
		this.assertRoot();
		return readTransactionTask<T>(
			this.database,
			task,
			() => readRevertPlanTask(this.database, task) as T,
			{ signal },
		);
	}

	/** One short durable transaction pins the original manifests, never their trimmed replacement. */
	begin(input: BeginRevertPlan): RevertPlanSummary {
		keys(input, [...HEADER_KEYS, "plan", "manifestProof"]);
		const header = normalizeHeader(input);
		const plan = normalizeRef(input.plan);
		const proof = normalizeProof(input.manifestProof);
		if (proof.headerDigest !== digest(header))
			throw fail("REQUEST_CONFLICT", "The verified manifest does not bind this header");
		evidenceBudget(
			refBytes({ selector: header.selector, plan, historyManifest: header.historyManifest }) +
				proof.fileEvidenceBytes,
		);
		const values = {
			protocolVersion: FILE_CHANGE_EVIDENCE_VERSION,
			narratorId: header.narratorId,
			projectId: header.projectId,
			requestedBySubjectKey: header.subjectKey,
			idempotencyKey: header.idempotencyKey,
			requestDigest: header.requestDigest,
			kind: header.kind,
			scope: header.revertScope,
			selectorKind: header.selectorKind,
			selectorBlobDigest: header.selector.digest,
			planBlobDigest: plan.digest,
			historyManifestBlobDigest: header.historyManifest.digest,
			planHash: planHash(header, plan, proof),
			expectedMessageVersion: header.expectedMessageVersion,
			parentRevertId: header.parentRevertId,
			fileCount: header.expectedFileCount,
		};
		return this.transaction((tx) => {
			const existing = tx
				.select()
				.from(revertOperations)
				.where(
					and(
						eq(revertOperations.requestedBySubjectKey, header.subjectKey),
						eq(revertOperations.idempotencyKey, header.idempotencyKey),
					),
				)
				.get();
			if (existing) {
				for (const key of Object.keys(values) as (keyof typeof values)[])
					if (!equal(existing[key], values[key]))
						throw fail(
							"REQUEST_CONFLICT",
							"An owner's idempotency key cannot change its complete request",
						);
				return this.summary(existing);
			}
			this.assertNamespace(tx);
			for (const ref of [header.selector, plan, header.historyManifest]) requireReadyRef(tx, ref);
			assertParent(tx, values);
			const timestamp = this.timestamp();
			const row = {
				...values,
				id: generateId(),
				status: "planned" as const,
				coverageComplete: false,
				appliedFileCount: 0,
				reason: null,
				leaseUntil: null,
				expiresAt: new Date(Date.parse(timestamp) + this.ttlMs).toISOString(),
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			metadata(row);
			return this.summary(tx.insert(revertOperations).values(row).returning().get());
		});
	}

	/**
	 * <=32 inserts per transaction. Totals are read through indexed bounded pages because
	 * this schema has no appended-count/byte counters; never COUNT/SUM or load all rows.
	 * A concurrent append makes the optimistic snapshot fail, rather than lose a budget check.
	 */
	async appendFiles(
		owner: RevertPlanOwner,
		planId: string,
		inputs: AppendRevertPlanFile[],
		options: { signal?: AbortSignal } = {},
	): Promise<Pick<FileRecord, "id" | "fileKey" | "sequence">[]> {
		const context = normalizeOwner(owner);
		text(planId, "planId");
		integer(inputs.length, "batch size", 1, REVERT_PLAN_BATCH_ITEMS);
		const files = inputs.map(normalizeFile);
		if (
			new Set(files.map((f) => f.fileKey)).size !== files.length ||
			new Set(files.map((f) => f.sequence)).size !== files.length
		)
			throw fail(
				"DUPLICATE_FILE",
				"The batch contains repeated file identities or sequence values",
			);
		options.signal?.throwIfAborted();
		this.assertRoot();
		const { operation: original, refs } = await this.readTask<RevertPlanAppendRead>(
			{
				kind: "revertPlanReadV1",
				action: "append",
				owner: context,
				planId,
				namespaceKey: this.namespaceKey,
				now: this.timestamp(),
			},
			options.signal,
		);
		let bytes = refBytes(refs);
		let count = 0;
		const sequences = new Map<number, string>();
		let cursor: RevertPlanFileCursor | undefined;
		for (;;) {
			options.signal?.throwIfAborted();
			this.assertRoot();
			const page = await this.readTask<FileRecord[]>(
				{
					kind: "revertPlanReadV1",
					action: "files",
					owner: context,
					planId,
					cursor,
					limit: REVERT_PLAN_BATCH_ITEMS + 1,
				},
				options.signal,
			);
			for (const row of page.slice(0, REVERT_PLAN_BATCH_ITEMS)) {
				metadata(row);
				if (sequences.has(row.sequence))
					throw fail("DUPLICATE_FILE", "Stored sequence values repeat");
				sequences.set(row.sequence, row.fileKey);
				count++;
				integer(count, "appended files", 0, original.fileCount);
				bytes +=
					stateBytes(normalizeState(row.expectedStateJson)) +
					stateBytes(normalizeState(row.desiredStateJson));
				evidenceBudget(bytes);
			}
			if (page.length <= REVERT_PLAN_BATCH_ITEMS) break;
			cursor = fileCursor(page[REVERT_PLAN_BATCH_ITEMS - 1]);
			await yieldToEventLoop();
		}
		options.signal?.throwIfAborted();
		return this.transaction((tx) => {
			const operation = requireOwner(tx, context, planId);
			assertSameRevision(original, operation);
			assertPlanned(operation);
			this.assertFresh(operation);
			this.refs(tx, operation);
			assertParent(tx, operation);
			const results: Pick<FileRecord, "id" | "fileKey" | "sequence">[] = [];
			let changed = false;
			for (const file of files) {
				integer(file.sequence, "sequence", 0, operation.fileCount - 1);
				assertScope(tx, file.identity);
				for (const ref of [stateRef(file.expected), stateRef(file.desired)])
					if (ref) requireReadyRef(tx, ref);
				const values = fileValues(operation, file);
				const existing = tx
					.select()
					.from(revertOperationFiles)
					.where(
						and(
							eq(revertOperationFiles.revertOperationId, planId),
							eq(revertOperationFiles.fileKey, file.fileKey),
						),
					)
					.get();
				if (existing) {
					assertFileValues(existing, values);
					results.push({ id: existing.id, fileKey: existing.fileKey, sequence: existing.sequence });
					continue;
				}
				if (sequences.has(file.sequence))
					throw fail("DUPLICATE_FILE", "Another file owns this manifest position");
				integer(++count, "appended files", 0, operation.fileCount);
				bytes += stateBytes(file.expected) + stateBytes(file.desired);
				evidenceBudget(bytes);
				sequences.set(file.sequence, file.fileKey);
				const row = {
					...values,
					id: generateId(),
					observedAfterStateJson: null,
					observedAfterBlobDigest: null,
					receiptJson: null,
					reason: null,
					status: "prepared" as const,
					updatedAt: this.timestamp(),
				};
				metadata(row);
				tx.insert(revertOperationFiles).values(row).run();
				results.push({ id: row.id, fileKey: row.fileKey, sequence: row.sequence });
				changed = true;
			}
			if (changed)
				tx.update(revertOperations)
					.set({ updatedAt: this.timestamp(operation.updatedAt) })
					.where(eq(revertOperations.id, planId))
					.run();
			return results;
		});
	}

	/** The caller supplies the SAME explicit trusted full-coverage proof, never just a count. */
	async finalize(
		owner: RevertPlanOwner,
		planId: string,
		manifestProof: RevertPlanManifestProof,
		options: { signal?: AbortSignal } = {},
	): Promise<RevertPlanSummary> {
		const context = normalizeOwner(owner);
		text(planId, "planId");
		const proof = normalizeProof(manifestProof);
		options.signal?.throwIfAborted();
		this.assertRoot();
		const original = await this.readTask<PlanRecord>(
			{
				kind: "revertPlanReadV1",
				action: "proof",
				owner: context,
				planId,
				namespaceKey: this.namespaceKey,
				proof,
				now: this.timestamp(),
			},
			options.signal,
		);
		if (
			(original.status !== "planned" && original.status !== "prepared") ||
			original.appliedFileCount !== 0 ||
			original.coverageComplete !== (original.status === "prepared")
		)
			throw fail("INVALID_TRANSITION", "Only an unattempted plan can be prepared");
		const entries = new Map<number, string>();
		let fileBytes = 0;
		let cursor: RevertPlanFileCursor | undefined;
		for (;;) {
			options.signal?.throwIfAborted();
			const { rows: page, verified } = await this.readTask<RevertPlanReadPage>(
				{
					kind: "revertPlanReadV1",
					action: "page",
					owner: context,
					planId,
					namespaceKey: this.namespaceKey,
					proof,
					original,
					cursor,
					now: this.timestamp(),
				},
				options.signal,
			);
			for (const file of verified) {
				if (entries.has(file.sequence))
					throw fail("DUPLICATE_FILE", "Stored manifest positions repeat");
				entries.set(file.sequence, file.digest);
				integer(entries.size, "verified files", 0, original.fileCount);
				fileBytes += file.bytes;
				evidenceBudget(fileBytes);
			}
			if (page.length <= REVERT_PLAN_BATCH_ITEMS) break;
			cursor = fileCursor(page[REVERT_PLAN_BATCH_ITEMS - 1]);
			await yieldToEventLoop();
		}
		options.signal?.throwIfAborted();
		if (
			entries.size !== original.fileCount ||
			fileBytes !== proof.fileEvidenceBytes ||
			orderedDigest(entries) !== proof.orderedFilesDigest
		)
			throw fail(
				"INCOMPLETE_SET",
				proof.computation === "partial"
					? "The actionable file subset or its metadata changed"
					: "Every declared file and its exact ordered metadata must match the complete manifest",
			);
		return this.transaction((tx) => {
			const operation = requireOwner(tx, context, planId);
			assertSameRevision(original, operation);
			this.assertFresh(operation);
			this.assertProof(tx, operation, proof);
			assertParent(tx, operation);
			assertPinnedRefsStillReady(tx, planId);
			if (operation.status === "prepared" && operation.coverageComplete)
				return this.summary(operation);
			assertPlanned(operation);
			return this.summary(
				tx
					.update(revertOperations)
					.set({
						status: "prepared",
						coverageComplete: true,
						updatedAt: this.timestamp(operation.updatedAt),
					})
					.where(
						and(
							eq(revertOperations.id, planId),
							eq(revertOperations.status, "planned"),
							eq(revertOperations.updatedAt, original.updatedAt),
						),
					)
					.returning()
					.get(),
			);
		});
	}

	/** Fully supplied convenience API: reject oversized/incomplete lists before pinning a prefix. */
	async prepare(
		input: BeginRevertPlan,
		files: AppendRevertPlanFile[],
		options: { signal?: AbortSignal } = {},
	): Promise<RevertPlanSummary> {
		options.signal?.throwIfAborted();
		// Reject undeclared fields before touching/copying their values (e.g. inputJson).
		keys(input, [...HEADER_KEYS, "plan", "manifestProof"]);
		const { protocolVersion: _protocolVersion, ...header } = normalizeHeader(input);
		const fixed: BeginRevertPlan = {
			...header,
			plan: normalizeRef(input.plan),
			manifestProof: normalizeProof(input.manifestProof),
		};
		integer(files.length, "files", 0, FILE_CHANGE_LIMITS.revertFiles);
		const normalized = files.map(normalizeFile);
		const fingerprint = fingerprintNormalizedFiles(normalized);
		if (
			fingerprint.fileCount !== fixed.expectedFileCount ||
			fingerprint.orderedFilesDigest !== fixed.manifestProof.orderedFilesDigest ||
			fingerprint.fileEvidenceBytes !== fixed.manifestProof.fileEvidenceBytes
		)
			throw fail(
				"INCOMPLETE_SET",
				"The complete supplied file list does not match its fixed manifest",
			);
		const plan = this.begin(fixed);
		if (plan.status === "planned")
			for (let offset = 0; offset < normalized.length; offset += REVERT_PLAN_BATCH_ITEMS) {
				await this.appendFiles(
					fixed,
					plan.id,
					normalized
						.slice(offset, offset + REVERT_PLAN_BATCH_ITEMS)
						.map(({ sequence, identity, expected, desired }) => ({
							sequence,
							identity,
							expected,
							desired,
						})),
					options,
				);
				await yieldToEventLoop();
			}
		return this.finalize(fixed, plan.id, fixed.manifestProof, options);
	}

	async getSummary(owner: RevertPlanOwner, planId: string): Promise<RevertPlanSummary> {
		return this.summary(
			await this.readTask<PlanRecord>({
				kind: "revertPlanReadV1",
				action: "owner",
				owner: normalizeOwner(owner),
				planId,
			}),
		);
	}

	async listSummaries(
		owner: RevertPlanOwner,
		options: { cursor?: RevertPlanSummaryCursor; limit?: number } = {},
	): Promise<RevertPlanPage<RevertPlanSummary, RevertPlanSummaryCursor>> {
		const context = normalizeOwner(owner);
		const limit = pageLimit(options.limit);
		if (options.cursor) text(options.cursor.idempotencyKey, "cursor idempotencyKey");
		const rows = await readQuery(
			this.database
				.select()
				.from(revertOperations)
				.where(
					and(
						eq(revertOperations.requestedBySubjectKey, context.subjectKey),
						sql`${revertOperations.narratorId} IS ${context.narratorId}`,
						sql`${revertOperations.projectId} IS ${context.projectId}`,
						options.cursor
							? sql`${revertOperations.idempotencyKey} > ${options.cursor.idempotencyKey}`
							: undefined,
					),
				)
				.orderBy(asc(revertOperations.idempotencyKey))
				.limit(limit + 1),
		);
		const result = boundedPage(rows, limit, (row) => ({ idempotencyKey: row.idempotencyKey }));
		return { ...result, items: result.items.map((row) => this.summary(row)) };
	}

	async listFiles(
		owner: RevertPlanOwner,
		planId: string,
		options: { cursor?: RevertPlanFileCursor; limit?: number } = {},
	): Promise<RevertPlanPage<RevertPlanFileMetadata, RevertPlanFileCursor>> {
		const limit = pageLimit(options.limit);
		if (options.cursor) sha256(options.cursor.fileKey);
		const rows = await this.readTask<FileRecord[]>({
			kind: "revertPlanReadV1",
			action: "files",
			owner: normalizeOwner(owner),
			planId,
			cursor: options.cursor,
			limit: limit + 1,
		});
		const page = boundedPage(rows, limit, fileCursor);
		return {
			...page,
			items: page.items.map((row) => ({
				id: row.id,
				fileKey: row.fileKey,
				sequence: row.sequence,
				identityJson: row.identityJson,
				expectedStateJson: row.expectedStateJson,
				desiredStateJson: row.desiredStateJson,
				applyMutationId: row.applyMutationId,
				applyRequestDigest: row.applyRequestDigest,
				compensateMutationId: row.compensateMutationId,
				compensateRequestDigest: row.compensateRequestDigest,
				status: row.status,
			})),
		};
	}

	private summary(row: PlanRecord): RevertPlanSummary {
		metadata(row);
		return {
			id: row.id,
			kind: row.kind,
			revertScope: row.scope,
			selectorKind: row.selectorKind,
			status: row.status,
			expectedFileCount: row.fileCount,
			coverageComplete: row.coverageComplete,
			planHash: row.planHash,
			manifestDigests: {
				selector: row.selectorBlobDigest,
				plan: row.planBlobDigest,
				history: row.historyManifestBlobDigest,
			},
			expectedMessageVersion: row.expectedMessageVersion,
			expiresAt: row.expiresAt,
			expired: Date.parse(row.expiresAt) <= Date.parse(this.timestamp()),
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}
}

/** Pure publication helpers. Hashing a list does NOT attest coverage or publish a blob. */

/**
 * The dialect-free core of the plan service, exported for the PostgreSQL sibling
 * (`pg-revert-plan-store.ts`) — and nothing else.
 *
 * Everything here is pure normalization, hashing, budgeting or row mapping: no SQL
 * fragment, no drizzle object, no driver shape. The pieces that DO carry a dialect
 * (the `IS` null-safe comparison idiom, `json_extract`, the sync `.get()/.run()`
 * chaining) stay private above; the PG store rewrites those against its own schema.
 * Exporting the pure half is what lets the two backends share the section CONTENT
 * — the same validations in the same order — rather than diverging copies of it.
 */
export const revertPlanInternals = {
	normalizeOwner,
	normalizeHeader,
	normalizeProof,
	normalizeRef,
	normalizeState,
	normalizeFile,
	fileValues,
	assertFileValues,
	assertPlanned,
	assertSameRevision,
	selectFiles,
	fileCursor,
	stateRef,
	stateBytes,
	refBytes,
	boundedPage,
	pageLimit,
	nullableId,
	text,
	integer,
	sha256,
	keys,
	metadata,
	evidenceBudget,
	digest,
	equal,
	planHash,
	headerFromRow,
	fail,
};
