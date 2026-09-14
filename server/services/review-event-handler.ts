/**
 * Review event handler — writes a concluded review into the source chapter's history.
 *
 * ## One row, model-visible, from the moment it lands
 *
 * The conclusion IS a `role: "user"` message. That is the whole design, and it removes
 * the questions the earlier attempts kept re-asking:
 *
 *   - Nothing has to be "delivered" to a running narrator. NarraFork sends the full
 *     history on every request, so the next pass rebuilds from the database and sees the
 *     row. There is no buffer queue, no soft stop, and no second copy of the text.
 *   - Nothing is duplicated on screen. The card and the model read the SAME row: the
 *     `review_feedback` block draws it, the `text` block is what the model receives.
 *   - An idle narrator needs no wake-up to be informed, only to start working. The card's
 *     button therefore starts a loop over the history that already contains this row —
 *     it writes nothing (see the apply route).
 *
 * `role: "user"` rather than `sys` is deliberate: a review that says "change this" is a
 * request, and `taskReflection` reads the parent history to decide whether a task was
 * actually asked for. `origin: "system"` keeps the attribution honest — a reviewer, not
 * the reader, spoke.
 */
import { formatOriginLabel } from "@shared/message-origin";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { narrators, reviewConclusions } from "../db/schema";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { publishHistoryMessage } from "./narrator-history-publisher";
import { narratorService } from "./narrator-service";

// === Finding type (mirrors schema) ===

export interface ReviewFinding {
	severity: "critical" | "major" | "minor" | "suggestion";
	file?: string;
	line?: number;
	message: string;
}

export type Verdict = "approve" | "request_changes" | "comment_only";

// === Build human-readable feedback text ===

const VERDICT_LABELS: Record<Verdict, string> = {
	approve: "Approved",
	request_changes: "Changes Requested",
	comment_only: "Comments Only",
};

const SEVERITY_ICONS: Record<string, string> = {
	critical: "\u{1F6A8}",
	major: "\u26A0\uFE0F",
	minor: "\u{1F4CB}",
	suggestion: "\u{1F4A1}",
};

export function buildFeedbackText(
	verdict: Verdict,
	findings: ReviewFinding[] | null,
	options?: { revised?: boolean },
): string {
	const heading = options?.revised
		? `## Code Review (revised): ${VERDICT_LABELS[verdict]}\n\n`
		: `## Code Review: ${VERDICT_LABELS[verdict]}\n\n`;
	let text = heading;

	if (findings && findings.length > 0) {
		for (const f of findings) {
			const icon = SEVERITY_ICONS[f.severity] ?? "";
			const loc = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\` — ` : "";
			text += `- ${icon} **[${f.severity}]** ${loc}${f.message}\n`;
		}
		text += "\n";
	}

	if (options?.revised) {
		text += "This replaces the reviewer's earlier conclusion.\n";
	}
	if (verdict === "request_changes") {
		text += "Please address the above findings before merging.\n";
	}

	return text;
}

// === Event handler ===

export function initReviewEventHandler(): void {
	eventBus.on("review:concluded", async (event) => {
		try {
			// 1. Fetch the latest conclusion for this review chapter
			const conclusion = await db.query.reviewConclusions.findFirst({
				where: eq(reviewConclusions.reviewChapterId, event.reviewChapterId),
				orderBy: [desc(reviewConclusions.createdAt)],
			});
			if (!conclusion) {
				// No structured conclusion yet (review concluded without ConcludeReview tool)
				return;
			}

			// 2. Find the source chapter's primary narrator
			const sourceNarrator = await db.query.narrators.findFirst({
				where: and(
					eq(narrators.chapterId, event.sourceChapterId),
					eq(narrators.variant, "primary"),
				),
			});
			if (!sourceNarrator) {
				logger.debug("No primary narrator for source chapter, skipping feedback injection", {
					sourceChapterId: event.sourceChapterId,
				});
				return;
			}

			// 3. Build feedback text + structured block
			const findings = (conclusion.findingsJson as ReviewFinding[] | null) ?? null;
			const revised = event.revised === true;
			const feedbackText = buildFeedbackText(conclusion.verdict as Verdict, findings, { revised });

			// 4. One row, carrying both projections of the same conclusion: the `text` block
			//    is what the model reads, the `review_feedback` block is what the reader
			//    sees. Written as `role: "user"` so it is in the history immediately — a
			//    running narrator picks it up on its next pass with no delivery step, and an
			//    idle one already has it before the reader presses anything.
			//
			//    `text` is carried on the BLOCK as well because that is what the card
			//    renders; rows written before that field existed are composed from
			//    `verdict`/`findings` by the adapter.
			const msg = await narratorService.persistUserMessage(
				sourceNarrator.id,
				feedbackText,
				[
					{ type: "text", text: feedbackText },
					{
						type: "review_feedback",
						verdict: conclusion.verdict,
						findings: findings ?? [],
						reviewChapterId: event.reviewChapterId,
						text: feedbackText,
						revised,
					},
				],
				undefined,
				// No human authored this: the reviewer is another chapter's narrator.
				undefined,
				{ origin: "system", originLabel: formatOriginLabel("review") },
			);

			// 5. Broadcast so an open panel shows the card without a refetch.
			publishHistoryMessage(sourceNarrator.id, msg, "user_message");

			logger.info("Review conclusion written to the source narrator's history", {
				sourceNarratorId: sourceNarrator.id,
				reviewChapterId: event.reviewChapterId,
				verdict: conclusion.verdict,
				findingsCount: findings?.length ?? 0,
				revised,
			});
		} catch (err) {
			logger.error("Failed to inject review feedback", {
				reviewChapterId: event.reviewChapterId,
				sourceChapterId: event.sourceChapterId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});
}
