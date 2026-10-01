/**
 * The stash relay across both tools: StructView holds a range, StructSed writes it.
 *
 * The property that matters most is asserted first and hardest: the stash output must NOT
 * contain the stashed text. Echoing it would put the content in the context, which is the
 * entire cost this feature exists to remove — and a regression there would look like a
 * working feature.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { peekStash, resetStash } from "../../structural/stash";
import type { ToolContext } from "../../types";
import { structSedTool } from "../struct-sed";
import { structViewTool } from "../struct-view";

const workDir = mkdtempSync(join(tmpdir(), "stash-tool-"));
const srcFile = join(workDir, "src.ts");
const SOURCE = "keep1\nkeep2\n/** doc */\nfunction moved() {\n\treturn 1;\n}\n";

function ctx(narratorId = "n1"): ToolContext {
	return {
		narratorId,
		cwd: workDir,
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" }),
	} as unknown as ToolContext;
}

async function stash(args: Record<string, unknown>, narratorId = "n1") {
	writeFileSync(srcFile, SOURCE, "utf8");
	return structViewTool.execute({ file_path: srcFile, mode: "stash", ...args }, ctx(narratorId));
}

async function sed(args: Record<string, unknown>, narratorId = "n1") {
	return structSedTool.execute(args, ctx(narratorId));
}

describe("stash mode", () => {
	test("never echoes the stashed content", async () => {
		resetStash();
		const r = await stash({ address: "3,$" });
		expect(r.isError).toBeFalsy();
		// The whole point: the text stays server-side.
		expect(r.output).not.toContain("function moved");
		expect(r.output).not.toContain("return 1");
		// But the caller learns enough to act.
		expect(r.output).toContain("line(s)");
		expect(r.metadata?.handle).toMatch(/^stash_[A-Za-z0-9_-]{8}$/);
	});

	test("stashes by line address — the case that had no working path", async () => {
		resetStash();
		const r = await stash({ address: "4,6" });
		expect(r.metadata?.startLine).toBe(4);
		expect(r.metadata?.endLine).toBe(6);
	});

	test("leaves the source file untouched", async () => {
		resetStash();
		await stash({ address: "3,$" });
		// Stashing is a read. Removing the original is a separate, visible delete; if this
		// ever cut instead of copied, a crash would lose the only copy of the text.
		expect(readFileSync(srcFile, "utf8")).toBe(SOURCE);
	});

	test("refuses address and symbol together", async () => {
		resetStash();
		const both = await stash({ address: "1", symbol: "moved" });
		expect(both.isError).toBe(true);
		expect(both.output).toContain("not both");
	});

	// Neither argument used to be an error. It now means "what am I holding?", which is the
	// only way to recover an opaque handle after a compaction.
	test("with neither argument it lists what is held instead of erroring", async () => {
		resetStash();
		const empty = await stash({});
		expect(empty.isError).toBeFalsy();
		expect(empty.output).toContain("No stashes held");

		await stash({ address: "1,3" });
		const listed = await stash({});
		expect(listed.isError).toBeFalsy();
		expect(listed.output).toContain("1 stash(es) held");
		expect(listed.output).toContain("stash_");
		// A listing must never carry the content — that is the point of holding it server-side.
		expect(listed.output).not.toContain(SOURCE.split("\n")[0]);
	});

	test("a named handle is readable, and a name in use is refused not overwritten", async () => {
		resetStash();
		const named = await stash({ address: "1,3", name: "scroll-fns" });
		expect(named.isError).toBeFalsy();
		expect(named.metadata?.handle).toBe("stash_scroll-fns");

		// Overwriting would silently invalidate a handle its holder still believes is good.
		const clash = await stash({ address: "1,3", name: "scroll-fns" });
		expect(clash.isError).toBe(true);
		expect(clash.output).toContain("already holds");

		const bad = await stash({ address: "1,3", name: "no spaces allowed" });
		expect(bad.isError).toBe(true);
		expect(bad.output).toContain("not usable");
	});

	test("an address matching nothing is an error, not an empty stash", async () => {
		resetStash();
		const r = await stash({ address: "/nothing-matches-this/" });
		expect(r.isError).toBe(true);
		expect(r.output).toContain("matched nothing");
	});
});

describe("from_stash", () => {
	test("writes the stashed text without it passing through the caller", async () => {
		resetStash();
		const held = await stash({ address: "3,$" });
		const handle = held.metadata?.handle as string;
		const target = join(workDir, "preview-target.ts");
		const r = await sed({
			file_path: target,
			command: "append",
			address: "1",
			from_stash: handle,
			create_if_missing: true,
		});
		expect(r.isError).toBeFalsy();
		// The preview shows what would be written; that is the one place content is expected.
		expect(r.output).toContain("DRY RUN");
	});

	// The preview window only shows lines around the edit, so on a large block its trailing
	// edge is off-screen and a caller cannot tell whether the range took one line too many.
	test("a dry run summarises the stash source and what it declares", async () => {
		resetStash();
		const held = await stash({ address: "1,$", name: "whole-file" });
		const target = join(workDir, "summary-target.ts");
		const r = await sed({
			file_path: target,
			command: "append",
			address: "1",
			from_stash: held.metadata?.handle as string,
			create_if_missing: true,
		});
		expect(r.isError).toBeFalsy();
		// Where it came from and how big it is, so the range can be checked without reading it.
		expect(r.output).toContain("stash_whole-file ←");
		expect(r.output).toContain("line(s)");
		// The declarations carried along, which is what confirms the right range was taken.
		expect(r.output).toContain("declares:");
	});

	test("a dry run does not consume the handle", async () => {
		resetStash();
		const held = await stash({ address: "3,$" });
		const handle = held.metadata?.handle as string;
		const target = join(workDir, "twice.ts");
		const args = {
			file_path: target,
			command: "append",
			address: "1",
			from_stash: handle,
			create_if_missing: true,
		};
		expect((await sed(args)).isError).toBeFalsy();
		// Consuming on preview would make the first real write always fail.
		expect((await sed(args)).isError).toBeFalsy();
	});

	test("content and from_stash together is refused", async () => {
		resetStash();
		const held = await stash({ address: "1" });
		const r = await sed({
			file_path: srcFile,
			command: "append",
			address: "1",
			content: "x",
			from_stash: held.metadata?.handle,
		});
		expect(r.isError).toBe(true);
		expect(r.output).toContain("not both");
	});

	test("substitute, move and copy refuse a handle outright", async () => {
		// They transform or relocate within one file, where a cross-file relay has no
		// coherent meaning. `delete` is deliberately NOT in this list — it takes the range.
		resetStash();
		const held = await stash({ address: "1" });
		for (const command of ["substitute", "move", "copy"]) {
			const r = await sed({
				file_path: srcFile,
				command,
				address: "1",
				from_stash: held.metadata?.handle,
				...(command === "substitute" ? { pattern: "a", replacement: "b" } : {}),
				...(command === "move" || command === "copy" ? { to_address: "5" } : {}),
			});
			expect(r.isError).toBe(true);
			expect(r.output).toContain("does not take `from_stash`");
		}
	});

	test("delete takes its range from the stash, with no address given", async () => {
		resetStash();
		const held = await stash({ address: "4,6" });
		const r = await sed({
			file_path: srcFile,
			command: "delete",
			from_stash: held.metadata?.handle,
		});
		expect(r.isError).toBeFalsy();
		expect(r.output).toContain("delete on L4-6");
	});

	test("delete refuses an address alongside the stash rather than picking one", async () => {
		resetStash();
		const held = await stash({ address: "4,6" });
		const r = await sed({
			file_path: srcFile,
			command: "delete",
			address: "1",
			from_stash: held.metadata?.handle,
		});
		expect(r.isError).toBe(true);
		expect(r.output).toContain("two ranges cannot both be right");
	});

	test("a shifted file relocates the delete instead of removing the wrong lines", async () => {
		// The bug that prompted this: the recorded range went stale and the delete would have
		// removed whatever moved into those lines, silently.
		resetStash();
		const held = await stash({ address: "4,6" });
		writeFileSync(srcFile, `inserted1\ninserted2\n${SOURCE}`, "utf8");
		const r = await sed({
			file_path: srcFile,
			command: "delete",
			from_stash: held.metadata?.handle,
		});
		expect(r.isError).toBeFalsy();
		expect(r.output).toContain("delete on L6-8");
		// The correction must be stated, not silent.
		expect(r.output).toContain("stash range moved");
	});

	test("duplicate text refuses rather than guessing which copy was stashed", async () => {
		resetStash();
		const held = await stash({ address: "4,6" });
		const block = SOURCE.split("\n").slice(3, 6).join("\n");
		// The block must also MOVE, not just be duplicated: if the recorded position still
		// holds the stashed text, that is the answer and copies elsewhere are irrelevant.
		writeFileSync(srcFile, `pad\n${SOURCE}${block}\n`, "utf8");
		const r = await sed({
			file_path: srcFile,
			command: "delete",
			from_stash: held.metadata?.handle,
		});
		expect(r.isError).toBe(true);
		expect(r.output).toContain("cannot be identified");
	});

	test("rewritten content refuses and says nothing was changed", async () => {
		resetStash();
		const held = await stash({ address: "4,6" });
		writeFileSync(srcFile, "keep1\nkeep2\ncompletely\ndifferent\n", "utf8");
		const r = await sed({
			file_path: srcFile,
			command: "delete",
			from_stash: held.metadata?.handle,
		});
		expect(r.isError).toBe(true);
		expect(r.output).toContain("no longer in");
		expect(r.output).toContain("Nothing was changed");
	});

	test("another narrator cannot use the handle, and the error says why", async () => {
		resetStash();
		const held = await stash({ address: "1" }, "owner");
		const r = await sed(
			{
				file_path: srcFile,
				command: "append",
				address: "1",
				from_stash: held.metadata?.handle,
			},
			"intruder",
		);
		expect(r.isError).toBe(true);
		expect(r.output).toContain("different narrator");
	});

	test("an unknown handle explains that the source file still has the range", async () => {
		resetStash();
		const r = await sed({
			file_path: srcFile,
			command: "append",
			address: "1",
			from_stash: "stash_zzzzzzzz",
		});
		expect(r.isError).toBe(true);
		// Recovery matters more than the diagnosis: nothing was lost.
		expect(r.output).toContain("still has the range");
	});

	test("a failed write keeps the handle, so the text is never lost", async () => {
		// Releasing before the bytes are on disk would discard the only copy held server-side.
		// This write is refused for lacking a tool-call binding, which makes it a clean probe.
		resetStash();
		const held = await stash({ address: "3,$" });
		const handle = held.metadata?.handle as string;
		const r = await sed({
			file_path: join(workDir, "unwritable.ts"),
			command: "append",
			address: "1",
			from_stash: handle,
			create_if_missing: true,
			dry_run: false,
		});
		expect(r.isError).toBe(true);
		expect("entry" in peekStash(handle, "n1")).toBe(true);
	});

	test("to_file now points at the stash path", async () => {
		resetStash();
		const r = await sed({
			file_path: srcFile,
			command: "move",
			symbol: "moved",
			to_file: join(workDir, "other.ts"),
			to_address: "1",
		});
		expect(r.isError).toBe(true);
		expect(r.output).toContain("mode=stash");
		expect(r.output).toContain("from_stash");
	});
});
