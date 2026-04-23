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
import { SHELL_TOOL_NAME } from "../lib/agent/tools/bash";
import { OUTPUT_DIR as TRUNCATE_OUTPUT_DIR } from "../lib/agent/truncate";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { isSubagentVariant } from "../lib/narrator-utils";
import { isInsidePath, pathsEqual, resolvePath } from "../lib/platform-path";
import { getToolMessage, getToolMessageWithParams, type Locale } from "../lib/prompt-i18n";
import { settings } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { narratorService } from "./narrator-service";
import {
	activeNarrators,
	pendingFeedback,
	pendingOverseerMessages,
	pendingPermissions,
	pendingPlanApprover,
	pendingPlanCompact,
	pendingPlanDiff,
	planModeAskedOnce,
} from "./narrator-session-state";
import { getConclusionFileId, resolveConclusionFilePath } from "./subagent-conclusion";

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
		if (conclusionFileId && (toolName === "Write" || toolName === "Edit")) {
			const filePath = typeof input.file_path === "string" ? input.file_path : "";
			if (filePath) {
				const absPath = resolvePath(cwd, filePath);
				const conclusionPath = resolveConclusionFilePath(cwd, conclusionFileId);
				if (pathsEqual(absPath, conclusionPath)) return "allow";
			}
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

const ALWAYS_ALLOW_TOOLS = ["TaskCreate", "EnterPlanMode", "WebSearch", "ContinueTask", "Skill"];

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
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "ShareFile"];

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
	const subagentConcFileId = getConclusionFileId(narratorId);
	if (subagentConcFileId && (toolName === "Write" || toolName === "Edit")) {
		const filePath = typeof effectiveInput.file_path === "string" ? effectiveInput.file_path : "";
		const conclusionRelPath = `.narrafork/conclusion-${subagentConcFileId}.md`;
		if (filePath) {
			const absPath = resolvePath(cwd, filePath);
			const conclusionAbsPath = resolveConclusionFilePath(cwd, subagentConcFileId);
			if (!pathsEqual(absPath, conclusionAbsPath)) {
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
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
			const cs = project?.chapterSettings as any;
			if (cs?.whitelistDirs) {
				projectWl = cs.whitelistDirs
					.filter((d: any) => d.enabled !== false)
					.map((d: any) => ({
						path: d.path,
						accessLevel: d.accessLevel ?? "readOnly",
						enabled: true,
					}));
			}
			if (cs?.blacklistDirs) {
				projectBl = cs.blacklistDirs
					.filter((d: any) => d.enabled !== false)
					.map((d: any) => ({
						path: d.path,
						denyLevel: d.denyLevel ?? "denyAll",
						enabled: true,
						source: "project" as const,
					}));
			}
			if (cs?.commandWhitelist) {
				projectCmdWl = cs.commandWhitelist
					.filter((d: any) => d.enabled !== false)
					.map((d: any) => ({
						pattern: d.pattern,
						enabled: true,
						source: "project" as const,
					}));
			}
			if (cs?.commandBlacklist) {
				projectCmdBl = cs.commandBlacklist
					.filter((d: any) => d.enabled !== false)
					.map((d: any) => ({
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
	let decision = resolvePermissionDecision({
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

	// Route to overseer (async, non-blocking)
	routePermissionToOverseer(
		narratorId,
		toolCallId,
		toolName,
		toolUseId,
		effectiveInput,
		wsTarget,
	).catch((err) => {
		logger.debug("Overseer routing skipped or failed", { narratorId, error: String(err) });
	});

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

	pending.cleanup();

	// Remove this request from any overseer queue
	for (const [overseerNarratorId, queue] of pendingOverseerMessages) {
		const idx = queue.findIndex((m) => m.requestId === requestId);
		if (idx !== -1) {
			queue.splice(idx, 1);
			if (queue.length === 0) pendingOverseerMessages.delete(overseerNarratorId);
			logger.debug("Removed resolved permission from overseer queue", {
				requestId,
				overseerNarratorId,
			});
			break;
		}
	}

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

// === Overseer permission routing ===

async function routePermissionToOverseer(
	narratorId: string,
	toolCallId: string,
	toolName: string,
	toolUseId: string,
	input: Record<string, unknown>,
	broadcastTargetId: string,
): Promise<void> {
	const { findResponsibleOverseer, getOverseerPolicy } = await import("./overseer-service");

	const overseer = await findResponsibleOverseer(narratorId);
	if (!overseer) return;

	const policy = getOverseerPolicy(overseer);
	if (!policy.handleEvents.permissionRequests) return;

	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { id: true, title: true, chapterId: true },
	});

	const narratorTitle = narrator?.title ?? "Untitled";
	const inputSummary = JSON.stringify(input, null, 2).slice(0, 2000);

	const contentBlocks = [
		{
			type: "overseer_permission_request" as const,
			requestId: toolCallId,
			narratorId,
			narratorTitle,
			toolName,
			toolUseId,
			inputJson: input,
		},
	];

	const { getUserLanguage } = await import("../lib/prompt-i18n");
	let overseerLocale: import("../lib/prompt-i18n").Locale = "en";
	try {
		const { users } = await import("../db/schema");
		const admin = await db.query.users.findFirst({
			where: eq(users.role, "admin"),
			columns: { id: true },
		});
		if (admin) {
			overseerLocale = await getUserLanguage(admin.id);
		}
	} catch {
		// fallback to "en"
	}

	const textForModel = getToolMessageWithParams("overseerPermissionRequestText", overseerLocale, {
		requestId: toolCallId,
		narratorTitle,
		narratorId,
		toolName,
		toolUseId,
		inputSummary,
	});

	eventBus.emit({
		type: "overseer:event_routed",
		overseerId: overseer.id,
		narratorId,
		eventType: "permission_request",
	});

	const existingActive = activeNarrators.get(overseer.narratorId);
	if (existingActive?.alive && existingActive._loopRunning) {
		const queue = pendingOverseerMessages.get(overseer.narratorId) ?? [];
		queue.push({
			requestId: toolCallId,
			narratorId,
			toolName,
			toolUseId,
			input,
			textForModel,
			contentBlocks,
			broadcastTargetId,
		});
		pendingOverseerMessages.set(overseer.narratorId, queue);

		broadcastToNarrator(broadcastTargetId, {
			type: "overseer_reviewing",
			narratorId: broadcastTargetId,
			requestId: toolCallId,
			toolUseId,
			status: "queued",
			overseerId: overseer.id,
		});

		logger.debug("Overseer busy, queued permission request", {
			overseerId: overseer.id,
			requestId: toolCallId,
			queueLength: queue.length,
		});
		return;
	}

	try {
		// Import ensureNarrator dynamically to avoid circular dependency
		const { ensureNarrator, runAgentLoop } = await import("./narrator-session");

		const active = await ensureNarrator(overseer.narratorId, overseerLocale);

		const userMsg = await narratorService.persistUserMessage(
			overseer.narratorId,
			textForModel,
			contentBlocks,
		);

		broadcastToNarrator(overseer.narratorId, {
			type: "user_message",
			narratorId: overseer.narratorId,
			message: userMsg,
		});

		await narratorService.updateStatus(overseer.narratorId, "working");

		broadcastToNarrator(broadcastTargetId, {
			type: "overseer_reviewing",
			narratorId: broadcastTargetId,
			requestId: toolCallId,
			toolUseId,
			status: "reviewing",
			overseerId: overseer.id,
		});

		runAgentLoop(active, textForModel).catch(async (err: unknown) => {
			logger.warn("Overseer agent loop failed", {
				overseerId: overseer.id,
				error: String(err),
			});
			await narratorService.updateStatus(overseer.narratorId, "idle", {
				substatus: ["error"],
				errorMessage: String(err),
			});
		});
	} catch (err) {
		logger.warn("Failed to route permission to overseer", {
			overseerId: overseer.id,
			narratorId,
			error: String(err),
		});
	}
}
