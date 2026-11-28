import type { Database } from "bun:sqlite";
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import type { narratorToolCalls } from "../../db/schema";
import type {
	FileChangeEffectRecord,
	FileChangeOperationRecord,
} from "../../services/file-change-evidence";
import type { FileChangeScopeIdentity } from "../../services/file-change-identity";

const binding = {
	id: "id",
	narratorId: "narrator_id",
	messageId: "message_id",
	toolUseId: "tool_use_id",
	toolName: "tool_name",
	executionIdentityVersion: "execution_identity_version",
	executionOriginToolCallId: "execution_origin_tool_call_id",
	executionAttempt: "execution_attempt",
	fileChangeOperationId: "file_change_operation_id",
	executionDeviceId: "execution_device_id",
	executionPathFlavor: "execution_path_flavor",
	resolvedFilePath: "resolved_file_path",
	canonicalFilePath: "canonical_file_path",
	runtimeGeneration: "runtime_generation",
} as const;

export type ToolEditBinding = Pick<typeof narratorToolCalls.$inferSelect, keyof typeof binding>;
export type ToolEditOperation = Pick<FileChangeOperationRecord, keyof typeof operation>;
export type ToolEditEffect = Pick<FileChangeEffectRecord, keyof typeof effect>;

const operation = {
	id: "id",
	sourceInstanceId: "source_instance_id",
	sourceKind: "source_kind",
	sourceId: "source_id",
	toolCallId: "tool_call_id",
	toolUseId: "tool_use_id",
	narratorId: "narrator_id",
	attempt: "attempt",
	evidenceVersion: "evidence_version",
	executionBindingJson: "execution_binding_json",
} as const;
const effect = {
	operationId: "operation_id",
	scopeId: "scope_id",
	fileKey: "file_key",
	phase: "phase",
	identityJson: "identity_json",
	beforeStateJson: "before_state_json",
	observedAfterStateJson: "observed_after_state_json",
} as const;
const scope: Record<keyof FileChangeScopeIdentity, string> = {
	id: "id",
	sourceInstanceId: "source_instance_id",
	deviceId: "device_id",
	workspaceInstanceId: "workspace_instance_id",
	pathFlavor: "path_flavor",
	canonicalRoot: "canonical_root",
};

const bindingKeys = Object.keys(binding) as (keyof ToolEditBinding)[];
export function sameToolEditBinding(a: ToolEditBinding, b: ToolEditBinding): boolean {
	return bindingKeys.every((key) => a[key] === b[key]);
}

function projection(columns: Record<string, string>) {
	const fields = Object.entries(columns);
	const bytes = fields.map(([, sql]) => `coalesce(octet_length(${sql}), 0)`).join(" + ");
	return {
		bytes,
		values: fields.map(([key, column]) => `${column} AS "${key}"`).join(", "),
	};
}

const bindingProjection = projection(binding);
const operationProjection = projection(operation);
const effectProjection = projection(effect);
const scopeProjection = projection(scope);
const MAX_ROW_BYTES = FILE_CHANGE_LIMITS.summaryBytes;
const tooLarge = "too_large" as const;

function getRow<T>(
	sqlite: Database,
	select: ReturnType<typeof projection>,
	from: string,
	id: string,
) {
	const size = sqlite
		.query<{ bytes: number }, [string]>(`SELECT ${select.bytes} AS bytes ${from}`)
		.get(id);
	if (!size) return null;
	if (size.bytes > MAX_ROW_BYTES) return tooLarge;
	return sqlite.query<T, [string]>(`SELECT ${select.values} ${from}`).get(id);
}

type Encoded<T, K extends keyof T> = Omit<T, K> & {
	[P in K]: null extends T[P] ? string | null : string;
};
type OperationSnapshot = {
	row: ToolEditBinding;
	original?: ToolEditBinding;
	operation: ToolEditOperation;
};
export type ToolEditPreviewSnapshot =
	| { status: "missing" }
	| { status: "too_large" }
	| ({ status: "ambiguous" } & OperationSnapshot)
	| ({
			status: "ok";
			effect?: ToolEditEffect;
			scope: FileChangeScopeIdentity | null;
	  } & OperationSnapshot);

/** Pin the selected call, COW origin, operation, effect and scope to one committed snapshot. */
export function readToolEditPreviewSnapshot(
	sqlite: Database,
	toolCallId: string,
	signal: AbortSignal,
): ToolEditPreviewSnapshot {
	return sqlite.transaction((): ToolEditPreviewSnapshot => {
		signal.throwIfAborted();
		const callFrom = "FROM narrator_tool_calls WHERE id = ?";
		const row = getRow<ToolEditBinding>(sqlite, bindingProjection, callFrom, toolCallId);
		if (row === tooLarge) return { status: tooLarge };
		if (!row?.fileChangeOperationId) return { status: "missing" };
		const original = row.executionOriginToolCallId
			? getRow<ToolEditBinding>(sqlite, bindingProjection, callFrom, row.executionOriginToolCallId)
			: null;
		if (original === tooLarge) return { status: tooLarge };
		const stored = getRow<Encoded<ToolEditOperation, "executionBindingJson">>(
			sqlite,
			operationProjection,
			"FROM file_change_operations WHERE id = ?",
			row.fileChangeOperationId,
		);
		if (stored === tooLarge) return { status: tooLarge };
		if (!stored) return { status: "missing" };
		const facts: OperationSnapshot = {
			row,
			original: original ?? undefined,
			operation: {
				...stored,
				executionBindingJson:
					stored.executionBindingJson === null ? null : JSON.parse(stored.executionBindingJson),
			},
		};
		const fromEffects =
			"FROM file_change_effects WHERE operation_id = ? ORDER BY file_key, phase LIMIT 2";
		const sizes = sqlite
			.query<{ bytes: number }, [string]>(
				`SELECT ${effectProjection.bytes} AS bytes ${fromEffects}`,
			)
			.all(stored.id);
		if (sizes.length > 1) return { status: "ambiguous", ...facts };
		if (!sizes.length) return { status: "ok", ...facts, scope: null };
		if (sizes[0].bytes > MAX_ROW_BYTES) return { status: tooLarge };
		const encoded = sqlite
			.query<
				Encoded<ToolEditEffect, "identityJson" | "beforeStateJson" | "observedAfterStateJson">,
				[string]
			>(`SELECT ${effectProjection.values} ${fromEffects}`)
			.get(stored.id);
		if (!encoded) return { status: "ok", ...facts, scope: null };
		const evidenceScope = getRow<FileChangeScopeIdentity>(
			sqlite,
			scopeProjection,
			"FROM file_change_scopes WHERE id = ?",
			encoded.scopeId,
		);
		if (evidenceScope === tooLarge) return { status: tooLarge };
		signal.throwIfAborted();
		return {
			status: "ok",
			...facts,
			effect: {
				...encoded,
				identityJson: JSON.parse(encoded.identityJson),
				beforeStateJson: JSON.parse(encoded.beforeStateJson),
				observedAfterStateJson: JSON.parse(encoded.observedAfterStateJson),
			},
			scope: evidenceScope,
		};
	})();
}
