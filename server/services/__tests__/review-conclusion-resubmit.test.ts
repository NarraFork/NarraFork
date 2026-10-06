/**
 * Resubmitting a review conclusion.
 *
 * The platform used to contradict itself here. The workspace guard restores a reviewer's
 * files and tells it — in those words — to "re-examine the code and output your review
 * conclusion", and the only tool for submitting one answered
 * `Error: Review is already concluded.` The reviewer complied with the instruction it
 * was given and was refused, while the findings it had just disowned stayed on record as
 * the source chapter's latest word.
 *
 * So a concluded review accepts a new conclusion, that conclusion becomes the current
 * one, and the source chapter hears about it. `converted` / `dismissed` stay closed —
 * those reviews have had their worktree and narrator torn down.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { chapters, projects, reviewConclusions } from "../../db/schema";
import { concludeReviewTool } from "../../lib/agent/tools/conclude-review";
import type { ToolContext } from "../../lib/agent/types";
import { eventBus } from "../../lib/event-bus";
import { generateId } from "../../lib/id";
import { reviewService } from "../review-service";

const createdProjectIds: string[] = [];
const createdChapterIds: string[] = [];

type ReviewStatus = "reviewing" | "concluded" | "converted" | "dismissed";

/** A source chapter plus a review chapter pointing at it, in the given review state. */
async function seedReview(reviewStatus: ReviewStatus): Promise<{
	reviewChapterId: string;
	sourceChapterId: string;
}> {
	const now = new Date().toISOString();
	const projectId = generateId();
	createdProjectIds.push(projectId);
	await db.insert(projects).values({
		id: projectId,
		name: "resubmit-test",
		gitPath: `/tmp/nf-resubmit-${projectId.slice(0, 6)}`,
		createdAt: now,
		updatedAt: now,
	});

	const sourceChapterId = generateId();
	createdChapterIds.push(sourceChapterId);
	await db.insert(chapters).values({
		id: sourceChapterId,
		projectId,
		title: "Feature under review",
		status: "active",
		role: "branch",
		branch: "feat",
		baseBranch: "main",
		createdAt: now,
		updatedAt: now,
	});

	const reviewChapterId = generateId();
	createdChapterIds.push(reviewChapterId);
	await db.insert(chapters).values({
		id: reviewChapterId,
		projectId,
		title: "Review: Feature under review",
		status: "active",
		role: "review",
		branch: "review/feat",
		baseBranch: "feat",
		reviewSourceChapterId: sourceChapterId,
		reviewStatus,
		createdAt: now,
		updatedAt: now,
	});

	return { reviewChapterId, sourceChapterId };
}

function toolContext(chapterId: string): ToolContext {
	return {
		narratorId: `narrator-${chapterId.slice(0, 6)}`,
		cwd: "/tmp",
		signal: new AbortController().signal,
		locale: "en",
		chapterId,
		// ConcludeReview never asks: submitting a conclusion is the reviewer's own output,
		// not an action on the user's system. Throwing rather than allowing makes that an
		// assertion — a future permission check here would fail loudly instead of silently
		// being granted by the stub.
		requestPermission: async () => {
			throw new Error("ConcludeReview must not request permission");
		},
	};
}

async function submit(
	chapterId: string,
	verdict: "approve" | "request_changes" | "comment_only",
	messages: string[],
) {
	return concludeReviewTool.execute(
		{
			verdict,
			findings: messages.map((message) => ({ severity: "major" as const, message })),
		},
		toolContext(chapterId),
	);
}

/** Every `review:concluded` event raised during one test. */
let events: Array<{ reviewChapterId: string; sourceChapterId: string; revised?: boolean }> = [];

// `eventBus.on` returns void, so the handler has to be held and passed back to `off`.
// Leaking it instead makes every later test in the file observe the earlier tests'
// events, which reads as "the same conclusion was announced many times".
const recordConcluded = (event: {
	reviewChapterId: string;
	sourceChapterId: string;
	revised?: boolean;
}) => {
	events.push({
		reviewChapterId: event.reviewChapterId,
		sourceChapterId: event.sourceChapterId,
		revised: event.revised,
	});
};

beforeEach(() => {
	events = [];
	eventBus.on("review:concluded", recordConcluded);
});

afterEach(async () => {
	eventBus.off("review:concluded", recordConcluded);
	for (const id of createdChapterIds.splice(0)) {
		await db.delete(chapters).where(eq(chapters.id, id));
	}
	for (const id of createdProjectIds.splice(0)) {
		await db.delete(projects).where(eq(projects.id, id));
	}
});

describe("submitting a conclusion for the first time", () => {
	test("records it and moves the review to concluded", async () => {
		const { reviewChapterId } = await seedReview("reviewing");
		const result = await submit(reviewChapterId, "request_changes", ["the index has no migration"]);
		expect(result.isError).toBeUndefined();

		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, reviewChapterId),
			columns: { reviewStatus: true },
		});
		expect(chapter?.reviewStatus).toBe("concluded");
		expect(events).toHaveLength(1);
		expect(events[0]?.revised).toBe(false);
	});
});

describe("resubmitting after the workspace guard asked for a re-examination", () => {
	test("succeeds instead of refusing", async () => {
		const { reviewChapterId } = await seedReview("reviewing");
		await submit(reviewChapterId, "request_changes", ["stale finding"]);

		const result = await submit(reviewChapterId, "approve", ["verified against the real source"]);
		expect(result.isError).toBeUndefined();
		expect(result.output).toContain("replaces your earlier one");
	});

	test("the new conclusion becomes the current one, and the old one is kept", async () => {
		const { reviewChapterId, sourceChapterId } = await seedReview("reviewing");
		await submit(reviewChapterId, "request_changes", ["stale finding"]);
		await submit(reviewChapterId, "approve", ["verified against the real source"]);

		// Appended rather than overwritten: the superseded verdict stays auditable.
		const all = await db.query.reviewConclusions.findMany({
			where: eq(reviewConclusions.reviewChapterId, reviewChapterId),
			orderBy: [asc(reviewConclusions.createdAt)],
		});
		expect(all).toHaveLength(2);
		expect(all[0]?.verdict).toBe("request_changes");

		// …while every "what does the reviewer say" reader sees only the newest.
		const latestForReview = await db.query.reviewConclusions.findFirst({
			where: eq(reviewConclusions.reviewChapterId, reviewChapterId),
			orderBy: [desc(reviewConclusions.createdAt)],
		});
		expect(latestForReview?.verdict).toBe("approve");
		const latestForSource = await reviewService.getLatestConclusionForSource(sourceChapterId);
		expect(latestForSource?.verdict).toBe("approve");
	});

	test("the source chapter is told again, marked as a revision", async () => {
		// Gating the announcement on the status transition made the second submission
		// silently go nowhere: the row was written and nobody was informed.
		const { reviewChapterId, sourceChapterId } = await seedReview("reviewing");
		await submit(reviewChapterId, "request_changes", ["stale finding"]);
		await submit(reviewChapterId, "approve", ["verified"]);

		expect(events).toHaveLength(2);
		expect(events[0]?.revised).toBe(false);
		expect(events[1]).toEqual({ reviewChapterId, sourceChapterId, revised: true });
	});

	test("the status stays concluded rather than being rewritten", async () => {
		const { reviewChapterId } = await seedReview("concluded");
		await submit(reviewChapterId, "approve", ["fine"]);
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, reviewChapterId),
			columns: { reviewStatus: true },
		});
		expect(chapter?.reviewStatus).toBe("concluded");
	});
});

describe("reviews whose resources are gone", () => {
	test.each(["converted", "dismissed"] as const)("%s is still refused", async (status) => {
		// The worktree is deleted and the narrator re-parented or archived by this point, so
		// there is nothing coherent left to revise — unlike `concluded`, which is a live
		// review that simply already spoke.
		const { reviewChapterId } = await seedReview(status);
		const result = await submit(reviewChapterId, "approve", ["too late"]);
		expect(result.isError).toBe(true);
		expect(result.output).toContain(status);

		const rows = await db.query.reviewConclusions.findMany({
			where: eq(reviewConclusions.reviewChapterId, reviewChapterId),
		});
		expect(rows).toHaveLength(0);
		expect(events).toHaveLength(0);
	});
});
