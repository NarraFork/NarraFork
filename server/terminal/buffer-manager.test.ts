import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getNarraforkPath } from "../lib/narrafork-home";
import { BufferManager } from "./buffer-manager";

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

	test("a physical-row cursor cannot be reused after horizontal reflow", async () => {
		const { buffer } = makeBuffer(() => {});
		buffer.append(`${"x".repeat(90)} READY`);
		const point = await buffer.markReadCursor();
		if (!point) throw new Error("missing observation");
		await buffer.resize(160, 24);
		expect(buffer.cloneReadCursor(point)).toBeUndefined();
		const fresh = await buffer.markReadCursor();
		if (!fresh) throw new Error("missing fresh observation");
		expect(fresh.columns).toBe(160);
		expect(fresh.layoutRevision).toBeGreaterThan(point.layoutRevision);
		await buffer.resize(80, 24);
		expect(buffer.cols).toBe(point.columns);
		expect(buffer.cloneReadCursor(point)).toBeUndefined();
		expect(buffer.layoutRevision).toBeGreaterThan(fresh.layoutRevision);
		fresh.marker.dispose();
		point.marker.dispose();
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
