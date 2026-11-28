/**
 * tool-display.live-output-chars.test.ts — the GENERIC live output counter in
 * header summaries: any running tool whose `_streamingOutput` is a bare
 * cumulative count (the ContextAsk convention) shows "N chars" on its folded
 * row / header. Agent and Await are the first non-ContextAsk consumers; the
 * server streams the count from the subagent's text deltas
 * (narrator-event-handler's `noteSubagentOutputText`).
 */

import { describe, expect, it } from "bun:test";
import { classifyToolDetail } from "@shared/pretext-layout/tool-detail";
import { getCategory, getCategoryColor, getSummary, isRunningForegroundBash } from "./tool-display";

describe("Stop display and legacy cancellation history", () => {
	it("displays Stop type and target, without treating it as a launched agent or Bash", () => {
		expect(getCategory("Stop")).toBe("stop");
		expect(getCategoryColor("stop")).toBe("orange");
		for (const type of ["bash", "agent"]) {
			const input = { type, id: "owned-task" };
			expect(getSummary("Stop", input)).toBe(`${type}: owned-task`);
			expect(isRunningForegroundBash("Stop", input, "running")).toBe(false);
			expect(
				classifyToolDetail({
					toolUseId: "stop-display-test",
					toolName: "Stop",
					category: "stop",
					status: "completed",
					inputJson: input,
					outputJson: "Task cancelled",
				}),
			).toBeDefined();
		}
	});

	it("retains summaries and details for historical Bash/Agent stop cards", () => {
		for (const toolName of ["Bash", "Agent"]) {
			const input = { stop: "old-task" };
			expect(getSummary(toolName, input)).toBe("Stop: old-task");
			expect(
				classifyToolDetail({
					toolUseId: "stop-display-test",
					toolName,
					category: getCategory(toolName),
					status: "completed",
					inputJson: input,
					outputJson: "Task cancelled",
				}),
			).toBeDefined();
		}
	});
});

describe("Watch registration summary", () => {
	it("uses a distinct category and never presents a returned observation as live output", () => {
		expect(getCategory("Watch")).toBe("watch");
		const summary = getSummary(
			"Watch",
			{ type: "agent", id: "worker", timeout: 600000 },
			{ status: "watching", _streamingOutput: "999" },
			{ watchRegistered: "已登记观察" },
		);
		expect(summary).toBe("agent: worker · 已登记观察");
		expect(summary).not.toContain("999");
		expect(summary).not.toContain("600000");
	});
});

describe("Agent header summary live output counter", () => {
	const input = { subagent_type: "explore", description: "survey auth flow" };

	it("appends the live count while the subagent streams", () => {
		expect(getSummary("Agent", input, { _streamingOutput: "1240" })).toBe(
			"explore: survey auth flow · 1240 chars",
		);
	});

	it("localizes the counter fragment", () => {
		expect(
			getSummary("Agent", input, { _streamingOutput: "1240" }, { liveOutputChars: "{count} 字符" }),
		).toBe("explore: survey auth flow · 1240 字符");
	});

	it("ignores a non-numeric streaming body and terminal cards", () => {
		expect(getSummary("Agent", input, { _streamingOutput: "thinking…" })).toBe(
			"explore: survey auth flow",
		);
		expect(getSummary("Agent", input)).toBe("explore: survey auth flow");
	});

	it("keeps the bare tool name when no type/description stream in", () => {
		expect(getSummary("Agent", {}, { _streamingOutput: "12" })).toBe("Agent · 12 chars");
	});
});

describe("Await header summary live output counter", () => {
	const input = { type: "agent", id: "worker-1" };

	it("appends the awaited child's live count", () => {
		expect(getSummary("Await", input, { _streamingOutput: "512" })).toBe(
			"agent: worker-1 · 512 chars",
		);
	});

	it("localizes the counter fragment", () => {
		expect(
			getSummary("Await", input, { _streamingOutput: "512" }, { liveOutputChars: "{count} 字符" }),
		).toBe("agent: worker-1 · 512 字符");
	});

	it("never appends for a non-numeric streaming body", () => {
		expect(getSummary("Await", input, { _streamingOutput: "waiting" })).toBe("agent: worker-1");
	});
});

describe("Await header summary target naming", () => {
	const input = { type: "agent", id: "worker-1" };

	it("headlines the session title when the returned metadata carries one", () => {
		expect(
			getSummary("Await", input, {
				targetTitle: "SDK review 修复方案",
				targetLabel: "sdk-review",
			}),
		).toBe("agent: SDK review 修复方案");
	});

	it("prefers the live transport title while the wait is still running", () => {
		expect(getSummary("Await", input, { _awaitAgentTitle: "Plan story retirement" })).toBe(
			"agent: Plan story retirement",
		);
		// The persisted title wins once the tool has returned.
		expect(
			getSummary("Await", input, {
				targetTitle: "Final name",
				_awaitAgentTitle: "Live name",
			}),
		).toBe("agent: Final name");
	});

	it("falls back to the resolved alias, then the raw selector", () => {
		expect(getSummary("Await", input, { targetLabel: "sdk-review" })).toBe("agent: sdk-review");
		expect(getSummary("Await", input)).toBe("agent: worker-1");
	});
});
