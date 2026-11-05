/** Stream unclaimed attachments outside the worktree until a message claims them. */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir, open, opendir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	MAX_PENDING_STAGED_ATTACHMENTS,
	MAX_STAGED_ATTACHMENTS_TOTAL_BYTES,
	MAX_TEXT_FILE_SIZE,
} from "@shared/text-file-types";
import { AppError, ValidationError } from "./errors";
import { generateShortId } from "./id";
import { logger } from "./logger";
import { getNarraforkPath } from "./narrafork-home";

// Kept local to avoid a dependency cycle with uploads.ts.
export function isWithinStagingRoot(
	root: string,
	target: string,
	paths = { relative, isAbsolute, sep },
): boolean {
	const path = paths.relative(root, target);
	return path !== ".." && !path.startsWith(`..${paths.sep}`) && !paths.isAbsolute(path);
}

export const STAGED_ATTACHMENT_TTL_MS = 6 * 60 * 60 * 1000;
/** Total transfer deadline; permits a 1 GiB upload over a roughly 5 Mbit/s link. */
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_FILENAME_CHARS = 255;
const STAGED_DATA_SUFFIX = ".upload";
const STAGED_META_SUFFIX = ".json";
const MAX_SIDECAR_BYTES = 8 * 1024;

let stagingRootTestOverride: string | null = null;
let perFileCeilingTestOverride: number | null = null;
let limitsTestOverride: { count?: number; bytes?: number; timeoutMs?: number } = {};
// Active bytes are reserved before writing and excluded from the disk count.
const activeUploads = new Map<string, Map<string, number>>();

export function setStagedAttachmentsDirForTests(dir?: string | null): void {
	stagingRootTestOverride = dir ? resolve(dir) : null;
}

export function setStagedAttachmentCeilingForTests(bytes?: number | null): void {
	perFileCeilingTestOverride = bytes ?? null;
}

export function setStagedAttachmentLimitsForTests(limits: typeof limitsTestOverride = {}): void {
	limitsTestOverride = limits;
}

function maxStagedAttachmentBytes(): number {
	return perFileCeilingTestOverride ?? MAX_TEXT_FILE_SIZE;
}

/**
 * The two refusals a user can act on carry their own 413 codes, so the composer
 * can say "this file is over 1 GiB" or "send or remove pending attachments"
 * instead of a generic upload failure. Malformed requests stay ValidationError.
 */
function attachmentTooLarge(): AppError {
	return new AppError(
		`Attachment exceeds the ${formatLimit(maxStagedAttachmentBytes())} limit`,
		413,
		"ATTACHMENT_TOO_LARGE",
	);
}

function stagingFull(message: string): AppError {
	return new AppError(message, 413, "ATTACHMENT_STAGING_FULL");
}

export function getStagedAttachmentsDir(): string {
	return stagingRootTestOverride ?? getNarraforkPath("attachment-staging");
}

export interface StagedAttachment {
	narratorId: string;
	uploadId: string;
	filename: string;
	mediaType: string;
	size: number;
	path: string;
	createdAtMs: number;
}

const stagedByFile = new WeakMap<File, StagedAttachment>();

function narratorDir(narratorId: string): string {
	const root = getStagedAttachmentsDir();
	const dir = resolve(root, narratorId);
	if (!isWithinStagingRoot(root, dir) || dir === resolve(root)) {
		throw new ValidationError("Invalid narrator ID");
	}
	return dir;
}

function isSafeUploadId(uploadId: string): boolean {
	return /^[A-Za-z0-9_-]{1,64}$/.test(uploadId);
}

function dataPath(narratorId: string, uploadId: string): string {
	return join(narratorDir(narratorId), `${uploadId}${STAGED_DATA_SUFFIX}`);
}

function metaPath(narratorId: string, uploadId: string): string {
	return join(narratorDir(narratorId), `${uploadId}${STAGED_META_SUFFIX}`);
}

function sanitizeMediaType(raw: string | null | undefined): string {
	const value = (raw ?? "").trim().toLowerCase();
	if (!value || value.length > 128) return "application/octet-stream";
	if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value)) {
		return "application/octet-stream";
	}
	return value;
}

export function sanitizeAttachmentFilename(raw: string | null | undefined): string {
	const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters
	const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	if (!cleaned || cleaned === "." || cleaned === "..") return "attachment";
	return cleaned.slice(0, MAX_FILENAME_CHARS);
}

/** Includes in-flight reservations without counting their partial files twice. */
export function pendingStagedUploads(narratorId: string): { count: number; bytes: number } {
	const active = activeUploads.get(narratorId);
	let count = active?.size ?? 0;
	let bytes = 0;
	for (const size of active?.values() ?? []) bytes += size;
	try {
		const dir = narratorDir(narratorId);
		for (const entry of readdirSync(dir)) {
			if (!entry.endsWith(STAGED_DATA_SUFFIX)) continue;
			if (active?.has(entry.slice(0, -STAGED_DATA_SUFFIX.length))) continue;
			try {
				const info = statSync(join(dir, entry));
				if (!info.isFile()) continue;
				count++;
				bytes += info.size;
			} catch {
				// Concurrent discard.
			}
		}
	} catch {
		// No staging directory yet.
	}
	return { count, bytes };
}

export interface StageAttachmentOptions {
	narratorId: string;
	filename: string | null | undefined;
	mediaType?: string | null;
	declaredLength?: number;
	signal?: AbortSignal;
}

export async function stageAttachment(
	body: ReadableStream<Uint8Array> | null,
	options: StageAttachmentOptions,
): Promise<StagedAttachment> {
	const { narratorId, declaredLength } = options;
	if (!body) throw new ValidationError("Attachment body is required");
	const filename = sanitizeAttachmentFilename(options.filename);
	const mediaType = sanitizeMediaType(options.mediaType);
	if (declaredLength !== undefined) {
		if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
			throw new ValidationError("Invalid attachment Content-Length");
		}
		if (declaredLength > maxStagedAttachmentBytes()) throw attachmentTooLarge();
	}

	const dir = narratorDir(narratorId);
	const pending = pendingStagedUploads(narratorId);
	const maxCount = limitsTestOverride.count ?? MAX_PENDING_STAGED_ATTACHMENTS;
	const maxBytes = limitsTestOverride.bytes ?? MAX_STAGED_ATTACHMENTS_TOTAL_BYTES;
	if (pending.count >= maxCount) {
		throw stagingFull(
			`Too many pending attachments (max ${maxCount}); send or discard the current ones first`,
		);
	}
	if (pending.bytes + (declaredLength ?? 0) > maxBytes) {
		throw stagingFull("Pending attachments exceed the staging byte limit");
	}
	const uploadId = generateShortId();
	const path = dataPath(narratorId, uploadId);
	const sidecar = metaPath(narratorId, uploadId);
	const active = activeUploads.get(narratorId) ?? new Map<string, number>();
	active.set(uploadId, declaredLength ?? 0);
	activeUploads.set(narratorId, active);

	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	let size = 0;
	let created = false;
	let completed = false;
	const controller = new AbortController();
	const abort = (reason: unknown) => {
		if (controller.signal.aborted) return;
		controller.abort(reason);
		void reader?.cancel(reason).catch(() => {});
	};
	const onAbort = () => abort(options.signal?.reason ?? new Error("Attachment upload aborted"));
	const timer = setTimeout(
		() => abort(new ValidationError("Attachment upload timed out")),
		limitsTestOverride.timeoutMs ?? UPLOAD_TIMEOUT_MS,
	);
	options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		reader = body.getReader();
		if (options.signal?.aborted) onAbort();
		controller.signal.throwIfAborted();
		await mkdir(dir, { recursive: true });
		handle = await open(path, "wx", 0o600);
		created = true;
		while (true) {
			controller.signal.throwIfAborted();
			const { done, value } = await reader.read();
			controller.signal.throwIfAborted();
			if (done) break;
			const nextSize = size + value.byteLength;
			if (nextSize > maxStagedAttachmentBytes()) throw attachmentTooLarge();
			const reserved = active.get(uploadId) ?? 0;
			const nextReserved = Math.max(nextSize, reserved);
			if (pendingStagedUploads(narratorId).bytes - reserved + nextReserved > maxBytes) {
				throw stagingFull("Pending attachments exceed the staging byte limit");
			}
			active.set(uploadId, nextReserved);
			await writeAll(handle, value, size);
			size = nextSize;
		}
		if (size === 0) throw new ValidationError("Attachment is empty");
		await handle.close();
		handle = undefined;
		await writeFile(sidecar, JSON.stringify({ filename, mediaType, size }), { mode: 0o600 });
		controller.signal.throwIfAborted();
		completed = true;
		logger.info("Attachment staged", { narratorId, uploadId, size, filename });
		return { narratorId, uploadId, filename, mediaType, size, path, createdAtMs: Date.now() };
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
		if (!completed) void reader?.cancel().catch(() => {});
		reader?.releaseLock();
		try {
			await handle?.close();
		} finally {
			try {
				if (created && !completed)
					await Promise.all([rm(path, { force: true }), rm(sidecar, { force: true })]);
			} finally {
				active.delete(uploadId);
				if (active.size === 0) activeUploads.delete(narratorId);
			}
		}
	}
}

function formatLimit(bytes: number): string {
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(bytes >= 1024 * 1024 * 1024 ? 0 : 1)} GiB`;
}

async function writeAll(
	handle: Awaited<ReturnType<typeof open>>,
	chunk: Uint8Array,
	offset: number,
): Promise<void> {
	let written = 0;
	while (written < chunk.byteLength) {
		const { bytesWritten } = await handle.write(
			chunk,
			written,
			chunk.byteLength - written,
			offset + written,
		);
		if (bytesWritten <= 0) throw new Error("Attachment write made no progress");
		written += bytesWritten;
	}
}

export function findStagedAttachment(
	narratorId: string,
	uploadId: string,
): StagedAttachment | null {
	if (!isSafeUploadId(uploadId)) return null;
	let path: string;
	let sidecar: string;
	try {
		path = dataPath(narratorId, uploadId);
		sidecar = metaPath(narratorId, uploadId);
	} catch {
		return null;
	}
	if (!existsSync(path)) return null;
	try {
		const info = statSync(path);
		if (!info.isFile() || info.size === 0) return null;
		let filename = basename(path);
		let mediaType = "application/octet-stream";
		try {
			const meta = statSync(sidecar);
			if (meta.isFile() && meta.size <= MAX_SIDECAR_BYTES) {
				const parsed = JSON.parse(readFileSync(sidecar, "utf8")) as {
					filename?: unknown;
					mediaType?: unknown;
				};
				if (typeof parsed.filename === "string")
					filename = sanitizeAttachmentFilename(parsed.filename);
				if (typeof parsed.mediaType === "string") mediaType = sanitizeMediaType(parsed.mediaType);
			}
		} catch {
			// Missing metadata falls back to the opaque filename.
		}
		return {
			narratorId,
			uploadId,
			filename,
			mediaType,
			size: info.size,
			path,
			createdAtMs: info.mtimeMs,
		};
	} catch {
		return null;
	}
}

export function stagedAttachmentAsFile(staged: StagedAttachment): File {
	const file = new File([Bun.file(staged.path)], staged.filename, { type: staged.mediaType });
	stagedByFile.set(file, staged);
	return file;
}

export function releaseStagedAttachment(file: File): void {
	const staged = stagedByFile.get(file);
	if (!staged) return;
	stagedByFile.delete(file);
	discardStagedAttachment(staged.narratorId, staged.uploadId);
}

export function isStagedAttachment(file: File): boolean {
	return stagedByFile.has(file);
}

export function discardStagedAttachment(narratorId: string, uploadId: string): void {
	if (!isSafeUploadId(uploadId)) return;
	let path: string;
	let sidecar: string;
	try {
		path = dataPath(narratorId, uploadId);
		sidecar = metaPath(narratorId, uploadId);
	} catch {
		return;
	}
	rmSync(path, { force: true });
	rmSync(sidecar, { force: true });
}

/** Async directory iterators keep the sweep off the main thread and bound memory. */
export async function sweepStagedAttachments(
	now = Date.now(),
): Promise<{ removed: number; freedBytes: number }> {
	let removed = 0;
	let freedBytes = 0;
	const root = getStagedAttachmentsDir();
	const narrators = await opendir(root).catch(() => null);
	if (!narrators) return { removed, freedBytes };
	for await (const narrator of narrators) {
		if (!narrator.isDirectory()) continue;
		const dir = join(root, narrator.name);
		const entries = await opendir(dir).catch(() => null);
		if (!entries) continue;
		for await (const entry of entries) {
			if (!entry.isFile()) continue;
			const path = join(dir, entry.name);
			try {
				if (entry.name.endsWith(STAGED_DATA_SUFFIX)) {
					const uploadId = entry.name.slice(0, -STAGED_DATA_SUFFIX.length);
					if (activeUploads.get(narrator.name)?.has(uploadId)) continue;
					const info = await stat(path);
					if (now - info.mtimeMs < STAGED_ATTACHMENT_TTL_MS) continue;
					await rm(path, { force: true });
					await rm(join(dir, `${uploadId}${STAGED_META_SUFFIX}`), { force: true });
					removed++;
					freedBytes += info.size;
				} else if (entry.name.endsWith(STAGED_META_SUFFIX)) {
					const uploadId = entry.name.slice(0, -STAGED_META_SUFFIX.length);
					if (activeUploads.get(narrator.name)?.has(uploadId)) continue;
					if (!(await stat(join(dir, `${uploadId}${STAGED_DATA_SUFFIX}`)).catch(() => null))) {
						await rm(path, { force: true });
					}
				}
			} catch {
				// A concurrent discard or sweep may have removed the entry.
			}
		}
		await rmdir(dir).catch(() => {});
	}
	if (removed) logger.info("Reclaimed abandoned attachments", { removed, freedBytes });
	return { removed, freedBytes };
}
