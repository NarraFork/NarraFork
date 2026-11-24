/**
 * Validators for `/api/fs/*`.
 *
 * Only the WRITE side is validated here. Reads take a single `path` query
 * parameter each and are checked inline against the credential deny-list
 * (`fs-secret-paths.ts`), which is where their real gate lives; a schema in front
 * of one string would only restate `typeof path === "string"`.
 *
 * Writing is different: the body carries four fields whose combinations decide
 * whether an existing file gets overwritten, so a malformed one must be refused
 * with a 400 that names the field rather than tripping over a hand-written `if`
 * chain further down.
 */

import { z } from "zod";
import { PROJECT_PROMPT_FILENAMES } from "../global-prompt-paths";

/**
 * Cap on the body of one human save, in UTF-16 code units of the JSON string.
 *
 * A cheap pre-filter, NOT the real limit: the byte length is what the route
 * enforces (`MAX_WRITE_BYTES`), and a multi-byte character costs more bytes than
 * code units. This exists so a 200 MB body is rejected by the parser instead of
 * being measured first — `Buffer.byteLength` on it would run on the server's only
 * JS thread. Set well above the byte cap so it can never be the binding
 * constraint for a legitimate save, which must fail with the byte-accurate error.
 */
const MAX_WRITE_CONTENT_LENGTH = 4 * 1024 * 1024;

export const fsWriteSchema = z.object({
	path: z.string().trim().min(1, "path is required"),
	content: z.string().max(MAX_WRITE_CONTENT_LENGTH, "Content exceeds the maximum writable size"),
	/**
	 * Required, and not merely for authorization: the narrator is what defines the
	 * writable root. A save with no session has no workspace to be bounded by.
	 */
	narratorId: z.string().trim().min(1, "narratorId is required"),
	/**
	 * sha256 of the content the editor loaded — the optimistic lock.
	 *
	 * `null`/absent means "I am creating this file", which the route refuses when the
	 * target already exists. Both spellings are accepted because a client that keeps
	 * the field in its request shape will send an explicit `null`.
	 */
	baseHash: z
		.string()
		.regex(/^[0-9a-f]{64}$/, "baseHash must be a lowercase hex sha256")
		.nullish(),
	/**
	 * The encoding the editor was told the file is in, echoed back from
	 * `/api/fs/edit-source`.
	 *
	 * Sent by the client rather than re-detected at write time on purpose: detection
	 * runs on the bytes, and by the time this request arrives the bytes are the ones
	 * being replaced. Re-detecting would let a file's encoding silently change
	 * because the user's new text happened to sniff differently.
	 *
	 * Absent means UTF-8, which is also what a client that predates this field means.
	 */
	encoding: z.string().trim().min(1).max(40).optional(),
	/**
	 * Acknowledge that the write targets a path outside all allowed roots.
	 *
	 * When `checkWriteBoundary` returns `confirmable: true`, the route responds 409
	 * NEEDS_CONFIRMATION with the resolved physical path. The client shows that path
	 * to the user; if they accept, the next save sets this flag. Only
	 * `outside-allowed-roots` honours it — secret-path and symlink escapes are hard
	 * refusals that no flag can override.
	 */
	confirmOutsideRoots: z.boolean().optional(),
	/**
	 * After a successful save, inject a notification into the narrator's conversation
	 * so it knows the user edited the file. Mirrors the spec-edit interject pattern.
	 */
	notifyAgent: z.boolean().optional(),
});

export type FsWriteInput = z.infer<typeof fsWriteSchema>;

/**
 * The two fields every mutating file operation carries.
 *
 * `narratorId` has the same job as in {@link fsWriteSchema}: it is what defines the
 * writable root, so an operation with no session has no workspace to be bounded by.
 */
const fsEntryTargetSchema = z.object({
	narratorId: z.string().trim().min(1, "narratorId is required"),
	path: z.string().trim().min(1, "path is required").max(4096),
});

/**
 * One NAME, never a path.
 *
 * Separators, control characters and the Windows-reserved set are refused exactly as
 * `POST /api/fs/mkdir` refuses them, so a rename cannot walk out of its directory or
 * produce a name the platform cannot store. `.` and `..` are refused separately: they
 * contain no separator, yet naming them would rename the entry over its own parent.
 */
const fsEntryNameSchema = z
	.string()
	.trim()
	.min(1, "name is required")
	.max(255, "name is too long")
	.refine((name) => !/[/\\<>:"|?*]/.test(name), "The name contains a character a path cannot hold")
	.refine(
		(name) => ![...name].some((ch) => ch.charCodeAt(0) < 32),
		"The name contains a control character",
	)
	.refine(
		(name) => name !== "." && name !== "..",
		"The name must not be a relative directory reference",
	);

/** `POST /api/fs/rename` — rename in place, keeping the entry in its own directory. */
export const fsRenameSchema = fsEntryTargetSchema.extend({ name: fsEntryNameSchema });

/** `POST /api/fs/delete` — remove one file entry. */
export const fsDeleteSchema = fsEntryTargetSchema;

/**
 * `POST /api/fs/transfer` — copy or move one file into a directory.
 *
 * The destination is a DIRECTORY plus the source's own name, rather than a full target
 * path: the paste gesture this serves means "put this file where that other file lives",
 * and accepting a full destination path would turn a bounded paste into an arbitrary
 * write at a client-chosen name.
 *
 * `overwrite` is the second half of that gesture: a paste onto a name that is already
 * taken answers 409 first, and replaces the file only when the user has been shown which
 * file that is and says yes. Absent means "do not replace anything".
 */
export const fsTransferSchema = fsEntryTargetSchema.extend({
	targetDir: z.string().trim().min(1, "targetDir is required").max(4096),
	mode: z.enum(["copy", "move"]),
	overwrite: z.boolean().optional(),
});

export type FsRenameInput = z.infer<typeof fsRenameSchema>;
export type FsTransferInput = z.infer<typeof fsTransferSchema>;

/**
 * One project instruction filename (`AGENTS.md` & friends).
 *
 * Constrained to the known filenames rather than accepting a path: the only thing
 * this feature is allowed to touch is a file NarraFork itself injects into a system
 * prompt, and accepting an arbitrary name would turn "edit the project prompt" into
 * a general-purpose file write that skips the narrator-scoped boundary in
 * `/api/fs/write`.
 */
const projectPromptFilenameSchema = z.enum(PROJECT_PROMPT_FILENAMES);

/** `GET /api/fs/project-prompt?cwd=…` */
export const projectPromptReadSchema = z.object({
	cwd: z.string().trim().min(1, "cwd is required").max(4096),
});

/**
 * `PUT /api/fs/project-prompt`.
 *
 * `baseHash` is the optimistic lock, with the same meaning as in `fsWriteSchema`:
 * absent means "I believe this file does not exist yet". Required whenever the file
 * IS on disk, because an agent may have rewritten it between the dialog opening and
 * the user pressing create, and the alternative to a 409 is silently discarding
 * that work.
 */
export const projectPromptWriteSchema = z.object({
	cwd: z.string().trim().min(1, "cwd is required").max(4096),
	filename: projectPromptFilenameSchema,
	content: z.string().max(MAX_WRITE_CONTENT_LENGTH, "Content exceeds the maximum writable size"),
	baseHash: z
		.string()
		.regex(/^[0-9a-f]{64}$/, "baseHash must be a lowercase hex sha256")
		.nullish(),
});
