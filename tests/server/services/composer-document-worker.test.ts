import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { db, sqlite } from "../../../server/db";
import { narratorMessageRefs, narratorMessages, narrators } from "../../../server/db/schema";
import * as pool from "../../../server/lib/db-worker/pool";
import { NotFoundError, ValidationError } from "../../../server/lib/errors";
import { generateId } from "../../../server/lib/id";
import { settings } from "../../../server/lib/settings";
import { insertEnvelope } from "../../../server/services/narrator-body-writes";
import { readCommittedComposerDocument } from "../../../server/services/narrator-composer-document";

const now = "2026-07-01T00:00:00.000Z";
const doc = { version: 1, paragraphs: [], assets: [] } as const;
const text = "Some historic input 🌱";

function fixture(role: "user" | "assistant" = "user", blocks = false) {
	const narratorId = generateId();
	const messageId = generateId();
	const refId = generateId();
	db.insert(narrators)
		.values({ id: narratorId, title: "Session", createdAt: now, updatedAt: now })
		.run();
	db.transaction((tx) => {
		const message = {
			id: messageId,
			narratorId,
			role,
			bodyFormat: blocks ? 2 : 1,
			bodyRevision: 5,
			contentJson: [{ type: "text", text }],
			composerDocument: { ...doc, paragraphs: [], assets: [] },
			createdAt: now,
		};
		if (blocks) insertEnvelope(tx, message);
		else tx.insert(narratorMessages).values(message).run();
		tx.insert(narratorMessageRefs).values({ id: refId, narratorId, messageId, seq: 1 }).run();
	});
	return { narratorId, messageId, refId };
}

async function allow() {}
function read(
	scope: { narratorId: string; messageId: string },
	authorize = allow,
	signal = new AbortController().signal,
) {
	return readCommittedComposerDocument(scope.narratorId, scope.messageId, signal, authorize);
}

afterEach(() => mock.restore());

test("renders legacy and rows-only composer snapshots while only rechecking metadata locally", async () => {
	const legacy = fixture();
	const { compactJson, read: blockReads, write } = settings.narratorBlocks;
	settings.narratorBlocks.compactJson = true;
	settings.narratorBlocks.read = true;
	settings.narratorBlocks.write = true;
	try {
		const rowsOnly = fixture("user", true);
		settings.narratorBlocks.read = false;
		expect(
			sqlite
				.query("SELECT body_rows_only AS yes FROM narrator_messages WHERE id = ?")
				.get(rowsOnly.messageId),
		).toEqual({ yes: 1 });
		const scopes = [legacy, rowsOnly].map((scope) => ({
			scope,
			bodyRevision: sqlite
				.query<{ revision: number }, [string]>(
					"SELECT body_revision AS revision FROM narrator_messages WHERE id = ?",
				)
				.get(scope.messageId)?.revision,
		}));
		const mainQueries = spyOn(sqlite, "query");
		for (const { scope, bodyRevision } of scopes) {
			expect(JSON.parse(await read(scope))).toMatchObject({
				composerDocument: doc,
				bodyRevision,
				text,
			});
		}
		expect(mainQueries).toHaveBeenCalledTimes(2);
		for (const [sql] of mainQueries.mock.calls)
			expect(sql).not.toMatch(/content_json|composer_document/i);
	} finally {
		settings.narratorBlocks.compactJson = compactJson;
		settings.narratorBlocks.read = blockReads;
		settings.narratorBlocks.write = write;
	}
});

test("rejects a missing reference, a non-user body, and an oversized body", async () => {
	const other = fixture();
	await expect(read({ ...other, narratorId: generateId() })).rejects.toBeInstanceOf(NotFoundError);
	await expect(read(fixture("assistant"))).rejects.toBeInstanceOf(ValidationError);
	sqlite
		.query("UPDATE narrator_messages SET content_json = ? WHERE id = ?")
		.run(JSON.stringify([{ type: "text", text: "x".repeat(4 * 1024 * 1024) }]), other.messageId);
	await expect(read(other)).rejects.toBeInstanceOf(ValidationError);
});

test("returns no bytes when the ACL or message reference changes while awaiting the snapshot", async () => {
	const scope = fixture();
	const aclFailure = new Error("access revoked");
	await expect(
		read(scope, async () => {
			throw aclFailure;
		}),
	).rejects.toBe(aclFailure);
	await expect(
		read(scope, async () => {
			sqlite.query("DELETE FROM narrator_message_refs WHERE id = ?").run(scope.refId);
		}),
	).rejects.toBeInstanceOf(NotFoundError);
});

test("returns no stale body after an edit", async () => {
	const scope = fixture();
	await expect(
		read(scope, async () => {
			sqlite
				.query("UPDATE narrator_messages SET content_json = '[]' WHERE id = ?")
				.run(scope.messageId);
		}),
	).rejects.toBeInstanceOf(NotFoundError);
});

test("propagates Worker failures and turn cancellation without falling back", async () => {
	const scope = fixture();
	const query = spyOn(sqlite, "query");
	const worker = spyOn(pool, "runTrackedEphemeralReadTask");
	const controller = new AbortController();
	for (const error of [
		new pool.WorkersUnavailableError("creation_failed"),
		new pool.DbReadTaskExecutionError("execution failed"),
		new pool.DbReadTaskTimeoutError("timed out"),
	]) {
		worker.mockReturnValueOnce({ result: Promise.reject(error), released: Promise.resolve() });
		await expect(read(scope, allow, controller.signal)).rejects.toBe(error);
		expect(worker.mock.lastCall?.[2]?.signal).toBe(controller.signal);
	}
	const previous = process.env.NARRAFORK_DB_WORKER;
	process.env.NARRAFORK_DB_WORKER = "off";
	try {
		await expect(read(scope)).rejects.toMatchObject({ reason: "disabled_by_env" });
	} finally {
		if (previous === undefined) delete process.env.NARRAFORK_DB_WORKER;
		else process.env.NARRAFORK_DB_WORKER = previous;
	}
	const reason = new Error("aborted");
	controller.abort(reason);
	await expect(read(scope, allow, controller.signal)).rejects.toBe(reason);
	expect(query).not.toHaveBeenCalled();
});
