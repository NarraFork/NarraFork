/**
 * Typing that did not reach the page is never lost with a client, session, panel or surface
 * (review round 4): it goes to the tab's unsaved-text store, which outlives all of them, and
 * leaves only when the person dismisses it or the page acknowledges it.
 *
 * What must hold:
 *  - the store is bounded (entries, bytes): the oldest go first, with a warning; a newer entry for
 *    the same block and reason replaces the older one;
 *  - refused, or no longer allowed to write, with typing on hand: the text is in the store, and
 *    stays there when the panel is hidden (the session dropped) and shown again (probe P2′);
 *  - a session with typing not acknowledged is not dropped to make room for other pages, nor
 *    after its grace period: it waits for the socket and the acknowledgement (probe P5), at most
 *    the documented wait; then its client gives the typing to the store as it goes;
 *  - text kept because its block is gone is not overwritten by a later "deleted" notice; adding
 *    it back is done (the entry leaves) only when the page acknowledges it, and a refused restore
 *    keeps it;
 *  - restoring a deleted block validates every operation: one that no longer fits keeps the
 *    notice and sends nothing.
 *
 * Review of round 4 (minor):
 *  - texts the limits push out are counted on their page (the notice says so) until dismissed;
 *  - the sessions kept only for typing not acknowledged are counted for the tab-limit notice,
 *    with when the first of them goes at the latest;
 *  - adding back sent but never answered (the session closed) marks the entry "may have been
 *    added"; one never sent, or refused, does not;
 *  - past the wait, what was sent but never acknowledged on a connection that looks live (dead
 *    without knowing it) goes to the store too; what was acknowledged never does.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	decodeLiveFrame,
	encodeLiveFrame,
	LIVE_FRAME,
	type LiveBlockWire,
	type LiveFrame,
	type LiveJoinedHead,
	OUTLINE_LIVE_LIMITS,
} from "@shared/outline-live-protocol";
import * as Y from "yjs";
import { LiveClient, type LiveTransport, type SeedBlock } from "./live-client";
import {
	acquireLiveSession,
	liveSessionsOn,
	liveSessionsWaitingOn,
	releaseLiveSession,
	retainLiveSession,
	setLiveSessionGraceForTests,
	setLiveSessionUnackedWaitForTests,
} from "./live-sessions";
import {
	clearUnsavedTextsForTests,
	dismissUnsavedDropped,
	dropUnsavedText,
	keepUnsavedTexts,
	UNSAVED_LIMITS,
	unsavedDroppedOf,
	unsavedTextsOf,
} from "./unsaved-texts";

/** A socket that records what is sent, lets the test answer, and can go down and come back. */
function socket() {
	const handles = new Set<number>();
	const listeners = new Set<(frame: LiveFrame) => void>();
	const connection = new Set<(connected: boolean) => void>();
	const sent: LiveFrame[] = [];
	let up = true;
	const transport: LiveTransport = {
		get connected() {
			return up;
		},
		send(bytes) {
			if (!up) return false;
			const frame = decodeLiveFrame(bytes);
			if (frame) sent.push(frame);
			return true;
		},
		onFrame(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		onConnectionChange(listener) {
			connection.add(listener);
			return () => connection.delete(listener);
		},
		allocateHandle() {
			for (let h = 1; h < 256; h++) {
				if (!handles.has(h)) {
					handles.add(h);
					return h;
				}
			}
			return null;
		},
		releaseHandle(handle) {
			handles.delete(handle);
		},
	};
	const deliver = (frame: {
		kind: number;
		handle: number;
		n?: number;
		head?: unknown;
		body?: Uint8Array;
	}) => {
		const decoded = decodeLiveFrame(encodeLiveFrame(frame));
		if (!decoded) throw new Error("bad frame");
		for (const l of [...listeners]) l(decoded);
	};
	/** The socket goes down or comes back (`silent`: no event, as for a socket down from the start). */
	const setConnected = (connected: boolean, silent = false) => {
		up = connected;
		if (!silent) for (const l of [...connection]) l(connected);
	};
	/** The last join sent for a page. */
	const joinOf = (pageId: string) =>
		[...sent]
			.reverse()
			.find((f) => f.kind === LIVE_FRAME.join && (f.head as { page?: string }).page === pageId);
	return { transport, sent, deliver, setConnected, joinOf };
}

const PAGE = "page-0000001";
const A = "block-aaaaaa1";
const B = "block-bbbbbb1";

function read(): SeedBlock[] {
	return [
		{ id: PAGE, parentId: null, sid: "p1", content: "Page", task: null, childIds: [A, B] },
		{ id: A, parentId: PAGE, sid: "a1", content: "Alpha", task: null, childIds: [] },
		{ id: B, parentId: PAGE, sid: "b1", content: "Bee", task: null, childIds: [] },
	];
}

/** The page's snapshot: A and B (or only those named) under the page. */
function joined(handle: number, head: Partial<LiveJoinedHead> = {}, ids: string[] = [A, B]) {
	const doc = new Y.Doc();
	const map = doc.getMap<Y.Text>("texts");
	const texts: Record<string, string> = { [PAGE]: "Page", [A]: "Alpha", [B]: "Bee" };
	const blocks: LiveBlockWire[] = [[PAGE, -1, "a0", "p1", ""]];
	map.set(PAGE, new Y.Text("Page"));
	ids.forEach((id, i) => {
		map.set(id, new Y.Text(texts[id] ?? ""));
		blocks.push([id, 0, `a${i}`, id === A ? "a1" : "b1", ""]);
	});
	const answer: LiveJoinedHead = {
		epoch: 7,
		mode: "reset",
		w: true,
		op: 0,
		tx: 0,
		me: 1,
		blocks,
		peers: [],
		...head,
	};
	return { kind: LIVE_FRAME.joined, handle, head: answer, body: Y.encodeStateAsUpdate(doc) };
}

const type = (client: LiveClient, id: string, md: string) =>
	client.commit({
		ops: [],
		bodies: [{ id, md }],
		kind: "typing",
		blockId: id,
		selBefore: null,
		selAfter: null,
		view: null,
	});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LIMIT = OUTLINE_LIVE_LIMITS.sessionsPerSocket;

afterEach(() => {
	setLiveSessionGraceForTests(null);
	setLiveSessionUnackedWaitForTests(null);
	clearUnsavedTextsForTests();
});

describe("the unsaved-text store", () => {
	const entry = (i: number, text = `text ${i}`) => ({
		pageId: PAGE,
		blockId: `block-${String(i).padStart(7, "0")}`,
		text,
		reason: "not_sent" as const,
	});

	test("at most 50 entries: the oldest go first, with a warning", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			for (let i = 0; i < UNSAVED_LIMITS.entries + 3; i++) keepUnsavedTexts([entry(i)]);
			const kept = unsavedTextsOf(PAGE);
			expect(kept).toHaveLength(UNSAVED_LIMITS.entries);
			expect(kept[0]?.text).toBe("text 3");
			expect(kept.at(-1)?.text).toBe(`text ${UNSAVED_LIMITS.entries + 2}`);
			expect(warn).toHaveBeenCalledTimes(3);
		} finally {
			warn.mockRestore();
		}
	});

	test("at most 256 KB of text: the oldest go first; the newest stays even alone over it", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const big = "x".repeat(100 * 1024);
			for (let i = 0; i < 3; i++) keepUnsavedTexts([entry(i, `${i}${big}`)]);
			expect(unsavedTextsOf(PAGE).map((e) => e.text[0])).toEqual(["1", "2"]);
			expect(warn).toHaveBeenCalledTimes(1);
			keepUnsavedTexts([entry(9, `9${"y".repeat(300 * 1024)}`)]);
			expect(unsavedTextsOf(PAGE).map((e) => e.text[0])).toEqual(["9"]);
		} finally {
			warn.mockRestore();
		}
	});

	test("texts pushed out are counted on their page until dismissed (review: silent eviction)", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			keepUnsavedTexts([
				{ pageId: "pageA", blockId: "blockA1xx", text: "a few words on A", reason: "not_sent" },
				{ pageId: "pageA", blockId: "blockA2xx", text: "more words on A", reason: "refused" },
			]);
			// A refused paste of 300 KB on page B: it alone is over the bytes limit.
			keepUnsavedTexts([
				{ pageId: "pageB", blockId: "blockB1xx", text: "x".repeat(300 * 1024), reason: "refused" },
			]);
			expect(unsavedTextsOf("pageA")).toEqual([]);
			expect(unsavedDroppedOf("pageA")).toBe(2);
			expect(unsavedDroppedOf("pageB")).toBe(0);
			// More than 50 on B: its own oldest go, counted on B.
			for (let i = 0; i < UNSAVED_LIMITS.entries; i++) keepUnsavedTexts([entry(i)]);
			expect(unsavedDroppedOf(PAGE)).toBe(0);
			expect(unsavedDroppedOf("pageB")).toBe(1);
			keepUnsavedTexts([entry(99)]);
			expect(unsavedDroppedOf(PAGE)).toBe(1);
			dismissUnsavedDropped("pageA");
			expect(unsavedDroppedOf("pageA")).toBe(0);
			expect(warn).toHaveBeenCalledTimes(4);
		} finally {
			warn.mockRestore();
		}
	});

	test("a newer entry of the same block and reason replaces the older one", () => {
		keepUnsavedTexts([entry(1, "first")]);
		keepUnsavedTexts([entry(1, "first and more")]);
		keepUnsavedTexts([{ ...entry(1, "refused"), reason: "refused" }]);
		expect(unsavedTextsOf(PAGE).map((e) => [e.text, e.reason])).toEqual([
			["first and more", "not_sent"],
			["refused", "refused"],
		]);
		expect(unsavedTextsOf("another-page")).toEqual([]);
	});
});

describe("typing that cannot reach the page outlives its session", () => {
	test("refused while typing, hidden, shown again: the text is still there (probe P2′)", async () => {
		const { transport, sent, deliver } = socket();
		const shared = acquireLiveSession(transport, PAGE, "edit");
		if (!shared) throw new Error("no session");
		retainLiveSession(shared);
		shared.client.seed(read());
		type(shared.client, B, "Bee typed then refused");
		deliver({
			kind: LIVE_FRAME.closed,
			handle: sent[0]?.handle as number,
			head: { code: "too_large" },
		});
		// The panel is hidden: its editor unmounts, the session is dropped.
		releaseLiveSession(shared);
		await sleep(20);
		expect(liveSessionsOn(transport)).toEqual([]);
		// Shown again: a new session, the same kept text.
		const again = acquireLiveSession(transport, PAGE, "edit");
		expect(again?.client).not.toBe(shared.client);
		expect(unsavedTextsOf(PAGE)).toMatchObject([
			{ blockId: B, text: "Bee typed then refused", reason: "refused" },
		]);
	});

	test("no longer allowed to write when the snapshot arrives, then hidden: the text is still there", async () => {
		const { transport, sent, deliver } = socket();
		const shared = acquireLiveSession(transport, PAGE, "edit");
		if (!shared) throw new Error("no session");
		retainLiveSession(shared);
		shared.client.seed(read());
		type(shared.client, B, "Bee typed, now read only");
		deliver(joined(sent[0]?.handle as number, { w: false }));
		expect(shared.client.ready).toBe(true);
		setLiveSessionGraceForTests(10);
		releaseLiveSession(shared);
		await sleep(40);
		expect(liveSessionsOn(transport)).toEqual([]);
		expect(unsavedTextsOf(PAGE)).toMatchObject([
			{ blockId: B, text: "Bee typed, now read only", reason: "read_only" },
		]);
	});

	test("refused a write while live (read only now): what was not taken is kept", () => {
		const { transport, sent, deliver } = socket();
		const client = new LiveClient(transport, PAGE, "edit");
		const handle = sent[0]?.handle as number;
		deliver(joined(handle));
		type(client, A, "Alpha typed");
		// A structural change with text: the typing before it goes first (sent, not acknowledged).
		client.commit({
			ops: [{ t: "k", id: B, task: " " }],
			bodies: [{ id: B, md: "Bee typed" }],
			kind: "struct",
			blockId: B,
			selBefore: null,
			selAfter: null,
			view: null,
		});
		expect(sent.map((f) => f.kind)).toEqual([LIVE_FRAME.join, LIVE_FRAME.update, LIVE_FRAME.tx]);
		const n = sent.at(-1)?.n as number;
		deliver({ kind: LIVE_FRAME.reject, handle, n, head: { code: "read_only" } });
		expect(client.editable).toBe(false);
		expect(
			unsavedTextsOf(PAGE)
				.map((e) => [e.blockId, e.text, e.reason])
				.sort(),
		).toEqual([
			[A, "Alpha typed", "read_only"],
			[B, "Bee typed", "read_only"],
		]);
	});

	test("a live session closed for good (access gone): what was not acknowledged is kept at once", () => {
		const { transport, sent, deliver } = socket();
		const client = new LiveClient(transport, PAGE, "edit");
		const handle = sent[0]?.handle as number;
		deliver(joined(handle));
		type(client, A, "Alpha typed, then the access went");
		deliver({ kind: LIVE_FRAME.closed, handle, head: { code: "access_denied" } });
		expect(client.status).toBe("closed");
		expect(client.pending).toEqual([]);
		expect(unsavedTextsOf(PAGE)).toMatchObject([
			{ blockId: A, text: "Alpha typed, then the access went", reason: "not_sent" },
		]);
	});

	test("disposed live: what was sent goes before the leave and is not kept; offline: kept", () => {
		const live = socket();
		const client = new LiveClient(live.transport, PAGE, "edit");
		live.deliver(joined(live.sent[0]?.handle as number));
		type(client, A, "Alpha typed");
		client.dispose();
		expect(live.sent.map((f) => f.kind)).toEqual([
			LIVE_FRAME.join,
			LIVE_FRAME.update,
			LIVE_FRAME.leave,
		]);
		expect(unsavedTextsOf(PAGE)).toEqual([]);
		const down = socket();
		const other = new LiveClient(down.transport, PAGE, "edit");
		down.deliver(joined(down.sent[0]?.handle as number));
		down.setConnected(false);
		type(other, B, "Bee typed offline");
		other.dispose();
		expect(unsavedTextsOf(PAGE)).toMatchObject([
			{ blockId: B, text: "Bee typed offline", reason: "not_sent" },
		]);
	});
});

describe("a session with typing not acknowledged", () => {
	test("is not dropped to make room for other pages; joins again and sends it (probe P5)", async () => {
		setLiveSessionGraceForTests(20);
		const s = socket();
		const shared = acquireLiveSession(s.transport, PAGE, "edit");
		if (!shared) throw new Error("no session");
		retainLiveSession(shared);
		shared.client.seed(read());
		type(shared.client, B, "typed while connecting, then offline");
		// The join is refused for now (a server limit): offline, it tries again later.
		s.deliver({
			kind: LIVE_FRAME.closed,
			handle: s.sent[0]?.handle as number,
			head: { code: "unavailable" },
		});
		releaseLiveSession(shared);
		const opened = [];
		for (let i = 0; i < LIMIT; i++) {
			const o = acquireLiveSession(s.transport, `page-other-${i}`, "edit");
			if (o) retainLiveSession(o);
			opened.push(o);
		}
		// Seven fit; the eighth is refused here (the tab-limit notice) rather than losing the text.
		expect(opened.filter(Boolean)).toHaveLength(LIMIT - 1);
		expect(liveSessionsOn(s.transport).some((x) => x.pageId === PAGE)).toBe(true);
		expect(unsavedTextsOf(PAGE)).toEqual([]);
		// It joins again (about a second later) and the merged text goes out.
		const end = Date.now() + 3_000;
		while (Date.now() < end && !shared.client.status.startsWith("connecting")) await sleep(20);
		const join = s.joinOf(PAGE);
		expect(join).toBeDefined();
		s.deliver(joined(join?.handle as number));
		const update = s.sent.at(-1);
		expect(update?.kind).toBe(LIVE_FRAME.update);
		await sleep(60);
		// Sent, not acknowledged: still there.
		expect(liveSessionsOn(s.transport).some((x) => x.pageId === PAGE)).toBe(true);
		s.deliver({ kind: LIVE_FRAME.batch, handle: join?.handle as number, n: update?.n as number });
		await sleep(60);
		expect(liveSessionsOn(s.transport).some((x) => x.pageId === PAGE)).toBe(false);
		expect(unsavedTextsOf(PAGE)).toEqual([]);
	}, 10_000);

	test("live, released, then the socket drops: it waits; past the wait the typing goes to the store", async () => {
		setLiveSessionGraceForTests(10);
		setLiveSessionUnackedWaitForTests(120);
		const s = socket();
		const shared = acquireLiveSession(s.transport, PAGE, "edit");
		if (!shared) throw new Error("no session");
		retainLiveSession(shared);
		s.deliver(joined(s.sent[0]?.handle as number));
		s.setConnected(false);
		type(shared.client, A, "Alpha typed offline");
		releaseLiveSession(shared);
		await sleep(50);
		// Past the grace period, not past the wait: kept, text inside the client.
		expect(liveSessionsOn(s.transport)).toHaveLength(1);
		expect(unsavedTextsOf(PAGE)).toEqual([]);
		// Making room skips it too.
		let opened = 0;
		for (let i = 0; i < LIMIT; i++) {
			const o = acquireLiveSession(s.transport, `o-${i}`, "edit");
			if (!o) continue;
			retainLiveSession(o);
			opened++;
		}
		expect(opened).toBe(LIMIT - 1);
		expect(liveSessionsOn(s.transport).some((x) => x.pageId === PAGE)).toBe(true);
		await sleep(150);
		expect(liveSessionsOn(s.transport).some((x) => x.pageId === PAGE)).toBe(false);
		expect(unsavedTextsOf(PAGE)).toMatchObject([
			{ blockId: A, text: "Alpha typed offline", reason: "not_sent" },
		]);
	});

	test("counted for the tab-limit notice, with when the first goes at the latest", async () => {
		setLiveSessionGraceForTests(10);
		const s = socket();
		const shared = acquireLiveSession(s.transport, PAGE, "edit");
		if (!shared) throw new Error("no session");
		retainLiveSession(shared);
		const handle = s.sent[0]?.handle as number;
		s.deliver(joined(handle));
		type(shared.client, A, "Alpha typed");
		await sleep(60);
		expect(liveSessionsWaitingOn(s.transport)).toEqual({ count: 0, freeBy: null });
		const released = Date.now();
		releaseLiveSession(shared);
		const waiting = liveSessionsWaitingOn(s.transport);
		expect(waiting.count).toBe(1);
		const freeBy = waiting.freeBy as number;
		expect(freeBy - released).toBeGreaterThanOrEqual(2 * 60_000 - 50);
		expect(freeBy - released).toBeLessThanOrEqual(2 * 60_000 + 50);
		// Acknowledged: no longer waiting, and it goes after the grace period.
		const update = s.sent.find((f) => f.kind === LIVE_FRAME.update);
		s.deliver({ kind: LIVE_FRAME.batch, handle, n: update?.n as number });
		expect(liveSessionsWaitingOn(s.transport)).toEqual({ count: 0, freeBy: null });
		await sleep(40);
		expect(liveSessionsOn(s.transport)).toEqual([]);
		expect(unsavedTextsOf(PAGE)).toEqual([]);
	});

	test("live, sent, never acknowledged (a dead connection): past the wait the text goes to the store", async () => {
		setLiveSessionGraceForTests(10);
		setLiveSessionUnackedWaitForTests(80);
		const s = socket();
		const dead = acquireLiveSession(s.transport, PAGE, "edit");
		const fine = acquireLiveSession(s.transport, "page-0000002", "edit");
		if (!dead || !fine) throw new Error("no session");
		retainLiveSession(dead);
		retainLiveSession(fine);
		const deadHandle = s.joinOf(PAGE)?.handle as number;
		const fineHandle = s.joinOf("page-0000002")?.handle as number;
		s.deliver(joined(deadHandle));
		const two = new Y.Doc();
		two.getMap<Y.Text>("texts").set("page-0000002", new Y.Text("Page two"));
		s.deliver({
			kind: LIVE_FRAME.joined,
			handle: fineHandle,
			head: { ...joined(fineHandle).head, blocks: [["page-0000002", -1, "a0", "p2", ""]] },
			body: Y.encodeStateAsUpdate(two),
		});
		type(dead.client, A, "Alpha sent into the void");
		type(fine.client, "page-0000002", "Page two typed");
		await sleep(60);
		// Both sent (the socket looks live); only the second page answers.
		const updates = s.sent.filter((f) => f.kind === LIVE_FRAME.update);
		expect(updates).toHaveLength(2);
		const fineUpdate = updates.find((f) => f.handle === fineHandle);
		s.deliver({ kind: LIVE_FRAME.batch, handle: fineHandle, n: fineUpdate?.n as number });
		releaseLiveSession(dead);
		releaseLiveSession(fine);
		await sleep(40);
		expect(liveSessionsOn(s.transport).map((x) => x.pageId)).toEqual([PAGE]);
		expect(dead.client.status).toBe("live");
		await sleep(120);
		expect(liveSessionsOn(s.transport)).toEqual([]);
		// Not counted as written: kept, as possibly not saved. The acknowledged one is not.
		expect(unsavedTextsOf(PAGE)).toMatchObject([
			{ blockId: A, text: "Alpha sent into the void", reason: "not_sent" },
		]);
		expect(unsavedTextsOf("page-0000002")).toEqual([]);
	});

	test("offline with typing on the read, never joined: at most the wait, then it goes to the store", async () => {
		setLiveSessionUnackedWaitForTests(60);
		const s = socket();
		s.setConnected(false, true);
		const shared = acquireLiveSession(s.transport, PAGE, "edit");
		if (!shared) throw new Error("no session");
		retainLiveSession(shared);
		shared.client.seed(read());
		type(shared.client, B, "typed on the read, offline");
		releaseLiveSession(shared);
		await sleep(20);
		expect(liveSessionsOn(s.transport)).toHaveLength(1);
		await sleep(80);
		expect(liveSessionsOn(s.transport)).toEqual([]);
		expect(unsavedTextsOf(PAGE)).toMatchObject([
			{ blockId: B, text: "typed on the read, offline", reason: "not_sent" },
		]);
	});
});

describe("text kept because its block is gone", () => {
	/** Seeded, typed into B, B gone from the snapshot: the kept entry. */
	function goneWhileConnecting() {
		const s = socket();
		const client = new LiveClient(s.transport, PAGE, "edit");
		client.seed(read());
		type(client, B, "Bee with my words");
		const handle = s.sent[0]?.handle as number;
		s.deliver(joined(handle, {}, [A]));
		const entry = unsavedTextsOf(PAGE)[0];
		if (!entry) throw new Error("nothing kept");
		return { ...s, client, handle, entry };
	}

	test("a later deletion notice does not replace it, nor does dismissing that notice remove it", () => {
		const { client, deliver, handle, entry } = goneWhileConnecting();
		expect(entry).toMatchObject({ blockId: B, reason: "moved_away" });
		client.cursorBlock = A;
		deliver({
			kind: LIVE_FRAME.batch,
			handle,
			n: 0,
			head: { c: [{ o: 1, by: 2, ops: [{ t: "d", id: A }] }] },
		});
		expect(client.deleted).toMatchObject({ blockId: A });
		expect(unsavedTextsOf(PAGE).map((e) => e.id)).toEqual([entry.id]);
		client.dismissDeleted();
		expect(unsavedTextsOf(PAGE).map((e) => e.id)).toEqual([entry.id]);
	});

	test("adding it back refused by the page: the entry stays (later acknowledgements too)", () => {
		const { client, deliver, handle, entry, sent } = goneWhileConnecting();
		expect(client.restoreUnsaved(entry)).toBe(true);
		const n = sent.at(-1)?.n as number;
		deliver({ kind: LIVE_FRAME.reject, handle, n, head: { code: "conflict" } });
		expect(unsavedTextsOf(PAGE).map((e) => e.id)).toEqual([entry.id]);
		// The client joins again after a refusal; the page answers, then acknowledges more.
		const join = sent.at(-1);
		expect(join?.kind).toBe(LIVE_FRAME.join);
		deliver(joined(join?.handle as number, { tx: n }, [A]));
		expect(client.status).toBe("live");
		client.commit({
			ops: [{ t: "k", id: A, task: " " }],
			bodies: [],
			kind: "struct",
			blockId: A,
			selBefore: null,
			selAfter: null,
			view: null,
		});
		const later = sent.at(-1)?.n as number;
		expect(later).toBeGreaterThan(n);
		deliver({ kind: LIVE_FRAME.batch, handle: join?.handle as number, n: later });
		expect(client.pending).toEqual([]);
		expect(unsavedTextsOf(PAGE).map((e) => e.id)).toEqual([entry.id]);
		// Added back again, and acknowledged this time: done.
		expect(client.restoreUnsaved(entry)).toBe(true);
		const again = sent.at(-1)?.n as number;
		deliver({
			kind: LIVE_FRAME.batch,
			handle: join?.handle as number,
			n: again,
			head: { a: [[again, 3]] },
		});
		expect(unsavedTextsOf(PAGE)).toEqual([]);
	});

	test("adding back sent, the session closed before the page answered: it may have been added", () => {
		const { client, entry } = goneWhileConnecting();
		expect(client.restoreUnsaved(entry)).toBe(true);
		expect(unsavedTextsOf(PAGE)[0]?.adding).toBe("sending");
		// Live: the insert went out before the leave; whether the page took it is not known.
		client.dispose();
		expect(unsavedTextsOf(PAGE)).toMatchObject([{ id: entry.id, adding: "unknown" }]);
	});

	test("adding back never sent, or refused: not added, offered again as before", () => {
		// The socket is gone before the insert could be sent (the client does not know yet).
		const late = goneWhileConnecting();
		late.setConnected(false, true);
		expect(late.client.restoreUnsaved(late.entry)).toBe(true);
		expect(late.sent.some((f) => f.kind === LIVE_FRAME.tx)).toBe(false);
		late.client.dispose();
		expect(unsavedTextsOf(PAGE)[0]?.adding).toBeUndefined();
		// Refused by the page: back to "add".
		clearUnsavedTextsForTests();
		const refused = goneWhileConnecting();
		expect(refused.client.restoreUnsaved(refused.entry)).toBe(true);
		const n = refused.sent.at(-1)?.n as number;
		refused.deliver({
			kind: LIVE_FRAME.reject,
			handle: refused.handle,
			n,
			head: { code: "conflict" },
		});
		expect(unsavedTextsOf(PAGE)[0]?.adding).toBeUndefined();
	});

	test("dismissed by the person: gone", () => {
		const { entry } = goneWhileConnecting();
		dropUnsavedText(entry.id);
		expect(unsavedTextsOf(PAGE)).toEqual([]);
	});
});

describe("restoring a deleted block", () => {
	test("an operation after the first that no longer fits: false, the notice stays, nothing sent", () => {
		const { transport, sent, deliver } = socket();
		const client = new LiveClient(transport, PAGE, "edit");
		deliver(joined(sent[0]?.handle as number));
		const notice = {
			blockId: "block-xxxxxx1",
			by: "",
			restore: [
				{ t: "i" as const, id: "block-xxxxxx1", p: PAGE, k: "a5", task: null, content: "X" },
				{
					t: "i" as const,
					id: "block-yyyyyy1",
					p: "block-gone0001",
					k: "a0",
					task: null,
					content: "Y",
				},
			],
		};
		client.deleted = notice;
		const before = sent.length;
		expect(client.restoreDeleted()).toBe(false);
		expect(client.deleted).toBe(notice);
		expect(sent.length).toBe(before);
		expect(client.visible.alive("block-xxxxxx1")).toBeUndefined();
		// Every operation fits (the second under the first): restored in one transaction.
		notice.restore[1] = { ...notice.restore[1], p: "block-xxxxxx1" } as (typeof notice.restore)[1];
		expect(client.restoreDeleted()).toBe(true);
		expect(client.deleted).toBeNull();
		expect(client.visible.children("block-xxxxxx1")).toEqual(["block-yyyyyy1"]);
		expect(sent.at(-1)?.kind).toBe(LIVE_FRAME.tx);
	});
});
