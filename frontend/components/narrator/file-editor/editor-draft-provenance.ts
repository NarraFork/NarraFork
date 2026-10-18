import type { EditorDraftAnchorDescriptor } from "@shared/editor-document";
import { editorDocumentApi } from "../../../lib/api/editor-documents";
import { draftEditable, type EditorDraftMetadata } from "./editor-draft-store";

export type RecoverableEditorDraft = EditorDraftMetadata & {
	provenance?: EditorDraftAnchorDescriptor;
};
export function matchesDraftAnchor(row: EditorDraftMetadata, anchor: EditorDraftAnchorDescriptor) {
	return (
		!!row.anchor &&
		anchor.anchorId === row.anchor.anchorId &&
		anchor.checkpointGeneration === row.generation &&
		anchor.recoveryKey === row.scope.recoveryKey &&
		anchor.resourceKey === row.scope.resourceKey &&
		anchor.writerId === row.writerId &&
		anchor.revision === row.revision &&
		anchor.modelLifetime === row.modelLifetime
	);
}
export function recoverableDraftFormat(row: RecoverableEditorDraft) {
	// IDB operation fields are only hints. Only verified server coverage can prove no dispatch.
	return (
		row.provenance?.status === "no-dispatch" &&
		matchesDraftAnchor(row, row.provenance) &&
		draftEditable({ ...row, operation: undefined })
	);
}
/** Metadata only, sequential and bounded by the existing 32-entry IDB owner index. */
export async function verifyDraftProvenance(rows: EditorDraftMetadata[], signal: AbortSignal) {
	const result: RecoverableEditorDraft[] = [];
	for (const row of rows) {
		signal.throwIfAborted();
		try {
			if (!row.anchor) {
				result.push(row);
				continue;
			}
			const anchor = await editorDocumentApi.getDraftAnchor(
				row.scope.narratorId,
				row.anchor.anchorId,
				{ deviceId: row.scope.deviceId, origin: row.scope.origin },
				signal,
			);
			if (!matchesDraftAnchor(row, anchor)) throw new Error("EDITOR_DRAFT_ANCHOR_MISMATCH");
			result.push({
				...row,
				provenance: anchor,
				...(anchor.operation
					? { operation: { ...anchor.operation, status: "query-first" as const } }
					: {}),
			});
		} catch {
			signal.throwIfAborted();
			result.push(row);
		}
	}
	return result;
}
export async function claimDraftForRecovery(row: RecoverableEditorDraft, signal: AbortSignal) {
	if (!row.anchor || !recoverableDraftFormat(row)) throw new Error("EDITOR_DRAFT_READ_ONLY");
	const claim = await editorDocumentApi.claimDraftAnchor(
		row.scope.narratorId,
		row.anchor.anchorId,
		{ deviceId: row.scope.deviceId, origin: row.scope.origin },
		signal,
	);
	if (!matchesDraftAnchor(row, claim) || claim.status !== "no-dispatch" || !claim.retired)
		throw new Error("EDITOR_DRAFT_QUERY_REQUIRED");
	return claim;
}
