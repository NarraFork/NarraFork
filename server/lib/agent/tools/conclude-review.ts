import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "../../../db";
import { chapters, reviewConclusions } from "../../../db/schema";
import { generateId } from "../../id";
import { logger } from "../../logger";
import type { ToolContext, ToolDefinition, ToolResult } from "../types";

export const concludeReviewTool: ToolDefinition = {
	name: "ConcludeReview",
	description:
		"Submit your structured review conclusion. You MUST call this tool when you have completed your code review. " +
		"Do NOT output your conclusion as plain text — always use this tool to submit a structured verdict and findings. " +
		"Calling it again after you have already concluded replaces your earlier conclusion, which is what to do if you " +
		"were asked to re-examine the code.",
	rawJsonSchema: {
		type: "object",
		properties: {
			verdict: {
				type: "string",
				enum: ["approve", "request_changes", "comment_only"],
				description: "Your overall verdict on the code changes",
			},
			findings: {
				type: "array",
				items: {
					type: "object",
					properties: {
						severity: {
							type: "string",
							enum: ["critical", "major", "minor", "suggestion"],
							description: "Severity level of the finding",
						},
						file: {
							type: "string",
							description: "File path (optional)",
						},
						line: {
							type: "number",
							description: "Line number (optional)",
						},
						message: {
							type: "string",
							description: "Description of the finding",
						},
					},
					required: ["severity", "message"],
					additionalProperties: false,
				},
				description: "List of findings ordered by severity",
			},
		},
		required: ["verdict", "findings"],
		additionalProperties: false,
	},
	parameters: z.object({
		verdict: z
			.enum(["approve", "request_changes", "comment_only"])
			.describe("Overall verdict on the code changes"),
		findings: z
			.array(
				z.object({
					severity: z.enum(["critical", "major", "minor", "suggestion"]),
					file: z.string().optional(),
					line: z.number().optional(),
					message: z.string(),
				}),
			)
			.describe("List of findings ordered by severity"),
	}),

	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		const { verdict, findings } = args as {
			verdict: "approve" | "request_changes" | "comment_only";
			findings: Array<{
				severity: "critical" | "major" | "minor" | "suggestion";
				file?: string;
				line?: number;
				message: string;
			}>;
		};

		if (!ctx.chapterId) {
			return { output: "Error: No chapter context available.", isError: true };
		}

		// Verify this is a review chapter
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, ctx.chapterId),
			columns: {
				id: true,
				role: true,
				reviewSourceChapterId: true,
				reviewStatus: true,
			},
		});

		if (!chapter || chapter.role !== "review") {
			return {
				output: "Error: ConcludeReview can only be used in review chapters.",
				isError: true,
			};
		}

		if (!chapter.reviewSourceChapterId) {
			return {
				output: "Error: Review chapter has no source chapter.",
				isError: true,
			};
		}

		// A concluded review accepts a REVISED conclusion. Refusing it made the platform
		// contradict itself: the workspace guard restores the reviewer's files and asks it
		// to re-examine and re-submit, and the only tool for submitting then answered
		// "Review is already concluded" — leaving findings the reviewer had disowned as
		// the source chapter's latest word. `converted` and `dismissed` stay closed: those
		// reviews have had their worktree and narrator torn down, so there is nothing
		// coherent left to revise.
		const revising = chapter.reviewStatus === "concluded";
		if (chapter.reviewStatus !== "reviewing" && !revising) {
			return {
				output: `Error: Review is ${chapter.reviewStatus ?? "in an invalid state"} and can no longer accept a conclusion.`,
				isError: true,
			};
		}

		const now = new Date().toISOString();

		// Appended, not overwritten: `review_conclusions` is read newest-first, so a new
		// row IS the current conclusion while the superseded one stays auditable.
		await db.insert(reviewConclusions).values({
			id: generateId(),
			reviewChapterId: ctx.chapterId,
			sourceChapterId: chapter.reviewSourceChapterId,
			verdict,
			findingsJson: findings,
			createdAt: now,
		});

		// Import lazily to avoid a startup cycle through narrator-session -> agent index.
		const { reviewService } = await import("../../../services/review-service");

		// Status update (first time only) + event emission (every time, so a revision
		// reaches the source chapter too).
		await reviewService.concludeReview(ctx.chapterId);

		logger.info(
			revising ? "Revised review conclusion submitted" : "Structured review conclusion submitted",
			{
				reviewChapterId: ctx.chapterId,
				verdict,
				findingsCount: findings.length,
			},
		);

		// Build a human-readable summary for the tool output
		const severityCounts = { critical: 0, major: 0, minor: 0, suggestion: 0 };
		for (const f of findings) {
			severityCounts[f.severity]++;
		}
		const countParts = Object.entries(severityCounts)
			.filter(([, c]) => c > 0)
			.map(([s, c]) => `${c} ${s}`)
			.join(", ");

		return {
			output:
				`${
					revising
						? "Revised review conclusion submitted successfully — it replaces your earlier one."
						: "Review conclusion submitted successfully."
				}\n` +
				`Verdict: ${verdict}\n` +
				`Findings: ${findings.length} total${countParts ? ` (${countParts})` : ""}`,
		};
	},
};
