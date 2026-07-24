import { describe, expect, it } from "bun:test";
import {
	classifyToolDetail,
	countLines,
	extractField,
	extractNumericField,
	isTruncated,
	resolveDisplayText,
	type ToolCappedDetail,
	type ToolErrorDetail,
	type ToolGenericDetail,
	type ToolSpecTasksDetail,
	type ToolStructuredDetail,
} from "./tool-detail";

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
	it("reads from _hints on a truncated value", () => {
		expect(
			extractField(
				{ _truncated: true, preview: "{}", fullLength: 2, _hints: { command: "hint" } },
				"command",
			),
		).toBe("hint");
	});
	it("regex-scans the preview of a truncated value", () => {
		expect(
			extractField(
				{ _truncated: true, preview: '{"command":"echo hi"}', fullLength: 30 },
				"command",
			),
		).toBe("echo hi");
	});
	it("regex-scans a partial (truncated mid-value) preview", () => {
		expect(
			extractField({ _truncated: true, preview: '{"command":"echo hi', fullLength: 30 }, "command"),
		).toBe("echo hi");
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
	it("reads from _hints on a truncated value", () => {
		expect(
			extractNumericField(
				{ _truncated: true, preview: "{}", fullLength: 2, _hints: { limit: 42 } },
				"limit",
			),
		).toBe(42);
	});
	it("regex-scans the preview of a truncated value", () => {
		expect(
			extractNumericField({ _truncated: true, preview: '{"limit":100}', fullLength: 20 }, "limit"),
		).toBe(100);
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
		const d = classifyToolDetail({
			toolName: "Read",
			category: "read",
			outputJson: "ignored",
			metadata: { isImage: true },
		}) as ToolCappedDetail;
		expect(d.kind).toBe("capped");
		expect(d.cap).toBe("media");
		expect(d.contentPx).toBe(400);
		expect(d.hasLabel).toBe(false);
	});
	it("maps a text read to a code cap with content line count", () => {
		const d = classifyToolDetail({
			toolName: "Read",
			category: "read",
			outputJson: "line1\nline2\nline3",
		}) as ToolCappedDetail;
		expect(d.cap).toBe("code");
		expect(d.contentLines).toBe(3);
		expect(d.hasLabel).toBe(false);
	});
});

describe("classifyToolDetail — file", () => {
	it("maps Edit with old_string to a diff cap", () => {
		const d = classifyToolDetail({
			toolName: "Edit",
			category: "file",
			inputJson: { old_string: "a\nb", new_string: "a\nB\nc" },
		}) as ToolCappedDetail;
		expect(d.cap).toBe("diff");
		// countLines("a\nb")=2 + countLines("a\nB\nc")=3 + 2 = 7
		expect(d.contentLines).toBe(7);
	});
	it("maps Write to a code cap using content", () => {
		const d = classifyToolDetail({
			toolName: "Write",
			category: "file",
			inputJson: { content: "x\ny\nz\nw" },
		}) as ToolCappedDetail;
		expect(d.cap).toBe("code");
		expect(d.contentLines).toBe(4);
	});
});

describe("classifyToolDetail — tasks", () => {
	it("parses tasks from metadata", () => {
		const d = classifyToolDetail({
			toolName: "Read",
			category: "tasks",
			metadata: { tasks: [{ text: "do A" }, { text: "do B" }, {}] },
		}) as ToolSpecTasksDetail;
		expect(d.kind).toBe("spec-tasks");
		expect(d.tasks).toEqual(["do A", "do B", "—"]);
	});
	it("parses tasks from input.content JSON", () => {
		const doc = JSON.stringify({ tasks: [{ text: "first" }] });
		const d = classifyToolDetail({
			toolName: "Write",
			category: "tasks",
			inputJson: { content: doc },
		}) as ToolSpecTasksDetail;
		expect(d.tasks).toEqual(["first"]);
	});
	it("returns empty spec-tasks for an empty task document", () => {
		const doc = JSON.stringify({ tasks: [] });
		const d = classifyToolDetail({
			toolName: "Write",
			category: "tasks",
			inputJson: { content: doc },
		}) as ToolSpecTasksDetail;
		expect(d.kind).toBe("spec-tasks");
		expect(d.tasks).toEqual([]);
	});
	it("falls back to file branch when nothing parseable", () => {
		const d = classifyToolDetail({
			toolName: "Write",
			category: "tasks",
			inputJson: { content: "not json" },
		}) as ToolCappedDetail;
		expect(d.kind).toBe("capped");
		expect(d.cap).toBe("code");
	});
});

describe("classifyToolDetail — bash", () => {
	it("sums command + output lines under a term cap", () => {
		const d = classifyToolDetail({
			toolName: "Bash",
			category: "bash",
			inputJson: { command: "echo hi" },
			outputJson: "hi\nthere",
		}) as ToolCappedDetail;
		expect(d.cap).toBe("term");
		// countLines("echo hi")=1 + countLines("hi\nthere")=2 = 3
		expect(d.contentLines).toBe(3);
	});
	it("uses streaming-bash cap when streaming output present", () => {
		const d = classifyToolDetail({
			toolName: "Bash",
			category: "bash",
			inputJson: { command: "sleep 1" },
			metadata: { _streamingOutput: "partial..." },
		}) as ToolCappedDetail;
		expect(d.cap).toBe("streaming-bash");
	});
	it("returns null when no command and no output", () => {
		expect(classifyToolDetail({ toolName: "Bash", category: "bash", inputJson: {} })).toBeNull();
	});
});

describe("classifyToolDetail — search", () => {
	it("returns error on failed search with no output", () => {
		const d = classifyToolDetail({
			toolName: "Grep",
			category: "search",
			status: "fail",
			inputJson: { pattern: "foo" },
		}) as ToolErrorDetail;
		expect(d.kind).toBe("error");
		expect(d.text).toBe("foo");
	});
	it("returns a code cap with header lines on success", () => {
		const d = classifyToolDetail({
			toolName: "Grep",
			category: "search",
			outputJson: "match1\nmatch2",
		}) as ToolCappedDetail;
		expect(d.cap).toBe("code");
		expect(d.contentLines).toBe(4); // 2 output + 2 header
	});
});

describe("classifyToolDetail — webSearch", () => {
	it("builds structured body lines from parsed results", () => {
		const output = JSON.stringify({
			results: [
				{ title: "T1", domain: "a.com", snippet: "s1" },
				{ title: "T2", domain: "b.com", snippet: "s2" },
			],
		});
		const d = classifyToolDetail({
			toolName: "WebSearch",
			category: "webSearch",
			outputJson: output,
		}) as ToolStructuredDetail;
		expect(d.kind).toBe("structured");
		expect(d.badgeRows).toBe(0);
		// 2 results * 3 + 1 = 7 body lines
		expect(d.bodyLines).toHaveLength(7);
		expect(d.bodyLines[0]).toBe("T1");
	});
	it("falls back to a code cap for non-JSON output", () => {
		const d = classifyToolDetail({
			toolName: "WebSearch",
			category: "webSearch",
			outputJson: "plain text\nresults",
		}) as ToolCappedDetail;
		expect(d.cap).toBe("code");
		expect(d.contentLines).toBe(2);
	});
	it("returns error when no output", () => {
		const d = classifyToolDetail({
			toolName: "WebSearch",
			category: "webSearch",
		}) as ToolErrorDetail;
		expect(d.kind).toBe("error");
	});
});

describe("classifyToolDetail — webFetch", () => {
	it("maps screenshot mode with previewUrl to media", () => {
		const d = classifyToolDetail({
			toolName: "WebFetch",
			category: "webFetch",
			inputJson: { mode: "screenshot" },
			metadata: { previewUrl: "blob:x" },
		}) as ToolCappedDetail;
		expect(d.cap).toBe("media");
		expect(d.contentPx).toBe(400);
	});
	it("maps readability output to a code cap with header lines", () => {
		const d = classifyToolDetail({
			toolName: "WebFetch",
			category: "webFetch",
			inputJson: { mode: "readability" },
			outputJson: "a\nb",
		}) as ToolCappedDetail;
		expect(d.cap).toBe("code");
		expect(d.contentLines).toBe(5); // 2 + 3 header
	});
});

describe("classifyToolDetail — agent/generic", () => {
	it("produces generic input/output line counts", () => {
		const d = classifyToolDetail({
			toolName: "Task",
			category: "agent",
			inputJson: "prompt line",
			outputJson: "out1\nout2",
		}) as ToolGenericDetail;
		expect(d.kind).toBe("generic");
		expect(d.inputLines).toBe(1);
		expect(d.outputLines).toBe(2);
	});
	it("omits outputLines when there's no output", () => {
		const d = classifyToolDetail({
			toolName: "Task",
			category: "agent",
			inputJson: "prompt",
		}) as ToolGenericDetail;
		expect(d.outputLines).toBeUndefined();
	});
	it("falls back to generic for unknown category", () => {
		const d = classifyToolDetail({
			toolName: "Mystery",
			category: "generic",
			inputJson: "in",
		}) as ToolGenericDetail;
		expect(d.kind).toBe("generic");
	});
});

describe("classifyToolDetail — await", () => {
	it("uses term cap for bash await", () => {
		const d = classifyToolDetail({
			toolName: "Await",
			category: "await",
			inputJson: { type: "bash" },
			outputJson: "line",
		}) as ToolCappedDetail;
		expect(d.cap).toBe("term");
	});
	it("uses code cap for agent await", () => {
		const d = classifyToolDetail({
			toolName: "Await",
			category: "await",
			inputJson: { type: "agent" },
		}) as ToolCappedDetail;
		expect(d.cap).toBe("code");
		expect(d.contentLines).toBe(0);
	});
});

describe("classifyToolDetail — send", () => {
	it("produces a structured body with message + targets + output", () => {
		const d = classifyToolDetail({
			toolName: "Send",
			category: "send",
			inputJson: { message: "hi\nthere" },
			outputJson: "delivered",
			metadata: { targets: [{ title: "Agent A", status: "sent" }] },
		}) as ToolStructuredDetail;
		expect(d.kind).toBe("structured");
		expect(d.badgeRows).toBe(1);
		expect(d.bodyLines).toContain("hi");
		expect(d.bodyLines).toContain("there");
		expect(d.bodyLines).toContain("sent · Agent A");
		expect(d.bodyLines).toContain("delivered");
	});
});

describe("classifyToolDetail — ask", () => {
	it("returns null while pending", () => {
		expect(
			classifyToolDetail({
				toolName: "AskUserQuestion",
				category: "ask",
				status: "pending",
				inputJson: { questions: [{ header: "Q" }] },
			}),
		).toBeNull();
	});
	it("returns null when there are no questions", () => {
		expect(
			classifyToolDetail({ toolName: "AskUserQuestion", category: "ask", inputJson: {} }),
		).toBeNull();
	});
	it("produces a structured body from resolved questions", () => {
		const d = classifyToolDetail({
			toolName: "AskUserQuestion",
			category: "ask",
			status: "success",
			inputJson: { questions: [{ header: "Pick one", options: ["a", "b"] }] },
		}) as ToolStructuredDetail;
		expect(d.kind).toBe("structured");
		expect(d.badgeRows).toBe(0);
		// header + 2 options = 3 lines
		expect(d.bodyLines).toHaveLength(3);
		expect(d.bodyLines[0]).toBe("Pick one");
	});
});

describe("classifyToolDetail — plan", () => {
	it("returns null when no plan text", () => {
		expect(
			classifyToolDetail({ toolName: "ExitPlanMode", category: "plan", inputJson: {} }),
		).toBeNull();
	});
	it("maps plan text to a plan cap", () => {
		const d = classifyToolDetail({
			toolName: "ExitPlanMode",
			category: "plan",
			inputJson: { plan: "step 1\nstep 2" },
		}) as ToolCappedDetail;
		expect(d.cap).toBe("plan");
		expect(d.contentLines).toBe(2);
	});
});

describe("classifyToolDetail — pipeline", () => {
	it("produces a monospace structured body", () => {
		const d = classifyToolDetail({
			toolName: "ExtractPipeline",
			category: "pipeline",
			inputJson: { rule: "grab logs", aliases: ["a1"] },
			outputJson: "body line",
		}) as ToolStructuredDetail;
		expect(d.kind).toBe("structured");
		expect(d.badgeRows).toBe(1);
		expect(d.mono).toBe(true);
		expect(d.bodyLines).toContain("grab logs");
		expect(d.bodyLines).toContain("a1");
		expect(d.bodyLines).toContain("body line");
	});
	it("returns empty body when nothing parseable", () => {
		const d = classifyToolDetail({
			toolName: "StartPipeline",
			category: "pipeline",
			inputJson: {},
		}) as ToolStructuredDetail;
		expect(d.badgeRows).toBe(1);
		expect(d.bodyLines).toEqual([]);
	});
});

describe("classifyToolDetail — terminal", () => {
	it("maps write action to a bash-cmd cap", () => {
		const d = classifyToolDetail({
			toolName: "Terminal",
			category: "terminal",
			inputJson: { action: "write", input: "ls" },
		}) as ToolCappedDetail;
		expect(d.cap).toBe("bash-cmd");
		expect(d.contentLines).toBe(1);
	});
	it("maps read action to a term cap", () => {
		const d = classifyToolDetail({
			toolName: "Terminal",
			category: "terminal",
			inputJson: { action: "read" },
			outputJson: "out\nput",
		}) as ToolCappedDetail;
		expect(d.cap).toBe("term");
		expect(d.contentLines).toBe(2);
	});
	it("returns error on failed read with no output", () => {
		const d = classifyToolDetail({
			toolName: "Terminal",
			category: "terminal",
			status: "fail",
			inputJson: { action: "read" },
		}) as ToolErrorDetail;
		expect(d.kind).toBe("error");
	});
});

describe("classifyToolDetail — share", () => {
	it("maps media preview to a media cap", () => {
		const d = classifyToolDetail({
			toolName: "ShareFile",
			category: "share",
			metadata: { downloadUrl: "/d/x", preview: true, previewUrl: "/p/x" },
		}) as ToolCappedDetail;
		expect(d.cap).toBe("media");
		expect(d.contentPx).toBe(400);
	});
	it("maps a downloadable file to a structured body with the filename", () => {
		const d = classifyToolDetail({
			toolName: "ShareFile",
			category: "share",
			metadata: { downloadUrl: "/d/x", filename: "report.pdf" },
		}) as ToolStructuredDetail;
		expect(d.kind).toBe("structured");
		expect(d.bodyLines).toEqual(["report.pdf"]);
	});
	it("falls back to generic when no downloadUrl", () => {
		const d = classifyToolDetail({
			toolName: "ShareFile",
			category: "share",
			inputJson: "in",
		}) as ToolGenericDetail;
		expect(d.kind).toBe("generic");
	});
});

describe("classifyToolDetail — recall", () => {
	it("produces a structured body for search results", () => {
		const d = classifyToolDetail({
			toolName: "Recall",
			category: "recall",
			metadata: { action: "search", results: [{ id: "1" }, { id: "2" }] },
		}) as ToolStructuredDetail;
		expect(d.kind).toBe("structured");
		expect(d.badgeRows).toBe(1);
		expect(d.bodyLines).toHaveLength(8); // 2 results * 4
	});
	it("produces a no-results body when empty", () => {
		const d = classifyToolDetail({
			toolName: "Recall",
			category: "recall",
			metadata: { action: "search", results: [] },
		}) as ToolStructuredDetail;
		expect(d.bodyLines).toEqual(["No results"]);
	});
	it("falls back to generic without recall metadata", () => {
		const d = classifyToolDetail({
			toolName: "Recall",
			category: "recall",
			inputJson: "in",
		}) as ToolGenericDetail;
		expect(d.kind).toBe("generic");
	});
});

describe("classifyToolDetail — skill", () => {
	it("maps parsed skill content to a skill cap", () => {
		const output = `<skill_content name="demo">\n\nHello\nWorld\nBase directory for this skill: /x`;
		const d = classifyToolDetail({
			toolName: "Skill",
			category: "skill",
			outputJson: output,
		}) as ToolCappedDetail;
		expect(d.cap).toBe("skill");
		expect(d.contentLines).toBeGreaterThanOrEqual(3);
	});
	it("falls back to generic without skill_content", () => {
		const d = classifyToolDetail({
			toolName: "Skill",
			category: "skill",
			outputJson: "no marker",
		}) as ToolGenericDetail;
		expect(d.kind).toBe("generic");
	});
});

describe("classifyToolDetail — browser", () => {
	it("maps screenshot action to a media cap", () => {
		const d = classifyToolDetail({
			toolName: "Browser",
			category: "browser",
			inputJson: { action: "screenshot" },
			metadata: { previewUrl: "/p/x" },
		}) as ToolCappedDetail;
		expect(d.cap).toBe("media");
	});
	it("returns error on failed browser action with no output", () => {
		const d = classifyToolDetail({
			toolName: "Browser",
			category: "browser",
			status: "fail",
			inputJson: { action: "click" },
		}) as ToolErrorDetail;
		expect(d.kind).toBe("error");
	});
});

describe("classifyToolDetail — knowledge", () => {
	it("maps KnowledgeSearch results to a structured body", () => {
		const d = classifyToolDetail({
			toolName: "KnowledgeSearch",
			category: "knowledge",
			metadata: { results: [{}, {}, {}] },
		}) as ToolStructuredDetail;
		expect(d.kind).toBe("structured");
		expect(d.bodyLines).toHaveLength(9); // 3 results * 3
	});
	it("maps KnowledgeRead to a knowledge cap", () => {
		const d = classifyToolDetail({
			toolName: "KnowledgeRead",
			category: "knowledge",
			outputJson: "doc\nbody",
		}) as ToolCappedDetail;
		expect(d.cap).toBe("knowledge");
		expect(d.contentLines).toBe(4); // 2 + 2
	});
});

describe("classifyToolDetail — render-only body text passthrough (Approach B)", () => {
	it("read/code carries the real output text", () => {
		const d = classifyToolDetail({
			toolName: "Read",
			category: "read",
			outputJson: "line1\nline2",
		}) as ToolCappedDetail;
		expect(d.text).toBe("line1\nline2");
	});
	it("Write/file carries the written content", () => {
		const d = classifyToolDetail({
			toolName: "Write",
			category: "file",
			inputJson: { content: "const x = 1;\nconst y = 2;" },
		}) as ToolCappedDetail;
		expect(d.text).toBe("const x = 1;\nconst y = 2;");
	});
	it("Edit/diff composes a +/- diff body", () => {
		const d = classifyToolDetail({
			toolName: "Edit",
			category: "file",
			inputJson: { old_string: "a", new_string: "b" },
		}) as ToolCappedDetail;
		expect(d.text).toBe("- a\n+ b");
	});
	it("bash prefixes the command and appends output", () => {
		const d = classifyToolDetail({
			toolName: "Bash",
			category: "bash",
			inputJson: { command: "ls -la" },
			outputJson: "file1\nfile2",
		}) as ToolCappedDetail;
		expect(d.text).toBe("$ ls -la\nfile1\nfile2");
	});
	it("generic carries input + output text", () => {
		const d = classifyToolDetail({
			toolName: "Agent",
			category: "agent",
			inputJson: "the prompt",
			outputJson: "the result",
		}) as ToolGenericDetail;
		expect(d.inputText).toBe("the prompt");
		expect(d.outputText).toBe("the result");
	});
	it("media caps carry no text (contentPx only)", () => {
		const d = classifyToolDetail({
			toolName: "Read",
			category: "read",
			metadata: { isImage: true },
		}) as ToolCappedDetail;
		expect(d.text).toBeUndefined();
		expect(d.contentPx).toBe(400);
	});
});
