/**
 * What a concluded review leaves in the source chapter's history.
 *
 * The row IS the request. A reviewer that says "fix this" is asking the narrator for
 * work, so the conclusion is persisted as a `role: "user"` message and is model-visible
 * from the moment it lands. Everything else follows from that:
 *
 *   - a running narrator needs no delivery step (the next request rebuilds the full
 *     history and sees the row), so there is no buffer queue and no second copy;
 *   - an idle narrator is already informed, so the card's button only has to START a
 *     turn — which is why the apply path writes nothing;
 *   - the reader and the model read the SAME row, the card from the `review_feedback`
 *     block and the model from the `text` block, so they cannot drift.
 *
 * The earlier attempt made the card `role: "disp"` and delivered the text separately.
 * That worked for the model but put the same findings on screen twice, and the delivery
 * path lost the row's attribution (a buffered message is consumed as a plain user turn,
 * so an automatic conclusion arrived unsigned and a reader-triggered one looked like the
 * reader had typed it).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { db } from "../../db";
import {
	chapters,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	projects,
	reviewConclusions,
} from "../../db/schema";
import { generateId } from "../../lib/id";
import { initReviewEventHandler } from "../review-event-handler";

const createdProjectIds: string[] = [];
const createdChapterIds: string[] = [];
const createdNarratorIds: string[] = [];

// The handler is a module-level subscription, installed once for this file.
initReviewEventHandler();

interface Seeded {
	reviewChapterId: string;
	sourceChapterId: string;
	sourceNarratorId: string;
}

async function seed(): Promise<Seeded> {
	const now = new Date().toISOString();
	const projectId = generateId();
	createdProjectIds.push(projectId);
	await db.insert(projects).values({
		id: projectId,
		name: "review-row-test",
		gitPath: `/tmp/nf-review-row-${projectId.slice(0, 6)}`,
		createdAt: now,
		updatedAt: now,
	});

	const sourceChapterId = generateId();
	createdChapterIds.push(sourceChapterId);
	await db.insert(chapters).values({
		id: sourceChapterId,
		projectId,
		title: "Feature",
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
		title: "Review: Feature",
		status: "active",
		role: "review",
		branch: "review/feat",
		baseBranch: "feat",
		reviewSourceChapterId: sourceChapterId,
		reviewStatus: "reviewing",
		createdAt: now,
		updatedAt: now,
	});

	const sourceNarratorId = generateId();
	createdNarratorIds.push(sourceNarratorId);
	await db.insert(narrators).values({
		id: sourceNarratorId,
		chapterId: sourceChapterId,
		type: "primary",
		variant: "primary",
		status: "idle",
		cwd: "/tmp",
		createdAt: now,
		updatedAt: now,
	});

	return { reviewChapterId, sourceChapterId, sourceNarratorId };
}

/** Write a structured conclusion and let the handler react to it. */
async function concludeWith(
	seeded: Seeded,
	verdict: "approve" | "request_changes",
	findings: Array<{ severity: "critical" | "major" | "minor" | "suggestion"; message: string }>,
) {
	await db.insert(reviewConclusions).values({
		id: generateId(),
		reviewChapterId: seeded.reviewChapterId,
		sourceChapterId: seeded.sourceChapterId,
		verdict,
		findingsJson: findings,
		createdAt: new Date().toISOString(),
	});
	const { reviewService } = await import("../review-service");
	await reviewService.concludeReview(seeded.reviewChapterId);
	// The handler runs off an event, so give the microtask queue a turn to drain.
	await new Promise((resolve) => setTimeout(resolve, 30));
}

async function latestRow(narratorId: string) {
	return db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.narratorId, narratorId),
		orderBy: [desc(narratorMessages.createdAt)],
	});
}

function blocksOf(row: { contentJson: unknown } | undefined): Array<Record<string, unknown>> {
	return Array.isArray(row?.contentJson) ? (row.contentJson as Array<Record<string, unknown>>) : [];
}

afterEach(async () => {
	// Strict order: neither `narrator_message_refs` nor `narrator_messages` cascades from
	// `narrators`, so refs → messages → narrator. Getting it wrong fails the foreign key
	// during teardown rather than in the test body, which makes it look like a code bug.
	for (const id of createdNarratorIds) {
		await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, id));
		await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, id));
	}
	for (const id of createdNarratorIds.splice(0)) {
		await db.delete(narrators).where(eq(narrators.id, id));
	}
	for (const id of createdChapterIds.splice(0)) {
		await db.delete(chapters).where(eq(chapters.id, id));
	}
	for (const id of createdProjectIds.splice(0)) {
		await db.delete(projects).where(eq(projects.id, id));
	}
});

describe("the row a concluded review writes", () => {
	test("is a model-visible user turn attributed to the reviewer", async () => {
		const seeded = await seed();
		await concludeWith(seeded, "request_changes", [
			{ severity: "critical", message: "the index has no migration" },
		]);

		const row = await latestRow(seeded.sourceNarratorId);
		// `user`, not `disp`: the findings are a request the model has to answer, and
		// `taskReflection` can only recognize a task that arrived as a user turn.
		expect(row?.role).toBe("user");
		// …but not attributed to the reader, who did not write it.
		expect(row?.origin).toBe("system");
		expect(row?.originLabel).toBeTruthy();
	});

	test("carries the conclusion for the model and the card for the reader, on one row", async () => {
		const seeded = await seed();
		await concludeWith(seeded, "request_changes", [
			{ severity: "critical", message: "the index has no migration" },
		]);

		const blocks = blocksOf(await latestRow(seeded.sourceNarratorId));
		const text = blocks.find((b) => b.type === "text");
		const card = blocks.find((b) => b.type === "review_feedback");
		// The model's copy: providers project text blocks only.
		expect(String(text?.text)).toContain("the index has no migration");
		// The reader's copy: same content, structured.
		expect(card?.verdict).toBe("request_changes");
		expect(Array.isArray(card?.findings) ? card.findings : []).toHaveLength(1);
		// Carried on the block too, because that is what the card renders.
		expect(String(card?.text)).toContain("the index has no migration");
	});

	test("writes exactly ONE row per conclusion", async () => {
		// The two-channel design wrote a display card AND delivered the text, so the same
		// findings appeared twice on screen.
		const seeded = await seed();
		await concludeWith(seeded, "approve", []);
		const rows = await db.query.narratorMessages.findMany({
			where: eq(narratorMessages.narratorId, seeded.sourceNarratorId),
		});
		expect(rows).toHaveLength(1);
	});

	test("starts out un-applied, so the reader still has a turn to start", async () => {
		const seeded = await seed();
		await concludeWith(seeded, "request_changes", [{ severity: "major", message: "fix this" }]);
		const card = blocksOf(await latestRow(seeded.sourceNarratorId)).find(
			(b) => b.type === "review_feedback",
		);
		expect(card?.applied).toBeUndefined();
	});

	test("a revision is a new row, marked as such", async () => {
		const seeded = await seed();
		await concludeWith(seeded, "request_changes", [{ severity: "critical", message: "stale" }]);
		await concludeWith(seeded, "approve", [{ severity: "minor", message: "verified" }]);

		const rows = await db.query.narratorMessages.findMany({
			where: eq(narratorMessages.narratorId, seeded.sourceNarratorId),
			orderBy: [desc(narratorMessages.createdAt)],
		});
		expect(rows).toHaveLength(2);
		const newest = blocksOf(rows[0]).find((b) => b.type === "review_feedback");
		expect(newest?.verdict).toBe("approve");
		expect(newest?.revised).toBe(true);
	});
});

describe("marking a conclusion as handled", () => {
	test("latches the row and reports a repeat click without re-latching", async () => {
		const seeded = await seed();
		await concludeWith(seeded, "request_changes", [{ severity: "major", message: "fix this" }]);
		const row = await latestRow(seeded.sourceNarratorId);
		const messageId = row?.id as string;

		const { narratorService } = await import("../narrator-service");
		const first = await narratorService.markReviewFeedbackApplied(
			seeded.sourceNarratorId,
			messageId,
		);
		expect(first.alreadyApplied).toBe(false);
		expect(
			blocksOf(await latestRow(seeded.sourceNarratorId)).find((b) => b.type === "review_feedback")
				?.applied,
		).toBe(true);

		// A second click must not start another turn for the same findings.
		const second = await narratorService.markReviewFeedbackApplied(
			seeded.sourceNarratorId,
			messageId,
		);
		expect(second.alreadyApplied).toBe(true);
	});

	test("leaves the conclusion itself untouched — it is history, not a draft", async () => {
		const seeded = await seed();
		await concludeWith(seeded, "approve", [{ severity: "minor", message: "nit" }]);
		const before = await latestRow(seeded.sourceNarratorId);

		const { narratorService } = await import("../narrator-service");
		await narratorService.markReviewFeedbackApplied(seeded.sourceNarratorId, before?.id as string);

		const after = await latestRow(seeded.sourceNarratorId);
		expect(after?.id).toBe(before?.id);
		expect(after?.role).toBe("user");
		expect(after?.contentText).toBe(before?.contentText);
		// Still one row: handling a conclusion adds no message.
		const rows = await db.query.narratorMessages.findMany({
			where: eq(narratorMessages.narratorId, seeded.sourceNarratorId),
		});
		expect(rows).toHaveLength(1);
	});

	test("refuses a message that is not a review card", async () => {
		const seeded = await seed();
		const { narratorService } = await import("../narrator-service");
		const plain = await narratorService.persistUserMessage(
			seeded.sourceNarratorId,
			"just a message",
			[{ type: "text", text: "just a message" }],
		);
		expect(
			narratorService.markReviewFeedbackApplied(seeded.sourceNarratorId, plain.id),
		).rejects.toThrow();
	});
});
