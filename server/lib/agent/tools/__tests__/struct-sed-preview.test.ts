/**
 * `previewStructSedChange` — the approval preview for a pending StructSed write.
 *
 * Approval is only requested for `dry_run: false`, and at that point the call has no output
 * for the card to show. The preview must report the texts the write WOULD produce, without
 * writing, and must fail visibly (not silently return nothing) when the address is stale.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../../types";
import { previewStructSedChange } from "../struct-sed";

const SOURCE = "alpha\nbravo\ncharlie\ndelta\n";

let workDir: string;
let file: string;

beforeAll(() => {
	workDir = mkdtempSync(join(tmpdir(), "struct-sed-preview-"));
	file = join(workDir, "notes.txt");
	writeFileSync(file, SOURCE, "utf8");
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function makeCtx(): ToolContext {
	return {
		narratorId: "test-narrator",
		cwd: workDir,
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "deny" }),
	} as unknown as ToolContext;
}

describe("previewStructSedChange", () => {
	test("returns the would-be texts for a real write without touching the file", async () => {
		const outcome = await previewStructSedChange(
			{ file_path: file, command: "replace", address: "2", content: "BRAVO", dry_run: false },
			makeCtx(),
		);
		if ("error" in outcome) throw new Error(outcome.error);
		expect(outcome.preview.before).toBe(SOURCE);
		expect(outcome.preview.after).toBe("alpha\nBRAVO\ncharlie\ndelta\n");
		expect(outcome.window?.oldText).toContain("bravo");
		expect(outcome.window?.newText).toContain("BRAVO");
		expect(outcome.window?.startLine).toBe(1);
		// `dry_run: false` in the pending input must not leak through into a write.
		expect(readFileSync(file, "utf8")).toBe(SOURCE);
	});

	test("reports the tool's error when the address no longer resolves", async () => {
		const outcome = await previewStructSedChange(
			{ file_path: file, command: "delete", address: "/no-such-line/", dry_run: false },
			makeCtx(),
		);
		expect("error" in outcome).toBe(true);
	});

	test("reports a no-op change as an error rather than an empty diff", async () => {
		const outcome = await previewStructSedChange(
			{ file_path: file, command: "replace", address: "1", content: "alpha", dry_run: false },
			makeCtx(),
		);
		expect("error" in outcome && outcome.error).toContain("No changes");
	});
});
