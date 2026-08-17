/**
 * chat-attachments.ts — Disk layer for images and files posted into a chat room.
 *
 * ## Why a separate root from `uploads/`
 *
 * `uploads/<narratorId>/` is keyed by NARRATOR and reclaimed when that narrator is
 * deleted (`deleteNarratorUploads`) or judged orphaned (`cleanupOrphanedUploads`,
 * which preserves a directory only when some `narrator_messages.content_json` still
 * references an image block). A chat attachment has neither property: a DM has no
 * narrator at all, and a narrator-room attachment is referenced from
 * `chat_attachments`, which those cleanup paths do not read. Filing chat uploads
 * under a narrator id would therefore make them collateral damage of narrator
 * cleanup.
 *
 * ## Why not the worktree
 *
 * `saveTextFileToWorktree` puts narrator attachments in `<cwd>/.narrafork/attached/`,
 * which is inside the tree-snapshot boundary: a workspace-scoped rollback deletes
 * whatever the target tree does not contain. Chat history outlives any single
 * narrator turn, so an attachment stored there would disappear from a conversation
 * when someone reverted a turn — silently, since nothing links the two. Forwarding
 * COPIES into the worktree instead (see `copyChatAttachmentToWorktree`), so only the
 * copy is exposed to that.
 *
 * ## Image validation is fail-closed; non-images are accepted as opaque bytes
 *
 * Images go through `processImageUpload`, so a file that declares an image MIME type
 * but whose magic bytes disagree is REJECTED rather than stored. That matters more
 * here than for narrator uploads: a chat attachment is served back to other users of
 * the room, so storing a misdeclared file means later serving it under an image
 * content type.
 *
 * Non-images are NOT filtered by extension. `isTextFile` accepts everything by
 * design ("the extension allowlist is kept only for display hints"), and the
 * narrator attachment path relies on that, so rejecting a `.zip` here would make
 * chat arbitrarily stricter than the composer next to it for no security gain. The
 * actual mitigation is in how they are SERVED: a non-image is returned as
 * `application/octet-stream` with `Content-Disposition: attachment` and
 * `X-Content-Type-Options: nosniff`, so an uploaded `.svg` or `.html` is downloaded
 * rather than executed in the app's origin. Size is still bounded.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { MAX_TEXT_FILE_SIZE } from "@shared/text-file-types";
import { ValidationError } from "./errors";
import { generateShortId } from "./id";
import { logger } from "./logger";
import { getNarraforkPath } from "./narrafork-home";
import {
	allocateWorktreeAttachmentPath,
	ensureUploadDirWritable,
	type ImageDimensions,
	isWithinDir,
	MIME_TO_EXT,
	processImageUpload,
	type TextFileRef,
	toUploadPermissionError,
	validateUploadedImage,
} from "./uploads";

let chatAttachmentsDirTestOverride: string | null = null;

/** Tests only: override the chat-attachments root for this process. */
export function setChatAttachmentsDirForTests(dir?: string | null): void {
	chatAttachmentsDirTestOverride = dir ? resolve(dir) : null;
}

/**
 * The chat-attachments root.
 *
 * Resolved per call rather than captured at module load, for the same reason
 * `getUploadsDir` is: `getNarraforkPath` reads `NARRAFORK_HOME` lazily so test
 * preloads can set it before application modules are imported, and freezing the
 * answer in a module constant defeats that depending on import order.
 */
export function getChatAttachmentsDir(): string {
	return chatAttachmentsDirTestOverride ?? getNarraforkPath("chat-attachments");
}

/**
 * Max attachments a single chat message may carry.
 *
 * Matches the narrator composer's per-type limit so the two surfaces do not
 * disagree about what "too many" means.
 */
export const CHAT_ATTACHMENTS_PER_MESSAGE_MAX = 10;

/**
 * Ceiling on one room's unclaimed (draft) uploads per user.
 *
 * An upload is persisted before the message exists, so "upload and never send" is a
 * reachable state that costs disk with no row referencing it from chat history. The
 * cleanup path reclaims those after a grace window, but a bound is needed at write
 * time too: without it a loop could fill the disk faster than any periodic sweep.
 */
export const CHAT_DRAFT_ATTACHMENTS_MAX = 30;

/**
 * Combined byte ceiling for one message's attachments.
 *
 * Deliberately much lower than `MAX_NARRATOR_ATTACHMENT_BYTES` (128 MiB): a narrator
 * attachment is consumed once by a model, whereas a chat attachment is stored
 * indefinitely in a conversation and served to every room member who scrolls past
 * it. 64 MiB is generous for screenshots and logs while keeping a room's footprint
 * predictable.
 */
export const CHAT_ATTACHMENT_TOTAL_BYTES_MAX = 64 * 1024 * 1024;

/** Grace period before an unclaimed upload is treated as abandoned. */
export const CHAT_DRAFT_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

export interface SavedChatAttachment {
	kind: "image" | "file";
	filename: string;
	mediaType: string;
	sizeBytes: number;
	width?: number;
	height?: number;
	/** On-disk name inside the room directory. */
	storedName: string;
	/** Absolute path, for the caller's rollback on a failed DB write. */
	filePath: string;
}

/** Room directory, with traversal refused rather than normalized away. */
function resolveRoomDir(roomId: string): string {
	const root = getChatAttachmentsDir();
	const dir = resolve(root, roomId);
	if (!isWithinDir(root, dir) || dir === resolve(root)) {
		throw new ValidationError("Invalid room ID");
	}
	return dir;
}

/**
 * A media type for a non-image attachment.
 *
 * The browser's declared type is NOT trusted for storage decisions (the extension
 * allowlist already decided admissibility), but it is a reasonable label to serve
 * back. Anything absent or obviously wrong falls back to a generic type: these files
 * are always served as a download, never rendered inline, so the label is
 * informational rather than a security boundary.
 */
function fileMediaType(file: File): string {
	const declared = file.type?.trim();
	if (!declared || declared.length > 128) return "application/octet-stream";
	// A declared image type on a file that failed image validation would be a lie;
	// serving it as an image type invites the browser to render it.
	if (declared.startsWith("image/")) return "application/octet-stream";
	return declared;
}

/**
 * Whether to handle the upload as an image (thumbnail + parsed dimensions).
 *
 * Keyed on the media types the image pipeline can actually parse, NOT on the
 * `image/` prefix. The difference matters for `image/svg+xml`, `image/bmp`,
 * `image/tiff` and friends: with a prefix test they would enter image validation and
 * be REJECTED outright, so a user picking an SVG would simply be unable to attach
 * it. Routing them to the file branch stores them as opaque bytes, which is both
 * useful and safe — a non-image is served as an octet-stream download with `nosniff`,
 * so an SVG cannot execute in the app's origin.
 *
 * Within the supported set the pipeline still fails closed: a file declaring
 * `image/png` whose bytes are not a PNG is rejected rather than quietly demoted to a
 * download, because there the user's intent really was "an image" and silence would
 * hide a corrupt or disguised file.
 */
export function isChatImageUpload(file: File): boolean {
	return typeof file.type === "string" && file.type in MIME_TO_EXT;
}

/**
 * Persist one chat attachment and return everything the DB row needs.
 *
 * Validation happens BEFORE any write, so a rejected file leaves nothing on disk.
 * The caller is responsible for deleting `filePath` if its own DB insert then fails
 * — this function cannot do it, because a successful return is exactly the case
 * where the file must survive.
 */
export async function saveChatAttachment(roomId: string, file: File): Promise<SavedChatAttachment> {
	const dir = resolveRoomDir(roomId);
	const asImage = isChatImageUpload(file);

	// Checked before either branch, so no path can read the whole file into memory
	// ahead of the cap. The branches have their own, tighter limits today, which is
	// exactly why this one used to sit after them and never fire — a limit that only
	// holds because another limit happens to be smaller stops holding the moment that
	// other limit is raised.
	if (file.size > CHAT_ATTACHMENT_TOTAL_BYTES_MAX) {
		throw new ValidationError(
			`Attachment exceeds the ${(CHAT_ATTACHMENT_TOTAL_BYTES_MAX / 1024 / 1024).toFixed(0)}MB limit`,
		);
	}

	let bytes: Uint8Array;
	let mediaType: string;
	let dimensions: ImageDimensions | undefined;
	let kind: "image" | "file";

	if (asImage) {
		// Fail-closed: declared type must be supported AND match the magic bytes, and
		// the dimensions must parse. Rejecting here is what keeps a disguised file
		// from later being served back to other room members as an image.
		validateUploadedImage(file);
		const processed = await processImageUpload(file);
		bytes = processed.bytes;
		mediaType = processed.detectedMediaType;
		dimensions = processed.dimensions;
		kind = "image";
	} else {
		// No extension gate: `isTextFile` returns true for everything on purpose (see
		// the module header), so calling it here would be a check that never fails and
		// would misleadingly suggest an allowlist is being enforced.
		if (file.size > MAX_TEXT_FILE_SIZE) {
			throw new ValidationError(
				`Attachment too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Max: ${(
					MAX_TEXT_FILE_SIZE / 1024 / 1024
				).toFixed(0)}MB`,
			);
		}
		bytes = new Uint8Array(await file.arrayBuffer());
		mediaType = fileMediaType(file);
		kind = "file";
	}

	mkdirSync(dir, { recursive: true });
	ensureUploadDirWritable(dir);

	// The stored name is generated, never derived from the upload's filename: the
	// original name is displayed from the DB row, so nothing on disk has to carry
	// user-controlled text. Collisions are impossible by construction, which is why
	// there is no existence check here.
	const ext = asImage ? (MIME_TO_EXT[mediaType] ?? ".bin") : extname(file.name).slice(0, 16) || "";
	const storedName = `${generateShortId()}${ext}`;
	const filePath = resolve(dir, storedName);
	if (!isWithinDir(dir, filePath)) throw new ValidationError("Invalid attachment name");

	try {
		await Bun.write(filePath, bytes);
	} catch (error) {
		rmSync(filePath, { force: true });
		throw toUploadPermissionError(error, filePath);
	}

	logger.info("Chat attachment saved", { roomId, kind, storedName, size: file.size });

	return {
		kind,
		filename: file.name,
		mediaType,
		sizeBytes: file.size,
		...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
		storedName,
		filePath,
	};
}

/** Absolute path of a stored attachment, or null when it is not on disk. */
export function getChatAttachmentPath(roomId: string, storedName: string): string | null {
	let dir: string;
	try {
		dir = resolveRoomDir(roomId);
	} catch {
		return null;
	}
	// `storedName` comes from the DB, but a traversal check here is cheap and keeps a
	// corrupted row from reaching outside the room directory.
	const filePath = resolve(dir, storedName);
	if (!isWithinDir(dir, filePath)) return null;
	if (!existsSync(filePath)) return null;
	try {
		if (!statSync(filePath).isFile()) return null;
	} catch {
		return null;
	}
	return filePath;
}

export interface ChatAttachmentFileInfo {
	filePath: string;
	size: number;
}

/** Path + size of a stored attachment, or null when unreadable. */
export function getChatAttachmentFileInfo(
	roomId: string,
	storedName: string,
): ChatAttachmentFileInfo | null {
	const filePath = getChatAttachmentPath(roomId, storedName);
	if (!filePath) return null;
	try {
		return { filePath, size: statSync(filePath).size };
	} catch {
		return null;
	}
}

/** Best-effort removal of stored attachment files. */
export function deleteChatAttachmentFiles(
	entries: Iterable<{ roomId: string; storedName: string }>,
): void {
	for (const entry of entries) {
		const filePath = getChatAttachmentPath(entry.roomId, entry.storedName);
		if (filePath) rmSync(filePath, { force: true });
	}
}

/** Remove a whole room's attachment directory (room deleted). */
export function deleteChatRoomAttachments(roomId: string): void {
	let dir: string;
	try {
		dir = resolveRoomDir(roomId);
	} catch {
		return;
	}
	if (existsSync(dir)) {
		rmSync(dir, { recursive: true, force: true });
		logger.info("Chat room attachments cleaned up", { roomId });
	}
}

/** Stored names present on disk for a room (cleanup reconciliation). */
export function listStoredChatAttachmentNames(roomId: string): string[] {
	let dir: string;
	try {
		dir = resolveRoomDir(roomId);
	} catch {
		return [];
	}
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

/**
 * Copy a stored chat attachment into a narrator's worktree attachment directory.
 *
 * Streams through `Bun.write(path, BunFile)` rather than reading the payload into a
 * JS buffer, so a large attachment does not land on the heap. The destination name
 * is allocated by `allocateWorktreeAttachmentPath`, the same helper narrator
 * uploads use, so a name already present in `.narrafork/attached/` is suffixed
 * rather than overwritten — forwarding a `README.md` must not clobber the one the
 * narrator was already given.
 *
 * Returns a `TextFileRef` because that is what `buildAttachedFilesHint` consumes:
 * the forward text names paths for the model's Read tool, and images are read the
 * same way (Read handles image files), which is why an image needs no separate path
 * here.
 */
export async function copyChatAttachmentToWorktree(
	cwd: string,
	source: { roomId: string; storedName: string; filename: string; sizeBytes: number },
): Promise<TextFileRef> {
	const sourcePath = getChatAttachmentPath(source.roomId, source.storedName);
	if (!sourcePath) {
		throw new ValidationError(`Attachment file not found: ${source.filename}`);
	}
	const filePath = allocateWorktreeAttachmentPath(cwd, source.filename);
	try {
		await Bun.write(filePath, Bun.file(sourcePath));
	} catch (error) {
		rmSync(filePath, { force: true });
		throw toUploadPermissionError(error, filePath);
	}
	return { filename: source.filename, filePath, size: source.sizeBytes };
}
