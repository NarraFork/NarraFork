import { createHash } from "node:crypto";
import type { ComposerDocument } from "@shared/composer-document";
import { COMMUNICATION_LIMITS } from "@shared/narrator-communication";
import { AppError, ValidationError } from "../../lib/errors";
import { MAILBOX_LIMITS } from "./limits";

export const USER_SUBMISSION_WINDOW_MS = MAILBOX_LIMITS.userDedupeTtlMs;

export interface SubmissionAttachment {
	channel: "images" | "media" | "textFiles";
	name: string;
	size: number;
	type: string;
	digest: string;
	/** Only a lookup coordinate for an immutable consumed stage; never hashed as content. */
	uploadId?: string;
}

export interface UserSubmission {
	clientSubmissionId: string;
	attachments?: SubmissionAttachment[];
	/** Hash of the original request, before file snapshots or generated upload IDs. */
	fingerprint: string;
}

export function submissionRequestKey(userId: string, clientSubmissionId: string): string {
	if (!/^[A-Za-z0-9_-]{1,128}$/u.test(clientSubmissionId))
		throw new ValidationError("Invalid client submission ID");
	return createHash("sha256")
		.update(JSON.stringify([userId, clientSubmissionId]))
		.digest("hex");
}

export function submissionFingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Only typed atoms in this new submission can request peer creation. */
export function communicationReferenceTargets(document?: ComposerDocument): string[] {
	const targets = new Set<string>();
	for (const paragraph of document?.paragraphs ?? []) {
		for (const node of paragraph.children) {
			if (node.type === "narratorReference") targets.add(node.narratorId);
			if (targets.size > COMMUNICATION_LIMITS.maxReferences)
				throw new ValidationError("Too many narrator references");
		}
	}
	return [...targets];
}

export function assertUserSubmissionReplay(
	row: { metadataJson: string | null; dedupeExpiresAt: string | null },
	submission: UserSubmission,
): void {
	if (row.dedupeExpiresAt && Date.parse(row.dedupeExpiresAt) <= Date.now())
		throw new AppError(
			"Submission receipt expired; explicitly send again with a new ID",
			410,
			"SUBMISSION_EXPIRED",
		);
	const metadata = JSON.parse(row.metadataJson ?? "{}") as { submissionFingerprint?: string };
	if (metadata.submissionFingerprint !== submission.fingerprint)
		throw new AppError(
			"Client submission ID was already used for different content",
			409,
			"SUBMISSION_CONFLICT",
		);
}
