import { describe, expect, test } from "bun:test";
import {
	formatWatchTarget,
	isWatchCommand,
	isWatchDeadlineOutput,
	parseWatchCommand,
	WATCH_COMMAND_PREFIX,
	watchCommandTargetType,
	watchNoticeFromTask,
	watchResultTargetStatus,
} from "./watch-command";

const row = (target: Parameters<typeof formatWatchTarget>[0]) =>
	`${WATCH_COMMAND_PREFIX} ${formatWatchTarget(target)}`;

describe("watch command", () => {
	test("round-trips agent, bash and terminal targets with pattern and timeout", () => {
		for (const target of [
			{ type: "agent", id: "child-1", runId: "run-1", timeoutMs: 600_000 },
			{ type: "bash", id: "b1", runId: null, pattern: 'ready "now"\n', timeoutMs: 30_000 },
			{ type: "terminal", id: "term-1", pattern: "$ ", timeoutMs: 86_400_000 },
		] as const) {
			const command = row(target);
			expect(isWatchCommand(command)).toBe(true);
			expect(parseWatchCommand(command)).toEqual(target);
		}
	});

	test("parses rows written before the timeout was recorded", () => {
		expect(parseWatchCommand('[watch] agent "a" run "r"')).toEqual({
			type: "agent",
			id: "a",
			runId: "r",
		});
		expect(parseWatchCommand('[watch] terminal "t" for "x"')).toEqual({
			type: "terminal",
			id: "t",
			pattern: "x",
		});
	});

	test("rejects legacy terminal watches and unknown shapes", () => {
		expect(parseWatchCommand('[terminal watch] "t"')).toBeNull();
		expect(parseWatchCommand("[watch] source")).toBeNull();
		expect(parseWatchCommand('bash "b" run null')).toBeNull();
		expect(parseWatchCommand(null)).toBeNull();
	});

	test("recognises deadline outputs of target and terminal watches", () => {
		expect(isWatchDeadlineOutput("Watch reached its deadline for agent a.")).toBe(true);
		expect(isWatchDeadlineOutput("Terminal watch timed out: observation reached")).toBe(true);
		expect(isWatchDeadlineOutput("Watch agent a: completed.")).toBe(false);
		expect(isWatchDeadlineOutput(null)).toBe(false);
	});

	test("reads the target status from a finished watch's header line", () => {
		expect(watchResultTargetStatus("Watch bash b1: found.\n\nready")).toBe("found");
		expect(watchResultTargetStatus("Watch agent Fix: login: taken_over.")).toBe("taken_over");
		expect(
			watchResultTargetStatus("Observation fulfilled by the ordinary agent notice"),
		).toBeNull();
		expect(watchResultTargetStatus(null)).toBeNull();
	});
});

describe("watchNoticeFromTask", () => {
	test("reads a flagged agent watch's target, outcome and result body", () => {
		expect(
			watchNoticeFromTask({
				title: "watch agent 实现服务端全量回源",
				status: "completed",
				preview:
					"Watch reached its deadline for agent sub-1. Only the observation ended; the target was not stopped.\n\nSubagent is still running.",
				watch: "agent",
			}),
		).toEqual({
			targetType: "agent",
			targetName: "实现服务端全量回源",
			outcome: "deadline",
			body: "Subagent is still running.",
		});
	});

	test("recognises older unflagged agent and bash watch rows by title", () => {
		expect(
			watchNoticeFromTask({
				title: "watch bash dev-server",
				status: "completed",
				preview: "Watch bash dev-server: found.\n\nready on :3000",
			}),
		).toMatchObject({ targetType: "bash", outcome: "matched", body: "ready on :3000" });
		expect(
			watchNoticeFromTask({
				title: "watch agent a",
				status: "failed",
				preview: "boom",
				watch: "agent",
			})?.outcome,
		).toBe("failed");
		expect(
			watchNoticeFromTask({
				title: "watch agent a",
				status: "completed",
				preview: "Watch agent a: superseded.",
			})?.outcome,
		).toBe("replaced");
	});

	test("keeps a terminal deadline's observed output, blank lines included", () => {
		const preview =
			'Terminal watch timed out: "ready" did not appear in terminal "dev". The command may still be running.\nLast observed output:\nfirst\n\nsecond';
		expect(
			watchNoticeFromTask({
				title: "watch dev: ready",
				status: "timeout",
				preview,
				watch: "terminal",
			}),
		).toMatchObject({ outcome: "deadline", body: preview });
	});

	test("leaves ordinary bash completions alone", () => {
		expect(
			watchNoticeFromTask({ title: "bun test", status: "completed", preview: "ok" }),
		).toBeNull();
		expect(
			watchNoticeFromTask({ title: "watch logs", status: "completed", preview: "tail output" }),
		).toBeNull();
	});

	test("maps a task command to its watched target type", () => {
		expect(watchCommandTargetType('[watch] agent "a"')).toBe("agent");
		expect(watchCommandTargetType('[terminal watch] "t"')).toBe("terminal");
		expect(watchCommandTargetType("bun test")).toBeNull();
		expect(watchCommandTargetType(null)).toBeNull();
	});
});
