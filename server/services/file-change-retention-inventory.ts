import type { Database, SQLQueryBindings } from "bun:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import { FILE_CHANGE_BLOB_BUDGET_ID } from "./file-change-blob-catalog";

export const FILE_CHANGE_RETENTION_INVENTORY_LIMITS = Object.freeze({
	pageItems: FILE_CHANGE_LIMITS.historyPageItems,
	summaryBytes: FILE_CHANGE_LIMITS.summaryBytes,
	metadataBytes: FILE_CHANGE_LIMITS.summaryBytes,
	queries: 512,
	referenceRoots: 32,
	schemaObjects: 2048,
	schemaTables: 256,
	pragmaRows: 64,
	defaultDurationMs: 250,
	maximumDurationMs: 1000,
	slowMs: 50,
});
const LIMITS = FILE_CHANGE_RETENTION_INVENTORY_LIMITS;
const KEY_BYTES = 256;
const DIGEST = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-zA-Z_][a-zA-Z_0-9]*$/;
const BLOB_STATUSES = ["staging", "ready", "missing", "expired"] as const;

/** JSON -> reverse FK agreement is NOT enforced by the current schema. */
const STATE_ROOTS: Readonly<Record<string, string>> = Object.freeze({
	"file_change_effects.before_blob_digest": "before_state_json",
	"file_change_effects.intended_after_blob_digest": "intended_after_state_json",
	"file_change_effects.observed_after_blob_digest": "observed_after_state_json",
	"revert_operation_files.before_blob_digest": "expected_state_json",
	"revert_operation_files.desired_blob_digest": "desired_state_json",
	"revert_operation_files.observed_after_blob_digest": "observed_after_state_json",
	"revert_operation_files.compensation_after_blob_digest": "compensation_after_state_json",
});
const REQUIRED_ROOTS = [
	...Object.keys(STATE_ROOTS),
	"snapshot_captures.manifest_blob_digest",
	"revert_operations.selector_blob_digest",
	"revert_operations.plan_blob_digest",
	"revert_operations.history_manifest_blob_digest",
	"file_change_blob_reservations.blob_digest",
];

export interface FileChangeRetentionInventoryCursor {
	version: 1;
	namespaceKey: string;
	generation: number;
	schemaVersion: number;
	/** Frozen age decision, NOT a transaction/snapshot spanning pages. */
	cutoff: string;
	upperDigest: string;
	afterDigest: string | null;
}
export interface FileChangeRetentionInventoryRoot {
	table: string;
	column: string;
	index: string | null;
	stateColumn: string | null;
}
export interface FileChangeRetentionInventoryIssue {
	code: string;
	root?: string;
	stage?: string;
}
export interface FileChangeRetentionInventoryItem {
	id: string | null;
	digest: string;
	sizeBytes: number | null;
	catalogStatus: (typeof BLOB_STATUSES)[number] | "unknown";
	createdAt: string | null;
	updatedAt: string | null;
	leaseUntil: string | null;
	gcGeneration: number | null;
	/** Indices into page.referenceRoots; shared hashes appear only once per traversal. */
	references: number[];
	/** LIMIT 1 witnesses only; consistent samples cannot certify the rest of a root. */
	inconsistentStateSamples: number[];
	indexedReferences: "present" | "none_observed" | "unknown";
	retention: "retained" | "unknown";
	/** Only an index miss, not proof that typed JSON/manifests do not refer to it. */
	potentiallyUnreferenced: boolean;
	candidate: false;
	reasons: string[];
}
export interface FileChangeRetentionInventoryMetrics {
	queries: number;
	referenceProbes: number;
	/** Includes bounded typed JSON inspected inside SQLite, never returned as body data. */
	metadataBytes: number;
	responseBytes: number;
	durationMs: number;
}
export interface FileChangeRetentionInventoryPage {
	readOnly: true;
	noDeletionAuthority: true;
	physicalInventory: "not_checked";
	temporaryInventory: "not_checked";
	referenceCompleteness: "unknown";
	typedStateReverseIntegrity: "not_enforced";
	status: "exhausted" | "page" | "cancelled" | "budget_exceeded" | "read_failed";
	/** True only for the bounded catalog traversal, NEVER physical/root completeness. */
	catalogWindowExhausted: boolean;
	cutoff: string;
	graceCutoff: string;
	namespaceStatus: "ready" | "unverified" | "reconciling" | "unknown";
	pendingReservations: "present" | "none_observed" | "unknown";
	referenceRoots: FileChangeRetentionInventoryRoot[];
	issues: FileChangeRetentionInventoryIssue[];
	items: FileChangeRetentionInventoryItem[];
	nextCursor: FileChangeRetentionInventoryCursor | null;
	metrics: FileChangeRetentionInventoryMetrics;
}
export interface FileChangeRetentionInventoryOptions {
	/** Trusted maintenance caller injects a ROOT SQLite connection or a worker read connection.
	 * No application DB import, open(), automatic startup hook, content lookup or ACL bypass.
	 * An authenticated caller identity must be established outside this internal service;
	 * neither this label nor any digest is an authorization capability. */
	db: Pick<Database, "query" | "inTransaction">;
	maintenanceCaller: { kind: "maintenance"; subjectKey: string };
	namespaceKey: string;
	expectedGeneration: number;
	durationMs?: number;
	onSlow?: (
		event: FileChangeRetentionInventoryMetrics & { service: "file-change-retention" },
	) => void;
}
export class FileChangeRetentionInventoryError extends Error {
	readonly readOnly = true;
	readonly noDeletionAuthority = true;
	constructor(readonly code: string) {
		super(`File-change retention inventory: ${code}`);
		this.name = "FileChangeRetentionInventoryError";
	}
}
class PageStop extends Error {
	constructor(
		readonly code: "cancelled" | "budget_exceeded" | "read_failed",
		readonly stage: string,
	) {
		super(code);
	}
}
interface SchemaInventory {
	version: number;
	roots: FileChangeRetentionInventoryRoot[];
	issues: FileChangeRetentionInventoryIssue[];
}
interface BlobRow {
	id: string | null;
	digest: string | null;
	sizeBytes: number;
	status: string | null;
	leaseUntil: string | null;
	leaseValid: number;
	gcGeneration: number;
	createdAt: string | null;
	updatedAt: string | null;
	storageKeyValid: number;
}
interface NamespaceState {
	status: "ready" | "unverified" | "reconciling";
	pending: boolean;
	issues: FileChangeRetentionInventoryIssue[];
}

/**
 * A finite metadata page may run on the request thread: every corpus read is an
 * indexed keyset or LIMIT 1 probe, never COUNT/SUM/GROUP BY/JSON corpus scanning.
 * Schema discovery is also bounded (SQLite schema rowid + bounded PRAGMA metadata),
 * cached ONLY across an unchanged schema_version. Future FK roots are discovered,
 * not silently omitted; missing/partial/non-BINARY indexes are never scan fallbacks.
 *
 * Entire-corpus audits, physical/staging enumeration, transitive manifest marking,
 * JSON/reverse-index verification and any future GC MUST run in a coordinated worker.
 * This service does none of them. In particular it intentionally emits ZERO deletion
 * candidates until durable schema-level pin integrity exists and is separately audited.
 * LIMIT 1 JSON witnesses catch some corrupt pins but cannot prove unseen JSON is safe.
 * Retention does not depend on narrator deletion, COW, skipRevert, settlement, plan TTL,
 * or the 30-day recovery policy: an extant FK always pins, including settled reservations.
 *
 * Digest keysets use the existing UNIQUE index (no missing created_at/id index needed).
 * The cursor freezes its upper key, cutoff, namespace and generation, so equal-millisecond
 * blobs are not lost and aging cannot change page predicates. Concurrent inserts behind
 * the cursor are NOT covered by a repeatable snapshot. Even exhaustion is not a GC proof.
 * No transaction spans an await, and every page yields (also every 16 witnesses).
 * Cancellation/deadlines are checked between bounded statements; SQLite cannot be
 * preempted by AbortSignal. A caller needing hard IO deadlines must use a worker.
 */
export class FileChangeRetentionInventory {
	private readonly options: FileChangeRetentionInventoryOptions;
	private schema: SchemaInventory | undefined;

	constructor(options: FileChangeRetentionInventoryOptions) {
		key(options.namespaceKey);
		if (options.maintenanceCaller?.kind !== "maintenance") invalid();
		key(options.maintenanceCaller.subjectKey);
		integer(options.expectedGeneration);
		integer(options.durationMs ?? LIMITS.defaultDurationMs, LIMITS.maximumDurationMs, 1);
		this.options = { ...options, maintenanceCaller: { ...options.maintenanceCaller } };
	}

	async listPage(input: {
		signal: AbortSignal;
		limit?: number;
		cursor?: FileChangeRetentionInventoryCursor;
	}): Promise<FileChangeRetentionInventoryPage> {
		if (!(input.signal instanceof AbortSignal)) invalid();
		const limit = input.limit ?? LIMITS.pageItems;
		integer(limit, LIMITS.pageItems, 1);
		const cursor = input.cursor ? this.validateCursor(input.cursor) : undefined;
		const cutoff = cursor?.cutoff ?? new Date().toISOString();
		const graceCutoff = new Date(
			Date.parse(cutoff) - FILE_CHANGE_LIMITS.unreferencedGraceMs,
		).toISOString();
		const meter = new ReadBudget(this.options, input.signal);
		const page: FileChangeRetentionInventoryPage = {
			readOnly: true,
			noDeletionAuthority: true,
			physicalInventory: "not_checked",
			temporaryInventory: "not_checked",
			referenceCompleteness: "unknown",
			typedStateReverseIntegrity: "not_enforced",
			status: "page",
			catalogWindowExhausted: false,
			cutoff,
			graceCutoff,
			namespaceStatus: "unknown",
			pendingReservations: "unknown",
			referenceRoots: [],
			issues: [
				{ code: "typed_state_reverse_constraints_missing" },
				{ code: "transitive_manifest_references_not_checked" },
				{ code: "physical_and_temporary_inventory_not_checked" },
				{ code: "concurrent_publication_not_a_snapshot" },
			],
			items: [],
			nextCursor: cursor ?? null,
			metrics: {
				queries: 0,
				referenceProbes: 0,
				metadataBytes: 0,
				responseBytes: 0,
				durationMs: 0,
			},
		};
		try {
			await yieldToEventLoop();
			meter.check("page_start");
			const timeout = meter.read<{ timeout: number }>("PRAGMA busy_timeout", [], 1, 128)[0]
				?.timeout;
			const foreignKeys = meter.read<{ foreign_keys: number }>("PRAGMA foreign_keys", [], 1, 128)[0]
				?.foreign_keys;
			if (timeout === undefined || timeout < 0 || timeout > 250 || foreignKeys !== 1)
				throw new FileChangeRetentionInventoryError("connection_not_supported");
			const version = this.schemaVersion(meter);
			if (cursor && cursor.schemaVersion !== version)
				throw new FileChangeRetentionInventoryError("schema_changed");
			if (this.schema?.version !== version) this.schema = discoverSchema(meter, version);
			page.referenceRoots = this.schema.roots.map((root) => ({ ...root }));
			page.issues.push(...this.schema.issues.map((issue) => ({ ...issue })));
			this.applyNamespace(page, this.readNamespace(meter));
			const upper =
				cursor?.upperDigest ??
				meter.read<{ digest: string | null }>(
					`SELECT CASE WHEN length(CAST(digest AS BLOB)) = 64 THEN digest END AS digest
				 FROM main.file_change_blobs INDEXED BY idx_fc_blob_digest ORDER BY file_change_blobs.digest DESC LIMIT 1`,
					[],
					1,
					128,
				)[0]?.digest;
			if (upper === null || (upper !== undefined && !DIGEST.test(upper)))
				throw new FileChangeRetentionInventoryError("invalid_blob_digest");
			if (upper !== undefined) {
				page.nextCursor = {
					version: 1,
					namespaceKey: this.options.namespaceKey,
					generation: this.options.expectedGeneration,
					schemaVersion: version,
					cutoff,
					upperDigest: upper,
					afterDigest: cursor?.afterDigest ?? null,
				};
				// Reserve fence/response work; metadata-heavy schemas may return a smaller page.
				const pageLimit = Math.min(
					limit,
					Math.floor((meter.remainingMetadata - FILE_CHANGE_LIMITS.metadataBytes) / 2048) - 1,
				);
				if (pageLimit < 1) throw new PageStop("budget_exceeded", "blob_page_metadata");
				const rows = meter.read<BlobRow>(
					`SELECT CASE WHEN length(CAST(id AS BLOB)) <= ${KEY_BYTES} THEN id END AS id,
					 CASE WHEN length(CAST(digest AS BLOB)) = 64 THEN digest END AS digest,
					 CASE WHEN typeof(size_bytes) = 'integer' THEN size_bytes END AS sizeBytes,
					 CASE WHEN length(CAST(status AS BLOB)) <= 32 THEN status END AS status,
					 CASE WHEN length(CAST(lease_until AS BLOB)) = 24 THEN lease_until END AS leaseUntil,
					 (lease_until IS NULL OR length(CAST(lease_until AS BLOB)) = 24) AS leaseValid,
					 CASE WHEN typeof(gc_generation) = 'integer' THEN gc_generation END AS gcGeneration,
					 CASE WHEN length(CAST(created_at AS BLOB)) = 24 THEN created_at END AS createdAt,
					 CASE WHEN length(CAST(updated_at AS BLOB)) = 24 THEN updated_at END AS updatedAt,
					 CASE WHEN length(CAST(digest AS BLOB)) = 64 THEN
					 storage_key = 'sha256/' || substr(digest, 1, 2) || '/' || digest ELSE 0 END AS storageKeyValid
					 FROM main.file_change_blobs INDEXED BY idx_fc_blob_digest
					 WHERE digest > ? AND digest <= ? ORDER BY file_change_blobs.digest LIMIT ?`,
					[cursor?.afterDigest ?? "", upper, pageLimit + 1],
					pageLimit + 1,
					2048,
				);
				let responseBytes = jsonBytes(page);
				for (const row of rows.slice(0, pageLimit)) {
					meter.check("blob_page");
					if (!row.digest || !DIGEST.test(row.digest))
						throw new FileChangeRetentionInventoryError("invalid_blob_digest");
					const item = this.inspectBlob(meter, row as BlobRow & { digest: string }, page);
					responseBytes += jsonBytes(item) + 1;
					if (responseBytes > LIMITS.summaryBytes - FILE_CHANGE_LIMITS.metadataBytes)
						throw new PageStop("budget_exceeded", "response_bytes");
					page.items.push(item);
					page.nextCursor = { ...page.nextCursor, afterDigest: row.digest };
					if (page.items.length % 16 === 0) await yieldToEventLoop();
				}
				page.catalogWindowExhausted = rows.length <= pageLimit;
			} else {
				page.catalogWindowExhausted = true;
			}
			// Fence the whole page after every yield and all observations. Never return a stale candidate.
			this.applyNamespace(page, this.readNamespace(meter));
			if (this.schemaVersion(meter) !== version)
				throw new FileChangeRetentionInventoryError("schema_changed");
			meter.check("page_end");
			page.status = page.catalogWindowExhausted ? "exhausted" : "page";
			if (page.catalogWindowExhausted) page.nextCursor = null;
		} catch (error) {
			if (!(error instanceof PageStop)) throw error;
			page.status = error.code;
			page.catalogWindowExhausted = false;
			page.issues.push({ code: error.code, stage: error.stage });
			// A partial page has not completed the final namespace/generation fence.
			for (const item of page.items) {
				item.retention = "unknown";
				item.reasons.push("page_fence_incomplete");
			}
		}
		page.metrics = meter.metrics();
		// The byte count contains itself; converge even across a decimal digit boundary.
		for (let n = 0; n < 4; n++) {
			const bytes = jsonBytes(page);
			if (page.metrics.responseBytes === bytes) break;
			page.metrics.responseBytes = bytes;
		}
		if (page.metrics.responseBytes > LIMITS.summaryBytes)
			throw new FileChangeRetentionInventoryError("response_budget_exceeded");
		if (page.metrics.durationMs >= LIMITS.slowMs) {
			// Observability cannot erase the inventory or expose SQL/body/namespace data.
			try {
				this.options.onSlow?.({ service: "file-change-retention", ...page.metrics });
			} catch {}
		}
		return page;
	}

	private schemaVersion(meter: ReadBudget): number {
		const version = meter.read<{ schema_version: number }>(
			"PRAGMA main.schema_version",
			[],
			1,
			128,
		)[0]?.schema_version;
		if (!safeInteger(version))
			throw new FileChangeRetentionInventoryError("invalid_schema_version");
		return version;
	}

	private validateCursor(
		input: FileChangeRetentionInventoryCursor,
	): FileChangeRetentionInventoryCursor {
		if (
			!input ||
			typeof input !== "object" ||
			Array.isArray(input) ||
			![Object.prototype, null].includes(Object.getPrototypeOf(input))
		)
			invalid();
		if (
			Reflect.ownKeys(input).some(
				(field) =>
					typeof field !== "string" ||
					!Object.hasOwn(Object.getOwnPropertyDescriptor(input, field) ?? {}, "value"),
			)
		)
			invalid();
		const fields = [
			"version",
			"namespaceKey",
			"generation",
			"schemaVersion",
			"cutoff",
			"upperDigest",
			"afterDigest",
		];
		if (
			Object.keys(input).length !== fields.length ||
			Object.keys(input).some((field) => !fields.includes(field))
		)
			invalid();
		if (input.version !== 1 || !iso(input.cutoff) || input.cutoff > new Date().toISOString())
			invalid();
		if (input.namespaceKey !== this.options.namespaceKey)
			throw new FileChangeRetentionInventoryError("namespace_mismatch");
		if (input.generation !== this.options.expectedGeneration)
			throw new FileChangeRetentionInventoryError("generation_changed");
		integer(input.schemaVersion);
		if (typeof input.upperDigest !== "string" || !DIGEST.test(input.upperDigest)) invalid();
		if (
			input.afterDigest !== null &&
			(typeof input.afterDigest !== "string" ||
				!DIGEST.test(input.afterDigest) ||
				input.afterDigest > input.upperDigest)
		)
			invalid();
		return { ...input };
	}

	private readNamespace(meter: ReadBudget): NamespaceState {
		const rows = meter.read<{
			id: string;
			namespaceKey: string;
			generation: number;
			status: NamespaceState["status"];
			reservedBytes: number;
			usedBytes: number;
			quotaBytes: number;
			reconciledAt: string | null;
		}>(
			`SELECT CASE WHEN length(CAST(id AS BLOB)) <= ${KEY_BYTES} THEN id END AS id,
			 CASE WHEN length(CAST(namespace_key AS BLOB)) <= ${KEY_BYTES} THEN namespace_key END AS namespaceKey,
			 CASE WHEN typeof(generation) = 'integer' THEN generation END AS generation,
			 CASE WHEN length(CAST(status AS BLOB)) <= 32 THEN status END AS status,
			 CASE WHEN typeof(reserved_bytes) = 'integer' THEN reserved_bytes END AS reservedBytes,
			 CASE WHEN typeof(used_bytes) = 'integer' THEN used_bytes END AS usedBytes,
			 CASE WHEN typeof(quota_bytes) = 'integer' THEN quota_bytes END AS quotaBytes,
			 CASE WHEN length(CAST(reconciled_at AS BLOB)) = 24 THEN reconciled_at END AS reconciledAt
			 FROM main.file_change_storage_budgets ORDER BY file_change_storage_budgets.id LIMIT 2`,
			[],
			2,
			4096,
		);
		const row = rows[0];
		// Never select by the caller's namespace key: a second source key cannot bypass the singleton.
		if (
			rows.length !== 1 ||
			row?.id !== FILE_CHANGE_BLOB_BUDGET_ID ||
			row.namespaceKey !== this.options.namespaceKey
		)
			throw new FileChangeRetentionInventoryError(
				rows.length === 0 ? "namespace_unverified" : "namespace_mismatch",
			);
		if (row.generation !== this.options.expectedGeneration)
			throw new FileChangeRetentionInventoryError("generation_changed");
		if (
			!["unverified", "reconciling", "ready"].includes(row.status) ||
			![row.generation, row.reservedBytes, row.usedBytes, row.quotaBytes].every(safeInteger)
		)
			throw new FileChangeRetentionInventoryError("invalid_namespace_metadata");
		const issues: FileChangeRetentionInventoryIssue[] = [];
		if (row.status !== "ready" || !iso(row.reconciledAt))
			issues.push({ code: "namespace_unverified" });
		if (row.reservedBytes !== 0) issues.push({ code: "reserved_bytes_outstanding" });
		if (row.usedBytes > row.quotaBytes) issues.push({ code: "namespace_over_quota" });
		let pending = row.reservedBytes !== 0;
		// Seek successive distinct status keys; NOT DISTINCT/NOT IN over all reservations.
		let after: string | null = null;
		for (let n = 0; n < 4; n++) {
			const found: { status: string } | undefined = meter.read<{ status: string }>(
				`SELECT CASE WHEN length(CAST(status AS BLOB)) <= 32 THEN status ELSE '' END AS status FROM main.file_change_blob_reservations
				 INDEXED BY idx_fc_reservation_budget WHERE budget_id = ?${after === null ? "" : " AND status > ?"}
				 ORDER BY file_change_blob_reservations.status LIMIT 1`,
				after === null ? [row.id] : [row.id, after],
				1,
				256,
			)[0];
			if (!found) break;
			if (!["reserved", "settled", "reconcile_required"].includes(found.status)) {
				issues.push({ code: "invalid_reservation_status" });
				pending = true;
				break;
			}
			if (found.status !== "settled") pending = true;
			after = found.status;
		}
		if (pending) issues.push({ code: "pending_or_unacknowledged_reservation" });
		return { status: row.status, pending, issues };
	}

	private applyNamespace(page: FileChangeRetentionInventoryPage, namespace: NamespaceState): void {
		page.namespaceStatus = namespace.status;
		page.pendingReservations =
			namespace.pending || page.pendingReservations === "present" ? "present" : "none_observed";
		for (const issue of namespace.issues)
			if (!page.issues.some((current) => current.code === issue.code)) page.issues.push(issue);
	}

	private inspectBlob(
		meter: ReadBudget,
		row: BlobRow & { digest: string },
		page: FileChangeRetentionInventoryPage,
	): FileChangeRetentionInventoryItem {
		const roots = page.referenceRoots;
		const stateRoots = roots.filter((root) => root.index && root.stateColumn).length;
		const probeBound = roots.length * 32 + 128;
		const stateLimit = Math.min(
			FILE_CHANGE_LIMITS.metadataBytes,
			Math.max(0, Math.floor((meter.remainingMetadata - probeBound) / Math.max(1, stateRoots))),
		);
		const parameters: SQLQueryBindings[] = [];
		const expressions = roots.map((root, i) => {
			if (!root.index) return `0 AS r${i}`;
			const column = identifier(root.column);
			let witness = "1";
			if (root.stateColumn) {
				const state = identifier(root.stateColumn);
				const matches = (member: "blob" | "target") => `COALESCE(
					json_extract(${state}, '$.${member}.algorithm') = 'sha256'
					AND json_extract(${state}, '$.${member}.digest') = ${column}
					AND json_type(${state}, '$.${member}.sizeBytes') = 'integer'
					AND json_extract(${state}, '$.${member}.sizeBytes') = ?, 0)`;
				// CASE is lazy: oversized/malformed JSON is not parsed or returned. Low two
				// bits encode the witness; the rest account for actually inspected metadata.
				witness = `CASE WHEN ${state} IS NULL OR length(CAST(${state} AS BLOB)) > ${stateLimit} THEN 2
					ELSE 4 * length(CAST(${state} AS BLOB)) + CASE WHEN json_valid(${state}) = 0 THEN 2
					WHEN CASE json_extract(${state}, '$.kind')
					 WHEN 'regular' THEN ${matches("blob")} WHEN 'symlink' THEN ${matches("target")}
					 ELSE 0 END THEN 1 ELSE 2 END END`;
				parameters.push(
					safeInteger(row.sizeBytes) ? row.sizeBytes : -1,
					safeInteger(row.sizeBytes) ? row.sizeBytes : -1,
				);
			}
			parameters.push(row.digest);
			meter.referenceProbes++;
			return `COALESCE((SELECT ${witness} FROM main.${identifier(root.table)} INDEXED BY ${identifier(root.index)}
			 WHERE ${column} COLLATE BINARY = ? LIMIT 1), 0) AS r${i}`;
		});
		const witnesses = expressions.length
			? meter.read<Record<string, number>>(
					`SELECT ${expressions.join(",")} LIMIT 1`,
					parameters,
					1,
					probeBound,
				)[0]
			: {};
		const references: number[] = [];
		const inconsistent: number[] = [];
		let stateBytes = 0;
		for (let i = 0; i < roots.length; i++) {
			const value = witnesses?.[`r${i}`] ?? 0;
			stateBytes += Math.floor(value / 4);
			if (value % 4) references.push(i);
			if (value % 4 === 2) inconsistent.push(i);
		}
		meter.charge(stateBytes, "typed_state_metadata");
		const metadataValid =
			!!row.id &&
			safeInteger(row.sizeBytes) &&
			row.sizeBytes <= FILE_CHANGE_LIMITS.blobBytes &&
			safeInteger(row.gcGeneration) &&
			iso(row.createdAt) &&
			iso(row.updatedAt) &&
			row.leaseValid === 1 &&
			(row.leaseUntil === null || iso(row.leaseUntil)) &&
			row.storageKeyValid === 1 &&
			BLOB_STATUSES.includes(row.status as (typeof BLOB_STATUSES)[number]);
		const reasons: string[] = [];
		if (references.length) reasons.push("indexed_reference");
		if (inconsistent.length) reasons.push("typed_state_pin_mismatch_or_unreadable");
		if (!metadataValid) reasons.push("invalid_blob_metadata");
		if (row.status !== "ready") reasons.push("catalog_not_ready");
		if (row.gcGeneration !== this.options.expectedGeneration)
			reasons.push("blob_generation_unverified");
		if (
			(iso(row.createdAt) && row.createdAt > page.graceCutoff) ||
			(iso(row.updatedAt) && row.updatedAt > page.graceCutoff)
		)
			reasons.push("within_grace_period");
		if (iso(row.leaseUntil) && row.leaseUntil >= page.cutoff) reasons.push("active_blob_lease");
		if (!references.length) reasons.push("typed_state_reverse_integrity_unknown");
		const indexedComplete = !page.issues.some((issue) =>
			["missing_reference_root", "unsupported_reference_root", "missing_reference_index"].includes(
				issue.code,
			),
		);
		return {
			id: row.id,
			digest: row.digest,
			sizeBytes: safeInteger(row.sizeBytes) ? row.sizeBytes : null,
			catalogStatus: BLOB_STATUSES.includes(row.status as (typeof BLOB_STATUSES)[number])
				? (row.status as (typeof BLOB_STATUSES)[number])
				: "unknown",
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			leaseUntil: row.leaseUntil,
			gcGeneration: safeInteger(row.gcGeneration) ? row.gcGeneration : null,
			references,
			inconsistentStateSamples: inconsistent,
			indexedReferences: references.length
				? "present"
				: indexedComplete
					? "none_observed"
					: "unknown",
			retention:
				inconsistent.length || !metadataValid
					? "unknown"
					: references.length ||
							reasons.some((reason) =>
								["within_grace_period", "active_blob_lease", "catalog_not_ready"].includes(reason),
							)
						? "retained"
						: "unknown",
			potentiallyUnreferenced: !references.length && indexedComplete,
			candidate: false,
			reasons,
		};
	}
}

class ReadBudget {
	private readonly startedAt = performance.now();
	private queries = 0;
	private metadataBytes = 0;
	referenceProbes = 0;
	constructor(
		private readonly options: FileChangeRetentionInventoryOptions,
		private readonly signal: AbortSignal,
	) {}
	get remainingMetadata(): number {
		return LIMITS.metadataBytes - this.metadataBytes;
	}
	check(stage: string): void {
		if (this.signal.aborted) throw new PageStop("cancelled", stage);
		if (performance.now() - this.startedAt >= (this.options.durationMs ?? LIMITS.defaultDurationMs))
			throw new PageStop("budget_exceeded", "time");
		if (this.options.db.inTransaction)
			throw new FileChangeRetentionInventoryError("root_connection_required");
	}
	charge(bytes: number, stage: string): void {
		this.metadataBytes += bytes;
		if (this.metadataBytes > LIMITS.metadataBytes) throw new PageStop("budget_exceeded", stage);
	}
	read<T>(query: string, bindings: SQLQueryBindings[], rows: number, rowBytes: number): T[] {
		this.check("read");
		if (this.queries >= LIMITS.queries || rows * rowBytes > this.remainingMetadata)
			throw new PageStop("budget_exceeded", "read_budget");
		this.queries++;
		let result: T[];
		try {
			result = this.options.db.query<T, SQLQueryBindings[]>(query).all(...bindings);
		} catch {
			throw new PageStop("read_failed", "sqlite_read");
		}
		if (result.length > rows) throw new PageStop("budget_exceeded", "row_budget");
		this.charge(jsonBytes(result), "metadata_bytes");
		this.check("read_end");
		return result;
	}
	metrics(): FileChangeRetentionInventoryMetrics {
		return {
			queries: this.queries,
			referenceProbes: this.referenceProbes,
			metadataBytes: this.metadataBytes,
			responseBytes: 0,
			durationMs: Math.ceil(performance.now() - this.startedAt),
		};
	}
}

function discoverSchema(meter: ReadBudget, version: number): SchemaInventory {
	validatePagingIndexes(meter);
	const roots: FileChangeRetentionInventoryRoot[] = [];
	const issues: FileChangeRetentionInventoryIssue[] = [];
	let after = 0;
	let objects = 0;
	let tables = 0;
	for (;;) {
		const rows = meter.read<{ rowid: number; name: string; type: string }>(
			`SELECT rowid, ${schemaName("name")} AS name, type FROM main.sqlite_schema WHERE rowid > ? ORDER BY rowid LIMIT ?`,
			[after, LIMITS.pageItems],
			LIMITS.pageItems,
			512,
		);
		for (const row of rows) {
			after = row.rowid;
			if (++objects > LIMITS.schemaObjects) throw new PageStop("budget_exceeded", "schema_objects");
			if (row.type !== "table") continue;
			if (++tables > LIMITS.schemaTables) throw new PageStop("budget_exceeded", "schema_tables");
			if (!validIdentifier(row.name)) {
				issues.push({ code: "unsupported_reference_root", root: `schema_row_${row.rowid}` });
				if (issues.length > LIMITS.referenceRoots)
					throw new PageStop("budget_exceeded", "schema_issues");
				continue;
			}
			const fks = meter.read<{ id: number; seq: number; table: string; from: string; to: string }>(
				`SELECT id, seq, ${schemaName('"table"')} AS "table", ${schemaName('"from"')} AS "from",
				 ${schemaName('"to"')} AS "to" FROM pragma_foreign_key_list(?, 'main') LIMIT ?`,
				[row.name, LIMITS.pragmaRows + 1],
				LIMITS.pragmaRows + 1,
				1024,
			);
			if (fks.length > LIMITS.pragmaRows)
				throw new PageStop("budget_exceeded", "schema_foreign_keys");
			for (const fk of fks) {
				if (issues.length > LIMITS.referenceRoots)
					throw new PageStop("budget_exceeded", "schema_issues");
				if (!fk.table) {
					issues.push({ code: "unsupported_reference_root", root: row.name });
					continue;
				}
				if (fk.table !== "file_change_blobs") continue;
				const rootKey = `${row.name}.${fk.from}`;
				if (
					fk.to !== "digest" ||
					fk.seq !== 0 ||
					fks.some((other) => other.id === fk.id && other.seq !== 0) ||
					!validIdentifier(row.name) ||
					!validIdentifier(fk.from)
				) {
					issues.push({ code: "unsupported_reference_root", root: rootKey });
					continue;
				}
				if (roots.some((root) => root.table === row.name && root.column === fk.from)) continue;
				if (roots.length >= LIMITS.referenceRoots)
					throw new PageStop("budget_exceeded", "reference_roots");
				const index = referenceIndex(meter, row.name, fk.from);
				if (!index) issues.push({ code: "missing_reference_index", root: rootKey });
				roots.push({
					table: row.name,
					column: fk.from,
					index,
					stateColumn: STATE_ROOTS[rootKey] ?? null,
				});
			}
		}
		if (rows.length < LIMITS.pageItems) break;
	}
	for (const required of REQUIRED_ROOTS)
		if (!roots.some((root) => `${root.table}.${root.column}` === required))
			issues.push({ code: "missing_reference_root", root: required });
	return { version, roots, issues };
}

function referenceIndex(meter: ReadBudget, table: string, column: string): string | null {
	const indexes = meter.read<{ name: string; partial: number }>(
		`SELECT ${schemaName("name")} AS name, partial FROM pragma_index_list(?, 'main') LIMIT ?`,
		[table, LIMITS.pragmaRows + 1],
		LIMITS.pragmaRows + 1,
		384,
	);
	if (indexes.length > LIMITS.pragmaRows) throw new PageStop("budget_exceeded", "schema_indexes");
	for (const index of indexes) {
		if (index.partial || !validIdentifier(index.name)) continue;
		const first = meter.read<{ name: string; coll: string }>(
			`SELECT ${schemaName("name")} AS name, substr(coll, 1, 32) AS coll FROM pragma_index_xinfo(?, 'main') WHERE seqno = 0 LIMIT 1`,
			[index.name],
			1,
			512,
		)[0];
		if (first?.name === column && first.coll === "BINARY") return index.name;
	}
	return null;
}

function validatePagingIndexes(meter: ReadBudget): void {
	for (const spec of [
		{ table: "file_change_blobs", index: "idx_fc_blob_digest", columns: ["digest"], unique: true },
		{
			table: "file_change_blob_reservations",
			index: "idx_fc_reservation_budget",
			columns: ["budget_id", "status"],
			unique: false,
		},
	]) {
		const indexes = meter.read<{ name: string; partial: number; isUnique: number }>(
			`SELECT ${schemaName("name")} AS name, partial, "unique" AS isUnique FROM pragma_index_list(?, 'main') LIMIT ?`,
			[spec.table, LIMITS.pragmaRows + 1],
			LIMITS.pragmaRows + 1,
			384,
		);
		if (indexes.length > LIMITS.pragmaRows) throw new PageStop("budget_exceeded", "schema_indexes");
		const index = indexes.find((item) => item.name === spec.index);
		if (!index || index.partial !== 0 || (spec.unique && index.isUnique !== 1))
			throw new PageStop("read_failed", "required_paging_index");
		const columns = meter.read<{ name: string; coll: string; key: number }>(
			`SELECT ${schemaName("name")} AS name, substr(coll, 1, 32) AS coll, key FROM pragma_index_xinfo(?, 'main') LIMIT ?`,
			[spec.index, spec.columns.length + 1],
			spec.columns.length + 1,
			512,
		);
		if (
			spec.columns.some((name, i) => columns[i]?.name !== name || columns[i]?.coll !== "BINARY") ||
			(spec.unique && columns[spec.columns.length]?.key !== 0)
		)
			throw new PageStop("read_failed", "required_paging_index");
	}
	if (!referenceIndex(meter, "file_change_storage_budgets", "id"))
		throw new PageStop("read_failed", "namespace_identity_index");
}

/** Bounded ASCII identifiers only. Unusual/oversized names become explicit omissions,
 * never a truncated identifier that might query a DIFFERENT table or index. */
function schemaName(column: string): string {
	return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${KEY_BYTES} THEN
	 CASE WHEN ${column} NOT GLOB '*[^a-zA-Z_0-9]*' THEN ${column} ELSE '' END ELSE '' END`;
}

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}
function safeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function integer(value: number, maximum = Number.MAX_SAFE_INTEGER, minimum = 0): void {
	if (!safeInteger(value) || value < minimum || value > maximum) invalid();
}
function iso(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length === 24 &&
		!Number.isNaN(Date.parse(value)) &&
		new Date(value).toISOString() === value
	);
}
function key(value: string): void {
	if (
		typeof value !== "string" ||
		!value.length ||
		Buffer.byteLength(value) > KEY_BYTES ||
		[...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
	)
		invalid();
}
function validIdentifier(value: string): boolean {
	return typeof value === "string" && value.length <= KEY_BYTES && IDENTIFIER.test(value);
}
function identifier(value: string): string {
	if (!validIdentifier(value))
		throw new FileChangeRetentionInventoryError("invalid_schema_identifier");
	return `"${value}"`;
}
function invalid(): never {
	throw new FileChangeRetentionInventoryError("invalid_input");
}
