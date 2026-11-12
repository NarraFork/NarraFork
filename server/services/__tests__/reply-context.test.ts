import { expect, mock, spyOn, test } from "bun:test";
import { parseReplyContext } from "@shared/reply-context";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { withPostgres } from "../../../tests/db/pg-test-harness";
import { db, sqlite } from "../../db";
import { createPostgresClient } from "../../db/postgres-client";
import { narrators } from "../../db/schema";
import { createPostgresRuntimeQueue } from "../agent-runtime/postgres-runtime-queue";
import { preparePrefixRequest } from "../agent-runtime/prepare-prefix-request";
import {
	type ContextQuery,
	postgresContextQuery,
	sqliteContextQuery,
} from "../context-composition-history";
import {
	adoptHumanReplyContext,
	createReplyContextStore,
	ensureReplyContext,
} from "../narrator-reply-context";
import { narratorService } from "../narrator-service";
import { editAndRegenerate } from "../narrator-session";

const chinese = { locale: "zh-CN" as const, replyInUserLanguage: true };
const english = { locale: "en" as const, replyInUserLanguage: false };

async function contract(query: ContextQuery) {
	const store = createReplyContextStore(query);
	await query.run(
		"INSERT INTO users (id, username, password_hash, created_at) VALUES ('reply-owner', 'reply-owner', 'hash', 'now')",
		[],
	);
	await query.run(
		"INSERT INTO user_preferences (id, user_id, language, created_at, updated_at) VALUES ('reply-prefs', 'reply-owner', 'zh-Hans', 'now', 'now')",
		[],
	);
	for (const id of [
		"reply-legacy",
		"reply-recovery",
		"reply-default",
		"reply-broken",
		"reply-race",
	])
		await query.run(
			"INSERT INTO narrators (id, owner_user_id, created_at, updated_at) VALUES (?, ?, 'now', 'now')",
			[id, id === "reply-legacy" ? "reply-owner" : null],
		);
	await query.run(
		"INSERT INTO users (id, username, password_hash, created_at) VALUES ('reply-owner-nopref', 'reply-owner-nopref', 'hash', 'now')",
		[],
	);
	await query.run(
		"INSERT INTO narrators (id, owner_user_id, created_at, updated_at) VALUES ('reply-nopref', 'reply-owner-nopref', 'now', 'now')",
		[],
	);
	expect(await store.ensure("reply-nopref")).toEqual({ locale: "en", replyInUserLanguage: true });
	expect(await store.ensure("reply-legacy")).toEqual(chinese);
	expect(await store.ensure("reply-default")).toEqual(english);
	expect(await store.ensure("reply-recovery", chinese)).toEqual(chinese);
	await store.adopt("reply-recovery", english);
	expect(await store.ensure("reply-recovery", chinese)).toEqual(english);
	for (const bad of [
		"null",
		"{}",
		'{"locale":"en"}',
		'{"locale":"zh-CN","replyInUserLanguage":1}',
		"bad JSON",
	]) {
		await query.run("UPDATE narrators SET reply_context = ? WHERE id = 'reply-broken'", [bad]);
		await expect(store.ensure("reply-broken", chinese)).rejects.toThrow();
	}
	let blocked = true;
	const racing = createReplyContextStore({
		get: async <T>(statement: string, params: Parameters<ContextQuery["get"]>[1]) => {
			if (blocked && statement.startsWith("UPDATE narrators SET reply_context")) {
				blocked = false;
				await store.adopt("reply-race", english);
			}
			return query.get<T>(statement, params);
		},
	});
	expect(await racing.ensure("reply-race", chinese)).toEqual(english);
}

test("strict reply pair parsing distinguishes absent and malformed contexts", () => {
	expect(parseReplyContext(null)).toBeNull();
	expect(parseReplyContext(undefined)).toBeNull();
	for (const bad of [false, "en", {}, { locale: "en" }, { ...english, locale: "unknown" }])
		expect(() => parseReplyContext(bad)).toThrow();
	const original = { ...chinese };
	const frozen = parseReplyContext(original);
	original.replyInUserLanguage = false;
	expect(frozen).toEqual(chinese);
});

test("request preparation freezes the whole reply pair before its first await", async () => {
	const gate = Promise.withResolvers<void>();
	const read = spyOn(narratorService, "getModelHistorySinceLastCompact").mockImplementation(
		async () => {
			await gate.promise;
			return [];
		},
	);
	const live = { ...chinese } as { locale: "en" | "zh-CN"; replyInUserLanguage: boolean };
	const observed: unknown[] = [];
	try {
		const prepare = () =>
			preparePrefixRequest({
				narratorId: "snapshot",
				locale: "en",
				getModel: () => "model",
				getProvider: () => "provider",
				getReplyContext: () => live,
				buildPrefixPrompt: async (_model, pair) => {
					observed.push(pair);
					return { contract: "", parts: [] };
				},
			});
		const first = prepare();
		live.locale = "en";
		live.replyInUserLanguage = false;
		gate.resolve();
		await first;
		expect(observed).toEqual([chinese]);
		await prepare();
		expect(observed).toEqual([chinese, english]);
	} finally {
		read.mockRestore();
	}
});

test("SQLite legacy preference, trusted recovery, durable priority, corrupt rows and adoption CAS", async () => {
	await contract(sqliteContextQuery(sqlite));
});

test("new child and full/fresh forks explicitly inherit the parent's durable pair", async () => {
	const parent = await narratorService.create({ cwd: process.cwd() });
	await db.update(narrators).set({ replyContext: chinese }).where(eq(narrators.id, parent.id));
	const child = await narratorService.createSubagent({
		parentNarratorId: parent.id,
		subagentType: "general",
		cwd: process.cwd(),
		subagentOriginKind: "standalone",
	});
	expect(child.replyContext).toEqual(chinese);
	for (const mode of ["full", "fresh"] as const) {
		const fork = await narratorService.forkNarrator(parent.id, null, { inheritMode: mode });
		expect(fork.replyContext).toEqual(chinese);
	}
	await db.update(narrators).set({ replyContext: english }).where(eq(narrators.id, parent.id));
	expect((await narratorService.getById(child.id)).replyContext).toEqual(chinese);
});

test("explicit human edit adopts atomically with message COW, including rollback", async () => {
	const narrator = await narratorService.create({ cwd: process.cwd() });
	await db.update(narrators).set({ replyContext: chinese }).where(eq(narrators.id, narrator.id));
	const message = await narratorService.persistUserMessage(narrator.id, "original", [
		{ type: "text", text: "original" },
	]);
	const options = { humanReplyContext: english, deferContinuation: true, revertFiles: false };
	sqlite.exec(
		"CREATE TRIGGER fail_reply_edit BEFORE UPDATE OF reply_context ON narrators BEGIN SELECT RAISE(ABORT, 'forced reply failure'); END",
	);
	try {
		await expect(
			editAndRegenerate(narrator.id, message.id, "edited", "en", false, options),
		).rejects.toThrow("forced reply failure");
	} finally {
		sqlite.exec("DROP TRIGGER fail_reply_edit");
	}
	expect((await narratorService.getById(narrator.id)).replyContext).toEqual(chinese);
	expect(
		(await narratorService.getModelHistorySinceLastCompact(narrator.id)).find(
			(row) => row.id === message.id,
		)?.contentText,
	).toBe("original");
	expect(
		(await editAndRegenerate(narrator.id, message.id, "edited", "en", false, options)).ok,
	).toBe(true);
	expect((await narratorService.getById(narrator.id)).replyContext).toEqual(english);
	expect(
		(await narratorService.getModelHistorySinceLastCompact(narrator.id)).find(
			(row) => row.id === message.id,
		)?.contentText,
	).toBe("edited");
});

test("PostgreSQL generated schema preserves pair priority and transaction rollback", async () => {
	const realDbModule = { ...(await import("../../db")) };
	let completed = false;
	let callbackError: unknown;
	const result = await withPostgres(async ({ port, credentials }) => {
		const url = `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@127.0.0.1:${port}/${credentials.database}`;
		const client = createPostgresClient({ driver: "bun-sql", url, max: 1 });
		try {
			await migrate(client.db, { migrationsFolder: "drizzle-postgres" });
			const query = postgresContextQuery(client.sql);
			await contract(query);
			const store = createReplyContextStore(query);
			await store.adopt("reply-recovery", chinese);
			const queue = createPostgresRuntimeQueue(client.db);
			await queue.mailbox.enqueue({
				kind: "user_input",
				narratorId: "reply-recovery",
				text: "B",
				projectedByteSize: 1,
				metadata: { humanReplyContext: english },
			});
			expect(await store.ensure("reply-recovery")).toEqual(chinese);
			const row = await queue.mailbox.claimEligibleHead("reply-recovery", {
				token: "token",
				epoch: "epoch",
			});
			if (!row?.claimToken || !row.claimEpoch) throw new Error("missing claim");
			const claim = {
				id: row.id,
				narratorId: row.narratorId,
				token: row.claimToken,
				epoch: row.claimEpoch,
			};
			const persist = async (
				tx: Parameters<Parameters<typeof queue.mailbox.materialize>[1]>[0],
			) => {
				const id = row.recipientMessageId;
				if (!id) throw new Error("Expected a reserved mailbox message id");
				await tx.execute(
					sql`INSERT INTO narrator_messages (id, narrator_id, role, content_json, content_text, created_at) VALUES (${id}, ${row.narratorId}, 'user', '[]', 'B', 'now')`,
				);
				await tx.execute(
					sql`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES ('reply-ref', ${row.narratorId}, ${id}, 1)`,
				);
				return { messageId: id, refId: "reply-ref" };
			};
			await client.sql.unsafe(`CREATE FUNCTION fail_reply_flip() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state = 'materialized' THEN RAISE EXCEPTION 'forced claim failure'; END IF; RETURN NEW; END $$;
CREATE TRIGGER fail_reply_flip BEFORE UPDATE OF state ON narrator_buffered_messages FOR EACH ROW EXECUTE FUNCTION fail_reply_flip()`);
			const failure = await queue.mailbox.materialize(claim, persist).then(
				() => null,
				(error: unknown) => error,
			);
			expect(failure).toBeInstanceOf(Error);
			expect(String((failure as Error).cause)).toContain("forced claim failure");
			expect(await store.ensure("reply-recovery")).toEqual(chinese);
			expect(
				await query.get("SELECT id FROM narrator_messages WHERE id = ?", [row.recipientMessageId]),
			).toBeNull();
			await client.sql.unsafe("DROP TRIGGER fail_reply_flip ON narrator_buffered_messages");
			await queue.mailbox.materialize(claim, persist);
			expect(await store.ensure("reply-recovery", chinese)).toEqual(english);
			await expect(queue.mailbox.materialize(claim, persist)).rejects.toThrow(
				"Stale mailbox claim",
			);
			const forbidden = new Proxy(
				{},
				{
					get() {
						throw new Error("PG reply context must not read SQLite");
					},
				},
			);
			mock.module("../../db", () => ({
				...realDbModule,
				activeDatabaseBackend: "postgres",
				postgresRuntime: { client },
				db: forbidden,
				sqlite: forbidden,
			}));
			expect(await ensureReplyContext("reply-recovery", chinese)).toEqual(english);
			await adoptHumanReplyContext("reply-recovery", chinese);
			expect(await store.ensure("reply-recovery")).toEqual(chinese);
			completed = true;
		} catch (error) {
			callbackError = error;
			throw error;
		} finally {
			mock.module("../../db", () => realDbModule);
			await client.close();
		}
	});
	if (callbackError) throw callbackError;
	if (!completed) throw new Error(`PostgreSQL unavailable: ${JSON.stringify(result)}`);
}, 120_000);
