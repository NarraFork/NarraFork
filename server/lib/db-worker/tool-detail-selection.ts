import { isSubagentVariant } from "../narrator-utils";

export const TOOL_DETAIL_CANDIDATE_LIMIT = 200;
const TOOL_DETAIL_METADATA_ROW_LIMIT = 1_000;
export const TOOL_DETAIL_PAYLOAD_BYTE_LIMIT = 32 * 1024 * 1024;

export type ToolDetailReference = { toolCallId?: string; messageId?: string };

interface ToolParent {
	id: string;
	narratorId: string;
	toolUseId: string;
	toolName: string;
	executionOriginToolCallId: string | null;
	executionIdentityVersion: number;
	isFileHistoryCheckpoint: boolean;
	directRef: boolean | number;
}

export interface ToolDetailCandidate extends ToolParent {
	messageNarratorId: string;
	parentToolUseId: string | null;
	authorType: string;
	authorVariant: string;
	authorParentNarratorId: string | null;
	authorOriginToolCallId: string | null;
	authorRef: boolean | number;
}

function isAgent(call: ToolParent): boolean {
	return (
		(call.toolName === "Agent" || call.toolName === "Task") &&
		call.executionIdentityVersion === 1 &&
		!call.isFileHistoryCheckpoint
	);
}

export function selectVisibleToolDetail(
	candidates: ToolDetailCandidate[],
	findOriginal: (id: string) => ToolParent | null | undefined,
	findCopies: (toolUseId: string) => ToolParent[],
	signal?: AbortSignal,
): { kind: "selected"; id: string; parentCopyId?: string } | { kind: "ambiguous" | "notFound" } {
	let metadataRows = candidates.length;
	if (metadataRows > TOOL_DETAIL_CANDIDATE_LIMIT) return { kind: "ambiguous" };
	const childVisibility = new Map<string, { parentCopyId?: string } | null>();
	const visible: { id: string; parentCopyId?: string }[] = [];
	for (const candidate of candidates) {
		signal?.throwIfAborted();
		if (candidate.directRef) {
			visible.push({ id: candidate.id });
			continue;
		}
		// Provider IDs only corroborate ancestry; the original Agent/Task PK proves it.
		if (
			candidate.authorType !== "subagent" ||
			!isSubagentVariant(candidate.authorVariant) ||
			!candidate.authorOriginToolCallId ||
			!candidate.authorParentNarratorId ||
			!candidate.parentToolUseId ||
			!candidate.authorRef ||
			candidate.narratorId !== candidate.messageNarratorId
		)
			continue;
		const originId = candidate.authorOriginToolCallId;
		const key = JSON.stringify([candidate.messageNarratorId, originId, candidate.parentToolUseId]);
		const cached = childVisibility.get(key);
		if (cached !== undefined) {
			if (cached) visible.push({ id: candidate.id, ...cached });
			continue;
		}
		const original = findOriginal(originId);
		if (original && ++metadataRows > TOOL_DETAIL_METADATA_ROW_LIMIT) return { kind: "ambiguous" };
		if (
			original &&
			(!isAgent(original) ||
				original.executionOriginToolCallId !== null ||
				original.narratorId !== candidate.authorParentNarratorId ||
				original.toolUseId !== candidate.parentToolUseId)
		) {
			childVisibility.set(key, null);
			continue;
		}
		if (original?.directRef) {
			childVisibility.set(key, {});
			visible.push({ id: candidate.id });
			continue;
		}
		// COW can remove the original; only a referenced copy with the same immutable origin qualifies.
		const copies = findCopies(candidate.parentToolUseId);
		metadataRows += copies.length;
		if (
			copies.length > TOOL_DETAIL_CANDIDATE_LIMIT ||
			metadataRows > TOOL_DETAIL_METADATA_ROW_LIMIT
		)
			return { kind: "ambiguous" };
		const copy = copies.find(
			(parent) =>
				parent.directRef && isAgent(parent) && parent.executionOriginToolCallId === originId,
		);
		const proof = copy ? { parentCopyId: copy.id } : null;
		childVisibility.set(key, proof);
		if (proof) visible.push({ id: candidate.id, ...proof });
	}
	if (!visible.length) return { kind: "notFound" };
	if (visible.length !== 1) return { kind: "ambiguous" };
	return { kind: "selected", ...visible[0] };
}
export type ToolDetailParent = ToolParent;
