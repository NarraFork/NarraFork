import { describe, expect, test } from "bun:test";
import { estimateTokens } from "../estimate-tokens";

/**
 * 事故请求的字符构成（UTF-8 body 3,077,644 字节，被 deepseek 的分词器数成 1,080,519 token）。
 * 它同时是"字符法必然低估"的实测反证：本函数的 ASCII 系数只有 0.5，而这份内容的
 * ASCII（JSON 结构符号 / 代码 / 路径）实测约 1.31 token/字符。
 */
const INCIDENT_CJK_CHARS = 183_803;
const INCIDENT_ASCII_CHARS = 738_946;
/** 旧系数（ASCII 0.3 / CJK 0.6）对同一构型的估值 331,966。 */
const LEGACY_COEFFICIENT_ESTIMATE = Math.ceil(
	INCIDENT_CJK_CHARS * 0.6 + INCIDENT_ASCII_CHARS * 0.3,
);

describe("estimateTokens", () => {
	test("纯 ASCII 按 0.5 token/字符估算", () => {
		expect(estimateTokens("a".repeat(100))).toBe(50);
		expect(estimateTokens("a".repeat(1000))).toBe(500);
	});

	test("纯 CJK 按 0.85 token/字符估算", () => {
		expect(estimateTokens("中".repeat(100))).toBe(85);
		// 0.85 在二进制里不精确，逐字符累加后 ceil 最多多进一位（850 → 851）。
		// 方向仍是"宁可高估"，因此这里断言区间而不是钉死单值。
		const large = estimateTokens("中".repeat(1000));
		expect(large).toBeGreaterThanOrEqual(850);
		expect(large).toBeLessThanOrEqual(851);
	});

	test("混合内容按两类字符各自累加", () => {
		expect(estimateTokens("a".repeat(100) + "中".repeat(100))).toBe(135);
		// 拼接顺序不影响结果
		expect(estimateTokens("中".repeat(100) + "a".repeat(100))).toBe(135);
	});

	test("非 CJK 字符（拉丁扩展、标点符号）归入 ASCII 桶", () => {
		expect(estimateTokens("é".repeat(100))).toBe(50);
		// "( { [ ] } ) , :" 共 8 个字符
		expect(estimateTokens("({[]}),:".repeat(100))).toBe(400);
	});

	test("非整数结果向上取整，预算是安全一侧", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("a")).toBe(1);
		expect(estimateTokens("ab")).toBe(1);
		expect(estimateTokens("abc")).toBe(2);
		expect(estimateTokens("中")).toBe(1);
		expect(estimateTokens("中中")).toBe(2);
	});

	test("回归保护：事故请求的字符构成不再停在 0.3/0.6 时代的低估水平", () => {
		const estimate = estimateTokens(
			"中".repeat(INCIDENT_CJK_CHARS) + "a".repeat(INCIDENT_ASCII_CHARS),
		);

		// 新系数的确定值：183803×0.85 + 738946×0.5 = 525,705.55 → 525,706
		expect(estimate).toBe(525_706);
		// 下界：必须明显高于旧系数给出的 331,966（那正是"低估到 0.3 时代"的量级），
		// 否则等于回到撞墙事故的起点。
		expect(estimate).toBeGreaterThan(LEGACY_COEFFICIENT_ESTIMATE);
		expect(estimate).toBeGreaterThanOrEqual(500_000);
		// 但它仍然是低估——真实值是 1,080,519。这条断言把"字符法给不出精确值"这个
		// 已知局限钉住，避免有人把 0.5/0.85 当成可靠上界（那会让下游放松防线）。
		expect(estimate).toBeLessThan(1_080_519);
	});
});
