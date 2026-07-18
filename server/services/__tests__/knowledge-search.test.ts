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

describe("project isolation (H3)", () => {
	test("projectId filter returns this project's + global entries, hides other projects'", async () => {
		const tag = Date.now();
		const { db } = await import("../../db");
		const { projects } = await import("../../db/schema");
		const now = new Date().toISOString();
		const projA = `proj-A-${tag}`;
		const projB = `proj-B-${tag}`;
		// Real project rows so the collection.projectId FK is satisfied.
		await db.insert(projects).values([
			{
				id: projA,
				name: `A-${tag}`,
				status: "active",
				flowMode: "classic",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: projB,
				name: `B-${tag}`,
				status: "active",
				flowMode: "classic",
				createdAt: now,
				updatedAt: now,
			},
		]);

		// Project A collection + entry
		const colA = await knowledgeService.createCollection({
			name: `projA-${tag}`,
			projectId: projA,
		});
		const entryA = await knowledgeService.createEntry({
			collectionId: colA.id,
			title: `Alpha协议${tag}`,
			content: "项目A 专属知识 协议规范",
		});
		// Project B collection + entry (same distinctive term)
		const colB = await knowledgeService.createCollection({
			name: `projB-${tag}`,
			projectId: projB,
		});
		const entryB = await knowledgeService.createEntry({
			collectionId: colB.id,
			title: `Beta协议${tag}`,
			content: "项目B 专属知识 协议规范",
		});
		// Global collection (projectId null)
		const colG = await knowledgeService.createCollection({ name: `global-${tag}` });
		const entryG = await knowledgeService.createEntry({
			collectionId: colG.id,
			title: `Gamma协议${tag}`,
			content: "全局共享知识 协议规范",
		});

		// Search scoped to project A: should see Alpha (A) + Gamma (global), NOT Beta (B).
		const scoped = knowledgeService.search({ q: "协议规范", projectId: projA });
		const titles = scoped.map((r) => r.title);
		expect(titles).toContain(`Alpha协议${tag}`);
		expect(titles).toContain(`Gamma协议${tag}`);
		expect(titles).not.toContain(`Beta协议${tag}`);

		// Direct KnowledgeRead-style lookup must enforce the same context boundary.
		expect((await knowledgeService.getEntry(entryA.id, { projectId: projA })).id).toBe(entryA.id);
		expect((await knowledgeService.getEntry(entryG.id, { projectId: projA })).id).toBe(entryG.id);
		await expect(knowledgeService.getEntry(entryB.id, { projectId: projA })).rejects.toThrow();
	});
});
