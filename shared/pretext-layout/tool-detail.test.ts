import { describe, expect, it } from "bun:test";
import { diffDocumentLineNoWidth, projectDiffDocument } from "./diff-core";
import { createSourceText } from "./source-text";
import {
	classifyToolDetail,
	countLines,
	type DetailCapKind,
	extractField,
	extractNumericField,
	isTruncated,
	MEDIA_IMAGE_CONTENT_PX,
	resolveDisplayText,
	resolveFileDiffStats,
	type ToolAskDetail,
	type ToolCappedDetail,
	type ToolDetailData,
	type ToolErrorDetail,
	type ToolMetaRowsDetail,
	type ToolSectionBody,
	type ToolSectionLabel,
	type ToolSectionsDetail,
	type ToolSpecTasksDetail,
	type ToolStructuredDetail,
	toolBodyId,
	toolInputFieldView,
} from "./tool-detail";

// ─────────────────────────────────────────────────────────────────────────────
// Section helpers — most cards are now MULTI-part details (meta header + one or
// more labelled body sections), mirroring the chunked ToolCallCard. These pull a
// specific piece out so each test can assert the block it cares about.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * View any detail as a section list. A detail with exactly ONE unlabelled
 * section stays collapsed to that bare body (so the simple cards keep their
 * original single-block shape and height model); normalize both forms here.
 */
function asSections(detail: ToolDetailData | null): ToolSectionsDetail {
	expect(detail?.kind).toBe("sections");
	if (!detail) throw new Error("Missing sections detail");
	return detail;
}

function bodyOfKind<K extends ToolSectionBody["kind"]>(
	detail: ToolDetailData | null,
	kind: K,
): Extract<ToolSectionBody, { kind: K }> {
	const body = asSections(detail).sections.find((part) => part.body.kind === kind)?.body;
	if (!body) throw new Error(`Missing ${kind} body`);
	return body as Extract<ToolSectionBody, { kind: K }>;
}

function diffRows(body: ToolCappedDetail) {
	if (!body.diffDocument) throw new Error("Missing diff document");
	return projectDiffDocument(body.diffDocument, { startRow: 0 }).lines;
}

/** The body of the section carrying `label` (fails when absent). */
function sectionBody(detail: ToolDetailData | null, label: ToolSectionLabel) {
	const found = asSections(detail).sections.find((s) => s.label === label);
	if (!found) throw new Error(`no "${label}" section in ${JSON.stringify(detail)}`);
	return found.body;
}

/** The body of the (possibly unlabelled) section carrying a given cap kind. */
function cappedSectionBody(detail: ToolDetailData | null, cap: DetailCapKind): ToolCappedDetail {
	const found = asSections(detail).sections.find(
		(s) => s.body?.kind === "capped" && s.body.cap === cap,
	);
	if (!found) throw new Error(`no "${cap}" capped section in ${JSON.stringify(detail)}`);
	return found.body as ToolCappedDetail;
}

/** True when a section with `label` exists. */
function hasSection(detail: ToolDetailData | null, label: ToolSectionLabel): boolean {
	return asSections(detail).sections.some((s) => s.label === label);
}

/** The first meta-rows body (the leading header block). */
function metaRowsOf(detail: ToolDetailData | null): ToolMetaRowsDetail {
	const found = asSections(detail).sections.find((s) => s.body.kind === "meta-rows");
	if (!found) throw new Error(`no meta-rows section in ${JSON.stringify(detail)}`);
	return found.body as ToolMetaRowsDetail;
}

/** Every badge label across the meta rows, flattened. */
function metaBadgeLabels(detail: ToolDetailData | null): string[] {
	return metaRowsOf(detail).rows.flatMap((r) => (r.badges ?? []).map((b) => b.label));
}

/** Every meta row text, flattened (empty rows dropped). */
function metaTexts(detail: ToolDetailData | null): string[] {
	return metaRowsOf(detail)
		.rows.map((r) => r.text)
		.filter((t) => t.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

describe("isTruncated", () => {
	it("recognizes a truncated wrapper", () => {
		expect(isTruncated({ _truncated: true, preview: "abc", fullLength: 10 })).toBe(true);
	});
	it("rejects non-truncated values", () => {
		expect(isTruncated(null)).toBe(false);
		expect(isTruncated("str")).toBe(false);
		expect(isTruncated({ _truncated: true })).toBe(false);
		expect(isTruncated({ preview: "x" })).toBe(false);
		expect(isTruncated({ _truncated: false, preview: "x" })).toBe(false);
	});
});

describe("resolveDisplayText", () => {
	it("returns empty string for null/undefined", () => {
		expect(resolveDisplayText(null)).toBe("");
		expect(resolveDisplayText(undefined)).toBe("");
	});
	it("returns the preview for truncated values", () => {
		expect(resolveDisplayText({ _truncated: true, preview: "hello", fullLength: 99 })).toBe(
			"hello",
		);
	});
	it("returns strings verbatim", () => {
		expect(resolveDisplayText("plain")).toBe("plain");
	});
	it("returns _text when present", () => {
		expect(resolveDisplayText({ _text: "inner" })).toBe("inner");
	});
	it("unwraps a TRUNCATED _text instead of dumping the wrapper JSON", () => {
		// The regression: `{_text, _metadata}` output whose _text was cut used to
		// render as the literal `{"_text":"…` — quotes, escapes and all.
		expect(
			resolveDisplayText({
				_text: { _truncated: true, preview: "line1\nline2", fullLength: 9000 },
				_metadata: { action: "search" },
			}),
		).toBe("line1\nline2");
	});
	it("renders a nested truncated leaf as text, never as its wrapper structure", () => {
		const text = resolveDisplayText({
			file_path: "/a/b.ts",
			content: { _truncated: true, preview: "body", fullLength: 9000 },
		});
		expect(text).not.toContain("_truncated");
		expect(text).not.toContain("fullLength");
		expect(text).toContain("body");
	});
	it("JSON-stringifies other objects", () => {
		expect(resolveDisplayText({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2));
	});
});

describe("extractField", () => {
	it("reads a string field from a plain object", () => {
		expect(extractField({ command: "ls -la" }, "command")).toBe("ls -la");
	});
	it("returns the first matching key", () => {
		expect(extractField({ glob: "*.ts" }, "pattern", "glob")).toBe("*.ts");
	});
	it("returns empty string when no key matches", () => {
		expect(extractField({ other: "x" }, "command")).toBe("");
		expect(extractField(null, "command")).toBe("");
	});
	// Field-level projection keeps every key in place, so a header field is read
	// directly. The old `_hints` whitelist + preview regex scraping are gone: they
	// existed only because the ROOT wrapper had destroyed the object.
	it("reads a short field that survived next to a truncated sibling", () => {
		expect(
			extractField(
				{ command: "echo hi", _pad: { _truncated: true, preview: "xxx", fullLength: 3000 } },
				"command",
			),
		).toBe("echo hi");
	});
	it("returns the preview when the field ITSELF was truncated", () => {
		expect(
			extractField(
				{ command: { _truncated: true, preview: "echo hi", fullLength: 3000 } },
				"command",
			),
		).toBe("echo hi");
	});
	it("ignores a legacy _hints map (no longer produced)", () => {
		expect(extractField({ _hints: { command: "hint" } }, "command")).toBe("");
	});
});

describe("extractNumericField", () => {
	it("reads a numeric field from a plain object", () => {
		expect(extractNumericField({ offset: 5 }, "offset")).toBe(5);
	});
	it("returns undefined when absent", () => {
		expect(extractNumericField({ a: "x" }, "offset")).toBeUndefined();
		expect(extractNumericField(null, "offset")).toBeUndefined();
	});
	it("reads a numeric field that survived next to a truncated sibling", () => {
		expect(
			extractNumericField(
				{ limit: 42, _pad: { _truncated: true, preview: "xxx", fullLength: 3000 } },
				"limit",
			),
		).toBe(42);
	});
	it("ignores a legacy _hints map (no longer produced)", () => {
		expect(extractNumericField({ _hints: { limit: 42 } }, "limit")).toBeUndefined();
	});
});

describe("countLines", () => {
	it("returns 0 for empty string", () => {
		expect(countLines("")).toBe(0);
	});
	it("returns 1 for a single line", () => {
		expect(countLines("one line")).toBe(1);
	});
	it("counts newlines + 1", () => {
		expect(countLines("a\nb\nc")).toBe(3);
		expect(countLines("a\n")).toBe(2);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyToolDetail — per category
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyToolDetail — read", () => {
	it("maps an image read to a media cap with contentPx", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Read",
				category: "read",
				outputJson: "ignored",
				metadata: { isImage: true },
			}),
			"capped",
		);
		expect(d.kind).toBe("capped");
		expect(d.cap).toBe("media");
		// Same reserved height a chat image block uses — not a taller standalone
		// estimate that would letterbox every screenshot.
		expect(d.contentPx).toBe(MEDIA_IMAGE_CONTENT_PX);
		expect(d.source).toBe("output.main");
	});
	it("maps a text read to a code cap with content line count", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Read",
				category: "read",
				outputJson: "line1\nline2\nline3",
			}),
			"capped",
		);
		expect(d.cap).toBe("code");
		expect(d.contentLines).toBe(3);
		expect(d.source).toBe("output.main");
	});
	it("keeps the file path as a leading meta row (chunked parity)", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Read",
			category: "read",
			inputJson: { file_path: "/src/app.ts" },
			outputJson: "body",
		});
		expect(metaTexts(d)).toEqual(["/src/app.ts"]);
	});
	it("shows size + format next to the path for an image read", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Read",
			category: "read",
			inputJson: { file_path: "/tmp/pic.png" },
			metadata: { isImage: true, filePath: "/tmp/pic.png", sizeKB: 12, imageFormat: "png" },
		});
		expect(metaTexts(d)).toEqual(["/tmp/pic.png (12 KB, png)"]);
	});
	it("forwards intrinsic dimensions on a media ref (aspect-ratio reservation)", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Read",
			category: "read",
			inputJson: { file_path: "/tmp/pic.png" },
			metadata: { isImage: true, filePath: "/tmp/pic.png", width: 1600, height: 900 },
		});
		// The path meta row exists here, so the media cap sits inside a sections
		// wrapper rather than being the unwrapped single body.
		const media = asSections(d).sections.find(
			(s) => s.body.kind === "capped" && s.body.cap === "media",
		)?.body as ToolCappedDetail;
		expect(media.media?.width).toBe(1600);
		expect(media.media?.height).toBe(900);
		// The fixed estimate stays as the fallback signal; measure overrides it
		// with the aspect fit when dims are present.
		expect(media.contentPx).toBe(MEDIA_IMAGE_CONTENT_PX);
	});
	it("omits dimensions when only one side is present or they are invalid", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Read",
				category: "read",
				inputJson: { file_path: "/tmp/pic.png" },
				metadata: { isImage: true, width: 1600 },
			}),
			"capped",
		);
		expect(d.media?.width).toBeUndefined();
		expect(d.media?.height).toBeUndefined();
		const bad = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Read",
				category: "read",
				inputJson: { file_path: "/tmp/pic.png" },
				metadata: { isImage: true, width: 0, height: -3 },
			}),
			"capped",
		);
		expect(bad.media?.width).toBeUndefined();
		expect(bad.media?.height).toBeUndefined();
	});
});

describe("classifyToolDetail — file", () => {
	it("maps Edit with old_string to a REAL line diff, not two concatenated halves", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Edit",
				category: "file",
				inputJson: { old_string: "a\nb", new_string: "a\nB\nc" },
			}),
			"capped",
		);
		expect(d.cap).toBe("diff");
		// The unchanged first line must be CONTEXT, not "removed then re-added".
		// A naive concatenation would emit 5 rows (2 removed + 3 added); a real diff
		// emits 4: context "a", removed "b", added "B", added "c".
		expect(diffRows(d).map((line) => [line.type, line.content])).toEqual([
			["context", "a"],
			["removed", "b"],
			["added", "B"],
			["added", "c"],
		]);
		expect(d.diffDocument ? d.diffDocument.totalRows : countLines(d.text ?? "")).toBe(4);
	});
	it("numbers Edit diff rows on both the old and new side", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Edit",
			category: "file",
			inputJson: { file_path: "/x.ts", old_string: "a\nb", new_string: "a\nB" },
			metadata: { startLine: 42 },
		});
		const body = cappedSectionBody(d, "diff");
		// Context lines carry BOTH numbers; a removal only the old, an addition only
		// the new — that is what the two-column gutter renders.
		expect(diffRows(body).map((line) => [line.type, line.oldLineNo, line.newLineNo])).toEqual([
			["context", 42, 42],
			["removed", 43, undefined],
			["added", undefined, 43],
		]);
		// One column is 2 chars wide at minimum, so both columns align.
		expect(diffDocumentLineNoWidth(body.diffDocument!)).toBe(2);
	});
	it("carries word-level changes for a modified line pair", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Edit",
				category: "file",
				inputJson: { old_string: "const a = 1;", new_string: "const a = 2;" },
			}),
			"capped",
		);
		const removed = diffRows(d).find((line) => line.type === "removed");
		const added = diffRows(d).find((line) => line.type === "added");
		// The shared prefix must NOT be marked as changed; only the differing token.
		expect(removed?.wordChanges?.some((c) => c.removed && c.value.includes("1"))).toBe(true);
		expect(removed?.wordChanges?.some((c) => c.added)).toBe(false);
		expect(added?.wordChanges?.some((c) => c.added && c.value.includes("2"))).toBe(true);
		expect(added?.wordChanges?.some((c) => c.removed)).toBe(false);
	});
	it("omits the diff gutter width when the edit position is unknown", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Edit",
				category: "file",
				inputJson: { old_string: "a", new_string: "b" },
			}),
			"capped",
		);
		// No startLine and not streaming → no line-number gutter (chunked parity).
		expect(d.diffDocument?.startLine).toBeUndefined();
	});
	it("maps Write to a code cap using content", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Write",
				category: "file",
				inputJson: { content: "x\ny\nz\nw" },
			}),
			"capped",
		);
		expect(d.cap).toBe("code");
		expect(d.diffDocument ? d.diffDocument.totalRows : countLines(d.text ?? "")).toBe(4);
	});
	it("shows the Write path as a meta row", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Write",
			category: "file",
			inputJson: { file_path: "/src/new.ts", content: "x" },
		});
		expect(metaTexts(d)).toEqual(["/src/new.ts"]);
	});
	it("annotates an Edit diff header with the original start line", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Edit",
			category: "file",
			inputJson: { file_path: "/src/a.ts", old_string: "a", new_string: "b" },
			metadata: { startLine: 42 },
		});
		expect(metaTexts(d)).toEqual(["/src/a.ts:42"]);
	});
});

describe("classifyToolDetail — tasks", () => {
	it("parses tasks from metadata with status + protected", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Read",
				category: "tasks",
				metadata: {
					tasks: [
						{ text: "do A", status: "done" },
						{ text: "do B", status: "doing", protected: true },
						{},
					],
				},
			}),
			"spec-tasks",
		);
		expect(d.kind).toBe("spec-tasks");
		expect(d.tasks).toEqual([
			{ text: "do A", status: "done", protected: false },
			{ text: "do B", status: "doing", protected: true },
			{ text: "—", status: undefined, protected: false },
		]);
	});
	it("parses tasks from input.content JSON", () => {
		const doc = JSON.stringify({ tasks: [{ text: "first", status: "todo" }] });
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Write",
				category: "tasks",
				inputJson: { content: doc },
			}),
			"spec-tasks",
		);
		expect(d.tasks).toEqual([{ text: "first", status: "todo", protected: false }]);
	});
	it("returns empty spec-tasks for an empty task document", () => {
		const doc = JSON.stringify({ tasks: [] });
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Write",
				category: "tasks",
				inputJson: { content: doc },
			}),
			"spec-tasks",
		);
		expect(d.kind).toBe("spec-tasks");
		expect(d.tasks).toEqual([]);
	});
	it("falls back to file branch when nothing parseable", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Write",
				category: "tasks",
				inputJson: { content: "not json" },
			}),
			"capped",
		);
		expect(d.kind).toBe("capped");
		expect(d.cap).toBe("code");
	});
});

describe("classifyToolDetail — bash", () => {
	it("keeps the command and the output as SEPARATE labelled sections", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Bash",
			category: "bash",
			inputJson: { command: "echo hi" },
			outputJson: "hi\nthere",
		});
		// The chunked card draws two boxes (60px command cap + 200px output cap);
		// merging them into one string erased the boundary and the Output label.
		const cmd = sectionBody(d, "command") as ToolCappedDetail;
		expect(cmd.cap).toBe("bash-cmd");
		expect(cmd.text).toBe("$ echo hi");
		const out = sectionBody(d, "output") as ToolCappedDetail;
		expect(out.cap).toBe("term");
		expect(out.text).toBe("hi\nthere");
		expect(out.contentLines).toBe(2);
	});
	it("uses streaming-bash cap when streaming output present", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Bash",
			category: "bash",
			inputJson: { command: "sleep 1" },
			metadata: { _streamingOutput: "partial..." },
		});
		const out = sectionBody(d, "output") as ToolCappedDetail;
		expect(out.cap).toBe("streaming-bash");
		expect(out.text).toBe("partial...");
	});
	it("surfaces the await badge row (task id, timeout, wait_for)", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Bash",
			category: "bash",
			inputJson: { await: { task_id: "t-1", timeout: 30000, wait_for_text: "ready" } },
		});
		expect(metaBadgeLabels(d)).toEqual(["await", "t-1", "timeout: 30s"]);
		expect(metaTexts(d)).toEqual(['wait_for: "ready"']);
	});
	it("returns null when no command and no output", () => {
		expect(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Bash",
				category: "bash",
				inputJson: {},
			}),
		).toBeNull();
	});
});

describe("classifyToolDetail — search", () => {
	it("returns error on failed search with no output", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Grep",
				category: "search",
				status: "fail",
				inputJson: { pattern: "foo" },
			}),
			"error",
		);
		expect(d.kind).toBe("error");
		expect(d.text).toBe("foo");
	});
	it("returns a labelled output section on success", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Grep",
			category: "search",
			outputJson: "match1\nmatch2",
		});
		const out = sectionBody(d, "output") as ToolCappedDetail;
		expect(out.cap).toBe("code");
		expect(out.contentLines).toBe(2);
	});
	it("keeps the pattern and search path as meta rows", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Grep",
			category: "search",
			inputJson: { pattern: "foo", path: "src/" },
			outputJson: "hit",
		});
		expect(metaTexts(d)).toEqual(["foo", "in src/"]);
	});
});

describe("classifyToolDetail — webSearch", () => {
	it("builds one structured ENTRY per result, keeping the link", () => {
		const output = JSON.stringify({
			results: [
				{ title: "T1", domain: "a.com", snippet: "s1", url: "https://a.com/1" },
				{ title: "T2", domain: "b.com", snippet: "s2", url: "https://b.com/2" },
			],
		});
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "WebSearch",
			category: "webSearch",
			outputJson: output,
		});
		const body = asSections(d).sections.find((s) => s.body.kind === "structured")
			?.body as ToolStructuredDetail;
		expect(body.entries).toHaveLength(2);
		expect(body.entries?.[0]).toEqual({
			title: "T1",
			href: "https://a.com/1",
			meta: "a.com",
			snippet: "s1",
		});
	});
	it("renders non-JSON output as MARKDOWN (chunked ContentViewer parity)", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "WebSearch",
			category: "webSearch",
			inputJson: { query: "how to" },
			outputJson: "plain text\nresults",
		});
		const out = sectionBody(d, "output") as ToolCappedDetail;
		expect(out.cap).toBe("code");
		expect(out.format).toBe("markdown");
		expect(metaTexts(d)).toEqual(["how to"]);
	});
	it("returns error when no output", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "WebSearch",
				category: "webSearch",
			}),
			"error",
		);
		expect(d.kind).toBe("error");
	});
});

describe("classifyToolDetail — webFetch", () => {
	it("maps screenshot mode with previewUrl to media", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "WebFetch",
			category: "webFetch",
			inputJson: { mode: "screenshot" },
			metadata: { previewUrl: "blob:x" },
		});
		const media = asSections(d).sections.find(
			(s) => s.body.kind === "capped" && s.body.cap === "media",
		)?.body as ToolCappedDetail;
		expect(media.contentPx).toBe(MEDIA_IMAGE_CONTENT_PX);
	});
	it("forwards screenshot dimensions from the metadata", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "WebFetch",
			category: "webFetch",
			inputJson: { mode: "screenshot" },
			metadata: { previewUrl: "blob:x", width: 1280, height: 800 },
		});
		const media = asSections(d).sections.find(
			(s) => s.body.kind === "capped" && s.body.cap === "media",
		)?.body as ToolCappedDetail;
		expect(media.media?.width).toBe(1280);
		expect(media.media?.height).toBe(800);
	});
	it("keeps the url link, mode badge and selector rows", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "WebFetch",
			category: "webFetch",
			inputJson: { url: "https://x.dev/a", mode: "readability", selector: "main" },
			outputJson: "a\nb",
		});
		const rows = metaRowsOf(d).rows;
		expect(rows[0]?.text).toBe("https://x.dev/a");
		expect(rows[0]?.href).toBe("https://x.dev/a");
		expect(metaBadgeLabels(d)).toEqual(["readability"]);
		expect(metaTexts(d)).toContain("selector: main");
	});
	it("renders smart/readability output as markdown", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "WebFetch",
			category: "webFetch",
			inputJson: { mode: "readability" },
			outputJson: "a\nb",
		});
		const out = sectionBody(d, "output") as ToolCappedDetail;
		expect(out.cap).toBe("code");
		expect(out.contentLines).toBe(2);
		expect(out.format).toBe("markdown");
	});
	it("leaves raw modes as plain monospace", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "WebFetch",
			category: "webFetch",
			inputJson: { mode: "dom" },
			outputJson: "<html>",
		});
		expect((sectionBody(d, "output") as ToolCappedDetail).format).not.toBe("markdown");
	});
});

describe("classifyToolDetail — agent/generic", () => {
	it("produces generic input/output line counts", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Task",
			category: "agent",
			inputJson: "prompt line",
			outputJson: "out1\nout2",
		});
		expect(asSections(d).kind).toBe("sections");
		expect(countLines(bodyOfKind(d, "capped").text ?? "")).toBe(1);
		expect(
			d?.sections.find((part) => part.key === "output.main")?.body.kind === "capped"
				? countLines(
						(d.sections.find((part) => part.key === "output.main")!.body as ToolCappedDetail)
							.text ?? "",
					)
				: undefined,
		).toBe(2);
	});
	it("omits outputLines when there's no output", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Task",
			category: "agent",
			inputJson: "prompt",
		});
		expect(
			d?.sections.find((part) => part.key === "output.main")?.body.kind === "capped"
				? countLines(
						(d.sections.find((part) => part.key === "output.main")!.body as ToolCappedDetail)
							.text ?? "",
					)
				: undefined,
		).toBeUndefined();
	});
	it("falls back to generic for unknown category", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Mystery",
			category: "generic",
			inputJson: "in",
		});
		expect(asSections(d).kind).toBe("sections");
	});
});

describe("protocol receipts stay out of displayed tool output", () => {
	it.each([
		"<subagent_id>worker</subagent_id>\n\nStill running",
		"Agent worker status: completed\n\n<subagent_id>worker</subagent_id>\n\n# Result\nDone",
	])("unwraps agent await addressing without losing status or results", (text) => {
		const d = classifyToolDetail({
			previewId: "protocol-await",
			toolName: "Await",
			category: "await",
			inputJson: { type: "agent", id: "worker" },
			outputJson: { _text: text },
			metadata: { subagentId: "real-id" },
		});
		const body = sectionBody(d, "result") as ToolCappedDetail;
		expect(body.text).not.toContain("<subagent_id>");
		expect(body.text).toContain(
			text.includes("Still running") ? "Still running" : "# Result\nDone",
		);
		expect(metaTexts(d)).toContain("subagent: real-id");
	});

	it("does not strip tags quoted in reports or shell stdout", () => {
		const text = "Example:\n```xml\n<subagent_id>example</subagent_id>\n```";
		for (const type of ["agent", "bash"]) {
			const d = classifyToolDetail({
				previewId: "quoted-protocol",
				toolName: "Await",
				category: "await",
				inputJson: { type },
				outputJson: text,
			});
			expect((sectionBody(d, type === "bash" ? "output" : "result") as ToolCappedDetail).text).toBe(
				text,
			);
		}
	});

	it("renders a localized background Bash receipt instead of XML and instructions", () => {
		const d = classifyToolDetail({
			previewId: "background-bash",
			toolName: "Bash",
			category: "bash",
			status: "success",
			inputJson: { command: "bun test", run_in_background: true },
			outputJson: {
				_text:
					"<background_task_id>tests</background_task_id>\n\nBackground bash task started. Use Await...",
			},
		labels: { backgroundTaskStarted: "已在后台启动" },
	});
	expect(metaBadgeLabels(d)).toEqual([]);
	expect(metaTexts(d)).toContain("已在后台启动");
	expect(metaTexts(d)).not.toContain("tests");
		expect(asSections(d).sections.some((part) => part.key === "output.main")).toBe(false);
		expect((sectionBody(d, "command") as ToolCappedDetail).text).toBe("$ bun test");
	});

	it.each([
		false,
		true,
	])("preserves shell stdout and launch errors (background=%s)", (background) => {
		const text = "<background_task_id>example</background_task_id>\nlaunch error";
		const d = classifyToolDetail({
			previewId: "shell-protocol",
			toolName: "Bash",
			category: "bash",
			status: background ? "fail" : "success",
			inputJson: { command: "example", run_in_background: background },
			outputJson: text,
		});
		expect((sectionBody(d, "output") as ToolCappedDetail).text).toBe(text);
	});
});

describe("classifyToolDetail — await", () => {
	it("uses a term-capped output section for bash await", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Await",
			category: "await",
			inputJson: { type: "bash" },
			outputJson: "line",
		});
		expect((sectionBody(d, "output") as ToolCappedDetail).cap).toBe("term");
	});
	it("uses a markdown result section for agent await", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Await",
			category: "await",
			inputJson: { type: "agent" },
			outputJson: "done",
		});
		const body = sectionBody(d, "result") as ToolCappedDetail;
		expect(body.cap).toBe("code");
		expect(body.format).toBe("markdown");
	});
	it("surfaces the badge row plus waitFor / subagent rows", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Await",
			category: "await",
			inputJson: { type: "agent", id: "t-9", timeout: 600000, wait_for_text: "done" },
			metadata: { resolvedId: "n-1", status: "completed", subagentId: "sa-1" },
		});
		expect(metaBadgeLabels(d)).toEqual(["agent", "t-9", "→ n-1", "completed", "timeout: 10m"]);
		expect(metaTexts(d)).toEqual(['wait_for: "done"', "subagent: sa-1"]);
	});
});

describe("classifyToolDetail — send", () => {
	it.each([
		[{ await: true }, undefined],
		[{ await: false }, undefined],
		[{}, undefined],
		[{ await: false }, { await: true }],
		[{ _truncated: true, preview: "{}" }, { await: true }],
		[{ _truncated: true, preview: "{}" }, { await: false }],
	])("does not show mode labels before enqueueing for %j / %j", (inputJson, metadata) => {
		const d = classifyToolDetail({
			previewId: "send-mode",
			toolName: "Send",
			category: "send",
			inputJson,
			metadata,
			labels: {
				communicationRunning: "发送中",
				sendAwaitReply: "等待回复",
				sendNoAwaitReply: "不等待回复",
			},
		});
		expect(metaBadgeLabels(d)).toContain("发送中");
		expect(metaBadgeLabels(d)).not.toContain("不等待回复");
		expect(metaBadgeLabels(d)).not.toContain("等待回复");
	});
	it("splits message / delivery / result into labelled sections", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Send",
			category: "send",
			inputJson: { message: "hi\nthere" },
			outputJson: "delivered",
			metadata: { targets: [{ title: "Agent A", status: "sent" }] },
		});
		const message = sectionBody(d, "message") as ToolCappedDetail;
		expect(message.text).toBe("hi\nthere");
		expect(message.format).toBe("markdown");
		// Delivery keeps per-target structure instead of "sent · Agent A" text.
		const delivery = sectionBody(d, "delivery") as ToolStructuredDetail;
		expect(delivery.entries).toEqual([
			{ title: "Agent A", badges: [{ label: "Sent", color: "green" }] },
		]);
		expect((sectionBody(d, "result") as ToolCappedDetail).text).toBe("delivered");
		expect(metaBadgeLabels(d)).toEqual(["→ Agent A", "Sent"]);
	});
	it("marks a failed delivery and carries its error", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Send",
			category: "send",
			inputJson: { message: "hi" },
			metadata: { targets: [{ id: "a1", status: "failed", error: "gone", interrupted: true }] },
		});
		const delivery = sectionBody(d, "delivery") as ToolStructuredDetail;
		expect(delivery.entries?.[0]?.badges).toEqual([
			{ label: "Send failed", color: "red" },
			{ label: "interrupted", color: "orange" },
		]);
		expect(delivery.entries?.[0]?.snippet).toBe("gone");
	});
	it("labels the output `reply` in await mode and marks the badges", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Send",
			category: "send",
			inputJson: { message: "hi", await: true, doInterrupt: true },
			outputJson: "pong",
			metadata: { targets: [{ id: "a", status: "completed", awaited: true }] },
		});
		expect(hasSection(d, "reply")).toBe(true);
		expect(metaBadgeLabels(d)).toContain("Sent · Reply received");
		expect(metaBadgeLabels(d)).toContain("interrupt");
	});
});

describe("classifyToolDetail — ask", () => {
	/** Classify an ask payload, typed as the ask replay it must produce. */
	function ask(inputJson: unknown, labels?: Record<string, string>): ToolAskDetail {
		return bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "AskUserQuestion",
				category: "ask",
				status: "success",
				inputJson,
				...(labels ? { labels } : {}),
			}),
			"ask",
		);
	}

	it("suppresses the summary only when a LIVE permission form is mounted", () => {
		expect(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "AskUserQuestion",
				category: "ask",
				status: "pending",
				inputJson: { questions: [{ header: "Q" }] },
				hasPendingPermission: true,
			}),
		).toBeNull();
	});
	it("still renders a running question when no form is mounted", () => {
		// Previously `running` alone returned null, so an in-flight question showed
		// an empty card whenever the interactive banner lived elsewhere.
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "AskUserQuestion",
				category: "ask",
				status: "running",
				inputJson: { questions: [{ header: "Q" }] },
			}),
			"ask",
		);
		expect(d.kind).toBe("ask");
		expect(d.questions[0]?.header).toBe("Q");
	});
	it("returns null when there are no questions", () => {
		expect(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "AskUserQuestion",
				category: "ask",
				inputJson: {},
			}),
		).toBeNull();
	});
	it("carries each option's DESCRIPTION alongside its label", () => {
		const d = ask({
			questions: [
				{
					header: "Pick one",
					options: [{ label: "Alpha" }, { label: "Beta", description: "the second" }],
				},
			],
		});
		expect(d.questions[0]?.options).toEqual([
			{ header: "Alpha" },
			{ header: "Beta", description: "the second" },
		]);
	});
	it("marks the chosen option and prefixes the answer", () => {
		const d = ask({
			questions: [{ question: "k", header: "Pick", options: [{ label: "Alpha" }] }],
			answers: { k: "Alpha" },
		});
		expect(d.questions[0]?.answer).toBe("Answer: Alpha");
		expect(d.questions[0]?.options[0]?.selected).toBe(true);
	});
	it("marks EVERY option of a multi-select answer", () => {
		// `answer === label` only ever matched a single-option answer, so a
		// multi-select submission left every option unmarked.
		const d = ask({
			questions: [
				{
					question: "k",
					header: "Pick some",
					multiSelect: true,
					options: [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }],
				},
			],
			answers: { k: "Alpha, Gamma" },
		});
		expect(d.questions[0]?.options.map((o) => o.selected === true)).toEqual([true, false, true]);
		// A combination of real option labels is NOT free text.
		expect(d.questions[0]?.customAnswer).toBeUndefined();
		expect(d.questions[0]?.answer).toBe("Answer: Alpha, Gamma");
	});
	it("resolves an answer keyed by HEADER when `question` is absent", () => {
		// Providers occasionally omit `question`; the live banner falls back to the
		// header, and reading only answers[question] rendered these as unanswered.
		const d = ask({
			questions: [
				{ header: "Pick", options: [{ label: "Alpha" }] },
				{ header: "Other", options: [{ label: "Beta" }] },
			],
			answers: { Pick: "Alpha" },
		});
		expect(d.questions[0]?.answer).toBe("Answer: Alpha");
		expect(d.questions[1]?.answer).toBeUndefined();
	});
	it("falls back to the only answer for a single question with a drifted key", () => {
		const d = ask({
			questions: [{ question: "k", header: "Pick", options: [{ label: "Alpha" }] }],
			answers: { somethingElse: "Alpha" },
		});
		expect(d.questions[0]?.answer).toBe("Answer: Alpha");
		expect(d.questions[0]?.options[0]?.selected).toBe(true);
	});
	it("does not apply the single-answer fallback across MULTIPLE questions", () => {
		const d = ask({
			questions: [
				{ question: "a", header: "First", options: [{ label: "Alpha" }] },
				{ question: "b", header: "Second", options: [{ label: "Beta" }] },
			],
			answers: { drifted: "Alpha" },
		});
		expect(d.questions[0]?.answer).toBeUndefined();
		expect(d.questions[1]?.answer).toBeUndefined();
	});
	it("omits the header for a single question (the card already shows it)", () => {
		expect(ask({ questions: [{ header: "Only" }] }).questions[0]?.omitHeader).toBe(true);
		const two = ask({ questions: [{ header: "First" }, { header: "Second" }] });
		expect(two.questions.map((q) => q.omitHeader)).toEqual([undefined, undefined]);
	});
	it("routes a free-text answer to customAnswer", () => {
		const d = ask({
			questions: [{ question: "k", header: "Pick", options: [{ label: "Alpha" }] }],
			answers: { k: "something entirely different" },
		});
		expect(d.questions[0]?.customAnswer).toBe("Custom answer: something entirely different");
		expect(d.questions[0]?.answer).toBeUndefined();
		expect(d.questions[0]?.options[0]?.selected).toBeUndefined();
	});
	it("uses the injected localized prefixes", () => {
		const d = ask(
			{
				questions: [{ question: "k", header: "Pick", options: [{ label: "Alpha" }] }],
				answers: { k: "Alpha" },
			},
			{ askAnswerPrefix: "答案：" },
		);
		// A full-width colon carries its own trailing space in the glyph, so no
		// separating space is added.
		expect(d.questions[0]?.answer).toBe("答案：Alpha");
	});
	it("truncates absurd question / option counts", () => {
		const d = ask({
			questions: Array.from({ length: 40 }, (_, qi) => ({
				header: `Q${qi}`,
				options: Array.from({ length: 40 }, (_, oi) => ({ label: `O${oi}` })),
			})),
		});
		expect(d.questions).toHaveLength(8);
		expect(d.questions[0]?.options).toHaveLength(8);
	});
	it("wraps a failed question into a sections detail alongside its error", () => {
		// A denied / skipped question has an errorMessage and no output, so
		// withErrorSection composes `[ask, error]` — the shape the render layer must
		// route explicitly (a bare fallthrough loses the option glyphs).
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "AskUserQuestion",
			category: "ask",
			status: "fail",
			inputJson: { questions: [{ header: "Pick", options: [{ label: "Alpha" }] }] },
			errorMessage: "User skipped the question",
		}) as ToolSectionsDetail;
		expect(d.kind).toBe("sections");
		expect(d.sections.map((s) => s.body.kind)).toEqual(["ask", "error"]);
		expect(d.sections[1]?.label).toBe("error");
	});
});

describe("classifyToolDetail — plan", () => {
	it("returns null when no plan text", () => {
		expect(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "ExitPlanMode",
				category: "plan",
				inputJson: {},
			}),
		).toBeNull();
	});
	it("maps plan text to a plan cap", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "ExitPlanMode",
				category: "plan",
				inputJson: { plan: "step 1\nstep 2" },
			}),
			"capped",
		);
		expect(d.cap).toBe("plan");
		expect(d.contentLines).toBe(2);
	});
	it("marks the body as markdown (parity with the chunked ContentViewer)", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "ExitPlanMode",
				category: "plan",
				inputJson: { plan: "# Title\n\n- a\n- b" },
			}),
			"capped",
		);
		expect(d.format).toBe("markdown");
		expect(d.text).toBe("# Title\n\n- a\n- b");
	});
	it("passes through the RAW _planFile path, never a localized string", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "ExitPlanMode",
				category: "plan",
				inputJson: { plan: "body", _planFile: ".narrafork/plan-abc123.md" },
			}),
			"capped",
		);
		expect(d.sourcePath).toBe(".narrafork/plan-abc123.md");
		// The render layer owns the "Plan from …" wording (shared/ has no i18n).
		expect(d.sourcePath).not.toContain("Plan from");
	});
	it("omits sourcePath for an inline plan", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "ExitPlanMode",
				category: "plan",
				inputJson: { plan: "body" },
			}),
			"capped",
		);
		expect(d.sourcePath).toBeUndefined();
	});

	// Regression: a file-based plan is replaced by a short path reference in MODEL
	// history, and a model can echo that sentence back as the next call's `plan`.
	// Classifying it as a plan body put "the plan is saved in <path>" on screen
	// where the plan should be.
	it("refuses to treat our own model-facing plan reference as a plan body", () => {
		const reference =
			"The plan was not approved. Its full content is saved in the plan file: " +
			".narrafork/plan-portable-jukebox-parrot--cnz6sszhQubPv9s0.md. " +
			"Re-read that file with the Read tool if you need the plan details.";
		expect(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "ExitPlanMode",
				category: "plan",
				inputJson: {
					plan: reference,
					_planFile: ".narrafork/plan-portable-jukebox-parrot--cnz6sszhQubPv9s0.md",
				},
			}),
		).toBeNull();
	});
});

describe("classifyToolDetail — pipeline", () => {
	it("keeps rule / captured / output as separate sections", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "ExtractPipeline",
			category: "pipeline",
			inputJson: { rule: "grab logs", aliases: ["a1"], format: "json" },
			outputJson: "body line",
			metadata: { captured: [{ alias: "a1", toolName: "Bash", bytes: 120 }] },
		});
		expect((sectionBody(d, "rule") as ToolCappedDetail).text).toBe("grab logs");
		const captured = sectionBody(d, "captured") as ToolStructuredDetail;
		expect(captured.entries).toEqual([
			{ title: "a1", badges: [{ label: "Bash", color: "gray" }], meta: "120 B" },
		]);
		expect((sectionBody(d, "output") as ToolCappedDetail).text).toBe("body line");
		expect(metaBadgeLabels(d)).toEqual(["extract", "json", "a1"]);
	});
	it("shows the char caps for a start stage", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "StartPipeline",
			category: "pipeline",
			inputJson: { maxPreviewChars: 500, maxChars: 9000 },
		});
		expect(metaBadgeLabels(d)).toEqual(["start", "preview ≤ 500 chars", "max 9000 chars"]);
	});
	it("returns just the stage badge when nothing parseable", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "StartPipeline",
			category: "pipeline",
			inputJson: {},
		});
		expect(metaBadgeLabels(d)).toEqual(["start"]);
	});
});

describe("classifyToolDetail — terminal", () => {
	it("maps write action to a labelled bash-cmd section", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Terminal",
			category: "terminal",
			inputJson: { action: "write", input: "ls", terminalId: "term-7" },
		});
		const body = sectionBody(d, "input") as ToolCappedDetail;
		expect(body.cap).toBe("bash-cmd");
		expect(body.contentLines).toBe(1);
		// The terminal id + action badge row was entirely absent before.
		expect(metaBadgeLabels(d)).toEqual(["write"]);
		expect(metaTexts(d)).toEqual(["terminal: term-7"]);
	});
	it("maps read action to a term-capped output section", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Terminal",
			category: "terminal",
			inputJson: { action: "read" },
			outputJson: "out\nput",
		});
		const body = sectionBody(d, "output") as ToolCappedDetail;
		expect(body.cap).toBe("term");
		expect(body.contentLines).toBe(2);
	});
	it("returns error on failed read with no output", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Terminal",
				category: "terminal",
				status: "fail",
				inputJson: { action: "read" },
			}),
			"error",
		);
		expect(d.kind).toBe("error");
	});
});

describe("classifyToolDetail — share", () => {
	it("maps media preview to a media cap with a preview URL", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "ShareFile",
			category: "share",
			metadata: { downloadUrl: "/d/x", preview: true, previewUrl: "/p/x", filename: "shot.png" },
		});
		const media = asSections(d).sections.find(
			(s) => s.body.kind === "capped" && s.body.cap === "media",
		)?.body as ToolCappedDetail;
		expect(media.contentPx).toBe(MEDIA_IMAGE_CONTENT_PX);
		expect(media.media?.previewUrl).toBe("/p/x");
		expect(media.media?.filename).toBe("shot.png");
	});
	it("forwards preview image dimensions from the share metadata", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "ShareFile",
			category: "share",
			metadata: {
				downloadUrl: "/d/x",
				preview: true,
				previewUrl: "/p/x",
				filename: "shot.png",
				width: 2400,
				height: 300,
			},
		});
		const media = asSections(d).sections.find(
			(s) => s.body.kind === "capped" && s.body.cap === "media",
		)?.body as ToolCappedDetail;
		expect(media.media?.width).toBe(2400);
		expect(media.media?.height).toBe(300);
	});
	it("carries the download + copy-link ACTIONS and the metadata badges", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "ShareFile",
			category: "share",
			metadata: {
				downloadUrl: "/d/x",
				filename: "report.pdf",
				sizeFormatted: "1.2 MB",
				expiryHours: 24,
				fileCount: 3,
				format: "zip",
			},
		});
		const row = metaRowsOf(d).rows[0];
		expect(row?.text).toBe("report.pdf");
		// The two buttons are the whole point of the share card; the vlist had none.
		expect(row?.actions).toEqual([
			{ kind: "download", value: "/d/x" },
			{ kind: "copy", value: "/d/x" },
		]);
		expect(metaBadgeLabels(d)).toEqual(["1.2 MB", "zip", "3 files", "24h"]);
	});
	it("falls back to generic when no downloadUrl", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "ShareFile",
			category: "share",
			inputJson: "in",
		});
		expect(asSections(d).kind).toBe("sections");
	});
});

describe("classifyToolDetail — transfer", () => {
	it("renders a REAL determinate bar from the measurement, not ascii text", () => {
		// The bar is a structured row the render layer paints with a Progress
		// element. Carrying it as text would mean the client re-parses the producer's
		// own formatting, and the bar could neither animate nor be styled.
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "TransferFile",
			category: "transfer",
			status: "running",
			inputJson: { direction: "upload", remotePath: "/r/app.apk", localPath: "/l/app.apk" },
			metadata: {
				_structuredProgress: {
					completed: 4 * 1024 * 1024,
					total: 10 * 1024 * 1024,
					elapsedMs: 2000,
				},
			},
		});
		const bar = metaRowsOf(d).rows.find((r) => r.progress);
		expect(bar?.progress?.ratio).toBeCloseTo(0.4, 5);
		expect(bar?.progress?.percent).toBe(40);
		expect(bar?.progress?.figures).toContain("4.0 MB / 10.0 MB");
		expect(bar?.progress?.active).toBe(true);
	});

	it("marks the bar INDETERMINATE when the total is unknown", () => {
		// An upload reports no total. A ratio of 0 would paint a bar frozen at zero,
		// which reads as a stalled transfer rather than as an unmeasurable one.
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "TransferFile",
			category: "transfer",
			status: "running",
			inputJson: { direction: "upload", remotePath: "/r/f", localPath: "/l/f" },
			metadata: { _structuredProgress: { completed: 4 * 1024 * 1024, elapsedMs: 2000 } },
		});
		const bar = metaRowsOf(d).rows.find((r) => r.progress);
		expect(bar?.progress?.ratio).toBeNull();
		expect(bar?.progress?.percent).toBeUndefined();
	});

	it("suppresses the ascii text body while the real bar is showing", () => {
		// Both channels describe the same instant; showing them together would say it
		// twice, once badly.
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "TransferFile",
			category: "transfer",
			status: "running",
			inputJson: { direction: "upload", remotePath: "/r/f", localPath: "/l/f" },
			metadata: {
				_structuredProgress: { completed: 100, total: 1000, elapsedMs: 1000 },
				_streamingOutput: "upload → pad7s — 10%",
			},
		});
		const hasTextBody = asSections(d).sections.some((s) => s.body.kind === "capped");
		expect(hasTextBody).toBe(false);
	});

	it("falls back to the streamed TEXT when no measurement arrived", () => {
		// An older payload, or a producer that only wired the text channel.
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "TransferFile",
			category: "transfer",
			status: "running",
			inputJson: { direction: "upload", remotePath: "/r/f", localPath: "/l/f" },
			metadata: { _streamingOutput: "upload → pad7s — 40%\n4.0 MB / 10.0 MB" },
		});
		expect(cappedSectionBody(d, "streaming-bash").text).toContain("4.0 MB / 10.0 MB");
	});

	it("drops the bar once the call is terminal", () => {
		// A finished transfer's bar would sit at 100% forever, saying nothing the
		// summary line does not already say.
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "TransferFile",
			category: "transfer",
			status: "success",
			inputJson: { direction: "upload", remotePath: "/r/f", localPath: "/l/f" },
			outputJson: "Uploaded 10.0 MB",
			metadata: {
				_structuredProgress: { completed: 10, total: 10, elapsedMs: 1000 },
			},
		});
		expect(metaRowsOf(d).rows.some((r) => r.progress)).toBe(false);
	});

	it("uses the persisted output once the transfer finishes", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "TransferFile",
			category: "transfer",
			status: "success",
			inputJson: { direction: "upload", remotePath: "/r/app.apk", localPath: "/l/app.apk" },
			outputJson: "Uploaded 10.0 MB — /l/app.apk → pad7s:/r/app.apk in 5s, 2.0 MB/s.",
			metadata: { transferDirection: "upload", deviceName: "pad7s" },
		});
		expect(cappedSectionBody(d, "term").text).toContain("Uploaded 10.0 MB");
	});

	it("badges the direction, device, size and rate", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "TransferFile",
			category: "transfer",
			status: "success",
			inputJson: { direction: "download", remotePath: "/r/f", localPath: "/l/f" },
			outputJson: "done",
			metadata: {
				transferDirection: "download",
				deviceName: "pad7s",
				bytesFormatted: "48.0 MB",
				rateFormatted: "2.1 MB/s",
				filesTransferred: 12,
				recursive: true,
			},
		});
		expect(metaBadgeLabels(d)).toEqual([
			"download",
			"pad7s",
			"recursive",
			"48.0 MB",
			"2.1 MB/s",
			"12 files",
		]);
	});

	it("orders the path row source → destination per direction", () => {
		// An arrow is the only thing telling the reader which side is which, so it
		// must follow the transfer, not the argument order.
		const up = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "TransferFile",
			category: "transfer",
			status: "success",
			inputJson: { direction: "upload", remotePath: "/remote/x", localPath: "/local/x" },
			outputJson: "ok",
		});
		expect(metaTexts(up)).toContain("/local/x  →  /remote/x");
		const down = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "TransferFile",
			category: "transfer",
			status: "success",
			inputJson: { direction: "download", remotePath: "/remote/x", localPath: "/local/x" },
			outputJson: "ok",
		});
		expect(metaTexts(down)).toContain("/remote/x  →  /local/x");
	});

	it("keeps the header and reports the failure when a transfer errors with no body", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "TransferFile",
			category: "transfer",
			status: "fail",
			inputJson: { direction: "upload", remotePath: "/r/f", localPath: "/l/f" },
		});
		expect(metaTexts(d)).toContain("/l/f  →  /r/f");
		expect((sectionBody(d, "error") as ToolErrorDetail).kind).toBe("error");
	});

	it("shows a failure message exactly once, not beside a placeholder", () => {
		// The trailing `withErrorSection` pass appends `errorMessage` to whatever the
		// classifier returned, so emitting our own placeholder unconditionally would
		// print the failure twice.
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "TransferFile",
			category: "transfer",
			status: "fail",
			inputJson: { direction: "upload", remotePath: "/r/f", localPath: "/l/f" },
			errorMessage: "Device pad7s is offline.",
		});
		const errors = asSections(d).sections.filter((s) => s.body.kind === "error");
		expect(errors.length).toBe(1);
		expect((errors[0]?.body as ToolErrorDetail).text).toBe("Device pad7s is offline.");
	});
});

describe("classifyToolDetail — recall", () => {
	it("keeps each search hit as its own entry (role badge + title + snippet)", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Recall",
				category: "recall",
				metadata: {
					action: "search",
					queries: ["find me"],
					results: [
						{ id: "1", role: "user", narratorTitle: "Chat A", snippet: "hello" },
						{ id: "2", role: "assistant", snippet: "world" },
					],
				},
			}),
			"structured",
		);
		expect(d.kind).toBe("structured");
		expect(d.badgeRows).toBe(1);
		// Flattening these into body lines lost the role, title and id structure.
		expect(d.entries?.[0]).toEqual({
			title: "Chat A",
			badges: [{ label: "user", color: "blue" }],
			meta: "1",
			snippet: "hello",
			tone: "indigo",
		});
		expect(d.entries?.[1]?.title).toBe("assistant");
		expect(d.entries?.[1]?.snippet).toBe("world");
		expect(d.badges).toEqual([{ label: "find me", color: "cyan" }]);
	});
	it("keeps seq + model for a read_conversation recall", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Recall",
				category: "recall",
				metadata: {
					action: "read_conversation",
					narratorTitle: "Chat A",
					model: "opus",
					messages: [{ role: "user", seq: 4, text: "hi" }],
				},
			}),
			"structured",
		);
		expect(d.badges).toEqual([
			{ label: "Chat A", color: "gray" },
			{ label: "opus", color: "gray" },
		]);
		expect(d.entries?.[0]?.meta).toBe("seq 4");
		expect(d.entries?.[0]?.snippet).toBe("hi");
	});
	it("produces a no-results body when empty", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Recall",
				category: "recall",
				metadata: { action: "search", results: [] },
			}),
			"structured",
		);
		expect(d.bodyLines).toEqual(["No results"]);
	});
	it("falls back to generic without recall metadata", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Recall",
			category: "recall",
			inputJson: "in",
		});
		expect(asSections(d).kind).toBe("sections");
	});
});

describe("classifyToolDetail — skill", () => {
	it("maps parsed skill content to a MARKDOWN skill cap plus a name badge", () => {
		const output = `<skill_content name="demo">\n\nHello\nWorld\nBase directory for this skill: /x`;
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Skill",
			category: "skill",
			outputJson: output,
		});
		const body = asSections(d).sections.find(
			(s) => s.body.kind === "capped" && s.body.cap === "skill",
		)?.body as ToolCappedDetail;
		expect(body.contentLines).toBeGreaterThanOrEqual(3);
		// Skill bodies are markdown documents; monospace was a visible downgrade.
		expect(body.format).toBe("markdown");
		expect(metaBadgeLabels(d)).toEqual(["demo"]);
	});
	it("falls back to generic without skill_content", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Skill",
			category: "skill",
			outputJson: "no marker",
		});
		expect(asSections(d).kind).toBe("sections");
	});
});

describe("classifyToolDetail — browser", () => {
	it("maps screenshot action to a media cap under an action/url header", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Browser",
			category: "browser",
			inputJson: { action: "screenshot", url: "https://x.dev" },
			metadata: { previewUrl: "/p/x", sessionId: "s-1" },
		});
		const media = asSections(d).sections.find(
			(s) => s.body.kind === "capped" && s.body.cap === "media",
		)?.body as ToolCappedDetail;
		expect(media.media?.previewUrl).toBe("/p/x");
		expect(metaBadgeLabels(d)).toEqual(["screenshot", "s-1"]);
		expect(metaRowsOf(d).rows.find((r) => r.href)?.href).toBe("https://x.dev");
	});
	it("forwards screenshot dimensions from the browser metadata", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Browser",
			category: "browser",
			inputJson: { action: "screenshot", url: "https://x.dev" },
			metadata: { previewUrl: "/p/x", sessionId: "s-1", width: 1440, height: 810 },
		});
		const media = asSections(d).sections.find(
			(s) => s.body.kind === "capped" && s.body.cap === "media",
		)?.body as ToolCappedDetail;
		expect(media.media?.width).toBe(1440);
		expect(media.media?.height).toBe(810);
	});
	it("returns error on failed browser action with no output", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Browser",
				category: "browser",
				status: "fail",
				inputJson: { action: "click" },
			}),
			"error",
		);
		expect(d.kind).toBe("error");
	});
});

describe("classifyToolDetail — knowledge", () => {
	it("maps KnowledgeSearch results to linked entries with tag badges", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "KnowledgeSearch",
				category: "knowledge",
				metadata: {
					results: [
						{ id: "e1", title: "Entry One", tags: ["a", "b"], snippet: "snip one" },
						{ id: "e2", title: "Entry Two", snippet: "snip two" },
					],
				},
			}),
			"structured",
		);
		expect(d.kind).toBe("structured");
		expect(d.entries?.[0]?.title).toBe("Entry One");
		// The entry link was missing entirely; tags were flattened into text.
		expect(d.entries?.[0]?.href).toBe("/knowledge/e1");
		expect(d.entries?.[0]?.badges).toEqual([
			{ label: "#a", color: "grape" },
			{ label: "#b", color: "grape" },
		]);
		expect(d.entries?.[0]?.snippet).toBe("snip one");
		expect(d.entries?.[1]?.title).toBe("Entry Two");
	});
	it("maps KnowledgeRead to a MARKDOWN knowledge cap with a linked header", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "KnowledgeRead",
			category: "knowledge",
			outputJson: "doc\nbody",
			metadata: { entryId: "e9", title: "Doc", tags: ["x"], keywords: ["kw"] },
		});
		const body = asSections(d).sections.find(
			(s) => s.body.kind === "capped" && s.body.cap === "knowledge",
		)?.body as ToolCappedDetail;
		expect(body.contentLines).toBe(4); // 2 + 2
		expect(body.format).toBe("markdown");
		const rows = metaRowsOf(d).rows;
		expect(rows[0]?.text).toBe("Doc");
		expect(rows[0]?.href).toBe("/knowledge/e9");
		expect(metaBadgeLabels(d)).toEqual(["#x", "kw"]);
	});
});

describe("classifyToolDetail — taskOutput", () => {
	it("surfaces the task badges and the retrieval error", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "TaskOutput",
			category: "taskOutput",
			inputJson: { task_id: "t-3", task_type: "explore", timeout: 5000 },
			outputJson: { status: "failed", retrieval_status: "expired", _text: "partial" },
		});
		expect(metaBadgeLabels(d)).toEqual(["t-3", "failed", "explore", "timeout: 5s"]);
		expect((sectionBody(d, "error") as ToolErrorDetail).text).toBe("expired");
	});
});

describe("classifyToolDetail — plan deny feedback", () => {
	/** The (unlabelled) feedback body of a denied plan. */
	function denyBody(detail: ToolDetailData | null): ToolErrorDetail {
		const found = asSections(detail).sections.find((s) => s.body?.kind === "error");
		if (!found) throw new Error(`no feedback body in ${JSON.stringify(detail)}`);
		return found.body as ToolErrorDetail;
	}

	it("keeps the denial feedback above the plan body", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "ExitPlanMode",
			category: "plan",
			inputJson: { plan: "the plan" },
			metadata: { denyFeedback: "needs more detail" },
		});
		expect(denyBody(d).text).toBe("needs more detail");
		expect((sectionBody(d, "plan") as ToolCappedDetail).text).toBe("the plan");
	});

	// An "Error" heading would file the reviewer's own note under tool failures;
	// the chunked PlanDetail prints it bare. `status: "fail"` is required for the
	// column to be read at all, and without it this would pass because NO feedback
	// section was produced rather than because the one produced is unlabelled.
	it("leaves the feedback body unlabelled", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "ExitPlanMode",
			category: "plan",
			status: "fail",
			inputJson: { plan: "the plan" },
			denyMessage: "needs more detail",
		});
		expect(denyBody(d).text).toBe("needs more detail");
		expect(hasSection(d, "error")).toBe(false);
	});

	// `permissionDenyMessage` is a TOP-LEVEL tool-call column, NOT a `_metadata`
	// key: enrichToolUseBlocks copies it onto the block itself. Reading only the
	// metadata keys is why a plan denied with typed feedback rendered as a bare
	// collapsed plan — the user's own words were dropped with no error anywhere.
	it("reads the denial feedback from the top-level denyMessage field", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "ExitPlanMode",
			category: "plan",
			status: "fail",
			inputJson: { plan: "the plan" },
			denyMessage: "split step 2 first",
		});
		expect(denyBody(d).text).toBe("split step 2 first");
		expect((sectionBody(d, "plan") as ToolCappedDetail).text).toBe("the plan");
	});

	// The feedback is the reviewer's note back to the model, not a tool failure —
	// the chunked PlanDetail paints it yellow, so the tone has to travel.
	it("marks the feedback as a warning, not an error", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "ExitPlanMode",
			category: "plan",
			status: "fail",
			inputJson: { plan: "the plan" },
			denyMessage: "split step 2 first",
		});
		expect(denyBody(d).tone).toBe("warning");
	});

	// A deny with NO feedback stores an English system placeholder. Presenting it
	// would attribute a system string to the user, so it counts as "no feedback".
	it("drops the system placeholder written when no feedback was typed", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "ExitPlanMode",
			category: "plan",
			status: "fail",
			inputJson: { plan: "the plan" },
			denyMessage: "Permission denied by user",
		});
		expect(bodyOfKind(d, "capped").kind).toBe("capped");
		expect(bodyOfKind(d, "capped").text).toBe("the plan");
	});

	// `failReprocessedPendingPermission` DOES write this into the column (unlike the
	// placeholder above, which only reaches `errorMessage`). Its detail text varies,
	// so it is matched by prefix.
	it("drops a reprocessing-failure message, whatever detail it carries", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "ExitPlanMode",
			category: "plan",
			status: "fail",
			inputJson: { plan: "the plan" },
			denyMessage: "Permission reprocessing failed: target narrator is frozen",
		});
		expect(bodyOfKind(d, "capped").kind).toBe("capped");
	});

	// The column is NOT denial-only: narrator-permission stores `denyMessage ||
	// feedbackText`, so an APPROVAL with a typed note lands in the same field (20 of
	// this repository's 162 ExitPlanMode rows with the column set are approvals).
	// Rendering those as denial feedback tells the reader their accepted plan was
	// rejected — and the plan body is identical either way, so nothing else in the
	// card contradicts it.
	it("ignores the column on an APPROVED plan, where it holds approval feedback", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "ExitPlanMode",
			category: "plan",
			status: "success",
			inputJson: { plan: "the plan" },
			denyMessage: "批准。方案分析透彻",
		});
		expect(bodyOfKind(d, "capped").kind).toBe("capped");
		expect(bodyOfKind(d, "capped").text).toBe("the plan");
	});

	// A metadata copy (older rows / fixtures) still wins, so nothing regresses for
	// payloads that already carried it there. Unlike the raw column, `denyFeedback`
	// names a denial, so it is honoured without a status gate.
	it("prefers a metadata copy over the top-level field", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "ExitPlanMode",
			category: "plan",
			status: "fail",
			inputJson: { plan: "the plan" },
			metadata: { denyFeedback: "from metadata" },
			denyMessage: "from column",
		});
		expect(denyBody(d).text).toBe("from metadata");
	});

	// A denied call's `errorMessage` is the full "[计划模式] 用户拒绝了…" template,
	// and `withErrorSection` appends it as a SECOND, red, "Error"-labelled section
	// whenever `outputJson` is null — the same feedback twice, in two colours. Real
	// denials always persist an output (`_text` + `_metadata`), which is the only
	// reason it does not happen today; this pins the shape so the invariant is not
	// left resting on another field being non-null.
	it("shows the feedback exactly once on a realistic denied call", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "ExitPlanMode",
			category: "plan",
			status: "fail",
			inputJson: { plan: "the plan" },
			outputJson: { _text: "[计划模式] 用户拒绝了你的计划…", _metadata: { execDurationMs: 0 } },
			denyMessage: "split step 2 first",
			errorMessage: "[计划模式] 用户拒绝了你的计划，并附带以下反馈：split step 2 first",
		});
		const sections = asSections(d).sections;
		expect(sections.map((s) => s.label)).toEqual([undefined, "plan"]);
		expect(denyBody(d).text).toBe("split step 2 first");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// `textTruncated` per body.
//
// The flag makes the measure layer reserve the FULL cap for a body that is only a
// prefix, so a card's first painted height is already its final one. Each capped
// box must therefore carry the flag of ITS OWN source: a bash card whose command
// fits but whose output was cut has to reserve the cap for the output box only.
// These pin down the three bodies that read from the OUTPUT while the flag was
// wired to the input (or missing entirely).
// ─────────────────────────────────────────────────────────────────────────────

/** A truncated string leaf as the server's projection emits it. */
function leaf(preview: string, fullLength = 40_000) {
	return { _truncated: true, preview, fullLength };
}

describe("classifyToolDetail — textTruncated is per body", () => {
	it("flags a truncated bash OUTPUT without touching the command box", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Bash",
			category: "bash",
			inputJson: { command: "echo hi" },
			outputJson: { _text: leaf("hi\nthere") },
		});
		expect((sectionBody(d, "command") as ToolCappedDetail).textTruncated).toBeUndefined();
		expect((sectionBody(d, "output") as ToolCappedDetail).textTruncated).toBe(true);
	});

	it("flags a truncated bash COMMAND without touching the output box", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Bash",
			category: "bash",
			inputJson: { command: leaf("echo hi") },
			outputJson: "hi",
		});
		expect((sectionBody(d, "command") as ToolCappedDetail).textTruncated).toBe(true);
		expect((sectionBody(d, "output") as ToolCappedDetail).textTruncated).toBeUndefined();
	});

	it("flags a truncated STREAMING bash body", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Bash",
			category: "bash",
			inputJson: { command: "sleep 1" },
			metadata: { _streamingOutput: leaf("partial...") },
		});
		const out = sectionBody(d, "output") as ToolCappedDetail;
		expect(out.cap).toBe("streaming-bash");
		expect(out.textTruncated).toBe(true);
	});

	it("flags a truncated skill body (carved from the OUTPUT, not the input)", () => {
		const output = `<skill_content name="demo">\n\nHello\nWorld\nBase directory for this skill: /x`;
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Skill",
			category: "skill",
			inputJson: { name: "demo" },
			outputJson: { _text: leaf(output) },
		});
		const body = asSections(d).sections.find(
			(s) => s.body.kind === "capped" && s.body.cap === "skill",
		)?.body as ToolCappedDetail;
		expect(body.textTruncated).toBe(true);
	});

	it("flags a truncated KnowledgeRead body", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "KnowledgeRead",
			category: "knowledge",
			outputJson: { _text: leaf("doc\nbody"), _metadata: { entryId: "e9" } },
			metadata: { entryId: "e9", title: "Doc" },
		});
		const body = asSections(d).sections.find(
			(s) => s.body.kind === "capped" && s.body.cap === "knowledge",
		)?.body as ToolCappedDetail;
		expect(body.textTruncated).toBe(true);
	});

	it("leaves the flag absent for complete payloads", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Bash",
			category: "bash",
			inputJson: { command: "echo hi" },
			outputJson: "hi",
		});
		expect((sectionBody(d, "command") as ToolCappedDetail).textTruncated).toBeUndefined();
		expect((sectionBody(d, "output") as ToolCappedDetail).textTruncated).toBeUndefined();
	});
});

describe("classifyToolDetail — trailing error section", () => {
	it("appends the tool error when nothing else displays it", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Bash",
			category: "bash",
			status: "fail",
			inputJson: { command: "bad" },
			errorMessage: "exit 127",
		});
		expect((sectionBody(d, "error") as ToolErrorDetail).text).toBe("exit 127");
	});
	it("omits it once a real output body exists (chunked parity)", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Bash",
			category: "bash",
			status: "fail",
			inputJson: { command: "bad" },
			outputJson: "some output",
			errorMessage: "exit 127",
		});
		expect(hasSection(d, "error")).toBe(false);
	});
});

describe("classifyToolDetail — streaming input", () => {
	it("previews the streamed written content with its path", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Write",
			category: "file",
			isStreaming: true,
			inputJson: {
				_streamingFilePath: "/src/a.ts",
				_streamingFieldName: "content",
				_streamingFieldValue: "const a = 1;",
			},
		});
		expect(metaTexts(d)).toEqual(["/src/a.ts"]);
		const body = asSections(d).sections.find((s) => s.body.kind === "capped")
			?.body as ToolCappedDetail;
		expect(body.text).toBe("const a = 1;");
	});
	it("previews a provisional Edit diff while streaming", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Edit",
			category: "file",
			isStreaming: true,
			inputJson: {
				_streamingFields: { file_path: "/src/a.ts", old_string: "a" },
				_streamingFieldName: "new_string",
				_streamingFieldValue: "b",
			},
		});
		const body = cappedSectionBody(d, "diff");
		// Unified-diff markers are SINGLE characters (chunked parity), not "- ".
		expect(JSON.parse(body.text!)).toEqual({ old_string: "a", new_string: "b" });
		expect(diffRows(body).map((line) => [line.type, line.content])).toEqual([
			["removed", "a"],
			["added", "b"],
		]);
		// new_string is arriving → the replacing phase, so positions are real.
		expect(body.diffDocument?.startLine).toBeUndefined();
		expect(diffDocumentLineNoWidth(body.diffDocument!)).toBe(2);
	});
	it("shows provisional line numbers while a streaming Edit is still matching", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Edit",
			category: "file",
			isStreaming: true,
			inputJson: {
				_streamingFields: { file_path: "/src/a.ts" },
				_streamingFieldName: "old_string",
				_streamingFieldValue: "a\nb",
			},
		});
		const body = cappedSectionBody(d, "diff");
		// Nothing to replace yet: the preview is all context, and the numbers are
		// flagged provisional with the `xx` prefix (chunked EditDiffBlock parity).
		expect(diffRows(body).every((line) => line.type === "context")).toBe(true);
		expect(body.diffDocument?.oldSource.range.originKnown).toBe(false);
	});
	it("previews the streamed shell command", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Bash",
				category: "bash",
				isStreaming: true,
				inputJson: { _streamingFieldName: "command", _streamingFieldValue: "ls -la" },
			}),
			"capped",
		);
		expect(d.cap).toBe("streaming-bash");
		expect(d.text).toBe("$ ls -la");
	});
	it("previews a streamed plan as markdown", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "ExitPlanMode",
				category: "plan",
				isStreaming: true,
				inputJson: { _streamingFieldName: "plan", _streamingFieldValue: "# Step" },
			}),
			"capped",
		);
		expect(d.cap).toBe("plan");
		expect(d.format).toBe("markdown");
	});
	it("renders nothing extra for read/search (header already says it)", () => {
		expect(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Read",
				category: "read",
				isStreaming: true,
				inputJson: { _streamingFieldName: "file_path", _streamingFieldValue: "/a" },
			})?.kind,
		).toBe("sections");
	});

	it("previews streamed content that arrived BEFORE its file_path", () => {
		// Write commonly streams `content` first. Gating the whole preview on the
		// path left the card blank for the entire write, and — worse — let the
		// classifier fall through to classifyFile (see the leak test below).
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Write",
				category: "file",
				isStreaming: true,
				inputJson: {
					_streamingChars: 1429,
					_streamingFieldName: "content",
					_streamingFieldValue: "# Heading\nbody",
				},
			}),
			"capped",
		);
		expect(d.cap).toBe("streaming");
		expect(d.text).toBe("# Heading\nbody");
	});

	it("reads a settled file_path off the merged input, not just the markers", () => {
		// A live chunk MERGES into an already-persisted input (mergeToolFields), so
		// the real `file_path` can sit on the input while the markers only describe
		// the field in flight. Without the fallback the path row and the syntax
		// language were both lost.
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Write",
			category: "file",
			isStreaming: true,
			inputJson: {
				file_path: "/src/a.ts",
				_streamingChars: 90,
				_streamingFieldName: "content",
				_streamingFieldValue: "const a = 1;",
			},
		});
		expect(metaTexts(d)).toEqual(["/src/a.ts"]);
		expect(cappedSectionBody(d, "streaming").codeLangPath).toBe("/src/a.ts");
	});

	it("NEVER leaks internal _streaming* markers as a raw JSON body", () => {
		// The regression: streaming used to fall through to the category classifiers
		// when it had no preview to show. A Write whose `content` outran its
		// `file_path` has no real `content` field, so classifyFile hit its
		// resolveDisplayText fallback and painted NarraFork's own stream bookkeeping
		// into the card as JSON, labelled "Input".
		const leaky = [
			{ _streamingChars: 12 },
			{ _streamingChars: 12, _streamingFilePath: "/a.ts" },
			{ _streamingChars: 12, _streamingFields: { file_path: "/a.ts" } },
		];
		for (const inputJson of leaky) {
			for (const [toolName, category] of [
				["Write", "file"],
				["Edit", "file"],
				["Bash", "bash"],
				["Agent", "agent"],
				["KnowledgeSearch", "knowledge"],
				["SomeMcpTool", "generic"],
			] as const) {
				const d = classifyToolDetail({
					previewId: "classifier-fixture",
					toolName,
					category,
					isStreaming: true,
					inputJson,
				});
				expect(JSON.stringify(d) ?? "").not.toContain("_streaming");
			}
		}
	});
});

describe("classifyToolDetail — render-only body text passthrough (Approach B)", () => {
	it("read/code carries the real output text", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Read",
				category: "read",
				outputJson: "line1\nline2",
			}),
			"capped",
		);
		expect(d.text).toBe("line1\nline2");
	});
	it("Write/file carries the written content", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Write",
				category: "file",
				inputJson: { content: "const x = 1;\nconst y = 2;" },
			}),
			"capped",
		);
		expect(d.text).toBe("const x = 1;\nconst y = 2;");
	});
	it("Edit/diff composes a unified +/- diff body as the plain fallback", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Edit",
				category: "file",
				inputJson: { old_string: "a", new_string: "b" },
			}),
			"capped",
		);
		// Single-character markers, and the structured rows travel alongside.
		expect(JSON.parse(d.text!)).toEqual({ old_string: "a", new_string: "b" });
		expect(diffRows(d)).toHaveLength(2);
	});
	it("keeps unchanged lines as context in the plain fallback text too", () => {
		const d = bodyOfKind(
			classifyToolDetail({
				previewId: "classifier-fixture",
				toolName: "Edit",
				category: "file",
				inputJson: { old_string: "keep\ndrop", new_string: "keep\nadd" },
			}),
			"capped",
		);
		// A leading space marks context — the unchanged line is not duplicated.
		expect(diffRows(d).map((line) => [line.type, line.content])).toEqual([
			["context", "keep"],
			["removed", "drop"],
			["added", "add"],
		]);
	});
	it("bash carries the command and output in their own sections", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Bash",
			category: "bash",
			inputJson: { command: "ls -la" },
			outputJson: "file1\nfile2",
		});
		expect((sectionBody(d, "command") as ToolCappedDetail).text).toBe("$ ls -la");
		expect((sectionBody(d, "output") as ToolCappedDetail).text).toBe("file1\nfile2");
	});
	it("generic carries input + output text", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Agent",
			category: "agent",
			inputJson: "the prompt",
			outputJson: "the result",
		});
		expect(bodyOfKind(d, "capped").text).toBe("the prompt");
		expect(
			(asSections(d).sections.find((part) => part.key === "output.main")!.body as ToolCappedDetail)
				.text,
		).toBe("the result");
	});
	it("media caps carry no text (contentPx only) but do carry a media ref", () => {
		const d = classifyToolDetail({
			previewId: "classifier-fixture",
			toolName: "Read",
			category: "read",
			metadata: { isImage: true, filePath: "/tmp/pic.png", sizeKB: 12, imageFormat: "png" },
		});
		const media = asSections(d).sections.find(
			(s) => s.body.kind === "capped" && s.body.cap === "media",
		)?.body as ToolCappedDetail;
		expect(media.text).toBeUndefined();
		expect(media.contentPx).toBe(MEDIA_IMAGE_CONTENT_PX);
		expect(media.media?.filePath).toBe("/tmp/pic.png");
		expect(media.media?.filename).toBe("pic.png");
		expect(media.media?.sizeKB).toBe(12);
		expect(media.media?.imageFormat).toBe("png");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveFileDiffStats — the `+N -N` figure's two sources, and the cases where it
// must refuse to answer.
//
// The refusals are the point of these tests. A wrong line count looks exactly as
// authoritative as a right one, so every path that cannot know the answer has to
// return undefined rather than a plausible-looking number.
// ─────────────────────────────────────────────────────────────────────────────

/** A truncated leaf as the server's field-level projection emits it. */
const truncatedLeaf = (preview: string) => ({
	_truncated: true as const,
	preview,
	fullLength: 99_999,
});

describe("canonical sections and source lifecycle", () => {
	const body = (detail: ToolDetailData | null, source: string) => {
		const found = detail?.sections.find(
			(part) => part.body.kind === "capped" && part.body.source === source,
		)?.body;
		if (!found || found.kind !== "capped") throw new Error(`Missing ${source}`);
		return found;
	};

	it.each([
		["Bash", "bash"],
		["Grep", "search"],
		["WebFetch", "webFetch"],
		["TaskOutput", "taskOutput"],
		["Await", "await"],
		["Send", "send"],
		["StartPipeline", "pipeline"],
		["Terminal", "terminal"],
		["Browser", "browser"],
		["KnowledgeRead", "knowledge"],
	])("%s keeps an empty output and its own truncation flag", (toolName, category) => {
		for (const truncated of [false, true]) {
			const detail = classifyToolDetail({
				toolUseId: "empty-output",
				toolName,
				category,
				status: "success",
				inputJson: {
					command: "",
					message: "",
					rule: "",
					action: "read",
					type: "bash",
					mode: "readability",
				},
				outputJson: truncated ? { _truncated: true, preview: "", fullLength: 1000 } : "",
			});
			const output = body(detail, "output.main");
			expect(output.text).toBe("");
			expect(output.textTruncated === true).toBe(truncated);
			expect(output.id).toBe(toolBodyId("empty-output", "output.main"));
			expect(output.live).toBe(false);
		}
	});

	it("Send without a message omits that section without evaluating an absent string", () => {
		const detail = classifyToolDetail({
			toolUseId: "send-no-input",
			toolName: "Send",
			category: "send",
			outputJson: "reply",
		});
		expect(detail?.sections.some((section) => section.key === "input.message")).toBe(false);
		expect(body(detail, "output.main").text).toBe("reply");
	});

	it("resolves current > settled > formal by presence, including empty strings", () => {
		const input = {
			content: "formal",
			new_string: "formal-new",
			file_path: "/formal.ts",
			_streamingFields: { content: "settled", new_string: "settled-new" },
			_streamingFieldName: "new_string",
			_streamingFieldValue: "",
		};
		const fields = toolInputFieldView(input);
		expect(fields).toEqual({ content: "settled", new_string: "", file_path: "/formal.ts" });
		expect(input.new_string).toBe("formal-new");
	});

	it("keeps the same Write body through path arrival, metadata and completion", () => {
		const source = "input.content";
		const states = [
			{
				status: "running",
				isStreaming: true,
				inputJson: { _streamingFieldName: "content", _streamingFieldValue: "" },
			},
			{
				status: "running",
				isStreaming: true,
				inputJson: { _streamingFieldName: "content", _streamingFieldValue: "hello" },
			},
			{
				status: "running",
				isStreaming: true,
				inputJson: {
					_streamingFields: { content: "hello" },
					_streamingFieldName: "file_path",
					_streamingFieldValue: "/late.ts",
				},
			},
			{ status: "success", inputJson: { content: "hello", file_path: "/late.ts" } },
		];
		const bodies = states.map((state) =>
			body(
				classifyToolDetail({
					toolUseId: "write-one",
					toolName: "Write",
					category: "file",
					...state,
				}),
				source,
			),
		);
		expect(new Set(bodies.map((b) => b.id))).toEqual(new Set([toolBodyId("write-one", source)]));
		expect(bodies.map((b) => b.live)).toEqual([true, true, false, false]);
		expect(bodies.map((b) => b.text)).toEqual(["", "hello", "hello", "hello"]);
		expect(bodies.every((b) => b.format === "code")).toBe(true);
	});

	it("separates input and output live state and lets terminal status win", () => {
		const common = {
			toolUseId: "bash-one",
			toolName: "Bash",
			category: "bash",
			inputJson: { command: "formal", _streamingFieldName: "command", _streamingFieldValue: "ls" },
			metadata: { _streamingOutput: "stdout" },
		};
		const streaming = classifyToolDetail({ ...common, status: "running", isStreaming: true });
		const executing = classifyToolDetail({ ...common, status: "running", isStreaming: false });
		const done = classifyToolDetail({
			...common,
			status: "success",
			isStreaming: true,
			outputJson: "",
		});
		for (const [detail, inputLive, outputLive] of [
			[streaming, true, false],
			[executing, false, true],
			[done, false, false],
		] as const) {
			expect(body(detail, "input.command").live).toBe(inputLive);
			expect(body(detail, "output.main").live).toBe(outputLive);
			expect(body(detail, "input.command").id).not.toBe(body(detail, "output.main").id);
		}
		expect(body(done, "output.main").text).toBe("");
	});

	it("Edit matching, replacing and empty replacement share input.edit", () => {
		const context = {
			toolUseId: "edit-one",
			toolName: "Edit",
			category: "file",
			status: "running",
			isStreaming: true,
		};
		const matching = body(
			classifyToolDetail({
				...context,
				inputJson: { _streamingFieldName: "old_string", _streamingFieldValue: "keep\ndrop" },
			}),
			"input.edit",
		);
		const replacing = body(
			classifyToolDetail({
				...context,
				inputJson: {
					new_string: "stale",
					_streamingFields: { old_string: "keep\ndrop", new_string: "settled-stale" },
					_streamingFieldName: "new_string",
					_streamingFieldValue: "",
				},
			}),
			"input.edit",
		);
		const done = body(
			classifyToolDetail({
				...context,
				status: "success",
				isStreaming: false,
				inputJson: { old_string: "keep\ndrop", new_string: "", file_path: "/late.ts" },
			}),
			"input.edit",
		);
		expect([matching.id, replacing.id, done.id]).toEqual(
			Array(3).fill(toolBodyId("edit-one", "input.edit")),
		);
		expect(diffRows(matching).every((row) => row.type === "context")).toBe(true);
		expect(diffRows(replacing).every((row) => row.type === "removed")).toBe(true);
		expect(replacing.diffDocument?.newSource.text).toBe("");
		expect(replacing.followTarget.kind).toBe("diff-row");
		expect(replacing.diffDocument?.focus?.side).toBe("old");
		expect(done.live).toBe(false);
	});

	it("forwards both source ranges without selecting a 500-row viewport", () => {
		const text = Array.from({ length: 1600 }, (_, i) => `r${i}`).join("\n");
		const range = createSourceText(text, { epoch: "same-epoch", originKnown: false }).range;
		const model = body(
			classifyToolDetail({
				toolUseId: "long-edit",
				toolName: "Edit",
				category: "file",
				status: "running",
				isStreaming: true,
				inputJson: {
					_streamingFields: { old_string: text },
					_streamingFieldName: "new_string",
					_streamingFieldValue: `${text}!`,
					_streamingFieldRanges: {
						old_string: range,
						new_string: {
							...range,
							endOffset: range.endOffset + 1,
							endColumn: range.endColumn + 1,
						},
					},
				},
			}),
			"input.edit",
		);
		expect(model.diffDocument?.totalRows).toBeGreaterThan(500);
		expect(model.diffDocument?.oldSource.range).toEqual(range);
		expect(model.diffDocument?.focus?.line).toBe(1599);
		expect(model.diffDocument?.focus?.epoch).toBe("same-epoch");
		expect("diffLines" in model).toBe(false);
		expect("lines" in model.diffDocument!).toBe(false);
	});

	it("generic has ordinary sections and source identities stay distinct across calls", () => {
		const classify = (toolUseId: string) =>
			classifyToolDetail({
				toolUseId,
				toolName: "Unknown",
				category: "generic",
				inputJson: { content: "same" },
				outputJson: "same",
			});
		const first = asSections(classify("one"));
		const second = asSections(classify("two"));
		expect(first.sections.map((s) => s.key)).toEqual(["input.arguments", "output.main"]);
		expect(first.sections.every((s) => s.body.kind === "capped")).toBe(true);
		expect(body(first, "output.main").id).not.toBe(body(second, "output.main").id);
	});
});

describe("resolveFileDiffStats — tool metadata (authoritative)", () => {
	it("reads the counts the tool wrote, for both Write and Edit", () => {
		expect(
			resolveFileDiffStats(
				"Edit",
				{ old_string: "a", new_string: "b" },
				{
					linesAdded: 12,
					linesRemoved: 3,
				},
			),
		).toEqual({ added: 12, removed: 3 });
		expect(
			resolveFileDiffStats("Write", { content: "x" }, { linesAdded: 240, linesRemoved: 0 }),
		).toEqual({ added: 240, removed: 0 });
	});

	it("reads StructSed's counts, which the server measures at execution", () => {
		// A structural rewrite changes the file as much as the equivalent Edit, so its
		// folded row carries the same figure rather than reading as a lesser step.
		expect(
			resolveFileDiffStats(
				"StructSed",
				{ command: "replace", symbol: "handler" },
				{ linesAdded: 8, linesRemoved: 20 },
			),
		).toEqual({ added: 8, removed: 20 });
	});

	it("refuses to invent a figure for StructSed without metadata", () => {
		// Its input names a range, never the text being replaced, so there is nothing to
		// diff locally. Undefined is the only honest answer.
		expect(
			resolveFileDiffStats("StructSed", { command: "delete", address: "10,20" }, {}),
		).toBeUndefined();
	});

	it("prefers metadata over a local computation", () => {
		// The local diff of these two strings would say 1/1; metadata wins because only
		// the server saw the untruncated payload.
		expect(
			resolveFileDiffStats(
				"Edit",
				{ old_string: "a", new_string: "b" },
				{
					linesAdded: 7,
					linesRemoved: 5,
				},
			),
		).toEqual({ added: 7, removed: 5 });
	});

	it("keeps a genuine zero-change measurement", () => {
		// Distinct from "unknown": the tool measured this and found no line changes.
		expect(
			resolveFileDiffStats("Write", { content: "x" }, { linesAdded: 0, linesRemoved: 0 }),
		).toEqual({ added: 0, removed: 0 });
	});

	/**
	 * A half-written pair is rejected rather than read with the missing half as zero,
	 * which would understate one direction of the change without any signal.
	 */
	it("rejects a partial or malformed metadata pair", () => {
		expect(resolveFileDiffStats("Write", { content: "x" }, { linesAdded: 5 })).toBeUndefined();
		expect(resolveFileDiffStats("Write", { content: "x" }, { linesRemoved: 5 })).toBeUndefined();
		expect(
			resolveFileDiffStats("Write", { content: "x" }, { linesAdded: "5", linesRemoved: 0 }),
		).toBeUndefined();
		expect(
			resolveFileDiffStats(
				"Write",
				{ content: "x" },
				{
					linesAdded: Number.NaN,
					linesRemoved: 0,
				},
			),
		).toBeUndefined();
		expect(
			resolveFileDiffStats("Write", { content: "x" }, { linesAdded: -1, linesRemoved: 0 }),
		).toBeUndefined();
	});
});

describe("resolveFileDiffStats — Edit local fallback", () => {
	it("diffs old_string against new_string when both are complete", () => {
		expect(
			resolveFileDiffStats("Edit", { old_string: "a\nb\nc", new_string: "a\nB\nc" }, null),
		).toEqual({ added: 1, removed: 1 });
	});

	/**
	 * A truncated side is an 8KB PREFIX of a longer string. Diffing prefixes yields a
	 * smaller count with nothing marking it as partial, so the figure is withheld.
	 */
	it("refuses when either side was truncated in transport", () => {
		expect(
			resolveFileDiffStats("Edit", { old_string: truncatedLeaf("a"), new_string: "b" }, null),
		).toBeUndefined();
		expect(
			resolveFileDiffStats("Edit", { old_string: "a", new_string: truncatedLeaf("b") }, null),
		).toBeUndefined();
	});

	/**
	 * `old_string: ""` is Edit's whole-file OVERWRITE mode. It has the same missing
	 * baseline a Write does — the previous content is not in the input — so the client
	 * cannot tell a 3-line change from a wholesale replacement.
	 */
	it("refuses Edit's overwrite mode, which has no baseline in the input", () => {
		expect(
			resolveFileDiffStats("Edit", { old_string: "", new_string: "a\nb\nc" }, null),
		).toBeUndefined();
	});

	it("refuses when the input lacks the fields entirely", () => {
		expect(resolveFileDiffStats("Edit", { file_path: "/a.ts" }, null)).toBeUndefined();
		expect(resolveFileDiffStats("Edit", truncatedLeaf("{"), null)).toBeUndefined();
		expect(resolveFileDiffStats("Edit", null, null)).toBeUndefined();
	});
});

describe("resolveFileDiffStats — Write has no local fallback", () => {
	/**
	 * THE case this guard exists for, and not an edge case: every Write persisted
	 * before the tool started writing metadata lands here.
	 *
	 * A Write's input carries only `content`; the file's previous state is never sent.
	 * Computing locally could only ever conclude "every line is new", rendering a
	 * rewrite that changed 3 lines as `+240 -0`. The client also cannot tell whether
	 * the Write created the file or replaced one, so there is no safe reading.
	 */
	it("returns undefined for a Write without metadata, however complete its content", () => {
		expect(resolveFileDiffStats("Write", { content: "a\nb\nc" }, null)).toBeUndefined();
		expect(resolveFileDiffStats("Write", { content: "a\nb\nc" }, {})).toBeUndefined();
		expect(
			resolveFileDiffStats("Write", { file_path: "/a.ts", content: "x".repeat(5_000) }, null),
		).toBeUndefined();
	});
});

describe("resolveFileDiffStats — non-file tools", () => {
	it("never answers for a tool that does not change files", () => {
		// Even carrying the metadata keys: a Bash call's header has no `+N -N` lane.
		expect(
			resolveFileDiffStats("Bash", { command: "ls" }, { linesAdded: 1, linesRemoved: 1 }),
		).toBeUndefined();
		expect(resolveFileDiffStats("Read", { file_path: "/a.ts" }, null)).toBeUndefined();
	});
});
