/**
 * The single composition seam for the PostgreSQL backend.
 *
 * Every PostgreSQL store adapter in this repository is deliberately INJECTED: the store
 * modules (`registration/store.ts`, `auth/store.ts`, `knowledge/store.ts`,
 * `chapter-write/store.ts`, `project-archive/store.ts`, `read/index.ts`,
 * `search/postgres-store.ts`) open no
 * connection and resolve to SQLite until someone hands them an adapter built on a real
 * runtime. This module is that someone — the ONE place production code turns
 * `server/db/index.ts`'s `postgresRuntime` into live stores.
 *
 * WHY A SINGLE SEAM
 * -----------------
 * The alternative — each store growing its own "am I postgres?" check — is how a deployment
 * ends up half on one engine and half on another, with no line of code able to say so. Here
 * the injection is all-or-nothing and sourced from ONE runtime: one client, one migration
 * baseline, one close. A store missing from {@link composePostgresStores} is a visible gap
 * in one function, not a fork distributed across five modules.
 *
 * The search store differs from the others: `search/backend.ts` resolves the BACKEND from
 * the same configuration at module load, and this composition BINDS the connection into the
 * already-registered PostgreSQL store (which fails closed until bound).
 */
import type { PostgresRuntime } from "@server/db/postgres-runtime";
import {
	createPostgresRuntimeQueue,
	type PostgresRuntimeQueue,
	RuntimeQueueSchemaPendingError,
	type RuntimeQueueSchemaReadiness,
	setPostgresRuntimeQueue,
} from "./agent-runtime/postgres-runtime-queue";
import { requireRuntimeQueuePort } from "./agent-runtime/runtime-queue-port";
import { createPostgresAuthMfaStore } from "./auth/postgres-mfa-store";
import { createPostgresAuthSessionStore } from "./auth/postgres-session-store";
import { setAuthStores } from "./auth/store";
import { createPostgresChapterWriteStore } from "./chapter-write/postgres-write-store";
import { setChapterWriteStore } from "./chapter-write/store";
import { createPostgresKnowledgeReadStore } from "./knowledge/postgres-read-store";
import { createPostgresKnowledgeWriteStore } from "./knowledge/postgres-write-store";
import { setKnowledgeReadStore, setKnowledgeWriteStore } from "./knowledge/store";
import { createPostgresNarratorMessageRefsPort } from "./narrator-refs/postgres-store";
import { bindNarratorMessageRefs } from "./narrator-refs/store";
import { createPostgresProjectArchiveMainStore } from "./project-archive/postgres-main-store";
import { setProjectArchiveMainStore } from "./project-archive/store";
import { setProjectReadAdapter } from "./read";
import { PostgresProjectReadAdapter } from "./read/postgres-project-read-adapter";
import { createPostgresRegistrationAccountStore } from "./registration/postgres-account-store";
import { setRegistrationAccountStore } from "./registration/store";
import { bindPostgresSearchClient } from "./search/postgres-store";

/**
 * Inject every PostgreSQL store from one runtime. Called once from `main.ts` startup, after
 * `server/db/index.ts` has finished the fail-fast runtime startup (connect → migrate → FTS).
 *
 * Not idempotent by design: a second call would mean a second runtime, and that is exactly
 * the split-brain shape the seam exists to prevent.
 */
export function composePostgresStores(runtime: PostgresRuntime): void {
	const db = runtime.client.db;
	setRegistrationAccountStore(createPostgresRegistrationAccountStore(db));
	// The auth loop (login lookup, session gate, MFA factors, token-generation revocation)
	// is one store pair over the same handle: a deployment can never register an account
	// on PostgreSQL and then verify its sessions against SQLite.
	setAuthStores({
		session: createPostgresAuthSessionStore(db),
		mfa: createPostgresAuthMfaStore(db),
	});
	setKnowledgeWriteStore(createPostgresKnowledgeWriteStore(db));
	setKnowledgeReadStore(createPostgresKnowledgeReadStore(db));
	setChapterWriteStore(createPostgresChapterWriteStore(db));
	setProjectArchiveMainStore(createPostgresProjectArchiveMainStore(db));
	setProjectReadAdapter(new PostgresProjectReadAdapter(db));
	// The runtime queue (mailbox + publication outbox). Constructed and bound here so the
	// caller-migration track has exactly one consumption point (`getPostgresRuntimeQueue`
	// / `requirePostgresRuntimeQueue`). Construction performs NO queries: the legacy-
	// admission surface stays fail-closed (`schemaReadiness.legacyAdmission === "blocked"`)
	// until {@link activatePostgresRuntimeQueue} runs the one bounded startup probe and
	// boundary capture — nothing here probes or fakes that verdict, and no queue call
	// site is re-pointed by this line.
	setPostgresRuntimeQueue(createPostgresRuntimeQueue(db));
	// The narrator message/refs port. Promise-shaped like every networked port; binding
	// it here is what turns the narrator-refs selector's fail-closed "unavailable" into
	// a live adapter — and makes the still-unmigrated narrator surfaces fail closed
	// against THIS port instead of reaching for the SQLite handle.
	bindNarratorMessageRefs({ backend: "postgres", port: createPostgresNarratorMessageRefsPort(db) });
	// The search store binds through the runtime executor, so the shutdown gate ("stop
	// accepting new PG operations") applies to search queries too.
	bindPostgresSearchClient(runtime.executor);
}

/**
 * The startup activation gate for the PostgreSQL runtime queue.
 *
 * Call ONCE from `main.ts`, after {@link composePostgresStores} and before
 * `Bun.serve()` accepts a request. This is the only production caller of
 * `activateLegacyAdmission()`: the `information_schema` probe, the three-table
 * `insert_seq` boundary capture and the quiescing lock run here and never again —
 * the request hot path neither re-probes the catalog nor captures a boundary.
 *
 * FAIL-CLOSED CONTRACT
 * --------------------
 *   - No bound queue (composition did not run, or the process is not on PostgreSQL):
 *     throws the selector's "not bound" error — never a SQLite fallback.
 *   - The probe finds an `insert_seq` identity column missing: the store reports
 *     `legacyAdmission: "blocked"` and this function throws a
 *     {@link RuntimeQueueSchemaPendingError} naming the exact pending columns.
 *   - Cancellation and timeout (the activation has an internal bounded deadline and
 *     honors the caller's signal): the activation error propagates unchanged and no
 *     boundary is published.
 *
 * A fulfilled promise is therefore proof that the full migration journal is applied
 * AND the legacy boundary is captured; the caller may proceed to cold-start recovery.
 */
export async function activatePostgresRuntimeQueue(
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RuntimeQueueSchemaReadiness> {
	const queue: PostgresRuntimeQueue = requireRuntimeQueuePort();
	const readiness = await queue.activateLegacyAdmission(options);
	if (readiness.legacyAdmission !== "available") {
		throw new RuntimeQueueSchemaPendingError(
			"startup.activateLegacyAdmission",
			readiness.pendingSchema,
			"schema",
		);
	}
	return readiness;
}
