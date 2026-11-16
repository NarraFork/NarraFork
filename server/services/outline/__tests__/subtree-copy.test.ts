/**
 * Copying a block's subtree (pageless outline, A2: `subtree-copy.ts`, `routes/outline-copy.ts`).
 *
 * What must hold:
 *  - a copy in one space and into another: text, order and shape as the source's; links to
 *    copied blocks point to their copies; a task in progress is to do, without manager, with
 *    only the assignees who may write the target; a question is a plain block; aliases, tags
 *    and locks are not copied; the provenance is the first block; the source is untouched;
 *  - the bounds: blocks and bytes, breadth first, the rest counted;
 *  - batches: parents first, every commit within the write path's operations, the order whole;
 *  - an interrupted copy leaves a whole tree, says where it stopped, and the same `copyId`
 *    finishes it without a second copy of anything;
 *  - a copy into the block's own subtree is refused;
 *  - over HTTP both sides are checked: source read (404), target read (404) and write (403).
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own world.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { OutlineCopyResponse } from "@shared/outline-copy-api";
import { Hono } from "hono";
import { db } from "../../../db";
import { aclGrants, projects, users } from "../../../db/schema";
import { toErrorPayload } from "../../../lib/app-error-response";
import { AppError, ValidationError } from "../../../lib/errors";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import { outlineRoutes } from "../../../routes/outline";
import { OUTLINE_LIMITS } from "../model";
import { ensureProjectSpace } from "../spaces";
import { outlineStore } from "../store";
import type { OutlineBlockRow, OutlineSpaceRow } from "../store/port";
import {
	copiedBlockId,
	copyOutlineSubtree,
	OUTLINE_SUBTREE_COPY_LIMITS,
	type OutlineSubtreeCopyRequest,
} from "../subtree-copy";
import { type OutlineOp, writeOutline } from "../write";

const NOW = "2026-11-16T00:00:00.000Z";

beforeEach(() => {
	settings.outline.enabled = true;
});

type Who = { id: string; username: string; role: "admin" | "user" };

async function person(label: string): Promise<Who> {
	const id = generateId();
	const username = `${label}${id.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`;
	await db.insert(users).values({ id, username, passwordHash: "x", role: "user", createdAt: NOW });
	return { id, username, role: "user" };
}

async function project(owner: Who, grants: Array<[Who, "read" | "write"]> = []): Promise<string> {
	const id = generateId();
	await db.insert(projects).values({
		id,
		name: `copy-${id}`,
		ownerUserId: owner.id,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	for (const [who, capability] of grants) {
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId: id,
			principalType: "user",
			principalId: who.id,
			capability,
			createdAt: NOW,
		});
	}
	return id;
}

async function space(owner: Who, grants: Array<[Who, "read" | "write"]> = []) {
	return await ensureProjectSpace(await project(owner, grants));
}

async function write(target: OutlineSpaceRow, who: Who, ops: OutlineOp[]) {
	return await writeOutline({
		spaceId: target.id,
		ops,
		actor: { kind: "human", id: who.id },
		responsibleUserId: who.id,
	});
}

/** The live children of a parent, in sibling order, whole (a test reads them all). */
async function children(spaceId: string, parentId: string | null): Promise<OutlineBlockRow[]> {
	const { rows } = await outlineStore.listLevel(spaceId, parentId, { asOf: null, limit: 5000 });
	const blocks = await Promise.all(rows.map((row) => outlineStore.getBlock(row.id)));
	return blocks.filter((b): b is OutlineBlockRow => !!b);
}

/** A subtree as text: one line per block, indented, `[status]` for tasks, `?` for questions. */
async function shape(spaceId: string, rootId: string, skip?: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (id: string, depth: number) => {
		for (const child of await children(spaceId, id)) {
			if (child.id === skip) continue;
			const mark = child.taskJson ? `[${child.taskJson.status}] ` : child.askJson ? "? " : "";
			out.push(`${"  ".repeat(depth)}${mark}${child.content}`);
			await walk(child.id, depth + 1);
		}
	};
	const root = await outlineStore.getBlock(rootId);
	out.push(`${root?.taskJson ? `[${root.taskJson.status}] ` : ""}${root?.content}`);
	await walk(rootId, 1);
	return out;
}

function copyArgs(
	who: Who,
	sourceBlockId: string,
	target: OutlineSpaceRow,
	parentId: string | null,
	extra: Partial<OutlineSubtreeCopyRequest> = {},
): OutlineSubtreeCopyRequest {
	return {
		sourceBlockId,
		target: { space: target, parent: parentId === null ? null : { id: parentId } },
		copyId: `copy-${generateId()}`,
		actor: { kind: "human", id: who.id },
		responsibleUserId: who.id,
		provenance: { text: ({ source, omitted }) => `from ${source} (${omitted} left out)` },
		...extra,
	};
}

/** A source tree with a task in progress, a question, an alias, a tag and links between blocks. */
async function sourceTree(source: OutlineSpaceRow, who: Who, assignees: { person: string }) {
	await write(source, who, [
		{ op: "insert", tempId: "root", parent: null, content: "Design", alias: "design" },
		{ op: "insert", tempId: "a", sid: "AAAA0001", parent: { tempId: "root" }, content: "Goals" },
		{
			op: "insert",
			tempId: "t",
			parent: { tempId: "root" },
			content: `Build it, see [[${source.key}/AAAA0001]]`,
			task: { status: "doing", assignee: `human:${assignees.person}` },
		},
		{
			op: "insert",
			parent: { tempId: "t" },
			content: "Step two",
			task: {
				status: "todo",
				assignee: "agent:someone",
				depends: [{ target: "AAAA0001", label: null }],
			},
		},
		{ op: "insert", parent: { tempId: "a" }, content: "Fast", tags: ["perf"] },
		{
			op: "insert",
			parent: { tempId: "root" },
			content: "Which database?",
			ask: {
				to: { kind: "human", id: who.id },
				options: ["sqlite", "pg"],
				recommend: {},
			} as never,
		},
	]);
	const [root] = await outlineStore.findAliasOwners(source.id, ["design"]);
	return root as { id: string };
}

describe("copying a subtree", () => {
	test("in one space: shape, text, tasks to do, a question plain, links to copies, provenance first", async () => {
		const lead = await person("lead");
		const s = await space(lead);
		const root = await sourceTree(s, lead, { person: lead.username });
		await write(s, lead, [{ op: "insert", tempId: "dest", parent: null, content: "Archive" }]);
		const dest = (await children(s.id, null)).find(
			(b) => b.content === "Archive",
		) as OutlineBlockRow;
		const before = await shape(s.id, root.id);
		const result = await copyOutlineSubtree(copyArgs(lead, root.id, s, dest.id));
		expect(result.done).toBe(true);
		expect(result.commits).toBe(1);
		expect(result.copied).toBe(6);
		expect(result.omitted).toBe(0);
		// The source is as it was.
		expect(await shape(s.id, root.id)).toEqual(before);
		const copy = await outlineStore.getBlock(result.root.id);
		expect(copy?.parentId).toBe(dest.id);
		expect(copy?.alias).toBeNull();
		const kids = await children(s.id, result.root.id);
		// Provenance first, then the source's children in order.
		expect(kids[0]?.content).toBe(
			`from ${s.key}/${(await outlineStore.getBlock(root.id))?.sid} (0 left out)`,
		);
		expect(kids.slice(1).map((k) => k.content)).toEqual([
			"Goals",
			expect.stringContaining("Build it"),
			"Which database?",
		]);
		const goals = kids[1] as OutlineBlockRow;
		const build = kids[2] as OutlineBlockRow;
		const question = kids[3] as OutlineBlockRow;
		// The link names the copy of Goals, not Goals.
		expect(build.content).toBe(`Build it, see [[${s.key}/${goals.sid}]]`);
		expect(goals.sid).not.toBe("AAAA0001");
		expect(build.taskJson?.status).toBe("todo");
		expect(build.taskJson?.assignee).toBe(`human:${lead.username}`);
		expect(build.taskJson?.manager ?? null).toBeNull();
		expect(question.askJson).toBeNull();
		const [step] = await children(s.id, build.id);
		expect(step?.taskJson?.assignee ?? null).toBeNull();
		expect(step?.taskJson?.depends).toEqual([{ target: `${s.key}/${goals.sid}`, label: null }]);
		const [fast] = await children(s.id, goals.id);
		expect(fast?.content).toBe("Fast");
		const tags = await outlineStore.listLinksAt([fast?.id as string], null, ["tag"], 10);
		expect(tags).toEqual([]);
		// Its claims: none (the copy is to do, nobody holds it).
		expect(await outlineStore.getTaskClaims([build.id])).toEqual([]);
	});

	test("into another space: assignees only who may write it; a bare prerequisite still names the source", async () => {
		const lead = await person("lead");
		const outsider = await person("out");
		const writer = await person("wr");
		const from = await space(lead, [[outsider, "write"]]);
		const to = await space(lead, [[writer, "write"]]);
		await write(from, lead, [
			{ op: "insert", tempId: "r", sid: "RRRR0001", parent: null, content: "Root" },
			{
				op: "insert",
				parent: { tempId: "r" },
				content: "Mine",
				task: { status: "todo", assignee: `human:${writer.username}` },
			},
			{
				op: "insert",
				parent: { tempId: "r" },
				content: "Theirs",
				task: {
					status: "todo",
					assignee: `human:${outsider.username}`,
					depends: [{ target: "ZZZZ0009", label: null }],
				},
			},
		]);
		await write(from, lead, [
			{ op: "insert", sid: "ZZZZ0009", parent: null, content: "Elsewhere" },
		]);
		const [rootMeta] = await outlineStore.getBlockMetas(from.id, { sids: ["RRRR0001"] });
		const result = await copyOutlineSubtree(copyArgs(lead, rootMeta?.id as string, to, null));
		expect(result.done).toBe(true);
		expect(result.root.spaceId).toBe(to.id);
		expect(result.dropped).toBe(1);
		const kids = await children(to.id, result.root.id);
		expect(kids.map((k) => k.content)).toEqual([expect.stringContaining("from"), "Mine", "Theirs"]);
		expect(kids[1]?.taskJson?.assignee).toBe(`human:${writer.username}`);
		expect(kids[2]?.taskJson?.assignee ?? null).toBeNull();
		expect(kids[2]?.taskJson?.depends).toEqual([{ target: `${from.key}/ZZZZ0009`, label: null }]);
		// The top level of the target: the copy is there.
		expect((await children(to.id, null)).map((b) => b.id)).toContain(result.root.id);
	});

	test("bounds: blocks and bytes, breadth first, the rest counted", async () => {
		const lead = await person("lead");
		const s = await space(lead);
		const ops: OutlineOp[] = [{ op: "insert", tempId: "r", parent: null, content: "Root" }];
		for (let i = 0; i < 4; i++) {
			ops.push({ op: "insert", tempId: `c${i}`, parent: { tempId: "r" }, content: `child ${i}` });
			for (let j = 0; j < 3; j++)
				ops.push({ op: "insert", parent: { tempId: `c${i}` }, content: `grand ${i}.${j}` });
		}
		await write(s, lead, ops);
		const [root] = (await children(s.id, null)).filter((b) => b.content === "Root");
		// 6 blocks with the provenance: the root, the four children, one grandchild.
		const small = await copyOutlineSubtree(
			copyArgs(lead, root?.id as string, s, null, { limits: { blocks: 6 } }),
		);
		expect(small.copied).toBe(5);
		expect(small.omitted).toBe(12);
		expect((await shape(s.id, small.root.id)).slice(1)).toEqual([
			"  from " + `${s.key}/${root?.sid} (12 left out)`,
			"  child 0",
			"  child 1",
			"  child 2",
			"  child 3",
		]);
		// Bytes: the root's text alone fits.
		const tight = await copyOutlineSubtree(
			copyArgs(lead, root?.id as string, s, null, { limits: { bytes: 4 } }),
		);
		expect(tight.copied).toBe(1);
		expect(tight.omitted).toBe(16);
		expect(OUTLINE_SUBTREE_COPY_LIMITS.batchOps).toBeLessThanOrEqual(OUTLINE_LIMITS.maxOps);
	});

	test("batches: a large subtree in several commits, parents first, the order whole", async () => {
		const lead = await person("lead");
		const s = await space(lead);
		await write(s, lead, [{ op: "insert", tempId: "r", parent: null, content: "Root" }]);
		const [root] = await children(s.id, null);
		// 450 blocks: 15 children of 29 grandchildren each, written in commits the write path takes.
		for (let i = 0; i < 15; i++) {
			const ops: OutlineOp[] = [
				{ op: "insert", tempId: "c", parent: { id: root?.id as string }, content: `c${i}` },
			];
			for (let j = 0; j < 29; j++)
				ops.push({ op: "insert", parent: { tempId: "c" }, content: `g${i}.${j}` });
			await write(s, lead, ops);
		}
		const sizes: number[] = [];
		const result = await copyOutlineSubtree(
			copyArgs(lead, root?.id as string, s, null, {
				write: async (input, options) => {
					sizes.push(input.ops.length);
					return await writeOutline(input, options);
				},
			}),
		);
		expect(result.done).toBe(true);
		expect(result.copied).toBe(451);
		expect(result.commits).toBe(sizes.length);
		expect(sizes.length).toBe(3);
		for (const size of sizes) expect(size).toBeLessThanOrEqual(OUTLINE_LIMITS.maxOps);
		expect((await shape(s.id, result.root.id)).slice(2)).toEqual(
			(await shape(s.id, root?.id as string)).slice(1),
		);
	});

	test("an interrupted copy leaves a whole tree; the same copy id finishes it, nothing twice", async () => {
		const lead = await person("lead");
		const s = await space(lead);
		await write(s, lead, [{ op: "insert", tempId: "r", parent: null, content: "Root" }]);
		const [root] = await children(s.id, null);
		for (let i = 0; i < 10; i++) {
			const ops: OutlineOp[] = [
				{ op: "insert", tempId: "c", parent: { id: root?.id as string }, content: `c${i}` },
			];
			for (let j = 0; j < 39; j++)
				ops.push({ op: "insert", parent: { tempId: "c" }, content: `g${i}.${j}` });
			await write(s, lead, ops);
		}
		const args = copyArgs(lead, root?.id as string, s, null);
		let calls = 0;
		const first = await copyOutlineSubtree({
			...args,
			write: async (input, options) => {
				if (++calls === 2) throw new AppError("refused in a test", 409, "OUTLINE_TEST_REFUSED");
				return await writeOutline(input, options);
			},
		});
		expect(first.done).toBe(false);
		expect(first.commits).toBe(1);
		expect(first.stopped?.code).toBe("OUTLINE_TEST_REFUSED");
		expect(first.copied).toBeGreaterThan(0);
		expect(first.copied).toBeLessThan(401);
		// What is there is a whole tree: every copied block's parent is the root's copy or copied.
		const copiedIds = new Set<string>([first.root.id]);
		const stack = [first.root.id];
		while (stack.length > 0) {
			const id = stack.pop() as string;
			for (const child of await children(s.id, id)) {
				copiedIds.add(child.id);
				stack.push(child.id);
			}
		}
		// The root's copy, its provenance and what the first commit copied.
		expect(copiedIds.size).toBe(first.copied + 1);
		const again = await copyOutlineSubtree(args);
		expect(again.done).toBe(true);
		expect(again.copied).toBe(401);
		expect(again.root.id).toBe(first.root.id);
		expect(again.written).toBe(401 - first.copied);
		expect((await shape(s.id, again.root.id)).slice(2)).toEqual(
			(await shape(s.id, root?.id as string)).slice(1),
		);
		// Asked once more: nothing to write.
		const third = await copyOutlineSubtree(args);
		expect(third).toMatchObject({ done: true, written: 0, commits: 0, copied: 401 });
		expect((await children(s.id, null)).filter((b) => b.content === "Root")).toHaveLength(2);
	});

	test("a copy into the block itself or under it is refused; a deleted copy is not brought back", async () => {
		const lead = await person("lead");
		const s = await space(lead);
		await write(s, lead, [
			{ op: "insert", tempId: "r", parent: null, content: "Root" },
			{ op: "insert", tempId: "c", parent: { tempId: "r" }, content: "child" },
			{ op: "insert", parent: { tempId: "c" }, content: "grand" },
		]);
		const [root] = await children(s.id, null);
		const [child] = await children(s.id, root?.id as string);
		for (const parent of [root?.id, child?.id] as string[])
			await expect(
				copyOutlineSubtree(copyArgs(lead, root?.id as string, s, parent)),
			).rejects.toThrow(ValidationError);
		const args = copyArgs(lead, child?.id as string, s, null);
		const made = await copyOutlineSubtree(args);
		await write(s, lead, [{ op: "delete", block: { id: made.root.id } }]);
		const again = await copyOutlineSubtree(args);
		expect(again).toMatchObject({
			done: false,
			written: 0,
			stopped: { code: "OUTLINE_COPY_DELETED" },
		});
		expect(copiedBlockId(args.copyId, child?.id as string)).toBe(made.root.id);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Over HTTP
// ─────────────────────────────────────────────────────────────────────────────

function appAs(who: Who) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: who.id, role: who.role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) => {
		if (error instanceof AppError)
			return new Response(JSON.stringify(toErrorPayload(error)), {
				status: error.statusCode,
				headers: { "content-type": "application/json" },
			});
		return new Response(JSON.stringify({ error: String(error) }), { status: 500 });
	});
	app.route("/outline", outlineRoutes);
	return app;
}

async function post(who: Who, path: string, body: unknown) {
	const response = await appAs(who).request(`http://localhost/outline${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	let parsed: unknown = text;
	try {
		parsed = JSON.parse(text);
	} catch {
		// A plain 404.
	}
	return { status: response.status, body: parsed as OutlineCopyResponse & { code?: string } };
}

describe("POST /spaces/:spaceId/blocks/:blockId/copy", () => {
	test("both sides are checked: read the source, read and write the target", async () => {
		const lead = await person("lead");
		const reader = await person("rd");
		const stranger = await person("st");
		const from = await space(lead, [[reader, "read"]]);
		const to = await space(lead, [[reader, "write"]]);
		const readOnly = await space(lead, [[reader, "read"]]);
		const hidden = await space(lead);
		await write(from, lead, [
			{ op: "insert", tempId: "r", parent: null, content: "Root" },
			{ op: "insert", parent: { tempId: "r" }, content: "child", task: { status: "doing" } },
		]);
		const [root] = await children(from.id, null);
		await write(hidden, lead, [{ op: "insert", parent: null, content: "Secret" }]);
		const [secret] = await children(hidden.id, null);
		const path = (spaceId: string, blockId: string) => `/spaces/${spaceId}/blocks/${blockId}/copy`;
		const body = { targetSpaceId: to.id, parentId: null };

		const ok = await post(reader, path(from.id, root?.id as string), {
			...body,
			copyId: "copy-route-0001",
		});
		expect(ok.status).toBe(200);
		expect(ok.body).toMatchObject({ copyId: "copy-route-0001", done: true, copied: 2 });
		const kids = await children(to.id, ok.body.root.id);
		expect(kids.map((k) => k.taskJson?.status ?? null)).toEqual([null, "todo"]);
		expect(kids[0]?.content).toContain("Copied from [[");

		// The source unreadable: 404, as one that does not exist.
		expect((await post(reader, path(hidden.id, secret?.id as string), body)).status).toBe(404);
		expect((await post(reader, path("nope", "nope"), body)).status).toBe(404);
		// The block must be one of the space in the path.
		expect((await post(reader, path(from.id, secret?.id as string), body)).status).toBe(404);
		// The target: unreadable 404, read-only 403.
		expect(
			(await post(reader, path(from.id, root?.id as string), { ...body, targetSpaceId: hidden.id }))
				.status,
		).toBe(404);
		expect(
			(
				await post(reader, path(from.id, root?.id as string), {
					...body,
					targetSpaceId: readOnly.id,
				})
			).status,
		).toBe(403);
		expect((await post(stranger, path(from.id, root?.id as string), body)).status).toBe(404);
		// A target parent of another space: 404.
		expect(
			(await post(reader, path(from.id, root?.id as string), { ...body, parentId: secret?.id }))
				.status,
		).toBe(404);
		// A body outside the schema: 400.
		expect(
			(await post(reader, path(from.id, root?.id as string), { ...body, copyId: "bad id!" }))
				.status,
		).toBe(400);
	});
});
