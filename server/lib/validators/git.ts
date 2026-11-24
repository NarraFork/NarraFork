import {
	GIT_BRANCH_NAME_MAX,
	GIT_START_POINT_MAX,
	isValidGitBranchName,
	isValidGitRemoteName,
	isValidGitStartPoint,
} from "@shared/git-branches";
import { GIT_COMMIT_SHA_PATTERN } from "@shared/git-commit-preview";
import { GIT_STAGING_LIMITS } from "@shared/git-staging-lists";
import {
	GIT_STATUS_FILTER_CHARS,
	GIT_STATUS_PAGE_MAX_BYTES,
	GIT_STATUS_PAGE_MAX_LIMIT,
	isGitStatusFilterChar,
} from "@shared/git-status-page";
import { z } from "zod";

const filePathArray = z.array(z.string().min(1)).min(1);
const snapshotScopeSchema = z.object({
	snapshotId: z.string().min(1).max(128),
	filter: z.array(z.enum(GIT_STATUS_FILTER_CHARS)).max(GIT_STATUS_FILTER_CHARS.length),
	section: z.enum(["staged", "unstaged"]),
	directory: z.string().min(1).max(4096).optional(),
});

/**
 * Defense-in-depth: git ref/SHA validator.
 *
 * Even though we pass args via argv (no shell injection), a leading `-` would be
 * interpreted as a flag by git (e.g. `--hard`). We restrict to the character set
 * that legal git refs and SHA expressions use:
 *   - First character must not be `-` (prevents flag injection)
 *   - Allowed: alphanumeric, `.`, `_`, `/`, `~`, `^`, `@`, `{`, `}`, `-`
 *   - Disallowed: spaces, control characters, `..` (path traversal in refspecs)
 *
 * Covers: full/short SHAs, branch names (feature/x), tags (v1.0.0), relative
 * refs (HEAD~1, main^2), reflog (@{1}), remote refs (origin/main).
 */
export const gitRefPattern = /^[A-Za-z0-9_./@~^{][A-Za-z0-9._/~^@{}-]*$/;

export const gitRef = z
	.string()
	.min(1)
	.max(200)
	.regex(gitRefPattern, "Invalid git ref: must not start with '-' or contain spaces/control chars")
	.refine((s) => !s.includes(".."), "Invalid git ref: '..' is not allowed");

export const gitStageSchema = z
	.object({
		files: filePathArray.optional(),
		all: z.boolean().optional(),
		snapshotScope: snapshotScopeSchema.optional(),
	})
	.refine((d) => (d.files && d.files.length > 0) || d.all, {
		message: "Provide files array or set all=true",
	})
	.refine((d) => !d.snapshotScope || (!!d.files && !d.all), {
		message: "Snapshot scope requires explicit files and cannot be combined with all=true",
	});

export const gitUnstageSchema = z
	.object({
		files: filePathArray.optional(),
		all: z.boolean().optional(),
		snapshotScope: snapshotScopeSchema.optional(),
	})
	.refine((d) => (d.files && d.files.length > 0) || d.all, {
		message: "Provide files array or set all=true",
	})
	.refine((d) => !d.snapshotScope || (!!d.files && !d.all), {
		message: "Snapshot scope requires explicit files and cannot be combined with all=true",
	});

export const gitCommitSchema = z.object({
	message: z.string().min(1).max(500),
});

export const gitDiscardSchema = z
	.object({
		files: filePathArray.optional(),
		all: z.boolean().optional(),
		snapshotScope: snapshotScopeSchema.optional(),
	})
	.refine((d) => (d.files && d.files.length > 0) || d.all, {
		message: "Provide files array or set all=true",
	})
	.refine((d) => !d.snapshotScope || (!!d.files && !d.all), {
		message: "Snapshot scope requires explicit files and cannot be combined with all=true",
	});

export const gitStashSchema = z.object({
	action: z.enum(["push", "pop", "drop"]),
	message: z.string().max(200).optional(),
	index: z.number().int().min(0).optional(),
});

export const gitResetSchema = z.object({
	target: gitRef,
	mode: z.enum(["soft", "hard"]),
});

export const gitLogQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(200).default(50),
	skip: z.coerce.number().int().min(0).default(0),
});

export const gitDiffQuerySchema = z.object({
	file: z.string().min(1),
	staged: z
		.string()
		.optional()
		.transform((v) => v === "true"),
});

/** Full commit object name only: refs, ranges and flags cannot reach git. */
export const gitCommitShaSchema = z
	.string()
	.regex(GIT_COMMIT_SHA_PATTERN, "Commit preview requires a full commit SHA")
	.transform((sha) => sha.toLowerCase());

export const gitCommitDiffQuerySchema = z.object({
	file: z.string().min(1).max(4096),
	oldPath: z.string().min(1).max(4096).optional(),
});

// === branch management ===

/**
 * A branch NAME, not a revision.
 *
 * Deliberately not `gitRef`: that pattern models revision syntax and therefore
 * allows `~`, `^` and `@{}` (all illegal in a branch name), while it rejects legal
 * non-ASCII names and `+`. It is also not `common.ts`'s `gitBranchName`, which is
 * ASCII-only for the same reason. The server still runs
 * `git check-ref-format --branch` before creating a ref, so this is the stricter
 * of the two checks by construction.
 */
export const gitBranchNameSchema = z
	.string()
	.min(1)
	.max(GIT_BRANCH_NAME_MAX)
	.refine(isValidGitBranchName, "Invalid Git branch name");

/** A remote name: no leading dash, no whitespace/control/ref punctuation. */
export const gitRemoteNameSchema = z
	.string()
	.min(1)
	.max(100)
	.refine(isValidGitRemoteName, "Invalid Git remote");

/**
 * A checkout start point is a branch name or a revision.
 *
 * `gitRef` alone rejects `+` and non-ASCII, which are legal in `origin/功能` and
 * `origin/feature+x` — the values the picker sends when it tracks a remote branch.
 * Revisions such as `HEAD~2` stay accepted.
 */
export const gitStartPointSchema = z
	.string()
	.min(1)
	.max(GIT_START_POINT_MAX)
	.refine(isValidGitStartPoint, "Invalid Git start point");

export const gitCheckoutSchema = z.object({
	branch: gitBranchNameSchema,
	create: z.boolean().optional(),
	/** With `create`: the revision the new branch starts from (rev syntax allowed). */
	startPoint: gitStartPointSchema.optional(),
});

export const gitPushSchema = z.object({
	remote: gitRemoteNameSchema.optional(),
	setUpstream: z.boolean().optional(),
});

export const gitFetchSchema = z.object({
	remote: gitRemoteNameSchema.optional(),
	prune: z.boolean().optional(),
});

/** Statistics reuse the existing status-page row and byte budgets. */
export const gitStatusPageStatsQuerySchema = z.object({
	snapshotId: snapshotScopeSchema.shape.snapshotId,
	filter: z
		.string()
		.max(32)
		.optional()
		.transform((value) => (value ? value.split(",") : []))
		.refine((values) => values.every(isGitStatusFilterChar), "Invalid Git status filter")
		.transform((values) => values.filter(isGitStatusFilterChar)),
	rows: z
		.string()
		.refine(
			(value) => Buffer.byteLength(value, "utf8") <= GIT_STATUS_PAGE_MAX_BYTES,
			"Git status statistics exceed the page byte budget",
		)
		.transform((value, context): unknown => {
			try {
				return JSON.parse(value);
			} catch {
				context.addIssue({ code: "custom", message: "Invalid Git status statistics rows" });
				return z.NEVER;
			}
		})
		.pipe(
			z
				.array(
					z.object({
						type: z.enum(["file", "directory"]),
						section: snapshotScopeSchema.shape.section,
						path: gitCommitDiffQuerySchema.shape.file,
					}),
				)
				.min(1)
				.max(GIT_STATUS_PAGE_MAX_LIMIT),
		),
});

// === independent staging lists ===
export const gitStagingListIdSchema = z
	.string()
	.regex(/^[A-Za-z0-9_-]{1,128}$/, "Invalid staging identifier");
const stagingId = gitStagingListIdSchema;
const stagingName = z.string().refine(
	(value) =>
		[...value].length > 0 &&
		[...value].length <= GIT_STAGING_LIMITS.maxNameChars &&
		value.trim().length > 0 &&
		![...value].some((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff);
		}),
	"Invalid staging list name",
);
const stagingPath = z
	.string()
	.min(1)
	.max(GIT_STAGING_LIMITS.maxPathChars)
	.refine(
		(value) =>
			!value.includes("\0") &&
			!/^[\\/]|^[a-z]:[\\/]/i.test(value) &&
			!value.split(/[\\/]/).some((part) => part === ".." || part === ".") &&
			!/(^|[\\/])\.git([\\/]|$)/i.test(value) &&
			!/^\.narrafork[\\/]git-staging([\\/]|$)/i.test(value),
		"A Git-root-relative staging path is required",
	);
const stagingPaths = z
	.array(stagingPath)
	.min(1)
	.max(GIT_STAGING_LIMITS.maxFilesPerOperation)
	.refine(
		(values) => new Set(values).size === values.length,
		"Duplicate staging paths are not allowed",
	);
const stagingActionBase = { workspaceKey: z.string().min(1).max(128) };
const stagingExpectedVersion = {
	expectedGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	observationId: stagingId,
};
const stagingVersionedAction = { ...stagingActionBase, ...stagingExpectedVersion };
const stagingFilter = z.array(z.enum(GIT_STATUS_FILTER_CHARS)).max(6);
export const gitStagingActionSchema = z.discriminatedUnion("action", [
	z.object({ ...stagingActionBase, action: z.literal("init") }).strict(),
	z.object({ ...stagingActionBase, action: z.literal("sync") }).strict(),
	z.object({ ...stagingVersionedAction, action: z.literal("create"), name: stagingName }).strict(),
	z
		.object({
			...stagingVersionedAction,
			action: z.literal("rename"),
			listId: stagingId,
			name: stagingName,
		})
		.strict(),
	z
		.object({ ...stagingVersionedAction, action: z.literal("activate"), listId: stagingId })
		.strict(),
	z.object({ ...stagingVersionedAction, action: z.literal("delete"), listId: stagingId }).strict(),
	z
		.object({
			...stagingVersionedAction,
			action: z.literal("move"),
			fromListId: stagingId,
			toListId: stagingId,
			unitIds: z
				.array(
					z
						.string()
						.min(1)
						.max(256)
						.refine((id) => !/[\0\r\n]/.test(id), "Invalid unit identifier"),
				)
				.min(1)
				.max(GIT_STAGING_LIMITS.maxUnitsPerOperation)
				.refine((ids) => new Set(ids).size === ids.length, "Duplicate unit IDs")
				.optional(),
			paths: stagingPaths.optional(),
			all: z.literal(true).optional(),
			scope: z
				.object({ filter: stagingFilter.optional(), directory: stagingPath.optional() })
				.strict()
				.refine(
					(scope) => scope.directory !== undefined || !!scope.filter?.length,
					"An empty scope is not an explicit all-files selection",
				)
				.optional(),
		})
		.strict()
		.refine(
			(value) =>
				[value.unitIds, value.paths, value.all, value.scope].filter((v) => v !== undefined)
					.length === 1,
			"Choose exactly one move selection: unitIds, paths, all or scope",
		),
	// Identity is resolved for the authenticated user at the route boundary.
	z
		.object({
			...stagingVersionedAction,
			action: z.literal("commit"),
			listId: stagingId,
			message: z.string().trim().min(1).max(500),
		})
		.strict(),
	z
		.object({ ...stagingVersionedAction, action: z.literal("recover"), operationId: stagingId })
		.strict(),
]);
export const gitStagingFilesQuerySchema = z.object({
	workspaceKey: z.string().min(1).max(128),
	cursor: z.string().min(1).max(4096).optional(),
	limit: z.coerce.number().int().min(1).max(GIT_STAGING_LIMITS.maxPageRows).optional(),
	filter: z
		.string()
		.regex(/^[AMDRCU]*$/)
		.transform((value) => [...new Set(value)] as Array<(typeof GIT_STATUS_FILTER_CHARS)[number]>)
		.optional(),
});
export const gitStagingDiffQuerySchema = z.object({
	workspaceKey: z.string().min(1).max(128),
	path: stagingPath,
	oldPath: stagingPath.optional(),
});

// === modification view ===

/**
 * Query for `GET /api/narrators/:narratorId/git/modifications`.
 *
 * Validated rather than forwarded raw because the failure mode is silent. `since`/`until`
 * are compared as STRINGS against `file_attributions.changed_at` (SQLite has no date type),
 * so an unparseable value is not an error — it compares lexicographically, matches nothing,
 * and returns an empty window that a client reads as "this file has no attribution". The
 * same goes for `narratorId`: a malformed id matches no row. Drizzle parameterizes, so
 * there was never an injection risk here; the risk was a wrong answer that looks valid.
 *
 * `offset: true` on the timestamps allows both the `Z` form the database stores and a
 * client-local offset, which the comparison handles because boundaries are normalized to
 * UTC before they reach it.
 */
export const gitModificationsQuerySchema = z
	.object({
		limit: z.coerce.number().int().min(1).max(2000).optional(),
		since: z.iso.datetime({ offset: true }).optional(),
		until: z.iso.datetime({ offset: true }).optional(),
		/**
		 * A narrator id, or the literal `"external"` selecting changes with no narrator at all.
		 * Length-bounded rather than pattern-matched: ids are nanoid, whose alphabet includes
		 * `-` and `_`, and short ids (8 chars) are as valid as the 21-char default.
		 */
		narratorId: z.union([z.literal("external"), z.string().trim().min(1).max(64)]).optional(),
		scope: z.literal("uncommitted").optional(),
		/**
		 * Which projections to build. `byFile` omits the full timeline but includes a bounded
		 * per-file event summary for the Git status hover card. Absent means "everything", so
		 * an older client is unaffected.
		 */
		projection: z.enum(["all", "byFile"]).optional(),
		/**
		 * One Git-root-relative path for the hover card. It only selects an entry of the
		 * server's own status; rename sources and cwd scopes are never accepted from clients.
		 */
		filePath: z.string().min(1).max(4096).optional(),
	})
	.refine(
		(query) =>
			query.filePath === undefined ||
			(query.scope === "uncommitted" && query.projection === "byFile"),
		{ message: "filePath requires scope=uncommitted and projection=byFile", path: ["filePath"] },
	);

// === commits list ===

export const listCommitsSchema = z.object({
	since: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
});
