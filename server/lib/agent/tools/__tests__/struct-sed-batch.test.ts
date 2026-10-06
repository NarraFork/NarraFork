/**
 * StructSed batch (`operations`) tool-level tests.
 *
 * These cover the batch GATES and the dry-run report, not the text arithmetic — that lives
 * in edit-ops-batch.test.ts. As in struct-sed.test.ts, every case runs without a tool-call
 * binding, so the write path is refused and nothing here writes a file.
 *
 * The behaviour that matters most: a batch address means what it meant when the batch was
 * written. If the tool resolved addresses against intermediate states, the second operation
 * in a batch would land somewhere the caller could not have predicted.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../../types";
import { structSedTool } from "../struct-sed";

const PLAIN_SOURCE = "alpha\nbravo\ncharlie\ndelta\necho\n";

let workDir: string;
let plainFile: string;

beforeAll(() => {
	workDir = mkdtempSync(join(tmpdir(), "struct-sed-batch-"));
	plainFile = join(workDir, "notes.txt");
	writeFileSync(plainFile, PLAIN_SOURCE, "utf8");
});

function makeCtx(): ToolContext {
	return {
		narratorId: "test-narrator",
		cwd: workDir,
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" }),
	} as unknown as ToolContext;
}

async function run(args: Record<string, unknown>) {
	return structSedTool.execute(args, makeCtx());
}

describe("batch gates", () => {
	test("an empty operations array is refused", () => {
		return run({ file_path: "notes.txt", operations: [] }).then((r) => {
			expect(r.isError).toBe(true);
			expect(r.output).toMatch(/empty/i);
		});
	});

	test("operations plus a top-level command is refused rather than half-honoured", async () => {
		// Ignoring one of the two silently would leave the model believing both applied.
		const r = await run({
			file_path: "notes.txt",
			command: "delete",
			operations: [{ command: "delete", address: "1" }],
		});
		expect(r.isError).toBe(true);
		expect(r.output).toMatch(/not both/i);
	});

	test("operations plus a top-level address is refused", async () => {
		const r = await run({
			file_path: "notes.txt",
			address: "1",
			operations: [{ command: "delete", address: "1" }],
		});
		expect(r.isError).toBe(true);
		expect(r.output).toMatch(/not both/i);
	});

	test("more than 50 operations is refused with the count", async () => {
		const many = Array.from({ length: 51 }, (_, i) => ({
			command: "delete",
			address: String(i + 1),
		}));
		const r = await run({ file_path: "notes.txt", operations: many });
		expect(r.isError).toBe(true);
		expect(r.output).toMatch(/51/);
	});

	test("a per-operation validation error names which operation failed", async () => {
		const r = await run({
			file_path: "notes.txt",
			operations: [
				{ command: "delete", address: "1" },
				{ command: "delete", symbol: "x", address: "2" },
			],
		});
		expect(r.isError).toBe(true);
		expect(r.output).toMatch(/operation 2/i);
	});

	test("an unknown command inside a batch is refused", async () => {
		const r = await run({
			file_path: "notes.txt",
			operations: [{ command: "frobnicate", address: "1" }],
		});
		expect(r.isError).toBe(true);
		expect(r.output).toMatch(/Unknown command/i);
	});

	test("a destination on a non-relocating batch entry is refused", async () => {
		const r = await run({
			file_path: "notes.txt",
			operations: [{ command: "delete", address: "1", to_address: "3" }],
		});
		expect(r.isError).toBe(true);
		expect(r.output).toMatch(/does not take a destination/i);
	});

	test("overlapping operations reject the whole batch", async () => {
		// Two operations on the same line have no defined combined result.
		const r = await run({
			file_path: "notes.txt",
			operations: [
				{ command: "delete", address: "2" },
				{ command: "replace", address: "2", content: "x" },
			],
		});
		expect(r.isError).toBe(true);
		expect(r.output).toMatch(/overlap/i);
	});
});

describe("batch dry run", () => {
	test("defaults to a dry run and writes nothing", async () => {
		const r = await run({
			file_path: "notes.txt",
			operations: [
				{ command: "replace", address: "1", content: "ALPHA" },
				{ command: "delete", address: "4" },
			],
		});
		expect(r.isError).toBeFalsy();
		expect(r.output).toMatch(/DRY RUN/);
		expect(readFileSync(plainFile, "utf8")).toBe(PLAIN_SOURCE);
	});

	test("lists every operation, not just the first", async () => {
		// A preview that showed one of three would defeat the point of previewing a batch.
		const r = await run({
			file_path: "notes.txt",
			operations: [
				{ command: "replace", address: "1", content: "ALPHA" },
				{ command: "delete", address: "3" },
				{ command: "append", address: "5", content: "foxtrot" },
			],
		});
		expect(r.output).toMatch(/1\. replace/);
		expect(r.output).toMatch(/2\. delete/);
		expect(r.output).toMatch(/3\. append/);
	});

	test("reports the operation count in metadata", async () => {
		const r = await run({
			file_path: "notes.txt",
			operations: [
				{ command: "delete", address: "1" },
				{ command: "delete", address: "3" },
			],
		});
		expect(r.metadata?.operations).toBe(2);
	});

	test("the preview reflects ALL operations having been applied", async () => {
		const r = await run({
			file_path: "notes.txt",
			operations: [
				{ command: "replace", address: "1", content: "ALPHA" },
				{ command: "replace", address: "2", content: "BRAVO" },
			],
		});
		expect(r.output).toContain("ALPHA");
		expect(r.output).toContain("BRAVO");
	});

	test("addresses are relative to the original file across a growing operation", async () => {
		// L1 becomes two lines; the L3 replace must still hit the original "charlie".
		const r = await run({
			file_path: "notes.txt",
			operations: [
				{ command: "replace", address: "1", content: "one\ntwo" },
				{ command: "replace", address: "3", content: "CHARLIE" },
			],
		});
		expect(r.isError).toBeFalsy();
		expect(r.output).toContain("CHARLIE");
		// "charlie" only survives if the second address was misresolved onto another line.
		expect(r.output).not.toMatch(/^\s*\d+\s+charlie$/m);
	});

	test("a batch producing no change says so instead of reporting success", async () => {
		const r = await run({
			file_path: "notes.txt",
			operations: [
				{ command: "replace", address: "1", content: "alpha" },
				{ command: "replace", address: "2", content: "bravo" },
			],
		});
		expect(r.output).toMatch(/No changes/i);
	});

	test("a batch of one behaves like a single call", async () => {
		const asBatch = await run({
			file_path: "notes.txt",
			operations: [{ command: "delete", address: "2" }],
		});
		const asSingle = await run({ file_path: "notes.txt", command: "delete", address: "2" });
		expect(asBatch.isError).toBeFalsy();
		expect(asSingle.isError).toBeFalsy();
		// Same resulting text; only the plan header differs between the two shapes.
		const after = (out: string) => out.split("After:")[1];
		expect(after(asBatch.output)).toBe(after(asSingle.output));
	});

	test("a regex address works inside a batch", async () => {
		const r = await run({
			file_path: "notes.txt",
			operations: [{ command: "replace", address: "/charlie/", content: "CHARLIE" }],
		});
		expect(r.isError).toBeFalsy();
		expect(r.output).toContain("CHARLIE");
	});

	test("the write path is still refused without a tool-call binding", async () => {
		const r = await run({
			file_path: "notes.txt",
			dry_run: false,
			operations: [{ command: "delete", address: "1" }],
		});
		expect(r.isError).toBe(true);
		expect(readFileSync(plainFile, "utf8")).toBe(PLAIN_SOURCE);
	});
});
