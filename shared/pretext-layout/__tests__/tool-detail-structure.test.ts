/**
 * StructView's detail card.
 *
 * The bug being fixed: StructView was routed to `classifySearch`, which reads
 * `pattern` / `glob` / `path`. StructView has none of those, `metaRows` drops empty
 * rows, and so the card's ENTIRE header disappeared — leaving a wall of output with no
 * indication of which file or mode produced it. On failure it was worse: the search
 * classifier returns only an error section, discarding the last clue about what had
 * been attempted.
 */
import { describe, expect, test } from "bun:test";
import { classifyToolDetail, type ToolDetailData } from "../tool-detail";

const FILE = "E:/repo/server/lib/agent/tools/struct-view.ts";

function classify(args: {
	inputJson?: unknown;
	outputJson?: unknown;
	metadata?: unknown;
	status?: string | null;
}): ToolDetailData | null {
	return classifyToolDetail({
		// Body ids are derived from the call identity; a fixed one keeps assertions stable.
		toolUseId: "test-struct-view",
		toolName: "StructView",
		category: "structure",
		status: args.status ?? "success",
		inputJson: args.inputJson,
		outputJson: args.outputJson ?? "L1 class Foo\nL5 function bar",
		metadata: args.metadata ?? null,
	});
}

/** Every badge label across the detail, for order-independent assertions. */
function badgeLabels(detail: ToolDetailData | null): string[] {
	const labels: string[] = [];
	const visit = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		const record = value as Record<string, unknown>;
		if (typeof record.label === "string" && typeof record.color === "string") {
			labels.push(record.label);
		}
		for (const child of Object.values(record)) visit(child);
	};
	visit(detail);
	return labels;
}

/** Every meta-row text across the detail. */
function rowTexts(detail: ToolDetailData | null): string[] {
	const texts: string[] = [];
	const visit = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		const record = value as Record<string, unknown>;
		if (record.kind === "meta-rows" && Array.isArray(record.rows)) {
			for (const row of record.rows) {
				const text = (row as Record<string, unknown>)?.text;
				if (typeof text === "string" && text.length > 0) texts.push(text);
			}
		}
		for (const child of Object.values(record)) visit(child);
	};
	visit(detail);
	return texts;
}

describe("classifyStructure", () => {
	test("the header names the file — the thing the search classifier dropped", () => {
		const detail = classify({ inputJson: { file_path: FILE, mode: "outline" } });
		expect(rowTexts(detail).some((t) => t.includes("struct-view.ts"))).toBe(true);
	});

	test("the mode appears as a chip", () => {
		const detail = classify({ inputJson: { file_path: FILE, mode: "report" } });
		expect(badgeLabels(detail)).toContain("report");
	});

	test("a missing mode reads as the tool default, matching the collapsed row", () => {
		const detail = classify({ inputJson: { file_path: FILE } });
		expect(badgeLabels(detail)).toContain("outline");
	});

	test("mode-specific arguments are surfaced", () => {
		expect(
			badgeLabels(classify({ inputJson: { file_path: FILE, mode: "extract", symbol: "Foo.bar" } })),
		).toContain("Foo.bar");
		expect(
			badgeLabels(classify({ inputJson: { file_path: FILE, mode: "print", address: "10,20" } })),
		).toContain("10,20");
		expect(
			badgeLabels(classify({ inputJson: { file_path: FILE, mode: "enclosing", position: "412" } })),
		).toContain("412");
		expect(
			badgeLabels(classify({ inputJson: { file_path: FILE, mode: "calls", filter: "use" } })),
		).toContain("use");
	});

	test("an approximate result is flagged on the card, not only in the output text", () => {
		const detail = classify({
			inputJson: { file_path: FILE, mode: "outline" },
			metadata: { support: "degraded", provider: "heuristic" },
		});
		// Burying this in a trailing note is how a heuristic answer gets read as exact.
		expect(badgeLabels(detail)).toContain("approximate");
	});

	test("an exact result carries no approximate flag", () => {
		const detail = classify({
			inputJson: { file_path: FILE, mode: "outline" },
			metadata: { support: "full", provider: "tree-sitter" },
		});
		expect(badgeLabels(detail)).not.toContain("approximate");
	});

	test("an ambiguous extract is flagged", () => {
		const detail = classify({
			inputJson: { file_path: FILE, mode: "extract", symbol: "run" },
			metadata: { ambiguous: true },
		});
		expect(badgeLabels(detail)).toContain("ambiguous");
	});

	test("result counts from metadata become chips", () => {
		const labels = badgeLabels(
			classify({
				inputJson: { file_path: FILE, mode: "outline" },
				metadata: { declarations: 316 },
			}),
		);
		expect(labels).toContain("316 decl");
	});

	test("counts are filtered to the ones the mode actually produces", () => {
		// `singleReference` is a refs-mode result. Showing it on an outline card would
		// assert a number that mode never computed.
		const outlineLabels = badgeLabels(
			classify({
				inputJson: { file_path: FILE, mode: "outline" },
				metadata: { declarations: 316, singleReference: 5 },
			}),
		);
		expect(outlineLabels).toContain("316 decl");
		expect(outlineLabels).not.toContain("5 refs:1");

		const refsLabels = badgeLabels(
			classify({
				inputJson: { file_path: FILE, mode: "refs" },
				metadata: { declarations: 316, singleReference: 5 },
			}),
		);
		expect(refsLabels).toContain("5 refs:1");
	});

	test("print shows block/line counts, never a declaration count", () => {
		const labels = badgeLabels(
			classify({
				inputJson: { file_path: FILE, mode: "print", address: "10,20" },
				metadata: { blocks: 2, printedLines: 11, totalLines: 480, declarations: 99 },
			}),
		);
		expect(labels).toContain("2 blocks");
		expect(labels).toContain("11 lines");
		expect(labels.some((l) => l.includes("decl"))).toBe(false);
	});

	test("zero and absent counts produce no chip", () => {
		const labels = badgeLabels(
			classify({
				inputJson: { file_path: FILE, mode: "outline" },
				metadata: { declarations: 0 },
			}),
		);
		expect(labels.some((l) => l.includes("decl"))).toBe(false);
	});

	test("language and provider are reported", () => {
		const detail = classify({
			inputJson: { file_path: FILE, mode: "outline" },
			metadata: { languageId: "typescript", provider: "tree-sitter" },
		});
		expect(
			rowTexts(detail).some((t) => t.includes("typescript") && t.includes("tree-sitter")),
		).toBe(true);
	});

	test("a failed call keeps its header instead of showing only an error", () => {
		const detail = classify({
			inputJson: { file_path: FILE, mode: "extract", symbol: "missing" },
			outputJson: "",
			status: "fail",
		});
		// The search classifier discarded the header here, removing the only record of
		// what had been attempted.
		expect(rowTexts(detail).some((t) => t.includes("struct-view.ts"))).toBe(true);
		expect(badgeLabels(detail)).toContain("extract");
	});

	test("the output body is present", () => {
		const detail = classify({
			inputJson: { file_path: FILE, mode: "outline" },
			outputJson: "L1 class Foo",
		});
		expect(JSON.stringify(detail)).toContain("output.main");
	});
});

/** The output body descriptor, for highlighting and cap assertions. */
function outputBody(detail: ToolDetailData | null): Record<string, unknown> | null {
	let found: Record<string, unknown> | null = null;
	const visit = (value: unknown): void => {
		if (found || !value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		const record = value as Record<string, unknown>;
		if (record.kind === "capped" && record.source === "output.main") {
			found = record;
			return;
		}
		for (const child of Object.values(record)) visit(child);
	};
	visit(detail);
	return found;
}

describe("syntax highlighting", () => {
	test("extract uses a language grammar, because its body is real source", () => {
		const body = outputBody(
			classify({ inputJson: { file_path: FILE, mode: "extract", symbol: "runPrint" } }),
		);
		expect(body?.format).toBe("code");
		// The PATH travels, not a resolved language id: this layer cannot import the
		// frontend's `getShikiLang`.
		expect(body?.codeLangPath).toBe(FILE);
		expect(body?.customHighlight).toBeUndefined();
	});

	test("print uses a language grammar too, despite its line-number gutter", () => {
		// Verified against the real tokenizer: a `   109│` prefix leaves the remaining
		// tokens identical to the un-prefixed text.
		const body = outputBody(
			classify({ inputJson: { file_path: FILE, mode: "print", address: "10,20" } }),
		);
		expect(body?.codeLangPath).toBe(FILE);
		expect(body?.customHighlight).toBeUndefined();
	});

	test("report-shaped modes use the bespoke tokenizer, not a language grammar", () => {
		// A grammar painted `exported`/`refs:3` as function names, left `variable` grey and
		// split `L13-27` into a subtraction. These bodies are reports, not code.
		for (const mode of [
			"outline",
			"api",
			"tree",
			"refs",
			"calls",
			"imports",
			"enclosing",
			"report",
		]) {
			const body = outputBody(classify({ inputJson: { file_path: FILE, mode } }));
			expect(body?.customHighlight).toBe("struct-view");
			expect(body?.codeLangPath).toBeUndefined();
			expect(body?.codeLang).toBeUndefined();
			// Still `code` format: the rows are column-aligned and must not reflow as prose.
			expect(body?.format).toBe("code");
		}
	});

	test("the two routes are mutually exclusive", () => {
		for (const mode of ["extract", "print", "outline", "report", "refs"]) {
			const body = outputBody(classify({ inputJson: { file_path: FILE, mode } }));
			const hasGrammar = Boolean(body?.codeLangPath || body?.codeLang);
			expect(hasGrammar).toBe(!body?.customHighlight);
		}
	});

	test("a report body needs no file path to be highlighted", () => {
		// The tokenizer reads the report's own grammar, so it does not depend on knowing
		// which language the analysed file was written in.
		const body = outputBody(classify({ inputJson: { mode: "outline" } }));
		expect(body?.customHighlight).toBe("struct-view");
		expect(body?.codeLangPath).toBeUndefined();
	});

	test("an unknown mode is treated as a report rather than as source", () => {
		const body = outputBody(classify({ inputJson: { file_path: FILE, mode: "not-a-mode" } }));
		expect(body?.customHighlight).toBe("struct-view");
	});
});

describe("body height cap", () => {
	test("pinpoint modes keep the small cap", () => {
		for (const mode of ["extract", "print", "enclosing", "imports"]) {
			expect(outputBody(classify({ inputJson: { file_path: FILE, mode } }))?.cap).toBe("code");
		}
	});

	test("listing modes get a taller box than the 13-line default", () => {
		for (const mode of ["outline", "api", "refs", "calls", "tree"]) {
			expect(outputBody(classify({ inputJson: { file_path: FILE, mode } }))?.cap).toBe(
				"agent-result",
			);
		}
	});

	test("report gets the tallest box, because its value is seeing it all at once", () => {
		expect(outputBody(classify({ inputJson: { file_path: FILE, mode: "report" } }))?.cap).toBe(
			"knowledge",
		);
	});

	test("an unknown mode falls back to the small cap rather than crashing", () => {
		expect(outputBody(classify({ inputJson: { file_path: FILE, mode: "not-a-mode" } }))?.cap).toBe(
			"code",
		);
	});
});
