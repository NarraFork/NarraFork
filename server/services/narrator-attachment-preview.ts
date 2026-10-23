import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { narratorMessageRefs, narratorMessages, narrators, users } from "../db/schema";
import { AppError, NotFoundError } from "../lib/errors";
import { statWorkspaceFile } from "../lib/plan-file-path";
import { assertNarratorAccess, NARRATOR_ACL_COLUMNS } from "./narrator-acl";
import { narratorDeviceWorkspaceService } from "./narrator-device-workspace-service";
import { textAttachmentRef } from "./narrator-text-attachments";
import {
	assertNarratorCapturedReferenceAuthority,
	assertNarratorOriginalWorkspaceAuthority,
	createNarratorWorkspaceAttachmentSourceAccess,
} from "./workspace-artifact-access";

export const MAX_ATTACHMENT_PREVIEW_BYTES = 1024 * 1024;
const TIMEOUT_MS = 5_000;
const unavailable = () =>
	new AppError(
		"Original attachment provenance is unavailable",
		409,
		"ATTACHMENT_SOURCE_UNAVAILABLE",
	);

/** Bounded, source-only read. The route invokes the returned fence without any further await. */
export async function previewNarratorAttachment(
	narratorId: string,
	userId: string,
	messageId: string,
	attachmentId: string,
	callerSignal?: AbortSignal,
) {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new AppError("Attachment preview timed out", 504, "ATTACHMENT_TIMEOUT")),
		TIMEOUT_MS,
	);
	const signal = callerSignal
		? AbortSignal.any([callerSignal, controller.signal])
		: controller.signal;
	async function wait<T>(operation: () => Promise<T>): Promise<T> {
		signal.throwIfAborted();
		let abort: () => void = () => {};
		try {
			return await Promise.race([
				operation(),
				new Promise<never>((_, reject) => {
					abort = () => reject(signal.reason);
					signal.addEventListener("abort", abort, { once: true });
					if (signal.aborted) abort();
				}),
			]);
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}
	try {
		if (
			![narratorId, userId, messageId, attachmentId].every(
				(value) => typeof value === "string" && value.length > 0 && value.length <= 128,
			)
		)
			throw new AppError("Invalid attachment selector", 400, "VALIDATION_ERROR");
		const authorizeReader = async () => {
			const actor = await db.query.users.findFirst({
				where: eq(users.id, userId),
				columns: { role: true },
			});
			const narrator = await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: NARRATOR_ACL_COLUMNS,
			});
			if (!actor || !narrator) throw new NotFoundError("Narrator", narratorId);
			await assertNarratorAccess(narrator, { userId, isAdmin: actor.role === "admin" }, "read");
		};
		await wait(authorizeReader);
		const assertRelation = () => {
			if (
				!db
					.select({ id: narratorMessageRefs.id })
					.from(narratorMessageRefs)
					.where(
						and(
							eq(narratorMessageRefs.narratorId, narratorId),
							eq(narratorMessageRefs.messageId, messageId),
						),
					)
					.limit(1)
					.get()
			)
				throw new NotFoundError("Attachment", attachmentId);
		};
		assertRelation();
		const summary = db
			.select({
				role: narratorMessages.role,
				length: sql<number>`length(cast(${narratorMessages.contentJson} as text))`,
			})
			.from(narratorMessages)
			.where(eq(narratorMessages.id, messageId))
			.get();
		if (!summary || summary.role !== "user") throw new NotFoundError("Attachment", attachmentId);
		// Gate before decoding contentJson: max 256K codepoints (at most 1 MiB UTF-8).
		if (!Number.isSafeInteger(summary.length) || summary.length > 256 * 1024) throw unavailable();
		const row = await wait(() =>
			db.query.narratorMessages.findFirst({
				where: and(
					eq(narratorMessages.id, messageId),
					sql`length(cast(${narratorMessages.contentJson} as text)) <= ${256 * 1024}`,
				),
				columns: { contentJson: true },
			}),
		);
		if (!Array.isArray(row?.contentJson) || row.contentJson.length > 256) throw unavailable();
		const matches = row.contentJson
			.map(textAttachmentRef)
			.filter((ref) => ref?.attachmentId === attachmentId);
		if (matches.length !== 1 || !matches[0]) throw new NotFoundError("Attachment", attachmentId);
		const ref = matches[0];
		const workspace = ref.attachmentWorkspace;
		const origin = ref.attachmentOrigin;
		if (
			!workspace ||
			!origin ||
			!ref.sourceNarratorId ||
			ref.sourceNarratorId.length > 128 ||
			ref.attachmentUnavailableReason ||
			!ref.deviceId ||
			ref.deviceId.length > 128 ||
			workspace.deviceId !== ref.deviceId ||
			!ref.contextKey ||
			ref.contextKey.length > 4096 ||
			workspace.contextKey !== ref.contextKey ||
			!workspace.cwd ||
			workspace.cwd.length > 4096 ||
			!ref.filePath ||
			ref.filePath.length > 4096 ||
			(workspace.contextProjectId !== undefined && workspace.contextProjectId !== origin.projectId)
		)
			throw unavailable();
		const source = {
			narratorId: ref.sourceNarratorId,
			deviceId: ref.deviceId,
			projectId: origin.projectId,
			canonicalPath: ref.filePath,
			cwd: workspace.cwd,
			version: 1 as const,
		};
		// This proof snapshots Read traits, policy and OAuth/ACL dependencies synchronously;
		// it does not read a snapshot or substitute a current workspace.
		const readProof = await wait(() =>
			assertNarratorCapturedReferenceAuthority(source, userId, signal),
		);
		const requestProof = await wait(() =>
			narratorDeviceWorkspaceService.assertOriginalEndpointDeviceCurrent(
				narratorId,
				ref.deviceId as string,
				{ userId, originalProjectId: origin.projectId },
			),
		);
		const access = createNarratorWorkspaceAttachmentSourceAccess(
			ref.sourceNarratorId,
			workspace,
			ref.filePath,
			{ userId, signal, originalProjectId: origin.projectId, authorizationGuard: authorizeReader },
		);
		const info = await wait(() => statWorkspaceFile(access, ref.filePath));
		if (!info?.isFile) throw new NotFoundError("Attachment", attachmentId);
		if (
			!Number.isSafeInteger(info.size) ||
			info.size < 0 ||
			info.size > MAX_ATTACHMENT_PREVIEW_BYTES
		)
			throw new AppError("Attachment preview exceeds 1 MiB", 413, "ATTACHMENT_TOO_LARGE");
		const result = await wait(() =>
			access.backend.readFileBytes(ref.filePath, {
				maxBytes: MAX_ATTACHMENT_PREVIEW_BYTES,
				expectedResolvedPath: info.resolvedPath,
				signal,
				timeoutMs: TIMEOUT_MS,
			}),
		);
		if (result.truncated || result.bytes.byteLength > MAX_ATTACHMENT_PREVIEW_BYTES)
			throw new AppError("Attachment preview exceeds 1 MiB", 413, "ATTACHMENT_TOO_LARGE");
		if (!Number.isSafeInteger(result.totalSize) || result.totalSize !== result.bytes.byteLength)
			throw new AppError(
				"Complete attachment bytes are unavailable",
				409,
				"ATTACHMENT_READ_INCOMPLETE",
			);
		if (result.resolvedPath && !access.backend.paths.equals(result.resolvedPath, ref.filePath))
			throw unavailable();
		if (result.bytes.includes(0))
			throw new AppError(
				"Binary attachment text preview is unsupported",
				415,
				"ATTACHMENT_BINARY_UNSUPPORTED",
			);
		try {
			new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
		} catch {
			throw new AppError("Attachment is not UTF-8 text", 415, "ATTACHMENT_BINARY_UNSUPPORTED");
		}
		const sourceProof = await wait(() =>
			assertNarratorOriginalWorkspaceAuthority(ref.sourceNarratorId as string, workspace, {
				userId,
				signal,
				originalProjectId: origin.projectId,
				canonicalPath: ref.filePath,
			}),
		);
		await wait(authorizeReader);
		const assertStillCurrent = () => {
			signal.throwIfAborted();
			readProof.assertStillCurrent();
			sourceProof.assertStillCurrent();
			requestProof.assertStillCurrent();
			assertRelation();
		};
		assertStillCurrent();
		return {
			bytes: new Uint8Array(result.bytes),
			size: result.bytes.byteLength,
			truncated: false as const,
			contentType: "text/plain; charset=utf-8",
			assertStillCurrent,
		};
	} finally {
		clearTimeout(timer);
	}
}
