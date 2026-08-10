import { z } from "zod";
import { gitBranchName, localeSchema } from "./common";

export const createChapterSchema = z.object({
	projectId: z.string().min(1),
	title: z.string().min(1).max(200),
	description: z.string().max(2000).optional(),
	baseBranch: gitBranchName.optional(),
});

export const containerConfigSchema = z.object({
	composeFile: z.string().max(500).optional(),
	services: z.array(z.string().min(1)).optional(),
	ports: z
		.array(
			z.object({
				containerPort: z.number().int().min(1).max(65535),
				serviceName: z.string().min(1),
			}),
		)
		.optional(),
	env: z.record(z.string(), z.string()).optional(),
});

export const updateChapterSchema = z.object({
	title: z.string().min(1).max(200).optional(),
	description: z.string().max(2000).optional(),
	// `frozen` is deliberately absent; see the note on `chapters.status` in schema.ts.
	status: z.enum(["active", "dormant", "merged", "abandoned"]).optional(),
	role: z.enum(["trunk", "branch", "exploration", "review"]).optional(),
	color: z.string().max(20).nullable().optional(),
	groupLabel: z.string().max(100).nullable().optional(),
	containerConfig: containerConfigSchema.nullable().optional(),
});

// === Fork / Merge / Cleanup ===

export const forkChapterSchema = z.object({
	title: z.string().min(1).max(200).optional(),
	description: z.string().max(2000).optional(),
	inheritMode: z.enum(["full", "compressed", "fresh"]).optional(),
	/** Fork point by SDK message uuid (assistant messages only). */
	forkAtMessageUuid: z.string().min(1).optional(),
	/** Fork point by local narrator message id (any role) — preferred for UI forks. */
	forkAtMessageId: z.string().min(1).optional(),
	/** Explicit commit SHA to fork from (ruler mode). Overrides the fork point. */
	startCommitSha: z.string().min(1).optional(),
	/** Explicit parent chapter ID (ruler mode). Defaults to root chapter. */
	parentChapterId: z.string().min(1).optional(),
	role: z.enum(["branch", "exploration"]).default("branch"),
	anchorCommitSha: z.string().min(1).optional(),
	axisOffset: z.number().optional(),
	crossOffset: z.number().min(0).optional(),
});

export const mergeChapterSchema = z.object({
	targetChapterId: z.string().min(1),
	strategy: z.enum(["merge", "squash", "cherry-pick"]).optional(),
	message: z.string().max(500).optional(),
	/**
	 * Which space the merge is carried out in.
	 *
	 * Omitted means "decide automatically", which prefers `snapshot` — merging the
	 * workspaces as they stand, without requiring or creating commits. `commit` asks
	 * for the historical behaviour, including its uncommitted-changes rejection.
	 */
	mode: z.enum(["snapshot", "commit"]).optional(),
});

export const mergeCheckSchema = z.object({
	targetChapterId: z.string().min(1),
});

export const batchCleanupSchema = z.object({
	chapterIds: z.array(z.string().min(1)).min(1),
	force: z.boolean().optional(),
	deleteBranch: z.boolean().optional(),
});

export const batchMergeSchema = z
	.object({
		baseChapterId: z.string().min(1),
		sourceChapterIds: z.array(z.string().min(1)).min(1),
		title: z.string().max(200).default(""),
		description: z.string().max(2000).optional(),
		strategy: z.enum(["merge", "squash", "cherry-pick"]).optional(),
		/** If provided, merge directly into this existing chapter instead of forking */
		targetChapterId: z.string().min(1).optional(),
	})
	.refine((data) => data.targetChapterId || (data.title && data.title.length > 0), {
		message: "title is required when not merging into an existing chapter",
		path: ["title"],
	});

export const createReviewSchema = z.object({
	title: z.string().min(1).max(200).optional(),
	locale: localeSchema.optional(),
	anchorCommitSha: z.string().min(1).optional(),
	axisOffset: z.number().optional(),
	crossOffset: z.number().min(0).optional(),
});

// === chapter edges ===

export const createChapterEdgeSchema = z.object({
	sourceId: z.string().min(1),
	targetId: z.string().min(1),
	type: z.enum(["dependency"]),
	metadata: z
		.object({
			description: z.string().max(500).optional(),
		})
		.optional(),
});

// === graph positions ===

export const updateGraphPositionsSchema = z.object({
	positions: z
		.array(
			z.object({
				chapterId: z.string().min(1),
				anchorCommitSha: z.string().optional(),
				axisOffset: z.number().finite(),
				crossOffset: z.number().finite().min(0),
				panelExpanded: z.boolean().optional(),
				panelWidth: z.number().finite().optional(),
				panelHeight: z.number().finite().optional(),
			}),
		)
		.max(500),
});

// === chapter split ===

export const splitChapterSchema = z.object({
	commitSha: z.string().min(1),
	newFork: z.object({
		title: z.string().min(1).max(200),
		description: z.string().max(2000).optional(),
		inheritMode: z.enum(["full", "compressed", "fresh"]).default("full"),
	}),
});

// === batch fork: not implemented ===
//
// `batchForkSchema` used to live here. There was never a `POST /chapters/:id/batch-fork`
// route to parse with it, nor a `chapterFork` method behind one, and the frontend client
// that named the endpoint has been removed too. A validator for a request nothing accepts
// is indistinguishable from one for a request that works, which is how the whole feature
// came to look implemented in DESIGN.md.
//
// Reviving it means a service method plus a route; write the schema then. Note the
// per-fork `crossOffset` question in `chapter-fork.ts` — a batch is the one caller that
// can assign slots up front and sidestep the unguarded slot search.

// === cherry-pick ===

export const cherryPickSchema = z.object({
	sourceChapterId: z.string().min(1),
	commitShas: z.array(z.string().min(1)).min(1),
});
