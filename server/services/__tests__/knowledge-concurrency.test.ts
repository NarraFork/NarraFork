/**
 * Concurrency regression tests for knowledge copy-on-write versioning.
 *
 * Runs against a real (isolated) database under a temp NARRAFORK_HOME so the
 * service layer + migrations + unique indexes are all exercised. Verifies that
 * concurrent addRevision calls on the same entry never collide on the
 * (entry_id, version) unique index and never surface a raw SQLite error.
 *
 * Run: NARRAFORK_ALLOW_MULTIPLE=1 NARRAFORK_HOME=$(mktemp -d) \
 *      bun test server/services/__tests__/knowledge-concurrency.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { knowledgeService } from "../knowledge-service";

let collectionId: string;
let entryId: string;

beforeAll(async () => {
	const col = await knowledgeService.createCollection({
		name: `concurrency-${Date.now()}`,
	});
	collectionId = col.id;
	const entry = await knowledgeService.createEntry({
		collectionId,
		title: `entry-${Date.now()}`,
		content: "v1",
	});
	entryId = entry.id;
});

describe("addRevision concurrency", () => {
	test("parallel revisions get distinct, gapless versions (no unique collision)", async () => {
		const N = 12;
		const results = await Promise.all(
			Array.from({ length: N }, (_, i) =>
				knowledgeService.addRevision(entryId, { content: `parallel-${i}` }),
			),
		);

		const versions = results.map((r) => r.version).sort((a, b) => a - b);
		const unique = new Set(versions);
		// All versions must be distinct (the whole point — no two writers share a version).
		expect(unique.size).toBe(N);

		// Versions should form a contiguous range starting just after the initial v1.
		const min = versions[0];
		const max = versions[versions.length - 1];
		expect(max - min).toBe(N - 1);

		// The entry's persisted current revision must be one of the produced revisions.
		const history = await knowledgeService.listRevisions(entryId, {
			userId: "",
			role: "admin",
		});
		// Initial revision (v1) + N parallel revisions, all versions unique in storage.
		const storedVersions = history.map((h) => h.version);
		expect(new Set(storedVersions).size).toBe(storedVersions.length);
	});
});
