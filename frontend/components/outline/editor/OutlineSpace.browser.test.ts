/**
 * Views of one space in Chromium (pageless plan L3 acceptance): editors whose roots are different
 * blocks of one space are participants of one session and see each other live; a block someone
 * moves reaches the others as a move (never a delete and an insert), and what is being typed into
 * it meanwhile is kept; an editor whose root is not a page resumes after a dropped connection
 * without losing what was typed offline.
 *
 * The editor still shows one root per session client (L4/L5 change that): the views here are
 * editors of different people, or of one person on different roots.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { liveSessionOf, liveSpaceOf } from "../../../../server/services/outline/live/registry";
import {
	dbText,
	type Editor,
	errorsOf,
	flushed,
	type Harness,
	openEditor,
	resetHarness,
	seedPage,
	serverOutline,
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

const caret = (e: Editor, id: string, offset = -1) =>
	e.call((f, x, o) => f.caret(x as never, o as never), id, offset);
const hold = (e: Editor, on: boolean) => e.call((f, x) => f.net().hold(x as never), on);
const opsSeen = (e: Editor) => e.call((f) => [...f.net().opsSeen]);

/** The editor's client and its document show what the server's session holds under its root. */
async function converged(rootId: string, ...editors: Editor[]): Promise<string> {
	await settle(...editors);
	const server = serverOutline(rootId);
	for (const e of editors) {
		expect({ who: e.userId, client: await e.call((f) => f.outline()) }).toEqual({
			who: e.userId,
			client: server,
		});
		expect({ who: e.userId, view: await e.call((f) => f.viewOutline()) }).toEqual({
			who: e.userId,
			view: server,
		});
	}
	return server;
}

function noErrors(...editors: Editor[]): void {
	for (const e of editors) expect(errorsOf(e)).toEqual([]);
}

test("two views of one space, the page and a block inside it as its own root, see each other live in one session", async () => {
	const { pageId, ids } = await seedPage(h, "Space views", ["X", "  x1", "  x2", "Y"]);
	const [x, x1, x2] = ids as [string, string, string, string];
	const a = await openEditor(h, h.owner, pageId);
	const b = await openEditor(h, h.writer, x);
	// One session of the space, both people in it.
	const session = liveSpaceOf(h.space.id);
	expect(session?.participants.size).toBe(2);
	expect(liveSessionOf(x)?.space).toBe(session);

	await caret(a, x1);
	await a.page.keyboard.type(" from the page");
	await until(b, (f, id) => f.text(id as never).endsWith("from the page"), [x1]);
	await caret(b, x2);
	await b.page.keyboard.type(" from the block");
	await until(a, (f, id) => f.text(id as never).endsWith("from the block"), [x2]);

	expect(await converged(x, b)).toBe("- x1 from the page\n- x2 from the block");
	expect(await converged(pageId, a)).toBe("- X\n  - x1 from the page\n  - x2 from the block\n- Y");
	await flushed(pageId);
	expect(await dbText(x1)).toBe("x1 from the page");
	expect(await dbText(x2)).toBe("x2 from the block");
	noErrors(a, b);
}, 30_000);

test("a moved block reaches the others as a move, and what is typed into it meanwhile is kept", async () => {
	const { pageId, ids } = await seedPage(h, "Moves", ["X", "  x1", "Y", "  y1"]);
	const [, x1, y] = ids as [string, string, string, string];
	const a = await openEditor(h, h.owner, pageId);
	const c = await openEditor(h, h.writer, pageId);
	// Y as a root of its own: x1 arrives there with its text.
	const d = await openEditor(h, h.reader, y, { canWrite: false });
	const seenBefore = (await opsSeen(c)).length;

	// C types into x1 while A moves it under Y; C's frames reach the server after the move.
	await caret(c, x1);
	await hold(c, true);
	await c.page.keyboard.type(" typed while moved");
	await a.call((f, id, p) => f.moveInto(id as never, p as never), x1, y);
	await settle(a);
	await hold(c, false);
	await settle(a, c, d);

	expect(await converged(pageId, a, c)).toBe("- X\n- Y\n  - y1\n  - x1 typed while moved");
	expect(await converged(y, d)).toBe("- y1\n- x1 typed while moved");
	// C (watching the whole page) was sent a move of x1: never a delete or an insert of it.
	const ofX1 = (await opsSeen(c)).slice(seenBefore).filter((op) => op.endsWith(` ${x1}`));
	expect(ofX1).toEqual([`m ${x1}`]);
	await flushed(pageId);
	expect(await dbText(x1)).toBe("x1 typed while moved");
	expect(await c.call((f) => f.client().stats.rejects)).toBe(0);
	noErrors(a, c, d);
}, 30_000);

test("an editor rooted at a block resumes after a dropped connection: nothing typed offline is lost", async () => {
	const { pageId, ids } = await seedPage(h, "Reconnect", ["X", "  x1", "  x2"]);
	const [x, x1, x2] = ids as [string, string, string];
	const a = await openEditor(h, h.owner, pageId);
	const b = await openEditor(h, h.writer, x);
	await caret(b, x2);
	await b.call((f) => f.net().disconnect());
	await until(b, (f) => f.client().status !== "live");
	await b.page.keyboard.type(" offline");
	// Meanwhile the other view types into the same subtree.
	await caret(a, x1);
	await a.page.keyboard.type(" online");
	await settle(a);
	await b.call((f) => f.net().connect());
	await until(b, (f) => f.client().status === "live", [], 10_000);
	await until(b, (f, id) => f.text(id as never).endsWith("online"), [x1]);
	await until(a, (f, id) => f.text(id as never).endsWith("offline"), [x2]);

	expect(await converged(x, b)).toBe("- x1 online\n- x2 offline");
	expect(await converged(pageId, a)).toBe("- X\n  - x1 online\n  - x2 offline");
	expect(await b.call((f) => f.client().stats.resumes)).toBeGreaterThanOrEqual(1);
	await flushed(pageId);
	expect(await dbText(x1)).toBe("x1 online");
	expect(await dbText(x2)).toBe("x2 offline");
	noErrors(a, b);
}, 30_000);
