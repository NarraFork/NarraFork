/**
 * Folded reads (readability F): `readBlockView` with `fold` spends its budget on what the page
 * shows open (`shared/outline-fold.ts` defaults with the reader's stored folding over them), and
 * `GET /spaces/:s/blocks/:b?fold=default` reads the reader's own stored folding.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case writes its own space.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { OutlineBlockViewResponse, OutlineViewBlock } from "@shared/outline-api";
import { buildFoldTree, visibleFoldRows } from "@shared/outline-fold";
import { Hono } from "hono";
import { db } from "../../../db";
import { users } from "../../../db/schema";
import { AppError } from "../../../lib/errors";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import { outlineRoutes } from "../../../routes/outline";
import { ensurePersonalSpace } from "../spaces";
import { writeViewState } from "../view-state";
import { readBlockView } from "../views";
import { type OutlineOp, writeOutline } from "../write";

const NOW = "2026-11-03T00:00:00.000Z";
const NONE = async () => ({ expanded: [], collapsed: [] });

beforeEach(() => {
	settings.outline.enabled = true;
});

async function user(): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `fold${id.replace(/[^A-Za-z0-9]/g, "")}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	return id;
}

interface Spec {
	key: string;
	text: string;
	task?: "todo" | "doing" | "done" | "cancelled";
	ask?: string;
	kids?: Spec[];
}

/** A page of a person's own space from a nested spec; block ids by the spec's keys. */
async function page(owner: string, specs: Spec[]) {
	const space = await ensurePersonalSpace(owner);
	const ops: OutlineOp[] = [{ op: "insert", tempId: "page", parent: null, content: "Tasks" }];
	const keys = ["page"];
	const walk = (list: Spec[], parent: string) => {
		for (const spec of list) {
			ops.push({
				op: "insert",
				tempId: spec.key,
				parent: { tempId: parent },
				content: spec.text,
				...(spec.task ? { task: { status: spec.task } } : {}),
				...(spec.ask ? { ask: { to: { kind: "human", id: spec.ask }, recommend: {} } } : {}),
			});
			keys.push(spec.key);
			walk(spec.kids ?? [], spec.key);
		}
	};
	walk(specs, "page");
	const written = await writeOutline({
		spaceId: space.id,
		ops,
		actor: { kind: "human", id: owner },
		responsibleUserId: owner,
	});
	const ids = new Map(
		keys.map((key, i) => [key, (written.results[i] as { blockId: string }).blockId]),
	);
	const id = (key: string) => ids.get(key) as string;
	const key = (blockId: string) => [...ids].find(([, value]) => value === blockId)?.[0] ?? blockId;
	return { space, id, key, pageId: id("page") };
}

const notes = (prefix: string, n: number): Spec[] =>
	Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i}`, text: `${prefix} note ${i}` }));

describe("a folded read", () => {
	test("takes one preview block under a finished task and everything under an open one", async () => {
		const me = await user();
		const p = await page(me, [
			{
				key: "done",
				text: "Finished",
				task: "done",
				kids: [
					{ key: "sub", text: "A sub task", task: "done" },
					{ key: "result", text: "The result", kids: notes("deep", 3) },
					...notes("d", 5),
				],
			},
			{
				key: "doing",
				text: "In progress",
				task: "doing",
				kids: [{ key: "detail", text: "A note", kids: notes("x", 4) }, ...notes("o", 2)],
			},
			{ key: "fact", text: "A fact", kids: notes("f", 2) },
		]);
		const view = await readBlockView({ blockId: p.pageId, view: "all", fold: NONE });
		const shown = new Set(view?.blocks.map((b) => p.key(b.id)));
		// The finished task: its first note (not the sub task before it), nothing under that.
		expect(shown.has("result")).toBe(true);
		for (const hidden of ["sub", "deep0", "d0", "d4"]) expect(shown.has(hidden)).toBe(false);
		// The open task: its children; the note under it is a detail, closed over its first block.
		for (const open of ["detail", "o0", "o1", "x0", "fact", "f0", "f1"]) {
			expect(shown.has(open)).toBe(true);
		}
		expect(shown.has("x1")).toBe(false);
		const by = new Map(view?.blocks.map((b) => [p.key(b.id), b]));
		expect(by.get("done")?.fold).toEqual({ kids: 7, size: 10 });
		expect(by.get("done")?.childIds).toEqual([p.id("result")]);
		expect(by.get("done")?.hidden).toBe(6);
		expect(by.get("result")?.hidden).toBe(3);
		expect(by.get("result")?.fold).toEqual({ kids: 3, size: 3 });
		expect(by.get("detail")?.fold).toEqual({ kids: 4, size: 4 });
		expect(by.get("doing")?.fold).toBeUndefined();
		expect(by.get("fact")?.fold).toBeUndefined();
		expect(view?.hiddenByFold).toBe(9 + 3);
		expect(view?.hiddenByBudget).toBe(0);

		// Without it, the read is the whole page, as before.
		const whole = await readBlockView({ blockId: p.pageId, view: "all" });
		expect(whole?.blocks).toHaveLength(23);
		expect(whole?.hiddenByFold).toBeUndefined();
		expect(whole?.blocks.some((b) => b.fold)).toBe(false);
	});

	test("shows the client every row its own folding draws, with the blocks they are read from", async () => {
		const me = await user();
		const p = await page(me, [
			{ key: "done", text: "Finished", task: "done", kids: notes("d", 3) },
			{
				key: "doing",
				text: "Doing",
				task: "doing",
				kids: [{ key: "n", text: "Note", kids: notes("x", 2) }],
			},
		]);
		const view = (await readBlockView({ blockId: p.pageId, view: "all", fold: NONE })) as {
			blocks: OutlineViewBlock[];
			rootId: string;
		};
		const byId = new Map(view.blocks.map((b) => [b.id, b]));
		const source = {
			children: (id: string) => byId.get(id)?.childIds ?? [],
			task: (id: string) => byId.get(id)?.task?.status ?? null,
			report: () => false,
		};
		const tree = buildFoldTree(source, { rootId: view.rootId });
		const { rows } = visibleFoldRows(tree, source);
		// Every row the default view draws is in the read, with its preview line's block.
		expect(rows.map((row) => p.key(row.node.id))).toEqual(["done", "doing", "n"]);
		for (const row of rows) {
			// A closed row's one line is read from a block of the read.
			expect(row.preview === null).toBe(row.node.open);
			if (row.preview) expect(byId.has(row.preview.textId)).toBe(true);
		}
	});

	test("honours what the reader opened and closed", async () => {
		const me = await user();
		const p = await page(me, [
			{ key: "done", text: "Finished", task: "done", kids: notes("d", 3) },
			{ key: "fact", text: "A fact", kids: notes("f", 3) },
		]);
		const view = await readBlockView({
			blockId: p.pageId,
			view: "all",
			fold: async () => ({ expanded: [p.id("done")], collapsed: [p.id("fact")] }),
		});
		const shown = new Set(view?.blocks.map((b) => p.key(b.id)));
		for (const key of ["d0", "d1", "d2", "f0"]) expect(shown.has(key)).toBe(true);
		for (const key of ["f1", "f2"]) expect(shown.has(key)).toBe(false);
		const by = new Map(view?.blocks.map((b) => [p.key(b.id), b]));
		expect(by.get("done")?.fold).toBeUndefined();
		expect(by.get("fact")?.fold).toEqual({ kids: 3, size: 3 });
	});

	test("a closed row over an unanswered question is read whole: the question stays reachable", async () => {
		const me = await user();
		const p = await page(me, [
			{
				key: "done",
				text: "Finished",
				task: "done",
				kids: [...notes("d", 2), { key: "q", text: "Which one?", ask: me }],
			},
		]);
		// By default the question keeps its ancestors open; closed by the reader, the row counts
		// it, so its blocks must be in the read.
		const closed = await readBlockView({
			blockId: p.pageId,
			view: "all",
			fold: async () => ({ expanded: [], collapsed: [p.id("done")] }),
		});
		const shown = new Set(closed?.blocks.map((b) => p.key(b.id)));
		expect(shown.has("q")).toBe(true);
		expect(closed?.blocks.find((b) => b.id === p.id("done"))?.fold).toBeUndefined();
		expect(closed?.blocks.find((b) => b.id === p.id("q"))?.question?.state).toBe("open");
	});

	test("the budget goes to open work: a page of big finished tasks still shows the open one", async () => {
		const me = await user();
		const finished: Spec[] = Array.from({ length: 12 }, (_, i) => ({
			key: `done${i}`,
			text: `Finished ${i}`,
			task: "done" as const,
			kids: notes(`r${i}_`, 14),
		}));
		const p = await page(me, [
			...finished,
			{ key: "open", text: "Open work", task: "doing", kids: notes("w", 5) },
		]);
		const budget = { blocks: 60, bytes: 64 * 1024 };
		const plain = await readBlockView({ blockId: p.pageId, view: "all", budget });
		expect(plain?.blocks.some((b) => p.key(b.id) === "w0")).toBe(false);
		const folded = await readBlockView({ blockId: p.pageId, view: "all", budget, fold: NONE });
		const shown = new Set(folded?.blocks.map((b) => p.key(b.id)));
		for (const key of ["open", "w0", "w4", "done11", "r11_0"]) expect(shown.has(key)).toBe(true);
		expect(folded?.blocks).toHaveLength(1 + 13 + 12 + 5);
		expect(folded?.hiddenByBudget).toBe(0);
		expect(folded?.hiddenByFold).toBe(12 * 13);
	});
});

describe("GET /spaces/:s/blocks/:b?fold=default", () => {
	function app(userId: string) {
		const instance = new Hono();
		instance.use("*", async (c, next) => {
			c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
			await next();
		});
		instance.onError((error) => {
			const status = error instanceof AppError ? error.statusCode : 500;
			return new Response(JSON.stringify({ error: error.message }), { status });
		});
		instance.route("/outline", outlineRoutes);
		return instance;
	}

	test("reads the caller's own stored folding of the page", async () => {
		const me = await user();
		const p = await page(me, [
			{ key: "done", text: "Finished", task: "done", kids: notes("d", 3) },
		]);
		const read = async (query: string) => {
			const res = await app(me).request(
				`http://localhost/outline/spaces/${p.space.id}/blocks/${p.pageId}?view=all${query}`,
			);
			expect(res.status).toBe(200);
			return (await res.json()) as OutlineBlockViewResponse;
		};
		expect((await read("")).blocks).toHaveLength(5);
		const folded = await read("&fold=default");
		expect(folded.blocks).toHaveLength(3);
		expect(folded.hiddenByFold).toBe(2);
		await writeViewState({ userId: me, isAdmin: false }, p.pageId, {
			collapsed: [],
			expanded: [p.id("done")],
			layout: "right",
		});
		const opened = await read("&fold=default");
		expect(opened.blocks).toHaveLength(5);
		expect(opened.hiddenByFold).toBe(0);
		const bad = await app(me).request(
			`http://localhost/outline/spaces/${p.space.id}/blocks/${p.pageId}?fold=all`,
		);
		expect(bad.status).toBe(400);
	});
});
