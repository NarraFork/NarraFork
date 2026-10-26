/**
 * `shared/outline/` runs unchanged in the browser (editor, clipboard) and on the server (tools,
 * write-time normalization). It may import only its own modules and `marked`; anything from
 * `server/`, `frontend/`, a UI runtime or a Node built-in would tie it to one side, and a DOM
 * global would break it on the other. The file list is enumerated, so new modules are covered.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "__tests__") out.push(...sourceFiles(path));
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(path);
	}
	return out.sort();
}

/** Source with comment-only lines dropped, so prose about "the document" does not trip checks. */
function codeLines(source: string): string {
	return source
		.split("\n")
		.filter((line) => {
			const t = line.trimStart();
			return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
		})
		.join("\n");
}

describe("shared/outline stays pure", () => {
	const files = sourceFiles(ROOT);

	test("covers every module", () => {
		const names = files.map((f) => relative(ROOT, f));
		expect(names).toContain("md-outline.ts");
		expect(names).toContain("dialect/serialize.ts");
	});

	test("imports only its own modules and marked", () => {
		for (const file of files) {
			const code = codeLines(readFileSync(file, "utf8"));
			for (const m of code.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
				const spec = m[1] as string;
				const ok = spec === "marked" || spec.startsWith("./") || spec.startsWith("../");
				expect(ok, `${relative(ROOT, file)} imports ${spec}`).toBe(true);
				if (spec.startsWith("../"))
					expect(
						join(file, "..", spec).startsWith(ROOT),
						`${relative(ROOT, file)} reaches outside shared/outline: ${spec}`,
					).toBe(true);
			}
		}
	});

	test("does not touch browser or Node globals", () => {
		for (const file of files) {
			const code = codeLines(readFileSync(file, "utf8"));
			expect(code, file).not.toMatch(/\b(?:document|window|navigator|process|Buffer)\s*\./);
			expect(code, file).not.toMatch(/\brequire\s*\(/);
		}
	});
});
