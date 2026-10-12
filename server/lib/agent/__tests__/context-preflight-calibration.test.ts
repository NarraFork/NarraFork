/**
 * 预检 × 模型校准的集成断言。
 *
 * 载体是那起真实事故：同一份内容（CJK 183,803 字符 + ASCII 738,946 字符 = 922,749 字符）
 * 在 hy4-preview 上被数成 638,848 token，在 deepseek-v4.1-flash 上被数成 1,080,519 token。
 * 全局系数算出 525,706，落在 1M 窗口的可用预算（1,048,576 − 20,000 = 1,028,576）之下，
 * 所以上线后的预检拦不住这一起；按模型实测比（约 1.17 token/字符）换算则是 1,079,617，能拦住。
 *
 * 这里同时钉住反方向：纯英文长会话在真实占用远不到窗口时，不能因为校准而被硬压缩。
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { settings } from "../../settings";
import {
	CONTEXT_CALIBRATION_FILE_PATH,
	recordContextCalibrationSample,
	resetContextCalibrationForTests,
} from "../context-calibration";
import {
	estimatePayloadTokens,
	evaluateContextPreflight,
	formatContextPreflightMessage,
	PREFLIGHT_BUFFER,
} from "../context-preflight";

/** 事故内容的字符构成。 */
const ACCIDENT_CJK_CHARS = 183_803;
const ACCIDENT_ASCII_CHARS = 738_946;
const ACCIDENT_TOTAL_CHARS = ACCIDENT_CJK_CHARS + ACCIDENT_ASCII_CHARS;

/** 事故发生的窗口与可用预算。 */
const ACCIDENT_WINDOW = 1_048_576;
const ACCIDENT_USABLE = ACCIDENT_WINDOW - PREFLIGHT_BUFFER;

/** 全局系数对这份内容的历史估算值（= 事故当时的记录值）。 */
const GLOBAL_ESTIMATE = 525_706;

const DENSE_MODEL = "deepseek-v4.1-flash";
const SPARSE_MODEL = "hy4-preview";

/** 事故内容的等价载荷：两个字符串，字符数与之一致。 */
function accidentPayload(): unknown[] {
	return ["中".repeat(ACCIDENT_CJK_CHARS), "a".repeat(ACCIDENT_ASCII_CHARS)];
}

/** 喂 n 条指定比值的样本（字符量足够大，不会碰到最小字符闸门）。 */
function seedRatio(model: string, ratio: number, samples = 5): void {
	for (let index = 0; index < samples; index++) {
		recordContextCalibrationSample(model, "test-provider", 100_000, Math.round(100_000 * ratio));
	}
}

function preflight(parts: readonly unknown[], model?: string) {
	const estimate = estimatePayloadTokens(parts, model ? { model } : undefined);
	return {
		estimate,
		verdict: evaluateContextPreflight({ contextWindow: ACCIDENT_WINDOW, estimate }),
	};
}

beforeEach(() => {
	resetContextCalibrationForTests();
	rmSync(CONTEXT_CALIBRATION_FILE_PATH, { force: true });
});

describe("事故场景：校准前拦不住，校准后能拦住", () => {
	test("没有样本时回退全局系数：估算 525,706，不触发拦截", () => {
		const { estimate, verdict } = preflight(accidentPayload(), DENSE_MODEL);

		expect(estimate.source).toBe("global-heuristic");
		expect(estimate.calibration).toBeNull();
		expect(estimate.chars).toBe(ACCIDENT_TOTAL_CHARS);
		expect(estimate.tokens).toBe(GLOBAL_ESTIMATE);
		expect(verdict.usableTokens).toBe(ACCIDENT_USABLE);
		expect(verdict.exceeded).toBe(false);
	});

	test("有该模型的实测比（1.17）时按字符数换算：估算 1,079,617，触发拦截", () => {
		seedRatio(DENSE_MODEL, 1.17);

		const { estimate, verdict } = preflight(accidentPayload(), DENSE_MODEL);

		expect(estimate.source).toBe("model-calibration");
		expect(estimate.calibration).toMatchObject({ model: DENSE_MODEL, ratio: 1.17, samples: 5 });
		expect(estimate.tokens).toBe(Math.ceil(ACCIDENT_TOTAL_CHARS * 1.17));
		expect(estimate.tokens).toBeGreaterThan(GLOBAL_ESTIMATE * 2);
		expect(verdict.exceeded).toBe(true);

		// 诊断串里能直接看出用的是模型实测比，事后核对"为什么拦"不需要再翻代码。
		const message = formatContextPreflightMessage(verdict, {
			provider: "deepseek",
			model: DENSE_MODEL,
		});
		expect(message).toContain("calibrated");
		expect(message).toContain(DENSE_MODEL);
	});

	test("样本只对采到的模型生效：另一个模型仍回退全局系数", () => {
		seedRatio(DENSE_MODEL, 1.17);

		const dense = preflight(accidentPayload(), DENSE_MODEL);
		const other = preflight(accidentPayload(), SPARSE_MODEL);

		expect(dense.verdict.exceeded).toBe(true);
		expect(other.estimate.source).toBe("global-heuristic");
		expect(other.estimate.tokens).toBe(GLOBAL_ESTIMATE);
		expect(other.verdict.exceeded).toBe(false);
	});

	test("没传模型时不改变任何行为（回退路径与校准上线前逐字节一致）", () => {
		seedRatio(DENSE_MODEL, 1.17);

		const withoutModel = estimatePayloadTokens(accidentPayload());
		const withUnknownModel = estimatePayloadTokens(accidentPayload(), { model: "nobody" });

		expect(withoutModel).toEqual(withUnknownModel);
		expect(withoutModel.tokens).toBe(GLOBAL_ESTIMATE);
		expect(withoutModel.source).toBe("global-heuristic");
	});
});

describe("误伤保护：稀疏模型的长会话不被硬压缩", () => {
	test("纯英文长会话：全局口径会误拦，校准后的真实密度不拦", () => {
		// 220 万 ASCII 字符 ≈ 55 万真实 token，只占 1M 窗口的一半。
		const english = ["a".repeat(2_200_000)];
		seedRatio(SPARSE_MODEL, 0.26);

		const global = preflight(english);
		expect(global.estimate.tokens).toBe(1_100_000);
		expect(global.verdict.exceeded).toBe(true); // 全局系数在这里误伤

		const calibrated = preflight(english, SPARSE_MODEL);
		expect(calibrated.estimate.source).toBe("model-calibration");
		expect(calibrated.estimate.tokens).toBe(Math.ceil(2_200_000 * 0.26));
		expect(calibrated.verdict.exceeded).toBe(false);
	});

	test("校准比全局系数低时绝不抬高估算", () => {
		seedRatio(SPARSE_MODEL, 0.26);
		const english = ["a".repeat(100_000)];

		const calibrated = preflight(english, SPARSE_MODEL);
		expect(calibrated.estimate.tokens).toBeLessThan(preflight(english).estimate.tokens);
	});
});

describe("开关关闭时回退全局系数", () => {
	test("已学样本被忽略，事故内容不再被拦", () => {
		seedRatio(DENSE_MODEL, 1.17);
		settings.agent.contextCalibrationEnabled = false;

		const { estimate, verdict } = preflight(accidentPayload(), DENSE_MODEL);

		expect(estimate.source).toBe("global-heuristic");
		expect(estimate.tokens).toBe(GLOBAL_ESTIMATE);
		expect(verdict.exceeded).toBe(false);
	});
});

describe("遍历提前结束（partial）时的校准口径", () => {
	test("仍按实测比换算，且不低于全局下界系数 0.25", () => {
		seedRatio(DENSE_MODEL, 0.3);
		const huge = ["a".repeat(4 * 1024 * 1024 + 1)];

		const { estimate } = preflight(huge, DENSE_MODEL);

		expect(estimate.partial).toBe(true);
		expect(estimate.tokens).toBe(Math.ceil((4 * 1024 * 1024 + 1) * 0.3));
	});
});
