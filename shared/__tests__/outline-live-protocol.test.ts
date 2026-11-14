import { describe, expect, test } from "bun:test";
import {
	decodeLiveFrame,
	decodeLiveTexts,
	encodeLiveFrame,
	encodeLiveHead,
	encodeLiveTexts,
	isLiveFrame,
	isLiveHandle,
	isLiveTaskChar,
	LIVE_FRAME,
	LIVE_PEER_PALETTE,
	LIVE_STATUS_OF_TASK,
	LIVE_TASK_OF_STATUS,
	LIVE_TEXT_KIND,
	type LiveRejectHead,
	livePeerColor,
	OUTLINE_LIVE_AGENT_PNO_BASE,
	OUTLINE_LIVE_LIMITS,
	OUTLINE_LIVE_MAGIC,
	OUTLINE_LIVE_MAX_HANDLE,
	OUTLINE_LIVE_PROTOCOL_VERSION,
} from "../outline-live-protocol";

describe("live frames", () => {
	test("encode and decode round trip, body as a view", () => {
		const body = new Uint8Array([1, 2, 3, 250]);
		const bytes = encodeLiveFrame({
			kind: LIVE_FRAME.update,
			handle: 200,
			n: 2 ** 40,
			head: { a: [1, "x"] },
			body,
		});
		expect(bytes[0]).toBe(OUTLINE_LIVE_MAGIC);
		expect(isLiveFrame(bytes)).toBe(true);
		const frame = decodeLiveFrame(bytes);
		expect(frame).toMatchObject({
			kind: LIVE_FRAME.update,
			handle: 200,
			n: 2 ** 40,
			head: { a: [1, "x"] },
		});
		expect([...(frame?.body ?? [])]).toEqual([1, 2, 3, 250]);
	});

	test("a frame without head or body is a few bytes", () => {
		const bytes = encodeLiveFrame({ kind: LIVE_FRAME.leave, handle: 1 });
		expect(bytes.length).toBe(5);
		expect(decodeLiveFrame(bytes)).toMatchObject({
			kind: LIVE_FRAME.leave,
			handle: 1,
			n: 0,
			head: null,
		});
	});

	test("malformed frames decode to null", () => {
		const good = encodeLiveFrame({ kind: LIVE_FRAME.tx, handle: 1, n: 1, head: { ops: [] } });
		expect(decodeLiveFrame(new Uint8Array([0x7b, 0x22]))).toBeNull();
		expect(decodeLiveFrame(good.subarray(0, 4))).toBeNull();
		const badJson = good.slice();
		badJson[badJson.length - 1] = 0x7b;
		expect(decodeLiveFrame(badJson)).toBeNull();
		expect(
			decodeLiveFrame(
				new Uint8Array([OUTLINE_LIVE_MAGIC, 1, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
			),
		).toBeNull();
		expect(() => encodeLiveFrame({ kind: 1, handle: -1 })).toThrow();
	});

	test("handles stay in the range a reply can carry", () => {
		expect(() =>
			encodeLiveFrame({ kind: LIVE_FRAME.join, handle: OUTLINE_LIVE_MAX_HANDLE + 1 }),
		).toThrow();
		const ok = encodeLiveFrame({ kind: LIVE_FRAME.join, handle: OUTLINE_LIVE_MAX_HANDLE });
		expect(decodeLiveFrame(ok)?.handle).toBe(OUTLINE_LIVE_MAX_HANDLE);
		// A larger handle written by hand (varuint 70000) does not decode.
		const forged = new Uint8Array([OUTLINE_LIVE_MAGIC, LIVE_FRAME.join, 0xf0, 0xa2, 0x04, 0, 0]);
		expect(decodeLiveFrame(forged)).toBeNull();
		expect(isLiveHandle(0)).toBe(true);
		expect(isLiveHandle(1.5)).toBe(false);
	});

	test("a head serialized once is the same frame", () => {
		const head = { peers: [[1, "u", "n", "#000", "e"]] };
		const a = encodeLiveFrame({ kind: LIVE_FRAME.presence, handle: 7, head });
		const b = encodeLiveFrame({
			kind: LIVE_FRAME.presence,
			handle: 7,
			rawHead: encodeLiveHead(head),
		});
		expect([...b]).toEqual([...a]);
	});

	test("head limits by direction: a client frame's head is small, a snapshot's may be large", () => {
		const big = { blocks: "x".repeat(OUTLINE_LIVE_LIMITS.maxHeadBytes + 10) };
		const fromClient = encodeLiveFrame({ kind: LIVE_FRAME.join, handle: 1, head: big });
		const fromServer = encodeLiveFrame({ kind: LIVE_FRAME.joined, handle: 1, head: big });
		expect(decodeLiveFrame(fromClient)).toBeNull();
		expect(decodeLiveFrame(fromServer)?.head).toEqual(big);
		// The server reads every frame with the client limit.
		expect(decodeLiveFrame(fromServer, OUTLINE_LIVE_LIMITS.maxHeadBytes)).toBeNull();
	});

	test("a refusal can say who is doing the task; a client reading only the code is unaffected", () => {
		const head: LiveRejectHead = {
			code: "conflict",
			claimed: {
				address: "K1/abc",
				holder: { kind: "agent", id: "narrator-1", name: "Fix the login" },
			},
		};
		const bytes = encodeLiveFrame({ kind: LIVE_FRAME.reject, handle: 3, n: 7, head });
		const frame = decodeLiveFrame(bytes);
		expect(frame?.kind).toBe(LIVE_FRAME.reject);
		expect(frame?.head).toEqual(head);
		// What a client of the first version did with it: read `code`, nothing else.
		expect((frame?.head as { code: string }).code).toBe("conflict");
		// And a refusal without the field is as before.
		const plain = decodeLiveFrame(
			encodeLiveFrame({ kind: LIVE_FRAME.reject, handle: 3, n: 8, head: { code: "failed" } }),
		);
		expect(plain?.head).toEqual({ code: "failed" });
	});

	test("task characters and statuses map both ways", () => {
		for (const [status, char] of Object.entries(LIVE_TASK_OF_STATUS)) {
			expect(LIVE_STATUS_OF_TASK[char]).toBe(status as never);
			expect(isLiveTaskChar(char)).toBe(true);
		}
		expect(isLiveTaskChar("?")).toBe(false);
	});
});

describe("agents in presence (P2 PR 10b)", () => {
	test("an id's palette colour is stable, and agents number apart from people", () => {
		expect(livePeerColor("abc")).toBe(livePeerColor("abc"));
		expect(LIVE_PEER_PALETTE as readonly string[]).toContain(livePeerColor("some-narrator-id"));
		expect(OUTLINE_LIVE_AGENT_PNO_BASE).toBeGreaterThan(
			OUTLINE_LIVE_LIMITS.editorsPerPage + OUTLINE_LIVE_LIMITS.viewersPerPage,
		);
	});
});

describe("text entries (protocol version 2)", () => {
	test("entries round trip in order, payloads as views; an empty body is no entries", () => {
		const entries = [
			{ id: "block-0001", kind: LIVE_TEXT_KIND.seed, data: new TextEncoder().encode("大纲 text") },
			{ id: "block-0002", kind: LIVE_TEXT_KIND.update, data: new Uint8Array(300).fill(7) },
			{ id: "块", kind: LIVE_TEXT_KIND.vector, data: new Uint8Array(0) },
			{ id: "block-0001", kind: LIVE_TEXT_KIND.update, data: new Uint8Array([0, 0]) },
		];
		const body = encodeLiveTexts(entries);
		const back = decodeLiveTexts(body);
		expect(back?.map((e) => [e.id, e.kind, [...e.data]])).toEqual(
			entries.map((e) => [e.id, e.kind, [...e.data]]),
		);
		expect(back?.[1]?.data.buffer).toBe(body.buffer);
		expect(encodeLiveTexts([])).toHaveLength(0);
		expect(decodeLiveTexts(new Uint8Array(0))).toEqual([]);
		// Carried as a frame's body unchanged.
		const frame = decodeLiveFrame(
			encodeLiveFrame({ kind: LIVE_FRAME.update, handle: 1, n: 3, body }),
		);
		expect(decodeLiveTexts(frame?.body as Uint8Array)).toHaveLength(4);
	});

	test("malformed bodies do not decode: truncated, unknown kind, bad id, too many entries", () => {
		const body = encodeLiveTexts([
			{ id: "block-0001", kind: LIVE_TEXT_KIND.update, data: new Uint8Array([1, 2, 3]) },
			{ id: "block-0002", kind: LIVE_TEXT_KIND.update, data: new Uint8Array([4]) },
		]);
		for (let cut = 1; cut < body.length; cut++) {
			// A cut at an entry boundary is a shorter list; anywhere else it is malformed.
			const decoded = decodeLiveTexts(body.subarray(0, cut));
			if (decoded !== null) expect(decoded).toHaveLength(1);
		}
		const kind = body.slice();
		kind[1 + "block-0001".length] = 9;
		expect(decodeLiveTexts(kind)).toBeNull();
		expect(decodeLiveTexts(new Uint8Array([0, LIVE_TEXT_KIND.update, 0]))).toBeNull();
		expect(decodeLiveTexts(new Uint8Array([2, 0xff, 0xfe, LIVE_TEXT_KIND.update, 0]))).toBeNull();
		const long = encodeLiveTexts([
			{
				id: "x".repeat(OUTLINE_LIVE_LIMITS.maxTextIdBytes + 1),
				kind: LIVE_TEXT_KIND.update,
				data: new Uint8Array(0),
			},
		]);
		expect(decodeLiveTexts(long)).toBeNull();
		expect(decodeLiveTexts(body, 1)).toBeNull();
		expect(decodeLiveTexts(body, 2)).toHaveLength(2);
		expect(OUTLINE_LIVE_PROTOCOL_VERSION).toBe(2);
	});
});
