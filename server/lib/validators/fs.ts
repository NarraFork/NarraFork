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
