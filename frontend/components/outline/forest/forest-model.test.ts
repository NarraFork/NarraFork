/**
 * The forest's model against an in-memory outline (`forest-fake.ts`): lazy levels, "more",
 * paging past 2,000, the default folding with the reader's own over it and its storage, the
 * block watch's obligations (only what changed is read again), marks once per screen, locate.
 * The last groups are the review's findings: changes landing while a read is in flight, fold
 * writes the server's limits would refuse, reconnects, a focused root deleted or moved, a
 * transient deny, locate by one request.
 */
import { describe, expect, test } from "bun:test";
import { FOLD_MAX_OPEN_DEPTH } from "@shared/outline-fold";
import { FakeOutline } from "./forest-fake";
import {
	DENIED_RETRIES,
	FOLD_CHUNK_CHANGES,
	FOLD_LEAVE_BYTES,
	FOLD_RETRIES,
	FOREST_LIMITS,
	type ForestRow,
	SpaceForest,
} from "./forest-model";

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
		/** Timers waiting (not cancelled). */
		get waiting() {
			return timers.filter((timer) => !timer.cancelled).length;
		},
	};
}

/** A fake whose `children` answers are computed at call time but held until released. */
class Gated extends FakeOutline {
	hold = false;
	held: Array<() => void> = [];
	override async children(spaceId: string, params: Parameters<FakeOutline["children"]>[1]) {
		const answer = await super.children(spaceId, params);
		if (!this.hold) return answer;
		return new Promise<typeof answer>((resolve) => this.held.push(() => resolve(answer)));
	}
	release() {
		this.hold = false;
		for (const go of this.held.splice(0)) go();
	}
}

const count = (outline: FakeOutline, kind: string) =>
	outline.calls.filter((call) => call.kind === kind).length;

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
		// Back to the default inside it, the row itself included (a top-level row: closed).
		expect(titles(model.getView().rows)).toEqual(["> Top one", "- Top two"]);
		expect(outline.expanded.size).toBe(0);
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

describe("a change that lands while its level is being read", () => {
	test("the level stays stale and is read again (the newer frame is not lost)", async () => {
		const o = new Gated();
		o.add({ id: "top1", parentId: null, content: "Top one" });
		o.add({ id: "fact", parentId: "top1", content: "v0" });
		o.expanded.add("top1");
		const { model, time } = await forest(o);
		model.setViewport(0, 50);
		await settle();
		model.onWatching(o.seq, model.watchKeys());
		await settle();
		o.hold = true;
		o.edit("fact", { content: "v1" });
		model.onChanged({ seq: o.seq, levels: ["top1"], subtrees: [], all: false });
		await settle();
		// The read of top1 (answering as of v1) is on its way …
		expect(o.held.length).toBe(1);
		// … when v2 lands and its frame arrives first.
		o.edit("fact", { content: "v2" });
		model.onChanged({ seq: o.seq, levels: ["top1"], subtrees: [], all: false });
		await settle();
		o.release();
		await settle();
		await time.run();
		expect(titles(model.getView().rows)).toContain("  - v2");
		expect(model.levelOf("top1")?.seq).toBe(o.seq);
	});

	test("a frame told before the read started is answered by that read (no loop)", async () => {
		const o = sample();
		o.expanded.add("top1");
		const { model } = await forest(o);
		model.setViewport(0, 50);
		await settle();
		const before = count(o, "children");
		// A frame naming a seq the read will not reach (the server's read is never older than
		// a commit it was told of before it started): one read, not an endless loop.
		model.onChanged({ seq: o.seq + 5, levels: ["top1"], subtrees: [], all: false });
		await settle();
		expect(count(o, "children") - before).toBe(1);
	});

	test("changes waiting for confirmation (no seq) during a read are not lost either", async () => {
		const o = new Gated();
		o.add({ id: "top1", parentId: null, content: "Top one" });
		o.add({ id: "fact", parentId: "top1", content: "v0" });
		o.expanded.add("top1");
		const { model } = await forest(o);
		model.setViewport(0, 50);
		await settle();
		o.hold = true;
		model.onPending();
		await settle();
		expect(o.held.length).toBe(1);
		model.onPending();
		o.edit("fact", { content: "after" });
		o.release();
		await settle();
		expect(titles(model.getView().rows)).toContain("  - after");
	});
});

describe("the reader's folding is saved within the server's limits", () => {
	function many(): FakeOutline {
		const o = new FakeOutline();
		o.add({ id: "top1", parentId: null, content: "Top" });
		for (let i = 0; i < 30; i++) {
			o.add({ id: `t${i}`, parentId: "top1", content: `task ${i}`, task: "done" });
			for (let j = 0; j < 25; j++) {
				o.add({ id: `t${i}-${j}`, parentId: `t${i}`, content: `sub ${j}`, task: "done" });
				o.add({ id: `t${i}-${j}-x`, parentId: `t${i}-${j}`, content: "x" });
			}
		}
		return o;
	}

	test("everything inside a big row: writes of at most 500 changes, in order, all saved", async () => {
		const o = many();
		const { model, time } = await forest(o);
		model.setViewport(0, 5000);
		model.foldInside("top1", true);
		for (let i = 0; i < 20; i++) await time.run();
		const sizes = o.calls
			.filter((c) => c.kind === "putFold")
			.map((c) => c.detail.split(",").length);
		expect(sizes.length).toBeGreaterThan(1);
		expect(Math.max(...sizes)).toBeLessThanOrEqual(FOLD_CHUNK_CHANGES);
		// Everything the reader opened is stored (800 rows at most open, the row itself too).
		expect(o.expanded.size).toBe(sizes.reduce((sum, n) => sum + n, 0));
		expect(o.expanded.size).toBeGreaterThan(500);
		expect(model.foldSaveFailed).toBe(false);
	});

	test("a failed write keeps its changes, is tried again with a growing delay, then says so", async () => {
		const o = sample();
		o.expanded.add("top1");
		const { model, time } = await forest(o);
		o.foldFails = 100;
		model.toggle("fact");
		await time.run(); // the debounced write: fails
		expect(o.collapsed.has("fact")).toBe(false);
		for (let i = 0; i < FOLD_RETRIES; i++) {
			expect(time.waiting).toBe(1);
			await time.run();
		}
		expect(count(o, "putFold")).toBe(FOLD_RETRIES + 1);
		// No more automatic tries; the forest says the folding could not be saved.
		expect(time.waiting).toBe(0);
		expect(model.foldSaveFailed).toBe(true);
		// The reader's "try again": it is still queued, and goes.
		o.foldFails = 0;
		model.retryFoldSave();
		await settle();
		expect(o.collapsed.has("fact")).toBe(true);
		expect(model.foldSaveFailed).toBe(false);
	});

	test("a change made while a failed write waits for its retry is not undone by the retry", async () => {
		const o = sample();
		o.expanded.add("top1");
		const { model, time } = await forest(o);
		o.foldFails = 1;
		model.toggle("fact"); // closed
		await time.run(); // fails, retry scheduled
		model.toggle("fact"); // open again: back to the default (null)
		await time.run();
		await time.run();
		expect(o.collapsed.has("fact")).toBe(false);
		expect(model.foldOf("fact")).toBe(null);
	});

	test("back to the default is ONE reset request, whatever was stored", async () => {
		const o = many();
		const { model, time } = await forest(o);
		model.setViewport(0, 5000);
		model.foldInside("top1", true);
		for (let i = 0; i < 20; i++) await time.run();
		const puts = count(o, "putFold");
		// Something stored for a block not loaded here: the reset covers it too.
		o.expanded.add("t3-3");
		model.foldInside("top1", false);
		for (let i = 0; i < 3; i++) await time.run();
		expect(count(o, "putFold")).toBe(puts);
		expect(o.calls.filter((c) => c.kind === "resetFold").map((c) => c.detail)).toEqual(["top1"]);
		expect(o.expanded.size).toBe(0);
		expect(titles(model.getView().rows)).toEqual(["> Top"]);
	});

	test("as the page goes away: sent at once with keepalive, within the browser's budget", async () => {
		const o = many();
		const { model, time } = await forest(o);
		model.setViewport(0, 5000);
		model.foldInside("top1", true);
		await settle();
		// Nothing flushed yet (the debounce has not run); a write is in flight forever.
		const sent = model.leave();
		expect(sent).toBeLessThanOrEqual(FOLD_LEAVE_BYTES);
		expect(o.keepalive.length).toBeGreaterThan(0);
		const total = o.keepalive.reduce((sum, body) => sum + body.length, 0);
		expect(total).toBeLessThan(64 * 1024);
		for (const body of o.keepalive)
			expect((JSON.parse(body) as { changes: unknown[] }).changes.length).toBeLessThanOrEqual(
				FOLD_CHUNK_CHANGES,
			);
		await time.run();
	});

	test("folding done while the stored folding is read is not overwritten by it", async () => {
		const o = sample();
		const time = clock();
		const model = new SpaceForest({
			spaceId: o.spaceId,
			rootId: null,
			view: "all",
			io: o,
			delay: time.delay,
		});
		const loading = model.load();
		// (No rows yet: a change the reader made in another surface of this model.)
		(model as unknown as { queueFold(id: string, open: boolean | null): void }).queueFold(
			"top1",
			true,
		);
		await loading;
		await settle();
		expect(model.foldOf("top1")).toBe("expanded");
		await time.run();
		expect(o.expanded.has("top1")).toBe(true);
	});
});

describe("reconnects, the focused root, a transient deny", () => {
	test("after a reconnect the marks of closed rows are read again (an open question opens it)", async () => {
		const o = sample();
		o.add({ id: "deep", parentId: "factKid", content: "deep" });
		const { model, time } = await forest(o);
		model.setViewport(0, 50);
		await time.run();
		model.onWatching(o.seq, model.watchKeys());
		await time.run();
		expect(model.marksOf("top1")?.questions).toBe(0);
		// The socket drops; a question is added under top1; a level read over HTTP meanwhile
		// moves what the forest knows past the last marks read.
		o.add({ id: "ask", parentId: "deep", content: "?", question: "open" });
		await (
			model as unknown as { readFromStart(k: string[], p: boolean): Promise<void> }
		).readFromStart(["top2"], false);
		expect(model.knownSeq).toBe(o.seq);
		// Reconnected: every key is new.
		model.onWatching(o.seq, model.watchKeys());
		await time.run();
		await time.run();
		expect(model.marksOf("top1")?.questions).toBe(1);
	});

	test("a focused root that is deleted shows missing; one that moved updates its path", async () => {
		const o = sample();
		o.add({ id: "elsewhere", parentId: null, content: "Elsewhere" });
		const { model, time } = await forest(o, { rootId: "fact" });
		model.setViewport(0, 50);
		await time.run();
		expect(model.watchKeys().subtrees).toContain("fact");
		expect(model.path.map((step) => step.id)).toEqual(["top1"]);
		// Moved under "Elsewhere".
		o.remove("fact");
		o.add({ id: "fact", parentId: "elsewhere", content: "A fact" });
		o.add({ id: "factKid", parentId: "fact", content: "Under the fact" });
		model.onChanged({ seq: o.seq, levels: [], subtrees: ["fact"], all: false });
		await time.run();
		expect(model.path.map((step) => step.id)).toEqual(["elsewhere"]);
		expect(model.status).toBe("ready");
		// Deleted.
		o.remove("factKid");
		o.remove("fact");
		model.onChanged({ seq: o.seq, levels: ["fact"], subtrees: ["fact"], all: false });
		await time.run();
		expect(model.status).toBe("missing");
	});

	test("a transient deny asks the watch again with a growing delay, a bounded number of times", async () => {
		const o = sample();
		const { model, time } = await forest(o);
		let rewatched = 0;
		for (let i = 0; i < DENIED_RETRIES + 2; i++) {
			expect(await model.onDenied(() => rewatched++)).toBe("transient");
			await time.run();
		}
		expect(rewatched).toBe(DENIED_RETRIES);
		// A confirmation starts over.
		model.onWatching(o.seq, { levels: [], subtrees: [] });
		await model.onDenied(() => rewatched++);
		await time.run();
		expect(rewatched).toBe(DENIED_RETRIES + 1);
		// Gone for real: missing, and no more asking.
		o.failNext = 404;
		expect(await model.onDenied(() => rewatched++)).toBe("missing");
		expect(model.status).toBe("missing");
	});
});

describe("locate in one round trip", () => {
	test("all the ancestors' levels are read by ONE children request", async () => {
		const o = new FakeOutline();
		let parent: string | null = null;
		const chain: string[] = [];
		for (let i = 0; i < 12; i++) {
			const id = `d${i}`;
			o.add({ id, parentId: parent, content: `Depth ${i}` });
			o.add({ id: `${id}-sib`, parentId: parent, content: `Sibling ${i}` });
			chain.push(id);
			parent = id;
		}
		o.add({ id: "target", parentId: parent, content: "Target" });
		const { model } = await forest(o);
		const before = count(o, "children");
		const found = model.locate(chain, "target");
		await settle();
		expect(await found).toBe(true);
		expect(count(o, "children") - before).toBe(1);
		expect(model.getView().indexOf.has("target")).toBe(true);
	});

	test("a located block deeper than the default's depth limit still opens its way", async () => {
		const o = new FakeOutline();
		let parent: string | null = null;
		const chain: string[] = [];
		for (let i = 0; i < FOLD_MAX_OPEN_DEPTH + 5; i++) {
			const id = `n${i}`;
			o.add({ id, parentId: parent, content: `Level ${i}` });
			chain.push(id);
			parent = id;
		}
		o.add({ id: "bottom", parentId: parent, content: "Bottom" });
		const { model } = await forest(o);
		const found = model.locate(chain, "bottom");
		for (let i = 0; i < 20; i++) await settle();
		expect(await found).toBe(true);
		expect(model.getView().indexOf.has("bottom")).toBe(true);
	}, 30_000);
});
