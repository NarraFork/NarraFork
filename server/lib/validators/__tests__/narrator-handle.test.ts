import { describe, expect, test } from "bun:test";
import { createNarratorSchema, narratorHandleSchema } from "../narrators";

describe("narratorHandleSchema", () => {
	test("preserves the original case (matching is case-insensitive elsewhere)", () => {
		expect(narratorHandleSchema.parse("Alice")).toBe("Alice");
		expect(narratorHandleSchema.parse("BOB_42")).toBe("BOB_42");
		expect(narratorHandleSchema.parse("MyBot")).toBe("MyBot");
	});

	test("trims surrounding whitespace", () => {
		expect(narratorHandleSchema.parse("  Alice  ")).toBe("Alice");
	});

	test("accepts CJK handles", () => {
		expect(narratorHandleSchema.parse("小明")).toBe("小明");
		expect(narratorHandleSchema.parse("张三-1")).toBe("张三-1");
		expect(narratorHandleSchema.parse("测试机器人")).toBe("测试机器人");
	});

	test("accepts letters, digits, underscores and hyphens", () => {
		expect(narratorHandleSchema.parse("code-reviewer")).toBe("code-reviewer");
		expect(narratorHandleSchema.parse("agent_007")).toBe("agent_007");
		expect(narratorHandleSchema.parse("a1")).toBe("a1");
	});

	test("rejects handles that do not start with a letter/digit/letter", () => {
		expect(() => narratorHandleSchema.parse("-alice")).toThrow();
		expect(() => narratorHandleSchema.parse("_alice")).toThrow();
	});

	test("rejects handles with disallowed characters", () => {
		expect(() => narratorHandleSchema.parse("alice!")).toThrow();
		expect(() => narratorHandleSchema.parse("space name")).toThrow();
		expect(() => narratorHandleSchema.parse("emoji😀")).toThrow();
		expect(() => narratorHandleSchema.parse("a.b")).toThrow();
		expect(() => narratorHandleSchema.parse("小明！")).toThrow();
	});

	test("enforces length bounds in code points (2-32)", () => {
		expect(() => narratorHandleSchema.parse("a")).toThrow();
		expect(() => narratorHandleSchema.parse("小")).toThrow();
		expect(narratorHandleSchema.parse("ab")).toBe("ab");
		expect(narratorHandleSchema.parse("小明")).toBe("小明");
		expect(narratorHandleSchema.parse("a".repeat(32))).toBe("a".repeat(32));
		expect(() => narratorHandleSchema.parse("a".repeat(33))).toThrow();
		expect(() => narratorHandleSchema.parse("字".repeat(33))).toThrow();
	});
});

describe("createNarratorSchema named-narrator fields", () => {
	test("accepts makeNamed with a valid handle preserving case", () => {
		const parsed = createNarratorSchema.parse({ makeNamed: true, handle: "Alice" });
		expect(parsed.makeNamed).toBe(true);
		expect(parsed.handle).toBe("Alice");
	});

	test("accepts a CJK handle", () => {
		const parsed = createNarratorSchema.parse({ makeNamed: true, handle: "小明" });
		expect(parsed.handle).toBe("小明");
	});

	test("handle is optional for regular narrators", () => {
		const parsed = createNarratorSchema.parse({ model: "claude-sonnet-4.5" });
		expect(parsed.handle).toBeUndefined();
		expect(parsed.makeNamed).toBeUndefined();
	});

	test("rejects an invalid handle even when provided", () => {
		expect(() => createNarratorSchema.parse({ makeNamed: true, handle: "bad handle" })).toThrow();
	});
});
