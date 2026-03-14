import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, sqlite } from "../db";
import {
	chapters,
	narratorBlacklistCmds,
	narratorBlacklistDirs,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	narratorWhitelistCmds,
	narratorWhitelistDirs,
	projects,
} from "../db/schema";
import { buildHistory, type PermissionResult, resolveProviderAndModel } from "../lib/agent";
import { analyzeShellCommand, type BashAnalysis } from "../lib/agent/bash-analyze";
import { detectShell } from "../lib/agent/shell";
import { SHELL_TOOL_NAME } from "../lib/agent/tools/bash";
import { OPTIONAL_TOOLS } from "../lib/agent/tools/index";
import { OUTPUT_DIR as TRUNCATE_OUTPUT_DIR } from "../lib/agent/truncate";
import { getBuiltinToolRoutines } from "../lib/builtin-routines";
import { NotFoundError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import { getHome } from "../lib/platform";
import { isInsidePath, pathsEqual, resolvePath } from "../lib/platform-path";
import { getToolMessage, getToolMessageWithParams, type Locale } from "../lib/prompt-i18n";
import {
	isAnthropicProvider,
	resolveDefaultReasoningEffort,
	resolveProvider,
	settings,
	usesCodexApiMode,
} from "../lib/settings";
import type { ImageRef } from "../lib/uploads";
import { getImagePath, imageToBase64 } from "../lib/uploads";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { gitService } from "./git-service";

import { narratorContext } from "./narrator-context";
import {
	clearStreamingSnapshot,
	type EventHandlerContext,
	type EventHooks,
	processEvent,
} from "./narrator-event-handler";
import { executeAgentLoop } from "./narrator-executor";
import { buildEffectiveSystemPrompt } from "./narrator-prompt";
import {
	handleContextOverflow,
	handleTransientError,
	MAX_CONTEXT_OVERFLOW_RETRIES,
	MAX_TRANSIENT_RETRIES,
} from "./narrator-recovery";
import { narratorService } from "./narrator-service";
import { generateAndSetTitle, generateQuickTitle } from "./narrator-title";
import { reviewService } from "./review-service";

import { worktreeWatcher } from "./worktree-watcher";

// === In-memory state ===

// Tools that may modify files on disk — git status is tracked after these complete
const FILE_MUTATING_TOOLS = new Set(["Write", "Edit", SHELL_TOOL_NAME]);

/** Parse `git status --porcelain` output into a set of file paths. */
function parsePorcelainFiles(output: string): Set<string> {
	const files = new Set<string>();
	for (const line of output.split("\n")) {
		if (line.length < 4) continue;
		// Porcelain format: XY filename  (or XY orig -> renamed)
		const filePart = line.slice(3);
		// Handle renames: "old -> new"
		const arrowIdx = filePart.indexOf(" -> ");
		files.add(arrowIdx >= 0 ? filePart.slice(arrowIdx + 4) : filePart);
	}
	return files;
}


interface ActiveNarrator {
	abortController: AbortController;
	narratorId: string;
	conversationId: string;
	cwd: string;
	model: string;
	provider: string;
	systemPrompt: string | null;
	events: EventEmitter;
	alive: boolean;
	locale: Locale;
	_usedCompactSummary?: boolean;
	/** Current context usage percentage — used for message metadata */
	_contextUsagePct?: number;
	/** Last reported metering from the provider */
	_lastMeterUsage?: number;
	_lastMeterUnit?: string;
	/** Last reported token usage snapshot from context_usage events */
	_lastTokenUsage?: import("./narrator-event-handler").TokenUsageSnapshot;
	/** Whether to append language instruction to system prompt */
	_replyInUserLanguage?: boolean;
	/** Set when ExitPlanMode completes — the loop should restart with a user message.
	 *  "continue" = no compact; "compact" = compact was performed, needs fresh context. */
	_planApprovedContinue?: "continue" | "compact";
	/** Cached prune boundary from the start of the current agent loop iteration */
	_pruneBoundaryMessageId?: string | null;
	/** Cached chapter ID (set when narrator is bound to an active chapter) */
	_chapterId?: string;
	/** Cached chapter role (trunk/branch/exploration/review) */
	_chapterRole?: string;
	/** Cached worktree path (set when narrator is bound to an active chapter with a worktree) */
	_worktreePath?: string;
	/** Plan file ID — set when entering plan mode, used to lock Write/Edit to .narrafork/plan-{id}.md */
	_planFileId?: string;
	/** Permission mode before entering plan mode — used to restore on ExitPlanMode */
	_previousPermissionMode?: string;
	/** Cached base branch (for commits-ahead tracking) */
	_baseBranch?: string;
	/** Trailing-edge throttle timer for git status tracking */
	_gitTrackTimer?: ReturnType<typeof setTimeout>;
	/** ID of the partial assistant message being incrementally built via block_complete events */
	_partialMessageId?: string;
	/** Per-tool-call before git status cache: toolUseId → Promise<Set<filePath>> (Bash snapshot) */
	_bashBeforeStatus?: Map<string, Promise<Set<string>>>;
	/** Whether the narrator's cwd is inside a git repo (enables Bash file tracking) */
	_isInGitRepo?: boolean;
	/** Cached project git path (for skill loading) */
	_projectGitPath?: string | null;
	/** Resolved skill scan root (projectGitPath or git root from cwd) */
	_skillRoot?: string | null;
	/** Optional tools enabled for this session (tool names, e.g. "Terminal") */
	_enabledOptionalTools: Set<string>;
}

// Use globalThis to survive Bun --hot reloads.  Module-level variables are
// re-initialised on hot reload, but agent loops spawned by the previous module
// evaluation are still running in the background.  Losing the Map reference
// means the old loop's finally-block deletes from a *new* empty Map while the
// new code creates a second ActiveNarrator for the same narrator — leading to
// two concurrent loops and status clobbering.

/** Retrieve (or lazily create) a globalThis-pinned collection that survives --hot reloads. */
function hotSafe<T>(key: string, factory: () => T): T {
	const sym = Symbol.for(key);
	// biome-ignore lint/suspicious/noExplicitAny: globalThis symbol key
	const g = globalThis as any;
	if (!g[sym]) g[sym] = factory();
	return g[sym];
}

const activeNarrators = hotSafe<Map<string, ActiveNarrator>>(
	"narrafork.activeNarrators",
	() => new Map(),
);

// Lock to prevent concurrent narrator creation for the same narrator
const narratorCreationLocks = hotSafe<Map<string, Promise<ActiveNarrator>>>(
	"narrafork.narratorCreationLocks",
	() => new Map(),
);

interface PendingPermission {
	resolve: (result: PermissionResult) => void;
	cleanup: () => void;
	input: Record<string, unknown>;
	narratorId: string;
	toolName: string;
	toolUseId: string;
	/** For subagent permissions: broadcast to parent narrator's WS channel instead of own. */
	broadcastTargetId: string;
}

const pendingPermissions = hotSafe<Map<string, PendingPermission>>(
	"narrafork.pendingPermissions",
	() => new Map(),
);

// Feedback queued by "allow with feedback" — keyed by narratorId
const pendingFeedback = hotSafe<Map<string, { toolUseId: string; feedbackText: string }>>(
	"narrafork.pendingFeedback",
	() => new Map(),
);

// Tracks narrators that should run plan compact after ExitPlanMode completes — keyed by narratorId
const pendingPlanCompact = hotSafe<Set<string>>("narrafork.pendingPlanCompact", () => new Set());

// Buffered message queue — keyed by narratorId, supports multiple queued messages
interface BufferedMessage {
	id: string;
	text: string;
	images?: ImageRef[];
	bufferedAt: string;
	commandText?: string | null;
	createdBy?: string | null;
}
const bufferedMessages = hotSafe<Map<string, BufferedMessage[]>>(
	"narrafork.bufferedMessages",
	() => new Map(),
);

// === SSE event types yielded to the HTTP response ===

export type NarratorEvent =
	| { type: "user_message"; data: unknown }
	| { type: "assistant_message"; data: unknown }
	| { type: "stream_event"; data: unknown }
	| { type: "tool_progress"; data: unknown }
	| { type: "result"; data: unknown }
	| { type: "error"; data: { message: string } }
	| { type: "interrupted"; data: { message: string } }
	| {
			type: "context_usage";
			data: { percentage: number; promptTokens?: number; contextWindow?: number };
	  }
	| { type: "done"; data: null };

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

/**
 * Check if a file path falls inside any enabled whitelist directory.
 * Returns the best (most permissive) access level, or null if not whitelisted.
 */
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
			if (dir.accessLevel === "full") return "full"; // can't get better
			if (!best || levels.indexOf(dir.accessLevel) > levels.indexOf(best)) {
				best = dir.accessLevel;
			}
		}
	}
	return best;
}

/**
 * Check if ALL given paths are covered by whitelist at the required access level.
 * `requiredLevel`: "readOnly" means read is enough, "readWrite" means write needed.
 */
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
		const isGeneral = input.subagent_type === "general";
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

/**
 * Check if a file path falls inside any enabled blacklist directory.
 * Returns the matching dir entry (most restrictive), or null if not blacklisted.
 */
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
			if (dir.denyLevel === "denyAll") return dir; // can't get worse
			if (!worst) worst = dir;
		}
	}
	return worst;
}

/** Result from blacklist decision: "deny" + human-readable reason with source info. */
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

/**
 * Check if ANY of the given paths are blocked by the blacklist for the given operation.
 * Returns the first matching reason, or null.
 */
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
		// denyAll blocks everything; denyWrite blocks general subagents (which have write access)
		if (match.denyLevel === "denyAll") {
			return { decision: "deny", reason: formatBlacklistReason(match, resolvedWorkdir) };
		}
		if (input.subagent_type === "general") {
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

// and does not access the local filesystem or execute arbitrary commands.
// Task is auto-allowed when using the parent's cwd — the subagent's
// individual tools go through their own permission checks. When Task specifies
// a different workdir, it requires user approval (handled below).
const ALWAYS_ALLOW_TOOLS = [
	"TaskCreate",
	"EnterPlanMode",
	"WebSearch",
	"ContinueTask",
	"TaskOutput",
	"TaskStop",
	"Skill",
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
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "ShareFile"];

/**
 * Pure decision logic for permission handling.
 * Returns "allow", "deny", or "ask" (needs user confirmation).
 */
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
	/** Which layer this entry comes from (for user-facing messages). */
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
	/** When a blacklist rule triggered, describes the source and matched path. */
	blacklistReason?: string;
	/** When a command blacklist rule triggered. */
	commandBlacklistReason?: string;
	/** The denyPrompt from the matched command blacklist entry. */
	commandBlacklistDenyPrompt?: string;
}

export interface PermissionDecisionOpts {
	toolName: string;
	input: Record<string, unknown>;
	permMode: string;
	cwd: string;
	bashAnalysis?: BashAnalysis;
	isChapter?: boolean;
	planFileId?: string;
	whitelistDirs?: WhitelistDir[];
	blacklistDirs?: BlacklistDir[];
	commandWhitelist?: CommandWhitelistEntry[];
	commandBlacklist?: CommandBlacklistEntry[];
	/** When true (plan + relaxedPlan toggle), inherit previousPermissionMode instead of readOnly */
	relaxedPlan?: boolean;
	/** The permission mode saved before entering plan mode */
	previousPermissionMode?: string;
	/** Mutable object to collect metadata about the decision (e.g. blacklist source). */
	meta?: PermissionDecisionMeta;
}

// ── Command pattern matching ──────────────────────────────

/** Simple glob match supporting `*` wildcard. */
function globMatch(text: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (!pattern.includes("*")) return text === pattern;
	const regex = new RegExp(
		`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
	);
	return regex.test(text);
}

/**
 * Match a command's tokens against a pattern string.
 * Pattern can be a single command name ("npm"), a glob ("docker*"),
 * or a multi-token prefix ("npm run", "git push --force").
 */
function matchCommandPattern(tokens: string[], pattern: string): boolean {
	const parts = pattern.split(/\s+/);
	if (parts.length > tokens.length) return false;
	return parts.every((part, i) => globMatch(tokens[i], part));
}

/**
 * Check if any command in the bash analysis matches a command blacklist entry.
 * Returns the first match or null.
 */
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

/**
 * Check if all non-whitelisted commands are covered by the command whitelist.
 * Returns true if the command whitelist fully covers all nonWhitelisted commands
 * (and there are no dangerous patterns / env injection).
 */
function isCommandWhitelistCovered(
	bashAnalysis: BashAnalysis,
	commandWhitelist: CommandWhitelistEntry[],
): boolean {
	if (commandWhitelist.length === 0) return false;
	if (bashAnalysis.allWhitelisted) return false; // already whitelisted, no need
	if (bashAnalysis.dangerousPatterns.length > 0) return false;
	if (bashAnalysis.hasEnvInjection) return false;
	if (bashAnalysis.nonWhitelisted.length === 0) return false;

	return bashAnalysis.nonWhitelisted.every((cmdName) => {
		const cmd = bashAnalysis.commands.find((c) => c.tokens[0] === cmdName);
		if (!cmd) return false;
		return commandWhitelist.some((entry) => matchCommandPattern(cmd.tokens, entry.pattern));
	});
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
		whitelistDirs = [],
		blacklistDirs = [],
		commandWhitelist = [],
		commandBlacklist = [],
		relaxedPlan = false,
		previousPermissionMode,
		meta,
	} = opts;
	// Catastrophic commands are ALWAYS blocked — no override possible
	if (toolName === SHELL_TOOL_NAME && bashAnalysis?.isCatastrophic) return "fatal";

	// Chapter mode: git branch violations are hard-denied (no bypass)
	if (toolName === SHELL_TOOL_NAME && isChapter && bashAnalysis?.gitBranchViolations?.length)
		return "deny";

	// Plan mode: Write/Edit to the designated plan file is always allowed.
	if (permMode === "plan" && (toolName === "Write" || toolName === "Edit")) {
		if (planFileId) {
			const filePath = typeof input.file_path === "string" ? input.file_path : "";
			const absPath = resolvePath(cwd, filePath);
			const planFilePath = resolvePath(cwd, `.narrafork/plan-${planFileId}.md`);
			if (pathsEqual(absPath, planFilePath)) return "allow";
		}
		// Strict plan: deny non-plan-file writes. Relaxed plan: delegate to inherited mode.
		if (!relaxedPlan) return "deny";
	}

	// For all other tools in plan mode:
	// - strict plan → behave like readOnly
	// - relaxed plan → inherit the permission mode from before entering plan
	const effectiveMode =
		permMode === "plan"
			? relaxedPlan
				? (previousPermissionMode ?? "default")
				: "readOnly"
			: permMode;
	if (ALWAYS_ASK_TOOLS.includes(toolName)) return "ask";
	if (ALWAYS_ALLOW_TOOLS.includes(toolName)) return "allow";

	// Command blacklist — deny if any sub-command matches (priority over all whitelists).
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

	// Blacklist takes priority over whitelist — deny if any path is blocked.
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

	// Command whitelist — if all non-whitelisted commands are covered, treat as whitelisted.
	let effectiveBashAnalysis = bashAnalysis;
	if (
		toolName === SHELL_TOOL_NAME &&
		bashAnalysis &&
		isCommandWhitelistCovered(bashAnalysis, commandWhitelist)
	) {
		// All nonWhitelisted commands are covered by command whitelist.
		// Create a patched analysis so downstream logic sees them as whitelisted.
		effectiveBashAnalysis = {
			...bashAnalysis,
			allWhitelisted: true,
			nonWhitelisted: [],
		};
	}

	// Agent: auto-allow when using parent's cwd; ask when workdir differs.
	// bypassPermissions still bypasses this; dontAsk denies it.
	// readOnly: explore/plan subagents within cwd subtree are allowed,
	// outside cwd requires user approval, general subagents are always denied.
	if (toolName === "Agent") {
		const workdir = input.workdir;
		const resolvedWorkdir =
			typeof workdir === "string" && workdir ? resolvePath(cwd, workdir) : null;
		const normalizedCwd = resolvePath(cwd);
		const isOutsideCwd = resolvedWorkdir !== null && !isInsidePath(normalizedCwd, resolvedWorkdir);
		const isDifferentDir = resolvedWorkdir !== null && !pathsEqual(resolvedWorkdir, normalizedCwd);

		if (effectiveMode === "readOnly") {
			// general subagents have write access — always deny in readOnly
			if (input.subagent_type === "general") return "deny";
			// explore/plan: workdir outside cwd needs user approval
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

	// readOnly: auto-allow read-only tools, auto-deny everything else.
	// Bash/Shell gets special handling — read-only commands inside allowed paths are allowed.
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
		// All commands whitelisted + all paths inside worktree + no dangerous patterns
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

	// Read-only access to the truncated-output temp directory is always safe —
	// the agent needs to retrieve full output after truncation without user approval.
	if (
		hasExternalPath &&
		READ_ONLY_TOOLS.includes(toolName) &&
		allPathsInTruncateDir(cwd, toolPaths)
	) {
		return "allow";
	}

	return "ask";
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
	// Read permission mode from DB in real-time
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: {
			permissionMode: true,
			chapterId: true,
			relaxedPlan: true,
			previousPermissionMode: true,
			type: true,
			parentNarratorId: true,
		},
	});
	const permMode = narrator?.permissionMode ?? "default";
	const isRelaxedPlan = !!narrator?.relaxedPlan;
	const isPlanMode = permMode === "plan";
	const isChapter = !!narrator?.chapterId;

	// Plan mode: redirect Write/Edit file_path to the locked plan file
	let effectiveInput = input;
	if (isPlanMode && (toolName === "Write" || toolName === "Edit")) {
		const active = activeNarrators.get(narratorId);
		const planFileId = active?._planFileId;
		if (planFileId) {
			const planFileName = `.narrafork/plan-${planFileId}.md`;
			effectiveInput = { ...input, file_path: planFileName };
		}
	}

	// ExitPlanMode with planFile: pre-read file content for the permission UI.
	// Replace planFile with the resolved plan content so the frontend can display it
	// and execute() receives a single `plan` parameter (not both plan + planFile).
	if (toolName === "ExitPlanMode" && !input.plan) {
		const active = activeNarrators.get(narratorId);
		const planFileId = active?._planFileId;
		if (planFileId) {
			const planFileName = `.narrafork/plan-${planFileId}.md`;
			const absPath = resolve(cwd, planFileName);
			try {
				if (existsSync(absPath)) {
					const content = readFileSync(absPath, "utf-8");
					if (content.trim()) {
						// Drop planFile, inject plan content — execute() sees only `plan`
						const { planFile: _, ...rest } = effectiveInput;
						effectiveInput = { ...rest, plan: content };
					}
				}
			} catch {
				// Ignore read errors — the tool execute will handle them
			}
		}
	}

	// Shell command pre-analysis (tree-sitter AST for bash, regex for PowerShell)
	let bashAnalysis: BashAnalysis | undefined;
	if (toolName === SHELL_TOOL_NAME && typeof input.command === "string") {
		try {
			const shellType = detectShell().type;
			const shellCwd = resolveToolCwd(cwd, effectiveInput);
			bashAnalysis = await analyzeShellCommand(input.command, shellCwd, shellType, isChapter);
		} catch (err) {
			logger.warn("Bash command analysis failed, falling back to ask", { err });
			// Analysis failure → conservative: ask user
		}
	}

	const planFileId = isPlanMode ? activeNarrators.get(narratorId)?._planFileId : undefined;

	// Load enabled whitelist/blacklist directories for this narrator.
	// Subagents inherit their parent narrator's directories.
	// Three-layer merge: global settings → project chapterSettings → narrator DB rows.
	const dirOwnerId =
		narrator?.type === "subagent" && narrator.parentNarratorId
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

	// Layer 2: project chapterSettings (if narrator belongs to a chapter)
	let projectWl: WhitelistDir[] = [];
	let projectBl: BlacklistDir[] = [];
	let projectCmdWl: CommandWhitelistEntry[] = [];
	let projectCmdBl: CommandBlacklistEntry[] = [];
	if (narrator?.chapterId) {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, narrator.chapterId),
			columns: { projectId: true },
		});
		if (chapter?.projectId) {
			const project = await db.query.projects.findFirst({
				where: eq(projects.id, chapter.projectId),
				columns: { chapterSettings: true },
			});
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

	// Merge all layers
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

	// ── Command whitelist/blacklist: three-layer merge ──
	// Layer 1: global settings
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

	// Layer 2: already extracted from project chapterSettings above

	// Layer 3: narrator-level DB rows
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
	const decision = resolvePermissionDecision({
		toolName,
		input: effectiveInput,
		permMode,
		cwd,
		bashAnalysis,
		isChapter,
		planFileId,
		whitelistDirs: mergedWhitelist,
		blacklistDirs: mergedBlacklist,
		commandWhitelist: mergedCmdWhitelist,
		commandBlacklist: mergedCmdBlacklist,
		relaxedPlan: isRelaxedPlan,
		previousPermissionMode: narrator?.previousPermissionMode ?? undefined,
		meta: permMeta,
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
		return { behavior: "allow", updatedInput: effectiveInput };
	}
	if (decision === "deny") {
		// Blacklist-triggered deny — use the specific reason from the blacklist check
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
		// Command blacklist-triggered deny
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
		// Chapter mode git branch violation — provide specific error message
		const branchViolations = bashAnalysis?.gitBranchViolations;
		// In readOnly mode, read-only tools (Read/Grep/Glob) and read-only bash commands
		// are only denied when their paths fall outside the allowed worktree scope.
		// Use a path-specific message instead of the generic "read-only mode" message.
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

	// Build decisionReason for Agent with custom workdir
	if (toolName === "Agent" && typeof input.workdir === "string" && input.workdir) {
		const resolvedWorkdir = resolvePath(cwd, input.workdir);
		decisionReason = `Subagent requests custom working directory: ${resolvedWorkdir} (parent cwd: ${cwd})`;
	}

	await db
		.update(narratorToolCalls)
		.set({
			status: "pending",
			// Persist effectiveInput so getPendingPermissions returns enriched data
			// (e.g. ExitPlanMode with resolved plan content instead of just planFile path)
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
	// When a subagent requests permission, also set the parent narrator to waiting
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
			// Restore parent narrator status on abort
			if (broadcastTargetId && broadcastTargetId !== narratorId) {
				await narratorService.updateStatus(broadcastTargetId, "thinking");
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
		});
	});
}

/** Called from WebSocket when user makes a permission decision */
export async function resolvePermission(
	requestId: string,
	decision: "allow" | "deny",
	denyMessage?: string,
	answers?: Record<string, string>,
	feedbackText?: string,
	compactAfter?: boolean,
	updatedPlan?: string,
): Promise<void> {
	const pending = pendingPermissions.get(requestId);
	if (!pending) {
		logger.warn("Permission resolution for unknown request", {
			requestId,
			decision,
			pendingKeys: [...pendingPermissions.keys()],
		});
		return;
	}

	logger.debug("Resolving permission", {
		requestId,
		decision,
		narratorId: pending.narratorId,
		toolUseId: pending.toolUseId,
	});

	// Clean up timeout + abort listener to prevent stale handlers from firing
	pending.cleanup();

	// Build updatedInput early so we can include it in the broadcast
	let updatedInput: Record<string, unknown> | undefined;
	if (answers) {
		updatedInput = { ...pending.input, answers };
	} else if (updatedPlan !== undefined && pending.toolName === "ExitPlanMode") {
		updatedInput = { ...pending.input, plan: updatedPlan };
	}

	// Broadcast to all subscribers so other tabs can clear the permission banner
	broadcastToNarrator(pending.broadcastTargetId, {
		type: "permission_resolved",
		narratorId: pending.broadcastTargetId,
		requestId,
		toolUseId: pending.toolUseId,
		decision,
		// Include answers so other clients can update the tool call display
		...(updatedInput ? { updatedInput } : {}),
		...(decision === "deny" && (denyMessage || feedbackText?.trim())
			? { feedbackText: denyMessage || feedbackText?.trim() }
			: {}),
	});

	try {
		await narratorService.updateStatus(pending.narratorId, "thinking");
		// Restore parent narrator status when subagent permission is resolved
		if (pending.broadcastTargetId !== pending.narratorId) {
			await narratorService.updateStatus(pending.broadcastTargetId, "thinking");
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

		// Mark for plan compact if requested (ExitPlanMode + reset context)
		if (compactAfter) {
			pendingPlanCompact.add(pending.narratorId);
		}

		pending.resolve({ behavior: "allow", updatedInput: effectiveUpdatedInput });

		// If the user attached feedback text, abort the agent loop so it stops
		// after the current tool completes instead of continuing to the next turn.
		// The outer while-loop will pick up pendingFeedback and inject the user
		// message before starting a fresh agent loop iteration.
		// Exception: ExitPlanMode already aborts via onExitPlanMode — aborting
		// here would race and prevent the tool_result from being processed.
		if (feedbackText?.trim() && pending.toolName !== "ExitPlanMode") {
			const active = activeNarrators.get(pending.narratorId);
			if (active?.alive) {
				active.abortController.abort();
			}
		}
	} else {
		const userFeedback = denyMessage || feedbackText?.trim();
		// ExitPlanMode denial: use a plan-specific message so the model knows it's still in plan mode
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
}

/**
 * Auto-approve all pending permission requests for a narrator and its subagents.
 * Called when the user switches permission mode to bypassPermissions.
 */
export async function resolveAllPendingPermissions(narratorId: string): Promise<number> {
	const toResolve: string[] = [];
	for (const [requestId, pending] of pendingPermissions) {
		// Match requests belonging to this narrator directly,
		// or subagent requests that broadcast to this narrator (broadcastTargetId).
		if (pending.narratorId === narratorId || pending.broadcastTargetId === narratorId) {
			toResolve.push(requestId);
		}
	}
	for (const requestId of toResolve) {
		await resolvePermission(requestId, "allow");
	}
	return toResolve.length;
}

// === Narrator lifecycle ===

/**
 * Ensure an active narrator exists for this narrator ID.
 * If one is already alive, return it. Otherwise create a new one.
 */
async function ensureNarrator(
	narratorId: string,
	locale: Locale,
	replyInUserLanguage = false,
): Promise<ActiveNarrator> {
	const existing = activeNarrators.get(narratorId);
	if (existing?.alive) return existing;

	const pending = narratorCreationLocks.get(narratorId);
	if (pending) return pending;

	const creation = createNarrator(narratorId, locale, replyInUserLanguage);
	narratorCreationLocks.set(narratorId, creation);
	try {
		return await creation;
	} finally {
		narratorCreationLocks.delete(narratorId);
	}
}

/**
 * Build the effective system prompt dynamically.
 * Reads AGENT.md (fallback CLAUDE.md) from disk each time so changes are picked up mid-conversation.
 */
async function buildSystemPrompt(
	narrator: { systemPrompt: string | null; contextSummary: string | null; todosJson?: unknown },
	cwd: string,
	locale: Locale,
	replyInUserLanguage: boolean,
	planMode = false,
	planFileId?: string,
): Promise<{ prompt: string | null; usedCompactSummary: boolean }> {
	return buildEffectiveSystemPrompt({
		basePrompt: narrator.systemPrompt,
		cwd,
		locale,
		contextSummary: narrator.contextSummary,
		todosJson: narrator.todosJson,
		planMode,
		planFileId,
		replyInUserLanguage,
	});
}

async function createNarrator(
	narratorId: string,
	locale: Locale,
	replyInUserLanguage = false,
): Promise<ActiveNarrator> {
	const existing = activeNarrators.get(narratorId);
	if (existing) {
		existing.abortController.abort();
		activeNarrators.delete(narratorId);
		clearStreamingSnapshot(narratorId);
	}

	const narrator = await narratorService.getById(narratorId);

	// Use narrator-level state directly
	const effectiveConversationId = narrator.apiConversationId;
	const effectiveContextSummary = narrator.contextSummary;

	// Resolve CWD and cache chapter info for git tracking
	let narratorCwd: string;
	let narratorChapterId: string | undefined;
	let narratorChapterRole: string | undefined;
	let narratorWorktreePath: string | undefined;
	let narratorBaseBranch: string | undefined;
	let projectGitPath: string | null = null;
	if (narrator.chapterId) {
		const ch = await db.query.chapters.findFirst({
			where: eq(chapters.id, narrator.chapterId),
		});
		if (!ch) throw new NotFoundError("Chapter", narrator.chapterId);
		// Always try to resolve project gitPath for skill loading
		const project = await db.query.projects.findFirst({
			where: eq(projects.id, ch.projectId),
		});
		projectGitPath = project?.gitPath ?? null;
		if (ch.worktreePath) {
			narratorCwd = ch.worktreePath;
			narratorChapterId = ch.id;
			narratorChapterRole = ch.role;
			narratorWorktreePath = ch.worktreePath;
			narratorBaseBranch = ch.baseBranch;
		} else {
			// Chapter is dormant — fall back to project gitPath or narrator cwd
			narratorCwd = narrator.cwd || project?.gitPath || getHome();
			logger.info("Chapter dormant, using fallback CWD", {
				chapterId: narrator.chapterId,
				narratorCwd,
			});
		}
	} else {
		narratorCwd = narrator.cwd || getHome();
	}

	// Generate planFileId if narrator is already in plan mode (e.g. server restart recovery).
	// A new ID is generated each time — any previously written plan file from a prior session
	// becomes orphaned, but the model will use the new file path from the refreshed system prompt.
	const isPlanMode = narrator.permissionMode === "plan";
	const planFileId = isPlanMode ? generateShortId() : undefined;

	const { prompt: effectiveSystemPrompt, usedCompactSummary } = await buildSystemPrompt(
		{
			systemPrompt: narrator.systemPrompt,
			contextSummary: effectiveContextSummary,
			todosJson: narrator.todosJson,
		},
		narratorCwd,
		locale,
		replyInUserLanguage,
		isPlanMode,
		planFileId,
	);

	// Resolve skill root for the Skill tool (projectGitPath or git root from cwd)
	let skillRoot: string | null = null;
	try {
		const { resolveSkillRoot } = await import("./skill-service");
		skillRoot = await resolveSkillRoot(projectGitPath, narratorCwd);
		if (skillRoot) {
			// Pre-populate skill cache so the tool description includes the skill list
			const { warmSkillCache } = await import("../lib/agent/tools/skill");
			await warmSkillCache(skillRoot);
		}
	} catch {
		// Skill root resolution failure is non-fatal
	}

	// For standalone narrators, only enable Bash git-status-based file tracking
	// if cwd is inside a git repo. This prevents running `git status` on non-repo dirs.
	let narratorIsInGitRepo = !!narratorChapterId;
	if (!narratorChapterId) {
		try {
			narratorIsInGitRepo = await gitService.isGitRepo(narratorCwd);
		} catch {
			// Non-fatal — Bash file tracking just won't be enabled
		}
	}

	const abortController = new AbortController();
	const events = new EventEmitter();
	events.setMaxListeners(20);

	const narratorModel = narrator.model ?? settings.agent.defaultModel;

	const active: ActiveNarrator = {
		abortController,
		narratorId,
		conversationId: effectiveConversationId ?? randomUUID(),
		cwd: narratorCwd,
		model: narratorModel,
		provider: resolveProvider(narratorModel),
		systemPrompt: effectiveSystemPrompt,
		events,
		alive: true,
		locale,
		_usedCompactSummary: usedCompactSummary,
		_replyInUserLanguage: replyInUserLanguage,
		_chapterId: narratorChapterId,
		_chapterRole: narratorChapterRole,
		_worktreePath: narratorWorktreePath,
		_baseBranch: narratorBaseBranch,
		_isInGitRepo: narratorIsInGitRepo,
		_planFileId: planFileId,
		_projectGitPath: projectGitPath,
		_skillRoot: skillRoot,
		_enabledOptionalTools: new Set(),
	};

	// Auto-load optional tools whose routines are globally enabled (not in disabledRoutines)
	const disabledRoutines = new Set(settings.routines?.disabledRoutines ?? []);
	for (const routine of getBuiltinToolRoutines()) {
		if (routine.tool && !disabledRoutines.has(routine.id)) {
			active._enabledOptionalTools.add(routine.tool.toolName);
		}
	}
	// Merge tools explicitly enabled on this narrator (via /load)
	if (Array.isArray(narrator.enabledTools)) {
		for (const toolName of narrator.enabledTools) {
			if (OPTIONAL_TOOLS.has(toolName)) {
				active._enabledOptionalTools.add(toolName);
			}
		}
	}

	activeNarrators.set(narratorId, active);

	// Start file watcher for the worktree (covers terminal/editor changes)
	if (narratorWorktreePath && narratorChapterId) {
		worktreeWatcher.watch(narratorWorktreePath, narratorChapterId, narratorId, locale);
	}

	return active;
}

// === Agent loop execution ===

/** Trigger compact when context usage exceeds this percentage (0–100). */
export const COMPACT_CONTEXT_USAGE_PCT = 99;

/**
 * Minimum prunedPercent required before compact is allowed at the COMPACT_CONTEXT_USAGE_PCT
 * threshold. If prunedPercent is below this value, the system continues pruning instead of
 * compacting — giving prune more room to reclaim context before resorting to the heavier
 * compact operation.
 */
const COMPACT_PRUNE_THRESHOLD_PCT = 80;

/**
 * Trigger a mid-turn compact: eagerly reserve the lock, find the boundary, and run compact.
 * Extracted to avoid duplication between the prune-check path and the direct-compact fallback.
 */
function triggerMidTurnCompact(
	narratorId: string,
	locale: Locale,
	onCompactDone?: () => void,
): void {
	const placeholder = Promise.resolve();
	compactLocks.set(narratorId, placeholder);

	logger.info("Context usage high, triggering compact (mid-turn)", { narratorId });
	narratorService
		.getCompactBoundaryMessage(narratorId)
		.then((boundaryMessageId) => {
			if (!boundaryMessageId) {
				if (compactLocks.get(narratorId) === placeholder) {
					compactLocks.delete(narratorId);
				}
				return;
			}
			runCustomCompact(narratorId, locale, boundaryMessageId)
				.then(() => {
					onCompactDone?.();
					broadcastToNarrator(narratorId, { type: "compact_done", narratorId });
				})
				.catch((err) => {
					logger.error("Auto-compact failed (mid-turn)", {
						narratorId,
						error: String(err),
					});
				});
		})
		.catch(() => {
			if (compactLocks.get(narratorId) === placeholder) {
				compactLocks.delete(narratorId);
			}
		});
}

/**
 * Strip tool calls from messages at or before the prune boundary so they
 * are excluded from the provider history entirely. This is simpler and
 * safer than truncating input/output — no risk of malformed JSON reaching
 * the API. The text content of these messages is preserved.
 *
 * Mutates the messages in place.
 */
/** Tool names whose tool_use + tool_result pairs should survive pruning
 *  so the model retains critical context (e.g. the approved plan). */
const PRUNE_PROTECTED_TOOLS = new Set(["ExitPlanMode", "Skill"]);

export function pruneToolCalls(
	dbMessages: import("../lib/agent/provider").DbMessage[],
	boundaryMessageId: string,
): void {
	const boundaryIdx = dbMessages.findIndex((m) => m.id === boundaryMessageId);
	if (boundaryIdx < 0) return;

	// Collect IDs of messages at or before the boundary.
	// For subagent narrators all messages have parentToolUseId set, so we
	// must NOT filter by !parentToolUseId — otherwise nothing gets pruned.
	const pruneIds = new Set(dbMessages.slice(0, boundaryIdx + 1).map((m) => m.id));

	for (const msg of dbMessages) {
		if (!pruneIds.has(msg.id)) continue;

		if (msg.toolCalls?.length) {
			const kept = msg.toolCalls.filter((tc) => PRUNE_PROTECTED_TOOLS.has(tc.toolName));
			msg.toolCalls = kept.length > 0 ? kept : [];
		}

		// Strip reasoning providerMetadata (encrypted_content) from pruned messages.
		// Old encrypted content cannot be used for continuation and wastes tokens.
		// The reasoning summary text is preserved for context.
		// Skip if the message still has protected tool calls — their reasoning item
		// must be preserved to satisfy Responses API pairing requirements.
		if (Array.isArray(msg.contentJson) && !msg.toolCalls?.length) {
			let mutated = false;
			const blocks = msg.contentJson as Array<{ type: string; providerMetadata?: unknown }>;
			for (const block of blocks) {
				if (block.type === "reasoning" && block.providerMetadata) {
					block.providerMetadata = undefined;
					mutated = true;
				}
			}
			if (mutated) {
				msg.contentJson = [...blocks];
			}
		}
	}
}

/** Append pending todos to the user message text so the model has context. */
function appendTodosContext(text: string, todosJson: unknown): string {
	if (!Array.isArray(todosJson) || todosJson.length === 0) return text;
	const pending = todosJson.filter((t: { status?: string }) => t.status !== "completed");
	if (pending.length === 0) return text;
	const statusIcon: Record<string, string> = {
		in_progress: "→",
		pending: "○",
	};
	const lines = pending.map(
		(t: { id?: string; content?: string; status?: string; priority?: string }) => {
			const icon = statusIcon[t.status ?? "pending"] ?? "○";
			const pri = t.priority && t.priority !== "medium" ? ` [${t.priority}]` : "";
			return `${icon} [${t.id}] ${t.content ?? ""}${pri}`;
		},
	);
	return `${text}\n\n<current_todos>\n${lines.join("\n")}\n</current_todos>`;
}

// === Shared context management hooks ===

export interface ContextManagementOptions {
	narratorId: string;
	locale: Locale;
	/** Dynamic getter for the current model (supports mid-loop model switching) */
	getModel: () => string;
	/** Dynamic getter for the current provider (supports mid-loop model switching) */
	getProvider: () => string;
	/** Whether this narrator is a subagent (all messages have parentToolUseId) */
	isSubagent?: boolean;
	/** Mutable getter/setter for the cached prune boundary */
	getPruneBoundary: () => string | null;
	setPruneBoundary: (id: string | null) => void;
	/** Called after compact completes (e.g. reset conversationId, set restart flag) */
	onCompactDone?: () => void;
}

/**
 * Build reusable context management hooks (prune + compact) for both
 * main narrators and subagents.
 *
 * Returns an `onContextUsage` EventHook and an `onBeforeTurn` AgentConfig callback.
 */
export function buildContextManagementHooks(opts: ContextManagementOptions): {
	onContextUsage: NonNullable<EventHooks["onContextUsage"]>;
	onBeforeTurn: NonNullable<import("../lib/agent").AgentConfig["onBeforeTurn"]>;
} {
	const {
		narratorId,
		locale,
		getModel,
		getProvider,
		isSubagent: isSubagentNarrator,
		getPruneBoundary,
		setPruneBoundary,
		onCompactDone,
	} = opts;

	const onContextUsage = (percentage: number) => {
		// Dynamic pruning: 95–98%
		if (percentage >= 95 && percentage < COMPACT_CONTEXT_USAGE_PCT && !pruneLocks.has(narratorId)) {
			pruneLocks.add(narratorId);
			narratorService
				.computeAndUpdatePruneBoundary(narratorId, percentage)
				.then((result) => {
					broadcastToNarrator(narratorId, {
						type: "prune_boundary",
						narratorId,
						boundaryMessageId: result?.boundaryMessageId ?? null,
						prunedPercent: result?.prunedPercent ?? null,
					});
				})
				.catch((err) => {
					logger.error("Failed to update prune boundary", {
						narratorId,
						contextPct: percentage,
						error: String(err),
					});
				})
				.finally(() => {
					pruneLocks.delete(narratorId);
				});
		}

		// ≥ 99%: check prunedPercent before deciding compact vs continued prune.
		// If prunedPercent < 80%, there's still room to prune further — skip compact.
		if (
			percentage >= COMPACT_CONTEXT_USAGE_PCT &&
			!pruneLocks.has(narratorId) &&
			!compactLocks.has(narratorId)
		) {
			pruneLocks.add(narratorId);
			narratorService
				.computeAndUpdatePruneBoundary(narratorId, percentage)
				.then((result) => {
					broadcastToNarrator(narratorId, {
						type: "prune_boundary",
						narratorId,
						boundaryMessageId: result?.boundaryMessageId ?? null,
						prunedPercent: result?.prunedPercent ?? null,
					});
					const prunedPct = result?.prunedPercent ?? 0;
					if (prunedPct < COMPACT_PRUNE_THRESHOLD_PCT) {
						logger.info("Context ≥99% but prunedPercent below threshold, continuing prune", {
							narratorId,
							contextPct: percentage,
							prunedPercent: prunedPct,
							threshold: COMPACT_PRUNE_THRESHOLD_PCT,
						});
						return; // stay in prune mode — don't compact yet
					}
					// prunedPercent ≥ 80%: prune is exhausted, proceed to compact
					triggerMidTurnCompact(narratorId, locale, onCompactDone);
				})
				.catch((err) => {
					logger.error("Failed to update prune boundary (pre-compact check)", {
						narratorId,
						contextPct: percentage,
						error: String(err),
					});
				})
				.finally(() => {
					pruneLocks.delete(narratorId);
				});
		}
	};

	const onBeforeTurn = async () => {
		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { pruneBoundaryMessageId: true },
		});
		const newBoundary = row?.pruneBoundaryMessageId ?? null;
		if (newBoundary === getPruneBoundary()) return null;
		setPruneBoundary(newBoundary);
		const rawMsgs = await narratorService.getMessagesSinceLastCompact(narratorId);
		// Subagent messages all have parentToolUseId set — clear it so
		// buildHistory treats them as top-level (same as loadSubagentHistory).
		const msgs = isSubagentNarrator
			? rawMsgs.map((m) => ({ ...m, parentToolUseId: null }))
			: rawMsgs;
		if (newBoundary) pruneToolCalls(msgs, newBoundary);
		const result = await buildHistory(msgs, getModel(), getProvider(), narratorId);
		return { history: result.history, pendingToolResults: result.trailingToolResults };
	};

	return { onContextUsage, onBeforeTurn };
}

/**
 * Build AgentConfig, start the agent loop via executeAgentLoop(), and handle chained messages.
 * Runs in the background — kicked off by feedMessage().
 */
async function runAgentLoop(
	active: ActiveNarrator,
	text: string,
	images?: ImageRef[],
): Promise<void> {
	const { narratorId, locale } = active;
	let shouldUpdateTitle = false;
	let currentText = text;
	let currentImages = images;
	let loopHadError = false;
	/** How many times we've retried after emergency compact in this runAgentLoop call. */
	let contextOverflowRetries = 0;

	/** How many consecutive transient-error retries in this runAgentLoop call. */
	let transientRetries = 0;

	/** How many consecutive smart-interruption auto-continues in this runAgentLoop call. */
	let interruptionRetries = 0;
	const MAX_INTERRUPTION_RETRIES = 3;

	try {
		while (active.alive) {
			// Always use getMessagesSinceLastCompact: if no compact marker exists it
			// returns all messages; after a compact it only returns post-compact messages
			// (old context is already in the summary injected via system prompt).
			const dbMessages = await narratorService.getMessagesSinceLastCompact(narratorId);

			// Rebuild system prompt each iteration so AGENT.md/CLAUDE.md changes are picked up
			const freshNarrator = await narratorService.getById(narratorId);

			// Apply dynamic pruning — strip tool calls from messages at or
			// before the persisted boundary so the context stays within budget.
			active._pruneBoundaryMessageId = freshNarrator.pruneBoundaryMessageId ?? null;
			if (freshNarrator.pruneBoundaryMessageId) {
				pruneToolCalls(dbMessages, freshNarrator.pruneBoundaryMessageId);
			}

			const resolved = resolveProviderAndModel(active.model);
			active.provider = resolved.provider;
			const { history, trailingToolResults } = await buildHistory(
				dbMessages,
				resolved.model,
				resolved.provider,
				narratorId,
			);

			const { prompt: freshSystemPrompt, usedCompactSummary } = await buildSystemPrompt(
				{
					systemPrompt: freshNarrator.systemPrompt,
					contextSummary: freshNarrator.contextSummary,
					todosJson: freshNarrator.todosJson,
				},
				active.cwd,
				locale,
				active._replyInUserLanguage ?? false,
				freshNarrator.permissionMode === "plan",
				active._planFileId,
			);
			active.systemPrompt = freshSystemPrompt;
			active._usedCompactSummary = usedCompactSummary;

			const eventContext: EventHandlerContext = {
				narratorId,
				broadcastTargetId: narratorId,
				sseEmitter: active.events,
				conversationId: active.conversationId,
				locale: active.locale,
				providerPrefix: resolved.provider,
				getContextUsagePct: () => active._contextUsagePct,
				getMeterUsage: () => active._lastMeterUsage,
				getMeterUnit: () => active._lastMeterUnit,
				getPartialMessageId: () => active._partialMessageId,
				getTokenUsage: () => active._lastTokenUsage,
				setPartialMessageId: (id) => {
					active._partialMessageId = id;
				},
				setContextUsagePct: (pct) => {
					active._contextUsagePct = pct;
				},
				setMeterData: (usage, unit) => {
					active._lastMeterUsage = usage;
					active._lastMeterUnit = unit;
				},
				setTokenUsage: (usage) => {
					active._lastTokenUsage = usage;
				},
			};

			// Build shared context management hooks (prune + compact)
			const ctxMgmt = buildContextManagementHooks({
				narratorId,
				locale,
				getModel: () => resolveProviderAndModel(active.model).model,
				getProvider: () => resolveProviderAndModel(active.model).provider,
				getPruneBoundary: () => active._pruneBoundaryMessageId ?? null,
				setPruneBoundary: (id) => {
					active._pruneBoundaryMessageId = id;
				},
				onCompactDone: () => {
					const s = activeNarrators.get(narratorId);
					if (s?.alive) {
						s.conversationId = randomUUID();
					}
				},
			});

			const hooks: EventHooks = {
				onTitleCheck: async (_savedId) => {
					const n = await db.query.narrators.findFirst({
						where: eq(narrators.id, narratorId),
						columns: { messageCount: true, title: true },
					});
					const titleUpdate = !!(n && (n.messageCount ?? 0) <= 1 && !n.title);
					return { titleUpdate };
				},
				onTodoWrite: async (todos, toolUseId) => {
					// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
					await narratorService.updateTodos(narratorId, todos as any[], toolUseId);
					broadcastToNarrator(narratorId, {
						type: "todos_updated",
						narratorId,
						// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
						todos: todos as any[],
						toolUseId,
					});
				},
				onEnterPlanMode: async () => {
					active._planFileId = generateShortId();
					// Save current permission mode and switch to plan
					const current = await db.query.narrators.findFirst({
						where: eq(narrators.id, narratorId),
						columns: { permissionMode: true },
					});
					const prevMode = current?.permissionMode ?? "default";
					// Guard: if already in plan mode, don't overwrite previousPermissionMode
					if (prevMode === "plan") return;
					active._previousPermissionMode = prevMode;
					const now = new Date().toISOString();
					await db
						.update(narrators)
						.set({
							permissionMode: "plan",
							previousPermissionMode: prevMode,
							updatedAt: now,
						})
						.where(eq(narrators.id, narratorId));
					broadcastToNarrator(narratorId, {
						type: "permission_mode_changed",
						narratorId,
						permissionMode: "plan",
					});
				},
				onExitPlanMode: async (toolUseId) => {
					active._planFileId = undefined;
					// Guard: if not currently in plan mode, the model called ExitPlanMode
					// without a matching EnterPlanMode — skip permission mode restoration
					// and plan-continuation logic to avoid accidentally resetting the
					// user's chosen mode or aborting the agent loop.
					const currentRow = await db.query.narrators.findFirst({
						where: eq(narrators.id, narratorId),
						columns: { permissionMode: true, previousPermissionMode: true },
					});
					if (currentRow?.permissionMode !== "plan") {
						active._previousPermissionMode = undefined;
						return;
					}
					// Restore previous permission mode — check in-memory first, then DB
					let restoreMode = active._previousPermissionMode;
					if (!restoreMode) {
						restoreMode = currentRow.previousPermissionMode ?? undefined;
					}
					// If the previous mode would block plan execution, fall back to default
					const BLOCKED_MODES = new Set(["readOnly", "plan", "dontAsk"]);
					const resolved = restoreMode && !BLOCKED_MODES.has(restoreMode) ? restoreMode : "default";
					const finalMode = resolved as
						| "default"
						| "acceptEdits"
						| "bypassPermissions"
						| "readOnly"
						| "plan"
						| "dontAsk";
					active._previousPermissionMode = undefined;
					const now = new Date().toISOString();
					await db
						.update(narrators)
						.set({
							permissionMode: finalMode,
							previousPermissionMode: null,
							updatedAt: now,
						})
						.where(eq(narrators.id, narratorId));
					broadcastToNarrator(narratorId, {
						type: "permission_mode_changed",
						narratorId,
						permissionMode: finalMode,
					});
					// Plan compact logic — retrieve plan text from the tool call's inputJson
					if (pendingPlanCompact.has(narratorId)) {
						pendingPlanCompact.delete(narratorId);
						const planText = await narratorService.getToolCallPlanText(toolUseId);
						if (planText) {
							await runPlanCompact(narratorId, planText);
							active.conversationId = randomUUID();
							broadcastToNarrator(narratorId, { type: "compact_done", narratorId });
							active._planApprovedContinue = "compact";
							active.abortController.abort();
						}
					} else {
						// Non-compact: abort the current agent loop and persist a user
						// message so the next iteration starts with an explicit
						// "plan approved, begin execution" prompt — this prevents the
						// model from ignoring the tool result and asking the user again.
						active._planApprovedContinue = "continue";
						active.abortController.abort();
					}
				},
				onClearCompactSummary: async () => {
					if (!active._usedCompactSummary) return;
					await db
						.update(narrators)
						.set({ contextSummary: null, updatedAt: new Date().toISOString() })
						.where(eq(narrators.id, narratorId));
					active._usedCompactSummary = false;
				},
				onGitTrack:
					active._worktreePath && active._chapterId
						? (toolName, toolUseId) => {
								if (!FILE_MUTATING_TOOLS.has(toolName)) return;
								const chapterId = active._chapterId as string;
								const worktreePath = active._worktreePath as string;
								const baseBranch = active._baseBranch as string | undefined;

								// Throttle: collapse rapid successive calls into one trailing query.
								// Store the latest toolUseId so the broadcast references the most
								// recent tool, and clear any pending timer.
								if (active._gitTrackTimer) clearTimeout(active._gitTrackTimer);
								active._gitTrackTimer = setTimeout(() => {
									active._gitTrackTimer = undefined;
									Promise.all([
										gitService.getStatusSummary(worktreePath),
										baseBranch
											? gitService.getCommitsAhead(worktreePath, baseBranch)
											: Promise.resolve({ count: 0, baseBranch: "" }),
										gitService.getUncommittedLineStats(worktreePath),
									]).then(
										([gitStatus, ahead, lines]) => {
											// Strip files array from WS broadcast to avoid
											// sending huge payloads when many files are changed.
											// The Git panel fetches the full list via API.
											const { files: _files, ...statusWithoutFiles } = gitStatus;
											broadcastToNarrator(narratorId, {
												type: "git_status",
												narratorId,
												chapterId,
												toolUseId,
												status: statusWithoutFiles as typeof gitStatus,
												commitsAhead: ahead.count,
												baseBranch: ahead.baseBranch,
												linesAdded: lines.added,
												linesRemoved: lines.removed,
											});
										},
										(err) => {
											logger.debug("Git status tracking failed", {
												narratorId,
												error: String(err),
											});
										},
									);
								}, 800);
							}
						: undefined,
				onSnapshotBefore: active._isInGitRepo
					? (toolUseId, toolName) => {
							// Only Bash needs before/after git status diff.
							// Write/Edit record snapshots directly in their execute().
							if (toolName !== SHELL_TOOL_NAME) return;

							if (!active._bashBeforeStatus) {
								active._bashBeforeStatus = new Map();
							}

							const statusPromise = gitService
								.getStatus(active.cwd)
								.then((output) => parsePorcelainFiles(output));

							active._bashBeforeStatus.set(toolUseId, statusPromise);

							// Swallow errors so the unhandled-rejection handler stays quiet
							statusPromise.catch((err) =>
								logger.debug("Bash before-status failed", {
									narratorId,
									toolUseId,
									error: String(err),
								}),
							);
						}
					: undefined,
				onSnapshotAfter: active._isInGitRepo
					? (toolUseId, toolName) => {
							// Only Bash needs before/after git status diff
							if (toolName !== SHELL_TOOL_NAME) return;

							const beforePromise = active._bashBeforeStatus?.get(toolUseId);
							if (!beforePromise) return;
							active._bashBeforeStatus?.delete(toolUseId);

							// Fire-and-forget: diff before/after status, snapshot new/changed files
							beforePromise
								.then(async (beforeFiles) => {
									const afterOutput = await gitService.getStatus(active.cwd);
									const afterFiles = parsePorcelainFiles(afterOutput);

									// Find files that are new or changed (in after but not in before)
									const changedFiles: string[] = [];
									for (const f of afterFiles) {
										if (!beforeFiles.has(f)) {
											changedFiles.push(f);
										}
									}
									if (changedFiles.length === 0) return;

									// Record snapshots for changed files.
									// For Bash, we use `git show HEAD:<path>` to recover the last
									// committed version as the "original" content. This covers the
									// common case of Bash modifying tracked files. For untracked
									// files (truly new), originalContent will be null.
									const { ensureFileSnapshot } = await import("./file-snapshot-service");
									const cwd = active.cwd;
									for (const filePath of changedFiles) {
										await ensureFileSnapshot(narratorId, filePath, async () => {
											// Try to get the last committed version of this file
											try {
												return await gitService.getFileAtHead(cwd, filePath);
											} catch {
												return null;
											}
										});
									}
								})
								.catch((err) =>
									logger.debug("Bash after-status snapshot failed", {
										narratorId,
										toolUseId,
										error: String(err),
									}),
								);
						}
					: undefined,
				onContextUsage: ctxMgmt.onContextUsage,
				onErrorCleanup: async (message) => {
					// Clean up partial message
					const partialId = active._partialMessageId;
					active._partialMessageId = undefined;
					if (message === "Aborted") {
						if (
							active._planApprovedContinue === "compact" ||
							active._planApprovedContinue === "continue"
						) {
							logger.info("Agent loop aborted for plan approval", {
								narratorId,
								mode: active._planApprovedContinue,
							});
							// Mark any orphaned tool calls (e.g. ExitPlanMode) as success
							// since the abort was intentional after approval.
							completeOrphanedToolCalls(narratorId).catch((err) => {
								logger.warn("Failed to complete orphaned tool calls after plan approval", {
									narratorId,
									error: String(err),
								});
							});
							if (partialId) {
								cleanupPartialMessage(partialId, narratorId);
							}
							return;
						}
						logger.info("Agent loop aborted (interrupted)", { narratorId });
						// Broadcast interrupted event FIRST for instant UI feedback,
						// then await DB cleanup so orphaned tool calls are resolved
						// before the caller checks narrator status.
						active.events.emit("event", {
							type: "interrupted",
							data: { message: "Narrator interrupted" },
						});
						// Preserve terminal error state: if status is already error, do not overwrite it.
						const cleanupTasks = [cleanupOrphanedToolCalls(narratorId, active.locale)];
						const current = await db.query.narrators.findFirst({
							where: eq(narrators.id, narratorId),
							columns: { status: true },
						});
						if (current?.status !== "error") {
							cleanupTasks.push(narratorService.updateStatus(narratorId, "interrupted"));
						}
						if (partialId) {
							cleanupTasks.push(cleanupPartialMessage(partialId, narratorId));
						}
						await Promise.all(cleanupTasks).catch((err) => {
							logger.warn("Post-interrupt cleanup failed", {
								narratorId,
								error: String(err),
							});
						});
						return;
					}
					if (partialId) {
						await cleanupPartialMessage(partialId, narratorId);
					}
					logger.error("Agent loop error", { narratorId, error: message });
					await narratorService.updateStatus(narratorId, "error", message);
					loopHadError = true;
					active.events.emit("event", { type: "error", data: { message } });
				},
			};

			const resolvedReasoningEffort =
				freshNarrator.reasoningEffort ?? resolveDefaultReasoningEffort(resolved.provider);

			const resolvedServiceTier =
				freshNarrator.fastMode && usesCodexApiMode(resolved.provider) ? "priority" : undefined;

			const config: import("../lib/agent").AgentConfig = {
				narratorId,
				conversationId: active.conversationId,
				model: resolved.model,
				provider: resolved.provider,
				cwd: active.cwd,
				systemPrompt: active.systemPrompt ?? undefined,
				locale,
				signal: active.abortController.signal,
				planMode: freshNarrator.permissionMode === "plan",
				relaxedPlan: !!freshNarrator.relaxedPlan,
				planFileId: active._planFileId,
				skillRoot: active._skillRoot ?? undefined,
				reasoningEffort: resolvedReasoningEffort,
				serviceTier: resolvedServiceTier,
				metadata: isAnthropicProvider(resolved.provider)
					? { user_id: `user_${narratorId}_account__session_${active.conversationId}` }
					: undefined,
				// Exclude optional tools that haven't been loaded for this session
				toolFilter: (tool) => {
					if (OPTIONAL_TOOLS.has(tool.name)) {
						return active._enabledOptionalTools.has(tool.name);
					}
					return true;
				},
				permissionHandler: (toolName, input, toolUseId) =>
					handlePermission(
						narratorId,
						active.abortController.signal,
						toolName,
						input,
						toolUseId,
						active.cwd,
						locale,
					),
				onBeforeTurn: ctxMgmt.onBeforeTurn,
				getInjectedUserText: () => {
					return null;
				},
				getModelOverride: () => {
					// active.model is updated in real-time by updateNarratorModel()
					if (active.model !== config.model) {
						return active.model;
					}
					return null;
				},
				// onEvent receives only side-channel events (tool_output, tool_progress)
				// from executeTool — NOT yielded events like tool_result or assistant_message.
				onEvent: (event) => {
					processEvent(event, eventContext, hooks).catch((err) => {
						logger.error("Side-channel event processing error", {
							narratorId,
							eventType: event.type,
							error: String(err),
						});
					});
				},
			};

			// Convert images to base64 for the agent loop (first iteration only)
			let loopImages: Array<{ format: string; base64: string }> | undefined;
			if (currentImages?.length) {
				const resolved: Array<{ format: string; base64: string }> = [];
				for (const img of currentImages) {
					const filePath = getImagePath(narratorId, img.imageId);
					if (filePath) {
						try {
							const result = await imageToBase64(filePath);
							const mimeToFormat: Record<string, string> = {
								"image/png": "png",
								"image/jpeg": "jpeg",
								"image/gif": "gif",
								"image/webp": "webp",
							};
							// Prefer detected real format over stored mediaType
							const effectiveMime = result.detectedMediaType ?? img.mediaType;
							resolved.push({
								format: mimeToFormat[effectiveMime] ?? "png",
								base64: result.base64,
							});
						} catch {
							// Image file may have been deleted — skip silently
						}
					}
				}
				if (resolved.length > 0) loopImages = resolved;
				currentImages = undefined; // only attach images on the first iteration
			}

			// Run one agent loop pass

			// Inject pending todos into the user message so the model always has context
			const effectiveText = appendTodosContext(currentText, freshNarrator.todosJson);

			const result = await executeAgentLoop({
				config,
				userText: effectiveText,
				history,
				trailingToolResults,
				images: loopImages,
				eventContext,
				hooks,
			});

			// --- Context length exceeded: aggressive prune (Codex) then compact/retry ---
			if (result.contextLengthExceeded && active.alive) {
				const overflow = await handleContextOverflow({
					narratorId,
					locale,
					provider: active.provider,
					overflowRetries: contextOverflowRetries,
					maxRetries: MAX_CONTEXT_OVERFLOW_RETRIES,
					onBroadcast(event) {
						broadcastToNarrator(narratorId, event as Parameters<typeof broadcastToNarrator>[1]);
					},
				});
				contextOverflowRetries = overflow.overflowRetries;

				if (overflow.action === "retry_pruned") {
					active._pruneBoundaryMessageId = overflow.boundaryMessageId;
					continue;
				}
				if (overflow.action === "retry_compacted") {
					active.conversationId = overflow.newConversationId;
					continue;
				}

				// All attempts failed
				logger.error("Context length exceeded after max retries", { narratorId });
				await narratorService.updateStatus(narratorId, "error", "Context too long, compact failed");
				active.events.emit("event", {
					type: "error",
					data: { message: "Context too long, compact failed" },
				});
				loopHadError = true;
				break;
			}

			// --- Transient API error: warn frontend and retry with backoff ---
			if (result.retryableError && active.alive) {
				transientRetries++;
				const { shouldRetry } = await handleTransientError({
					narratorId,
					error: result.retryableError,
					retryCount: transientRetries,
					maxRetries: MAX_TRANSIENT_RETRIES,
					signal: active.abortController.signal,
				});
				if (shouldRetry) {
					continue;
				}
				await narratorService.updateStatus(narratorId, "error", result.retryableError);
				active.events.emit("event", {
					type: "error",
					data: { message: result.retryableError },
				});
				loopHadError = true;
				break;
			}

			// Reset transient retry counter on success
			transientRetries = 0;

			if (result.shouldUpdateTitle) {
				shouldUpdateTitle = true;
			}

			// Smart interruption check — auto-continue if output was truncated
			if (result.interrupted && active.alive) {
				interruptionRetries++;
				if (interruptionRetries > MAX_INTERRUPTION_RETRIES) {
					logger.warn("Smart interruption check: max retries reached, stopping", {
						narratorId,
						retries: interruptionRetries,
					});
				} else {
					const continueText = getToolMessage("interruptionContinue", locale);
					const userMsg = await narratorService.persistUserMessage(narratorId, continueText, [
						{ type: "text", text: continueText },
					]);
					broadcastToNarrator(narratorId, {
						type: "user_message",
						narratorId,
						message: userMsg,
					});
					active.events.emit("event", { type: "user_message", data: userMsg });
					await narratorService.updateStatus(narratorId, "thinking");
					currentText = continueText;
					currentImages = undefined;
					continue;
				}
			} else {
				// Reset counter on successful non-interrupted output
				interruptionRetries = 0;
			}

			// Plan approved — abort was triggered by onExitPlanMode so we persist
			// a user message and restart the loop to drive plan execution.
			if (
				active._planApprovedContinue === "compact" ||
				active._planApprovedContinue === "continue"
			) {
				const isCompact = active._planApprovedContinue === "compact";
				active._planApprovedContinue = undefined;
				active.abortController = new AbortController();

				if (isCompact) {
					await narratorService.updateStats(narratorId, 0);
				}

				const continuePrompt = getToolMessage(
					isCompact ? "planCompactContinue" : "exitPlanModeApproved",
					locale,
				);

				// Check for chained feedback — use it instead of the default prompt
				const fb = pendingFeedback.get(narratorId);
				const promptText = fb ? fb.feedbackText : continuePrompt;
				if (fb) pendingFeedback.delete(narratorId);

				const userMsg = await narratorService.persistUserMessage(narratorId, promptText, [
					{ type: "text", text: promptText },
				]);
				broadcastToNarrator(narratorId, {
					type: "user_message",
					narratorId,
					message: userMsg,
				});
				active.events.emit("event", { type: "user_message", data: userMsg });
				await narratorService.updateStatus(narratorId, "thinking");
				currentText = promptText;
				currentImages = undefined;
				continue;
			}

			// If the loop was interrupted (abort signal fired), reset the abort
			// controller so that any chained buffered message or feedback below
			// can start a fresh agent loop iteration without immediately aborting.
			if (active.abortController.signal.aborted) {
				active.abortController = new AbortController();
			}

			// Check for chained feedback BEFORE marking "done" — when the user
			// approves a permission with attached text, the loop is aborted right
			// after the tool completes so the feedback is injected immediately
			// instead of waiting for the entire turn to finish.
			const fb = pendingFeedback.get(narratorId);
			if (fb) {
				pendingFeedback.delete(narratorId);
				const userMsg = await narratorService.persistUserMessage(narratorId, fb.feedbackText, [
					{ type: "text", text: fb.feedbackText },
				]);
				broadcastToNarrator(narratorId, { type: "user_message", narratorId, message: userMsg });
				active.events.emit("event", { type: "user_message", data: userMsg });
				await narratorService.updateStatus(narratorId, "thinking");
				currentText = fb.feedbackText;
				continue;
			}

			// Review git state check — if the review narrator modified files,
			// reset and re-inject a message to continue the loop.
			if (active._chapterRole === "review" && active._chapterId && active.alive) {
				const gitCheck = await reviewService.checkAndResetGitState(active._chapterId);
				if (!gitCheck.clean && gitCheck.message) {
					const userMsg = await narratorService.persistUserMessage(narratorId, gitCheck.message, [
						{ type: "text", text: gitCheck.message },
					]);
					broadcastToNarrator(narratorId, {
						type: "user_message",
						narratorId,
						message: userMsg,
					});
					active.events.emit("event", { type: "user_message", data: userMsg });
					await narratorService.updateStatus(narratorId, "thinking");
					currentText = gitCheck.message;
					continue;
				}
				// Git is clean and loop ended normally — conclude the review
				if (!result.hasError) {
					await reviewService.concludeReview(active._chapterId);
				}
			}

			// Agent loop done — update stats (always, even if we continue with buffered messages)
			await narratorService.updateStats(narratorId, 0);

			// Compact if context usage is high (checked after a complete turn).
			// This is a fallback — the mid-turn compact in the context_usage handler
			// may have already started a background compact.
			// Before compacting, check prunedPercent: if < 80%, continue pruning instead.
			if (
				active._contextUsagePct != null &&
				active._contextUsagePct >= COMPACT_CONTEXT_USAGE_PCT &&
				!compactLocks.has(narratorId)
			) {
				active._contextUsagePct = undefined;

				// Check current prunedPercent — if below threshold, prune further instead of compacting
				const narrator = await db.query.narrators.findFirst({
					where: eq(narrators.id, narratorId),
					columns: { prunedPercent: true },
				});
				const currentPrunedPct = narrator?.prunedPercent ?? 0;

				if (currentPrunedPct < COMPACT_PRUNE_THRESHOLD_PCT) {
					logger.info(
						"Context ≥99% post-turn but prunedPercent below threshold, skipping compact",
						{
							narratorId,
							prunedPercent: currentPrunedPct,
							threshold: COMPACT_PRUNE_THRESHOLD_PCT,
						},
					);
				} else {
					const boundaryMessageId = await narratorService.getCompactBoundaryMessage(narratorId);

					if (boundaryMessageId) {
						logger.info("Context usage high, triggering background compact (post-turn)", {
							narratorId,
							boundaryMessageId,
						});

						// Fire-and-forget: compact runs in the background.
						// On completion it resets the narrator's conversationId so the next
						// agent loop iteration starts a fresh API conversation.
						runCustomCompact(narratorId, locale, boundaryMessageId)
							.then(() => {
								const current = activeNarrators.get(narratorId);
								if (current?.alive) {
									current.conversationId = randomUUID();
								}
								broadcastToNarrator(narratorId, { type: "compact_done", narratorId });
							})
							.catch((compactErr) => {
								logger.error("Auto-compact failed", {
									narratorId,
									error: String(compactErr),
								});
							});
					} else {
						logger.info("Context usage high but not enough messages to compact", {
							narratorId,
						});
					}
				}
			}

			// Check for buffered messages BEFORE transitioning to "done" —
			// this prevents spurious notifications when there are queued messages.
			const queue = bufferedMessages.get(narratorId);
			const buffered = queue?.[0];
			if (buffered) {
				queue?.shift();
				if (queue?.length === 0) bufferedMessages.delete(narratorId);
				const finalNarrator = await db.query.narrators.findFirst({
					where: eq(narrators.id, narratorId),
					columns: { status: true },
				});
				if (finalNarrator?.status !== "error") {
					// Broadcast which message was consumed + remaining queue snapshot
					const remaining = toBufferSummary(getBufferedMessages(narratorId));
					broadcastToNarrator(narratorId, {
						type: "buffer_consumed",
						narratorId,
						messageId: buffered.id,
						remaining,
					});
					const persistBlocks: Array<
						| { type: "text"; text: string }
						| { type: "image"; imageId: string; filename: string; mediaType: string }
					> = [];
					if (buffered.images?.length) {
						for (const img of buffered.images) {
							persistBlocks.push({
								type: "image",
								imageId: img.imageId,
								filename: img.filename,
								mediaType: img.mediaType,
							});
						}
					}
					persistBlocks.push({ type: "text", text: buffered.text });
					const userMsg = await narratorService.persistUserMessage(
						narratorId,
						buffered.text,
						persistBlocks,
						buffered.commandText,
						buffered.createdBy,
					);
					broadcastToNarrator(narratorId, { type: "user_message", narratorId, message: userMsg });
					active.events.emit("event", { type: "user_message", data: userMsg });
					await narratorService.updateStatus(narratorId, "thinking");
					currentText = buffered.text;
					currentImages = buffered.images;
					continue;
				}
				broadcastToNarrator(narratorId, {
					type: "buffer_cleared",
					narratorId,
					reason: "narrator_error",
				});
			}

			// No buffered messages — now transition to "done" (triggers notifications)
			if (!loopHadError) {
				// Atomically transition thinking/waiting → done.
				// If status has already moved (e.g. another loop took over after
				// hot reload, or user interrupted), the CAS is a no-op.
				await narratorService.compareAndSetStatus(narratorId, ["thinking", "waiting"], "done");
			}

			active.events.emit("event", { type: "done", data: null });
			break;
		}
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		logger.error("Narrator loop error", { narratorId, error: errorMsg });
		await narratorService.updateStatus(narratorId, "error", errorMsg);
		loopHadError = true;
		active.events.emit("event", { type: "error", data: { message: errorMsg } });
	} finally {
		active.alive = false;
		if (active._gitTrackTimer) clearTimeout(active._gitTrackTimer);
		// Stop file watcher for this narrator
		if (active._worktreePath) {
			worktreeWatcher.unwatch(active._worktreePath, narratorId);
		}
		// Persist conversationId so the next activation can resume the API session
		// (avoids cache miss from generating a new random UUID every time).
		narratorService.updateConversationId(narratorId, active.conversationId).catch((err) => {
			logger.error("Failed to persist conversationId", {
				narratorId,
				error: String(err),
			});
		});
		activeNarrators.delete(narratorId);
		clearStreamingSnapshot(narratorId);
		active.abortController.abort();
		active.events.emit("event", { type: "done", data: null });
		active.events.removeAllListeners();
		if (shouldUpdateTitle) {
			generateAndSetTitle(narratorId, locale).catch(() => {});
		}
	}
}

// === Custom compact (conversation rotation) ===

/** Per-narrator lock to prevent concurrent compact operations. */
export const compactLocks = hotSafe<Map<string, Promise<void>>>(
	"narrafork.compactLocks",
	() => new Map(),
);

/** Per-narrator lock to prevent concurrent prune boundary computations. */
export const pruneLocks = hotSafe<Set<string>>("narrafork.pruneLocks", () => new Set());

/** Compact operation timeout in milliseconds (5 minutes). */
const COMPACT_TIMEOUT_MS = 5 * 60 * 1000;
const COMPACT_FAILURE_TEXT = "[Compact Failed]";

/**
 * Run custom compact with concurrency protection.
 * If a compact is already in progress for this narrator, waits for it to finish
 * and skips the duplicate request.
 */
export async function runCustomCompact(
	narratorId: string,
	locale: Locale,
	beforeMessageId?: string,
): Promise<void> {
	const existing = compactLocks.get(narratorId);
	if (existing) {
		logger.info("Compact already in progress, skipping duplicate", { narratorId });
		// Wait for the in-flight compact to settle (ignore its error — the original
		// caller handles it). We just need to know it's done before returning.
		await existing.catch(() => {});
		return;
	}

	// Wrap compact with timeout to ensure lock is always released
	const compactPromise = Promise.race([
		doRunCustomCompact(narratorId, locale, beforeMessageId),
		new Promise<void>((_, reject) =>
			setTimeout(
				() => reject(new Error("Compact operation timed out after 5 minutes")),
				COMPACT_TIMEOUT_MS,
			),
		),
	]);
	compactLocks.set(narratorId, compactPromise);
	try {
		await compactPromise;
	} catch (err) {
		logger.error("Compact operation failed or timed out", {
			narratorId,
			error: String(err),
		});
		throw err;
	} finally {
		compactLocks.delete(narratorId);
	}
}

/**
 * Internal compact implementation: generate a summary from DB messages and store it.
 * Clears apiConversationId so the next narrator starts fresh with the summary.
 *
 * On failure, finalizes the marker as a failed compact message, marks narrator error,
 * and broadcasts a failure event.
 */
async function doRunCustomCompact(
	narratorId: string,
	locale: Locale,
	beforeMessageId?: string,
): Promise<void> {
	logger.info("Starting custom compact", { narratorId, beforeMessageId });

	// Fetch messages to compact
	const messages = beforeMessageId
		? await narratorService.getMessagesBefore(narratorId, beforeMessageId)
		: undefined;

	if (beforeMessageId && (!messages || messages.length === 0)) {
		logger.info("No messages to compact before target", { narratorId, beforeMessageId });
		return;
	}

	// Insert a "compacting" marker so the frontend shows a loading indicator
	const compactingMsg = await narratorService.persistCompactingMessage(narratorId, beforeMessageId);
	broadcastToNarrator(narratorId, { type: "message", narratorId, message: compactingMsg });

	// Pass the main session's prune boundary so generateCompactSummary can
	// start with tool calls already stripped for messages the main loop pruned.
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { pruneBoundaryMessageId: true },
	});
	const pruneBoundaryMessageId = narrator?.pruneBoundaryMessageId ?? null;

	try {
		const { summary, contextPercent } = await narratorContext.generateCompactSummary(
			narratorId,
			locale,
			messages,
			pruneBoundaryMessageId,
		);

		// Finalize the compacting marker — atomically sets isCompact=1,
		// updates message content, and stores contextSummary on the narrator.
		const compactedMsg = await narratorService.finalizeCompactingMessage(
			compactingMsg.id,
			narratorId,
			summary,
			contextPercent,
		);

		if (compactedMsg) {
			broadcastToNarrator(narratorId, { type: "message", narratorId, message: compactedMsg });
		}
		await narratorService.clearPruneBoundary(narratorId);

		// Atomically transition done → idle.  If a pending/buffered message
		// already kicked off a new loop iteration (status = "thinking"), the
		// CAS is a no-op — the compact ran as a fire-and-forget background
		// task and the new loop owns the status now.
		const transitioned = await narratorService.compareAndSetStatus(narratorId, "done", "idle");
		if (!transitioned) {
			logger.info("Skipping idle transition after compact — narrator already moved on", {
				narratorId,
			});
		}

		logger.info("Custom compact completed", { narratorId, summaryLength: summary.length });
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		logger.error("Custom compact failed after retries", {
			narratorId,
			messageId: compactingMsg.id,
			error: errorMsg,
		});

		const failedSummary = `${COMPACT_FAILURE_TEXT}\n${errorMsg}`;
		const failedMsg = await narratorService
			.finalizeCompactingMessage(compactingMsg.id, narratorId, failedSummary, undefined, {
				status: "failed",
				error: errorMsg,
			})
			.catch((e) => {
				logger.error("Failed to finalize failed compact marker", {
					narratorId,
					messageId: compactingMsg.id,
					error: String(e),
				});
				return null;
			});

		if (failedMsg) {
			broadcastToNarrator(narratorId, { type: "message", narratorId, message: failedMsg });
		}

		await narratorService.clearPruneBoundary(narratorId).catch(() => {});
		await narratorService.updateStatus(narratorId, "error", `Compact failed: ${errorMsg}`);
		const active = activeNarrators.get(narratorId);
		if (active?.alive) {
			active.abortController.abort();
		}
		broadcastToNarrator(narratorId, {
			type: "compact_failed",
			narratorId,
			messageId: compactingMsg.id,
		});
		throw err;
	}
}

/**
 * Run plan compact: use the plan text directly as compact summary.
 * Skips AI summary generation — the plan itself is the summary.
 */
async function runPlanCompact(narratorId: string, planText: string): Promise<void> {
	logger.info("Starting plan compact", { narratorId, planLength: planText.length });

	// persistPlanMessage atomically inserts the message, sets isCompact=1,
	// and updates narrator's contextSummary + clears apiConversationId.
	const compactMsg = await narratorService.persistPlanMessage(narratorId, planText);
	if (compactMsg) {
		broadcastToNarrator(narratorId, { type: "message", narratorId, message: compactMsg });
	}

	await narratorService.clearPruneBoundary(narratorId);
	logger.info("Plan compact completed", { narratorId, summaryLength: planText.length });
}

// === Message feeding ===

/**
 * Persist a user message and kick off the agent loop in the background.
 * Returns the active narrator and persisted message for SSE subscription.
 */
async function feedMessage(
	narratorId: string,
	prompt: string,
	images?: ImageRef[],
	locale: Locale = "en",
	replyInUserLanguage = false,
	commandText?: string | null,
	userId?: string | null,
): Promise<{ active: ActiveNarrator; userMsg: typeof narratorMessages.$inferSelect }> {
	const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);

	const persistBlocks: Array<
		| { type: "text"; text: string }
		| { type: "image"; imageId: string; filename: string; mediaType: string }
	> = [];
	if (images?.length) {
		for (const img of images) {
			persistBlocks.push({
				type: "image",
				imageId: img.imageId,
				filename: img.filename,
				mediaType: img.mediaType,
			});
		}
	}
	persistBlocks.push({ type: "text", text: prompt });
	const userMsg = await narratorService.persistUserMessage(
		narratorId,
		prompt,
		persistBlocks,
		commandText,
		userId,
	);

	await narratorService.updateStatus(narratorId, "thinking");

	const narrator = await narratorService.getById(narratorId);
	if ((narrator.messageCount ?? 0) <= 1 && !narrator.title) {
		generateQuickTitle(narratorId, prompt, locale).catch(() => {});
	}

	// Start agent loop in background
	runAgentLoop(active, prompt, images).catch(async (err) => {
		logger.error("runAgentLoop unhandled error", { narratorId, error: String(err) });
		await narratorService.updateStatus(narratorId, "error", String(err));
		broadcastToNarrator(narratorId, {
			type: "narrator_error",
			narratorId,
			error: String(err),
		});
	});

	return { active, userMsg };
}

// === Public API ===

/**
 * Send a message to a narrator (fire-and-forget).
 * Persists the user message, broadcasts it via WS, kicks off the agent loop
 * in the background, and returns the persisted user message.
 * All streaming events are delivered exclusively via WebSocket.
 */
export async function sendMessage(
	narratorId: string,
	prompt: string,
	images?: ImageRef[],
	locale: Locale = "en",
	replyInUserLanguage = false,
	commandText?: string | null,
	userId?: string | null,
): Promise<typeof narratorMessages.$inferSelect> {
	const { userMsg } = await feedMessage(
		narratorId,
		prompt,
		images,
		locale,
		replyInUserLanguage,
		commandText,
		userId,
	);
	broadcastToNarrator(narratorId, {
		type: "user_message",
		narratorId,
		message: userMsg,
	});
	return userMsg;
}

/**
 * Retry the last user message without creating a new message record.
 * Deletes any assistant/error response that followed the last user message,
 * then re-runs the agent loop with the existing user message text.
 */
export async function retryLastMessage(
	narratorId: string,
	locale: Locale = "en",
	replyInUserLanguage = false,
): Promise<{ ok: boolean }> {
	// Find the last top-level message via refs
	const lastRef = await db
		.select({
			messageId: narratorMessageRefs.messageId,
			seq: narratorMessageRefs.seq,
		})
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				isNull(narratorMessages.parentToolUseId),
				inArray(narratorMessages.role, ["user", "assistant"]),
			),
		)
		.orderBy(sql`${narratorMessageRefs.seq} DESC`)
		.limit(1);

	if (!lastRef.length) {
		throw new NotFoundError("No messages to retry", narratorId);
	}

	const lastMsg = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, lastRef[0].messageId),
	});
	if (!lastMsg || lastMsg.role !== "user") {
		throw new NotFoundError("Last message is not a user message", narratorId);
	}

	const prompt = lastMsg.contentText ?? "";
	if (!prompt.trim()) {
		throw new NotFoundError("Last user message has no text", narratorId);
	}

	// Delete any messages after the last user message (old assistant responses)
	const { deletedMessageIds } = await narratorService.deleteMessagesAfter(narratorId, lastMsg.id);
	if (deletedMessageIds.length > 0) {
		broadcastToNarrator(narratorId, {
			type: "messages_deleted",
			narratorId,
			deletedMessageIds,
		});
	}

	const imageRefs = extractImageRefs(lastMsg.contentJson);

	const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
	await narratorService.updateStatus(narratorId, "thinking");

	runAgentLoop(active, prompt, imageRefs.length > 0 ? imageRefs : undefined).catch(async (err) => {
		logger.error("runAgentLoop unhandled error (retry)", { narratorId, error: String(err) });
		await narratorService.updateStatus(narratorId, "error", String(err));
		broadcastToNarrator(narratorId, {
			type: "narrator_error",
			narratorId,
			error: String(err),
		});
	});

	return { ok: true };
}

/**
 * Regenerate from a specific message.
 * - If the target is a user message: delete everything after it, re-run agent loop with its text.
 * - If the target is an assistant message: find the preceding user message,
 *   delete the assistant message and everything after it, re-run agent loop.
 */
export async function regenerateFromMessage(
	narratorId: string,
	messageId: string,
	locale: Locale = "en",
	replyInUserLanguage = false,
): Promise<{ ok: boolean }> {
	const targetRef = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, narratorId),
			eq(narratorMessageRefs.messageId, messageId),
		),
	});
	if (!targetRef) throw new NotFoundError("Message", messageId);

	const targetMsg = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, messageId),
	});
	if (!targetMsg) throw new NotFoundError("Message", messageId);

	let userMsg: typeof targetMsg;

	if (targetMsg.role === "user") {
		// Delete everything after this user message, then re-run
		userMsg = targetMsg;
		const { deletedMessageIds } = await narratorService.deleteMessagesAfter(narratorId, messageId);
		if (deletedMessageIds.length > 0) {
			broadcastToNarrator(narratorId, {
				type: "messages_deleted",
				narratorId,
				deletedMessageIds,
			});
		}
	} else {
		// Find the user message before this assistant message
		const prevUserRef = await db
			.select({
				messageId: narratorMessageRefs.messageId,
			})
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessageRefs.messageId, narratorMessages.id))
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					isNull(narratorMessages.parentToolUseId),
					eq(narratorMessages.role, "user"),
					sql`${narratorMessageRefs.seq} < ${targetRef.seq}`,
				),
			)
			.orderBy(sql`${narratorMessageRefs.seq} DESC`)
			.limit(1);

		if (!prevUserRef.length) {
			throw new NotFoundError("No preceding user message found", messageId);
		}

		const prevUser = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, prevUserRef[0].messageId),
		});
		if (!prevUser) throw new NotFoundError("User message", prevUserRef[0].messageId);

		userMsg = prevUser;

		// Delete the target assistant message and everything after it
		const { deletedMessageIds } = await narratorService.deleteMessagesAfter(
			narratorId,
			prevUser.id,
		);
		if (deletedMessageIds.length > 0) {
			broadcastToNarrator(narratorId, {
				type: "messages_deleted",
				narratorId,
				deletedMessageIds,
			});
		}
	}

	const prompt = userMsg.contentText ?? "";
	if (!prompt.trim()) {
		throw new NotFoundError("User message has no text", narratorId);
	}

	const imageRefs = extractImageRefs(userMsg.contentJson);

	const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
	await narratorService.updateStatus(narratorId, "thinking");

	runAgentLoop(active, prompt, imageRefs.length > 0 ? imageRefs : undefined).catch(async (err) => {
		logger.error("runAgentLoop unhandled error (regenerate)", { narratorId, error: String(err) });
		await narratorService.updateStatus(narratorId, "error", String(err));
		broadcastToNarrator(narratorId, {
			type: "narrator_error",
			narratorId,
			error: String(err),
		});
	});

	return { ok: true };
}

/** Extract image refs from a message's contentJson. */
function extractImageRefs(contentJson: unknown): ImageRef[] {
	const imageRefs: ImageRef[] = [];
	if (Array.isArray(contentJson)) {
		for (const block of contentJson as Array<Record<string, unknown>>) {
			if (
				block.type === "image" &&
				typeof block.imageId === "string" &&
				typeof block.filename === "string" &&
				typeof block.mediaType === "string"
			) {
				imageRefs.push({
					imageId: block.imageId as string,
					filename: block.filename as string,
					mediaType: block.mediaType as string,
				});
			}
		}
	}
	return imageRefs;
}

/**
 * Edit a user message and regenerate the response.
 * Updates the message content, deletes everything after it, and re-runs the agent loop.
 * If rollback is true and the narrator is bound to a chapter, resets git to the state
 * before the original message was sent.
 */
export async function editAndRegenerate(
	narratorId: string,
	messageId: string,
	newContent: string,
	locale: Locale = "en",
	replyInUserLanguage = false,
	rollback = false,
): Promise<{ ok: boolean }> {
	const targetRef = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, narratorId),
			eq(narratorMessageRefs.messageId, messageId),
		),
	});
	if (!targetRef) throw new NotFoundError("Message", messageId);

	const targetMsg = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, messageId),
	});
	if (!targetMsg) throw new NotFoundError("Message", messageId);
	if (targetMsg.role !== "user") {
		throw new NotFoundError("Can only edit user messages", messageId);
	}

	// File rollback is now handled automatically by deleteMessagesAfter via snapshot revert.
	// The `rollback` parameter is kept for API compatibility but is no longer needed —
	// snapshot-based revert is always applied when messages with file changes are deleted.
	if (rollback) {
		logger.debug("editAndRegenerate: rollback param is now a no-op (auto-revert via snapshot)", {
			narratorId,
		});
	}

	// Update the message content
	const now = new Date().toISOString();
	const newContentJson = [{ type: "text", text: newContent }];

	// Preserve existing images in contentJson
	const existingImages = extractImageRefs(targetMsg.contentJson);
	for (const img of existingImages) {
		newContentJson.push({
			type: "image",
			imageId: img.imageId,
			filename: img.filename,
			mediaType: img.mediaType,
		} as { type: string; text?: string; imageId?: string; filename?: string; mediaType?: string });
	}

	await db
		.update(narratorMessages)
		.set({
			contentText: newContent,
			contentJson: newContentJson,
			updatedAt: now,
		})
		.where(eq(narratorMessages.id, messageId));

	// Broadcast the updated message
	const updatedMsg = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, messageId),
	});
	if (updatedMsg) {
		broadcastToNarrator(narratorId, {
			type: "message_updated",
			narratorId,
			message: updatedMsg,
		});
	}

	// Delete everything after this message
	const { deletedMessageIds } = await narratorService.deleteMessagesAfter(narratorId, messageId);
	if (deletedMessageIds.length > 0) {
		broadcastToNarrator(narratorId, {
			type: "messages_deleted",
			narratorId,
			deletedMessageIds,
		});
	}

	const imageRefs = existingImages;

	const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
	await narratorService.updateStatus(narratorId, "thinking");

	runAgentLoop(active, newContent, imageRefs.length > 0 ? imageRefs : undefined).catch(
		async (err) => {
			logger.error("runAgentLoop unhandled error (editAndRegenerate)", {
				narratorId,
				error: String(err),
			});
			await narratorService.updateStatus(narratorId, "error", String(err));
			broadcastToNarrator(narratorId, {
				type: "narrator_error",
				narratorId,
				error: String(err),
			});
		},
	);

	return { ok: true };
}

/**
 * Start or feed a message into a narrator.
 * Yields NarratorEvent objects for consumption (used by chapter-merge).
 */
export async function* startSession(
	narratorId: string,
	prompt: string,
	images?: ImageRef[],
	locale: Locale = "en",
	replyInUserLanguage = false,
): AsyncGenerator<NarratorEvent> {
	let active: ActiveNarrator;
	let userMsg: typeof narratorMessages.$inferSelect;
	try {
		({ active, userMsg } = await feedMessage(
			narratorId,
			prompt,
			images,
			locale,
			replyInUserLanguage,
		));
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		yield { type: "error", data: { message: errorMsg } };
		yield { type: "done", data: null };
		return;
	}

	// Subscribe to narrator events and yield them
	const eventQueue: NarratorEvent[] = [];
	let resolve: (() => void) | null = null;
	let done = false;

	const onEvent = (event: NarratorEvent) => {
		eventQueue.push(event);
		if (resolve) {
			const r = resolve;
			resolve = null;
			r();
		}
	};

	active.events.on("event", onEvent);

	// Emit user_message AFTER subscribing so it's not lost
	// Broadcast to all WS subscribers so other clients see the user message in real-time
	broadcastToNarrator(narratorId, {
		type: "user_message",
		narratorId,
		message: userMsg,
	});
	yield { type: "user_message", data: userMsg };

	try {
		while (!done) {
			while (eventQueue.length > 0) {
				const event = eventQueue.shift();
				if (!event) break;
				if (event.type === "done") {
					yield event;
					done = true;
					break;
				}
				yield event;
			}
			if (!done) {
				await new Promise<void>((r) => {
					resolve = r;
				});
			}
		}
	} finally {
		active.events.off("event", onEvent);
	}
}

// === Narrator control ===

/**
 * Clean up a partial (incomplete) assistant message and its related records.
 * Deletes children first to satisfy FK constraints.
 */
async function cleanupPartialMessage(partialId: string, narratorId: string): Promise<void> {
	try {
		await db.transaction(async (tx) => {
			await tx.delete(narratorToolCalls).where(eq(narratorToolCalls.messageId, partialId));
			await tx.delete(narratorMessageRefs).where(eq(narratorMessageRefs.messageId, partialId));
			await tx.delete(narratorMessages).where(eq(narratorMessages.id, partialId));
		});
	} catch (err) {
		logger.warn("Failed to clean up partial message on error", {
			narratorId,
			partialId,
			error: String(err),
		});
	}
}

/**
 * Mark any in-flight tool calls for this narrator as failed.
 * Without this, an interrupt leaves orphaned tool call records in
 * "initializing" / "pending" / "running" state, which breaks the
 */
async function cleanupOrphanedToolCalls(narratorId: string, locale: Locale = "en"): Promise<void> {
	const staleStatuses = ["initializing", "pending", "running"] as const;
	await db
		.update(narratorToolCalls)
		.set({
			status: "fail",
			errorMessage: "Narrator interrupted by user",
			outputJson: getToolMessage("interruptedByUser", locale),
		})
		.where(
			and(
				eq(narratorToolCalls.narratorId, narratorId),
				inArray(narratorToolCalls.status, [...staleStatuses]),
			),
		);
}

/**
 * Mark orphaned tool calls as success — used when the agent loop is
 * intentionally aborted after plan approval (the tool did complete
 * successfully but the result event was never yielded).
 */
async function completeOrphanedToolCalls(narratorId: string): Promise<void> {
	const staleStatuses = ["initializing", "pending", "running"] as const;
	await db
		.update(narratorToolCalls)
		.set({ status: "success" })
		.where(
			and(
				eq(narratorToolCalls.narratorId, narratorId),
				inArray(narratorToolCalls.status, [...staleStatuses]),
			),
		);
}

export function interruptNarrator(narratorId: string): boolean {
	const active = activeNarrators.get(narratorId);
	if (!active) return false;
	active.abortController.abort();
	// Cleanup is handled by the agent loop's onErrorCleanup callback
	// when it detects the "Aborted" error — no need to duplicate here.
	logger.info("Narrator interrupted", { narratorId });
	return true;
}

/** Gracefully close a narrator. */
export function closeNarrator(narratorId: string): void {
	const active = activeNarrators.get(narratorId);
	if (!active) return;
	active.alive = false;
	if (active._gitTrackTimer) clearTimeout(active._gitTrackTimer);
	active.abortController.abort();
	clearStreamingSnapshot(narratorId);
	cleanupOrphanedToolCalls(narratorId, active.locale).catch((err) => {
		logger.error("Failed to clean up orphaned tool calls on close", {
			narratorId,
			error: String(err),
		});
	});
	logger.info("Narrator closed", { narratorId });
}

export function isNarratorActive(narratorId: string): boolean {
	return activeNarrators.has(narratorId);
}

// === Dynamic narrator controls ===

export function updateNarratorModel(narratorId: string, model: string): void {
	const active = activeNarrators.get(narratorId);
	if (active?.alive) {
		active.model = model;
		active.provider = resolveProvider(model);
		broadcastToNarrator(narratorId, {
			type: "model_changed",
			narratorId,
			model,
		});
	}
}

/** Update the cached chapter role for a live narrator (e.g. after promote). */
export function updateNarratorChapterRole(narratorId: string, role: string): void {
	const active = activeNarrators.get(narratorId);
	if (active) {
		active._chapterRole = role;
	}
}

export async function updateNarratorPermissionMode(
	narratorId: string,
	mode: string,
): Promise<void> {
	// Permission mode is read from DB in real-time by handlePermission.
	// When switching to/from plan mode, manage the plan file ID on the active narrator.
	const active = activeNarrators.get(narratorId);
	if (!active) return;
	if (mode === "plan") {
		if (!active._planFileId) {
			active._planFileId = generateShortId();
		}
		// _previousPermissionMode is also persisted in DB by narratorService.updatePermissionMode,
		// so onExitPlanMode will read it from DB if the in-memory value is missing.
	} else {
		active._planFileId = undefined;
		active._previousPermissionMode = undefined;
	}
}

// === Buffered message queue API ===

/** Push a message onto the queue. Returns the generated message id. */
export function pushBufferedMessage(
	narratorId: string,
	text: string,
	images?: ImageRef[],
	commandText?: string | null,
	createdBy?: string | null,
): { ok: boolean; bufferedAt: string; id: string } {
	if (!activeNarrators.has(narratorId)) {
		return { ok: false, bufferedAt: "", id: "" };
	}
	const id = generateShortId();
	const bufferedAt = new Date().toISOString();
	const queue = bufferedMessages.get(narratorId) ?? [];
	queue.push({ id, text, images, bufferedAt, commandText, createdBy });
	bufferedMessages.set(narratorId, queue);
	return { ok: true, bufferedAt, id };
}

/** Edit a queued message in-place. */
export function updateBufferedMessage(
	narratorId: string,
	messageId: string,
	text: string,
	images?: ImageRef[],
): boolean {
	const queue = bufferedMessages.get(narratorId);
	if (!queue) return false;
	const msg = queue.find((m) => m.id === messageId);
	if (!msg) return false;
	msg.text = text;
	if (images !== undefined) msg.images = images;
	msg.bufferedAt = new Date().toISOString();
	return true;
}

/** Remove a single queued message. */
export function removeBufferedMessage(narratorId: string, messageId: string): boolean {
	const queue = bufferedMessages.get(narratorId);
	if (!queue) return false;
	const idx = queue.findIndex((m) => m.id === messageId);
	if (idx === -1) return false;
	queue.splice(idx, 1);
	if (queue.length === 0) bufferedMessages.delete(narratorId);
	return true;
}

/** Clear the entire queue. */
export function clearBufferedMessages(narratorId: string): void {
	bufferedMessages.delete(narratorId);
}

/** Get the full queue (for REST hydration). */
export function getBufferedMessages(narratorId: string): BufferedMessage[] {
	return bufferedMessages.get(narratorId) ?? [];
}

/** Project a buffer queue to the minimal shape needed for WS broadcast / REST responses. */
export function toBufferSummary(
	msgs: readonly Pick<BufferedMessage, "id" | "text" | "bufferedAt">[],
): Array<{ id: string; text: string; bufferedAt: string }> {
	return msgs.map((m) => ({ id: m.id, text: m.text, bufferedAt: m.bufferedAt }));
}

// === Startup recovery ===

/**
 * Guard against running recovery during Bun --hot reloads.
 * In --hot mode the process stays alive but modules are re-evaluated,
 * so activeNarrators is reset to an empty Map while agent loops are
 * still running in the background.  Running recovery in that state
 * would incorrectly mark in-flight tool calls as "server restart".
 *
 * We use a globalThis flag that survives module re-evaluation (the
 * process is the same) to detect hot reloads vs. cold starts.
 */
const HOT_RELOAD_GUARD = Symbol.for("narrafork.narrator.initialized");

/** Clean up stale in-progress states left by a previous server run. */
export async function recoverOnStartup(): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: globalThis symbol key
	if ((globalThis as any)[HOT_RELOAD_GUARD]) {
		logger.info("Skipping narrator recovery (hot reload detected)");
		return;
	}
	// biome-ignore lint/suspicious/noExplicitAny: globalThis symbol key
	(globalThis as any)[HOT_RELOAD_GUARD] = true;

	const now = new Date().toISOString();
	const migrations = [
		["active", "idle"],
		["paused", "idle"],
		["completed", "archived"],
		["thinking", "idle"],
		["waiting", "idle"],
	] as const;
	const stmt = sqlite.prepare("UPDATE narrators SET status = ?, updated_at = ? WHERE status = ?");
	for (const [from, to] of migrations) {
		const result = stmt.run(to, now, from);
		if (result.changes > 0) {
			logger.info(`Narrator status migrated: ${from} → ${to}`, { count: result.changes });
		}
	}

	const stalePermissions = await db.query.narratorToolCalls.findMany({
		where: eq(narratorToolCalls.status, "pending"),
	});
	if (stalePermissions.length > 0) {
		await db
			.update(narratorToolCalls)
			.set({
				status: "fail",
				errorMessage: "Interrupted by server restart",
				permissionDecidedBy: "server_restart",
				permissionDecidedAt: now,
			})
			.where(eq(narratorToolCalls.status, "pending"));
		logger.info("Stale pending tool calls auto-denied on startup", {
			count: stalePermissions.length,
		});
	}

	const staleToolCalls = await db.query.narratorToolCalls.findMany({
		where: eq(narratorToolCalls.status, "running"),
	});
	if (staleToolCalls.length > 0) {
		await db
			.update(narratorToolCalls)
			.set({
				status: "fail",
				errorMessage: "Interrupted by server restart",
				outputJson: getToolMessage("interruptedByServerRestart"),
			})
			.where(eq(narratorToolCalls.status, "running"));
		logger.info("Stale running tool calls marked as failed on startup", {
			count: staleToolCalls.length,
		});
	}

	// Also recover tool calls stuck in "initializing" (permission check never started)
	const staleInitializing = await db.query.narratorToolCalls.findMany({
		where: eq(narratorToolCalls.status, "initializing"),
	});
	if (staleInitializing.length > 0) {
		await db
			.update(narratorToolCalls)
			.set({
				status: "fail",
				errorMessage: "Interrupted by server restart",
				outputJson: getToolMessage("interruptedByServerRestart"),
			})
			.where(eq(narratorToolCalls.status, "initializing"));
		logger.info("Stale initializing tool calls marked as failed on startup", {
			count: staleInitializing.length,
		});
	}

	// Clean up stale "compacting" marker messages left by a previous crash.
	// These are compact operations that started but never finalized.
	const staleCompacting = await db.query.narratorMessages.findMany({
		where: and(
			eq(narratorMessages.role, "system"),
			eq(narratorMessages.contentText, "[Compacting]"),
		),
	});
	for (const msg of staleCompacting) {
		await narratorService.removeCompactingMessage(msg.narratorId, msg.id).catch((e) => {
			logger.error("Failed to clean up stale compacting message", {
				messageId: msg.id,
				narratorId: msg.narratorId,
				error: String(e),
			});
		});
	}
	if (staleCompacting.length > 0) {
		logger.info("Stale compacting messages cleaned up on startup", {
			count: staleCompacting.length,
		});
	}
}

// ---------------------------------------------------------------------------
// Optional tool management
// ---------------------------------------------------------------------------

/**
 * Enable an optional tool for a narrator.
 * Persists to DB and updates the in-memory session if active.
 */
export async function loadOptionalTool(
	narratorId: string,
	toolName: string,
): Promise<"loaded" | "already_loaded" | "unknown_tool"> {
	if (!OPTIONAL_TOOLS.has(toolName)) return "unknown_tool";

	// Read current enabled tools from DB
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { enabledTools: true },
	});
	const current: string[] = (narrator?.enabledTools as string[] | null) ?? [];
	if (current.includes(toolName)) return "already_loaded";

	// Persist
	await db
		.update(narrators)
		.set({ enabledTools: [...current, toolName] })
		.where(eq(narrators.id, narratorId));

	// Also update in-memory session if active
	const active = activeNarrators.get(narratorId);
	if (active) {
		active._enabledOptionalTools.add(toolName);
	}

	logger.info("Optional tool loaded", { narratorId, toolName });
	return "loaded";
}

/** Get the set of enabled optional tool names for a narrator session. */
export function getEnabledOptionalTools(narratorId: string): Set<string> {
	const active = activeNarrators.get(narratorId);
	return active?._enabledOptionalTools ?? new Set();
}
