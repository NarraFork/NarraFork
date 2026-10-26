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
