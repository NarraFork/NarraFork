import { AppError } from "../../lib/errors";
import type { KnowledgeDraftVersion } from "./write-store";

export function assertDraftVersion(
	current: KnowledgeDraftVersion | undefined,
	expected: KnowledgeDraftVersion,
): void {
	if (
		!current ||
		current.status !== "active" ||
		current.contentHash !== expected.contentHash ||
		current.baseRevisionId !== expected.baseRevisionId ||
		current.updatedAt !== expected.updatedAt ||
		current.status !== expected.status ||
		current.title !== expected.title ||
		current.targetCollectionId !== expected.targetCollectionId ||
		JSON.stringify(current.keywordsJson) !== JSON.stringify(expected.keywordsJson)
	) {
		throw new AppError("Personal entry changed; reload and retry", 409, "KNOWLEDGE_DRAFT_CONFLICT");
	}
}
