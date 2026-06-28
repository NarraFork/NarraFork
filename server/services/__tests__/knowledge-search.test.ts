/**
 * Search behaviour tests for the knowledge service.
 *
 * Verifies the H4 fix: 2-character CJK queries (which the trigram FTS index
 * cannot tokenize) still find body matches via a TIGHTLY-BOUNDED LIKE fallback,
 * 3+ character queries use FTS, and all results are capped. Runs against an
 * isolated DB under a temp NARRAFORK_HOME.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { knowledgeService } from "../knowledge-service";

let collectionId: string;

beforeAll(async () => {
	const col = await knowledgeService.createCollection({ name: `search-${Date.now()}` });
	collectionId = col.id;
	await knowledgeService.createEntry({
		collectionId,
		title: "充电故障处理",
		content: "充电流程 A to B to C 三阶段，电池温度监控。",
	});
	await knowledgeService.createEntry({
		collectionId,
		title: "网络诊断指南",
		content: "网络连接超时排查步骤与日志分析。",
	});
});

describe("knowledge search", () => {
	test("3+ char CJK query matches via FTS", () => {
		const results = knowledgeService.search({ q: "三阶段", collectionId });
		expect(results.some((r) => r.title === "充电故障处理")).toBe(true);
	});

	test("2-character CJK query finds body match via bounded LIKE fallback", () => {
		// "充电" (2 chars) can't use trigram FTS; the fallback still matches title+body.
		const results = knowledgeService.search({ q: "充电", collectionId });
		expect(results.some((r) => r.title.includes("充电"))).toBe(true);
	});

	test("2-character CJK body-only term is found via fallback", () => {
		// "电池" appears only in the body, not any title.
		const results = knowledgeService.search({ q: "电池", collectionId });
		expect(results.some((r) => r.title === "充电故障处理")).toBe(true);
	});

	test("respects the result limit", () => {
		const results = knowledgeService.search({ q: "网络", collectionId, limit: 1 });
		expect(results.length).toBeLessThanOrEqual(1);
	});

	test("empty query lists recent entries (bounded)", () => {
		const results = knowledgeService.search({ q: "", collectionId, limit: 10 });
		expect(results.length).toBeLessThanOrEqual(10);
		expect(results.length).toBeGreaterThanOrEqual(1);
	});
});
