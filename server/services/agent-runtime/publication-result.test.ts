import { expect, test } from "bun:test";
import {
	AGENT_RESULT_OUTPUT_CHARS,
	AGENT_RESULT_TRUNCATION_MARKER,
	decodeAgentTerminalSnapshot,
	decodeRunAssistantProjection,
	parseRunSourceBoundary,
} from "./publication-result";

test("source boundary accepts only safe explicit integer watermarks", () => {
	expect(parseRunSourceBoundary("source_after:-1")).toBe(-1);
	expect(parseRunSourceBoundary("source_after:0")).toBe(0);
	for (const pointer of [
		null,
		"source_after:",
		"source_after: ",
		"source_after:1e3",
		"source_after:1.5",
		"source_after:9007199254740992",
		"message:old",
	])
		expect(parseRunSourceBoundary(pointer)).toBeNull();
});

test("both immutable truncation flags and projection budgets expose a bounded explicit truncation notice", () => {
	const raw = JSON.stringify([
		{
			type: "text",
			text: "small saved prefix",
			publicationResult: { logicalRunId: "run", truncated: true },
		},
	]);
	const snapshot = decodeAgentTerminalSnapshot(raw, "run");
	expect(snapshot?.output).toContain("small saved prefix");
	expect(snapshot?.output).toContain(AGENT_RESULT_TRUNCATION_MARKER);
	expect(decodeAgentTerminalSnapshot(raw, "other-run")).toBeNull();
	const plain = decodeRunAssistantProjection("x".repeat(100_000), null);
	expect(plain?.output).toHaveLength(AGENT_RESULT_OUTPUT_CHARS);
	expect(plain?.output).toEndWith(AGENT_RESULT_TRUNCATION_MARKER);
	const body = decodeRunAssistantProjection(
		null,
		JSON.stringify([{ type: "text", text: "x".repeat(30_000) }]),
	);
	expect(body?.output).toHaveLength(AGENT_RESULT_OUTPUT_CHARS);
	expect(body?.output).toEndWith(AGENT_RESULT_TRUNCATION_MARKER);
});

test("empty/thinking-only source projection is not a received result, while committed empty snapshots are valid", () => {
	expect(decodeRunAssistantProjection("", null)).toBeNull();
	expect(
		decodeRunAssistantProjection(
			null,
			JSON.stringify([{ type: "thinking", thinking: "background" }]),
		),
	).toBeNull();
	expect(
		decodeRunAssistantProjection(null, JSON.stringify([{ type: "text", text: "" }])),
	).toBeNull();
	expect(
		decodeAgentTerminalSnapshot(
			JSON.stringify([{ type: "text", text: "", publicationResult: { logicalRunId: "run" } }]),
			"run",
		),
	).toEqual({ output: "" });
});
