import {
	runtimePolicyForContext,
	runtimeWatchTargets,
} from "@server/services/agent-runtime/policy";
import { MAX_WATCH_PATTERN_CHARS } from "@server/services/terminal-watch-service";
import { DEFAULT_WATCH_TIMEOUT_MS, MAX_WATCH_TIMEOUT_MS } from "@server/services/watch-observation";
import { watchTask } from "@server/services/watch-service";
import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";
import { looseNumber, normalizeNumber } from "./number-param";
import { watchTerminal } from "./terminal";

const parameters = z.object({
	type: z.enum(["terminal", "bash", "agent"]).describe("The kind of target to observe."),
	id: z
		.string()
		.trim()
		.min(1)
		.describe("Terminal ID/name, owned Bash task ID/alias, or accessible agent selector."),
	pattern: z
		.string()
		.min(1)
		.max(MAX_WATCH_PATTERN_CHARS)
		.optional()
		.describe(
			"For terminal/Bash: case-sensitive literal output to match. Without a pattern, observe exit/completion or the deadline.",
		),
	timeout: looseNumber(
		"Observation deadline in milliseconds (default 600000, maximum 86400000). Reaching it posts a mailbox message and does not stop the target.",
	),
	start_at: z
		.enum(["last_observation", "now"])
		.optional()
		.describe(
			"Terminal only: observe since this session's last returned read/write snapshot (default), or only new output from now.",
		),
});

export const watchTool: ToolDefinition = {
	name: "Watch",
	description:
		"Observe a terminal, background Bash task, or agent without blocking. " +
		"Returns an observation handle immediately; end your turn or do independent work. " +
		"A text match, completion, or deadline delivers its result through the mailbox. " +
		"A target's ordinary completion notice fulfils all watches of that recipient/run; it is not repeated. " +
		"Already-finished targets return their saved result immediately without registering a watch. " +
		"Observation handles are not watch targets: use the original target ID; inspect a handle with TeamStatus action get_task. " +
		"Timeout ends only the observation, never the target. Stop({ type: 'bash', id: watchHandle }) cancels only the watch. " +
		"Terminal matching uses rendered output, not command exit status; use Terminal.write.notify_on to atomically send and observe without matching the input echo. " +
		"Agent observations follow one run; takeover or a replaced run is reported, not mistaken for a completed result. " +
		"Timeout is in milliseconds (Terminal.write.timeout remains in seconds).",
	parameters,
	async execute(args, ctx): Promise<ToolResult> {
		const parsed = parameters.safeParse(args);
		if (!parsed.success)
			return { output: `Invalid Watch parameters: ${parsed.error.message}`, isError: true };
		const input = parsed.data;
		if (!runtimeWatchTargets(runtimePolicyForContext(ctx)).includes(input.type)) {
			return {
				output: `Watch does not permit ${input.type} observations in this session.`,
				isError: true,
			};
		}
		if (input.type === "agent" && input.pattern !== undefined) {
			return {
				output: "Agent watches observe completion or deadline, not output patterns.",
				isError: true,
			};
		}
		if (input.type !== "terminal" && input.start_at !== undefined) {
			return { output: "start_at applies only to terminal observations.", isError: true };
		}
		const timeout =
			normalizeNumber(input.timeout, { min: 1000, max: MAX_WATCH_TIMEOUT_MS }) ??
			DEFAULT_WATCH_TIMEOUT_MS;
		try {
			if (ctx.signal.aborted)
				return { output: "Watch registration interrupted. The target was not stopped." };
			if (input.type === "terminal") {
				return await watchTerminal(input.id, ctx, input.pattern, timeout, input.start_at);
			}
			return await watchTask({ ...input, type: input.type, timeout }, ctx);
		} catch (error) {
			return {
				output: `Watch could not be registered: ${error instanceof Error ? error.message : String(error)}`,
				isError: true,
				metadata: {
					kind: "watch",
					type: input.type,
					targetId: input.id,
					status: "failed",
				},
			};
		}
	},
};
