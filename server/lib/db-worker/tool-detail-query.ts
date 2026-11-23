import type { Database } from "bun:sqlite";
import { clearedToolOutputSql } from "@shared/narrator-blocks/retention";
import { toolCallWithExecutionTargets } from "../tool-execution-target-projection";
import { DOMAIN_STREAM_BYTE_LIMITS } from "./domain-protocol";
import {
	selectVisibleToolDetail,
	TOOL_DETAIL_CANDIDATE_LIMIT,
	TOOL_DETAIL_PAYLOAD_BYTE_LIMIT,
	type ToolDetailCandidate,
	type ToolDetailParent,
	type ToolDetailReference,
} from "./tool-detail-selection";

export interface ToolDetailSnapshotParams {
	narratorId: string;
	toolUseId: string;
	reference: ToolDetailReference;
	columns: {
		key: string;
		name: string;
		type: string;
		virtual: boolean;
	}[];
}

export interface ToolDetailIdentity {
	id: string;
	messageId: string;
	modelRevision: number;
	parentCopyId?: string;
}

export type ToolDetailMetadata =
	| { kind: "found"; identity: ToolDetailIdentity }
	| { kind: "ambiguous" | "notFound" | "tooLarge" };

type ToolDetailSnapshot = ToolDetailMetadata & { json?: string };

const candidateLimit = TOOL_DETAIL_CANDIDATE_LIMIT + 1;
const parentColumns = `t.id, t.narrator_id AS narratorId, t.tool_use_id AS toolUseId,
	t.tool_name AS toolName, t.execution_origin_tool_call_id AS executionOriginToolCallId,
	t.execution_identity_version AS executionIdentityVersion,
	t.is_file_history_checkpoint = 1 AS isFileHistoryCheckpoint,
	EXISTS (SELECT 1 FROM narrator_message_refs r
		WHERE r.narrator_id = ? AND r.message_id = t.message_id) AS directRef`;

function identifier(value: string): string {
	if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) throw new Error("Invalid tool detail column");
	return `"${value}"`;
}

export function readToolDetailSnapshot(
	sqlite: Database,
	params: ToolDetailSnapshotParams,
	signal: AbortSignal,
): ToolDetailSnapshot {
	signal.throwIfAborted();
	return sqlite.transaction(() => readToolDetailSnapshotTx(sqlite, params, signal))();
}

function selectToolDetailRow(
	sqlite: Database,
	narratorId: string,
	toolUseId: string,
	reference: ToolDetailReference,
	signal?: AbortSignal,
	fence?: ToolDetailIdentity,
) {
	const conditions = ["t.tool_use_id = ?"];
	const params: (string | number)[] = [narratorId, toolUseId];
	if (reference.toolCallId !== undefined) {
		conditions.push("t.id = ?");
		params.push(reference.toolCallId);
	}
	if (reference.messageId !== undefined) {
		conditions.push("t.message_id = ?");
		params.push(reference.messageId);
	}
	if (fence) {
		conditions.push("t.model_revision = ?");
		params.push(fence.modelRevision);
	}
	const candidates = sqlite
		.query<ToolDetailCandidate, (string | number)[]>(
			`SELECT ${parentColumns}, m.narrator_id AS messageNarratorId,
				m.parent_tool_use_id AS parentToolUseId, n.type AS authorType, n.variant AS authorVariant,
				n.parent_narrator_id AS authorParentNarratorId,
				n.origin_tool_call_id AS authorOriginToolCallId,
				EXISTS (SELECT 1 FROM narrator_message_refs r
					WHERE r.narrator_id = m.narrator_id AND r.message_id = t.message_id) AS authorRef
			FROM narrator_tool_calls t JOIN narrator_messages m ON m.id = t.message_id
				JOIN narrators n ON n.id = m.narrator_id
			WHERE ${conditions.join(" AND ")} LIMIT ${candidateLimit}`,
		)
		.all(...params);
	const byId = (id: string) =>
		sqlite
			.query<ToolDetailParent, [string, string]>(
				`SELECT ${parentColumns} FROM narrator_tool_calls t WHERE t.id = ?`,
			)
			.get(narratorId, id);
	return selectVisibleToolDetail(
		candidates,
		byId,
		(useId) => {
			if (fence) {
				const copy = fence.parentCopyId && byId(fence.parentCopyId);
				return copy && copy.toolUseId === useId ? [copy] : [];
			}
			return sqlite
				.query<ToolDetailParent, [string, string]>(
					`SELECT ${parentColumns} FROM narrator_tool_calls t WHERE t.tool_use_id = ? LIMIT ${candidateLimit}`,
				)
				.all(narratorId, useId);
		},
		signal,
	);
}

/** Recheck only the selected row, origin, and observed COW copy, without loading payloads. */
export function isCurrentToolDetail(
	sqlite: Database,
	narratorId: string,
	toolUseId: string,
	identity: ToolDetailIdentity,
): boolean {
	return sqlite.transaction(
		() =>
			selectToolDetailRow(
				sqlite,
				narratorId,
				toolUseId,
				{ toolCallId: identity.id, messageId: identity.messageId },
				undefined,
				identity,
			).kind === "selected",
	)();
}

function readToolDetailSnapshotTx(
	sqlite: Database,
	{ narratorId, toolUseId, reference, columns }: ToolDetailSnapshotParams,
	signal: AbortSignal,
): ToolDetailSnapshot {
	const selected = selectToolDetailRow(sqlite, narratorId, toolUseId, reference, signal);
	if (selected.kind !== "selected") return { kind: selected.kind };

	signal.throwIfAborted();
	const cleared = clearedToolOutputSql();
	const storedBytes = columns
		.filter((column) => !column.virtual)
		.map(({ name }) => {
			const bytes = `coalesce(octet_length(${identifier(name)}), 0)`;
			return name === "input_json" ? `CASE WHEN ${cleared} THEN 0 ELSE ${bytes} END` : bytes;
		});
	const size = sqlite
		.query<{ bytes: number }, [string]>(
			`SELECT ${storedBytes.join(" + ")} AS bytes FROM narrator_tool_calls WHERE id = ?`,
		)
		.get(selected.id);
	if (!size) return { kind: "notFound" };
	if (size.bytes > TOOL_DETAIL_PAYLOAD_BYTE_LIMIT) return { kind: "tooLarge" };

	const projection = columns.map(({ key, name }) => {
		const field = identifier(name);
		const value =
			name === "input_json" ? `CASE WHEN ${cleared} THEN NULL ELSE ${field} END` : field;
		return `${value} AS ${identifier(key)}`;
	});
	const detail = sqlite
		.query<
			Record<string, unknown> & Pick<ToolDetailIdentity, "id" | "messageId" | "modelRevision">,
			[string]
		>(`SELECT ${projection.join(", ")} FROM narrator_tool_calls WHERE id = ?`)
		.get(selected.id);
	if (!detail) return { kind: "notFound" };
	for (const { key, type } of columns) {
		const value = detail[key];
		if (typeof value === "string" && type === "json") detail[key] = JSON.parse(value);
		if (typeof value === "number" && type === "boolean") detail[key] = value === 1;
	}
	const json = JSON.stringify(toolCallWithExecutionTargets(detail));
	if (Buffer.byteLength(json) > DOMAIN_STREAM_BYTE_LIMITS.toolDetailSnapshot)
		return { kind: "tooLarge" };
	return {
		kind: "found",
		json,
		identity: {
			id: detail.id,
			messageId: detail.messageId,
			modelRevision: detail.modelRevision,
			parentCopyId: selected.parentCopyId,
		},
	};
}
