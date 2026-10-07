import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { MAX_TEXT_FILE_SIZE } from "@shared/text-file-types";
import { ValidationError } from "./errors";
import { generateShortId } from "./id";
import {
	getUploadsDir,
	type ImageWorktreeCopyBudget,
	isWithinDir,
	type TextFileRef,
} from "./uploads";

function missingFile(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function checkDirectory(root: string, path: string): Promise<void> {
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink() || !isWithinDir(root, await realpath(path))) {
		throw new ValidationError("Unsafe legacy attachment directory");
	}
}

async function attachmentDirectory(root: string): Promise<string> {
	let path = root;
	for (const part of [".narrafork", "attached"]) {
		path = resolve(path, part);
		try {
			await mkdir(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
		}
		await checkDirectory(root, path);
	}
	return path;
}

async function checkedFileSize(root: string, path: string): Promise<number | null> {
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink() || !isWithinDir(root, await realpath(path))) {
			throw new ValidationError("Unsafe legacy attachment file");
		}
		if (info.size > MAX_TEXT_FILE_SIZE) throw new ValidationError("Legacy attachment too large");
		return info.size;
	} catch (error) {
		if (missingFile(error)) return null;
		throw error;
	}
}

/**
 * Copy a canonical legacy uploads-relative reference into the active worktree.
 * Existing copies retain user edits. Copies use a 64 KiB buffer and a 100 MiB cap.
 * Cancellation and the 10 second deadline are cooperative between filesystem calls;
 * portable Node APIs cannot stop an in-flight call or hostile directory rename races.
 */
export async function ensureLegacyFileWorktreeCopy(
	cwd: string,
	file: TextFileRef & { fileId?: string },
	signal?: AbortSignal,
	budget?: ImageWorktreeCopyBudget,
): Promise<TextFileRef | null> {
	const deadline = performance.now() + 10_000;
	let copying = false;
	const checkBudget = () => {
		signal?.throwIfAborted();
		if (performance.now() > deadline || (copying && budget && Date.now() >= budget.deadlineAt)) {
			throw new ValidationError("Legacy attachment copy timed out");
		}
	};
	checkBudget();
	// Match exactly, without normalizing away traversal or accepting absolute paths.
	const canonical =
		/^([A-Za-z0-9_-]{1,100})\/text\/([A-Za-z0-9_-]{1,100})\.([A-Za-z0-9]{1,16})$/.exec(
			file.filePath,
		);
	if (
		!canonical ||
		canonical[0] !== file.filePath ||
		!file.fileId ||
		canonical[2] !== file.fileId
	) {
		throw new ValidationError("Invalid canonical legacy attachment reference");
	}
	const [, owner, , extension] = canonical;
	const root = await realpath(cwd);
	checkBudget();
	const directory = await attachmentDirectory(root);
	checkBudget();
	const key = createHash("sha256").update(file.filePath).digest("hex");
	const filePath = resolve(directory, `legacy-${key}.${extension}`);
	const existingSize = await checkedFileSize(root, filePath);
	checkBudget();
	if (existingSize !== null) return { filename: file.filename, filePath, size: existingSize };
	if (budget && (budget.remainingCopies <= 0 || Date.now() >= budget.deadlineAt)) return null;
	copying = true;

	const uploadsRoot = resolve(getUploadsDir());
	const sourcePath = resolve(uploadsRoot, file.filePath);
	try {
		await checkDirectory(uploadsRoot, uploadsRoot);
		await checkDirectory(uploadsRoot, resolve(uploadsRoot, owner));
		await checkDirectory(uploadsRoot, resolve(uploadsRoot, owner, "text"));
		if ((await checkedFileSize(uploadsRoot, sourcePath)) === null) return null;
	} catch (error) {
		if (missingFile(error)) return null;
		throw error;
	}
	checkBudget();
	const source = await open(
		sourcePath,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	).catch((error) => {
		if (missingFile(error)) return null;
		throw error;
	});
	if (!source) return null;
	let temporaryPath: string | undefined;
	try {
		checkBudget();
		const info = await source.stat();
		if (!info.isFile() || info.size > MAX_TEXT_FILE_SIZE) {
			throw new ValidationError("Legacy attachment too large or not a regular file");
		}
		if (budget && info.size > budget.remainingBytes) return null;
		const maxBytes = Math.min(MAX_TEXT_FILE_SIZE, budget?.remainingBytes ?? MAX_TEXT_FILE_SIZE);
		await attachmentDirectory(root);
		checkBudget();
		const allocatedPath = resolve(directory, `.legacy-${generateShortId()}.tmp`);
		const target = await open(
			allocatedPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		temporaryPath = allocatedPath;
		let copied = 0;
		try {
			const buffer = Buffer.alloc(64 * 1024);
			while (true) {
				checkBudget();
				const { bytesRead } = await source.read(buffer, 0, buffer.length, copied);
				checkBudget();
				if (bytesRead === 0) break;
				if (copied + bytesRead > maxBytes) {
					throw new ValidationError("Legacy attachment too large");
				}
				let written = 0;
				while (written < bytesRead) {
					checkBudget();
					const { bytesWritten } = await target.write(
						buffer,
						written,
						bytesRead - written,
						copied + written,
					);
					checkBudget();
					if (bytesWritten === 0) throw new ValidationError("Legacy attachment write stalled");
					written += bytesWritten;
				}
				copied += bytesRead;
			}
		} finally {
			await target.close();
		}
		await attachmentDirectory(root);
		checkBudget();
		try {
			await link(temporaryPath, filePath);
			if (budget) {
				budget.remainingCopies--;
				budget.remainingBytes -= copied;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
		}
		const size = await checkedFileSize(root, filePath);
		if (size === null) throw new ValidationError("Legacy attachment disappeared");
		return { filename: file.filename, filePath, size };
	} finally {
		try {
			await source.close();
		} finally {
			if (temporaryPath) await unlink(temporaryPath).catch(() => {});
		}
	}
}
