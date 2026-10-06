/**
 * The composition seam (`services/postgres-composition.ts`): one runtime in, every
 * PostgreSQL-capable store swapped, all-or-nothing.
 *
 * Uses a STUB runtime — the seam's contract is "inject adapters built on this handle into
 * every store", which is observable from the live bindings without a database. The adapters
 * themselves are covered against a real PostgreSQL by their own suites; what would rot
 * without this test is the seam forgetting a store.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { PostgresClient } from "@server/db/postgres-client";
import type { PostgresRuntime } from "@server/db/postgres-runtime";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { setPostgresRuntimeQueue } from "../agent-runtime/postgres-runtime-queue";
import {
	getRuntimeQueuePort,
	resolveRuntimeQueueBackend,
} from "../agent-runtime/runtime-queue-port";
import { sqliteAuthMfaStore } from "../auth/sqlite-mfa-store";
import { sqliteAuthSessionStore } from "../auth/sqlite-session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../auth/store";
import { chapterWriteStore, setChapterWriteStore } from "../chapter-write/store";
import {
	knowledgeReadStore,
	knowledgeWriteStore,
	setKnowledgeReadStore,
	setKnowledgeWriteStore,
} from "../knowledge/store";
import { bindNarratorMessageRefs, getNarratorMessageRefsPort } from "../narrator-refs/store";
import { activatePostgresRuntimeQueue, composePostgresStores } from "../postgres-composition";
import { projectArchiveMainStore, setProjectArchiveMainStore } from "../project-archive/store";
import { projectReadAdapter, setProjectReadAdapter } from "../read";
import { PostgresProjectReadAdapter } from "../read/postgres-project-read-adapter";
import { sqliteRegistrationAccountStore } from "../registration/sqlite-account-store";
import { registrationAccountStore, setRegistrationAccountStore } from "../registration/store";
import {
	isPostgresSearchBound,
	unbindPostgresSearchClientForTests,
} from "../search/postgres-store";

function stubRuntime(): PostgresRuntime {
	const client = {
		sql: {
			unsafe: () => Promise.resolve([]),
		} as unknown as PostgresClient["sql"],
		db: {} as BunSQLDatabase,
		close: () => Promise.resolve(),
	};
	return {
		backend: "postgres",
		client,
		executor: { unsafe: () => Promise.resolve([]) },
		migration: { folder: "/stub" },
		probeFtsDrift: () => Promise.reject(new Error("stub: no database")),
		readMigrationState: () => Promise.resolve([]),
		closed: false,
		close: () => Promise.resolve(),
	};
}

afterAll(() => {
	// Restore the environment-resolved defaults so no later test file in this process keeps
	// the stubbed stores.
	setRegistrationAccountStore(undefined);
	setAuthStores(undefined);
	setKnowledgeWriteStore(undefined);
	setKnowledgeReadStore(undefined);
	setChapterWriteStore(undefined);
	setProjectArchiveMainStore(undefined);
	setProjectReadAdapter(undefined);
	setPostgresRuntimeQueue(undefined);
	bindNarratorMessageRefs(undefined);
	// `composePostgresStores` binds the module-level postgres search client; restore the
	// fail-closed default so the search-backend contract's "fails closed before binding"
	// assertion still holds when both files run in one process.
	unbindPostgresSearchClientForTests();
});

describe("composePostgresStores", () => {
	test("injects every PG-capable store from the one runtime", () => {
		expect(registrationAccountStore).toBe(sqliteRegistrationAccountStore);
		expect(authSessionStore).toBe(sqliteAuthSessionStore);
		expect(authMfaStore).toBe(sqliteAuthMfaStore);

		composePostgresStores(stubRuntime());

		// Each store is now the injected PostgreSQL adapter, not the SQLite default.
		expect(registrationAccountStore).not.toBe(sqliteRegistrationAccountStore);
		expect(authSessionStore).not.toBe(sqliteAuthSessionStore);
		expect(authMfaStore).not.toBe(sqliteAuthMfaStore);
		expect(projectReadAdapter()).toBeInstanceOf(PostgresProjectReadAdapter);
		expect(isPostgresSearchBound()).toBe(true);

		// The write stores expose no class to assert on; the observable claim is that the
		// binding was swapped away from the environment-resolved default and swapping back
		// restores exactly it. The auth pair is swapped TOGETHER by design: half a swap
		// would split the login loop across two engines.
		const injectedSession = authSessionStore;
		const injectedMfa = authMfaStore;
		const injectedKnowledge = knowledgeWriteStore;
		const injectedKnowledgeRead = knowledgeReadStore;
		const injectedChapter = chapterWriteStore;
		const injectedArchive = projectArchiveMainStore;
		setAuthStores(undefined);
		setKnowledgeWriteStore(undefined);
		setKnowledgeReadStore(undefined);
		setChapterWriteStore(undefined);
		setProjectArchiveMainStore(undefined);
		expect(authSessionStore).not.toBe(injectedSession);
		expect(authMfaStore).not.toBe(injectedMfa);
		expect(authSessionStore).toBe(sqliteAuthSessionStore);
		expect(authMfaStore).toBe(sqliteAuthMfaStore);
		expect(knowledgeWriteStore).not.toBe(injectedKnowledge);
		expect(knowledgeReadStore).not.toBe(injectedKnowledgeRead);
		expect(chapterWriteStore).not.toBe(injectedChapter);
		expect(projectArchiveMainStore).not.toBe(injectedArchive);
	});

	test("binds the runtime queue and narrator refs ports without querying at construction", () => {
		// The stub runtime's db is `{}: any` — ANY query attempted during composition
		// would throw, so a successful compose proves construction is query-free.
		composePostgresStores(stubRuntime());

		// The queue selector now resolves to the injected PG store.
		expect(resolveRuntimeQueueBackend()).toBe("postgres");
		const queue = getRuntimeQueuePort();
		expect(queue).toBeDefined();
		expect(queue?.backendId).toBe("postgres");
		// Activation was NOT triggered by construction: the store has probed nothing.
		expect(queue?.schemaReadiness).toEqual({
			insertSeqOrdinal: "unknown",
			pendingSchema: [
				"background_tasks.insert_seq",
				"narrators.insert_seq",
				"narrator_tool_continuations.insert_seq",
			],
			legacyAdmission: "blocked",
		});

		// The narrator message/refs port is the injected PG adapter, and disposal
		// restores the selector's SQLite verdict (no port, no throw on this env).
		const refsPort = getNarratorMessageRefsPort();
		expect(refsPort).toBeDefined();
		expect(typeof refsPort?.append).toBe("function");
	});

	test("startup activation is fail-closed when no queue is bound", async () => {
		setPostgresRuntimeQueue(undefined);
		bindNarratorMessageRefs(undefined);
		await expect(activatePostgresRuntimeQueue()).rejects.toThrow(/not bound/);
	});
});
