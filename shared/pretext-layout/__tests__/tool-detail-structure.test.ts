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
		const detail = classify({
			inputJson: { file_path: FILE, mode: "outline" },
			metadata: { declarations: 316, singleReference: 5 },
		});
		const labels = badgeLabels(detail);
		expect(labels).toContain("316 decl");
		expect(labels).toContain("5 refs:1");
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
