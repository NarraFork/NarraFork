/**
 * 按模型校准"字符 → token"换算比的口径测试。
 *
 * 这里钉住的是**采样与配对的可信性**：并发/重试不串台、失败请求不污染样本、样本不足回退、
 * 比值越界被闸门挡下、滑动窗口与文件上限生效。
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { settings } from "../../settings";
import {
	CALIBRATION_RATIO_QUANTILE,
	CONTEXT_CALIBRATION_FILE_PATH,
	calibrationRatioFromSamples,
	contextCalibrationRatioFor,
	createContextCalibrationProbe,
	getContextCalibrationStats,
	isUsableSample,
	MAX_CALIBRATION_FILE_BYTES,
	MAX_CALIBRATION_MODELS,
	MAX_CALIBRATION_SAMPLES_PER_MODEL,
	MIN_CALIBRATION_SAMPLES,
	persistContextCalibrationForTests,
	recordContextCalibrationSample,
	resetContextCalibrationForTests,
} from "../context-calibration";

const MODEL = "deepseek-v4.1-flash";
const CHARS = 100_000;

/** 喂 n 条指定比值的样本。 */
function seed(model: string, ratios: readonly number[], chars = CHARS): void {
	for (const ratio of ratios) {
		recordContextCalibrationSample(model, "test-provider", chars, Math.round(chars * ratio));
	}
}

/** 从落盘文件读回样本（文件是样本窗口的只读出口，用于核对配对是否正确）。 */
function persistedSamples(model: string): Array<[number, number]> {
	const parsed = JSON.parse(readFileSync(CONTEXT_CALIBRATION_FILE_PATH, "utf-8")) as {
		models: Record<string, { samples: Array<[number, number]> }>;
	};
	return parsed.models[model]?.samples ?? [];
}

function waitForFile(path: string, timeoutMs = 2000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	return (async () => {
		while (Date.now() < deadline) {
			if (existsSync(path)) return true;
			await Bun.sleep(20);
		}
		return existsSync(path);
	})();
}

beforeEach(() => {
	resetContextCalibrationForTests();
	rmSync(CONTEXT_CALIBRATION_FILE_PATH, { force: true });
});

describe("isUsableSample — 样本闸门", () => {
	test("字符量太小、token 非正、比值越界的样本一律不可用", () => {
		expect(isUsableSample({ chars: 100_000, tokens: 117_000 })).toBe(true);
		expect(isUsableSample({ chars: 999, tokens: 500 })).toBe(false);
		expect(isUsableSample({ chars: 100_000, tokens: 0 })).toBe(false);
		expect(isUsableSample({ chars: 100_000, tokens: -1 })).toBe(false);
		expect(isUsableSample({ chars: 100_000, tokens: 900_000 })).toBe(false); // 9 token/字符
		expect(isUsableSample({ chars: 100_000, tokens: 1_000 })).toBe(false); // 0.01 token/字符
		expect(isUsableSample({ chars: Number.NaN, tokens: 1000 })).toBe(false);
	});
});

describe("calibrationRatioFromSamples — 分位数口径", () => {
	test("取上分位而不是均值：单个极端样本不会把比值带偏", () => {
		const samples = [
			{ chars: 100_000, tokens: 25_000 },
			{ chars: 100_000, tokens: 26_000 },
			{ chars: 100_000, tokens: 27_000 },
			{ chars: 100_000, tokens: 28_000 },
			{ chars: 100_000, tokens: 200_000 }, // 极端样本（几乎全 JSON，2 token/字符）
		];
		const ratio = calibrationRatioFromSamples(samples);
		// 均值会被带到 0.61；上分位仍落在第四小的样本上。
		expect(ratio).toBeCloseTo(0.28, 5);
		const mean = samples.reduce((sum, s) => sum + s.tokens / s.chars, 0) / samples.length;
		expect(ratio as number).toBeLessThan(mean);
	});

	test("不可用样本被排除；全部不可用时返回 null", () => {
		expect(calibrationRatioFromSamples([])).toBeNull();
		expect(calibrationRatioFromSamples([{ chars: 10, tokens: 5 }])).toBeNull();
		expect(
			calibrationRatioFromSamples([
				{ chars: 10, tokens: 5 },
				{ chars: 100_000, tokens: 50_000 },
			]),
		).toBeCloseTo(0.5, 5);
	});

	test("分位数位置对单调序列稳定", () => {
		const samples = [1, 2, 3, 4, 5, 6, 7, 8].map((step) => ({
			chars: 100_000,
			tokens: step * 10_000,
		}));
		// ceil(0.75 × 8) = 6 → 第 6 小的样本（0.6）。
		expect(calibrationRatioFromSamples(samples, CALIBRATION_RATIO_QUANTILE)).toBeCloseTo(0.6, 5);
	});
});

describe("采样探针 — 配对、重试与失败隔离", () => {
	test("一次请求的字符数与 usage 配成一条样本", async () => {
		const probe = createContextCalibrationProbe();
		probe.begin("deepseek", MODEL, CHARS);
		probe.observe(117_000);
		probe.flush();

		await persistContextCalibrationForTests();
		expect(persistedSamples(MODEL)).toEqual([[CHARS, 117_000]]);
	});

	test("失败/中断的请求（没有 usage）不产生样本", () => {
		const probe = createContextCalibrationProbe();
		probe.begin("deepseek", MODEL, CHARS);
		probe.flush();
		probe.begin("deepseek", MODEL, CHARS);
		probe.flush();

		expect(getContextCalibrationStats()).toEqual([]);
		// 没有样本 → 连节流落盘都不会被触发，磁盘上不该出现文件。
		expect(existsSync(CONTEXT_CALIBRATION_FILE_PATH)).toBe(false);
	});

	test("重试：每一轮只与自己的字符数配对，上一轮的悬空槽位不会串到下一轮", async () => {
		const probe = createContextCalibrationProbe();
		// 第一轮：测到了字符数，但请求失败、没有 usage。
		probe.begin("deepseek", MODEL, 10_000);
		probe.flush();
		// 第二轮：历史变长了，字符数不同，正常返回。
		probe.begin("deepseek", MODEL, 200_000);
		probe.observe(234_000);
		probe.flush();

		await persistContextCalibrationForTests();
		expect(persistedSamples(MODEL)).toEqual([[200_000, 234_000]]);
	});

	test("同一轮多次上报 usage 时取最大值（部分计数器不能当最终值）", async () => {
		const probe = createContextCalibrationProbe();
		probe.begin("deepseek", MODEL, CHARS);
		probe.observe(1000); // 中间值
		probe.observe(117_000); // 最终值
		probe.observe(50); // 迟到的零头
		probe.flush();

		await persistContextCalibrationForTests();
		expect(persistedSamples(MODEL)).toEqual([[CHARS, 117_000]]);
	});

	test("下一轮 begin 会结掉上一轮尚未 flush 的可信配对", async () => {
		const probe = createContextCalibrationProbe();
		probe.begin("deepseek", MODEL, CHARS);
		probe.observe(117_000);
		// 没有显式 flush（例如循环走了别的出口）也要落账。
		probe.begin("deepseek", MODEL, CHARS);
		probe.observe(120_000);
		probe.flush();

		await persistContextCalibrationForTests();
		expect(persistedSamples(MODEL)).toEqual([
			[CHARS, 117_000],
			[CHARS, 120_000],
		]);
	});

	test("非法 usage（0 / 负数 / NaN / 缺失）不产生样本", async () => {
		const probe = createContextCalibrationProbe();
		probe.begin("deepseek", MODEL, CHARS);
		probe.observe(0);
		probe.observe(-1);
		probe.observe(Number.NaN);
		probe.observe(undefined);
		probe.flush();

		expect(getContextCalibrationStats()).toEqual([]);
	});

	test("拿不到字符数（null / 0 / 非有限）时本轮不采样", async () => {
		const probe = createContextCalibrationProbe();
		for (const chars of [null, 0, -1, Number.NaN, undefined]) {
			probe.begin("deepseek", MODEL, chars);
			probe.observe(117_000);
			probe.flush();
		}
		expect(getContextCalibrationStats()).toEqual([]);
	});

	test("探针相互独立：并发叙述者不会互相覆盖", async () => {
		const first = createContextCalibrationProbe();
		const second = createContextCalibrationProbe();
		first.begin("provider-a", "model-a", 100_000);
		second.begin("provider-b", "model-b", 400_000);
		first.observe(25_000);
		second.observe(500_000);
		second.flush();
		first.flush();

		await persistContextCalibrationForTests();
		expect(persistedSamples("model-a")).toEqual([[100_000, 25_000]]);
		expect(persistedSamples("model-b")).toEqual([[400_000, 500_000]]);
	});
});

describe("聚合与查询", () => {
	test("样本不足时视为无数据，回退全局系数", () => {
		seed(MODEL, [1.17, 1.17, 1.17, 1.17]);
		expect(getContextCalibrationStats()).toMatchObject([
			{ model: MODEL, samples: MIN_CALIBRATION_SAMPLES - 1, ratio: null },
		]);
		expect(contextCalibrationRatioFor(MODEL)).toBeNull();

		seed(MODEL, [1.17]);
		const ratio = contextCalibrationRatioFor(MODEL);
		expect(ratio?.ratio).toBeCloseTo(1.17, 5);
		expect(ratio?.samples).toBe(5);
	});

	test("模型之间互不影响", () => {
		seed("model-a", [0.3, 0.3, 0.3, 0.3, 0.3]);
		seed("model-b", [1.2, 1.2, 1.2, 1.2, 1.2]);
		expect(contextCalibrationRatioFor("model-a")?.ratio).toBeCloseTo(0.3, 5);
		expect(contextCalibrationRatioFor("model-b")?.ratio).toBeCloseTo(1.2, 5);
		expect(contextCalibrationRatioFor("model-c")).toBeNull();
	});

	test("滑动窗口只保留最近 N 条样本", async () => {
		seed(MODEL, new Array(6).fill(0.5));
		seed(MODEL, new Array(MAX_CALIBRATION_SAMPLES_PER_MODEL).fill(1.0));

		const stats = getContextCalibrationStats();
		expect(stats[0]?.samples).toBe(MAX_CALIBRATION_SAMPLES_PER_MODEL);
		// 旧的 0.5 已被挤出窗口，比值只剩新样本的 1.0。
		expect(stats[0]?.ratio).toBeCloseTo(1, 5);

		await persistContextCalibrationForTests();
		expect(persistedSamples(MODEL)).toHaveLength(MAX_CALIBRATION_SAMPLES_PER_MODEL);
	});
});

describe("开关", () => {
	test("默认开启", () => {
		expect(contextCalibrationRatioFor(MODEL)).toBeNull();
		seed(MODEL, [1.17, 1.17, 1.17, 1.17, 1.17]);
		expect(contextCalibrationRatioFor(MODEL)?.ratio).toBeCloseTo(1.17, 5);
	});

	test("关闭时不采集、不生效（预检因此回退全局系数）", () => {
		settings.agent.contextCalibrationEnabled = false;
		seed(MODEL, [1.17, 1.17, 1.17, 1.17, 1.17]);
		expect(getContextCalibrationStats()).toEqual([]);
		expect(contextCalibrationRatioFor(MODEL)).toBeNull();

		const probe = createContextCalibrationProbe();
		probe.begin("deepseek", MODEL, CHARS);
		probe.observe(117_000);
		probe.flush();
		expect(getContextCalibrationStats()).toEqual([]);
	});

	test("关闭时不再改磁盘上的文件", async () => {
		seed(MODEL, [1.17, 1.17, 1.17, 1.17, 1.17]);
		await persistContextCalibrationForTests();
		const before = readFileSync(CONTEXT_CALIBRATION_FILE_PATH, "utf-8");

		settings.agent.contextCalibrationEnabled = false;
		seed(MODEL, new Array(40).fill(2));
		await Bun.sleep(50);
		expect(readFileSync(CONTEXT_CALIBRATION_FILE_PATH, "utf-8")).toBe(before);
	});

	test("重新开启后已学到的样本仍然可用", () => {
		seed(MODEL, [1.17, 1.17, 1.17, 1.17, 1.17]);
		settings.agent.contextCalibrationEnabled = false;
		expect(contextCalibrationRatioFor(MODEL)).toBeNull();
		settings.agent.contextCalibrationEnabled = undefined;
		expect(contextCalibrationRatioFor(MODEL)?.ratio).toBeCloseTo(1.17, 5);
	});
});

describe("持久化", () => {
	test("节流：单条样本不会立刻写盘，累积到上限才立即写一次", async () => {
		recordContextCalibrationSample(MODEL, "p", CHARS, 117_000);
		expect(existsSync(CONTEXT_CALIBRATION_FILE_PATH)).toBe(false);

		seed(MODEL, new Array(19).fill(1.17));
		expect(await waitForFile(CONTEXT_CALIBRATION_FILE_PATH)).toBe(true);
	});

	test("重启后从磁盘装载", async () => {
		seed("model-a", [0.31, 0.31, 0.31, 0.31, 0.31]);
		await persistContextCalibrationForTests();

		resetContextCalibrationForTests(); // 模拟进程重启：内存清空，文件保留
		expect(contextCalibrationRatioFor("model-a")?.ratio).toBeCloseTo(0.31, 5);
	});

	test("文件损坏时静默从零开始，且之后仍能采集", async () => {
		writeFileSync(CONTEXT_CALIBRATION_FILE_PATH, "{{{ 这不是 JSON");
		resetContextCalibrationForTests();
		expect(getContextCalibrationStats()).toEqual([]);
		expect(contextCalibrationRatioFor(MODEL)).toBeNull();

		seed(MODEL, [1.17, 1.17, 1.17, 1.17, 1.17]);
		expect(contextCalibrationRatioFor(MODEL)?.ratio).toBeCloseTo(1.17, 5);
	});

	test("文件内非法字段被丢弃", async () => {
		writeFileSync(
			CONTEXT_CALIBRATION_FILE_PATH,
			JSON.stringify({
				version: 1,
				models: {
					good: { provider: "p", updatedAt: 1, samples: [[100_000, 30_000]] },
					bad: { provider: 3, updatedAt: "x", samples: [["a", "b"], [100, 5], null] },
					empty: { samples: [] },
				},
			}),
		);
		resetContextCalibrationForTests();
		const stats = getContextCalibrationStats();
		expect(stats.map((entry) => entry.model)).toEqual(["good"]);
		expect(stats[0]?.provider).toBe("p");
	});

	test("模型数上限：超出时淘汰最久未更新的模型", async () => {
		recordContextCalibrationSample("old-model", "p", CHARS, 30_000);
		await Bun.sleep(5);
		for (let index = 0; index < MAX_CALIBRATION_MODELS; index++) {
			recordContextCalibrationSample(`model-${index}`, "p", CHARS, 30_000);
		}

		const stats = getContextCalibrationStats();
		expect(stats).toHaveLength(MAX_CALIBRATION_MODELS);
		expect(stats.some((entry) => entry.model === "old-model")).toBe(false);
	});

	test("落盘文件不超过字节上限", async () => {
		for (let index = 0; index < MAX_CALIBRATION_MODELS; index++) {
			seed(`model-${index}`, new Array(MAX_CALIBRATION_SAMPLES_PER_MODEL).fill(1.17));
		}
		await persistContextCalibrationForTests();
		const bytes = readFileSync(CONTEXT_CALIBRATION_FILE_PATH).byteLength;
		expect(bytes).toBeLessThanOrEqual(MAX_CALIBRATION_FILE_BYTES);
	});
});
