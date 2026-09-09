import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
	FILE_CHANGE_EVIDENCE_VERSION,
	FILE_CHANGE_LIMITS,
	type FileChangeBlobRef,
	type FileChangeExecutionBinding,
	type FileChangeIdentity,
	type FileChangeRevertAction,
	type FileChangeRevertSelector,
	type FileChangeState,
	fileChangeRevertActionMatches,
	fileChangeStatesEqual,
	hasConfirmedNoFileChange,
	type KnownFileChangeState,
} from "@shared/file-change-protocol";
import { AppError } from "../lib/errors";
import type { FileChangeBlobCatalog } from "./file-change-blob-catalog";
import type { FileChangeBlobStore } from "./file-change-blob-store";
import { fileChangeExecutionBindingMatches, fileChangeIdentityKey } from "./file-change-identity";
import {
	FileChangeReversalCalculator,
	type FileChangeReversalEffect,
	type FileChangeReversalStep,
} from "./file-change-reversal";
import type { NarratorPrincipal } from "./narrator-acl";
import {
	type AppendRevertPlanFile,
	fingerprintRevertPlanFiles,
	type RevertPlanHeader,
	type RevertPlanManifestProof,
	type RevertPlanOwner,
	RevertPlanService,
	type RevertPlanSummary,
	revertPlanHeaderDigest,
} from "./revert-plan-service";
import {
	type RevertSelectionOptions,
	type RevertSelectionResult,
	RevertSelectionService,
} from "./revert-selection-service";

export interface RevertPlannerRequest {
	/** Authenticated route context, rechecked by the required authentication adapter. */
	principal: NarratorPrincipal;
	narratorId: string;
	expectedMessageVersion: number;
	idempotencyKey: string;
	kind: "revert" | "history_delete" | "rollback_to_block";
	revertScope: "narrator";
	selector: FileChangeRevertSelector;
	/** Server-selected UI entrypoint, persisted inside the original request commitment. */
	uiAction?: FileChangeRevertAction;
	signal?: AbortSignal;
}
export interface RevertPlannerFileAccess {
	principal: NarratorPrincipal;
	owner: RevertPlanOwner;
	identity: FileChangeIdentity;
	signal: AbortSignal;
}
/** Actual authorized backend capability, NOT an unverified path or a subject label. */
export interface RevertPlannerFileTarget {
	identity: FileChangeIdentity;
	executionBinding: FileChangeExecutionBinding;
	scopeRevision: number;
	/** Must check live scope incarnation, canonical target, runtime/fence and write activity.
	 * Reconnecting to another backend or resolving a remote path locally MUST fail. */
	assertCurrent(options: { signal: AbortSignal }): Promise<void>;
	/** Read only, bounded, cancellation-aware actual IO. The raw bytes are NOT yet required
	 * to be in the catalog: this planner verifies and publishes them. Do not publish or
	 * write DB metadata here; the final read occurs inside a read-only freshness window. */
	readCurrent(options: {
		signal: AbortSignal;
		maxBytes: number;
	}): Promise<{ state: FileChangeState; raw: Uint8Array | null }>;
}
export interface RevertPlannerAccess {
	/** Validate that this principal still represents an authenticated, enabled user. */
	authenticate(principal: NarratorPrincipal, signal: AbortSignal): Promise<void>;
	authorizeNarrator: RevertSelectionOptions["authorize"];
	/** Resolve the real project (including chapter context) and enforce its write gate.
	 * Null must mean truly standalone, never lookup/authorization failure. */
	resolveContext(input: {
		principal: NarratorPrincipal;
		narratorId: string;
		signal: AbortSignal;
	}): Promise<{ projectId: string | null }>;
	/** Enforce file/device/project authorization, not just narrator read permission. */
	authorizeFile(input: RevertPlannerFileAccess): Promise<void>;
	resolveFile(input: RevertPlannerFileAccess): Promise<RevertPlannerFileTarget>;
}
export interface RevertPlannerOptions {
	access: RevertPlannerAccess;
	/** These must share the SAME physically verified, catalog-admitted namespace. */
	blobStore: FileChangeBlobStore;
	blobCatalog: FileChangeBlobCatalog;
	generation: number;
	planOptions: ConstructorParameters<typeof RevertPlanService>[1];
	/** Trusted configuration can only lower shared limits, never HTTP overrides. */
	maxEvidenceBytes?: number;
	timeoutMs?: number;
	onSlow?: (event: {
		service: "revert-planner";
		durationMs: number;
		evidenceBytes: number;
	}) => void;
}
export interface RevertPlannerResult {
	plan: RevertPlanSummary;
	/** Prepared is a durable preview, NOT execution admission or a history/files mutation. */
	executable: false;
	historySummary: { deletedMessageCount: number; deletedBlockCount: number };
}
export class RevertPlannerError extends AppError {
	constructor(code: string, message: string) {
		super(message, 409, `REVERT_PLANNER_${code}`);
		this.name = "RevertPlannerError";
	}
}
type FixedRequest = Omit<RevertPlannerRequest, "signal">;
type PreparedFile = AppendRevertPlanFile & {
	executionBinding: FileChangeExecutionBinding;
	scopeRevision: number;
	steps: FileChangeReversalStep[];
};
type FileContext = { access: RevertPlannerFileAccess; target: RevertPlannerFileTarget };
type CalculationContext = FileContext & { work: Work; maxOutputBytes: number };

/** Dormant, dependency-injected M3 preview composition. There is no application DB import,
 * default-allow ACL, remote-to-local fallback, workspace capture guess or unrevert replay.
 * Unknown candidates are rejected BEFORE any complete plan declaration. All original
 * selection metadata, no_dispatch records, receipts and versions survive in raw manifests.
 *
 * Raw publication may leave unreferenced immutable objects on failure; it never writes the
 * workspace/history. Only after ALL files compute, the three original manifests verify,
 * selection is collected again, ACL/runtime/current bytes revalidate, does preparation start.
 * The scan stages never overlap this request's own catalog publications.
 *
 * The final executor STILL has to reauthorize, acquire coordination, recheck this entire
 * fixed selection/current bytes and journal its mutations. This is not a filesystem CAS,
 * execution endpoint or cross-file atomicity claim. Failed preparation retains planned pins.
 */
export class RevertPlannerService {
	private readonly selection: RevertSelectionService;
	private readonly plans: RevertPlanService;
	private readonly reversal: FileChangeReversalCalculator;
	private readonly calculation = new AsyncLocalStorage<CalculationContext>();
	private readonly maxEvidenceBytes: number;
	private readonly timeoutMs: number;
	private active = 0;

	constructor(
		private readonly database: ConstructorParameters<typeof RevertPlanService>[0],
		private readonly options: RevertPlannerOptions,
	) {
		for (const name of [
			"authenticate",
			"authorizeNarrator",
			"resolveContext",
			"authorizeFile",
			"resolveFile",
		] as const)
			if (typeof options.access?.[name] !== "function")
				throw fail(
					"AUTHORIZATION_REQUIRED",
					"Real authentication and backend adapters are required",
				);
		this.maxEvidenceBytes = options.maxEvidenceBytes ?? FILE_CHANGE_LIMITS.operationEvidenceBytes;
		integer(this.maxEvidenceBytes, 1, FILE_CHANGE_LIMITS.operationEvidenceBytes);
		this.timeoutMs = options.timeoutMs ?? 60_000;
		integer(this.timeoutMs, 1, FILE_CHANGE_LIMITS.planLifetimeMs);
		this.selection = new RevertSelectionService(database, {
			authorize: (principal, row, need, signal) =>
				options.access.authorizeNarrator(principal, row, need, signal),
		});
		this.plans = new RevertPlanService(database, options.planOptions);
		const context = () => {
			const active = this.calculation.getStore();
			if (!active) throw fail("INTERNAL_CONTEXT", "Reversal IO needs its authorized file context");
			return active;
		};
		// ONE calculator for the whole planner. A per-file cap is reserved from the SHARED
		// remaining budget before calculate, bounding every private intermediate output too.
		// The calculator reads this option on each merge; ALS isolates simultaneous requests.
		this.reversal = new FileChangeReversalCalculator({
			readBlob: async (ref, { signal }) => {
				const active = context();
				await this.guard(active, active.work, signal);
				return this.readBlob(ref, active.work, signal);
			},
			publishBlob: async (bytes, input) => {
				const active = context();
				await this.guard(active, active.work, input.signal);
				const ref = await active.work.wait(options.blobStore.putBytes(bytes, input));
				this.ready(ref);
				return ref;
			},
			mergeOptions: {
				get maxOutputBytes() {
					return context().maxOutputBytes;
				},
			},
		});
	}

	async prepare(request: RevertPlannerRequest): Promise<RevertPlannerResult> {
		const fixed = snapshotRequest(request);
		const work = new Work(
			AbortSignal.any([
				...(request.signal ? [request.signal] : []),
				AbortSignal.timeout(this.timeoutMs),
			]),
			this.maxEvidenceBytes,
		);
		work.check();
		if (this.active >= FILE_CHANGE_LIMITS.captureConcurrency)
			throw fail("BUSY", "Too many preview preparations; retry without changing the request");
		this.active++;
		const started = performance.now();
		try {
			const owner = await this.owner(fixed, work);
			const original = await encodeJson({ version: 1, owner, request: fixed }, work);
			work.charge(original.ref.sizeBytes);
			const requestDigest = original.ref.digest;
			this.checkIdempotency(owner, fixed.idempotencyKey, requestDigest);
			const selected = await work.wait(this.selection.collect({ ...fixed, signal: work.signal }));
			complete(selected);
			const groups = new Map<string, FileChangeReversalEffect[]>();
			let selectedRawBytes = 0;
			let processedEffects = 0;
			for (const effect of selected.effects) {
				if (processedEffects++ % FILE_CHANGE_LIMITS.historyPageItems === 0) {
					await yieldToEventLoop();
					work.check();
				}
				Object.freeze(effect.identity);
				const key = fileChangeIdentityKey(effect.identity);
				const group = groups.get(key);
				if (group && group[0].identity.scopeId !== effect.identity.scopeId)
					throw fail("IDENTITY_MISMATCH", "The same file key cannot merge different scopes");
				if (group) group.push(effect);
				else groups.set(key, [effect]);
				for (const state of effectStates(effect)) {
					// A measured content delta is not proof of unmeasured object metadata.
					// In particular, null mode must not produce an executable restore state.
					knownState(state);
					const bytes = stateBytes(state);
					work.charge(bytes);
					selectedRawBytes += bytes;
				}
				if (groups.size > FILE_CHANGE_LIMITS.revertFiles)
					throw fail("BUDGET_EXCEEDED", "The complete file set exceeds the shared limit");
			}
			const declaredRawBytes = selected.operations.reduce(
				(sum, operation) => sum + operation.evidenceBytes,
				0,
			);
			work.charge(Math.max(0, declaredRawBytes - selectedRawBytes));
			// The history manifest is the COMPLETE collector result, including effect sources,
			// COW block identities, non-disk candidates and explicit (empty only on success) issues.
			const history = await encodeJson(selected, work);
			work.charge(history.ref.sizeBytes);
			const selector = await encodeJson(
				{
					version: 1,
					owner,
					request: fixed,
					fixedSelector: selected.selector,
					boundary: selected.boundary,
				},
				work,
			);
			work.charge(selector.ref.sizeBytes);
			const files: PreparedFile[] = [];
			for (const [, effects] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
				const identity = effects[0].identity;
				const context = await this.target(fixed, owner, identity, work);
				const observed = await this.current(
					context,
					work,
					Math.min(FILE_CHANGE_LIMITS.blobBytes, work.remaining),
				);
				work.charge(stateBytes(observed.state));
				if (observed.raw) {
					const ref = stateRef(observed.state);
					if (!ref) throw fail("STATE_UNKNOWN", "Raw bytes require a known object state");
					await work.wait(
						this.options.blobStore.putBytes(observed.raw, {
							signal: work.signal,
							expectedDigest: ref.digest,
							expectedSize: ref.sizeBytes,
						}),
					);
					this.ready(ref);
				}
				// Verify even intendedAfter / original receipt objects that a reverse shortcut
				// would otherwise not need to read. A catalog row alone is not raw evidence.
				const refs = new Map<string, FileChangeBlobRef>();
				for (const effect of effects)
					for (const state of effectStates(effect)) {
						const ref = stateRef(state);
						if (ref) refs.set(ref.digest, ref);
					}
				for (const ref of refs.values()) {
					await this.guard(context, work);
					await this.readBlob(ref, work);
				}
				const merges = effects.filter((effect) => effect.outcome === "changed").length;
				const cap = merges
					? Math.min(FILE_CHANGE_LIMITS.blobBytes, Math.floor(work.remaining / merges))
					: 0;
				const reserved = merges * cap;
				work.charge(reserved);
				const result = await this.calculation.run({ ...context, work, maxOutputBytes: cap }, () =>
					this.reversal.calculate({
						identity,
						current: observed.state,
						effects,
						signal: work.signal,
					}),
				);
				work.check();
				if (!result.ok)
					throw fail("REVERSAL_REFUSED", `Complete reversal refused: ${result.reason}`);
				const baseline =
					stateBytes(observed.state) +
					effects.reduce(
						(sum, effect) =>
							sum +
							(hasConfirmedNoFileChange(effect)
								? 0
								: stateBytes(effect.before) + stateBytes(effect.observedAfter)),
						0,
					);
				const intermediateBytes = result.evidenceBytes - baseline;
				integer(intermediateBytes, 0, reserved);
				work.release(reserved);
				work.charge(intermediateBytes);
				work.charge(stateBytes(result.desired));
				files.push({
					sequence: files.length,
					identity,
					expected: result.expected,
					desired: result.desired,
					executionBinding: context.target.executionBinding,
					scopeRevision: context.target.scopeRevision,
					steps: result.steps,
				});
				await yieldToEventLoop();
			}
			// No plan/header claims completeness until every selected file succeeded.
			const ordered = files.map(({ sequence, identity, expected, desired }) => ({
				sequence,
				identity,
				expected,
				desired,
			}));
			await yieldToEventLoop();
			work.check();
			// This helper hashes bounded per-file metadata (<=1000 x 8KiB), never
			// serialized source bodies. Large manifest serialization below is chunked.
			const fingerprint = fingerprintRevertPlanFiles(ordered);
			await yieldToEventLoop();
			work.check();
			const header: RevertPlanHeader = {
				...owner,
				idempotencyKey: fixed.idempotencyKey,
				requestDigest,
				kind: fixed.kind,
				revertScope: fixed.revertScope,
				selectorKind: selected.selector.kind,
				selector: selector.ref,
				historyManifest: history.ref,
				expectedMessageVersion: fixed.expectedMessageVersion,
				expectedFileCount: files.length,
			};
			const proof: RevertPlanManifestProof = {
				source: "trusted_published_planner_v1",
				headerDigest: revertPlanHeaderDigest(header),
				orderedFilesDigest: fingerprint.orderedFilesDigest,
				fileEvidenceBytes: fingerprint.fileEvidenceBytes,
				computation: "complete",
				selectorCoverage: "complete",
				historyCoverage: "complete",
				omittedFiles: 0,
				unknownFiles: 0,
			};
			const manifest = await encodeJson(
				{
					version: 1,
					protocolVersion: FILE_CHANGE_EVIDENCE_VERSION,
					header,
					proof,
					selectionMetadataDigest: selected.metadataDigest,
					messageVersions: selected.messageVersions,
					files,
				},
				work,
			);
			work.charge(manifest.ref.sizeBytes);
			for (const raw of [selector, history, manifest]) await this.publish(raw, work);
			// Publication writes total_changes. Finish it BEFORE opening the second scan.
			const reselected = await work.wait(this.selection.collect({ ...fixed, signal: work.signal }));
			complete(reselected);
			if (reselected.metadataDigest !== selected.metadataDigest)
				throw fail("STALE", "The complete source selection changed; preview again");
			const stamp = this.stamp();
			const freshOwner = await this.owner(fixed, work);
			if (freshOwner.projectId !== owner.projectId)
				throw fail("STALE", "The authorized project context changed");
			for (const file of files) {
				const context = await this.target(fixed, owner, file.identity, work);
				if (
					!fileChangeExecutionBindingMatches(
						file.executionBinding,
						context.target.executionBinding,
					) ||
					file.scopeRevision !== context.target.scopeRevision
				)
					throw fail("STALE", "The live runtime, fence or scope revision changed");
				const observed = await this.current(context, work);
				if (!fileChangeStatesEqual(file.expected, observed.state))
					throw fail("STALE", "Current bytes/object/mode changed; do not silently recompute");
			}
			work.check();
			if (stamp !== this.stamp())
				throw fail("STALE", "History or authorization metadata changed during final file checks");
			const plan = await this.plans.prepare(
				{ ...header, plan: manifest.ref, manifestProof: proof },
				ordered,
				{ signal: work.signal },
			);
			const deletedMessages = new Set(
				selected.history.messages
					.filter((message) => message.action === "delete" || message.action === "unlink")
					.map((message) => message.id),
			);
			return {
				plan,
				executable: false,
				historySummary: {
					deletedMessageCount: fixed.kind === "revert" ? 0 : deletedMessages.size,
					deletedBlockCount:
						fixed.kind === "revert"
							? 0
							: selected.history.blocks.filter(
									(block) => block.action === "remove" && !deletedMessages.has(block.messageId),
								).length,
				},
			};
		} finally {
			work.close(() => {
				this.active--;
			});
			const durationMs = performance.now() - started;
			if (durationMs > 1_000) {
				try {
					const event = {
						service: "revert-planner" as const,
						durationMs,
						evidenceBytes: work.used,
					};
					if (this.options.onSlow) this.options.onSlow(event);
					else console.warn("[revert-planner] slow preview preparation", event);
				} catch {
					/* Diagnostics must not invalidate an already prepared preview. */
				}
			}
		}
	}

	private async owner(request: FixedRequest, work: Work): Promise<RevertPlanOwner> {
		await work.wait(this.options.access.authenticate(request.principal, work.signal));
		const context = await work.wait(
			this.options.access.resolveContext({
				principal: request.principal,
				narratorId: request.narratorId,
				signal: work.signal,
			}),
		);
		if (context.projectId !== null) text(context.projectId);
		return Object.freeze({
			subjectKey: `human:${request.principal.userId}`,
			narratorId: request.narratorId,
			projectId: context.projectId,
		});
	}
	private checkIdempotency(owner: RevertPlanOwner, key: string, digest: string) {
		const row = this.database.$client
			.query<
				{ id: string; requestDigest: string; narratorId: string | null; projectId: string | null },
				[string, string]
			>(
				"SELECT id,request_digest AS requestDigest,narrator_id AS narratorId,project_id AS projectId FROM revert_operations WHERE requested_by_subject_key=? AND idempotency_key=? LIMIT 1",
			)
			.get(owner.subjectKey, key);
		if (!row) return;
		if (
			row.requestDigest !== digest ||
			row.narratorId !== owner.narratorId ||
			row.projectId !== owner.projectId
		)
			throw fail("REQUEST_CONFLICT", "Idempotency key belongs to another complete request/context");
		const summary = this.plans.getSummary(owner, row.id);
		if (summary.expired)
			throw fail("EXPIRED", "The original preview expired; use a new request key");
		if (summary.status !== "planned" && summary.status !== "prepared")
			throw fail("INVALID_TRANSITION", "An attempted plan cannot be prepared again");
	}
	private async target(
		request: FixedRequest,
		owner: RevertPlanOwner,
		identity: FileChangeIdentity,
		work: Work,
	): Promise<FileContext> {
		const access = { principal: request.principal, owner, identity, signal: work.signal };
		await work.wait(this.options.access.authorizeFile(access));
		const resolved = await work.wait(this.options.access.resolveFile(access));
		if (typeof resolved?.assertCurrent !== "function" || typeof resolved.readCurrent !== "function")
			throw fail(
				"BACKEND_UNAVAILABLE",
				"The authorized backend cannot verify and read this object",
			);
		if (
			fileChangeIdentityKey(resolved.identity) !== fileChangeIdentityKey(identity) ||
			resolved.identity.scopeId !== identity.scopeId ||
			resolved.executionBinding?.deviceId !== identity.deviceId ||
			!fileChangeExecutionBindingMatches(resolved.executionBinding, resolved.executionBinding)
		)
			throw fail("IDENTITY_MISMATCH", "Resolved backend identity does not match the selected file");
		integer(resolved.scopeRevision, 0, Number.MAX_SAFE_INTEGER);
		const target = {
			identity: { ...resolved.identity },
			executionBinding: { ...resolved.executionBinding },
			scopeRevision: resolved.scopeRevision,
			assertCurrent: resolved.assertCurrent.bind(resolved),
			readCurrent: resolved.readCurrent.bind(resolved),
		};
		return { access, target };
	}
	private async guard(context: FileContext, work: Work, signal = work.signal) {
		await work.wait(this.options.access.authorizeFile({ ...context.access, signal }));
		await work.wait(context.target.assertCurrent({ signal }));
	}
	private async current(context: FileContext, work: Work, maxBytes = FILE_CHANGE_LIMITS.blobBytes) {
		await this.guard(context, work);
		const observation = await work.wait(
			context.target.readCurrent({ signal: work.signal, maxBytes }),
		);
		const state = knownState(observation.state);
		const ref = stateRef(state);
		let raw: Uint8Array | null = null;
		if (ref) {
			integer(ref.sizeBytes, 0, maxBytes);
			if (!(observation.raw instanceof Uint8Array) || observation.raw.byteLength !== ref.sizeBytes)
				throw fail("BLOB_INTEGRITY", "Backend bytes do not match the declared actual state");
			raw = new Uint8Array(ref.sizeBytes);
			const hash = createHash("sha256");
			for (let offset = 0; offset < raw.length; offset += FILE_CHANGE_LIMITS.streamChunkBytes) {
				work.check();
				const end = Math.min(raw.length, offset + FILE_CHANGE_LIMITS.streamChunkBytes);
				raw.set(observation.raw.subarray(offset, end), offset);
				hash.update(raw.subarray(offset, end));
				await yieldToEventLoop();
			}
			if (hash.digest("hex") !== ref.digest)
				throw fail("BLOB_INTEGRITY", "Actual raw fingerprint mismatch");
		} else if (observation.raw !== null)
			throw fail("STATE_UNKNOWN", "Absent objects cannot have bytes");
		await this.guard(context, work);
		return { state, raw };
	}
	private ready(ref: FileChangeBlobRef) {
		const budget = this.options.blobCatalog.getBudget();
		if (
			budget?.status !== "ready" ||
			budget.generation !== this.options.generation ||
			budget.namespaceKey !== this.options.planOptions.namespaceKey
		)
			throw fail("CATALOG_UNVERIFIED", "The physical evidence namespace changed or is not ready");
		const row = this.options.blobCatalog.getMetadata({
			expectedGeneration: this.options.generation,
			ref,
		});
		if (row?.status !== "ready" || row.sizeBytes !== ref.sizeBytes)
			throw fail("BLOB_UNAVAILABLE", "The complete raw object must be published and catalog-ready");
	}
	private async readBlob(ref: FileChangeBlobRef, work: Work, signal = work.signal) {
		this.ready(ref);
		const bytes = await work.wait(
			this.options.blobStore.readBytes(ref, { signal, maxBytes: FILE_CHANGE_LIMITS.blobBytes }),
		);
		this.ready(ref);
		return bytes;
	}
	private async publish(raw: Encoded, work: Work) {
		const ref = await work.wait(
			this.options.blobStore.putStream(
				(async function* () {
					for (const chunk of raw.chunks) {
						work.check();
						yield chunk;
					}
				})(),
				{ signal: work.signal, expectedSize: raw.ref.sizeBytes, expectedDigest: raw.ref.digest },
			),
		);
		this.ready(ref);
		// putStream itself validates digest, fsyncs, publishes and rereads the original bytes.
		if (ref.digest !== raw.ref.digest || ref.sizeBytes !== raw.ref.sizeBytes)
			throw fail("BLOB_INTEGRITY", "The original manifest publication did not match");
	}
	private stamp() {
		const changes = this.database.$client
			.query<{ value: number }, []>("SELECT total_changes() AS value")
			.get()?.value;
		const version = this.database.$client
			.query<{ data_version: number }, []>("PRAGMA data_version")
			.get()?.data_version;
		return `${changes}:${version}`;
	}
}

function complete(selection: RevertSelectionResult) {
	if (
		selection.selectionComplete !== true ||
		selection.evidenceComplete !== true ||
		selection.issues.length !== 0
	)
		throw fail(
			"EVIDENCE_INCOMPLETE",
			"Every candidate needs complete, settled evidence; nothing was prepared",
		);
}
function effectStates(effect: FileChangeReversalEffect) {
	return [
		effect.before,
		effect.intendedAfter,
		effect.observedAfter,
		...(effect.executionReceipt ? [effect.executionReceipt.observedAfter] : []),
	];
}
function stateRef(state: FileChangeState): FileChangeBlobRef | null {
	return state.kind === "regular" ? state.blob : state.kind === "symlink" ? state.target : null;
}
function stateBytes(state: FileChangeState) {
	return stateRef(state)?.sizeBytes ?? 0;
}
function knownState(state: FileChangeState): KnownFileChangeState {
	if (!state || state.kind === "unknown")
		throw fail("STATE_UNKNOWN", "Current object was not measured");
	if (state.kind === "absent") return { kind: "absent" };
	if (state.kind !== "regular" && state.kind !== "symlink")
		throw fail("STATE_UNKNOWN", "Unsupported object");
	if (state.mode === null) throw fail("STATE_UNKNOWN", "Object mode was not measured");
	integer(state.mode, 0, 0o7777);
	const ref = stateRef(state);
	if (!ref || ref.algorithm !== "sha256" || !/^[a-f0-9]{64}$/.test(ref.digest))
		throw fail("BLOB_INTEGRITY", "Invalid actual raw reference");
	integer(ref.sizeBytes, 0, FILE_CHANGE_LIMITS.blobBytes);
	return state.kind === "regular"
		? { kind: "regular", mode: state.mode, blob: { ...ref } }
		: { kind: "symlink", mode: state.mode, target: { ...ref } };
}
function snapshotRequest(input: RevertPlannerRequest): FixedRequest {
	keys(input, [
		"principal",
		"narratorId",
		"expectedMessageVersion",
		"idempotencyKey",
		"kind",
		"revertScope",
		"selector",
		"uiAction",
		"signal",
	]);
	keys(input.principal, ["userId", "isAdmin"]);
	text(input.principal.userId);
	if (typeof input.principal.isAdmin !== "boolean")
		throw fail("AUTHORIZATION_REQUIRED", "Invalid authenticated principal");
	text(input.narratorId);
	text(input.idempotencyKey);
	integer(input.expectedMessageVersion, 0, Number.MAX_SAFE_INTEGER);
	if (
		input.revertScope !== "narrator" ||
		!["revert", "history_delete", "rollback_to_block"].includes(input.kind)
	)
		throw fail(
			"UNSUPPORTED",
			"Workspace capture, unrevert and regeneration require their missing execution journals",
		);
	const source = input.selector;
	let selector: FileChangeRevertSelector;
	switch (source?.kind) {
		case "all":
			keys(source, ["kind"]);
			selector = { kind: "all" };
			break;
		case "from_seq":
			keys(source, ["kind", "minSeq"]);
			integer(source.minSeq, 0, Number.MAX_SAFE_INTEGER);
			selector = { kind: "from_seq", minSeq: source.minSeq };
			break;
		case "after_block":
			keys(source, ["kind", "messageId", "keepThroughBlockIndex"]);
			text(source.messageId);
			integer(source.keepThroughBlockIndex, -1, FILE_CHANGE_LIMITS.historyToolRelatedChanges);
			selector = {
				kind: "after_block",
				messageId: source.messageId,
				keepThroughBlockIndex: source.keepThroughBlockIndex,
			};
			break;
		case "messages":
			keys(source, ["kind", "messageIds"]);
			selector = {
				kind: "messages",
				messageIds: ids(source.messageIds, FILE_CHANGE_LIMITS.historyMessageRefChanges),
			};
			break;
		case "tool_calls":
			keys(source, ["kind", "toolCallIds"]);
			selector = {
				kind: "tool_calls",
				toolCallIds: ids(source.toolCallIds, FILE_CHANGE_LIMITS.historyToolRelatedChanges),
			};
			break;
		default:
			throw fail("INVALID_INPUT", "Unsupported selector");
	}
	if (input.kind === "rollback_to_block" && selector.kind !== "after_block")
		throw fail("INVALID_INPUT", "Block rollback requires a fixed after_block selection");
	if (
		input.uiAction !== undefined &&
		!fileChangeRevertActionMatches(input.uiAction, input.kind, selector)
	)
		throw fail("ACTION_MISMATCH", "The UI action must match its fixed journal program");
	if (selector.kind === "messages") Object.freeze(selector.messageIds);
	if (selector.kind === "tool_calls") Object.freeze(selector.toolCallIds);
	return Object.freeze({
		principal: Object.freeze({ ...input.principal }),
		narratorId: input.narratorId,
		expectedMessageVersion: input.expectedMessageVersion,
		idempotencyKey: input.idempotencyKey,
		kind: input.kind,
		revertScope: input.revertScope,
		selector: Object.freeze(selector),
		...(input.uiAction === undefined ? {} : { uiAction: input.uiAction }),
	});
}
function ids(values: string[], max: number) {
	if (!Array.isArray(values)) throw fail("INVALID_INPUT", "Expected explicit selector IDs");
	integer(values.length, 1, max);
	return values.map((value) => {
		text(value);
		return value;
	});
}
function keys(value: object, allowed: string[]) {
	if (
		!value ||
		typeof value !== "object" ||
		Object.keys(value).some((key) => !allowed.includes(key))
	)
		throw fail("INVALID_INPUT", "Unknown request fields cannot override the planner proof");
}
function text(value: string) {
	if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value) > 256)
		throw fail("INVALID_INPUT", "Invalid bounded identifier");
}
function integer(value: number, min: number, max: number) {
	if (!Number.isSafeInteger(value) || value < min || value > max)
		throw fail("BUDGET_EXCEEDED", "Value exceeds a complete planning bound");
}
function fail(code: string, message: string) {
	return new RevertPlannerError(code, message);
}

class Work {
	used = 0;
	private readonly pending = new Set<Promise<unknown>>();
	constructor(
		readonly signal: AbortSignal,
		private readonly maximum: number,
	) {}
	get remaining() {
		return this.maximum - this.used;
	}
	check() {
		this.signal.throwIfAborted();
	}
	charge(bytes: number) {
		integer(bytes, 0, this.remaining);
		this.used += bytes;
		this.check();
	}
	release(bytes: number) {
		integer(bytes, 0, this.used);
		this.used -= bytes;
	}
	async wait<T>(promise: Promise<T>): Promise<T> {
		this.pending.add(promise);
		void promise.finally(() => this.pending.delete(promise)).catch(() => {});
		let abort: (() => void) | undefined;
		try {
			this.check();
			const result = await Promise.race([
				promise,
				new Promise<never>((_, reject) => {
					abort = () => reject(this.signal.reason);
					this.signal.addEventListener("abort", abort, { once: true });
				}),
			]);
			this.check();
			return result;
		} finally {
			if (abort) this.signal.removeEventListener("abort", abort);
		}
	}
	close(release: () => void) {
		// A timed-out adapter is NOT assumed stopped; retain concurrency admission until
		// actual IO settles, even though the caller receives cancellation promptly.
		if (this.pending.size) void Promise.allSettled([...this.pending]).then(release);
		else release();
	}
}
type Encoded = { ref: FileChangeBlobRef; chunks: Uint8Array[] };
/** No JSON.stringify of a full history/manifest. Bounded scalar tokens -> small chunks, with
 * incremental hash and event-loop yields; neither a 32MiB string nor a second full copy. */
async function encodeJson(value: unknown, work: Work): Promise<Encoded> {
	const hash = createHash("sha256");
	const chunks: Uint8Array[] = [];
	let parts: string[] = [];
	let characters = 0;
	let sizeBytes = 0;
	const flush = () => {
		const chunk = Buffer.from(parts.join(""));
		integer(chunk.byteLength, 0, FILE_CHANGE_LIMITS.streamChunkBytes);
		sizeBytes += chunk.byteLength;
		integer(sizeBytes, 0, Math.min(FILE_CHANGE_LIMITS.blobBytes, work.remaining));
		hash.update(chunk);
		chunks.push(chunk);
		parts = [];
		characters = 0;
	};
	for (const token of tokens(value)) {
		parts.push(token);
		characters += token.length;
		if (characters >= 16 * 1024) {
			flush();
			await yieldToEventLoop();
			work.check();
		}
	}
	if (parts.length) flush();
	work.check();
	return { ref: { algorithm: "sha256", digest: hash.digest("hex"), sizeBytes }, chunks };
}
function* tokens(value: unknown, depth = 0): Generator<string> {
	if (depth > 24) throw fail("INVALID_INPUT", "Unexpected manifest nesting");
	if (value === null) {
		yield "null";
		return;
	}
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		if (typeof value === "string" && value.length > FILE_CHANGE_LIMITS.metadataBytes)
			throw fail("BUDGET_EXCEEDED", "Manifest scalar exceeds metadata bound");
		if (typeof value === "number" && !Number.isFinite(value))
			throw fail("INVALID_INPUT", "Invalid manifest scalar");
		yield JSON.stringify(value);
		return;
	}
	if (Array.isArray(value)) {
		yield "[";
		for (let index = 0; index < value.length; index++) {
			if (index) yield ",";
			yield* tokens(value[index], depth + 1);
		}
		yield "]";
		return;
	}
	if (!value || typeof value !== "object")
		throw fail("INVALID_INPUT", "Unsupported manifest value");
	yield "{";
	let first = true;
	for (const key of Object.keys(value)) {
		const item = (value as Record<string, unknown>)[key];
		if (item === undefined) continue;
		if (!first) yield ",";
		first = false;
		yield JSON.stringify(key);
		yield ":";
		yield* tokens(item, depth + 1);
	}
	yield "}";
}
