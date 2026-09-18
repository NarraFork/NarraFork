import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
	FILE_CHANGE_EVIDENCE_VERSION,
	FILE_CHANGE_LIMITS,
	type FileChangeBlobRef,
	type FileChangeIdentity,
	type FileChangeState,
	type KnownFileChangeState,
} from "@shared/file-change-protocol";
import { and, asc, eq, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { alias } from "drizzle-orm/sqlite-core";
import {
	fileChangeBlobs,
	fileChangeScopes,
	fileChangeStorageBudgets,
	revertOperationFiles,
	revertOperations,
} from "../db/schema";
import { AppError } from "../lib/errors";
import { generateId } from "../lib/id";
import { FILE_CHANGE_BLOB_BUDGET_ID } from "./file-change-blob-catalog";
import { createFileChangeIdentity, fileChangeIdentityKey } from "./file-change-identity";

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

export class RevertPlanError extends AppError {
	constructor(code: string, message: string) {
		super(message, 409, `REVERT_PLAN_${code}`);
		this.name = "RevertPlanError";
	}
}

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
		const budget = tx
			.select({
				status: fileChangeStorageBudgets.status,
				namespaceKey: fileChangeStorageBudgets.namespaceKey,
			})
			.from(fileChangeStorageBudgets)
			.where(eq(fileChangeStorageBudgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
			.get();
		if (budget?.status !== "ready" || budget.namespaceKey !== this.namespaceKey)
			throw fail("CATALOG_UNVERIFIED", "The physical blob namespace must be reconciled and ready");
	}

	private refs(tx: Executor, row: PlanRecord) {
		this.assertNamespace(tx);
		return {
			selector: catalogRef(tx, row.selectorBlobDigest),
			plan: catalogRef(tx, row.planBlobDigest),
			historyManifest: catalogRef(tx, row.historyManifestBlobDigest),
		};
	}

	private assertProof(tx: Executor, row: PlanRecord, proof: RevertPlanManifestProof) {
		const refs = this.refs(tx, row);
		const header = headerFromRow(row, refs);
		if (
			proof.headerDigest !== digest(header) ||
			row.planHash !== planHash(header, refs.plan, proof)
		)
			throw fail("REQUEST_CONFLICT", "The complete manifest/header commitment changed");
		evidenceBudget(refBytes(refs) + proof.fileEvidenceBytes);
		return refs;
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
		const original = requireOwner(this.database, context, planId);
		assertPlanned(original);
		this.assertFresh(original);
		const refs = this.refs(this.database, original);
		let bytes = refBytes(refs);
		let count = 0;
		const sequences = new Map<number, string>();
		let cursor: RevertPlanFileCursor | undefined;
		for (;;) {
			options.signal?.throwIfAborted();
			this.assertRoot();
			const page = selectFiles(this.database, planId, cursor, REVERT_PLAN_BATCH_ITEMS + 1);
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
		const original = requireOwner(this.database, context, planId);
		this.assertFresh(original);
		this.assertProof(this.database, original, proof);
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
			const page = this.transaction((tx) => {
				const operation = requireOwner(tx, context, planId);
				assertSameRevision(original, operation);
				this.assertFresh(operation);
				this.assertProof(tx, operation, proof);
				const rows = selectFiles(tx, planId, cursor, REVERT_PLAN_BATCH_ITEMS + 1);
				for (const row of rows.slice(0, REVERT_PLAN_BATCH_ITEMS)) {
					metadata(row);
					const file = normalizeFile({
						sequence: row.sequence,
						identity: row.identityJson,
						expected: row.expectedStateJson,
						desired: row.desiredStateJson,
					});
					integer(file.sequence, "sequence", 0, operation.fileCount - 1);
					assertFileValues(row, fileValues(operation, file));
					assertScope(tx, file.identity);
					for (const ref of [stateRef(file.expected), stateRef(file.desired)])
						if (ref) requireReadyRef(tx, ref);
					if (entries.has(file.sequence))
						throw fail("DUPLICATE_FILE", "Stored manifest positions repeat");
					entries.set(file.sequence, digest(file));
					integer(entries.size, "verified files", 0, operation.fileCount);
					fileBytes += stateBytes(file.expected) + stateBytes(file.desired);
					evidenceBudget(fileBytes);
				}
				return rows;
			});
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

	getSummary(owner: RevertPlanOwner, planId: string): RevertPlanSummary {
		return this.summary(requireOwner(this.database, normalizeOwner(owner), planId));
	}

	listSummaries(
		owner: RevertPlanOwner,
		options: { cursor?: RevertPlanSummaryCursor; limit?: number } = {},
	): RevertPlanPage<RevertPlanSummary, RevertPlanSummaryCursor> {
		const context = normalizeOwner(owner);
		const limit = pageLimit(options.limit);
		if (options.cursor) text(options.cursor.idempotencyKey, "cursor idempotencyKey");
		const rows = this.database
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
			.limit(limit + 1)
			.all();
		const result = boundedPage(rows, limit, (row) => ({ idempotencyKey: row.idempotencyKey }));
		return { ...result, items: result.items.map((row) => this.summary(row)) };
	}

	listFiles(
		owner: RevertPlanOwner,
		planId: string,
		options: { cursor?: RevertPlanFileCursor; limit?: number } = {},
	): RevertPlanPage<RevertPlanFileMetadata, RevertPlanFileCursor> {
		requireOwner(this.database, normalizeOwner(owner), planId);
		const limit = pageLimit(options.limit);
		if (options.cursor) sha256(options.cursor.fileKey);
		const rows = selectFiles(this.database, planId, options.cursor, limit + 1);
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

const HEADER_KEYS = [
	"subjectKey",
	"narratorId",
	"projectId",
	"idempotencyKey",
	"requestDigest",
	"kind",
	"revertScope",
	"selectorKind",
	"selector",
	"historyManifest",
	"expectedMessageVersion",
	"expectedFileCount",
	"parentRevertId",
];

/** Pure publication helpers. Hashing a list does NOT attest coverage or publish a blob. */
export function revertPlanHeaderDigest(input: RevertPlanHeader): string {
	return digest(normalizeHeader(input));
}
export function fingerprintRevertPlanFiles(files: AppendRevertPlanFile[]) {
	integer(files.length, "files", 0, FILE_CHANGE_LIMITS.revertFiles);
	return fingerprintNormalizedFiles(files.map(normalizeFile));
}
function fingerprintNormalizedFiles(files: ReturnType<typeof normalizeFile>[]) {
	const entries = new Map<number, string>();
	const identities = new Set<string>();
	let fileEvidenceBytes = 0;
	for (const file of files) {
		integer(file.sequence, "sequence", 0, files.length - 1);
		if (entries.has(file.sequence) || identities.has(file.fileKey))
			throw fail("DUPLICATE_FILE", "The complete file list contains duplicates");
		entries.set(file.sequence, digest(file));
		identities.add(file.fileKey);
		fileEvidenceBytes += stateBytes(file.expected) + stateBytes(file.desired);
		evidenceBudget(fileEvidenceBytes);
	}
	return { fileCount: files.length, orderedFilesDigest: orderedDigest(entries), fileEvidenceBytes };
}

function normalizeOwner(input: RevertPlanOwner): RevertPlanOwner {
	text(input.subjectKey, "subjectKey");
	return {
		subjectKey: input.subjectKey,
		narratorId: nullableId(input.narratorId),
		projectId: nullableId(input.projectId),
	};
}
function normalizeHeader(input: RevertPlanHeader) {
	text(input.idempotencyKey, "idempotencyKey");
	sha256(input.requestDigest);
	if (
		!["revert", "unrevert", "history_delete", "rollback_to_block", "edit_regenerate"].includes(
			input.kind,
		) ||
		!["narrator", "workspace"].includes(input.revertScope) ||
		!["all", "from_seq", "messages", "tool_calls", "after_block"].includes(input.selectorKind)
	)
		throw fail("INVALID_INPUT", "Unknown plan kind, scope or selector kind");
	integer(input.expectedFileCount, "expectedFileCount", 0, FILE_CHANGE_LIMITS.revertFiles);
	integer(input.expectedMessageVersion, "expectedMessageVersion");
	const owner = normalizeOwner(input);
	if (input.revertScope === "narrator" && !owner.narratorId)
		throw fail("INVALID_INPUT", "Narrator scope requires a narrator context");
	const parentRevertId = nullableId(input.parentRevertId ?? null);
	if ((input.kind === "unrevert") !== (parentRevertId !== null))
		throw fail("PARENT_UNAVAILABLE", "Only unrevert requires a committed parent journal");
	const header = {
		...owner,
		protocolVersion: FILE_CHANGE_EVIDENCE_VERSION,
		idempotencyKey: input.idempotencyKey,
		requestDigest: input.requestDigest,
		kind: input.kind,
		revertScope: input.revertScope,
		selectorKind: input.selectorKind,
		selector: normalizeRef(input.selector),
		historyManifest: normalizeRef(input.historyManifest),
		expectedMessageVersion: input.expectedMessageVersion,
		expectedFileCount: input.expectedFileCount,
		parentRevertId,
	};
	metadata(header);
	return header;
}
function normalizeProof(input: RevertPlanManifestProof): RevertPlanManifestProof {
	keys(input, [
		"source",
		"headerDigest",
		"orderedFilesDigest",
		"fileEvidenceBytes",
		"computation",
		"selectorCoverage",
		"historyCoverage",
		"omittedFiles",
		"unknownFiles",
	]);
	if (
		input.source !== "trusted_published_planner_v1" ||
		(input.computation !== "complete" && input.computation !== "partial") ||
		input.selectorCoverage !== "complete" ||
		(input.historyCoverage !== "complete" && input.historyCoverage !== "partial") ||
		input.omittedFiles < 0 ||
		input.unknownFiles < 0
	)
		throw fail(
			"COVERAGE_UNPROVEN",
			"Explicit complete computation and source coverage with no unknown/omitted files are required",
		);
	sha256(input.headerDigest);
	sha256(input.orderedFilesDigest);
	integer(
		input.fileEvidenceBytes,
		"fileEvidenceBytes",
		0,
		FILE_CHANGE_LIMITS.operationEvidenceBytes,
	);
	return { ...input };
}
function normalizeRef(ref: FileChangeBlobRef): FileChangeBlobRef {
	keys(ref, ["algorithm", "digest", "sizeBytes"]);
	if (ref.algorithm !== "sha256") throw fail("INVALID_INPUT", "Only SHA-256 refs are supported");
	sha256(ref.digest);
	integer(ref.sizeBytes, "blob size", 0, FILE_CHANGE_LIMITS.blobBytes);
	return { algorithm: "sha256", digest: ref.digest, sizeBytes: ref.sizeBytes };
}
function normalizeState(state: FileChangeState): KnownFileChangeState {
	if (!state || state.kind === "unknown")
		throw fail("UNKNOWN_STATE", "Unknown/null states cannot enter a fixed plan");
	if (state.kind === "absent") {
		keys(state, ["kind"]);
		return { kind: "absent" };
	}
	if (state.kind !== "regular" && state.kind !== "symlink")
		throw fail("UNKNOWN_STATE", "Unsupported file state");
	keys(state, state.kind === "regular" ? ["kind", "blob", "mode"] : ["kind", "target", "mode"]);
	if (state.mode !== null) integer(state.mode, "mode", 0, 0xffff);
	return state.kind === "regular"
		? { kind: "regular", blob: normalizeRef(state.blob), mode: state.mode }
		: { kind: "symlink", target: normalizeRef(state.target), mode: state.mode };
}
function normalizeFile(input: AppendRevertPlanFile) {
	keys(input, ["sequence", "identity", "expected", "desired"]);
	integer(input.sequence, "sequence", 0, FILE_CHANGE_LIMITS.revertFiles - 1);
	keys(input.identity, [
		"sourceInstanceId",
		"deviceId",
		"workspaceInstanceId",
		"scopeId",
		"pathFlavor",
		"objectRole",
		"canonicalPath",
		"lexicalPath",
		"displayPath",
	]);
	const fileKey = fileChangeIdentityKey(input.identity);
	const file = {
		sequence: input.sequence,
		identity: { ...input.identity },
		fileKey,
		expected: normalizeState(input.expected),
		desired: normalizeState(input.desired),
	};
	metadata(file);
	return file;
}
function headerFromRow(
	row: PlanRecord,
	refs: { selector: FileChangeBlobRef; historyManifest: FileChangeBlobRef },
) {
	if (row.protocolVersion !== FILE_CHANGE_EVIDENCE_VERSION || row.expectedMessageVersion === null)
		throw fail("LEGACY_UNVERIFIED", "A full v2 plan journal is required");
	return normalizeHeader({
		subjectKey: row.requestedBySubjectKey,
		narratorId: row.narratorId,
		projectId: row.projectId,
		idempotencyKey: row.idempotencyKey,
		requestDigest: row.requestDigest,
		kind: row.kind,
		revertScope: row.scope,
		selectorKind: row.selectorKind,
		...refs,
		expectedMessageVersion: row.expectedMessageVersion,
		expectedFileCount: row.fileCount,
		parentRevertId: row.parentRevertId,
	});
}
function planHash(
	header: ReturnType<typeof normalizeHeader>,
	plan: FileChangeBlobRef,
	proof: RevertPlanManifestProof,
) {
	return digest(["revert-plan-commitment-v1", header, plan, proof]);
}
function orderedDigest(entries: Map<number, string>): string {
	const hash = createHash("sha256").update("revert-plan-ordered-files-v1\n");
	for (let sequence = 0; sequence < entries.size; sequence++) {
		const entry = entries.get(sequence);
		if (!entry) throw fail("INCOMPLETE_SET", "The ordered manifest has a missing position");
		hash.update(`${sequence}:${entry}\n`);
	}
	return hash.digest("hex");
}
function fileValues(operation: PlanRecord, file: ReturnType<typeof normalizeFile>) {
	const binding = [
		operation.id,
		operation.requestDigest,
		operation.planHash,
		file.fileKey,
		file.sequence,
	];
	return {
		revertOperationId: operation.id,
		scopeId: file.identity.scopeId,
		fileKey: file.fileKey,
		identityJson: file.identity,
		sequence: file.sequence,
		expectedStateJson: file.expected,
		desiredStateJson: file.desired,
		beforeBlobDigest: stateRef(file.expected)?.digest ?? null,
		desiredBlobDigest: stateRef(file.desired)?.digest ?? null,
		applyMutationId: digest(["revert-mutation-v1", ...binding, "apply"]),
		compensateMutationId: digest(["revert-mutation-v1", ...binding, "compensate"]),
		applyRequestDigest: digest([
			"revert-request-v1",
			...binding,
			"apply",
			file.expected,
			file.desired,
		]),
		compensateRequestDigest: digest([
			"revert-request-v1",
			...binding,
			"compensate",
			file.desired,
			file.expected,
		]),
	};
}
function assertFileValues(row: FileRecord, values: ReturnType<typeof fileValues>) {
	for (const key of Object.keys(values) as (keyof typeof values)[])
		if (!equal(row[key], values[key]))
			throw fail("REQUEST_CONFLICT", "A file's immutable metadata or phase binding changed");
	if (
		row.status !== "prepared" ||
		row.observedAfterStateJson !== null ||
		row.observedAfterBlobDigest !== null ||
		row.compensationAfterStateJson !== null ||
		row.compensationAfterBlobDigest !== null ||
		row.receiptJson !== null
	)
		throw fail("INVALID_TRANSITION", "An attempted/unknown file is not a prepared intent");
}
function assertScope(tx: Executor, identity: FileChangeIdentity) {
	const scope = tx
		.select({
			id: fileChangeScopes.id,
			sourceInstanceId: fileChangeScopes.sourceInstanceId,
			deviceId: fileChangeScopes.deviceId,
			workspaceInstanceId: fileChangeScopes.workspaceInstanceId,
			canonicalRoot: fileChangeScopes.canonicalRoot,
			pathFlavor: fileChangeScopes.pathFlavor,
			status: fileChangeScopes.status,
		})
		.from(fileChangeScopes)
		.where(eq(fileChangeScopes.id, identity.scopeId))
		.get();
	if (!scope || scope.status !== "active")
		throw fail("TARGET_UNVERIFIED", "A verified active scope is required");
	if (!equal(createFileChangeIdentity(scope, identity), identity))
		throw fail(
			"IDENTITY_CONFLICT",
			"Identity does not match its actual source/device/workspace/path scope",
		);
}
function assertParent(
	tx: Executor,
	row: Pick<
		PlanRecord,
		"kind" | "parentRevertId" | "requestedBySubjectKey" | "narratorId" | "projectId"
	>,
) {
	if (row.kind !== "unrevert") return;
	const parent = tx
		.select()
		.from(revertOperations)
		.where(
			and(
				eq(revertOperations.id, row.parentRevertId ?? ""),
				eq(revertOperations.requestedBySubjectKey, row.requestedBySubjectKey),
				sql`${revertOperations.narratorId} IS ${row.narratorId}`,
				sql`${revertOperations.projectId} IS ${row.projectId}`,
			),
		)
		.get();
	if (
		!parent ||
		parent.kind !== "revert" ||
		parent.status !== "committed" ||
		parent.protocolVersion !== FILE_CHANGE_EVIDENCE_VERSION ||
		!parent.coverageComplete ||
		!parent.planHash ||
		!parent.planBlobDigest ||
		!parent.selectorBlobDigest ||
		!parent.historyManifestBlobDigest ||
		parent.expectedMessageVersion === null
	)
		throw fail(
			"PARENT_UNAVAILABLE",
			"Unrevert requires a committed v2 revert journal in the same authorized owner/context",
		);
	metadata(parent);
}
function assertPlanned(row: PlanRecord) {
	if (row.protocolVersion !== FILE_CHANGE_EVIDENCE_VERSION || row.expectedMessageVersion === null)
		throw fail("LEGACY_UNVERIFIED", "A full v2 plan declaration is required");
	integer(row.fileCount, "expectedFileCount", 0, FILE_CHANGE_LIMITS.revertFiles);
	if (
		row.status !== "planned" ||
		row.coverageComplete ||
		row.appliedFileCount !== 0 ||
		!row.planHash
	)
		throw fail("INVALID_TRANSITION", "Only an incomplete unattempted plan accepts preparation");
}
function assertSameRevision(before: PlanRecord, after: PlanRecord) {
	if (before.updatedAt !== after.updatedAt || !equal(before, after))
		throw fail(
			"CONCURRENT_CHANGE",
			"The plan changed between preparation pages; retry from the beginning",
		);
}
function requireOwner(tx: Executor, owner: RevertPlanOwner, planId: string): PlanRecord {
	text(planId, "planId");
	const row = tx
		.select()
		.from(revertOperations)
		.where(
			and(
				eq(revertOperations.id, planId),
				eq(revertOperations.requestedBySubjectKey, owner.subjectKey),
				sql`${revertOperations.narratorId} IS ${owner.narratorId}`,
				sql`${revertOperations.projectId} IS ${owner.projectId}`,
			),
		)
		.get();
	if (!row) throw fail("NOT_FOUND", "Plan not found in the owning context");
	metadata(row);
	return row;
}
function catalogRef(tx: Executor, digestValue: string | null): FileChangeBlobRef {
	if (!digestValue) throw fail("LEGACY_UNVERIFIED", "Original manifest references are required");
	const blob = tx
		.select({
			digest: fileChangeBlobs.digest,
			sizeBytes: fileChangeBlobs.sizeBytes,
			status: fileChangeBlobs.status,
		})
		.from(fileChangeBlobs)
		.where(eq(fileChangeBlobs.digest, digestValue))
		.get();
	if (!blob || blob.status !== "ready")
		throw fail("BLOB_NOT_READY", "A referenced published object is not ready");
	return normalizeRef({ algorithm: "sha256", digest: blob.digest, sizeBytes: blob.sizeBytes });
}
function requireReadyRef(tx: Executor, ref: FileChangeBlobRef) {
	if (!equal(catalogRef(tx, ref.digest), ref))
		throw fail("BLOB_NOT_READY", "Published object size does not match the fixed reference");
}
function assertPinnedRefsStillReady(tx: Executor, planId: string) {
	// Scoped EXISTS, <=1000 admitted files; no body materialization or global aggregate.
	// Recheck readiness changed during a page yield, not just the last visited page.
	const before = alias(fileChangeBlobs, "revert_expected_blob");
	const desired = alias(fileChangeBlobs, "revert_desired_blob");
	const row = tx
		.select({ id: revertOperationFiles.id })
		.from(revertOperationFiles)
		.leftJoin(before, eq(revertOperationFiles.beforeBlobDigest, before.digest))
		.leftJoin(desired, eq(revertOperationFiles.desiredBlobDigest, desired.digest))
		.leftJoin(fileChangeScopes, eq(revertOperationFiles.scopeId, fileChangeScopes.id))
		.where(
			and(
				eq(revertOperationFiles.revertOperationId, planId),
				sql`(
			${revertOperationFiles.status} != 'prepared' OR ${fileChangeScopes.status} IS NOT 'active'
			OR (${revertOperationFiles.beforeBlobDigest} IS NOT NULL AND (${before.status} IS NOT 'ready'
				OR ${before.sizeBytes} IS NOT coalesce(json_extract(${revertOperationFiles.expectedStateJson}, '$.blob.sizeBytes'), json_extract(${revertOperationFiles.expectedStateJson}, '$.target.sizeBytes'))))
			OR (${revertOperationFiles.desiredBlobDigest} IS NOT NULL AND (${desired.status} IS NOT 'ready'
				OR ${desired.sizeBytes} IS NOT coalesce(json_extract(${revertOperationFiles.desiredStateJson}, '$.blob.sizeBytes'), json_extract(${revertOperationFiles.desiredStateJson}, '$.target.sizeBytes'))))
		)`,
			),
		)
		.limit(1)
		.get();
	if (row)
		throw fail(
			"BLOB_NOT_READY",
			"Pinned file evidence or scope became unavailable during preparation",
		);
}
function selectFiles(
	tx: Executor,
	planId: string,
	cursor: RevertPlanFileCursor | undefined,
	limit: number,
): FileRecord[] {
	return tx
		.select()
		.from(revertOperationFiles)
		.where(
			and(
				eq(revertOperationFiles.revertOperationId, planId),
				cursor ? sql`${revertOperationFiles.fileKey} > ${cursor.fileKey}` : undefined,
			),
		)
		.orderBy(asc(revertOperationFiles.fileKey))
		.limit(limit)
		.all();
}
function fileCursor(row: FileRecord): RevertPlanFileCursor {
	return { fileKey: row.fileKey };
}
function stateRef(state: KnownFileChangeState) {
	return state.kind === "regular" ? state.blob : state.kind === "symlink" ? state.target : null;
}
function stateBytes(state: KnownFileChangeState) {
	return stateRef(state)?.sizeBytes ?? 0;
}
function refBytes(refs: {
	selector: FileChangeBlobRef;
	plan: FileChangeBlobRef;
	historyManifest: FileChangeBlobRef;
}) {
	return refs.selector.sizeBytes + refs.plan.sizeBytes + refs.historyManifest.sizeBytes;
}
function boundedPage<T, C>(rows: T[], limit: number, cursor: (row: T) => C): RevertPlanPage<T, C> {
	const items: T[] = [];
	let bytes = 1024;
	for (const row of rows) {
		metadata(row);
		const size = Buffer.byteLength(JSON.stringify(row)) + 1;
		if (items.length === limit || bytes + size > FILE_CHANGE_LIMITS.summaryBytes) break;
		items.push(row);
		bytes += size;
	}
	if (rows.length && !items.length)
		throw fail("METADATA_BUDGET", "A row cannot fit in a bounded summary");
	const hasMore = rows.length > items.length;
	const last = items.at(-1);
	return { items, hasMore, nextCursor: hasMore && last ? cursor(last) : null };
}
function pageLimit(value: number = FILE_CHANGE_LIMITS.historyPageItems) {
	integer(value, "page size", 1, FILE_CHANGE_LIMITS.historyPageItems);
	return value;
}
function nullableId(value: string | null) {
	if (value !== null) text(value, "context id");
	return value;
}
function text(value: string, name: string) {
	if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value) > 256)
		throw fail("INVALID_INPUT", `Invalid ${name}`);
}
function integer(value: number, name: string, min = 0, max = Number.MAX_SAFE_INTEGER) {
	if (!Number.isSafeInteger(value) || value < min || value > max)
		throw fail("BUDGET_OR_INPUT", `Invalid or over-budget ${name}`);
}
function sha256(value: string) {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
		throw fail("INVALID_INPUT", "Invalid SHA-256 digest");
}
function keys(value: object, allowed: string[]) {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !allowed.includes(key))
	)
		throw fail("INVALID_INPUT", "Only bounded, declared metadata fields are accepted");
}
function metadata(value: unknown) {
	if (Buffer.byteLength(JSON.stringify(value)) > FILE_CHANGE_LIMITS.metadataBytes)
		throw fail("METADATA_BUDGET", "Metadata exceeds the shared row budget");
}
function evidenceBudget(bytes: number) {
	integer(bytes, "evidence bytes", 0, FILE_CHANGE_LIMITS.operationEvidenceBytes);
}
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
function digest(value: unknown): string {
	return createHash("sha256").update(canonical(value)).digest("hex");
}
function equal(a: unknown, b: unknown): boolean {
	return canonical(a) === canonical(b);
}
function fail(code: string, message: string) {
	return new RevertPlanError(code, message);
}

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
