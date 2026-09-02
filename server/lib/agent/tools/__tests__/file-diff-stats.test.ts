/**
 * file-diff-stats.test.ts — the `+N -N` line counts Write/Edit attach as metadata.
 *
 * WHY THESE LIVE ON THE SERVER SIDE
 * ---------------------------------
 * The client cannot compute them (see `resolveFileDiffStats`): payloads reach the
 * browser truncated, and a Write's input never carries the file's previous content.
 * So the value the UI shows is decided HERE, and these tests pin the two properties
 * a wrong figure would violate:
 *
 *   1. the numbers match what actually changed — including the cases where the
 *      naive answer differs (an overwrite is not "all new", a `replace_all` is not
 *      one occurrence, a fuzzy match is not the model's `old_string`)
 *   2. when the count cannot be established, BOTH keys are ABSENT rather than 0 —
 *      `linesAdded: 0` claims the call changed nothing, which is a worse lie than
 *      saying nothing
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { narrators } from "../../../../db/schema";
import type { ToolContext } from "../../types";
import { editTool } from "../edit";
import { countOccurrences, MAX_WHOLE_FILE_STATS_CHARS } from "../file-diff-stats";
import { writeTool } from "../write";

const TEST_RUN_ID = `${Date.now().toString(36)}-stats`;
const TEST_NARRATOR_ID = `diff-stats-test-${TEST_RUN_ID}`;
const TEST_DIR = join(tmpdir(), `narrafork-diff-stats-${TEST_RUN_ID}`);

function makeCtx(): ToolContext {
	return {
		narratorId: TEST_NARRATOR_ID,
		cwd: TEST_DIR,
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" as const }),
	};
}

/** The two metadata keys under test, as the tool result carries them. */
function stats(result: { metadata?: Record<string, unknown> }): {
	added: unknown;
	removed: unknown;
} {
	return {
		added: result.metadata?.linesAdded,
		removed: result.metadata?.linesRemoved,
	};
}

/** Assert both keys are absent — the "unknown" encoding, distinct from 0/0. */
function expectNoStats(result: { metadata?: Record<string, unknown> }) {
	expect(result.metadata?.linesAdded).toBeUndefined();
	expect(result.metadata?.linesRemoved).toBeUndefined();
	// Explicitly NOT zero: a reader (or a later migration) must be able to tell
	// "we did not measure this" from "this changed nothing".
	expect(result.metadata?.linesAdded).not.toBe(0);
}

beforeAll(async () => {
	mkdirSync(TEST_DIR, { recursive: true });
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id: TEST_NARRATOR_ID,
		title: "diff stats test narrator",
		createdAt: now,
		updatedAt: now,
	});
});

afterAll(async () => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
	await db.delete(narrators).where(eq(narrators.id, TEST_NARRATOR_ID));
});

describe("Write — line statistics", () => {
	test("a new file counts every line as an addition", async () => {
		const target = join(TEST_DIR, "created.txt");
		const result = await writeTool.execute(
			{ file_path: target, content: "one\ntwo\nthree\n" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(stats(result)).toEqual({ added: 3, removed: 0 });
	});

	/**
	 * The case the client provably cannot get right, and the reason the server
	 * computes this at all: a rewrite that touches one line must report 1/1, not
	 * "everything is new".
	 */
	test("an overwrite is diffed against the previous content", async () => {
		const target = join(TEST_DIR, "overwritten.txt");
		writeFileSync(target, "alpha\nbeta\ngamma\n");
		const result = await writeTool.execute(
			{ file_path: target, content: "alpha\nBETA\ngamma\n" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(stats(result)).toEqual({ added: 1, removed: 1 });
	});

	test("appending reports additions only", async () => {
		const target = join(TEST_DIR, "appended.txt");
		writeFileSync(target, "keep\n");
		const result = await writeTool.execute(
			{ file_path: target, content: "keep\nadded one\nadded two\n" },
			makeCtx(),
		);
		expect(stats(result)).toEqual({ added: 2, removed: 0 });
	});

	test("rewriting a file with identical content reports a real zero", async () => {
		const target = join(TEST_DIR, "unchanged.txt");
		writeFileSync(target, "same\ncontent\n");
		const result = await writeTool.execute(
			{ file_path: target, content: "same\ncontent\n" },
			makeCtx(),
		);
		// 0/0 is a MEASUREMENT here (the tool compared both sides), unlike the absent
		// keys asserted elsewhere. The renderer draws nothing either way, but the
		// stored row must remain honest about which happened.
		expect(stats(result)).toEqual({ added: 0, removed: 0 });
	});

	/**
	 * A whole-file diff runs on the thread carrying the agent loop, so it is bounded
	 * by `MAX_WHOLE_FILE_STATS_CHARS`. Past that the figure is DROPPED, not zeroed —
	 * and the write itself must still succeed, because a missing header decoration is
	 * no reason to fail the operation the user asked for.
	 */
	test("drops the figure for a file beyond the whole-file budget, still writing", async () => {
		const target = join(TEST_DIR, "huge.txt");
		const line = `${"x".repeat(60)}\n`;
		const previous = line.repeat(Math.ceil(MAX_WHOLE_FILE_STATS_CHARS / line.length));
		writeFileSync(target, previous);
		const next = `${previous}tail\n`;
		expect(previous.length + next.length).toBeGreaterThan(MAX_WHOLE_FILE_STATS_CHARS);

		const result = await writeTool.execute({ file_path: target, content: next }, makeCtx());

		expect(result.isError).toBeFalsy();
		expect(await Bun.file(target).text()).toBe(next);
		expectNoStats(result);
	});
});

describe("Edit — line statistics", () => {
	test("a single-line replacement reports one added and one removed", async () => {
		const target = join(TEST_DIR, "edit-one.txt");
		writeFileSync(target, "alpha\nbeta\ngamma\n");
		const result = await editTool.execute(
			{ file_path: target, old_string: "beta", new_string: "BETA" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(stats(result)).toEqual({ added: 1, removed: 1 });
	});

	test("inserting lines reports additions only", async () => {
		const target = join(TEST_DIR, "edit-insert.txt");
		writeFileSync(target, "first\nlast\n");
		const result = await editTool.execute(
			{ file_path: target, old_string: "first\n", new_string: "first\nmiddle-a\nmiddle-b\n" },
			makeCtx(),
		);
		expect(stats(result)).toEqual({ added: 2, removed: 0 });
	});

	test("deleting lines reports removals only", async () => {
		const target = join(TEST_DIR, "edit-delete.txt");
		writeFileSync(target, "keep\ndrop-a\ndrop-b\nkeep2\n");
		const result = await editTool.execute(
			{ file_path: target, old_string: "drop-a\ndrop-b\n", new_string: "" },
			makeCtx(),
		);
		expect(stats(result)).toEqual({ added: 0, removed: 2 });
	});

	/**
	 * `replace_all` changes N sites, so reporting the single-occurrence figure would
	 * understate a wide rename by exactly N-fold — the mistake this scaling prevents.
	 */
	test("replace_all scales the figure by the number of occurrences", async () => {
		const target = join(TEST_DIR, "edit-all.txt");
		writeFileSync(target, "old\nkeep\nold\nkeep\nold\n");
		const result = await editTool.execute(
			{ file_path: target, old_string: "old", new_string: "new", replace_all: true },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(await Bun.file(target).text()).toBe("new\nkeep\nnew\nkeep\nnew\n");
		expect(stats(result)).toEqual({ added: 3, removed: 3 });
	});

	/**
	 * The replacer chain can match text that differs from what the model typed
	 * (line-trimmed / whitespace-normalized fallbacks). Statistics are computed
	 * against the MATCHED text, so a match found through a fuzzy replacer does not
	 * report indentation the file never had.
	 */
	test("counts against the text actually matched, not the model's old_string", async () => {
		const target = join(TEST_DIR, "edit-fuzzy.txt");
		writeFileSync(target, "    indented line\nsecond\n");
		// The model omits the leading indentation; LineTrimmedReplacer matches anyway.
		const result = await editTool.execute(
			{ file_path: target, old_string: "indented line", new_string: "    replaced line" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		// One line in, one line out — NOT inflated by an indentation-only difference
		// between `old_string` and the real file content.
		expect(stats(result)).toEqual({ added: 1, removed: 1 });
	});

	test("the create/overwrite mode diffs against the previous content", async () => {
		const target = join(TEST_DIR, "edit-overwrite.txt");
		writeFileSync(target, "alpha\nbeta\n");
		const result = await editTool.execute(
			{ file_path: target, old_string: "", new_string: "alpha\nBETA\n" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(stats(result)).toEqual({ added: 1, removed: 1 });
	});

	test("the create mode on a missing file counts every line as new", async () => {
		const target = join(TEST_DIR, "edit-created.txt");
		const result = await editTool.execute(
			{ file_path: target, old_string: "", new_string: "one\ntwo\n" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(stats(result)).toEqual({ added: 2, removed: 0 });
	});

	test("keeps the pre-existing position metadata alongside the counts", async () => {
		const target = join(TEST_DIR, "edit-position.txt");
		writeFileSync(target, "l1\nl2\nl3\nl4\n");
		const result = await editTool.execute(
			{ file_path: target, old_string: "l3", new_string: "L3" },
			makeCtx(),
		);
		// The line counts are additive: nothing the header already relied on is lost.
		expect(result.metadata?.startLine).toBe(3);
		expect(stats(result)).toEqual({ added: 1, removed: 1 });
	});

	test("a failed edit carries no counts", async () => {
		const target = join(TEST_DIR, "edit-fail.txt");
		writeFileSync(target, "content\n");
		const result = await editTool.execute(
			{ file_path: target, old_string: "absent", new_string: "x" },
			makeCtx(),
		);
		expect(result.isError).toBeTrue();
		expectNoStats(result);
	});
});

describe("countOccurrences", () => {
	test("counts non-overlapping matches", () => {
		expect(countOccurrences("old old old", "old")).toBe(3);
		expect(countOccurrences("aaaa", "aa")).toBe(2);
		expect(countOccurrences("none here", "missing")).toBe(0);
		expect(countOccurrences("anything", "")).toBe(0);
	});
});
