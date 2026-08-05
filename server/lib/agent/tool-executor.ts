import {
	beginToolStartAdmission,
	convertToolStartGrantToExecution,
	inertUpdateExecutionLease,
	type UpdateCheckpointActivityLease,
	type UpdateExecutionKind,
	type UpdateExecutionLease,
	type UpdateToolStartGrant,
	waitUntilUpdateGateOpens,
} from "@server/services/update-coordinator";
import { logger } from "../logger";
import { getToolMessage, getToolMessageWithParams, type Locale } from "../prompt-i18n";
import { shouldUseNativeSearch } from "../search/native";
import type { ExecutionBackend } from "./execution/backend";
import { LOCAL_DEVICE_ID } from "./execution/backend";
import { targetPathSemantics, toolBaseCwd } from "./execution/path-resolve";
import {
	ExecutionTargetAuthorizationError,
	ExecutionTargetError,
	localBackend,
	resolveBackend,
} from "./execution/registry";
import {
	capturePipelineOutput,
	clipText,
	getPipelineStateForToolCall,
	isPipelineControlTool,
} from "./pipeline-state";
import { toolRegistry } from "./tool-registry";
import { truncateOutput } from "./truncate";
import type {
	AgentConfig,
	AgentToolUse,
	AllowPermissionResult,
	ToolContext,
	ToolExecutionEndpointRequest,
	ToolExecutionPlan,
	ToolExecutionTarget,
} from "./types";

const PROGRESS_INTERVAL_MS = 5_000;

/** Max size of output pushed via tool_output events (UI preview only). */
const MAX_STREAM_OUTPUT_LENGTH = 30_000;

/** Minimum interval between tool_output events (ms). */
const OUTPUT_THROTTLE_MS = 100;

export interface ToolExecResult {
	output: string;
	isError?: boolean;
	durationMs: number;
	permissionStartedAt?: number;
	executionStartedAt?: number;
	completedAt?: number;
	fatal?: boolean;
	/** Set when the tool call was rejected because the model's output was
	 *  cut off mid-stream (malformed JSON, suspiciously large content, etc.).
	 *  The loop will strip this tool_use + tool_result from the history sent
	 *  to the model and inject a user-side reminder instead. */
	broken?: boolean;
	/** Optional metadata from the tool (e.g. line numbers for Edit). */
	metadata?: Record<string, unknown>;
	/** Base64-encoded images to include in the tool result (for multimodal providers). */
	images?: Array<{ format: string; base64: string }>;
	/** When the permission handler redirected the input (e.g. plan-mode file path),
	 *  this holds the effective input that was actually executed. */
	updatedInput?: Record<string, unknown>;
	/** One-shot Pipeline exit confirmation to be injected by the Agent Loop as a SideCar. */
	pipelineExitConfirmation?: boolean;
	/** Pipeline state identity used for two-phase SideCar delivery acknowledgement. */
	pipelineExitConfirmationStateId?: string;
}

export interface ToolAdmissionState {
	preAdmissionComplete?: boolean;
	startGrant?: UpdateToolStartGrant;
	deferred?: {
		toolCallId: string;
		updateEpoch: string;
		payloadJson: Record<string, unknown>;
	};
}

interface ExecuteToolOptions {
	preGrantedPermission?: AllowPermissionResult;
	/** When true, a permission request raised for this tool must not trigger a
	 *  user-facing attention notification (e.g. reflection-takeover fallback). */
	suppressAttention?: boolean;
	/**
	 * A previously frozen execution target to reproduce exactly (e.g. re-running a
	 * denied tool call). When provided for a routed tool, the freeze reuses this
	 * identity — including its audit-only `selectionSource` — instead of recomputing
	 * it from the current session default. This keeps the re-run's target byte-identical
	 * to the original pass so the persistence-layer frozen-target guard does not reject
	 * it once the tool-call row has left the "initializing" status.
	 */
	preFrozenTarget?: ToolExecutionTarget;
	/** Shared state used when a reflection preflight already passed update admission. */
	admissionState?: ToolAdmissionState;
	/** Skip the defensive pre-admission check because the caller already completed it. */
	preAdmissionComplete?: boolean;
}

type FrozenExecutionEndpoint = {
	backend: ExecutionBackend;
	request: ToolExecutionEndpointRequest;
	target: ToolExecutionTarget;
};

type FrozenExecutionTarget = {
	backend: ExecutionBackend;
	target: ToolExecutionTarget;
	plan: ToolExecutionPlan;
	endpoints: FrozenExecutionEndpoint[];
};

function deviceSelectionSource(
	requested: string | undefined,
	sessionDefault: string | null | undefined,
): ToolExecutionTarget["selectionSource"] {
	if (requested !== undefined) return "explicit";
	if (sessionDefault !== undefined && sessionDefault !== null) return "session_default";
	return "local_default";
}

function assertAuthorizedExecutionDevice(requested: string | undefined, config: AgentConfig): void {
	const deviceId = requested ?? config.defaultDeviceId ?? LOCAL_DEVICE_ID;
	const source = requested !== undefined ? "requested" : "session_default";
	if (deviceId === LOCAL_DEVICE_ID) {
		if (config.allowLocalExecution === false) {
			throw new ExecutionTargetAuthorizationError(deviceId, source);
		}
		return;
	}
	const authorized = config.availableDevices?.some((device) => device.id === deviceId) ?? false;
	if (!authorized) throw new ExecutionTargetAuthorizationError(deviceId, source);
}

function isRoutedTool(tu: AgentToolUse): boolean {
	return !!toolRegistry.get(tu.name)?.executionRouting;
}

/** Rebuild a persisted primary endpoint without ever falling back to local. */
function rehydrateFrozenTarget(target: ToolExecutionTarget): FrozenExecutionTarget {
	const backend =
		target.deviceId === LOCAL_DEVICE_ID
			? localBackend
			: resolveBackend({ requested: target.deviceId });
	const plan: ToolExecutionPlan = {
		kind: "single",
		primaryKey: "primary",
		endpoints: [{ key: "primary", operation: "control", target }],
	};
	return {
		backend,
		target,
		plan,
		endpoints: [{ backend, request: { key: "primary", operation: "control" }, target }],
	};
}

async function resolveEndpoint(
	request: ToolExecutionEndpointRequest,
	config: AgentConfig,
	previous?: FrozenExecutionEndpoint,
): Promise<FrozenExecutionEndpoint> {
	const requested = request.hostOnly ? LOCAL_DEVICE_ID : request.deviceId;
	if (request.hostOnly && request.deviceId && request.deviceId !== LOCAL_DEVICE_ID) {
		throw new Error(
			`Endpoint ${request.key} is host-only but requested device "${request.deviceId}".`,
		);
	}
	assertAuthorizedExecutionDevice(requested, config);
	const backend =
		previous?.backend ?? resolveBackend({ requested, sessionDefault: config.defaultDeviceId });
	if (previous && backend.deviceId !== previous.target.deviceId) {
		throw new Error(`Endpoint ${request.key} changed its frozen execution device.`);
	}
	if (
		previous &&
		previous.target.runtimeGeneration !== undefined &&
		backend.runtimeGeneration !== previous.target.runtimeGeneration
	) {
		throw new Error(
			`Endpoint ${request.key} runtime generation changed; retry requires a fresh target.`,
		);
	}

	const semantics = request.pathFlavor ? targetPathSemantics(request.pathFlavor) : backend.paths;
	const baseCwd = request.pathFlavor === "spec" ? "spec://" : toolBaseCwd(backend, config.cwd);
	const cwd = request.workdir ? semantics.resolve(baseCwd, request.workdir) : baseCwd;
	let lexicalPath: string | undefined;
	let canonicalPath: string | undefined;
	if (request.path) {
		lexicalPath = semantics.resolve(baseCwd, request.path);
		if (request.pathFlavor === "spec") {
			canonicalPath = lexicalPath;
		} else {
			const identity = await backend.resolvePathIdentity(lexicalPath);
			lexicalPath = identity.lexicalPath;
			canonicalPath = identity.canonicalPath;
		}
	}
	const target: ToolExecutionTarget = {
		deviceId: backend.deviceId,
		backendKind: backend.kind,
		cwd,
		pathFlavor: semantics.flavor,
		...(lexicalPath ? { lexicalPath, resolvedFilePath: lexicalPath } : {}),
		...(canonicalPath ? { canonicalPath } : {}),
		runtimeGeneration: backend.runtimeGeneration,
		selectionSource:
			previous?.target.selectionSource ?? deviceSelectionSource(requested, config.defaultDeviceId),
	};
	return { backend, request, target };
}

async function resolveFrozenExecutionTarget(
	tu: AgentToolUse,
	config: AgentConfig,
	input: Record<string, unknown>,
	previous?: FrozenExecutionTarget,
): Promise<FrozenExecutionTarget | undefined> {
	const routing = toolRegistry.get(tu.name)?.executionRouting;
	if (!routing) return undefined;
	let requests: ToolExecutionEndpointRequest[];
	let primaryKey: string;
	if (routing.kind === "single") {
		const resolved = routing.resolve(input, config);
		if (!resolved) return undefined;
		requests = [resolved];
		primaryKey = resolved.key;
	} else {
		const resolved = routing.resolve(input, config);
		if (!resolved) return undefined;
		requests = resolved.endpoints;
		primaryKey = resolved.primaryKey;
	}
	const frozenEndpoints: FrozenExecutionEndpoint[] = [];
	for (const request of requests) {
		const previousEndpoint = previous?.endpoints.find(
			(endpoint) => endpoint.request.key === request.key,
		);
		frozenEndpoints.push(await resolveEndpoint(request, config, previousEndpoint));
	}
	const primary = frozenEndpoints.find((endpoint) => endpoint.request.key === primaryKey);
	if (!primary)
		throw new Error(`Execution routing did not produce primary endpoint "${primaryKey}".`);
	const plan: ToolExecutionPlan = {
		kind: routing.kind,
		primaryKey,
		endpoints: frozenEndpoints.map(({ request, target }) => ({
			key: request.key,
			operation: request.operation,
			target,
		})),
	};
	return { backend: primary.backend, target: primary.target, plan, endpoints: frozenEndpoints };
}

async function resolveAndPersistFrozenExecutionTarget(
	tu: AgentToolUse,
	config: AgentConfig,
	input: Record<string, unknown>,
	previous?: FrozenExecutionTarget,
): Promise<FrozenExecutionTarget | undefined> {
	// Unrouted tools must not pay for the resolver's async hops. Eager (mid-stream) execution
	// has to reach tool.execute before the streaming loop emits assistant_message, so every
	// avoidable microtask before execution changes observable tool ordering.
	if (!toolRegistry.get(tu.name)?.executionRouting) return undefined;
	const frozen = await resolveFrozenExecutionTarget(tu, config, input, previous);
	if (!frozen) return undefined;
	if (config.onExecutionTargetResolved) {
		await config.onExecutionTargetResolved(tu.toolUseId, frozen.target);
	}
	if (config.onExecutionPlanResolved)
		await config.onExecutionPlanResolved(tu.toolUseId, frozen.plan);
	return frozen;
}

/**
 * Persist the immutable execution identity before an external preflight (such as
 * taskReflection) advances the tool-call row into a permission-related status.
 * executeTool will resolve the target again later and require an exact match.
 */
export async function freezeToolExecution(
	tu: AgentToolUse,
	config: AgentConfig,
): Promise<FrozenExecutionTarget | undefined> {
	return resolveAndPersistFrozenExecutionTarget(tu, config, tu.input);
}

export async function freezeToolExecutionTarget(
	tu: AgentToolUse,
	config: AgentConfig,
): Promise<ToolExecutionTarget | undefined> {
	return (await freezeToolExecution(tu, config))?.target;
}

function executionTargetMetadata(
	target: ToolExecutionTarget | undefined,
	metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
	if (!target) return metadata;
	return { ...metadata, executionTarget: target };
}

function executionTargetsEqual(a: ToolExecutionTarget, b: ToolExecutionTarget): boolean {
	return (
		a.deviceId === b.deviceId &&
		a.backendKind === b.backendKind &&
		a.cwd === b.cwd &&
		a.pathFlavor === b.pathFlavor &&
		a.lexicalPath === b.lexicalPath &&
		a.canonicalPath === b.canonicalPath &&
		a.runtimeGeneration === b.runtimeGeneration &&
		a.resolvedFilePath === b.resolvedFilePath &&
		a.selectionSource === b.selectionSource
	);
}

/**
 * Human-readable diff between an already-approved execution identity and the one
 * resolved for a re-run. `selectionSource` is deliberately excluded: it is pinned by
 * `preFrozenTarget` and is audit-only, never a safety property.
 */
function describeExecutionTargetDrift(
	approved: ToolExecutionTarget,
	resolved: ToolExecutionTarget,
): string | null {
	const drifted: string[] = [];
	if (approved.deviceId !== resolved.deviceId) {
		drifted.push(`device "${approved.deviceId}" → "${resolved.deviceId}"`);
	}
	if (approved.backendKind !== resolved.backendKind) {
		drifted.push(`backend "${approved.backendKind}" → "${resolved.backendKind}"`);
	}
	if (approved.cwd !== resolved.cwd) {
		drifted.push(`cwd "${approved.cwd}" → "${resolved.cwd}"`);
	}
	if (approved.resolvedFilePath !== resolved.resolvedFilePath) {
		drifted.push(
			`path "${approved.resolvedFilePath ?? "(none)"}" → "${resolved.resolvedFilePath ?? "(none)"}"`,
		);
	}
	return drifted.length > 0 ? drifted.join(", ") : null;
}

export function classifyToolUpdateExecution(tu: AgentToolUse): UpdateExecutionKind {
	if ((tu.name === "Bash" || tu.name === "Shell") && tu.input.run_in_background === true) {
		return "background_bash";
	}
	if (
		(tu.name === "Agent" && typeof tu.input.stop !== "string") ||
		(tu.name === "Await" && tu.input.type === "agent") ||
		(tu.name === "Send" && tu.input.await === true)
	) {
		return "resumable";
	}
	return "ordinary";
}

async function waitForStableToolCallRow(
	tu: AgentToolUse,
	config: AgentConfig,
): Promise<{ id: string; narratorId: string }> {
	const { narratorService } = await import("@server/services/narrator-service");
	for (;;) {
		const toolCall = await narratorService.getToolCallByToolUseId(tu.toolUseId);
		if (toolCall?.id && toolCall.narratorId === config.narratorId) {
			return { id: toolCall.id, narratorId: toolCall.narratorId };
		}
		if (config.signal.aborted) {
			const error = new Error("Waiting for the stable tool-call row was aborted");
			error.name = "AbortError";
			throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function upsertDeferredTool(
	tu: AgentToolUse,
	config: AgentConfig,
	kind: UpdateExecutionKind,
	permissionGranted: boolean,
	executionTarget: ToolExecutionTarget | undefined,
	state: ToolAdmissionState,
	updateEpoch: string,
	activity: UpdateCheckpointActivityLease,
): Promise<void> {
	try {
		const toolCall = await waitForStableToolCallRow(tu, config);
		// Do NOT persist the full tool input here. The authoritative input lives in the
		// narrator_tool_calls.inputJson column, which reExecuteDeniedToolCall reads when the
		// deferred tool is restored. Duplicating tu.input in the continuation payload would
		// bloat narrator_tool_continuations with large content blobs (e.g. Write/Edit bodies)
		// while adding no recovery value — the payload only needs the routing/permission metadata.
		const payloadJson: Record<string, unknown> = {
			narratorId: config.narratorId,
			toolUseId: tu.toolUseId,
			toolName: tu.name,
			executionKind: kind,
			permissionGranted,
			...(executionTarget ? { executionTarget } : {}),
			...(tu.name === "Await" && typeof tu.input.type === "string"
				? { awaitType: tu.input.type }
				: {}),
			...(tu.name === "Agent"
				? {
						runInBackground: tu.input.run_in_background === true || tu.input.background === true,
					}
				: {}),
		};
		const { toolContinuationService } = await import("@server/services/tool-continuation-service");
		await toolContinuationService.upsert({
			toolCallId: toolCall.id,
			narratorId: config.narratorId,
			updateEpoch,
			kind: "deferred_tool",
			state: "paused",
			payloadJson,
		});
		state.deferred = { toolCallId: toolCall.id, updateEpoch, payloadJson };
	} finally {
		activity.release();
	}
}

async function waitForRejectedAdmission(
	tu: AgentToolUse,
	config: AgentConfig,
	kind: UpdateExecutionKind,
	permissionGranted: boolean,
	executionTarget: ToolExecutionTarget | undefined,
	state: ToolAdmissionState,
	updateEpoch: string,
	activity: UpdateCheckpointActivityLease,
): Promise<void> {
	await upsertDeferredTool(
		tu,
		config,
		kind,
		permissionGranted,
		executionTarget,
		state,
		updateEpoch,
		activity,
	);
	await waitUntilUpdateGateOpens(config.signal);
}

export function releaseToolAdmissionState(state: ToolAdmissionState): void {
	state.startGrant?.release();
	state.startGrant = undefined;
	state.preAdmissionComplete = false;
}

/**
 * A reflection loop's decision tool (DangerConfirm/DangerCancel, ExitPlanConfirm/...) must
 * bypass update admission.
 *
 * These tools resolve a gate that is ALREADY inside the checkpoint fence: the parent tool
 * holds its `startGrant` for as long as the gate deliberates. Making the decision tool wait
 * for the gate to open deadlocked the pair — the fence cannot stabilize while the parent tool
 * stays paused, and the parent cannot finish until the decision lands. They also create no new
 * tool row and touch no execution target, so there is nothing for the fence to exclude.
 */
function isReflectionDecisionTool(tu: AgentToolUse, config: AgentConfig): boolean {
	if (!config.reflectionLoop) return false;
	return config.reflectionLoop.allowedTools.includes(tu.name);
}

export async function preAdmitToolExecution(
	tu: AgentToolUse,
	config: AgentConfig,
	options: {
		executionTarget?: ToolExecutionTarget;
		state?: ToolAdmissionState;
	} = {},
): Promise<ToolAdmissionState> {
	const state = options.state ?? {};
	if (state.startGrant) return state;
	if (isReflectionDecisionTool(tu, config)) {
		state.preAdmissionComplete = true;
		return state;
	}
	const kind = classifyToolUpdateExecution(tu);
	for (;;) {
		const admission = beginToolStartAdmission(kind, config.narratorId, tu.toolUseId);
		if (admission.status === "granted") {
			state.startGrant = admission.grant;
			state.preAdmissionComplete = true;
			return state;
		}
		await waitForRejectedAdmission(
			tu,
			config,
			kind,
			false,
			options.executionTarget,
			state,
			admission.updateEpoch,
			admission.activity,
		);
	}
}

async function acquireFinalToolExecution(
	tu: AgentToolUse,
	config: AgentConfig,
	executionTarget: ToolExecutionTarget | undefined,
	state: ToolAdmissionState,
): Promise<{ lease: UpdateExecutionLease; resumed: boolean }> {
	// Reflection decision tools never take a grant (see isReflectionDecisionTool), so they
	// have no lease to convert either. Hand back an inert lease instead of failing the gate.
	if (isReflectionDecisionTool(tu, config)) {
		return { lease: inertUpdateExecutionLease(), resumed: false };
	}
	if (!state.startGrant) {
		await preAdmitToolExecution(tu, config, { executionTarget, state });
	}
	const grant = state.startGrant;
	if (!grant) throw new Error("Tool start admission completed without a grant");

	// beginToolStartAdmission is the irrevocable start linearization point. Once granted,
	// permission/routing latency cannot let phase two turn this tool into deferred work.
	const transition = convertToolStartGrantToExecution(grant, config.narratorId, tu.toolUseId);
	state.startGrant = undefined;
	state.preAdmissionComplete = false;

	const lease = transition.lease;
	let resumed = false;
	try {
		if (state.deferred) {
			resumed = true;
			const deferred = state.deferred;
			const { toolContinuationService } = await import(
				"@server/services/tool-continuation-service"
			);
			await toolContinuationService.upsert({
				toolCallId: deferred.toolCallId,
				narratorId: config.narratorId,
				updateEpoch: deferred.updateEpoch,
				kind: "deferred_tool",
				state: "completed",
				payloadJson: deferred.payloadJson,
			});
			state.deferred = undefined;
		}
		return { lease, resumed };
	} catch (error) {
		lease.release();
		throw error;
	}
}

/** Max serialized size of tool_input passed to hooks (bytes). */
const MAX_HOOK_INPUT_SIZE = 8_000;

/** Truncate tool_input for hook payloads to avoid sending huge content blobs. */
export function truncateToolInput(input: Record<string, unknown>): Record<string, unknown> {
	const serialized = JSON.stringify(input);
	if (serialized.length <= MAX_HOOK_INPUT_SIZE) return input;
	// Recursively truncate large string values
	const truncateValue = (val: unknown): unknown => {
		if (typeof val === "string" && val.length > 500) {
			return `${val.slice(0, 500)}… [truncated, ${val.length} chars total]`;
		}
		if (Array.isArray(val)) return val.map(truncateValue);
		if (val && typeof val === "object" && !Array.isArray(val)) {
			const obj: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(val)) {
				obj[k] = truncateValue(v);
			}
			return obj;
		}
		return val;
	};
	return truncateValue(input) as Record<string, unknown>;
}

async function getPipelineCaptureText(
	result: { output: string; metadata?: Record<string, unknown> },
	finalOutput: string,
	appendNotice: string,
): Promise<string> {
	const fullOutputPath = result.metadata?.fullOutputPath;
	if (typeof fullOutputPath !== "string") return finalOutput;

	try {
		return `${await Bun.file(fullOutputPath).text()}${appendNotice}`;
	} catch (err) {
		logger.warn("Failed to read full tool output for pipeline capture", {
			fullOutputPath,
			error: err instanceof Error ? err.message : String(err),
		});
		return finalOutput;
	}
}

export async function executeTool(
	tu: AgentToolUse,
	config: AgentConfig,
	options: ExecuteToolOptions = {},
): Promise<ToolExecResult> {
	const locale = (config.locale as Locale) ?? "en";
	const admissionState = options.admissionState ?? {};

	// Unified update admission is deliberately the first executable guard. Live loop callers
	// reach this point only after the tool-use block has a stable narrator_tool_calls row.
	// A boolean alone is not admission authority: only the registered grant closes the phase race.
	if (!admissionState.startGrant) {
		await preAdmitToolExecution(tu, config, { state: admissionState });
	}

	try {
		const tool = toolRegistry.get(tu.name);

		// Defense-in-depth: when unified native search is enabled for this provider/model,
		// the WebSearch function tool is filtered from the API request. Some upstreams may
		// still emit a learned function call; block it so the configured native channel remains
		// the single source of truth. If native search is disabled, WebSearch remains available
		// for managed/custom/subagent fallback channels.
		if (tu.name === "WebSearch" && shouldUseNativeSearch(config.provider, config.model)) {
			logger.warn("Blocked WebSearch function tool for native-search provider", {
				provider: config.provider,
				model: config.model,
				narratorId: config.narratorId,
			});
			return {
				output:
					"This provider uses native server-side web search. The WebSearch function tool is not available.",
				isError: true,
				durationMs: 0,
			};
		}

		if (!tool) {
			return {
				output: `Unknown tool: ${tu.name}`,
				isError: true,
				durationMs: 0,
			};
		}

		const allowedTools =
			config.allowedTools instanceof Set
				? config.allowedTools
				: config.allowedTools
					? new Set(config.allowedTools)
					: null;
		if (allowedTools && !allowedTools.has(tu.name)) {
			return {
				output: `Tool is not allowed by this narrator's runtime policy: ${tu.name}`,
				isError: true,
				durationMs: 0,
				fatal: true,
			};
		}
		if (config.runtimeAuthorizationGuard) {
			try {
				await config.runtimeAuthorizationGuard();
			} catch (error) {
				return {
					output: `Runtime authorization expired: ${error instanceof Error ? error.message : String(error)}`,
					isError: true,
					durationMs: 0,
					fatal: true,
				};
			}
		}

		const disabledTools =
			config.disabledTools instanceof Set
				? config.disabledTools
				: new Set(config.disabledTools ?? []);
		if (disabledTools.has(tu.name)) {
			return {
				output: `Tool disabled by this narrator's custom trait: ${tu.name}`,
				isError: true,
				durationMs: 0,
			};
		}

		// Enforce blocked-skills trait as a second layer (the Skill tool description and
		// toolFilter already hide blocked skills, but a model could still guess a name).
		if (tu.name === "Skill" && config.blockedSkills) {
			const { all, names } = config.blockedSkills;
			if (all) {
				return {
					output: "Skills are disabled for this narrator by a custom trait.",
					isError: true,
					durationMs: 0,
				};
			}
			const requested =
				typeof (tu.input as { skill?: unknown }).skill === "string"
					? (tu.input as { skill: string }).skill
					: typeof (tu.input as { name?: unknown }).name === "string"
						? (tu.input as { name: string }).name
						: undefined;
			if (requested && names.includes(requested)) {
				return {
					output: `Skill "${requested}" is blocked for this narrator by a custom trait.`,
					isError: true,
					durationMs: 0,
				};
			}
		}

		// Freeze the execution backend and path identity before permission handling. A
		// live session persists this callback before it can display/await approval.
		// When re-running a previously frozen call, seed the resolver with that identity so
		// the audit-only selectionSource is reproduced instead of recomputed.
		//
		// cwd/resolvedFilePath are still resolved from the live backend on purpose: the file
		// tools resolve their own paths from the backend (see edit.ts/write.ts), so pinning the
		// audit columns to a stale identity would only make the record disagree with the bytes
		// actually written, and would hide a permission-time path redirect.
		let frozenExecution: FrozenExecutionTarget | undefined;
		try {
			const approvedTarget =
				options.preFrozenTarget && isRoutedTool(tu) ? options.preFrozenTarget : undefined;
			const seedPrevious = approvedTarget ? rehydrateFrozenTarget(approvedTarget) : undefined;
			// A pre-granted re-run carries an approval for one specific execution identity
			// (a restored deferred tool whose permission was already granted, or a user
			// pressing retry). If the environment drifted since then — most commonly a remote
			// device reporting a different defaultCwd after reconnecting — silently retargeting
			// would execute something the approval never covered. Resolve without persisting
			// first so a refusal leaves the audit columns untouched. Non-pre-granted re-runs go
			// through permission handling again and may legitimately re-freeze the new identity.
			if (approvedTarget && options.preGrantedPermission) {
				const candidate = await resolveFrozenExecutionTarget(tu, config, tu.input, seedPrevious);
				const drift = candidate
					? describeExecutionTargetDrift(approvedTarget, candidate.target)
					: null;
				if (drift) {
					return {
						output:
							`Execution target drift: the approved execution identity for this tool call no longer ` +
							`matches the current environment (${drift}). The tool was not executed. ` +
							`Re-issue the call so it can be approved against the current target.`,
						isError: true,
						durationMs: 0,
						completedAt: Date.now(),
						metadata: executionTargetMetadata(approvedTarget),
					};
				}
			}
			frozenExecution = await resolveAndPersistFrozenExecutionTarget(
				tu,
				config,
				tu.input,
				seedPrevious,
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				output: `${err instanceof ExecutionTargetError || err instanceof ExecutionTargetAuthorizationError ? "Execution target error" : "Tool routing error"}: ${message}`,
				isError: true,
				durationMs: 0,
				completedAt: Date.now(),
			};
		}

		// Permission check. The live handler may canonicalize a path (for example a plan-file
		// redirect) before deciding or displaying approval. Refine + persist that identity while
		// the tool-call row is still initializing, never after approval has begun.
		const permissionStartedAt = Date.now();
		let permission: Awaited<ReturnType<AgentConfig["permissionHandler"]>>;
		try {
			permission =
				options.preGrantedPermission ??
				(await config.permissionHandler(tu.name, tu.input, tu.toolUseId, {
					suppressAttention: options.suppressAttention,
					executionBackend: frozenExecution?.backend,
					executionTarget: frozenExecution?.target,
					executionPlan: frozenExecution?.plan,
					onInputResolved: frozenExecution
						? async (resolvedInput) => {
								const refined = await resolveAndPersistFrozenExecutionTarget(
									tu,
									config,
									resolvedInput,
									frozenExecution,
								);
								if (!refined) {
									throw new Error("Routed tool lost its frozen execution target.");
								}
								frozenExecution = refined;
							}
						: undefined,
				}));
		} catch (err) {
			return {
				output: `Tool routing error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
				durationMs: 0,
				permissionStartedAt,
				completedAt: Date.now(),
				metadata: executionTargetMetadata(frozenExecution?.target),
			};
		}
		if (permission.behavior === "deny") {
			const userMessage =
				permission.rawMessage && permission.message
					? permission.message
					: permission.message
						? getToolMessageWithParams("permissionDeniedWithMessage", locale, {
								message: permission.message,
							})
						: getToolMessage("permissionDeniedByUser", locale);
			return {
				output: userMessage,
				isError: true,
				durationMs: 0,
				permissionStartedAt,
				completedAt: Date.now(),
				fatal: permission.fatal,
				metadata: executionTargetMetadata(frozenExecution?.target),
			};
		}
		if (permission.behavior === "dangerReflection") {
			return {
				output:
					"Internal permission error: tool executor received an unresolved dangerReflection result. " +
					"The tool was not executed.",
				isError: true,
				durationMs: 0,
				permissionStartedAt,
				completedAt: Date.now(),
				fatal: false,
				metadata: executionTargetMetadata(frozenExecution?.target),
			};
		}

		// PreToolUse hook check — fail-open: if the hook itself errors (timeout,
		// crash, network failure), we log a warning and let the tool execute.
		// Only an explicit "blocked" outcome prevents execution.
		if (config.hookHandler) {
			try {
				const hookResult = await config.hookHandler("PreToolUse", {
					tool_name: tu.name,
					tool_input: truncateToolInput(tu.input),
					tool_use_id: tu.toolUseId,
				});
				if (hookResult.outcome === "blocked") {
					return {
						output: hookResult.reason ?? "Blocked by hook",
						isError: true,
						durationMs: 0,
						metadata: executionTargetMetadata(frozenExecution?.target),
					};
				}
			} catch (err) {
				logger.warn("PreToolUse hook error (non-blocking)", {
					error: err instanceof Error ? err.message : String(err),
					toolName: tu.name,
				});
			}
		}

		// Start timing after permission is granted. If an update closes the final gate,
		// reset these timestamps after the transparent wait so paused time is not execution time.
		let start = Date.now();
		let executionStartedAt = start;

		const effectiveInput = permission.updatedInput ?? tu.input;
		const permissionNotice = permission.notice;
		// Track whether the permission handler redirected the input (e.g. plan-mode file path)
		const redirectedInput =
			permission.updatedInput && permission.updatedInput !== tu.input
				? permission.updatedInput
				: undefined;

		// Any routed input returned by permission handling must match the identity reported through
		// onInputResolved before the approval decision. A handler cannot redirect cwd/path/device only
		// after approval and silently rewrite the audit record.
		if (frozenExecution && redirectedInput) {
			try {
				const updatedFrozen = await resolveFrozenExecutionTarget(
					tu,
					config,
					effectiveInput,
					frozenExecution,
				);
				if (!updatedFrozen) throw new Error("Routed tool lost its frozen execution target.");
				if (!executionTargetsEqual(frozenExecution.target, updatedFrozen.target)) {
					throw new Error(
						"Permission handling returned an execution target that was not frozen before approval.",
					);
				}
				frozenExecution = updatedFrozen;
			} catch (err) {
				return {
					output: `Tool routing error: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
					durationMs: Date.now() - start,
					permissionStartedAt,
					executionStartedAt,
					completedAt: Date.now(),
					metadata: executionTargetMetadata(frozenExecution?.target),
				};
			}
		}

		// Check if the tool input is malformed JSON (_raw field) — a sign of output truncation
		if ("_raw" in effectiveInput) {
			const rawLen = typeof effectiveInput._raw === "string" ? effectiveInput._raw.length : 0;
			return {
				output:
					`The tool call input was truncated — received malformed JSON (${rawLen} chars of raw input). ` +
					`The ${tu.name} was NOT executed to avoid corrupting files. ` +
					"Each tool call's total input must be under 10,000 characters. " +
					"Use skeleton-first approach: Write a skeleton with SPLICE markers, " +
					"then Edit to fill each marker with real content.",
				isError: true,
				durationMs: Date.now() - start,
				permissionStartedAt,
				executionStartedAt,
				completedAt: Date.now(),
				broken: true,
				metadata: executionTargetMetadata(frozenExecution?.target),
			};
		}

		// Detect empty input for file-writing tools — a sign of complete truncation
		// where the stream sent tool name/id but no input chunks at all.
		const FILE_TOOLS = new Set(["Write", "Edit"]);
		if (FILE_TOOLS.has(tu.name) && Object.keys(effectiveInput).length === 0) {
			return {
				output:
					`The ${tu.name} call received no input at all (complete truncation). ` +
					`The ${tu.name} was NOT executed. ` +
					"Each tool call's total input must be under 10,000 characters. " +
					"Use skeleton-first approach: Write a skeleton with SPLICE markers, " +
					"then Edit to fill each marker with real content.",
				isError: true,
				durationMs: Date.now() - start,
				permissionStartedAt,
				executionStartedAt,
				completedAt: Date.now(),
				broken: true,
				metadata: executionTargetMetadata(frozenExecution?.target),
			};
		}

		// Validate parameters
		const parsed = tool.parameters.safeParse(effectiveInput);
		if (!parsed.success) {
			return {
				output: `Invalid parameters: ${parsed.error.message}`,
				isError: true,
				durationMs: Date.now() - start,
				permissionStartedAt,
				executionStartedAt,
				completedAt: Date.now(),
				metadata: executionTargetMetadata(frozenExecution?.target),
			};
		}

		const pipelineLookup = !isPipelineControlTool(tu.name)
			? await getPipelineStateForToolCall(config.narratorId)
			: null;
		const pipelineState = pipelineLookup?.state ?? null;
		const pipelineExitConfirmation = pipelineLookup?.needsExitConfirmation || undefined;
		const pipelineExitConfirmationStateId = pipelineExitConfirmation
			? pipelineState?.id
			: undefined;
		if (pipelineLookup?.autoCleared) {
			logger.info("Auto-cleared stale pipeline state", {
				narratorId: config.narratorId,
				toolName: tu.name,
			});
		}
		const pipelinePreviewChars = pipelineState?.maxPreviewChars ?? 100;

		const ctx: ToolContext = {
			narratorId: config.narratorId,
			cwd: config.cwd,
			signal: config.signal,
			provider: config.provider,
			model: config.model,
			pipelineUnusedToolCallThreshold: config.pipelineUnusedToolCallThreshold,
			locale: config.locale ?? "en",
			chapterId: config.chapterId,
			planFileId: config.planFileId,
			planFilePath: config.getPlanFilePathForTool?.(tu.toolUseId) ?? config.planFilePath,
			skillRoot: config.skillRoot,
			projectGitPath: config.projectGitPath,
			worktreePath: config.worktreePath,
			skillScopeKey: config.skillScopeKey,
			blockedSkills: config.blockedSkills,
			parentNarratorId: config.parentNarratorId,
			userId: config.userId,
			projectId: config.projectId,
			requestPermission: config.permissionHandler,
			currentToolUseId: tu.toolUseId,
			reflectionLoop: config.reflectionLoop?.context,
			resolveBackend: (device?: string) => {
				if (frozenExecution) {
					if (device !== undefined && device !== frozenExecution.target.deviceId) {
						throw new Error(
							`Tool attempted to change its frozen execution device from ` +
								`"${frozenExecution.target.deviceId}" to "${device}".`,
						);
					}
					return frozenExecution.backend;
				}
				return resolveBackend({ requested: device, sessionDefault: config.defaultDeviceId });
			},
			executionTarget: frozenExecution?.target,
			executionPlan: frozenExecution?.plan,
			availableDevices: config.availableDevices,
			defaultDeviceId: config.defaultDeviceId,
			allowLocalExecution: config.allowLocalExecution,
			setDefaultDevice: config.setDefaultDevice,
		};

		// Wire up emitLongRunning: notify UI when a process exceeds 60s
		if (config.onEvent) {
			const onEvent = config.onEvent;
			ctx.emitLongRunning = (toolUseId: string, elapsed: number) => {
				onEvent({ type: "tool_long_running", toolUseId, elapsed });
			};
		}

		// Wire up emitOutput: throttled streaming of tool output to the UI
		let pendingOutputTimer: ReturnType<typeof setTimeout> | undefined;
		if (config.onEvent) {
			const onEvent = config.onEvent;
			let lastEmitTime = 0;
			let latestOutput = "";

			const flush = () => {
				lastEmitTime = Date.now();
				onEvent({ type: "tool_output", toolUseId: tu.toolUseId, output: latestOutput });
			};

			ctx.emitOutput = (output: string) => {
				if (pipelineState) {
					latestOutput = `Pipeline live output preview (${tu.name}):\n${clipText(output, pipelinePreviewChars)}`;
				} else {
					latestOutput =
						output.length > MAX_STREAM_OUTPUT_LENGTH
							? `...\n\n${output.slice(-MAX_STREAM_OUTPUT_LENGTH)}`
							: output;
				}

				const elapsed = Date.now() - lastEmitTime;
				if (elapsed >= OUTPUT_THROTTLE_MS) {
					if (pendingOutputTimer) {
						clearTimeout(pendingOutputTimer);
						pendingOutputTimer = undefined;
					}
					flush();
				} else if (!pendingOutputTimer) {
					pendingOutputTimer = setTimeout(() => {
						pendingOutputTimer = undefined;
						flush();
					}, OUTPUT_THROTTLE_MS - elapsed);
				}
			};
		}

		const executionToolUse = effectiveInput === tu.input ? tu : { ...tu, input: effectiveInput };
		const finalAdmission = await acquireFinalToolExecution(
			executionToolUse,
			config,
			frozenExecution?.target,
			admissionState,
		);
		if (finalAdmission.resumed) {
			start = Date.now();
			executionStartedAt = start;
		}
		let updateLeaseTransferred = false;
		let updateLeaseReleased = false;
		const updateExecutionLease = {
			kind: finalAdmission.lease.kind,
			setNarratorId(narratorId: string) {
				finalAdmission.lease.setNarratorId(narratorId);
			},
			transfer() {
				if (updateLeaseReleased || updateLeaseTransferred) return false;
				updateLeaseTransferred = true;
				return true;
			},
			release() {
				if (updateLeaseReleased) return;
				updateLeaseReleased = true;
				finalAdmission.lease.release();
			},
		};
		ctx.updateExecutionLease = updateExecutionLease;

		// Progress starts only after final admission; a deferred tool remains visually pending.
		let progressTimer: ReturnType<typeof setInterval> | undefined;
		if (config.onEvent) {
			const onEvent = config.onEvent;
			// The ONE moment that proves execution has begun: permission granted, final
			// admission acquired, `tool.execute` not yet called. Everything upstream of here
			// (input parsing, the approval prompt, a reflection gate, the admission wait) is
			// preparation the UI must not paint as work in progress.
			//
			// `executionStartedAt` rather than `Date.now()`: a tool resumed after a
			// transparent update wait re-stamps it above, so this matches the value the
			// eventual `tool_result` reports and the two cannot disagree.
			onEvent({ type: "tool_executing", toolUseId: tu.toolUseId, executionStartedAt });
			let elapsed = 0;
			progressTimer = setInterval(() => {
				elapsed += PROGRESS_INTERVAL_MS / 1000;
				onEvent({ type: "tool_progress", toolUseId: tu.toolUseId, elapsed });
			}, PROGRESS_INTERVAL_MS);
		}

		try {
			const result = await tool.execute(effectiveInput, ctx);

			// Append permission notice (e.g. plan-mode file redirect) to output.
			// Special case: when Edit was redirected but the target conclusion file doesn't exist,
			// the tool returns "File not found" error for the REDIRECTED path. We need to attach
			// a specific notice so the model understands it must Write first, then Edit.
			let appendNotice = "";
			if (permissionNotice) {
				const redirectedPath =
					typeof effectiveInput.file_path === "string" ? effectiveInput.file_path : "";
				const isEditRedirectedFileNotFound =
					tu.name === "Edit" &&
					result.isError &&
					redirectedInput &&
					redirectedPath &&
					result.output.includes(`File not found: ${redirectedPath}`);

				if (isEditRedirectedFileNotFound) {
					// Replace the generic notice with a specific one for this edge case
					const originalPath = typeof tu.input.file_path === "string" ? tu.input.file_path : "";
					const locale = (config.locale === "zh-CN" ? "zh-CN" : "en") as Locale;
					appendNotice = `\n\n${getToolMessageWithParams("subagentConclusionRedirectedFileNotFound", locale, { originalPath, conclusionFile: redirectedPath })}`;
				} else if (!result.isError) {
					appendNotice = `\n\n${permissionNotice}`;
				}
			}

			// PostToolUse hook (fire-and-forget, non-blocking)
			if (config.hookHandler) {
				config
					.hookHandler("PostToolUse", {
						tool_name: tu.name,
						tool_input: truncateToolInput(tu.input),
						tool_use_id: tu.toolUseId,
						tool_output: result.output.slice(0, 2000),
						tool_is_error: result.isError ?? false,
					})
					.catch((err) => {
						logger.warn("PostToolUse hook error", {
							error: err instanceof Error ? err.message : String(err),
							toolName: tu.name,
						});
					});
			}

			const finalOutput = result.output + appendNotice;
			if (pipelineState && !isPipelineControlTool(tu.name)) {
				const pipelineOutput = await getPipelineCaptureText(result, finalOutput, appendNotice);
				const captured = await capturePipelineOutput({
					narratorId: config.narratorId,
					toolUseId: tu.toolUseId,
					toolName: tu.name,
					input: effectiveInput,
					output: pipelineOutput,
					isError: result.isError,
					metadata: executionTargetMetadata(frozenExecution?.target, result.metadata),
					expectedStateId: pipelineState.id,
				});
				if (captured) {
					return {
						output: captured.previewOutput,
						isError: result.isError,
						fatal: result.fatal,
						durationMs: Date.now() - start,
						permissionStartedAt,
						executionStartedAt,
						completedAt: Date.now(),
						metadata: executionTargetMetadata(frozenExecution?.target, {
							...result.metadata,
							pipelineAlias: captured.capture.alias,
							pipelineOutputPath: captured.capture.outputPath,
							pipelineCapturedBytes: captured.capture.bytes,
						}),
						images: result.images,
						updatedInput: redirectedInput,
						pipelineExitConfirmation,
						pipelineExitConfirmationStateId,
					};
				}
			}

			// If the tool already truncated its output, pass through as-is.
			if (result.truncated) {
				return {
					output: finalOutput,
					isError: result.isError,
					fatal: result.fatal,
					durationMs: Date.now() - start,
					permissionStartedAt,
					executionStartedAt,
					completedAt: Date.now(),
					metadata: executionTargetMetadata(frozenExecution?.target, result.metadata),
					images: result.images,
					updatedInput: redirectedInput,
					pipelineExitConfirmation,
					pipelineExitConfirmationStateId,
				};
			}
			const truncated = truncateOutput(result.output);
			return {
				output: truncated.content + appendNotice,
				isError: result.isError,
				fatal: result.fatal,
				durationMs: Date.now() - start,
				permissionStartedAt,
				executionStartedAt,
				completedAt: Date.now(),
				metadata: executionTargetMetadata(frozenExecution?.target, result.metadata),
				images: result.images,
				updatedInput: redirectedInput,
				pipelineExitConfirmation,
				pipelineExitConfirmationStateId,
			};
		} catch (err) {
			return {
				output: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
				durationMs: Date.now() - start,
				permissionStartedAt,
				executionStartedAt,
				completedAt: Date.now(),
				updatedInput: redirectedInput,
				pipelineExitConfirmation,
				pipelineExitConfirmationStateId,
				metadata: executionTargetMetadata(frozenExecution?.target),
			};
		} finally {
			if (!updateLeaseTransferred) updateExecutionLease.release();
			if (progressTimer) clearInterval(progressTimer);
			if (pendingOutputTimer) {
				clearTimeout(pendingOutputTimer);
				pendingOutputTimer = undefined;
			}
		}
	} finally {
		releaseToolAdmissionState(admissionState);
	}
}

/**
 * Build a sanitized version of a broken tool call's input for DB persistence.
 * Keeps structural parameters (file_path, etc.) but replaces large content
 * fields with a short placeholder so the DB record is readable.
 */
export function sanitizeBrokenInput(
	toolName: string,
	input: Record<string, unknown>,
	locale: string,
): Record<string, unknown> {
	const placeholder = getToolMessage("brokenToolCallInputPlaceholder", (locale as Locale) ?? "en");
	const clean: Record<string, unknown> = {};
	const isEdit = toolName === "Edit";

	// If input is just { _raw: "..." }, extract file_path from the incomplete JSON
	if ("_raw" in input && Object.keys(input).length === 1) {
		const raw = input._raw as string;
		const filePathMatch = raw.match(/"file_path"\s*:\s*"([^"]+)"/);
		clean.file_path = filePathMatch ? filePathMatch[1] : "";
		// Use the correct field names so the frontend can render properly
		if (isEdit) {
			clean.old_string = placeholder;
			clean.new_string = placeholder;
		} else {
			clean.content = placeholder;
		}
	} else {
		// Normal case: copy non-content fields, replace content fields
		for (const [key, value] of Object.entries(input)) {
			if (key === "_raw") continue;
			if (key === "content" || key === "old_string" || key === "new_string") {
				clean[key] = placeholder;
			} else {
				clean[key] = value;
			}
		}
		// Ensure file_path is always present
		if (!("file_path" in clean)) {
			clean.file_path = "";
		}
		// Ensure content fields exist with correct names for the tool type
		if (isEdit) {
			if (!("old_string" in clean)) clean.old_string = placeholder;
			if (!("new_string" in clean)) clean.new_string = placeholder;
		} else if (!("content" in clean)) {
			clean.content = placeholder;
		}
	}

	return clean;
}
