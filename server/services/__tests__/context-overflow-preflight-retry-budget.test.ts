/**
 * 发送前预检（context-preflight）触发溢出恢复时的重试上界。
 *
 * 预检只是在 provider 之前多产出一个 `context_length_exceeded`，因此它的重试上界必须完全由
 * 既有的恢复链决定。这个文件用**真实的** `selectRuntimeRecovery` + `handleContextOverflow`
 * 拼出 orchestrator 的 replay 循环，证明"预检每次都判超预算"这种最坏情况下依然有限轮终止：
 * 只有真正发起压缩的 Phase B 消耗 `MAX_CONTEXT_OVERFLOW_RETRIES`，压缩后仍超预算最终报
 * `max_retries_exceeded`，而不是继续重试。
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realNarratorService = { ...(await import("../narrator-service")) };
const realNarratorSession = { ...(await import("../narrator-session")) };

let compactSeqQueue: Array<number | null>;
let runCustomCompactCalls: number;
let runCustomCompactImpl: () => Promise<boolean>;

function nextCompactSeq(): number | null {
	return compactSeqQueue.length > 1
		? (compactSeqQueue.shift() ?? null)
		: (compactSeqQueue[0] ?? null);
}

mock.module("../narrator-service", () => ({
	...realNarratorService,
	narratorService: {
		...realNarratorService.narratorService,
		getLatestCompactSeq: mock(async () => nextCompactSeq()),
		getCompactBoundaryMessage: mock(async () => "boundary-msg"),
		getEmergencyCompactBoundaryMessage: mock(async () => null),
	},
}));

mock.module("../narrator-session", () => ({
	...realNarratorSession,
	awaitCompactCompletion: mock(async () => {}),
	markCompactAsBlocking: mock(async () => {}),
	runCustomCompact: mock(async () => {
		runCustomCompactCalls++;
		return runCustomCompactImpl();
	}),
}));

const { handleContextOverflow, MAX_CONTEXT_OVERFLOW_RETRIES } = await import(
	"../narrator-recovery"
);
const { createRuntimeRecoveryState, selectRuntimeRecovery } = await import(
	"../agent-runtime/transition"
);
const { compactLocks } = await import("../narrator-session-state");
const { resetContextOverflowRetriesAfterProgress } = await import("../narrator-recovery");

const NARRATOR_ID = "n-preflight-overflow";

/**
 * 预检拦截时，loop 在 provider 调用之前就结束了这一轮：会话/执行器一侧因此得到"上下文超长、
 * 且本轮没有完成任何 assistant 回合"。这个形状决定了 overflowRetries 不会被重置。
 */
function preflightOverflowResult() {
	return {
		finalText: "",
		hasError: false,
		shouldUpdateTitle: false,
		contextLengthExceeded: true as const,
		completedAssistantTurn: false,
	};
}

/** 压缩"成功"但历史规模不变：模拟压缩后预检仍然判超预算。 */
async function replayUntilTerminal(options: {
	baselineSeq: number;
	/** 只跑这么多轮就停（用于观察"沿用已有压缩"这类中间状态）。 */
	stopAfterPasses?: number;
}): Promise<{ passes: number; remainingQuota: number; outcome: "retry_compacted" | "failed" }> {
	const state = createRuntimeRecoveryState();
	const limit = options.stopAfterPasses ?? 8;
	let passes = 0;
	let outcome: "retry_compacted" | "failed" = "retry_compacted";

	while (outcome === "retry_compacted") {
		passes++;
		if (passes > limit) throw new Error(`恢复链未在 ${limit} 轮内终止`);

		const result = preflightOverflowResult();
		const transition = selectRuntimeRecovery(state, {
			result,
			aborted: false,
			planApproved: false,
			stateful: true,
			maxTransientRetries: 10,
		});
		expect(transition.kind).toBe("overflow");
		// 预检没有完成 assistant 回合 → 上一轮的配额必须被保留，否则会退化成无限重试。
		expect(resetContextOverflowRetriesAfterProgress(state.overflowRetries, false)).toBe(
			state.overflowRetries,
		);
		if (transition.kind !== "overflow") break;
		state.overflowRetries = transition.retryCount;

		const overflow = await handleContextOverflow({
			narratorId: NARRATOR_ID,
			locale: "en",
			provider: "deepseek",
			model: "deepseek-v4.1-flash",
			overflowRetries: state.overflowRetries,
			maxRetries: MAX_CONTEXT_OVERFLOW_RETRIES,
			baselineCompactSeq: options.baselineSeq,
		});
		state.overflowRetries = overflow.overflowRetries;
		state.transientRetries = 0;
		outcome = overflow.action;
		if (passes >= limit) break;
	}

	return { passes, remainingQuota: state.overflowRetries, outcome };
}

beforeEach(() => {
	compactSeqQueue = [7];
	runCustomCompactCalls = 0;
	runCustomCompactImpl = async () => true;
	compactLocks.clear();
});

afterEach(() => {
	compactSeqQueue = [7];
	runCustomCompactCalls = 0;
	runCustomCompactImpl = async () => true;
	compactLocks.clear();
});

afterAll(() => {
	mock.module("../narrator-service", () => realNarratorService);
	mock.module("../narrator-session", () => realNarratorSession);
	mock.restore();
});

describe("预检驱动的溢出恢复有界", () => {
	test("压缩成功但预检仍超预算：只压缩 MAX_CONTEXT_OVERFLOW_RETRIES 次，然后报 max_retries_exceeded", async () => {
		compactSeqQueue = [7];

		const { passes, remainingQuota, outcome } = await replayUntilTerminal({ baselineSeq: 7 });

		expect(outcome).toBe("failed");
		// 第 1、2 轮各消耗一次配额做压缩，第 3 轮撞上限失败。
		expect(passes).toBe(MAX_CONTEXT_OVERFLOW_RETRIES + 1);
		expect(runCustomCompactCalls).toBe(MAX_CONTEXT_OVERFLOW_RETRIES);
		expect(remainingQuota).toBe(MAX_CONTEXT_OVERFLOW_RETRIES + 1);
	});

	test("压缩没有真正缩小上下文时立刻失败，不进入重试", async () => {
		compactSeqQueue = [7];
		runCustomCompactImpl = async () => false;

		const { passes, outcome } = await replayUntilTerminal({ baselineSeq: 7 });

		expect(outcome).toBe("failed");
		expect(passes).toBe(1);
		expect(runCustomCompactCalls).toBe(1);
	});

	test("沿用已完成的压缩不消耗配额，但配额仍是最终上界", async () => {
		// 第一轮：请求组装时基线是 -1，恢复时已有的压缩已推进到 7 → 直接重试，不花配额。
		// 之后不再有新的压缩完成，于是回到 Phase B，由配额在有限轮内终止。
		compactSeqQueue = [7, 7];

		const first = await replayUntilTerminal({ baselineSeq: -1, stopAfterPasses: 1 });
		expect(first.passes).toBe(1);
		expect(first.outcome).toBe("retry_compacted");
		expect(first.remainingQuota).toBe(0);
		expect(runCustomCompactCalls).toBe(0);

		compactSeqQueue = [7];
		const rest = await replayUntilTerminal({ baselineSeq: 7 });
		expect(rest.outcome).toBe("failed");
		expect(rest.passes).toBe(MAX_CONTEXT_OVERFLOW_RETRIES + 1);
		expect(runCustomCompactCalls).toBe(MAX_CONTEXT_OVERFLOW_RETRIES);
	});
});
