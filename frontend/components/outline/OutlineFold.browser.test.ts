/**
 * The default folding of an outline page in Chromium (task tree readability, PR C): the live
 * editor, the read-only tree and the mind map fold a task page the same way, against the real
 * outline routes and live sessions (`outline-mindmap-harness.browser-fixture.ts`).
 *
 *   - the default view of a task page as the owner's screenshot had it: a task in progress with
 *     notes, a subagent report and a subtask; finished tasks; a cancelled one; a fact;
 *   - the controls: the arrow (one level), Alt on it, the row's quick control and the preview
 *     line (everything inside), the page's control; by mouse, by touch and from the keyboard;
 *   - the editor: the cursor never stays in hidden content, typing beside a closed block, an
 *     edit by someone else inside a closed block, an input method composing while its block's
 *     task is closed around it, undo;
 *   - what the reader folded is stored and comes back after a reload, in both views;
 *   - who wrote a report, and the marks a closed row counts.
 *
 * Text is Latin where widths matter (CI has no CJK fonts): the assertions are structural.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { db } from "../../../server/db";
import { narrators } from "../../../server/db/schema";
import { askTool } from "../../../server/lib/agent/tools/outline";
import type { ToolContext } from "../../../server/lib/agent/types";
import { generateId } from "../../../server/lib/id";
import { reportBlockId } from "../../../server/services/outline/delegation";
import { setOutlineAnswerDelivery } from "../../../server/services/outline/questions";
import { OUTLINE_REPORT_ACTOR } from "../../../server/services/outline/report-authors";
import { outlineStore } from "../../../server/services/outline/store";
import { writeOutline } from "../../../server/services/outline/write";
import {
	ime,
	seedPage,
	serverOutline,
	serverText,
	settle,
} from "./editor/outline-live-harness.browser-fixture";
import type { FoldRowDom } from "./outline-mindmap.browser-fixture";
import {
	type MapEditor,
	type MapHarness,
	openBob,
	openHost,
	resetMap,
	settled,
	startMapHarness,
	stopMapHarness,
} from "./outline-mindmap-harness.browser-fixture";

let h: MapHarness;

beforeAll(async () => {
	h = await startMapHarness();
}, 60_000);

afterAll(async () => {
	await stopMapHarness(h);
});

afterEach(async () => {
	await resetMap(h);
});

const REPORT = "Report (generation 1 · 2026-11-09 17:38 UTC)";

/** A session's task page: the kind of page the owner's screenshot showed. */
const LINES = [
	"[/] Ship the fold",
	"  First note line",
	"    Detail one",
	"      Deep detail",
	"    Detail two",
	"    Detail three",
	"  A lone note",
	`  ${REPORT}`,
	"    ## Findings",
	"      The summary paragraph.",
	"      More findings.",
	"    ## Next",
	"      Do this.",
	"  [ ] A subtask",
	"    Subtask note",
	"      Subtask deep",
	"[x] Wire the store",
	"  [x] A done subtask",
	"  Both stores write the column",
	"    store.ts:12",
	"[x] Only subtasks",
	"  [x] Nested done",
	"[-] Dropped idea",
	"  Superseded by the fold",
	"A fact",
	"  Under a fact",
	"    Deep under a fact",
];

/** The rows a reader sees before touching anything, top to bottom. */
const DEFAULT_ROWS = [
	"Ship the fold",
	"First note line",
	"A lone note",
	REPORT,
	"A subtask",
	"Subtask note",
	"Wire the store",
	"Only subtasks",
	"Dropped idea",
	"A fact",
	"Under a fact",
	"Deep under a fact",
];

async function page(title = "Fold page") {
	const { pageId, ids } = await seedPage(h, title, LINES);
	const idOf = (text: string) => {
		const at = LINES.findIndex((line) => line.trim().replace(/^\[.\] /, "") === text);
		if (at < 0) throw new Error(`no line ${text}`);
		return ids[at] as string;
	};
	return { pageId, idOf };
}

const rows = (e: MapEditor) => e.call((f) => f.foldRows());
const texts = async (e: MapEditor) => (await rows(e)).map((row) => row.text);
const rowOf = async (e: MapEditor, id: string) => (await rows(e)).find((row) => row.id === id);
const foldState = (e: MapEditor) => e.call((f) => f.foldState());

/** Wait until what the page shows is `want` (polled: folding re-projects in the same task). */
async function shows(e: MapEditor, want: string[], label = "rows"): Promise<void> {
	const end = Date.now() + 5000;
	let last: string[] = [];
	while (Date.now() < end) {
		last = await texts(e);
		if (JSON.stringify(last) === JSON.stringify(want)) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	expect({ label, rows: last }).toEqual({ label, rows: want });
}

async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean, label: string) {
	const end = Date.now() + 5000;
	let last = await read();
	while (!ok(last) && Date.now() < end) {
		await new Promise((r) => setTimeout(r, 20));
		last = await read();
	}
	if (!ok(last)) throw new Error(`${label}: ${JSON.stringify(last)}`);
	return last;
}

type Part = "arrow" | "quick" | "preview";

async function point(e: MapEditor, id: string, part: Part) {
	const p = await e.call((f, i, x) => f.foldPoint(i as never, x as never), id, part);
	if (!p) throw new Error(`no ${part} on ${id}`);
	return p;
}

async function click(e: MapEditor, id: string, part: Part, alt = false): Promise<void> {
	const p = await point(e, id, part);
	if (alt) await e.page.keyboard.down("Alt");
	await e.page.mouse.click(p.x, p.y);
	if (alt) await e.page.keyboard.up("Alt");
}

async function tap(e: MapEditor, id: string, part: Part): Promise<void> {
	const p = await point(e, id, part);
	await e.page.touchscreen.tap(p.x, p.y);
}

const caret = (e: MapEditor, id: string, offset = -1) =>
	e.call((f, x, o) => f.caret(x as never, o as never), id, offset);
const head = (e: MapEditor) => e.call((f) => f.selection()?.head ?? null);

async function press(e: MapEditor, keys: string): Promise<void> {
	const parts = keys.split("+");
	const key = parts.pop() as string;
	for (const m of parts) await e.page.keyboard.down(m as never);
	await e.page.keyboard.press(key as never);
	for (const m of parts.reverse()) await e.page.keyboard.up(m as never);
}

/** The default view, whichever surface draws it. */
function expectDefault(got: FoldRowDom[], report: string): void {
	const by = new Map(got.map((row) => [row.text, row]));
	const row = (text: string) => {
		const found = by.get(text);
		if (!found) throw new Error(`no row ${text}`);
		return found;
	};
	// A task in progress shows its direct children; each of them is one line.
	expect(row("Ship the fold")).toMatchObject({ state: "open", preview: null, quick: "expand" });
	expect(row("First note line")).toMatchObject({
		state: "closed",
		preview: { kind: "details", text: "Detail one", label: "2 more ▸" },
		quick: "expand",
	});
	expect(row("A lone note")).toMatchObject({ state: null, preview: null, quick: null });
	// A subagent report: one line of its first paragraph, and the whole of it counted.
	expect(row(report)).toMatchObject({
		state: "closed",
		preview: { kind: "report", text: "The summary paragraph.", label: "Show all (5 blocks) ▸" },
		quick: "expand",
	});
	// A subtask to do is open too; its note is one line (one child, nothing more: no label).
	expect(row("A subtask")).toMatchObject({ state: "open", preview: null });
	expect(row("Subtask note")).toMatchObject({
		state: "closed",
		preview: { kind: "details", text: "Subtask deep", label: "" },
	});
	// A finished task: its title and one line of its result (its first note, not its subtask).
	expect(row("Wire the store")).toMatchObject({
		state: "closed",
		preview: { kind: "result", text: "Both stores write the column", label: "1 more ▸" },
		quick: "expand",
	});
	// Only subtasks under it: the title is all there is. One level: the arrow is the only control.
	expect(row("Only subtasks")).toMatchObject({ state: "closed", preview: null, quick: null });
	expect(row("Subtask note")).toMatchObject({ quick: null });
	expect(row("Dropped idea")).toMatchObject({
		state: "closed",
		preview: { kind: "result", text: "Superseded by the fold", label: "" },
	});
	// Facts stay open, with nothing to fold.
	expect(row("A fact")).toMatchObject({ state: "open", preview: null, quick: null });
	expect(row("Under a fact")).toMatchObject({ state: "open", preview: null, quick: null });
	// One marker per row, on every row.
	expect(got.filter((r) => r.markers !== 1).map((r) => r.text)).toEqual([]);
}

test("the live editor shows a task page in its default view", async () => {
	const { pageId } = await page();
	const a = await openHost(h, "page", pageId);
	expect(await a.call((f) => f.foldSurface())).toBe("editor");
	await shows(a, DEFAULT_ROWS);
	expectDefault(await rows(a), REPORT);
	// The report's line reads as a person reads it (no generation, no "UTC").
	const lines = await a.call((f) => f.reportLines());
	expect(lines.length).toBe(1);
	expect(lines[0]?.label).toStartWith("Subagent report · ");
	expect(lines[0]?.label).not.toContain("UTC");
	// Each preview is one line inside its row; nothing is wider than the page; no frame part
	// has a hover style.
	const layout = await a.call((f) => f.foldLayout());
	expect(layout.overflowX).toBe(false);
	expect(layout.previews.length).toBe(5);
	expect(layout.previews.filter((p) => p.lines !== 1 || !p.labelSeen)).toEqual([]);
	expect(layout.hoverRules).toEqual([]);
	// Nothing was stored for it: the default is nobody's change.
	expect(await foldState(a)).toEqual({ expanded: [], collapsed: [] });
	// What is hidden is still in the document: the page as the editor holds it is the server's.
	expect(await a.call((f) => f.viewOutline())).toBe(serverOutline(pageId));
	expect(a.errors).toEqual([]);
}, 30_000);

test("the controls: the arrow, Alt on it, the quick control, the preview line, the page", async () => {
	const { pageId, idOf } = await page();
	const a = await openHost(h, "page", pageId);
	await shows(a, DEFAULT_ROWS);
	const note = idOf("First note line");
	const detail = idOf("Detail one");
	const doing = idOf("Ship the fold");
	const done = idOf("Wire the store");

	// The arrow opens one level: the note's children show, each still closed.
	await click(a, note, "arrow");
	await eventually(
		() => rowOf(a, note),
		(row) => row?.state === "open",
		"note open",
	);
	expect(await texts(a)).toEqual([
		...DEFAULT_ROWS.slice(0, 2),
		"Detail one",
		"Detail two",
		"Detail three",
		...DEFAULT_ROWS.slice(2),
	]);
	expect(await rowOf(a, detail)).toMatchObject({
		state: "closed",
		preview: { kind: "details", text: "Deep detail", label: "" },
	});
	expect(await foldState(a)).toEqual({ expanded: [note], collapsed: [] });
	// The arrow again: back to the default, and nothing stays stored.
	await click(a, note, "arrow");
	await shows(a, DEFAULT_ROWS);
	expect(await foldState(a)).toEqual({ expanded: [], collapsed: [] });

	// Alt on the arrow: everything inside, at once.
	await click(a, note, "arrow", true);
	await eventually(
		() => texts(a),
		(t) => t.includes("Deep detail"),
		"alt opens all inside",
	);
	expect((await foldState(a)).expanded.sort()).toEqual([note, detail].sort());
	expect((await rowOf(a, note))?.quick).toBe("collapse");
	// The quick control: back to the default view inside the row.
	await click(a, note, "quick");
	await shows(a, DEFAULT_ROWS);
	expect(await foldState(a)).toEqual({ expanded: [], collapsed: [] });

	// A click with Ctrl or Shift is not a toggle.
	const p = await point(a, note, "arrow");
	for (const mod of ["Control", "Shift"] as const) {
		await a.page.keyboard.down(mod);
		await a.page.mouse.click(p.x, p.y);
		await a.page.keyboard.up(mod);
	}
	expect(await texts(a)).toEqual(DEFAULT_ROWS);

	// The preview line opens everything inside its row.
	await click(a, done, "preview");
	await eventually(
		() => texts(a),
		(t) => t.includes("store.ts:12") && t.includes("A done subtask"),
		"preview opens all inside",
	);
	expect((await rowOf(a, done))?.preview).toBeNull();

	// Closing an open task: it goes to the other set, and shows its first note as a preview.
	await click(a, doing, "arrow");
	await eventually(
		() => rowOf(a, doing),
		(row) => row?.state === "closed",
		"task closed",
	);
	expect((await foldState(a)).collapsed).toEqual([doing]);
	expect((await rowOf(a, doing))?.preview).toMatchObject({
		kind: "details",
		text: "First note line",
		label: "3 more ▸",
	});

	// The page's control: everything open, then the default view again.
	const all = await a.call((f) => f.foldAll());
	expect(all).toMatchObject({ offers: "expand", label: "Expand all" });
	await a.page.mouse.click(all?.x ?? 0, all?.y ?? 0);
	await eventually(
		() => texts(a),
		(t) => t.length === LINES.length,
		"all open",
	);
	expect((await foldState(a)).collapsed).toEqual([]);
	const back = await a.call((f) => f.foldAll());
	expect(back).toMatchObject({ offers: "collapse", label: "Collapse all" });
	await a.page.mouse.click(back?.x ?? 0, back?.y ?? 0);
	await shows(a, DEFAULT_ROWS);
	expect(await foldState(a)).toEqual({ expanded: [], collapsed: [] });
	// Folding is the reader's own: nothing of it reached the page.
	await settle(a);
	expect(await a.call((f) => f.viewOutline())).toBe(serverOutline(pageId));
	expect(a.errors).toEqual([]);
}, 40_000);

test("touch: a tap on the arrow, the quick control and the preview line", async () => {
	const { pageId, idOf } = await page();
	const a = await openHost(h, "page", pageId, { width: 390, height: 780, touch: true });
	await shows(a, DEFAULT_ROWS);
	const note = idOf("First note line");
	const done = idOf("Wire the store");
	// Every control is drawn without a pointer over it.
	for (const part of ["arrow", "quick", "preview"] as const) await point(a, note, part);
	await tap(a, note, "arrow");
	await eventually(
		() => rowOf(a, note),
		(row) => row?.state === "open",
		"tap arrow",
	);
	await tap(a, note, "quick");
	await eventually(
		() => texts(a),
		(t) => t.includes("Deep detail"),
		"tap quick opens all inside",
	);
	await tap(a, note, "quick");
	await shows(a, DEFAULT_ROWS);
	await tap(a, done, "preview");
	await eventually(
		() => texts(a),
		(t) => t.includes("store.ts:12"),
		"tap preview",
	);
	const layout = await a.call((f) => f.foldLayout());
	expect(layout.overflowX).toBe(false);
	expect(layout.previews.filter((p) => p.lines !== 1 || !p.labelSeen)).toEqual([]);
	expect(a.errors).toEqual([]);
}, 30_000);

test("the keyboard: Mod-. and Alt-Enter at the cursor; Enter and Space on a control", async () => {
	const { pageId, idOf } = await page();
	const a = await openHost(h, "page", pageId);
	await shows(a, DEFAULT_ROWS);
	const note = idOf("First note line");
	const lone = idOf("A lone note");
	const done = idOf("Wire the store");

	// From the cursor's block: one level, and everything inside.
	await caret(a, note);
	await press(a, "Control+.");
	await eventually(
		() => rowOf(a, note),
		(row) => row?.state === "open",
		"Mod-. opens",
	);
	expect((await head(a))?.blockId).toBe(note);
	await press(a, "Control+.");
	await shows(a, DEFAULT_ROWS);
	await press(a, "Alt+Enter");
	await eventually(
		() => texts(a),
		(t) => t.includes("Deep detail"),
		"Alt-Enter opens all inside",
	);
	await press(a, "Alt+Enter");
	await shows(a, DEFAULT_ROWS);
	// Nothing was typed into the block, and the cursor stayed in it.
	expect(await a.call((f, id) => f.text(id as never), note)).toBe("First note line");
	expect((await head(a))?.blockId).toBe(note);
	// On a block with nothing to fold the keys are not taken: Alt-Enter does nothing here.
	await caret(a, lone);
	await press(a, "Control+.");
	expect(await texts(a)).toEqual(DEFAULT_ROWS);

	// The controls are named after their row, say their state, and are no tab stops.
	expect(await a.call((f, id) => f.foldAria(id as never, "arrow"), note)).toEqual({
		role: "button",
		label: "Expand · First note line",
		expanded: "false",
		title: "Expand · Alt+click: everything inside",
		tabIndex: -1,
	});
	expect(await a.call((f, id) => f.foldAria(id as never, "quick"), note)).toEqual({
		role: "button",
		label: "Expand/collapse everything in “First note line”",
		expanded: "false",
		title: "Expand everything inside",
		tabIndex: -1,
	});
	expect(await a.call((f, id) => f.foldAria(id as never, "preview"), note)).toEqual({
		role: "button",
		label: "Show everything inside this item: Detail one (2 more)",
		expanded: "false",
		title: null,
		tabIndex: -1,
	});

	// Enter on the arrow: its own key (never the window's, never typed into the page), and the
	// arrow keeps the keyboard.
	await a.call((f) => f.watchKeyLeaks());
	expect(await a.call((f, id) => f.foldFocus(id as never, "arrow"), note)).toBe(true);
	await a.page.keyboard.press("Enter");
	await eventually(
		() => rowOf(a, note),
		(row) => row?.state === "open",
		"Enter on the arrow",
	);
	expect(await a.call((f) => f.foldFocused())).toBe(`arrow:${note}`);
	// Space closes it again; a held key toggles once.
	await a.page.keyboard.down("Space");
	await a.page.keyboard.down("Space");
	await a.page.keyboard.down("Space");
	await a.page.keyboard.up("Space");
	await shows(a, DEFAULT_ROWS);
	// Alt+Enter on the arrow: everything inside.
	await press(a, "Alt+Enter");
	await eventually(
		() => texts(a),
		(t) => t.includes("Deep detail"),
		"Alt+Enter on the arrow",
	);
	expect(await a.call((f) => f.foldFocused())).toBe(`arrow:${note}`);
	// The quick control takes Enter too, and keeps the keyboard.
	expect(await a.call((f, id) => f.foldFocus(id as never, "quick"), note)).toBe(true);
	await a.page.keyboard.press("Enter");
	await shows(a, DEFAULT_ROWS);
	expect(await a.call((f) => f.foldFocused())).toBe(`quick:${note}`);
	// A preview line goes away when it is used: the keyboard moves to its row's quick control.
	expect(await a.call((f, id) => f.foldFocus(id as never, "preview"), done)).toBe(true);
	await a.page.keyboard.press("Enter");
	await eventually(
		() => texts(a),
		(t) => t.includes("store.ts:12"),
		"Enter on a preview",
	);
	expect(await a.call((f) => f.foldFocused())).toBe(`quick:${done}`);
	// None of those keys reached the window, and none changed the page.
	expect(await a.call((f) => f.keyLeaks())).toEqual([]);
	await settle(a);
	expect(serverOutline(pageId)).toBe(await a.call((f) => f.viewOutline()));
	expect(serverText(pageId, note)).toBe("First note line");
	expect(a.errors).toEqual([]);
}, 40_000);

test("the cursor never stays in hidden content, and typing beside a closed block stays outside it", async () => {
	const { pageId, idOf } = await page();
	const a = await openHost(h, "page", pageId);
	await shows(a, DEFAULT_ROWS);
	const note = idOf("First note line");
	const detail = idOf("Detail one");
	const deep = idOf("Deep detail");
	const lone = idOf("A lone note");

	// Putting the cursor into a hidden block (a jump, a link) opens the blocks around it.
	await caret(a, deep);
	await eventually(
		() => texts(a),
		(t) => t.includes("Deep detail"),
		"cursor opens its ancestors",
	);
	expect((await head(a))?.blockId).toBe(deep);
	expect((await foldState(a)).expanded.sort()).toEqual([note, detail].sort());
	// Typing lands where the cursor is shown.
	await a.page.keyboard.type(" seen");
	await settle(a);
	expect(serverText(pageId, deep)).toBe("Deep detail seen");

	// Closing a block around the cursor moves the cursor onto that block; it does not reopen.
	await click(a, note, "arrow");
	await eventually(
		() => rowOf(a, note),
		(row) => row?.state === "closed",
		"closed around the cursor",
	);
	expect(await head(a)).toEqual({ blockId: note, offset: "First note line".length });
	expect(await a.call((f) => f.view().isHidden(f.idOf("Deep detail seen") as string))).toBe(true);
	// Typing now goes into the closed block's own line, not into what it hides.
	await a.page.keyboard.type("!");
	await settle(a);
	expect(serverText(pageId, note)).toBe("First note line!");
	expect(serverText(pageId, deep)).toBe("Deep detail seen");

	// Enter at the end of a closed block: a new block after it, not inside it.
	await a.page.keyboard.press("Enter");
	await a.page.keyboard.type("beside");
	await settle(a);
	const doing = idOf("Ship the fold");
	const kids = await a.call((f, id) => f.kids(id as never), doing);
	expect(kids[0]).toBe(note);
	expect(await a.call((f, id) => f.text(id as never), kids[1])).toBe("beside");
	expect(await a.call((f, id) => f.kids(id as never), note)).toHaveLength(3);
	expect((await rowOf(a, note))?.state).toBe("closed");

	// Arrow keys step over what is hidden: up from the new block is the closed block's line.
	await a.page.keyboard.press("ArrowUp");
	expect((await head(a))?.blockId).toBe(note);
	await a.page.keyboard.press("ArrowDown");
	expect((await head(a))?.blockId).toBe(kids[1]);
	// From the end of the closed block's line: right and down go to the next block on screen,
	// left and up come back to its line; nothing opens on the way.
	await caret(a, note);
	await a.page.keyboard.press("ArrowRight");
	expect(await head(a)).toEqual({ blockId: kids[1] as string, offset: 0 });
	await a.page.keyboard.press("ArrowLeft");
	expect(await head(a)).toEqual({ blockId: note, offset: "First note line!".length });
	await a.page.keyboard.press("ArrowDown");
	expect((await head(a))?.blockId).toBe(kids[1]);
	await a.page.keyboard.press("ArrowUp");
	expect((await head(a))?.blockId).toBe(note);
	// Shift extends the selection over the closed block's edge the same way.
	await caret(a, note);
	await press(a, "Shift+ArrowRight");
	expect(await a.call((f) => f.selection())).toEqual({
		anchor: { blockId: note, offset: "First note line!".length },
		head: { blockId: kids[1] as string, offset: 0 },
	});
	await caret(a, kids[1] as string);
	expect((await rowOf(a, note))?.state).toBe("closed");
	// (What the reader opened under the note earlier is still theirs; nothing was added.)
	expect(await foldState(a)).toEqual({ expanded: [detail], collapsed: [] });

	// Delete at the end of a closed block joins the next block on screen, never a hidden child.
	await caret(a, note);
	await a.page.keyboard.press("Delete");
	await settle(a);
	expect(serverText(pageId, note)).toBe("First note line!beside");
	expect(serverText(pageId, detail)).toBe("Detail one");
	expect(await a.call((f, id) => f.kids(id as never), note)).toHaveLength(3);

	// Backspace at the start of the block after a closed one joins into the closed block's line.
	await caret(a, lone, 0);
	await a.page.keyboard.press("Backspace");
	await settle(a);
	expect(serverText(pageId, note)).toBe("First note line!besideA lone note");
	expect(serverText(pageId, detail)).toBe("Detail one");

	// Undo puts the text and the cursor back, with the fold as it is.
	await press(a, "Control+z");
	await settle(a);
	expect(serverText(pageId, note)).toBe("First note line!beside");
	expect((await rowOf(a, note))?.state).toBe("closed");
	// An indent under a closed block would hide the cursor: the block opens instead.
	const again = await a.call((f, id) => f.kids(id as never), doing);
	await caret(a, again[1] as string);
	await a.page.keyboard.press("Tab");
	await eventually(
		() => rowOf(a, note),
		(row) => row?.state === "open",
		"indent opens the closed block",
	);
	expect(await a.call((f, id) => f.kids(id as never), note)).toHaveLength(4);
	expect((await head(a))?.blockId).toBe(again[1]);
	// Ticking a task done closes it at once (the cursor is elsewhere); ticking it back opens it.
	const subtask = idOf("A subtask");
	expect((await rowOf(a, subtask))?.state).toBe("open");
	await a.call((f, id) => f.setTask(id as never, "x"), subtask);
	expect((await rowOf(a, subtask))?.state).toBe("closed");
	expect((await rowOf(a, subtask))?.preview).toMatchObject({
		kind: "result",
		text: "Subtask note",
	});
	await a.call((f, id) => f.setTask(id as never, "/"), subtask);
	expect((await rowOf(a, subtask))?.state).toBe("open");
	await settle(a);
	await settle(a);
	expect(await a.call((f) => f.viewOutline())).toBe(serverOutline(pageId));
	expect(a.errors).toEqual([]);
}, 40_000);

test("someone else's edits inside a closed block apply; a task they finish closes", async () => {
	const { pageId, idOf } = await page();
	const a = await openHost(h, "page", pageId);
	const b = await openBob(h, pageId);
	await shows(a, DEFAULT_ROWS);
	const note = idOf("First note line");
	const detail = idOf("Detail one");
	const sub = idOf("A subtask");
	const subnote = idOf("Subtask note");

	// Bob edits a block Alice has folded away: her preview line follows, nothing opens.
	await b.call((f, id) => f.insertAt(id as never, 0, "Changed: "), detail);
	await settle(a, b);
	await eventually(
		() => rowOf(a, note),
		(row) => row?.preview?.text === "Changed: Detail one",
		"preview follows a remote edit",
	);
	expect((await rowOf(a, note))?.state).toBe("closed");
	expect(await a.call((f, id) => f.text(id as never), detail)).toBe("Changed: Detail one");
	// He adds a block inside it: the count follows.
	await b.call((f, id) => f.cmd("split", id as never, 9999), idOf("Detail three"));
	await settle(a, b);
	await eventually(
		() => rowOf(a, note),
		(row) => row?.preview?.label === "3 more ▸",
		"count follows a remote insert",
	);
	expect(await foldState(a)).toEqual({ expanded: [], collapsed: [] });

	// Bob finishes the subtask while Alice's cursor is elsewhere: it closes for her.
	await caret(a, idOf("A fact"));
	await b.call((f, id) => f.setTask(id as never, "x"), sub);
	await settle(a, b);
	await eventually(
		() => rowOf(a, sub),
		(row) => row?.state === "closed",
		"a finished task closes",
	);
	expect((await rowOf(a, sub))?.preview).toMatchObject({ kind: "result", text: "Subtask note" });
	expect(await foldState(a)).toEqual({ expanded: [], collapsed: [] });
	// He reopens it; she puts her cursor in its note; he finishes it again: it stays open for
	// her while her cursor is in it, and closes when the cursor leaves. Nothing is stored.
	await b.call((f, id) => f.setTask(id as never, " "), sub);
	await settle(a, b);
	await eventually(
		() => rowOf(a, sub),
		(row) => row?.state === "open",
		"reopened",
	);
	await caret(a, subnote);
	await b.call((f, id) => f.setTask(id as never, "x"), sub);
	await settle(a, b);
	await eventually(
		() => a.call((f, id) => f.client().visible.get(id as never)?.task ?? null, sub),
		(task) => task === "x",
		"finished again",
	);
	expect((await rowOf(a, sub))?.state).toBe("open");
	expect((await head(a))?.blockId).toBe(subnote);
	// Typing goes on where it was.
	await a.page.keyboard.type("!");
	await settle(a, b);
	expect(serverText(pageId, subnote)).toBe("Subtask note!");
	expect((await rowOf(a, sub))?.state).toBe("open");
	expect(await foldState(a)).toEqual({ expanded: [], collapsed: [] });
	// The cursor leaves: the finished task closes, as it would for anyone.
	await caret(a, idOf("A fact"));
	await eventually(
		() => rowOf(a, sub),
		(row) => row?.state === "closed",
		"closes when the cursor leaves",
	);
	expect(await foldState(a)).toEqual({ expanded: [], collapsed: [] });
	expect(await a.call((f) => f.viewOutline())).toBe(serverOutline(pageId));
	expect([...a.errors, ...b.errors]).toEqual([]);
}, 40_000);

test("an input method keeps composing while its block's task is closed around it", async () => {
	const { pageId, idOf } = await page();
	const a = await openHost(h, "page", pageId);
	const b = await openBob(h, pageId);
	await shows(a, DEFAULT_ROWS);
	const sub = idOf("A subtask");
	const subnote = idOf("Subtask note");
	await caret(a, subnote);
	const input = ime(a as never);
	await input.set("ni");
	expect(await a.call((f) => f.view().pm.composing)).toBe(true);
	// Bob finishes the subtask: by default it would close over the block being composed in.
	await b.call((f, id) => f.setTask(id as never, "x"), sub);
	await settle(b);
	await eventually(
		() => a.call((f, id) => f.client().visible.get(id as never)?.task ?? null, sub),
		(task) => task === "x",
		"the finished task arrived",
	);
	// The block stays on screen and the composition goes on.
	expect(await a.call((f) => f.view().pm.composing)).toBe(true);
	expect(await a.call((f, id) => f.view().isHidden(id as never), subnote)).toBe(false);
	await input.set("nihao");
	await input.commit("你好");
	await settle(a, b);
	expect(serverText(pageId, subnote)).toBe("Subtask note你好");
	// After the composition the block stays open while the cursor is in it (nothing stored),
	// and closes when the cursor leaves.
	expect((await rowOf(a, sub))?.state).toBe("open");
	expect((await head(a))?.blockId).toBe(subnote);
	expect(await foldState(a)).toEqual({ expanded: [], collapsed: [] });
	await caret(a, idOf("A fact"));
	await eventually(
		() => rowOf(a, sub),
		(row) => row?.state === "closed",
		"closes when the cursor leaves",
	);
	expect(await a.call((f) => f.viewOutline())).toBe(serverOutline(pageId));
	expect([...a.errors, ...b.errors]).toEqual([]);
}, 40_000);

test("a jump to a block and undo into a closed block bring it on screen", async () => {
	const { pageId, idOf } = await page();
	const a = await openHost(h, "page", pageId);
	await shows(a, DEFAULT_ROWS);
	const note = idOf("First note line");
	const detail = idOf("Detail one");
	const evidence = idOf("store.ts:12");
	// Edit a hidden block's text after opening it, then close it again.
	await caret(a, detail);
	await a.page.keyboard.type(" edited");
	await settle(a);
	await click(a, note, "arrow");
	await shows(a, DEFAULT_ROWS);
	// Undo changes the hidden block and puts the cursor back in it: it opens.
	await caret(a, idOf("A fact"));
	await press(a, "Control+z");
	await settle(a);
	expect(serverText(pageId, detail)).toBe("Detail one");
	await eventually(
		() => texts(a),
		(t) => t.includes("Detail one"),
		"undo opens the block it changed",
	);
	expect((await head(a))?.blockId).toBe(detail);
	// The quick switcher's jump focuses the block: it is the page shown, with its own children.
	expect(await a.call((f, id) => f.reveal(id as never), evidence)).toBe(true);
	await settled(a);
	expect(await a.call((f) => f.state().focus)).toBe(evidence);
	// Back on the page, a block focused under a task folds its details as the page does.
	expect(await a.call((f, id) => f.focusBlock(id as never), note)).toBe(true);
	await settled(a);
	await eventually(
		() => texts(a),
		(t) => t.length === 3,
		"focused note",
	);
	expect(await texts(a)).toEqual(["Detail one", "Detail two", "Detail three"]);
	expect((await rowOf(a, detail))?.state).toBe("closed");
	expect(a.errors).toEqual([]);
}, 40_000);

test("what the reader folded is stored, and comes back after a reload in both views", async () => {
	const { pageId, idOf } = await page();
	const a = await openHost(h, "page", pageId);
	await shows(a, DEFAULT_ROWS);
	const note = idOf("First note line");
	const done = idOf("Wire the store");
	const fact = idOf("A fact");
	await click(a, note, "arrow");
	await click(a, done, "arrow");
	await click(a, fact, "arrow");
	const want = [
		"Ship the fold",
		"First note line",
		"Detail one",
		"Detail two",
		"Detail three",
		"A lone note",
		REPORT,
		"A subtask",
		"Subtask note",
		"Wire the store",
		"A done subtask",
		"Both stores write the column",
		"Only subtasks",
		"Dropped idea",
		"A fact",
	];
	await shows(a, want);
	// Written for the person, both sets (the write is debounced).
	const end = Date.now() + 5000;
	let stored = await outlineStore.getViewState(h.owner, pageId);
	while (Date.now() < end && (stored?.expanded.length ?? 0) < 2) {
		await new Promise((r) => setTimeout(r, 50));
		stored = await outlineStore.getViewState(h.owner, pageId);
	}
	expect(stored?.expanded.sort()).toEqual([note, done].sort());
	expect(stored?.collapsed).toEqual([fact]);
	// Someone else's view of the page is untouched.
	expect(await outlineStore.getViewState(h.writer, pageId)).toBeNull();

	// A reload: the same view.
	const again = await openHost(h, "page", pageId);
	await shows(again, want, "after a reload");
	expect(await foldState(again)).toEqual({ expanded: [note, done].sort(), collapsed: [fact] });
	// The page as of its last commit is the read-only tree: the same folding.
	const seq = (await outlineStore.getSpace(h.space.id))?.nextSeq ?? 1;
	const tree = await openHost(h, "page", pageId, { asOf: seq - 1 });
	expect(await tree.call((f) => f.foldSurface())).toBe("tree");
	// (The tree's row shows a report's line as it reads; the editor's keeps the stored text.)
	const reportRow = (await tree.call((f) => f.reportLines()))[0]?.label ?? "";
	await shows(
		tree,
		want.map((text) => (text === REPORT ? reportRow : text)),
		"the read-only tree",
	);
	// Bob opens the page: the default view.
	const bob = await openHost(h, "page", pageId, { userId: h.writer });
	await shows(bob, DEFAULT_ROWS, "someone else");
	expect([...again.errors, ...tree.errors, ...bob.errors]).toEqual([]);
}, 60_000);

for (const variant of [
	{ lang: "en", scheme: "light", width: 720 },
	{ lang: "zh-CN", scheme: "dark", width: 360 },
] as const) {
	test(`the read-only tree: default view and controls (${variant.lang}, ${variant.scheme}, ${variant.width}px)`, async () => {
		const { pageId, idOf } = await page();
		const seq = ((await outlineStore.getSpace(h.space.id))?.nextSeq ?? 1) - 1;
		const a = await openHost(h, "page", pageId, { ...variant, height: 900, asOf: seq });
		expect(await a.call((f) => f.foldSurface())).toBe("tree");
		const note = idOf("First note line");
		const detail = idOf("Detail one");
		const done = idOf("Wire the store");
		const reportId = idOf(REPORT);
		const report = (await a.call((f) => f.reportLines()))[0]?.label ?? "";
		expect(report).toStartWith(variant.lang === "en" ? "Subagent report · " : "子代理报告 · ");
		const reportRow = (await rowOf(a, reportId))?.text ?? "";
		const visible = DEFAULT_ROWS.map((text) => (text === REPORT ? reportRow : text));
		await shows(a, visible);
		if (variant.lang === "en") expectDefault(await rows(a), reportRow);
		else {
			// The same rows; the labels in the reader's language.
			expect((await rowOf(a, note))?.preview).toEqual({
				kind: "details",
				text: "Detail one",
				label: "还有 2 条 ▸",
			});
			expect((await rowOf(a, reportId))?.preview).toEqual({
				kind: "report",
				text: "The summary paragraph.",
				label: "展开全文（5 块）▸",
			});
			expect((await a.call((f) => f.foldAll()))?.label).toBe("全部展开");
		}
		const layout = await a.call((f) => f.foldLayout());
		expect(layout.overflowX).toBe(false);
		expect(layout.previews.length).toBe(5);
		expect(layout.previews.filter((p) => p.lines !== 1 || !p.labelSeen)).toEqual([]);

		// The arrow, Alt on it, the quick control.
		await click(a, note, "arrow");
		await eventually(
			() => rowOf(a, note),
			(row) => row?.state === "open",
			"arrow",
		);
		expect((await rowOf(a, detail))?.state).toBe("closed");
		await click(a, note, "arrow");
		await shows(a, visible);
		await click(a, note, "arrow", true);
		await eventually(
			() => texts(a),
			(t) => t.includes("Deep detail"),
			"alt",
		);
		expect((await rowOf(a, note))?.quick).toBe("collapse");
		await click(a, note, "quick");
		await shows(a, visible);

		// Enter on a preview line: everything inside, the keyboard on the row's quick control,
		// the key not leaking to the window.
		await a.call((f) => f.watchKeyLeaks());
		expect(await a.call((f, id) => f.foldFocus(id as never, "preview"), done)).toBe(true);
		await a.page.keyboard.press("Enter");
		await eventually(
			() => texts(a),
			(t) => t.includes("store.ts:12"),
			"Enter on a preview",
		);
		expect(await a.call((f) => f.foldFocused())).toBe(`quick:${done}`);
		// Space on the quick control (held: one toggle), then Alt+Enter on the arrow.
		await a.page.keyboard.down("Space");
		await a.page.keyboard.down("Space");
		await a.page.keyboard.up("Space");
		await shows(a, visible);
		expect(await a.call((f, id) => f.foldFocus(id as never, "arrow"), done)).toBe(true);
		await press(a, "Alt+Enter");
		await eventually(
			() => texts(a),
			(t) => t.includes("store.ts:12"),
			"Alt+Enter on the arrow",
		);
		expect(await a.call((f) => f.foldFocused())).toBe(`arrow:${done}`);
		expect(await a.call((f) => f.keyLeaks())).toEqual([]);

		// The page's control: everything, then the default view.
		const all = await a.call((f) => f.foldAll());
		expect(all?.offers).toBe("expand");
		await a.page.mouse.click(all?.x ?? 0, all?.y ?? 0);
		await eventually(
			() => texts(a),
			(t) => t.length === LINES.length,
			"all open",
		);
		expect((await a.call((f) => f.foldLayout())).overflowX).toBe(false);
		const back = await a.call((f) => f.foldAll());
		expect(back?.offers).toBe("collapse");
		await a.page.mouse.click(back?.x ?? 0, back?.y ?? 0);
		await shows(a, visible);
		expect(a.errors).toEqual([]);
	}, 40_000);
}

test("the live editor in Chinese, dark, 360 px: the same view, nothing wider than the page", async () => {
	const { pageId, idOf } = await page();
	const a = await openHost(h, "page", pageId, {
		lang: "zh-CN",
		scheme: "dark",
		width: 360,
		height: 900,
	});
	await shows(a, DEFAULT_ROWS);
	const note = idOf("First note line");
	expect((await rowOf(a, note))?.preview).toEqual({
		kind: "details",
		text: "Detail one",
		label: "还有 2 条 ▸",
	});
	expect((await rowOf(a, idOf(REPORT)))?.preview).toEqual({
		kind: "report",
		text: "The summary paragraph.",
		label: "展开全文（5 块）▸",
	});
	expect((await a.call((f) => f.reportLines()))[0]?.label).toStartWith("子代理报告 · ");
	expect(await a.call((f, id) => f.foldAria(id as never, "quick"), note)).toMatchObject({
		label: "展开/收起「First note line」里的全部",
		title: "展开其中全部",
	});
	expect((await a.call((f) => f.foldAll()))?.label).toBe("全部展开");
	const layout = await a.call((f) => f.foldLayout());
	expect(layout.overflowX).toBe(false);
	expect(layout.previews.length).toBe(5);
	expect(layout.previews.filter((p) => p.lines !== 1 || !p.labelSeen)).toEqual([]);
	// Everything open still fits.
	const all = await a.call((f) => f.foldAll());
	await a.page.mouse.click(all?.x ?? 0, all?.y ?? 0);
	await eventually(
		() => texts(a),
		(t) => t.length === LINES.length,
		"all open",
	);
	expect((await a.call((f) => f.foldLayout())).overflowX).toBe(false);
	expect(a.errors).toEqual([]);
}, 30_000);

test("a closed row counts the questions, pending changes and locks it hides", async () => {
	const { pageId, idOf } = await page();
	const a = await openHost(h, "page", pageId);
	await shows(a, DEFAULT_ROWS);
	const note = idOf("First note line");
	const doing = idOf("Ship the fold");
	const done = idOf("Wire the store");
	// As the page's summary marks them: a question nobody answered and a lock two levels under
	// a note, a pending change under a finished task, and marks on rows that are on screen.
	await a.call((f, m) => f.setMarks(m as never), {
		[idOf("Deep detail")]: { openQuestion: true, lockedBy: "alice" },
		[idOf("Detail two")]: { openQuestion: true },
		[idOf("store.ts:12")]: { pending: ["chg-1"] },
		[idOf("A lone note")]: { pending: ["chg-2"] },
	});
	// The questions are never folded away by default: the blocks above them open.
	await eventually(
		() => texts(a),
		(t) => t.includes("Deep detail") && t.includes("Detail two"),
		"unanswered questions are on screen",
	);
	expect(await foldState(a)).toEqual({ expanded: [], collapsed: [] });
	expect((await rowOf(a, note))?.hidden).toEqual({});
	// The pending change under the finished task is counted on its closed row.
	expect((await rowOf(a, done))?.hidden).toEqual({ pending: 1 });
	// A mark on a row that is shown is its own badge, not a count on its parent.
	expect((await rowOf(a, doing))?.hidden).toEqual({});
	// The reader closes the note: its row counts what it hides now.
	await click(a, note, "arrow");
	await eventually(
		() => rowOf(a, note),
		(row) => row?.state === "closed",
		"closed by the reader",
	);
	expect((await rowOf(a, note))?.hidden).toEqual({ question: 2, locked: 1 });
	// Open again, and one level down closed: the counts move to the row that hides them.
	await click(a, note, "arrow");
	await click(a, idOf("Detail one"), "arrow");
	await eventually(
		() => rowOf(a, idOf("Detail one")),
		(row) => row?.state === "closed",
		"one level down",
	);
	expect((await rowOf(a, note))?.hidden).toEqual({});
	expect((await rowOf(a, idOf("Detail one")))?.hidden).toEqual({ question: 1, locked: 1 });
	// Closing the task moves all of them up to it.
	await click(a, doing, "arrow");
	await eventually(
		() => rowOf(a, doing),
		(row) => row?.state === "closed",
		"task closed",
	);
	expect((await rowOf(a, doing))?.hidden).toEqual({ question: 2, pending: 1, locked: 1 });
	// The marks are icons (the states' badges, the question's mark) with a name; never a glyph.
	const chips = await a.call((f, id) => {
		const el = f.view().blockEls.get(id as never);
		return [...(el?.querySelectorAll(":scope > .ob-marks > .ob-fold-hidden") ?? [])].map((c) => ({
			kind: (c as HTMLElement).dataset.kind,
			label: c.getAttribute("aria-label"),
			icon: c.querySelector("svg")?.getAttribute("class") ?? "",
			status: c.querySelector("svg")?.getAttribute("data-status") ?? null,
			text: c.textContent,
		}));
	}, doing);
	expect(chips).toEqual([
		{
			kind: "question",
			label: "2 questions waiting for an answer inside",
			icon: "tabler-icon tabler-icon-help-circle",
			status: null,
			text: "2",
		},
		{
			kind: "pending",
			label: "1 change waiting for confirmation inside",
			icon: "tabler-icon tabler-icon-hourglass nf-status",
			status: "waiting",
			text: "1",
		},
		{
			kind: "locked",
			label: "1 locked task inside",
			icon: "tabler-icon tabler-icon-lock nf-status",
			status: "locked",
			text: "1",
		},
	]);
	expect((await a.call((f) => f.foldLayout())).overflowX).toBe(false);
	expect(a.errors).toEqual([]);
}, 30_000);

test("a report says who wrote it to someone who may read that session, in both views", async () => {
	const { pageId, idOf } = await page();
	const main = generateId();
	const scout = generateId();
	const NOW = "2026-10-27T00:00:00.000Z";
	await db.insert(narrators).values([
		{
			id: main,
			title: "main",
			ownerUserId: h.owner,
			visibility: "private",
			writeAudience: "owner",
			type: "primary",
			createdAt: NOW,
			updatedAt: NOW,
		},
		{
			id: scout,
			title: "scout-1",
			ownerUserId: h.owner,
			visibility: "private",
			writeAudience: "owner",
			type: "subagent",
			aclRootNarratorId: main,
			createdAt: NOW,
			updatedAt: NOW,
		},
	]);
	const container = reportBlockId(scout, "run-1");
	await writeOutline({
		spaceId: h.space.id,
		ops: [
			{
				op: "insert",
				tempId: "report",
				id: container,
				parent: { id: idOf("Ship the fold") },
				content: "Report (generation 3 · 2026-11-09 08:05 UTC)",
			},
			{ op: "insert", parent: { tempId: "report" }, content: "What the scout found." },
		],
		actor: { kind: "system", id: OUTLINE_REPORT_ACTOR },
		responsibleUserId: h.owner,
		narratorId: scout,
	});
	const labelOf = async (e: MapEditor) =>
		(
			await eventually(
				() => e.call((f) => f.reportLines()),
				(lines) => lines.some((line) => line.id === container && / · from /.test(line.label)),
				"the report names its subagent",
			)
		).find((line) => line.id === container)?.label ?? "";
	// The live editor: read once the page's containers are known.
	const a = await openHost(h, "page", pageId);
	const live = await labelOf(a);
	expect(live).toStartWith("Subagent report · ");
	expect(live).toEndWith(" · from scout-1");
	// A container known by its id folds like any report: one line of its first paragraph.
	expect((await rowOf(a, container))?.preview).toEqual({
		kind: "report",
		text: "What the scout found.",
		label: "Show all (1 block) ▸",
	});
	// The read-only tree gets the name with its blocks.
	const seq = ((await outlineStore.getSpace(h.space.id))?.nextSeq ?? 1) - 1;
	const tree = await openHost(h, "page", pageId, { asOf: seq });
	expect(await labelOf(tree)).toBe(live);
	// Bob reads the page, not Alice's session: the time alone.
	const bob = await openHost(h, "page", pageId, { userId: h.writer });
	await eventually(
		() => bob.call((f) => f.reportLines()),
		(lines) => lines.some((line) => line.id === container),
		"bob sees the report",
	);
	// (Give a wrongly allowed name the time to arrive.)
	await bob.page.waitForNetworkIdle({ idleTime: 300 });
	const theirs = (await bob.call((f) => f.reportLines())).find((line) => line.id === container);
	expect(theirs?.label).toStartWith("Subagent report · ");
	expect(theirs?.label).not.toContain("scout");
	expect([...a.errors, ...tree.errors, ...bob.errors]).toEqual([]);
}, 60_000);

test("the mind map folds the same tree: closed nodes carry a count, sizes stay exact", async () => {
	const { pageId, idOf } = await page();
	const a = await openHost(h, "page", pageId);
	await shows(a, DEFAULT_ROWS);
	expect(await a.call((f) => f.clickView("map"))).toBe(true);
	await settled(a);
	await a.call((f) => f.prewarmDone());
	await a.call((f) => f.mapTypographySettled());
	await a.call((f) => f.mapFlush());
	const ids = Object.fromEntries(
		[
			"Ship the fold",
			"First note line",
			"A lone note",
			REPORT,
			"A subtask",
			"Subtask note",
			"Wire the store",
			"Only subtasks",
			"Dropped idea",
			"A fact",
			"Under a fact",
			"Deep under a fact",
		].map((text) => [text, idOf(text)]),
	);
	const shownIds = async () => (await a.call((f) => f.mapTree())).map((n) => n.id);
	// The nodes are the outline's rows (and the page itself).
	expect((await shownIds()).sort()).toEqual([pageId, ...Object.values(ids)].sort());
	// A closed node says how many children it hides; an open one and a leaf say nothing.
	const badges = await a.call((f) => f.mapBadges());
	expect(badges[ids["First note line"] as string]).toBe("+3");
	expect(badges[ids[REPORT] as string]).toBe("+2");
	expect(badges[ids["Wire the store"] as string]).toBe("+2");
	expect(badges[ids["Only subtasks"] as string]).toBe("+1");
	expect(badges[ids["Subtask note"] as string]).toBe("+1");
	expect(badges[ids["Ship the fold"] as string]).toBe("");
	expect(badges[ids["A lone note"] as string]).toBe("");
	expect(badges[ids["A fact"] as string]).toBe("");
	// Every node's measured size is its drawn size.
	const accuracy = await a.call((f) => f.nodeAccuracy());
	expect(accuracy.checked).toBeGreaterThan(10);
	expect(accuracy.overH).toBe(0);
	expect(accuracy.overFrame).toBe(0);
	expect(await a.call((f) => f.nodeOverflow())).toEqual([]);

	// The arrow opens one level; Alt on it everything inside.
	const note = ids["First note line"] as string;
	const arrow = await a.call((f, id) => f.mapArrowPoint(id as never), note);
	await a.page.mouse.click(arrow?.x ?? 0, arrow?.y ?? 0);
	await eventually(
		shownIds,
		(shown) => shown.includes(idOf("Detail one")) && !shown.includes(idOf("Deep detail")),
		"map arrow opens one level",
	);
	expect((await a.call((f) => f.mapBadges()))[idOf("Detail one")]).toBe("+1");
	const done = ids["Wire the store"] as string;
	// (Opening the note moved the nodes: bring them all back on screen before the next click.)
	await a.call((f) => f.mapFit());
	await a.call((f) => f.mapFlush());
	const doneArrow = await a.call((f, id) => f.mapArrowPoint(id as never), done);
	await a.page.keyboard.down("Alt");
	await a.page.mouse.click(doneArrow?.x ?? 0, doneArrow?.y ?? 0);
	await a.page.keyboard.up("Alt");
	await eventually(
		shownIds,
		(shown) => shown.includes(idOf("store.ts:12")) && shown.includes(idOf("A done subtask")),
		"map Alt+click opens everything inside",
	);
	expect((await foldState(a)).expanded.sort()).toEqual(
		[note, done, idOf("Both stores write the column")].sort(),
	);
	// Still exact after folding.
	await a.call((f) => f.mapFlush());
	const after = await a.call((f) => f.nodeAccuracy());
	expect(after.checked).toBeGreaterThan(accuracy.checked);
	expect(after.overH).toBe(0);
	expect(after.overFrame).toBe(0);
	expect(await a.call((f) => f.nodeOverflow())).toEqual([]);
	// Back in the outline: the same folding.
	expect(await a.call((f) => f.clickView("outline"))).toBe(true);
	await settled(a);
	await eventually(
		() => texts(a),
		(t) => t.includes("store.ts:12") && t.includes("Detail one") && !t.includes("Deep detail"),
		"the outline follows the map's folding",
	);
	expect(a.errors).toEqual([]);
}, 60_000);

test("an unanswered question is never folded away; a closed row's count opens to its answer form; a draft survives folding", async () => {
	const { pageId, idOf } = await page();
	const NOW = "2026-10-27T00:00:00.000Z";
	const session = generateId();
	await db.insert(narrators).values({
		id: session,
		title: "Question worker",
		ownerUserId: h.owner,
		visibility: "private",
		contextProjectId: h.space.projectId,
		taskBackend: "outline",
		createdAt: NOW,
		updatedAt: NOW,
	});
	// The session works on the subtask, asks a question under it and a follow-up under that.
	const sub = idOf("A subtask");
	await writeOutline({
		spaceId: h.space.id,
		ops: [{ op: "setTask", block: { id: sub }, task: { status: "doing" } }],
		actor: { kind: "agent", id: session },
		narratorId: session,
		responsibleUserId: h.owner,
	});
	const context = {
		narratorId: session,
		cwd: "/",
		signal: new AbortController().signal,
		locale: "en",
		userId: h.owner,
		requestPermission: async () => ({ behavior: "allow" }),
	} as ToolContext;
	const asked = await askTool.execute(
		{
			questions: [
				{
					question: "Which format should we export?",
					options: ["CSV", "JSON"],
					recommend: 2,
					items: [
						{
							question: "Anything to leave out?",
							recommend: "Nothing",
							reason: "It is all small",
						},
					],
				},
			],
		},
		context,
	);
	if (asked.isError) throw new Error(JSON.stringify(asked));
	const first = (asked.metadata?.blockIds as string[])[0] as string;
	const second = (await outlineStore.listChildMetas(h.space.id, [first], 5)).find(
		(meta) => meta.askJson !== null,
	)?.id as string;
	expect((await outlineStore.getBlock(second))?.parentId).toBe(first);
	// The task is finished with the questions still open: by the usual rule it would fold.
	await writeOutline({
		spaceId: h.space.id,
		ops: [{ op: "setTask", block: { id: sub }, task: { status: "done" } }],
		actor: { kind: "human", id: h.owner },
		responsibleUserId: h.owner,
	});
	const previousDelivery = setOutlineAnswerDelivery({
		async deliver() {
			return { written: true, woke: false };
		},
	});
	try {
		const a = await openHost(h, "page", pageId);
		const card = (id: string) => `[data-testid="outline-question-${id}"][data-state="open"]`;
		const draft = `${card(second)} [data-testid="outline-question-text"]`;
		const ids = async () => (await rows(a)).map((row) => row.id);
		// Both questions are rows on screen: the finished task, and the question over its
		// follow-up, stay open for them. Nothing is stored for it: it is the default.
		await eventually(ids, (shown) => shown.includes(first) && shown.includes(second), "on screen");
		expect((await rowOf(a, sub))?.state).toBe("open");
		expect((await rowOf(a, sub))?.hidden).toEqual({});
		expect(await foldState(a)).toEqual({ expanded: [], collapsed: [] });

		// The reader closes the task: its row counts the questions, and the count is the way to
		// them: it opens the rows and goes to the block whose page holds their answer form.
		await click(a, sub, "arrow");
		await eventually(
			() => rowOf(a, sub),
			(row) => row?.state === "closed" && row.hidden.question === 2,
			"closed over the questions",
		);
		const chipOf = (id: string) =>
			a.call((f, x) => {
				const el = f
					.view()
					.blockEls.get(x as never)
					?.querySelector<HTMLElement>(
						':scope > .ob-marks > .ob-fold-hidden[data-kind="question"]',
					);
				if (!el) return null;
				const r = el.getBoundingClientRect();
				return {
					role: el.getAttribute("role"),
					label: el.getAttribute("aria-label"),
					x: r.left + r.width / 2,
					y: r.top + r.height / 2,
				};
			}, id);
		const chip = await chipOf(sub);
		expect(chip).toMatchObject({
			role: "button",
			label: "2 questions waiting for an answer inside",
		});
		await a.page.mouse.click(chip?.x ?? 0, chip?.y ?? 0);
		await a.page.waitForSelector(draft, { visible: true, timeout: 10_000 });
		const inCard = (id: string) =>
			a.page.evaluate(
				(selector) => !!document.querySelector(selector)?.contains(document.activeElement),
				card(id),
			);
		await eventually(
			() => inCard(first),
			(inside) => inside,
			"the keyboard is in the first form",
		);
		expect(await a.call((f) => f.state().focus)).toBe(sub);
		expect((await foldState(a)).collapsed).toEqual([]);
		await settled(a);
		await eventually(ids, (shown) => shown.includes(first) && shown.includes(second), "rows");
		// No shortcut that answers for the reader.
		expect(
			await a.page.evaluate(() =>
				[...document.querySelectorAll("button")]
					.map((b) => b.textContent ?? "")
					.filter((text) => /adopt|采纳/i.test(text)),
			),
		).toEqual([]);

		// A draft in progress: a choice for the first, words for the second.
		await a.page.click(`${card(first)} input[type=radio][value="1"]`);
		await a.page.click(draft);
		await a.page.keyboard.type("Leave the logs out");
		const mark = () =>
			a.page.evaluate((selector) => {
				const el = document.querySelector(selector) as
					| (HTMLTextAreaElement & { __kept?: 1 })
					| null;
				if (!el) return null;
				const kept = el.__kept === 1;
				el.__kept = 1;
				return { kept, value: el.value, focused: document.activeElement === el };
			}, draft);
		expect(await mark()).toEqual({ kept: false, value: "Leave the logs out", focused: true });

		// The reader folds the question over its follow-up: the form is not remounted, the draft
		// and the keyboard stay where they are, and the closed row counts the follow-up.
		await click(a, first, "arrow");
		await eventually(
			() => rowOf(a, first),
			(row) => row?.state === "closed" && row.hidden.question === 1,
			"closed over the follow-up",
		);
		expect(await ids()).not.toContain(second);
		expect(await mark()).toEqual({ kept: true, value: "Leave the logs out", focused: true });
		await a.page.keyboard.type(" for now");
		// Open again, and the page's control both ways: still the same form and draft.
		await click(a, first, "arrow");
		await eventually(
			() => rowOf(a, first),
			(row) => row?.state === "open",
			"open again",
		);
		await click(a, first, "arrow");
		await eventually(
			() => rowOf(a, first),
			(row) => row?.state === "closed",
			"closed again",
		);
		const all = await a.call((f) => f.foldAll());
		expect(all?.offers).toBe("expand");
		await a.page.mouse.click(all?.x ?? 0, all?.y ?? 0);
		await eventually(
			() => rowOf(a, first),
			(row) => row?.state === "open",
			"everything open",
		);
		expect(await mark()).toEqual({
			kept: true,
			value: "Leave the logs out for now",
			focused: true,
		});
		expect(
			await a.page.evaluate(
				(selector) => (document.querySelector(selector) as HTMLInputElement | null)?.checked,
				`${card(first)} input[type=radio][value="1"]`,
			),
		).toBe(true);

		// Closed by the reader again, the count puts the keyboard in the hidden question's form.
		await click(a, first, "arrow");
		await eventually(
			() => rowOf(a, first),
			(row) => row?.state === "closed" && row.hidden.question === 1,
			"closed once more",
		);
		await a.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
		const inner = await chipOf(first);
		expect(inner?.label).toBe("1 question waiting for an answer inside");
		await a.page.mouse.click(inner?.x ?? 0, inner?.y ?? 0);
		await eventually(
			() => rowOf(a, first),
			(row) => row?.state === "open",
			"the count opens it",
		);
		await eventually(
			() => inCard(second),
			(inside) => inside,
			"the keyboard is in its form",
		);
		expect(await mark()).toEqual({
			kept: true,
			value: "Leave the logs out for now",
			focused: true,
		});

		// The draft is sent as written, bound to the version of each question it was written for.
		const versions = Object.fromEntries(
			(await outlineStore.getBlockMetasByIds([first, second])).map((m) => [m.id, m.versionSeq]),
		);
		const request = a.page.waitForRequest(
			(r) => r.url().endsWith("/api/outline/questions/answer") && r.method() === "POST",
		);
		const response = a.page.waitForResponse(
			(r) => r.url().endsWith("/api/outline/questions/answer") && r.request().method() === "POST",
		);
		await a.page.click('[data-testid="outline-questions-submit"]');
		const sent = JSON.parse((await request).postData() ?? "{}") as {
			answers: Array<{ blockId: string; versionSeq: number; option?: number; text?: string }>;
		};
		expect((await response).status()).toBe(200);
		expect(sent.answers.map((x) => [x.blockId, x.versionSeq])).toEqual([
			[first, versions[first]],
			[second, versions[second]],
		]);
		expect(sent.answers[0]?.option).toBe(1);
		expect(sent.answers[1]?.text).toBe("Leave the logs out for now");
		expect((await outlineStore.getQuestions([first, second])).map((q) => q.state)).toEqual([
			"answered",
			"answered",
		]);
		expect(a.errors).toEqual([]);
	} finally {
		setOutlineAnswerDelivery(previousDelivery);
	}
}, 60_000);

test("a selection reaching into a closed block never deletes what the block hides", async () => {
	const { pageId, idOf } = await page();
	const a = await openHost(h, "page", pageId);
	await shows(a, DEFAULT_ROWS);
	const note = idOf("First note line");
	const lone = idOf("A lone note");
	const hiddenIds = ["Detail one", "Deep detail", "Detail two", "Detail three"].map(idOf);
	const alive = async () =>
		(
			await a.call(
				(f, ids) => (ids as unknown as string[]).filter((id) => !!f.client().visible.alive(id)),
				hiddenIds,
			)
		).length;
	const selectDown = async () => {
		// From the middle of the closed block's line into the next row.
		await caret(a, note, 5);
		await press(a, "Shift+ArrowDown");
		const sel = await a.call((f) => f.selection());
		expect(sel?.anchor).toEqual({ blockId: note, offset: 5 });
		expect(sel?.head.blockId).toBe(lone);
		return sel;
	};
	const closeNote = async () => {
		if ((await rowOf(a, note))?.state !== "open") return;
		await click(a, note, "arrow");
		await eventually(
			() => rowOf(a, note),
			(row) => row?.state === "closed",
			"closed again",
		);
	};

	// Typing over it: nothing is typed or deleted; the block opens with the selection kept, so
	// the reader sees what the selection covers.
	const sel = await selectDown();
	await a.page.keyboard.type("X");
	await settle(a);
	expect(await alive()).toBe(4);
	expect(serverText(pageId, note)).toBe("First note line");
	expect(serverText(pageId, lone)).toBe("A lone note");
	await eventually(
		() => texts(a),
		(t) => t.includes("Deep detail") && t.includes("Detail three"),
		"the closed block opened instead",
	);
	expect(await a.call((f) => f.selection())).toEqual(sel as never);
	// The same key again deletes what is now on screen.
	await a.page.keyboard.type("X");
	await settle(a);
	expect(await alive()).toBe(0);
	expect(serverText(pageId, note)).toMatch(/^FirstX/);
	// Undo brings the blocks back.
	await press(a, "Control+z");
	await settle(a);
	expect(await alive()).toBe(4);
	expect(serverText(pageId, note)).toBe("First note line");
	expect(serverText(pageId, lone)).toBe("A lone note");

	// Backspace, Delete and cut over such a selection: the same.
	for (const key of ["Backspace", "Delete", "Control+x"]) {
		await a.call((f) => f.surface().foldAll(false));
		await closeNote();
		await shows(a, DEFAULT_ROWS, `default before ${key}`);
		await selectDown();
		await press(a, key);
		await settle(a);
		expect({ key, alive: await alive() }).toEqual({ key, alive: 4 });
		expect(serverText(pageId, note)).toBe("First note line");
		expect((await rowOf(a, note))?.state).toBe("open");
	}

	// Pasting over such a selection: the same.
	await a.call((f) => f.surface().foldAll(false));
	await closeNote();
	await shows(a, DEFAULT_ROWS, "default before pasting");
	await selectDown();
	await a.call((f) => {
		const data = new DataTransfer();
		data.setData("text/plain", "pasted over");
		f.view().pm.dom.dispatchEvent(
			new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
		);
	});
	await settle(a);
	expect(await alive()).toBe(4);
	expect(serverText(pageId, note)).toBe("First note line");
	expect(serverOutline(pageId)).not.toContain("pasted over");
	expect((await rowOf(a, note))?.state).toBe("open");

	// An input method starting over such a selection composes at the cursor instead.
	await a.call((f) => f.surface().foldAll(false));
	await shows(a, DEFAULT_ROWS, "default before composing");
	await selectDown();
	const input = ime(a as never);
	await input.set("ni");
	await input.commit("你");
	await settle(a);
	expect(await alive()).toBe(4);
	expect(serverText(pageId, note)).toBe("First note line");
	expect(serverText(pageId, lone)).toContain("你");
	expect((await rowOf(a, note))?.state).toBe("open");
	await press(a, "Control+z");
	await settle(a);

	// A closed block deleted as a whole still takes what it holds: block selection and Delete.
	await a.call((f) => f.surface().foldAll(false));
	await shows(a, DEFAULT_ROWS, "default before deleting the row");
	await caret(a, note);
	await a.page.keyboard.press("Escape");
	await a.page.keyboard.press("Delete");
	await settle(a);
	expect(await alive()).toBe(0);
	expect(await a.call((f, id) => !!f.client().visible.alive(id as never), note)).toBe(false);
	await press(a, "Control+z");
	await settle(a);
	expect(await alive()).toBe(4);
	// (A text selection from the very start of its line is not the whole row: the next test.)
	expect(await a.call((f) => f.viewOutline())).toBe(serverOutline(pageId));
	expect(a.errors).toEqual([]);
}, 60_000);

test("a selection from the very start of a closed row opens it first, like one from inside its line", async () => {
	const { pageId, idOf } = await page();
	const a = await openHost(h, "page", pageId);
	await shows(a, DEFAULT_ROWS);
	const note = idOf("First note line");
	const lone = idOf("A lone note");
	const hiddenIds = ["Detail one", "Deep detail", "Detail two", "Detail three"].map(idOf);
	const alive = async () =>
		(
			await a.call(
				(f, ids) => (ids as unknown as string[]).filter((id) => !!f.client().visible.alive(id)),
				hiddenIds,
			)
		).length;
	const selectFromStart = async () => {
		await caret(a, note, 0);
		await press(a, "Shift+ArrowDown");
		const sel = await a.call((f) => f.selection());
		expect(sel?.anchor).toEqual({ blockId: note, offset: 0 });
		expect(sel?.head.blockId).toBe(lone);
		return sel;
	};
	const toDefault = async (label: string) => {
		await a.call((f) => f.surface().foldAll(false));
		if ((await rowOf(a, note))?.state === "open") await click(a, note, "arrow");
		await shows(a, DEFAULT_ROWS, label);
	};

	// The first key deletes nothing and types nothing: the row opens, with the selection kept.
	for (const key of ["Backspace", "Delete", "Control+x", "X"]) {
		await toDefault(`default before ${key}`);
		const sel = await selectFromStart();
		if (key === "X") await a.page.keyboard.type("X");
		else await press(a, key);
		await settle(a);
		expect({ key, alive: await alive() }).toEqual({ key, alive: 4 });
		expect(serverText(pageId, note)).toBe("First note line");
		expect(serverText(pageId, lone)).toBe("A lone note");
		await eventually(
			() => rowOf(a, note),
			(row) => row?.state === "open",
			`the row opened instead (${key})`,
		);
		expect(await a.call((f) => f.selection())).toEqual(sel as never);
	}
	// The same key again deletes what the reader now sees; undo brings it back.
	await a.page.keyboard.press("Backspace");
	await settle(a);
	expect(await alive()).toBe(0);
	await press(a, "Control+z");
	await settle(a);
	expect(await alive()).toBe(4);
	expect(serverText(pageId, note)).toBe("First note line");
	expect(serverText(pageId, lone)).toBe("A lone note");

	// An input method starting over such a selection composes at the cursor instead.
	await toDefault("default before composing");
	await selectFromStart();
	const input = ime(a as never);
	await input.set("ni");
	await input.commit("你");
	await settle(a);
	expect(await alive()).toBe(4);
	expect(serverText(pageId, note)).toBe("First note line");
	await press(a, "Control+z");
	await settle(a);

	// A true block selection of the closed row still takes what the row holds, in one key.
	await toDefault("default before the block selection");
	await caret(a, note, 0);
	await a.page.keyboard.press("Escape");
	await a.page.keyboard.press("Backspace");
	await settle(a);
	expect(await alive()).toBe(0);
	expect(await a.call((f, id) => !!f.client().visible.alive(id as never), note)).toBe(false);
	await press(a, "Control+z");
	await settle(a);
	expect(await alive()).toBe(4);
	// And so does cutting it as a block.
	await toDefault("default before cutting the block");
	await caret(a, note, 0);
	await a.page.keyboard.press("Escape");
	await press(a, "Control+x");
	await settle(a);
	expect(await alive()).toBe(0);
	await press(a, "Control+z");
	await settle(a);
	expect(await alive()).toBe(4);
	expect(await a.call((f) => f.viewOutline())).toBe(serverOutline(pageId));
	expect(a.errors).toEqual([]);
}, 60_000);

test("a closed row wholly inside a text selection opens first too; the whole page takes two presses", async () => {
	const { pageId, idOf } = await page();
	const a = await openHost(h, "page", pageId);
	await shows(a, DEFAULT_ROWS);
	const ship = idOf("Ship the fold");
	const note = idOf("First note line");
	const lone = idOf("A lone note");
	const aliveOf = async (names: string[]) =>
		(
			await a.call(
				(f, ids) => (ids as unknown as string[]).filter((id) => !!f.client().visible.alive(id)),
				names.map(idOf),
			)
		).length;
	const hidden = ["Detail one", "Deep detail", "Detail two", "Detail three"];
	const original = serverOutline(pageId);
	const toDefault = async (label: string) => {
		await a.call((f) => f.surface().foldAll(false));
		if ((await rowOf(a, note))?.state === "open") await click(a, note, "arrow");
		await shows(a, DEFAULT_ROWS, label);
	};
	/** A text selection between two rows, as dragging or Shift with the arrows leaves it. */
	const selectRange = async (from: [string, number], to: [string, number]) => {
		await a.call(
			(f, range) => {
				const [anchor, head] = range as unknown as Array<{ blockId: string; offset: number }>;
				const v = f.view();
				v.applySelection({ anchor, head, view: v } as never);
				v.pm.focus();
			},
			[
				{ blockId: from[0], offset: from[1] },
				{ blockId: to[0], offset: to[1] },
			],
		);
		const sel = await a.call((f) => f.selection());
		expect(sel?.anchor).toEqual({ blockId: from[0], offset: from[1] });
		expect(sel?.head).toEqual({ blockId: to[0], offset: to[1] });
		return sel;
	};
	/** From the row above, over the closed row, into the row after it. */
	const selectOver = (offset: number) => selectRange([ship, offset], [lone, 3]);

	// With the keyboard: the cursor at the end of the row above, Shift+Down twice, Backspace.
	// (A press right after the cursor is put there may come before the browser has it: each
	// press is given the time to move the selection, and pressed again when it did not.)
	await caret(a, ship);
	for (let i = 0; i < 8 && (await head(a))?.blockId !== lone; i++) {
		const was = await head(a);
		await press(a, "Shift+ArrowDown");
		const end = Date.now() + 500;
		while (Date.now() < end && JSON.stringify(await head(a)) === JSON.stringify(was))
			await new Promise((r) => setTimeout(r, 20));
	}
	const typed = await a.call((f) => f.selection());
	expect(typed?.anchor).toEqual({ blockId: ship, offset: "Ship the fold".length });
	expect(typed?.head.blockId).toBe(lone);
	await a.page.keyboard.press("Backspace");
	await settle(a);
	expect(await aliveOf([...hidden, "First note line"])).toBe(5);
	expect(serverOutline(pageId)).toBe(original);
	await eventually(
		() => texts(a),
		(t) => t.includes("Deep detail") && t.includes("Detail three"),
		"the closed row opened instead (keyboard)",
	);
	expect(await a.call((f) => f.selection())).toEqual(typed as never);

	// From the end of the row above (on screen: from the start of the closed row), Backspace;
	// from the middle of the row above, typing one character.
	for (const [offset, key] of [
		[13, "Backspace"],
		[4, "X"],
		[4, "Delete"],
		[13, "Control+x"],
	] as const) {
		await toDefault(`default before ${key} from ${offset}`);
		const sel = await selectOver(offset);
		if (key === "X") await a.page.keyboard.type("X");
		else await press(a, key);
		await settle(a);
		const label = `${key} from ${offset}`;
		expect({ label, alive: await aliveOf([...hidden, "First note line"]) }).toEqual({
			label,
			alive: 5,
		});
		expect({ label, outline: serverOutline(pageId) }).toEqual({ label, outline: original });
		await eventually(
			() => texts(a),
			(t) => t.includes("Deep detail") && t.includes("Detail three"),
			`the closed row opened instead (${label})`,
		);
		expect(await a.call((f) => f.selection())).toEqual(sel as never);
	}
	// The same key again deletes what the reader now sees; undo brings it back.
	await a.page.keyboard.type("X");
	await settle(a);
	expect(await aliveOf([...hidden, "First note line"])).toBe(0);
	await press(a, "Control+z");
	await settle(a);
	expect(serverOutline(pageId)).toBe(original);

	// Finished tasks wholly inside a selection: typing over them opens each of them first.
	await toDefault("default before typing over finished tasks");
	const finished = [
		"Subtask deep",
		"A done subtask",
		"Both stores write the column",
		"store.ts:12",
		"Nested done",
	];
	await selectRange([idOf("Subtask note"), 3], [idOf("Dropped idea"), 2]);
	await a.page.keyboard.type("X");
	await settle(a);
	expect(await aliveOf(finished)).toBe(finished.length);
	expect(serverOutline(pageId)).toBe(original);
	await eventually(
		() => texts(a),
		(t) => finished.every((text) => t.includes(text)),
		"the finished tasks opened instead",
	);

	// Every row of the page selected as text, from the first row's first character to the end
	// of the last: the first Delete opens everything that is closed and deletes nothing; the
	// second deletes what is now on screen.
	await toDefault("default before selecting the whole page");
	const everything = [...hidden, ...finished, "Superseded by the fold"];
	await selectRange([ship, 0], [idOf("Deep under a fact"), "Deep under a fact".length]);
	await a.page.keyboard.press("Delete");
	await settle(a);
	expect(serverOutline(pageId)).toBe(original);
	await eventually(
		() => texts(a),
		(t) => everything.every((text) => t.includes(text)),
		"every closed row opened first",
	);
	await a.page.keyboard.press("Delete");
	await settle(a);
	expect(await aliveOf([...everything, "First note line", "Wire the store", "A fact"])).toBe(0);
	await press(a, "Control+z");
	await settle(a);
	expect(serverOutline(pageId)).toBe(original);

	// Select all (Mod-A twice) is the editor's whole document, the page's own block included,
	// and that block always stays: Delete and typing over it change nothing, however often.
	await toDefault("default before select all");
	for (const key of ["Delete", "Backspace", "X"]) {
		await caret(a, lone, 2);
		await press(a, "Control+a");
		await press(a, "Control+a");
		const all = await a.call((f) => {
			const v = f.view();
			const sel = v.pm.state.selection;
			return { blocks: v.selectedBlocks().length, from: sel.from, to: sel.to };
		});
		expect(all).toEqual({
			blocks: 0,
			from: 0,
			to: await a.call((f) => f.view().pm.state.doc.content.size),
		});
		for (let i = 0; i < 2; i++) {
			if (key === "X") await a.page.keyboard.type("X");
			else await a.page.keyboard.press(key);
			await settle(a);
			expect({ key, i, outline: serverOutline(pageId) }).toEqual({ key, i, outline: original });
		}
	}
	await shows(a, DEFAULT_ROWS, "nothing opened, nothing deleted");
	expect(await a.call((f) => f.viewOutline())).toBe(serverOutline(pageId));
	expect(a.errors).toEqual([]);
}, 90_000);

test("a task kept open for the cursor stays open while the reader folds elsewhere", async () => {
	const { pageId, idOf } = await page();
	const a = await openHost(h, "page", pageId);
	await shows(a, DEFAULT_ROWS);
	const sub = idOf("A subtask");
	const subnote = idOf("Subtask note");
	const done = idOf("Wire the store");
	const note = idOf("First note line");
	const held = async (label: string) => {
		expect({ label, state: (await rowOf(a, sub))?.state }).toEqual({ label, state: "open" });
		expect({ label, at: (await head(a))?.blockId }).toEqual({ label, at: subnote });
	};
	const tickAround = async (label: string) => {
		await caret(a, subnote);
		await a.call((f, id) => f.setTask(id as never, "x"), sub);
		await settle(a);
		await held(label);
	};
	await tickAround("ticked done around the cursor");
	expect(await foldState(a)).toEqual({ expanded: [], collapsed: [] });

	// An arrow elsewhere on the page: that row opens, the task around the cursor stays.
	await click(a, done, "arrow");
	await eventually(
		() => rowOf(a, done),
		(row) => row?.state === "open",
		"the other row opened",
	);
	await held("after an arrow elsewhere");
	expect(await foldState(a)).toEqual({ expanded: [done], collapsed: [] });
	// And closing it again.
	await click(a, done, "arrow");
	await eventually(
		() => rowOf(a, done),
		(row) => row?.state === "closed",
		"the other row closed",
	);
	await held("after closing elsewhere");
	// A quick control elsewhere (everything inside another row).
	await click(a, note, "quick");
	await eventually(
		() => texts(a),
		(t) => t.includes("Deep detail"),
		"everything inside the other row",
	);
	await held("after a quick control elsewhere");
	// The keyboard on the cursor's own block: it opens, the task around it stays.
	await press(a, "Control+.");
	await eventually(
		() => texts(a),
		(t) => t.includes("Subtask deep"),
		"the cursor's block opened",
	);
	await held("after folding the cursor's own block");
	// The page's control opening everything.
	await a.call((f) => f.surface().foldAll(true));
	await eventually(
		() => texts(a),
		(t) => t.includes("store.ts:12"),
		"everything open",
	);
	await held("after opening everything");

	// The cursor leaving lets it go, whatever was folded meanwhile.
	await a.call((f) => f.surface().foldAll(false));
	await a.call((f, id) => f.setTask(id as never, "/"), sub);
	await settle(a);
	await tickAround("ticked done again");
	await click(a, done, "arrow");
	await eventually(
		() => rowOf(a, done),
		(row) => row?.state === "open",
		"the other row opened again",
	);
	await held("still held");
	await caret(a, done);
	await eventually(
		() => rowOf(a, sub),
		(row) => row?.state === "closed",
		"closed once the cursor left",
	);

	// The reader's own fold of a block around the cursor is not held against them: the arrow
	// of the task above closes it, and the cursor goes to that task's line.
	await a.call((f, id) => f.setTask(id as never, "/"), sub);
	await settle(a);
	await tickAround("ticked done a third time");
	const top = idOf("Ship the fold");
	await click(a, top, "arrow");
	await eventually(
		() => rowOf(a, top),
		(row) => row?.state === "closed",
		"the task above closed",
	);
	expect((await head(a))?.blockId).toBe(top);
	expect(a.errors).toEqual([]);
}, 40_000);

test("deleting the block after a closed row leaves the row closed; held fold keys toggle once", async () => {
	const { pageId, idOf } = await page();
	const a = await openHost(h, "page", pageId);
	await shows(a, DEFAULT_ROWS);
	const note = idOf("First note line");
	const lone = idOf("A lone note");
	// Block selection and Delete on the row after a closed one.
	await caret(a, lone);
	await a.page.keyboard.press("Escape");
	await a.page.keyboard.press("Delete");
	await settle(a);
	expect(await a.call((f, id) => !!f.client().visible.alive(id as never), lone)).toBe(false);
	// The cursor is at the end of the closed row's own line; nothing opened, nothing stored.
	expect(await head(a)).toEqual({ blockId: note, offset: "First note line".length });
	expect((await rowOf(a, note))?.state).toBe("closed");
	expect(await foldState(a)).toEqual({ expanded: [], collapsed: [] });
	// The first block under an open task: the cursor goes to the task's line.
	await caret(a, note);
	await a.page.keyboard.press("Escape");
	await a.page.keyboard.press("Delete");
	await settle(a);
	expect((await head(a))?.blockId).toBe(idOf("Ship the fold"));
	expect(await foldState(a)).toEqual({ expanded: [], collapsed: [] });

	// Mod-. held down: one toggle. Alt-Enter held down: one toggle.
	const done = idOf("Wire the store");
	await caret(a, done);
	await a.page.keyboard.down("Control");
	await a.page.keyboard.down(".");
	await a.page.keyboard.down(".");
	await a.page.keyboard.down(".");
	await a.page.keyboard.up(".");
	await a.page.keyboard.up("Control");
	expect((await rowOf(a, done))?.state).toBe("open");
	expect(await foldState(a)).toEqual({ expanded: [done], collapsed: [] });
	await a.page.keyboard.down("Alt");
	await a.page.keyboard.down("Enter");
	await a.page.keyboard.down("Enter");
	await a.page.keyboard.up("Enter");
	await a.page.keyboard.up("Alt");
	expect((await texts(a)).includes("store.ts:12")).toBe(true);
	// Nothing was typed by the repeats.
	await settle(a);
	expect(serverText(pageId, done)).toBe("Wire the store");
	expect(a.errors).toEqual([]);
}, 40_000);

test("a task the reader ticks done with the cursor inside closes when the cursor leaves", async () => {
	const { pageId, idOf } = await page();
	const a = await openHost(h, "page", pageId);
	await shows(a, DEFAULT_ROWS);
	const sub = idOf("A subtask");
	const subnote = idOf("Subtask note");
	await caret(a, subnote);
	await a.call((f, id) => f.setTask(id as never, "x"), sub);
	await settle(a);
	// Still open around the cursor, and not as something the reader opened.
	expect((await rowOf(a, sub))?.state).toBe("open");
	expect((await head(a))?.blockId).toBe(subnote);
	expect(await foldState(a)).toEqual({ expanded: [], collapsed: [] });
	// Kept open for the cursor, not against the reader: their own click on its arrow closes it,
	// and the cursor goes to the task's line.
	await click(a, sub, "arrow");
	await eventually(
		() => rowOf(a, sub),
		(row) => row?.state === "closed",
		"the reader closes it",
	);
	expect((await head(a))?.blockId).toBe(sub);
	expect(await foldState(a)).toEqual({ expanded: [], collapsed: [] });
	await caret(a, subnote);
	expect((await foldState(a)).expanded).toEqual([sub]);
	await click(a, sub, "arrow");
	expect(await foldState(a)).toEqual({ expanded: [], collapsed: [] });
	await a.call((f, id) => f.setTask(id as never, "/"), sub);
	await caret(a, subnote);
	await a.call((f, id) => f.setTask(id as never, "x"), sub);
	await settle(a);
	expect((await rowOf(a, sub))?.state).toBe("open");
	expect(await foldState(a)).toEqual({ expanded: [], collapsed: [] });
	// Moving inside it keeps it open; leaving closes it.
	await caret(a, sub);
	expect((await rowOf(a, sub))?.state).toBe("closed");
	// (On the task's own line the cursor is outside what the task holds.)
	await caret(a, subnote);
	expect((await rowOf(a, sub))?.state).toBe("open");
	expect((await foldState(a)).expanded).toEqual([sub]);
	expect(a.errors).toEqual([]);
}, 30_000);

test("a task finished by someone else above the reader does not move what they read", async () => {
	// Tall enough to scroll: tasks in progress with notes, the reader near the end.
	const lines: string[] = [];
	for (let t = 0; t < 24; t++) {
		lines.push(`[/] Task ${t}`);
		for (let n = 0; n < 4; n++) lines.push(`  Note ${t}.${n}`);
	}
	const { pageId, ids } = await seedPage(h, "Tall page", lines);
	const idOfLine = (text: string) => ids[lines.indexOf(text)] as string;
	const a = await openHost(h, "page", pageId, { width: 900, height: 600 });
	const b = await openBob(h, pageId);
	await eventually(
		() => texts(a),
		(t) => t.length === lines.length,
		"the tall page is shown",
	);
	const reading = idOfLine("  Note 20.1");
	await caret(a, reading);
	await a.call(
		(f, id) =>
			(f.view().blockEls.get(id as never) as HTMLElement).scrollIntoView({ block: "center" }),
		reading,
	);
	const where = () =>
		a.call((f, id) => {
			const el = f.view().blockEls.get(id as never) as HTMLElement;
			// Whatever scrolls the page (the surface's own scroller, or a box around it).
			let scroll = window.scrollY;
			for (let p = el.parentElement; p; p = p.parentElement) scroll += p.scrollTop;
			return { top: Math.round(el.getBoundingClientRect().top), scroll: Math.round(scroll) };
		}, reading);
	// (After a keystroke: the browser's own scroll anchoring no longer holds the row then.)
	await a.page.keyboard.type("x");
	await settle(a, b);
	const before = await where();
	expect(before.scroll).toBeGreaterThan(100);
	// Bob finishes three tasks above: fifteen rows become three.
	for (const t of [2, 5, 9])
		await b.call((f, id) => f.setTask(id as never, "x"), idOfLine(`[/] Task ${t}`));
	await settle(a, b);
	await eventually(
		() => texts(a),
		(t) => t.length === lines.length - 12,
		"the finished tasks closed",
	);
	const after = await where();
	expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1);
	expect(after.scroll).toBeLessThan(before.scroll - 100);
	// He adds rows above: the same.
	await b.call((f, id) => f.cmd("split", id as never, 9999), idOfLine("  Note 0.0"));
	await b.call((f, id) => f.cmd("split", id as never, 9999), idOfLine("  Note 0.1"));
	await settle(a, b);
	await eventually(
		() => texts(a),
		(t) => t.length === lines.length - 10,
		"the new rows arrived",
	);
	expect(Math.abs((await where()).top - before.top)).toBeLessThanOrEqual(1);
	// Without the keyboard in the editor the first row in view is what stays put.
	await a.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	const first = await a.call((f) => {
		const box = f.surface().scroller.getBoundingClientRect();
		const rows = [...f.view().pm.dom.querySelectorAll<HTMLElement>(".ob-block .ob-block")];
		const el = rows.find((row) => row.getBoundingClientRect().top >= box.top) as HTMLElement;
		return { id: el.dataset.id as string, top: Math.round(el.getBoundingClientRect().top) };
	});
	await b.call((f, id) => f.setTask(id as never, "x"), idOfLine("[/] Task 12"));
	await settle(a, b);
	await eventually(
		() => texts(a),
		(t) => t.length === lines.length - 14,
		"one more closed",
	);
	const firstNow = await a.call(
		(f, id) =>
			Math.round((f.view().blockEls.get(id as never) as HTMLElement).getBoundingClientRect().top),
		first.id,
	);
	expect(Math.abs(firstNow - first.top)).toBeLessThanOrEqual(1);
	expect([...a.errors, ...b.errors]).toEqual([]);
}, 60_000);
