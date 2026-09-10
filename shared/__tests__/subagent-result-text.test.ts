/**
 * subagent-result-text.test.ts — the extraction rule behind a subagent card's
 * conclusion body.
 *
 * The regression this locks down: the vlist adapter accepted only a bare string
 * `outputJson`, so every row whose output is the runner's `{_text, _metadata}`
 * envelope rendered a finished subagent card with NO result at all. Measured on a
 * real database that was 1343 of 3164 `Agent`/`Task` rows (43%).
 */

import { describe, expect, it } from "bun:test";
import {
	MAX_SUBAGENT_RESULT_TEXT_CHARS,
	parseSubagentOutputText,
	readBackgroundTaskId,
	stripAwaitAgentEnvelope,
	stripSubagentIdTag,
	subagentResultText,
} from "../subagent-result-text";

describe("parseSubagentOutputText", () => {
	it("returns a bare string output as-is", () => {
		expect(parseSubagentOutputText("done")).toBe("done");
	});

	it("unwraps the runner's {_text, _metadata} envelope", () => {
		expect(
			parseSubagentOutputText({ _text: "conclusion body", _metadata: { execDurationMs: 31 } }),
		).toBe("conclusion body");
	});

	it("prefers _text over a generic leaf read so an envelope never dumps as JSON", () => {
		const output = { _text: { _truncated: true, preview: "cut body", fullLength: 9000 } };
		expect(parseSubagentOutputText(output)).toBe("cut body");
	});

	it("reads a truncated leaf at the root (projected bare-string output)", () => {
		expect(
			parseSubagentOutputText({ _truncated: true, preview: "preview only", fullLength: 4000 }),
		).toBe("preview only");
	});

	it("joins an array of text content blocks", () => {
		expect(
			parseSubagentOutputText([
				{ type: "text", text: "first" },
				{ type: "image" },
				{ text: "second" },
			]),
		).toBe("first\nsecond");
	});

	it("falls back to a display-safe dump for an unrecognized object", () => {
		const text = parseSubagentOutputText({ ok: true, count: 2 });
		expect(text).toContain('"ok": true');
		expect(text).toContain('"count": 2');
	});

	it("returns empty for nullish / non-object outputs", () => {
		expect(parseSubagentOutputText(null)).toBe("");
		expect(parseSubagentOutputText(undefined)).toBe("");
		expect(parseSubagentOutputText(42)).toBe("");
	});

	it("caps the extracted text so a render path never gets an unbounded string", () => {
		const huge = "x".repeat(MAX_SUBAGENT_RESULT_TEXT_CHARS + 5_000);
		expect(parseSubagentOutputText(huge).length).toBe(MAX_SUBAGENT_RESULT_TEXT_CHARS);
		expect(parseSubagentOutputText({ _text: huge }).length).toBe(MAX_SUBAGENT_RESULT_TEXT_CHARS);
	});
});

describe("stripSubagentIdTag", () => {
	it("drops the runner's addressing tag and surrounding blank lines", () => {
		expect(stripSubagentIdTag("<subagent_id>abc-123</subagent_id>\n\nreal body")).toBe("real body");
	});

	it("keeps a background task id — that line IS the message", () => {
		const text =
			"<background_task_id>review-bubbles</background_task_id>\n\nBackground task started.";
		expect(stripSubagentIdTag(text)).toBe(text);
	});
});

describe("readBackgroundTaskId", () => {
	it("reads only a leading runner envelope", () => {
		expect(
			readBackgroundTaskId("<background_task_id>review-bubbles</background_task_id>\nstarted"),
		).toBe("review-bubbles");
		expect(readBackgroundTaskId("Example: <background_task_id>quoted</background_task_id>")).toBe(
			undefined,
		);
		expect(readBackgroundTaskId("<background_task_id>incomplete")).toBe(undefined);
	});
});

describe("stripAwaitAgentEnvelope", () => {
	it("drops a leading addressing tag and keeps an optional status line", () => {
		expect(stripAwaitAgentEnvelope("<subagent_id>worker</subagent_id>\n\nStill running")).toBe(
			"Still running",
		);
		expect(
			stripAwaitAgentEnvelope(
				"Agent worker status: completed\n\n<subagent_id>worker</subagent_id>\n\n# Result\nDone",
			),
		).toBe("Agent worker status: completed\n\n# Result\nDone");
	});

	it("does not rewrite tags quoted later in a report", () => {
		const text = "Example:\n```xml\n<subagent_id>example</subagent_id>\n```";
		expect(stripAwaitAgentEnvelope(text)).toBe(text);
	});
});

describe("subagentResultText", () => {
	it("extracts and strips in one step for the envelope form", () => {
		expect(
			subagentResultText({
				_text: "<subagent_id>枚举-单例耦合点</subagent_id>\n\n# 结论\n\n正文",
				_metadata: { execDurationMs: 12 },
			}),
		).toBe("# 结论\n\n正文");
	});

	it("extracts and strips for the bare-string form", () => {
		expect(subagentResultText("<subagent_id>x</subagent_id>\n\nreply text")).toBe("reply text");
	});

	it("returns empty when the output carries nothing readable", () => {
		expect(subagentResultText(null)).toBe("");
		expect(subagentResultText("<subagent_id>only-a-tag</subagent_id>")).toBe("");
	});
});
