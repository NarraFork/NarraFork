import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { isParentSelector } from "@shared/communication-tool";
import type { ProgressSnapshot } from "@shared/progress-phase";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
	integrationAuthorities,
	integrationCapabilityGrants,
	integrationResourceBindings,
	narratorMessages,
	narrators,
	narratorToolCalls,
	oauthClients,
	remoteDevices,
} from "../db/schema";
import type {
	DangerInfo,
	DangerSeverity,
	PermissionHandlerOptions,
	PermissionResult,
} from "../lib/agent";
import {
	analyzeShellCommand,
	type BashAnalysis,
	classifyFind,
	isReviewReadOnlyBashAnalysis,
} from "../lib/agent/bash-analyze";
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
import {
	getPermissionRecovery,
	isRecoveredHumanPermission,
	recoveryReflection,
} from "../lib/agent/recovery-gate";
import { detectShell } from "../lib/agent/shell";
import { isModelPlanReference } from "../lib/agent/strip-plan-body";
import { isBashToolName } from "../lib/agent/tool-name";
import { toolRegistry } from "../lib/agent/tool-registry";
import { isAsyncAskRequest, isWithdrawOnlyAskRequest } from "../lib/agent/tools/ask-user-question";
import { SHELL_TOOL_NAME } from "../lib/agent/tools/bash";
import {
	isKnowledgeReadAction,
	KNOWLEDGE_MERGE_ACTION_SET,
} from "../lib/agent/tools/knowledge-actions";
import {
	EXIT_PLAN_MODE_FILE,
	EXIT_PLAN_MODE_INLINE,
	readDeclaredExitPlanMode,
} from "../lib/agent/tools/plan-mode";
import { isScheduledTaskReadAction } from "../lib/agent/tools/scheduled-task-actions";
import { OUTPUT_DIR as TRUNCATE_OUTPUT_DIR } from "../lib/agent/truncate";
import type {
	ToolCallBinding,
	ToolExecutionOperation,
	ToolExecutionPlan,
	ToolExecutionTarget,
} from "../lib/agent/types";
import {
	type DangerReflectionLevel,
	normalizeDangerReflectionLevel,
	resolveDangerReflectionLevel,
} from "../lib/boolean-override";
import {
	measureSerializedCharacters,
	queueContextCharacterRefresh,
} from "../lib/context-characters";
import { AppError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { isPlanModeTrait, isSubagentVariant } from "../lib/narrator-utils";
import {
	type DeviceAccessPolicy,
	intersectOAuthClientPolicies,
	oauthClientPolicySchema,
} from "../lib/oauth-client-policy";
import { resolveEffectiveRelaxedPlan } from "../lib/permission-modes";
import {
	buildLegacyPlanFileRelPath,
	buildPlanFileRelPath,
	isInsidePlansDir,
	isSafePlanFileIdForPath,
	PLAN_DIR_REL,
} from "../lib/plan-file-path";
import { isInsidePath, normalizePathForOS, pathsEqual, resolvePath } from "../lib/platform-path";
import { getToolMessage, getToolMessageWithParams, type Locale } from "../lib/prompt-i18n";
import { narraforkDir, settings } from "../lib/settings";
import { assertToolSpecPaths, toolSpecPathError } from "../lib/spec-uri";
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
import {
	executionPolicyEngine,
	executionPolicyRevision,
	type ResolvedExecutionPolicy,
} from "./execution-policy/engine";
import { registerExecutionPolicyPendingReprocessor } from "./execution-policy/events";
import { normalizeExecutionPolicyRuleSet } from "./execution-policy/normalize";
import { resolveCanonicalPaths } from "./execution-policy/path-probes";
import { executionPolicyRepository } from "./execution-policy/repository";
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
import { notifyHumanAttentionChanged } from "./human-attention-events";
import { integrationResourceBindingService } from "./integration-resource-binding-service";
import { narratorPersistence, reconstructToolExecutionTargets } from "./narrator-persistence";
import { isTrustedReviewBoundary } from "./narrator-review-boundary";
import { narratorService } from "./narrator-service";
import {
	activeNarrators,
	activeSubagentSettings,
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
	pendingPlanApproverSource,
	pendingPlanCompact,
	pendingPlanDiff,
	planModeAskedOnce,
} from "./narrator-session-state";
import {
	completePermissionRuleRequestReflection as completeRuleReflection,
	failPermissionRuleRequest,
	PERMISSION_RULE_REQUEST_TTL_MS,
	type PermissionRuleReflectionCompletion,
	preparePermissionRuleRequest,
	recordPermissionRuleRequestDecision,
	terminatePermissionRuleRequest,
	validatePermissionRuleRequestApproval,
} from "./permission-rule-request-service";
import { broadcastReflectionFrame } from "./reflection-broadcast";
import { SPEC_TASKS_PATH } from "./spec-task-service";
import { specVfsService } from "./spec-vfs-service";

// An exact tool-call attempt owns this receipt. Never use the generic danger cache.
const permissionRuleRequestPauses = new Map<
	string,
	{ requestId: string; automatic: boolean; settling: boolean }
>();

import { resolveTaskAlias, subagentMatchesSelector } from "./subagent-alias";

// Preserve the original execution receipt and ACL ceiling while the SAME prompt is reprocessed.
const pendingPermissionContexts = new WeakMap<
	PendingPermission,
	{
		options?: PermissionHandlerOptions;
		runtimeConstraint?: RuntimePermissionConstraint;
		reviewReadOnlyBash: boolean;
	}
>();

// === Permission handling ===

async function refreshPermissionContextCharacters(
	narratorId: string,
	toolCallId: string,
): Promise<void> {
	const row = await db.query.narratorToolCalls
		.findFirst({ where: eq(narratorToolCalls.id, toolCallId), columns: { messageId: true } })
		.catch((error: unknown) => {
			logger.warn("Character refresh message identity unavailable", {
				toolCallId,
				error: String(error),
			});
			return undefined;
		});
	queueContextCharacterRefresh(narratorId, row?.messageId);
}

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
		case "StructSed":
		case "StructView":
			return typeof input.file_path === "string" ? [input.file_path] : [];
		case "CreateWorktree":
		case "AttachWorktree":
			return typeof input.destinationPath === "string" ? [input.destinationPath] : [];
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
	// toolRegistry.get resolves legacy aliases, so a stale "Shell" name still
	// finds the Bash definition and stays routed (i.e. still requires a frozen
	// execution target). Special-casing the alias here is no longer needed.
	return !!toolRegistry.get(toolName)?.executionRouting;
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
	if (isBashToolName(toolName)) {
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

	if (isBashToolName(toolName)) {
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

/**
 * Relative plan-file paths a plan-mode Write/Edit may target, most-preferred first.
 *
 * Normally a single path. It becomes two only while a cycle started before the move
 * to `.narrafork/plans/` is still open: the caller's resolved path (which may be the
 * legacy one) plus the canonical path, so a resumed cycle can keep writing where its
 * plan already is without locking new cycles out of the new location.
 *
 * TODO(migration): collapse to the single resolved path once no pre-move plan cycle
 * remains open.
 */
function planFileWriteCandidates(
	planFileId: string | undefined,
	designatedPlanFilePath: string | undefined,
): string[] {
	const candidates: string[] = [];
	const designated = designatedPlanFilePath?.trim();
	if (designated) candidates.push(designated);
	if (isSafePlanFileIdForPath(planFileId)) {
		for (const path of [buildPlanFileRelPath(planFileId), buildLegacyPlanFileRelPath(planFileId)]) {
			if (!candidates.includes(path)) candidates.push(path);
		}
	}
	return candidates;
}

// These are path-only shell mutations with no opaque interpreter/config hooks.
// Unknown commands cannot prove they leave the protected tree alone, even after cd.
const REVIEW_PATH_WRITE_COMMANDS = new Set([
	"touch",
	"mkdir",
	"rmdir",
	"cp",
	"mv",
	"rm",
	"install",
	"truncate",
]);

/** Literal path-only shell footprint. This is a guard, not an OS sandbox for arbitrary scripts. */
function reviewShellWriteFootprint(
	analysis: BashAnalysis,
	cwd: string,
	boundaryRoots: readonly string[],
	context?: ExecutionTargetContext | null,
): Array<{ path: string; subtree: boolean }> | null {
	const paths = decisionPaths(context);
	const result: Array<{ path: string; subtree: boolean }> = [];
	// Do not turn this permission check into an unbounded synchronous host filesystem scan.
	if (analysis.commands.length > 64) return null;
	let remainingProbes = 128;
	const startedAt = performance.now();
	const literal = (token: string): string | null => {
		const value = /^(?:'[^']*'|"[^"]*")$/.test(token) ? token.slice(1, -1) : token;
		// Expansions/globs, escapes and mixed quotation cannot prove their actual footprint.
		return value && !/[\s"'\\$`*?{}]/.test(value.replaceAll(" ", "")) ? value : null;
	};
	for (const command of analysis.commands) {
		const [name, ...args] = command.tokens;
		if (!REVIEW_PATH_WRITE_COMMANDS.has(name) || command.fullText !== command.text) return null;
		if (args.length > 256) return null;
		const operands: string[] = [];
		let targetDirectory: string | undefined;
		let noTargetDirectory = false;
		let recursive = false;
		let endOptions = false;
		for (let index = 0; index < args.length; index++) {
			const arg = args[index];
			if (!endOptions && arg === "--") {
				endOptions = true;
				continue;
			}
			if (!endOptions && arg.startsWith("-")) {
				if (arg === "--parents" && name !== "mkdir") return null;
				if ((name === "mv" || name === "cp") && (arg === "-t" || arg === "--target-directory")) {
					const value = literal(args[++index] ?? "");
					if (!value) return null;
					targetDirectory = value;
					continue;
				}
				if ((name === "mv" || name === "cp") && arg.startsWith("--target-directory=")) {
					const value = literal(arg.slice("--target-directory=".length));
					if (!value) return null;
					targetDirectory = value;
					continue;
				}
				if (arg === "-T" || arg === "--no-target-directory") noTargetDirectory = true;
				if (arg === "--recursive" || arg === "--archive" || /^-[^-]*[rRa]/.test(arg))
					recursive = true;
				// Only known valueless flags; flags with hidden path operands fail closed.
				if (
					!/^-[frRaipnvPTdHLsuv]+$/.test(arg) &&
					![
						"--recursive",
						"--archive",
						"--force",
						"--no-clobber",
						"--verbose",
						"--parents",
						"--no-target-directory",
						"--remove-destination",
						"--preserve=all",
					].includes(arg)
				)
					return null;
				continue;
			}
			const value = literal(arg);
			if (!value) return null;
			operands.push(value);
		}
		if (operands.length === 0) return null;
		const canonical = (value: string) => {
			if (--remainingProbes < 0 || performance.now() - startedAt > 100)
				throw new Error("Review write footprint identity budget exceeded");
			return canonicalHostPath(paths.resolve(decisionCwd(cwd, context), value));
		};
		if (name === "mv" || name === "cp") {
			if (noTargetDirectory && (targetDirectory || operands.length !== 2)) return null;
			const destination = targetDirectory ?? operands.pop();
			if (!destination || operands.length === 0) return null;
			const dest = canonical(destination);
			let intoDirectory =
				!!targetDirectory ||
				(!noTargetDirectory &&
					boundaryRoots.some((root) => paths.contains(dest, root) && !paths.equals(dest, root)));
			if (!noTargetDirectory && !intoDirectory) {
				try {
					intoDirectory = statSync(dest).isDirectory();
				} catch {
					/* absent destination */
				}
			}
			for (const source of operands) {
				const from = canonical(source);
				if (name === "mv") result.push({ path: from, subtree: true });
				// Copy reads its source. Its target (and mv's) may overwrite a protected subtree.
				// cp source/. copies CONTENTS, not a child named basename(source).
				// Resolving first would erase that syntax and miss an ancestor destination.
				const copiesContents = name === "cp" && /(?:^|\/)\.{1,2}(?:\/)*$/.test(source);
				const actualTarget =
					intoDirectory && !copiesContents
						? paths.resolve(dest, basename(paths.resolve(decisionCwd(cwd, context), source)))
						: dest;
				// Explicit operands are not the whole write footprint. A derived directory/file
				// target may itself be a symlink into the review tree. Resolve it AFTER joining;
				// cp -P controls source dereferencing, not existing destination-file symlinks.
				result.push({ path: canonical(actualTarget), subtree: name === "mv" || recursive });
			}
		} else {
			for (const operand of operands)
				result.push({
					path: canonical(operand),
					subtree: name === "rm" || name === "rmdir",
				});
		}
	}
	return result;
}

function resolveReviewBoundaryDeny(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	policy: CompiledExecutionPolicy,
	analysis?: BashAnalysis,
	context?: ExecutionTargetContext | null,
): string | null {
	// Scope follows the actual frozen executor, never just a matching path string.
	const execution = context ?? policy.targetContext;
	if (
		execution &&
		(execution.backend.kind !== "local" ||
			execution.target.deviceId !== LOCAL_DEVICE_ID ||
			execution.paths.flavor === "spec")
	)
		return null;
	const boundaries = policy.directoryBlacklist.filter(isTrustedReviewBoundary);
	if (
		boundaries.length === 0 ||
		isReadOnlyCall(toolName, input) ||
		isTaskStateMaintenanceTool(toolName, input)
	)
		return null;
	const paths = decisionPaths(context);
	if (isBashToolName(toolName)) {
		if (
			typeof input.command !== "string" ||
			input.run_in_background === true ||
			typeof input.stop === "string" ||
			input.await != null
		) {
			return "Inherited review boundary requires synchronous, verifiable shell operations";
		}
		if (analysis?.allReadOnly) return null;
		if (
			!analysis?.hasWriteOperation ||
			analysis.filePaths.length === 0 ||
			analysis.hasEnvInjection ||
			analysis.commandEnvVars.length > 0 ||
			analysis.dangerousPatterns.length > 0 ||
			analysis.commands.some((command) => !REVIEW_PATH_WRITE_COMMANDS.has(command.tokens[0]))
		) {
			return "Inherited review boundary denies shell operations with unproven write scope";
		}
		try {
			const footprint = reviewShellWriteFootprint(
				analysis,
				cwd,
				boundaries.map((rule) => rule.path),
				execution,
			);
			if (!footprint)
				return "Inherited review boundary denies shell operations with unproven write scope";
			return footprint.some(({ path, subtree }) =>
				boundaries.some(
					(rule) => paths.contains(rule.path, path) || (subtree && paths.contains(path, rule.path)),
				),
			)
				? "Inherited review workspace is read-only"
				: null;
		} catch {
			return "Inherited review boundary cannot verify shell path identity";
		}
	}
	if (toolName === "Agent" && (input.subagent_type === "explore" || input.subagent_type === "plan"))
		return null;
	if (
		toolName === "Browser" &&
		(input.action !== "screenshot" || typeof input.file_path !== "string")
	)
		return null;
	if (!WRITE_TOOLS.has(toolName) && toolName !== "Browser" && toolName !== "Agent") return null;
	const targets =
		toolName === "Agent" && typeof input.workdir === "string" && input.workdir
			? [resolveDecisionPath(cwd, input.workdir, context)]
			: getToolPolicyPaths(toolName, input, cwd, analysis, context);
	try {
		return targets.some((path) =>
			boundaries.some((rule) => {
				const canonical = canonicalHostPath(path);
				return (
					paths.contains(rule.path, canonical) ||
					(toolName === "Agent" && paths.contains(canonical, rule.path))
				);
			}),
		)
			? "Inherited review workspace is read-only"
			: null;
	} catch {
		return "Inherited review boundary cannot verify write path identity";
	}
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
		planFilePath: designatedPlanFilePath,
		relaxedPlan = false,
		planMode = false,
		meta,
		projectGitPath,
		executionBackend,
		executionTarget,
		executionContext,
		reviewReadOnlyBash = false,
	} = opts;
	const specError = toolSpecPathError(toolName, input);
	if (specError) {
		if (meta) meta.blacklistReason = specError;
		return "deny";
	}
	if (toolName === "Worktree") {
		if (input.action !== "list" && input.action !== "create") {
			if (meta)
				meta.blacklistReason = 'Invalid Worktree parameters: action must be "list" or "create".';
			return "deny";
		}
		if (reviewReadOnlyBash && input.action !== "list") {
			if (meta) meta.blacklistReason = "Review mode: Worktree only supports the list action.";
			return "deny";
		}
	}
	if (reviewReadOnlyBash && (toolName === "CreateWorktree" || toolName === "AttachWorktree")) {
		if (meta) meta.blacklistReason = `Review mode: ${toolName} modifies worktree resources.`;
		return "deny";
	}
	const compiledPolicy = compiledPolicyForDecision(opts);
	const context = executionContext ?? compiledPolicy.targetContext;
	const effectiveMode = planMode ? (relaxedPlan ? (permMode ?? "default") : "readOnly") : permMode;
	if (isBashToolName(toolName) && bashAnalysis?.isCatastrophic) return "fatal";

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
	const reviewBoundaryReason = resolveReviewBoundaryDeny(
		toolName,
		input,
		cwd,
		compiledPolicy,
		bashAnalysis,
		context,
	);
	if (reviewBoundaryReason) {
		if (meta) meta.blacklistReason = reviewBoundaryReason;
		return "deny";
	}

	// Task queue maintenance is session metadata, not a project/worktree write. Keep it
	// available in read-only/exploration flows just like the legacy TaskCreate/TodoWrite path.
	if (isTaskStateMaintenanceTool(toolName, input)) return "allow";

	const planFileCandidates = planFileWriteCandidates(planFileId, designatedPlanFilePath);
	if (planMode && (toolName === "Write" || toolName === "Edit")) {
		if (planFileCandidates.length > 0) {
			const filePath = typeof input.file_path === "string" ? input.file_path : "";
			const absPath =
				(context && executionTargetPolicyPath(context)) ??
				resolveDecisionPath(cwd, filePath, context);
			const paths = decisionPaths(context);
			for (const candidate of planFileCandidates) {
				const planFilePath = resolveDecisionPath(cwd, candidate, context);
				if (paths.equals(absPath, planFilePath)) return "allow";
			}
		}
		if (!relaxedPlan) {
			if (meta) {
				const planFile = planFileCandidates[0] ?? "(unknown)";
				meta.blacklistReason =
					`Plan mode: Write/Edit is only allowed to the plan file "${planFile}". ` +
					`Write your plan to that file, then call ExitPlanMode. ` +
					`Only after the user approves your plan can you implement changes.`;
				meta.planModeSoftDeny = true;
			}
			return "deny";
		}
	}

	// An ASYNCHRONOUS AskUserQuestion is not a request for approval — it is the agent
	// filing a question and carrying on. Prompting for it would recreate exactly the
	// blocking this mode exists to avoid, so it is allowed in every permission mode
	// (including dontAsk: nothing is executed on the user's behalf, a row is written).
	//
	// `!input.answers` is load-bearing: after the user answers, the answers are merged
	// into the input and the call runs again. That replay must keep the ordinary
	// semantics, and treating it as a fresh async submission would file a duplicate.
	// A withdraw-only call is the same kind of bookkeeping and needs no prompt either.
	if (toolName === "AskUserQuestion" && !input.answers) {
		if (isAsyncAskRequest(input) || isWithdrawOnlyAskRequest(input)) return "allow";
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
	if (isBashToolName(toolName) && bashAnalysis) {
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

	// Review follow-up Bash is a hard, non-interactive capability ceiling. Keep this
	// after command/path blacklists, but before command whitelists, bypassPermissions,
	// and ordinary Bash read-only shortcuts.
	if (reviewReadOnlyBash && isBashToolName(toolName)) {
		const isControlOperation =
			typeof input.command !== "string" ||
			input.run_in_background === true ||
			typeof input.stop === "string" ||
			input.await != null;
		const deviceId = executionContext?.target.deviceId ?? executionTarget?.deviceId;
		const externalPaths = getShellScopePaths(cwd, input, bashAnalysis, context).filter(
			(path) =>
				!isInsideDecisionWorktree(cwd, path, context) &&
				!isInsideDecisionTruncateDir(cwd, path, context),
		);
		if (
			isControlOperation ||
			(deviceId !== undefined && deviceId !== LOCAL_DEVICE_ID) ||
			externalPaths.length > 0 ||
			!bashAnalysis ||
			!isReviewReadOnlyBashAnalysis(bashAnalysis)
		) {
			return "deny";
		}
		return "allow";
	}

	const chapterGitIssues = isChapter ? getChapterGitPermissionIssues(bashAnalysis) : [];
	if (isBashToolName(toolName) && chapterGitIssues.length > 0) {
		return resolveChapterGitIssueDecision(effectiveMode);
	}

	// A tool allowlist must not turn a read-only/strict-plan session into an
	// external notification sender. Unknown actions are conservatively mutating.
	if (
		toolName === "Notification" &&
		input.action !== "list_channels" &&
		effectiveMode === "readOnly"
	) {
		return "deny";
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
		isBashToolName(toolName) &&
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
		isBashToolName(toolName) &&
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

	// ScheduledTask: per-ACTION, because the same tool both reads the schedule and
	// hands out recurring unattended execution. Inspecting tasks is as harmless as any
	// other read; creating or editing one installs a prompt that keeps launching
	// narrators (usually under bypassPermissions) long after this session ends, and
	// run_now dispatches such a launch immediately.
	//
	// Deliberately ABOVE the bypassPermissions/dontAsk shortcuts, which is the whole
	// point: bypass is exactly the mode an unattended or power-user session runs in, so
	// below them a mutation would be auto-allowed and the classification would never
	// run. An unclassified action is treated as mutating so a future action stays gated
	// until it is listed as a read.
	if (toolName === "ScheduledTask") {
		if (isScheduledTaskReadAction(input.action)) return "allow";
		if (effectiveMode === "readOnly" || effectiveMode === "dontAsk") return "deny";
		return "ask";
	}

	// Notification only exposes non-secret channel metadata for reads. Sending
	// is an external side effect: use ordinary approval/allowlist/bypass semantics.
	if (toolName === "Notification") {
		if (input.action === "list_channels") return "allow";
		if (input.action === "send" && opts.notificationPolicy?.allowSend === true) return "allow";
		if (effectiveMode === "bypassPermissions") return "allow";
		if (effectiveMode === "dontAsk") return "deny";
		return "ask";
	}

	if (effectiveMode === "bypassPermissions") return "allow";
	if (effectiveMode === "dontAsk") return "deny";

	// Recall: self-scoped reads are always safe (read-only on own conversation).
	// Cross-narrator reads (all_narrators) require approval outside bypass mode.
	if (toolName === "Recall") {
		if (input.all_narrators !== true) return "allow";
		return "ask";
	}

	// readOnly mode
	if (effectiveMode === "readOnly") {
		if (isReadOnlyCall(toolName, input)) {
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
		if (isBashToolName(toolName)) {
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
	if (isBashToolName(toolName)) {
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
			return isReadOnlyCall(toolName, input) ? "allow" : "ask";
		}
		if (effectiveMode === "acceptEdits" && ACCEPT_EDITS_AUTO_ALLOW.includes(toolName))
			return "allow";
	}

	if (
		hasExternalPath &&
		isReadOnlyCall(toolName, input) &&
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
	// The hard review fence is additive: never exempt a denyAll rule or a user/imported
	// prefix. Only trusted denyWrite rows are irrelevant to non-filesystem metadata.
	const metadataOnly =
		!isBashToolName(toolName) &&
		!WRITE_TOOLS.has(toolName) &&
		toolName !== "Agent" &&
		toolName !== "Browser" &&
		!isReadOnlyCall(toolName, input);
	const editableBlacklist = compiledPolicy.directoryBlacklist.filter(
		(rule) => !(metadataOnly && rule.denyLevel === "denyWrite" && isTrustedReviewBoundary(rule)),
	);
	if (editableBlacklist.length === 0) return null;
	const genericPolicy =
		editableBlacklist.length === compiledPolicy.directoryBlacklist.length
			? compiledPolicy
			: compileExecutionPolicy(
					{ ...compiledPolicy, directoryBlacklist: editableBlacklist },
					context ?? compiledPolicy.targetContext,
				);

	const operation =
		toolName === "Agent"
			? input.subagent_type === "explore" || input.subagent_type === "plan"
				? "read"
				: "full"
			: isBashToolName(toolName)
				? bashAnalysis?.hasWriteOperation
					? "write"
					: "read"
				: isReadOnlyCall(toolName, input)
					? "read"
					: "write";
	const paths =
		toolName === "Agent" && typeof input.workdir === "string" && input.workdir
			? [resolveDecisionPath(cwd, input.workdir, context)]
			: getToolPolicyPaths(toolName, input, cwd, bashAnalysis, context);
	for (const path of paths) {
		const result = genericPolicy.evaluatePath({ path, operation });
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
	"Question",
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

const ACCEPT_EDITS_AUTO_ALLOW = [
	"Edit",
	"Write",
	"NotebookEdit",
	"Read",
	"Glob",
	"Grep",
	"StructView",
];

/** Tools that don't modify the project worktree — safe to auto-allow in readOnly mode. */
const READ_ONLY_TOOLS = [
	"ListWorktrees",
	"GetWorktreeOperation",
	"Read",
	"Grep",
	"Glob",
	"StructView",
	"ShareFile",
	"ContextAsk",
	"Await",
	"KnowledgeSearch",
	"KnowledgeRead",
	"KnowledgeLibrary",
];

/**
 * Whether THIS CALL only reads, which is not always decidable from the tool name.
 *
 * StructSed with `dry_run` resolves the address and renders a diff without writing a byte,
 * so a preview is a read. Its default is `dry_run: true`, so the most common call shape was
 * the one being sent for approval.
 *
 * The flag is trustworthy here: execution reads `args.dry_run !== false` from the same input
 * this sees (`effectiveInput = permission.updatedInput ?? tu.input`), and `updatedInput` only
 * ever carries AskUserQuestion answers, an ExitPlanMode plan, or an async deferral — it never
 * rewrites `dry_run`.
 *
 * `!== false` mirrors the tool's own check verbatim. Writing `=== true` here would classify an
 * omitted `dry_run` as a write; the two predicates disagreeing about one call is the dangerous
 * direction, so they must stay identical.
 *
 * Per-call classification is the established shape in this file, not a new idea: the blacklist
 * decision below already splits `Agent` by `subagent_type` and Bash by its parsed command.
 */
function isReadOnlyCall(toolName: string, input: Record<string, unknown>): boolean {
	if (READ_ONLY_TOOLS.includes(toolName)) return true;
	if (toolName === "Notification") return input.action === "list_channels";
	if (toolName === "Worktree") return input.action === "list";
	return toolName === "StructSed" && input.dry_run !== false;
}

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
	/**
	 * Resolved relative path of the designated plan file. Supplied by the caller
	 * rather than rebuilt from `planFileId` because an in-flight cycle may still be
	 * anchored to the pre-`plans/` layout; the gate must accept the same file the
	 * model was told to write.
	 */
	planFilePath?: string;
	planMode?: boolean;
	/** Hard Bash policy for review follow-up subagents. */
	reviewReadOnlyBash?: boolean;
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
	notificationPolicy?: { allowSend?: boolean };
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

/**
 * Tools whose extracted path input is a write target (including worktree destinations).
 *
 * Membership is SECURITY-RELEVANT in two places, and in both an omission fails open:
 * the `.git` write ban below, and the OAuth read-only device policy. A file-modifying
 * tool missing from this set gets neither check and is silently allowed through.
 */
const WRITE_TOOLS = new Set([
	"Write",
	"Edit",
	"NotebookEdit",
	"StructSed",
	"CreateWorktree",
	"AttachWorktree",
]);
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

/** Resolve existing symlinks, including a symlinked parent of a not-yet-created file. */
function canonicalHostPath(path: string): string {
	const suffix: string[] = [];
	let current = resolve(path);
	for (let depth = 0; depth < 128; depth++) {
		try {
			return resolve(realpathSync(current), ...suffix);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!("code" in error) ||
				(error.code !== "ENOENT" && error.code !== "ENOTDIR")
			)
				throw error;
			const parent = dirname(current);
			if (parent === current) throw error;
			suffix.unshift(basename(current));
			current = parent;
		}
	}
	throw new Error("Host path identity budget exceeded");
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
		const filePath = extractToolPaths(toolName, input)[0] ?? "";
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
		// Only the host configuration is trusted to enable security switches. Reads and
		// trusted settings APIs remain available; another device's same path is unrelated.
		const hostTarget =
			(backend?.kind ?? "local") === "local" &&
			(executionContext?.target.deviceId ?? executionTarget?.deviceId ?? LOCAL_DEVICE_ID) ===
				LOCAL_DEVICE_ID &&
			targetPaths.flavor !== "spec";
		if (hostTarget && !isReadOnlyCall(toolName, input)) {
			try {
				const configuration = resolve(narraforkDir, "settings.json");
				const lexical = targetPaths.resolve(targetCwd, filePath);
				const protectedPaths = [configuration, canonicalHostPath(configuration)];
				if (
					[lexical, absPath, canonicalHostPath(lexical)].some((candidate) =>
						protectedPaths.some((protectedPath) => targetPaths.equals(candidate, protectedPath)),
					)
				)
					return "Agent file writes to the host security settings file are forbidden; use the trusted settings API";
			} catch {
				return "Cannot verify host security settings path identity";
			}
		}
		return null;
	}

	if (isBashToolName(toolName) && bashAnalysis) {
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
	if (isBashToolName(toolName)) {
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
	if (isBashToolName(toolName)) {
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
	notifyHumanAttentionChanged();

	try {
		await markQuestionReflectionStatus(
			requestId,
			pending,
			"running",
			"Question reflection is answering AskUserQuestion",
		);
		const narrator = await narratorService.getById(pending.narratorId).catch(() => null);
		const answers = await generateAskUserQuestionAnswers(pending.narratorId, questions, {
			locale: pending.locale,
			model: narrator?.model,
			actingUserId: activeNarrators.get(pending.narratorId)?._currentUserId ?? null,
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
			notifyHumanAttentionChanged();
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
		notifyHumanAttentionChanged();
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
	try {
		await markQuestionReflectionStatus(requestId, pending, "awaiting_user", message);
	} finally {
		notifyHumanAttentionChanged();
	}
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
		if (name === "find") {
			// Reuse the shared classifier instead of deriving danger from the mere presence of
			// `-exec`: `find … -exec cat {} \;` only reads, and reporting that as "high" made
			// read-only inspection reflect even on the light reflection level.
			const findClass = classifyFind(cmd.tokens);
			if (findClass.kind !== "safe" && !isCommandWhitelisted(cmd, commandWhitelist)) {
				if (findClass.kind === "unknown") {
					return danger(
						"Find runs a command NarraFork could not classify.",
						[
							"The executed command's side effects are unknown, and find applies it to every match.",
							"In Bypass All mode this would otherwise execute without user approval.",
						],
						[
							"Run the same find command without -exec first to see what it would match.",
							"Invoke the command directly on explicit paths instead.",
						],
						[`Command: ${cmd.text}`, `Pattern: ${findClass.pattern}`],
						"medium",
					);
				}
				return danger(
					findClass.kind === "dangerous"
						? "Find is being used to delete files or run a destructive command."
						: "Find applies a state-changing command to every match.",
					[
						"It can affect many matching files at once, including files the agent did not inspect.",
						// -exec/-fprintf target paths live inside the expression, so they never reach
						// `filePaths` and the worktree boundary check cannot see them.
						"Paths written through the find expression are not covered by the worktree boundary check.",
					],
					[
						"Run the same find command without -delete/-exec first.",
						"Apply changes to explicit paths.",
					],
					[`Command: ${cmd.text}`, `Pattern: ${findClass.pattern}`],
					"high",
				);
			}
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
		// Scratch writes confined to system temp directories keep their visibility but
		// drop from "high" to "medium": the light reflection level only pauses on high,
		// so `… > /tmp/x` no longer triggers a full reflection round there, while
		// standard/strict (threshold medium and below) still do.
		const tempDowngrade =
			bashAnalysis.hasWriteOperation && allExternalPathsAreSystemTemp(externalPaths);
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
			tempDowngrade ? "medium" : bashAnalysis.hasWriteOperation ? "high" : "low",
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
	if (isBashToolName(toolName))
		return classifyShellDanger(
			input,
			cwd,
			bashAnalysis,
			policy,
			skipReadOnlyConfirmations,
			executionContext,
		);

	if (toolName === "SwitchWorkingDirectory") {
		const target = input.target as { deviceId?: unknown; cwd?: unknown } | undefined;
		return danger(
			"SwitchWorkingDirectory changes the narrator's execution workspace.",
			[
				"Subsequent tools use a different working directory, skills and permission context.",
				"Existing background tools, subagents and terminals remain on their original targets.",
			],
			[
				"Verify the target device and directory match the user's requested workspace.",
				"Keep the current workspace if switching is not necessary for this task.",
			],
			[
				`Current working directory: ${cwd}`,
				`Requested device: ${String(target?.deviceId ?? "unknown")}`,
				`Requested working directory: ${String(target?.cwd ?? "unknown")}`,
			],
			"high",
		);
	}

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

	// KnowledgeEdit: publish and direct global writes are high; personal edits/metadata are
	// medium; read actions (e.g. my_submissions) are not dangerous at all.
	if (toolName === "KnowledgeEdit") {
		const action = typeof input.action === "string" ? input.action : "";
		if (!action || isKnowledgeReadAction(action)) return null;
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

	// A dry run reads, so it earns no write-risk notice: warning about out-of-worktree writes
	// for a preview that writes nothing is noise that dulls the real warnings.
	if (isReadOnlyCall(toolName, input)) {
		return null;
	}

	const toolPaths = getToolPolicyPaths(toolName, input, cwd, bashAnalysis, executionContext);
	const externalPaths = describeExternalPaths(cwd, toolPaths, policy, "write", executionContext);
	if (externalPaths.length > 0) {
		// Same temp-dir downgrade as the shell branch: a Write tool scratch file under
		// /tmp stays visible to standard/strict but does not pause the light level.
		const tempDowngrade = allExternalPathsAreSystemTemp(externalPaths);
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
			tempDowngrade ? "medium" : "high",
		);
	}

	return null;
}

/**
 * System temp directories, for the danger-reflection severity downgrade only.
 *
 * Writes into `/tmp` (and the OS tmpdir) are disposable scratch work, not worktree
 * content: they are outside project git history either way, but they are also outside
 * every user asset. Pausing the whole session to reflect on `echo hi > /tmp/x` — which
 * the light level does, because the external-path write classifies as "high" — turned
 * throwaway shell plumbing into a full reflection round. Downgraded to "medium", the
 * light level (threshold = high) skips it while standard and strict still pause.
 *
 * Only used by classifyDanger; the permission decision path keeps its own checks, so a
 * directory blacklist targeting /tmp still denies those writes before any of this runs.
 */
function isSystemTempDirPath(path: string): boolean {
	const normalized = resolvePath(path);
	if (normalized === "/tmp") return true;
	return isInsidePath(tmpdir(), normalized);
}

function allExternalPathsAreSystemTemp(paths: string[]): boolean {
	return paths.length > 0 && paths.every(isSystemTempDirPath);
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

/**
 * Resolve Send destinations for permission auto-allow rank checks.
 *
 * Parent is a first-class destination for a subagent: progress reports and
 * replyTo answers address the narrator that launched the child. Treating a
 * primary parent as "not a valid target" made `shouldAutoAllowSendWithinScope`
 * always fail for child→parent Send, so those reports sat in `pending` until a
 * human approved them — often never, while the parent Agent/await held an
 * update-blocking lease.
 */
async function resolveSendTargetsForPermission(
	callerId: string,
	caller: PermissionScopeNarrator,
	input: Record<string, unknown>,
): Promise<PermissionScopeNarrator[]> {
	const selectors = sendSelectors(input);
	if (selectors.length === 0) return [];
	const callerIsSubagent = !!caller.variant && isSubagentVariant(caller.variant);
	const teamParentId = callerIsSubagent ? caller.parentNarratorId : callerId;
	if (typeof teamParentId !== "string" || teamParentId.length === 0) return [];
	const parentId: string = teamParentId;

	const resolved: PermissionScopeNarrator[] = [];
	const seen = new Set<string>();
	for (const selector of selectors) {
		const aliasCandidate = await resolveSendAliasCandidate(selector, callerId, parentId);
		const addressesParent =
			callerIsSubagent &&
			(isParentSelector(aliasCandidate) ||
				isParentSelector(selector) ||
				aliasCandidate === parentId ||
				selector === parentId);
		// "parent"/"main" are reserved aliases, not narrator primary keys. Resolve the
		// launching narrator by teamParentId so mixed target lists still work.
		if (addressesParent) {
			const parent = await narratorService.getById(parentId).catch(() => null);
			if (!parent?.id || parent.id !== parentId || isSubagentVariant(parent.variant ?? "")) {
				return [];
			}
			if (!seen.has(parent.id)) {
				seen.add(parent.id);
				resolved.push(parent);
			}
			continue;
		}
		const direct = await narratorService.getById(aliasCandidate).catch(() => null);
		if (direct) {
			if (
				!direct.id ||
				!isSubagentVariant(direct.variant ?? "") ||
				direct.parentNarratorId !== parentId ||
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

		const siblings = await narratorService.listSubagentsByParent(parentId);
		const candidates = siblings.filter((s) => {
			if (callerIsSubagent && s.id === callerId) return false;
			return subagentMatchesSelector(s, selector);
		});
		if (candidates.length !== 1) return [];
		const target = await narratorService.getById(candidates[0].id).catch(() => null);
		if (
			!target?.id ||
			!isSubagentVariant(target.variant ?? "") ||
			target.parentNarratorId !== parentId
		) {
			return [];
		}
		if (!seen.has(target.id)) {
			seen.add(target.id);
			resolved.push(target);
		}
	}
	return resolved;
}

/**
 * Whether a Send may skip the permission prompt because every destination is
 * within the caller's communication scope.
 *
 * Child → parent progress reports/replies are always in scope: the parent
 * launched this subagent and is the intended consumer. Sibling/child targets
 * still use the permission-mode rank comparison.
 */
export async function shouldAutoAllowSendWithinScope(
	narratorId: string,
	caller: PermissionScopeNarrator | null | undefined,
	input: Record<string, unknown>,
): Promise<boolean> {
	try {
		if (!caller) return false;
		const callerIsSubagent = !!caller.variant && isSubagentVariant(caller.variant);
		const teamParentId = callerIsSubagent ? caller.parentNarratorId : null;
		const targets = await resolveSendTargetsForPermission(narratorId, caller, input);
		const selectors = sendSelectors(input);
		const onlyAddressesParent =
			callerIsSubagent &&
			!!teamParentId &&
			selectors.length > 0 &&
			selectors.every((selector) => isParentSelector(selector) || selector === teamParentId);

		if (targets.length === 0) {
			// Parent-only Send that failed id lookup still auto-allows when every
			// selector is a reserved parent alias or the exact team parent id.
			return onlyAddressesParent;
		}

		const nonParentTargets = teamParentId
			? targets.filter((target) => target.id !== teamParentId)
			: targets;
		// Parent destinations are always in-scope for the child that reports to them.
		if (nonParentTargets.length === 0) return true;

		const callerRank = permissionModeRank(caller);
		return nonParentTargets.every((target) => permissionModeRank(target) <= callerRank);
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
	// `.narrafork/plans/plan-*.md` short reference (the `plans/` segment is optional
	// so pre-move paths are still recognised).
	if (/\.narrafork[/\\](?:plans[/\\])?plan-[^\s]*\.md\s*$/i.test(trimmed)) return true;
	// The same mention followed by trailing prose (e.g. our own model-facing
	// reference sentence, which ends with "Re-read that file …").
	if (/\.narrafork[/\\](?:plans[/\\])?plan-[^\s]*\.md\b/i.test(trimmed)) return true;
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

type PlanFileResolutionError =
	| "invalid"
	| "tooLarge"
	| "executorUpgrade"
	/** A relaxed-mode custom path that resolves outside `.narrafork/plans/`. */
	| "outsidePlansDir";

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

/** Path grammar of an execution backend, falling back to its declared platform. */
function backendPathSemantics(backend: ExecutionBackend): TargetPathSemantics {
	return (
		backend.paths ??
		targetPathSemantics(
			backend.pathFlavor === "windows" || backend.platform?.os === "windows" ? "windows" : "posix",
		)
	);
}

function comparableBackendPath(backend: ExecutionBackend, baseCwd: string, value: string): string {
	const paths = backendPathSemantics(backend);
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
		(isSafePlanFileIdForPath(planFileId) ? buildPlanFileRelPath(planFileId) : null);
	const planFileName = customPlanFilePath ?? defaultPlanFilePath;
	/** Placeholder for messages emitted before any plan path is known. */
	const planFilePlaceholder = buildPlanFileRelPath("<id>");

	// `mode` is a DECLARATION of where the plan comes from, verified rather than
	// reinterpreted. Its whole purpose is to stop the source from being guessed
	// from which optional fields happen to be present: under pure inference, a
	// model that declared an inline plan but forgot the body silently got a
	// previous cycle's plan file submitted under its name.
	//
	// A missing `mode` still falls back to inference. It is required in the
	// model-facing schema, so a compliant model always sends it; erroring here
	// instead would make ExitPlanMode unusable for any model or gateway that
	// drops the field, turning a corrective nudge into a dead tool.
	const declaredMode = readDeclaredExitPlanMode(input);

	if (declaredMode === EXIT_PLAN_MODE_INLINE && !allowInlinePlan) {
		return {
			ok: false,
			input: stripPlanFileInput(effectiveInput),
			resolvedFromFile: false,
			message: getToolMessageWithParams("exitPlanModeInlineModeDisabled", locale, {
				planFile: planFileName ?? planFilePlaceholder,
			}),
		};
	}

	// Declared inline with nothing in `inline_plan`: report the contradiction
	// instead of quietly reading a file the model did not point at.
	if (declaredMode === EXIT_PLAN_MODE_INLINE && !normalizedInlinePlan) {
		return {
			ok: false,
			input: stripPlanFileInput(effectiveInput),
			resolvedFromFile: false,
			message: getToolMessageWithParams("exitPlanModeInlineWithoutBody", locale, {
				planFile: planFileName ?? planFilePlaceholder,
			}),
		};
	}

	// Strict plan mode: an inline submission is still checked against the designated
	// plan file. Once the model has written a plan there, that file IS the work the
	// user has to review — accepting an inline body instead would show the user one
	// artifact while silently discarding the other. Relaxed plan mode is excluded:
	// its plan path is model-chosen, so "a file exists" proves nothing about intent.
	//
	// This probe is advisory: it may only REFUSE an inline plan by proving a
	// conflicting file exists, never fail one because the file could not be read.
	const inlineConflictProbeOnly =
		!isRelaxedPlan && hasCompleteInlinePlan && declaredMode !== EXIT_PLAN_MODE_FILE;

	const shouldResolveFilePlan =
		!!planFileName &&
		(declaredMode === EXIT_PLAN_MODE_FILE ||
			inlineConflictProbeOnly ||
			// Declared inline never reads a file to SUBSTITUTE a plan: a bad inline
			// body must surface as an inline error, not be papered over by whatever
			// the plan file holds.
			(declaredMode !== EXIT_PLAN_MODE_INLINE &&
				(!!suppliedPlanFilePath || !hasCompleteInlinePlan)));
	let planFileError: PlanFileResolutionError | undefined;
	/** Bytes of plan content proven to be on disk, for the inline-conflict refusal. */
	let planFileContentBytes: number | undefined;
	const baseCwd = executionTarget?.cwd ?? toolBaseCwd(backend, cwd);

	// A malformed persisted identity is a boundary violation in its own right. It is
	// checked independently of whether a path could be derived from it: an identity
	// that fails validation yields no path at all, and letting a missing path skip
	// the check would silently turn the violation into an accepted inline plan.
	if (!isRelaxedPlan && planFileId && !isSafePlanIdentity(planFileId)) {
		planFileError = "invalid";
	}

	// Strict mode accepts only the canonical plan path — or, for a cycle that began
	// before the move to `.narrafork/plans/`, the legacy path it is anchored to.
	// TODO(migration): drop the legacy candidate once no pre-move cycle is open.
	if (!isRelaxedPlan && planFileName && !planFileError) {
		const strictCandidates = isSafePlanFileIdForPath(planFileId)
			? [buildPlanFileRelPath(planFileId), buildLegacyPlanFileRelPath(planFileId)]
			: [];
		const matchesDesignated = strictCandidates.some(
			(candidate) =>
				comparableBackendPath(backend, baseCwd, planFileName) ===
				comparableBackendPath(backend, baseCwd, candidate),
		);
		if (!isSafePlanIdentity(planFileId) || !matchesDesignated) planFileError = "invalid";
	}

	if (customPlanFilePath && !isMarkdownPlanFilePath(customPlanFilePath)) {
		planFileError = "invalid";
	}

	// Relaxed plan mode lets the model write other files while planning, but the plan
	// ITSELF stays in the plan directory: a plan file scattered anywhere in the tree
	// is what made plan artifacts unfindable. This is the lexical half of the check —
	// a symlink out of the directory is caught after stat resolves the real path.
	if (customPlanFilePath && !planFileError) {
		const paths = backendPathSemantics(backend);
		if (!isInsidePlansDir(paths, baseCwd, customPlanFilePath)) {
			planFileError = "outsidePlansDir";
		}
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
	// Errors found by the identity/path pre-validation above stay fatal even for the
	// advisory conflict probe: they mean the narrator's plan identity or the supplied
	// path is malformed, which is a boundary violation rather than an unreadable file.
	const preReadPlanFileError = planFileError;
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
							} else if (
								// The lexical check above proved the SUPPLIED path is in the plan
								// directory; this proves the file it actually resolves to is too,
								// closing a symlink from inside the directory to a file outside it.
								customPlanFilePath &&
								!isInsidePlansDir(targetContext.paths, baseCwd, canonicalPath)
							) {
								planFileError = "outsidePlansDir";
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
										if (inlineConflictProbeOnly) {
											// Only record the conflict. Substituting this content for the
											// model's inline body would swap the artifact under review;
											// the refusal below sends the model back to declare `file`.
											planFileContentBytes = file.bytes.byteLength;
										} else {
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
				}
			} catch {
				// Target freezing, policy compilation, stat, and atomic reads are fail-closed.
				planFileError = "invalid";
			}
		}
	}

	// The conflict probe must not be able to fail a submission. A plan file that is
	// unreadable, oversized, or on a legacy executor proves nothing about a conflict,
	// and treating it as fatal would leave no usable way out of plan mode: file mode
	// already rejects those executors, so inline has to stay available.
	if (inlineConflictProbeOnly && planFileError && !preReadPlanFileError) {
		planFileError = undefined;
		planFileContentBytes = undefined;
	}

	// Proven conflict: plan content is on disk AND the model tried to submit inline.
	if (planFileContentBytes !== undefined && planFileName) {
		return {
			ok: false,
			input: stripPlanFileInput(effectiveInput),
			resolvedFromFile: false,
			message: getToolMessageWithParams("exitPlanModeInlineWithExistingPlanFile", locale, {
				planFile: planFileName,
				bytes: planFileContentBytes,
			}),
		};
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
						: planFileError === "outsidePlansDir"
							? getToolMessageWithParams("exitPlanModePlanFileOutsidePlansDir", locale, {
									planFile: planFileName ?? "<unknown>",
									plansDir: PLAN_DIR_REL,
									defaultPlanFile: defaultPlanFilePath ?? planFilePlaceholder,
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

	// A declared `file` plan that produced no content must NOT silently fall back
	// to `inline_plan`: the model said the plan lives in a file, so the failure
	// belongs to that file and is reported below as an empty plan.
	const inlineFallbackAllowed = declaredMode !== EXIT_PLAN_MODE_FILE;

	if (!resolvedFromFile && allowInlinePlan && inlineFallbackAllowed) {
		const inlinePlan = normalizedInlinePlan;
		if (inlinePlan) {
			if (looksLikePathReference(inlinePlan)) {
				const planFilePath =
					planFileName ??
					(isSafePlanFileIdForPath(planFileId)
						? buildPlanFileRelPath(planFileId)
						: planFilePlaceholder);
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
	} else if ((!allowInlinePlan || !inlineFallbackAllowed) && !resolvedFromFile) {
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
			planFileName ??
			(isSafePlanFileIdForPath(planFileId)
				? buildPlanFileRelPath(planFileId)
				: planFilePlaceholder);
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
	permissionToolCallId: string,
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
				inputChars: measureSerializedCharacters(input),
				errorMessage: message,
				permissionDecidedBy: "auto",
				permissionDecidedAt: new Date().toISOString(),
				permissionDecisionReason: "invalid_ask_user_question_input",
			})
			.where(and(eq(narratorToolCalls.id, permissionToolCallId)));
		await refreshPermissionContextCharacters(narratorId, permissionToolCallId);
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
	if (
		toolName === "Read" ||
		toolName === "Write" ||
		toolName === "Edit" ||
		toolName === "NotebookEdit" ||
		toolName === "StructSed" ||
		toolName === "StructView"
	) {
		return typeof input.file_path === "string" ? input.file_path : undefined;
	}
	if (toolName === "Glob" || toolName === "Grep") {
		return typeof input.path === "string" ? input.path : undefined;
	}
	return undefined;
}

export async function canonicalizeShellAnalysisPaths(
	analysis: BashAnalysis,
	context: ExecutionTargetContext,
	signal?: AbortSignal,
): Promise<BashAnalysis> {
	signal?.throwIfAborted();
	if (analysis.filePaths.length === 0) return analysis;
	const canonicalPaths = await resolveCanonicalPaths(
		analysis.filePaths,
		context,
		"Shell path identity",
		signal,
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
	assertToolSpecPaths(input.toolName, input.toolInput);
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
	// A Dynamic Spec target runs on the host backend but keeps the spec:// grammar, so it
	// never matches the backend's own filesystem flavor. Comparing the two would reject
	// every reprocessed spec:// permission ("expected spec, got posix") — most visibly when
	// a plan-mode spec write is pending and the user changes permission mode.
	if (target.pathFlavor !== "spec") {
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

export interface FinalToolPermissionCheck {
	narratorId: string;
	toolName: string;
	input: Record<string, unknown>;
	toolUseId: string;
	binding: ToolCallBinding;
	executionBackend?: ExecutionBackend;
	executionTarget?: Readonly<ToolExecutionTarget>;
	executionPlan?: ToolExecutionPlan;
	/** Trusted multi-endpoint operation, never accepted from tool input. */
	endpointOperation?: ToolExecutionOperation;
	cwd?: string;
	signal?: AbortSignal;
	runtimeConstraint?: RuntimePermissionConstraint;
	reviewReadOnlyBash?: boolean;
}
export interface FinalToolPermissionFence {
	assertStillCurrent(): void;
}
const FINAL_PERMISSION_INPUT_MAX_BYTES = 512 * 1024;
function finalPermissionDeny(message: string): never {
	throw new AppError(
		`Final tool permission denied: ${message}`,
		403,
		"FINAL_TOOL_PERMISSION_DENIED",
	);
}
function captureFinalOAuthAuthority(check: FinalToolPermissionCheck) {
	const constraint = check.runtimeConstraint;
	if (!constraint) return null;
	if (!constraint.oauthClientId || !constraint.grantId)
		finalPermissionDeny("missing OAuth authority identity");
	const authority = db
		.select({
			id: integrationAuthorities.id,
			state: integrationAuthorities.state,
			kind: integrationAuthorities.kind,
			integrationId: integrationAuthorities.integrationId,
			integrationType: integrationAuthorities.integrationType,
			ownerUserId: integrationAuthorities.ownerUserId,
			expiresAt: integrationAuthorities.expiresAt,
			policy: integrationAuthorities.policyJson,
		})
		.from(integrationAuthorities)
		.where(eq(integrationAuthorities.id, constraint.grantId))
		.get();
	const client = db
		.select({
			id: oauthClients.id,
			revokedAt: oauthClients.revokedAt,
			publicClient: oauthClients.publicClient,
			scopes: oauthClients.scopes,
			policy: oauthClients.policyJson,
		})
		.from(oauthClients)
		.where(eq(oauthClients.id, constraint.oauthClientId))
		.get();
	const provenance = db
		.select({
			state: integrationResourceBindings.state,
			sourceId: integrationResourceBindings.sourceId,
			sourceType: integrationResourceBindings.sourceType,
			authorityId: integrationResourceBindings.authorityId,
			authorityType: integrationResourceBindings.authorityType,
			revision: integrationResourceBindings.revision,
		})
		.from(integrationResourceBindings)
		.where(
			and(
				eq(integrationResourceBindings.resourceType, "narrator"),
				eq(integrationResourceBindings.resourceId, check.narratorId),
			),
		)
		.get();
	const snapshot = db
		.select({
			policy: sql<string | null>`json_extract(${narrators.oauthPolicySnapshotJson}, '$.policy')`,
			deviceIds: sql<
				string | null
			>`json_extract(${narrators.oauthPolicySnapshotJson}, '$.deviceIds')`,
			defaultDeviceId: narrators.defaultDeviceId,
		})
		.from(narrators)
		.where(eq(narrators.id, check.narratorId))
		.get();
	const now = new Date().toISOString();
	const grants = db
		.select({
			id: integrationCapabilityGrants.id,
			expiresAt: integrationCapabilityGrants.expiresAt,
		})
		.from(integrationCapabilityGrants)
		.where(
			and(
				eq(integrationCapabilityGrants.authorityId, constraint.grantId),
				eq(integrationCapabilityGrants.capabilityId, "narrator.send_message"),
				isNull(integrationCapabilityGrants.revokedAt),
				or(
					isNull(integrationCapabilityGrants.expiresAt),
					gt(integrationCapabilityGrants.expiresAt, now),
				),
			),
		)
		.limit(2001)
		.all();
	if (
		!authority ||
		authority.state !== "active" ||
		authority.kind !== "oauth_grant" ||
		authority.integrationType !== "oauth_client" ||
		authority.integrationId !== constraint.oauthClientId ||
		!authority.ownerUserId ||
		(authority.expiresAt !== null &&
			(!Number.isFinite(Date.parse(authority.expiresAt)) ||
				Date.parse(authority.expiresAt) <= Date.now())) ||
		!client ||
		client.revokedAt !== null ||
		!client.publicClient ||
		!client.scopes.includes("narrator.send_message") ||
		!provenance ||
		provenance.state !== "active" ||
		provenance.sourceType !== "oauth_client" ||
		provenance.sourceId !== constraint.oauthClientId ||
		provenance.authorityType !== "oauth_grant" ||
		provenance.authorityId !== constraint.grantId ||
		!snapshot?.policy ||
		grants.length === 0 ||
		grants.length > 2000
	)
		finalPermissionDeny("OAuth authority was revoked or expired");
	const policy = intersectOAuthClientPolicies(
		oauthClientPolicySchema.parse(client.policy),
		oauthClientPolicySchema.parse(authority.policy),
		oauthClientPolicySchema.parse(JSON.parse(snapshot.policy)),
	);
	if (!policy) finalPermissionDeny("OAuth policy intersection is empty");
	if (
		!policy.allowedPermissionModes.includes(constraint.permissionMode) ||
		stableJson(policy.deviceAccess) !== stableJson(constraint.deviceAccess) ||
		policy.allowKnowledgeWrite !== constraint.allowKnowledgeWrite ||
		policy.allowRobotDiagnosticPreset !== !!constraint.useRobotDiagnosticPreset
	) {
		finalPermissionDeny("OAuth policy ceiling changed");
	}
	const ids: unknown = JSON.parse(snapshot.deviceIds ?? "[]");
	if (
		!Array.isArray(ids) ||
		ids.length === 0 ||
		ids.length > 128 ||
		ids.some((id) => typeof id !== "string") ||
		!snapshot.defaultDeviceId ||
		!ids.includes(snapshot.defaultDeviceId)
	)
		finalPermissionDeny("invalid OAuth device snapshot");
	const devices = db
		.select({ id: remoteDevices.id, revokedAt: remoteDevices.revokedAt })
		.from(remoteDevices)
		.where(inArray(remoteDevices.id, ids as string[]))
		.limit(129)
		.all();
	const bindings = db
		.select({
			resourceId: integrationResourceBindings.resourceId,
			state: integrationResourceBindings.state,
			sourceId: integrationResourceBindings.sourceId,
			sourceType: integrationResourceBindings.sourceType,
			authorityType: integrationResourceBindings.authorityType,
			authorityId: integrationResourceBindings.authorityId,
			revision: integrationResourceBindings.revision,
		})
		.from(integrationResourceBindings)
		.where(
			and(
				eq(integrationResourceBindings.resourceType, "device"),
				inArray(integrationResourceBindings.resourceId, ids as string[]),
			),
		)
		.limit(129)
		.all();
	for (const id of ids) {
		const device = devices.find((item) => item.id === id),
			binding = bindings.find((item) => item.resourceId === id);
		if (
			!device ||
			device.revokedAt !== null ||
			!binding ||
			binding.state !== "active" ||
			binding.sourceType !== "oauth_client" ||
			binding.sourceId !== constraint.oauthClientId ||
			binding.authorityType !== "oauth_grant" ||
			binding.authorityId !== constraint.grantId
		)
			finalPermissionDeny("OAuth device binding was revoked");
	}
	return { authority, client, provenance, snapshot, grants, devices, bindings };
}
function finalPermissionSnapshot(check: FinalToolPermissionCheck) {
	const narrator = db
		.select({
			id: narrators.id,
			chapterId: narrators.chapterId,
			contextProjectId: narrators.contextProjectId,
			parentNarratorId: narrators.parentNarratorId,
			cwd: narrators.cwd,
			workspaceRevision: narrators.workspaceRevision,
			defaultDeviceId: narrators.defaultDeviceId,
			permissionMode: narrators.permissionMode,
			relaxedPlan: narrators.relaxedPlan,
			traits: narrators.traits,
			variant: narrators.variant,
			planFileId: narrators.planFileId,
			previousPermissionMode: narrators.previousPermissionMode,
		})
		.from(narrators)
		.where(eq(narrators.id, check.narratorId))
		.get();
	const call = db
		.select({
			id: narratorToolCalls.id,
			narratorId: narratorToolCalls.narratorId,
			toolUseId: narratorToolCalls.toolUseId,
			toolName: narratorToolCalls.toolName,
			attempt: narratorToolCalls.executionAttempt,
			version: narratorToolCalls.executionIdentityVersion,
			origin: narratorToolCalls.executionOriginToolCallId,
			status: narratorToolCalls.status,
			decidedBy: narratorToolCalls.permissionDecidedBy,
			decidedAt: narratorToolCalls.permissionDecidedAt,
			deviceId: narratorToolCalls.executionDeviceId,
			cwd: narratorToolCalls.executionCwd,
			pathFlavor: narratorToolCalls.executionPathFlavor,
			path: narratorToolCalls.canonicalFilePath,
			resolvedPath: narratorToolCalls.resolvedFilePath,
			generation: narratorToolCalls.runtimeGeneration,
			targets: narratorToolCalls.executionTargetsJson,
			selectionSource: narratorToolCalls.deviceSelectionSource,
			// Single-row detail budget; never copy an arbitrarily large Write body into the guard.
			persistedInput: sql<
				string | null
			>`CASE WHEN length(CAST(${narratorToolCalls.inputJson} AS BLOB)) <= ${FINAL_PERMISSION_INPUT_MAX_BYTES} THEN ${narratorToolCalls.inputJson} ELSE NULL END`,
		})
		.from(narratorToolCalls)
		.where(
			and(
				eq(narratorToolCalls.id, check.binding.toolCallId),
				eq(narratorToolCalls.narratorId, check.narratorId),
				eq(narratorToolCalls.toolUseId, check.toolUseId),
			),
		)
		.get();
	if (
		!narrator ||
		!call ||
		call.attempt !== check.binding.attempt ||
		call.version !== 1 ||
		call.origin !== null ||
		(call.toolName !== check.toolName &&
			!(isBashToolName(call.toolName) && isBashToolName(check.toolName)))
	) {
		finalPermissionDeny("stale actor/tool execution binding");
	}
	if (
		call.status !== "running" ||
		!call.decidedAt ||
		!["auto", "user", "reflection"].includes(call.decidedBy ?? "")
	) {
		finalPermissionDeny("the exact tool attempt has no persisted approval");
	}
	const policy = executionPolicyRepository.loadNow(check.narratorId);
	const policyRevision = executionPolicyRevision(policy);
	const oauthAuthority = captureFinalOAuthAuthority(check);
	const revision = createHash("sha256")
		.update(stableJson({ narrator, call, policyRevision, oauthAuthority }))
		.digest("hex");
	return { narrator, call, policy, policyRevision, revision };
}

/** Read-only authorization gate. It never prompts, writes permission decisions or consumes receipts. */
export async function recheckFinalToolExecutionPermission(
	check: FinalToolPermissionCheck,
): Promise<FinalToolPermissionFence> {
	check.signal?.throwIfAborted();
	if (check.executionPlan?.kind === "multi") {
		if (check.runtimeConstraint)
			finalPermissionDeny(
				"OAuth cannot authorize a multi-target operation with one capability context",
			);
		if (check.executionPlan.endpoints.length === 0 || check.executionPlan.endpoints.length > 16)
			finalPermissionDeny("invalid or excessive endpoint plan");
		const fences: FinalToolPermissionFence[] = [];
		for (const endpoint of check.executionPlan.endpoints) {
			fences.push(
				await recheckFinalToolExecutionPermission({
					...check,
					executionPlan: undefined,
					endpointOperation: endpoint.operation,
					executionTarget: endpoint.target,
					executionBackend: resolveBackend({ requested: endpoint.target.deviceId }),
				}),
			);
		}
		return {
			assertStillCurrent() {
				for (const fence of fences) fence.assertStillCurrent();
			},
		};
	}
	await narratorPersistence.validateToolCallBinding(
		check.narratorId,
		check.toolUseId,
		check.binding,
	);
	const before = finalPermissionSnapshot(check);
	const routed = isRoutedPermissionTool(check.toolName);
	let context: ExecutionTargetContext | null = null;
	if (routed) {
		if (!check.executionBackend || !check.executionTarget)
			finalPermissionDeny("missing frozen execution target");
		context = await freezePermissionExecutionContext({
			toolName: check.toolName,
			toolInput: check.input,
			backend: check.executionBackend,
			target: { ...check.executionTarget },
		});
		const row = before.call;
		const registered = reconstructToolExecutionTargets({
			executionDeviceId: row.deviceId,
			executionCwd: row.cwd,
			executionPathFlavor: row.pathFlavor,
			resolvedFilePath: row.resolvedPath,
			canonicalFilePath: row.path,
			runtimeGeneration: row.generation,
			executionTargetsJson: row.targets,
			deviceSelectionSource: row.selectionSource,
		});
		const frozen = context;
		if (
			!registered.some(
				(target) =>
					target.deviceId === frozen.target.deviceId &&
					target.backendKind === frozen.target.backendKind &&
					frozen.paths.equals(target.cwd, frozen.target.cwd) &&
					(!target.pathFlavor || target.pathFlavor === frozen.target.pathFlavor) &&
					(target.runtimeGeneration ?? 0) === frozen.target.runtimeGeneration &&
					(!frozen.target.canonicalPath ||
						frozen.paths.equals(
							target.canonicalPath ?? target.resolvedFilePath ?? "",
							frozen.target.canonicalPath,
						)),
			)
		) {
			finalPermissionDeny("persisted device/directory/path differs from the frozen target");
		}
	}
	const primaryInputPath = permissionPrimaryPath(check.toolName, check.input);
	if (
		context &&
		primaryInputPath &&
		!context.paths.equals(
			context.paths.resolve(context.target.cwd, primaryInputPath),
			context.target.lexicalPath ??
				context.target.resolvedFilePath ??
				context.target.canonicalPath ??
				"",
		)
	) {
		finalPermissionDeny("input path differs from the frozen target");
	}
	// Small inputs, particularly commands and manual single-call approvals, must be byte-semantically bound.
	if (before.call.persistedInput !== null) {
		let persisted: unknown;
		try {
			persisted = JSON.parse(before.call.persistedInput);
		} catch {
			finalPermissionDeny("invalid persisted input");
		}
		if (stableJson(persisted) !== stableJson(check.input))
			finalPermissionDeny("approved input changed");
	} else if (
		before.call.decidedBy !== "auto" ||
		check.toolName !== "Write" ||
		!context?.target.canonicalPath ||
		!primaryInputPath
	) {
		finalPermissionDeny("approval input exceeds the bounded identity verification budget");
	}
	const cwd = context?.target.cwd ?? check.cwd ?? before.narrator.cwd;
	if (!cwd) finalPermissionDeny("missing execution directory");
	const constraint = check.runtimeConstraint;
	if (constraint && check.toolName === "RequestPermissionRule")
		finalPermissionDeny("OAuth cannot mutate narrator permission rules");
	if (
		constraint &&
		(check.toolName === "KnowledgeCreate" || check.toolName === "KnowledgeEdit") &&
		(!constraint.allowKnowledgeWrite ||
			check.input.action === "transfer_owner" ||
			check.input.action === "transfer_collection_owner")
	) {
		finalPermissionDeny("OAuth knowledge capability ceiling");
	}
	let analysis: BashAnalysis | undefined;
	if (isBashToolName(check.toolName) && typeof check.input.command === "string") {
		analysis = await analyzeShellCommand(
			check.input.command,
			cwd,
			resolvePermissionShellType(context?.backend),
			!!before.narrator.chapterId,
			context?.paths ?? localPathSemantics,
		);
		if (context) analysis = await canonicalizeShellAnalysisPaths(analysis, context, check.signal);
		if (analysis.commands.length === 0)
			finalPermissionDeny("command analysis produced no executable command");
	}
	let deviceLevel: "denied" | "readOnly" | "readWrite" | undefined;
	if (constraint && context) {
		if (!constraint.deviceAccess || !constraint.oauthClientId || !constraint.grantId)
			finalPermissionDeny("missing OAuth device capability");
		const group = await classifyDeviceAccessGroup(context.target.deviceId, {
			oauthClientId: constraint.oauthClientId,
			grantId: constraint.grantId,
		});
		context = withExecutionDeviceClass(context, group);
		deviceLevel = constraint.deviceAccess[group];
		if (
			deviceLevel === "denied" ||
			(deviceLevel !== "readWrite" &&
				(WRITE_TOOLS.has(check.toolName) || analysis?.hasWriteOperation))
		) {
			finalPermissionDeny("OAuth device capability ceiling");
		}
	}
	executionPolicyEngine.invalidate(check.narratorId);
	const policy = await executionPolicyEngine.compile(
		check.narratorId,
		context,
		constraint?.useRobotDiagnosticPreset ? ["robotDiagnostic"] : [],
		check.signal,
	);
	const expectedPolicy = createHash("sha256")
		.update(
			`${before.policyRevision}:${constraint?.useRobotDiagnosticPreset ? "robotDiagnostic" : "none"}`,
		)
		.digest("hex");
	if (policy.revision !== expectedPolicy)
		finalPermissionDeny("policy changed during final compilation");
	if (analysis?.isCatastrophic) finalPermissionDeny("catastrophic command");
	const decisionTool =
		check.endpointOperation === "read" || check.endpointOperation === "search"
			? "Read"
			: check.endpointOperation === "write"
				? "Write"
				: check.toolName;
	const decisionInput =
		decisionTool !== check.toolName && context
			? { ...check.input, file_path: executionTargetPolicyPath(context) }
			: check.input;
	const protectedReason = resolveProtectedPathDeny(
		decisionTool,
		decisionInput,
		cwd,
		policy.projectGitPath ?? undefined,
		analysis,
		context,
		context?.backend,
		context?.target,
	);
	if (protectedReason) finalPermissionDeny(protectedReason);
	const reviewBoundaryReason = resolveReviewBoundaryDeny(
		decisionTool,
		decisionInput,
		cwd,
		policy,
		analysis,
		context,
	);
	if (reviewBoundaryReason) finalPermissionDeny(reviewBoundaryReason);
	// Run deny layers before ALL shortcuts (including designated plan-file allowance).
	if (
		analysis &&
		policy.evaluateCommands(analysis.commands.map((command) => command.tokens)).decision === "deny"
	) {
		finalPermissionDeny("latest command blacklist matches this call");
	}
	const pathDeny = resolveBlacklistDecision(
		decisionTool,
		decisionInput,
		cwd,
		policy,
		analysis,
		context,
	);
	if (pathDeny) finalPermissionDeny(pathDeny.reason);
	const mode =
		constraint && context
			? deviceLevel === "readWrite"
				? "bypassPermissions"
				: "readOnly"
			: constraint && (check.toolName === "KnowledgeCreate" || check.toolName === "KnowledgeEdit")
				? "bypassPermissions"
				: (constraint?.permissionMode ?? before.narrator.permissionMode ?? "default");
	const review = check.reviewReadOnlyBash || before.narrator.variant === "subagent:review";
	if (
		review &&
		!isTaskStateMaintenanceTool(check.toolName, check.input) &&
		(WRITE_TOOLS.has(decisionTool) || check.toolName === "RequestPermissionRule")
	)
		finalPermissionDeny("review capability ceiling");
	const sendInScope =
		check.toolName === "Send" &&
		(await shouldAutoAllowSendWithinScope(check.narratorId, before.narrator, check.input));
	let dedicatedRuleApproval = false;
	if (check.toolName === "RequestPermissionRule") {
		if (!context) finalPermissionDeny("missing dedicated rule request execution context");
		await validatePermissionRuleRequestApproval(
			{ narratorId: check.narratorId, toolUseId: check.toolUseId, binding: check.binding },
			check.input,
			context,
		);
		dedicatedRuleApproval = true;
	}
	// The dedicated receipt grants only this rule insertion, never generic Write/Bash.
	// All latest deny layers and hard capability ceilings above still precede it.
	const decision =
		dedicatedRuleApproval || sendInScope
			? "allow"
			: resolvePermissionDecision({
					toolName: decisionTool,
					input: decisionInput,
					permMode: mode,
					cwd,
					bashAnalysis: analysis,
					isChapter: !!before.narrator.chapterId,
					compiledPolicy: policy,
					executionContext: context,
					projectGitPath: policy.projectGitPath ?? undefined,
					planMode: constraint ? false : isPlanModeTrait(before.narrator.traits),
					relaxedPlan: constraint
						? false
						: resolveEffectiveRelaxedPlan(mode, before.narrator.relaxedPlan),
					planFileId: before.narrator.planFileId ?? undefined,
					planFilePath: activeNarrators.get(check.narratorId)?._planFilePath,
					reviewReadOnlyBash: review,
					notificationPolicy: settings.agent.notificationPolicy,
					webFetchPolicy: settings.agent.webFetchPolicy,
				});
	if (
		decision === "deny" ||
		decision === "fatal" ||
		(decision === "ask" && before.call.decidedBy === "auto")
	) {
		finalPermissionDeny("current policy no longer authorizes the original automatic approval");
	}
	const assertStillCurrent = () => {
		check.signal?.throwIfAborted();
		if (
			context &&
			context.backend.runtimeGeneration !== undefined &&
			context.backend.runtimeGeneration !== context.target.runtimeGeneration
		) {
			finalPermissionDeny("execution device generation changed");
		}
		if (finalPermissionSnapshot(check).revision !== before.revision)
			finalPermissionDeny("authorization changed before the tool body started");
	};
	assertStillCurrent();
	return { assertStillCurrent };
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
	toolCallId: string;
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
		.where(and(eq(narratorToolCalls.id, input.toolCallId)));
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
	reviewReadOnlyBash = false,
): Promise<PermissionResult> {
	const specError = toolSpecPathError(toolName, input);
	if (specError) return { behavior: "deny", message: specError };
	const binding = options?.toolCallBinding;
	if (binding) {
		try {
			await narratorPersistence.validateToolCallBinding(narratorId, toolUseId, binding);
		} catch {
			return { behavior: "deny", message: "Invalid persisted tool execution binding" };
		}
	}
	// Legacy callers may omit the binding only when the provider id is unambiguous.
	const candidates = await db.query.narratorToolCalls.findMany({
		where: and(
			binding ? eq(narratorToolCalls.id, binding.toolCallId) : undefined,
			eq(narratorToolCalls.narratorId, narratorId),
			eq(narratorToolCalls.toolUseId, toolUseId),
		),
		columns: { id: true, executionAttempt: true },
		limit: 2,
	});
	if (candidates.length > 1 || (binding && candidates.length !== 1)) {
		return { behavior: "deny", message: "Ambiguous or missing persisted tool execution record" };
	}
	const permissionToolCallId = candidates[0]?.id ?? "";
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

	if (toolName === "RequestPermissionRule") {
		if (runtimeConstraint || reviewReadOnlyBash || !binding || !executionContext) {
			return {
				behavior: "deny",
				message: "Permission rule requests require an exact unconstrained frozen execution binding",
			};
		}
		return handlePermissionRuleRequest({
			narratorId,
			signal,
			input,
			toolUseId,
			cwd,
			locale,
			wsTarget,
			parentToolUseId,
			options: options as PermissionHandlerOptions,
			context: executionContext,
		});
	}

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
		isBashToolName(toolName) && !input.command && (input.await != null || input.stop != null);
	if (isBashToolName(toolName) && typeof input.command === "string") {
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
				bashAnalysis = await canonicalizeShellAnalysisPaths(bashAnalysis, executionContext, signal);
			}
			if (bashAnalysis.commands.length === 0) {
				throw new Error("command parser produced no executable command");
			}
		} catch (err) {
			// Cancellation is not a parse failure: deny right away instead of logging a
			// misleading analysis warning and running the rest of the policy pipeline.
			if (signal?.aborted) return { behavior: "deny", message: "Permission check aborted" };
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
				(isBashToolName(toolName) && bashAnalysis?.hasWriteOperation === true);
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
	const designatedPlanFilePath = isPlanMode
		? activeNarrators.get(narratorId)?._planFilePath
		: undefined;

	// Plan mode: redirect Write/Edit targeting any .md file to the designated plan file
	let planRedirectNotice: string | undefined;
	if (isPlanMode && !isRelaxedPlan && planFileId && (toolName === "Write" || toolName === "Edit")) {
		const filePath = typeof effectiveInput.file_path === "string" ? effectiveInput.file_path : "";
		// A spec:// URI is never a filesystem plan file. Rewriting it to the plan path would
		// also change the path grammar of an execution target that was already frozen as
		// "spec" before permission handling, which the executor rejects outright ("path
		// flavor is already frozen to spec and cannot change to posix") — so the model sees
		// a routing error instead of a decision. Dynamic Spec writes are session metadata
		// and are judged on their own below (tasks.json is allowed, anything else still
		// falls through to the plan-mode soft deny).
		if (filePath && !specVfsService.isSpecUri(filePath)) {
			const paths = executionContext?.paths ?? localPathSemantics;
			const absPath =
				(executionContext && executionTargetPolicyPath(executionContext)) ??
				resolveDecisionPath(cwd, filePath, executionContext);
			// A resumed pre-move cycle may legitimately still be writing to its legacy
			// path; redirecting that away would cut the model off from its own plan.
			const candidates = planFileWriteCandidates(planFileId, designatedPlanFilePath);
			const alreadyPlanFile = candidates.some((candidate) =>
				paths.equals(absPath, resolveDecisionPath(cwd, candidate, executionContext)),
			);
			if (!alreadyPlanFile) {
				const fileName = paths.basename(filePath).toLowerCase();
				if (fileName.endsWith(".md")) {
					const correctRelPath = candidates[0] ?? buildPlanFileRelPath(planFileId);
					effectiveInput = { ...effectiveInput, file_path: correctRelPath };
					planRedirectNotice = getToolMessageWithParams("planModeFileRedirected", locale, {
						originalPath: filePath,
						planFile: correctRelPath,
					});
				}
			}
		}
	}

	if (toolName === "AskUserQuestion") {
		try {
			const { assertNarratorCanAskQuestion } = await import("./narrator-question-service");
			await assertNarratorCanAskQuestion(narratorId);
		} catch (error) {
			return { behavior: "deny", message: error instanceof Error ? error.message : String(error) };
		}
		const askResult = await validateOrRepairAskUserQuestionInput(
			narratorId,
			toolUseId,
			effectiveInput,
			permissionToolCallId,
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

	// Bash await/stop are pure control operations for ordinary sessions, but review
	// follow-ups are limited to synchronous Git inspection and cannot use them.
	if (reviewReadOnlyBash && isBashControlOp) {
		return {
			behavior: "deny",
			message: "Review Bash only permits synchronous, read-only Git inspection commands.",
		};
	}

	// Stopping owned work must remain possible when remote metadata RPCs are
	// exhausted/offline. The tool still enforces task ownership when executing.
	// Deliberately decided BEFORE policy compilation: stop/await run no command and
	// touch no path, so directory/command policy (and its compile failures) do not
	// apply. OAuth-denied devices and review read-only mode are rejected above.
	if (isBashControlOp && !isRecoveredHumanPermission(getPermissionRecovery(options))) {
		await options?.onInputResolved?.(effectiveInput);
		await db
			.update(narratorToolCalls)
			.set({
				status: "running",
				permissionDecidedBy: "auto",
				permissionDecidedAt: new Date().toISOString(),
			})
			.where(and(eq(narratorToolCalls.id, permissionToolCallId)));
		return { behavior: "allow", updatedInput: effectiveInput };
	}
	let compiledPolicy: ResolvedExecutionPolicy;
	try {
		compiledPolicy = await executionPolicyEngine.compile(
			narratorId,
			executionContext,
			runtimeConstraint?.useRobotDiagnosticPreset ? ["robotDiagnostic"] : [],
			signal,
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
		if (
			isRecoveredHumanPermission(getPermissionRecovery(options)) &&
			typeof input.plan === "string" &&
			input.plan !== resolved.input.plan
		) {
			return { behavior: "deny", message: "Plan changed while its approval was awaiting a user" };
		}
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
					planFilePath: designatedPlanFilePath,
					planMode: isPlanMode,
					reviewReadOnlyBash,
					compiledPolicy,
					executionContext,
					relaxedPlan: isRelaxedPlan,
					previousPermissionMode: narrator?.previousPermissionMode ?? undefined,
					meta: permMeta,
					projectGitPath: compiledPolicy.projectGitPath ?? undefined,
					executionBackend: executionContext?.backend,
					executionTarget: initialExecutionTarget,
					notificationPolicy: settings.agent.notificationPolicy,
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

	const restoredGate = getPermissionRecovery(options);
	const restoredReflection = recoveryReflection(restoredGate);
	// A durable human wait is not a new permission decision. Policy expansion after
	// restart must never silently approve it; hard deny/fatal decisions remain enforced.
	if (isRecoveredHumanPermission(restoredGate) && decision === "allow") decision = "ask";

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
			isBashToolName(toolName) && shellAnalysisError
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
			where: and(eq(narratorToolCalls.id, permissionToolCallId)),
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
				inputChars: measureSerializedCharacters(effectiveInput),
				permissionStartedAt: now,
				permissionDecisionReason: `Danger reflection: ${danger.summary}`,
				permissionSuggestions: suggestions,
			})
			.where(eq(narratorToolCalls.id, requestId));
		await refreshPermissionContextCharacters(narratorId, requestId);
		await narratorService.updateStatus(narratorId, "waiting", {
			substatus: ["reflecting"],
		});
		// Automatic reflection belongs to the tool owner, not the parent whose
		// page renders the child card. The lifecycle frame below updates that card
		// without turning the parent's ongoing work into a false user wait.
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
				// The decision is already cancelled; don't leave a user-actionable live entry
				// while the best-effort persistence/status updates above are still awaiting.
				cleanup();
				resolve({ behavior: "deny", message: "Narrator aborted" });
			};
			cleanup = () => {
				signal.removeEventListener("abort", onAbort);
				if (pendingDangerReflections.delete(requestId)) notifyHumanAttentionChanged();
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
			notifyHumanAttentionChanged();
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
	if (
		restoredReflection?.type === "danger_reflection" &&
		["running", "awaiting_user"].includes(restoredReflection.status) &&
		(decision === "allow" || decision === "ask")
	) {
		const restoredDanger = restoredReflection.danger as DangerInfo | undefined;
		if (
			!restoredDanger ||
			typeof restoredDanger.summary !== "string" ||
			typeof restoredReflection.fingerprint !== "string"
		) {
			return { behavior: "deny", message: "Invalid persisted danger reflection" };
		}
		const pause = await startDangerReflectionPause(restoredDanger, restoredReflection.fingerprint, {
			skipConfirmationCache: true,
			planModeSoftDeny: restoredReflection.planModeSoftDeny === true,
		});
		if (pause?.behavior === "dangerReflection" && restoredReflection.status === "awaiting_user") {
			await stopDangerReflectionLoop(pause.requestId, "Restored user-owned danger reflection");
			options?.onAwaitingUserDecision?.();
		}
		if (pause) return pause;
	}
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
			isBashToolName(toolName) && shellAnalysisError
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
			toolCallId: permissionToolCallId,
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
			.where(and(eq(narratorToolCalls.id, permissionToolCallId)));
		return {
			behavior: "allow",
			updatedInput: effectiveInput,
			...(planRedirectNotice ? { notice: planRedirectNotice } : {}),
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
			isBashToolName(toolName) && shellAnalysisError
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
				.where(and(eq(narratorToolCalls.id, permissionToolCallId)));
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
				.where(and(eq(narratorToolCalls.id, permissionToolCallId)));
			return { behavior: "deny", message: denyMsg };
		}
		const chapterGitIssues = isChapter ? getChapterGitPermissionIssues(bashAnalysis) : [];
		const isReadToolPathDenied =
			(permMode === "readOnly" || isPlanMode) &&
			(READ_ONLY_TOOLS.includes(toolName) ||
				(isBashToolName(toolName) &&
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
			.where(and(eq(narratorToolCalls.id, permissionToolCallId)));
		return {
			behavior: "deny",
			message: denyMsg,
		};
	}

	const toolCallRecord = await db.query.narratorToolCalls.findFirst({
		where: and(eq(narratorToolCalls.id, permissionToolCallId)),
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
			inputChars: measureSerializedCharacters(effectiveInput),
			permissionStartedAt: new Date().toISOString(),
			...(decisionReason ? { permissionDecisionReason: decisionReason } : {}),
		})
		.where(eq(narratorToolCalls.id, toolCallId));
	await refreshPermissionContextCharacters(narratorId, toolCallId);
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
		toolName === "AskUserQuestion" &&
		!isRecoveredHumanPermission(restoredGate) &&
		shouldScheduleQuestionReflection(effectiveMode)
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
			if (pendingPermissions.delete(toolCallId)) notifyHumanAttentionChanged();
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
		if (toolName === "AskUserQuestion" && questionReflectionDeadline !== undefined) {
			pendingEntry.questionReflectionDeadline = questionReflectionDeadline;
			pendingEntry.questionReflectionTimer = scheduleQuestionReflection(
				toolCallId,
				effectiveMode,
				questionReflectionDeadline,
			);
		}
		pendingPermissionContexts.set(pendingEntry, { options, runtimeConstraint, reviewReadOnlyBash });
		pendingPermissions.set(toolCallId, pendingEntry);
		// Unlike permission_request (above), this fires after the registry and countdown exist.
		notifyHumanAttentionChanged();
		// The row is already `pending` and the request is now registered, so this wait is durable:
		// a checkpoint will persist it as a `pending_permission` continuation and the replacement
		// process re-offers it with its stored input. Tell the executor it may drop its update
		// start grant, so an unanswered request does not block a planned restart. Deliberately
		// after `pendingPermissions.set` — releasing before the request is discoverable would let
		// a restart checkpoint see neither an in-flight tool nor a recoverable request.
		options?.onAwaitingUserDecision?.();
	});
}

async function handlePermissionRuleRequest(args: {
	narratorId: string;
	signal: AbortSignal;
	input: Record<string, unknown>;
	toolUseId: string;
	cwd: string;
	locale: Locale;
	wsTarget: string;
	parentToolUseId?: string;
	options: PermissionHandlerOptions;
	context: ExecutionTargetContext;
}): Promise<PermissionResult> {
	const {
		narratorId,
		signal,
		toolUseId,
		cwd,
		locale,
		wsTarget,
		parentToolUseId,
		options,
		context,
	} = args;
	const binding = options.toolCallBinding;
	if (!binding) return { behavior: "deny", message: "Missing exact rule-request tool binding" };
	let prepared: Awaited<ReturnType<typeof preparePermissionRuleRequest>>;
	try {
		signal.throwIfAborted();
		prepared = await preparePermissionRuleRequest(
			{ narratorId, toolUseId, binding },
			args.input,
			context,
		);
		if (isRecoveredHumanPermission(getPermissionRecovery(options))) {
			prepared = { ...prepared, automatic: false };
		}
		await options.onInputResolved?.(prepared.input);
	} catch (error) {
		return { behavior: "deny", message: error instanceof Error ? error.message : String(error) };
	}
	const id = binding.toolCallId;
	const input = prepared.input as Record<string, unknown>;
	const routing = permissionRoutingIdentity(narratorId, wsTarget, parentToolUseId);
	const risk: DangerInfo = {
		severity: "high",
		summary: "Persist a narrator permission rule",
		details: [
			`Rule: ${prepared.rule.ruleType}`,
			`Device: ${input.device}`,
			`Reason: ${input.reason}`,
			`Proposal hash: ${prepared.proposalHash}`,
		],
		consequences: [
			"Future calls may be authorized without repeated prompts. Inherited deny rules and hard capability ceilings remain enforced.",
		],
		saferAlternatives: ["Keep the rule absent and approve individual calls."],
	};
	try {
		await db
			.update(narratorToolCalls)
			.set({
				status: "pending",
				inputJson: input,
				inputChars: measureSerializedCharacters(input),
				permissionStartedAt: new Date().toISOString(),
				permissionDecisionReason: `Permission rule request: ${input.reason}`,
				permissionSuggestions: [
					{
						type: "permission_rule_request",
						requestId: prepared.requestId,
						proposalHash: prepared.proposalHash,
						scope: "narrator",
						deviceId: input.device,
						...(prepared.automatic
							? { purpose: "permissionRuleRequest", reflectionLevel: "strict" }
							: {}),
					},
				],
			})
			.where(eq(narratorToolCalls.id, id));
		await refreshPermissionContextCharacters(narratorId, id);
	} catch (error) {
		failPermissionRuleRequest(prepared.requestId, String(error));
		return { behavior: "deny", message: "Permission rule request persistence failed" };
	}
	let cleanup = () => {};
	const decision = new Promise<PermissionResult>((resolve) => {
		const abort = () => {
			pendingDangerReflections.get(id)?.reflectionAbortController?.abort();
			try {
				terminatePermissionRuleRequest({
					narratorId,
					toolCallId: binding.toolCallId,
					attempt: binding.attempt,
					status: "cancelled",
					reason: signal.aborted
						? "Permission rule request aborted"
						: "Permission rule request timed out",
				});
			} catch {}
			cleanup();
			resolve({ behavior: "deny", message: "Permission rule request cancelled or timed out" });
		};
		const timer = setTimeout(abort, PERMISSION_RULE_REQUEST_TTL_MS);
		cleanup = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			if (pendingPermissions.delete(id))
				eventBus.emit({
					type: "narrator:attention_resolved",
					narratorId,
					reason: "waiting_permission",
				});
			pendingDangerReflections.delete(id);
			permissionRuleRequestPauses.delete(id);
			notifyHumanAttentionChanged();
		};
		signal.addEventListener("abort", abort, { once: true });
		permissionRuleRequestPauses.set(id, {
			requestId: prepared.requestId,
			automatic: prepared.automatic,
			settling: false,
		});
		if (prepared.automatic) {
			pendingDangerReflections.set(id, {
				narratorId,
				requestId: id,
				toolCallId: id,
				toolUseId,
				toolName: "RequestPermissionRule",
				broadcastTargetId: wsTarget,
				parentToolUseId,
				input,
				fingerprint: prepared.proposalHash,
				danger: risk,
				startedAt: Date.now(),
				resolve,
				cleanup,
			});
		} else {
			pendingPermissions.set(id, {
				narratorId,
				toolName: "RequestPermissionRule",
				toolUseId,
				broadcastTargetId: wsTarget,
				parentToolUseId,
				input,
				cwd,
				locale,
				signal,
				executionTarget: snapshotExecutionTarget(context.target),
				attentionEmitted: true,
				resolve,
				cleanup,
			});
		}
		if (signal.aborted) abort();
	});
	if (signal.aborted) return decision;
	await narratorService.updateStatus(
		narratorId,
		"waiting",
		prepared.automatic ? { substatus: ["reflecting"] } : undefined,
	);
	notifyHumanAttentionChanged();
	if (prepared.automatic) {
		broadcastReflectionFrame(
			{ narratorId, broadcastTargetId: wsTarget, parentToolUseId },
			{
				type: "danger_reflection_started",
				requestId: id,
				toolUseId,
				toolName: "RequestPermissionRule",
				danger: risk,
			},
		);
		return {
			behavior: "dangerReflection",
			requestId: id,
			danger: risk,
			fingerprint: prepared.proposalHash,
			reflectionLevel: "strict",
			purpose: "permissionRuleRequest",
			input,
			decision,
		};
	}
	broadcastToNarrator(wsTarget, {
		type: "permission_request",
		narratorId: wsTarget,
		request: {
			id,
			...routing,
			toolName: "RequestPermissionRule",
			toolUseId,
			inputJson: input,
			decisionReason: `Permission rule request: ${input.reason}`,
			executionDeviceId: context.target.deviceId,
			executionCwd: context.target.cwd,
			resolvedFilePath: "path" in prepared.input ? prepared.input.path : null,
			deviceSelectionSource: context.target.selectionSource,
		},
	});
	eventBus.emit({ type: "narrator:permission_request", narratorId, requestId: id });
	eventBus.emit({ type: "narrator:attention", narratorId, reason: "waiting_permission" });
	options.onAwaitingUserDecision?.();
	return decision;
}

/** Called ONLY by the strict loop completion boundary, never by textual fallback. */
export async function completePermissionRuleRequestReflection(
	requestId: string,
	result: PermissionRuleReflectionCompletion,
): Promise<boolean> {
	const state = permissionRuleRequestPauses.get(requestId);
	const pause = pendingDangerReflections.get(requestId);
	if (!state?.automatic || !pause || state.settling) return false;
	state.settling = true;
	let approved = false;
	try {
		approved = completeRuleReflection(state.requestId, result);
		await db
			.update(narratorToolCalls)
			.set({
				status: approved ? "running" : "fail",
				permissionDecidedBy: "reflection",
				permissionDecidedAt: new Date().toISOString(),
				permissionDecisionReason: approved
					? "Strict rule-request reflection completed"
					: "Strict rule-request reflection failed",
			})
			.where(eq(narratorToolCalls.id, pause.toolCallId));
	} catch {
		approved = false;
		try {
			failPermissionRuleRequest(state.requestId, "Strict receipt persistence failed");
		} catch {}
	}
	pause.cleanup();
	broadcastReflectionFrame(pause, {
		type: "danger_reflection_resolved",
		requestId,
		toolUseId: pause.toolUseId,
		decision: approved ? "allow" : "deny",
		reason: approved
			? "Strict rule-request reflection completed"
			: "Strict rule-request reflection failed",
		...(!approved ? { failed: true } : {}),
	});
	pause.resolve(
		approved
			? { behavior: "allow", updatedInput: pause.input }
			: { behavior: "deny", message: "Strict permission rule reflection failed" },
	);
	await narratorService.updateStatus(pause.narratorId, "working").catch(() => {});
	return approved;
}

export interface ResolvePermissionOpts {
	denyMessage?: string;
	answers?: Record<string, string>;
	feedbackText?: string;
	compactAfter?: boolean;
	updatedPlan?: string;
	/**
	 * AskUserQuestion only: release the loop WITHOUT answering, turning the blocking
	 * prompt into an asynchronous question the user answers later. Mutually exclusive
	 * with `answers` (answering is not deferring); `answers` wins if both arrive.
	 */
	deferAsync?: boolean;
	userId?: string;
	/**
	 * Who decided this permission. `"user"`/`"auto"`/`"reflection"` are the built-in
	 * deciders; `narrator:<id>` only appears in historical rows written by the
	 * removed proxy-approval path. The value is persisted to permissionDecidedBy.
	 */
	decidedBy?: "user" | "auto" | "reflection" | `narrator:${string}`;
	exitPlanCancelled?: boolean;
}

type DangerReflectionDecidedBy = "reflection" | "user" | "auto" | `narrator:${string}`;

/**
 * How approval feedback text reaches a SUBAGENT.
 *
 * ## Why subagents need their own path at all
 *
 * The primary-narrator path stashes the text in `pendingFeedback` (keyed by
 * narratorId) and arms `_feedbackSoftStop` on the `activeNarrators` entry; the
 * `[continuation-source: permission-feedback]` branch of `runAgentLoop` then
 * persists it as a real `role: "user"` turn and restarts the pass with it.
 *
 * A subagent has NO `activeNarrators` entry — a running subagent registers only in
 * `activeSubagentSettings` — so BOTH halves of that mechanism silently no-op for
 * one. The user could type feedback into the InlinePermission form rendered inside
 * the parent's SubagentCard, approve, and have the text vanish without a trace,
 * which is worse than offering no input box at all.
 *
 * ## Why a message and not a note on the tool result
 *
 * The subagent's equivalent of "stash payload + arm soft stop" is the buffered
 * message queue: `bufferSubagentUserMessage` enqueues the text AND requests the
 * next safe post-tool boundary (`shouldStopSubagentForBufferedMessage` is exactly
 * what the subagent loop passes as its `shouldStop`). The queue is drained by
 * `getAfterToolsInjections` (in-pass) or `consumeNextBufferedSubagentMessage`
 * (pass restart), and both persist it through `persistSubagentUserMessage`. So the
 * result is the same shape the primary path produces: a `role: "user"` turn.
 *
 * That is what the content IS. The user typed a turn ("go ahead, but watch out for
 * X"); routing it through `deliverInjection` instead would file it as a `sys`
 * injection row — lower weight for the model, attributed to the system rather than
 * to the person who wrote it, and rendered as a system card instead of their
 * message. Attaching it to the tool result would be worse still: it would arrive
 * as commentary on one call rather than as an instruction for what to do next.
 *
 * ## Why a seam and not a lazy import at the call site
 *
 * `mock.module` is process-wide in Bun: replacing `subagent-executor` for one test
 * file hands the replacement to every later file in the run, and that module holds
 * lazily-initialized queues other suites read. A seam the test installs and
 * restores keeps the blast radius inside the test.
 */
export interface SubagentFeedbackDelivery {
	/** Whether a subagent loop is currently running under this narrator id. */
	isSubagentRunning: (narratorId: string) => boolean;
	/**
	 * Queue the text as the subagent's next user turn and request a safe stop.
	 * Returns false when the queue refused it (full, or no running subagent).
	 */
	deliver: (
		narratorId: string,
		text: string,
		options: { createdBy: string | null },
	) => boolean | Promise<boolean>;
}

/** Lazily bound to the real subagent modules; replaced only by tests. */
let subagentFeedbackDelivery: SubagentFeedbackDelivery | null = null;

/**
 * Install a subagent feedback delivery implementation, returning the previous one
 * so a test can restore it. Pass `null` to fall back to the real subagent modules.
 */
export function setSubagentFeedbackDelivery(
	next: SubagentFeedbackDelivery | null,
): SubagentFeedbackDelivery | null {
	const previous = subagentFeedbackDelivery;
	subagentFeedbackDelivery = next;
	return previous;
}

/**
 * Whether this permission's feedback must take the subagent path.
 *
 * Kept synchronous so the primary-narrator branch stays exactly what it was: an
 * in-line `pendingFeedback.set` before `pending.resolve`, with no await inserted
 * between the two. `activeSubagentSettings` is registered for the whole span of a
 * subagent run, so this needs no database read on the decision path.
 */
function isSubagentFeedbackRecipient(narratorId: string): boolean {
	if (subagentFeedbackDelivery) return subagentFeedbackDelivery.isSubagentRunning(narratorId);
	return activeSubagentSettings.has(narratorId);
}

/**
 * Queue approval feedback text as the subagent's next user turn.
 *
 * Failure is logged, not thrown: the permission has already been decided and the
 * approved tool is about to run, so raising here would fail a call the user allowed.
 */
async function deliverSubagentPermissionFeedback(
	narratorId: string,
	text: string,
	userId: string | null,
): Promise<void> {
	try {
		let delivery = subagentFeedbackDelivery;
		if (!delivery) {
			const [{ bufferSubagentUserMessage }, { isTakenOver }] = await Promise.all([
				import("./subagent-executor"),
				import("./subagent-takeover"),
			]);
			delivery = {
				isSubagentRunning: (id) => activeSubagentSettings.has(id),
				deliver: async (id, message, options) =>
					(
						await bufferSubagentUserMessage(id, message, {
							createdBy: options.createdBy,
							// A taken-over subagent is driven by the user directly, so cutting
							// short the turn they are steering would be wrong; the resume path
							// drains the queue instead. Same rule every other subagent send obeys.
							requestSoftStop: !isTakenOver(id),
						})
					).ok,
			};
		}
		if (!(await delivery.deliver(narratorId, text, { createdBy: userId }))) {
			logger.warn("Subagent permission feedback could not be queued", {
				narratorId,
				chars: text.length,
			});
		}
	} catch (err) {
		logger.error("Failed to deliver subagent permission feedback", {
			narratorId,
			error: String(err),
		});
	}
}

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
		deferAsync,
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

	if (pending.toolName === "RequestPermissionRule") {
		const state = permissionRuleRequestPauses.get(requestId);
		if (
			!state ||
			state.automatic ||
			state.settling ||
			decidedBy !== "user" ||
			!userId ||
			answers ||
			updatedPlan !== undefined ||
			deferAsync
		)
			return false;
		state.settling = true;
		let approved = false;
		try {
			if (
				!recordPermissionRuleRequestDecision(state.requestId, decision, "user", userId, denyMessage)
			)
				return false;
			await db
				.update(narratorToolCalls)
				.set({
					status: decision === "allow" ? "running" : "fail",
					permissionDecidedBy: "user",
					permissionDecidedAt: new Date().toISOString(),
				})
				.where(eq(narratorToolCalls.id, requestId));
			approved = decision === "allow";
		} catch {
			try {
				failPermissionRuleRequest(state.requestId, "Human approval persistence failed");
			} catch {}
		} finally {
			pending.cleanup();
			broadcastToNarrator(pending.broadcastTargetId, {
				type: "permission_resolved",
				narratorId: pending.broadcastTargetId,
				requestId,
				toolUseId: pending.toolUseId,
				decision: approved ? "allow" : "deny",
				...pendingPermissionRoutingIdentity(pending),
			});
			pending.resolve(
				approved
					? { behavior: "allow", updatedInput: pending.input }
					: { behavior: "deny", message: denyMessage ?? "Permission rule request rejected" },
			);
		}
		await narratorService.updateStatus(pending.narratorId, "working").catch(() => {});
		return true;
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
	} else if (deferAsync && pending.toolName === "AskUserQuestion") {
		// "Answer later": the user releases the loop without deciding. Flipping the input
		// to `async` is the whole mechanism — the tool then takes its asynchronous branch,
		// files the question, and returns the same "carry on with a default" instruction
		// the agent would have received had it asked asynchronously in the first place.
		//
		// Approved rather than denied, deliberately: a denial tells the agent its call was
		// refused, when in fact the question was accepted and merely moved.
		updatedInput = { ...pending.input, async: true, deferredByUser: true };
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
				...(updatedInput
					? { inputJson: updatedInput, inputChars: measureSerializedCharacters(updatedInput) }
					: {}),
				...(decision === "deny"
					? {
							errorMessage: effectiveDenyMessage || "Permission denied by user",
						}
					: {}),
			})
			.where(eq(narratorToolCalls.id, requestId));
		if (updatedInput) await refreshPermissionContextCharacters(pending.narratorId, requestId);
	} catch (err) {
		logger.error("Failed to persist permission decision; refusing execution", {
			requestId,
			error: String(err),
		});
		pending.resolve({ behavior: "deny", message: "Permission decision could not be persisted" });
		return false;
	}

	if (decision === "allow") {
		const approvalFeedback = feedbackText?.trim();
		// Carry the approver so the injected turn shows their avatar rather than an
		// anonymous "you".
		const feedbackUserId = decidedBy === "user" ? (userId ?? null) : null;
		// A subagent has no `activeNarrators` entry, so `pendingFeedback` +
		// `_feedbackSoftStop` would both be written into the void for one. Its
		// equivalent is the buffered-message queue — see `SubagentFeedbackDelivery`.
		const subagentFeedback =
			approvalFeedback && isSubagentFeedbackRecipient(pending.narratorId) ? approvalFeedback : null;
		if (approvalFeedback && !subagentFeedback) {
			pendingFeedback.set(pending.narratorId, {
				toolUseId: pending.toolUseId,
				feedbackText: approvalFeedback,
				userId: feedbackUserId,
			});
		}
		const effectiveUpdatedInput = updatedInput ?? pending.input;

		if (compactAfter) {
			pendingPlanCompact.add(pending.narratorId);
		}

		if (pending.toolName === "ExitPlanMode" && userId) {
			pendingPlanApprover.set(pending.narratorId, userId);
			pendingPlanApproverSource.set(pending.narratorId, "user");
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

		// The ExitPlanMode exclusion is a PRIMARY-narrator rule and stays scoped to the
		// primary branch: approving a plan already restarts the loop through
		// `_planApprovedContinue`, which merges `pendingFeedback` into its own prompt, so
		// arming a second stop would cut that restart short. Subagents have no plan mode
		// at all (`subagent-tools.ts` admits neither EnterPlanMode nor ExitPlanMode, and
		// `isPlanModeTrait` is never true for a subagent row), so the exclusion is
		// vacuous on their path and is deliberately not carried over.
		if (subagentFeedback) {
			await deliverSubagentPermissionFeedback(pending.narratorId, subagentFeedback, feedbackUserId);
		} else if (approvalFeedback && pending.toolName !== "ExitPlanMode") {
			const active = activeNarrators.get(pending.narratorId);
			if (active?.alive) {
				active._feedbackSoftStop = true;
			}
		}
	} else {
		const userFeedback = denyMessage || feedbackText?.trim();
		if (pending.toolName === "ExitPlanMode") {
			// `pending.locale` is the locale the request was RAISED with — the same value
			// `handlePermission` received from whichever loop opened it (a subagent passes
			// its `SubagentExecOptions.locale`, a primary its `ActiveNarrator.locale`), and
			// it is frozen with the request so reprocessing reuses it. Reading
			// `activeNarrators` instead resolved to undefined for every subagent and
			// silently degraded this message to English for Chinese users.
			const locale = pending.locale ?? "en";
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

/**
 * The narrator a request id belongs to, whatever kind of pending decision it is.
 *
 * Exists because the decision surfaces are keyed by request id alone and carry no
 * narrator id: `POST /permissions/:requestId/...` and the `permission_decision`
 * WebSocket frame both have to discover the owner before they can authorize the
 * caller. Approving a tool call is the single most consequential action on this
 * surface — it is what lets an agent write files or run commands — so a decision
 * frame that skipped this lookup was authorized by nothing but knowledge of the
 * request id, and request ids are broadcast to every reader of the session.
 *
 * All four in-memory registries key by request id and record `narratorId`. Once a
 * request has been decided it lives only in `narrator_tool_calls`, where the request
 * id IS the row id — hence the final fallback rather than "not found". (An ExitPlan
 * reflection's `exit_plan_*` id is synthetic and lives ONLY in its registry: it
 * never resolves through the tool-call row, which is why the registry lookups must
 * all run before that fallback.)
 */
export async function resolveDecisionNarratorId(requestId: string): Promise<string | null> {
	const pending = pendingPermissions.get(requestId);
	if (pending?.narratorId) return pending.narratorId;
	const reflection = pendingDangerReflections.get(requestId);
	if (reflection?.narratorId) return reflection.narratorId;
	const { getTaskReflectionNarratorId } = await import("@server/lib/agent/tools/task-reflection");
	const taskReflectionNarratorId = getTaskReflectionNarratorId(requestId);
	if (taskReflectionNarratorId) return taskReflectionNarratorId;
	const { getExitPlanReflectionNarratorId } = await import(
		"@server/lib/agent/tools/exit-plan-reflection"
	);
	const planReflectionNarratorId = getExitPlanReflectionNarratorId(requestId);
	if (planReflectionNarratorId) return planReflectionNarratorId;
	const row = await db.query.narratorToolCalls.findFirst({
		where: eq(narratorToolCalls.id, requestId),
		columns: { narratorId: true },
	});
	return row?.narratorId ?? null;
}

/**
 * Defer a blocking AskUserQuestion into the asynchronous inbox.
 *
 * A dedicated entry point rather than a flag on the generic resolve routes, because
 * "answer later" only means anything for AskUserQuestion. Reached through the generic
 * route, a deferral of some other pending tool would resolve it as ALLOW with a stray
 * `async: true` in its input — i.e. silently approve an operation the user was trying to
 * postpone. The guard belongs here, with the pending-request registry, rather than in a
 * route that would have to reach into it.
 */
export async function deferPendingQuestion(
	requestId: string,
	opts: { userId?: string } = {},
): Promise<{ ok: boolean; reason?: "not_found" | "not_a_question" }> {
	const pending = pendingPermissions.get(requestId);
	if (!pending) return { ok: false, reason: "not_found" };
	if (pending.toolName !== "AskUserQuestion") return { ok: false, reason: "not_a_question" };
	const resolved = await resolvePermission(requestId, "allow", {
		deferAsync: true,
		userId: opts.userId,
		decidedBy: "user",
	});
	return resolved ? { ok: true } : { ok: false, reason: "not_found" };
}

export async function resolvePermissionOrDangerReflection(
	requestId: string,
	decision: "allow" | "deny",
	opts: ResolvePermissionOpts = {},
): Promise<boolean> {
	// --no-auto-resume leaves durable approvals intact, but mounts no executing owner.
	// An explicit human decision may restore this one owner's subtree, never unrelated work.
	if (
		!pendingPermissions.has(requestId) &&
		!pendingDangerReflections.has(requestId) &&
		(opts.decidedBy ?? "user") === "user"
	) {
		const { manuallyResumeRestartRecovery, pausedRestartToolCallForRequest } = await import(
			"./restart-recovery-service"
		);
		const stored = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.id, pausedRestartToolCallForRequest(requestId)),
			columns: {
				narratorId: true,
				status: true,
				executionStartedAt: true,
				fileChangeOperationId: true,
			},
		});
		if (
			stored?.status === "pending" &&
			stored.executionStartedAt == null &&
			stored.fileChangeOperationId == null
		) {
			if (await manuallyResumeRestartRecovery(stored.narratorId)) {
				const deadline = Date.now() + 2_000;
				while (
					!pendingPermissions.has(requestId) &&
					!pendingDangerReflections.has(requestId) &&
					Date.now() < deadline
				) {
					const { hasPendingTaskReflection } = await import("../lib/agent/tools/task-reflection");
					if (hasPendingTaskReflection(requestId)) break;
					await new Promise<void>((resolve) => setTimeout(resolve, 10));
				}
			}
		}
	}
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
		if (pause?.reflectionStoppedByUser) {
			await mirrorPermissionStatusToTarget(narratorId, broadcastTargetId, "working").catch(
				() => {},
			);
		}
	} catch (err) {
		logger.warn("Failed to mark danger reflection as aborted", {
			requestId,
			narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
	} finally {
		await narratorService.updateStatus(narratorId, "working").catch(() => {});
		if (pause?.reflectionStoppedByUser) {
			await mirrorPermissionStatusToTarget(narratorId, broadcastTargetId, "working").catch(
				() => {},
			);
		}
		if (options.cleanup) {
			const current = pendingDangerReflections.get(requestId);
			// onAbort removes discoverability immediately. Still finish the captured
			// pause's cleanup hooks after persistence, without touching a replacement.
			if (!current || current === pause) {
				pause?.cleanup();
				if (pendingDangerReflections.delete(requestId)) notifyHumanAttentionChanged();
			}
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
	} finally {
		notifyHumanAttentionChanged();
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
	const ruleRequest = permissionRuleRequestPauses.get(requestId);
	if (ruleRequest) {
		if (decidedBy !== "reflection" || ruleRequest.settling) return false;
		try {
			return recordPermissionRuleRequestDecision(
				ruleRequest.requestId,
				"allow",
				"reflection",
				undefined,
				reflection,
			);
		} catch {
			await completePermissionRuleRequestReflection(requestId, {
				completedNormally: false,
				validToolDecision: false,
			});
			return false;
		}
	}
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
		if (pause.reflectionStoppedByUser) {
			await mirrorPermissionStatusToTarget(
				pause.narratorId,
				pause.broadcastTargetId,
				"working",
			).catch(() => {});
		}
	} catch (err) {
		logger.warn("Failed to finalize confirmed danger reflection", {
			requestId,
			narratorId: pause.narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
	} finally {
		await narratorService.updateStatus(pause.narratorId, "working").catch(() => {});
		if (pause.reflectionStoppedByUser) {
			await mirrorPermissionStatusToTarget(
				pause.narratorId,
				pause.broadcastTargetId,
				"working",
			).catch(() => {});
		}
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
	const ruleRequest = permissionRuleRequestPauses.get(requestId);
	if (ruleRequest) {
		pause.reflectionAbortController?.abort();
		try {
			failPermissionRuleRequest(
				ruleRequest.requestId,
				reason ?? "Permission rule reflection cancelled",
			);
		} catch {}
		pause.cleanup();
		pause.resolve({ behavior: "deny", message: reason ?? "Permission rule reflection cancelled" });
		broadcastReflectionFrame(pause, {
			type: "danger_reflection_resolved",
			requestId,
			toolUseId: pause.toolUseId,
			decision: "deny",
			reason: reason ?? "Permission rule reflection cancelled",
		});
		return true;
	}
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
		if (pause.reflectionStoppedByUser) {
			await mirrorPermissionStatusToTarget(
				pause.narratorId,
				pause.broadcastTargetId,
				"working",
			).catch(() => {});
		}
	} catch (err) {
		logger.warn("Failed to finalize cancelled danger reflection", {
			requestId,
			narratorId: pause.narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
	} finally {
		await narratorService.updateStatus(pause.narratorId, "working").catch(() => {});
		if (pause.reflectionStoppedByUser) {
			await mirrorPermissionStatusToTarget(
				pause.narratorId,
				pause.broadcastTargetId,
				"working",
			).catch(() => {});
		}
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

function broadcastReprocessedPermissionDecision(
	requestId: string,
	pending: PendingPermission,
	result: PermissionResult,
): void {
	if (result.behavior === "dangerReflection") return;
	broadcastToNarrator(pending.broadcastTargetId, {
		type: "permission_resolved",
		narratorId: pending.broadcastTargetId,
		requestId,
		toolUseId: pending.toolUseId,
		decision: result.behavior === "allow" ? "allow" : "deny",
		...(result.behavior === "allow" && result.updatedInput
			? { updatedInput: result.updatedInput }
			: {}),
		...(result.behavior === "deny" && result.message ? { feedbackText: result.message } : {}),
		...pendingPermissionRoutingIdentity(pending),
	});
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

		const originalContext = pendingPermissionContexts.get(pending);
		const reprocessOptions: PermissionHandlerOptions = {
			...originalContext?.options,
			suppressAttention: true,
		};
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
			originalContext?.runtimeConstraint,
			originalContext?.reviewReadOnlyBash,
		)
			.then(async (result) => {
				broadcastReprocessedPermissionDecision(requestId, pending, result);
				if (result.behavior !== "dangerReflection") {
					await restoreReprocessedPermissionStatus(pending);
				} else {
					// A real user prompt became an automatic child gate. Clear only
					// the old parent wait; the owner must stay waiting + reflecting.
					await mirrorPermissionStatusToTarget(
						pending.narratorId,
						pending.broadcastTargetId,
						"working",
					);
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
