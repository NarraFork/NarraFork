import { z } from "zod";
import { gitBranchName } from "./common";

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
	status: z.enum(["active", "dormant", "merged", "abandoned", "frozen"]).optional(),
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
	forkAtMessageUuid: z.string().optional(),
	/** Explicit commit SHA to fork from (ruler mode). Overrides forkAtMessageUuid. */
	startCommitSha: z.string().optional(),
	/** Explicit parent chapter ID (ruler mode). Defaults to root chapter. */
	parentChapterId: z.string().optional(),
	role: z.enum(["branch", "exploration"]).default("branch"),
	anchorCommitSha: z.string().optional(),
	axisOffset: z.number().optional(),
	crossOffset: z.number().min(0).optional(),
});

export const mergeChapterSchema = z.object({
	targetChapterId: z.string().min(1),
	strategy: z.enum(["merge", "squash", "cherry-pick"]).optional(),
	message: z.string().max(500).optional(),
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
	locale: z.enum(["en", "zh-CN"]).optional(),
	anchorCommitSha: z.string().optional(),
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

// === batch fork ===

export const batchForkSchema = z.object({
	forks: z
		.array(
			z.object({
				title: z.string().min(1).max(200),
				description: z.string().max(2000).optional(),
				inheritMode: z.enum(["full", "compressed", "fresh"]).default("full"),
				role: z.enum(["branch", "exploration"]).default("branch"),
			}),
		)
		.min(1)
		.max(10),
});

// === cherry-pick ===

export const cherryPickSchema = z.object({
	sourceChapterId: z.string().min(1),
	commitShas: z.array(z.string().min(1)).min(1),
});
