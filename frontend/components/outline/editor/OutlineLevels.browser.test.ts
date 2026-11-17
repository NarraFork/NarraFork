/**
 * Only expanded blocks are loaded and in the editor (pageless plan, L4), in Chromium against the
 * real outline routes and live sessions:
 *
 *   - a closed block's children are not in the editor document; what it hides is counted on its
 *     row from the block model;
 *   - a page too large to watch whole (more than `OUTLINE_LIVE_LIMITS.maxWatchBlocks` blocks)
 *     goes live by levels: opening a block too large to watch whole loads what it shows,
 *     closing it lets that go (unwatched), and a change someone made inside it meanwhile shows
 *     when it is opened;
 *   - a block closed while an input method composes in it: the composition ends in it, then
 *     what it holds leaves the document.
 *
 * Text is Latin where widths matter (CI has no CJK fonts): the assertions are structural.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { liveSpaceOf } from "../../../../server/services/outline/live/registry";
import { writeOutline } from "../../../../server/services/outline/write";
import {
	type Editor,
	errorsOf,
	type Harness,
	ime,
	openEditor,
	resetHarness,
	seedPage,
	serverText,
	settle,
	startHarness,
	stopHarness,
	until,
} from "./outline-live-harness.browser-fixture";

let h: Harness;

beforeAll(async () => {
	h = await startHarness();
}, 60_000);

afterAll(async () => {
	await stopHarness(h);
});

afterEach(async () => {
	await resetHarness(h);
});

/** Block ids in the editor document, in order. */
const inDoc = (e: Editor) =>
	e.call((f) => {
		const out: string[] = [];
		f.view().pm.state.doc.descendants((n) => {
			if (n.type.name === "block") out.push(n.attrs.id as string);
			return n.type.name === "block" || n.type.name === "children";
		});
		return out;
	});
const loaded = (e: Editor, id: string) =>
	e.call((f, x) => !!f.client().visible.alive(x as never), id);
const watches = (e: Editor) =>
	e.call((f) =>
		f
			.client()
			.watchSet.map((w) => ("s" in w ? `s:${w.s}` : `l:${w.l ?? ""}`))
			.sort(),
	);

async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean, label: string) {
	const end = Date.now() + 10_000;
	let last = await read();
	while (!ok(last) && Date.now() < end) {
		await new Promise((r) => setTimeout(r, 20));
		last = await read();
	}
	if (!ok(last)) throw new Error(`${label}: ${JSON.stringify(last).slice(0, 400)}`);
	return last;
}

test("a closed block's children are not in the document; opening puts them in, closing takes them out", async () => {
	const lines = [
		"[x] Done task",
		"  Result note",
		"    Deeper",
		"  Second note",
		"Open fact",
		"  Fact child",
	];
	const { pageId, ids } = await seedPage(h, "Levels small", lines);
	const [done, result, deeper, second, fact, factChild] = ids as [
		string,
		string,
		string,
		string,
		string,
		string,
	];
	const a = await openEditor(h, h.owner, pageId);
	// The done task is closed by default: its notes are not in the document, its row says so.
	expect(await inDoc(a)).toEqual([pageId, done, fact, factChild]);
	expect(await a.call(() => document.querySelectorAll(".ob-block").length)).toBe(4);
	expect(await loaded(a, deeper)).toBe(true);
	const preview = await a.call(
		(f, id) => f.dom(id as never)?.querySelector(".ob-preview-text")?.textContent ?? null,
		done,
	);
	expect(preview).toBe("Result note");

	// Someone else changes a block inside it: the preview follows, nothing opens.
	await writeOutline({
		spaceId: h.space.id,
		ops: [{ op: "update", block: { id: result }, content: "Result note, changed" }],
		actor: { kind: "human", id: h.writer },
		responsibleUserId: h.writer,
	});
	await until(
		a,
		(f, id) =>
			f.dom(id as never)?.querySelector(".ob-preview-text")?.textContent === "Result note, changed",
		[done],
	);
	expect(await inDoc(a)).toEqual([pageId, done, fact, factChild]);

	// Opened: its children are put into the document, with the change.
	await a.call((f, id) => f.view().toggleCollapse(id as never), done);
	expect(await inDoc(a)).toEqual([pageId, done, result, second, fact, factChild]);
	expect(await a.call((f, id) => f.viewText(id as never), result)).toBe("Result note, changed");
	// Closed again: taken out.
	await a.call((f, id) => f.view().toggleCollapse(id as never), done);
	expect(await inDoc(a)).toEqual([pageId, done, fact, factChild]);
	expect(await a.call((f) => f.viewOutline())).toBe(
		[
			"- [x] Done task",
			"  - Result note, changed",
			"    - Deeper",
			"  - Second note",
			"- Open fact",
			"  - Fact child",
		].join("\n"),
	);
	expect(errorsOf(a)).toEqual([]);
}, 60_000);

test("a block closed while an input method composes in it keeps the composition, then takes what it holds out", async () => {
	const { pageId, ids } = await seedPage(h, "Levels ime", [
		"Parent",
		"  Child one",
		"  Child two",
		"Other",
	]);
	const [parent, one, two, other] = ids as [string, string, string, string];
	const a = await openEditor(h, h.owner, pageId);
	expect(await inDoc(a)).toEqual([pageId, parent, one, two, other]);
	await a.call((f, id) => f.caret(id as never), parent);
	const input = ime(a);
	await input.set("ni");
	expect(await a.call((f) => f.composing())).toBe(true);
	// The reader closes the block the composition is in (the arrow, as another view would).
	await a.call((f, id) => f.view().toggleCollapse(id as never), parent);
	// The block being composed in is not touched until the composition ends.
	expect(await a.call((f) => f.composing())).toBe(true);
	expect(await inDoc(a)).toEqual([pageId, parent, one, two, other]);
	await input.set("nihao");
	await input.commit("你好");
	await settle(a);
	expect(serverText(pageId, parent)).toBe("Parent你好");
	await until(a, (f, id) => f.dom(id as never)?.classList.contains("collapsed") === true, [parent]);
	expect(await inDoc(a)).toEqual([pageId, parent, other]);
	expect((await a.call((f) => f.where()))?.blockId).toBe(parent);
	// Typing goes on in its line.
	await a.page.keyboard.type("!");
	await settle(a);
	expect(serverText(pageId, parent)).toBe("Parent你好!");
	expect(serverText(pageId, one)).toBe("Child one");
	expect(serverText(pageId, two)).toBe("Child two");
	expect(errorsOf(a)).toEqual([]);
}, 60_000);

test("a page too large to watch whole goes live by levels: opening loads, closing lets go", async () => {
	// A finished task holding three parts of 700 notes each (2,104 blocks: too large for one
	// watch), and two small blocks; 2,110 blocks under the page.
	const lines: string[] = ["[x] Big"];
	for (let p = 0; p < 3; p++) {
		lines.push(`  Part ${p}`);
		for (let i = 0; i < 700; i++) lines.push(`    p${p} note ${i}`);
	}
	lines.push("Small fact", "  Small child", "[x] Done small", "  Done note", "  Done note two");
	const { pageId, ids } = await seedPage(h, "Levels big", lines);
	const idOf = (text: string) =>
		ids[lines.findIndex((l) => l.trim().replace(/^\[.\] /, "") === text)] as string;
	const big = idOf("Big");
	const part1 = idOf("Part 1");
	const note15 = idOf("p1 note 5");
	const small = idOf("Small fact");
	const doneSmall = idOf("Done small");
	const a = await openEditor(h, h.owner, pageId);
	// The top level (the page itself is in it), the page's level, each small block whole, the
	// big one by its level (it is too large).
	const base = ["l:", `l:${pageId}`, `l:${big}`, `s:${small}`, `s:${doneSmall}`].sort();
	await waitFor(
		() => watches(a),
		(w) => JSON.stringify(w) === JSON.stringify(base),
		"watched",
	);
	expect(await a.call((f, id) => f.client().watchRefused.get(`s:${id}`) ?? null, big)).toBe(
		"too_large",
	);
	expect(await loaded(a, part1)).toBe(true);
	expect(await loaded(a, note15)).toBe(false);
	// Closed by default: the big task shows its first part as its preview.
	expect(
		await a.call(
			(f, id) => f.dom(id as never)?.querySelector(".ob-preview-text")?.textContent ?? null,
			big,
		),
	).toBe("Part 0");
	const docSize = (await inDoc(a)).length;
	expect(docSize).toBeLessThan(10);

	// Someone else changes a note inside it, which this editor has not loaded.
	await writeOutline({
		spaceId: h.space.id,
		ops: [{ op: "update", block: { id: note15 }, content: "p1 note 5, changed" }],
		actor: { kind: "human", id: h.writer },
		responsibleUserId: h.writer,
	});

	// Opened: each part it shows is loaded whole (each fits one watch).
	await a.call((f, id) => f.view().toggleCollapse(id as never), big);
	await waitFor(
		() => watches(a),
		(w) => [0, 1, 2].every((p) => w.includes(`s:${idOf(`Part ${p}`)}`)),
		"the parts watched",
	);
	await waitFor(
		() => loaded(a, note15),
		(x) => x,
		"the part's notes loaded",
	);
	// The parts are details: closed, so their notes are loaded but not in the document.
	expect(await inDoc(a)).toContain(part1);
	expect(await inDoc(a)).not.toContain(note15);
	await a.call((f, id) => f.view().toggleCollapse(id as never), part1);
	expect(await inDoc(a)).toContain(note15);
	expect(await a.call((f, id) => f.viewText(id as never), note15)).toBe("p1 note 5, changed");
	// Typing inside it reaches the page.
	await a.call((f, id) => f.caret(id as never), note15);
	await a.page.keyboard.type(" typed");
	await settle(a);
	// (Watched by levels: no session view of the page's whole subtree to read it from.)
	expect(liveSpaceOf(h.space.id)?.textOf(note15)).toBe("p1 note 5, changed typed");

	// Closed again: what it showed leaves the document and is let go.
	await a.call((f, id) => f.caret(id as never), small);
	await a.call((f, id) => f.view().toggleCollapse(id as never), big);
	await waitFor(
		() => watches(a),
		(w) => JSON.stringify(w) === JSON.stringify(base),
		"let go",
	);
	await waitFor(
		() => loaded(a, note15),
		(x) => !x,
		"the notes let go",
	);
	expect(await loaded(a, part1)).toBe(true);
	expect((await inDoc(a)).length).toBe(docSize);
	expect(errorsOf(a)).toEqual([]);
}, 120_000);
