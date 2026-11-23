import { describe, expect, test } from "bun:test";
import {
	formatWatchTarget,
	isWatchCommand,
	isWatchDeadlineOutput,
	parseWatchCommand,
	WATCH_COMMAND_PREFIX,
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
});
