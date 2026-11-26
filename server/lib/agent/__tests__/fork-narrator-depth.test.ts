import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../../tests/setup";
import { narrators } from "../../../db/schema";
import { getNarratorWorkerTestDb } from "../../../services/__tests__/narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
const { db, sqlite } = fixture;
await fixture.ready;
// Bun's mock.module is process-wide and mock.restore() does not undo it, so the
// real module is snapshotted first and re-pointed in afterAll — otherwise this
// migration-only in-memory db leaks into later real-db suites.
const realDbModule = { ...(await import("../../../db")) };
mock.module("../../../db", () => ({ ...realDbModule, db, sqlite }));

afterAll(async () => {
	mock.module("../../../db", () => realDbModule);
	mock.restore();
	await fixture.close();
});

const { resolveForkDepth, exceedsForkDepthLimit, FORK_NARRATOR_MAX_DEPTH } = await import(
	"../fork-narrator-depth"
);

const BASE_TIME = new Date("2025-01-01T00:00:00.000Z").getTime();
let tsOffset = 0;
function ts() {
	return new Date(BASE_TIME + tsOffset++ * 1000).toISOString();
}

/** Insert a chain of standalone narrators, each forked from the previous one. */
function seedNarratorChain(length: number): string[] {
	const ids: string[] = [];
	for (let i = 0; i < length; i++) {
		const id = `n-${i}`;
		db.insert(narrators)
			.values({
				id,
				parentNarratorId: i === 0 ? null : `n-${i - 1}`,
				title: `Narrator ${i}`,
				createdAt: ts(),
				updatedAt: ts(),
			})
			.run();
		ids.push(id);
	}
	return ids;
}

afterEach(() => {
	cleanDb(sqlite);
	tsOffset = 0;
});

describe("resolveForkDepth", () => {
	test("follows narrator lineage to its root", async () => {
		seedNarratorChain(4);
		expect(await resolveForkDepth({ id: "n-3" })).toBe(3);
	});

	test("a narrator with no parent is depth 0", async () => {
		seedNarratorChain(1);
		expect(await resolveForkDepth({ id: "n-0" })).toBe(0);
	});

	test("counts ancestors, not siblings", async () => {
		// Breadth must not read as depth: three siblings off the root are depth 1, not 3.
		seedNarratorChain(1);
		for (const suffix of ["a", "b", "c"]) {
			db.insert(narrators)
				.values({
					id: `n-${suffix}`,
					parentNarratorId: "n-0",
					title: `Sibling ${suffix}`,
					createdAt: ts(),
					updatedAt: ts(),
				})
				.run();
		}
		expect(await resolveForkDepth({ id: "n-b" })).toBe(1);
	});

	test("terminates on a cycle instead of walking forever", async () => {
		// `parent_narrator_id` is a self-reference with no constraint forbidding a cycle,
		// and this runs on the main thread, so the walk cannot trust the data's shape.
		seedNarratorChain(3);
		db.update(narrators).set({ parentNarratorId: "n-2" }).where(eq(narrators.id, "n-0")).run();

		const depth = await resolveForkDepth({ id: "n-2" });
		expect(Number.isFinite(depth)).toBe(true);
	});

	test("a missing narrator row resolves to 0 rather than throwing", async () => {
		// Fork must not be blocked by a dangling reference; refusing is worse than
		// treating unknown lineage as shallow.
		expect(await resolveForkDepth({ id: "n-does-not-exist" })).toBe(0);
	});
});

describe("exceedsForkDepthLimit", () => {
	test("measures the CHILD's depth, since that is what gets created", () => {
		// At exactly the limit the parent is fine but its child would be one too deep.
		expect(exceedsForkDepthLimit(FORK_NARRATOR_MAX_DEPTH - 1)).toBe(false);
		expect(exceedsForkDepthLimit(FORK_NARRATOR_MAX_DEPTH)).toBe(true);
	});

	test("allows the first fork from a root", () => {
		expect(exceedsForkDepthLimit(0)).toBe(false);
	});
});
