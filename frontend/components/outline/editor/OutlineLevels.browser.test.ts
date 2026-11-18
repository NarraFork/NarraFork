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
import { OUTLINE_LIVE_BOUNDS } from "../../../../server/services/outline/live/session";
import { outlineStore } from "../../../../server/services/outline/store";
import { writeOutline } from "../../../../server/services/outline/write";
import {
	type Editor,
	errorsOf,
	eventually,
	type Harness,
	ime,
	openEditor,
	resetHarness,
	seedPage,
	serverOutline,
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
	// Copying the closed block, as a block and inside a text selection, copies what it hides.
	const copy = (e: Editor) =>
		e.call((f) => {
			const data = new DataTransfer();
			f.view().pm.dom.dispatchEvent(
				new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }),
			);
			return data.getData("text/plain");
		});
	await a.call((f, id) => f.caret(id as never), done);
	await a.call((f, id) => f.view().setBlockSelection({ anchor: id, head: id }), done);
	const asBlock = await copy(a);
	expect(asBlock).toContain("Deeper");
	expect(asBlock).toContain("Second note");
	await a.call((f) => f.view().setBlockSelection(null));
	await a.call((f, x, y) => f.select(x as never, 0, y as never, 4), done, fact);
	const asText = await copy(a);
	expect(asText).toContain("Deeper");
	expect(asText).toContain("Open");
	expect(await inDoc(a)).toEqual([pageId, done, fact, factChild]);
	// A block indented under the closed one goes after what it hides (and the closed block
	// stays open while the cursor is in it); undo puts it back.
	await a.call((f) => f.view().setBlockSelection(null));
	await a.call((f, id) => f.caret(id as never), fact);
	await a.page.keyboard.press("Tab");
	await settle(a);
	expect(await a.call((f, id) => f.kids(id as never), done)).toEqual([result, second, fact]);
	// (Under a task it is a detail: closed itself.)
	expect(await inDoc(a)).toEqual([pageId, done, result, second, fact]);
	await a.call((f) => f.undo());
	await settle(a);
	expect(await a.call((f, id) => f.kids(id as never), pageId)).toEqual([done, fact]);
	await a.call((f, id) => f.caret(id as never), factChild);
	await until(a, (f, id) => f.dom(id as never)?.classList.contains("collapsed") === true, [done]);
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

const JOIN_LINES = ["Intro", "[x] Done task", "  Result note", "    Deeper", "Open fact"];
const FOLDER_LINES = ["Intro", "", "  Inside a", "    Inside deep", "  Inside b", "After"];

/** Both the document (with what closed rows hide, read from the block model) and the server. */
async function same(e: Editor, pageId: string) {
	await settle(e);
	expect(await e.call((f) => f.viewOutline())).toBe(serverOutline(pageId));
}

const refusals = (e: Editor) => e.call((f) => f.view().stats.refused);
const undo = async (e: Editor) => {
	await e.call((f) => f.undo());
	await settle(e);
};
const redo = async (e: Editor) => {
	await e.call((f) => f.redo());
	await settle(e);
};

test("a join next to a closed row opens it first, then takes what it holds along; never deletes it", async () => {
	for (const key of ["Backspace", "Delete"] as const) {
		const { pageId, ids } = await seedPage(h, `Join ${key}`, JOIN_LINES);
		const [intro, done, result, deeper] = ids as [string, string, string, string];
		const a = await openEditor(h, h.owner, pageId);
		const original = serverOutline(pageId);
		// Backspace at the start of the closed row, or Delete at the end of the row above it.
		if (key === "Backspace") await a.call((f, id) => f.caret(id as never, 0), done);
		else await a.call((f, id) => f.caret(id as never, -1), intro);
		await a.page.keyboard.press(key);
		await settle(a);
		// Nothing changed: the closed row opened (what it holds is on screen now).
		expect(serverOutline(pageId)).toBe(original);
		expect(await refusals(a)).toBe(1);
		expect(await inDoc(a)).toContain(deeper);
		// The same key again joins it, its children taken along (as when they were shown).
		await a.page.keyboard.press(key);
		await same(a, pageId);
		const joined = serverOutline(pageId);
		expect(joined).toContain("IntroDone task");
		expect(joined).toContain("  - Result note");
		expect(joined).toContain("    - Deeper");
		expect(await a.call((f, id) => f.kids(id as never), intro)).toEqual([result]);
		await undo(a);
		expect(serverOutline(pageId)).toBe(original);
		await redo(a);
		expect(serverOutline(pageId)).toBe(joined);
		await same(a, pageId);
		expect(errorsOf(a)).toEqual([]);
	}
}, 120_000);

test("an empty closed row: Backspace after it, Delete at its end and a paste into it keep what it holds", async () => {
	for (const how of ["backspace", "delete", "paste"] as const) {
		const { pageId, ids } = await seedPage(h, `Folder ${how}`, FOLDER_LINES);
		const [, folder, insideA, insideDeep, insideB, after] = ids as string[];
		const a = await openEditor(h, h.owner, pageId);
		await a.call((f, id) => f.view().toggleCollapse(id as never), folder);
		expect(await inDoc(a)).not.toContain(insideA);
		if (how === "backspace") {
			await a.call((f, id) => f.caret(id as never, 0), after);
			await a.page.keyboard.press("Backspace");
		} else if (how === "delete") {
			await a.call((f, id) => f.caret(id as never, -1), folder);
			await a.page.keyboard.press("Delete");
		} else {
			await a.call((f, id) => f.caret(id as never, 0), folder);
			await a.call((f) => {
				const data = new DataTransfer();
				data.setData("text/plain", "- one\n- two");
				f.view().pm.dom.dispatchEvent(
					new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
				);
			});
		}
		await same(a, pageId);
		const out = serverOutline(pageId);
		// The closed row stays, with what it holds, where it was.
		expect(await a.call((f, id) => f.kids(id as never), folder)).toEqual([insideA, insideB]);
		expect(await a.call((f, id) => f.kids(id as never), insideA)).toEqual([insideDeep]);
		if (how === "paste") expect(out).toMatch(/- one\n- two/);
		else expect(out).toContain("- After");
		await undo(a);
		await same(a, pageId);
		expect(serverOutline(pageId)).not.toContain("one");
		expect(await a.call((f, id) => f.kids(id as never), folder)).toEqual([insideA, insideB]);
		await redo(a);
		await same(a, pageId);
		expect(errorsOf(a)).toEqual([]);
	}
}, 120_000);

/**
 * Drop a selection the way ProseMirror does: dragged (`transformCopied`), then dropped at the
 * end of a row's text through the editor's drop (`handleDrop`: moved or copied as the drop says).
 * The drag itself starts as the other kind (the copy key pressed or let go on the way).
 */
async function drop(e: Editor, target: string, move: boolean) {
	return e.call(
		(f, t, mv) => {
			const v = f.view();
			const pm = v.pm;
			let slice = pm.state.selection.content();
			pm.someProp("transformCopied", (fn: (s: typeof slice, v: typeof pm) => typeof slice) => {
				slice = fn(slice, pm);
			});
			(pm as unknown as { dragging: unknown }).dragging = { slice, move: !mv, node: undefined };
			let at = -1;
			pm.state.doc.descendants((n, pos) => {
				if (n.type.name === "block" && n.attrs.id === t) at = pos + 1 + n.child(0).nodeSize - 1;
				return true;
			});
			v.drop(slice, mv as boolean, at);
			(pm as unknown as { dragging: unknown }).dragging = null;
		},
		target,
		move,
	);
}

test("a dragged selection holding a closed row: copied, it is new blocks; moved, the row keeps what it hides", async () => {
	const lines = ["Intro", "[x] Done task", "  Result note", "    Deeper", "Open fact", "Tail"];
	const count = (out: string, text: string) =>
		out.split("\n").filter((l) => l.includes(text)).length;
	for (const move of [false, true]) {
		const { pageId, ids } = await seedPage(h, `Drop ${move}`, lines);
		const [intro, done, result, deeper, fact, tail] = ids as string[];
		const a = await openEditor(h, h.owner, pageId);
		// From inside the row above to inside the row below: the closed row whole.
		await a.call((f, x, y) => f.select(x as never, 2, y as never, 2), intro, fact);
		await drop(a, tail as string, move);
		await same(a, pageId);
		const out = serverOutline(pageId);
		if (move) {
			// Moved (the selection's rows went, the closed row with what it hides).
			expect(count(out, "Result note")).toBe(1);
			expect(count(out, "Deeper")).toBe(1);
			expect(await a.call((f, id) => f.kids(id as never), done)).toEqual([result]);
		} else {
			// Copied: the original as it was, and a copy with copies of what it hid.
			expect(count(out, "Result note")).toBe(2);
			expect(count(out, "Deeper")).toBe(2);
			expect(await a.call((f, id) => f.kids(id as never), done)).toEqual([result]);
			expect(await a.call((f, id) => f.kids(id as never), result)).toEqual([deeper]);
		}
		expect(errorsOf(a)).toEqual([]);
	}
	// A selection ending inside the closed row's line: what it hides is after the selection.
	for (const move of [false, true]) {
		const { pageId, ids } = await seedPage(h, `Drop mid ${move}`, lines);
		const [intro, done, result, , , tail] = ids as string[];
		const a = await openEditor(h, h.owner, pageId);
		await a.call((f, x, y) => f.select(x as never, 2, y as never, 4), intro, done);
		await drop(a, tail as string, move);
		await same(a, pageId);
		const out = serverOutline(pageId);
		expect(count(out, "Result note")).toBe(1);
		expect(count(out, "Deeper")).toBe(1);
		if (!move) expect(await a.call((f, id) => f.kids(id as never), done)).toEqual([result]);
		expect(errorsOf(a)).toEqual([]);
	}
}, 120_000);

test("by levels, a row whose children are not loaded is never deleted or joined away", async () => {
	// 1,100 rows with a child each under an open fact: too large to watch whole, and more rows
	// than a watch set takes (`maxWatch`): the last ones' children cannot be loaded.
	const lines = ["Big"];
	for (let i = 0; i < 1100; i++) lines.push(`  k${i}`, `    c${i}`);
	lines.push("Tail");
	const { pageId, ids } = await seedPage(h, "Wide", lines);
	const idOf = (t: string) => ids[lines.findIndex((l) => l.trim() === t)] as string;
	const a = await openEditor(h, h.owner, pageId);
	const [k0, k1, c1, kLast, cLast] = ["k0", "k1", "c1", "k1099", "c1099"].map(idOf) as string[];
	await waitFor(
		() => loaded(a, c1),
		(x) => x,
		"the first rows' children loaded",
	);
	await until(a, () => !!document.querySelector("[data-testid=outline-not-loaded]"));
	expect(await a.call((f, id) => f.client().visible.children(id as never).length, kLast)).toBe(0);
	// Backspace at the start of a row whose child is not loaded: refused, nothing deleted.
	const before = await refusals(a);
	await a.call((f, id) => f.caret(id as never, 0), kLast);
	await a.page.keyboard.press("Backspace");
	await settle(a);
	expect(await refusals(a)).toBe(before + 1);
	expect((await outlineStore.getBlock(kLast))?.deleted).toBe(false);
	expect((await outlineStore.getBlock(cLast))?.deleted).toBe(false);
	// So is deleting it as a block.
	await a.call((f, id) => f.view().setBlockSelection({ anchor: id, head: id }), kLast);
	await a.page.keyboard.press("Delete");
	await settle(a);
	expect((await outlineStore.getBlock(cLast))?.deleted).toBe(false);
	await a.call((f) => f.view().setBlockSelection(null));
	// A loaded row joins as usual (into the row before it on screen, k0's child), its child
	// taken along.
	await a.call((f, id) => f.caret(id as never, 0), k1);
	await a.page.keyboard.press("Backspace");
	await settle(a);
	await eventually(async () => (await outlineStore.getBlock(k1))?.deleted === true, "joined");
	expect((await outlineStore.getBlock(c1))?.deleted).toBe(false);
	expect((await outlineStore.getBlock(c1))?.parentId).toBe(idOf("c0"));
	expect(await a.call((f, id) => f.kids(id as never), k0)).toEqual([idOf("c0")]);
	expect(errorsOf(a)).toEqual([]);
}, 180_000);

/** A page by levels: "Big" (an open fact) holds three parts of 700 notes each (too large). */
async function bigPage(title: string) {
	const lines = ["Big"];
	for (let p = 0; p < 3; p++) {
		lines.push(`  Part ${p}`);
		for (let i = 0; i < 700; i++) lines.push(`    p${p} note ${i}`);
	}
	lines.push("Tail");
	const { pageId, ids } = await seedPage(h, title, lines);
	const idOf = (t: string) => ids[lines.findIndex((l) => l.trim() === t)] as string;
	return {
		pageId,
		big: idOf("Big"),
		parts: [0, 1, 2].map((p) => idOf(`Part ${p}`)),
		tail: idOf("Tail"),
	};
}

test("by levels, a block made here can be deleted at once; undo never deletes what is not loaded", async () => {
	// Enter, then Backspace before the new block's own watch is answered (the socket held).
	{
		const { pageId, big } = await bigPage("Made here");
		const a = await openEditor(h, h.owner, pageId);
		await waitFor(
			() => watches(a),
			(w) => w.includes(`l:${big}`),
			"big by levels",
		);
		const before = await refusals(a);
		await a.call((f, id) => f.caret(id as never, -1), big);
		await a.call((f) => f.net().hold(true));
		await a.page.keyboard.press("Enter");
		const x = await a.call((f) => f.where()?.blockId ?? null);
		expect(x).not.toBe(big);
		expect(await a.call((f, id) => f.client().visible.get(id as never)?.parentId, x)).toBe(big);
		await a.page.keyboard.press("Backspace");
		expect(await refusals(a)).toBe(before);
		expect(await a.call((f, id) => !!f.client().visible.alive(id as never), x)).toBe(false);
		await a.call((f) => f.net().hold(false));
		await settle(a);
		expect((await outlineStore.getBlock(x as string))?.deleted ?? true).toBe(true);
		expect(errorsOf(a)).toEqual([]);
	}
	// A block made here, someone adds under it, the reader closes "Big" (its watch let go):
	// undoing the insert must not delete it with what is under it.
	{
		const { pageId, big, tail } = await bigPage("Undo unloaded");
		const a = await openEditor(h, h.owner, pageId);
		await waitFor(
			() => watches(a),
			(w) => w.includes(`l:${big}`),
			"big by levels",
		);
		await a.call((f, id) => f.caret(id as never, -1), big);
		await a.page.keyboard.press("Enter");
		await settle(a);
		const x = (await a.call((f) => f.where()?.blockId ?? null)) as string;
		await waitFor(
			() => watches(a),
			(w) => w.includes(`s:${x}`),
			"x watched whole",
		);
		const r = await writeOutline({
			spaceId: h.space.id,
			ops: [{ op: "insert", parent: { id: x }, content: "Bob's child" }],
			actor: { kind: "human", id: h.writer },
			responsibleUserId: h.writer,
		});
		const bob = r.results[0]?.blockId as string;
		await waitFor(
			() => loaded(a, bob),
			(v) => v,
			"bob's child arrived",
		);
		await a.call((f, id) => f.caret(id as never, -1), tail);
		await a.call((f, id) => f.view().toggleCollapse(id as never), big);
		await waitFor(
			() => loaded(a, bob),
			(v) => !v,
			"bob's child let go",
		);
		// Undo the insert: its children are not loaded now, so it is not deleted (the undo
		// step is skipped, as for any structure that changed meanwhile).
		await undo(a);
		expect((await outlineStore.getBlock(bob))?.deleted).toBe(false);
		expect((await outlineStore.getBlock(x))?.deleted).toBe(false);
		expect(await a.call((f) => f.client().log.some((l) => l.includes("skipped d")))).toBe(true);
		// Redo after it does no harm either.
		await redo(a);
		expect((await outlineStore.getBlock(bob))?.deleted).toBe(false);
		expect(errorsOf(a)).toEqual([]);
	}
}, 240_000);

test("by levels, what was refused for room loads once the reader closes something and opens it again", async () => {
	const bounds = OUTLINE_LIVE_BOUNDS as { maxUserBlocks: number };
	const saved = bounds.maxUserBlocks;
	try {
		// Room for two of the three parts.
		bounds.maxUserBlocks = 1600;
		const { pageId, big, parts } = await bigPage("Refused for room");
		const a = await openEditor(h, h.owner, pageId);
		const whole = (w: string[]) => parts.filter((p) => w.includes(`s:${p}`)).length;
		await waitFor(
			() => watches(a),
			(w) => whole(w) === 2,
			"two parts loaded",
		);
		await until(a, () => !!document.querySelector("[data-testid=outline-not-loaded]"));
		const refused = await a.call(
			(f, ids) =>
				(ids as unknown as string[]).map((id) => f.client().watchRefused.get(`s:${id}`) ?? null),
			parts,
		);
		expect(refused.filter((c) => c === "user_limit")).toHaveLength(1);
		// Room again (the person closed views elsewhere); closing and opening "Big" asks again.
		bounds.maxUserBlocks = saved;
		await a.call((f, id) => f.view().toggleCollapse(id as never), big);
		await waitFor(
			() => watches(a),
			(w) => whole(w) === 0,
			"let go",
		);
		await a.call((f, id) => f.view().toggleCollapse(id as never), big);
		await waitFor(
			() => watches(a),
			(w) => whole(w) === 3,
			"all three loaded",
		);
		await until(a, () => !document.querySelector("[data-testid=outline-not-loaded]"));
		expect(errorsOf(a)).toEqual([]);
	} finally {
		bounds.maxUserBlocks = saved;
	}
}, 180_000);
