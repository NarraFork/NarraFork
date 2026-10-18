import { expect, test } from "bun:test";
import {
	EDITOR_APPLY_OUTCOMES,
	EDITOR_BOUNDED_READ_CAPABILITIES,
	EDITOR_LOCAL_V1_CAPABILITIES,
	EDITOR_METADATA_POLICIES,
	EDITOR_NO_CAPABILITIES,
	EDITOR_PATH_FLAVORS,
	EDITOR_PROVIDER_ERRORS,
	EDITOR_QUERY_OUTCOMES,
	EDITOR_STAGE_ABORT_REASONS,
	EDITOR_WATCH_REASONS,
	type EditorApplyRequest,
	type EditorApplyResult,
	type EditorProviderCapabilities,
	type EditorQueryRequest,
	type EditorQueryResult,
	type EditorRawReadChunk,
	type EditorRawReadChunkRequest,
	type EditorRawReadClose,
	type EditorRawReadOpen,
	type EditorRawReadPreflight,
	type EditorResourceIdentity,
	type EditorStageAbort,
	type EditorStageAppend,
	type EditorStageHandle,
	type EditorStageOpen,
	type EditorStageSeal,
	type EditorWatchClose,
	type EditorWatchHandle,
	type EditorWatchNotify,
	type EditorWatchOpen,
} from "./editor-provider-contracts";
import golden from "./editor-provider-contracts.golden.json";

// JSON imports widen string literals. Narrow only enum values with a runtime
// check; do not cast whole objects, which would hide missing required fields.
function member<T extends string>(values: readonly T[], value: string): T {
	for (const item of values) if (item === value) return item;
	throw new Error(`Unknown wire enum: ${value}`);
}
const identity = (
	value: Omit<EditorResourceIdentity, "pathFlavor"> & { pathFlavor: string },
): EditorResourceIdentity => ({
	...value,
	pathFlavor: member(EDITOR_PATH_FLAVORS, value.pathFlavor),
});
const applyResult = (
	value: Omit<EditorApplyResult, "outcome"> & { outcome: string },
): EditorApplyResult => ({ ...value, outcome: member(EDITOR_APPLY_OUTCOMES, value.outcome) });

// Compile-time check (tsgo): every fixture case must be assignable to its real
// wire type, and the full case set must be listed here. Go strictly decodes and
// re-encodes the same artifact, including nullable and omitted fields.
const typed = {
	capabilitiesNone: golden.capabilitiesNone,
	capabilitiesLocalV1: golden.capabilitiesLocalV1,
	capabilitiesBoundedRead: golden.capabilitiesBoundedRead,
	identityPosix: identity(golden.identityPosix),
	rawReadPreflight: {
		...golden.rawReadPreflight,
		identity: identity(golden.rawReadPreflight.identity),
	},
	rawReadOpen: { ...golden.rawReadOpen, identity: identity(golden.rawReadOpen.identity) },
	rawReadChunkRequest: golden.rawReadChunkRequest,
	rawReadChunkEof: golden.rawReadChunkEof,
	rawReadClose: golden.rawReadClose,
	stageOpen: golden.stageOpen,
	stageHandle: golden.stageHandle,
	stageAppend: golden.stageAppend,
	stageSeal: golden.stageSeal,
	stageAbort: {
		...golden.stageAbort,
		reason: member(EDITOR_STAGE_ABORT_REASONS, golden.stageAbort.reason),
	},
	applyCreate: {
		...golden.applyCreate,
		identity: identity(golden.applyCreate.identity),
		metadataPolicy: member(EDITOR_METADATA_POLICIES, golden.applyCreate.metadataPolicy),
	},
	applyReplace: {
		...golden.applyReplace,
		identity: identity(golden.applyReplace.identity),
		metadataPolicy: member(EDITOR_METADATA_POLICIES, golden.applyReplace.metadataPolicy),
	},
	applyCommitted: applyResult(golden.applyCommitted),
	applyUncertain: applyResult(golden.applyUncertain),
	queryRequest: golden.queryRequest,
	queryNotFound: {
		...golden.queryNotFound,
		outcome: member(EDITOR_QUERY_OUTCOMES, golden.queryNotFound.outcome),
	},
	queryCommitted: {
		...golden.queryCommitted,
		outcome: member(EDITOR_QUERY_OUTCOMES, golden.queryCommitted.outcome),
		result: applyResult(golden.queryCommitted.result),
	},
	watchOpen: golden.watchOpen,
	watchHandle: golden.watchHandle,
	watchNotify: {
		...golden.watchNotify,
		reason: member(EDITOR_WATCH_REASONS, golden.watchNotify.reason),
	},
	watchClose: golden.watchClose,
	enums: golden.enums,
} satisfies Record<keyof typeof golden, unknown> & {
	capabilitiesNone: EditorProviderCapabilities;
	capabilitiesLocalV1: EditorProviderCapabilities;
	capabilitiesBoundedRead: EditorProviderCapabilities;
	identityPosix: EditorResourceIdentity;
	rawReadPreflight: EditorRawReadPreflight;
	rawReadOpen: EditorRawReadOpen;
	rawReadChunkRequest: EditorRawReadChunkRequest;
	rawReadChunkEof: EditorRawReadChunk;
	rawReadClose: EditorRawReadClose;
	stageOpen: EditorStageOpen;
	stageHandle: EditorStageHandle;
	stageAppend: EditorStageAppend;
	stageSeal: EditorStageSeal;
	stageAbort: EditorStageAbort;
	applyCreate: EditorApplyRequest;
	applyReplace: EditorApplyRequest;
	applyCommitted: EditorApplyResult;
	applyUncertain: EditorApplyResult;
	queryRequest: EditorQueryRequest;
	queryNotFound: EditorQueryResult;
	queryCommitted: EditorQueryResult;
	watchOpen: EditorWatchOpen;
	watchHandle: EditorWatchHandle;
	watchNotify: EditorWatchNotify;
	watchClose: EditorWatchClose;
};

test("fixture case set is exactly the typed case set", () => {
	expect(Object.keys(typed).sort()).toEqual(Object.keys(golden).sort());
});

test("capability presets match the shared fixture and nothing unimplemented is true", () => {
	expect(typed.capabilitiesNone).toEqual({ ...EDITOR_NO_CAPABILITIES });
	expect(typed.capabilitiesLocalV1).toEqual({ ...EDITOR_LOCAL_V1_CAPABILITIES });
	expect(typed.capabilitiesBoundedRead).toEqual({ ...EDITOR_BOUNDED_READ_CAPABILITIES });
	for (const caps of [EDITOR_LOCAL_V1_CAPABILITIES, EDITOR_BOUNDED_READ_CAPABILITIES])
		for (const key of ["rawRead", "stage", "durableApply", "durableQuery", "watch"] as const)
			expect([key, caps[key]]).toEqual([key, false]);
});

test("string unions and error codes equal the fixture enums used by Go", () => {
	expect(typed.enums).toEqual({
		pathFlavors: [...EDITOR_PATH_FLAVORS],
		stageAbortReasons: [...EDITOR_STAGE_ABORT_REASONS],
		metadataPolicies: [...EDITOR_METADATA_POLICIES],
		applyOutcomes: [...EDITOR_APPLY_OUTCOMES],
		queryOutcomes: [...EDITOR_QUERY_OUTCOMES],
		watchReasons: [...EDITOR_WATCH_REASONS],
		errors: Object.values(EDITOR_PROVIDER_ERRORS),
	});
	const values = (field: string) =>
		Object.values(golden).flatMap((value) =>
			value && typeof value === "object" && field in value
				? [(value as Record<string, unknown>)[field]]
				: [],
		);
	for (const reason of values("reason"))
		expect([...EDITOR_STAGE_ABORT_REASONS, ...EDITOR_WATCH_REASONS]).toContain(reason as never);
	for (const policy of values("metadataPolicy"))
		expect(EDITOR_METADATA_POLICIES).toContain(policy as never);
});

test("required-null fields are present as null; optional error is omitted, not null", () => {
	const wire = JSON.parse(JSON.stringify(typed));
	expect(wire).toEqual(golden);
	const committed: EditorApplyResult = { ...typed.applyCommitted, error: undefined };
	expect(JSON.parse(JSON.stringify(committed))).toEqual(golden.applyCommitted);
	expect(wire.applyCreate).toHaveProperty("expectedRawHash", null);
	expect(typed.applyUncertain).toMatchObject({ rawDigest: null, totalBytes: null });
	expect(typed.queryNotFound).toHaveProperty("result", null);
	expect(typed.queryNotFound.outcome).not.toBe("proven_not_executed");
	expect("error" in typed.applyCommitted).toBe(false);
	expect("error" in (typed.queryCommitted.result as EditorApplyResult)).toBe(false);
	// Watch notifications are opaque: ids/seq/generation/reason only.
	expect(Object.keys(typed.watchNotify).sort()).toEqual([
		"generation",
		"reason",
		"seq",
		"subscriptionId",
	]);
});
