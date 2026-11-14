import { describe, expect, test } from "bun:test";
import { ContextEvidenceBudget, projectKnowledgeEvidence } from "../context-evidence-budget";

describe("request evidence reservations", () => {
	test("memory, restored knowledge and pending work share one UTF-8 allowance", () => {
		const budget = new ContextEvidenceBudget(() => 20);
		budget.reset(4);
		const memory = budget.reserve("memory", 10);
		const knowledge = budget.reserve("knowledge", 10);
		expect(memory.byteBudget).toBe(10);
		expect(knowledge.byteBudget).toBe(6);
		expect(budget.remaining).toBe(0);
		expect(memory.commit("中文")).toBe(true);
		expect(budget.remaining).toBe(4);
		expect(knowledge.commit("abcdefg")).toBe(false);
		expect(budget.remaining).toBe(10);
		expect(budget.knowledgeAllowance).toBe(14);
		expect(memory.commit("x")).toBe(false);
		memory.release();
		knowledge.release();
		expect(budget.remaining).toBe(10);
	});

	test("a failed or cancelled scan releases its reservation once", () => {
		const budget = new ContextEvidenceBudget(() => 12);
		const scan = budget.reserve("knowledge", 12);
		expect(budget.remaining).toBe(0);
		scan.release();
		scan.release();
		expect(scan.commit("late")).toBe(false);
		expect(budget.remaining).toBe(12);
	});

	test("a compact or retry resets usage and rejects stale asynchronous commits", () => {
		let cap = 20;
		const budget = new ContextEvidenceBudget(() => cap);
		const old = budget.reserve("knowledge", 20);
		cap = 10;
		budget.reset(3);
		const current = budget.reserve("memory", 5);
		expect(old.commit("stale")).toBe(false);
		old.release();
		expect(budget.remaining).toBe(2);
		expect(current.commit("now")).toBe(true);
		expect(budget.remaining).toBe(4);
	});

	for (const cap of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		test(`invalid or disabled allowance fails closed: ${cap}`, () => {
			const budget = new ContextEvidenceBudget(() => cap);
			expect(budget.remaining).toBe(0);
			expect(budget.reserve("knowledge", 100).commit("x")).toBe(false);
		});
	}

	test("default and maximum allowances are bounded", () => {
		expect(new ContextEvidenceBudget().remaining).toBe(16 * 1024);
		expect(new ContextEvidenceBudget(() => 1e9).remaining).toBe(64 * 1024);
	});
});

const hint = (text: string) => ({ type: "knowledge_hint", modelText: text, entries: [] });
const row = (id: string, role: string, contentJson: unknown[], contentText = "") => ({
	id,
	role,
	contentJson,
	contentText,
});

describe("optional knowledge history projection", () => {
	test("keeps recent whole evidence blocks and preserves required roles and mixed blocks", () => {
		const required = { type: "spec_continuation", modelText: "TASK_STATE" };
		const source = [
			row("old", "sys", [hint("old-old")]),
			row("user", "user", [hint("USER_INPUT_IS_NOT_OPTIONAL")]),
			row("call", "assistant", [{ type: "tool_use", id: "call", name: "Read" }]),
			row("result", "tool", [{ type: "tool_result", tool_use_id: "call", content: "ok" }]),
			row("mixed", "sys", [hint("too-large"), required], "too-large\nTASK_STATE"),
			row("new", "sys", [hint("中文")]),
		];
		const original = structuredClone(source);
		const projected = projectKnowledgeEvidence(source, 6);
		expect(projected.bytes).toBe(6);
		expect(projected.omittedMessageIds).toEqual(["old", "mixed"]);
		expect(projected.messages.map((message) => message.id)).toEqual([
			"user",
			"call",
			"result",
			"mixed",
			"new",
		]);
		expect(projected.messages[0]).toBe(source[1]);
		expect(projected.messages[1]).toBe(source[2]);
		expect(projected.messages[2]).toBe(source[3]);
		expect(projected.messages[3]?.contentJson).toEqual([required]);
		expect(projected.messages[3]?.contentText).toBe("TASK_STATE");
		expect(source).toEqual(original);
	});

	test("accounts native tool hints and legacy text companions without removing unrelated notices", () => {
		const source = [
			row(
				"legacy",
				"sys",
				[
					{ type: "text", text: "LEGACY_KNOWLEDGE" },
					{ type: "knowledge_hint", entries: [] },
					{ type: "text", text: "KEEP_NOTICE" },
				],
				"LEGACY_KNOWLEDGE\nKEEP_NOTICE",
			),
			row("tool-hint", "sys", [
				{ type: "system_injection", source: "knowledge_base_hint", modelText: "new" },
			]),
			row("required", "sys", [
				{ type: "system_injection", source: "tool_loaded", modelText: "TOOL_CHAIN" },
			]),
		];
		const projected = projectKnowledgeEvidence(source, 3);
		expect(projected.bytes).toBe(3);
		expect(projected.messages[0]?.contentJson).toEqual([{ type: "text", text: "KEEP_NOTICE" }]);
		expect(projected.messages[0]?.contentText).toBe("KEEP_NOTICE");
		expect(projected.messages[1]).toBe(source[1]);
		expect(projected.messages[2]).toBe(source[2]);
	});
});
