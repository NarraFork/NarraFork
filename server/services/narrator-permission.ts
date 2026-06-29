import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
	chapters,
	narratorBlacklistCmds,
	narratorBlacklistDirs,
	narrators,
	narratorToolCalls,
	narratorWhitelistCmds,
	narratorWhitelistDirs,
	projects,
} from "../db/schema";
import type { DangerInfo, DangerSeverity, PermissionResult } from "../lib/agent";
import { analyzeShellCommand, type BashAnalysis } from "../lib/agent/bash-analyze";
import { detectShell } from "../lib/agent/shell";
import { toolRegistry } from "../lib/agent/tool-registry";
import { SHELL_TOOL_NAME } from "../lib/agent/tools/bash";
import {
	isKnowledgeReadAction,
	KNOWLEDGE_MERGE_ACTION_SET,
} from "../lib/agent/tools/knowledge-actions";
import { OUTPUT_DIR as TRUNCATE_OUTPUT_DIR } from "../lib/agent/truncate";
import {
	type DangerReflectionLevel,
	normalizeDangerReflectionLevel,
	resolveDangerReflectionLevel,
} from "../lib/boolean-override";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { isPlanModeTrait, isSubagentVariant } from "../lib/narrator-utils";
import { isInsidePath, pathsEqual, resolvePath } from "../lib/platform-path";
import { getToolMessage, getToolMessageWithParams, type Locale } from "../lib/prompt-i18n";
import { settings } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";

export {
	normalizeDangerReflectionLevel,
	resolveDangerReflectionLevel,
} from "../lib/boolean-override";

import { coerceAskQuestions, generateAskUserQuestionAnswers } from "./ask-user-question-reflection";
import { backgroundTaskService } from "./background-task-service";
import { narratorService } from "./narrator-service";
import {
	activeNarrators,
	type PendingDangerReflection,
	type PendingPermission,
	pendingDangerConfirmations,
	pendingDangerReflections,
	pendingFeedback,
	pendingPermissions,
	pendingPlanApprover,
	pendingPlanCompact,
	pendingPlanDiff,
	planModeAskedOnce,
} from "./narrator-session-state";
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

/** Check if ALL paths target only the truncated-output directory (read-only safe zone). */
function allPathsInTruncateDir(cwd: string, paths: string[]): boolean {
	return paths.length > 0 && paths.every((p) => isInsideTruncateDir(cwd, p));
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

function getShellScopePaths(
	cwd: string,
	input: Record<string, unknown>,
	bashAnalysis?: BashAnalysis,
): string[] {
	const paths = new Set<string>();
	if (typeof input.workdir === "string" && input.workdir) {
		const workdir = resolvePath(cwd, input.workdir);
		if (!pathsEqual(workdir, cwd)) paths.add(workdir);
	}
	for (const p of bashAnalysis?.filePaths ?? []) paths.add(p);
	return [...paths];
}

function whitelistAccessForPath(
	cwd: string,
	filePath: string,
	whitelistDirs: WhitelistDir[],
): "readOnly" | "readWrite" | "full" | null {
	if (whitelistDirs.length === 0) return null;
	const absPath = resolvePath(cwd, filePath);
	const levels = ["readOnly", "readWrite", "full"] as const;
	let best: (typeof levels)[number] | null = null;
	for (const dir of whitelistDirs) {
		if (!dir.enabled) continue;
		if (isInsidePath(dir.path, absPath)) {
			if (dir.accessLevel === "full") return "full";
			if (!best || levels.indexOf(dir.accessLevel) > levels.indexOf(best)) {
				best = dir.accessLevel;
			}
		}
	}
	return best;
}

function allPathsWhitelisted(
	cwd: string,
	paths: string[],
	whitelistDirs: WhitelistDir[],
	requiredLevel: "readOnly" | "readWrite" | "full",
): boolean {
	if (paths.length === 0 || whitelistDirs.length === 0) return false;
	const levels = ["readOnly", "readWrite", "full"] as const;
	const reqIdx = levels.indexOf(requiredLevel);
	return paths.every((p) => {
		const access = whitelistAccessForPath(cwd, p, whitelistDirs);
		return access !== null && levels.indexOf(access) >= reqIdx;
	});
}

function resolveWhitelistDecision(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	whitelistDirs: WhitelistDir[],
	bashAnalysis?: BashAnalysis,
): "allow" | null {
	if (whitelistDirs.length === 0) return null;

	if (toolName === "Agent") {
		const workdir = input.workdir;
		if (typeof workdir !== "string" || !workdir) return null;
		const resolvedWorkdir = resolvePath(cwd, workdir);
		if (pathsEqual(resolvedWorkdir, cwd)) return null;
		const access = whitelistAccessForPath(cwd, resolvedWorkdir, whitelistDirs);
		if (!access) return null;
		const isGeneral = input.subagent_type !== "explore" && input.subagent_type !== "plan";
		if (!isGeneral) return "allow";
		return access === "full" ? "allow" : null;
	}

	if (toolName === SHELL_TOOL_NAME) {
		if (!bashAnalysis) return null;
		if (bashAnalysis.nonWhitelisted.length > 0) return null;
		if (bashAnalysis.dangerousPatterns.length > 0) return null;
		if (bashAnalysis.hasEnvInjection) return null;
		const shellPaths = getShellScopePaths(cwd, input, bashAnalysis).filter(
			(p) => !isInsideWorktree(cwd, p) && !isInsideTruncateDir(cwd, p),
		);
		if (shellPaths.length === 0) return null;
		const requiredLevel = bashAnalysis.hasWriteOperation ? "readWrite" : "readOnly";
		return allPathsWhitelisted(cwd, shellPaths, whitelistDirs, requiredLevel) ? "allow" : null;
	}

	const toolPaths = extractToolPaths(toolName, input);
	if (toolPaths.length === 0) return null;
	const externalToolPaths = toolPaths.filter(
		(p) => !isInsideWorktree(cwd, p) && !isInsideTruncateDir(cwd, p),
	);
	if (externalToolPaths.length === 0) return null;
	const isReadTool = READ_ONLY_TOOLS.includes(toolName);
	const requiredLevel = isReadTool ? "readOnly" : "readWrite";
	return allPathsWhitelisted(cwd, externalToolPaths, whitelistDirs, requiredLevel) ? "allow" : null;
}

function blacklistMatchForPath(
	cwd: string,
	filePath: string,
	blacklistDirs: BlacklistDir[],
): BlacklistDir | null {
	if (blacklistDirs.length === 0) return null;
	const absPath = resolvePath(cwd, filePath);
	let worst: BlacklistDir | null = null;
	for (const dir of blacklistDirs) {
		if (!dir.enabled) continue;
		if (isInsidePath(dir.path, absPath)) {
			if (dir.denyLevel === "denyAll") return dir;
			if (!worst) worst = dir;
		}
	}
	return worst;
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

function formatBlacklistReason(dir: BlacklistDir, matchedPath: string): string {
	const src = dir.source ? (BLACKLIST_SOURCE_LABELS[dir.source] ?? dir.source) : "unknown";
	const level = dir.denyLevel === "denyAll" ? "block all access" : "block write access";
	return `Blacklisted by ${src}-level rule: "${dir.path}" (${level}), matched path: ${matchedPath}`;
}

function findBlacklistedPath(
	cwd: string,
	paths: string[],
	blacklistDirs: BlacklistDir[],
	operation: "read" | "write",
): string | null {
	if (paths.length === 0 || blacklistDirs.length === 0) return null;
	for (const p of paths) {
		const match = blacklistMatchForPath(cwd, p, blacklistDirs);
		if (!match) continue;
		if (match.denyLevel === "denyAll" || operation === "write") {
			return formatBlacklistReason(match, resolvePath(cwd, p));
		}
	}
	return null;
}

function getChapterGitPermissionIssues(bashAnalysis?: BashAnalysis): string[] {
	return [...(bashAnalysis?.gitBranchViolations ?? []), ...(bashAnalysis?.gitBranchWarnings ?? [])];
}

function resolveChapterGitIssueDecision(effectiveMode: string): "allow" | "deny" | "ask" {
	if (effectiveMode === "bypassPermissions") return "allow";
	if (effectiveMode === "dontAsk" || effectiveMode === "readOnly") return "deny";
	return "ask";
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
		whitelistDirs = [],
		blacklistDirs = [],
		commandWhitelist = [],
		commandBlacklist = [],
		relaxedPlan = false,
		planMode = false,
		meta,
		projectGitPath,
	} = opts;
	const effectiveMode = planMode ? (relaxedPlan ? (permMode ?? "default") : "readOnly") : permMode;
	if (toolName === SHELL_TOOL_NAME && bashAnalysis?.isCatastrophic) return "fatal";

	const protectedPathReason = resolveProtectedPathDeny(
		toolName,
		input,
		cwd,
		projectGitPath,
		bashAnalysis,
	);
	if (protectedPathReason) {
		if (meta) meta.blacklistReason = protectedPathReason;
		return "deny";
	}

	if (planMode && (toolName === "Write" || toolName === "Edit")) {
		if (planFileId) {
			const filePath = typeof input.file_path === "string" ? input.file_path : "";
			const absPath = resolvePath(cwd, filePath);
			const planFilePath = resolvePath(cwd, `.narrafork/plan-${planFileId}.md`);
			if (pathsEqual(absPath, planFilePath)) return "allow";
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
	if (toolName === SHELL_TOOL_NAME && bashAnalysis && commandBlacklist.length > 0) {
		const cmdBlMatch = resolveCommandBlacklistMatch(bashAnalysis, commandBlacklist);
		if (cmdBlMatch) {
			if (meta) {
				const src = cmdBlMatch.source ? ` (${cmdBlMatch.source} level)` : "";
				meta.commandBlacklistReason = `Command "${cmdBlMatch.command}" is blocked by command blacklist${src}. Pattern: "${cmdBlMatch.pattern}"`;
				if (cmdBlMatch.denyPrompt) {
					meta.commandBlacklistDenyPrompt = cmdBlMatch.denyPrompt;
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
		blacklistDirs,
		bashAnalysis,
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
		whitelistDirs,
		bashAnalysis,
	);
	if (whitelistDecision) return whitelistDecision;

	// MCP tool permission: check server-level defaultBehavior and per-tool overrides
	const mcpDecision = resolveMcpToolPermission(toolName, effectiveMode);
	if (mcpDecision) return mcpDecision;

	// Command whitelist
	let effectiveBashAnalysis = bashAnalysis;
	if (
		toolName === SHELL_TOOL_NAME &&
		bashAnalysis &&
		isCommandWhitelistCovered(bashAnalysis, commandWhitelist)
	) {
		effectiveBashAnalysis = {
			...bashAnalysis,
			allWhitelisted: true,
			nonWhitelisted: [],
			dangerousPatterns: filterWhitelistedPipePatterns(
				bashAnalysis.dangerousPatterns,
				commandWhitelist,
			),
		};
	}

	// Agent tool
	if (toolName === "Agent") {
		const workdir = input.workdir;
		const resolvedWorkdir =
			typeof workdir === "string" && workdir ? resolvePath(cwd, workdir) : null;
		const normalizedCwd = resolvePath(cwd);
		const isOutsideCwd = resolvedWorkdir !== null && !isInsidePath(normalizedCwd, resolvedWorkdir);
		const isDifferentDir = resolvedWorkdir !== null && !pathsEqual(resolvedWorkdir, normalizedCwd);

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
			const absPath = resolvePath(cwd, filePath);
			const conclusionPath = resolveConclusionFilePath(cwd, conclusionFileId);
			if (pathsEqual(absPath, conclusionPath)) return "allow";
		}
	}

	// readOnly mode
	if (effectiveMode === "readOnly") {
		if (READ_ONLY_TOOLS.includes(toolName)) {
			const toolPaths = extractToolPaths(toolName, input);
			const hasExternalPath =
				toolPaths.length > 0 && toolPaths.some((p) => !isInsideWorktree(cwd, p));
			if (!hasExternalPath || allPathsInTruncateDir(cwd, toolPaths)) return "allow";
			return "deny";
		}
		if (toolName === SHELL_TOOL_NAME) {
			if (!effectiveBashAnalysis) return "deny";
			if (effectiveBashAnalysis.nonWhitelisted.length > 0) return "deny";
			if (effectiveBashAnalysis.dangerousPatterns.length > 0) return "deny";
			if (effectiveBashAnalysis.hasEnvInjection) return "deny";
			if (effectiveBashAnalysis.hasWriteOperation) return "deny";
			const externalBashPaths = getShellScopePaths(cwd, input, effectiveBashAnalysis).filter(
				(p) => !isInsideWorktree(cwd, p) && !isInsideTruncateDir(cwd, p),
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
		const externalBashPaths = getShellScopePaths(cwd, input, effectiveBashAnalysis).filter(
			(p) => !isInsideWorktree(cwd, p) && !isInsideTruncateDir(cwd, p),
		);
		if (externalBashPaths.length > 0) return "ask";
		if (effectiveBashAnalysis.hasWriteOperation && effectiveMode !== "acceptEdits") return "ask";
		if (effectiveMode === "acceptEdits") return "allow";
		return "ask";
	}

	const toolPaths = extractToolPaths(toolName, input);
	const hasExternalPath = toolPaths.length > 0 && toolPaths.some((p) => !isInsideWorktree(cwd, p));

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
		allPathsInTruncateDir(cwd, toolPaths)
	) {
		return "allow";
	}

	return "ask";
}

function resolveBlacklistDecision(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	blacklistDirs: BlacklistDir[],
	bashAnalysis?: BashAnalysis,
): BlacklistDecisionResult | null {
	if (blacklistDirs.length === 0) return null;

	if (toolName === "Agent") {
		const workdir = input.workdir;
		if (typeof workdir !== "string" || !workdir) return null;
		const resolvedWorkdir = resolvePath(cwd, workdir);
		if (pathsEqual(resolvedWorkdir, cwd)) return null;
		const match = blacklistMatchForPath(cwd, resolvedWorkdir, blacklistDirs);
		if (!match) return null;
		// denyAll blocks everything; denyWrite blocks subagents with write access (non-explore/plan)
		if (match.denyLevel === "denyAll") {
			return { decision: "deny", reason: formatBlacklistReason(match, resolvedWorkdir) };
		}
		if (input.subagent_type !== "explore" && input.subagent_type !== "plan") {
			return { decision: "deny", reason: formatBlacklistReason(match, resolvedWorkdir) };
		}
		return null;
	}

	if (toolName === SHELL_TOOL_NAME) {
		if (!bashAnalysis) return null;
		const shellPaths = getShellScopePaths(cwd, input, bashAnalysis);
		if (shellPaths.length === 0) return null;
		const operation = bashAnalysis.hasWriteOperation ? "write" : "read";
		const reason = findBlacklistedPath(cwd, shellPaths, blacklistDirs, operation);
		return reason ? { decision: "deny", reason } : null;
	}

	const toolPaths = extractToolPaths(toolName, input);
	if (toolPaths.length === 0) return null;
	const isReadTool = READ_ONLY_TOOLS.includes(toolName);
	const operation = isReadTool ? "read" : "write";
	const reason = findBlacklistedPath(cwd, toolPaths, blacklistDirs, operation);
	return reason ? { decision: "deny", reason } : null;
}

const ALWAYS_ALLOW_TOOLS = [
	"TaskCreate",
	"EnterPlanMode",
	"WebSearch",
	"Await",
	"Skill",
	"LearningGuide",
	"GetGoals",
	"UpdateGoal",
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
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "ShareFile", "Await"];

/** Tools that always require user approval regardless of permission mode. */
const ALWAYS_ASK_TOOLS = ["ExitPlanMode", "AskUserQuestion"];

export interface WhitelistDir {
	path: string;
	accessLevel: "readOnly" | "readWrite" | "full";
	enabled: boolean;
}

export interface BlacklistDir {
	path: string;
	denyLevel: "denyWrite" | "denyAll";
	enabled: boolean;
	source?: "global" | "project" | "narrator";
}

export interface CommandWhitelistEntry {
	pattern: string;
	enabled: boolean;
	source?: "global" | "project" | "narrator";
}

export interface CommandBlacklistEntry {
	pattern: string;
	denyPrompt?: string | null;
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
	webFetchPolicy?: {
		allowAll?: boolean;
		whitelist?: Array<{ pattern: string; enabled?: boolean }>;
		blacklist?: Array<{ pattern: string; enabled?: boolean }>;
	};
}

// ── Command pattern matching ──────────────────────────────

function globMatch(text: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (!pattern.includes("*")) return text === pattern;
	const regex = new RegExp(
		`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
	);
	return regex.test(text);
}

function matchCommandPattern(tokens: string[], pattern: string): boolean {
	const parts = pattern.split(/\s+/);
	if (parts.length > tokens.length) return false;
	return parts.every((part, i) => globMatch(tokens[i], part));
}

function resolveCommandBlacklistMatch(
	bashAnalysis: BashAnalysis,
	commandBlacklist: CommandBlacklistEntry[],
): {
	pattern: string;
	command: string;
	denyPrompt?: string | null;
	source?: string;
} | null {
	if (commandBlacklist.length === 0) return null;
	for (const cmd of bashAnalysis.commands) {
		for (const entry of commandBlacklist) {
			if (matchCommandPattern(cmd.tokens, entry.pattern)) {
				return {
					pattern: entry.pattern,
					command: cmd.text,
					denyPrompt: entry.denyPrompt,
					source: entry.source,
				};
			}
		}
	}
	return null;
}

function filterWhitelistedPipePatterns(
	dangerousPatterns: string[],
	commandWhitelist: CommandWhitelistEntry[],
): string[] {
	if (commandWhitelist.length === 0) return dangerousPatterns;
	return dangerousPatterns.filter((pattern) => {
		const match = pattern.match(/^pipe to (.+)$/);
		if (!match) return true;
		const pipedCmd = match[1];
		return !commandWhitelist.some((entry) => matchCommandPattern([pipedCmd], entry.pattern));
	});
}

function isCommandWhitelistCovered(
	bashAnalysis: BashAnalysis,
	commandWhitelist: CommandWhitelistEntry[],
): boolean {
	if (bashAnalysis.allWhitelisted) return false;
	if (bashAnalysis.hasEnvInjection) return false;
	const remainingDangerous = filterWhitelistedPipePatterns(
		bashAnalysis.dangerousPatterns,
		commandWhitelist,
	);
	if (remainingDangerous.length > 0) return false;
	if (bashAnalysis.nonWhitelisted.length === 0) return true;
	if (commandWhitelist.length === 0) return false;
	return bashAnalysis.nonWhitelisted.every((cmdName) => {
		const cmd = bashAnalysis.commands.find((c) => c.tokens[0] === cmdName);
		if (!cmd) return false;
		return commandWhitelist.some((entry) => matchCommandPattern(cmd.tokens, entry.pattern));
	});
}

function isCommandWhitelisted(
	cmd: BashAnalysis["commands"][number],
	commandWhitelist: CommandWhitelistEntry[],
): boolean {
	return commandWhitelist.some(
		(entry) => entry.enabled && matchCommandPattern(cmd.tokens, entry.pattern),
	);
}

function areUnsafeCommandsWhitelistedForDanger(
	bashAnalysis: BashAnalysis,
	commandWhitelist: CommandWhitelistEntry[],
): boolean {
	if (commandWhitelist.length === 0 || bashAnalysis.hasEnvInjection) return false;
	if (bashAnalysis.nonWhitelisted.length === 0) return false;
	return bashAnalysis.nonWhitelisted.every((cmdName) => {
		const cmd = bashAnalysis.commands.find((c) => c.tokens[0] === cmdName);
		return !!cmd && isCommandWhitelisted(cmd, commandWhitelist);
	});
}

// ── Protected path checks (hard-deny, no bypass) ─────────

const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
const DESTRUCTIVE_COMMANDS = new Set(["rm", "rmdir", "shred"]);

function isGitInternalPath(absPath: string): boolean {
	const normalized = resolvePath(absPath);
	const segments = normalized.split("/");
	return segments.includes(".git");
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
): string | null {
	if (WRITE_TOOLS.has(toolName) || toolName === "Browser") {
		const filePath = typeof input.file_path === "string" ? input.file_path : "";
		if (!filePath || (toolName === "Browser" && input.action !== "screenshot")) return null;
		const absPath = resolvePath(cwd, filePath);
		if (isGitInternalPath(absPath)) {
			return `Write to .git directory is forbidden: ${absPath}`;
		}
		return null;
	}

	if (toolName === SHELL_TOOL_NAME && bashAnalysis) {
		if (bashAnalysis.hasWriteOperation) {
			for (const p of bashAnalysis.filePaths) {
				if (isGitInternalPath(p)) {
					return `Shell write operation targeting .git directory is forbidden: ${p}`;
				}
			}
		}
		if (projectGitPath) {
			for (const cmd of bashAnalysis.commands) {
				const cmdName = cmd.tokens[0];
				if (!DESTRUCTIVE_COMMANDS.has(cmdName)) continue;
				for (const arg of cmd.tokens.slice(1)) {
					if (arg.startsWith("-")) continue;
					const absArg = resolvePath(cwd, arg);
					if (isGitInternalPath(absArg)) {
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
): { cwd?: string; resolvedPaths?: string[] } {
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
	const resolvedPaths = [...new Set(paths.map((p) => resolvePath(normalizedCwd, p)))].sort();
	return { cwd: normalizedCwd, resolvedPaths };
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
): string {
	return createHash("sha256")
		.update(
			stableJson({
				input: getDangerFingerprintInput(toolName, input),
				scope: getDangerFingerprintScope(toolName, input, cwd, bashAnalysis),
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
		broadcastToNarrator(pending.broadcastTargetId, {
			type: "question_reflection_started",
			narratorId: pending.broadcastTargetId,
			requestId,
			toolUseId: pending.toolUseId,
			toolName: pending.toolName,
			inputJson: pending.input,
			reason,
		});
	} else {
		broadcastToNarrator(pending.broadcastTargetId, {
			type: "question_reflection_resolved",
			narratorId: pending.broadcastTargetId,
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
): ReturnType<typeof setTimeout> | undefined {
	if (!shouldScheduleQuestionReflection(effectiveMode)) return undefined;
	return setTimeout(() => {
		void reflectPendingAskUserQuestion(requestId, { automatic: true }).catch((err) => {
			logger.warn("AskUserQuestion automatic reflection failed", {
				requestId,
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}, getQuestionReflectionTimeoutMs());
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
		!!narrator.relaxedPlan,
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

	if (pending.questionReflectionTimer) {
		clearTimeout(pending.questionReflectionTimer);
		pending.questionReflectionTimer = undefined;
	}

	const questions = coerceAskQuestions(pending.input.questions);
	if (questions.length === 0) return { ok: false, reason: "No AskUserQuestion questions found" };

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
		});
		if (!pendingPermissions.has(requestId)) {
			await db
				.update(narratorToolCalls)
				.set({ permissionSuggestions: null })
				.where(eq(narratorToolCalls.id, requestId));
			return { ok: false, answers, reason: "Already resolved" };
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
		logger.warn("AskUserQuestion reflection failed", {
			requestId,
			narratorId: pending.narratorId,
			reason,
		});
		if (pendingPermissions.has(requestId)) {
			await markQuestionReflectionStatus(requestId, pending, "awaiting_user", reason);
		}
		return { ok: false, reason };
	}
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
): DangerInfo {
	const details = [
		`Tool: ${toolName}`,
		...extractToolPaths(toolName, input).map((path) => `Target path: ${resolvePath(cwd, path)}`),
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
	whitelistDirs: WhitelistDir[] = [],
	requiredLevel: "readOnly" | "readWrite" | "full" = "readOnly",
): string[] {
	const seen = new Set<string>();
	return paths
		.map((p) => resolvePath(cwd, p))
		.filter((p) => !isInsideWorktree(cwd, p) && !isInsideTruncateDir(cwd, p))
		.filter((p) => !allPathsWhitelisted(cwd, [p], whitelistDirs, requiredLevel))
		.filter((p) => {
			if (seen.has(p)) return false;
			seen.add(p);
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
	whitelistDirs: WhitelistDir[] = [],
	commandWhitelist: CommandWhitelistEntry[] = [],
	skipReadOnlyConfirmations = false,
): DangerInfo | null {
	if (!bashAnalysis) return null;
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
		getShellScopePaths(cwd, input, bashAnalysis),
		whitelistDirs,
		bashAnalysis.hasWriteOperation ? "readWrite" : "readOnly",
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
): DangerInfo | null {
	if (toolName === SHELL_TOOL_NAME)
		return classifyShellDanger(
			input,
			cwd,
			bashAnalysis,
			whitelistDirs,
			commandWhitelist,
			skipReadOnlyConfirmations,
		);

	if (toolName === "Agent") {
		if (input.subagent_type === "explore" || input.subagent_type === "plan") return null;
		const workdir = typeof input.workdir === "string" ? input.workdir : "";
		if (workdir) {
			const resolvedWorkdir = resolvePath(cwd, workdir);
			if (!pathsEqual(resolvedWorkdir, resolvePath(cwd))) {
				if (allPathsWhitelisted(cwd, [resolvedWorkdir], whitelistDirs, "full")) {
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

	// Knowledge ACL / review tools: these perform no filesystem writes (so the path
	// heuristics below never flag them), but their WRITE actions mutate shared
	// knowledge or its access control. Classify write actions as dangerous so that
	// under bypassPermissions they still trigger danger reflection; read actions
	// (and a missing action) stay null. The read/write split is the single source
	// of truth in knowledge-actions.ts, shared with the tool implementations.
	if (toolName === "KnowledgeAdmin" || toolName === "KnowledgeReview") {
		const action = typeof input.action === "string" ? input.action : "";
		if (!action || isKnowledgeReadAction(action)) return null;
		const isMerge = KNOWLEDGE_MERGE_ACTION_SET.has(action);
		return danger(
			`${toolName} performs a knowledge-base write action: ${action}.`,
			[
				"This changes shared project knowledge or its access-control configuration.",
				isMerge
					? "Merging or writing to main updates the globally-served knowledge version."
					: "ACL changes affect who can read or modify knowledge entries.",
			],
			[
				"Confirm the action and target ids are correct before proceeding.",
				"For content changes, prefer the draft → review flow when unsure.",
			],
			[`Tool: ${toolName}`, `Action: ${action}`],
			isMerge ? "high" : "medium",
		);
	}

	if (READ_ONLY_TOOLS.includes(toolName)) {
		return null;
	}

	const toolPaths = extractToolPaths(toolName, input);
	const externalPaths = describeExternalPaths(cwd, toolPaths, whitelistDirs, "readWrite");
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
	const effectiveMode = isPlanModeTrait(narrator?.traits)
		? narrator?.relaxedPlan
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

export function resolveExitPlanModeInput(
	narratorId: string,
	cwd: string,
	input: Record<string, unknown>,
	locale: Locale = "en",
):
	| { ok: true; input: Record<string, unknown>; resolvedFromFile: boolean }
	| { ok: false; message: string; input: Record<string, unknown>; resolvedFromFile: boolean } {
	const active = activeNarrators.get(narratorId);
	const planFileId = active?._planFileId;
	const allowInlinePlan = settings.agent.planModeAllowInlinePlan;
	let effectiveInput = input;
	let resolvedFromFile = false;
	if (planFileId) {
		const planFileName = `.narrafork/plan-${planFileId}.md`;
		const absPath = resolve(cwd, planFileName);
		try {
			if (existsSync(absPath)) {
				const content = readFileSync(absPath, "utf-8");
				if (content.trim()) {
					effectiveInput = { ...effectiveInput, plan: content };
					resolvedFromFile = true;
				}
			}
		} catch {
			// Ignore read errors
		}
	}
	// Inline plan is only used as a fallback when the instance allows it. When
	// inline plans are disabled, the plan must come from the designated plan file.
	if (!resolvedFromFile && allowInlinePlan) {
		const inlinePlan = typeof input.plan === "string" ? input.plan.trim() : "";
		if (inlinePlan) {
			effectiveInput = { ...effectiveInput, plan: inlinePlan };
		}
	} else if (!allowInlinePlan && typeof effectiveInput.plan === "string" && !resolvedFromFile) {
		// Strip any inline plan the model may have passed despite the disabled schema.
		const { plan: _ignored, ...rest } = effectiveInput;
		effectiveInput = rest;
	}

	const planValue = effectiveInput.plan;
	const hasPlanContent = typeof planValue === "string" && planValue.trim().length > 0;
	if (!hasPlanContent) {
		const activePfId = activeNarrators.get(narratorId)?._planFileId;
		const planFilePath = activePfId
			? `.narrafork/plan-${activePfId}.md`
			: ".narrafork/plan-<id>.md";
		return {
			ok: false,
			input: effectiveInput,
			resolvedFromFile,
			message: getToolMessageWithParams("exitPlanModeEmptyPlan", locale, {
				planFile: planFilePath,
			}),
		};
	}

	return { ok: true, input: effectiveInput, resolvedFromFile };
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

export async function handlePermission(
	narratorId: string,
	signal: AbortSignal,
	toolName: string,
	input: Record<string, unknown>,
	toolUseId: string,
	cwd: string,
	locale: Locale = "en",
	broadcastTargetId?: string,
	options?: { suppressAttention?: boolean },
): Promise<PermissionResult> {
	const wsTarget = broadcastTargetId ?? narratorId;
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
	const permMode = narrator?.permissionMode ?? "default";
	const isRelaxedPlan = !!narrator?.relaxedPlan;
	const isPlanMode = isPlanModeTrait(narrator?.traits);
	const isChapter = !!narrator?.chapterId;

	let effectiveInput = input;
	let exitPlanResolvedFromFile = false;

	// ExitPlanMode: resolve plan content from the designated plan file
	if (toolName === "ExitPlanMode") {
		const resolved = resolveExitPlanModeInput(narratorId, cwd, input, locale);
		effectiveInput = resolved.input;
		exitPlanResolvedFromFile = resolved.resolvedFromFile;
		if (!resolved.ok) {
			return {
				behavior: "deny",
				message: resolved.message,
				rawMessage: true,
			};
		}
	}

	// Shell command pre-analysis
	let bashAnalysis: BashAnalysis | undefined;
	let shellAnalysisError: string | undefined;
	// Bash await/stop are control operations (no command execution) — always allow
	const isBashControlOp =
		toolName === SHELL_TOOL_NAME && !input.command && (input.await != null || input.stop != null);
	if (toolName === SHELL_TOOL_NAME && typeof input.command === "string") {
		try {
			const shellType = detectShell().type;
			const shellCwd = resolveToolCwd(cwd, effectiveInput);
			bashAnalysis = await analyzeShellCommand(input.command, shellCwd, shellType, isChapter);
		} catch (err) {
			shellAnalysisError = err instanceof Error ? err.message : String(err);
			logger.warn("Bash command analysis failed; unsafe auto-allow will be blocked", {
				error: shellAnalysisError,
			});
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
			const absPath = resolvePath(cwd, filePath);
			const planFilePath = resolvePath(cwd, `.narrafork/plan-${planFileId}.md`);
			if (!pathsEqual(absPath, planFilePath)) {
				const fileName = filePath.split("/").pop()?.toLowerCase() ?? "";
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
			const absPath = resolvePath(cwd, filePath);
			if (!pathsEqual(absPath, subagentConcEntry.absPath)) {
				effectiveInput = { ...effectiveInput, file_path: conclusionRelPath };
				conclusionRedirectNotice =
					`File path redirected: "${filePath}" → "${conclusionRelPath}". ` +
					`As an explore/plan subagent, all Write/Edit operations target the conclusion file.`;
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

	// Load enabled whitelist/blacklist directories — three-layer merge
	const dirOwnerId =
		narrator && isSubagentVariant(narrator.variant) && narrator.parentNarratorId
			? narrator.parentNarratorId
			: narratorId;

	// Layer 1: global settings
	const globalWl: WhitelistDir[] = (settings.agent.whitelistDirs ?? [])
		.filter((d) => d.enabled !== false)
		.map((d) => ({ path: d.path, accessLevel: d.accessLevel, enabled: true }));
	const globalBl: BlacklistDir[] = (settings.agent.blacklistDirs ?? [])
		.filter((d) => d.enabled !== false)
		.map((d) => ({
			path: d.path,
			denyLevel: d.denyLevel,
			enabled: true,
			source: "global" as const,
		}));

	// Layer 2: project chapterSettings
	let projectWl: WhitelistDir[] = [];
	let projectBl: BlacklistDir[] = [];
	let projectCmdWl: CommandWhitelistEntry[] = [];
	let projectCmdBl: CommandBlacklistEntry[] = [];
	let resolvedProjectGitPath: string | undefined;
	if (narrator?.chapterId) {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, narrator.chapterId),
			columns: { projectId: true },
		});
		if (chapter?.projectId) {
			const project = await db.query.projects.findFirst({
				where: eq(projects.id, chapter.projectId),
				columns: { chapterSettings: true, gitPath: true },
			});
			if (project?.gitPath) resolvedProjectGitPath = project.gitPath;
			const cs = project?.chapterSettings as
				| {
						whitelistDirs?: Array<{
							path: string;
							accessLevel?: WhitelistDir["accessLevel"];
							enabled?: boolean;
						}>;
						blacklistDirs?: Array<{
							path: string;
							denyLevel?: BlacklistDir["denyLevel"];
							enabled?: boolean;
						}>;
						commandWhitelist?: Array<{
							pattern: string;
							enabled?: boolean;
						}>;
						commandBlacklist?: Array<{
							pattern: string;
							denyPrompt?: string | null;
							enabled?: boolean;
						}>;
				  }
				| undefined;
			if (cs?.whitelistDirs) {
				projectWl = cs.whitelistDirs
					.filter((d) => d.enabled !== false)
					.map((d) => ({
						path: d.path,
						accessLevel: d.accessLevel ?? "readOnly",
						enabled: true,
					}));
			}
			if (cs?.blacklistDirs) {
				projectBl = cs.blacklistDirs
					.filter((d) => d.enabled !== false)
					.map((d) => ({
						path: d.path,
						denyLevel: d.denyLevel ?? "denyAll",
						enabled: true,
						source: "project" as const,
					}));
			}
			if (cs?.commandWhitelist) {
				projectCmdWl = cs.commandWhitelist
					.filter((d) => d.enabled !== false)
					.map((d) => ({
						pattern: d.pattern,
						enabled: true,
						source: "project" as const,
					}));
			}
			if (cs?.commandBlacklist) {
				projectCmdBl = cs.commandBlacklist
					.filter((d) => d.enabled !== false)
					.map((d) => ({
						pattern: d.pattern,
						denyPrompt: d.denyPrompt,
						enabled: true,
						source: "project" as const,
					}));
			}
		}
	}

	// Layer 3: narrator-level DB rows
	const wlRows = await db.query.narratorWhitelistDirs.findMany({
		where: and(
			eq(narratorWhitelistDirs.narratorId, dirOwnerId),
			eq(narratorWhitelistDirs.enabled, true),
		),
		columns: { path: true, accessLevel: true, enabled: true },
	});
	const blRows = await db.query.narratorBlacklistDirs.findMany({
		where: and(
			eq(narratorBlacklistDirs.narratorId, dirOwnerId),
			eq(narratorBlacklistDirs.enabled, true),
		),
		columns: { path: true, denyLevel: true, enabled: true },
	});

	const mergedWhitelist: WhitelistDir[] = [
		...globalWl,
		...projectWl,
		...(wlRows as WhitelistDir[]),
	];
	const mergedBlacklist: BlacklistDir[] = [
		...globalBl,
		...projectBl,
		...blRows.map((r) => ({ ...r, source: "narrator" as const })),
	];

	// Command whitelist/blacklist: three-layer merge
	const globalCmdWl: CommandWhitelistEntry[] = (settings.agent.commandWhitelist ?? [])
		.filter((d) => d.enabled !== false)
		.map((d) => ({ pattern: d.pattern, enabled: true, source: "global" as const }));
	const globalCmdBl: CommandBlacklistEntry[] = (settings.agent.commandBlacklist ?? [])
		.filter((d) => d.enabled !== false)
		.map((d) => ({
			pattern: d.pattern,
			denyPrompt: d.denyPrompt,
			enabled: true,
			source: "global" as const,
		}));

	const cmdWlRows = await db.query.narratorWhitelistCmds.findMany({
		where: and(
			eq(narratorWhitelistCmds.narratorId, dirOwnerId),
			eq(narratorWhitelistCmds.enabled, true),
		),
		columns: { pattern: true, enabled: true },
	});
	const cmdBlRows = await db.query.narratorBlacklistCmds.findMany({
		where: and(
			eq(narratorBlacklistCmds.narratorId, dirOwnerId),
			eq(narratorBlacklistCmds.enabled, true),
		),
		columns: { pattern: true, denyPrompt: true, enabled: true },
	});

	const mergedCmdWhitelist: CommandWhitelistEntry[] = [
		...globalCmdWl,
		...projectCmdWl,
		...cmdWlRows.map((r) => ({ ...r, source: "narrator" as const })),
	];
	const mergedCmdBlacklist: CommandBlacklistEntry[] = [
		...globalCmdBl,
		...projectCmdBl,
		...cmdBlRows.map((r) => ({ ...r, source: "narrator" as const })),
	];

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

	let decision =
		toolName === "Send" &&
		(await shouldAutoAllowSendWithinScope(narratorId, narrator, effectiveInput))
			? "allow"
			: resolvePermissionDecision({
					toolName,
					input: effectiveInput,
					permMode,
					cwd,
					bashAnalysis,
					isChapter,
					planFileId,
					planMode: isPlanMode,
					conclusionFileId,
					whitelistDirs: mergedWhitelist,
					blacklistDirs: mergedBlacklist,
					commandWhitelist: mergedCmdWhitelist,
					commandBlacklist: mergedCmdBlacklist,
					relaxedPlan: isRelaxedPlan,
					previousPermissionMode: narrator?.previousPermissionMode ?? undefined,
					meta: permMeta,
					projectGitPath: resolvedProjectGitPath,
					webFetchPolicy: settings.agent.webFetchPolicy,
				});
	logger.debug("Permission decision", {
		narratorId,
		toolName,
		decision,
		permMode,
		cwd,
		whitelistDirCount: mergedWhitelist.length,
		blacklistDirCount: mergedBlacklist.length,
		whitelistDirs: mergedWhitelist.map((d) => ({ path: d.path, accessLevel: d.accessLevel })),
		blacklistDirs: mergedBlacklist.map((d) => ({ path: d.path, denyLevel: d.denyLevel })),
		bashAnalysisAvailable: !!bashAnalysis,
		bashFilePaths: bashAnalysis?.filePaths,
		bashNonWhitelisted: bashAnalysis?.nonWhitelisted,
		bashHasWrite: bashAnalysis?.hasWriteOperation,
	});

	const effectiveMode = getEffectivePermissionMode(
		permMode,
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
		if (wsTarget !== narratorId) {
			await narratorService.updateStatus(wsTarget, "waiting", {
				substatus: ["reflecting"],
			});
		}
		if (signal.aborted) {
			await markDangerReflectionAborted(requestId, wsTarget, toolUseId, narratorId, {
				danger,
				fingerprint,
				startedAt: startedAtMs,
			});
			return { behavior: "deny", message: "Narrator aborted" };
		}

		const decisionPromise = new Promise<PermissionResult>((resolve) => {
			let cleanup = () => {};
			const onAbort = () => {
				void markDangerReflectionAborted(requestId, wsTarget, toolUseId, narratorId, undefined, {
					cleanup: true,
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
				input: effectiveInput,
				fingerprint,
				danger,
				startedAt: startedAtMs,
				planModeSoftDeny: opts.planModeSoftDeny,
				resolve,
				cleanup,
			});
		});
		broadcastToNarrator(wsTarget, {
			type: "danger_reflection_started",
			narratorId: wsTarget,
			requestId,
			toolUseId,
			toolName,
			danger,
		});
		return {
			behavior: "dangerReflection",
			requestId,
			danger,
			fingerprint,
			reflectionLevel: dangerReflectionLevel === "off" ? undefined : dangerReflectionLevel,
			input: effectiveInput,
			decision: decisionPromise,
		};
	};
	if (
		decision === "allow" &&
		effectiveMode === "bypassPermissions" &&
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
						mergedWhitelist,
						mergedCmdWhitelist,
						settings.agent.dangerSkipReadOnlyConfirmations,
					);
		if (danger && shouldTriggerDangerReflection(danger, dangerReflectionLevel)) {
			const fingerprint = createDangerFingerprint(toolName, effectiveInput, cwd, bashAnalysis);
			const pause = await startDangerReflectionPause(danger, fingerprint);
			if (pause) return pause;
		}
	}

	if (decision === "fatal") {
		const reason = bashAnalysis?.catastrophicReason ?? "catastrophic command detected";
		const fatalMsg = `FATAL: ${reason}. Narrator terminated for safety.`;
		logger.error("Catastrophic command blocked", {
			narratorId,
			toolName,
			toolUseId,
			reason,
			command: typeof input.command === "string" ? input.command : undefined,
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
					eq(narratorToolCalls.narratorId, narratorId),
					eq(narratorToolCalls.toolUseId, toolUseId),
				),
			);
		return { behavior: "deny", message: fatalMsg, fatal: true };
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
						mergedWhitelist,
						mergedCmdWhitelist,
						settings.agent.dangerSkipReadOnlyConfirmations,
					);
		const danger = buildPlanModeSoftDenyDanger(toolName, effectiveInput, cwd, baseDanger);
		const fingerprint = `plan_mode_soft_deny:${createDangerFingerprint(
			toolName,
			effectiveInput,
			cwd,
			bashAnalysis,
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

	broadcastToNarrator(wsTarget, {
		type: "permission_request",
		narratorId: wsTarget,
		request: { id: toolCallId, toolName, toolUseId, inputJson: effectiveInput, decisionReason },
	});
	eventBus.emit({ type: "narrator:permission_request", narratorId, requestId: toolCallId });
	// A real permission request is waiting for the user — emit the semantic
	// attention intent so notification consumers can alert the user. Suppressed
	// when the caller (e.g. plan-reflection takeover fallback) drives this itself.
	if (!options?.suppressAttention) {
		eventBus.emit({ type: "narrator:attention", narratorId, reason: "waiting_permission" });
	}
	await narratorService.updateStatus(narratorId, "waiting");
	if (broadcastTargetId && broadcastTargetId !== narratorId) {
		await narratorService.updateStatus(broadcastTargetId, "waiting");
	}

	if (signal.aborted) {
		broadcastToNarrator(wsTarget, {
			type: "permission_resolved",
			narratorId: wsTarget,
			requestId: toolCallId,
			toolUseId,
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
			if (broadcastTargetId && broadcastTargetId !== narratorId) {
				await narratorService.updateStatus(broadcastTargetId, "working");
			}
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
			cwd,
			locale,
			signal,
			planModeSoftDeny: promotedPlanSoftDeny || undefined,
			planSubmittedFromFile:
				toolName === "ExitPlanMode" && exitPlanResolvedFromFile ? true : undefined,
		};
		pendingPermissions.set(toolCallId, pendingEntry);
		if (toolName === "AskUserQuestion") {
			pendingEntry.questionReflectionTimer = scheduleQuestionReflection(toolCallId, effectiveMode);
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
		...(pending.narratorId !== pending.broadcastTargetId
			? { subagentNarratorId: pending.narratorId }
			: {}),
		...(updatedInput ? { updatedInput } : {}),
		...(decidedByNarrator ? { decidedByNarrator } : {}),
		...(decision === "deny" && (denyMessage || feedbackText?.trim())
			? { feedbackText: denyMessage || feedbackText?.trim() }
			: {}),
	});

	try {
		await narratorService.updateStatus(pending.narratorId, "working");
		if (pending.broadcastTargetId !== pending.narratorId) {
			await narratorService.updateStatus(pending.broadcastTargetId, "working");
		}
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
	status: "running" | "awaiting_user" | "confirmed" | "cancelled" | "aborted",
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

async function markDangerReflectionAborted(
	requestId: string,
	broadcastTargetId: string,
	toolUseId: string,
	narratorId: string,
	fallback?: Pick<PendingDangerReflection, "danger" | "fingerprint" | "startedAt">,
	options: { cleanup?: boolean } = {},
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
		broadcastToNarrator(broadcastTargetId, {
			type: "danger_reflection_resolved",
			narratorId: broadcastTargetId,
			requestId,
			toolUseId,
			decision: "aborted",
			reason: "Narrator aborted",
		});
		await narratorService.updateStatus(narratorId, "working").catch(() => {});
		if (broadcastTargetId !== narratorId) {
			await narratorService.updateStatus(broadcastTargetId, "working").catch(() => {});
		}
	} catch (err) {
		logger.warn("Failed to mark danger reflection as aborted", {
			requestId,
			narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
	} finally {
		await narratorService.updateStatus(narratorId, "working").catch(() => {});
		if (broadcastTargetId !== narratorId) {
			await narratorService.updateStatus(broadcastTargetId, "working").catch(() => {});
		}
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
			toolUseId: true,
			status: true,
			permissionSuggestions: true,
		},
	});
	if (!toolCall) return false;

	const existingReflection = getPersistedDangerReflectionSuggestion(toolCall.permissionSuggestions);
	if (!existingReflection) return false;
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, toolCall.narratorId),
		columns: { parentNarratorId: true },
	});
	const broadcastTargetIds = [
		...new Set(
			[toolCall.narratorId, narrator?.parentNarratorId].filter((id): id is string => !!id),
		),
	];
	const broadcastResolved = (decision: "allow" | "deny" | "aborted", resolvedReason?: string) => {
		for (const targetId of broadcastTargetIds) {
			broadcastToNarrator(targetId, {
				type: "danger_reflection_resolved",
				narratorId: targetId,
				requestId,
				toolUseId: toolCall.toolUseId,
				decision,
				reason: resolvedReason,
			});
		}
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
		broadcastToNarrator(pause.broadcastTargetId, {
			type: "danger_reflection_stopped",
			narratorId: pause.broadcastTargetId,
			requestId,
			toolUseId: pause.toolUseId,
			toolName: pause.toolName,
			danger: pause.danger,
			inputJson: pause.input,
			reason: message,
		});
		await narratorService.updateStatus(pause.narratorId, "waiting", {
			substatus: ["reflecting"],
		});
		if (pause.broadcastTargetId !== pause.narratorId) {
			await narratorService.updateStatus(pause.broadcastTargetId, "waiting", {
				substatus: ["reflecting"],
			});
		}
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
		broadcastToNarrator(pause.broadcastTargetId, {
			type: "danger_reflection_resolved",
			narratorId: pause.broadcastTargetId,
			requestId,
			toolUseId: pause.toolUseId,
			decision: "allow",
			reason,
		});
		if (pause.planModeSoftDeny) {
			await enableRelaxedPlanAfterPlanSoftDeny(pause.narratorId, pause.broadcastTargetId);
		}
		await narratorService.updateStatus(pause.narratorId, "working").catch(() => {});
		if (pause.broadcastTargetId !== pause.narratorId) {
			await narratorService.updateStatus(pause.broadcastTargetId, "working").catch(() => {});
		}
	} catch (err) {
		logger.warn("Failed to finalize confirmed danger reflection", {
			requestId,
			narratorId: pause.narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
	} finally {
		await narratorService.updateStatus(pause.narratorId, "working").catch(() => {});
		if (pause.broadcastTargetId !== pause.narratorId) {
			await narratorService.updateStatus(pause.broadcastTargetId, "working").catch(() => {});
		}
		pause.resolve(result);
	}
	return true;
}

export async function cancelDangerReflection(
	requestId: string,
	reason?: string,
	decidedBy: DangerReflectionDecidedBy = "reflection",
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
				permissionSuggestions: dangerReflectionSuggestions(pause, "cancelled", message),
			})
			.where(eq(narratorToolCalls.id, pause.toolCallId));
		broadcastToNarrator(pause.broadcastTargetId, {
			type: "danger_reflection_resolved",
			narratorId: pause.broadcastTargetId,
			requestId,
			toolUseId: pause.toolUseId,
			decision: "deny",
			reason: message,
		});
		await narratorService.updateStatus(pause.narratorId, "working").catch(() => {});
		if (pause.broadcastTargetId !== pause.narratorId) {
			await narratorService.updateStatus(pause.broadcastTargetId, "working").catch(() => {});
		}
	} catch (err) {
		logger.warn("Failed to finalize cancelled danger reflection", {
			requestId,
			narratorId: pause.narratorId,
			error: err instanceof Error ? err.message : String(err),
		});
	} finally {
		await narratorService.updateStatus(pause.narratorId, "working").catch(() => {});
		if (pause.broadcastTargetId !== pause.narratorId) {
			await narratorService.updateStatus(pause.broadcastTargetId, "working").catch(() => {});
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
	if (pending.broadcastTargetId !== pending.narratorId) {
		await narratorService.updateStatus(pending.broadcastTargetId, "working").catch(() => {});
	}
}

export function reprocessAllPendingPermissions(narratorId: string): number {
	const toReprocess = [...pendingPermissions.entries()].filter(
		([, pending]) => pending.narratorId === narratorId || pending.broadcastTargetId === narratorId,
	);

	for (const [requestId, pending] of toReprocess) {
		pending.cleanup();
		broadcastToNarrator(pending.broadcastTargetId, {
			type: "permission_resolved",
			narratorId: pending.broadcastTargetId,
			requestId,
			toolUseId: pending.toolUseId,
			...(pending.narratorId !== pending.broadcastTargetId
				? { subagentNarratorId: pending.narratorId }
				: {}),
		});

		void handlePermission(
			pending.narratorId,
			pending.signal,
			pending.toolName,
			pending.input,
			pending.toolUseId,
			pending.cwd,
			pending.locale,
			pending.broadcastTargetId,
			// Re-evaluating an already-pending request (e.g. on switch to
			// bypassPermissions). The user was already notified when it first became
			// pending, so suppress a duplicate attention notification.
			{ suppressAttention: true },
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
