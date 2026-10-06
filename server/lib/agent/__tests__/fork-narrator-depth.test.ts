import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../../tests/setup";
import { chapters, narrators, projects } from "../../../db/schema";

const { db, sqlite } = getTestDb();
// Bun's mock.module is process-wide and mock.restore() does not undo it, so the
// real module is snapshotted first and re-pointed in afterAll — otherwise this
// migration-only in-memory db leaks into later real-db suites.
const realDbModule = { ...(await import("../../../db")) };
mock.module("../../../db", () => ({ ...realDbModule, db, sqlite }));

afterAll(() => {
	mock.module("../../../db", () => realDbModule);
	mock.restore();
});

const { resolveForkDepth, exceedsForkDepthLimit, FORK_NARRATOR_MAX_DEPTH } = await import(
	"../fork-narrator-depth"
);

const BASE_TIME = new Date("2025-01-01T00:00:00.000Z").getTime();
let tsOffset = 0;
function ts() {
	return new Date(BASE_TIME + tsOffset++ * 1000).toISOString();
}

function seedProject() {
	db.insert(projects)
		.values({ id: "p1", name: "Proj", gitPath: "/tmp/repo", createdAt: ts(), updatedAt: ts() })
		.run();
}

/** Insert a chain of chapters, each forked from the previous one. */
function seedChapterChain(length: number): string[] {
	const ids: string[] = [];
	for (let i = 0; i < length; i++) {
		const id = `ch-${i}`;
		db.insert(chapters)
			.values({
				id,
				projectId: "p1",
				title: `Chapter ${i}`,
				branch: i === 0 ? "main" : `chapter/c${i}`,
				baseBranch: "main",
				parentChapterId: i === 0 ? null : `ch-${i - 1}`,
				createdAt: ts(),
				updatedAt: ts(),
			})
			.run();
		ids.push(id);
	}
	return ids;
}

/** Insert a chain of standalone narrators, each forked from the previous one. */
function seedNarratorChain(length: number): string[] {
	const ids: string[] = [];
	for (let i = 0; i < length; i++) {
		const id = `n-${i}`;
		db.insert(narrators)
			.values({
				id,
				chapterId: null,
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
	test("a root chapter has no ancestors", async () => {
		seedProject();
		seedChapterChain(1);
		expect(await resolveForkDepth({ id: "any", chapterId: "ch-0" })).toBe(0);
	});

	test("counts chapter ancestors, not chapters in the project", async () => {
		// Breadth must not read as depth: three siblings off the root are depth 1, not 3.
		seedProject();
		seedChapterChain(1);
		for (const suffix of ["a", "b", "c"]) {
			db.insert(chapters)
				.values({
					id: `ch-${suffix}`,
					projectId: "p1",
					title: `Sibling ${suffix}`,
					branch: `chapter/${suffix}`,
					baseBranch: "main",
					parentChapterId: "ch-0",
					createdAt: ts(),
					updatedAt: ts(),
				})
				.run();
		}
		expect(await resolveForkDepth({ id: "any", chapterId: "ch-b" })).toBe(1);
	});

	test("follows a chapter chain to its root", async () => {
		seedProject();
		seedChapterChain(5);
		expect(await resolveForkDepth({ id: "any", chapterId: "ch-4" })).toBe(4);
	});

	test("uses narrator lineage when the narrator is standalone", async () => {
		seedNarratorChain(4);
		expect(await resolveForkDepth({ id: "n-3", chapterId: null })).toBe(3);
	});

	test("a standalone narrator with no parent is depth 0", async () => {
		seedNarratorChain(1);
		expect(await resolveForkDepth({ id: "n-0", chapterId: null })).toBe(0);
	});

	test("terminates on a cycle instead of walking forever", async () => {
		// `parent_chapter_id` is a self-reference with no constraint forbidding a cycle,
		// and this runs on the main thread, so the walk cannot trust the data's shape.
		seedProject();
		seedChapterChain(3);
		db.update(chapters).set({ parentChapterId: "ch-2" }).where(eq(chapters.id, "ch-0")).run();

		const depth = await resolveForkDepth({ id: "any", chapterId: "ch-2" });
		expect(Number.isFinite(depth)).toBe(true);
	});

	test("a missing chapter row resolves to 0 rather than throwing", async () => {
		// Fork must not be blocked by a dangling reference; refusing is worse than
		// treating unknown lineage as shallow.
		seedProject();
		expect(await resolveForkDepth({ id: "any", chapterId: "ch-does-not-exist" })).toBe(0);
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
