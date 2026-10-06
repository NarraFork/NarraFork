import { describe, expect, test } from "bun:test";
import { coerceAskQuestions } from "../ask-user-question-coerce";

describe("coerceAskQuestions", () => {
	test("accepts the advertised short-header + full-description shape", () => {
		const questions = coerceAskQuestions([
			{
				header: "写路径权限策略",
				description: "背景: 内网已全放行；云端 key 未挂权限点。写路径权限模型选哪个？",
				options: [
					{ header: "挂权限点", description: "推荐" },
					{ header: "维持现状", description: "" },
				],
			},
		]);

		expect(questions).toHaveLength(1);
		expect(questions[0]?.header).toBe("写路径权限策略");
		expect(questions[0]?.description).toBe(
			"背景: 内网已全放行；云端 key 未挂权限点。写路径权限模型选哪个？",
		);
		expect(questions[0]?.options[0]?.header).toBe("挂权限点");
		expect(questions[0]?.id.length).toBeGreaterThan(0);
		expect(questions[0]?.id.length).toBeLessThanOrEqual(32);
	});

	test("maps legacy short header + long question body into title/description", () => {
		const body =
			"背景: 我核实了 lan.go#L39-L81——内网全放行；云端 key 逐点授予。写路径权限模型选哪个？";
		const questions = coerceAskQuestions([
			{
				question: body,
				header: "写端点权限",
				options: [{ label: "挂权限点", description: "推荐" }],
			},
		]);

		expect(questions).toHaveLength(1);
		expect(questions[0]?.header).toBe("写端点权限");
		expect(questions[0]?.description).toBe(body);
		expect(questions[0]?.options[0]?.header).toBe("挂权限点");
	});

	test("keeps a long-only header readable (no duplicate description)", () => {
		const body = "一整段被塞进 header 的长问题正文，最终怎么选？";
		const questions = coerceAskQuestions([{ header: body, options: [{ header: "A" }] }]);
		expect(questions[0]?.header).toBe(body);
		expect(questions[0]?.description).toBeUndefined();
	});

	test("maps legacy key-like question into internal id and keeps header title", () => {
		const questions = coerceAskQuestions([
			{
				question: "max-enum",
				header: "max 档位怎么处理",
				description: "全局加 max 还是维持现状？",
				options: [{ label: "方案A", description: "全局加 max" }],
			},
		]);

		expect(questions[0]?.id).toBe("max-enum");
		expect(questions[0]?.header).toBe("max 档位怎么处理");
		expect(questions[0]?.description).toBe("全局加 max 还是维持现状？");
		expect(questions[0]?.options[0]?.header).toBe("方案A");
	});

	test("uniquifies colliding headers so answers cannot overwrite", () => {
		const questions = coerceAskQuestions([
			{ header: "测试策略", options: [{ header: "A" }] },
			{ header: "测试策略", options: [{ header: "B" }] },
		]);

		expect(questions[0]?.id).not.toBe(questions[1]?.id);
		expect(questions.map((q) => q.header)).toEqual(["测试策略", "测试策略 (2)"]);
	});

	test("replaces placeholder keys and parses stringified arrays", () => {
		const questions = coerceAskQuestions(
			JSON.stringify([
				{
					question: "undefined",
					header: "策略",
					options: [{ label: "A", description: "" }],
				},
			]),
		);

		expect(questions).toHaveLength(1);
		expect(questions[0]?.header).toBe("策略");
		expect(questions[0]?.id.length).toBeGreaterThan(0);
		expect(questions[0]?.options[0]?.header).toBe("A");
	});

	test("falls back to positional header when nothing readable exists", () => {
		const questions = coerceAskQuestions([{ options: [{ label: "A" }] }, {}]);
		expect(questions.map((q) => q.header)).toEqual(["Question 1", "Question 2"]);
	});

	test("returns empty array for unrecoverable input", () => {
		expect(coerceAskQuestions("not json")).toEqual([]);
		expect(coerceAskQuestions(null)).toEqual([]);
		expect(coerceAskQuestions(42)).toEqual([]);
	});
});
