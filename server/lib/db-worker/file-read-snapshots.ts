import type { Database, SQLQueryBindings } from "bun:sqlite";
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import type * as schema from "../../db/schema";
import { DbReadError } from "./errors";

type Tables = {
	fileChangeBlobs: typeof schema.fileChangeBlobs.$inferSelect;
	fileChangeEffects: typeof schema.fileChangeEffects.$inferSelect;
	fileChangeOperations: typeof schema.fileChangeOperations.$inferSelect;
	fileChangeScopes: typeof schema.fileChangeScopes.$inferSelect;
	fileChangeStorageBudgets: typeof schema.fileChangeStorageBudgets.$inferSelect;
	revertOperationFiles: typeof schema.revertOperationFiles.$inferSelect;
	revertOperations: typeof schema.revertOperations.$inferSelect;
};
const tables = {
	fileChangeBlobs: {
		name: "file_change_blobs",
		columns: [
			["id", "id", "string"],
			["digest", "digest", "string"],
			["sizeBytes", "size_bytes", "number"],
			["storageKey", "storage_key", "string"],
			["status", "status", "string"],
			["leaseUntil", "lease_until", "string"],
			["gcGeneration", "gc_generation", "number"],
			["createdAt", "created_at", "string"],
			["updatedAt", "updated_at", "string"],
		],
	},
	fileChangeEffects: {
		name: "file_change_effects",
		columns: [
			["id", "id", "string"],
			["operationId", "operation_id", "string"],
			["journalSeq", "journal_seq", "number"],
			["scopeId", "scope_id", "string"],
			["fileKey", "file_key", "string"],
			["identityJson", "identity_json", "json"],
			["scopeRevision", "scope_revision", "number"],
			["mutationId", "mutation_id", "string"],
			["requestDigest", "request_digest", "string"],
			["phase", "phase", "string"],
			["beforeStateJson", "before_state_json", "json"],
			["intendedAfterStateJson", "intended_after_state_json", "json"],
			["observedAfterStateJson", "observed_after_state_json", "json"],
			["beforeBlobDigest", "before_blob_digest", "string"],
			["intendedAfterBlobDigest", "intended_after_blob_digest", "string"],
			["observedAfterBlobDigest", "observed_after_blob_digest", "string"],
			["diskOutcome", "disk_outcome", "string"],
			["outcome", "outcome", "string"],
			["settlement", "settlement", "string"],
			["attributionGrade", "attribution_grade", "string"],
			["attributionCeiling", "attribution_ceiling", "string"],
			["executionConfirmed", "execution_confirmed", "boolean"],
			["executionReceiptJson", "execution_receipt_json", "json"],
			["executionReceiptDigest", "execution_receipt_digest", "string"],
			["linesAdded", "lines_added", "number"],
			["linesRemoved", "lines_removed", "number"],
			["createdAt", "created_at", "string"],
			["updatedAt", "updated_at", "string"],
		],
	},
	fileChangeOperations: {
		name: "file_change_operations",
		columns: [
			["id", "id", "string"],
			["journalSeq", "journal_seq", "number"],
			["executionSegmentId", "execution_segment_id", "string"],
			["evidenceVersion", "evidence_version", "number"],
			["sourceInstanceId", "source_instance_id", "string"],
			["sourceKind", "source_kind", "string"],
			["sourceId", "source_id", "string"],
			["attempt", "attempt", "number"],
			["requestDigest", "request_digest", "string"],
			["expectedEffectCount", "expected_effect_count", "number"],
			["workspaceLeaseId", "workspace_lease_id", "string"],
			["editorRawSnapshotRevision", "editor_raw_snapshot_revision", "number"],
			["preparedEffectCount", "prepared_effect_count", "number"],
			["evidenceBytes", "evidence_bytes", "number"],
			["settledEffectCount", "settled_effect_count", "number"],
			["unresolvedEffectCount", "unresolved_effect_count", "number"],
			["toolCallId", "tool_call_id", "string"],
			["toolUseId", "tool_use_id", "string"],
			["backgroundTaskId", "background_task_id", "string"],
			["narratorId", "narrator_id", "string"],
			["projectId", "project_id", "string"],
			["ownerUserId", "owner_user_id", "string"],
			["actorSubjectKey", "actor_subject_key", "string"],
			["actorJson", "actor_json", "json"],
			["initiatorSubjectKey", "initiator_subject_key", "string"],
			["executionBindingJson", "execution_binding_json", "json"],
			["executionOutcome", "execution_outcome", "string"],
			["effectOutcome", "effect_outcome", "string"],
			["settlement", "settlement", "string"],
			["attributionGrade", "attribution_grade", "string"],
			["coverage", "coverage", "string"],
			["parentOperationId", "parent_operation_id", "string"],
			["reason", "reason", "string"],
			["leaseUntil", "lease_until", "string"],
			["startedAt", "started_at", "string"],
			["finishedAt", "finished_at", "string"],
			["updatedAt", "updated_at", "string"],
		],
	},
	fileChangeScopes: {
		name: "file_change_scopes",
		columns: [
			["id", "id", "string"],
			["sourceInstanceId", "source_instance_id", "string"],
			["deviceId", "device_id", "string"],
			["workspaceInstanceId", "workspace_instance_id", "string"],
			["canonicalRoot", "canonical_root", "string"],
			["displayRoot", "display_root", "string"],
			["pathFlavor", "path_flavor", "string"],
			["status", "status", "string"],
			["rootIdentityJson", "root_identity_json", "json"],
			["revision", "revision", "number"],
			["fencingToken", "fencing_token", "number"],
			["activeLeaseId", "active_lease_id", "string"],
			["activeLeaseEpoch", "active_lease_epoch", "string"],
			["activeLeaseStartedAt", "active_lease_started_at", "string"],
			["activeMutationCount", "active_mutation_count", "number"],
			["createdAt", "created_at", "string"],
			["updatedAt", "updated_at", "string"],
		],
	},
	fileChangeStorageBudgets: {
		name: "file_change_storage_budgets",
		columns: [
			["id", "id", "string"],
			["namespaceKey", "namespace_key", "string"],
			["status", "status", "string"],
			["usedBytes", "used_bytes", "number"],
			["reservedBytes", "reserved_bytes", "number"],
			["quotaBytes", "quota_bytes", "number"],
			["generation", "generation", "number"],
			["reconciledAt", "reconciled_at", "string"],
			["updatedAt", "updated_at", "string"],
		],
	},
	revertOperationFiles: {
		name: "revert_operation_files",
		columns: [
			["id", "id", "string"],
			["revertOperationId", "revert_operation_id", "string"],
			["scopeId", "scope_id", "string"],
			["fileKey", "file_key", "string"],
			["identityJson", "identity_json", "json"],
			["sequence", "sequence", "number"],
			["expectedStateJson", "expected_state_json", "json"],
			["desiredStateJson", "desired_state_json", "json"],
			["observedAfterStateJson", "observed_after_state_json", "json"],
			["beforeBlobDigest", "before_blob_digest", "string"],
			["desiredBlobDigest", "desired_blob_digest", "string"],
			["observedAfterBlobDigest", "observed_after_blob_digest", "string"],
			["compensationAfterStateJson", "compensation_after_state_json", "json"],
			["compensationAfterBlobDigest", "compensation_after_blob_digest", "string"],
			["applyMutationId", "apply_mutation_id", "string"],
			["applyRequestDigest", "apply_request_digest", "string"],
			["compensateMutationId", "compensate_mutation_id", "string"],
			["compensateRequestDigest", "compensate_request_digest", "string"],
			["status", "status", "string"],
			["receiptJson", "receipt_json", "json"],
			["reason", "reason", "string"],
			["updatedAt", "updated_at", "string"],
		],
	},
	revertOperations: {
		name: "revert_operations",
		columns: [
			["id", "id", "string"],
			["protocolVersion", "protocol_version", "number"],
			["narratorId", "narrator_id", "string"],
			["projectId", "project_id", "string"],
			["requestedBySubjectKey", "requested_by_subject_key", "string"],
			["idempotencyKey", "idempotency_key", "string"],
			["requestDigest", "request_digest", "string"],
			["kind", "kind", "string"],
			["scope", "scope", "string"],
			["selectorKind", "selector_kind", "string"],
			["selectorBlobDigest", "selector_blob_digest", "string"],
			["planBlobDigest", "plan_blob_digest", "string"],
			["historyManifestBlobDigest", "history_manifest_blob_digest", "string"],
			["planHash", "plan_hash", "string"],
			["expectedMessageVersion", "expected_message_version", "number"],
			["parentRevertId", "parent_revert_id", "string"],
			["status", "status", "string"],
			["fileCount", "file_count", "number"],
			["appliedFileCount", "applied_file_count", "number"],
			["coverageComplete", "coverage_complete", "boolean"],
			["reason", "reason", "string"],
			["expiresAt", "expires_at", "string"],
			["leaseUntil", "lease_until", "string"],
			["createdAt", "created_at", "string"],
			["updatedAt", "updated_at", "string"],
		],
	},
} as const;

function check(signal: AbortSignal, deadlineAt?: number) {
	signal.throwIfAborted();
	if (deadlineAt !== undefined && Date.now() >= deadlineAt)
		throw new DbReadError("DB_READ_TIMEOUT", "File evidence read deadline exceeded");
}
function rows<K extends keyof Tables>(
	sqlite: Database,
	table: K,
	clause: string,
	params: SQLQueryBindings[],
	signal: AbortSignal,
	deadlineAt?: number,
): Tables[K][] {
	check(signal, deadlineAt);
	const definition = tables[table];
	const cap = FILE_CHANGE_LIMITS.summaryBytes;
	const projection = definition.columns
		.map(([key, name, type]) =>
			type === "number" || type === "boolean"
				? `"${name}" AS "${key}"`
				: `CAST(substr(CAST("${name}" AS BLOB), 1, ${cap + 1}) AS TEXT) AS "${key}"`,
		)
		.join(", ");
	const size = definition.columns
		.map(([, name]) => `coalesce(octet_length("${name}"), 0)`)
		.join(" + ");
	const statement = sqlite.prepare<Record<string, unknown>, SQLQueryBindings[]>(
		`SELECT ${projection}, (${size}) AS __sourceBytes FROM "${definition.name}" ${clause}`,
	);
	const result: Tables[K][] = [];
	let bytes = 0;
	try {
		for (const raw of statement.iterate(...params)) {
			check(signal, deadlineAt);
			const { __sourceBytes, ...row } = raw;
			bytes += Number(__sourceBytes);
			if (Number(__sourceBytes) > cap || bytes > 4 * 1024 * 1024)
				throw new DbReadError("DB_READ_BUDGET", "File evidence exceeds its source byte budget");
			for (const [key, , type] of definition.columns) {
				if (type === "json" && row[key] !== null) row[key] = JSON.parse(row[key] as string);
				else if (type === "boolean" && row[key] !== null) row[key] = Boolean(row[key]);
			}
			result.push(row as Tables[K]);
		}
		return result;
	} finally {
		statement.finalize();
	}
}
export interface EditorOperationReadInput {
	sourceInstanceId: string;
	sourceId: string;
}
export function readEditorOperationEvidence(
	sqlite: Database,
	input: EditorOperationReadInput,
	signal: AbortSignal,
	deadlineAt?: number,
): EditorOperationReadSnapshot {
	const operation =
		rows(
			sqlite,
			"fileChangeOperations",
			"WHERE source_instance_id = ? AND source_kind = 'editor' AND source_id = ? AND attempt = 1 LIMIT 1",
			[input.sourceInstanceId, input.sourceId],
			signal,
			deadlineAt,
		)[0] ?? null;
	const effects = operation
		? rows(
				sqlite,
				"fileChangeEffects",
				"WHERE operation_id = ? ORDER BY file_key, phase LIMIT 3",
				[operation.id],
				signal,
				deadlineAt,
			)
		: [];
	return { operation, effects };
}
export interface RevertReadInput {
	owner: { subjectKey: string; narratorId: string | null; projectId: string | null };
	planId: string;
	cursor: string | null;
	limit: number;
}
export function readRevertPlan(
	sqlite: Database,
	input: RevertReadInput,
	signal: AbortSignal,
	deadlineAt?: number,
): RevertReadSnapshot {
	const operation =
		rows(
			sqlite,
			"revertOperations",
			"WHERE id = ? AND requested_by_subject_key = ? AND narrator_id IS ? AND project_id IS ? LIMIT 1",
			[input.planId, input.owner.subjectKey, input.owner.narratorId, input.owner.projectId],
			signal,
			deadlineAt,
		)[0] ?? null;
	const files =
		operation && input.limit
			? rows(
					sqlite,
					"revertOperationFiles",
					`WHERE "revert_operation_id" = ? ${input.cursor ? "AND file_key > ?" : ""} ORDER BY file_key LIMIT ?`,
					[operation.id, ...(input.cursor ? [input.cursor] : []), input.limit],
					signal,
					deadlineAt,
				)
			: [];
	const budget =
		rows(
			sqlite,
			"fileChangeStorageBudgets",
			"WHERE id = ? LIMIT 1",
			["file-change-blobs"],
			signal,
			deadlineAt,
		)[0] ?? null;
	const scopeIds = [...new Set(files.map((file) => file.scopeId))];
	const scopes = scopeIds.length
		? rows(
				sqlite,
				"fileChangeScopes",
				`WHERE id IN (${scopeIds.map(() => "?").join(",")}) LIMIT 101`,
				scopeIds,
				signal,
				deadlineAt,
			)
		: [];
	const digests = [
		...new Set(
			[
				operation?.selectorBlobDigest,
				operation?.planBlobDigest,
				operation?.historyManifestBlobDigest,
				...files.map((file) => file.desiredBlobDigest),
			].filter((value): value is string => typeof value === "string"),
		),
	];
	const blobs = digests.length
		? rows(
				sqlite,
				"fileChangeBlobs",
				`WHERE digest IN (${digests.map(() => "?").join(",")}) LIMIT 104`,
				digests,
				signal,
				deadlineAt,
			)
		: [];
	return { operation, files, budget, scopes, blobs };
}
export interface EditorOperationReadSnapshot {
	operation: Tables["fileChangeOperations"] | null;
	effects: Tables["fileChangeEffects"][];
}
export interface RevertReadSnapshot {
	operation: Tables["revertOperations"] | null;
	files: Tables["revertOperationFiles"][];
	budget: Tables["fileChangeStorageBudgets"] | null;
	scopes: Tables["fileChangeScopes"][];
	blobs: Tables["fileChangeBlobs"][];
}
