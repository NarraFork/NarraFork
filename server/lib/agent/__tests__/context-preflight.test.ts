import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONTEXT_WINDOW, settings } from "../../settings";
import {
	estimatePayloadTokens,
	evaluateContextPreflight,
	formatContextPreflightMessage,
	isContextPreflightEnabled,
	MAX_PREFLIGHT_CHARS,
	MAX_PREFLIGHT_DEPTH,
	MAX_PREFLIGHT_NODES,
	PREFLIGHT_BUFFER,
	preflightReserveTokens,
} from "../context-preflight";
import { estimateTokens } from "../estimate-tokens";

const originalContextPreflightEnabled = settings.agent.contextPreflightEnabled;

afterEach(() => {
	settings.agent.contextPreflightEnabled = originalContextPreflightEnabled;
});

describe("estimatePayloadTokens — 轻量遍历", () => {
	test("字符串按 estimateTokens 的字符口径计入", () => {
		const ascii = estimatePayloadTokens(["abcdefgh"]);
		// 只钉住判定用得到的字段：估算对象另外带 chars/source/calibration 三个诊断字段。
		expect(ascii).toMatchObject({ tokens: estimateTokens("abcdefgh"), partial: false });
		expect(ascii.tokens).toBe(4);

		// CJK 单字符系数更高：同样 8 个字符，中文估出的 token 更多。
		const cjk = estimatePayloadTokens(["中文字符内容测试"]);
		expect(cjk.tokens).toBeGreaterThan(ascii.tokens);
		expect(cjk.partial).toBe(false);
	});

	test("遍历嵌套对象/数组，并把对象键折算成结构 token", () => {
		const withKeys = estimatePayloadTokens([{ description: "abcd", schema: { type: "object" } }]);
		const valuesOnly = estimatePayloadTokens([{ d: "abcd", s: "object" }]);
		// 键名本身也会变成 token，所以长键名的估算必须更高。
		expect(withKeys.tokens).toBeGreaterThan(valuesOnly.tokens);
	});

	test("多个分片累加，覆盖 content/history/tools 这类拆分输入", () => {
		const single = estimatePayloadTokens(["abcd"]);
		const split = estimatePayloadTokens(["ab", ["cd", "ef"], [{ a: "" }]]);
		expect(single.tokens).toBe(2);
		expect(split.tokens).toBeGreaterThan(single.tokens);
		expect(split.partial).toBe(false);
	});

	test("非字符串标量只承担结构字符，不会把数字当成巨大内容", () => {
		const estimate = estimatePayloadTokens([[1, 2, 3, 4, 5]]);
		expect(estimate.tokens).toBeLessThanOrEqual(5);
		expect(estimate.partial).toBe(false);
	});

	test("超过深度上限只跳过该子树：标记 partial，但仍继续统计兄弟节点", () => {
		let deep: unknown = "leaf";
		for (let i = 0; i < MAX_PREFLIGHT_DEPTH + 4; i++) deep = { nested: deep };
		const estimate = estimatePayloadTokens([{ deep, sibling: "x".repeat(1_000) }]);
		expect(estimate.partial).toBe(true);
		// 兄弟节点的内容仍然被算进来（不是整次遍历作废）。
		expect(estimate.tokens).toBeGreaterThanOrEqual(estimateTokens("x".repeat(1_000)));
	});

	test("超过节点上限时标记 partial，遍历有界（节点开销比逐字符分类贵一个量级）", () => {
		const nodes: unknown[] = [];
		for (let i = 0; i < MAX_PREFLIGHT_NODES + 1_000; i++) nodes.push({ a: "x" });
		const estimate = estimatePayloadTokens([nodes]);
		expect(estimate.partial).toBe(true);
	});

	test("自引用结构不会卡死（深度上限兜住）", () => {
		const cyclic: Record<string, unknown> = { role: "user", content: "abcd" };
		cyclic.self = cyclic;
		const estimate = estimatePayloadTokens([cyclic]);
		expect(estimate.partial).toBe(true);
		expect(estimate.tokens).toBeGreaterThan(0);
	});

	test("遍历不完整时用已数到的字符数换算下界", () => {
		// 单个超长字符串直接顶到字符上限：已数到的 4M 字符本身就是可靠下界。
		const estimate = estimatePayloadTokens(["a".repeat(MAX_PREFLIGHT_CHARS + 1)]);
		expect(estimate.partial).toBe(true);
		expect(estimate.tokens).toBeGreaterThanOrEqual(MAX_PREFLIGHT_CHARS * 0.25);
	});

	test("约 60 万字符的样本远快于阻塞阈值（回归护栏：不允许退化成整串序列化）", () => {
		const sample = [
			`${"tool output line\n".repeat(35_000)}`,
			[{ role: "user", content: "中".repeat(10_000) }],
		];
		const started = performance.now();
		const estimate = estimatePayloadTokens(sample);
		const durationMs = performance.now() - started;
		expect(estimate.partial).toBe(false);
		expect(estimate.tokens).toBeGreaterThan(100_000);
		// 实测约 4ms/2.3M 字符；这里给足余量，只拦数量级级别的退化。
		expect(durationMs).toBeLessThan(200);
	});
});

describe("preflightReserveTokens — 输出预留下限", () => {
	test("取 maxOutputTokens 与 PREFLIGHT_BUFFER 的较大者", () => {
		expect(preflightReserveTokens(64_000)).toBe(64_000);
		expect(preflightReserveTokens(4_096)).toBe(PREFLIGHT_BUFFER);
	});

	test("取不到/非法值时用 PREFLIGHT_BUFFER 兜底", () => {
		expect(preflightReserveTokens(undefined)).toBe(PREFLIGHT_BUFFER);
		expect(preflightReserveTokens(null)).toBe(PREFLIGHT_BUFFER);
		expect(preflightReserveTokens(0)).toBe(PREFLIGHT_BUFFER);
		expect(preflightReserveTokens(-1)).toBe(PREFLIGHT_BUFFER);
		expect(preflightReserveTokens(Number.NaN)).toBe(PREFLIGHT_BUFFER);
	});
});

describe("evaluateContextPreflight — 绝对预算判定", () => {
	test("预算内不拦", () => {
		const verdict = evaluateContextPreflight({
			contextWindow: 200_000,
			maxOutputTokens: null,
			estimate: { tokens: 179_000, partial: false },
		});
		expect(verdict).toMatchObject({
			exceeded: false,
			contextWindow: 200_000,
			reservedTokens: PREFLIGHT_BUFFER,
			usableTokens: 180_000,
			estimatedTokens: 179_000,
		});
	});

	test("超出可用预算即拦（等号不拦，超一 token 就拦）", () => {
		const atLimit = evaluateContextPreflight({
			contextWindow: 200_000,
			maxOutputTokens: null,
			estimate: { tokens: 180_000, partial: false },
		});
		expect(atLimit.exceeded).toBe(false);

		const over = evaluateContextPreflight({
			contextWindow: 200_000,
			maxOutputTokens: null,
			estimate: { tokens: 180_001, partial: false },
		});
		expect(over.exceeded).toBe(true);
	});

	test("遍历不完整（partial）本身不构成超预算，只按下界比较", () => {
		// 结构极深但内容很少的对象（例如还没转成 JSON 的 schema 对象）会命中深度上限，
		// 此时估算只是下界，绝不能据此拦掉一个正常请求——那是 2026-10 回归里踩过的坑。
		const structuralOnly = evaluateContextPreflight({
			contextWindow: 200_000,
			maxOutputTokens: null,
			estimate: { tokens: 38_987, partial: true },
		});
		expect(structuralOnly.exceeded).toBe(false);
		expect(structuralOnly.partial).toBe(true);

		// 但下界本身超预算时仍然要拦（例如字符上限兜住的超大输入）。
		const hugeLowerBound = evaluateContextPreflight({
			contextWindow: 200_000,
			maxOutputTokens: null,
			estimate: { tokens: 400_000, partial: true },
		});
		expect(hugeLowerBound.exceeded).toBe(true);
	});

	test("窗口取不到时用兜底窗口继续检查，不 fail-open（与 opencode 的有意分歧）", () => {
		const justUnder = evaluateContextPreflight({
			contextWindow: null,
			maxOutputTokens: null,
			estimate: { tokens: DEFAULT_CONTEXT_WINDOW - PREFLIGHT_BUFFER, partial: false },
		});
		expect(justUnder.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
		expect(justUnder.exceeded).toBe(false);

		const justOver = evaluateContextPreflight({
			contextWindow: null,
			maxOutputTokens: null,
			estimate: { tokens: DEFAULT_CONTEXT_WINDOW - PREFLIGHT_BUFFER + 1, partial: false },
		});
		expect(justOver.exceeded).toBe(true);

		for (const contextWindow of [undefined, 0, -1, Number.NaN]) {
			expect(
				evaluateContextPreflight({
					contextWindow,
					maxOutputTokens: null,
					estimate: { tokens: DEFAULT_CONTEXT_WINDOW, partial: false },
				}).exceeded,
			).toBe(true);
		}
	});

	test("maxOutputTokens 超过缓冲时，预留改用模型元数据", () => {
		const verdict = evaluateContextPreflight({
			contextWindow: 200_000,
			maxOutputTokens: 64_000,
			estimate: { tokens: 140_000, partial: false },
		});
		expect(verdict.reservedTokens).toBe(64_000);
		expect(verdict.usableTokens).toBe(136_000);
		expect(verdict.exceeded).toBe(true);
	});
});

describe("isContextPreflightEnabled — 开关语义", () => {
	test("默认开启", () => {
		expect(isContextPreflightEnabled()).toBe(true);
	});

	test("显式关闭后不再预检，恢复默认值后重新开启", () => {
		settings.agent.contextPreflightEnabled = false;
		expect(isContextPreflightEnabled()).toBe(false);
		settings.agent.contextPreflightEnabled = undefined;
		expect(isContextPreflightEnabled()).toBe(true);
	});
});

describe("formatContextPreflightMessage", () => {
	test("带上估算值、可用预算与模型标识", () => {
		const message = formatContextPreflightMessage(
			{
				exceeded: true,
				contextWindow: 200_000,
				reservedTokens: 20_000,
				usableTokens: 180_000,
				estimatedTokens: 250_000,
				partial: false,
			},
			{ provider: "anthropic", model: "claude-x" },
		);
		expect(message).toContain("250000");
		expect(message).toContain("180000");
		expect(message).toContain("anthropic:claude-x");
	});

	test("估算只是下界时明确说明", () => {
		const message = formatContextPreflightMessage(
			{
				exceeded: true,
				contextWindow: 200_000,
				reservedTokens: 20_000,
				usableTokens: 180_000,
				estimatedTokens: 190_000,
				partial: true,
			},
			{ provider: "anthropic", model: "claude-x" },
		);
		expect(message).toContain("at least 190000");
	});
});
