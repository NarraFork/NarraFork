import { isAbsolute } from "node:path";
import { modelTextFromContentBlocks } from "@shared/native-injection";
import {
	buildAttachedFilesHint,
	buildLegacyAttachedFilesHint,
	type FileAttachmentLocation,
	type ImageAttachmentLocation,
} from "../attached-files";
import { ensureLegacyFileWorktreeCopy } from "../legacy-file-attachments";
import { logger } from "../logger";
import {
	ensureImageWorktreeCopy,
	type ImageRef,
	type ImageWorktreeCopyBudget,
	type TextFileRef,
} from "../uploads";
import { getFileReferenceSnapshots, projectFileReferenceText } from "./file-reference-projection";
import type { DbMessage } from "./provider";
import { findCurrentSenderMessage, projectMessageSenderText } from "./sender-projection";

// History preparation is not an unbounded file migration. Deferred images can be
// retried on the next build; a missing copy must never acquire a fabricated path.
const MAX_HISTORY_ATTACHMENT_COPIES = 100;
const MAX_HISTORY_ATTACHMENT_BYTES = 128 * 1024 * 1024;
const COPY_PREPARATION_BUDGET_MS = 10_000;
const projectedAttachment = Symbol("projectedAttachment");
type AttachmentMessage = DbMessage & {
	[projectedAttachment]?: { cwd: string; original: DbMessage };
};

type PersistedFileAttachment = TextFileRef & { fileId?: string };

function textFilesFromBlocks(blocks: Array<Record<string, unknown>>): PersistedFileAttachment[] {
	return blocks.flatMap((block) =>
		block?.type === "text_file" &&
		typeof block.filePath === "string" &&
		typeof block.filename === "string" &&
		typeof block.size === "number" &&
		Number.isFinite(block.size) &&
		block.size >= 0
			? [
					{
						filename: block.filename,
						filePath: block.filePath,
						size: block.size,
						...(typeof block.fileId === "string" ? { fileId: block.fileId } : {}),
					},
				]
			: [],
	);
}

/** Immutable model-only preparation; upload identities and saved message rows stay intact. */
export async function projectAttachmentLocations<T extends DbMessage>(
	messages: readonly T[],
	options: { cwd: string; narratorId: string; currentInput?: string; signal?: AbortSignal },
): Promise<{ messages: T[]; currentInput?: string }> {
	options.signal?.throwIfAborted();
	const budget: ImageWorktreeCopyBudget = {
		remainingCopies: MAX_HISTORY_ATTACHMENT_COPIES,
		remainingBytes: MAX_HISTORY_ATTACHMENT_BYTES,
		deadlineAt: Date.now() + COPY_PREPARATION_BUDGET_MS,
	};
	const copies = new Map<string, Promise<TextFileRef | null>>();
	const current = findCurrentSenderMessage(messages);
	let currentInput = options.currentInput;
	const output = new Array<T>(messages.length);
	// Prepare the newest/current attachments first without reordering history.
	// Existing copies do not consume migration budget, so older deferred images
	// make progress across subsequent builds instead of being permanently skipped.
	for (let index = messages.length - 1; index >= 0; index--) {
		const input = messages[index];
		options.signal?.throwIfAborted();
		const prior = (input as AttachmentMessage)[projectedAttachment];
		const message = (prior?.original ?? input) as T;
		if (message.role !== "user" || !Array.isArray(message.contentJson)) {
			output[index] = input;
			continue;
		}
		const blocks = message.contentJson as Array<Record<string, unknown>>;
		const imageBlocks = blocks.filter(
			(block) => block?.type === "image" && typeof block.imageId === "string",
		);
		const sourceFiles = textFilesFromBlocks(blocks);
		if (!imageBlocks.length && !sourceFiles.length) {
			output[index] = input;
			continue;
		}
		const images: ImageAttachmentLocation[] = [];
		for (const block of imageBlocks) {
			const image: ImageRef = {
				imageId: block.imageId as string,
				filename: typeof block.filename === "string" ? block.filename : (block.imageId as string),
				mediaType: typeof block.mediaType === "string" ? block.mediaType : "image/png",
				...(typeof block.uploadNarratorId === "string"
					? { uploadNarratorId: block.uploadNarratorId }
					: {}),
			};
			const owner = image.uploadNarratorId ?? message.narratorId ?? options.narratorId;
			const key = JSON.stringify([owner, image.imageId]);
			let copy = copies.get(key);
			if (!copy) {
				copy = ensureImageWorktreeCopy(options.cwd, image, owner, options.signal, budget).catch(
					(error) => {
						options.signal?.throwIfAborted();
						logger.warn("Image worktree copy unavailable", {
							messageId: message.id,
							imageId: image.imageId,
							error: String(error),
						});
						return null;
					},
				);
				copies.set(key, copy);
			}
			const file = copy ? await copy : null;
			images.push({ filename: image.filename, imageId: image.imageId, ...(file ? { file } : {}) });
		}
		const files: FileAttachmentLocation[] = [];
		for (const source of sourceFiles) {
			if (isAbsolute(source.filePath)) {
				files.push(source);
				continue;
			}
			const key = JSON.stringify(["legacy-file", source.filePath]);
			let copy = copies.get(key);
			if (!copy) {
				copy = ensureLegacyFileWorktreeCopy(options.cwd, source, options.signal, budget).catch(
					(error) => {
						options.signal?.throwIfAborted();
						logger.warn("Legacy file worktree copy unavailable", {
							messageId: message.id,
							error: String(error),
						});
						return null;
					},
				);
				copies.set(key, copy);
			}
			const file = await copy;
			files.push(
				file
					? { ...file, filename: source.filename }
					: { filename: source.filename, size: source.size },
			);
		}
		const authored = blocks
			.filter((block) => block?.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string);
		let base = authored.length ? authored.join("\n") : (message.contentText ?? "");
		if (!authored.length) {
			for (const hint of [
				buildLegacyAttachedFilesHint(sourceFiles),
				buildAttachedFilesHint(sourceFiles),
			]) {
				if (hint && base.endsWith(hint)) base = base.slice(0, -hint.length);
			}
		}
		const text = base + buildAttachedFilesHint(files, images);
		let writtenText = false;
		const contentJson = blocks.flatMap((block) => {
			if (block?.type !== "text") return [block];
			if (writtenText) return [];
			writtenText = true;
			return [{ ...block, text }];
		});
		if (!writtenText) contentJson.push({ type: "text", text });
		const projected = {
			...message,
			contentText: text,
			contentJson,
			[projectedAttachment]: { cwd: options.cwd, original: message },
		} as T;
		output[index] = projected;
		if (input === current && currentInput !== undefined) {
			const snapshots = getFileReferenceSnapshots(blocks);
			const bodies = [
				message.contentText ?? "",
				modelTextFromContentBlocks(blocks),
				...(prior
					? [
							input.contentText ?? "",
							modelTextFromContentBlocks(Array.isArray(input.contentJson) ? input.contentJson : []),
						]
					: []),
			].map((body) => projectFileReferenceText(body, snapshots));
			const projectedText = projectFileReferenceText(text, snapshots);
			if (bodies.includes(currentInput)) currentInput = projectedText;
			else if (bodies.some((body) => projectMessageSenderText(message, body) === currentInput))
				currentInput = projectMessageSenderText(projected, projectedText);
		}
	}
	options.signal?.throwIfAborted();
	const durationMs = Date.now() - (budget.deadlineAt - COPY_PREPARATION_BUDGET_MS);
	if (durationMs > 1000) {
		logger.warn("Slow model attachment preparation", {
			narratorId: options.narratorId,
			durationMs,
			distinctAttachments: copies.size,
			newCopies: MAX_HISTORY_ATTACHMENT_COPIES - budget.remainingCopies,
			copiedBytes: MAX_HISTORY_ATTACHMENT_BYTES - budget.remainingBytes,
		});
	}
	return { messages: output, currentInput };
}
