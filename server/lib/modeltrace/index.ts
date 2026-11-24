import type { ModelTraceResultBlock } from "@shared/modeltrace-result";
import { generateChallenges } from "lmfpd-sdk";
import { logger } from "../logger";
import { type ModelTraceOutput, validOutputs } from "./protocol";
import { makeModelTraceRunner } from "./worker-client";

export { MODELTRACE_MAX_TEXT_LENGTH } from "./protocol";

export function buildModelTraceChallenges(
	count: 1 | 3 = 1,
): { prompt: string; expectedCount: number }[] {
	return generateChallenges(count).map(({ prompt, expected_count }) => ({
		prompt: `Generate the numbers directly in this reply, without tools, code execution, or delegation. Do not continue the previous task.\n\n${prompt}`,
		expectedCount: expected_count,
	}));
}

const analyze = makeModelTraceRunner();

export async function analyzeModelTrace(
	outputs: ModelTraceOutput[],
	locale = "zh-CN",
	signal?: AbortSignal,
): Promise<ModelTraceResultBlock> {
	const zh = locale.toLowerCase().startsWith("zh");
	const unavailable = (error: string): ModelTraceResultBlock => ({
		type: "modeltrace_result",
		decision: "unscorable",
		results: [],
		error,
	});
	if (signal?.aborted) return unavailable(zh ? "检测已取消。" : "Detection cancelled.");
	if (!validOutputs(outputs)) {
		return unavailable(zh ? "数字样本超出检测限制。" : "Number samples exceed detection limits.");
	}
	try {
		return { type: "modeltrace_result", ...(await analyze(outputs, signal)) };
	} catch (error) {
		if (signal?.aborted) return unavailable(zh ? "检测已取消。" : "Detection cancelled.");
		// Never log provider answers or worker exception messages.
		logger.warn("Model fingerprint worker unavailable", {
			reason: error instanceof Error ? error.name : "WorkerError",
		});
		return unavailable(zh ? "本地检测暂不可用。" : "Local detection is temporarily unavailable.");
	}
}
