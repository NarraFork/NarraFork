/**
 * Which project a narrator belongs to.
 *
 * This existed in three copies that disagreed, and each disagreement is pinned
 * here because project membership is about to gate access — a resolver that
 * answers "no project" where one exists reads as "nothing to enforce".
 *
 *  1. chapter-bound narrator → the chapter's project (the chapter wins)
 *  2. standalone + contextProjectId → that project
 *     (the old `snapshot-revert` copy ignored this column entirely)
 *  3. chapter AND contextProjectId both set → the chapter still wins
 *     (the old `trait-layer-service` copy returned contextProjectId)
 *  4. neither → null, meaning "no project gate applies", never "unrestricted"
 *
 * Run: NARRAFORK_ALLOW_MULTIPLE=1 NARRAFORK_HOME=$(mktemp -d) \
 *      bun test server/services/__tests__/narrator-project.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../../db";
import { chapters, narrators, projects } from "../../db/schema";
import { generateId } from "../../lib/id";
import { resolveNarratorProjectId, resolveProjectIdForNarratorId } from "../narrator-project";

const TAG = Date.now();

let projectA: string;
let projectB: string;
let chapterInA: string;

async function makeNarrator(fields: {
	chapterId?: string | null;
	contextProjectId?: string | null;
}): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id,
		chapterId: fields.chapterId ?? null,
		contextProjectId: fields.contextProjectId ?? null,
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

beforeAll(async () => {
	const now = new Date().toISOString();
	projectA = generateId();
	projectB = generateId();
	for (const [id, name] of [
		[projectA, `proj-a-${TAG}`],
		[projectB, `proj-b-${TAG}`],
	] as const) {
		await db.insert(projects).values({
			id,
			name,
			gitPath: `/tmp/${name}`,
			createdAt: now,
			updatedAt: now,
		});
	}

	chapterInA = generateId();
	await db.insert(chapters).values({
		id: chapterInA,
		projectId: projectA,
		title: "chapter in A",
		branch: `chapter/${TAG}`,
		baseBranch: "main",
		createdAt: now,
		updatedAt: now,
	});
});

describe("resolveNarratorProjectId", () => {
	test("a chapter-bound narrator resolves to the chapter's project", async () => {
		expect(await resolveNarratorProjectId({ chapterId: chapterInA })).toBe(projectA);
	});

	test("a standalone narrator resolves through contextProjectId", async () => {
		// The snapshot-revert copy read only chapterId, so this returned null and any
		// project-scoped decision silently found nothing to enforce.
		expect(await resolveNarratorProjectId({ contextProjectId: projectB })).toBe(projectB);
	});

	test("the chapter wins when both are somehow set", async () => {
		// The trait-layer copy preferred contextProjectId. The column is documented as
		// the context for STANDALONE narrators, so the chapter is authoritative whenever
		// there is one.
		expect(
			await resolveNarratorProjectId({ chapterId: chapterInA, contextProjectId: projectB }),
		).toBe(projectA);
	});

	test("a narrator with neither resolves to null", async () => {
		expect(await resolveNarratorProjectId({})).toBeNull();
		expect(await resolveNarratorProjectId({ chapterId: null, contextProjectId: null })).toBeNull();
	});

	test("a dangling chapter reference resolves to null rather than throwing", async () => {
		// A missing chapter row is a broken reference, not a permission verdict; callers
		// pair this with the resource's own ACL check.
		expect(await resolveNarratorProjectId({ chapterId: "no-such-chapter" })).toBeNull();
	});
});

describe("resolveProjectIdForNarratorId", () => {
	test("resolves a chapter-bound narrator by id", async () => {
		const id = await makeNarrator({ chapterId: chapterInA });
		expect(await resolveProjectIdForNarratorId(id)).toBe(projectA);
	});

	test("resolves a standalone narrator by id", async () => {
		const id = await makeNarrator({ contextProjectId: projectB });
		expect(await resolveProjectIdForNarratorId(id)).toBe(projectB);
	});

	test("an unknown narrator id resolves to null instead of throwing", async () => {
		expect(await resolveProjectIdForNarratorId("no-such-narrator")).toBeNull();
	});

	test("both variants agree for the same narrator", async () => {
		// The two entry points must never diverge — that is how three copies happened.
		const id = await makeNarrator({ chapterId: chapterInA, contextProjectId: projectB });
		const row = await db.query.narrators.findFirst({
			where: (n, { eq }) => eq(n.id, id),
			columns: { chapterId: true, contextProjectId: true },
		});
		expect(await resolveProjectIdForNarratorId(id)).toBe(
			await resolveNarratorProjectId(row as { chapterId: string | null }),
		);
	});
});
