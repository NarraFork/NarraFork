import { formatFileSize } from "@shared/text-file-types";
import type { WorkspaceContext } from "@shared/workspace-context";
import { ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";
import type { WorkspaceFileAccess } from "../lib/plan-file-path";
import {
	copyTextFileToWorktree,
	deleteWorkspaceAttachmentFiles,
	saveTextFileToWorktree,
	type TextFileRef,
	type WorkspaceAttachmentAccess,
} from "../lib/uploads";
import { isWorkspaceAttachmentProof } from "../lib/workspace-attachment-io";
import {
	createNarratorWorkspaceAttachmentAccess,
	createNarratorWorkspaceAttachmentSourceAccess,
} from "./workspace-artifact-access";
import { workspaceContextService } from "./workspace-context-service";

export interface PersistedTextAttachment extends TextFileRef {
	type: "text_file";
	fileId?: string;
}

export async function prepareNarratorTextAttachmentAccess(
	narratorId: string,
	options: {
		userId?: string | null;
		workspaceContext?: WorkspaceContext;
		signal?: AbortSignal;
		authorizationGuard?: () => Promise<void>;
	} = {},
): Promise<WorkspaceAttachmentAccess> {
	const workspace = Object.freeze(
		structuredClone(
			options.workspaceContext ??
				(await workspaceContextService.get(narratorId, { userId: options.userId })),
		),
	);
	return createNarratorWorkspaceAttachmentAccess(narratorId, workspace, {
		userId: options.userId,
		signal: options.signal ?? AbortSignal.timeout(5 * 60_000),
		authorizationGuard: options.authorizationGuard,
	});
}

export function textAttachmentKey(ref: Pick<TextFileRef, "deviceId" | "filePath">): string {
	const device = ref.deviceId ?? "local";
	return `${device.length}:${device}:${ref.filePath}`;
}

export function textAttachmentBlock(ref: TextFileRef): PersistedTextAttachment {
	return { type: "text_file", ...ref };
}

export function textAttachmentRef(value: unknown): TextFileRef | undefined {
	if (!value || typeof value !== "object") return undefined;
	const block = value as Record<string, unknown>;
	if (
		block.type !== "text_file" ||
		typeof block.filename !== "string" ||
		typeof block.filePath !== "string" ||
		typeof block.size !== "number"
	)
		return undefined;
	return {
		filename: block.filename,
		filePath: block.filePath,
		size: block.size,
		...(typeof block.deviceId === "string" ? { deviceId: block.deviceId } : {}),
		...(typeof block.contextKey === "string" ? { contextKey: block.contextKey } : {}),
		...(typeof block.attachmentId === "string" ? { attachmentId: block.attachmentId } : {}),
		...(typeof block.sourceNarratorId === "string"
			? { sourceNarratorId: block.sourceNarratorId }
			: {}),
		...(typeof block.attachmentUnavailableReason === "string"
			? { attachmentUnavailableReason: block.attachmentUnavailableReason }
			: {}),
		...(typeof block.attachmentCleanupUnavailableReason === "string"
			? { attachmentCleanupUnavailableReason: block.attachmentCleanupUnavailableReason }
			: {}),
		...(isWorkspaceAttachmentProof(block.attachmentCreationProof)
			? { attachmentCreationProof: structuredClone(block.attachmentCreationProof) }
			: {}),
		...(validSourceWorkspace(block.attachmentWorkspace)
			? { attachmentWorkspace: structuredClone(block.attachmentWorkspace) }
			: {}),
	};
}

function validSourceWorkspace(value: unknown): value is WorkspaceContext {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.deviceId === "string" &&
		typeof candidate.cwd === "string" &&
		(candidate.pathFlavor === "posix" || candidate.pathFlavor === "windows") &&
		typeof candidate.revision === "number" &&
		Number.isSafeInteger(candidate.revision) &&
		candidate.revision >= 0 &&
		typeof candidate.contextKey === "string" &&
		!!candidate.capabilities &&
		typeof candidate.capabilities === "object" &&
		typeof (candidate.capabilities as Record<string, unknown>).switchDirectory === "boolean"
	);
}

function acceptedRef(
	narratorId: string,
	ref: TextFileRef,
	access: WorkspaceAttachmentAccess,
): TextFileRef {
	return {
		...ref,
		deviceId: access.backend.deviceId,
		contextKey: access.workspaceContext.contextKey,
		attachmentWorkspace: structuredClone(access.workspaceContext),
		sourceNarratorId: narratorId,
	};
}

export async function saveAcceptedNarratorTextFiles(
	narratorId: string,
	files: readonly File[],
	access: WorkspaceAttachmentAccess,
): Promise<TextFileRef[]> {
	const saved: TextFileRef[] = [];
	try {
		for (const file of files) {
			const ref = await saveTextFileToWorktree(access.workspaceContext.cwd, file, access);
			saved.push(acceptedRef(narratorId, ref, access));
		}
		return saved;
	} catch (error) {
		await cleanupKnownNarratorTextFiles(saved, access);
		throw error;
	}
}

export async function cleanupKnownNarratorTextFiles(
	refs: readonly TextFileRef[],
	access: WorkspaceAttachmentAccess,
): Promise<void> {
	try {
		await deleteWorkspaceAttachmentFiles(refs, access);
	} catch (error) {
		logger.warn("Known attachment cleanup deferred", {
			deviceId: access.backend.deviceId,
			error: String(error),
		});
	}
}

export interface RetainedTextAttachment {
	ref: TextFileRef;
	sourceAccess?: WorkspaceFileAccess;
	copy: boolean;
}

/** Original device/root comes only from persisted provenance; unknown sources remain explicit. */
export async function prepareRetainedNarratorTextFile(
	source: TextFileRef,
	target: WorkspaceAttachmentAccess,
	options: { narratorId: string; sourceNarratorId: string; userId?: string | null },
): Promise<RetainedTextAttachment> {
	if (!Number.isSafeInteger(source.size) || source.size < 0)
		throw new ValidationError("Attached file size is unavailable");
	const deviceId = source.deviceId ?? "local";
	const insideTarget =
		deviceId === target.backend.deviceId &&
		target.backend.paths.isAbsolute(source.filePath) &&
		target.backend.paths.contains(target.workspaceContext.cwd, source.filePath);
	let original = source.attachmentWorkspace;
	if (original && (original.deviceId !== deviceId || original.contextKey !== source.contextKey)) {
		return {
			ref: {
				...source,
				attachmentUnavailableReason:
					"Original attachment binding is inconsistent; remove and reattach the file.",
			},
			copy: false,
		};
	}
	// A legacy local file already inside the admitted local workspace needs no invented root.
	if (!original && insideTarget && deviceId === "local") original = target.workspaceContext;
	if (!original) {
		return {
			ref: {
				...source,
				attachmentUnavailableReason:
					"Original attachment source is unknown; it cannot be copied to this workspace. Remove and reattach the file.",
			},
			copy: false,
		};
	}
	const sourceAccess = createNarratorWorkspaceAttachmentSourceAccess(
		source.sourceNarratorId ?? options.sourceNarratorId,
		original,
		source.filePath,
		{
			userId: options.userId,
			signal: target.signal,
		},
	);
	const identity = await sourceAccess.backend.resolvePathIdentity(source.filePath, {
		signal: target.signal,
		timeoutMs: 5_000,
	});
	if (
		(await sourceAccess.authorizeRead(
			identity.canonicalPath,
			sourceAccess.backend,
			target.signal,
		)) !== true
	)
		throw new ValidationError("Attachment source read denied");
	const info = await sourceAccess.backend.statFile(identity.canonicalPath, {
		signal: target.signal,
		timeoutMs: 5_000,
	});
	if (!info?.isFile || !Number.isSafeInteger(info.size) || info.size < 0)
		throw new ValidationError(`Attached file not found: ${source.filename}`);
	return { ref: { ...source, size: info.size }, sourceAccess, copy: !insideTarget };
}

export async function copyRetainedNarratorTextFile(
	narratorId: string,
	source: RetainedTextAttachment,
	target: WorkspaceAttachmentAccess,
): Promise<TextFileRef> {
	if (!source.copy || !source.sourceAccess)
		throw new ValidationError("Attachment has no confirmed original copy source");
	const ref = await copyTextFileToWorktree(target.workspaceContext.cwd, source.ref, {
		...target,
		sourceAccess: source.sourceAccess,
	});
	return acceptedRef(narratorId, ref, target);
}

export function buildNarratorTextAttachmentHint(files: readonly TextFileRef[]): string {
	if (files.length === 0) return "";
	const lines = files.map((file) =>
		file.attachmentUnavailableReason
			? `- ${file.filename}: ${file.attachmentUnavailableReason}`
			: `- device "${file.deviceId ?? "local"}": ${file.filePath} (${file.filename}, ${formatFileSize(file.size)})`,
	);
	return `\n\n<attached_files>\nThe user attached these device-qualified files. Use Read with the indicated device; do not reinterpret paths on the current device. Unavailable attachments must be reattached by the user.\n${lines.join("\n")}\n</attached_files>`;
}
