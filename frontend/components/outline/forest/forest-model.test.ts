/**
 * The forest's model against an in-memory outline (`forest-fake.ts`): lazy levels, "more",
 * paging past 2,000, the default folding with the reader's own over it and its storage, the
 * block watch's obligations (only what changed is read again), marks once per screen, locate.
 */
import { describe, expect, test } from "bun:test";
import { FakeOutline } from "./forest-fake";
import { FOREST_LIMITS, type ForestRow, SpaceForest } from "./forest-model";

/** Timers run by hand. */
function clock() {
	const timers: Array<{ fn: () => void; cancelled: boolean }> = [];
	return {
		delay: (fn: () => void) => {
			const timer = { fn, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
		async run() {
			for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn();
			await settle();
		},
	};
}

async function settle() {
	for (let i = 0; i < 40; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function titles(rows: readonly ForestRow[]): string[] {
	return rows.map((row) =>
		row.kind === "block"
			? `${"  ".repeat(row.depth)}${row.hasChildren ? (row.open ? "v " : "> ") : "- "}${row.block.content}`
			: row.kind === "more"
				? `${"  ".repeat(row.depth)}[${row.mode}]`
				: `${"  ".repeat(row.depth)}(${row.kind})`,
	);
}

async function forest(
	outline: FakeOutline,
	options: { rootId?: string | null; view?: "facts" | "all"; since?: number } = {},
) {
	const time = clock();
	const model = new SpaceForest({
		spaceId: outline.spaceId,
		rootId: options.rootId ?? null,
		view: options.view ?? "all",
		io: outline,
		delay: time.delay,
		since: options.since,
	});
	await model.load();
	await settle();
	return { model, time };
}

function sample(): FakeOutline {
	const o = new FakeOutline();
	o.add({ id: "top1", parentId: null, content: "Top one" });
	o.add({ id: "top2", parentId: null, content: "Top two" });
	o.add({ id: "fact", parentId: "top1", content: "A fact" });
	o.add({ id: "factKid", parentId: "fact", content: "Under the fact" });
	o.add({ id: "doing", parentId: "top1", content: "In progress", task: "doing" });
	o.add({ id: "note", parentId: "doing", content: "A note" });
	o.add({ id: "noteKid", parentId: "note", content: "Deep" });
	o.add({ id: "done", parentId: "top1", content: "Finished", task: "done" });
	o.add({ id: "result", parentId: "done", content: "Its result" });
	return o;
}

describe("a space's landing view", () => {
	test("top-level blocks, one line each, closed until the reader opens one", async () => {
		const outline = sample();
		const { model } = await forest(outline);
		expect(titles(model.getView().rows)).toEqual(["> Top one", "- Top two"]);
		model.toggle("top1");
		await settle();
		// Under it the default folding: a fact open, an open task's details and a finished task closed.
		expect(titles(model.getView().rows)).toEqual([
			"v Top one",
			"  v A fact",
			"    - Under the fact",
			"  v In progress",
			"    > A note",
			"  > Finished",
			"- Top two",
		]);
		// A closed row on screen gets the child its one line is read from.
		model.setViewport(0, 20);
		await settle();
		const rows = model.getView().rows;
		const done = rows.find((row) => row.kind === "block" && row.id === "done");
		expect(done?.kind === "block" && done.previewKind).toBe("result");
		expect(done?.kind === "block" && done.previewId).toBe("result");
	});

	test("the reader's folding is sent as changes and survives a reload", async () => {
		const outline = sample();
		const first = await forest(outline);
		first.model.toggle("top1");
		await settle();
		first.model.toggle("done");
		first.model.toggle("fact");
		await first.time.run();
		expect(outline.expanded).toEqual(new Set(["top1", "done"]));
		expect(outline.collapsed).toEqual(new Set(["fact"]));
		// Back to the default leaves no row behind.
		first.model.toggle("fact");
		await first.time.run();
		expect(outline.collapsed.size).toBe(0);
		expect(outline.calls.filter((c) => c.kind === "putFold").at(-1)?.detail).toBe("fact=null");
		const again = await forest(outline);
		expect(titles(again.model.getView().rows)).toEqual([
			"v Top one",
			"  v A fact",
			"    - Under the fact",
			"  v In progress",
			"    > A note",
			"  v Finished",
			"    - Its result",
			"- Top two",
		]);
		// One folded read brought all of it.
		expect(again.model.readCount).toBe(0);
	});

	test("an unanswered question under a row keeps it open, by the read and then by the marks", async () => {
		const outline = sample();
		outline.add({ id: "ask", parentId: "noteKid", content: "Which one?", question: "open" });
		outline.expanded.add("top1");
		const { model, time } = await forest(outline);
		expect(titles(model.getView().rows)).toContain("    v A note");
		// Answered: once the marks say so the row follows its default again.
		outline.edit("ask", { question: "answered" });
		model.setViewport(0, 20);
		await time.run();
		expect(titles(model.getView().rows)).toContain("    > A note");
	});
});

describe("lazy levels", () => {
	test("a long level ends in a row that reads the next chunk in place", async () => {
		const outline = new FakeOutline();
		outline.add({ id: "root", parentId: null, content: "Root" });
		outline.fill("root", "kid", 700);
		const { model } = await forest(outline, { rootId: "root" });
		// The folded read's budget is one screen; "more" continues from its cursor.
		let rows = model.getView().rows;
		expect(rows.at(-1)).toMatchObject({ kind: "more", mode: "more" });
		const had = rows.length - 1;
		await model.more("root", "more");
		rows = model.getView().rows;
		expect(rows.filter((row) => row.kind === "block").length).toBe(had + FOREST_LIMITS.chunk);
		await model.more("root", "more");
		rows = model.getView().rows;
		expect(rows.filter((row) => row.kind === "block").length).toBe(700);
		expect(rows.at(-1)?.kind).toBe("block");
		expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
	});

	test("a level with more than 2,000 children is paged in place, forward and back", async () => {
		const outline = new FakeOutline();
		outline.add({ id: "root", parentId: null, content: "Root" });
		outline.fill("root", "kid", 2700);
		const { model } = await forest(outline, { rootId: "root" });
		for (let i = 0; i < 20; i++) {
			const last = model.getView().rows.at(-1);
			if (last?.kind !== "more" || last.mode !== "more") break;
			await model.more("root", "more");
		}
		let rows = model.getView().rows;
		const blocksOf = () => model.getView().rows.filter((row) => row.kind === "block");
		expect(blocksOf().length).toBeLessThanOrEqual(FOREST_LIMITS.pagedAbove);
		expect(blocksOf().length).toBeGreaterThan(FOREST_LIMITS.pagedAbove - FOREST_LIMITS.chunk);
		expect(rows.at(-1)).toMatchObject({ kind: "more", mode: "next" });
		const firstWindow = blocksOf().length;
		await model.more("root", "next");
		rows = model.getView().rows;
		expect(rows[0]).toMatchObject({ kind: "more", mode: "prev", before: firstWindow });
		expect(blocksOf().length).toBe(FOREST_LIMITS.page);
		expect((blocksOf()[0] as { id: string }).id).toBe(`kid-${firstWindow}`);
		await model.more("root", "next");
		expect(blocksOf().length).toBe(2700 - firstWindow - FOREST_LIMITS.page);
		expect(model.getView().rows.at(-1)?.kind).toBe("block");
		await model.more("root", "prev");
		await model.more("root", "prev");
		expect(model.getView().rows[0]?.kind).toBe("block");
		expect(blocksOf().length).toBe(firstWindow);
		expect((blocksOf()[0] as { id: string }).id).toBe("kid-0");
	});

	test("past the budget an open row waits for the reader", async () => {
		const outline = new FakeOutline();
		outline.add({ id: "root", parentId: null, content: "Root" });
		for (let i = 0; i < 12; i++) {
			outline.add({ id: `p${i}`, parentId: "root", content: `Parent ${i}` });
			outline.fill(`p${i}`, `p${i}k`, 200);
		}
		const { model } = await forest(outline, { rootId: "root" });
		await settle();
		const rows = model.getView().rows;
		expect(model.size).toBeLessThan(FOREST_LIMITS.autoRows + FOREST_LIMITS.readBlocks);
		const waiting = rows.filter((row) => row.kind === "more" && row.mode === "load");
		expect(waiting.length).toBeGreaterThan(0);
		const key = (waiting[0] as { parentKey: string }).parentKey;
		await model.more(key, "load");
		await settle();
		expect(model.levelOf(key)?.ids.length).toBe(200);
	});

	test("the facts view leaves tasks out and says how many", async () => {
		const outline = sample();
		const { model } = await forest(outline, { rootId: "top1", view: "facts" });
		expect(titles(model.getView().rows)).toEqual(["v A fact", "  - Under the fact"]);
		expect(model.getView().processHidden).toBe(2);
	});
});

describe("live", () => {
	test("only the level a commit concerns is read again; a leaf gains its arrow", async () => {
		const outline = sample();
		outline.expanded.add("top1");
		const { model } = await forest(outline);
		model.setViewport(0, 50);
		await settle();
		model.onWatching(outline.seq, model.watchKeys());
		const before = outline.calls.length;
		// A first child under "Under the fact": the watch names its parent's level (`fact`) and
		// the new block's own (`factKid`).
		outline.add({ id: "new", parentId: "factKid", content: "New child" });
		model.onChanged({ seq: outline.seq, levels: ["fact", "factKid"], subtrees: [], all: false });
		await settle();
		const reads = outline.calls.slice(before).filter((c) => c.kind === "children");
		// … and then the level that just opened; nothing else of the tree.
		expect(reads.map((c) => c.detail)).toEqual(["fact", "factKid"]);
		expect(titles(model.getView().rows)).toContain("    v Under the fact");
		await settle();
		expect(titles(model.getView().rows)).toContain("      - New child");
	});

	test("a watch confirmed past what was read reads everything near again; an old frame nothing", async () => {
		const outline = sample();
		outline.expanded.add("top1");
		const { model } = await forest(outline);
		model.setViewport(0, 50);
		await settle();
		const seen = outline.seq;
		let before = outline.calls.length;
		model.onWatching(seen, model.watchKeys());
		await settle();
		// Every key is new in the set, but all were read at this seq: nothing to read.
		expect(outline.calls.slice(before).filter((c) => c.kind === "children")).toEqual([]);
		outline.edit("fact", { content: "A fact, edited" });
		before = outline.calls.length;
		model.onWatching(outline.seq, { levels: [], subtrees: [] });
		await settle();
		expect(outline.calls.slice(before).some((c) => c.kind === "children")).toBe(true);
		expect(titles(model.getView().rows)).toContain("  v A fact, edited");
		expect(model.knownSeq).toBe(outline.seq);
	});

	test("marks are one read for the rows on screen, and again after a change, never per row", async () => {
		const outline = sample();
		outline.expanded.add("top1");
		outline.add({ id: "ask", parentId: "result", content: "Sure?", question: "open" });
		outline.collapsed.add("done");
		const { model, time } = await forest(outline, { since: 0 });
		model.setViewport(0, 50);
		model.setViewport(0, 50);
		await time.run();
		const reads = outline.calls.filter((c) => c.kind === "marks");
		expect(reads.length).toBe(1);
		expect(reads[0]?.detail).toContain("since0");
		expect(model.marksOf("done")?.questions).toBe(1);
		model.onChanged({ seq: outline.seq + 1, levels: [], subtrees: ["done"], all: false });
		model.onChanged({ seq: outline.seq + 2, levels: [], subtrees: ["done"], all: false });
		await time.run();
		expect(outline.calls.filter((c) => c.kind === "marks").length).toBe(2);
	});
});

describe("locate and everything inside", () => {
	test("a block behind closed rows gets a row: its ancestors open for this visit, unstored", async () => {
		const outline = sample();
		const { model, time } = await forest(outline);
		const found = model.locate(["top1", "doing", "note"], "noteKid");
		await settle();
		expect(await found).toBe(true);
		expect(model.getView().indexOf.has("noteKid")).toBe(true);
		await time.run();
		expect(outline.expanded.size).toBe(0);
	});

	test("a block past its level's window is pinned above it", async () => {
		const outline = new FakeOutline();
		outline.add({ id: "root", parentId: null, content: "Root" });
		outline.fill("root", "kid", 900);
		outline.add({ id: "deep", parentId: "kid-850", content: "Deep" });
		const { model } = await forest(outline);
		const found = model.locate(["root", "kid-850"], "deep");
		await settle();
		expect(await found).toBe(true);
		const rows = model.getView().rows;
		const pinned = rows.find((row) => row.kind === "block" && row.id === "kid-850");
		expect(pinned?.kind === "block" && pinned.pinned).toBe(true);
		expect(model.getView().indexOf.has("deep")).toBe(true);
	});

	test("what is not under the forest's root is not found", async () => {
		const outline = sample();
		const { model } = await forest(outline, { rootId: "fact" });
		expect(await model.locate(["top1", "doing"], "note")).toBe(false);
	});

	test("everything inside a row opens what loads under it; back to the default drops it", async () => {
		const outline = sample();
		outline.expanded.add("top1");
		const { model, time } = await forest(outline);
		const top = model.getView().rows[0];
		expect(top?.kind === "block" && top.subtree).toBe("expand");
		model.foldInside("top1", true);
		await settle();
		expect(titles(model.getView().rows)).toEqual([
			"v Top one",
			"  v A fact",
			"    - Under the fact",
			"  v In progress",
			"    v A note",
			"      - Deep",
			"  v Finished",
			"    - Its result",
			"- Top two",
		]);
		const now = model.getView().rows[0];
		expect(now?.kind === "block" && now.subtree).toBe("collapse");
		model.foldInside("top1", false);
		await time.run();
		expect(titles(model.getView().rows)).toContain("    > A note");
		expect(outline.expanded).toEqual(new Set(["top1"]));
	});

	test("a closed row's questions: opened, and the form comes up under the first", async () => {
		const outline = sample();
		outline.expanded.add("top1");
		outline.collapsed.add("doing");
		outline.add({ id: "ask", parentId: "noteKid", content: "Which one?", question: "open" });
		const { model } = await forest(outline);
		expect(titles(model.getView().rows)).toContain("  > In progress");
		model.openQuestions("doing");
		await settle();
		const rows = model.getView().rows;
		const at = rows.findIndex((row) => row.kind === "block" && row.id === "ask");
		expect(at).toBeGreaterThan(0);
		expect(rows[at + 1]).toMatchObject({ kind: "form", under: "noteKid" });
	});
});

describe("failures", () => {
	test("a root that cannot be read says which way", async () => {
		const outline = sample();
		const gone = await forest(outline, { rootId: "nope" });
		expect(gone.model.status).toBe("missing");
		outline.failNext = 409;
		expect((await forest(outline)).model.status).toBe("unavailable");
		outline.failNext = 500;
		expect((await forest(outline)).model.status).toBe("error");
	});
});
