import { createHash } from "node:crypto";
import { parentPort } from "node:worker_threads";
import {
	FILE_CHANGE_EVIDENCE_VERSION,
	type FileChangeBlobRef,
	type FileChangeExecutionBinding,
	type FileChangeRevertAction,
	type FileChangeState,
	fileChangeRevertActionMatches,
	hasConfirmedNoFileChange,
	hasSettledMeasuredFileEffect,
	type KnownFileChangeState,
	FILE_CHANGE_LIMITS as LIMIT,
} from "@shared/file-change-protocol";
import { fileChangeIdentityKey } from "./file-change-identity";
import type { RevertJournalFile, RevertJournalOperation } from "./revert-mutation-journal";
import {
	type AppendRevertPlanFile,
	fingerprintRevertPlanFiles,
	type RevertPlanHeader,
	type RevertPlanManifestProof,
	revertPlanHeaderDigest,
} from "./revert-plan-service";
import type { RevertSelectionResult } from "./revert-selection-service";

/** Private worker protocol. Raw manifests never get parsed/stringified on the HTTP thread. */
export interface TransactionManifestFile extends AppendRevertPlanFile {
	expected: KnownFileChangeState;
	desired: KnownFileChangeState;
	executionBinding: FileChangeExecutionBinding;
	scopeRevision: number;
}
export interface ValidatedTransactionManifest {
	header: RevertPlanHeader;
	proof: RevertPlanManifestProof;
	selection: RevertSelectionResult;
	files: TransactionManifestFile[];
	rawRefs: FileChangeBlobRef[];
	evidenceBytes: number;
}
export type TransactionManifestRequest =
	| {
			action: "validate";
			raw: { ref: FileChangeBlobRef; bytes: Uint8Array }[];
			operation: RevertJournalOperation;
			files: RevertJournalFile[];
			userId: string;
			acceptSnapshotRestore?: true;
	  }
	| { action: "compare"; fixed: RevertSelectionResult; current: RevertSelectionResult }
	| {
			action: "entrypoint";
			raw: { ref: FileChangeBlobRef; bytes: Uint8Array };
			operation: RevertJournalOperation;
			userId: string;
			expectedAction?: FileChangeRevertAction;
			acceptSnapshotRestore?: true;
	  };

const port = parentPort;
if (port) {
	port.on("message", (request: TransactionManifestRequest) => {
		try {
			if (request.action === "compare") {
				check(equal(request.fixed, request.current), "SELECTION_STALE");
				port.postMessage({ value: true });
			} else if (request.action === "entrypoint") {
				validateEntrypoint(request);
				port.postMessage({ value: true });
			} else port.postMessage({ value: validate(request) });
		} catch (error) {
			port.postMessage({
				error: error instanceof Error ? error.message.slice(0, 128) : "INVALID_MANIFEST",
			});
		}
	});
	// The caller may probe compiled entry paths, but must never dispatch before this handshake.
	port.postMessage({ type: "revert-manifest-worker-ready", version: 1 });
}

/** Also works for terminal journals: applying twice cannot bypass the original UI consent. */
function validateEntrypoint(input: Extract<TransactionManifestRequest, { action: "entrypoint" }>) {
	const { ref, bytes } = input.raw;
	refValid(ref);
	check(ref.digest === input.operation.selectorBlobDigest, "SELECTOR_REF");
	check(bytes.byteLength === ref.sizeBytes && hash(bytes) === ref.digest, "RAW_INTEGRITY");
	const selector = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	bounded(selector);
	keys(selector, ["version", "owner", "request", "fixedSelector", "boundary"]);
	check(selector.version === 1, "SELECTOR_VERSION");
	check(
		equal(selector.owner, {
			subjectKey: input.operation.requestedBySubjectKey,
			narratorId: input.operation.narratorId,
			projectId: input.operation.projectId,
		}) && input.operation.requestedBySubjectKey === `human:${input.userId}`,
		"OWNER",
	);
	check(
		hash(JSON.stringify({ version: 1, owner: selector.owner, request: selector.request })) ===
			input.operation.requestDigest,
		"ORIGINAL_REQUEST_DIGEST",
	);
	keys(
		selector.request,
		[
			"principal",
			"narratorId",
			"expectedMessageVersion",
			"idempotencyKey",
			"kind",
			"revertScope",
			"selector",
		],
		["uiAction", "recoveryMode"],
	);
	keys(selector.request.principal, ["userId", "isAdmin"]);
	selectorValid(selector.request.selector);
	check(
		selector.request.kind === input.operation.kind &&
			selector.request.narratorId === input.operation.narratorId &&
			selector.request.expectedMessageVersion === input.operation.expectedMessageVersion &&
			selector.request.idempotencyKey === input.operation.idempotencyKey &&
			selector.request.revertScope === input.operation.scope &&
			selector.request.principal.userId === input.userId &&
			typeof selector.request.principal.isAdmin === "boolean",
		"REQUEST_CONFLICT",
	);
	if (input.expectedAction !== undefined)
		check(selector.request.uiAction === input.expectedAction, "ACTION_MISMATCH");
	validateRecoveryPolicy(selector.request, input.acceptSnapshotRestore);
}

function validate(
	input: Extract<TransactionManifestRequest, { action: "validate" }>,
): ValidatedTransactionManifest {
	check(input.raw.length === 3, "ORIGINAL_REFS_REQUIRED");
	const [manifest, selector, selection] = input.raw.map(({ ref, bytes }) => {
		refValid(ref);
		check(bytes.byteLength === ref.sizeBytes && hash(bytes) === ref.digest, "RAW_INTEGRITY");
		const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		bounded(value);
		return value;
	});
	const operation = input.operation;
	check(input.raw[0].ref.digest === operation.planBlobDigest, "PLAN_REF");
	check(input.raw[1].ref.digest === operation.selectorBlobDigest, "SELECTOR_REF");
	check(input.raw[2].ref.digest === operation.historyManifestBlobDigest, "HISTORY_REF");
	keys(manifest, [
		"version",
		"protocolVersion",
		"header",
		"proof",
		"selectionMetadataDigest",
		"messageVersions",
		"files",
	]);
	check(
		manifest.version === 1 && manifest.protocolVersion === FILE_CHANGE_EVIDENCE_VERSION,
		"VERSION",
	);
	const header = manifest.header as RevertPlanHeader;
	keys(
		header,
		[
			"subjectKey",
			"narratorId",
			"projectId",
			"idempotencyKey",
			"requestDigest",
			"kind",
			"revertScope",
			"selectorKind",
			"selector",
			"historyManifest",
			"expectedMessageVersion",
			"expectedFileCount",
		],
		["parentRevertId"],
	);
	check(
		header.revertScope === "narrator" &&
			["revert", "history_delete", "rollback_to_block"].includes(header.kind),
		"UNSUPPORTED",
	);
	const expectedHeader: RevertPlanHeader = {
		subjectKey: operation.requestedBySubjectKey,
		narratorId: operation.narratorId,
		projectId: operation.projectId,
		idempotencyKey: operation.idempotencyKey,
		requestDigest: operation.requestDigest,
		kind: operation.kind,
		revertScope: operation.scope,
		selectorKind: operation.selectorKind,
		selector: input.raw[1].ref,
		historyManifest: input.raw[2].ref,
		expectedMessageVersion: operation.expectedMessageVersion as number,
		expectedFileCount: operation.fileCount,
		parentRevertId: operation.parentRevertId,
	};
	check(
		revertPlanHeaderDigest(header) === revertPlanHeaderDigest(expectedHeader),
		"HEADER_CONFLICT",
	);
	check(
		operation.parentRevertId === null && (header.parentRevertId ?? null) === null,
		"UNSUPPORTED_PARENT",
	);
	const proof = manifest.proof as RevertPlanManifestProof;
	keys(proof, [
		"source",
		"headerDigest",
		"orderedFilesDigest",
		"fileEvidenceBytes",
		"computation",
		"selectorCoverage",
		"historyCoverage",
		"omittedFiles",
		"unknownFiles",
	]);
	check(
		proof.source === "trusted_published_planner_v1" &&
			proof.computation === "complete" &&
			proof.selectorCoverage === "complete" &&
			proof.historyCoverage === "complete" &&
			proof.omittedFiles === 0 &&
			proof.unknownFiles === 0,
		"INCOMPLETE_PROOF",
	);
	check(proof.headerDigest === revertPlanHeaderDigest(header), "HEADER_DIGEST");
	const normalizedHeader = { ...expectedHeader, protocolVersion: FILE_CHANGE_EVIDENCE_VERSION };
	check(
		digest(["revert-plan-commitment-v1", normalizedHeader, input.raw[0].ref, proof]) ===
			operation.planHash,
		"PLAN_HASH",
	);

	keys(selector, ["version", "owner", "request", "fixedSelector", "boundary"]);
	check(selector.version === 1, "SELECTOR_VERSION");
	check(
		equal(selector.owner, {
			subjectKey: header.subjectKey,
			narratorId: header.narratorId,
			projectId: header.projectId,
		}),
		"OWNER",
	);
	keys(
		selector.request,
		[
			"principal",
			"narratorId",
			"expectedMessageVersion",
			"idempotencyKey",
			"kind",
			"revertScope",
			"selector",
		],
		["uiAction", "recoveryMode"],
	);
	validateRecoveryPolicy(selector.request, input.acceptSnapshotRestore);
	keys(selector.request.principal, ["userId", "isAdmin"]);
	check(
		selector.request.principal.userId === input.userId &&
			typeof selector.request.principal.isAdmin === "boolean",
		"PRINCIPAL",
	);
	check(header.subjectKey === `human:${input.userId}`, "SUBJECT");
	for (const key of [
		"narratorId",
		"expectedMessageVersion",
		"idempotencyKey",
		"kind",
		"revertScope",
	] as const)
		check(selector.request[key] === header[key], "REQUEST_CONFLICT");
	check(
		hash(JSON.stringify({ version: 1, owner: selector.owner, request: selector.request })) ===
			header.requestDigest,
		"ORIGINAL_REQUEST_DIGEST",
	);

	keys(selection, [
		"version",
		"narratorId",
		"requestedByUserId",
		"selector",
		"messageVersions",
		"boundary",
		"selectionComplete",
		"evidenceComplete",
		"executable",
		"history",
		"tools",
		"operations",
		"effects",
		"noDiskTools",
		"issues",
		"metadataDigest",
	]);
	check(
		selection.version === 1 &&
			selection.selectionComplete === true &&
			selection.evidenceComplete === true &&
			selection.executable === false &&
			Array.isArray(selection.issues) &&
			selection.issues.length === 0,
		"INCOMPLETE_SELECTION",
	);
	check(
		selection.narratorId === header.narratorId && selection.requestedByUserId === input.userId,
		"SELECTION_OWNER",
	);
	check(
		selection.metadataDigest === manifest.selectionMetadataDigest &&
			equal(selection.messageVersions, manifest.messageVersions),
		"SELECTION_COMMITMENT",
	);
	check(
		equal(selection.selector, selector.fixedSelector) &&
			equal(selection.boundary, selector.boundary),
		"FIXED_SELECTOR",
	);
	check(selection.selector.kind === header.selectorKind, "SELECTOR_KIND");
	selectorValid(selection.selector);
	selectorValid(selector.request.selector);
	if (header.kind === "rollback_to_block")
		check(header.selectorKind === "after_block", "BLOCK_SELECTOR");
	keys(selection.history, ["messages", "blocks", "toolChanges", "associations", "budget"]);
	const history = selection.history;
	array(history.messages, LIMIT.historyMessageRefChanges);
	for (const value of [
		history.blocks,
		history.toolChanges,
		selection.tools,
		selection.operations,
		selection.effects,
		selection.noDiskTools,
		selection.messageVersions,
	])
		array(value, LIMIT.historyToolRelatedChanges);
	array(
		history.associations,
		2 * (LIMIT.historyMessageRefChanges + LIMIT.historyToolRelatedChanges),
	);
	keys(history.budget, ["messageRefChanges", "relatedRows", "cowBytes"]);
	integer(history.budget.messageRefChanges, LIMIT.historyMessageRefChanges);
	integer(history.budget.relatedRows, LIMIT.historyToolRelatedChanges);
	integer(history.budget.cowBytes, LIMIT.historyCowBytes);
	check(
		selection.messageVersions.some(
			(row: { narratorId: string; messageVersion: number }) =>
				row.narratorId === header.narratorId &&
				row.messageVersion === header.expectedMessageVersion,
		),
		"ROOT_VERSION",
	);

	array(manifest.files, LIMIT.revertFiles);
	check(
		manifest.files.length === header.expectedFileCount &&
			input.files.length === header.expectedFileCount,
		"FILE_COUNT",
	);
	const bySequence = new Map(input.files.map((file) => [file.sequence, file]));
	check(bySequence.size === input.files.length, "DUPLICATE_SEQUENCE");
	const refs = new Map<string, FileChangeBlobRef>();
	let evidenceBytes = input.raw.reduce((sum, raw) => sum + raw.ref.sizeBytes, 0);
	const chargeState = (state: FileChangeState) => {
		stateValid(state);
		if (state.kind !== "regular") return;
		const old = refs.get(state.blob.digest);
		check(!old || old.sizeBytes === state.blob.sizeBytes, "REF_CONFLICT");
		refs.set(state.blob.digest, state.blob);
		evidenceBytes += state.blob.sizeBytes;
		integer(evidenceBytes, LIMIT.operationEvidenceBytes);
	};
	const manifestBytes = evidenceBytes;
	const effects = new Map<string, RevertSelectionResult["effects"][number]>();
	for (const effect of selection.effects as RevertSelectionResult["effects"]) {
		check(!effects.has(effect.id), "DUPLICATE_EFFECT");
		effects.set(effect.id, effect);
		for (const state of [
			effect.before,
			effect.intendedAfter,
			effect.observedAfter,
			...(effect.executionReceipt ? [effect.executionReceipt.observedAfter] : []),
		])
			chargeState(state);
	}
	let declaredBytes = 0;
	for (const operation of selection.operations as RevertSelectionResult["operations"]) {
		integer(operation.evidenceBytes, LIMIT.operationEvidenceBytes);
		declaredBytes += operation.evidenceBytes;
		integer(declaredBytes, LIMIT.operationEvidenceBytes);
	}
	evidenceBytes += Math.max(0, declaredBytes - (evidenceBytes - manifestBytes));
	integer(evidenceBytes, LIMIT.operationEvidenceBytes);
	const usedEffects = new Set<string>();
	const files: TransactionManifestFile[] = manifest.files.map(
		(
			file: TransactionManifestFile & {
				steps: { effectId: string; mutationId: string; scopeRevision: number; method: string }[];
			},
			index: number,
		) => {
			keys(file, [
				"sequence",
				"identity",
				"expected",
				"desired",
				"executionBinding",
				"scopeRevision",
				"steps",
			]);
			check(file.sequence === index, "FILE_ORDER");
			const row = bySequence.get(index);
			check(
				!!row &&
					row.status === "prepared" &&
					row.receiptJson === null &&
					row.observedAfterStateJson === null &&
					row.compensationAfterStateJson === null,
				"ALREADY_ATTEMPTED",
			);
			check(
				equal(file.identity, row?.identityJson) &&
					equal(file.expected, row?.expectedStateJson) &&
					equal(file.desired, row?.desiredStateJson),
				"FILE_METADATA",
			);
			// Filesystem grammars only. The caller's scopeIdentity() additionally binds
			// every file to the live local backend's flavor before any target IO.
			check(
				file.identity.deviceId === "local" &&
					(file.identity.pathFlavor === "posix" || file.identity.pathFlavor === "windows") &&
					file.identity.objectRole === "referent",
				"UNSUPPORTED_TARGET",
			);
			keys(file.executionBinding, [
				"deviceId",
				"runtimeEpoch",
				"runtimeGeneration",
				"fencingToken",
			]);
			check(
				file.executionBinding.deviceId === "local" &&
					typeof file.executionBinding.runtimeEpoch === "string" &&
					file.executionBinding.runtimeEpoch.length > 0,
				"RUNTIME",
			);
			integer(file.scopeRevision, Number.MAX_SAFE_INTEGER - 1);
			integer(file.executionBinding.fencingToken, Number.MAX_SAFE_INTEGER - 1);
			integer(file.executionBinding.runtimeGeneration, Number.MAX_SAFE_INTEGER);
			chargeState(file.expected);
			chargeState(file.desired);
			const binding = [
				operation.id,
				operation.requestDigest,
				operation.planHash,
				fileChangeIdentityKey(file.identity),
				index,
			];
			for (const phase of ["apply", "compensate"] as const) {
				const states =
					phase === "apply" ? [file.expected, file.desired] : [file.desired, file.expected];
				check(
					row?.[phase === "apply" ? "applyMutationId" : "compensateMutationId"] ===
						digest(["revert-mutation-v1", ...binding, phase]),
					"PHASE_ID",
				);
				check(
					row?.[phase === "apply" ? "applyRequestDigest" : "compensateRequestDigest"] ===
						digest(["revert-request-v1", ...binding, phase, ...states]),
					"PHASE_DIGEST",
				);
			}
			array(file.steps, LIMIT.historyToolRelatedChanges);
			let previous = Number.MAX_SAFE_INTEGER;
			let snapshotDesired: FileChangeState = file.expected;
			let previousChanged = Number.MAX_SAFE_INTEGER;
			for (const step of file.steps) {
				keys(step, ["effectId", "mutationId", "scopeRevision", "method"]);
				const effect = effects.get(step.effectId);
				check(
					!!effect &&
						!usedEffects.has(step.effectId) &&
						equal(effect.identity, file.identity) &&
						effect.mutationId === step.mutationId &&
						effect.scopeRevision === step.scopeRevision &&
						step.scopeRevision <= previous,
					"EFFECT_BINDING",
				);
				check(
					["restore_before", "restore_snapshot", "merge", "already_before", "no_change"].includes(
						step.method,
					),
					"STEP_METHOD",
				);
				if (selector.request.recoveryMode === "snapshot") {
					if (effect.outcome === "no_change") {
						check(
							(hasConfirmedNoFileChange(effect) || hasSettledMeasuredFileEffect(effect)) &&
								step.method === "no_change",
							"STEP_METHOD",
						);
					} else {
						check(
							hasSettledMeasuredFileEffect(effect) && step.method === "restore_snapshot",
							"STEP_METHOD",
						);
						check(step.scopeRevision < previousChanged, "EFFECT_BINDING");
						previousChanged = step.scopeRevision;
						snapshotDesired = effect.before;
					}
				} else check(step.method !== "restore_snapshot", "STEP_METHOD");
				previous = step.scopeRevision;
				usedEffects.add(step.effectId);
			}
			check(file.steps.length > 0, "EMPTY_FILE_SELECTION");
			if (selector.request.recoveryMode === "snapshot")
				check(equal(file.desired, snapshotDesired), "SNAPSHOT_TARGET_CONFLICT");
			return {
				sequence: file.sequence,
				identity: file.identity,
				expected: file.expected,
				desired: file.desired,
				executionBinding: file.executionBinding,
				scopeRevision: file.scopeRevision,
			};
		},
	);
	check(usedEffects.size === effects.size, "OMITTED_EFFECT");
	const fingerprint = fingerprintRevertPlanFiles(
		files.map(({ sequence, identity, expected, desired }) => ({
			sequence,
			identity,
			expected,
			desired,
		})),
	);
	check(
		fingerprint.orderedFilesDigest === proof.orderedFilesDigest &&
			fingerprint.fileEvidenceBytes === proof.fileEvidenceBytes,
		"FILE_FINGERPRINT",
	);
	// Expected/desired are already charged above. Matching apply/compensation observations
	// reuse those typed states; only later independent third-state evidence grows the budget.
	integer(evidenceBytes, LIMIT.operationEvidenceBytes);
	return { header, proof, selection, files, rawRefs: [...refs.values()], evidenceBytes };
}

function validateRecoveryPolicy(
	request: {
		recoveryMode?: unknown;
		kind: "revert" | "history_delete" | "rollback_to_block";
		uiAction?: FileChangeRevertAction;
		selector: RevertSelectionResult["selector"];
	},
	acceptSnapshotRestore?: true,
) {
	check(
		["revert", "history_delete", "rollback_to_block"].includes(request.kind) &&
			(request.recoveryMode === undefined ||
				(request.recoveryMode === "snapshot" && request.uiAction !== undefined)),
		"RECOVERY_MODE",
	);
	if (request.uiAction !== undefined)
		check(
			["revert_files", "rollback_to_block", "delete_tool_block"].includes(request.uiAction) &&
				fileChangeRevertActionMatches(request.uiAction, request.kind, request.selector),
			"ACTION_MISMATCH",
		);
	check(
		request.recoveryMode !== "snapshot" || acceptSnapshotRestore === true,
		"SNAPSHOT_CONFIRMATION_REQUIRED",
	);
}

function selectorValid(value: RevertSelectionResult["selector"]) {
	switch (value?.kind) {
		case "all":
			keys(value, ["kind"]);
			break;
		case "from_seq":
			keys(value, ["kind", "minSeq"]);
			integer(value.minSeq, Number.MAX_SAFE_INTEGER);
			break;
		case "messages":
			keys(value, ["kind", "messageIds"]);
			array(value.messageIds, LIMIT.historyMessageRefChanges);
			break;
		case "tool_calls":
			keys(value, ["kind", "toolCallIds"]);
			array(value.toolCallIds, LIMIT.historyToolRelatedChanges);
			break;
		case "after_block":
			keys(value, ["kind", "messageId", "keepThroughBlockIndex"]);
			check(typeof value.messageId === "string" && value.messageId.length > 0, "SELECTOR");
			integer(value.keepThroughBlockIndex + 1, LIMIT.historyToolRelatedChanges + 1);
			break;
		default:
			throw new Error("SELECTOR");
	}
}
function stateValid(state: FileChangeState) {
	if (state?.kind === "absent") {
		keys(state, ["kind"]);
		return;
	}
	check(state?.kind === "regular", "UNSUPPORTED_STATE");
	if (state.kind !== "regular") return;
	keys(state, ["kind", "mode", "blob"]);
	integer(state.mode as number, 0o7777);
	refValid(state.blob);
}
function refValid(ref: FileChangeBlobRef) {
	keys(ref, ["algorithm", "digest", "sizeBytes"]);
	check(ref.algorithm === "sha256" && /^[a-f0-9]{64}$/.test(ref.digest), "REF_INVALID");
	integer(ref.sizeBytes, LIMIT.blobBytes);
}
function bounded(value: unknown, depth = 0): void {
	check(depth <= 24, "DEPTH");
	if (typeof value === "string")
		check(Buffer.byteLength(value) <= LIMIT.metadataBytes, "SCALAR_LIMIT");
	else if (Array.isArray(value)) {
		array(value, 30_000);
		for (const item of value) bounded(item, depth + 1);
	} else if (value && typeof value === "object") {
		check(Object.keys(value).length <= 100, "KEY_LIMIT");
		for (const [key, item] of Object.entries(value)) {
			check(key !== "__proto__" && key !== "constructor" && key.length <= 100, "KEY");
			bounded(item, depth + 1);
		}
	}
}
function keys(value: object, required: string[], optional: string[] = []) {
	check(!!value && typeof value === "object" && !Array.isArray(value), "OBJECT");
	check(
		required.every((key) => Object.hasOwn(value, key)) &&
			Object.keys(value).every((key) => required.includes(key) || optional.includes(key)),
		"KEYS",
	);
}
function array(value: unknown, max: number): asserts value is unknown[] {
	check(Array.isArray(value) && value.length <= max, "ARRAY_LIMIT");
}
function integer(value: number, max: number) {
	check(Number.isSafeInteger(value) && value >= 0 && value <= max, "BUDGET");
}
function check(value: unknown, code: string): asserts value {
	if (!value) throw new Error(code);
}
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
function equal(a: unknown, b: unknown) {
	return canonical(a) === canonical(b);
}
function hash(value: Uint8Array | string) {
	return createHash("sha256").update(value).digest("hex");
}
function digest(value: unknown) {
	return hash(canonical(value));
}
