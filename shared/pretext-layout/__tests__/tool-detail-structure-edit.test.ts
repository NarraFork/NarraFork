/**
 * StructSed's card must not be StructView's card.
 *
 * The two tools address code the same way but take different inputs: `command` versus
 * `mode`. Routing StructSed through the structure classifier compiles fine and produces a
 * card that reads "outline" for a delete — the same class of silent mislabelling that made
 * StructView's own card empty when it was routed through the search classifier.
 */

import { describe, expect, test } from "bun:test";
import { classifyToolDetail, type ToolDetailData } from "../tool-detail";

const FILE = "E:/repo/server/lib/agent/tools/struct-view.ts";

function classify(input: {
	inputJson?: unknown;
	outputJson?: unknown;
	metadata?: unknown;
	status?: string | null;
}): ToolDetailData | null {
	return classifyToolDetail({
		toolUseId: "test-struct-sed",
		toolName: "StructSed",
		category: "structureEdit",
		status: input.status ?? "success",
		inputJson: input.inputJson,
		outputJson: input.outputJson ?? "applied",
		metadata: input.metadata ?? null,
	} as never);
}

function badgeLabels(detail: unknown): string[] {
	const labels: string[] = [];
	const visit = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		const record = value as Record<string, unknown>;
		if (typeof record.label === "string") labels.push(record.label);
		for (const child of Object.values(record)) visit(child);
	};
	visit(detail);
	return labels;
}

function outputBody(detail: unknown): Record<string, unknown> | null {
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

describe("the command drives the card, not a mode", () => {
	test("each command appears as its own chip", () => {
		for (const command of ["replace", "delete", "insert", "append", "substitute"]) {
			const labels = badgeLabels(classify({ inputJson: { file_path: FILE, command } }));
			expect(labels).toContain(command);
			// The StructView default must never leak in: it would present a write as a read.
			expect(labels).not.toContain("outline");
		}
	});

	test("delete is coloured apart from the additive commands", () => {
		// Removal is the one command whose own input cannot reconstruct what was lost.
		const detail = JSON.stringify(classify({ inputJson: { file_path: FILE, command: "delete" } }));
		expect(detail).toContain("red");
		const insert = JSON.stringify(
			classify({ inputJson: { file_path: FILE, command: "insert", content: "x" } }),
		);
		expect(insert).not.toContain("red");
	});

	test("a streaming call with no command yet does not invent one", () => {
		const labels = badgeLabels(classify({ inputJson: { file_path: FILE } }));
		for (const command of ["replace", "delete", "insert", "append", "substitute"]) {
			expect(labels).not.toContain(command);
		}
	});
});

describe("address and target", () => {
	test("a symbol address is shown", () => {
		const labels = badgeLabels(
			classify({ inputJson: { file_path: FILE, command: "delete", symbol: "runPrint" } }),
		);
		expect(labels).toContain("runPrint");
	});

	test("a line address is shown", () => {
		const labels = badgeLabels(
			classify({ inputJson: { file_path: FILE, command: "delete", address: "10,20" } }),
		);
		expect(labels).toContain("10,20");
	});

	test("a failure with no output still shows what was attempted", () => {
		// A failed call's only clue is the target and command; dropping the header removes it.
		const detail = JSON.stringify(
			classify({
				status: "error",
				outputJson: "",
				inputJson: { file_path: FILE, command: "delete", symbol: "runPrint" },
			}),
		);
		expect(detail).toContain("struct-view.ts");
		expect(detail).toContain("runPrint");
		expect(detail).toContain("StructSed failed");
	});

	test("a failure that DID produce output keeps the output instead of an error stub", () => {
		const detail = JSON.stringify(
			classify({
				status: "error",
				outputJson: 'No symbol matching "nope"',
				inputJson: { file_path: FILE, command: "delete", symbol: "nope" },
			}),
		);
		expect(detail).toContain("No symbol matching");
	});
});

describe("dry run is visible", () => {
	test("a preview is labelled", () => {
		// Reading a preview as an applied edit (or the reverse) misstates whether the work
		// actually happened.
		const labels = badgeLabels(
			classify({
				inputJson: { file_path: FILE, command: "delete", address: "5" },
				metadata: { dryRun: true, startLine: 5, endLine: 5 },
			}),
		);
		expect(labels).toContain("dry run");
	});

	test("an applied edit carries no dry-run chip", () => {
		const labels = badgeLabels(
			classify({
				inputJson: { file_path: FILE, command: "delete", address: "5" },
				metadata: { startLine: 5, endLine: 5 },
			}),
		);
		expect(labels).not.toContain("dry run");
	});

	test("a preview gets a taller body box than an applied summary", () => {
		// A dry run prints before AND after; an applied edit is one line.
		const preview = outputBody(
			classify({
				inputJson: { file_path: FILE, command: "delete" },
				metadata: { dryRun: true },
			}),
		);
		const applied = outputBody(
			classify({ inputJson: { file_path: FILE, command: "delete" }, metadata: {} }),
		);
		expect(preview?.cap).toBe("agent-result");
		expect(applied?.cap).toBe("code");
	});
});

describe("resolved range and counts", () => {
	test("a multi-line range reads as a range", () => {
		const labels = badgeLabels(
			classify({
				inputJson: { file_path: FILE, command: "delete" },
				metadata: { startLine: 12, endLine: 40 },
			}),
		);
		expect(labels).toContain("L12-40");
	});

	test("a single-line range is not written as L5-5", () => {
		const labels = badgeLabels(
			classify({
				inputJson: { file_path: FILE, command: "delete" },
				metadata: { startLine: 5, endLine: 5 },
			}),
		);
		expect(labels).toContain("L5");
		expect(labels).not.toContain("L5-5");
	});

	test("substitute reports how many replacements it made", () => {
		const labels = badgeLabels(
			classify({
				inputJson: { file_path: FILE, command: "substitute" },
				metadata: { replacements: 7 },
			}),
		);
		expect(labels).toContain("7 replaced");
	});
});

describe("body highlighting", () => {
	test("a report with no diff data uses the bespoke tokenizer, not a language grammar", () => {
		// The body is StructSed's own line-numbered report, not source of the target file.
		const body = outputBody(
			classify({ inputJson: { file_path: FILE, command: "delete" }, outputJson: "DRY RUN" }),
		);
		expect(body?.customHighlight).toBe("struct-view");
		expect(body?.codeLangPath).toBeUndefined();
		expect(body?.format).toBe("code");
	});
});

describe("dry-run diff rendering", () => {
	const diffMeta = {
		dryRun: true,
		command: "replace",
		startLine: 2,
		endLine: 2,
		diffBefore: "one\ntwo\nthree",
		diffAfter: "one\nTWO\nthree",
		diffStartLine: 1,
	};

	test("before/after metadata renders as a diff, not the tokenizer", () => {
		// This is the fix: the struct-view tokenizer highlights the report's syntax, so
		// real source in a Before/After block came out unhighlighted. A diff pairs the
		// lines and marks exactly what changed.
		const body = outputBody(
			classify({
				inputJson: { file_path: FILE, command: "replace", content: "TWO" },
				outputJson: "DRY RUN — nothing written.",
				metadata: diffMeta,
			}),
		);
		expect(body?.format).toBe("diff");
		expect(body?.customHighlight).toBeUndefined();
		expect(body?.diffDocument).toBeDefined();
	});

	test("the diff carries the file's language path so it highlights as source", () => {
		const body = outputBody(
			classify({
				inputJson: { file_path: FILE, command: "replace", content: "TWO" },
				metadata: diffMeta,
			}),
		);
		expect(body?.codeLangPath).toBe(FILE);
	});

	test("the diff is numbered from the reported start line", () => {
		const body = outputBody(classify({ inputJson: { file_path: FILE }, metadata: diffMeta }));
		const doc = body?.diffDocument as { startLine?: number } | undefined;
		expect(doc?.startLine).toBe(1);
	});

	test("a dry run WITHOUT diff data still falls back to the preview", () => {
		// The tool omits the diff for a change too large to show that way; the card must
		// keep working, not blank out.
		const body = outputBody(
			classify({
				inputJson: { file_path: FILE, command: "move" },
				outputJson: "DRY RUN — nothing written.",
				metadata: { dryRun: true, command: "move", startLine: 1, endLine: 1 },
			}),
		);
		expect(body?.format).toBe("code");
		expect(body?.customHighlight).toBe("struct-view");
	});

	test("an applied call with no diff data uses the summary tokenizer", () => {
		// Falls back to the text summary only when the tool omitted the diff (e.g. a change
		// too large to show that way).
		const body = outputBody(
			classify({
				inputJson: { file_path: FILE, command: "replace" },
				outputJson: "replace applied to file → L2",
				metadata: { command: "replace", startLine: 2, endLine: 2 },
			}),
		);
		expect(body?.format).toBe("code");
	});
});

describe("preview vs applied are told apart", () => {
	// Both now render an identical red/green diff. The ONLY signal that a preview has not
	// touched the file is the banner — this is the fix for "the dry-run diff looked like it
	// had already been applied".
	const diffFields = {
		diffBefore: "one\ntwo\nthree",
		diffAfter: "one\nTWO\nthree",
		diffStartLine: 1,
	};

	function noticeTexts(detail: unknown): string[] {
		const texts: string[] = [];
		const visit = (value: unknown): void => {
			if (!value || typeof value !== "object") return;
			if (Array.isArray(value)) {
				for (const item of value) visit(item);
				return;
			}
			const record = value as Record<string, unknown>;
			if (record.kind === "error" && typeof record.text === "string") texts.push(record.text);
			for (const child of Object.values(record)) visit(child);
		};
		visit(detail);
		return texts;
	}

	test("a dry run leads with a 'nothing written' notice", () => {
		const detail = classify({
			inputJson: { file_path: FILE, command: "replace", content: "TWO" },
			outputJson: "DRY RUN — nothing written.",
			metadata: { dryRun: true, command: "replace", ...diffFields },
		});
		expect(noticeTexts(detail).some((t) => /nothing was written/i.test(t))).toBe(true);
	});

	test("the dry-run notice is a warning tone, not an error", () => {
		// Yellow, not red: a preview is not a failure.
		const detail = JSON.stringify(
			classify({
				inputJson: { file_path: FILE, command: "replace" },
				metadata: { dryRun: true, command: "replace", ...diffFields },
			}),
		);
		expect(detail).toContain("warning");
	});

	test("an APPLIED edit renders a diff too, with NO preview notice", () => {
		// The applied path now carries diff metadata (without dryRun), so a real edit shows
		// the same diff — but must not claim it is only a preview.
		const detail = classify({
			inputJson: { file_path: FILE, command: "replace" },
			outputJson: "replace applied to file → L2",
			metadata: { command: "replace", startLine: 2, ...diffFields },
		});
		const body = outputBody(detail);
		expect(body?.format).toBe("diff");
		expect(noticeTexts(detail).some((t) => /nothing was written/i.test(t))).toBe(false);
	});

	test("an applied edit shows no 'dry run' chip", () => {
		const labels = badgeLabels(
			classify({
				inputJson: { file_path: FILE, command: "replace" },
				metadata: { command: "replace", startLine: 2, ...diffFields },
			}),
		);
		expect(labels).not.toContain("dry run");
	});
});
