/**
 * Comparing and restoring subtrees over HTTP (`routes/outline-restore.ts`).
 *
 * What must hold:
 *  - with `outline.enabled` off every route is a plain 404;
 *  - the diff is a read: a reader gets it, and a space the caller cannot read is 404 exactly
 *    like one that does not exist;
 *  - preview, restore and move-back are a revert's: 404 when the space cannot be read, 403 when
 *    it can be read but not written;
 *  - a block named in the path or as `rootId` must belong to the space (404), so no route
 *    reads or writes a block of another space;
 *  - history the space cannot answer is H2's 409; a subtree that changed after the preview is
 *    409 `OUTLINE_RESTORE_CONFLICT`; a body outside the limits is refused before any read;
 *  - the page-keyed revert route still works beside them.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	OUTLINE_DIFF_LIMITS,
	type OutlineMoveBackResponse,
	type OutlineRestorePreviewResponse,
	type OutlineRestoreResponse,
	type OutlineSubtreeDiffResponse,
} from "@shared/outline-restore-api";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { aclGrants, outlineSpaces, projects, users } from "../../db/schema";
import { toErrorPayload } from "../../lib/app-error-response";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import { ensureProjectSpace } from "../../services/outline/spaces";
import { outlineStore } from "../../services/outline/store";
import type { OutlineSpaceRow } from "../../services/outline/store/port";
import { type OutlineOp, writeOutline } from "../../services/outline/write";
import { outlineRoutes } from "../outline";

const NOW = "2026-10-26T00:00:00.000Z";

type Role = "admin" | "user";
type Who = { id: string; role: Role };

function appAs(who: Who) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: who.id, role: who.role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) => {
		if (error instanceof AppError) {
			return new Response(JSON.stringify(toErrorPayload(error)), {
				status: error.statusCode,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ error: String(error) }), { status: 500 });
	});
	app.route("/outline", outlineRoutes);
	return app;
}

async function post<T = Record<string, unknown>>(
	who: Who,
	path: string,
	body: unknown,
): Promise<{ status: number; body: T; text: string }> {
	const response = await appAs(who).request(`http://localhost/outline${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
	const text = await response.text();
	let parsed: unknown = text;
	try {
		parsed = JSON.parse(text);
	} catch {
		// A plain 404 has a text body.
	}
	return { status: response.status, body: parsed as T, text };
}

async function user(label: string, role: Role = "user"): Promise<Who> {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `${label}-${id}`, passwordHash: "x", role, createdAt: NOW });
	return { id, role };
}

async function project(owner: Who, readers: Who[] = []): Promise<string> {
	const id = generateId();
	await db.insert(projects).values({
		id,
		name: `Project ${id}`,
		ownerUserId: owner.id,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	for (const reader of readers) {
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId: id,
			principalType: "user",
			principalId: reader.id,
			capability: "read",
			createdAt: NOW,
		});
	}
	return id;
}

async function write(space: OutlineSpaceRow, ops: OutlineOp[], actor: Who) {
	return writeOutline({
		spaceId: space.id,
		ops,
		actor: { kind: "human", id: actor.id },
		responsibleUserId: actor.id,
	});
}

async function content(id: string): Promise<string | undefined> {
	return (await outlineStore.getBlock(id))?.content;
}

let alice: Who;
let bob: Who;
let carol: Who;
/** Alice's project space, which Bob may read (not write). */
let spaceA: OutlineSpaceRow;
/** Carol's project space, which neither Alice nor Bob may read. */
let spaceB: OutlineSpaceRow;
let a: { top: string; one: string; two: string; thenSeq: number };
let b: { top: string; child: string; thenSeq: number };

/** The four routes, with a body that is valid for each. */
function calls(spaceId: string, blockId: string, thenSeq: number): Array<[string, unknown]> {
	return [
		[`/spaces/${spaceId}/diff`, { thenSeq, rootId: blockId }],
		[`/spaces/${spaceId}/restore/preview`, { thenSeq, rootId: blockId }],
		[`/spaces/${spaceId}/restore`, { token: "abc.def" }],
		[`/spaces/${spaceId}/blocks/${blockId}/move-back`, { thenSeq }],
	];
}

// The preload restores settings after every test.
beforeEach(() => {
	settings.outline.enabled = true;
});

beforeAll(async () => {
	settings.outline.enabled = true;
	alice = await user("alice");
	bob = await user("bob");
	carol = await user("carol");
	spaceA = await ensureProjectSpace(await project(alice, [bob]));
	spaceB = await ensureProjectSpace(await project(carol));
	const inA = await write(
		spaceA,
		[
			{ op: "insert", tempId: "top", parent: null, content: "top" },
			{ op: "insert", parent: { tempId: "top" }, content: "one" },
			{ op: "insert", parent: { tempId: "top" }, content: "two" },
		],
		alice,
	);
	const [top, one, two] = inA.results.map((r) => r.blockId) as [string, string, string];
	a = { top, one, two, thenSeq: inA.commit?.seq as number };
	const inB = await write(
		spaceB,
		[
			{ op: "insert", tempId: "top", parent: null, content: "secret top" },
			{ op: "insert", parent: { tempId: "top" }, content: "secret child" },
		],
		carol,
	);
	b = {
		top: inB.results[0]?.blockId as string,
		child: inB.results[1]?.blockId as string,
		thenSeq: inB.commit?.seq as number,
	};
	await write(spaceB, [{ op: "update", block: { id: b.child }, content: "secret edited" }], carol);
});

describe("outline restore routes", () => {
	test("every route is a plain 404 while outline.enabled is off", async () => {
		settings.outline.enabled = false;
		for (const [path, body] of calls(spaceA.id, a.top, a.thenSeq)) {
			const result = await post(alice, path, body);
			expect(result.status).toBe(404);
			expect(result.text).not.toContain("top");
		}
	});

	test("a space the caller cannot read is 404 on every route, like one that does not exist", async () => {
		for (const who of [alice, bob]) {
			const hidden = calls(spaceB.id, b.top, b.thenSeq);
			const missing = calls(generateId(), b.top, b.thenSeq);
			for (let i = 0; i < hidden.length; i++) {
				const [path, body] = hidden[i] as [string, unknown];
				const [missingPath] = missing[i] as [string, unknown];
				const result = await post(who, path, body);
				const none = await post(who, missingPath, body);
				expect(result.status).toBe(404);
				expect(none.status).toBe(404);
				expect(result.text).not.toContain("secret");
				expect((result.body as { code?: string }).code).toBe((none.body as { code?: string }).code);
			}
		}
		expect(await content(b.child)).toBe("secret edited");
	});

	test("a reader may compare; previewing, restoring and moving back need write access (403)", async () => {
		await write(spaceA, [{ op: "update", block: { id: a.one }, content: "one edited" }], alice);
		const diff = await post<OutlineSubtreeDiffResponse>(bob, `/spaces/${spaceA.id}/diff`, {
			thenSeq: a.thenSeq,
			rootId: a.top,
		});
		expect(diff.status).toBe(200);
		expect(diff.body.entries.map((entry) => [entry.blockId, entry.kind, entry.fields])).toEqual([
			[a.one, "changed", ["text"]],
		]);
		expect(diff.body.entries[0]?.before?.excerpt).toBe("one");
		expect(diff.body.entries[0]?.after?.excerpt).toBe("one edited");
		expect(diff.body.nextCursor).toBeNull();

		const token = (
			await post<OutlineRestorePreviewResponse>(alice, `/spaces/${spaceA.id}/restore/preview`, {
				thenSeq: a.thenSeq,
				rootId: a.top,
			})
		).body.token;
		for (const [path, body] of [
			[`/spaces/${spaceA.id}/restore/preview`, { thenSeq: a.thenSeq, rootId: a.top }],
			[`/spaces/${spaceA.id}/restore`, { token }],
			[`/spaces/${spaceA.id}/blocks/${a.one}/move-back`, { thenSeq: a.thenSeq }],
		] as Array<[string, unknown]>) {
			const result = await post(bob, path, body);
			expect(result.status).toBe(403);
		}
		expect(await content(a.one)).toBe("one edited");
	});

	test("a block of another space, in the path or as the root, is 404 and nothing of it is read or written", async () => {
		// Alice writes space A; the blocks named are Carol's.
		for (const [path, body] of [
			[`/spaces/${spaceA.id}/diff`, { thenSeq: b.thenSeq, rootId: b.top }],
			[`/spaces/${spaceA.id}/restore/preview`, { thenSeq: b.thenSeq, rootId: b.top }],
			[`/spaces/${spaceA.id}/blocks/${b.child}/move-back`, { thenSeq: b.thenSeq }],
		] as Array<[string, unknown]>) {
			const result = await post(alice, path, body);
			expect(result.status).toBe(404);
			expect(result.text).not.toContain("secret");
		}
		// A token is of one space: Carol's token does nothing in Alice's.
		const preview = await post<OutlineRestorePreviewResponse>(
			carol,
			`/spaces/${spaceB.id}/restore/preview`,
			{ thenSeq: b.thenSeq },
		);
		expect(preview.status).toBe(200);
		const crossed = await post(alice, `/spaces/${spaceA.id}/restore`, {
			token: preview.body.token,
		});
		expect(crossed.status).toBe(400);
		expect((crossed.body as { code: string }).code).toBe("OUTLINE_RESTORE_TOKEN_INVALID");
		expect(await content(b.child)).toBe("secret edited");
	});

	test("preview, restore, and the conflict when the subtree changed in between", async () => {
		const space = await ensureProjectSpace(await project(alice));
		const made = await write(
			space,
			[
				{ op: "insert", tempId: "top", parent: null, content: "top" },
				{ op: "insert", parent: { tempId: "top" }, content: "one" },
				{ op: "insert", parent: null, content: "elsewhere" },
			],
			alice,
		);
		const [top, one, elsewhere] = made.results.map((r) => r.blockId) as [string, string, string];
		const thenSeq = made.commit?.seq as number;
		const added = await write(
			space,
			[
				{ op: "update", block: { id: one }, content: "one edited" },
				{ op: "insert", parent: { id: top }, content: "added" },
				{ op: "move", block: { id: one }, parent: { id: elsewhere } },
			],
			alice,
		);
		const preview = await post<OutlineRestorePreviewResponse>(
			alice,
			`/spaces/${space.id}/restore/preview`,
			{ thenSeq, rootId: top },
		);
		expect(preview.status).toBe(200);
		expect(preview.body.nowSeq).toBe(added.commit?.seq as number);
		expect(preview.body.entries.map((entry) => [entry.kind, entry.action]).sort()).toEqual([
			["added", "delete"],
			["moved-away", "none"],
		]);
		// Someone edits under the subtree after the preview.
		const foreign = await write(
			space,
			[{ op: "insert", parent: { id: top }, content: "late" }],
			alice,
		);
		const refused = await post(alice, `/spaces/${space.id}/restore`, {
			token: preview.body.token,
		});
		expect(refused.status).toBe(409);
		expect(refused.body).toMatchObject({
			code: "OUTLINE_RESTORE_CONFLICT",
			details: {
				restoreId: preview.body.restoreId,
				previewSeq: preview.body.nowSeq,
				conflictSeq: foreign.commit?.seq as number,
			},
		});
		const again = await post<OutlineRestorePreviewResponse>(
			alice,
			`/spaces/${space.id}/restore/preview`,
			{ thenSeq, rootId: top },
		);
		const done = await post<OutlineRestoreResponse>(alice, `/spaces/${space.id}/restore`, {
			token: again.body.token,
		});
		expect(done.status).toBe(200);
		expect(done.body).toMatchObject({ done: true, cursor: null, movedAway: 1, skipped: [] });
		expect(done.body.commits).toHaveLength(1);
		const commit = await outlineStore.getCommit(done.body.commits[0]?.id as string);
		expect(commit).toMatchObject({ kind: "revert", actorKind: "human", actorId: alice.id });
		expect(commit?.summary).toContain(`to #${thenSeq}`);
		// The block that moved away is still away, with its edit; one click moves it back.
		expect((await outlineStore.getBlock(one))?.parentId).toBe(elsewhere);
		const back = await post<OutlineMoveBackResponse>(
			alice,
			`/spaces/${space.id}/blocks/${one}/move-back`,
			{ thenSeq },
		);
		expect(back.status).toBe(200);
		expect(back.body.commit).not.toBeNull();
		expect(await outlineStore.getBlock(one)).toMatchObject({
			parentId: top,
			content: "one edited",
		});
		// The page-keyed revert is still there.
		const reverted = await post(alice, `/commits/${back.body.commit?.id}/revert`, {});
		expect(reverted.status).toBe(200);
		expect((await outlineStore.getBlock(one))?.parentId).toBe(elsewhere);
	});

	test("history the space cannot answer is a 409 with H2's codes", async () => {
		const space = await ensureProjectSpace(await project(alice));
		const made = await write(space, [{ op: "insert", parent: null, content: "top" }], alice);
		const top = made.results[0]?.blockId as string;
		await write(space, [{ op: "update", block: { id: top }, content: "edited" }], alice);
		await write(space, [{ op: "update", block: { id: top }, content: "edited again" }], alice);
		await db
			.update(outlineSpaces)
			.set({ edgesReady: true, historyFloorSeq: 2 })
			.where(eq(outlineSpaces.id, space.id));
		for (const [path, body] of [
			[`/spaces/${space.id}/diff`, { thenSeq: 1 }],
			[`/spaces/${space.id}/restore/preview`, { thenSeq: 1 }],
			[`/spaces/${space.id}/blocks/${top}/move-back`, { thenSeq: 1 }],
		] as Array<[string, unknown]>) {
			const result = await post(alice, path, body);
			expect(result.status).toBe(409);
			expect(result.body).toMatchObject({
				code: "OUTLINE_HISTORY_BEFORE_FLOOR",
				details: { reason: "before-floor", floorSeq: 2, seq: 1 },
			});
		}
		// The floor itself can be compared with and restored to.
		const atFloor = await post<OutlineSubtreeDiffResponse>(alice, `/spaces/${space.id}/diff`, {
			thenSeq: 2,
		});
		expect(atFloor.status).toBe(200);
		expect(atFloor.body.entries).toHaveLength(1);
		await db.update(outlineSpaces).set({ edgesReady: false }).where(eq(outlineSpaces.id, space.id));
		const notReady = await post(alice, `/spaces/${space.id}/diff`, { thenSeq: 2 });
		expect(notReady.status).toBe(409);
		expect((notReady.body as { code: string }).code).toBe("OUTLINE_HISTORY_NOT_READY");
	});

	test("a body outside the limits is refused before any read", async () => {
		const bad: Array<[string, unknown]> = [
			[`/spaces/${spaceA.id}/diff`, {}],
			[`/spaces/${spaceA.id}/diff`, { thenSeq: -1 }],
			[`/spaces/${spaceA.id}/diff`, { thenSeq: 1.5 }],
			[`/spaces/${spaceA.id}/diff`, { thenSeq: 1, limit: OUTLINE_DIFF_LIMITS.maxEntries + 1 }],
			[`/spaces/${spaceA.id}/diff`, { thenSeq: 1, extra: true }],
			[`/spaces/${spaceA.id}/diff`, { thenSeq: 1, rootId: "x".repeat(200) }],
			[
				`/spaces/${spaceA.id}/diff`,
				{ thenSeq: 1, cursor: "x".repeat(OUTLINE_DIFF_LIMITS.maxCursorChars + 1) },
			],
			[`/spaces/${spaceA.id}/diff`, "{not json"],
			[`/spaces/${spaceA.id}/restore/preview`, { thenSeq: 1, cursor: "abc.def" }],
			[`/spaces/${spaceA.id}/restore`, {}],
			[`/spaces/${spaceA.id}/restore`, { token: "" }],
			[`/spaces/${spaceA.id}/blocks/${a.one}/move-back`, {}],
		];
		for (const [path, body] of bad) {
			const result = await post(alice, path, body);
			expect(result.status).toBe(400);
		}
		// A cursor or a token nobody sealed.
		for (const [path, body] of [
			[`/spaces/${spaceA.id}/diff`, { thenSeq: 1, cursor: "WzFd.forged" }],
			[`/spaces/${spaceA.id}/restore`, { token: "WzFd.forged" }],
			[`/spaces/${spaceA.id}/restore/preview`, { thenSeq: 1, token: "WzFd.forged" }],
		] as Array<[string, unknown]>) {
			const result = await post(alice, path, body);
			expect(result.status).toBe(400);
			expect((result.body as { code: string }).code).toBe("OUTLINE_RESTORE_TOKEN_INVALID");
		}
	});
});
