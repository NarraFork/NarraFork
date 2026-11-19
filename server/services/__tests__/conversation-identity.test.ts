import { expect, mock, test } from "bun:test";
import { SQL } from "bun";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { withPostgres } from "../../../tests/db/pg-test-harness";
import { sqlite } from "../../db";
import { createPostgresClient } from "../../db/postgres-client";
import {
	type ContextQuery,
	postgresContextQuery,
	sqliteContextQuery,
} from "../context-composition-history";
import {
	claimConversationIdentity,
	createConversationIdentityStore,
	ensureConversationIdentityPersisted,
} from "../narrator-conversation-identity";
import {
	type ActiveNarrator,
	activeNarrators,
	resetActiveUpstreamSession,
	withNarratorMutationAdmission,
} from "../narrator-session-state";

// Settle worker I/O before Bun's synchronous throw matcher evaluates the rejection.
async function settledThrow(work: Promise<unknown>): Promise<() => never> {
	const [result] = await Promise.allSettled([work]);
	expect(result.status).toBe("rejected");
	if (result.status !== "rejected") throw new Error("Expected operation to reject");
	return () => {
		throw result.reason;
	};
}

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function seed(query: ContextQuery, id: string, identity: string | null = null) {
	await query.run(
		`INSERT INTO narrators (id, variant, status, api_conversation_id, created_at, updated_at)
		 VALUES (?, 'primary', 'idle', ?, 'now', 'now')`,
		[id, identity],
	);
}

/** The same contract runs against real SQLite and PostgreSQL adapters. Only the
 * scheduling gate is synthetic; every read, successful/failed CAS and clear hits SQL.
 */
async function identityContract(query: ContextQuery, other: ContextQuery) {
	const store = createConversationIdentityStore(query);
	const recoveredStore = createConversationIdentityStore(other);
	await seed(query, "first");
	const active = {
		conversationId: "first-request",
		_persistedConversationId: null as string | null,
	};
	let outbound = 0;
	const send = async (
		id: string,
		current: Pick<ActiveNarrator, "conversationId" | "_persistedConversationId">,
		storage = store,
	) => {
		const identity = await withNarratorMutationAdmission(id, () =>
			claimConversationIdentity(storage, id, current),
		);
		outbound++;
		return identity;
	};
	const initial = await store.read("first");
	expect(await send("first", active)).toBe("first-request");
	// Simulate cold recovery with a new store and new active object before teardown.
	const recovered = await recoveredStore.read("first");
	expect(recovered.conversationId).toBe("first-request");
	expect(recovered.revision).toBe(initial.revision);
	expect(
		await send("first", {
			conversationId: recovered.conversationId as string,
			_persistedConversationId: recovered.conversationId,
		}),
	).toBe("first-request");
	expect(outbound).toBe(2);

	await seed(query, "delayed");
	const delayedActive = {
		conversationId: "delayed-id",
		_persistedConversationId: null as string | null,
	};
	const entered = deferred();
	const release = deferred();
	const pending = send("delayed", delayedActive, {
		...store,
		async claim(...args) {
			entered.resolve();
			await release.promise;
			return store.claim(...args);
		},
	});
	await entered.promise;
	expect(outbound).toBe(2);
	expect(delayedActive._persistedConversationId).toBeNull();
	expect((await recoveredStore.read("delayed")).conversationId).toBeNull();
	let mutationEntered = false;
	const mutation = withNarratorMutationAdmission("delayed", async () => {
		mutationEntered = true;
	});
	await Promise.resolve();
	expect(mutationEntered).toBe(false);
	release.resolve();
	expect(await pending).toBe("delayed-id");
	await mutation;
	expect(mutationEntered).toBe(true);
	expect(outbound).toBe(3);

	for (const old of [null, "old-id"]) {
		const id = old === null ? "null-aba" : "old-identity";
		await seed(query, id, old);
		const stale = { conversationId: "stale-candidate", _persistedConversationId: old };
		const before = await store.read(id);
		const raced = {
			...store,
			async claim(...args: Parameters<typeof store.claim>) {
				// Real context-summary trigger moves model_history_revision even for null -> null.
				await other.run(
					"UPDATE narrators SET api_conversation_id = NULL, context_summary = ? WHERE id = ?",
					["compacted history", id],
				);
				return store.claim(...args);
			},
		};
		expect(await settledThrow(send(id, stale, raced))).toThrow("Conversation identity changed");
		expect(outbound).toBe(3);
		expect(stale._persistedConversationId).toBe(old);
		expect((await store.read(id)).conversationId).toBeNull();
		expect((await store.read(id)).revision).not.toBe(before.revision);
		// A delayed writer still holding the pre-clear revision cannot resurrect the id.
		expect(await store.claim(id, stale.conversationId, before)).toBe(false);
		expect((await store.read(id)).conversationId).toBeNull();
	}

	await seed(query, "lost-id", "other-owner");
	const lost = { conversationId: "candidate", _persistedConversationId: null };
	expect(await settledThrow(send("lost-id", lost))).toThrow("Conversation identity changed");
	expect(lost._persistedConversationId).toBeNull();
	expect((await store.read("lost-id")).conversationId).toBe("other-owner");
	expect(await settledThrow(send("missing-row", lost))).toThrow();
	expect(outbound).toBe(3);

	for (const failAt of ["read", "claim"] as const) {
		const id = `storage-${failAt}`;
		await seed(query, id);
		const failed = { conversationId: "not-sent", _persistedConversationId: null };
		const broken = createConversationIdentityStore({
			async get<T>(statement: string, bindings: Parameters<ContextQuery["get"]>[1]) {
				if (failAt === "read")
					return query.get<T>("SELECT id FROM missing_conversation_identity_table", []);
				return query.get<T>(statement, bindings);
			},
			async writeReturning<T>(
				statement: string,
				bindings: Parameters<ContextQuery["writeReturning"]>[1],
			) {
				if (failAt === "claim")
					return query.writeReturning<T>(
						"UPDATE missing_conversation_identity_table SET id = ? RETURNING id",
						[id],
					);
				return query.writeReturning<T>(statement, bindings);
			},
		});
		expect(await settledThrow(send(id, failed, broken))).toThrow();
		expect(failed._persistedConversationId).toBeNull();
		expect((await store.read(id)).conversationId).toBeNull();
		expect(outbound).toBe(3);
	}

	// An intentional compact reset keeps the live cache key; the NEXT request
	// claims it against the new revision rather than changing an epoch/UUID.
	await seed(query, "compact", "stable-key");
	const live = {
		alive: true,
		conversationId: "stable-key",
		_persistedConversationId: "stable-key",
	} as ActiveNarrator;
	activeNarrators.set("compact", live);
	try {
		await withNarratorMutationAdmission("compact", async () => {
			await other.run(
				"UPDATE narrators SET api_conversation_id = NULL, context_summary = ? WHERE id = ?",
				["new compact", "compact"],
			);
			resetActiveUpstreamSession("compact", { persistedIdentityCleared: true });
		});
		expect(live.conversationId).toBe("stable-key");
		expect(live._persistedConversationId).toBeNull();
		expect((await store.read("compact")).conversationId).toBeNull();
		expect(await send("compact", live)).toBe("stable-key");
		expect(live._resetUpstreamSessionOnNextRequest).toBe(true);
		expect((await store.read("compact")).conversationId).toBe("stable-key");
	} finally {
		activeNarrators.delete("compact");
	}
}

test("SQLite: identity is durable before send; delayed/failed/ABA claims fail closed", async () => {
	await identityContract(sqliteContextQuery(sqlite), sqliteContextQuery(sqlite));
});

test("SQLite identity claims use the writer while read and queued transaction boundaries stay strict", async () => {
	const query = sqliteContextQuery(sqlite);
	const id = "identity-explicit-writer";
	await seed(query, id);
	const store = createConversationIdentityStore(query);
	const expected = await store.read(id);
	const update = "UPDATE narrators SET api_conversation_id = ? WHERE id = ? RETURNING id";
	const readWriteError = await query.get(update, ["read-path-write", id]).then(
		() => null,
		(error: unknown) => error,
	);
	expect(readWriteError).toMatchObject({ code: "DB_READ_INVALID" });
	expect((await store.read(id)).conversationId).toBeNull();
	expect(await store.claim(id, "writer-claimed", expected)).toBe(true);
	expect((await store.read(id)).conversationId).toBe("writer-claimed");
	expect(
		await settledThrow(
			query.transaction(async (tx) => {
				await tx.run("UPDATE narrators SET api_conversation_id = ? WHERE id = ?", ["queued", id]);
				await tx.writeReturning(update, ["escaped", id]);
			}),
		),
	).toThrow("Returning mutations are not supported in queued context transactions");
	expect((await store.read(id)).conversationId).toBe("writer-claimed");
});

test("production admission rejects a displaced or aborted session before touching identity", async () => {
	await seed(sqliteContextQuery(sqlite), "not-current");
	const active = {
		alive: true,
		conversationId: "not-sent",
		_persistedConversationId: null,
		abortController: new AbortController(),
	} as ActiveNarrator;
	expect(await settledThrow(ensureConversationIdentityPersisted("not-current", active))).toThrow(
		"Conversation identity changed",
	);
	activeNarrators.set("not-current", active);
	try {
		active.abortController.abort(new Error("stopped"));
		expect(await settledThrow(ensureConversationIdentityPersisted("not-current", active))).toThrow(
			"stopped",
		);
		expect(active._persistedConversationId).toBeNull();
	} finally {
		activeNarrators.delete("not-current");
	}
});

test("PostgreSQL: first-send identity and revision CAS survive independent connections", async () => {
	const realDbModule = { ...(await import("../../db")) };
	let callbackError: unknown;
	let completed = false;
	const result = await withPostgres(async ({ port, credentials }) => {
		const url = `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@127.0.0.1:${port}/${credentials.database}`;
		const client = createPostgresClient({ driver: "bun-sql", url, max: 1 });
		const independent = new SQL(url, { max: 1 });
		try {
			await migrate(client.db, { migrationsFolder: "drizzle-postgres" });
			mock.module("../../db", () => ({
				...realDbModule,
				activeDatabaseBackend: "postgres",
				postgresRuntime: { client },
				db: new Proxy(
					{},
					{
						get() {
							throw new Error("PG admission must not read SQLite ORM");
						},
					},
				),
				sqlite: new Proxy(
					{},
					{
						get() {
							throw new Error("PG identity must not read SQLite");
						},
					},
				),
			}));
			await identityContract(postgresContextQuery(client.sql), postgresContextQuery(independent));
			await seed(postgresContextQuery(client.sql), "pg-production");
			const active = {
				alive: true,
				conversationId: "pg-durable",
				_persistedConversationId: null,
				abortController: new AbortController(),
			} as ActiveNarrator;
			activeNarrators.set("pg-production", active);
			try {
				expect(await ensureConversationIdentityPersisted("pg-production", active)).toBe(
					"pg-durable",
				);
				expect(
					(
						await createConversationIdentityStore(postgresContextQuery(independent)).read(
							"pg-production",
						)
					).conversationId,
				).toBe("pg-durable");
			} finally {
				activeNarrators.delete("pg-production");
			}
			completed = true;
		} catch (error) {
			callbackError = error;
			throw error;
		} finally {
			mock.module("../../db", () => realDbModule);
			await independent.close();
			await client.close();
		}
	});
	if (callbackError) throw callbackError;
	if (!completed)
		throw new Error(`PostgreSQL identity contract did not run: ${JSON.stringify(result)}`);
}, 120_000);
