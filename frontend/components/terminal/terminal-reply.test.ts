import { describe, expect, test } from "bun:test";
import { Terminal } from "@xterm/headless";
import { isHeadlessTerminalReply } from "./terminal-reply";

async function headlessReplies(query: string): Promise<string[]> {
	const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
	const replies: string[] = [];
	term.onData((data) => replies.push(data));
	await new Promise<void>((resolve) => term.write(query, resolve));
	term.dispose();
	return replies;
}

describe("isHeadlessTerminalReply", () => {
	test("matches the reports the headless buffer emits", () => {
		expect(isHeadlessTerminalReply("\x1b[2;4R")).toBe(true);
		expect(isHeadlessTerminalReply("\x1b[?2;4R")).toBe(true);
		expect(isHeadlessTerminalReply("\x1b[0n")).toBe(true);
		expect(isHeadlessTerminalReply("\x1b[?1;2c")).toBe(true);
		expect(isHeadlessTerminalReply("\x1b[>0;276;0c")).toBe(true);
		expect(isHeadlessTerminalReply("\x1b[4;2$y")).toBe(true);
		expect(isHeadlessTerminalReply("\x1b[?25;1$y")).toBe(true);
		expect(isHeadlessTerminalReply("\x1bP1$r1;24r\x1b\\")).toBe(true);
	});

	test("matches the replies headless xterm actually emits", async () => {
		const queries = [
			"\x1b[6n",
			"\x1b[?6n",
			"\x1b[5n",
			"\x1b[c",
			"\x1b[>c",
			"\x1b[4$p",
			"\x1b[?25$p",
			"\x1bP$qr\x1b\\",
			"\x1bP$qZ\x1b\\",
		];
		for (const query of queries) {
			const replies = await headlessReplies(query);
			expect(replies.length).toBeGreaterThan(0);
			for (const reply of replies) {
				expect(isHeadlessTerminalReply(reply)).toBe(true);
			}
		}
	});

	test("keeps keystrokes, focus, and OSC color replies", () => {
		expect(isHeadlessTerminalReply("a")).toBe(false);
		expect(isHeadlessTerminalReply("\x1b[A")).toBe(false);
		expect(isHeadlessTerminalReply("\x1b[1;5C")).toBe(false);
		expect(isHeadlessTerminalReply("\x1b[15~")).toBe(false);
		expect(isHeadlessTerminalReply("\x1b[82;5u")).toBe(false);
		expect(isHeadlessTerminalReply("\x1b[I")).toBe(false);
		expect(isHeadlessTerminalReply("\x1b[O")).toBe(false);
		expect(isHeadlessTerminalReply("\x1b]11;rgb:0000/0000/0000\x1b\\")).toBe(false);
		expect(isHeadlessTerminalReply("")).toBe(false);
	});
});
