/**
 * The stash storage layer.
 *
 * Two properties carry the whole design and are tested hardest:
 *   - taking an entry CONSUMES it, while peeking does not (a dry run that consumed the
 *     handle would make the first real write always fail);
 *   - entries are reclaimed without help, because a narrator that was interrupted between
 *     two tool calls never gets to release anything.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
	dropStash,
	formatStashSize,
	locateStashRange,
	MAX_STASH_BYTES,
	MAX_STASH_ENTRIES_PER_NARRATOR,
	peekStash,
	putStash,
	resetStash,
	STASH_TTL_MS,
	StashTooLargeError,
	setStashClock,
	takeStash,
} from "../stash";

beforeEach(() => {
	resetStash();
});

function put(overrides: Partial<Parameters<typeof putStash>[0]> = {}) {
	return putStash({
		narratorId: "n1",
		text: "line1\nline2",
		filePath: "src.ts",
		startLine: 10,
		endLine: 11,
		...overrides,
	});
}

describe("put and read", () => {
	test("returns a handle and the range's own metadata", () => {
		const entry = put();
		expect(entry.handle).toMatch(/^stash_\w{8}$/);
		expect(entry.filePath).toBe("src.ts");
		expect(entry.startLine).toBe(10);
		expect(entry.endLine).toBe(11);
		expect(entry.lineCount).toBe(2);
		expect(entry.bytes).toBe(11);
	});

	test("text round-trips byte-for-byte, including CJK and tabs", () => {
		// The point of the relay is that nothing rewrites the content on the way through.
		const text = "\t处理(参数)\n\treturn 值;\n";
		const entry = put({ text });
		const result = takeStash(entry.handle, "n1");
		expect("entry" in result && result.entry.text).toBe(text);
	});

	test("peek leaves the entry usable; take consumes it", () => {
		const entry = put();
		expect("entry" in peekStash(entry.handle, "n1")).toBe(true);
		// Still there after peeking — this is what lets dry_run preview safely.
		expect("entry" in peekStash(entry.handle, "n1")).toBe(true);
		expect("entry" in takeStash(entry.handle, "n1")).toBe(true);
		// Gone after taking.
		expect(takeStash(entry.handle, "n1")).toEqual({ failure: "unknown" });
	});

	test("an oversized range is refused with a remedy, not silently truncated", () => {
		// A truncated block written to a file is a corrupted file.
		expect(() => put({ text: "x".repeat(MAX_STASH_BYTES + 1) })).toThrow(StashTooLargeError);
	});
});

describe("isolation and reclamation", () => {
	test("another narrator cannot read the handle", () => {
		const entry = put({ narratorId: "owner" });
		expect(peekStash(entry.handle, "intruder")).toEqual({ failure: "wrong_narrator" });
		// And it stays intact for its owner.
		expect("entry" in peekStash(entry.handle, "owner")).toBe(true);
	});

	test("an entry expires on its own", () => {
		// Nothing releases a handle after an interrupt, so the TTL is the only reclamation.
		let clock = 1_000;
		setStashClock(() => clock);
		const entry = put();
		clock += STASH_TTL_MS + 1;
		expect(peekStash(entry.handle, "n1")).toEqual({ failure: "expired" });
		// Expiry also removes it rather than leaving it to be re-checked forever.
		expect(peekStash(entry.handle, "n1")).toEqual({ failure: "unknown" });
	});

	test("exceeding the per-narrator count evicts the oldest first", () => {
		let clock = 1_000;
		setStashClock(() => clock);
		const handles = Array.from({ length: MAX_STASH_ENTRIES_PER_NARRATOR + 2 }, () => {
			clock += 10;
			return put().handle;
		});
		const first = handles[0] as string;
		const second = handles[1] as string;
		const last = handles[handles.length - 1] as string;
		expect(peekStash(first, "n1")).toEqual({ failure: "unknown" });
		expect(peekStash(second, "n1")).toEqual({ failure: "unknown" });
		// The newest survives; eviction costs one re-stash, never the source file.
		expect("entry" in peekStash(last, "n1")).toBe(true);
	});

	test("one narrator's entries do not evict another's", () => {
		let clock = 1_000;
		setStashClock(() => clock);
		const mine = put({ narratorId: "a" }).handle;
		for (let i = 0; i < MAX_STASH_ENTRIES_PER_NARRATOR + 2; i++) {
			clock += 10;
			put({ narratorId: "b" });
		}
		expect("entry" in peekStash(mine, "a")).toBe(true);
	});

	test("drop is idempotent and scoped to the owner", () => {
		const entry = put({ narratorId: "owner" });
		expect(dropStash(entry.handle, "intruder")).toBe(false);
		expect(dropStash(entry.handle, "owner")).toBe(true);
		expect(dropStash(entry.handle, "owner")).toBe(false);
	});
});

describe("locateStashRange", () => {
	const entry = { text: "TARGET_A\nTARGET_B", startLine: 3, endLine: 4 };

	test("an unchanged file resolves at the recorded position", () => {
		const found = locateStashRange("L1\nL2\nTARGET_A\nTARGET_B\nL5\n", entry);
		expect(found).toEqual({ kind: "exact", startLine: 3, endLine: 4 });
	});

	test("lines inserted above relocate the range instead of deleting the wrong text", () => {
		// The bug this exists for: the recorded L3-4 now holds L1/L2, so acting on the stale
		// range would delete those instead of the stashed block.
		const found = locateStashRange("N1\nN2\nL1\nL2\nTARGET_A\nTARGET_B\nL5\n", entry);
		expect(found).toEqual({
			kind: "relocated",
			startLine: 5,
			endLine: 6,
			fromStartLine: 3,
			fromEndLine: 4,
		});
	});

	test("lines removed above relocate upward", () => {
		const found = locateStashRange("L2\nTARGET_A\nTARGET_B\n", entry);
		expect(found).toMatchObject({ kind: "relocated", startLine: 2, endLine: 3 });
	});

	test("duplicate text is ambiguous rather than a guess", () => {
		const found = locateStashRange("TARGET_A\nTARGET_B\nmid\nTARGET_A\nTARGET_B\n", entry);
		expect(found).toEqual({ kind: "ambiguous", candidates: [1, 4] });
	});

	test("rewritten content is reported missing, not silently relocated", () => {
		expect(locateStashRange("L1\nL2\nCHANGED_A\nTARGET_B\n", entry)).toEqual({ kind: "missing" });
		expect(locateStashRange("", entry)).toEqual({ kind: "missing" });
	});

	test("a CRLF file matches at its recorded position", () => {
		// A line-sliced stash of a CRLF file ends with a lone `\r`, which
		// normalizeLineEndings does not strip. Comparing raw would make every CRLF file
		// report "missing" — the content looking changed when nothing had.
		const crlf = { text: "L2\r\nL3\r", startLine: 2, endLine: 3 };
		expect(locateStashRange("L1\r\nL2\r\nL3\r\nL4\r\n", crlf)).toEqual({
			kind: "exact",
			startLine: 2,
			endLine: 3,
		});
	});

	test("a stash taken from CRLF still matches after the file is converted to LF", () => {
		// Line-wise comparison makes the two representations equivalent, which is the
		// behaviour a caller would expect from "is my block still there".
		const crlf = { text: "L2\r\nL3\r", startLine: 2, endLine: 3 };
		expect(locateStashRange("L1\nL2\nL3\nL4\n", crlf)).toMatchObject({ kind: "exact" });
	});

	test("single-line and end-of-file ranges resolve", () => {
		expect(locateStashRange("a\nb\nc\n", { text: "b", startLine: 2, endLine: 2 })).toEqual({
			kind: "exact",
			startLine: 2,
			endLine: 2,
		});
		// A range ending at the last line, where the trailing newline yields a final empty
		// entry — an off-by-one here would silently drop the last line from a move.
		expect(locateStashRange("a\nb\nc", { text: "b\nc", startLine: 2, endLine: 3 })).toEqual({
			kind: "exact",
			startLine: 2,
			endLine: 3,
		});
	});
});

describe("formatStashSize", () => {
	test("reports bytes below 1 KB and KB above", () => {
		expect(formatStashSize(512)).toBe("512 B");
		expect(formatStashSize(2048)).toBe("2.0 KB");
	});
});
