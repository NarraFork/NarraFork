import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { ProgressSnapshot } from "@shared/progress-phase";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { narratorMessages, narrators, narratorToolCalls, remoteDevices } from "../db/schema";
import type {
	DangerInfo,
	DangerSeverity,
	PermissionHandlerOptions,
	PermissionResult,
} from "../lib/agent";
import { analyzeShellCommand, type BashAnalysis } from "../lib/agent/bash-analyze";
import type { ExecutionBackend, TargetPathSemantics } from "../lib/agent/execution/backend";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { resolveBackendPath, toolBaseCwd } from "../lib/agent/execution/path-resolve";
import {
	localPathSemantics,
	specPathSemantics,
	targetPathSemantics,
} from "../lib/agent/execution/path-semantics";
import { localBackend, resolveBackend } from "../lib/agent/execution/registry";
import {
	FS_READ_ATOMIC_RESOLVED_PATH_FEATURE,
	FS_STAT_RESOLVED_PATH_FEATURE,
} from "../lib/agent/execution/rpc-types";
import { detectShell } from "../lib/agent/shell";
import { isModelPlanReference } from "../lib/agent/strip-plan-body";
import { toolRegistry } from "../lib/agent/tool-registry";
import { SHELL_TOOL_NAME } from "../lib/agent/tools/bash";
import {
	isKnowledgeReadAction,
	KNOWLEDGE_MERGE_ACTION_SET,
} from "../lib/agent/tools/knowledge-actions";
import { OUTPUT_DIR as TRUNCATE_OUTPUT_DIR } from "../lib/agent/truncate";
import type { ToolExecutionTarget } from "../lib/agent/types";
import {
	type DangerReflectionLevel,
	normalizeDangerReflectionLevel,
	resolveDangerReflectionLevel,
} from "../lib/boolean-override";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { isPlanModeTrait, isSubagentVariant } from "../lib/narrator-utils";
import type { DeviceAccessPolicy } from "../lib/oauth-client-policy";
import { resolveEffectiveRelaxedPlan } from "../lib/permission-modes";
import { isInsidePath, normalizePathForOS, pathsEqual, resolvePath } from "../lib/platform-path";
import { getToolMessage, getToolMessageWithParams, type Locale } from "../lib/prompt-i18n";
import { settings } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";

export {
	normalizeDangerReflectionLevel,
	resolveDangerReflectionLevel,
} from "../lib/boolean-override";

import { coerceAskQuestions, generateAskUserQuestionAnswers } from "./ask-user-question-reflection";
import { backgroundTaskService } from "./background-task-service";
import { commandPatternMatches } from "./execution-policy/command-policy";
import type { CompiledExecutionPolicy } from "./execution-policy/compiler";
import { compileExecutionPolicy } from "./execution-policy/compiler";
import { executionPolicyEngine, type ResolvedExecutionPolicy } from "./execution-policy/engine";
import { registerExecutionPolicyPendingReprocessor } from "./execution-policy/events";
import { normalizeExecutionPolicyRuleSet } from "./execution-policy/normalize";
import {
	createExecutionTargetContext,
	executionTargetContextKey,
	executionTargetPolicyPath,
	withExecutionDeviceClass,
} from "./execution-policy/target-context";
import type {
	CommandWhitelistRule,
	DirectoryBlacklistRule,
	ExecutionTargetContext,
	LegacyCommandBlacklistEntry,
	LegacyCommandWhitelistEntry,
	LegacyDirectoryBlacklistEntry,
	LegacyDirectoryWhitelistEntry,
} from "./execution-policy/types";
import { integrationResourceBindingService } from "./integration-resource-binding-service";
import { narratorService } from "./narrator-service";
import {
	activeNarrators,
	isNarratorRuntimeBusy,
	type PendingDangerReflection,
	type PendingExecutionTarget,
	type PendingPermission,
	type PendingPlanSource,
	pendingDangerConfirmations,
	pendingDangerReflections,
	pendingFeedback,
	pendingPermissions,
	pendingPlanApprover,
	pendingPlanCompact,
	pendingPlanDiff,
	planModeAskedOnce,
} from "./narrator-session-state";
import { broadcastReflectionFrame } from "./reflection-broadcast";
import { SPEC_TASKS_PATH } from "./spec-task-service";
import { specVfsService } from "./spec-vfs-service";
import { resolveTaskAlias, subagentMatchesSelector } from "./subagent-alias";
import {
	getConclusionEntry,
	getConclusionFileId,
	resolveConclusionFilePath,
} from "./subagent-conclusion";

// === Permission handling ===

export function isInsideWorktree(cwd: string, filePath: string): boolean {
	return isInsidePath(cwd, resolve(cwd, filePath));
}

/** Check if a path points inside the truncated-output temp directory. */
function isInsideTruncateDir(_cwd: string, filePath: string): boolean {
	return isInsidePath(TRUNCATE_OUTPUT_DIR, resolve(_cwd, filePath));
}

export function extractToolPaths(toolName: string, input: Record<string, unknown>): string[] {
	switch (toolName) {
		case "Read":
		case "Write":
		case "Edit":
		case "NotebookEdit":
			return typeof input.file_path === "string" ? [input.file_path] : [];
		case "ShareFile":
			return typeof input.path === "string" ? [input.path] : [];
		case "Glob":
		case "Grep":
			return typeof input.path === "string" ? [input.path] : [];
		case "Browser":
			return input.action === "screenshot" &&
				typeof input.file_path === "string" &&
				input.file_path.length > 0
				? [input.file_path]
				: [];
		case SHELL_TOOL_NAME: {
			const paths: string[] = [];
			if (typeof input.workdir === "string") paths.push(input.workdir);
			if (Array.isArray(input._filePaths)) {
				paths.push(...input._filePaths.filter((p): p is string => typeof p === "string"));
			}
			return paths;
		}
		default:
			return [];
	}
}

function resolveToolCwd(cwd: string, input: Record<string, unknown>): string {
	if (typeof input.workdir === "string" && input.workdir) {
		return resolvePath(cwd, input.workdir);
	}
	return resolvePath(cwd);
}

function isSupportedShellType(value: unknown): value is "bash" | "posix" | "powershell" | "cmd" {
	return value === "bash" || value === "posix" || value === "powershell" || value === "cmd";
}

function resolvePermissionShellType(
	backend?: ExecutionBackend,
): "bash" | "posix" | "powershell" | "cmd" {
	if (backend?.kind === "remote") {
		const shellType = backend.platform?.shellType;
		if (!isSupportedShellType(shellType)) {
			throw new Error(
				`Remote device did not report a supported shell type: ${shellType ?? "missing"}`,
			);
		}
		return shellType;
	}
	return detectShell().type;
}

function isRoutedPermissionTool(toolName: string): boolean {
	return toolName === "Shell" || !!toolRegistry.get(toolName)?.executionRouting;
}

function decisionPaths(context?: ExecutionTargetContext | null): TargetPathSemantics {
	return context?.paths ?? localPathSemantics;
}

function decisionCwd(cwd: string, context?: ExecutionTargetContext | null): string {
	return context?.target.cwd ?? resolvePath(cwd);
}

function resolveDecisionPath(
	cwd: string,
	path: string,
	context?: ExecutionTargetContext | null,
): string {
	const paths = decisionPaths(context);
	return paths.resolve(decisionCwd(cwd, context), path);
}

function isInsideDecisionPath(
	cwd: string,
	parent: string,
	child: string,
	context?: ExecutionTargetContext | null,
): boolean {
	const paths = decisionPaths(context);
	return paths.contains(
		paths.resolve(decisionCwd(cwd, context), parent),
		paths.resolve(decisionCwd(cwd, context), child),
	);
}

function isInsideDecisionWorktree(
	cwd: string,
	path: string,
	context?: ExecutionTargetContext | null,
): boolean {
	return isInsideDecisionPath(cwd, decisionCwd(cwd, context), path, context);
}

function isInsideDecisionTruncateDir(
	cwd: string,
	path: string,
	context?: ExecutionTargetContext | null,
): boolean {
	if (context && (context.backend.kind !== "local" || context.paths.flavor === "spec"))
		return false;
	return isInsideTruncateDir(cwd, path);
}

function getShellScopePaths(
	cwd: string,
	input: Record<string, unknown>,
	bashAnalysis?: BashAnalysis,
	context?: ExecutionTargetContext | null,
): string[] {
	const paths = new Set<string>();
	if (typeof input.workdir === "string" && input.workdir) {
		paths.add(context?.target.cwd ?? resolveDecisionPath(cwd, input.workdir, context));
	}
	// analyzeShellCommand already resolves these with the target's path semantics. Never
	// feed them through the NarraFork host cwd a second time.
	for (const path of bashAnalysis?.filePaths ?? []) {
		paths.add(decisionPaths(context).normalize(path));
	}
	return [...paths];
}

function getToolPolicyPaths(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	bashAnalysis?: BashAnalysis,
	context?: ExecutionTargetContext | null,
): string[] {
	if (toolName === SHELL_TOOL_NAME || toolName === "Shell") {
		return getShellScopePaths(cwd, input, bashAnalysis, context);
	}
	if (context && isRoutedPermissionTool(toolName)) {
		const primaryPath = executionTargetPolicyPath(context);
		if (primaryPath) return [context.paths.normalize(primaryPath)];
	}
	return extractToolPaths(toolName, input).map((path) => resolveDecisionPath(cwd, path, context));
}

function allPathsAllowedByPolicy(
	paths: string[],
	compiledPolicy: CompiledExecutionPolicy,
	requiredLevel: "read" | "write" | "full",
): boolean {
	return (
		paths.length > 0 &&
		paths.every(
			(path) =>
				compiledPolicy.evaluatePath({ path, operation: requiredLevel }).decision === "allow",
		)
	);
}

function resolveWhitelistDecision(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	compiledPolicy: CompiledExecutionPolicy,
	bashAnalysis?: BashAnalysis,
	context?: ExecutionTargetContext | null,
): "allow" | null {
	if (compiledPolicy.directoryWhitelist.length === 0) return null;

	if (toolName === "Agent") {
		const workdir = input.workdir;
		if (typeof workdir !== "string" || !workdir) return null;
		const resolvedWorkdir = resolveDecisionPath(cwd, workdir, context);
		if (decisionPaths(context).equals(resolvedWorkdir, decisionCwd(cwd, context))) return null;
		const operation =
			input.subagent_type === "explore" || input.subagent_type === "plan" ? "read" : "full";
		return compiledPolicy.evaluatePath({ path: resolvedWorkdir, operation }).decision === "allow"
			? "allow"
			: null;
	}

	if (toolName === SHELL_TOOL_NAME || toolName === "Shell") {
		if (!bashAnalysis) return null;
		if (bashAnalysis.nonWhitelisted.length > 0) return null;
		if (bashAnalysis.dangerousPatterns.length > 0) return null;
		if (bashAnalysis.hasEnvInjection) return null;
		const shellPaths = getToolPolicyPaths(toolName, input, cwd, bashAnalysis, context).filter(
			(path) =>
				!isInsideDecisionWorktree(cwd, path, context) &&
				!isInsideDecisionTruncateDir(cwd, path, context),
		);
		if (shellPaths.length === 0) return null;
		return allPathsAllowedByPolicy(
			shellPaths,
			compiledPolicy,
			bashAnalysis.hasWriteOperation ? "write" : "read",
		)
			? "allow"
			: null;
	}

	const toolPaths = getToolPolicyPaths(toolName, input, cwd, bashAnalysis, context);
	if (toolPaths.length === 0) return null;
	const externalToolPaths = toolPaths.filter(
		(path) =>
			!isInsideDecisionWorktree(cwd, path, context) &&
			!isInsideDecisionTruncateDir(cwd, path, context),
	);
	if (externalToolPaths.length === 0) return null;
	return allPathsAllowedByPolicy(
		externalToolPaths,
		compiledPolicy,
		READ_ONLY_TOOLS.includes(toolName) ? "read" : "write",
	)
		? "allow"
		: null;
}

interface BlacklistDecisionResult {
	decision: "deny";
	reason: string;
}

const BLACKLIST_SOURCE_LABELS: Record<string, string> = {
	global: "global",
	project: "project",
	narrator: "narrator",
};

function formatBlacklistReason(dir: DirectoryBlacklistRule, matchedPath: string): string {
	const src = dir.source ? (BLACKLIST_SOURCE_LABELS[dir.source] ?? dir.source) : "unknown";
	const level = dir.denyLevel === "denyAll" ? "block all access" : "block write access";
	return `Blacklisted by ${src}-level rule: "${dir.path}" (${level}), matched path: ${matchedPath}`;
}

function getChapterGitPermissionIssues(bashAnalysis?: BashAnalysis): string[] {
	return [...(bashAnalysis?.gitBranchViolations ?? []), ...(bashAnalysis?.gitBranchWarnings ?? [])];
}

function resolveChapterGitIssueDecision(effectiveMode: string): "allow" | "deny" | "ask" {
	if (effectiveMode === "bypassPermissions") return "allow";
	if (effectiveMode === "dontAsk" || effectiveMode === "readOnly") return "deny";
	return "ask";
}

function isSpecTasksPath(value: unknown): boolean {
	if (!specVfsService.isSpecUri(value)) return false;
	try {
		return specVfsService.normalizeSpecPath(value) === SPEC_TASKS_PATH;
	} catch {
		return false;
	}
}

function isTaskStateMaintenanceTool(toolName: string, input: Record<string, unknown>): boolean {
	if (toolName === "TaskCreate") return true;
	if (toolName !== "Write" && toolName !== "Edit") return false;
	return isSpecTasksPath(input.file_path);
}

function compiledPolicyForDecision(opts: PermissionDecisionOpts): CompiledExecutionPolicy {
	if (opts.compiledPolicy) return opts.compiledPolicy;
	const legacy = normalizeExecutionPolicyRuleSet(
		{
			whitelistDirs: opts.whitelistDirs,
			blacklistDirs: opts.blacklistDirs,
			commandWhitelist: opts.commandWhitelist,
			commandBlacklist: opts.commandBlacklist,
		},
		"narrator",
	);
	return compileExecutionPolicy(legacy, opts.executionContext);
}

export function resolvePermissionDecision(
	opts: PermissionDecisionOpts,
): "allow" | "deny" | "ask" | "fatal" {
	const {
		toolName,
		input,
		permMode,
		cwd,
		bashAnalysis,
		isChapter = false,
		planFileId,
		conclusionFileId,
		relaxedPlan = false,
		planMode = false,
		meta,
		projectGitPath,
		executionBackend,
		executionTarget,
		executionContext,
	} = opts;
	const compiledPolicy = compiledPolicyForDecision(opts);
	const context = executionContext ?? compiledPolicy.targetContext;
	const effectiveMode = planMode ? (relaxedPlan ? (permMode ?? "default") : "readOnly") : permMode;
	if (toolName === SHELL_TOOL_NAME && bashAnalysis?.isCatastrophic) return "fatal";

	const protectedPathReason = resolveProtectedPathDeny(
		toolName,
		input,
		cwd,
		projectGitPath,
		bashAnalysis,
		context,
		executionBackend,
		executionTarget,
	);
	if (protectedPathReason) {
		if (meta) meta.blacklistReason = protectedPathReason;
		return "deny";
	}

	// Task queue maintenance is session metadata, not a project/worktree write. Keep it
	// available in read-only/exploration flows just like the legacy TaskCreate/TodoWrite path.
	if (isTaskStateMaintenanceTool(toolName, input)) return "allow";

	if (planMode && (toolName === "Write" || toolName === "Edit")) {
		if (planFileId) {
			const filePath = typeof input.file_path === "string" ? input.file_path : "";
			const absPath =
				(context && executionTargetPolicyPath(context)) ??
				resolveDecisionPath(cwd, filePath, context);
			const planFilePath = resolveDecisionPath(cwd, `.narrafork/plan-${planFileId}.md`, context);
			if (decisionPaths(context).equals(absPath, planFilePath)) return "allow";
		}
		if (!relaxedPlan) {
			if (meta) {
				const planFile = planFileId ? `.narrafork/plan-${planFileId}.md` : "(unknown)";
				meta.blacklistReason =
					`Plan mode: Write/Edit is only allowed to the plan file "${planFile}". ` +
					`Write your plan to that file, then call ExitPlanMode. ` +
					`Only after the user approves your plan can you implement changes.`;
				meta.planModeSoftDeny = true;
			}
			return "deny";
		}
	}

	if (ALWAYS_ASK_TOOLS.includes(toolName)) return "ask";
	if (ALWAYS_ALLOW_TOOLS.includes(toolName)) return "allow";

	// WebFetch: URL-based permission policy.
	if (toolName === "WebFetch") {
		const url = typeof input.url === "string" ? input.url.toLowerCase() : "";
		const policy = opts.webFetchPolicy;
		if (policy) {
			const blEntries = (policy.blacklist ?? []).filter((e) => e.enabled !== false);
			for (const entry of blEntries) {
				if (entry.pattern && url.includes(entry.pattern.toLowerCase())) {
					if (meta)
						meta.blacklistReason = `WebFetch URL blocked by blacklist pattern: "${entry.pattern}"`;
					return "deny";
				}
			}
			if (policy.allowAll) return "allow";
			const wlEntries = (policy.whitelist ?? []).filter((e) => e.enabled !== false);
			for (const entry of wlEntries) {
				if (entry.pattern && url.includes(entry.pattern.toLowerCase())) {
					return "allow";
				}
			}
		}
		if (effectiveMode === "bypassPermissions") return "allow";
		if (effectiveMode === "dontAsk") return "deny";
		if (effectiveMode === "readOnly") return "ask";
		return "ask";
	}

	// Command blacklist
	if ((toolName === SHELL_TOOL_NAME || toolName === "Shell") && bashAnalysis) {
		const commandDecision = compiledPolicy.evaluateCommands(
			bashAnalysis.commands.map((command) => command.tokens),
		);
		if (commandDecision.decision === "deny") {
			if (meta) {
				const source = commandDecision.rule.source ? ` (${commandDecision.rule.source} level)` : "";
				meta.commandBlacklistReason =
					`Command "${commandDecision.command.join(" ")}" is blocked by command blacklist${source}. ` +
					`Pattern: "${commandDecision.rule.pattern}"`;
				if (commandDecision.rule.denyPrompt) {
					meta.commandBlacklistDenyPrompt = commandDecision.rule.denyPrompt;
				}
			}
			return "deny";
		}
	}

	// Path blacklist takes priority over path whitelist.
	const blacklistResult = resolveBlacklistDecision(
		toolName,
		input,
		cwd,
		compiledPolicy,
		bashAnalysis,
		context,
	);
	if (blacklistResult) {
		if (meta) meta.blacklistReason = blacklistResult.reason;
		return "deny";
	}

	const chapterGitIssues = isChapter ? getChapterGitPermissionIssues(bashAnalysis) : [];
	if (toolName === SHELL_TOOL_NAME && chapterGitIssues.length > 0) {
		return resolveChapterGitIssueDecision(effectiveMode);
	}

	const whitelistDecision = resolveWhitelistDecision(
		toolName,
		input,
		cwd,
		compiledPolicy,
		bashAnalysis,
		context,
	);
	if (whitelistDecision) return whitelistDecision;

	// MCP tool permission: check server-level defaultBehavior and per-tool overrides
	const mcpDecision = resolveMcpToolPermission(toolName, effectiveMode);
	if (mcpDecision) return mcpDecision;

	// Command whitelist
	let effectiveBashAnalysis = bashAnalysis;
	if (
		(toolName === SHELL_TOOL_NAME || toolName === "Shell") &&
		bashAnalysis &&
		isCommandWhitelistCovered(bashAnalysis, compiledPolicy.commandWhitelist)
	) {
		effectiveBashAnalysis = {
			...bashAnalysis,
			allWhitelisted: true,
			nonWhitelisted: [],
			dangerousPatterns: filterWhitelistedPipePatterns(
				bashAnalysis.dangerousPatterns,
				compiledPolicy.commandWhitelist,
			),
		};
	}
	// Explicit user/project/global command whitelist entries mean "auto-allow without
	// asking". This is tracked separately from `allWhitelisted` (which only means the
	// builtin analyzer found nothing unsafe) so an explicit allowlist hit still skips
	// the approval prompt in interactive default mode.
	const explicitCommandWhitelisted =
		toolName === SHELL_TOOL_NAME &&
		!!bashAnalysis &&
		isExplicitlyCommandWhitelisted(bashAnalysis, compiledPolicy.commandWhitelist);

	// Agent tool
	if (toolName === "Agent") {
		const workdir = input.workdir;
		const resolvedWorkdir =
			typeof workdir === "string" && workdir ? resolveDecisionPath(cwd, workdir, context) : null;
		const normalizedCwd = decisionCwd(cwd, context);
		const isOutsideCwd =
			resolvedWorkdir !== null && !decisionPaths(context).contains(normalizedCwd, resolvedWorkdir);
		const isDifferentDir =
			resolvedWorkdir !== null && !decisionPaths(context).equals(resolvedWorkdir, normalizedCwd);

		if (effectiveMode === "readOnly") {
			if (input.subagent_type !== "explore" && input.subagent_type !== "plan") return "deny";
			if (isOutsideCwd) return "ask";
			return "allow";
		}
		if (isDifferentDir) {
			if (effectiveMode === "bypassPermissions") return "allow";
			if (effectiveMode === "dontAsk") return "deny";
			return "ask";
		}
		return "allow";
	}

	if (effectiveMode === "bypassPermissions") return "allow";
	if (effectiveMode === "dontAsk") return "deny";

	// Recall: self-scoped reads are always safe (read-only on own conversation).
	// Cross-narrator reads (all_narrators) require approval outside bypass mode.
	if (toolName === "Recall") {
		if (input.all_narrators !== true) return "allow";
		return "ask";
	}

	// Conclusion file: always allow Write/Edit targeting the designated conclusion file,
	// regardless of permission mode. This handles the fallback case where the conclusion
	// file lives outside cwd (e.g. ~/.narrafork/conclusions/) because cwd is read-only.
	if (conclusionFileId && (toolName === "Write" || toolName === "Edit")) {
		const filePath = typeof input.file_path === "string" ? input.file_path : "";
		if (filePath) {
			const absPath =
				(context && executionTargetPolicyPath(context)) ??
				resolveDecisionPath(cwd, filePath, context);
			const conclusionPath = resolveDecisionPath(
				cwd,
				resolveConclusionFilePath(cwd, conclusionFileId),
				context,
			);
			if (decisionPaths(context).equals(absPath, conclusionPath)) return "allow";
		}
	}

	// readOnly mode
	if (effectiveMode === "readOnly") {
		if (READ_ONLY_TOOLS.includes(toolName)) {
			const toolPaths = getToolPolicyPaths(toolName, input, cwd, bashAnalysis, context);
			const hasExternalPath =
				toolPaths.length > 0 &&
				toolPaths.some((path) => !isInsideDecisionWorktree(cwd, path, context));
			if (
				!hasExternalPath ||
				(toolPaths.length > 0 &&
					toolPaths.every((path) => isInsideDecisionTruncateDir(cwd, path, context)))
			) {
				return "allow";
			}
			return "deny";
		}
		if (toolName === SHELL_TOOL_NAME) {
			if (!effectiveBashAnalysis) return "deny";
			if (effectiveBashAnalysis.nonWhitelisted.length > 0) return "deny";
			if (effectiveBashAnalysis.dangerousPatterns.length > 0) return "deny";
			if (effectiveBashAnalysis.hasEnvInjection) return "deny";
			if (effectiveBashAnalysis.hasWriteOperation) return "deny";
			const externalBashPaths = getShellScopePaths(
				cwd,
				input,
				effectiveBashAnalysis,
				context,
			).filter(
				(path) =>
					!isInsideDecisionWorktree(cwd, path, context) &&
					!isInsideDecisionTruncateDir(cwd, path, context),
			);
			if (externalBashPaths.length > 0) return "deny";
			return "allow";
		}
		return "deny";
	}

	// Bash/Shell: AST-based command-level security
	if (toolName === SHELL_TOOL_NAME) {
		if (!effectiveBashAnalysis) return "ask";
		if (effectiveBashAnalysis.nonWhitelisted.length > 0) return "ask";
		if (effectiveBashAnalysis.dangerousPatterns.length > 0) return "ask";
		if (effectiveBashAnalysis.hasEnvInjection) return "ask";
		const externalBashPaths = getShellScopePaths(cwd, input, effectiveBashAnalysis, context).filter(
			(path) =>
				!isInsideDecisionWorktree(cwd, path, context) &&
				!isInsideDecisionTruncateDir(cwd, path, context),
		);
		if (externalBashPaths.length > 0) return "ask";
		// Explicit command allowlist means the user pre-approved this exact command.
		// Blacklists, catastrophic checks, and path scoping already ran above.
		if (explicitCommandWhitelisted) return "allow";
		if (effectiveBashAnalysis.hasWriteOperation && effectiveMode !== "acceptEdits") return "ask";
		if (effectiveMode === "acceptEdits") return "allow";
		// Interactive default mode only asks for mutations. A command confirmed to be
		// purely read-only inside the worktree carries no state change, so prompting for
		// it is pure friction.
		if (effectiveBashAnalysis.allReadOnly) return "allow";
		return "ask";
	}

	const toolPaths = getToolPolicyPaths(toolName, input, cwd, bashAnalysis, context);
	const hasExternalPath =
		toolPaths.length > 0 && toolPaths.some((path) => !isInsideDecisionWorktree(cwd, path, context));

	if (!hasExternalPath) {
		if (effectiveMode === "default") {
			return READ_ONLY_TOOLS.includes(toolName) ? "allow" : "ask";
		}
		if (effectiveMode === "acceptEdits" && ACCEPT_EDITS_AUTO_ALLOW.includes(toolName))
			return "allow";
	}

	if (
		hasExternalPath &&
		READ_ONLY_TOOLS.includes(toolName) &&
		toolPaths.every((path) => isInsideDecisionTruncateDir(cwd, path, context))
	) {
		return "allow";
	}

	return "ask";
}

function resolveBlacklistDecision(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	compiledPolicy: CompiledExecutionPolicy,
	bashAnalysis?: BashAnalysis,
	context?: ExecutionTargetContext | null,
): BlacklistDecisionResult | null {
	if (compiledPolicy.directoryBlacklist.length === 0) return null;

	const operation =
		toolName === "Agent"
			? input.subagent_type === "explore" || input.subagent_type === "plan"
				? "read"
				: "full"
			: toolName === SHELL_TOOL_NAME || toolName === "Shell"
				? bashAnalysis?.hasWriteOperation
					? "write"
					: "read"
				: READ_ONLY_TOOLS.includes(toolName)
					? "read"
					: "write";
	const paths =
		toolName === "Agent" && typeof input.workdir === "string" && input.workdir
			? [resolveDecisionPath(cwd, input.workdir, context)]
			: getToolPolicyPaths(toolName, input, cwd, bashAnalysis, context);
	for (const path of paths) {
		const result = compiledPolicy.evaluatePath({ path, operation });
		if (result.decision === "deny") {
			return { decision: "deny", reason: formatBlacklistReason(result.rule, path) };
		}
	}
	return null;
}

const ALWAYS_ALLOW_TOOLS = [
	"EnterPlanMode",
	"WebSearch",
	"Await",
	"Skill",
	"LearningGuide",
	// SwitchDevice only changes which device subsequent file/command tool calls default
	// to — it never reads, writes, or executes anything itself. Its own execute() already
	// validates the target against the session's authorized/online device set (or local
	// execution policy), so it's safe in readOnly/dontAsk/plan mode alike. Without this,
	// readOnly-mode sessions with multiple devices have no way to change the routing
	// target at all, since every other tool call still requires an explicit `device` arg.
	"SwitchDevice",
	// Pack tools: PackList (read-only listing) and PackDeactivate (only shrinks access)
	// are safe to auto-allow. PackActivate self-gates via ctx.requestPermission when
	// settings.knowledge.packActivateRequiresPermission is true, so the loop-level check
	// allows it through and the tool itself prompts (avoids double-prompting).
	"PackList",
	"PackActivate",
	"PackDeactivate",
];

const ACCEPT_EDITS_AUTO_ALLOW = ["Edit", "Write", "NotebookEdit", "Read", "Glob", "Grep"];

/** Tools that don't modify the project worktree — safe to auto-allow in readOnly mode. */
const READ_ONLY_TOOLS = [
	"Read",
	"Grep",
	"Glob",
	"ShareFile",
	"ContextAsk",
	"Await",
	"KnowledgeSearch",
	"KnowledgeRead",
	"KnowledgeLibrary",
];

/** Tools that always require user approval regardless of permission mode. */
const ALWAYS_ASK_TOOLS = ["ExitPlanMode", "AskUserQuestion"];

export interface WhitelistDir extends LegacyDirectoryWhitelistEntry {
	accessLevel: "readOnly" | "readWrite" | "full";
	enabled: boolean;
	source?: "global" | "project" | "narrator";
}

export interface BlacklistDir extends LegacyDirectoryBlacklistEntry {
	denyLevel: "denyWrite" | "denyAll";
	enabled: boolean;
	source?: "global" | "project" | "narrator";
}

export interface CommandWhitelistEntry extends LegacyCommandWhitelistEntry {
	enabled: boolean;
	source?: "global" | "project" | "narrator";
}

export interface CommandBlacklistEntry extends LegacyCommandBlacklistEntry {
	enabled: boolean;
	source?: "global" | "project" | "narrator";
}

/** Metadata collected during permission decision (side-channel output). */
export interface PermissionDecisionMeta {
	blacklistReason?: string;
	commandBlacklistReason?: string;
	commandBlacklistDenyPrompt?: string;
	planModeSoftDeny?: boolean;
}

/**
 * Map a four-level MCP behavior to a final permission decision based on the
 * narrator's effective permission mode.
 *
 *   readOnly  → allow in all interactive modes (including readOnly), deny in dontAsk
 *   readWrite → allow in acceptEdits/bypassPermissions, ask in default, deny in readOnly/dontAsk
 *   allow     → legacy auto-allow, denied in readOnly/dontAsk
 *   ask       → ask in interactive modes, deny in dontAsk
 *   deny      → always deny
 */
function mapMcpBehaviorToDecision(
	behavior: string,
	effectiveMode: string,
): "allow" | "deny" | "ask" {
	switch (behavior) {
		case "readOnly":
			return effectiveMode === "dontAsk" ? "deny" : "allow";
		case "readWrite":
			if (effectiveMode === "bypassPermissions" || effectiveMode === "acceptEdits") return "allow";
			if (effectiveMode === "readOnly" || effectiveMode === "dontAsk") return "deny";
			return "ask"; // default mode
		case "allow": // legacy value from pre readOnly/readWrite MCP settings
			return effectiveMode === "readOnly" || effectiveMode === "dontAsk" ? "deny" : "allow";
		case "ask":
			return effectiveMode === "dontAsk" ? "deny" : "ask";
		case "deny":
			return "deny";
		default:
			return "ask";
	}
}

/**
 * Resolve MCP tool permission from server-level config.
 * Checks per-tool overrides first, then server defaultBehavior.
 * Returns null when no MCP-specific config applies (fall through to normal logic).
 */
function resolveMcpToolPermission(
	toolName: string,
	effectiveMode: string,
): "allow" | "deny" | "ask" | null {
	if (!toolName.startsWith("mcp__")) return null;
	// bypassPermissions is handled upstream — everything is auto-allowed.
	if (effectiveMode === "bypassPermissions") return null;

	// Look up tool metadata from the registry
	const toolDef = toolRegistry.get(toolName);
	const meta = toolDef?.metadata;
	if (!meta?.mcpServerId) return null;

	const servers = settings.mcpServers;
	if (!servers) return null;
	const serverConfig = servers.find((s) => s.id === meta.mcpServerId);
	if (!serverConfig) return null;

	// Per-tool override takes priority
	if (serverConfig.toolPermissions) {
		const toolPerm = serverConfig.toolPermissions.find(
			(tp) => tp.toolName === meta.mcpToolName && tp.enabled !== false,
		);
		if (toolPerm) return mapMcpBehaviorToDecision(toolPerm.behavior, effectiveMode);
	}

	// Server-level default
	if (serverConfig.defaultBehavior) {
		return mapMcpBehaviorToDecision(serverConfig.defaultBehavior, effectiveMode);
	}

	return null;
}

export interface PermissionDecisionOpts {
	toolName: string;
	input: Record<string, unknown>;
	permMode: string;
	cwd: string;
	bashAnalysis?: BashAnalysis;
	isChapter?: boolean;
	planFileId?: string;
	planMode?: boolean;
	conclusionFileId?: string;
	whitelistDirs?: WhitelistDir[];
	blacklistDirs?: BlacklistDir[];
	commandWhitelist?: CommandWhitelistEntry[];
	commandBlacklist?: CommandBlacklistEntry[];
	relaxedPlan?: boolean;
	previousPermissionMode?: string;
	meta?: PermissionDecisionMeta;
	projectGitPath?: string;
	/** Precompiled global/project/narrator policy for the frozen target. */
	compiledPolicy?: CompiledExecutionPolicy;
	/** Complete frozen target context. Scoped rules fail closed when this is absent. */
	executionContext?: ExecutionTargetContext | null;
	/** Legacy compatibility fields; routed main flow uses executionContext. */
	executionBackend?: ExecutionBackend;
	executionTarget?: Readonly<ToolExecutionTarget>;
	webFetchPolicy?: {
		allowAll?: boolean;
		whitelist?: Array<{ pattern: string; enabled?: boolean }>;
		blacklist?: Array<{ pattern: string; enabled?: boolean }>;
	};
}

// ── Command policy helpers ────────────────────────────────

function filterWhitelistedPipePatterns(
	dangerousPatterns: string[],
	commandWhitelist: readonly CommandWhitelistRule[],
): string[] {
	if (commandWhitelist.length === 0) return dangerousPatterns;
	return dangerousPatterns.filter((pattern) => {
		const match = pattern.match(/^pipe to (.+)$/);
		if (!match) return true;
		return !commandWhitelist.some((rule) => commandPatternMatches([match[1]], rule.pattern));
	});
}

function isCommandWhitelistCovered(
	bashAnalysis: BashAnalysis,
	commandWhitelist: readonly CommandWhitelistRule[],
): boolean {
	if (bashAnalysis.allWhitelisted || bashAnalysis.hasEnvInjection) return false;
	const remainingDangerous = filterWhitelistedPipePatterns(
		bashAnalysis.dangerousPatterns,
		commandWhitelist,
	);
	if (remainingDangerous.length > 0) return false;
	if (bashAnalysis.nonWhitelisted.length === 0) return true;
	if (commandWhitelist.length === 0) return false;
	return bashAnalysis.nonWhitelisted.every((commandName) => {
		const command = bashAnalysis.commands.find((candidate) => candidate.tokens[0] === commandName);
		return (
			!!command &&
			commandWhitelist.some((rule) => commandPatternMatches(command.tokens, rule.pattern))
		);
	});
}

function isCommandWhitelisted(
	command: BashAnalysis["commands"][number],
	commandWhitelist: readonly CommandWhitelistRule[],
): boolean {
	return commandWhitelist.some(
		(rule) => rule.enabled && commandPatternMatches(command.tokens, rule.pattern),
	);
}

/**
 * Whether every parsed command is covered by an explicit (user/project/global) command
 * whitelist entry. Unlike `isCommandWhitelistCovered`, this does not short-circuit on
 * `allWhitelisted`: a command can be both builtin-safe and explicitly allowlisted, and
 * the explicit entry is what upgrades it from "ask" to "auto-allow".
 *
 * Env injection still disqualifies the command, and remaining dangerous patterns that
 * the whitelist does not cover are treated as not whitelisted. Path scoping, path
 * blacklists, command blacklists, and catastrophic detection are enforced by the
 * caller before this is consulted.
 */
function isExplicitlyCommandWhitelisted(
	bashAnalysis: BashAnalysis,
	commandWhitelist: readonly CommandWhitelistRule[],
): boolean {
	if (commandWhitelist.length === 0) return false;
	if (bashAnalysis.hasEnvInjection) return false;
	if (bashAnalysis.commands.length === 0) return false;
	const remainingDangerous = filterWhitelistedPipePatterns(
		bashAnalysis.dangerousPatterns,
		commandWhitelist,
	);
	if (remainingDangerous.length > 0) return false;
	return bashAnalysis.commands.every((cmd) => isCommandWhitelisted(cmd, commandWhitelist));
}

function areUnsafeCommandsWhitelistedForDanger(
	bashAnalysis: BashAnalysis,
	commandWhitelist: readonly CommandWhitelistRule[],
): boolean {
	if (commandWhitelist.length === 0 || bashAnalysis.hasEnvInjection) return false;
	if (bashAnalysis.nonWhitelisted.length === 0) return false;
	return bashAnalysis.nonWhitelisted.every((commandName) => {
		const command = bashAnalysis.commands.find((candidate) => candidate.tokens[0] === commandName);
		return !!command && isCommandWhitelisted(command, commandWhitelist);
	});
}

// ── Protected path checks (hard-deny, no bypass) ─────────

const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
const DESTRUCTIVE_COMMANDS = new Set(["rm", "rmdir", "shred"]);

function executionPathOS(backend?: ExecutionBackend): string {
	return backend?.platform?.os ?? (process.platform === "win32" ? "windows" : "posix");
}

function isGitInternalPath(absPath: string, os: string): boolean {
	return normalizePathForOS(absPath, os).split("/").includes(".git");
}

function resolveProtectedTargetPath(
	filePath: string,
	cwd: string,
	context?: ExecutionTargetContext | null,
	backend?: ExecutionBackend,
	target?: Readonly<ToolExecutionTarget>,
): string {
	if (context) {
		return (
			executionTargetPolicyPath(context) ?? context.paths.resolve(context.target.cwd, filePath)
		);
	}
	if (target?.canonicalPath) return target.canonicalPath;
	if (target?.lexicalPath) return target.lexicalPath;
	if (target?.resolvedFilePath) return target.resolvedFilePath;
	if (!backend) return resolvePath(cwd, filePath);
	return resolveBackendPath(backend, target?.cwd ?? toolBaseCwd(backend, cwd), filePath);
}

function isStructuralPath(absPath: string, projectGitPath: string): string | null {
	const normalizedTarget = resolvePath(absPath);
	const normalizedProject = resolvePath(projectGitPath);
	if (pathsEqual(normalizedTarget, normalizedProject)) {
		return `project root directory: ${normalizedProject}`;
	}
	if (
		isInsidePath(normalizedTarget, normalizedProject) &&
		!pathsEqual(normalizedTarget, normalizedProject)
	) {
		return `ancestor of project root: ${normalizedTarget}`;
	}
	if (pathsEqual(normalizedTarget, `${normalizedProject}/.worktrees`)) {
		return `worktrees directory: ${normalizedTarget}`;
	}
	return null;
}

function resolveProtectedPathDeny(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	projectGitPath: string | undefined,
	bashAnalysis?: BashAnalysis,
	executionContext?: ExecutionTargetContext | null,
	executionBackend?: ExecutionBackend,
	executionTarget?: Readonly<ToolExecutionTarget>,
): string | null {
	const backend = executionContext?.backend ?? executionBackend;
	const targetOS = executionPathOS(backend);
	const targetCwd =
		executionContext?.target.cwd ??
		executionTarget?.cwd ??
		toolBaseCwd(backend ?? localBackend, cwd);
	const targetPaths = executionContext?.paths ?? backend?.paths ?? localPathSemantics;
	if (WRITE_TOOLS.has(toolName) || toolName === "Browser") {
		const filePath = typeof input.file_path === "string" ? input.file_path : "";
		if (!filePath || (toolName === "Browser" && input.action !== "screenshot")) return null;
		const absPath = resolveProtectedTargetPath(
			filePath,
			cwd,
			executionContext,
			executionBackend,
			executionTarget,
		);
		if (isGitInternalPath(absPath, targetOS)) {
			return `Write to .git directory is forbidden: ${absPath}`;
		}
		return null;
	}

	if (toolName === SHELL_TOOL_NAME && bashAnalysis) {
		if (bashAnalysis.hasWriteOperation) {
			for (const p of bashAnalysis.filePaths) {
				if (isGitInternalPath(p, targetOS)) {
					return `Shell write operation targeting .git directory is forbidden: ${p}`;
				}
			}
		}
		// projectGitPath is a NarraFork-host structural boundary. Apply it only when the
		// frozen target is explicitly local; remote targets still receive target-grammar .git checks.
		const isLocalTarget = executionContext
			? executionContext.backend.kind === "local" &&
				executionContext.target.deviceId === LOCAL_DEVICE_ID &&
				executionContext.paths.flavor !== "spec"
			: executionBackend?.kind !== "remote";
		if (projectGitPath && isLocalTarget) {
			for (const cmd of bashAnalysis.commands) {
				const cmdName = cmd.tokens[0];
				if (!DESTRUCTIVE_COMMANDS.has(cmdName)) continue;
				for (const arg of cmd.tokens.slice(1)) {
					if (arg.startsWith("-")) continue;
					const absArg = targetPaths.resolve(targetCwd, arg);
					if (isGitInternalPath(absArg, targetOS)) {
						return `Destructive operation on .git directory is forbidden: ${cmdName} ${absArg}`;
					}
					const structural = isStructuralPath(absArg, projectGitPath);
					if (structural) {
						return `Destructive operation on ${structural} is forbidden: ${cmdName} ${absArg}`;
					}
				}
			}
		}
	}

	return null;
}

const DANGER_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => a.localeCompare(b));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

function getDangerFingerprintScope(
	toolName: string,
	input: Record<string, unknown>,
	cwd?: string,
	bashAnalysis?: BashAnalysis,
	context?: ExecutionTargetContext | null,
): Record<string, unknown> {
	if (context) {
		const scopePaths = getToolPolicyPaths(
			toolName,
			input,
			cwd ?? context.target.cwd,
			bashAnalysis,
			context,
		);
		return {
			deviceId: context.target.deviceId,
			pathFlavor: context.paths.flavor,
			targetPath:
				context.target.canonicalPath ??
				context.target.lexicalPath ??
				context.target.resolvedFilePath,
			runtimeGeneration: context.target.runtimeGeneration ?? context.backend.runtimeGeneration ?? 0,
			cwd: context.target.cwd,
			resolvedPaths: [...new Set(scopePaths.map((path) => context.paths.identityKey(path)))].sort(),
		};
	}
	if (!cwd) return {};
	const normalizedCwd = resolvePath(cwd);
	let paths: string[] = [];
	if (toolName === SHELL_TOOL_NAME) {
		paths = getShellScopePaths(normalizedCwd, input, bashAnalysis);
	} else if (toolName === "Agent") {
		const workdir = typeof input.workdir === "string" ? input.workdir : "";
		paths = workdir ? [workdir] : [];
	} else {
		paths = extractToolPaths(toolName, input);
	}
	const resolvedPaths = [...new Set(paths.map((path) => resolvePath(normalizedCwd, path)))].sort();
	return {
		deviceId: LOCAL_DEVICE_ID,
		pathFlavor: localPathSemantics.flavor,
		cwd: normalizedCwd,
		resolvedPaths,
	};
}

/**
 * 从 input 中提取影响 fingerprint 的核心字段，剔除 description 等不影响执行语义的字段。
 * 这确保 AI 模型重试相同命令时（即使 description 措辞不同）能匹配到之前的 danger 确认。
 */
function getDangerFingerprintInput(
	toolName: string,
	input: Record<string, unknown>,
): Record<string, unknown> {
	if (toolName === SHELL_TOOL_NAME) {
		// 只保留影响执行语义的字段：command 和 workdir
		const result: Record<string, unknown> = {};
		if (input.command !== undefined) result.command = input.command;
		if (input.workdir !== undefined) result.workdir = input.workdir;
		return result;
	}
	return input;
}

export function createDangerFingerprint(
	toolName: string,
	input: Record<string, unknown>,
	cwd?: string,
	bashAnalysis?: BashAnalysis,
	context?: ExecutionTargetContext | null,
	policyRevision?: string,
): string {
	return createHash("sha256")
		.update(
			stableJson({
				input: getDangerFingerprintInput(toolName, input),
				policyRevision: policyRevision ?? "legacy",
				scope: getDangerFingerprintScope(toolName, input, cwd, bashAnalysis, context),
				toolName,
			}),
		)
		.digest("hex");
}

function pruneExpiredDangerConfirmations(now = Date.now()): void {
	for (const [key, entry] of pendingDangerConfirmations) {
		if (entry.expiresAt < now) pendingDangerConfirmations.delete(key);
	}
}

function dangerConfirmationKey(narratorId: string, fingerprint: string): string {
	return `${narratorId}:${fingerprint}`;
}

function consumeDangerConfirmation(narratorId: string, fingerprint: string): boolean {
	pruneExpiredDangerConfirmations();
	const key = dangerConfirmationKey(narratorId, fingerprint);
	const entry = pendingDangerConfirmations.get(key);
	if (!entry) return false;
	pendingDangerConfirmations.delete(key);
	return true;
}

function rememberDangerConfirmation(
	narratorId: string,
	fingerprint: string,
	danger: DangerInfo,
): void {
	const now = Date.now();
	pruneExpiredDangerConfirmations(now);
	pendingDangerConfirmations.set(dangerConfirmationKey(narratorId, fingerprint), {
		narratorId,
		fingerprint,
		expiresAt: now + DANGER_CONFIRMATION_TTL_MS,
		summary: danger.summary,
	});
}

function getEffectivePermissionMode(
	permMode: string,
	planMode: boolean,
	relaxedPlan: boolean,
	_previousPermissionMode?: string | null,
): string {
	return planMode ? (relaxedPlan ? (permMode ?? "default") : "readOnly") : permMode;
}

type QuestionReflectionStatus = "running" | "awaiting_user" | "confirmed" | "cancelled" | "aborted";

function questionReflectionSuggestions(
	status: QuestionReflectionStatus,
	requestId: string,
	reason?: string,
) {
	return [
		{
			type: "question_reflection",
			status,
			requestId,
			resolvedAt: status === "running" ? undefined : new Date().toISOString(),
			...(reason ? { reason } : {}),
		},
	];
}

async function markQuestionReflectionStatus(
	requestId: string,
	pending: PendingPermission,
	status: QuestionReflectionStatus,
	reason?: string,
): Promise<void> {
	const suggestions = questionReflectionSuggestions(status, requestId, reason);
	await db
		.update(narratorToolCalls)
		.set({
			permissionSuggestions: suggestions,
			...(reason ? { permissionDecisionReason: reason } : {}),
		})
		.where(eq(narratorToolCalls.id, requestId));

	if (status === "running") {
		broadcastReflectionFrame(pending, {
			type: "question_reflection_started",
			requestId,
			toolUseId: pending.toolUseId,
			toolName: pending.toolName,
			inputJson: pending.input,
			reason,
		});
	} else {
		broadcastReflectionFrame(pending, {
			type: "question_reflection_resolved",
			requestId,
			toolUseId: pending.toolUseId,
			decision:
				status === "confirmed"
					? "allow"
					: status === "aborted" || status === "awaiting_user"
						? "aborted"
						: "deny",
			reason,
		});
	}
}

/**
 * Broadcast one live progress tick for a running AskUserQuestion reflection.
 *
 * Transient only — see `broadcastDangerReflectionProgress` for why this is never
 * persisted. Stops silently once the permission is gone or the user took over.
 */
function broadcastQuestionReflectionProgress(requestId: string, snapshot: ProgressSnapshot): void {
	const pending = pendingPermissions.get(requestId);
	if (!pending || pending.questionReflectionStoppedByUser) return;
	broadcastReflectionFrame(pending, {
		type: "reflection_progress",
		requestId,
		toolUseId: pending.toolUseId,
		kind: "question_reflection",
		phase: snapshot.phase,
		thinkingChars: snapshot.thinkingChars,
		outputChars: snapshot.outputChars,
	});
}

function getQuestionReflectionTimeoutMs(): number {
	const value = settings.agent.questionReflectionTimeoutMs;
	return typeof value === "number" && Number.isFinite(value) ? Math.max(10_000, value) : 300_000;
}

function shouldScheduleQuestionReflection(effectiveMode: string): boolean {
	return effectiveMode === "bypassPermissions" && settings.agent.questionReflectionEnabled === true;
}

function scheduleQuestionReflection(
	requestId: string,
	effectiveMode: string,
	deadline: number,
): ReturnType<typeof setTimeout> | undefined {
	if (!shouldScheduleQuestionReflection(effectiveMode)) return undefined;
	const delay = Math.max(0, deadline - Date.now());
	return setTimeout(() => {
		void reflectPendingAskUserQuestion(requestId, { automatic: true }).catch((err) => {
			logger.warn("AskUserQuestion automatic reflection failed", {
				requestId,
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}, delay);
}

async function currentPermissionModeAllowsAutomaticQuestionReflection(
	pending: PendingPermission,
): Promise<boolean> {
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, pending.narratorId),
		columns: {
			permissionMode: true,
			relaxedPlan: true,
			previousPermissionMode: true,
			traits: true,
		},
	});
	if (!narrator) return false;
	const effectiveMode = getEffectivePermissionMode(
		narrator.permissionMode ?? "default",
		isPlanModeTrait(narrator.traits),
		resolveEffectiveRelaxedPlan(narrator.permissionMode, narrator.relaxedPlan),
		narrator.previousPermissionMode,
	);
	return shouldScheduleQuestionReflection(effectiveMode);
}

export async function reflectPendingAskUserQuestion(
	requestId: string,
	opts: { automatic?: boolean } = {},
): Promise<{ ok: boolean; answers?: Record<string, string>; reason?: string }> {
	const pending = pendingPermissions.get(requestId);
	if (!pending) return { ok: false, reason: "Permission request not found" };
	if (pending.toolName !== "AskUserQuestion") {
		return { ok: false, reason: "Permission request is not AskUserQuestion" };
	}
	if (pending.signal.aborted) return { ok: false, reason: "Narrator aborted" };
	if (opts.automatic) {
		if (!(await currentPermissionModeAllowsAutomaticQuestionReflection(pending))) {
			return { ok: false, reason: "Question reflection is not enabled for this permission mode" };
		}
	}

	if (pending.questionReflectionStoppedByUser) {
		return { ok: false, reason: "Question reflection was taken over by the user" };
	}

	if (pending.questionReflectionTimer) {
		clearTimeout(pending.questionReflectionTimer);
		pending.questionReflectionTimer = undefined;
	}
	pending.questionReflectionDeadline = undefined;

	const questions = coerceAskQuestions(pending.input.questions);
	if (questions.length === 0) return { ok: false, reason: "No AskUserQuestion questions found" };

	const abort = new AbortController();
	pending.questionReflectionAbort = abort;

	await markQuestionReflectionStatus(
		requestId,
		pending,
		"running",
		"Question reflection is answering AskUserQuestion",
	);
	try {
		const narrator = await narratorService.getById(pending.narratorId).catch(() => null);
		const answers = await generateAskUserQuestionAnswers(pending.narratorId, questions, {
			locale: pending.locale,
			model: narrator?.model,
			mode: "reflection",
			signal: abort.signal,
			onProgress: (snapshot) => broadcastQuestionReflectionProgress(requestId, snapshot),
		});
		if (!pendingPermissions.has(requestId)) {
			await db
				.update(narratorToolCalls)
				.set({ permissionSuggestions: null })
				.where(eq(narratorToolCalls.id, requestId));
			return { ok: false, answers, reason: "Already resolved" };
		}
		if (pending.questionReflectionStoppedByUser) {
			return { ok: false, answers, reason: "Question reflection was taken over by the user" };
		}
		await markQuestionReflectionStatus(
			requestId,
			pending,
			"confirmed",
			"Question reflection answered automatically",
		);
		const resolved = await resolvePermission(requestId, "allow", {
			answers,
			decidedBy: "reflection",
		});
		return { ok: resolved, answers, reason: resolved ? undefined : "Already resolved" };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		// A user takeover aborts the generation on purpose; takeOverQuestionReflection
		// already broadcast the "awaiting_user" status, so don't clobber it here.
		if (pending.questionReflectionStoppedByUser) {
			return { ok: false, reason: "Question reflection was taken over by the user" };
		}
		logger.warn("AskUserQuestion reflection failed", {
			requestId,
			narratorId: pending.narratorId,
			reason,
		});
		if (pendingPermissions.has(requestId)) {
			await markQuestionReflectionStatus(requestId, pending, "awaiting_user", reason);
		}
		return { ok: false, reason };
	} finally {
		if (pending.questionReflectionAbort === abort) {
			pending.questionReflectionAbort = undefined;
		}
	}
}

/**
 * Absolute deadline (epoch ms) at which the pending AskUserQuestion reflection
 * will fire automatically, or null if none is scheduled. Used to reconstruct the
 * frontend countdown after a reconnect / permissions refetch.
 */
export function getQuestionReflectionDeadline(requestId: string): number | null {
	const pending = pendingPermissions.get(requestId);
	if (!pending || pending.toolName !== "AskUserQuestion") return null;
	if (pending.questionReflectionStoppedByUser) return null;
	return typeof pending.questionReflectionDeadline === "number"
		? pending.questionReflectionDeadline
		: null;
}

/**
 * Silently cancel the automatic AskUserQuestion reflection timer without changing
 * the permission state — the question stays pending for the user to answer. Used
 * when the user starts interacting with the question form so the auto-answer does
 * not fire mid-typing. Idempotent; returns whether a timer was actually disarmed.
 */
export function disarmQuestionReflection(requestId: string): boolean {
	const pending = pendingPermissions.get(requestId);
	if (!pending || pending.toolName !== "AskUserQuestion") return false;
	const hadTimer = pending.questionReflectionTimer !== undefined;
	if (pending.questionReflectionTimer) {
		clearTimeout(pending.questionReflectionTimer);
		pending.questionReflectionTimer = undefined;
	}
	const hadDeadline = pending.questionReflectionDeadline !== undefined;
	pending.questionReflectionDeadline = undefined;
	if (hadTimer || hadDeadline) {
		broadcastReflectionFrame(pending, {
			type: "question_reflection_disarmed",
			requestId,
			toolUseId: pending.toolUseId,
		});
	}
	return hadTimer || hadDeadline;
}

/**
 * User takes over an AskUserQuestion reflection: stop the timer, abort any
 * in-flight answer generation, and leave the question pending for the user to
 * answer (mirrors danger/plan/task takeover). Returns false if there is no such
 * pending request.
 */
export async function takeOverQuestionReflection(
	requestId: string,
	reason?: string,
): Promise<boolean> {
	const pending = pendingPermissions.get(requestId);
	if (!pending || pending.toolName !== "AskUserQuestion") return false;
	if (pending.signal.aborted) return false;
	const message = reason?.trim() || "Question reflection stopped; awaiting your answer";
	pending.questionReflectionStoppedByUser = true;
	if (pending.questionReflectionTimer) {
		clearTimeout(pending.questionReflectionTimer);
		pending.questionReflectionTimer = undefined;
	}
	pending.questionReflectionDeadline = undefined;
	pending.questionReflectionAbort?.abort(new Error(message));
	await markQuestionReflectionStatus(requestId, pending, "awaiting_user", message);
	return true;
}

function danger(
	summary: string,
	consequences: string[],
	saferAlternatives: string[],
	details?: string[],
	severity: DangerSeverity = "medium",
): DangerInfo {
	return { severity, summary, consequences, saferAlternatives, details };
}

function buildShellAnalysisFailureDanger(
	toolName: string,
	input: Record<string, unknown>,
	errorMessage: string,
): DangerInfo {
	const command = typeof input.command === "string" ? input.command : "";
	return danger(
		"Shell command safety analysis failed.",
		[
			"NarraFork could not inspect the command before execution.",
			"In Bypass All mode, executing an unanalyzed shell command may modify files, run code, or access external paths without an effective safety gate.",
		],
		[
			"Retry after fixing the command analysis failure.",
			"Break the task into dedicated read/write tools or smaller explicit commands.",
			"Run only after the visible command has been manually verified as intentional and bounded.",
		],
		[
			`Tool: ${toolName}`,
			...(command ? [`Command: ${command}`] : []),
			`Analysis error: ${errorMessage}`,
		],
		"medium",
	);
}

function buildPlanModeSoftDenyDanger(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	baseDanger?: DangerInfo | null,
	context?: ExecutionTargetContext | null,
): DangerInfo {
	const details = [
		`Tool: ${toolName}`,
		...extractToolPaths(toolName, input).map(
			(path) => `Target path: ${resolveDecisionPath(cwd, path, context)}`,
		),
		...(typeof input.command === "string" ? [`Command: ${input.command}`] : []),
		...(baseDanger?.details ?? []),
	];
	return danger(
		baseDanger?.summary ?? "Plan mode is about to be relaxed for a non-planning tool call.",
		[
			"The narrator is still in plan mode, but this approval will enable relaxed plan mode so edit-capable tools can run.",
			"Implementation changes may begin before the plan has gone through the normal plan-mode approval path.",
			...(baseDanger?.consequences ?? []),
		],
		[
			"Continue read-only investigation and write only to the designated plan file.",
			"Submit the complete plan first, then run implementation tools after approval.",
			...(baseDanger?.saferAlternatives ?? []),
		],
		details,
		baseDanger?.severity ?? "medium",
	);
}

function getGitSubcommand(tokens: string[]): { sub?: string; args: string[] } {
	let idx = 1;
	while (idx < tokens.length) {
		const token = tokens[idx];
		if ((token === "-C" || token === "-c") && idx + 1 < tokens.length) {
			idx += 2;
			continue;
		}
		if (
			(token === "--git-dir" || token === "--work-tree" || token === "--namespace") &&
			idx + 1 < tokens.length
		) {
			idx += 2;
			continue;
		}
		if (token.startsWith("--git-dir=") || token.startsWith("--work-tree=")) {
			idx++;
			continue;
		}
		if (token.startsWith("-")) {
			idx++;
			continue;
		}
		return { sub: token, args: tokens.slice(idx + 1) };
	}
	return { args: [] };
}

function describeExternalPaths(
	cwd: string,
	paths: string[],
	compiledPolicy: CompiledExecutionPolicy,
	requiredLevel: "read" | "write" | "full" = "read",
	context?: ExecutionTargetContext | null,
): string[] {
	const seen = new Set<string>();
	return paths
		.map((path) => resolveDecisionPath(cwd, path, context))
		.filter(
			(path) =>
				!isInsideDecisionWorktree(cwd, path, context) &&
				!isInsideDecisionTruncateDir(cwd, path, context),
		)
		.filter(
			(path) =>
				compiledPolicy.evaluatePath({ path, operation: requiredLevel }).decision !== "allow",
		)
		.filter((path) => {
			const key = decisionPaths(context).identityKey(path);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
}

function isLikelyCheckoutPathspec(arg: string): boolean {
	if (!arg || arg.startsWith("-")) return false;
	return (
		arg === "." ||
		arg === ".." ||
		arg.startsWith("./") ||
		arg.startsWith("../") ||
		arg.includes("/") ||
		arg.includes("\\") ||
		/\.[^/\\]+$/.test(arg)
	);
}

function checkoutRestoresPath(args: string[]): boolean {
	if (args.includes("--")) return true;
	if (args.includes(".")) return true;
	if (args.some((arg) => arg === "-b" || arg === "-B" || arg === "--orphan")) return false;
	if (args.some((arg) => arg.startsWith("--pathspec-from-file"))) return true;
	const positional = args.filter((arg) => !arg.startsWith("-"));
	return positional.some(isLikelyCheckoutPathspec);
}

function classifyGitDanger(cmdText: string, tokens: string[]): DangerInfo | null {
	const { sub, args } = getGitSubcommand(tokens);
	if (!sub) return null;
	const detail = [`Command: ${cmdText}`];
	const hasAny = (flags: string[]) => args.some((arg) => flags.includes(arg));
	const hasFlagPrefix = (prefixes: string[]) =>
		args.some((arg) => prefixes.some((p) => arg.startsWith(p)));

	if (sub === "reset" && (hasAny(["--hard", "--merge", "--keep"]) || args.length > 0)) {
		return danger(
			"Git reset may rewrite the current worktree/index state.",
			[
				"Uncommitted work can be discarded or unstaged.",
				"HEAD/index changes can be hard to reconstruct without reflog or backups.",
			],
			["Run git status and git diff first.", "Create a backup branch or stash before resetting."],
			detail,
			"high",
		);
	}
	if (sub === "clean") {
		return danger(
			"Git clean removes untracked files from the worktree.",
			[
				"Untracked files are often not recoverable from git.",
				"Generated artifacts, local notes, or new source files may be deleted.",
			],
			["Run git clean -nd first to preview.", "Delete only specific paths if possible."],
			detail,
			"high",
		);
	}
	if (sub === "checkout" && checkoutRestoresPath(args)) {
		return danger(
			"Git checkout is being used to restore paths and may discard local changes.",
			["Modified files can be reverted without preserving the previous content."],
			["Inspect git diff first.", "Restore only the specific files that must be reverted."],
			detail,
			"high",
		);
	}
	if (sub === "restore") {
		return danger(
			"Git restore may discard local file changes.",
			["Affected files can be reverted without preserving the previous content."],
			["Inspect git diff first.", "Restore only specific files rather than the whole tree."],
			detail,
			"high",
		);
	}
	if (
		sub === "push" &&
		(hasAny(["--force", "-f", "--force-with-lease", "--delete", "-d"]) ||
			hasFlagPrefix(["--force-with-lease="]))
	) {
		return danger(
			"Git push may rewrite or delete remote history.",
			[
				"Remote commits or branches can be overwritten or removed for collaborators.",
				"Recovery may require remote reflogs or manual intervention.",
			],
			[
				"Prefer a normal push.",
				"If force is necessary, verify the remote branch and use --force-with-lease.",
			],
			detail,
			"critical",
		);
	}
	if (sub === "branch" && hasAny(["-d", "-D", "--delete"])) {
		return danger(
			"Git branch deletion removes a local branch reference.",
			["Commits reachable only from that branch can become difficult to find."],
			["Check git branch --merged and note the commit hash before deleting."],
			detail,
			"high",
		);
	}
	if (sub === "worktree" && args.includes("remove")) {
		return danger(
			"Git worktree remove deletes a worktree checkout.",
			["Uncommitted files in that worktree may be lost."],
			[
				"Run git -C <worktree> status first.",
				"Commit, stash, or copy important files before removal.",
			],
			detail,
			"high",
		);
	}
	if (sub === "filter-branch" || sub === "filter-repo" || sub === "rebase") {
		return danger(
			`Git ${sub} rewrites commit history.`,
			["Commit hashes change and collaborators may need manual recovery steps."],
			[
				"Create a backup branch first.",
				"Prefer a new commit if history rewriting is not required.",
			],
			detail,
			"high",
		);
	}
	if (sub === "rm") {
		return danger(
			"Git rm deletes tracked files from the worktree and index.",
			["Files will be removed and staged for deletion."],
			["Use git status first.", "Remove only specific intended files."],
			detail,
			"high",
		);
	}
	if (sub === "reflog" && args.includes("expire")) {
		return danger(
			"Git reflog expire can destroy recovery points.",
			["Future recovery from accidental resets or rebases may become impossible."],
			["Avoid expiring reflogs during agent work unless explicitly required."],
			detail,
			"critical",
		);
	}
	if (sub === "stash") {
		const stashSub = args[0];
		if (stashSub === "drop") {
			return danger(
				"Git stash drop permanently removes a stash entry.",
				[
					"The stashed changes cannot be recovered after dropping.",
					"If the stash contains important uncommitted work, it will be lost.",
				],
				["Run git stash list first to inspect.", "Apply the stash before dropping it."],
				detail,
				"high",
			);
		}
		if (stashSub === "clear") {
			return danger(
				"Git stash clear removes all stash entries.",
				[
					"All stashed changes will be permanently lost.",
					"Recovery is not possible after clearing the stash.",
				],
				["Run git stash list first to inspect.", "Apply or pop important stashes before clearing."],
				detail,
				"critical",
			);
		}
	}
	if (sub === "gc" && hasFlagPrefix(["--prune"])) {
		return danger(
			"Git gc --prune can permanently remove unreachable objects.",
			["Commits/files recoverable only via dangling objects may be deleted."],
			[
				"Avoid aggressive pruning during agent work.",
				"Create a backup ref first if pruning is required.",
			],
			detail,
			"high",
		);
	}
	return null;
}

function isUncertainShellDangerPattern(pattern: string): boolean {
	const lower = pattern.toLowerCase();
	return (
		lower.startsWith("path execution:") ||
		lower.includes("(unknown ") ||
		lower.includes(" unknown ") ||
		lower.includes("not in safe allowlist") ||
		lower.includes("package not in allowlist") ||
		lower.includes("flag not in safe allowlist") ||
		lower.includes("argument not in safe allowlist")
	);
}

function shellDangerPatternSeverity(patterns: string[]): DangerSeverity {
	return patterns.length > 0 && patterns.every(isUncertainShellDangerPattern) ? "medium" : "high";
}

function classifyShellDanger(
	input: Record<string, unknown>,
	cwd: string,
	bashAnalysis: BashAnalysis | undefined,
	compiledPolicy: CompiledExecutionPolicy,
	skipReadOnlyConfirmations = false,
	context?: ExecutionTargetContext | null,
): DangerInfo | null {
	if (!bashAnalysis) return null;
	const commandWhitelist = compiledPolicy.commandWhitelist;
	const unsafeCommandsWhitelisted = areUnsafeCommandsWhitelistedForDanger(
		bashAnalysis,
		commandWhitelist,
	);
	const chapterGitIssues = getChapterGitPermissionIssues(bashAnalysis);
	for (const cmd of bashAnalysis.commands) {
		const [name, ...args] = cmd.tokens;
		if (name === "git") {
			const gitDanger = classifyGitDanger(cmd.text, cmd.tokens);
			if (gitDanger) {
				if (isCommandWhitelisted(cmd, commandWhitelist)) continue;
				return gitDanger;
			}
		}
		if (name === "rm" || name === "rmdir" || name === "shred") {
			if (isCommandWhitelisted(cmd, commandWhitelist)) continue;
			const recursive = args.some((a) => a.includes("r") || a === "--recursive");
			return danger(
				`${name} deletes files${recursive ? " recursively" : ""}.`,
				[
					"Deleted files may not be recoverable from git if they are untracked or ignored.",
					"The operation can remove user work that the agent did not create.",
				],
				["List the target paths first.", "Prefer moving files to a temporary trash directory."],
				[`Command: ${cmd.text}`],
				"high",
			);
		}
		if (name === "find" && (args.includes("-delete") || args.includes("-exec"))) {
			if (isCommandWhitelisted(cmd, commandWhitelist)) continue;
			return danger(
				"Find is being used with deletion or command execution.",
				["It can affect many matching files at once, including files the agent did not inspect."],
				[
					"Run the same find command without -delete/-exec first.",
					"Apply changes to explicit paths.",
				],
				[`Command: ${cmd.text}`],
				"high",
			);
		}
	}
	if (chapterGitIssues.length > 0) {
		return danger(
			"Git command changes chapter branch/worktree state.",
			[
				"The command can switch, create, delete, rewrite, or otherwise move branch/worktree state outside the normal chapter workflow.",
				"NarraFork may lose track of which chapter owns the resulting git state.",
			],
			[
				"Prefer NarraFork chapter/fork/merge operations for branch and worktree changes.",
				"If this git operation is intentional, confirm the exact target branch or worktree first.",
			],
			chapterGitIssues.map((issue) => `Chapter git issue: ${issue}`),
		);
	}
	if (bashAnalysis.hasEnvInjection) {
		return danger(
			"Shell command contains dangerous execution patterns.",
			[
				"The command may execute downloaded, nested, or environment-injected code.",
				"Side effects may be broader than the visible command line suggests.",
			],
			[
				"Inspect the command source first.",
				"Break the command into read-only inspection and explicit execution steps.",
			],
			[...bashAnalysis.dangerousPatterns, "Environment variable injection detected"],
			"high",
		);
	}
	if (bashAnalysis.dangerousPatterns.length > 0 && !unsafeCommandsWhitelisted) {
		const severity = shellDangerPatternSeverity(bashAnalysis.dangerousPatterns);
		const uncertainOnly = severity === "medium";
		return danger(
			uncertainOnly
				? "Shell command includes unclassified execution patterns."
				: "Shell command contains dangerous execution patterns.",
			uncertainOnly
				? [
						"The command may execute a local script, unknown subcommand, or unallowlisted argument whose side effects are not classified.",
						"In Bypass All mode this would otherwise execute without user approval.",
					]
				: [
						"The command may execute downloaded, nested, or environment-injected code.",
						"Side effects may be broader than the visible command line suggests.",
					],
			uncertainOnly
				? [
						"Use a dedicated NarraFork tool for read/write operations when possible.",
						"Break the command into smaller inspected steps or add a narrow command whitelist rule if this exact command is trusted.",
					]
				: [
						"Inspect the command source first.",
						"Break the command into read-only inspection and explicit execution steps.",
					],
			bashAnalysis.dangerousPatterns,
			severity,
		);
	}
	if (bashAnalysis.nonWhitelisted.length > 0 && !unsafeCommandsWhitelisted) {
		const commands = bashAnalysis.commands
			.filter((cmd) => bashAnalysis.nonWhitelisted.includes(cmd.tokens[0]))
			.map((cmd) => `Command: ${cmd.text}`);
		return danger(
			"Shell command includes commands outside the safety allowlist.",
			[
				"The command may run code, invoke a package/script, change system state, or perform side effects that NarraFork cannot classify as read-only.",
				"In Bypass All mode this would otherwise execute without user approval.",
			],
			[
				"Use a dedicated NarraFork tool for read/write operations when possible.",
				"Break the command into smaller inspected steps or add a narrow command whitelist rule if this exact command is trusted.",
			],
			commands.length > 0
				? commands
				: [`Commands outside allowlist: ${bashAnalysis.nonWhitelisted.join(", ")}`],
		);
	}
	if (!bashAnalysis.hasWriteOperation && skipReadOnlyConfirmations) return null;
	const externalPaths = describeExternalPaths(
		cwd,
		getShellScopePaths(cwd, input, bashAnalysis, context),
		compiledPolicy,
		bashAnalysis.hasWriteOperation ? "write" : "read",
		context,
	);
	if (externalPaths.length > 0) {
		return danger(
			"Shell command accesses paths outside the current working directory.",
			[
				"The command may read or modify files outside this chapter/worktree boundary.",
				"Those files may not be covered by NarraFork snapshots or git recovery.",
			],
			[
				"Copy needed data into the worktree first.",
				"Use a narrower command scoped to explicit paths.",
			],
			[`External paths: ${externalPaths.join(", ")}`],
			bashAnalysis.hasWriteOperation ? "high" : "low",
		);
	}
	return null;
}

export function classifyDanger(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	bashAnalysis?: BashAnalysis,
	whitelistDirs: WhitelistDir[] = [],
	commandWhitelist: CommandWhitelistEntry[] = [],
	skipReadOnlyConfirmations = false,
	compiledPolicy?: CompiledExecutionPolicy,
	executionContext?: ExecutionTargetContext | null,
): DangerInfo | null {
	const policy =
		compiledPolicy ??
		compileExecutionPolicy(
			normalizeExecutionPolicyRuleSet({ whitelistDirs, commandWhitelist }, "narrator"),
			executionContext,
		);
	if (toolName === SHELL_TOOL_NAME)
		return classifyShellDanger(
			input,
			cwd,
			bashAnalysis,
			policy,
			skipReadOnlyConfirmations,
			executionContext,
		);

	if (toolName === "Agent") {
		if (input.subagent_type === "explore" || input.subagent_type === "plan") return null;
		const workdir = typeof input.workdir === "string" ? input.workdir : "";
		if (workdir) {
			const resolvedWorkdir = resolveDecisionPath(cwd, workdir, executionContext);
			if (
				!decisionPaths(executionContext).equals(resolvedWorkdir, decisionCwd(cwd, executionContext))
			) {
				if (
					policy.evaluatePath({ path: resolvedWorkdir, operation: "full" }).decision === "allow"
				) {
					return null;
				}
				return danger(
					"Write-capable subagent requests a custom working directory.",
					[
						"The subagent may operate outside the parent narrator's current workspace.",
						"A write-capable subagent can modify files the parent did not inspect.",
					],
					[
						"Use the inherited working directory when possible.",
						"Use an explore/plan subagent for read-only investigation first.",
					],
					[`Requested workdir: ${resolvedWorkdir}`],
				);
			}
		}
		return null;
	}

	if (toolName === "Edit") {
		return null;
	}

	// Knowledge tools: these perform no filesystem writes (so the path heuristics below
	// never flag them), but their WRITE actions mutate shared knowledge, a user's personal
	// library, or access control. Classify writes as dangerous so that under bypassPermissions
	// they still trigger danger reflection; reads (and missing actions) stay null. The
	// read/write split is the single source of truth in knowledge-actions.ts.
	if (toolName === "KnowledgeAdmin" || toolName === "KnowledgeReview") {
		const action = typeof input.action === "string" ? input.action : "";
		if (!action || isKnowledgeReadAction(action)) return null;
		const isMerge = KNOWLEDGE_MERGE_ACTION_SET.has(action);
		return danger(
			`${toolName} performs a knowledge-base write action: ${action}.`,
			[
				"This changes shared project knowledge or its access-control configuration.",
				isMerge
					? "Approving a publish updates the globally-served knowledge version."
					: toolName === "KnowledgeReview"
						? "Reviewing affects whether a contributor's proposal is published."
						: "ACL changes affect who can read or modify knowledge entries.",
			],
			[
				"Confirm the action and target ids are correct before proceeding.",
				"Prefer the personal-entry → publish → review flow for content changes when unsure.",
			],
			[`Tool: ${toolName}`, `Action: ${action}`],
			isMerge ? "high" : "medium",
		);
	}

	// KnowledgeCreate: creating a personal entry is medium; a direct global create is high.
	if (toolName === "KnowledgeCreate") {
		const isDirect = input.direct === true;
		return danger(
			isDirect
				? "KnowledgeCreate creates an entry directly in the global knowledge base."
				: "KnowledgeCreate creates an entry in your personal knowledge library.",
			[
				isDirect
					? "A direct create publishes to the globally-served base without review."
					: "Personal entries are private to you until published.",
			],
			["Confirm the title and target collection are correct before proceeding."],
			[`Tool: KnowledgeCreate`, `Direct: ${isDirect}`],
			isDirect ? "high" : "medium",
		);
	}

	// KnowledgeEdit: publish and direct global writes are high; personal edits/metadata are medium.
	if (toolName === "KnowledgeEdit") {
		const action = typeof input.action === "string" ? input.action : "";
		if (!action) return null;
		const writesGlobal = action === "publish" || (action === "save" && input.direct === true);
		return danger(
			`KnowledgeEdit performs a knowledge action: ${action}.`,
			[
				writesGlobal
					? "Publishing or a direct save changes the globally-served knowledge version."
					: "This changes your personal entry, an entry's metadata, or ownership.",
			],
			[
				"Confirm the action and target ids are correct before proceeding.",
				action === "save"
					? "A non-direct save only updates your private personal entry."
					: "Use 'publish' to propose the change for review.",
			],
			[`Tool: KnowledgeEdit`, `Action: ${action}`],
			writesGlobal ? "high" : "medium",
		);
	}

	if (READ_ONLY_TOOLS.includes(toolName)) {
		return null;
	}

	const toolPaths = getToolPolicyPaths(toolName, input, cwd, bashAnalysis, executionContext);
	const externalPaths = describeExternalPaths(cwd, toolPaths, policy, "write", executionContext);
	if (externalPaths.length > 0) {
		return danger(
			`${toolName} targets paths outside the current working directory.`,
			[
				"The operation crosses the chapter/worktree boundary.",
				"External files may not be covered by project git history or NarraFork snapshots.",
			],
			[
				"Operate inside the worktree when possible.",
				"Use explicit user approval for external files.",
			],
			[`External paths: ${externalPaths.join(", ")}`],
			"high",
		);
	}

	return null;
}

function dangerSeverityRank(severity: DangerSeverity): number {
	switch (severity) {
		case "low":
			return 1;
		case "medium":
			return 2;
		case "high":
			return 3;
		case "critical":
			return 4;
		default:
			return 2;
	}
}

function dangerReflectionThreshold(level: DangerReflectionLevel): number {
	switch (level) {
		case "off":
			return Number.POSITIVE_INFINITY;
		case "light":
			return dangerSeverityRank("high");
		case "standard":
			return dangerSeverityRank("medium");
		case "strict":
			return dangerSeverityRank("low");
	}
}

export function shouldTriggerDangerReflection(
	danger: DangerInfo,
	level: DangerReflectionLevel,
): boolean {
	return dangerSeverityRank(danger.severity) >= dangerReflectionThreshold(level);
}

type PermissionScopeNarrator = {
	id?: string | null;
	variant?: string | null;
	parentNarratorId?: string | null;
	permissionMode?: string | null;
	relaxedPlan?: boolean | null;
	previousPermissionMode?: string | null;
	traits?: unknown;
};

function permissionModeRank(narrator: PermissionScopeNarrator | null | undefined): number {
	const permMode = narrator?.permissionMode ?? "default";
	const effectiveRelaxed = resolveEffectiveRelaxedPlan(permMode, narrator?.relaxedPlan);
	const effectiveMode = isPlanModeTrait(narrator?.traits)
		? effectiveRelaxed
			? permMode
			: "readOnly"
		: permMode;
	switch (effectiveMode) {
		case "dontAsk":
			return 0;
		case "readOnly":
			return 1;
		case "default":
			return 2;
		case "acceptEdits":
			return 3;
		case "bypassPermissions":
			return 4;
		default:
			return 2;
	}
}

function sendSelectors(input: Record<string, unknown>): string[] {
	const raw = [
		typeof input.id === "string" ? input.id : undefined,
		...(Array.isArray(input.ids) ? input.ids.filter((id) => typeof id === "string") : []),
		typeof input.name === "string" ? input.name : undefined,
		...(Array.isArray(input.names) ? input.names.filter((name) => typeof name === "string") : []),
	];
	const seen = new Set<string>();
	return raw.flatMap((value) => {
		const trimmed = value?.trim();
		if (!trimmed || seen.has(trimmed)) return [];
		seen.add(trimmed);
		return [trimmed];
	});
}

async function resolveSendAliasCandidate(
	selector: string,
	callerId: string,
	teamParentId: string,
): Promise<string> {
	for (const ownerId of [callerId, teamParentId]) {
		const inMemory = resolveTaskAlias(ownerId, selector);
		if (inMemory !== selector) return inMemory;
		const task = await backgroundTaskService.getByAlias(selector, ownerId);
		if (task?.subagentNarratorId) return task.subagentNarratorId;
		if (task?.type === "agent") return task.id;
	}
	return selector;
}

async function resolveSendTargetsForPermission(
	callerId: string,
	caller: PermissionScopeNarrator,
	input: Record<string, unknown>,
): Promise<PermissionScopeNarrator[]> {
	const selectors = sendSelectors(input);
	if (selectors.length === 0) return [];
	const callerIsSubagent = !!caller.variant && isSubagentVariant(caller.variant);
	const teamParentId = callerIsSubagent ? caller.parentNarratorId : callerId;
	if (!teamParentId) return [];

	const resolved: PermissionScopeNarrator[] = [];
	const seen = new Set<string>();
	for (const selector of selectors) {
		const aliasCandidate = await resolveSendAliasCandidate(selector, callerId, teamParentId);
		const direct = await narratorService.getById(aliasCandidate).catch(() => null);
		if (direct) {
			if (
				!isSubagentVariant(direct.variant) ||
				direct.parentNarratorId !== teamParentId ||
				(callerIsSubagent && direct.id === callerId)
			) {
				return [];
			}
			if (!seen.has(direct.id)) {
				seen.add(direct.id);
				resolved.push(direct);
			}
			continue;
		}

		const siblings = await narratorService.listSubagentsByParent(teamParentId);
		const candidates = siblings.filter((s) => {
			if (callerIsSubagent && s.id === callerId) return false;
			return subagentMatchesSelector(s, selector);
		});
		if (candidates.length !== 1) return [];
		const target = await narratorService.getById(candidates[0].id);
		if (!isSubagentVariant(target.variant) || target.parentNarratorId !== teamParentId) return [];
		if (!seen.has(target.id)) {
			seen.add(target.id);
			resolved.push(target);
		}
	}
	return resolved;
}

async function shouldAutoAllowSendWithinScope(
	narratorId: string,
	caller: PermissionScopeNarrator | null | undefined,
	input: Record<string, unknown>,
): Promise<boolean> {
	try {
		if (!caller) return false;
		const targets = await resolveSendTargetsForPermission(narratorId, caller, input);
		if (targets.length === 0) return false;
		const callerRank = permissionModeRank(caller);
		return targets.every((target) => permissionModeRank(target) <= callerRank);
	} catch {
		return false;
	}
}

/**
 * Heuristic: does this inline plan text look like a file-path / location
 * reference rather than an actual plan body? Models sometimes fill the inline
 * plan param with things like `plan_path: E:/project/PLAN.md` or a bare path,
 * which would otherwise be shown to the user as if it were the plan. We only
 * flag SHORT, SINGLE-LINE content — any multi-line text is treated as a real
 * plan (zero false positives on genuine plans).
 */
function looksLikePathReference(text: string): boolean {
	const trimmed = text.trim();
	// Our own model-facing plan reference, echoed back by the model as if it were
	// the plan. Checked BEFORE the length/line guards: the sentence is a single
	// line today but grows with the plan file's path, so it must not be able to
	// slip past the 200-char cutoff and be accepted as a complete inline plan.
	if (isModelPlanReference(trimmed)) return true;
	// Multi-line content is a real plan; never flag it.
	if (/[\r\n]/.test(trimmed)) return false;
	// Long single-line content is unusual for a path but plausible for a terse
	// plan; only treat short strings as suspicious.
	if (trimmed.length > 200) return false;
	// `plan_path:` / `path:` / `file:` style key-value reference.
	if (/^\s*(plan[_-]?path|path|file|filepath|plan[_-]?file)\s*[:=]/i.test(trimmed)) return true;
	// `.narrafork/plan-*.md` short reference.
	if (/\.narrafork[/\\]plan-[^\s]*\.md\s*$/i.test(trimmed)) return true;
	// A `.narrafork/plan-*.md` mention followed by trailing prose (e.g. our own
	// model-facing reference sentence, which ends with "Re-read that file …").
	if (/\.narrafork[/\\]plan-[^\s]*\.md\b/i.test(trimmed)) return true;
	// Bare filesystem path pointing at a doc file: Windows drive (E:\ or E:/) or
	// POSIX absolute (/…) ending in a doc extension, with no spaces mid-path
	// beyond a leading label.
	if (/^[a-z]:[/\\][^\r\n]*\.(md|markdown|txt)\s*$/i.test(trimmed)) return true;
	if (/^[/~][^\r\n]*\.(md|markdown|txt)\s*$/i.test(trimmed)) return true;
	return false;
}

export const MAX_PLAN_FILE_BYTES = 1024 * 1024;

function isMarkdownPlanFilePath(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	return lower.endsWith(".md") || lower.endsWith(".markdown");
}

function isSafePlanIdentity(planFileId: string | undefined): boolean {
	return (
		!!planFileId &&
		Buffer.byteLength(planFileId, "utf8") <= 256 &&
		/^[\p{L}\p{N}\p{M}_-]+$/u.test(planFileId)
	);
}

function stripPlanFileInput(input: Record<string, unknown>): Record<string, unknown> {
	const { inline_plan: _inlinePlan, plan: _plan, plan_file_path: _planFilePath, ...rest } = input;
	return rest;
}

type ExitPlanModeInputResolution =
	| {
			ok: true;
			input: Record<string, unknown>;
			resolvedFromFile: boolean;
			planSource: PendingPlanSource;
	  }
	| {
			ok: false;
			message: string;
			input: Record<string, unknown>;
			resolvedFromFile: boolean;
	  };

export async function resolveExitPlanModeInput(
	narratorId: string,
	cwd: string,
	input: Record<string, unknown>,
	locale: Locale = "en",
	isRelaxedPlan = false,
	backend: ExecutionBackend = localBackend,
	executionTarget?: ToolExecutionTarget,
	designatedPlanPath?: string,
	planReadPolicy?: PlanFileReadPolicy,
): Promise<ExitPlanModeInputResolution> {
	return resolveExitPlanModeInputWithBackend(
		narratorId,
		cwd,
		input,
		locale,
		isRelaxedPlan,
		backend,
		executionTarget,
		designatedPlanPath,
		planReadPolicy,
	);
}

export interface PlanFileReadPolicy {
	/** Main flow marker; compilation happens only after the actual target is frozen. */
	narratorId?: string;
	/** Already-compiled policy supplied by handlePermission for exact reuse. */
	compiledPolicy?: ResolvedExecutionPolicy;
	/** Legacy test/caller compatibility. Scoped entries still require the target context. */
	whitelistDirs?: WhitelistDir[];
	blacklistDirs?: BlacklistDir[];
}

type PlanFileResolutionError = "invalid" | "tooLarge" | "executorUpgrade";

type RemoteCapabilityBackend = ExecutionBackend & {
	supportsFsStatResolvedPath?: boolean;
	supportsFsReadAtomicResolvedPath?: boolean;
};

function requiresSafeRemotePlanRead(backend: ExecutionBackend): boolean {
	if (backend.kind !== "remote") return false;
	const remote = backend as RemoteCapabilityBackend;
	return (
		remote.supportsFsStatResolvedPath === false || remote.supportsFsReadAtomicResolvedPath === false
	);
}

function isRemoteResolvedPathMissing(backend: ExecutionBackend, resolvedPath?: string): boolean {
	return backend.kind === "remote" && !resolvedPath;
}

function planExecutorUpgradeMessage(locale: Locale, planFile: string): string {
	const requiredFeatures = `${FS_STAT_RESOLVED_PATH_FEATURE}, ${FS_READ_ATOMIC_RESOLVED_PATH_FEATURE}`;
	if (locale === "zh-CN") {
		return `错误：远程计划文件 "${planFile}" 需要升级 executor 才能安全解析并原子读取 canonical path（${requiredFeatures}）。当前连接仍可用于纯 inline 计划及其他远程工具，但文件型 ExitPlanMode 需要新版 executor。`;
	}
	return `Error: Remote plan file "${planFile}" requires an executor upgrade for canonical authorization and atomic reading (${requiredFeatures}). Pure inline plans and other remote tools remain available, but file-based ExitPlanMode needs a newer executor.`;
}

function comparableBackendPath(backend: ExecutionBackend, baseCwd: string, value: string): string {
	const paths =
		backend.paths ??
		targetPathSemantics(
			backend.pathFlavor === "windows" || backend.platform?.os === "windows" ? "windows" : "posix",
		);
	return paths.identityKey(paths.resolve(baseCwd, value));
}

function compiledPolicyMatchesContext(
	policy: ResolvedExecutionPolicy,
	context: ExecutionTargetContext,
): boolean {
	const existing = policy.targetContext;
	return !!existing && executionTargetContextKey(existing) === executionTargetContextKey(context);
}

async function resolvePlanCompiledPolicy(
	narratorId: string,
	context: ExecutionTargetContext,
	policy?: PlanFileReadPolicy,
): Promise<ResolvedExecutionPolicy | CompiledExecutionPolicy> {
	if (policy?.compiledPolicy && compiledPolicyMatchesContext(policy.compiledPolicy, context)) {
		return policy.compiledPolicy;
	}
	if (policy?.whitelistDirs || policy?.blacklistDirs) {
		return compileExecutionPolicy(
			normalizeExecutionPolicyRuleSet(
				{
					whitelistDirs: policy.whitelistDirs,
					blacklistDirs: policy.blacklistDirs,
				},
				"narrator",
			),
			context,
		);
	}
	try {
		return await executionPolicyEngine.compile(policy?.narratorId ?? narratorId, context);
	} catch (error) {
		// Direct helper callers (including pre-persistence validation and isolated tests) may
		// intentionally use a transient narrator id. Keep the target-local path guard while
		// avoiding a host-wide policy bypass; real narrator/database errors still propagate.
		if (error instanceof Error && /narrator not found/i.test(error.message)) {
			return compileExecutionPolicy(normalizeExecutionPolicyRuleSet({}, "narrator"), context);
		}
		throw error;
	}
}

function isPlanFileReadAuthorized(
	context: ExecutionTargetContext,
	resolvedPath: string,
	policy: CompiledExecutionPolicy,
): boolean {
	const decision = policy.evaluatePath({ path: resolvedPath, operation: "read" });
	if (decision.decision === "deny") return false;
	if (context.paths.contains(context.target.cwd, resolvedPath)) return true;
	return decision.decision === "allow";
}

/**
 * Resolve ExitPlanMode using the exact execution backend frozen for this tool call.
 *
 * Unlike the legacy synchronous helper above, this path never touches the server's
 * filesystem directly. The backend (and, when available, its resolved path) is selected
 * before permission handling, so a remote plan is read from the same device that will
 * execute the tool and the approval/audit record cannot drift to local storage.
 */
export async function resolveExitPlanModeInputWithBackend(
	narratorId: string,
	cwd: string,
	input: Record<string, unknown>,
	locale: Locale = "en",
	isRelaxedPlan = false,
	backend: ExecutionBackend = localBackend,
	executionTarget?: ToolExecutionTarget,
	designatedPlanPath?: string,
	planReadPolicy?: PlanFileReadPolicy,
): Promise<ExitPlanModeInputResolution> {
	const active = activeNarrators.get(narratorId);
	const planFileId = active?._planFileId;
	const allowInlinePlan = settings.agent.planModeAllowInlinePlan;
	let effectiveInput = input;
	let resolvedFromFile = false;
	let planSource: PendingPlanSource | undefined;
	const rawInlinePlan =
		typeof input.inline_plan === "string"
			? input.inline_plan
			: typeof input.plan === "string"
				? input.plan
				: "";
	const normalizedInlinePlan = rawInlinePlan.trim();
	const hasCompleteInlinePlan =
		allowInlinePlan && !!normalizedInlinePlan && !looksLikePathReference(normalizedInlinePlan);

	const suppliedPlanFilePath =
		typeof input.plan_file_path === "string" && input.plan_file_path.trim()
			? input.plan_file_path.trim()
			: undefined;
	const customPlanFilePath = isRelaxedPlan ? suppliedPlanFilePath : undefined;
	const defaultPlanFilePath =
		designatedPlanPath ??
		active?._planFilePath ??
		(planFileId ? `.narrafork/plan-${planFileId}.md` : null);
	const planFileName = customPlanFilePath ?? defaultPlanFilePath;
	const shouldResolveFilePlan =
		!!planFileName && (!!suppliedPlanFilePath || !hasCompleteInlinePlan);
	let planFileError: PlanFileResolutionError | undefined;
	const baseCwd = executionTarget?.cwd ?? toolBaseCwd(backend, cwd);

	if (
		!isRelaxedPlan &&
		planFileName &&
		(!isSafePlanIdentity(planFileId) ||
			comparableBackendPath(backend, baseCwd, planFileName) !==
				comparableBackendPath(backend, baseCwd, `.narrafork/plan-${planFileId}.md`))
	) {
		planFileError = "invalid";
	}

	if (customPlanFilePath && !isMarkdownPlanFilePath(customPlanFilePath)) {
		planFileError = "invalid";
	}

	if (
		!isRelaxedPlan &&
		suppliedPlanFilePath &&
		(!defaultPlanFilePath ||
			comparableBackendPath(backend, baseCwd, suppliedPlanFilePath) !==
				comparableBackendPath(backend, baseCwd, defaultPlanFilePath))
	) {
		planFileError = "invalid";
	}
	if (shouldResolveFilePlan && planFileName && !planFileError) {
		const requestedPath = resolveBackendPath(backend, baseCwd, planFileName);
		const frozenLexicalPath = executionTarget?.lexicalPath ?? executionTarget?.resolvedFilePath;
		if (frozenLexicalPath && !backend.paths.equals(frozenLexicalPath, requestedPath)) {
			// Reject a model-supplied path that diverges from the routed target before any
			// target filesystem metadata is observed.
			planFileError = "invalid";
		} else if (requiresSafeRemotePlanRead(backend)) {
			// File-based plan submission requires both canonical identity and executor-side
			// atomic verification during the subsequent read.
			planFileError = "executorUpgrade";
		} else {
			try {
				const paths =
					backend.paths ??
					targetPathSemantics(
						backend.pathFlavor === "windows" || backend.platform?.os === "windows"
							? "windows"
							: "posix",
					);
				let preflightStats: Awaited<ReturnType<ExecutionBackend["statFile"]>> | undefined;
				let targetForContext = executionTarget;
				if (!targetForContext || typeof backend.resolvePathIdentity !== "function") {
					preflightStats = await backend.statFile(requestedPath);
					const canonicalPath = preflightStats?.resolvedPath ?? requestedPath;
					targetForContext = {
						...(targetForContext ?? {
							deviceId: backend.deviceId,
							backendKind: backend.kind,
							cwd: baseCwd,
							selectionSource: backend.kind === "local" ? "local_default" : "session_default",
						}),
						pathFlavor: paths.flavor,
						lexicalPath: requestedPath,
						canonicalPath,
						resolvedFilePath: targetForContext?.resolvedFilePath ?? requestedPath,
						runtimeGeneration: backend.runtimeGeneration ?? 0,
					};
				}
				const resolvedTargetContext = await createExecutionTargetContext({
					backend,
					target: targetForContext,
					deviceClass: planReadPolicy?.compiledPolicy?.targetContext?.deviceClass ?? null,
				});
				const targetContext =
					planReadPolicy?.compiledPolicy?.targetContext &&
					compiledPolicyMatchesContext(planReadPolicy.compiledPolicy, resolvedTargetContext)
						? planReadPolicy.compiledPolicy.targetContext
						: resolvedTargetContext;
				const frozenLexicalPath =
					targetContext.target.lexicalPath ?? targetContext.target.resolvedFilePath;
				if (frozenLexicalPath && !targetContext.paths.equals(frozenLexicalPath, requestedPath)) {
					planFileError = "invalid";
				} else {
					const authorizedPath = executionTargetPolicyPath(targetContext) ?? requestedPath;
					const readPolicy = await resolvePlanCompiledPolicy(
						narratorId,
						targetContext,
						planReadPolicy,
					);
					if (!isPlanFileReadAuthorized(targetContext, authorizedPath, readPolicy)) {
						planFileError = "invalid";
					} else {
						const fileStats = preflightStats ?? (await backend.statFile(authorizedPath));
						if (fileStats && !fileStats.isFile) {
							planFileError = "invalid";
						} else if (fileStats && isRemoteResolvedPathMissing(backend, fileStats.resolvedPath)) {
							planFileError = "executorUpgrade";
						} else if (fileStats && fileStats.size > MAX_PLAN_FILE_BYTES) {
							planFileError = "tooLarge";
						} else if (fileStats?.isFile) {
							const canonicalPath = fileStats.resolvedPath ?? targetContext.target.canonicalPath;
							if (
								!canonicalPath ||
								(targetContext.target.canonicalPath &&
									!targetContext.paths.equals(targetContext.target.canonicalPath, canonicalPath))
							) {
								planFileError = "invalid";
							} else {
								const file = await backend.readFileBytes(authorizedPath, {
									maxBytes: MAX_PLAN_FILE_BYTES + 1,
									expectedResolvedPath: canonicalPath,
								});
								if (
									(backend.kind === "remote" && !file.resolvedPath) ||
									(file.resolvedPath &&
										!targetContext.paths.equals(file.resolvedPath, canonicalPath))
								) {
									planFileError = "invalid";
								} else if (
									file.truncated ||
									file.totalSize > MAX_PLAN_FILE_BYTES ||
									file.bytes.byteLength > MAX_PLAN_FILE_BYTES
								) {
									planFileError = "tooLarge";
								} else {
									const content = new TextDecoder().decode(file.bytes);
									if (content.trim()) {
										const {
											inline_plan: _inlineIgnored,
											plan_file_path: _pathIgnored,
											...restForFile
										} = effectiveInput;
										effectiveInput = {
											...restForFile,
											plan: content,
											_planFile: planFileName,
										};
										resolvedFromFile = true;
										planSource = {
											kind: "file",
											path: requestedPath,
											resolvedPath: canonicalPath,
											custom: !!customPlanFilePath,
										};
									}
								}
							}
						}
					}
				}
			} catch {
				// Target freezing, policy compilation, stat, and atomic reads are fail-closed.
				planFileError = "invalid";
			}
		}
	}

	if (planFileError) {
		return {
			ok: false,
			input: stripPlanFileInput(effectiveInput),
			resolvedFromFile: false,
			message:
				planFileError === "executorUpgrade"
					? planExecutorUpgradeMessage(locale, planFileName ?? "<unknown>")
					: planFileError === "tooLarge"
						? getToolMessageWithParams("exitPlanModePlanFileTooLarge", locale, {
								planFile: planFileName ?? "<unknown>",
								maxBytes: MAX_PLAN_FILE_BYTES,
							})
						: getToolMessageWithParams("exitPlanModePlanFileInvalid", locale, {
								planFile: planFileName ?? "<unknown>",
							}),
		};
	}

	if (customPlanFilePath && !resolvedFromFile) {
		return {
			ok: false,
			input: stripPlanFileInput(effectiveInput),
			resolvedFromFile: false,
			message: getToolMessageWithParams("exitPlanModeCustomFileNotFound", locale, {
				planFile: customPlanFilePath,
			}),
		};
	}

	if (!resolvedFromFile && allowInlinePlan) {
		const inlinePlan = normalizedInlinePlan;
		if (inlinePlan) {
			if (looksLikePathReference(inlinePlan)) {
				const planFilePath =
					planFileName ??
					(planFileId ? `.narrafork/plan-${planFileId}.md` : ".narrafork/plan-<id>.md");
				const {
					inline_plan: _drop,
					plan: _drop2,
					plan_file_path: _pathDrop,
					...rest
				} = effectiveInput;
				return {
					ok: false,
					input: rest,
					resolvedFromFile,
					message: getToolMessageWithParams("exitPlanModePathReference", locale, {
						planFile: planFilePath,
					}),
				};
			}
			const { inline_plan: _inlineIgnored, plan_file_path: _pathIgnored, ...rest } = effectiveInput;
			effectiveInput = { ...rest, plan: inlinePlan };
			planSource = { kind: "inline" };
		} else {
			const { inline_plan: _inlineIgnored, plan_file_path: _pathIgnored, ...rest } = effectiveInput;
			effectiveInput = rest;
		}
	} else if (!allowInlinePlan && !resolvedFromFile) {
		const {
			plan: _ignored,
			inline_plan: _inlineIgnored,
			plan_file_path: _pathIgnored,
			...rest
		} = effectiveInput;
		effectiveInput = rest;
	}

	const planValue = effectiveInput.plan;
	const hasPlanContent = typeof planValue === "string" && planValue.trim().length > 0;
	if (!hasPlanContent) {
		const planFilePath =
			planFileName ?? (planFileId ? `.narrafork/plan-${planFileId}.md` : ".narrafork/plan-<id>.md");
		return {
			ok: false,
			input: effectiveInput,
			resolvedFromFile,
			message: getToolMessageWithParams("exitPlanModeEmptyPlan", locale, {
				planFile: planFilePath,
			}),
		};
	}

	return {
		ok: true,
		input: effectiveInput,
		resolvedFromFile,
		planSource: planSource ?? { kind: "inline" },
	};
}

/**
 * Validate AskUserQuestion input, repairing recoverable issues before giving up.
 *
 * Providers sometimes omit a question's `question` key, send a placeholder key,
 * or stringify the whole `questions` array. The UI already repairs these (so the
 * call looks fine on screen), which means strict server-side validation would fail
 * a call the user can answer normally. We mirror the UI repair here via
 * `coerceAskQuestions`, then re-validate. Only truly unrecoverable input (no usable
 * questions at all) is rejected.
 *
 * Returns `{ deny }` to reject the call, or `{ repairedInput }` (possibly identical
 * to the original) to continue. When a repair changed the payload, `repairedInput`
 * carries the normalized questions so the persisted/broadcast input stays consistent
 * with what the answer-mapping logic expects.
 */
async function validateOrRepairAskUserQuestionInput(
	narratorId: string,
	toolUseId: string,
	input: Record<string, unknown>,
): Promise<{ deny: PermissionResult } | { repairedInput: Record<string, unknown> }> {
	const tool = toolRegistry.get("AskUserQuestion");

	const deny = async (message: string): Promise<{ deny: PermissionResult }> => {
		logger.warn("Rejecting invalid AskUserQuestion before permission prompt", {
			narratorId,
			toolUseId,
			message,
		});
		await db
			.update(narratorToolCalls)
			.set({
				status: "fail",
				inputJson: input,
				errorMessage: message,
				permissionDecidedBy: "auto",
				permissionDecidedAt: new Date().toISOString(),
				permissionDecisionReason: "invalid_ask_user_question_input",
			})
			.where(
				and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
			);
		return { deny: { behavior: "deny", message, rawMessage: true } };
	};

	if (!tool) {
		return deny("Invalid AskUserQuestion parameters: tool definition not found");
	}

	// Fast path: already valid, no repair needed.
	if (tool.parameters.safeParse(input).success) {
		return { repairedInput: input };
	}

	// Attempt to repair recoverable issues (missing/placeholder keys, stringified array).
	const repairedQuestions = coerceAskQuestions(input.questions);
	if (repairedQuestions.length > 0) {
		const repairedInput = { ...input, questions: repairedQuestions };
		const reparsed = tool.parameters.safeParse(repairedInput);
		if (reparsed.success) {
			logger.info("Repaired malformed AskUserQuestion input before permission prompt", {
				narratorId,
				toolUseId,
				questionCount: repairedQuestions.length,
			});
			return { repairedInput };
		}
	}

	const parsed = tool.parameters.safeParse(input);
	const message = parsed.success
		? "Invalid AskUserQuestion parameters"
		: `Invalid AskUserQuestion parameters: ${parsed.error.message}`;
	return deny(message);
}

export async function loadPlanFileReadPolicy(narratorId: string): Promise<PlanFileReadPolicy> {
	// Compilation is intentionally deferred until ExitPlanMode has its actual frozen target.
	// This keeps device selectors and path flavor filtering identical to ordinary permission checks.
	return { narratorId };
}

/**
 * Keep only the serializable execution identity needed to re-run permission checks.
 * ExecutionBackend instances contain live transports/closures and must never be
 * retained in pending state; the backend is re-resolved by device id instead.
 */
function snapshotExecutionTarget(
	target: Readonly<ToolExecutionTarget> | null | undefined,
): PendingExecutionTarget | undefined {
	if (!target) return undefined;
	if (!target.pathFlavor || target.runtimeGeneration === undefined) {
		throw new Error(
			"Routed pending permission target is missing path flavor or runtime generation.",
		);
	}
	return Object.freeze({
		deviceId: target.deviceId,
		backendKind: target.backendKind,
		cwd: target.cwd,
		pathFlavor: target.pathFlavor,
		...(target.lexicalPath !== undefined ? { lexicalPath: target.lexicalPath } : {}),
		...(target.canonicalPath !== undefined ? { canonicalPath: target.canonicalPath } : {}),
		...(target.resolvedFilePath !== undefined ? { resolvedFilePath: target.resolvedFilePath } : {}),
		runtimeGeneration: target.runtimeGeneration,
		selectionSource: target.selectionSource,
	});
}

function permissionPrimaryPath(
	toolName: string,
	input: Record<string, unknown>,
): string | undefined {
	if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
		return typeof input.file_path === "string" ? input.file_path : undefined;
	}
	if (toolName === "Glob" || toolName === "Grep") {
		return typeof input.path === "string" ? input.path : undefined;
	}
	return undefined;
}

async function canonicalizeShellAnalysisPaths(
	analysis: BashAnalysis,
	context: ExecutionTargetContext,
): Promise<BashAnalysis> {
	if (analysis.filePaths.length === 0) return analysis;
	const canonicalPaths = await Promise.all(
		analysis.filePaths.map(async (path) => {
			const identity = await context.backend.resolvePathIdentity(path);
			if (identity.runtimeGeneration !== context.target.runtimeGeneration) {
				throw new Error(
					`Shell path identity generation drifted: expected ${context.target.runtimeGeneration}, ` +
						`got ${identity.runtimeGeneration}.`,
				);
			}
			return identity.canonicalPath;
		}),
	);
	return { ...analysis, filePaths: [...new Set(canonicalPaths)] };
}

async function freezePermissionExecutionContext(input: {
	toolName: string;
	toolInput: Record<string, unknown>;
	backend: ExecutionBackend;
	target: ToolExecutionTarget;
	deviceClass?: DeviceAccessGroup | null;
	refinePrimaryPath?: boolean;
}): Promise<ExecutionTargetContext> {
	const paths =
		input.target.pathFlavor === "spec" || input.target.cwd.startsWith("spec://")
			? specPathSemantics
			: (input.backend.paths ??
				targetPathSemantics(
					input.backend.pathFlavor === "windows" || input.backend.platform?.os === "windows"
						? "windows"
						: "posix",
				));
	const primaryPath = input.refinePrimaryPath
		? permissionPrimaryPath(input.toolName, input.toolInput)
		: undefined;
	const target = primaryPath
		? {
				...input.target,
				pathFlavor: paths.flavor,
				lexicalPath: undefined,
				canonicalPath: undefined,
				resolvedFilePath: paths.resolve(input.target.cwd, primaryPath),
				runtimeGeneration: input.backend.runtimeGeneration ?? 0,
			}
		: input.target;
	return createExecutionTargetContext({
		backend: input.backend,
		target,
		deviceClass: input.deviceClass ?? null,
	});
}

function snapshotPendingPlanSource(
	source: PendingPlanSource | undefined,
): Readonly<PendingPlanSource> | undefined {
	if (!source) return undefined;
	return Object.freeze({ ...source });
}

function resolvePendingExecutionBackend(target: PendingExecutionTarget): ExecutionBackend {
	const backend = resolveBackend({ requested: target.deviceId });
	if (backend.deviceId !== target.deviceId || backend.kind !== target.backendKind) {
		throw new Error(
			`Frozen execution target mismatch: expected ${target.backendKind}/${target.deviceId}, ` +
				`got ${backend.kind}/${backend.deviceId}.`,
		);
	}
	const backendFlavor =
		backend.pathFlavor ??
		backend.paths?.flavor ??
		(backend.platform?.os === "windows" ? "windows" : "posix");
	if (target.pathFlavor !== backendFlavor) {
		throw new Error(
			`Frozen execution target path flavor drifted: expected ${target.pathFlavor}, ` +
				`got ${backendFlavor}.`,
		);
	}
	const runtimeGeneration = backend.runtimeGeneration ?? 0;
	if (target.runtimeGeneration !== runtimeGeneration) {
		throw new Error(
			`Frozen execution target runtime generation drifted: expected ${target.runtimeGeneration}, ` +
				`got ${runtimeGeneration}.`,
		);
	}
	return backend;
}

function permissionRoutingIdentity(
	ownerNarratorId: string,
	broadcastTargetId: string,
	parentToolUseId?: string,
) {
	return {
		ownerNarratorId,
		...(ownerNarratorId !== broadcastTargetId ? { subagentNarratorId: ownerNarratorId } : {}),
		...(parentToolUseId ? { parentToolUseId } : {}),
	};
}

function pendingPermissionRoutingIdentity(pending: PendingPermission) {
	return permissionRoutingIdentity(
		pending.narratorId,
		pending.broadcastTargetId,
		pending.parentToolUseId,
	);
}

/**
 * Mirror a permission-gate status transition onto the WS broadcast target.
 *
 * When the gate belongs to a SUBAGENT, `broadcastTargetId` is its parent: the
 * parent page renders the request inside the SubagentCard, so it must be told
 * about the transition. But a narrator's status row is owned by its own turn, and
 * a subagent pausing for permission says nothing about whether the parent is
 * running. Writing the parent's status here used to resurrect an already-finished
 * parent as `working`/`waiting` — the status then outlived every runtime owner and
 * blocked `/continue` and `/subagent-recovery` with "already running", while the
 * error substatus that drove the recovery card got wiped.
 *
 * So the mirror is a no-op unless the target genuinely owns running work. The
 * real-time UI signal is carried by the permission_* WS frames, which are
 * broadcast unconditionally and do not depend on this write.
 *
 * Self-transitions (target === owner) are always applied: that is the narrator
 * writing its own status, not a mirror.
 */
async function mirrorPermissionStatusToTarget(
	ownerNarratorId: string,
	broadcastTargetId: string | undefined,
	status: "working" | "waiting",
	options?: { substatus?: string[] },
): Promise<void> {
	if (!broadcastTargetId || broadcastTargetId === ownerNarratorId) return;
	if (!isNarratorRuntimeBusy(broadcastTargetId)) {
		logger.debug("Skipped permission status mirror to an idle broadcast target", {
			ownerNarratorId,
			broadcastTargetId,
			status,
		});
		return;
	}
	await narratorService.updateStatus(broadcastTargetId, status, options);
}

export interface RuntimePermissionConstraint {
	/**
	 * "bypassPermissions" does not skip review for external narrators: since they cannot
	 * answer an interactive prompt, risky calls route into the danger reflection loop
	 * instead of being denied outright. Catastrophic commands and the deviceAccess ceiling
	 * still apply.
	 */
	permissionMode: "readOnly" | "dontAsk" | "bypassPermissions";
	allowKnowledgeWrite: boolean;
	/** Client-supplied business context appended to the danger reflection prompt. */
	dangerReflectionPrompt?: string;
	/**
	 * Merge the robot diagnostic read-only preset into the compiled allow-list, so routine
	 * inspection commands resolve without a danger reflection round trip.
	 */
	useRobotDiagnosticPreset?: boolean;
	/** Per-device-group operation ceiling; undefined for ordinary (non-OAuth) sessions. */
	deviceAccess?: DeviceAccessPolicy;
	/** The OAuth client and grant this constraint was resolved for, used to classify which
	 * device access group a specific target device belongs to. Required whenever
	 * deviceAccess is present. */
	oauthClientId?: string;
	grantId?: string;
}

/** The concrete execution groups used by routed OAuth tools. */
export type DeviceAccessGroup = "host" | "global" | "selfRegistered";

/**
 * Classify which device access group a specific device belongs to for a given OAuth
 * client/grant. Membership is dynamic: the same device can be "selfRegistered" for the
 * client that provisioned it and merely "global" for another client that only has it
 * bound into a narrator's deviceIds — group membership is never a static column on the
 * device row.
 *
 * There is no separate "bound but not owned by this client" group: requireOwnedExternalDevice
 * (oauth-resource-access.ts) unconditionally requires a device's
 * integration_resource_bindings.sourceId to equal the requesting client's own id before it
 * may be bound into that client's narrator deviceIds at all, so every device reachable from
 * a narrator is always either "global" or "selfRegistered".
 */
export async function classifyDeviceAccessGroup(
	deviceId: string,
	ctx: { oauthClientId: string; grantId: string },
): Promise<DeviceAccessGroup> {
	if (deviceId === LOCAL_DEVICE_ID) return "host";
	const device = await db.query.remoteDevices.findFirst({
		where: eq(remoteDevices.id, deviceId),
		columns: { scope: true },
	});
	if (!device) return "global"; // fail closed toward the more restrictive default level below
	const binding = await integrationResourceBindingService.get("device", deviceId);
	const isSelfRegistered =
		binding?.sourceType === "oauth_client" &&
		binding.sourceId === ctx.oauthClientId &&
		binding.authorityType === "oauth_grant" &&
		binding.authorityId === ctx.grantId;
	return isSelfRegistered ? "selfRegistered" : "global";
}

async function blockCatastrophicCommand(input: {
	narratorId: string;
	toolName: string;
	toolUseId: string;
	toolInput: Record<string, unknown>;
	bashAnalysis?: BashAnalysis;
}): Promise<PermissionResult> {
	const reason = input.bashAnalysis?.catastrophicReason ?? "catastrophic command detected";
	const fatalMsg = `FATAL: ${reason}. Narrator terminated for safety.`;
	logger.error("Catastrophic command blocked", {
		narratorId: input.narratorId,
		toolName: input.toolName,
		toolUseId: input.toolUseId,
		reason,
		command: typeof input.toolInput.command === "string" ? input.toolInput.command : undefined,
	});
	await db
		.update(narratorToolCalls)
		.set({
			status: "fail",
			errorMessage: fatalMsg,
			permissionDecidedBy: "auto",
			permissionDecidedAt: new Date().toISOString(),
			permissionDecisionReason: reason,
		})
		.where(
			and(
				eq(narratorToolCalls.narratorId, input.narratorId),
				eq(narratorToolCalls.toolUseId, input.toolUseId),
			),
		);
	return { behavior: "deny", message: fatalMsg, fatal: true };
}

export async function handlePermission(
	narratorId: string,
	signal: AbortSignal,
	toolName: string,
	input: Record<string, unknown>,
	toolUseId: string,
	cwd: string,
	locale: Locale = "en",
	broadcastTargetId?: string,
	options?: PermissionHandlerOptions,
	parentToolUseId?: string,
	runtimeConstraint?: RuntimePermissionConstraint,
): Promise<PermissionResult> {
	// Every routed permission starts from a complete frozen context. Missing backend/target,
	// canonicalization failure, or backend identity drift is denied before policy loading.
	let executionContext: ExecutionTargetContext | null = null;
	if (isRoutedPermissionTool(toolName)) {
		if (!options?.executionBackend || !options.executionTarget) {
			return {
				behavior: "deny",
				message: `Routed permission ${toolName} requires a frozen execution target context.`,
			};
		}
		try {
			executionContext = await freezePermissionExecutionContext({
				toolName,
				toolInput: input,
				backend: options.executionBackend,
				target: options.executionTarget,
			});
		} catch (error) {
			return {
				behavior: "deny",
				message: `Execution target validation failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
	let initialExecutionTarget = executionContext?.target;
	const wsTarget = broadcastTargetId ?? narratorId;
	const routingIdentity = permissionRoutingIdentity(narratorId, wsTarget, parentToolUseId);
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: {
			permissionMode: true,
			chapterId: true,
			relaxedPlan: true,
			previousPermissionMode: true,
			planFileId: true,
			dangerReflectionOverride: true,
			variant: true,
			parentNarratorId: true,
			traits: true,
		},
	});
	const permMode = runtimeConstraint?.permissionMode ?? narrator?.permissionMode ?? "default";
	// OAuth runtime constraints are hard ceilings and never inherit relaxed-plan expansion.
	const isRelaxedPlan = runtimeConstraint
		? false
		: resolveEffectiveRelaxedPlan(permMode, narrator?.relaxedPlan);
	const isPlanMode = runtimeConstraint ? false : isPlanModeTrait(narrator?.traits);
	const isChapter = !!narrator?.chapterId;

	let effectiveInput = input;
	let exitPlanResolvedFromFile = false;
	let exitPlanSource: PendingPlanSource | undefined;

	// EnterPlanMode is prepared after its assistant message is persisted and committed only
	// after the matching successful tool_result. Permission evaluation must not mutate durable
	// plan-mode state or allocate an active plan identity here.

	// Shell command pre-analysis uses the selected target's shell and cwd. OAuth remote
	// diagnostics must never be classified with the NarraFork host's shell/path semantics.
	let bashAnalysis: BashAnalysis | undefined;
	let shellAnalysisError: string | undefined;
	const isBashControlOp =
		toolName === SHELL_TOOL_NAME && !input.command && (input.await != null || input.stop != null);
	if (toolName === SHELL_TOOL_NAME && typeof input.command === "string") {
		try {
			const shellType = resolvePermissionShellType(executionContext?.backend);
			const shellCwd = executionContext?.target.cwd ?? resolveToolCwd(cwd, effectiveInput);
			bashAnalysis = await analyzeShellCommand(
				input.command,
				shellCwd,
				shellType,
				isChapter,
				executionContext?.paths ?? localPathSemantics,
			);
			if (executionContext) {
				bashAnalysis = await canonicalizeShellAnalysisPaths(bashAnalysis, executionContext);
			}
			if (bashAnalysis.commands.length === 0) {
				throw new Error("command parser produced no executable command");
			}
		} catch (err) {
			shellAnalysisError = err instanceof Error ? err.message : String(err);
			bashAnalysis = undefined;
			logger.warn("Bash command analysis failed; unsafe auto-allow will be blocked", {
				error: shellAnalysisError,
			});
		}
	}

	let oauthDeviceLevel: "denied" | "readOnly" | "readWrite" | null = null;
	let oauthKnowledgeCapability: "read" | "write" | null = null;
	if (runtimeConstraint) {
		// Knowledge access is a separate OAuth capability family, but it still continues through
		// the shared deny/allow pipeline below. A granted write capability is explicit approval
		// for that family and therefore does not inherit the filesystem device ceiling.
		if (toolName === "KnowledgeSearch" || toolName === "KnowledgeRead") {
			oauthKnowledgeCapability = "read";
		} else if (toolName === "KnowledgeCreate" || toolName === "KnowledgeEdit") {
			if (!runtimeConstraint.allowKnowledgeWrite) {
				return { behavior: "deny", message: "OAuth policy does not allow knowledge writes" };
			}
			if (
				toolName === "KnowledgeEdit" &&
				(input.action === "transfer_owner" || input.action === "transfer_collection_owner")
			) {
				return {
					behavior: "deny",
					message: "OAuth knowledge policy does not allow ownership transfer",
				};
			}
			oauthKnowledgeCapability = "write";
		}

		if (executionContext) {
			if (options?.executionPlan?.kind === "multi") {
				return {
					behavior: "deny",
					message:
						"OAuth runtime policy cannot authorize a multi-target operation with a single device capability context",
				};
			}
			if (
				!runtimeConstraint.deviceAccess ||
				!runtimeConstraint.oauthClientId ||
				!runtimeConstraint.grantId
			) {
				return { behavior: "deny", message: "OAuth device access policy is missing" };
			}
			const deviceClass = await classifyDeviceAccessGroup(executionContext.target.deviceId, {
				oauthClientId: runtimeConstraint.oauthClientId,
				grantId: runtimeConstraint.grantId,
			});
			executionContext = withExecutionDeviceClass(executionContext, deviceClass);
			initialExecutionTarget = executionContext.target;
			oauthDeviceLevel = runtimeConstraint.deviceAccess[deviceClass];
			if (oauthDeviceLevel === "denied") {
				return {
					behavior: "deny",
					message: `OAuth device access policy denies this device group: ${deviceClass}`,
				};
			}

			const capabilityNeedsWrite =
				options?.executionPlan?.endpoints.some((endpoint) => endpoint.operation === "write") ===
					true ||
				WRITE_TOOLS.has(toolName) ||
				((toolName === SHELL_TOOL_NAME || toolName === "Shell") &&
					bashAnalysis?.hasWriteOperation === true);
			if (capabilityNeedsWrite && oauthDeviceLevel !== "readWrite") {
				return {
					behavior: "deny",
					message: `OAuth device access policy is read-only for this device group: ${deviceClass}`,
				};
			}
			if (
				(toolName === "Write" || toolName === "Edit") &&
				specVfsService.isSpecUri(effectiveInput.file_path)
			) {
				return {
					behavior: "deny",
					message: "OAuth file writes cannot target Dynamic Spec paths",
				};
			}
		}
	}

	const planFileId = isPlanMode
		? (activeNarrators.get(narratorId)?._planFileId ?? narrator?.planFileId ?? undefined)
		: undefined;

	// Plan mode: redirect Write/Edit targeting any .md file to the designated plan file
	let planRedirectNotice: string | undefined;
	if (isPlanMode && !isRelaxedPlan && planFileId && (toolName === "Write" || toolName === "Edit")) {
		const filePath = typeof effectiveInput.file_path === "string" ? effectiveInput.file_path : "";
		if (filePath) {
			const paths = executionContext?.paths ?? localPathSemantics;
			const absPath =
				(executionContext && executionTargetPolicyPath(executionContext)) ??
				resolveDecisionPath(cwd, filePath, executionContext);
			const planFilePath = resolveDecisionPath(
				cwd,
				`.narrafork/plan-${planFileId}.md`,
				executionContext,
			);
			if (!paths.equals(absPath, planFilePath)) {
				const fileName = paths.basename(filePath).toLowerCase();
				if (fileName.endsWith(".md")) {
					const correctRelPath = `.narrafork/plan-${planFileId}.md`;
					effectiveInput = { ...effectiveInput, file_path: correctRelPath };
					planRedirectNotice = getToolMessageWithParams("planModeFileRedirected", locale, {
						originalPath: filePath,
						planFile: correctRelPath,
					});
				}
			}
		}
	}

	// Conclusion file redirect
	let conclusionRedirectNotice: string | undefined;
	const subagentConcEntry = getConclusionEntry(narratorId);
	if (subagentConcEntry && (toolName === "Write" || toolName === "Edit")) {
		const filePath = typeof effectiveInput.file_path === "string" ? effectiveInput.file_path : "";
		const conclusionRelPath = subagentConcEntry.relPath;
		if (filePath) {
			const absPath =
				(executionContext && executionTargetPolicyPath(executionContext)) ??
				resolveDecisionPath(cwd, filePath, executionContext);
			const conclusionPath = resolveDecisionPath(cwd, subagentConcEntry.absPath, executionContext);
			if (!decisionPaths(executionContext).equals(absPath, conclusionPath)) {
				effectiveInput = { ...effectiveInput, file_path: conclusionRelPath };
				conclusionRedirectNotice = getToolMessageWithParams(
					"subagentConclusionRedirected",
					locale,
					{
						originalPath: filePath,
						conclusionFile: conclusionRelPath,
					},
				);
			}
		} else {
			effectiveInput = { ...effectiveInput, file_path: conclusionRelPath };
		}
	}

	if (toolName === "AskUserQuestion") {
		const askResult = await validateOrRepairAskUserQuestionInput(
			narratorId,
			toolUseId,
			effectiveInput,
		);
		if ("deny" in askResult) return askResult.deny;
		effectiveInput = askResult.repairedInput;
	}

	if (executionContext && permissionPrimaryPath(toolName, effectiveInput)) {
		try {
			executionContext = await freezePermissionExecutionContext({
				toolName,
				toolInput: effectiveInput,
				backend: executionContext.backend,
				target: executionContext.target as ToolExecutionTarget,
				deviceClass: executionContext.deviceClass,
				refinePrimaryPath: true,
			});
			initialExecutionTarget = executionContext.target;
		} catch (error) {
			return {
				behavior: "deny",
				message: `Execution target refinement failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	let compiledPolicy: ResolvedExecutionPolicy;
	try {
		compiledPolicy = await executionPolicyEngine.compile(
			narratorId,
			executionContext,
			runtimeConstraint?.useRobotDiagnosticPreset ? ["robotDiagnostic"] : [],
		);
	} catch (error) {
		return {
			behavior: "deny",
			message: `Execution policy compilation failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	// ExitPlanMode reads use the exact same target-filtered compiled path policy as the
	// ordinary decision below, and the backend performs an atomic canonical-path read.
	if (toolName === "ExitPlanMode") {
		if (!executionContext) {
			return { behavior: "deny", message: "ExitPlanMode requires a frozen execution target" };
		}
		const resolved = await resolveExitPlanModeInputWithBackend(
			narratorId,
			cwd,
			input,
			locale,
			isRelaxedPlan,
			executionContext.backend,
			executionContext.target as ToolExecutionTarget,
			activeNarrators.get(narratorId)?._planFilePath,
			{ narratorId, compiledPolicy },
		);
		effectiveInput = resolved.input;
		exitPlanResolvedFromFile = resolved.resolvedFromFile;
		exitPlanSource = resolved.ok ? resolved.planSource : undefined;
		if (!resolved.ok) {
			return {
				behavior: "deny",
				message: resolved.message,
				rawMessage: true,
			};
		}
	}

	// Redirects and plan canonicalization must be persisted before any approval is exposed.
	await options?.onInputResolved?.(effectiveInput);

	const permMeta: PermissionDecisionMeta = {};
	const conclusionFileId = getConclusionFileId(narratorId);

	// Bash await/stop are pure control operations — skip full permission analysis
	if (isBashControlOp) {
		await db
			.update(narratorToolCalls)
			.set({
				status: "running",
				permissionDecidedBy: "auto",
				permissionDecidedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
			);
		return { behavior: "allow", updatedInput: effectiveInput };
	}

	const decisionPermMode =
		runtimeConstraint && executionContext
			? oauthDeviceLevel === "readWrite"
				? "bypassPermissions"
				: "readOnly"
			: runtimeConstraint && oauthKnowledgeCapability === "write"
				? "bypassPermissions"
				: permMode;
	let decision =
		toolName === "Send" &&
		(await shouldAutoAllowSendWithinScope(narratorId, narrator, effectiveInput))
			? "allow"
			: resolvePermissionDecision({
					toolName,
					input: effectiveInput,
					permMode: decisionPermMode,
					cwd,
					bashAnalysis,
					isChapter,
					planFileId,
					planMode: isPlanMode,
					conclusionFileId,
					compiledPolicy,
					executionContext,
					relaxedPlan: isRelaxedPlan,
					previousPermissionMode: narrator?.previousPermissionMode ?? undefined,
					meta: permMeta,
					projectGitPath: compiledPolicy.projectGitPath ?? undefined,
					executionBackend: executionContext?.backend,
					executionTarget: initialExecutionTarget,
					webFetchPolicy: settings.agent.webFetchPolicy,
				});
	logger.debug("Permission decision", {
		narratorId,
		toolName,
		decision,
		permMode: decisionPermMode,
		cwd,
		policyRevision: compiledPolicy.revision,
		whitelistDirCount: compiledPolicy.directoryWhitelist.length,
		blacklistDirCount: compiledPolicy.directoryBlacklist.length,
		bashAnalysisAvailable: !!bashAnalysis,
		bashFilePaths: bashAnalysis?.filePaths,
		bashNonWhitelisted: bashAnalysis?.nonWhitelisted,
		bashHasWrite: bashAnalysis?.hasWriteOperation,
	});

	const effectiveMode = getEffectivePermissionMode(
		decisionPermMode,
		isPlanMode,
		isRelaxedPlan,
		narrator?.previousPermissionMode,
	);
	const globalDangerReflectionLevel = normalizeDangerReflectionLevel(
		settings.agent.dangerReflectionLevel,
		settings.agent.dangerReflectionEnabled,
	);
	const dangerReflectionLevel = resolveDangerReflectionLevel(
		narrator?.dangerReflectionOverride,
		globalDangerReflectionLevel,
	);
	// External narrators have no human to answer a prompt. Under readOnly/dontAsk that means
	// anything needing approval is denied. Under bypassPermissions the narrator instead
	// carries its review burden through the danger reflection loop below, so these two
	// fail-closed shortcuts must not pre-empt it.
	const oauthReflectsInsteadOfDenying =
		!!runtimeConstraint && runtimeConstraint.permissionMode === "bypassPermissions";
	if (runtimeConstraint && !oauthReflectsInsteadOfDenying && decision === "ask") {
		permMeta.blacklistReason =
			"OAuth runtime policy denies operations that require interactive approval";
		decision = "deny";
	}
	if (
		runtimeConstraint &&
		!oauthReflectsInsteadOfDenying &&
		decision === "allow" &&
		oauthKnowledgeCapability !== "write"
	) {
		const oauthDanger =
			toolName === SHELL_TOOL_NAME && shellAnalysisError
				? buildShellAnalysisFailureDanger(toolName, effectiveInput, shellAnalysisError)
				: classifyDanger(
						toolName,
						effectiveInput,
						cwd,
						bashAnalysis,
						[],
						[],
						settings.agent.dangerSkipReadOnlyConfirmations,
						compiledPolicy,
						executionContext,
					);
		if (oauthDanger) {
			permMeta.blacklistReason =
				`OAuth runtime policy denies operations requiring danger confirmation: ` +
				oauthDanger.summary +
				(shellAnalysisError ? ` (${shellAnalysisError})` : "");
			decision = "deny";
		}
	}
	const startDangerReflectionPause = async (
		danger: DangerInfo,
		fingerprint: string,
		opts: { planModeSoftDeny?: boolean; skipConfirmationCache?: boolean } = {},
	): Promise<PermissionResult | null> => {
		if (!opts.skipConfirmationCache && consumeDangerConfirmation(narratorId, fingerprint)) {
			return null;
		}
		const toolCallRecord = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
			),
		});
		if (!toolCallRecord) {
			logger.error("Tool call record not found for danger reflection", {
				narratorId,
				toolName,
				toolUseId,
			});
			return { behavior: "deny", message: "Internal error: tool call record not found" };
		}
		const requestId = toolCallRecord.id;
		const startedAtMs = Date.now();
		const now = new Date(startedAtMs).toISOString();
		const suggestions = [
			{
				type: "danger_reflection",
				status: "running",
				requestId,
				danger,
				fingerprint,
				startedAt: now,
				...(opts.planModeSoftDeny ? { planModeSoftDeny: true } : {}),
			},
		];
		logger.warn("Danger reflection: high-risk operation paused inside permission handler", {
			narratorId,
			toolName,
			toolUseId,
			fingerprint,
			severity: danger.severity,
			summary: danger.summary,
		});

		await db
			.update(narratorToolCalls)
			.set({
				status: "pending",
				inputJson: effectiveInput,
				permissionStartedAt: now,
				permissionDecisionReason: `Danger reflection: ${danger.summary}`,
				permissionSuggestions: suggestions,
			})
			.where(eq(narratorToolCalls.id, requestId));
		await narratorService.updateStatus(narratorId, "waiting", {
			substatus: ["reflecting"],
		});
		await mirrorPermissionStatusToTarget(narratorId, wsTarget, "waiting", {
			substatus: ["reflecting"],
		});
		if (signal.aborted) {
			await markDangerReflectionAborted(
				requestId,
				wsTarget,
				toolUseId,
				narratorId,
				{
					danger,
					fingerprint,
					startedAt: startedAtMs,
				},
				{ parentToolUseId },
			);
			return { behavior: "deny", message: "Narrator aborted" };
		}

		const decisionPromise = new Promise<PermissionResult>((resolve) => {
			let cleanup = () => {};
			const onAbort = () => {
				void markDangerReflectionAborted(requestId, wsTarget, toolUseId, narratorId, undefined, {
					cleanup: true,
					parentToolUseId,
				}).catch((err) => {
					logger.warn("Failed to mark danger reflection as aborted", {
						error: err instanceof Error ? err.message : String(err),
						narratorId,
						requestId,
					});
				});
				resolve({ behavior: "deny", message: "Narrator aborted" });
			};
			cleanup = () => {
				signal.removeEventListener("abort", onAbort);
				pendingDangerReflections.delete(requestId);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			pendingDangerReflections.set(requestId, {
				narratorId,
				requestId,
				toolCallId: requestId,
				toolUseId,
				toolName,
				broadcastTargetId: wsTarget,
				parentToolUseId,
				input: effectiveInput,
				fingerprint,
				danger,
				startedAt: startedAtMs,
				planModeSoftDeny: opts.planModeSoftDeny,
				resolve,
				cleanup,
			});
		});
		broadcastReflectionFrame(
			{ narratorId, broadcastTargetId: wsTarget, parentToolUseId },
			{
				type: "danger_reflection_started",
				requestId,
				toolUseId,
				toolName,
				danger,
			},
		);
		return {
			behavior: "dangerReflection",
			requestId,
			danger,
			fingerprint,
			reflectionLevel: dangerReflectionLevel === "off" ? undefined : dangerReflectionLevel,
			appendPrompt: runtimeConstraint?.dangerReflectionPrompt,
			input: effectiveInput,
			decision: decisionPromise,
		};
	};
	// An external narrator under bypassPermissions reaches here with decision "ask" as well:
	// there is nobody to ask, so reflection is its review path rather than a denial.
	const oauthDangerReflectionCandidate =
		oauthReflectsInsteadOfDenying && (decision === "allow" || decision === "ask");
	if (
		(oauthDangerReflectionCandidate ||
			(!runtimeConstraint && decision === "allow" && effectiveMode === "bypassPermissions")) &&
		dangerReflectionLevel !== "off"
	) {
		const danger =
			toolName === SHELL_TOOL_NAME && shellAnalysisError
				? buildShellAnalysisFailureDanger(toolName, effectiveInput, shellAnalysisError)
				: classifyDanger(
						toolName,
						effectiveInput,
						cwd,
						bashAnalysis,
						[],
						[],
						settings.agent.dangerSkipReadOnlyConfirmations,
						compiledPolicy,
						executionContext,
					);
		if (danger && shouldTriggerDangerReflection(danger, dangerReflectionLevel)) {
			const fingerprint = createDangerFingerprint(
				toolName,
				effectiveInput,
				cwd,
				bashAnalysis,
				executionContext,
				compiledPolicy.revision,
			);
			const pause = await startDangerReflectionPause(danger, fingerprint);
			if (pause) return pause;
		}
	}
	// Fail closed rather than hang: an external narrator still holding "ask" here has no
	// reflection pause to resolve it (reflection is off, the risk classifier found nothing to
	// reflect on, or the confirmation cache already consumed this fingerprint) and no human
	// to answer the prompt, so it must not fall through to the interactive approval wait.
	if (runtimeConstraint && decision === "ask") {
		permMeta.blacklistReason = oauthReflectsInsteadOfDenying
			? "OAuth runtime policy cannot obtain interactive approval and no danger reflection is available for this operation"
			: "OAuth runtime policy denies operations that require interactive approval";
		decision = "deny";
	}

	if (decision === "fatal") {
		return blockCatastrophicCommand({
			narratorId,
			toolName,
			toolUseId,
			toolInput: effectiveInput,
			bashAnalysis,
		});
	}
	if (decision === "allow") {
		logger.debug("Permission auto-allowed", { narratorId, toolName, toolUseId, permMode });
		await db
			.update(narratorToolCalls)
			.set({
				status: "running",
				permissionDecidedBy: "auto",
				permissionDecidedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
			);
		return {
			behavior: "allow",
			updatedInput: effectiveInput,
			...(planRedirectNotice
				? { notice: planRedirectNotice }
				: conclusionRedirectNotice
					? { notice: conclusionRedirectNotice }
					: {}),
		};
	}
	// Plan mode soft deny → ask the user once before falling back to auto-deny.
	let promotedPlanSoftDeny = false;
	if (decision === "deny") {
		const hasChapterGitIssues = isChapter && getChapterGitPermissionIssues(bashAnalysis).length > 0;
		const isPlanModeSoftDeny =
			isPlanMode &&
			!isRelaxedPlan &&
			!permMeta.commandBlacklistReason &&
			!hasChapterGitIssues &&
			(permMeta.planModeSoftDeny || !permMeta.blacklistReason);
		if (isPlanModeSoftDeny && !planModeAskedOnce.has(narratorId)) {
			planModeAskedOnce.add(narratorId);
			promotedPlanSoftDeny = true;
			decision = "ask";
		}
	}
	if (promotedPlanSoftDeny && permMode === "bypassPermissions" && dangerReflectionLevel !== "off") {
		const baseDanger =
			toolName === SHELL_TOOL_NAME && shellAnalysisError
				? buildShellAnalysisFailureDanger(toolName, effectiveInput, shellAnalysisError)
				: classifyDanger(
						toolName,
						effectiveInput,
						cwd,
						bashAnalysis,
						[],
						[],
						settings.agent.dangerSkipReadOnlyConfirmations,
						compiledPolicy,
						executionContext,
					);
		const danger = buildPlanModeSoftDenyDanger(
			toolName,
			effectiveInput,
			cwd,
			baseDanger,
			executionContext,
		);
		const fingerprint = `plan_mode_soft_deny:${createDangerFingerprint(
			toolName,
			effectiveInput,
			cwd,
			bashAnalysis,
			executionContext,
			compiledPolicy.revision,
		)}`;
		const pause = await startDangerReflectionPause(danger, fingerprint, {
			planModeSoftDeny: true,
			skipConfirmationCache: true,
		});
		if (pause) return pause;
	}
	if (decision === "deny") {
		if (permMeta.blacklistReason) {
			const denyMsg = `DENIED: ${permMeta.blacklistReason}`;
			logger.debug("Permission denied by blacklist", {
				narratorId,
				toolName,
				toolUseId,
				reason: permMeta.blacklistReason,
			});
			await db
				.update(narratorToolCalls)
				.set({
					status: "fail",
					errorMessage: denyMsg,
					permissionDecidedBy: "auto",
					permissionDecidedAt: new Date().toISOString(),
					permissionDecisionReason: permMeta.blacklistReason,
				})
				.where(
					and(
						eq(narratorToolCalls.narratorId, narratorId),
						eq(narratorToolCalls.toolUseId, toolUseId),
					),
				);
			return { behavior: "deny", message: denyMsg };
		}
		if (permMeta.commandBlacklistReason) {
			let denyMsg = `DENIED: ${permMeta.commandBlacklistReason}`;
			if (permMeta.commandBlacklistDenyPrompt) {
				denyMsg += `\n${permMeta.commandBlacklistDenyPrompt}`;
			}
			logger.debug("Permission denied by command blacklist", {
				narratorId,
				toolName,
				toolUseId,
				reason: permMeta.commandBlacklistReason,
			});
			await db
				.update(narratorToolCalls)
				.set({
					status: "fail",
					errorMessage: denyMsg,
					permissionDecidedBy: "auto",
					permissionDecidedAt: new Date().toISOString(),
					permissionDecisionReason: permMeta.commandBlacklistReason,
				})
				.where(
					and(
						eq(narratorToolCalls.narratorId, narratorId),
						eq(narratorToolCalls.toolUseId, toolUseId),
					),
				);
			return { behavior: "deny", message: denyMsg };
		}
		const chapterGitIssues = isChapter ? getChapterGitPermissionIssues(bashAnalysis) : [];
		const isReadToolPathDenied =
			(permMode === "readOnly" || isPlanMode) &&
			(READ_ONLY_TOOLS.includes(toolName) ||
				(toolName === SHELL_TOOL_NAME &&
					bashAnalysis &&
					!bashAnalysis.hasWriteOperation &&
					bashAnalysis.nonWhitelisted.length === 0 &&
					!bashAnalysis.dangerousPatterns.length &&
					!bashAnalysis.hasEnvInjection));
		const denyMsg =
			chapterGitIssues.length > 0
				? `DENIED: Chapter mode restricts git branch/worktree operations. Issues: ${chapterGitIssues.join("; ")}. Use NarraFork chapter operations or request explicit permission in an interactive mode.`
				: isReadToolPathDenied
					? getToolMessage("permissionDeniedPathOutsideScope", locale)
					: isPlanMode
						? getToolMessage("permissionDeniedPlanMode", locale)
						: permMode === "readOnly"
							? getToolMessage("permissionDeniedReadOnly", locale)
							: getToolMessage("permissionDeniedNonInteractive", locale);
		const decisionReason = chapterGitIssues.length > 0 ? chapterGitIssues.join("; ") : undefined;
		logger.debug("Permission auto-denied", {
			narratorId,
			toolName,
			toolUseId,
			permMode,
			...(decisionReason ? { reason: decisionReason } : {}),
		});
		await db
			.update(narratorToolCalls)
			.set({
				status: "fail",
				errorMessage: denyMsg,
				permissionDecidedBy: "auto",
				permissionDecidedAt: new Date().toISOString(),
				...(decisionReason ? { permissionDecisionReason: decisionReason } : {}),
			})
			.where(
				and(
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
			);
		return {
			behavior: "deny",
			message: denyMsg,
		};
	}

	const toolCallRecord = await db.query.narratorToolCalls.findFirst({
		where: and(
			eq(narratorToolCalls.narratorId, narratorId),
			eq(narratorToolCalls.toolUseId, toolUseId),
		),
	});

	if (!toolCallRecord) {
		logger.error("Tool call record not found for permission request", { narratorId, toolUseId });
		return { behavior: "deny", message: "Internal error: tool call record not found" };
	}

	const toolCallId = toolCallRecord.id;

	logger.debug("Permission request created", {
		narratorId,
		toolCallId,
		toolUseId,
		toolName,
		pendingCount: pendingPermissions.size,
	});

	// Build decisionReason from bash analysis
	let decisionReason: string | undefined;
	if (bashAnalysis && !bashAnalysis.allWhitelisted) {
		const parts: string[] = [];
		if (bashAnalysis.nonWhitelisted.length > 0) {
			parts.push(`Commands requiring approval: ${bashAnalysis.nonWhitelisted.join(", ")}`);
		}
		if (bashAnalysis.dangerousPatterns.length > 0) {
			parts.push(`Dangerous patterns: ${bashAnalysis.dangerousPatterns.join(", ")}`);
		}
		if (bashAnalysis.hasEnvInjection) {
			parts.push("Environment variable injection detected");
		}
		decisionReason = parts.join("; ");
	}
	if (isChapter && bashAnalysis) {
		const chapterGitParts: string[] = [];
		if (bashAnalysis.gitBranchViolations.length > 0) {
			chapterGitParts.push(`Chapter git issues: ${bashAnalysis.gitBranchViolations.join("; ")}`);
		}
		if (bashAnalysis.gitBranchWarnings.length > 0) {
			chapterGitParts.push(`Chapter git warnings: ${bashAnalysis.gitBranchWarnings.join("; ")}`);
		}
		if (chapterGitParts.length > 0) {
			const chapterGitMsg = chapterGitParts.join("; ");
			decisionReason = decisionReason ? `${decisionReason}; ${chapterGitMsg}` : chapterGitMsg;
		}
	}

	if (toolName === "Agent" && typeof input.workdir === "string" && input.workdir) {
		const resolvedWorkdir = resolvePath(cwd, input.workdir);
		decisionReason = `Subagent requests custom working directory: ${resolvedWorkdir} (parent cwd: ${cwd})`;
	}

	if (promotedPlanSoftDeny) {
		decisionReason = getToolMessage("planModeSoftDenyAskReason", locale);
	}

	await db
		.update(narratorToolCalls)
		.set({
			status: "pending",
			inputJson: effectiveInput,
			permissionStartedAt: new Date().toISOString(),
			...(decisionReason ? { permissionDecisionReason: decisionReason } : {}),
		})
		.where(eq(narratorToolCalls.id, toolCallId));
	const pendingExecutionTarget = snapshotExecutionTarget(initialExecutionTarget);
	if (isRoutedPermissionTool(toolName) && !pendingExecutionTarget) {
		return {
			behavior: "deny",
			message: "Routed permission lost its frozen execution target before pending state",
		};
	}

	// When automatic AskUserQuestion reflection is armed, compute the absolute
	// deadline up front so the timer, the request broadcast, and later reconnects
	// all agree on the same countdown target.
	const questionReflectionDeadline =
		toolName === "AskUserQuestion" && shouldScheduleQuestionReflection(effectiveMode)
			? Date.now() + getQuestionReflectionTimeoutMs()
			: undefined;

	broadcastToNarrator(wsTarget, {
		type: "permission_request",
		narratorId: wsTarget,
		request: {
			id: toolCallId,
			...routingIdentity,
			toolName,
			toolUseId,
			inputJson: effectiveInput,
			decisionReason,
			executionDeviceId: pendingExecutionTarget?.deviceId ?? null,
			executionCwd: pendingExecutionTarget?.cwd ?? null,
			resolvedFilePath:
				pendingExecutionTarget?.canonicalPath ??
				pendingExecutionTarget?.lexicalPath ??
				pendingExecutionTarget?.resolvedFilePath ??
				null,
			deviceSelectionSource: pendingExecutionTarget?.selectionSource ?? null,
			...(questionReflectionDeadline !== undefined
				? { reflectionDeadline: questionReflectionDeadline }
				: {}),
		},
	});
	eventBus.emit({ type: "narrator:permission_request", narratorId, requestId: toolCallId });
	// A real permission request is waiting for the user — emit the semantic
	// attention intent so notification consumers can alert the user. Suppressed
	// when the caller (e.g. plan-reflection takeover fallback) drives this itself.
	// Track whether we emitted so resolvePermission can fire the symmetric
	// `narrator:attention_resolved` only when an attention was actually raised.
	const attentionEmitted = !options?.suppressAttention;
	if (attentionEmitted) {
		eventBus.emit({ type: "narrator:attention", narratorId, reason: "waiting_permission" });
	}
	await narratorService.updateStatus(narratorId, "waiting");
	await mirrorPermissionStatusToTarget(narratorId, broadcastTargetId, "waiting");

	if (signal.aborted) {
		broadcastToNarrator(wsTarget, {
			type: "permission_resolved",
			narratorId: wsTarget,
			requestId: toolCallId,
			toolUseId,
			...routingIdentity,
		});
		await db
			.update(narratorToolCalls)
			.set({
				status: "fail",
				errorMessage: "Narrator aborted",
				permissionDecidedBy: "aborted",
				permissionDecidedAt: new Date().toISOString(),
			})
			.where(eq(narratorToolCalls.id, toolCallId));
		return { behavior: "deny", message: "Narrator aborted" };
	}

	return new Promise<PermissionResult>((resolve) => {
		let pendingEntry: PendingPermission | undefined;
		const cleanup = () => {
			if (pendingEntry?.questionReflectionTimer) {
				clearTimeout(pendingEntry.questionReflectionTimer);
				pendingEntry.questionReflectionTimer = undefined;
			}
			signal.removeEventListener("abort", onAbort);
			pendingPermissions.delete(toolCallId);
		};

		const onAbort = async () => {
			logger.debug("Permission request aborted", {
				narratorId,
				toolCallId,
				toolUseId,
				toolName,
			});
			cleanup();
			broadcastToNarrator(wsTarget, {
				type: "permission_resolved",
				narratorId: wsTarget,
				requestId: toolCallId,
				toolUseId,
				...routingIdentity,
			});
			await db
				.update(narratorToolCalls)
				.set({
					status: "fail",
					errorMessage: "Narrator aborted",
					permissionDecidedBy: "aborted",
					permissionDecidedAt: new Date().toISOString(),
				})
				.where(eq(narratorToolCalls.id, toolCallId));
			await mirrorPermissionStatusToTarget(narratorId, broadcastTargetId, "working");
			resolve({ behavior: "deny", message: "Narrator aborted" });
		};

		signal.addEventListener("abort", onAbort, { once: true });

		pendingEntry = {
			resolve,
			cleanup,
			input: effectiveInput,
			narratorId,
			toolName,
			toolUseId,
			broadcastTargetId: wsTarget,
			parentToolUseId,
			cwd,
			locale,
			signal,
			executionTarget: pendingExecutionTarget,
			planSource: snapshotPendingPlanSource(exitPlanSource),
			planModeSoftDeny: promotedPlanSoftDeny || undefined,
			planSubmittedFromFile:
				toolName === "ExitPlanMode" && exitPlanResolvedFromFile ? true : undefined,
			attentionEmitted,
		};
		pendingPermissions.set(toolCallId, pendingEntry);
		if (toolName === "AskUserQuestion" && questionReflectionDeadline !== undefined) {
			pendingEntry.questionReflectionDeadline = questionReflectionDeadline;
			pendingEntry.questionReflectionTimer = scheduleQuestionReflection(
				toolCallId,
				effectiveMode,
				questionReflectionDeadline,
			);
		}
	});
}

export interface ResolvePermissionOpts {
	denyMessage?: string;
	answers?: Record<string, string>;
	feedbackText?: string;
	compactAfter?: boolean;
	updatedPlan?: string;
	userId?: string;
	/**
	 * Who decided this permission. `"user"`/`"auto"`/`"reflection"` are the built-in
	 * deciders; `narrator:<id>` marks a proxy approval by a controlling named narrator
	 * (chat-group "full control"). The value is persisted to permissionDecidedBy.
	 */
	decidedBy?: "user" | "auto" | "reflection" | `narrator:${string}`;
	exitPlanCancelled?: boolean;
}

type DangerReflectionDecidedBy = "reflection" | "user" | "auto" | `narrator:${string}`;

async function enableRelaxedPlanAfterPlanSoftDeny(
	narratorId: string,
	broadcastTargetId: string,
): Promise<void> {
	try {
		await narratorService.updateRelaxedPlan(narratorId, true);
		broadcastToNarrator(broadcastTargetId, {
			type: "relaxed_plan_changed",
			narratorId,
			relaxedPlan: true,
		});
	} catch (err) {
		logger.warn("Failed to auto-enable relaxedPlan", {
			narratorId,
			error: String(err),
		});
	}
}

/** Cancel pending ExitPlanMode approvals for a narrator (e.g. manual plan-mode cancellation). */
export async function cancelPendingExitPlanMode(
	narratorId: string,
	message?: string,
): Promise<number> {
	const requests = [...pendingPermissions.entries()].filter(
		([, pending]) => pending.narratorId === narratorId && pending.toolName === "ExitPlanMode",
	);
	for (const [requestId] of requests) {
		await resolvePermission(requestId, "deny", {
			denyMessage: message,
			decidedBy: "auto",
			exitPlanCancelled: true,
		});
	}
	return requests.length;
}

/** Called when a pending permission receives a user or automatic decision. */
export async function resolvePermission(
	requestId: string,
	decision: "allow" | "deny",
	opts: ResolvePermissionOpts = {},
): Promise<boolean> {
	const {
		denyMessage,
		answers,
		feedbackText,
		compactAfter,
		updatedPlan,
		userId,
		decidedBy = "user",
		exitPlanCancelled,
	} = opts;
	const pending = pendingPermissions.get(requestId);
	if (!pending) {
		logger.warn("Permission resolution for unknown request", {
			requestId,
			decision,
			pendingKeys: [...pendingPermissions.keys()],
		});
		return false;
	}

	logger.debug("Resolving permission", {
		requestId,
		decision,
		narratorId: pending.narratorId,
		toolUseId: pending.toolUseId,
	});

	pending.cleanup();

	// Mirror of the `narrator:attention` emit in handlePermission — fire the
	// symmetric resolved intent only when an attention was actually raised for
	// this request (never for suppressed/takeover paths, so the two events stay
	// one-to-one). `detail` carries the user's decision.
	if (pending.attentionEmitted) {
		eventBus.emit({
			type: "narrator:attention_resolved",
			narratorId: pending.narratorId,
			reason: "waiting_permission",
			detail: decision,
		});
	}

	let updatedInput: Record<string, unknown> | undefined;
	if (answers) {
		updatedInput = { ...pending.input, answers };
	} else if (updatedPlan !== undefined && pending.toolName === "ExitPlanMode") {
		updatedInput = { ...pending.input, plan: updatedPlan };
	}

	// When a controlling named narrator proxy-decided, resolve its handle for the UI.
	let decidedByNarrator: { id: string; handle: string | null } | undefined;
	if (decidedBy.startsWith("narrator:")) {
		const proxyId = decidedBy.slice("narrator:".length);
		const proxy = await narratorService.getById(proxyId).catch(() => null);
		decidedByNarrator = { id: proxyId, handle: proxy?.handle ?? null };
	}

	broadcastToNarrator(pending.broadcastTargetId, {
		type: "permission_resolved",
		narratorId: pending.broadcastTargetId,
		requestId,
		toolUseId: pending.toolUseId,
		decision,
		...pendingPermissionRoutingIdentity(pending),
		...(updatedInput ? { updatedInput } : {}),
		...(decidedByNarrator ? { decidedByNarrator } : {}),
		...(decision === "deny" && (denyMessage || feedbackText?.trim())
			? { feedbackText: denyMessage || feedbackText?.trim() }
			: {}),
	});

	try {
		await narratorService.updateStatus(pending.narratorId, "working");
		await mirrorPermissionStatusToTarget(pending.narratorId, pending.broadcastTargetId, "working");
		const now = new Date().toISOString();
		const effectiveDenyMessage = denyMessage || feedbackText?.trim() || undefined;
		await db
			.update(narratorToolCalls)
			.set({
				status: decision === "allow" ? "running" : "fail",
				permissionDecidedBy: decidedBy,
				permissionDecidedAt: now,
				permissionDenyMessage: effectiveDenyMessage ?? null,
				...(decision === "deny"
					? {
							errorMessage: effectiveDenyMessage || "Permission denied by user",
						}
					: {}),
			})
			.where(eq(narratorToolCalls.id, requestId));
	} catch (err) {
		logger.error("Failed to update permission state in DB, resolving anyway", {
			requestId,
			error: String(err),
		});
	}

	if (decision === "allow") {
		if (feedbackText?.trim()) {
			pendingFeedback.set(pending.narratorId, {
				toolUseId: pending.toolUseId,
				feedbackText: feedbackText.trim(),
				// Carry the approver so the injected turn shows their avatar rather
				// than an anonymous "you".
				userId: decidedBy === "user" ? (userId ?? null) : null,
			});
		}
		const effectiveUpdatedInput = updatedInput ?? pending.input;

		if (updatedInput) {
			try {
				await db
					.update(narratorToolCalls)
					.set({ inputJson: effectiveUpdatedInput })
					.where(eq(narratorToolCalls.toolUseId, pending.toolUseId));
			} catch (err) {
				logger.error("Failed to persist updated tool call input", {
					requestId,
					toolName: pending.toolName,
					error: String(err),
				});
			}
		}

		if (compactAfter) {
			pendingPlanCompact.add(pending.narratorId);
		}

		if (pending.toolName === "ExitPlanMode" && userId) {
			pendingPlanApprover.set(pending.narratorId, userId);
		}

		if (updatedPlan !== undefined && pending.toolName === "ExitPlanMode") {
			const originalPlan = typeof pending.input.plan === "string" ? pending.input.plan : "";
			if (originalPlan && updatedPlan !== originalPlan) {
				const { computeLineDiff } = await import("./narrator-compact");
				const diff = computeLineDiff(originalPlan, updatedPlan);
				if (diff) {
					pendingPlanDiff.set(pending.narratorId, diff);
				}
			}
		}

		// Plan mode soft deny → approval auto-enables relaxed plan.
		if (pending.planModeSoftDeny) {
			await enableRelaxedPlanAfterPlanSoftDeny(pending.narratorId, pending.broadcastTargetId);
		}

		pending.resolve({ behavior: "allow", updatedInput: effectiveUpdatedInput });

		if (feedbackText?.trim() && pending.toolName !== "ExitPlanMode") {
			const active = activeNarrators.get(pending.narratorId);
			if (active?.alive) {
				active._feedbackSoftStop = true;
			}
		}
	} else {
		const userFeedback = denyMessage || feedbackText?.trim();
		if (pending.toolName === "ExitPlanMode") {
			const locale = activeNarrators.get(pending.narratorId)?.locale ?? "en";
			if (exitPlanCancelled && userFeedback) {
				pending.resolve({ behavior: "deny", message: userFeedback, rawMessage: true });
			} else {
				const denyKey = pending.planSubmittedFromFile
					? "exitPlanModeDeniedFile"
					: "exitPlanModeDenied";
				const denyWithMessageKey = pending.planSubmittedFromFile
					? "exitPlanModeDeniedFileWithMessage"
					: "exitPlanModeDeniedWithMessage";
				const planDenyMsg = userFeedback
					? getToolMessageWithParams(denyWithMessageKey, locale, {
							message: userFeedback,
						})
					: getToolMessage(denyKey, locale);
				pending.resolve({ behavior: "deny", message: planDenyMsg, rawMessage: true });
			}
		} else {
			const message = userFeedback || "Permission denied by user";
			pending.resolve({ behavior: "deny", message });
		}
	}
	return true;
}

export async function resolvePermissionOrDangerReflection(
	requestId: string,
	decision: "allow" | "deny",
	opts: ResolvePermissionOpts = {},
): Promise<boolean> {
	if (pendingPermissions.has(requestId)) {
		return resolvePermission(requestId, decision, opts);
	}

	if (pendingDangerReflections.has(requestId)) {
		if (decision === "allow") {
			const reflection = opts.feedbackText?.trim() || opts.denyMessage?.trim() || undefined;
			return confirmDangerReflection(requestId, reflection, opts.decidedBy ?? "user");
		}

		const reason = opts.denyMessage?.trim() || opts.feedbackText?.trim() || undefined;
		return cancelDangerReflection(requestId, reason, opts.decidedBy ?? "user");
	}

	// Task reflection taken over by the user: their approve/deny resolves the
	// reflection decision (allow → confirm/execute, deny → revise/feedback).
	const { hasPendingTaskReflection, confirmTaskReflection, reviseTaskReflection } = await import(
		"@server/lib/agent/tools/task-reflection"
	);
	if (hasPendingTaskReflection(requestId)) {
		if (decision === "allow") {
			const evidence =
				opts.feedbackText?.trim() || "User approved the protected task change via takeover.";
			return confirmTaskReflection(requestId, evidence, undefined, "user");
		}
		const feedback =
			opts.denyMessage?.trim() ||
			opts.feedbackText?.trim() ||
			"User rejected the protected task change.";
		const nextSteps =
			"The user declined this protected task change. Do not retry it without new instructions.";
		return reviseTaskReflection(requestId, feedback, nextSteps, "user");
	}

	return resolvePermission(requestId, decision, opts);
}

/**
 * Proxy-resolve a pending permission request on behalf of a controlling named
 * narrator (chat-group "full control"). Validates that the caller shares an
 * active chat group with the request's target narrator AND has canControl, then
 * resolves the request exactly like a user decision would (same recovery path),
 * recording the decider as `narrator:<callerId>` for audit.
 *
 * Returns { ok, reason } — ok=false with a human-readable reason when the caller
 * is not authorized or the request no longer exists.
 */
export async function resolvePermissionAsNarrator(
	requestId: string,
	callerNarratorId: string,
	decision: "allow" | "deny",
	opts: { denyMessage?: string; feedbackText?: string } = {},
): Promise<{ ok: boolean; reason?: string }> {
	// Locate the target narrator for this request (pending permission or danger reflection).
	const pendingPerm = pendingPermissions.get(requestId);
	const pendingDanger = pendingPerm ? undefined : pendingDangerReflections.get(requestId);
	const targetNarratorId = pendingPerm?.narratorId ?? pendingDanger?.narratorId;
	if (!targetNarratorId) {
		return { ok: false, reason: "Permission request not found or already resolved." };
	}
	if (targetNarratorId === callerNarratorId) {
		return { ok: false, reason: "Cannot proxy-approve your own permission request." };
	}

	// Authorize: caller must share an active chat group with the target and have canControl.
	const { chatGroupService } = await import("./chat-group-service");
	const authorized = await chatGroupService.canControlNarrator(callerNarratorId, targetNarratorId);
	if (!authorized) {
		return {
			ok: false,
			reason:
				"Not authorized: you must be a controlling member of a chat group that includes the target narrator.",
		};
	}

	const resolved = await resolvePermissionOrDangerReflection(requestId, decision, {
		denyMessage: opts.denyMessage,
		feedbackText: opts.feedbackText,
		decidedBy: `narrator:${callerNarratorId}`,
	});
	if (!resolved) {
		return { ok: false, reason: "Permission request not found or already resolved." };
	}
	logger.info("Permission proxy-resolved by narrator", {
		requestId,
		callerNarratorId,
		targetNarratorId,
		decision,
	});
	return { ok: true };
}

function dangerReflectionSuggestions(
	pause: {
		danger: PendingDangerReflection["danger"];
		fingerprint: string;
		startedAt?: number;
		requestId?: string;
	},
	status: "running" | "awaiting_user" | "confirmed" | "cancelled" | "aborted" | "failed",
	reason?: string,
) {
	return [
		{
			type: "danger_reflection",
			status,
			requestId: pause.requestId,
			danger: pause.danger,
			fingerprint: pause.fingerprint,
			startedAt:
				typeof pause.startedAt === "number" ? new Date(pause.startedAt).toISOString() : undefined,
			resolvedAt: new Date().toISOString(),
			...(reason ? { reason } : {}),
		},
	];
}

/**
 * Broadcast one live progress tick for a running danger reflection.
 *
 * Transient only — deliberately NOT persisted to `narratorToolCalls`: the
 * reflection loop reports on a throttled cadence, and writing the row per tick
 * would put repeated writes on the main-thread SQLite path. Clients that miss a
 * tick simply get the next one, and `danger_reflection_resolved` remains the
 * authoritative terminal state.
 */
export function broadcastDangerReflectionProgress(
	requestId: string,
	snapshot: ProgressSnapshot,
): void {
	const pause = pendingDangerReflections.get(requestId);
	if (!pause) return;
	broadcastReflectionFrame(pause, {
		type: "reflection_progress",
		requestId,
		toolUseId: pause.toolUseId,
		kind: "danger_reflection",
		phase: snapshot.phase,
		thinkingChars: snapshot.thinkingChars,
		outputChars: snapshot.outputChars,
	});
}

async function markDangerReflectionAborted(
	requestId: string,
	broadcastTargetId: string,
	toolUseId: string,
	narratorId: string,
	fallback?: Pick<PendingDangerReflection, "danger" | "fingerprint" | "startedAt">,
	options: { cleanup?: boolean; parentToolUseId?: string } = {},
): Promise<void> {
	const pause = pendingDangerReflections.get(requestId);
	const suggestionSource = pause ?? fallback;
	try {
		const now = new Date().toISOString();
		await db
			.update(narratorToolCalls)
			.set({
				status: "fail",
				errorMessage: "Narrator aborted",
				permissionDecidedBy: "aborted",
				permissionDecidedAt: now,
				permissionDecisionReason: "Danger reflection aborted",
				...(suggestionSource
					? {
							permissionSuggestions: dangerReflectionSuggestions(
								{ ...suggestionSource, requestId },
								"aborted",
								"Narrator aborted",
							),
						}
					: {}),
			})
			.where(eq(narratorToolCalls.id, requestId));
		broadcastReflectionFrame(
			{
				narratorId,
				broadcastTargetId,
				parentToolUseId: pause?.parentToolUseId ?? options.parentToolUseId,
			},
			{
				type: "danger_reflection_resolved",
				requestId,
				toolUseId,
				decision: "aborted",
				reason: "Narrator aborted",
			},
		);
		await narratorService.updateStatus(narratorId, "working").catch(() => {});
		await mirrorPermissionStatusToTarget(narratorId, broadcastTargetId, "working").catch(() => {});
	} catch (err) {
		logger.warn("Failed to mark danger reflection as aborted", {
			requestId,
			narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
	} finally {
		await narratorService.updateStatus(narratorId, "working").catch(() => {});
		await mirrorPermissionStatusToTarget(narratorId, broadcastTargetId, "working").catch(() => {});
		if (options.cleanup) {
			pendingDangerReflections.get(requestId)?.cleanup();
			pendingDangerReflections.delete(requestId);
		}
	}
}

function getPersistedDangerReflectionSuggestion(
	suggestions: unknown,
): { status: string; reason?: string } | null {
	if (!Array.isArray(suggestions)) return null;
	for (const suggestion of suggestions) {
		if (!suggestion || typeof suggestion !== "object" || Array.isArray(suggestion)) continue;
		const record = suggestion as Record<string, unknown>;
		if (record.type !== "danger_reflection") continue;
		return {
			status: typeof record.status === "string" ? record.status : "running",
			reason: typeof record.reason === "string" ? record.reason : undefined,
		};
	}
	return null;
}

function dangerReflectionDecisionFromStatus(status: string): "allow" | "deny" | "aborted" {
	if (status === "confirmed" || status === "allow") return "allow";
	if (status === "aborted") return "aborted";
	return "deny";
}

function abortPersistedDangerReflectionSuggestions(
	suggestions: unknown,
	reason: string,
	resolvedAt: string,
	requestId: string,
): unknown[] | null {
	if (!Array.isArray(suggestions)) return null;
	let changed = false;
	const next = suggestions.map((suggestion) => {
		if (!suggestion || typeof suggestion !== "object" || Array.isArray(suggestion)) {
			return suggestion;
		}
		const record = suggestion as Record<string, unknown>;
		if (record.type !== "danger_reflection") return suggestion;
		const status = typeof record.status === "string" ? record.status : "running";
		if (status !== "running" && status !== "awaiting_user") return suggestion;
		changed = true;
		return {
			...record,
			requestId: typeof record.requestId === "string" ? record.requestId : requestId,
			status: "aborted",
			reason,
			resolvedAt,
		};
	});
	return changed ? next : null;
}

async function abortPersistedDangerReflectionWithoutRuntime(
	requestId: string,
	reason?: string,
): Promise<boolean> {
	const toolCall = await db.query.narratorToolCalls.findFirst({
		where: eq(narratorToolCalls.id, requestId),
		columns: {
			id: true,
			narratorId: true,
			messageId: true,
			toolUseId: true,
			status: true,
			permissionSuggestions: true,
		},
	});
	if (!toolCall) return false;

	const existingReflection = getPersistedDangerReflectionSuggestion(toolCall.permissionSuggestions);
	if (!existingReflection) return false;
	const [narrator, ownerMessage] = await Promise.all([
		db.query.narrators.findFirst({
			where: eq(narrators.id, toolCall.narratorId),
			columns: { parentNarratorId: true },
		}),
		db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, toolCall.messageId),
			columns: { parentToolUseId: true },
		}),
	]);
	// No runtime pause exists, so the route is rebuilt from persistence: the owner
	// plus its parent (if it is a subagent) are exactly the pages that can be
	// rendering this gate. `broadcastReflectionFrame` applies the same fan-out.
	const route = {
		narratorId: toolCall.narratorId,
		broadcastTargetId: narrator?.parentNarratorId ?? toolCall.narratorId,
		parentToolUseId: ownerMessage?.parentToolUseId ?? undefined,
	};
	const broadcastResolved = (decision: "allow" | "deny" | "aborted", resolvedReason?: string) => {
		broadcastReflectionFrame(route, {
			type: "danger_reflection_resolved",
			requestId,
			toolUseId: toolCall.toolUseId,
			decision,
			reason: resolvedReason,
		});
	};

	const message =
		reason?.trim() ||
		"Danger reflection was interrupted before manual takeover; no live reflection loop remains";
	const now = new Date().toISOString();
	const abortedSuggestions = abortPersistedDangerReflectionSuggestions(
		toolCall.permissionSuggestions,
		message,
		now,
		requestId,
	);

	if (abortedSuggestions) {
		await db
			.update(narratorToolCalls)
			.set({
				...(toolCall.status === "pending"
					? {
							status: "fail",
							errorMessage: message,
							permissionDecidedBy: "aborted",
							permissionDecidedAt: now,
						}
					: {}),
				permissionDecisionReason: message,
				permissionSuggestions: abortedSuggestions,
			})
			.where(eq(narratorToolCalls.id, requestId));
		broadcastResolved("aborted", message);
		return true;
	}

	// Idempotent no-op: startup recovery may have already marked the persisted
	// reflection as resolved while an old browser tab still has a running notice.
	broadcastResolved(
		dangerReflectionDecisionFromStatus(existingReflection.status),
		reason?.trim() || existingReflection.reason,
	);
	return true;
}

export async function stopDangerReflectionLoop(
	requestId: string,
	reason?: string,
): Promise<boolean> {
	const pause = pendingDangerReflections.get(requestId);
	if (!pause) return abortPersistedDangerReflectionWithoutRuntime(requestId, reason);

	const message = reason?.trim() || "Danger reflection stopped by user; awaiting user decision";
	pause.reflectionStoppedByUser = true;
	pause.reflectionAbortController?.abort(new Error(message));

	try {
		await db
			.update(narratorToolCalls)
			.set({
				status: "pending",
				permissionDecisionReason: message,
				permissionSuggestions: dangerReflectionSuggestions(pause, "awaiting_user", message),
			})
			.where(eq(narratorToolCalls.id, pause.toolCallId));
		broadcastReflectionFrame(pause, {
			type: "danger_reflection_stopped",
			requestId,
			toolUseId: pause.toolUseId,
			toolName: pause.toolName,
			danger: pause.danger,
			inputJson: pause.input,
			reason: message,
		});
		// The AI loop is no longer deliberating — the decision now sits with the
		// user — so the "reflecting" tag must go, exactly as the plan/task gates do
		// on `awaiting_user` (see task-reflection.markTaskReflectionStatus). Leaving
		// it set kept every view's status badge / favicon / list card claiming the
		// reflection was still running after the takeover.
		await narratorService.updateStatus(pause.narratorId, "waiting", { substatus: [] });
		await mirrorPermissionStatusToTarget(pause.narratorId, pause.broadcastTargetId, "waiting", {
			substatus: [],
		});
	} catch (err) {
		logger.warn("Failed to stop danger reflection loop", {
			requestId,
			narratorId: pause.narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
	return true;
}

export async function confirmDangerReflection(
	requestId: string,
	reflection?: string,
	decidedBy: DangerReflectionDecidedBy = "reflection",
): Promise<boolean> {
	const pause = pendingDangerReflections.get(requestId);
	if (!pause) return false;
	if (decidedBy === "reflection" && pause.reflectionStoppedByUser) return false;
	pause.cleanup();
	const reason = reflection?.trim() || pause.danger.summary;
	const result: PermissionResult = { behavior: "allow", updatedInput: pause.input };

	// The original tool must never start before the live client knows that the
	// danger reflection was confirmed. Broadcast before the database write and
	// before resolving the permission promise: a busy/locked SQLite write must
	// not delay or suppress the real-time confirmation state.
	try {
		broadcastReflectionFrame(pause, {
			type: "danger_reflection_resolved",
			requestId,
			toolUseId: pause.toolUseId,
			decision: "allow",
			reason,
		});
	} catch (err) {
		logger.warn("Failed to broadcast confirmed danger reflection", {
			requestId,
			narratorId: pause.narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	try {
		rememberDangerConfirmation(pause.narratorId, pause.fingerprint, pause.danger);
		const now = new Date().toISOString();
		await db
			.update(narratorToolCalls)
			.set({
				status: "running",
				permissionDecidedBy: decidedBy,
				permissionDecidedAt: now,
				permissionDecisionReason: reason,
				permissionSuggestions: dangerReflectionSuggestions(pause, "confirmed", reason),
			})
			.where(eq(narratorToolCalls.id, pause.toolCallId));
		if (pause.planModeSoftDeny) {
			await enableRelaxedPlanAfterPlanSoftDeny(pause.narratorId, pause.broadcastTargetId);
		}
		await narratorService.updateStatus(pause.narratorId, "working").catch(() => {});
		await mirrorPermissionStatusToTarget(
			pause.narratorId,
			pause.broadcastTargetId,
			"working",
		).catch(() => {});
	} catch (err) {
		logger.warn("Failed to finalize confirmed danger reflection", {
			requestId,
			narratorId: pause.narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
	} finally {
		await narratorService.updateStatus(pause.narratorId, "working").catch(() => {});
		await mirrorPermissionStatusToTarget(
			pause.narratorId,
			pause.broadcastTargetId,
			"working",
		).catch(() => {});
		pause.resolve(result);
	}
	return true;
}

export async function cancelDangerReflection(
	requestId: string,
	reason?: string,
	decidedBy: DangerReflectionDecidedBy = "reflection",
	options: { failed?: boolean } = {},
): Promise<boolean> {
	const pause = pendingDangerReflections.get(requestId);
	if (!pause) return false;
	if (decidedBy === "reflection" && pause.reflectionStoppedByUser) return false;
	pause.cleanup();
	const message =
		reason?.trim() ||
		(decidedBy === "user"
			? "Danger reflection pause cancelled by user"
			: "Danger reflection pause cancelled by reflection loop");
	// A gate that COULD NOT decide is not a gate that decided "no". Both deny the tool, but
	// only the latter is a judgement about the operation, so they must not share a status:
	// "危险反思已拒绝此操作" on a provider 520 tells the user the operation was judged unsafe
	// when in fact nothing was ever judged.
	const status = options.failed ? "failed" : "cancelled";
	const result: PermissionResult = {
		behavior: "deny",
		message,
	};
	try {
		const now = new Date().toISOString();
		await db
			.update(narratorToolCalls)
			.set({
				status: "fail",
				errorMessage: message,
				permissionDecidedBy: decidedBy,
				permissionDecidedAt: now,
				permissionDecisionReason: message,
				permissionSuggestions: dangerReflectionSuggestions(pause, status, message),
			})
			.where(eq(narratorToolCalls.id, pause.toolCallId));
		broadcastReflectionFrame(pause, {
			type: "danger_reflection_resolved",
			requestId,
			toolUseId: pause.toolUseId,
			decision: "deny",
			reason: message,
			...(options.failed ? { failed: true } : {}),
		});
		await narratorService.updateStatus(pause.narratorId, "working").catch(() => {});
		await mirrorPermissionStatusToTarget(
			pause.narratorId,
			pause.broadcastTargetId,
			"working",
		).catch(() => {});
	} catch (err) {
		logger.warn("Failed to finalize cancelled danger reflection", {
			requestId,
			narratorId: pause.narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
	} finally {
		await narratorService.updateStatus(pause.narratorId, "working").catch(() => {});
		await mirrorPermissionStatusToTarget(
			pause.narratorId,
			pause.broadcastTargetId,
			"working",
		).catch(() => {});
		pause.resolve(result);
	}
	return true;
}

/**
 * Re-run pending permission requests for a narrator and its subagents under the
 * current permission policy. This is intentionally not a blind approval: when a
 * user switches to bypassPermissions, the normal permission pipeline still runs
 * so blacklists, fatal checks, and danger reflection can intercept risky tools.
 */
async function restoreReprocessedPermissionStatus(pending: {
	narratorId: string;
	broadcastTargetId: string;
}): Promise<void> {
	await narratorService.updateStatus(pending.narratorId, "working").catch(() => {});
	await mirrorPermissionStatusToTarget(
		pending.narratorId,
		pending.broadcastTargetId,
		"working",
	).catch(() => {});
}

/**
 * Reject a reprocess that cannot safely recover its frozen execution target.
 * In particular, an offline remote device must never turn into a local plan-file
 * read just because the permission mode changed while the request was pending.
 */
function pendingPermissionInputForReprocess(pending: PendingPermission): Record<string, unknown> {
	if (pending.toolName !== "ExitPlanMode" || pending.planSource?.kind !== "file") {
		return pending.input;
	}
	// File resolution strips plan_file_path before showing/persisting the approval
	// payload. Restore the normalized provenance only for reprocessing so the same
	// designated/custom path and frozen execution target are used again.
	return { ...pending.input, plan_file_path: pending.planSource.path };
}

async function failReprocessedPendingPermission(
	requestId: string,
	pending: PendingPermission,
	error: unknown,
): Promise<void> {
	const detail = error instanceof Error ? error.message : String(error);
	const message = `Permission reprocessing failed: ${detail}`;
	pending.cleanup();
	try {
		await db
			.update(narratorToolCalls)
			.set({
				status: "fail",
				errorMessage: message,
				permissionDecidedBy: "auto",
				permissionDecidedAt: new Date().toISOString(),
				permissionDecisionReason: message,
				permissionDenyMessage: message,
			})
			.where(eq(narratorToolCalls.id, requestId));
	} catch (dbError) {
		logger.error("Failed to persist frozen-target reprocessing failure", {
			requestId,
			narratorId: pending.narratorId,
			error: dbError instanceof Error ? dbError.message : String(dbError),
		});
	}
	broadcastToNarrator(pending.broadcastTargetId, {
		type: "permission_resolved",
		narratorId: pending.broadcastTargetId,
		requestId,
		toolUseId: pending.toolUseId,
		decision: "deny",
		feedbackText: message,
		...pendingPermissionRoutingIdentity(pending),
	});
	await restoreReprocessedPermissionStatus(pending);
	pending.resolve({ behavior: "deny", message });
}

export function reprocessAllPendingPermissions(narratorId: string): number {
	const toReprocess = [...pendingPermissions.entries()].filter(
		([, pending]) => pending.narratorId === narratorId || pending.broadcastTargetId === narratorId,
	);

	for (const [requestId, pending] of toReprocess) {
		let executionBackend: ExecutionBackend | undefined;
		if (pending.executionTarget) {
			try {
				executionBackend = resolvePendingExecutionBackend(pending.executionTarget);
			} catch (err) {
				void failReprocessedPendingPermission(requestId, pending, err).catch((failureError) => {
					logger.error("Failed to reject unsafe pending permission reprocessing", {
						requestId,
						narratorId: pending.narratorId,
						error: failureError instanceof Error ? failureError.message : String(failureError),
					});
				});
				continue;
			}
		}

		pending.cleanup();
		broadcastToNarrator(pending.broadcastTargetId, {
			type: "permission_resolved",
			narratorId: pending.broadcastTargetId,
			requestId,
			toolUseId: pending.toolUseId,
			...pendingPermissionRoutingIdentity(pending),
		});

		const reprocessOptions: PermissionHandlerOptions = { suppressAttention: true };
		if (pending.executionTarget) {
			// The backend is live but intentionally not stored in pending state; the
			// target snapshot is passed back so ExitPlanMode resolves on the same device.
			reprocessOptions.executionBackend = executionBackend;
			reprocessOptions.executionTarget = { ...pending.executionTarget };
		}

		void handlePermission(
			pending.narratorId,
			pending.signal,
			pending.toolName,
			pendingPermissionInputForReprocess(pending),
			pending.toolUseId,
			pending.cwd,
			pending.locale,
			pending.broadcastTargetId,
			// Re-evaluating an already-pending request (e.g. on switch to
			// bypassPermissions). The user was already notified when it first became
			// pending, so suppress a duplicate attention notification.
			reprocessOptions,
			pending.parentToolUseId,
		)
			.then(async (result) => {
				if (result.behavior !== "dangerReflection") {
					await restoreReprocessedPermissionStatus(pending);
				}
				pending.resolve(result);
			})
			.catch(async (err) => {
				const message = err instanceof Error ? err.message : String(err);
				logger.error("Failed to reprocess pending permission", {
					narratorId: pending.narratorId,
					requestId,
					toolName: pending.toolName,
					error: message,
				});
				await restoreReprocessedPermissionStatus(pending);
				pending.resolve({
					behavior: "deny",
					message: `Permission reprocessing failed: ${message}`,
				});
			});
	}

	return toReprocess.length;
}

registerExecutionPolicyPendingReprocessor(reprocessAllPendingPermissions);
