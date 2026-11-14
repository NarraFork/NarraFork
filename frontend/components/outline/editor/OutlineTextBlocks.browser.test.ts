/**
 * Text per block in the real editor (Chromium, two people): every block has a text document of
 * its own, made only when someone types in it, and the editor keeps one undo stack over them
 * (`live-client.ts`, `shared/outline-live-text.ts`). The engine-level cases are in
 * `server/services/outline/live/__tests__/live-text-blocks.test.ts`; here real keystrokes, real
 * Ctrl+Z and the real view go through the same paths.
 *
 * What must hold:
 *  - opening a page makes no text document; typing makes one for that block, on both editors;
 *  - two people typing at the same moment in a block neither had touched (each makes its
 *    document on its own) keep both texts, and Ctrl+Z / Ctrl+Shift+Z then take and return each
 *    person's keystrokes in the order typed;
 *  - Ctrl+Z walks one stack across blocks and structural changes in the order the person
 *    worked, and Ctrl+Shift+Z walks it forward again, with someone else's text in the same
 *    blocks left alone;
 *  - random editing with a high share of undo and redo, holds and an agent converges, over more
 *    rounds than `OutlineEditor.browser.test.ts` runs, with no document left with an update it
 *    cannot integrate.
 *
 * Behaviour only: nothing here depends on timing, fonts or line counts.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { liveSessionOf } from "../../../../server/services/outline/live/registry";
import { writeOutline } from "../../../../server/services/outline/write";
import {
	dbOutline,
	type Editor,
	errorsOf,
	flushed,
	type Harness,
	openEditor,
	resetHarness,
	seedPage,
	serverOutline,
	serverText,
	settle,
	startHarness,
	stopHarness,
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

async function both(pageId: string): Promise<[Editor, Editor]> {
	return [await openEditor(h, h.owner, pageId), await openEditor(h, h.writer, pageId)];
}

const caret = (e: Editor, id: string, offset = -1) =>
	e.call((f, x, o) => f.caret(x as never, o as never), id, offset);
const hold = (e: Editor, on: boolean) => e.call((f, x) => f.net().hold(x as never), on);
const docsOf = (e: Editor) => e.call((f) => f.client().textDocs);

/** Press a key with modifiers ("Control+Shift+z"). */
async function press(e: Editor, keys: string): Promise<void> {
	const parts = keys.split("+");
	const key = parts.pop() as string;
	for (const m of parts) await e.page.keyboard.down(m as never);
	await e.page.keyboard.press(key as never);
	for (const m of parts.reverse()) await e.page.keyboard.up(m as never);
}

/** Every editor, its client and the server show the same page. */
async function converged(pageId: string, ...editors: Editor[]): Promise<string> {
	await settle(...editors);
	const server = serverOutline(pageId);
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

/** No editor holds a text document with an update stuck in it, and none the server lacks. */
async function soundDocuments(pageId: string, ...editors: Editor[]): Promise<void> {
	const session = liveSessionOf(pageId);
	if (!session) throw new Error("no session");
	const server = new Set(session.textDocIds);
	for (const id of server) expect(session.textState(id)?.stuck).toBe(false);
	for (const e of editors) {
		const mine = await e.call((f) => {
			const c = f.client();
			const ids = new Set<string>(c.visible.blocks.keys());
			const out: Array<{ id: string; stuck: boolean; text: string }> = [];
			for (const id of ids) {
				const state = c.textState(id);
				if (state) out.push({ id, stuck: state.stuck, text: c.textOf(id) });
			}
			return out;
		});
		for (const d of mine) {
			expect({ who: e.userId, ...d }).toEqual({
				who: e.userId,
				id: d.id,
				stuck: false,
				text: session.textOf(d.id),
			});
			expect(server.has(d.id)).toBe(true);
		}
	}
}

function noErrors(...editors: Editor[]): void {
	for (const e of editors) expect(errorsOf(e)).toEqual([]);
}

test("no document until someone types; two people typing at once in an untouched block keep both texts, and each one's undo and redo return their keystrokes in order", async () => {
	const { pageId, ids } = await seedPage(h, "按块", ["甲块", "乙块", "丙块", "丁块"]);
	const [b0] = ids as [string, string, string, string];
	const [a, b] = await both(pageId);
	await settle(a, b);
	expect(liveSessionOf(pageId)?.textDocs).toBe(0);
	expect(await docsOf(a)).toBe(0);
	expect(await docsOf(b)).toBe(0);

	// Neither sees the other's keystrokes: each makes the block's document on its own.
	await hold(a, true);
	await hold(b, true);
	await caret(a, b0);
	await a.page.keyboard.type("abcdef");
	await caret(b, b0, 0);
	await b.page.keyboard.type("uvwxyz");
	expect(await docsOf(a)).toBe(1);
	expect(await docsOf(b)).toBe(1);
	expect(liveSessionOf(pageId)?.textDocs).toBe(0);
	await hold(a, false);
	await hold(b, false);
	await settle(a, b);
	expect(serverText(pageId, b0)).toBe("uvwxyz甲块abcdef");
	expect(liveSessionOf(pageId)?.textDocIds).toEqual([b0]);
	await converged(pageId, a, b);

	await press(a, "Control+z");
	await settle(a, b);
	expect(serverText(pageId, b0)).toBe("uvwxyz甲块");
	await press(b, "Control+z");
	await settle(a, b);
	expect(serverText(pageId, b0)).toBe("甲块");
	// Redone in the other order, with the other person's text already back.
	await press(b, "Control+Shift+z");
	await settle(a, b);
	expect(serverText(pageId, b0)).toBe("uvwxyz甲块");
	await press(a, "Control+Shift+z");
	await settle(a, b);
	expect(serverText(pageId, b0)).toBe("uvwxyz甲块abcdef");
	// And once more, the redo racing the other person's next keystrokes.
	await press(a, "Control+z");
	await settle(a, b);
	await hold(b, true);
	await caret(b, b0, 3);
	await b.page.keyboard.type("MID");
	await press(a, "Control+Shift+z");
	await settle(a);
	await hold(b, false);
	await settle(a, b);
	expect(serverText(pageId, b0)).toBe("uvwMIDxyz甲块abcdef");
	await converged(pageId, a, b);
	// Still one document, for the one block anyone typed in.
	expect(liveSessionOf(pageId)?.textDocIds).toEqual([b0]);
	expect(await docsOf(a)).toBe(1);
	await soundDocuments(pageId, a, b);
	await flushed(pageId);
	expect(await dbOutline(pageId)).toBe(serverOutline(pageId));
	noErrors(a, b);
}, 60_000);

test("Ctrl+Z walks one stack across blocks and structure in the order worked, Ctrl+Shift+Z walks it forward, and the other person's text in the same blocks stays", async () => {
	const { pageId, ids } = await seedPage(h, "一个栈", ["第一块", "第二块", "第三块"]);
	const [b0, b1, b2] = ids as [string, string, string];
	const [a, b] = await both(pageId);

	// The other person's text is there throughout, in two of the blocks A works in.
	await caret(b, b0, 0);
	await b.page.keyboard.type("B0");
	await caret(b, b2, 0);
	await b.page.keyboard.type("B2");
	await settle(a, b);

	// A: text in three blocks, back in the first, a split, text in the new block, an indent,
	// and text in the second again. Each is one step.
	const states = [serverOutline(pageId)];
	const step = async (work: () => Promise<void>) => {
		await work();
		await settle(a, b);
		states.push(serverOutline(pageId));
	};
	await step(async () => {
		await caret(a, b0);
		await a.page.keyboard.type("a1");
	});
	await step(async () => {
		await caret(a, b1);
		await a.page.keyboard.type("a2");
	});
	await step(async () => {
		await caret(a, b2);
		await a.page.keyboard.type("a3");
	});
	await step(async () => {
		await caret(a, b0);
		await a.page.keyboard.type("a4");
	});
	await step(async () => {
		await caret(a, b2);
		await press(a, "Enter");
	});
	await step(async () => {
		await a.page.keyboard.type("new");
	});
	await step(async () => {
		await press(a, "Tab");
	});
	await step(async () => {
		await caret(a, b1);
		await a.page.keyboard.type("a5");
	});
	expect(states[0]).toBe("- B0第一块\n- 第二块\n- B2第三块");
	expect(states[8]).toBe("- B0第一块a1a4\n- 第二块a2a5\n- B2第三块a3\n  - new");
	// Every step changed the page.
	expect(new Set(states).size).toBe(9);

	for (let i = 7; i >= 0; i--) {
		await press(a, "Control+z");
		await settle(a, b);
		expect({ after: i, page: serverOutline(pageId) }).toEqual({ after: i, page: states[i] });
	}
	await converged(pageId, a, b);
	// Nothing left to undo: one more changes nothing.
	await press(a, "Control+z");
	await settle(a, b);
	expect(serverOutline(pageId)).toBe(states[0] as string);

	for (let i = 1; i <= 8; i++) {
		await press(a, "Control+Shift+z");
		await settle(a, b);
		expect({ after: i, page: serverOutline(pageId) }).toEqual({ after: i, page: states[i] });
	}
	await converged(pageId, a, b);

	// Half way back, the other person types in a block of a step still undone, and an agent
	// rewrites another; the redos still land.
	for (let i = 0; i < 4; i++) await press(a, "Control+z");
	await settle(a, b);
	expect(serverOutline(pageId)).toBe(states[4] as string);
	await caret(b, b2);
	await b.page.keyboard.type("!");
	await settle(a, b);
	await writeOutline({
		spaceId: h.space.id,
		ops: [{ op: "update", block: { id: b1 }, content: "agent: 第二块a2" }],
		actor: { kind: "agent", id: "narrator-undo" },
		responsibleUserId: h.owner,
	});
	await settle(a, b);
	for (let i = 0; i < 4; i++) {
		await press(a, "Control+Shift+z");
		await settle(a, b);
	}
	expect(serverOutline(pageId)).toBe("- B0第一块a1a4\n- agent: 第二块a2a5\n- B2第三块a3!\n  - new");
	await converged(pageId, a, b);
	await soundDocuments(pageId, a, b);
	await flushed(pageId);
	expect(await dbOutline(pageId)).toBe(serverOutline(pageId));
	noErrors(a, b);
}, 90_000);

for (const start of [20261114, 7919]) {
	test(`random editing heavy on undo and redo converges (seed ${start})`, async () => {
		const { pageId } = await seedPage(h, "按块压力", ["一", "二", "  三", "四", "五", "六"]);
		const [a, b] = await both(pageId);
		let seed = start;
		const r = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		const names = ["moveUp", "moveDown", "indent", "outdent", "split", "join"];
		for (let i = 0; i < 260; i++) {
			const who = r() < 0.5 ? a : b;
			if (r() < 0.1) await hold(who, !(await who.call((f) => f.net().held)));
			const x = r();
			if (x < 0.94) {
				await who.call(
					(f, x1, x2, x3, names0) => {
						const c = f.client();
						const ids = [...c.visible.blocks.values()]
							.filter((bk) => c.visible.inPage(bk.id) && bk.id !== c.pageId)
							.map((bk) => bk.id);
						if (!ids.length) return;
						const id = ids[Math.floor((x1 as number) * ids.length)] as string;
						const text = f.viewText(id as never) ?? "";
						if ((x2 as number) < 0.45) {
							const off = Math.floor((x3 as number) * (text.length + 1));
							f.insertAt(
								id as never,
								off,
								String.fromCharCode(0x4e00 + Math.floor((x3 as number) * 500)),
							);
						} else if ((x2 as number) < 0.65) {
							const list = names0 as string[];
							const n = list[Math.floor((x3 as number) * list.length)] as never;
							f.cmd(
								n,
								id as never,
								n === "split" ? Math.floor((x3 as number) * (text.length + 1)) : 0,
							);
						} else if ((x2 as number) < 0.85) f.undo();
						else f.redo();
					},
					r(),
					r(),
					r(),
					names,
				);
			} else {
				const s = liveSessionOf(pageId);
				const live = s ? s.mirror.subtree(pageId).filter((id) => id !== pageId) : [];
				const id = live[Math.floor(r() * live.length)];
				if (id) {
					await writeOutline({
						spaceId: h.space.id,
						ops: [{ op: "update", block: { id }, content: `${s?.textOf(id) ?? ""}·` }],
						actor: { kind: "agent", id: "narrator-stress" },
						responsibleUserId: h.owner,
					}).catch(() => {});
				}
			}
			if (i % 20 === 19) {
				// The network comes back now and then.
				await hold(a, false);
				await hold(b, false);
				await settle(a, b);
			}
		}
		await hold(a, false);
		await hold(b, false);
		await converged(pageId, a, b);
		await soundDocuments(pageId, a, b);
		// Then each undoes as far as it can and redoes as far as it can: still one page.
		for (const who of [a, b]) {
			await who.call((f) => {
				for (let n = 0; n < 500 && f.undo(); n++);
			});
			await converged(pageId, a, b);
			await who.call((f) => {
				for (let n = 0; n < 500 && f.redo(); n++);
			});
			await converged(pageId, a, b);
		}
		await soundDocuments(pageId, a, b);
		await flushed(pageId);
		expect(await dbOutline(pageId)).toBe(serverOutline(pageId));
		noErrors(a, b);
	}, 120_000);
}
