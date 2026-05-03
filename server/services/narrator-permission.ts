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
import type { PermissionResult } from "../lib/agent";
import { analyzeShellCommand, type BashAnalysis } from "../lib/agent/bash-analyze";
import { detectShell } from "../lib/agent/shell";
import { toolRegistry } from "../lib/agent/tool-registry";
import { SHELL_TOOL_NAME } from "../lib/agent/tools/bash";
import { OUTPUT_DIR as TRUNCATE_OUTPUT_DIR } from "../lib/agent/truncate";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { isSubagentVariant } from "../lib/narrator-utils";
import { isInsidePath, pathsEqual, resolvePath } from "../lib/platform-path";
import { getToolMessage, getToolMessageWithParams, type Locale } from "../lib/prompt-i18n";
import { settings } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { backgroundTaskService } from "./background-task-service";
import { narratorService } from "./narrator-service";
import {
	activeNarrators,
	pendingFeedback,
	pendingPermissions,
	pendingPlanApprover,
	pendingPlanCompact,
	pendingPlanDiff,
	pendingYoloDangerConfirmations,
	pendingYoloPauses,
	planModeAskedOnce,
} from "./narrator-session-state";
import { resolveTaskAlias } from "./subagent-alias";
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
		case "MultiEdit":
			return typeof input.file_path === "string" ? [input.file_path] : [];
		case "ShareFile":
			return typeof input.path === "string" ? [input.path] : [];
		case "Glob":
		case "Grep":
			return typeof input.path === "string" ? [input.path] : [];
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
		previousPermissionMode,
		meta,
		projectGitPath,
	} = opts;
	if (toolName === SHELL_TOOL_NAME && bashAnalysis?.isCatastrophic) return "fatal";
	if (toolName === SHELL_TOOL_NAME && isChapter && bashAnalysis?.gitBranchViolations?.length)
		return "deny";
	if (toolName === SHELL_TOOL_NAME && isChapter && bashAnalysis?.gitBranchWarnings?.length)
		return "ask";

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

	if (permMode === "plan" && (toolName === "Write" || toolName === "Edit")) {
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

	const effectiveMode =
		permMode === "plan"
			? relaxedPlan
				? (previousPermissionMode ?? "default")
				: "readOnly"
			: permMode;
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

	// Blacklist takes priority over whitelist
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
	"GetGoals",
	"UpdateGoal",
];

const ACCEPT_EDITS_AUTO_ALLOW = [
	"Edit",
	"Write",
	"NotebookEdit",
	"MultiEdit",
	"Read",
	"Glob",
	"Grep",
];

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

function areUnsafeCommandsWhitelistedForYolo(
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

const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit", "MultiEdit"]);
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
	if (WRITE_TOOLS.has(toolName)) {
		const filePath = typeof input.file_path === "string" ? input.file_path : "";
		if (!filePath) return null;
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

const YOLO_DANGER_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

export interface YoloDangerInfo {
	summary: string;
	consequences: string[];
	saferAlternatives: string[];
	details?: string[];
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => a.localeCompare(b));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

function getYoloFingerprintScope(
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
 * 这确保 AI 模型重试相同命令时（即使 description 措辞不同）能匹配到之前的 YOLO 确认。
 */
function getYoloFingerprintInput(
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

export function createYoloDangerFingerprint(
	toolName: string,
	input: Record<string, unknown>,
	cwd?: string,
	bashAnalysis?: BashAnalysis,
): string {
	return createHash("sha256")
		.update(
			stableJson({
				input: getYoloFingerprintInput(toolName, input),
				scope: getYoloFingerprintScope(toolName, input, cwd, bashAnalysis),
				toolName,
			}),
		)
		.digest("hex");
}

function pruneExpiredYoloConfirmations(now = Date.now()): void {
	for (const [key, entry] of pendingYoloDangerConfirmations) {
		if (entry.expiresAt < now) pendingYoloDangerConfirmations.delete(key);
	}
}

function yoloConfirmationKey(narratorId: string, fingerprint: string): string {
	return `${narratorId}:${fingerprint}`;
}

function consumeYoloConfirmation(narratorId: string, fingerprint: string): boolean {
	pruneExpiredYoloConfirmations();
	const key = yoloConfirmationKey(narratorId, fingerprint);
	const entry = pendingYoloDangerConfirmations.get(key);
	if (!entry) return false;
	pendingYoloDangerConfirmations.delete(key);
	return true;
}

function rememberYoloConfirmation(
	narratorId: string,
	fingerprint: string,
	danger: YoloDangerInfo,
): void {
	const now = Date.now();
	pruneExpiredYoloConfirmations(now);
	pendingYoloDangerConfirmations.set(yoloConfirmationKey(narratorId, fingerprint), {
		narratorId,
		fingerprint,
		expiresAt: now + YOLO_DANGER_CONFIRMATION_TTL_MS,
		summary: danger.summary,
	});
}

function getEffectivePermissionMode(
	permMode: string,
	relaxedPlan: boolean,
	previousPermissionMode?: string | null,
): string {
	return permMode === "plan"
		? relaxedPlan
			? (previousPermissionMode ?? "default")
			: "readOnly"
		: permMode;
}

function danger(
	summary: string,
	consequences: string[],
	saferAlternatives: string[],
	details?: string[],
): YoloDangerInfo {
	return { summary, consequences, saferAlternatives, details };
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

function classifyGitDanger(cmdText: string, tokens: string[]): YoloDangerInfo | null {
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
		);
	}
	if (sub === "checkout" && checkoutRestoresPath(args)) {
		return danger(
			"Git checkout is being used to restore paths and may discard local changes.",
			["Modified files can be reverted without preserving the previous content."],
			["Inspect git diff first.", "Restore only the specific files that must be reverted."],
			detail,
		);
	}
	if (sub === "restore") {
		return danger(
			"Git restore may discard local file changes.",
			["Affected files can be reverted without preserving the previous content."],
			["Inspect git diff first.", "Restore only specific files rather than the whole tree."],
			detail,
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
		);
	}
	if (sub === "branch" && hasAny(["-d", "-D", "--delete"])) {
		return danger(
			"Git branch deletion removes a local branch reference.",
			["Commits reachable only from that branch can become difficult to find."],
			["Check git branch --merged and note the commit hash before deleting."],
			detail,
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
		);
	}
	if (sub === "rm") {
		return danger(
			"Git rm deletes tracked files from the worktree and index.",
			["Files will be removed and staged for deletion."],
			["Use git status first.", "Remove only specific intended files."],
			detail,
		);
	}
	if (sub === "reflog" && args.includes("expire")) {
		return danger(
			"Git reflog expire can destroy recovery points.",
			["Future recovery from accidental resets or rebases may become impossible."],
			["Avoid expiring reflogs during agent work unless explicitly required."],
			detail,
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
		);
	}
	return null;
}

function classifyShellDanger(
	input: Record<string, unknown>,
	cwd: string,
	bashAnalysis: BashAnalysis | undefined,
	whitelistDirs: WhitelistDir[] = [],
	commandWhitelist: CommandWhitelistEntry[] = [],
): YoloDangerInfo | null {
	if (!bashAnalysis) return null;
	const unsafeCommandsWhitelisted = areUnsafeCommandsWhitelistedForYolo(
		bashAnalysis,
		commandWhitelist,
	);
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
			);
		}
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
		);
	}
	if (bashAnalysis.dangerousPatterns.length > 0 && !unsafeCommandsWhitelisted) {
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
			bashAnalysis.dangerousPatterns,
		);
	}
	if (!bashAnalysis.hasWriteOperation) return null;
	const externalPaths = describeExternalPaths(
		cwd,
		getShellScopePaths(cwd, input, bashAnalysis),
		whitelistDirs,
		"readWrite",
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
		);
	}
	return null;
}

export function classifyYoloDanger(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	bashAnalysis?: BashAnalysis,
	whitelistDirs: WhitelistDir[] = [],
	commandWhitelist: CommandWhitelistEntry[] = [],
	_skipReadOnlyConfirmations = false,
): YoloDangerInfo | null {
	if (toolName === SHELL_TOOL_NAME)
		return classifyShellDanger(input, cwd, bashAnalysis, whitelistDirs, commandWhitelist);

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
		);
	}

	if (toolName === "Write") {
		const filePath = typeof input.file_path === "string" ? input.file_path : "";
		if (filePath && existsSync(resolvePath(cwd, filePath))) {
			return danger(
				"Write will overwrite an existing file.",
				[
					"Existing content can be replaced in one operation.",
					"If the file contains user changes, they may be difficult to reconstruct.",
				],
				[
					"Read the file and use Edit for a smaller diff.",
					"Create a backup or inspect git diff first.",
				],
				[`File: ${resolvePath(cwd, filePath)}`],
			);
		}
	}

	return null;
}

function buildYoloDangerMessage(danger: YoloDangerInfo): string {
	const lines = [
		"YOLO safety pause: this operation was NOT executed.",
		"",
		"Detected high-risk operation:",
		`- ${danger.summary}`,
	];
	if (danger.details?.length) {
		lines.push("", "Details:", ...danger.details.map((d) => `- ${d}`));
	}
	lines.push("", "Possible consequences:", ...danger.consequences.map((c) => `- ${c}`));
	lines.push(
		"",
		"Safer alternatives to consider:",
		...danger.saferAlternatives.map((a) => `- ${a}`),
	);
	lines.push(
		"",
		"This operation is paused and still pending. A separate safety reflection loop must call YoloConfirm to proceed or YoloCancel to cancel. The user may also approve or deny the pending permission from the UI.",
	);
	return lines.join("\n");
}

type PermissionScopeNarrator = {
	id?: string | null;
	variant?: string | null;
	parentNarratorId?: string | null;
	permissionMode?: string | null;
	relaxedPlan?: boolean | null;
	previousPermissionMode?: string | null;
};

function permissionModeRank(narrator: PermissionScopeNarrator | null | undefined): number {
	const permMode = narrator?.permissionMode ?? "default";
	const effectiveMode =
		permMode === "plan"
			? narrator?.relaxedPlan
				? (narrator.previousPermissionMode ?? "default")
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
			return s.id === selector || s.id.startsWith(selector) || s.title === selector;
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

export async function handlePermission(
	narratorId: string,
	signal: AbortSignal,
	toolName: string,
	input: Record<string, unknown>,
	toolUseId: string,
	cwd: string,
	locale: Locale = "en",
	broadcastTargetId?: string,
): Promise<PermissionResult> {
	const wsTarget = broadcastTargetId ?? narratorId;
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: {
			permissionMode: true,
			chapterId: true,
			relaxedPlan: true,
			previousPermissionMode: true,
			variant: true,
			parentNarratorId: true,
		},
	});
	const permMode = narrator?.permissionMode ?? "default";
	const isRelaxedPlan = !!narrator?.relaxedPlan;
	const isPlanMode = permMode === "plan";
	const isChapter = !!narrator?.chapterId;

	let effectiveInput = input;

	// ExitPlanMode: resolve plan content from the designated plan file
	if (toolName === "ExitPlanMode") {
		const active = activeNarrators.get(narratorId);
		const planFileId = active?._planFileId;
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
		if (!resolvedFromFile) {
			const inlinePlan = typeof input.plan === "string" ? input.plan.trim() : "";
			if (inlinePlan) {
				effectiveInput = { ...effectiveInput, plan: inlinePlan };
			}
		}

		const planValue = effectiveInput.plan;
		const hasPlanContent = typeof planValue === "string" && planValue.trim().length > 0;
		if (!hasPlanContent) {
			const activePfId = activeNarrators.get(narratorId)?._planFileId;
			const planFilePath = activePfId
				? `.narrafork/plan-${activePfId}.md`
				: ".narrafork/plan-<id>.md";
			return {
				behavior: "deny",
				message: getToolMessageWithParams("exitPlanModeEmptyPlan", locale, {
					planFile: planFilePath,
				}),
				rawMessage: true,
			};
		}
	}

	// Shell command pre-analysis
	let bashAnalysis: BashAnalysis | undefined;
	// Bash await/stop are control operations (no command execution) — always allow
	const isBashControlOp =
		toolName === SHELL_TOOL_NAME && !input.command && (input.await != null || input.stop != null);
	if (toolName === SHELL_TOOL_NAME && typeof input.command === "string") {
		try {
			const shellType = detectShell().type;
			const shellCwd = resolveToolCwd(cwd, effectiveInput);
			bashAnalysis = await analyzeShellCommand(input.command, shellCwd, shellType, isChapter);
		} catch (err) {
			logger.warn("Bash command analysis failed, falling back to ask", { err });
		}
	}

	const planFileId = isPlanMode ? activeNarrators.get(narratorId)?._planFileId : undefined;

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
		isRelaxedPlan,
		narrator?.previousPermissionMode,
	);
	if (decision === "allow" && effectiveMode === "bypassPermissions") {
		const danger = classifyYoloDanger(
			toolName,
			effectiveInput,
			cwd,
			bashAnalysis,
			mergedWhitelist,
			mergedCmdWhitelist,
			settings.agent.yoloSkipReadOnlyConfirmations,
		);
		if (danger) {
			const fingerprint = createYoloDangerFingerprint(toolName, effectiveInput, cwd, bashAnalysis);
			if (!consumeYoloConfirmation(narratorId, fingerprint)) {
				const warning = buildYoloDangerMessage(danger);
				const toolCallRecord = await db.query.narratorToolCalls.findFirst({
					where: and(
						eq(narratorToolCalls.narratorId, narratorId),
						eq(narratorToolCalls.toolUseId, toolUseId),
					),
				});
				if (!toolCallRecord) {
					logger.error("Tool call record not found for YOLO pause", { narratorId, toolUseId });
					return { behavior: "deny", message: "Internal error: tool call record not found" };
				}
				const toolCallId = toolCallRecord.id;
				const yoloReflectionSuggestion = {
					type: "yolo_reflection",
					status: "running",
					message:
						"AI safety reflection loop is running. It has one chance to call YoloConfirm or YoloCancel.",
					requestId: toolCallId,
					startedAt: new Date().toISOString(),
				};
				logger.warn("YOLO high-risk operation paused", {
					narratorId,
					toolName,
					toolUseId,
					fingerprint,
					summary: danger.summary,
				});
				await db
					.update(narratorToolCalls)
					.set({
						status: "pending",
						inputJson: effectiveInput,
						permissionStartedAt: new Date().toISOString(),
						permissionDecisionReason: `YOLO safety pause: ${danger.summary}`,
						permissionSuggestions: [yoloReflectionSuggestion],
					})
					.where(eq(narratorToolCalls.id, toolCallId));

				broadcastToNarrator(wsTarget, {
					type: "permission_request",
					narratorId: wsTarget,
					request: {
						id: toolCallId,
						toolName,
						toolUseId,
						inputJson: effectiveInput,
						decisionReason: `YOLO safety pause: ${danger.summary}`,
						suggestions: [yoloReflectionSuggestion],
					},
				});
				eventBus.emit({ type: "narrator:permission_request", narratorId, requestId: toolCallId });
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

				const decisionPromise = new Promise<PermissionResult>((resolve) => {
					const cleanup = () => {
						signal.removeEventListener("abort", onAbort);
						pendingPermissions.delete(toolCallId);
						pendingYoloPauses.delete(toolCallId);
					};
					const onAbort = async () => {
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
						resolve({ behavior: "deny", message: "Narrator aborted" });
					};
					signal.addEventListener("abort", onAbort, { once: true });
					pendingPermissions.set(toolCallId, {
						resolve,
						cleanup,
						input: effectiveInput,
						narratorId,
						toolName,
						toolUseId,
						broadcastTargetId: wsTarget,
					});
				});
				pendingYoloPauses.set(toolCallId, {
					narratorId,
					requestId: toolCallId,
					toolUseId,
					toolName,
					input: effectiveInput,
					fingerprint,
					danger,
					startedAt: Date.now(),
				});
				return {
					behavior: "yoloPause",
					requestId: toolCallId,
					toolCallId,
					message: warning,
					danger,
					fingerprint,
					decision: decisionPromise,
				};
			}
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
		const isPlanModeSoftDeny =
			isPlanMode &&
			!isRelaxedPlan &&
			!permMeta.commandBlacklistReason &&
			!(isChapter && bashAnalysis?.gitBranchViolations?.length) &&
			(permMeta.planModeSoftDeny || !permMeta.blacklistReason);
		if (isPlanModeSoftDeny && !planModeAskedOnce.has(narratorId)) {
			planModeAskedOnce.add(narratorId);
			promotedPlanSoftDeny = true;
			decision = "ask";
		}
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
		const branchViolations = bashAnalysis?.gitBranchViolations;
		const isReadToolPathDenied =
			(permMode === "readOnly" || permMode === "plan") &&
			(READ_ONLY_TOOLS.includes(toolName) ||
				(toolName === SHELL_TOOL_NAME &&
					bashAnalysis &&
					!bashAnalysis.hasWriteOperation &&
					bashAnalysis.nonWhitelisted.length === 0 &&
					!bashAnalysis.dangerousPatterns.length &&
					!bashAnalysis.hasEnvInjection));
		const denyMsg =
			isChapter && branchViolations?.length
				? `DENIED: Chapter mode restricts git branch operations. Violations: ${branchViolations.join("; ")}. You may only work on the current branch.`
				: isReadToolPathDenied
					? getToolMessage("permissionDeniedPathOutsideScope", locale)
					: permMode === "plan"
						? getToolMessage("permissionDeniedPlanMode", locale)
						: permMode === "readOnly"
							? getToolMessage("permissionDeniedReadOnly", locale)
							: getToolMessage("permissionDeniedNonInteractive", locale);
		const decisionReason =
			isChapter && branchViolations?.length ? branchViolations.join("; ") : undefined;
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
	if (isChapter && bashAnalysis?.gitBranchWarnings?.length) {
		const warningMsg = `Chapter branch warnings: ${bashAnalysis.gitBranchWarnings.join("; ")}`;
		decisionReason = decisionReason ? `${decisionReason}; ${warningMsg}` : warningMsg;
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
		const cleanup = () => {
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

		pendingPermissions.set(toolCallId, {
			resolve,
			cleanup,
			input: effectiveInput,
			narratorId,
			toolName,
			toolUseId,
			broadcastTargetId: wsTarget,
			planModeSoftDeny: promotedPlanSoftDeny || undefined,
		});
	});
}

export interface ResolvePermissionOpts {
	denyMessage?: string;
	answers?: Record<string, string>;
	feedbackText?: string;
	compactAfter?: boolean;
	updatedPlan?: string;
	userId?: string;
}

/** Called from WebSocket when user makes a permission decision */
export async function resolvePermission(
	requestId: string,
	decision: "allow" | "deny",
	opts: ResolvePermissionOpts = {},
): Promise<boolean> {
	const { denyMessage, answers, feedbackText, compactAfter, updatedPlan, userId } = opts;
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

	const yoloPause = pendingYoloPauses.get(requestId);
	pending.cleanup();

	let updatedInput: Record<string, unknown> | undefined;
	if (answers) {
		updatedInput = { ...pending.input, answers };
	} else if (updatedPlan !== undefined && pending.toolName === "ExitPlanMode") {
		updatedInput = { ...pending.input, plan: updatedPlan };
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
				permissionDecidedBy: "user",
				permissionDecidedAt: now,
				permissionDenyMessage: effectiveDenyMessage ?? null,
				...(decision === "deny"
					? { errorMessage: effectiveDenyMessage || "Permission denied by user" }
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
		if (yoloPause) {
			rememberYoloConfirmation(yoloPause.narratorId, yoloPause.fingerprint, yoloPause.danger);
			pendingYoloPauses.delete(requestId);
		}
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

		// Plan mode soft deny → user allowed → auto-enable relaxed plan
		if (pending.planModeSoftDeny) {
			try {
				await narratorService.updateRelaxedPlan(pending.narratorId, true);
				broadcastToNarrator(pending.broadcastTargetId, {
					type: "relaxed_plan_changed",
					narratorId: pending.narratorId,
					relaxedPlan: true,
				});
			} catch (err) {
				logger.warn("Failed to auto-enable relaxedPlan", {
					narratorId: pending.narratorId,
					error: String(err),
				});
			}
		}

		pending.resolve({ behavior: "allow", updatedInput: effectiveUpdatedInput });

		if (feedbackText?.trim() && pending.toolName !== "ExitPlanMode") {
			const active = activeNarrators.get(pending.narratorId);
			if (active?.alive) {
				active._feedbackSoftStop = true;
			}
		}
	} else {
		if (yoloPause) {
			pendingYoloPauses.delete(requestId);
		}
		const userFeedback = denyMessage || feedbackText?.trim();
		if (pending.toolName === "ExitPlanMode") {
			const locale = activeNarrators.get(pending.narratorId)?.locale ?? "en";
			const planDenyMsg = userFeedback
				? getToolMessageWithParams("exitPlanModeDeniedWithMessage", locale, {
						message: userFeedback,
					})
				: getToolMessage("exitPlanModeDenied", locale);
			pending.resolve({ behavior: "deny", message: planDenyMsg, rawMessage: true });
		} else {
			const message = userFeedback || "Permission denied by user";
			pending.resolve({ behavior: "deny", message });
		}
	}
	return true;
}

export async function confirmYoloPause(requestId: string, _reflection?: string): Promise<boolean> {
	const pause = pendingYoloPauses.get(requestId);
	if (!pause) return false;
	return resolvePermission(requestId, "allow");
}

export async function cancelYoloPause(requestId: string, reason?: string): Promise<boolean> {
	// Prefer the YOLO pause side table, but allow cancellation to resolve the underlying
	// pending permission as a last line of defense. If the side table was cleaned up or
	// lost while the permission is still pending, returning false would leave the
	// original tool call waiting forever.
	if (!pendingYoloPauses.has(requestId) && !pendingPermissions.has(requestId)) return false;
	return resolvePermission(requestId, "deny", {
		denyMessage: reason?.trim() || "YOLO safety pause cancelled by reflection loop",
	});
}

/**
 * Auto-approve all pending permission requests for a narrator and its subagents.
 */
export async function resolveAllPendingPermissions(narratorId: string): Promise<number> {
	const toResolve: string[] = [];
	for (const [requestId, pending] of pendingPermissions) {
		if (pending.narratorId === narratorId || pending.broadcastTargetId === narratorId) {
			toResolve.push(requestId);
		}
	}
	for (const requestId of toResolve) {
		await resolvePermission(requestId, "allow");
	}
	return toResolve.length;
}
