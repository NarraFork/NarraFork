import { GIT_COMMIT_SHA_PATTERN } from "@shared/git-commit-preview";
import { z } from "zod";

const filePathArray = z.array(z.string().min(1)).min(1);

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
	})
	.refine((d) => (d.files && d.files.length > 0) || d.all, {
		message: "Provide files array or set all=true",
	});

export const gitUnstageSchema = z
	.object({
		files: filePathArray.optional(),
		all: z.boolean().optional(),
	})
	.refine((d) => (d.files && d.files.length > 0) || d.all, {
		message: "Provide files array or set all=true",
	});

export const gitCommitSchema = z.object({
	message: z.string().min(1).max(500),
});

export const gitDiscardSchema = z
	.object({
		files: filePathArray.optional(),
		all: z.boolean().optional(),
	})
	.refine((d) => (d.files && d.files.length > 0) || d.all, {
		message: "Provide files array or set all=true",
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

// === modification view ===

/**
 * Query for `GET /:chapterId/git/modifications`.
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
export const gitModificationsQuerySchema = z.object({
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
});

// === commits list ===

export const listCommitsSchema = z.object({
	since: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
});
