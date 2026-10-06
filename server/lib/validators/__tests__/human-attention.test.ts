import { describe, expect, test } from "bun:test";
import {
	HUMAN_ATTENTION_DEFAULT_PAGE_SIZE,
	HUMAN_ATTENTION_MAX_PAGE_SIZE,
} from "@shared/human-attention";
import { humanAttentionListQuerySchema } from "../narrators";

describe("HumanAttention list query bounds", () => {
	test("supplies a bounded default and accepts an opaque cursor", () => {
		expect(humanAttentionListQuerySchema.parse({})).toEqual({
			limit: HUMAN_ATTENTION_DEFAULT_PAGE_SIZE,
		});
		expect(
			humanAttentionListQuerySchema.parse({ limit: "20", cursor: "opaque-page-token" }),
		).toEqual({
			limit: 20,
			cursor: "opaque-page-token",
		});
	});

	test("rejects invalid page sizes instead of issuing an unbounded query", () => {
		for (const limit of ["0", "-1", "1.5", "NaN", String(HUMAN_ATTENTION_MAX_PAGE_SIZE + 1)]) {
			expect(humanAttentionListQuerySchema.safeParse({ limit }).success).toBe(false);
		}
	});

	test("rejects empty and oversized cursor input", () => {
		expect(humanAttentionListQuerySchema.safeParse({ cursor: "" }).success).toBe(false);
		expect(humanAttentionListQuerySchema.safeParse({ cursor: "x".repeat(2049) }).success).toBe(
			false,
		);
	});
});
