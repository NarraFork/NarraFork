import { logger } from "../logger";
import { getToolMessage, getToolMessageWithParams, type Locale } from "../prompt-i18n";
import { shouldUseNativeSearch } from "../search/native";
import type { ExecutionBackend } from "./execution/backend";
import { LOCAL_DEVICE_ID } from "./execution/backend";
import { resolveBackendPath, toolBaseCwd } from "./execution/path-resolve";
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
}

const EXECUTION_ROUTED_TOOLS = new Set([
	"Read",
	"Write",
	"Edit",
	"Glob",
	"Grep",
	"Bash",
	"ExitPlanMode",
]);
const SPEC_FILE_TOOLS = new Set(["Read", "Write", "Edit"]);

type FrozenExecutionTarget = {
	backend: ExecutionBackend;
	target: ToolExecutionTarget;
};

function deviceSelectionSource(
	requested: string | undefined,
	sessionDefault: string | null | undefined,
): ToolExecutionTarget["selectionSource"] {
	if (requested !== undefined) return "explicit";
	if (sessionDefault !== undefined && sessionDefault !== null) return "session_default";
	return "local_default";
}

function getPrimaryPath(
	toolName: string,
	input: Record<string, unknown>,
	config?: AgentConfig,
): string | undefined {
	if (toolName === "ExitPlanMode") {
		if (
			config?.relaxedPlan === true &&
			typeof input.plan_file_path === "string" &&
			input.plan_file_path.trim()
		) {
			return input.plan_file_path.trim();
		}
		if (typeof input._planFile === "string" && input._planFile.trim()) {
			return input._planFile.trim();
		}
		return config?.planFilePath;
	}
	if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
		return typeof input.file_path === "string" ? input.file_path : undefined;
	}
	if (toolName === "Glob" || toolName === "Grep") {
		return typeof input.path === "string" ? input.path : undefined;
	}
	return undefined;
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

/**
 * Rebuild a FrozenExecutionTarget from a previously persisted execution target
 * (e.g. re-running a denied tool call). The backend is resolved from the target's
 * deviceId; remote targets fail closed when the device is unknown or offline, never
 * silently falling back to local execution.
 */
function rehydrateFrozenTarget(target: ToolExecutionTarget): FrozenExecutionTarget {
	const backend =
		target.deviceId === LOCAL_DEVICE_ID
			? localBackend
			: resolveBackend({ requested: target.deviceId });
	return { backend, target };
}

function resolveFrozenExecutionTarget(
	tu: AgentToolUse,
	config: AgentConfig,
	input: Record<string, unknown>,
	previous?: FrozenExecutionTarget,
): FrozenExecutionTarget | undefined {
	if (!EXECUTION_ROUTED_TOOLS.has(tu.name)) return undefined;

	const requested = typeof input.device === "string" ? input.device : undefined;
	const primaryPath = getPrimaryPath(tu.name, input, config);
	const isSpecUri =
		SPEC_FILE_TOOLS.has(tu.name) &&
		typeof primaryPath === "string" &&
		primaryPath.startsWith("spec://");

	if (isSpecUri) {
		if (config.allowLocalExecution === false) {
			throw new ExecutionTargetAuthorizationError(
				LOCAL_DEVICE_ID,
				requested === LOCAL_DEVICE_ID ? "requested" : "session_default",
			);
		}
		if (requested !== undefined && requested !== LOCAL_DEVICE_ID) {
			throw new Error(
				`Dynamic Spec paths execute on "${LOCAL_DEVICE_ID}" only; remote device "${requested}" was not used.`,
			);
		}
		const target: ToolExecutionTarget = {
			deviceId: LOCAL_DEVICE_ID,
			backendKind: "local",
			cwd: "spec://",
			resolvedFilePath: primaryPath,
			selectionSource: requested === LOCAL_DEVICE_ID ? "explicit" : "local_default",
		};
		if (previous && previous.target.deviceId !== target.deviceId) {
			throw new Error("Permission handling attempted to change the frozen execution device.");
		}
		return { backend: localBackend, target };
	}

	assertAuthorizedExecutionDevice(requested, config);
	const backend =
		previous?.backend ?? resolveBackend({ requested, sessionDefault: config.defaultDeviceId });
	if (previous && requested !== undefined && requested !== previous.target.deviceId) {
		throw new Error(
			`Permission handling attempted to change the frozen execution device from ` +
				`"${previous.target.deviceId}" to "${requested}".`,
		);
	}

	const baseCwd = toolBaseCwd(backend, config.cwd);
	const workdir =
		tu.name === "Bash" && typeof input.workdir === "string" ? input.workdir : undefined;
	const cwd = workdir ? resolveBackendPath(backend, baseCwd, workdir) : baseCwd;
	const resolvedFilePath = primaryPath
		? resolveBackendPath(backend, baseCwd, primaryPath)
		: undefined;
	const target: ToolExecutionTarget = {
		deviceId: backend.deviceId,
		backendKind: backend.kind,
		cwd,
		...(resolvedFilePath && { resolvedFilePath }),
		selectionSource:
			previous?.target.selectionSource ?? deviceSelectionSource(requested, config.defaultDeviceId),
	};
	return { backend, target };
}

async function resolveAndPersistFrozenExecutionTarget(
	tu: AgentToolUse,
	config: AgentConfig,
	input: Record<string, unknown>,
	previous?: FrozenExecutionTarget,
): Promise<FrozenExecutionTarget | undefined> {
	const frozen = resolveFrozenExecutionTarget(tu, config, input, previous);
	if (frozen && config.onExecutionTargetResolved) {
		await config.onExecutionTargetResolved(tu.toolUseId, frozen.target);
	}
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
		a.resolvedFilePath === b.resolvedFilePath &&
		a.selectionSource === b.selectionSource
	);
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
	const tool = toolRegistry.get(tu.name);
	const locale = (config.locale as Locale) ?? "en";

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
	// the audit-only selectionSource is reproduced instead of recomputed (which would
	// otherwise trip the persistence-layer frozen-target guard once the row has left
	// the "initializing" status).
	let frozenExecution: FrozenExecutionTarget | undefined;
	try {
		const seedPrevious =
			options.preFrozenTarget && EXECUTION_ROUTED_TOOLS.has(tu.name)
				? rehydrateFrozenTarget(options.preFrozenTarget)
				: undefined;
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

	// Start timing after permission is granted
	const start = Date.now();
	const executionStartedAt = start;

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
			const updatedFrozen = resolveFrozenExecutionTarget(
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

	// Progress timer
	let progressTimer: ReturnType<typeof setInterval> | undefined;
	if (config.onEvent) {
		const onEvent = config.onEvent;
		let elapsed = 0;
		progressTimer = setInterval(() => {
			elapsed += PROGRESS_INTERVAL_MS / 1000;
			onEvent({ type: "tool_progress", toolUseId: tu.toolUseId, elapsed });
		}, PROGRESS_INTERVAL_MS);
	}

	const pipelineLookup = !isPipelineControlTool(tu.name)
		? await getPipelineStateForToolCall(config.narratorId)
		: null;
	const pipelineState = pipelineLookup?.state ?? null;
	const pipelineExitConfirmation = pipelineLookup?.needsExitConfirmation || undefined;
	const pipelineExitConfirmationStateId = pipelineExitConfirmation ? pipelineState?.id : undefined;
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
		availableDevices: config.availableDevices,
		defaultDeviceId: config.defaultDeviceId,
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
		if (progressTimer) clearInterval(progressTimer);
		if (pendingOutputTimer) {
			clearTimeout(pendingOutputTimer);
			pendingOutputTimer = undefined;
		}
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
