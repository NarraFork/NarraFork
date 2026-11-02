/**
 * Locks and pending changes over the outline HTTP API (P2 PR 6, owner decision Q5):
 *
 *  - only people lock, with write access to the space, naming a delegate session they may write
 *    (one they cannot read is 404, one they can read but not write 403);
 *  - the locker, a manager of the space or an admin unlocks; anyone else who may write is 403;
 *    unlocking withdraws the tree's open changes;
 *  - a page's pending summary and a change's diff need read access (404 otherwise, as for a
 *    change that does not exist); the locker decides (`canDecide`), others are 403;
 *  - a confirmation that no longer applies is 409 with what failed; a block view carries locks
 *    with `canUnlock` for the caller;
 *  - review round 1: no lock takeover (409 until unlocked), deciding needs write access, session
 *    titles only for people who may read the session, a revert keeps a lock its author may not
 *    take away.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type {
	OutlineBlockViewResponse,
	OutlineLockResponse,
	OutlinePagePendingResponse,
	OutlinePendingDecisionResponse,
	OutlinePendingDetailResponse,
} from "@shared/outline-api";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { aclGrants, narrators, projects, users } from "../../db/schema";
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
			return new Response(JSON.stringify({ error: error.message, code: error.code }), {
				status: error.statusCode,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ error: String(error) }), { status: 500 });
	});
	app.route("/outline", outlineRoutes);
	return app;
}

async function call<T = Record<string, unknown>>(
	who: Who,
	path: string,
	method: "GET" | "POST" | "DELETE" = "GET",
	body?: unknown,
): Promise<{ status: number; body: T }> {
	const response = await appAs(who).request(`http://localhost/outline${path}`, {
		method,
		...(body !== undefined
			? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
			: {}),
	});
	const text = await response.text();
	let parsed: unknown = text;
	try {
		parsed = JSON.parse(text);
	} catch {
		// A plain 404 has a text body.
	}
	return { status: response.status, body: parsed as T };
}

async function user(label: string, role: Role = "user"): Promise<Who> {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: `${label}-${id}`, passwordHash: "x", role, createdAt: NOW });
	return { id, role };
}

async function grant(userId: string, capability: "read" | "write" | "manage") {
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "project",
		scopeId: projectId,
		principalType: "user",
		principalId: userId,
		capability,
		createdAt: NOW,
	});
}

async function session(owner: string, extra: Partial<typeof narrators.$inferInsert> = {}) {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title: "session",
		ownerUserId: owner,
		visibility: "private",
		writeAudience: "owner",
		type: "primary",
		createdAt: NOW,
		updatedAt: NOW,
		...extra,
	});
	return id;
}

let alice: Who;
let reader: Who;
let writer: Who;
let manager: Who;
let stranger: Who;
let admin: Who;
let projectId: string;
let space: OutlineSpaceRow;
let agent: string;
let delegate: string;

/** A fresh plan in the project space: root task, two steps. */
async function plan() {
	const r = await writeOutline({
		spaceId: space.id,
		ops: [
			{ op: "insert", tempId: "r", parent: null, content: "Ship it", task: { status: "todo" } },
			{ op: "insert", parent: { tempId: "r" }, content: "Step one", task: { status: "todo" } },
			{ op: "insert", parent: { tempId: "r" }, content: "Step two", task: { status: "todo" } },
			{ op: "insert", parent: { tempId: "r" }, content: "A plain note" },
		],
		actor: { kind: "human", id: alice.id },
		responsibleUserId: alice.id,
	});
	const [root, one, two, note] = r.results.map((x) => x.blockId) as [
		string,
		string,
		string,
		string,
	];
	return { root, one, two, note };
}

function propose(ops: OutlineOp[]) {
	return writeOutline({
		spaceId: space.id,
		ops,
		actor: { kind: "agent", id: agent },
		narratorId: agent,
		responsibleUserId: alice.id,
	});
}

beforeEach(() => {
	settings.outline.enabled = true;
});

beforeAll(async () => {
	settings.outline.enabled = true;
	alice = await user("alice");
	reader = await user("reader");
	writer = await user("writer");
	manager = await user("manager");
	stranger = await user("stranger");
	admin = await user("admin", "admin");
	projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Locks",
		ownerUserId: alice.id,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	await grant(reader.id, "read");
	await grant(writer.id, "write");
	await grant(manager.id, "manage");
	space = await ensureProjectSpace(projectId);
	agent = await session(alice.id, { contextProjectId: projectId });
	delegate = await session(alice.id, { contextProjectId: projectId });
});

describe("locking", () => {
	test("people with write access lock, naming a delegate they may write; others are refused", async () => {
		const p = await plan();
		const lockPath = `/spaces/${space.id}/blocks/${p.root}/lock`;
		expect((await call(reader, lockPath, "POST", {})).status).toBe(403);
		expect((await call(stranger, lockPath, "POST", {})).status).toBe(404);
		expect(
			(await call(alice, `/spaces/${space.id}/blocks/${p.note}/lock`, "POST", {})).status,
		).toBe(400);
		// A session the person cannot read is unknown; one they can read but not write is refused.
		const hidden = await session(stranger.id);
		expect((await call(alice, lockPath, "POST", { delegate: hidden })).status).toBe(404);
		const readable = await session(stranger.id, { visibility: "public" });
		expect((await call(alice, lockPath, "POST", { delegate: readable })).status).toBe(403);

		const locked = await call<OutlineLockResponse>(alice, lockPath, "POST", { delegate });
		expect(locked.status).toBe(200);
		expect(locked.body.lock).toMatchObject({
			blockId: p.root,
			by: { kind: "human", id: alice.id },
			delegate: { narratorId: delegate },
			canUnlock: true,
		});
		expect((await outlineStore.getBlock(p.root))?.taskJson?.lock?.delegate).toBe(delegate);
		// The block view carries it, with whether the caller may unlock.
		const asWriter = await call<OutlineBlockViewResponse>(
			writer,
			`/spaces/${space.id}/blocks/${p.root}?view=all`,
		);
		expect(asWriter.body.blocks[0]?.lock).toMatchObject({ blockId: p.root, canUnlock: false });
		const asManager = await call<OutlineBlockViewResponse>(
			manager,
			`/spaces/${space.id}/blocks/${p.root}?view=all`,
		);
		expect(asManager.body.blocks[0]?.lock?.canUnlock).toBe(true);
	});

	test("the locker, a manager or an admin unlocks, withdrawing open changes; a writer may not", async () => {
		const p = await plan();
		const lockPath = `/spaces/${space.id}/blocks/${p.root}/lock`;
		await call(alice, lockPath, "POST", {});
		const proposed = await propose([
			{ op: "update", block: { id: p.one }, content: "Step one, better" },
		]);
		expect(proposed.pending).toBeDefined();
		expect((await call(writer, lockPath, "DELETE")).status).toBe(403);
		const unlocked = await call<OutlineLockResponse>(manager, lockPath, "DELETE");
		expect(unlocked.status).toBe(200);
		expect(unlocked.body.commit).not.toBeNull();
		expect((await outlineStore.getPending([proposed.pending?.id as string]))[0]?.status).toBe(
			"withdrawn",
		);
		await call(alice, lockPath, "POST", {});
		expect((await call(admin, lockPath, "DELETE")).status).toBe(200);
		// Nothing locked: nothing to do.
		expect((await call<OutlineLockResponse>(alice, lockPath, "DELETE")).body).toEqual({
			lock: null,
			commit: null,
		});
	});
});

describe("pending changes", () => {
	test("a page lists what waits for confirmation to its readers; the locker decides; others are refused", async () => {
		const p = await plan();
		await call(alice, `/spaces/${space.id}/blocks/${p.root}/lock`, "POST", { delegate });
		const proposed = await propose([
			{ op: "update", block: { id: p.one }, content: "Step one, better" },
			{ op: "insert", parent: { id: p.root }, content: "Step three", task: { status: "todo" } },
		]);
		const id = proposed.pending?.id as string;
		const pagePath = `/spaces/${space.id}/pages/${p.root}/pending`;
		const asAlice = await call<OutlinePagePendingResponse>(alice, pagePath);
		expect(asAlice.status).toBe(200);
		expect(asAlice.body.pending).toEqual([
			expect.objectContaining({
				id,
				label: `P${id}`,
				status: "open",
				rootBlockId: p.root,
				proposer: { narratorId: agent, title: "session" },
				decider: {
					by: { kind: "human", id: alice.id, name: expect.stringContaining("alice") },
					delegate: { narratorId: delegate, title: "session" },
				},
				ops: 2,
				changedSince: false,
				canDecide: true,
			}),
		]);
		expect(asAlice.body.locks).toEqual([
			expect.objectContaining({ blockId: p.root, canUnlock: true }),
		]);
		const asReader = await call<OutlinePagePendingResponse>(reader, pagePath);
		expect(asReader.body.pending[0]?.canDecide).toBe(false);
		expect((await call(stranger, pagePath)).status).toBe(404);

		const detail = await call<OutlinePendingDetailResponse>(reader, `/pending/${id}`);
		expect(detail.status).toBe(200);
		expect(detail.body.entries).toEqual([
			expect.objectContaining({
				blockId: p.one,
				kind: "update",
				base: "Step one",
				proposed: "Step one, better",
				now: "Step one",
			}),
			expect.objectContaining({
				kind: "insert",
				base: null,
				proposed: "Step three",
				parentTitle: "Ship it",
			}),
		]);
		expect((await call(stranger, `/pending/${id}`)).status).toBe(404);
		expect((await call(stranger, "/pending/nonexistent")).status).toBe(404);

		const refused = await call<{ code: string }>(writer, `/pending/${id}/confirm`, "POST");
		expect(refused.status).toBe(403);
		expect(refused.body.code).toBe("OUTLINE_PENDING_NOT_DECIDER");
		const confirmed = await call<OutlinePendingDecisionResponse>(
			alice,
			`/pending/${id}/confirm`,
			"POST",
		);
		expect(confirmed.status).toBe(200);
		expect(confirmed.body.pending.status).toBe("confirmed");
		expect(confirmed.body.commit?.seq).toBeGreaterThan(0);
		expect((await outlineStore.getBlock(p.one))?.content).toBe("Step one, better");
		expect((await call<{ code: string }>(alice, `/pending/${id}/confirm`, "POST")).status).toBe(
			409,
		);
	});

	test("rejecting with a reason; a confirmation that no longer applies is 409 with what failed", async () => {
		const p = await plan();
		await call(alice, `/spaces/${space.id}/blocks/${p.root}/lock`, "POST", {});
		const first = await propose([
			{ op: "update", block: { id: p.two }, content: "Step two, faster" },
		]);
		const rejected = await call<OutlinePendingDecisionResponse>(
			alice,
			`/pending/${first.pending?.id}/reject`,
			"POST",
			{
				reason: "keep it",
			},
		);
		expect(rejected.status).toBe(200);
		expect(rejected.body.pending.status).toBe("rejected");
		expect((await outlineStore.getPending([first.pending?.id as string]))[0]?.reason).toBe(
			"keep it",
		);

		const second = await propose([
			{ op: "update", block: { id: p.two }, content: "Step two, faster" },
		]);
		await writeOutline({
			spaceId: space.id,
			ops: [{ op: "update", block: { id: p.two }, content: "Step two, slower" }],
			actor: { kind: "human", id: writer.id },
			responsibleUserId: writer.id,
		});
		const summary = await call<OutlinePagePendingResponse>(
			alice,
			`/spaces/${space.id}/pages/${p.root}/pending`,
		);
		expect(summary.body.pending[0]?.changedSince).toBe(true);
		const conflict = await call<{ code: string; details: string[] }>(
			alice,
			`/pending/${second.pending?.id}/confirm`,
			"POST",
		);
		expect(conflict.status).toBe(409);
		expect(conflict.body.code).toBe("OUTLINE_PENDING_CONFLICT");
		expect(conflict.body.details.length).toBeGreaterThan(0);
		expect((await outlineStore.getPending([second.pending?.id as string]))[0]?.status).toBe("open");
	});
});

describe("review round 1", () => {
	test("a task someone else locked is 409 to lock again (no takeover); unlocking comes first, by who may (B-2)", async () => {
		const p = await plan();
		const lockPath = `/spaces/${space.id}/blocks/${p.root}/lock`;
		expect((await call(alice, lockPath, "POST", {})).status).toBe(200);
		const proposed = await propose([{ op: "update", block: { id: p.one }, content: "x" }]);
		for (const who of [writer, manager, admin]) {
			const takeover = await call<{ code: string; message: string }>(who, lockPath, "POST", {});
			expect(takeover.status).toBe(409);
			expect(takeover.body.code).toBe("OUTLINE_LOCK_HELD");
			expect(takeover.body.message).toContain("unlocked first");
		}
		expect((await outlineStore.getBlock(p.root))?.taskJson?.lock?.by.id).toBe(alice.id);
		expect((await outlineStore.getPending([proposed.pending?.id as string]))[0]?.status).toBe(
			"open",
		);
		// The locker locking again only names another delegate: the change stays open.
		expect((await call(alice, lockPath, "POST", { delegate })).status).toBe(200);
		expect((await outlineStore.getPending([proposed.pending?.id as string]))[0]?.status).toBe(
			"open",
		);
		// A writer may not unlock; a manager does, and may then lock it themselves.
		expect((await call(writer, lockPath, "DELETE")).status).toBe(403);
		expect((await call(manager, lockPath, "DELETE")).status).toBe(200);
		expect((await call(manager, lockPath, "POST", {})).status).toBe(200);
		expect((await outlineStore.getBlock(p.root))?.taskJson?.lock?.by.id).toBe(manager.id);
	});

	test("confirming and rejecting need write access to the space (B-3)", async () => {
		const p = await plan();
		const locker = await user("locker");
		const [row] = await db
			.insert(aclGrants)
			.values({
				id: generateId(),
				scopeType: "project",
				scopeId: projectId,
				principalType: "user",
				principalId: locker.id,
				capability: "write",
				createdAt: NOW,
			})
			.returning();
		expect(
			(await call(locker, `/spaces/${space.id}/blocks/${p.root}/lock`, "POST", {})).status,
		).toBe(200);
		const proposed = await propose([
			{ op: "update", block: { id: p.one }, content: "by the agent" },
		]);
		const id = proposed.pending?.id as string;
		const pagePath = `/spaces/${space.id}/pages/${p.root}/pending`;
		expect(
			(await call<OutlinePagePendingResponse>(locker, pagePath)).body.pending[0]?.canDecide,
		).toBe(true);
		// The locker can only read the project now.
		await db
			.update(aclGrants)
			.set({ capability: "read" })
			.where(eq(aclGrants.id, row?.id as string));
		expect(
			(await call<OutlinePagePendingResponse>(locker, pagePath)).body.pending[0]?.canDecide,
		).toBe(false);
		expect((await call(locker, `/pending/${id}/confirm`, "POST")).status).toBe(403);
		expect((await call(locker, `/pending/${id}/reject`, "POST", { reason: "no" })).status).toBe(
			403,
		);
		expect((await outlineStore.getBlock(p.one))?.content).toBe("Step one");
		expect((await outlineStore.getPending([id]))[0]?.status).toBe("open");
	});

	test("session titles reach only people who may read the session (S-5)", async () => {
		const p = await plan();
		const secret = await session(alice.id, {
			contextProjectId: null,
			title: "Secret: layoffs plan",
		});
		const lockPath = `/spaces/${space.id}/blocks/${p.root}/lock`;
		const locked = await call<OutlineLockResponse>(alice, lockPath, "POST", { delegate: secret });
		// Alice owns it: she sees its title.
		expect(locked.body.lock?.delegate).toEqual({
			narratorId: secret,
			title: "Secret: layoffs plan",
		});
		await propose([{ op: "update", block: { id: p.one }, content: "x" }]);
		const summary = await call<OutlinePagePendingResponse>(
			reader,
			`/spaces/${space.id}/pages/${p.root}/pending`,
		);
		const view = await call<OutlineBlockViewResponse>(
			reader,
			`/spaces/${space.id}/blocks/${p.root}?view=all`,
		);
		expect(summary.body.pending[0]?.decider.delegate).toEqual({ narratorId: secret, title: null });
		expect(summary.body.locks[0]?.delegate).toEqual({ narratorId: secret, title: null });
		expect(view.body.blocks[0]?.lock?.delegate).toEqual({ narratorId: secret, title: null });
		expect(JSON.stringify(summary.body)).not.toContain("layoffs");
		expect(JSON.stringify(view.body)).not.toContain("layoffs");
		// The proposing session is Alice's private one: named to her, not to the reader.
		expect(summary.body.pending[0]?.proposer).toEqual({ narratorId: agent, title: null });
		const asAlice = await call<OutlinePagePendingResponse>(
			alice,
			`/spaces/${space.id}/pages/${p.root}/pending`,
		);
		expect(asAlice.body.pending[0]?.proposer.title).toBe("session");
		expect(asAlice.body.pending[0]?.decider.delegate?.title).toBe("Secret: layoffs plan");
		// And the change says how big it is without its operations being read.
		expect(summary.body.pending[0]?.ops).toBe(1);
	});

	test("reverting the lock commit keeps the lock for a writer who may not unlock; a manager's revert unlocks (S-4)", async () => {
		const p = await plan();
		const lockPath = `/spaces/${space.id}/blocks/${p.root}/lock`;
		const locked = await call<OutlineLockResponse>(alice, lockPath, "POST", {});
		const commitId = locked.body.commit?.id as string;
		const proposed = await propose([{ op: "update", block: { id: p.one }, content: "x" }]);
		const kept = await call<{ adjusted: number }>(writer, `/commits/${commitId}/revert`, "POST");
		expect(kept.status).toBe(200);
		expect(kept.body.adjusted).toBe(1);
		expect((await outlineStore.getBlock(p.root))?.taskJson?.lock?.by.id).toBe(alice.id);
		expect((await outlineStore.getPending([proposed.pending?.id as string]))[0]?.status).toBe(
			"open",
		);
		expect((await call(manager, `/commits/${commitId}/revert`, "POST")).status).toBe(200);
		expect((await outlineStore.getBlock(p.root))?.taskJson?.lock).toBeUndefined();
		expect((await outlineStore.getPending([proposed.pending?.id as string]))[0]?.status).toBe(
			"withdrawn",
		);
	});
});
