/**
 * agent-runtime/runtime-queue-port.ts — backend-neutral runtime queue shapes and the
 * ONE bound selector for the queue backend.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * Two things, deliberately co-located:
 *
 *   1. BACKEND-NEUTRAL DOMAIN SHAPES. `RuntimeMailboxRow`, the enqueue result, the
 *      pending-page entry and the publication run shapes are the vocabulary the
 *      cross-backend facade (caller-migration track) speaks. Neither dialect's schema
 *      type crosses this module: the SQLite `MailboxRow` and the PG `PgMailboxRow` are
 *      both structurally assignable to {@link RuntimeMailboxRow} (asserted at compile
 *      time in runtime-queue-port.test.ts), so each adapter can keep its own inferred
 *      row type and the facade never exposes either one.
 *
 *   2. THE BOUND SELECTOR. Exactly one module-level binding, installed by the
 *      composition seam (`services/postgres-composition.ts`) or by tests. Resolution
 *      follows the established selector semantics (`db/backend/read-selector.ts` /
 *      `write-selector.ts`, same pattern as `narrator-refs/store.ts`):
 *
 *        - SQLite is the default: no binding and no explicit configuration resolves to
 *          SQLite, and the PG port accessors return `undefined`.
 *        - Explicit PostgreSQL (`NF_WRITE_BACKEND=postgres`) WITHOUT an injected queue
 *          store throws — a process that believes it runs on PostgreSQL with no queue
 *          bound is a wiring bug, never a silent SQLite fallback.
 *        - A read/write backend mismatch throws via `assertWriteBackendMatchesRead`:
 *          one process reads and writes the same database.
 *
 *      Resolution happens at call time but performs NO per-request backend probing:
 *      the env selectors parse a string and the binding is a module-level constant
 *      between composition and disposal. No catalog/schema probe exists here at all —
 *      schema proof is the startup activation's job (`activateLegacyAdmission`).
 *
 * The runtime imports (`read-selector`, `write-selector`) are pure label parsers that
 * never open a connection; everything else imported here is type-only. This module
 * must stay free of database handles, drizzle tables and SQLite schema imports.
 */
import { selectReadBackend } from "../../db/backend/read-selector";
import { assertWriteBackendMatchesRead, selectWriteBackend } from "../../db/backend/write-selector";
import type { MailboxClaim, MailboxInput, NoticeKind, PayloadReference } from "./mailbox-types";
import type {
	MaterializedBinding,
	PgRuntimeTx,
	PostgresRuntimeQueue,
	RuntimeQueueSchemaReadiness,
} from "./postgres-runtime-queue";
import type {
	LegacyCompletionRegistration,
	LegacyPublicationProof,
	LegacyPublicationSource,
	PublicationEvent,
	PublicationIntent,
	PublicationRun,
} from "./publication-outbox";

// ─────────────────────────────────────────────────────────────────────────────
// Backend-neutral domain shapes
// ─────────────────────────────────────────────────────────────────────────────

export type RuntimeQueueBackendId = "sqlite" | "postgres";

/** Indexed receipt polling must never load a buffered payload or attachment metadata. */
export interface RuntimeBufferedDeliveryReceipt {
	id: string;
	state: string;
	recipientMessageId: string | null;
	lastError: string | null;
}

/**
 * The dialect-neutral mailbox row. Free-form and enum columns are typed `string`:
 * the SQLite schema narrows them to enum unions while the PG schema leaves them wide,
 * and the neutral shape is the COMMON SUPERSET both adapters can return without a
 * mapping layer. Consumers that need the narrowed union narrow it themselves.
 */
export interface RuntimeMailboxRow {
	id: string;
	narratorId: string;
	text: string;
	imagesJson: string | null;
	commandText: string | null;
	bashCommand: string | null;
	createdBy: string | null;
	creatorJson: string | null;
	textFilePathsJson: string | null;
	fileReferencesJson: string | null;
	priority: boolean;
	seq: number;
	bufferedAt: string;
	kind: string;
	noticeKind: string | null;
	envelopeVersion: number;
	metadataJson: string | null;
	sourceNarratorId: string | null;
	sourceToolCallId: string | null;
	sourceAttempt: number | null;
	sourceKey: string | null;
	dedupeKey: string | null;
	deliveryId: string | null;
	recipientMessageId: string | null;
	recipientRefId: string | null;
	currentMessageId: string | null;
	contentRevision: number;
	adoptedRevision: number | null;
	adoptedAt: string | null;
	currentRevision: number;
	currentAdoptedRevision: number | null;
	currentAdoptedAt: string | null;
	receiptDisposition: string;
	arrivalSeq: number | null;
	state: string;
	claimToken: string | null;
	claimEpoch: string | null;
	claimedAt: string | null;
	claimAttempts: number;
	lastError: string | null;
	byteSize: number;
	projectedByteSize: number;
	payloadRefJson: string | null;
	dedupeExpiresAt: string | null;
	updatedAt: string | null;
}

/** Enqueue verdict over the neutral row — same status vocabulary on both engines. */
export type RuntimeEnqueueResult =
	| { status: "accepted" | "duplicate"; delivery: RuntimeMailboxRow }
	| { status: "full" | "publication_pending" };

/** The bounded mailbox list projection (body/attachment columns deliberately absent). */
export interface RuntimeMailboxListEntry {
	id: string;
	kind: string;
	state: string;
	arrivalSeq: number | null;
	seq: number;
	priority: boolean;
	byteSize: number;
	deliveryId: string | null;
	receiptDisposition: string;
	lastError: string | null;
}

/**
 * Minimal ownership probe for file-backed buffered payload staging.
 * Implementations must return at most one row and must distinguish an empty result
 * from a rejected/failed lookup (the caller treats failures as retryable unknowns).
 */
export interface RuntimeMailboxStagingLookup {
	getByStagingId(narratorId: string, stagingId: string): Promise<RuntimeMailboxRow | undefined>;
}

/** One pending outbox intent in a bounded page; the cursor is the opaque text id. */
export interface RuntimePendingPageEntry {
	id: string;
	recipientId: string;
	producerKind: string;
	logicalRunId: string;
	arrivalSeq: number | null;
}

// Claim, input, binding and publication-run shapes are already dialect-neutral in
// their home modules; re-exported here (type-only, erased at runtime) so facade
// consumers have a single import site.
export type {
	LegacyCompletionRegistration,
	LegacyPublicationProof,
	LegacyPublicationSource,
	MailboxClaim,
	MailboxInput,
	MaterializedBinding,
	NoticeKind,
	PayloadReference,
	PublicationEvent,
	PublicationIntent,
	PublicationRun,
	RuntimeQueueSchemaReadiness,
};

/**
 * The bound queue port contract: the honestly-async adapter surface. Today exactly one
 * implementation exists (the PostgreSQL adapter); the SQLite facade adapter that wraps
 * the committed synchronous transaction results in Promises lands with the
 * caller-migration track. `PgRuntimeTx` is re-exposed for the named transaction-local
 * operations (materialize, recipient-ref updates) whose callers already hold a PG tx.
 */
export type RuntimeQueuePort = PostgresRuntimeQueue;
export type { PgRuntimeTx };

// ─────────────────────────────────────────────────────────────────────────────
// The bound selector
// ─────────────────────────────────────────────────────────────────────────────

export type RuntimeQueueBinding =
	| { backend: "sqlite" }
	| { backend: "postgres"; queue: RuntimeQueuePort };

let binding: RuntimeQueueBinding | undefined;

/** Composition root owns installation and disposal. Never casts a global handle. */
export function bindRuntimeQueue(value: RuntimeQueueBinding | undefined): void {
	binding = value;
}

/**
 * Which backend the runtime queue resolves to RIGHT NOW: the binding wins; otherwise
 * the explicit configuration decides, fail-closed and with the read/write consistency
 * check, exactly like the narrator-refs selector.
 */
export function resolveRuntimeQueueBackend(): RuntimeQueueBackendId {
	if (binding) return binding.backend;
	const write = selectWriteBackend(process.env.NF_WRITE_BACKEND, { postgresAvailable: false });
	assertWriteBackendMatchesRead(write, selectReadBackend(process.env.NF_READ_BACKEND));
	return write.backend;
}

/** The injected PostgreSQL queue port, or undefined when the process runs on SQLite. */
export function getRuntimeQueuePort(): RuntimeQueuePort | undefined {
	if (binding) return binding.backend === "postgres" ? binding.queue : undefined;
	const write = selectWriteBackend(process.env.NF_WRITE_BACKEND, { postgresAvailable: false });
	assertWriteBackendMatchesRead(write, selectReadBackend(process.env.NF_READ_BACKEND));
	return undefined;
}

/**
 * Fail-closed accessor for queue call sites on the PostgreSQL backend: an explicit
 * PostgreSQL process with no queue store injected is a wiring bug, not a SQLite
 * fallback. On an unbound SQLite process this also throws — callers that may run on
 * either engine must branch on {@link resolveRuntimeQueueBackend} first.
 */
export function requireRuntimeQueuePort(): RuntimeQueuePort {
	const port = getRuntimeQueuePort();
	if (!port)
		throw new Error(
			"PostgreSQL runtime queue is not bound: the composition seam " +
				"(services/postgres-composition.ts) must inject it before any queue call site runs. " +
				"There is no SQLite fallback from this accessor.",
		);
	return port;
}
