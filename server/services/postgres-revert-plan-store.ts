/**
 * PostgreSQL counterpart of `RevertPlanService`'s atomic write sections
 * (`revert-plan-service.ts`).
 *
 * WHY A SIBLING, NOT A FLAG
 * -------------------------
 * The SQLite service is strictly synchronous: `bun:sqlite` commits when the
 * transaction callback RETURNS, and its public methods (`begin`, the sections of
 * `appendFiles`/`finalize`) are built on that. A networked driver cannot satisfy a
 * synchronous signature, and faking one would commit at the first `await` — the
 * silent data loss `server/db/transaction-atomicity-contract.test.ts` pins. So the
 * PostgreSQL counterpart is its own module with honestly async methods, sharing
 * with the SQLite service the section CONTENT (same reads, guards and writes in
 * the same order) and the dialect-free core (`revertPlanInternals`: normalization,
 * digests, budgets, row mapping). What is rewritten here is the dialect shape:
 *
 *   - the `sql`${col} IS ${value}`` null-safe idiom is SQLite-only (`IS` in
 *     PostgreSQL compares NULL/boolean only); the sections below use
 *     `IS NOT DISTINCT FROM`, which is the same question in PG spelling;
 *   - `json_extract(...)` becomes `(col::jsonb #>> '{…}')::bigint` — the columns
 *     are jsonText (TEXT on disk), so the cast is explicit rather than a type
 *     surprise;
 *   - `.get()/.run()/.all()` chaining becomes awaited statements;
 *   - the durability-boundary check (`PRAGMA foreign_keys`, `inTransaction`) has
 *     no PG counterpart: foreign keys are always enforced, and "no ambient
 *     transaction" is structural — every method opens its OWN
 *     `db.transaction` through `withPgRetry` and never accepts a caller's
 *     transaction handle.
 *
 * HOW THE PORT CONTRACT IS MET (see `server/db/backend/write-port.ts`)
 * --------------------------------------------------------------------
 * - PROMISE boundary: every method is honestly async end to end.
 * - ATOMICITY: each section runs in one `db.transaction`; any rejection — including
 *   the optimistic `assertSameRevision` — rolls all of it back. Sections are NAMED
 *   async functions invoked through non-async arrows.
 * - RETRY: `withPgRetry` wraps the WHOLE section. Sections are idempotent under
 *   replay: `begin` re-finds its committed row through the (subject, idempotency
 *   key) check, `appendFiles` through the (plan, fileKey) check, `finalize`
 *   through the guarded status transition — a replay after a lost commit
 *   acknowledgement surfaces as a no-op returning the winner's state, never as
 *   duplicate rows.
 * - CONFLICTS: a lost idempotency race rejects with the same `RevertPlanError`
 *   code the SQLite path produces (`REQUEST_CONFLICT`), never a driver error.
 *
 * CONCURRENCY (where SQLite's single writer was the lock)
 * -------------------------------------------------------
 * The optimistic guards the SQLite service relies on translate directly: the
 * sections re-read the operation row inside the transaction and compare it
 * field-for-field (`assertSameRevision`), and `finalize` guards the status
 * transition in the UPDATE's WHERE clause. A concurrent change between the
 * pre-read and the section re-read is caught by the same comparison — the same
 * "the snapshot changed, fail and let the caller retry from the beginning"
 * verdict SQLite gives.
 */
import { createHash } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { withPgRetry } from "@server/db/pg-retry";
import {
	fileChangeBlobs,
	fileChangeScopes,
	fileChangeStorageBudgets,
	revertOperationFiles,
	revertOperations,
} from "@server/db/postgres-schema";
import { generateId } from "@server/lib/id";
import {
	FILE_CHANGE_EVIDENCE_VERSION,
	FILE_CHANGE_LIMITS,
	type FileChangeBlobRef,
} from "@shared/file-change-protocol";
import { and, asc, eq, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { alias } from "drizzle-orm/pg-core";
import type {
	revertOperationFiles as sqliteRevertOperationFiles,
	revertOperations as sqliteRevertOperations,
} from "../db/schema";
import { FILE_CHANGE_BLOB_BUDGET_ID } from "./file-change-blob-catalog";
import { createFileChangeIdentity } from "./file-change-identity";
import type {
	AppendRevertPlanFile,
	BeginRevertPlan,
	RevertPlanFileCursor,
	RevertPlanManifestProof,
	RevertPlanOwner,
	RevertPlanSummary,
} from "./revert-plan-service";
import { revertPlanInternals as I, REVERT_PLAN_BATCH_ITEMS } from "./revert-plan-service";

/** Transaction handle as produced by `db.transaction(async (tx) => …`. PG-side only. */
type Tx = Parameters<Parameters<BunSQLDatabase["transaction"]>[0]>[0];
/**
 * The root handle, seen through the transaction's query interface. The two drizzle
 * objects expose the same query methods at runtime; the generic parameters differ,
 * so the cast is confined to the operation entry points.
 */
type RootQueryable = Tx;
/**
 * Row shapes are typed against the SQLITE schema's inference DELIBERATELY: the two
 * schemas hold the same application values (the PG `jsonText` codec exists to
 * preserve SQLite JSON-mode application values), and the dialect-free core in
 * `revertPlanInternals` is typed against the SQLite rows. Typing the PG store's
 * internal rows the same way is what lets both backends share that core; the PG
 * driver's results are cast at the query boundary, where the equivalence claim
 * actually lives.
 */
type PlanRecord = typeof sqliteRevertOperations.$inferSelect;
type FileRecord = typeof sqliteRevertOperationFiles.$inferSelect;
type NormalizedHeader = ReturnType<typeof I.normalizeHeader>;
type NormalizedFile = ReturnType<typeof I.normalizeFile>;
type FileIdentity = NormalizedFile["identity"];

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

/** The `IS` idiom, in PG spelling: null-safe equality. */
function isNotDistinctFrom(column: unknown, value: unknown) {
	return sql`${column} IS NOT DISTINCT FROM ${value}`;
}

/**
 * The PostgreSQL revert-plan write store. Same options as the SQLite service;
 * `database` must be a ROOT handle — sections open their own transactions.
 */
export class PostgresRevertPlanStore {
	private readonly now: () => string;
	private readonly ttlMs: number;
	private readonly namespaceKey: string;

	constructor(
		private readonly database: BunSQLDatabase,
		options: { namespaceKey: string; now?: () => string; ttlMs?: number },
	) {
		this.now = options.now ?? (() => new Date().toISOString());
		this.ttlMs = options.ttlMs ?? FILE_CHANGE_LIMITS.planLifetimeMs;
		I.integer(this.ttlMs, "ttlMs", 1, FILE_CHANGE_LIMITS.planLifetimeMs);
		I.text(options.namespaceKey, "namespaceKey");
		this.namespaceKey = options.namespaceKey;
	}

	private timestamp(previous?: string): string {
		const now = Date.parse(this.now());
		if (!Number.isFinite(now)) throw I.fail("INVALID_INPUT", "Invalid clock");
		return new Date(Math.max(now, previous ? Date.parse(previous) + 1 : now)).toISOString();
	}

	private assertFresh(row: PlanRecord) {
		const expiresAt = Date.parse(row.expiresAt);
		if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(this.timestamp())) {
			throw I.fail("EXPIRED", "The fixed plan expired; rebuild it without deleting its journal");
		}
	}

	private summary(row: PlanRecord): RevertPlanSummary {
		I.metadata(row);
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

	// ── in-section guards (PG spellings of the SQLite service's private helpers) ──

	private async requireOwner(tx: Tx, owner: RevertPlanOwner, planId: string): Promise<PlanRecord> {
		I.text(planId, "planId");
		const rows = (await tx
			.select()
			.from(revertOperations)
			.where(
				and(
					eq(revertOperations.id, planId),
					eq(revertOperations.requestedBySubjectKey, owner.subjectKey),
					isNotDistinctFrom(revertOperations.narratorId, owner.narratorId),
					isNotDistinctFrom(revertOperations.projectId, owner.projectId),
				),
			)) as PlanRecord[];
		const row = rows[0];
		if (!row) throw I.fail("NOT_FOUND", "Plan not found in the owning context");
		I.metadata(row);
		return row;
	}

	private async assertNamespace(tx: Tx): Promise<void> {
		const rows = await tx
			.select({
				status: fileChangeStorageBudgets.status,
				namespaceKey: fileChangeStorageBudgets.namespaceKey,
			})
			.from(fileChangeStorageBudgets)
			.where(eq(fileChangeStorageBudgets.id, FILE_CHANGE_BLOB_BUDGET_ID));
		const budget = rows[0];
		if (budget?.status !== "ready" || budget.namespaceKey !== this.namespaceKey) {
			throw I.fail(
				"CATALOG_UNVERIFIED",
				"The physical blob namespace must be reconciled and ready",
			);
		}
	}

	private async catalogRef(tx: Tx, digestValue: string | null): Promise<FileChangeBlobRef> {
		if (!digestValue)
			throw I.fail("LEGACY_UNVERIFIED", "Original manifest references are required");
		const rows = await tx
			.select({
				digest: fileChangeBlobs.digest,
				sizeBytes: fileChangeBlobs.sizeBytes,
				status: fileChangeBlobs.status,
			})
			.from(fileChangeBlobs)
			.where(eq(fileChangeBlobs.digest, digestValue));
		const blob = rows[0];
		if (!blob || blob.status !== "ready") {
			throw I.fail("BLOB_NOT_READY", "A referenced published object is not ready");
		}
		return I.normalizeRef({ algorithm: "sha256", digest: blob.digest, sizeBytes: blob.sizeBytes });
	}

	private async requireReadyRef(tx: Tx, ref: FileChangeBlobRef): Promise<void> {
		if (!I.equal(await this.catalogRef(tx, ref.digest), ref)) {
			throw I.fail("BLOB_NOT_READY", "Published object size does not match the fixed reference");
		}
	}

	private async refs(tx: Tx, row: PlanRecord) {
		await this.assertNamespace(tx);
		return {
			selector: await this.catalogRef(tx, row.selectorBlobDigest),
			plan: await this.catalogRef(tx, row.planBlobDigest),
			historyManifest: await this.catalogRef(tx, row.historyManifestBlobDigest),
		};
	}

	private async assertProof(tx: Tx, row: PlanRecord, proof: RevertPlanManifestProof) {
		const manifestRefs = await this.refs(tx, row);
		const header = I.headerFromRow(row, manifestRefs);
		if (
			proof.headerDigest !== I.digest(header) ||
			row.planHash !== I.planHash(header, manifestRefs.plan, proof)
		) {
			throw I.fail("REQUEST_CONFLICT", "The complete manifest/header commitment changed");
		}
		I.evidenceBudget(I.refBytes(manifestRefs) + proof.fileEvidenceBytes);
		return manifestRefs;
	}

	private async assertParent(
		tx: Tx,
		row: Pick<
			PlanRecord,
			"kind" | "parentRevertId" | "requestedBySubjectKey" | "narratorId" | "projectId"
		>,
	): Promise<void> {
		if (row.kind !== "unrevert") return;
		const parents = (await tx
			.select()
			.from(revertOperations)
			.where(
				and(
					eq(revertOperations.id, row.parentRevertId ?? ""),
					eq(revertOperations.requestedBySubjectKey, row.requestedBySubjectKey),
					isNotDistinctFrom(revertOperations.narratorId, row.narratorId),
					isNotDistinctFrom(revertOperations.projectId, row.projectId),
				),
			)) as PlanRecord[];
		const parent = parents[0];
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
		) {
			throw I.fail(
				"PARENT_UNAVAILABLE",
				"Unrevert requires a committed v2 revert journal in the same authorized owner/context",
			);
		}
		I.metadata(parent);
	}

	private async assertScope(tx: Tx, identity: FileIdentity): Promise<void> {
		const rows = await tx
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
			.where(eq(fileChangeScopes.id, identity.scopeId));
		const scope = rows[0] as
			| (Parameters<typeof createFileChangeIdentity>[0] & { status: string })
			| undefined;
		if (!scope || scope.status !== "active") {
			throw I.fail("TARGET_UNVERIFIED", "A verified active scope is required");
		}
		if (!I.equal(createFileChangeIdentity(scope, identity), identity)) {
			throw I.fail(
				"IDENTITY_CONFLICT",
				"Identity does not match its actual source/device/workspace/path scope",
			);
		}
	}

	/**
	 * The pinned-evidence recheck, in PG spelling: the SQLite section's
	 * `json_extract(state, '$.blob.sizeBytes')` becomes
	 * `(state::jsonb #>> '{…}')::bigint`, and its `IS NOT` null-safe inequality
	 * becomes `IS DISTINCT FROM`.
	 */
	private async assertPinnedRefsStillReady(tx: Tx, planId: string): Promise<void> {
		const before = alias(fileChangeBlobs, "revert_expected_blob");
		const desired = alias(fileChangeBlobs, "revert_desired_blob");
		const rows = await tx
			.select({ id: revertOperationFiles.id })
			.from(revertOperationFiles)
			.leftJoin(before, eq(revertOperationFiles.beforeBlobDigest, before.digest))
			.leftJoin(desired, eq(revertOperationFiles.desiredBlobDigest, desired.digest))
			.leftJoin(fileChangeScopes, eq(revertOperationFiles.scopeId, fileChangeScopes.id))
			.where(
				and(
					eq(revertOperationFiles.revertOperationId, planId),
					sql`(
				${revertOperationFiles.status} != 'prepared' OR ${fileChangeScopes.status} IS DISTINCT FROM 'active'
				OR (${revertOperationFiles.beforeBlobDigest} IS NOT NULL AND (${before.status} IS DISTINCT FROM 'ready'
					OR ${before.sizeBytes} IS DISTINCT FROM coalesce((${revertOperationFiles.expectedStateJson}::jsonb #>> '{blob,sizeBytes}')::bigint, (${revertOperationFiles.expectedStateJson}::jsonb #>> '{target,sizeBytes}')::bigint)))
				OR (${revertOperationFiles.desiredBlobDigest} IS NOT NULL AND (${desired.status} IS DISTINCT FROM 'ready'
					OR ${desired.sizeBytes} IS DISTINCT FROM coalesce((${revertOperationFiles.desiredStateJson}::jsonb #>> '{blob,sizeBytes}')::bigint, (${revertOperationFiles.desiredStateJson}::jsonb #>> '{target,sizeBytes}')::bigint)))
			)`,
				),
			)
			.limit(1);
		if (rows[0]) {
			throw I.fail(
				"BLOB_NOT_READY",
				"Pinned file evidence or scope became unavailable during preparation",
			);
		}
	}

	private async selectFiles(
		db: Pick<BunSQLDatabase, "select">,
		planId: string,
		cursor: RevertPlanFileCursor | undefined,
		limit: number,
	): Promise<FileRecord[]> {
		return (await db
			.select()
			.from(revertOperationFiles)
			.where(
				and(
					eq(revertOperationFiles.revertOperationId, planId),
					cursor ? sql`${revertOperationFiles.fileKey} > ${cursor.fileKey}` : undefined,
				),
			)
			.orderBy(asc(revertOperationFiles.fileKey))
			.limit(limit)) as FileRecord[];
	}

	private assertPlanned(row: PlanRecord) {
		if (
			row.protocolVersion !== FILE_CHANGE_EVIDENCE_VERSION ||
			row.expectedMessageVersion === null
		) {
			throw I.fail("LEGACY_UNVERIFIED", "A full v2 plan declaration is required");
		}
		I.integer(row.fileCount, "expectedFileCount", 0, FILE_CHANGE_LIMITS.revertFiles);
		if (
			row.status !== "planned" ||
			row.coverageComplete ||
			row.appliedFileCount !== 0 ||
			!row.planHash
		) {
			throw I.fail("INVALID_TRANSITION", "Only an incomplete unattempted plan accepts preparation");
		}
	}

	// ── the write operations ──

	/** One short durable transaction pins the original manifests, never their trimmed replacement. */
	async begin(input: BeginRevertPlan): Promise<RevertPlanSummary> {
		I.keys(input, [...HEADER_KEYS, "plan", "manifestProof"]);
		const header = I.normalizeHeader(input);
		const plan = I.normalizeRef(input.plan);
		const proof = I.normalizeProof(input.manifestProof);
		if (proof.headerDigest !== I.digest(header)) {
			throw I.fail("REQUEST_CONFLICT", "The verified manifest does not bind this header");
		}
		I.evidenceBudget(
			I.refBytes({ selector: header.selector, plan, historyManifest: header.historyManifest }) +
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
			planHash: I.planHash(header, plan, proof),
			expectedMessageVersion: header.expectedMessageVersion,
			parentRevertId: header.parentRevertId,
			fileCount: header.expectedFileCount,
		};
		return withPgRetry(
			() => this.database.transaction((tx) => this.beginSection(tx, values, header, plan)),
			{
				label: "revertPlan.begin",
			},
		);
	}

	private async beginSection(
		tx: Tx,
		values: {
			protocolVersion: number;
			narratorId: string | null;
			projectId: string | null;
			requestedBySubjectKey: string;
			idempotencyKey: string;
			requestDigest: string;
			kind: PlanRecord["kind"];
			scope: PlanRecord["scope"];
			selectorKind: PlanRecord["selectorKind"];
			selectorBlobDigest: string;
			planBlobDigest: string;
			historyManifestBlobDigest: string;
			planHash: string;
			expectedMessageVersion: number;
			parentRevertId: string | null;
			fileCount: number;
		},
		header: NormalizedHeader,
		plan: FileChangeBlobRef,
	): Promise<RevertPlanSummary> {
		const existingRows = (await tx
			.select()
			.from(revertOperations)
			.where(
				and(
					eq(revertOperations.requestedBySubjectKey, values.requestedBySubjectKey),
					eq(revertOperations.idempotencyKey, values.idempotencyKey),
				),
			)) as PlanRecord[];
		const existing = existingRows[0];
		if (existing) {
			for (const key of Object.keys(values) as (keyof typeof values)[]) {
				if (!I.equal(existing[key], values[key])) {
					throw I.fail(
						"REQUEST_CONFLICT",
						"An owner's idempotency key cannot change its complete request",
					);
				}
			}
			return this.summary(existing);
		}
		await this.assertNamespace(tx);
		for (const ref of [header.selector, plan, header.historyManifest]) {
			await this.requireReadyRef(tx, ref);
		}
		await this.assertParent(tx, values);
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
		I.metadata(row);
		const inserted = await tx.insert(revertOperations).values(row).returning();
		const record = inserted[0] as PlanRecord | undefined;
		if (!record) throw I.fail("JOURNAL_UNAVAILABLE", "Plan insert returned no row");
		return this.summary(record);
	}

	/** See the SQLite service: <=32 inserts per transaction, optimistic snapshot. */
	async appendFiles(
		owner: RevertPlanOwner,
		planId: string,
		inputs: AppendRevertPlanFile[],
		options: { signal?: AbortSignal } = {},
	): Promise<Pick<FileRecord, "id" | "fileKey" | "sequence">[]> {
		const context = I.normalizeOwner(owner);
		I.text(planId, "planId");
		I.integer(inputs.length, "batch size", 1, REVERT_PLAN_BATCH_ITEMS);
		const files = inputs.map(I.normalizeFile);
		if (
			new Set(files.map((f) => f.fileKey)).size !== files.length ||
			new Set(files.map((f) => f.sequence)).size !== files.length
		) {
			throw I.fail(
				"DUPLICATE_FILE",
				"The batch contains repeated file identities or sequence values",
			);
		}
		options.signal?.throwIfAborted();
		const original = await this.requireOwner(
			this.database as unknown as RootQueryable,
			context,
			planId,
		);
		this.assertPlanned(original);
		this.assertFresh(original);
		const manifestRefs = await this.refs(this.database as unknown as RootQueryable, original);
		let bytes = I.refBytes(manifestRefs);
		let count = 0;
		const sequences = new Map<number, string>();
		let cursor: RevertPlanFileCursor | undefined;
		for (;;) {
			options.signal?.throwIfAborted();
			const page = await this.selectFiles(
				this.database,
				planId,
				cursor,
				REVERT_PLAN_BATCH_ITEMS + 1,
			);
			for (const row of page.slice(0, REVERT_PLAN_BATCH_ITEMS)) {
				I.metadata(row);
				if (sequences.has(row.sequence)) {
					throw I.fail("DUPLICATE_FILE", "Stored sequence values repeat");
				}
				sequences.set(row.sequence, row.fileKey);
				count++;
				I.integer(count, "appended files", 0, original.fileCount);
				bytes +=
					I.stateBytes(I.normalizeState(row.expectedStateJson)) +
					I.stateBytes(I.normalizeState(row.desiredStateJson));
				I.evidenceBudget(bytes);
			}
			if (page.length <= REVERT_PLAN_BATCH_ITEMS) break;
			cursor = I.fileCursor(page[REVERT_PLAN_BATCH_ITEMS - 1]);
			await yieldToEventLoop();
		}
		options.signal?.throwIfAborted();
		return withPgRetry(
			() =>
				this.database.transaction((tx) =>
					this.appendSection(tx, context, planId, original, files, sequences, count, bytes),
				),
			{ label: "revertPlan.appendFiles" },
		);
	}

	private async appendSection(
		tx: Tx,
		context: RevertPlanOwner,
		planId: string,
		original: PlanRecord,
		files: NormalizedFile[],
		sequences: Map<number, string>,
		count: number,
		bytes: number,
	): Promise<Pick<FileRecord, "id" | "fileKey" | "sequence">[]> {
		const operation = await this.requireOwner(tx, context, planId);
		I.assertSameRevision(original, operation);
		this.assertPlanned(operation);
		this.assertFresh(operation);
		await this.refs(tx, operation);
		await this.assertParent(tx, operation);
		const results: Pick<FileRecord, "id" | "fileKey" | "sequence">[] = [];
		let changed = false;
		for (const file of files) {
			I.integer(file.sequence, "sequence", 0, operation.fileCount - 1);
			await this.assertScope(tx, file.identity);
			for (const ref of [I.stateRef(file.expected), I.stateRef(file.desired)]) {
				if (ref) await this.requireReadyRef(tx, ref);
			}
			const values = I.fileValues(operation, file);
			const existingRows = (await tx
				.select()
				.from(revertOperationFiles)
				.where(
					and(
						eq(revertOperationFiles.revertOperationId, planId),
						eq(revertOperationFiles.fileKey, file.fileKey),
					),
				)) as FileRecord[];
			const existing = existingRows[0];
			if (existing) {
				I.assertFileValues(existing, values);
				results.push({ id: existing.id, fileKey: existing.fileKey, sequence: existing.sequence });
				continue;
			}
			if (sequences.has(file.sequence)) {
				throw I.fail("DUPLICATE_FILE", "Another file owns this manifest position");
			}
			I.integer(++count, "appended files", 0, operation.fileCount);
			bytes += I.stateBytes(file.expected) + I.stateBytes(file.desired);
			I.evidenceBudget(bytes);
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
			I.metadata(row);
			await tx.insert(revertOperationFiles).values(row);
			results.push({ id: row.id, fileKey: row.fileKey, sequence: row.sequence });
			changed = true;
		}
		if (changed) {
			await tx
				.update(revertOperations)
				.set({ updatedAt: this.timestamp(operation.updatedAt) })
				.where(eq(revertOperations.id, planId));
		}
		return results;
	}

	/** The caller supplies the SAME explicit trusted full-coverage proof, never just a count. */
	async finalize(
		owner: RevertPlanOwner,
		planId: string,
		manifestProof: RevertPlanManifestProof,
		options: { signal?: AbortSignal } = {},
	): Promise<RevertPlanSummary> {
		const context = I.normalizeOwner(owner);
		I.text(planId, "planId");
		const proof = I.normalizeProof(manifestProof);
		options.signal?.throwIfAborted();
		const original = await this.requireOwner(
			this.database as unknown as RootQueryable,
			context,
			planId,
		);
		this.assertFresh(original);
		await this.assertProof(this.database as unknown as RootQueryable, original, proof);
		if (
			(original.status !== "planned" && original.status !== "prepared") ||
			original.appliedFileCount !== 0 ||
			original.coverageComplete !== (original.status === "prepared")
		) {
			throw I.fail("INVALID_TRANSITION", "Only an unattempted plan can be prepared");
		}
		const entries = new Map<number, string>();
		let fileBytes = 0;
		let cursor: RevertPlanFileCursor | undefined;
		for (;;) {
			options.signal?.throwIfAborted();
			const page = await withPgRetry(
				() =>
					this.database.transaction((tx) =>
						this.finalizeVerifySection(tx, context, planId, original, proof, entries, cursor),
					),
				{ label: "revertPlan.finalize.verify" },
			);
			fileBytes += page.fileBytes;
			if (page.rows.length <= REVERT_PLAN_BATCH_ITEMS) break;
			cursor = I.fileCursor(page.rows[REVERT_PLAN_BATCH_ITEMS - 1]);
			await yieldToEventLoop();
		}
		options.signal?.throwIfAborted();
		if (
			entries.size !== original.fileCount ||
			fileBytes !== proof.fileEvidenceBytes ||
			orderedDigest(entries) !== proof.orderedFilesDigest
		) {
			throw I.fail(
				"INCOMPLETE_SET",
				proof.computation === "partial"
					? "The actionable file subset or its metadata changed"
					: "Every declared file and its exact ordered metadata must match the complete manifest",
			);
		}
		return withPgRetry(
			() =>
				this.database.transaction((tx) =>
					this.finalizeCommitSection(tx, context, planId, original, proof),
				),
			{ label: "revertPlan.finalize.commit" },
		);
	}

	private async finalizeVerifySection(
		tx: Tx,
		context: RevertPlanOwner,
		planId: string,
		original: PlanRecord,
		proof: RevertPlanManifestProof,
		entries: Map<number, string>,
		cursor: RevertPlanFileCursor | undefined,
	): Promise<{ rows: FileRecord[]; fileBytes: number }> {
		const operation = await this.requireOwner(tx, context, planId);
		I.assertSameRevision(original, operation);
		this.assertFresh(operation);
		await this.assertProof(tx, operation, proof);
		const rows = await this.selectFiles(tx, planId, cursor, REVERT_PLAN_BATCH_ITEMS + 1);
		let fileBytes = 0;
		for (const row of rows.slice(0, REVERT_PLAN_BATCH_ITEMS)) {
			I.metadata(row);
			const file = I.normalizeFile({
				sequence: row.sequence,
				identity: row.identityJson,
				expected: row.expectedStateJson,
				desired: row.desiredStateJson,
			});
			I.integer(file.sequence, "sequence", 0, operation.fileCount - 1);
			I.assertFileValues(row, I.fileValues(operation, file));
			await this.assertScope(tx, file.identity);
			for (const ref of [I.stateRef(file.expected), I.stateRef(file.desired)]) {
				if (ref) await this.requireReadyRef(tx, ref);
			}
			if (entries.has(file.sequence)) {
				throw I.fail("DUPLICATE_FILE", "Stored manifest positions repeat");
			}
			entries.set(file.sequence, I.digest(file));
			I.integer(entries.size, "verified files", 0, operation.fileCount);
			fileBytes += I.stateBytes(file.expected) + I.stateBytes(file.desired);
			I.evidenceBudget(fileBytes);
		}
		return { rows, fileBytes };
	}

	private async finalizeCommitSection(
		tx: Tx,
		context: RevertPlanOwner,
		planId: string,
		original: PlanRecord,
		proof: RevertPlanManifestProof,
	): Promise<RevertPlanSummary> {
		const operation = await this.requireOwner(tx, context, planId);
		I.assertSameRevision(original, operation);
		this.assertFresh(operation);
		await this.assertProof(tx, operation, proof);
		await this.assertParent(tx, operation);
		await this.assertPinnedRefsStillReady(tx, planId);
		if (operation.status === "prepared" && operation.coverageComplete) {
			return this.summary(operation);
		}
		this.assertPlanned(operation);
		const updated = await tx
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
			.returning();
		const row = updated[0] as PlanRecord | undefined;
		if (!row) {
			throw I.fail(
				"CONCURRENT_CHANGE",
				"The plan changed between preparation pages; retry from the beginning",
			);
		}
		return this.summary(row);
	}
}

/** Same construction as the SQLite service's private `orderedDigest`. */
function orderedDigest(entries: Map<number, string>): string {
	const hash = createHash("sha256").update("revert-plan-ordered-files-v1\n");
	for (let sequence = 0; sequence < entries.size; sequence++) {
		const entry = entries.get(sequence);
		if (!entry) throw I.fail("INCOMPLETE_SET", "The ordered manifest has a missing position");
		hash.update(`${sequence}:${entry}\n`);
	}
	return hash.digest("hex");
}

/**
 * Compose the store over a caller-supplied handle. Nothing here opens a
 * connection — tests and the future composition root build their own.
 */
export function createPostgresRevertPlanStore(
	database: BunSQLDatabase,
	options: { namespaceKey: string; now?: () => string; ttlMs?: number },
): PostgresRevertPlanStore {
	return new PostgresRevertPlanStore(database, options);
}
