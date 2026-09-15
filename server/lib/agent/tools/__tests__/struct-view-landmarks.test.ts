/**
 * `mode=landmarks` at the tool level.
 *
 * The mode exists because of a real finding: on a 3500-line component, one regex over
 * section comments surfaced 17 module boundaries that `outline` could not see, and it was
 * the single most useful call in that investigation. The point of these tests is that the
 * mode needs NO parser — the boundaries are a comment convention, so it must work on a
 * shell script or a config file, which is exactly where structural help is scarcest.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../../types";
import { structViewTool } from "../struct-view";

const workDir = mkdtempSync(join(tmpdir(), "landmarks-tool-"));

const TS_SOURCE = `import { thing } from "./thing";

// --- Message operations ---

function send() {
	return thing;
}

// --- Scroll state ---

function scroll() {
	// TODO: throttle this
	return 1;
}

// #region Internals

function internal() {
	return 2;
}
// #endregion
`;

// No parser exists for this extension, which is the case the mode has to serve.
const SHELL_SOURCE = `#!/bin/sh
# ===== setup =====
export A=1

# ===== main =====
# FIXME: handle spaces in paths
run() { echo hi; }
`;

function write(name: string, content: string): string {
	writeFileSync(join(workDir, name), content, "utf8");
	return name;
}

function ctx(): ToolContext {
	return {
		narratorId: "test",
		cwd: workDir,
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" }),
	} as unknown as ToolContext;
}

async function run(args: Record<string, unknown>) {
	return structViewTool.execute(args, ctx());
}

describe("landmarks mode", () => {
	test("lists section banners with their lines", async () => {
		const file = write("panel.ts", TS_SOURCE);
		const r = await run({ file_path: file, mode: "landmarks" });
		expect(r.isError).toBeFalsy();
		expect(r.output).toContain("Message operations");
		expect(r.output).toContain("Scroll state");
		expect(r.output).toMatch(/L3\s/);
	});

	test("includes regions and markers alongside sections", async () => {
		const file = write("panel.ts", TS_SOURCE);
		const r = await run({ file_path: file, mode: "landmarks" });
		expect(r.output).toContain("Internals");
		expect(r.output).toContain("TODO");
	});

	test("works on a file with no parser at all", async () => {
		// The mode must not depend on language detection succeeding.
		const file = write("deploy.sh", SHELL_SOURCE);
		const r = await run({ file_path: file, mode: "landmarks" });
		expect(r.isError).toBeFalsy();
		expect(r.output).toContain("setup");
		expect(r.output).toContain("main");
		expect(r.output).toContain("FIXME");
	});

	test("reports a marker summary", async () => {
		const file = write("panel.ts", TS_SOURCE);
		const r = await run({ file_path: file, mode: "landmarks" });
		expect(r.output).toMatch(/Markers: TODO 1/);
	});

	test("counts section boundaries in metadata", async () => {
		const file = write("panel.ts", TS_SOURCE);
		const r = await run({ file_path: file, mode: "landmarks" });
		expect(r.metadata?.mode).toBe("landmarks");
		// Two banners plus one region.
		expect(r.metadata?.sections).toBe(3);
	});

	test("kind filters to one landmark type", async () => {
		const file = write("panel.ts", TS_SOURCE);
		const r = await run({ file_path: file, mode: "landmarks", kind: "marker" });
		expect(r.output).toContain("TODO");
		expect(r.output).not.toContain("Scroll state");
	});

	test("kind accepts the comma-separated form used by other modes", async () => {
		const file = write("panel.ts", TS_SOURCE);
		const r = await run({ file_path: file, mode: "landmarks", kind: "section,region" });
		expect(r.output).toContain("Scroll state");
		expect(r.output).toContain("Internals");
		expect(r.output).not.toContain("TODO");
	});

	test("limit caps the list and says more exist", async () => {
		const many = Array.from({ length: 30 }, (_, i) => `// --- s${i} ---`).join("\n");
		const file = write("many.ts", many);
		const r = await run({ file_path: file, mode: "landmarks", limit: 5 });
		expect(r.metadata?.landmarks).toBe(5);
		expect(r.output).toMatch(/More exist/);
	});

	test("a file with no landmarks says so and points elsewhere", async () => {
		// Silence would read as failure; naming the alternative modes is the useful answer.
		const file = write("plain.ts", "const a = 1;\nconst b = 2;\n");
		const r = await run({ file_path: file, mode: "landmarks" });
		expect(r.isError).toBeFalsy();
		expect(r.output).toMatch(/No landmarks found/);
		expect(r.output).toMatch(/mode=outline/);
		expect(r.metadata?.landmarks).toBe(0);
	});

	test("does not report ordinary comments as boundaries", async () => {
		const file = write("noise.ts", "// a-b is fine\n// x = 1 default\nconst a = 1;\n");
		const r = await run({ file_path: file, mode: "landmarks" });
		expect(r.metadata?.landmarks).toBe(0);
	});

	test("reports the file's total line count for context", async () => {
		const file = write("panel.ts", TS_SOURCE);
		const r = await run({ file_path: file, mode: "landmarks" });
		expect(r.metadata?.totalLines).toBe(TS_SOURCE.split("\n").length);
	});
});
