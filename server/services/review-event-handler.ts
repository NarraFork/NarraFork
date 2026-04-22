/**
 * Review event handler — listens for `review:concluded` events and injects
 * structured review feedback as a system message into the source chapter's
 * primary narrator, so the narrator sees the review outcome in its next turn.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { narrators, reviewConclusions } from "../db/schema";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { narratorService } from "./narrator-service";

// === Finding type (mirrors schema) ===

interface ReviewFinding {
	severity: "critical" | "major" | "minor" | "suggestion";
	file?: string;
	line?: number;
	message: string;
}

type Verdict = "approve" | "request_changes" | "comment_only";

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

function buildFeedbackText(verdict: Verdict, findings: ReviewFinding[] | null): string {
	let text = `## Code Review: ${VERDICT_LABELS[verdict]}\n\n`;

	if (findings && findings.length > 0) {
		for (const f of findings) {
			const icon = SEVERITY_ICONS[f.severity] ?? "";
			const loc = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\` — ` : "";
			text += `- ${icon} **[${f.severity}]** ${loc}${f.message}\n`;
		}
		text += "\n";
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
			const feedbackText = buildFeedbackText(conclusion.verdict as Verdict, findings);

			// 4. Persist as system message (role="user" with review_feedback block)
			const msg = await narratorService.persistSystemMessage(sourceNarrator.id, feedbackText, [
				{
					type: "review_feedback",
					verdict: conclusion.verdict,
					findings: findings ?? [],
					reviewChapterId: event.reviewChapterId,
				},
			]);

			// 5. Broadcast to connected clients
			eventBus.emit({
				type: "narrator:ws_broadcast",
				narratorId: sourceNarrator.id,
				message: {
					type: "message",
					narratorId: sourceNarrator.id,
					message: { ...msg, creator: null },
				},
			});

			logger.info("Review feedback injected into source narrator", {
				sourceNarratorId: sourceNarrator.id,
				reviewChapterId: event.reviewChapterId,
				verdict: conclusion.verdict,
				findingsCount: findings?.length ?? 0,
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
