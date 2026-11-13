import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getNarraforkPath } from "../lib/narrafork-home";
import {
	BufferManager,
	MAX_BUFFER_READ_CURSORS,
	MAX_CURSOR_PENDING_FRAMES,
	MAX_LAYOUT_SCAN_CELLS,
	MAX_LAYOUT_SNAPSHOT_BYTES,
	MAX_LAYOUT_VIEW_CHARACTERS,
} from "./buffer-manager";

/**
 * The headless buffer is the single responder to terminal queries.
 *
 * Programs such as atuin (inline search UI), codex CLI and nushell/reedline ask
 * the terminal `CSI 6n` and block until the `CSI <row>;<col> R` reply arrives.
 * Nothing else in NarraFork answers it — the browser side deliberately drops
 * xterm.js's own reply to avoid a duplicate — so if this responder goes silent
 * those programs stall until their own timeout and report
 * "The cursor position could not be read within a normal duration".
 *
 * Equally important is the negative side: a restored snapshot is history, and
 * answering a query embedded in it would push stray bytes into the shell's
 * input. Both directions are asserted here.
 */

const buffersDir = getNarraforkPath("buffers");

const created: BufferManager[] = [];

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("missing cursor");
	return value;
}

function makeBuffer(onReply: (data: string) => void): {
	buffer: BufferManager;
	terminalId: string;
} {
	const terminalId = `test-${crypto.randomUUID()}`;
	const buffer = new BufferManager(terminalId, 80, 24, { onReply });
	created.push(buffer);
	return { buffer, terminalId };
}

afterEach(async () => {
	await Promise.all(created.splice(0).map((buffer) => buffer.dispose(true)));
});

describe("BufferManager parser replies", () => {
	test("answers DSR/CPR (CSI 6n) with the real cursor position", async () => {
		const replies: string[] = [];
		const { buffer } = makeBuffer((data) => replies.push(data));

		// Two lines, cursor after "def": row 2, column 4 — both 1-based in a CPR.
		buffer.append("abc\r\ndef");
		buffer.append("\x1b[6n");
		await buffer.flush();

		expect(replies).toEqual(["\x1b[2;4R"]);
	});

	test("answers DA1 (CSI c)", async () => {
		const replies: string[] = [];
		const { buffer } = makeBuffer((data) => replies.push(data));

		buffer.append("\x1b[c");
		await buffer.flush();

		// Exact capability string varies with the xterm build; the shape does not.
		expect(replies).toHaveLength(1);
		expect(replies[0].startsWith("\x1b[?")).toBe(true);
		expect(replies[0].endsWith("c")).toBe(true);
	});

	test("stays silent while replaying a saved snapshot", async () => {
		const replies: string[] = [];
		const { buffer, terminalId } = makeBuffer((data) => replies.push(data));

		// A snapshot is history: whatever it contains was already answered when
		// it was live, so replaying it must not answer again.
		const serialized = "history\x1b[6nmore";
		await mkdir(buffersDir, { recursive: true });
		await writeFile(
			join(buffersDir, `${terminalId}.buf`),
			JSON.stringify({
				version: 3,
				serialized: Buffer.from(serialized).toString("base64"),
				cols: 80,
				rows: 24,
				mouseMode: { x10: false, buttonEvent: false, anyEvent: false, sgr: false },
			}),
		);

		expect(await buffer.loadFromDisk()).toBe(true);
		await buffer.flush();

		expect(replies).toEqual([]);
	});

	test("answers a live query after a muted snapshot", async () => {
		const replies: string[] = [];
		const { buffer, terminalId } = makeBuffer((data) => replies.push(data));

		await mkdir(buffersDir, { recursive: true });
		await writeFile(
			join(buffersDir, `${terminalId}.buf`),
			JSON.stringify({
				version: 3,
				serialized: Buffer.from("\x1b[6n").toString("base64"),
				cols: 80,
				rows: 24,
				mouseMode: { x10: false, buttonEvent: false, anyEvent: false, sgr: false },
			}),
		);

		expect(await buffer.loadFromDisk()).toBe(true);
		buffer.append("ab");
		buffer.append("\x1b[6n");
		await buffer.flush();

		expect(replies).toEqual(["\x1b[1;3R"]);
	});

	test("stays silent after dispose", async () => {
		const replies: string[] = [];
		const { buffer } = makeBuffer((data) => replies.push(data));

		await buffer.dispose(true);
		created.length = 0;

		buffer.append("\x1b[6n");
		await buffer.flush();

		expect(replies).toEqual([]);
	});
});

describe("BufferManager tool observation cursors", () => {
	test("serialization and its frontier precede output parsed before the response returns", async () => {
		const { buffer } = makeBuffer(() => {});
		buffer.append("$ ");
		let point: import("./buffer-manager").BufferReadCursor | undefined;
		const contents = await buffer.getContents((cursor, sequence) => {
			point = cursor;
			expect(cursor?.sequence).toBe(sequence);
			buffer.append("READY\r\n$ ");
		});
		expect(contents).not.toContain("READY");
		if (!point) throw new Error("missing observation");
		const clone = buffer.cloneReadCursor(point);
		if (!clone) throw new Error("missing clone");
		const { text } = await buffer.readFromMarker(clone.marker);
		expect(text.indexOf("READY", clone.offset)).toBeGreaterThanOrEqual(0);
		expect(clone.textBefore).toBe(point.textBefore);
		clone.marker.dispose();
		expect(point.marker.isDisposed).toBe(false);
		const second = buffer.cloneReadCursor(point);
		if (!second) throw new Error("second clone missing");
		point.marker.dispose();
		expect(second.marker.isDisposed).toBe(false);
		second.marker.dispose();
	});

	test("clones never accept a cursor from another buffer", async () => {
		const { buffer: first } = makeBuffer(() => {});
		const { buffer: second } = makeBuffer(() => {});
		const point = await first.markReadCursor();
		if (!point) throw new Error("missing observation");
		expect(second.cloneReadCursor(point)).toBeUndefined();
		expect(point.marker.isDisposed).toBe(false);
		point.marker.dispose();
	});

	test("a naturally trimmed frontier starts at retained output rather than at now", async () => {
		const { buffer } = makeBuffer(() => {});
		const point = await buffer.markReadCursor();
		if (!point) throw new Error("missing observation");
		buffer.append(`${"working\r\n".repeat(5030)}READY\r\n$ `);
		await buffer.flush();
		expect(point.marker.isDisposed).toBe(true);
		const clone = buffer.cloneReadCursor(point);
		if (!clone) throw new Error("missing trimmed clone");
		expect(clone.offset).toBe(0);
		expect(clone.textBefore).toBe("");
		expect((await buffer.readFromMarker(clone.marker)).text).toContain("READY");
		clone.marker.dispose();
	});

	test("alternate screen and disposed buffers cannot create watch cursors", async () => {
		const { buffer } = makeBuffer(() => {});
		const point = await buffer.markReadCursor();
		if (!point) throw new Error("missing observation");
		buffer.append("\x1b[?1049h");
		await buffer.flush();
		expect(await buffer.markReadCursor()).toBeUndefined();
		expect(buffer.cloneReadCursor(point)).toBeUndefined();
		await buffer.dispose(true);
		expect(buffer.cloneReadCursor(point)).toBeUndefined();
	});

	test("reflow preserves old output and independent clone checkpoints through width ABA", async () => {
		const { buffer } = makeBuffer(() => {});
		buffer.append(`${"x".repeat(90)} `);
		const point = await buffer.markReadCursor();
		if (!point) throw new Error("missing observation");
		const initial = point.textBefore;
		buffer.append("READY");
		await buffer.resize(160, 24);
		const revision = point.layoutRevision;
		expect(point.columns).toBe(160);
		const clone = buffer.cloneReadCursor(point);
		if (!clone) throw new Error("missing clone");
		const cloned = await buffer.readCursor(clone);
		expect(cloned.map((frame) => frame.kind)).toEqual(["snapshot", "baseline", "snapshot"]);
		expect(cloned[0]).toMatchObject({ text: `${initial}READY`, markerLost: false });
		expect(cloned[1].kind !== "error" && cloned[1].text).toBe(
			`${"x".repeat(80)}${" ".repeat(80)}${"x".repeat(10)} READY`,
		);
		await buffer.resize(80, 24);
		expect(point.columns).toBe(80);
		expect(point.layoutRevision).toBeGreaterThan(revision);
		expect(point.textBefore).toBe(initial);
		expect(point.offset).toBe(initial.length);
		expect((await buffer.readCursor(point)).map((frame) => frame.kind)).toEqual([
			"snapshot",
			"baseline",
			"snapshot",
			"baseline",
			"snapshot",
		]);
		expect((await buffer.readCursor(clone)).map((frame) => frame.kind)).toEqual([
			"snapshot",
			"baseline",
			"snapshot",
		]);
	});

	test("the observed tail marker follows inserted rows and clone disposal is independent", async () => {
		const { buffer } = makeBuffer(() => {});
		buffer.append("first row\r\nold READY\x1b[1A");
		const point = await buffer.markReadCursor();
		if (!point?.observedEndMarker) throw new Error("missing point boundary");
		expect(point.observedEndMarker).not.toBe(point.marker);
		const clone = buffer.cloneReadCursor(point);
		if (!clone?.observedEndMarker) throw new Error("missing cloned boundary");
		point.dispose();
		expect(buffer.cloneReadCursor(point)).toBeUndefined();
		expect(clone.marker.isDisposed).toBe(false);
		expect(clone.observedEndMarker.isDisposed).toBe(false);
		buffer.append("\x1b[2;1H\x1b[L");
		const moved = await buffer.readFromMarker(clone.marker, clone.observedEndMarker);
		expect(moved.observedPrefixEnd).toBeDefined();
		expect(moved.text.slice(0, moved.observedPrefixEnd)).toContain("old READY");
		clone.dispose();
		expect(clone.marker.isDisposed).toBe(true);
		expect(clone.observedEndMarker.isDisposed).toBe(true);
	});

	test("baseline retains earlier history and old content below the cursor", async () => {
		const { buffer } = makeBuffer(() => {});
		await buffer.resize(20, 6);
		buffer.append(`earlier history\r\n${"x".repeat(25)}RE\r\nold READY\x1b[1A`);
		const point = await buffer.markReadCursor();
		if (!point) throw new Error("missing point");
		await buffer.resize(30, 6);
		const frames = await buffer.readCursor(point);
		expect(frames[1].kind).toBe("baseline");
		expect(frames[1].kind !== "error" && frames[1].text).toBe(
			`earlier history\n${"x".repeat(20)}${" ".repeat(10)}xxxxxRE\nold READY`,
		);
		buffer.append("ADY");
		const [snapshot] = await buffer.readCursor(point);
		expect(snapshot.kind).toBe("snapshot");
	});

	test("partial logical line survives resize and new baseline excludes historical text", async () => {
		const { buffer } = makeBuffer(() => {});
		buffer.append("x".repeat(90));
		const point = await buffer.markReadCursor();
		if (!point) throw new Error("missing point");
		buffer.append("RE");
		await buffer.resize(160, 24);
		const frames = await buffer.readCursor(point);
		expect(frames[0]).toMatchObject({ kind: "snapshot", text: `${"x".repeat(10)}RE` });
		expect(frames[1].kind).toBe("baseline");
		expect(frames[1].kind !== "error" && frames[1].text).toBe(
			`${"x".repeat(80)}${" ".repeat(80)}${"x".repeat(10)}RE`,
		);
		buffer.append("ADY");
		const [next] = await buffer.readCursor(point);
		expect(next).toMatchObject({
			kind: "snapshot",
			text: `${"x".repeat(80)}${" ".repeat(80)}${"x".repeat(10)}READY`,
		});
	});

	test("resize baseline preserves a multiline partial before the cursor while excluding historical matches", async () => {
		const { buffer } = makeBuffer(() => {});
		buffer.append("historical RE\r\nADY\r\n");
		const point = required(await buffer.markReadCursor());
		buffer.append("RE\r\n");
		await buffer.resize(100, 24);
		const frames = await buffer.readCursor(point);
		expect(frames[0]).toMatchObject({ kind: "snapshot", text: "RE" });
		const baseline = frames[1];
		if (baseline.kind !== "baseline") throw new Error("missing resize baseline");
		expect(baseline.text).toBe("historical RE\nADY\nRE");
		expect(point.marker.line).toBe(0);
		const historicalMatches = [...baseline.text.matchAll(/RE\nADY/g)].length;
		expect(historicalMatches).toBe(1);
		buffer.append("ADY");
		const [snapshot] = await buffer.readCursor(point);
		if (snapshot.kind !== "snapshot") throw new Error("missing current snapshot");
		expect(snapshot.markerLost).toBe(false);
		expect(snapshot.text).toBe("historical RE\nADY\nRE\nADY");
		expect([...snapshot.text.matchAll(/RE\nADY/g)].length - historicalMatches).toBe(1);
	});

	test("a trimmed clone preserves initial baseline but explicitly resets its snapshot frontier", async () => {
		const { buffer } = makeBuffer(() => {});
		buffer.append("old baseline");
		const point = required(await buffer.markReadCursor());
		buffer.append(`${"\r\nworking".repeat(5030)}\r\nREADY`);
		await buffer.flush();
		const clone = required(buffer.cloneReadCursor(point));
		expect(clone.textBefore).toBe("old baseline");
		expect(clone.offset).toBe(12);
		const frame = (await buffer.readCursor(clone))[0];
		expect(frame).toMatchObject({ kind: "snapshot", markerLost: true, observedPrefixEnd: 0 });
		expect(frame.kind !== "error" && frame.text).toContain("READY");
	});

	test("current reads share one cached scan and invalidate on parsed writes and resize", async () => {
		const { buffer } = makeBuffer(() => {});
		const point = required(await buffer.markReadCursor());
		const other = required(buffer.cloneReadCursor(point));
		const internal = buffer as unknown as { currentReadView: unknown };
		await buffer.readCursor(point);
		const initialView = internal.currentReadView;
		expect(initialView).toBeDefined();
		await buffer.readCursor(other);
		expect(internal.currentReadView).toBe(initialView);
		buffer.append("READY");
		expect(internal.currentReadView).toBeUndefined();
		await buffer.readCursor(point);
		expect(internal.currentReadView).not.toBe(initialView);
		await buffer.resize(81, 24);
		expect(internal.currentReadView).toBeUndefined();
		point.dispose();
		other.dispose();
	});

	test("cursor count, ownership and disposal are bounded", async () => {
		const { buffer } = makeBuffer(() => {});
		const points = [];
		for (let i = 0; i < MAX_BUFFER_READ_CURSORS; i++)
			points.push(required(await buffer.markReadCursor()));
		expect(await buffer.markReadCursor()).toBeUndefined();
		expect(buffer.cloneReadCursor(points[0])).toBeUndefined();
		points[0].dispose();
		expect((await buffer.readCursor(points[0]))[0].kind).toBe("error");
		expect(await buffer.markReadCursor()).toBeDefined();
		const { buffer: other } = makeBuffer(() => {});
		expect((await other.readCursor(points[1]))[0].kind).toBe("error");
		await buffer.dispose(true);
		expect(points.every((point) => point.marker.isDisposed)).toBe(true);
	});

	test("frame overflow retains real old output before an explicit persistent error", async () => {
		const { buffer } = makeBuffer(() => {});
		const point = required(await buffer.markReadCursor());
		buffer.append("READY");
		for (let i = 0; i <= MAX_CURSOR_PENDING_FRAMES / 2; i++)
			await buffer.resize(i % 2 ? 80 : 81, 24);
		const frames = await buffer.readCursor(point);
		expect(frames).toHaveLength(MAX_CURSOR_PENDING_FRAMES + 1);
		expect(frames[0]).toMatchObject({ kind: "snapshot", text: "READY" });
		expect(frames.at(-1)).toMatchObject({
			kind: "error",
			message: expect.stringContaining("frame budget"),
		});
		expect((await buffer.readCursor(point))[0].kind).toBe("error");
	});

	test("many cursors share byte ownership and disposal releases the shared budget", async () => {
		const { buffer } = makeBuffer(() => {});
		buffer.append("x".repeat(100_000));
		const points = [];
		for (let i = 0; i < 40; i++) points.push(required(await buffer.markReadCursor()));
		await buffer.resize(81, 24);
		for (const point of points)
			expect((await buffer.readCursor(point)).at(-1)?.kind).toBe("snapshot");
		const internal = buffer as unknown as { layoutSnapshotBytes: number };
		expect(internal.layoutSnapshotBytes).toBeGreaterThan(0);
		expect(internal.layoutSnapshotBytes).toBeLessThan(MAX_LAYOUT_SNAPSHOT_BYTES);
		await buffer.resize(80, 24);
		const clone = required(buffer.cloneReadCursor(points[0]));
		const shared = internal.layoutSnapshotBytes;
		expect(shared).toBeGreaterThan(0);
		expect(shared).toBeLessThan(MAX_LAYOUT_SNAPSHOT_BYTES);
		for (const point of points) point.dispose();
		expect(internal.layoutSnapshotBytes).toBe(shared);
		clone.dispose();
		expect(internal.layoutSnapshotBytes).toBe(0);
	});

	test("shared byte overflow is explicit without preventing resize", async () => {
		const { buffer } = makeBuffer(() => {});
		buffer.append("x".repeat(180_000));
		const point = required(await buffer.markReadCursor());
		for (let i = 0; i < 10; i++) await buffer.resize(i % 2 ? 80 : 81, 24);
		const frames = await buffer.readCursor(point);
		expect(frames.at(-1)).toMatchObject({
			kind: "error",
			message: expect.stringContaining("byte budget"),
		});
		expect(buffer.cols).toBe(80);
	});

	test("view character overflow is explicit", async () => {
		const { buffer } = makeBuffer(() => {});
		const point = required(await buffer.markReadCursor());
		buffer.append("x".repeat(MAX_LAYOUT_VIEW_CHARACTERS + 1));
		await buffer.resize(81, 24);
		expect((await buffer.readCursor(point)).at(-1)).toMatchObject({
			kind: "error",
			message: expect.stringContaining("character budget"),
		});
		expect(buffer.cols).toBe(81);
	});

	test("combined resize cell scan budget fails explicitly after retained old snapshot", async () => {
		const { buffer } = makeBuffer(() => {});
		const point = required(await buffer.markReadCursor());
		buffer.append("READY");
		const columns = Math.floor(MAX_LAYOUT_SCAN_CELLS / 24) + 1;
		await buffer.resize(columns, 24);
		const frames = await buffer.readCursor(point);
		expect(frames[0]).toMatchObject({ kind: "snapshot", text: "READY" });
		expect(frames.at(-1)).toMatchObject({
			kind: "error",
			message: expect.stringContaining("scan budget"),
		});
		expect(buffer.cols).toBe(columns);
	});

	test("a throwing observer does not leak its candidate marker", async () => {
		const { buffer } = makeBuffer(() => {});
		let point: import("./buffer-manager").BufferReadCursor | undefined;
		await expect(
			buffer.getContents((cursor) => {
				point = cursor;
				throw new Error("observer failed");
			}),
		).rejects.toThrow("observer failed");
		expect(point?.marker.isDisposed).toBe(true);
	});
});
