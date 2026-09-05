import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@server/db";
import { narrators } from "@server/db/schema";
import { eq } from "drizzle-orm";
import type { ToolContext } from "../../types";
import { editTool } from "../edit";
import { applyLineEnding, detectLineEnding, type LineEnding } from "../encoding";
import { writeTool } from "../write";

/**
 * Line endings survive an edit.
 *
 * Edit and Write normalize to LF before matching, because a model authors LF in
 * its `old_string` and a CRLF file would otherwise never match. Writing that
 * normalized text back converted the whole file: on Windows a one-line edit made
 * `git diff` show every line as changed, which destroys review and blame and
 * overrides a repository's `.gitattributes eol=crlf`.
 *
 * Written with char codes rather than escapes so the fixtures state exactly which
 * bytes they mean.
 */

// Built from char codes, then asserted: `String.fromCharCode` is opaque to the
// type checker, but these are exactly the two members of `LineEnding`.
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10) as LineEnding;
const CRLF = (CR + LF) as LineEnding;

const TEST_RUN_ID = Date.now().toString(36);
const TEST_NARRATOR_ID = `line-endings-test-${TEST_RUN_ID}`;
const TEST_DIR = join(tmpdir(), `narrafork-line-endings-test-${TEST_RUN_ID}`);

function makeCtx(): ToolContext {
	return {
		narratorId: TEST_NARRATOR_ID,
		cwd: TEST_DIR,
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" as const }),
	};
}

/** Write a fixture whose lines are joined by `ending`, and return its path. */
function fixture(name: string, lines: string[], ending: string): string {
	const path = join(TEST_DIR, name);
	writeFileSync(path, lines.join(ending) + ending, "utf-8");
	return path;
}

async function readRaw(path: string): Promise<string> {
	return await Bun.file(path).text();
}

beforeAll(async () => {
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id: TEST_NARRATOR_ID,
		title: "Line endings test narrator",
		createdAt: now,
		updatedAt: now,
	});
	mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(async () => {
	await db.delete(narrators).where(eq(narrators.id, TEST_NARRATOR_ID));
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("detectLineEnding", () => {
	test("reads the file's dominant ending", () => {
		expect(detectLineEnding(`a${LF}b${LF}c`)).toBe(LF);
		expect(detectLineEnding(`a${CRLF}b${CRLF}c`)).toBe(CRLF);
		expect(detectLineEnding("no newlines at all")).toBe(LF);
		expect(detectLineEnding("")).toBe(LF);
	});

	test("a lone stray ending does not convert the file", () => {
		// One CRLF among many LF lines is a typo in someone's editor, not the file's
		// convention — honouring it would rewrite every other line.
		expect(detectLineEnding(`a${LF}b${LF}c${LF}d${CRLF}e${LF}f${LF}g`)).toBe(LF);
		expect(detectLineEnding(`a${CRLF}b${CRLF}c${CRLF}d${LF}e${CRLF}f${CRLF}g`)).toBe(CRLF);
	});
});

describe("applyLineEnding", () => {
	test("restores CRLF on LF-normalized text and leaves LF alone", () => {
		expect(applyLineEnding(`a${LF}b`, CRLF)).toBe(`a${CRLF}b`);
		expect(applyLineEnding(`a${LF}b`, LF)).toBe(`a${LF}b`);
	});
});

describe("Edit", () => {
	test("a CRLF file stays CRLF, and only the edited line changes", async () => {
		const path = fixture("crlf.txt", ["alpha", "bravo", "charlie"], CRLF);
		const result = await editTool.execute(
			{ file_path: path, old_string: "bravo", new_string: "BRAVO" },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(await readRaw(path)).toBe(`alpha${CRLF}BRAVO${CRLF}charlie${CRLF}`);
	});

	test("an LF file stays LF", async () => {
		const path = fixture("lf.txt", ["alpha", "bravo", "charlie"], LF);
		await editTool.execute(
			{ file_path: path, old_string: "bravo", new_string: "BRAVO" },
			makeCtx(),
		);
		expect(await readRaw(path)).toBe(`alpha${LF}BRAVO${LF}charlie${LF}`);
	});

	test("a multi-line replacement authored with LF adopts the file's CRLF", async () => {
		// The model always writes LF in `new_string`; the inserted lines must not become
		// the only LF lines in a CRLF file.
		const path = fixture("crlf-multi.txt", ["alpha", "bravo", "charlie"], CRLF);
		await editTool.execute(
			{ file_path: path, old_string: "bravo", new_string: `one${LF}two` },
			makeCtx(),
		);
		expect(await readRaw(path)).toBe(`alpha${CRLF}one${CRLF}two${CRLF}charlie${CRLF}`);
	});

	test("overwrite mode (empty old_string) keeps an existing file's CRLF", async () => {
		const path = fixture("crlf-overwrite.txt", ["alpha", "bravo"], CRLF);
		await editTool.execute(
			{ file_path: path, old_string: "", new_string: `x${LF}y${LF}` },
			makeCtx(),
		);
		expect(await readRaw(path)).toBe(`x${CRLF}y${CRLF}`);
	});

	test("a new file keeps what the model wrote", async () => {
		const path = join(TEST_DIR, "created.txt");
		await editTool.execute(
			{ file_path: path, old_string: "", new_string: `x${LF}y${LF}` },
			makeCtx(),
		);
		expect(await readRaw(path)).toBe(`x${LF}y${LF}`);
	});
});

describe("Write", () => {
	test("rewriting a CRLF file keeps it CRLF", async () => {
		const path = fixture("crlf-write.txt", ["alpha", "bravo"], CRLF);
		const result = await writeTool.execute(
			{ file_path: path, content: `alpha${LF}BRAVO${LF}` },
			makeCtx(),
		);
		expect(result.isError).toBeFalsy();
		expect(await readRaw(path)).toBe(`alpha${CRLF}BRAVO${CRLF}`);
	});

	test("a new file keeps what the model wrote", async () => {
		const path = join(TEST_DIR, "written.txt");
		await writeTool.execute({ file_path: path, content: `a${LF}b${LF}` }, makeCtx());
		expect(await readRaw(path)).toBe(`a${LF}b${LF}`);
	});
});
