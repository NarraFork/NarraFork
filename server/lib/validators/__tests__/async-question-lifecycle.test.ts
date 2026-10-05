import { describe, expect, test } from "bun:test";
import {
	asyncQuestionAnswerSchema,
	asyncQuestionDetailQuerySchema,
	asyncQuestionListQuerySchema,
	asyncQuestionSupplementSchema,
} from "../narrators";

describe("async question lifecycle inputs", () => {
	test("supports all inbox views and legacy status queries", () => {
		for (const filter of ["all", "open", "pending", "history"] as const) {
			expect(asyncQuestionListQuerySchema.parse({ filter, limit: "32" })).toEqual({
				filter,
				limit: 32,
			});
		}
		expect(asyncQuestionListQuerySchema.parse({ status: "answered" })).toEqual({
			status: "answered",
		});
	});

	test("bounds list and detail pagination", () => {
		for (const schema of [asyncQuestionListQuerySchema, asyncQuestionDetailQuerySchema]) {
			expect(schema.safeParse({ limit: 33 }).success).toBe(false);
			expect(schema.safeParse({ limit: 0 }).success).toBe(false);
			expect(schema.safeParse({ cursor: "" }).success).toBe(false);
			expect(schema.safeParse({ cursor: "x".repeat(2049) }).success).toBe(false);
			const cursor = schema === asyncQuestionDetailQuerySchema ? "42" : "next";
			expect(schema.parse({ cursor, limit: "16" })).toEqual({ cursor, limit: 16 });
		}
		expect(asyncQuestionListQuerySchema.safeParse({ filter: "resolved" }).success).toBe(false);
	});

	test("validates event cursors and aggregate UTF-8 answer budgets", () => {
		expect(asyncQuestionDetailQuerySchema.safeParse({ cursor: "opaque" }).success).toBe(false);
		expect(asyncQuestionDetailQuerySchema.safeParse({ cursor: "9007199254740992" }).success).toBe(
			false,
		);
		expect(
			asyncQuestionAnswerSchema.safeParse({ answers: { choice: "中".repeat(6000) } }).success,
		).toBe(false);
		expect(
			asyncQuestionAnswerSchema.safeParse({
				answers: { choice: "x".repeat(9000) },
				annotations: { choice: { notes: "x".repeat(9000) } },
			}).success,
		).toBe(false);
		expect(asyncQuestionSupplementSchema.safeParse({ text: "中".repeat(6000) }).success).toBe(
			false,
		);
	});

	test("supplements carry a structured answer reference and preserve text", () => {
		expect(
			asyncQuestionSupplementSchema.parse({
				text: "  更正：使用正常登录。  ",
				answerMessageId: "answer-1",
			}),
		).toEqual({ text: "  更正：使用正常登录。  ", answerMessageId: "answer-1" });
		expect(asyncQuestionSupplementSchema.safeParse({ text: "   " }).success).toBe(false);
		expect(asyncQuestionSupplementSchema.safeParse({ text: "a".repeat(16_385) }).success).toBe(
			false,
		);
		expect(
			asyncQuestionSupplementSchema.safeParse({ text: "补充", answerMessageId: "" }).success,
		).toBe(false);
	});
});
