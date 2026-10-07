import { FORK_WORKTREE_SOURCES } from "@shared/chapter-fork";
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

export const forkChapterSchema = z
	.object({
		title: z.string().min(1).max(200).optional(),
		description: z.string().max(2000).optional(),
		inheritMode: z.enum(["full", "compressed", "fresh"]).optional(),
		worktreeSource: z.enum(FORK_WORKTREE_SOURCES).optional(),
		/** Fork point by SDK message uuid (assistant messages only). */
		forkAtMessageUuid: z.string().min(1).optional(),
		/** Fork point by local narrator message id (any role) — preferred for UI forks. */
		forkAtMessageId: z.string().min(1).optional(),
		/** Explicit commit SHA to fork from. Only valid with commit worktree source. */
		startCommitSha: z.string().min(1).optional(),
		/** Explicit parent chapter ID (ruler mode). Defaults to root chapter. */
		parentChapterId: z.string().min(1).optional(),
		role: z.enum(["branch", "exploration"]).default("branch"),
		anchorCommitSha: z.string().min(1).optional(),
		axisOffset: z.number().optional(),
		crossOffset: z.number().min(0).optional(),
	})
	.superRefine((data, ctx) => {
		if (data.forkAtMessageId && data.forkAtMessageUuid) {
			ctx.addIssue({
				code: "custom",
				message: "forkAtMessageId and forkAtMessageUuid are mutually exclusive",
				path: ["forkAtMessageId"],
			});
		}
		if (data.startCommitSha && (data.forkAtMessageId || data.forkAtMessageUuid)) {
			ctx.addIssue({
				code: "custom",
				message: "Message fork coordinates and startCommitSha are mutually exclusive",
				path: ["startCommitSha"],
			});
		}
		if (data.startCommitSha && data.worktreeSource === "workspace") {
			ctx.addIssue({
				code: "custom",
				message: "startCommitSha requires worktreeSource=commit",
				path: ["worktreeSource"],
			});
		}
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
	/** Ruler position: offsets relative to `anchorCommitSha`'s tick. */
	anchorCommitSha: z.string().min(1).optional(),
	axisOffset: z.number().optional(),
	crossOffset: z.number().min(0).optional(),
	/**
	 * Classic canvas position: absolute React Flow world coordinates. Unclamped,
	 * unlike `crossOffset` — a React Flow canvas has no origin the user is confined
	 * to, so negative coordinates are legitimate.
	 */
	graphX: z.number().finite().optional(),
	graphY: z.number().finite().optional(),
});

// === chapter edges: no user-authored edges ===
//
// `createChapterEdgeSchema` used to live here, accepting only `type: "dependency"`. Chapter
// edges are now all derived from the operation that creates them (fork/split, merge,
// review), so there is no create route left to validate. See `chapter-edge-service.ts` for
// why the dependency edge went away.

// === graph positions ===

/**
 * Classic canvas node positions.
 *
 * `x`/`y` are absolute React Flow world coordinates and land in the dedicated
 * `chapters.graphX`/`graphY` columns. This schema deliberately has no
 * `anchorCommitSha`/`axisOffset`/`crossOffset`: those are ruler's tick-relative
 * coordinate system (see `updateRulerPositionsSchema`), and letting this route
 * accept them is how the two canvases used to overwrite each other's layout.
 *
 * Neither axis is clamped to be non-negative — unlike ruler's `crossOffset`, which
 * measures distance from a ruler track and so has a real floor at 0. A React Flow
 * canvas has no origin the user is confined to; panning above or left of it is
 * normal, and clamping would silently snap those nodes onto the axes.
 */
export const updateGraphPositionsSchema = z.object({
	positions: z
		.array(
			z.object({
				chapterId: z.string().min(1),
				x: z.number().finite(),
				y: z.number().finite(),
				panelExpanded: z.boolean().optional(),
				panelWidth: z.number().finite().optional(),
				panelHeight: z.number().finite().optional(),
			}),
		)
		.max(500),
});

// === graph node dock layout ===

/**
 * Hard cap on a node's serialized dockview layout.
 *
 * The payload is a `SerializedDockview` string produced by the client, and it
 * grows with every panel opened, so it needs an explicit ceiling rather than
 * whatever the body parser tolerates. 64 KiB is far above a realistic layout
 * (a few hundred bytes for chat alone, single-digit KB with many panels) while
 * still bounding what one chapter row can hold.
 *
 * Deliberately NOT folded into `updateGraphPositionsSchema`: that route writes up
 * to 500 chapters per request and fires on every node drag, so carrying layouts
 * there would attach kilobytes of panel state to a position update.
 */
export const CHAPTER_DOCK_LAYOUT_MAX_BYTES = 65536;

export const updateChapterDockLayoutSchema = z.object({
	/** Serialized layout envelope, or null to reset the node to the default layout. */
	layout: z.string().max(CHAPTER_DOCK_LAYOUT_MAX_BYTES).nullable(),
});

/**
 * Cap on the detached-panel list for one chapter.
 *
 * Matches the dock-layout cap, because each detached canvas node now carries its
 * OWN serialized dockview layout: the nodes host real dockview surfaces (so that
 * tab drag/reorder/middle-click-close come from dockview rather than being
 * re-implemented), and one chapter can have several such nodes.
 *
 * This deliberately replaces the earlier, tighter bound that assumed a short flat
 * list of kind + geometry. Over-cap payloads are dropped client-side before the
 * request is made (see `serializeDetachedNodes`), so the ceiling degrades safely
 * rather than surfacing as a 400.
 */
export const CHAPTER_DETACHED_PANELS_MAX_BYTES = 65536;

export const updateChapterDetachedPanelsSchema = z.object({
	/** Serialized detached-panel envelope, or null when nothing is detached. */
	panels: z.string().max(CHAPTER_DETACHED_PANELS_MAX_BYTES).nullable(),
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
// came to look like a working feature.
//
// Reviving it means a service method plus a route; write the schema then. Note the
// per-fork `crossOffset` question in `chapter-fork.ts` — a batch is the one caller that
// can assign slots up front and sidestep the unguarded slot search.

// === chapter-level cherry-pick: not implemented ===
//
// `cherryPickSchema` used to live here, in the same shape as the batch-fork stub above:
// no `POST /chapters/:id/cherry-pick` route parsed it and the frontend client naming that
// endpoint has been removed.
//
// Do not confuse this with cherry-pick as a *merge strategy*, which does work: see
// `gitService.cherryPick`, reached via `chapter-merge` with `strategy: "cherry-pick"`,
// which records commits as `source: "cherry_pick"`. What is missing is the standalone
// feature of picking commits off another chapter and drawing a `cherry_pick` edge for it.
// Nothing creates edges of that type today, so `CherryPickEdge` never renders.
//
// Reviving it means a service method, a route, and a `chapterEdgeService.createCherryPickEdge`;
// write the schema then.
