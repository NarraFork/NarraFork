import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatFileSize } from "@shared/text-file-types";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
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
	overseers,
	projects,
} from "../db/schema";
import { buildHistory, type PermissionResult, resolveProviderAndModel } from "../lib/agent";
import { analyzeShellCommand, type BashAnalysis } from "../lib/agent/bash-analyze";
import { detectShell } from "../lib/agent/shell";
import { SHELL_TOOL_NAME } from "../lib/agent/tools/bash";
import { OPTIONAL_TOOLS, OVERSEER_TOOLS, REVIEW_TOOLS } from "../lib/agent/tools/index";
import { OUTPUT_DIR as TRUNCATE_OUTPUT_DIR } from "../lib/agent/truncate";
import { getBuiltinToolRoutines } from "../lib/builtin-routines";
import { NotFoundError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { hotSafe } from "../lib/hot-safe";
import { generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import { getHome } from "../lib/platform";
import { isInsidePath, pathsEqual, resolvePath } from "../lib/platform-path";
import { getToolMessage, getToolMessageWithParams, type Locale } from "../lib/prompt-i18n";
import {
	getContextThresholds,
	isAnthropicProvider,
	resolveDefaultReasoningEffort,
	resolveEffectiveModel,
	resolveProvider,
	settings,
	usesCodexApiMode,
	usesStatefulApi,
} from "../lib/settings";
import type { ImageRef, TextFileRef } from "../lib/uploads";
import { getImagePath, imageToBase64, saveTextFileToWorktree } from "../lib/uploads";
import { generateWordSlug } from "../lib/words";
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
	getMaxTransientRetries,
	getRetryBackoffCeilMs,
	handleContextOverflow,
	handleTransientError,
	MAX_CONTEXT_OVERFLOW_RETRIES,
} from "./narrator-recovery";
import { narratorService } from "./narrator-service";
import { generateAndSetTitle, generateQuickTitle } from "./narrator-title";
import { reviewService } from "./review-service";
import { getConclusionFileId, resolveConclusionFilePath } from "./subagent-conclusion";
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
	/** Whether this narrator is bound to an overseer */
	_isOverseer: boolean;
	/** Soft-stop flag: set when user approves a permission with feedbackText.
	 *  The agent loop checks this via shouldStop() after tools complete. */
	_feedbackSoftStop?: boolean;
	/** Whether the agent loop is currently running for this narrator. */
	_loopRunning?: boolean;
}

// Use globalThis to survive Bun --hot reloads.  Module-level variables are
// re-initialised on hot reload, but agent loops spawned by the previous module
// evaluation are still running in the background.  Losing the Map reference
// means the old loop's finally-block deletes from a *new* empty Map while the
// new code creates a second ActiveNarrator for the same narrator — leading to
// two concurrent loops and status clobbering.

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

// Tracks the userId of the user who approved the plan — keyed by narratorId
const pendingPlanApprover = hotSafe<Map<string, string>>(
	"narrafork.pendingPlanApprover",
	() => new Map(),
);

// Tracks the diff text when user edits the plan before approving — keyed by narratorId
const pendingPlanDiff = hotSafe<Map<string, string>>("narrafork.pendingPlanDiff", () => new Map());

// Overseer permission request queue — keyed by overseer narratorId.
// When the overseer's agent loop is already running, new permission requests
// are queued here instead of spawning a concurrent loop.
interface OverseerQueuedMessage {
	requestId: string;
	narratorId: string;
	toolName: string;
	toolUseId: string;
	input: Record<string, unknown>;
	textForModel: string;
	contentBlocks: unknown[];
	broadcastTargetId: string;
}
const pendingOverseerMessages = hotSafe<Map<string, OverseerQueuedMessage[]>>(
	"narrafork.pendingOverseerMessages",
	() => new Map(),
);

// Buffered message queue — keyed by narratorId, supports multiple queued messages
export interface BufferCreator {
	id: string;
	username: string;
	avatarColor?: string | null;
	avatarImageId?: string | null;
}

interface BufferedMessage {
	id: string;
	text: string;
	images?: ImageRef[];
	textFiles?: File[];
	bufferedAt: string;
	commandText?: string | null;
	createdBy?: string | null;
	creator?: BufferCreator | null;
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
			data: {
				percentage: number;
				promptTokens?: number;
				contextWindow?: number;
				isEstimated?: boolean;
			};
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
	/** Conclusion file ID for explore/plan subagents — Write/Edit to this file is allowed in readOnly mode */
	conclusionFileId?: string;
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
	/** Project git repository root path — used for structural path protection. */
	projectGitPath?: string;
	/** WebFetch URL permission policy. */
	webFetchPolicy?: {
		allowAll?: boolean;
		whitelist?: Array<{ pattern: string; enabled?: boolean }>;
		blacklist?: Array<{ pattern: string; enabled?: boolean }>;
	};
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

// ── Protected path checks (hard-deny, no bypass) ─────────

/** Write-operation tools that target a single file_path. */
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit", "MultiEdit"]);

/** Destructive shell commands that delete files/directories. */
const DESTRUCTIVE_COMMANDS = new Set(["rm", "rmdir", "shred"]);

/** Check if an absolute path points inside a `.git` directory (or is `.git` itself). */
function isGitInternalPath(absPath: string): boolean {
	const normalized = resolvePath(absPath);
	// Matches: /foo/.git, /foo/.git/config, /foo/.git/objects/...
	const segments = normalized.split("/");
	return segments.includes(".git");
}

/**
 * Check if an absolute path is a "structural" path that must not be destroyed:
 * - The project directory itself (gitPath)
 * - Any ancestor of the project directory
 * - The `.worktrees` directory itself
 *
 * Returns a human-readable reason string, or null if not structural.
 */
function isStructuralPath(absPath: string, projectGitPath: string): string | null {
	const normalizedTarget = resolvePath(absPath);
	const normalizedProject = resolvePath(projectGitPath);

	// Project directory itself
	if (pathsEqual(normalizedTarget, normalizedProject)) {
		return `project root directory: ${normalizedProject}`;
	}
	// Ancestor of project directory (projectGitPath is inside absPath)
	if (
		isInsidePath(normalizedTarget, normalizedProject) &&
		!pathsEqual(normalizedTarget, normalizedProject)
	) {
		return `ancestor of project root: ${normalizedTarget}`;
	}
	// .worktrees directory itself
	if (pathsEqual(normalizedTarget, `${normalizedProject}/.worktrees`)) {
		return `worktrees directory: ${normalizedTarget}`;
	}
	return null;
}

/**
 * Hard-deny check for protected paths. Runs before any permission mode logic.
 *
 * Two protection levels:
 * 1. `.git` — full write protection (Write/Edit deny; Bash with write ops deny)
 * 2. Structural paths (project dir, ancestors, .worktrees) — destructive-only protection
 *    (only rm/rmdir/shred targeting these paths are denied)
 *
 * Returns a deny-reason string, or null if no protection triggered.
 */
function resolveProtectedPathDeny(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	projectGitPath: string | undefined,
	bashAnalysis?: BashAnalysis,
): string | null {
	// ── Write/Edit tools: only .git protection ──
	if (WRITE_TOOLS.has(toolName)) {
		const filePath = typeof input.file_path === "string" ? input.file_path : "";
		if (!filePath) return null;
		const absPath = resolvePath(cwd, filePath);
		if (isGitInternalPath(absPath)) {
			return `Write to .git directory is forbidden: ${absPath}`;
		}
		// Structural paths are NOT blocked for Write/Edit (they're not destructive)
		return null;
	}

	// ── Bash/Shell tool ──
	if (toolName === SHELL_TOOL_NAME && bashAnalysis) {
		// 1. .git full write protection: any write operation touching .git paths
		if (bashAnalysis.hasWriteOperation) {
			for (const p of bashAnalysis.filePaths) {
				if (isGitInternalPath(p)) {
					return `Shell write operation targeting .git directory is forbidden: ${p}`;
				}
			}
		}

		// 2. Structural path protection: only destructive commands
		if (projectGitPath) {
			for (const cmd of bashAnalysis.commands) {
				const cmdName = cmd.tokens[0];
				if (!DESTRUCTIVE_COMMANDS.has(cmdName)) continue;
				// Extract non-flag arguments as potential path targets
				for (const arg of cmd.tokens.slice(1)) {
					if (arg.startsWith("-")) continue;
					const absArg = resolvePath(cwd, arg);
					// .git protection for destructive commands too
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
	// Catastrophic commands are ALWAYS blocked — no override possible
	if (toolName === SHELL_TOOL_NAME && bashAnalysis?.isCatastrophic) return "fatal";

	// Chapter mode: git branch violations are hard-denied (no bypass)
	if (toolName === SHELL_TOOL_NAME && isChapter && bashAnalysis?.gitBranchViolations?.length)
		return "deny";

	// Chapter mode: git branch warnings require user approval (ask)
	if (toolName === SHELL_TOOL_NAME && isChapter && bashAnalysis?.gitBranchWarnings?.length)
		return "ask";

	// Protected path check — hard-deny, no bypass possible.
	// .git: all write operations denied. Structural paths: destructive ops only.
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

	// Plan mode: Write/Edit to the designated plan file is always allowed.
	if (permMode === "plan" && (toolName === "Write" || toolName === "Edit")) {
		if (planFileId) {
			const filePath = typeof input.file_path === "string" ? input.file_path : "";
			const absPath = resolvePath(cwd, filePath);
			const planFilePath = resolvePath(cwd, `.narrafork/plan-${planFileId}.md`);
			if (pathsEqual(absPath, planFilePath)) return "allow";
		}
		// Strict plan: deny non-plan-file writes with explicit reason.
		if (!relaxedPlan) {
			if (meta) {
				const planFile = planFileId ? `.narrafork/plan-${planFileId}.md` : "(unknown)";
				meta.blacklistReason =
					`Plan mode: Write/Edit is only allowed to the plan file "${planFile}". ` +
					`Write your plan to that file, then call ExitPlanMode. ` +
					`Only after the user approves your plan can you implement changes.`;
			}
			return "deny";
		}
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

	// WebFetch: URL-based permission policy.
	// Default behaviour is "ask" (needs user approval).
	// allowAll → auto-allow everything.
	// blacklist match → deny (priority over whitelist).
	// whitelist match → allow.
	// No match → "ask" (or "deny" in readOnly/dontAsk modes).
	if (toolName === "WebFetch") {
		const url = typeof input.url === "string" ? input.url.toLowerCase() : "";
		const policy = opts.webFetchPolicy;
		if (policy) {
			// Blacklist takes priority
			const blEntries = (policy.blacklist ?? []).filter((e) => e.enabled !== false);
			for (const entry of blEntries) {
				if (entry.pattern && url.includes(entry.pattern.toLowerCase())) {
					if (meta)
						meta.blacklistReason = `WebFetch URL blocked by blacklist pattern: "${entry.pattern}"`;
					return "deny";
				}
			}
			// allowAll
			if (policy.allowAll) return "allow";
			// Whitelist
			const wlEntries = (policy.whitelist ?? []).filter((e) => e.enabled !== false);
			for (const entry of wlEntries) {
				if (entry.pattern && url.includes(entry.pattern.toLowerCase())) {
					return "allow";
				}
			}
		}
		// Fallback: respect permission mode
		if (effectiveMode === "bypassPermissions") return "allow";
		if (effectiveMode === "dontAsk") return "deny";
		// readOnly: WebFetch is a read-only operation — ask instead of deny
		if (effectiveMode === "readOnly") return "ask";
		return "ask";
	}

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
			// Non-explore/plan subagents may have write access — always deny in readOnly
			if (input.subagent_type !== "explore" && input.subagent_type !== "plan") return "deny";
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
		// Conclusion file: explore/plan subagents may Write/Edit their designated conclusion file.
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

	let effectiveInput = input;

	// ExitPlanMode: resolve plan content from the designated plan file (preferred)
	// or fall back to inline `plan` parameter, then reject if still empty.
	if (toolName === "ExitPlanMode") {
		// Step 1: Always prefer the plan file content over inline `plan` parameter.
		// This ensures the user reviews the actual file the model wrote, not a
		// potentially stale or duplicated inline copy.
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
				// Ignore read errors — fall through to inline plan or empty-plan check
			}
		}
		// Fall back to inline `plan` parameter only when the file doesn't exist or is empty.
		if (!resolvedFromFile) {
			const inlinePlan = typeof input.plan === "string" ? input.plan.trim() : "";
			if (inlinePlan) {
				effectiveInput = { ...effectiveInput, plan: inlinePlan };
			}
		}

		// Step 2: Reject if plan content is still empty — prevents empty approval dialog.
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

	// Plan mode: redirect Write/Edit targeting any .md file to the designated plan file,
	// instead of rejecting outright.
	// The model sometimes forgets the exact plan file path — this saves a wasted tool call.
	let planRedirectNotice: string | undefined;
	if (isPlanMode && !isRelaxedPlan && planFileId && (toolName === "Write" || toolName === "Edit")) {
		const filePath = typeof effectiveInput.file_path === "string" ? effectiveInput.file_path : "";
		if (filePath) {
			const absPath = resolvePath(cwd, filePath);
			const planFilePath = resolvePath(cwd, `.narrafork/plan-${planFileId}.md`);
			if (!pathsEqual(absPath, planFilePath)) {
				// Check if the filename ends with .md
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

	// Conclusion file redirect: explore/plan subagents have all Write/Edit
	// redirected to their designated conclusion file.
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
	const conclusionFileId = getConclusionFileId(narratorId);
	const decision = resolvePermissionDecision({
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
	// Chapter mode git branch warnings — include in decisionReason for ask flow
	if (isChapter && bashAnalysis?.gitBranchWarnings?.length) {
		const warningMsg = `Chapter branch warnings: ${bashAnalysis.gitBranchWarnings.join("; ")}`;
		decisionReason = decisionReason ? `${decisionReason}; ${warningMsg}` : warningMsg;
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

	// Route to overseer (async, non-blocking — overseer and user compete)
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

	// Clean up timeout + abort listener to prevent stale handlers from firing
	pending.cleanup();

	// Remove this request from any overseer queue (user resolved before overseer got to it)
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

		// Track the approver userId for ExitPlanMode so the continuation message
		// can display the approver's avatar and username.
		if (pending.toolName === "ExitPlanMode" && userId) {
			pendingPlanApprover.set(pending.narratorId, userId);
		}

		// Track plan diff when user edited the plan before approving
		if (updatedPlan !== undefined && pending.toolName === "ExitPlanMode") {
			const originalPlan = typeof pending.input.plan === "string" ? pending.input.plan : "";
			if (originalPlan && updatedPlan !== originalPlan) {
				const diff = computeLineDiff(originalPlan, updatedPlan);
				if (diff) {
					pendingPlanDiff.set(pending.narratorId, diff);
				}
			}
		}

		pending.resolve({ behavior: "allow", updatedInput: effectiveUpdatedInput });

		// If the user attached feedback text, set a soft-stop flag so the agent
		// loop exits gracefully after the current tool completes — without killing
		// running processes (unlike abort which would terminate Bash mid-execution).
		// The outer while-loop will pick up pendingFeedback and inject the user
		// message before starting a fresh agent loop iteration.
		// Exception: ExitPlanMode already aborts via onExitPlanMode — soft-stopping
		// here would race and prevent the tool_result from being processed.
		if (feedbackText?.trim() && pending.toolName !== "ExitPlanMode") {
			const active = activeNarrators.get(pending.narratorId);
			if (active?.alive) {
				active._feedbackSoftStop = true;
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
	return true;
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

// === Overseer permission routing ===

/**
 * Route a permission request to the responsible overseer (if any).
 * This is fire-and-forget: the overseer and user compete to resolve the request.
 * Whoever resolves first wins (pendingPermissions.resolve is idempotent).
 */
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
	if (!overseer) return; // No overseer — user handles it

	const policy = getOverseerPolicy(overseer);
	if (!policy.handleEvents.permissionRequests) return; // Overseer doesn't handle permissions

	// Build a descriptive message for the overseer
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { id: true, title: true, chapterId: true },
	});

	const narratorTitle = narrator?.title ?? "Untitled";
	const inputSummary = JSON.stringify(input, null, 2).slice(0, 2000);

	// Structured block for frontend rendering
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

	// Resolve locale for the overseer's prompt
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

	// Text version for the AI model
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

	// Check if the overseer's agent loop is already running
	const existingActive = activeNarrators.get(overseer.narratorId);
	if (existingActive?.alive && existingActive._loopRunning) {
		// Queue the message — the overseer's loop will pick it up when the current turn ends
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

		// Notify the source narrator's UI that this request is queued for overseer
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

	// Overseer is idle — persist and start the loop directly
	try {
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

		await narratorService.updateStatus(overseer.narratorId, "thinking");

		// Notify the source narrator's UI that the overseer is actively reviewing
		broadcastToNarrator(broadcastTargetId, {
			type: "overseer_reviewing",
			narratorId: broadcastTargetId,
			requestId: toolCallId,
			toolUseId,
			status: "reviewing",
			overseerId: overseer.id,
		});

		// Start agent loop in background
		runAgentLoop(active, textForModel).catch(async (err) => {
			logger.warn("Overseer agent loop failed", {
				overseerId: overseer.id,
				error: String(err),
			});
			await narratorService.updateStatus(overseer.narratorId, "error", String(err));
		});
	} catch (err) {
		logger.warn("Failed to route permission to overseer", {
			overseerId: overseer.id,
			narratorId,
			error: String(err),
		});
	}
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
	defaultSystemPrompt?: string | null,
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
		defaultSystemPrompt,
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
	const planFileId = isPlanMode ? generateWordSlug() : undefined;

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
		settings.agent.defaultSystemPrompt,
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

	const narratorModel = resolveEffectiveModel(narrator.model);

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
		_isOverseer: false,
	};

	// Check if this narrator is bound to an overseer
	{
		const overseerRecord = await db.query.overseers.findFirst({
			where: eq(overseers.narratorId, narratorId),
			columns: { id: true },
		});
		if (overseerRecord) {
			active._isOverseer = true;
		}
	}

	// Auto-load optional tools whose routines are globally enabled
	const disabledRoutines = new Set(settings.routines?.disabledRoutines ?? []);
	const enabledRoutines = new Set(settings.routines?.enabledRoutines ?? []);
	for (const routine of getBuiltinToolRoutines()) {
		if (!routine.tool) continue;
		const on = routine.defaultEnabled
			? !disabledRoutines.has(routine.id)
			: enabledRoutines.has(routine.id);
		if (on) {
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

/**
 * Minimum prunedPercent required before compact is allowed at the compactStart
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
				logger.debug("No compact boundary found, aborting mid-turn compact", { narratorId });
				if (compactLocks.get(narratorId) === placeholder) {
					compactLocks.delete(narratorId);
				}
				return;
			}
			// Release the placeholder lock before calling runCustomCompact,
			// which sets its own lock. Otherwise runCustomCompact sees the
			// placeholder and thinks a compact is already in progress.
			if (compactLocks.get(narratorId) === placeholder) {
				compactLocks.delete(narratorId);
			}
			logger.info("Starting runCustomCompact", {
				narratorId,
				boundaryMessageId,
				hasLock: compactLocks.has(narratorId),
			});
			runCustomCompact(narratorId, locale, boundaryMessageId)
				.then(() => {
					onCompactDone?.();
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

interface ContinuableTopLevelMessage {
	role: string;
	parentToolUseId?: string | null;
	contentJson?: unknown;
	toolCalls?: Array<{ toolUseId?: string | null; toolName?: string | null }>;
}

function getLastContinuableTopLevelMessage<T extends ContinuableTopLevelMessage>(
	messages: T[],
): T | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || msg.parentToolUseId) continue;
		if (msg.role !== "user" && msg.role !== "assistant") continue;
		return msg;
	}
	return undefined;
}

function shouldReplayToolResultPacket(msg: ContinuableTopLevelMessage | undefined): boolean {
	if (!msg || msg.role !== "assistant") return false;
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	if (blocks.some((block: { type?: string }) => block?.type === "tool_use")) return true;
	return (
		Array.isArray(msg.toolCalls) &&
		msg.toolCalls.some((tc) => Boolean(tc?.toolUseId) && Boolean(tc?.toolName))
	);
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
	/** Check whether a compact just finished and the next turn needs a full rebuild */
	isCompactDone?: () => boolean;
	/** Clear the compact-done flag after the rebuild has been applied */
	clearCompactDone?: () => void;
	/** Rebuild the system prompt with the latest contextSummary from DB */
	rebuildSystemPrompt?: () => Promise<string | null>;
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
		isCompactDone,
		clearCompactDone,
		rebuildSystemPrompt,
	} = opts;

	const onContextUsage = (percentage: number) => {
		const thresholds = getContextThresholds(getModel(), getProvider());

		// Dynamic pruning: pruneStart – (compactStart - 1)%
		if (
			percentage >= thresholds.pruneStart &&
			percentage < thresholds.compactStart &&
			!pruneLocks.has(narratorId)
		) {
			pruneLocks.add(narratorId);
			narratorService
				.computeAndUpdatePruneBoundary(narratorId, percentage, thresholds)
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

		// ≥ compactStart%: check prunedPercent before deciding compact vs continued prune.
		// If prunedPercent < 80%, there's still room to prune further — skip compact.
		// Exception: when pruning is disabled for this narrator, skip the prune gate
		// and compact immediately (otherwise compact would never trigger).
		if (
			percentage >= thresholds.compactStart &&
			!pruneLocks.has(narratorId) &&
			!compactLocks.has(narratorId)
		) {
			pruneLocks.add(narratorId);
			narratorService
				.computeAndUpdatePruneBoundary(narratorId, percentage, thresholds)
				.then(async (result) => {
					broadcastToNarrator(narratorId, {
						type: "prune_boundary",
						narratorId,
						boundaryMessageId: result?.boundaryMessageId ?? null,
						prunedPercent: result?.prunedPercent ?? null,
					});

					// If prune returned null (e.g. pruning disabled), check the DB flag
					// to decide whether to skip the prune gate entirely.
					if (result == null) {
						const row = await db.query.narrators.findFirst({
							where: eq(narrators.id, narratorId),
							columns: { pruneEnabled: true },
						});
						if (row && !row.pruneEnabled) {
							// Pruning disabled — go straight to compact
							triggerMidTurnCompact(narratorId, locale, onCompactDone);
							return;
						}
					}

					const prunedPct = result?.prunedPercent ?? 0;
					if (prunedPct < COMPACT_PRUNE_THRESHOLD_PCT) {
						logger.info(
							"Context above compactStart but prunedPercent below threshold, continuing prune",
							{
								narratorId,
								contextPct: percentage,
								prunedPercent: prunedPct,
								threshold: COMPACT_PRUNE_THRESHOLD_PCT,
							},
						);
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
		// Check if a compact just finished — if so, force a full rebuild
		// (history + system prompt) so the next API call uses compacted data.
		// This takes priority over the prune-boundary check below because compact
		// already clears the prune boundary and returns a fresh message set.
		const compactJustDone = isCompactDone?.() ?? false;
		if (compactJustDone) {
			clearCompactDone?.();
			// After compact, pruneBoundary is cleared — sync local cache
			setPruneBoundary(null);
			const rawMsgs = await narratorService.getMessagesSinceLastCompact(narratorId);
			const msgs = isSubagentNarrator
				? rawMsgs.map((m) => ({ ...m, parentToolUseId: null }))
				: rawMsgs;
			const result = await buildHistory(msgs, getModel(), getProvider(), narratorId);
			const systemPrompt = (await rebuildSystemPrompt?.()) ?? undefined;
			return {
				history: result.history,
				pendingToolResults: result.trailingToolResults,
				systemPrompt,
			};
		}

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
	active._loopRunning = true;
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
			let compactDoneFlag = false;
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
					compactDoneFlag = true;
				},
				isCompactDone: () => compactDoneFlag,
				clearCompactDone: () => {
					compactDoneFlag = false;
				},
				rebuildSystemPrompt: async () => {
					const freshNarrator = await narratorService.getById(narratorId);
					const { prompt } = await buildSystemPrompt(
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
						settings.agent.defaultSystemPrompt,
					);
					// NOTE: Do NOT set active.systemPrompt here — the returned value
					// flows through onBeforeTurn → loop.ts which updates config.systemPrompt.
					// Setting active.systemPrompt would create a second source of truth.
					return prompt;
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
					active._planFileId = generateWordSlug();
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
									]).then(
										([gitStatus, ahead]) => {
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
												linesAdded: gitStatus.linesAdded,
												linesRemoved: gitStatus.linesRemoved,
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
							cleanupTasks.push(
								finalizeOrCleanupPartialMessage(partialId, narratorId).then(() => {}),
							);
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
						await finalizeOrCleanupPartialMessage(partialId, narratorId);
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
				chapterId: active._chapterId,
				planMode: freshNarrator.permissionMode === "plan",
				relaxedPlan: !!freshNarrator.relaxedPlan,
				planFileId: active._planFileId,
				skillRoot: active._skillRoot ?? undefined,
				reasoningEffort: resolvedReasoningEffort,
				serviceTier: resolvedServiceTier,
				maxTransientRetries: getMaxTransientRetries(),
				retryBackoffCeilMs: getRetryBackoffCeilMs(),
				metadata: isAnthropicProvider(resolved.provider)
					? { user_id: `user_${narratorId}_account__session_${active.conversationId}` }
					: undefined,
				// Exclude optional tools that haven't been loaded for this session
				toolFilter: (tool) => {
					if (OPTIONAL_TOOLS.has(tool.name)) {
						return active._enabledOptionalTools.has(tool.name);
					}
					// Overseer tools: only available if this narrator is an overseer
					if (OVERSEER_TOOLS.has(tool.name)) {
						return active._isOverseer;
					}
					// Review tools: only available for review chapter narrators
					if (REVIEW_TOOLS.has(tool.name)) {
						return active._chapterRole === "review";
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
				shouldStop: () => {
					if (active._feedbackSoftStop) {
						active._feedbackSoftStop = false;
						return true;
					}
					return false;
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

			// When replaying a pure tool-result turn, preserve the original packet shape:
			// no synthetic user text, no auto-added todos wrapper.
			const isPureToolResultReplay = !currentText.trim() && trailingToolResults.length > 0;
			const effectiveText = isPureToolResultReplay
				? ""
				: appendTodosContext(currentText, freshNarrator.todosJson);

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
				// Finalize or clean up the partial message from the failed turn.
				// If tools were already executed, the message is kept so the
				// retry's rebuilt history includes them.
				const partialId = active._partialMessageId;
				active._partialMessageId = undefined;
				if (partialId) {
					await finalizeOrCleanupPartialMessage(partialId, narratorId);
				}

				const overflow = await handleContextOverflow({
					narratorId,
					locale,
					provider: active.provider,
					model: active.model,
					overflowRetries: contextOverflowRetries,
					maxRetries: MAX_CONTEXT_OVERFLOW_RETRIES,
					onBroadcast(event) {
						broadcastToNarrator(narratorId, event as Parameters<typeof broadcastToNarrator>[1]);
					},
				});
				contextOverflowRetries = overflow.overflowRetries;

				if (overflow.action === "retry_pruned") {
					active._pruneBoundaryMessageId = overflow.boundaryMessageId;
					transientRetries = 0;
					continue;
				}
				if (overflow.action === "retry_compacted") {
					active.conversationId = overflow.newConversationId;
					transientRetries = 0;
					continue;
				}

				// All attempts failed
				logger.error("Context length exceeded after max retries", { narratorId });
				await narratorService.updateStatus(
					narratorId,
					"error",
					"Context too long, compact failed",
					"context_too_long_compact_failed",
				);
				active.events.emit("event", {
					type: "error",
					data: { message: "Context too long, compact failed" },
				});
				loopHadError = true;
				break;
			}

			// --- Transient API error: warn frontend and retry with backoff ---
			// For stateless providers, the agentLoop already retried internally with
			// identical history/content — reaching here means all in-loop retries
			// were exhausted.  Only stateful providers (responses/codex) benefit from
			// an outer retry that rebuilds history from DB.
			if (result.retryableError && active.alive) {
				if (!usesStatefulApi(resolved.provider)) {
					// Stateless provider: in-loop retries exhausted — give up.
					const partialId = active._partialMessageId;
					active._partialMessageId = undefined;
					if (partialId) {
						await finalizeOrCleanupPartialMessage(partialId, narratorId);
					}
					await narratorService.updateStatus(narratorId, "error", result.retryableError);
					active.events.emit("event", {
						type: "error",
						data: { message: result.retryableError },
					});
					loopHadError = true;
					break;
				}
				// Stateful provider: outer retry with rebuilt history
				transientRetries++;
				const { shouldRetry } = await handleTransientError({
					narratorId,
					error: result.retryableError,
					retryCount: transientRetries,
					maxRetries: getMaxTransientRetries(),
					signal: active.abortController.signal,
				});
				if (shouldRetry) {
					// Finalize or clean up the partial message from the failed turn.
					// If tools were already executed (side effects occurred), the message
					// is kept so buildHistory includes them and the model won't repeat them.
					// Otherwise the partial is deleted so the retry starts fresh.
					const partialId = active._partialMessageId;
					active._partialMessageId = undefined;
					if (partialId) {
						await finalizeOrCleanupPartialMessage(partialId, narratorId);
					}
					continue;
				}
				// If aborted during backoff sleep, don't mark as error — the
				// interrupt handler will set the correct status.
				if (!active.alive) {
					break;
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

			// Smart interruption check — auto-continue if output was truncated.
			// When the last completed assistant turn was a tool-call turn, we must
			// replay the tool-result request packet instead of appending a textual
			// "continue" user message.
			if (result.interrupted && active.alive) {
				interruptionRetries++;
				if (interruptionRetries > MAX_INTERRUPTION_RETRIES) {
					logger.warn("Smart interruption check: max retries reached, stopping", {
						narratorId,
						retries: interruptionRetries,
					});
				} else if (result.shouldReplayInterruptedToolResultTurn) {
					logger.info("Smart interruption check: replaying interrupted tool-result turn", {
						narratorId,
						retries: interruptionRetries,
					});
					currentText = "";
					currentImages = undefined;
					continue;
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

				// If the user edited the plan, append the diff to the prompt
				// (only for non-compact — compact already has the edited plan in system prompt)
				const planDiff = pendingPlanDiff.get(narratorId);
				if (planDiff) pendingPlanDiff.delete(narratorId);
				const basePrompt =
					!isCompact && planDiff
						? getToolMessageWithParams("exitPlanModeApprovedWithDiff", locale, {
								diff: planDiff,
							})
						: continuePrompt;

				// Check for chained feedback — merge with diff if both exist
				const fb = pendingFeedback.get(narratorId);
				if (fb) pendingFeedback.delete(narratorId);
				const promptText = fb
					? basePrompt !== continuePrompt
						? `${basePrompt}\n\n${fb.feedbackText}`
						: fb.feedbackText
					: basePrompt;

				// Retrieve the approver userId so the message shows their avatar
				const approverId = pendingPlanApprover.get(narratorId);
				if (approverId) pendingPlanApprover.delete(narratorId);

				const userMsg = await narratorService.persistUserMessage(
					narratorId,
					promptText,
					[{ type: "text", text: promptText }],
					undefined,
					approverId,
				);
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
			const { model: postModel, provider: postProvider } = resolveProviderAndModel(active.model);
			const postTurnThresholds = getContextThresholds(postModel, postProvider);
			if (
				active._contextUsagePct != null &&
				active._contextUsagePct >= postTurnThresholds.compactStart &&
				!compactLocks.has(narratorId)
			) {
				active._contextUsagePct = undefined;

				// Check current prunedPercent — if below threshold, prune further instead of compacting.
				// Exception: when pruning is disabled, skip the prune gate and compact directly.
				const narrator = await db.query.narrators.findFirst({
					where: eq(narrators.id, narratorId),
					columns: { prunedPercent: true, pruneEnabled: true },
				});
				const currentPrunedPct = narrator?.prunedPercent ?? 0;
				const pruneDisabled = narrator != null && !narrator.pruneEnabled;

				if (!pruneDisabled && currentPrunedPct < COMPACT_PRUNE_THRESHOLD_PCT) {
					logger.info(
						"Context above compactStart post-turn but prunedPercent below threshold, skipping compact",
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
			// When the loop had an error, skip consumption entirely so queued
			// messages are preserved for the user to retry or dismiss.
			if (!loopHadError) {
				const queue = bufferedMessages.get(narratorId);
				const buffered = queue?.[0];
				if (buffered) {
					queue?.shift();
					if (queue?.length === 0) bufferedMessages.delete(narratorId);
					// Broadcast which message was consumed + remaining queue snapshot
					const remaining = toBufferSummary(getBufferedMessages(narratorId));
					broadcastToNarrator(narratorId, {
						type: "buffer_consumed",
						narratorId,
						messageId: buffered.id,
						remaining,
					});
					// Save buffered text files to worktree
					const savedBufferedTextFiles: TextFileRef[] = [];
					if (buffered.textFiles?.length) {
						for (const file of buffered.textFiles) {
							savedBufferedTextFiles.push(await saveTextFileToWorktree(active.cwd, file));
						}
					}
					const persistBlocks: Array<
						| { type: "text"; text: string }
						| { type: "image"; imageId: string; filename: string; mediaType: string }
						| {
								type: "text_file";
								filename: string;
								size: number;
								filePath: string;
						  }
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
					if (savedBufferedTextFiles.length > 0) {
						for (const tf of savedBufferedTextFiles) {
							persistBlocks.push({
								type: "text_file",
								filename: tf.filename,
								size: tf.size,
								filePath: tf.filePath,
							});
						}
					}
					const effectiveBufferedText =
						buffered.text + buildAttachedFilesHint(savedBufferedTextFiles);
					// contentJson blocks store raw user text; contentText stores effectiveBufferedText (see feedMessage)
					persistBlocks.push({ type: "text", text: buffered.text });
					const userMsg = await narratorService.persistUserMessage(
						narratorId,
						effectiveBufferedText,
						persistBlocks,
						buffered.commandText,
						buffered.createdBy,
					);
					broadcastToNarrator(narratorId, { type: "user_message", narratorId, message: userMsg });
					active.events.emit("event", { type: "user_message", data: userMsg });
					await narratorService.updateStatus(narratorId, "thinking");
					currentText = effectiveBufferedText;
					currentImages = buffered.images;
					continue;
				}
			}

			// Check for queued overseer permission requests before transitioning to done.
			// This only applies to overseer narrators — regular narrators have no entries.
			if (!loopHadError) {
				const overseerQueue = pendingOverseerMessages.get(narratorId);
				let nextValid: OverseerQueuedMessage | undefined;
				while (overseerQueue && overseerQueue.length > 0) {
					const candidate = overseerQueue.shift()!;
					if (overseerQueue.length === 0) pendingOverseerMessages.delete(narratorId);
					if (pendingPermissions.has(candidate.requestId)) {
						nextValid = candidate;
						break;
					}
					// Permission was already resolved — skip to next
					logger.debug("Overseer queue: skipping already-resolved request", {
						narratorId,
						requestId: candidate.requestId,
					});
				}
				if (nextValid) {
					const userMsg = await narratorService.persistUserMessage(
						narratorId,
						nextValid.textForModel,
						nextValid.contentBlocks,
					);
					broadcastToNarrator(narratorId, {
						type: "user_message",
						narratorId,
						message: userMsg,
					});
					// Notify the source narrator that the overseer is now actively reviewing
					broadcastToNarrator(nextValid.broadcastTargetId, {
						type: "overseer_reviewing",
						narratorId: nextValid.broadcastTargetId,
						requestId: nextValid.requestId,
						toolUseId: nextValid.toolUseId,
						status: "reviewing",
					});
					await narratorService.updateStatus(narratorId, "thinking");
					currentText = nextValid.textForModel;
					currentImages = undefined;
					continue;
				}
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
		active._loopRunning = false;
		active.alive = false;

		// Restore model after temporary override (slash command with modelOverride.mode="temporary")
		// Read from DB so this survives server restarts.
		try {
			const fresh = await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { pendingModelRestore: true },
			});
			if (fresh?.pendingModelRestore) {
				const restoreModel = fresh.pendingModelRestore;
				await db
					.update(narrators)
					.set({
						model: restoreModel,
						pendingModelRestore: null,
						updatedAt: new Date().toISOString(),
					})
					.where(eq(narrators.id, narratorId));
				broadcastToNarrator(narratorId, {
					type: "model_changed",
					narratorId,
					model: restoreModel,
				});
			}
		} catch (err) {
			logger.error("Failed to restore model after temporary override", {
				narratorId,
				error: String(err),
			});
		}

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

		// --- Clean up per-narrator entries in global containers to prevent memory leaks ---
		// These containers are module-level (hotSafe) and persist across narrator sessions.
		// Without cleanup, entries accumulate on every interrupt/retry/error cycle.

		// 1. pendingPermissions: key = toolCallId, value.narratorId identifies the owner
		for (const [key, perm] of pendingPermissions) {
			if (perm.narratorId === narratorId) {
				try {
					perm.cleanup();
				} catch (e) {
					logger.debug("Failed to cleanup pending permission", {
						toolCallId: key,
						error: String(e),
					});
				}
				pendingPermissions.delete(key);
			}
		}

		// 2-5. Containers keyed directly by narratorId
		pendingFeedback.delete(narratorId);
		pendingPlanCompact.delete(narratorId);
		pendingPlanApprover.delete(narratorId);
		pendingPlanDiff.delete(narratorId);
		// When the loop ended with an error, preserve buffered messages so the
		// user can retry and the queue will resume automatically.  Notify the
		// frontend so it keeps showing the queued messages.
		if (loopHadError) {
			const preserved = bufferedMessages.get(narratorId);
			if (preserved?.length) {
				broadcastToNarrator(narratorId, {
					type: "buffer_preserved",
					narratorId,
					messages: toBufferSummary(preserved),
				});
			}
		} else {
			bufferedMessages.delete(narratorId);
		}

		// Drain any remaining overseer queue items — notify source narrators
		// that the overseer is no longer reviewing so the UI clears the
		// "queued for overseer" badge.
		const remainingOverseerQueue = pendingOverseerMessages.get(narratorId);
		if (remainingOverseerQueue && remainingOverseerQueue.length > 0) {
			for (const queued of remainingOverseerQueue) {
				broadcastToNarrator(queued.broadcastTargetId, {
					type: "overseer_reviewing",
					narratorId: queued.broadcastTargetId,
					requestId: queued.requestId,
					toolUseId: queued.toolUseId,
					status: "cleared",
				});
			}
			logger.debug("Overseer loop ended with queued items, cleared UI state", {
				narratorId,
				droppedCount: remainingOverseerQueue.length,
			});
		}
		pendingOverseerMessages.delete(narratorId);

		// 6. Per-narrator git status Promise cache (Bash before-status snapshots)
		active._bashBeforeStatus?.clear();

		if (shouldUpdateTitle) {
			generateAndSetTitle(narratorId, locale).catch(() => {});
		}
	}
}

// === Custom compact (conversation rotation) ===

/** Check whether a compact operation is already running for the given narrator. */
export function isCompactInProgress(narratorId: string): boolean {
	return compactLocks.has(narratorId);
}

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
		logger.info("Compact already in progress, waiting for it to finish", { narratorId });
		// Wait for the in-flight compact to settle (ignore its error — the original
		// caller handles it), then broadcast compact_done so the frontend refreshes
		// its state (fixes manual compact button appearing unresponsive).
		await existing.catch(() => {});
		broadcastToNarrator(narratorId, { type: "compact_done", narratorId });
		return;
	}

	// Wrap compact with timeout to ensure lock is always released.
	// Save the timer ID so we can clearTimeout after the race settles —
	// without this, the 5-minute timer holds its closure in memory even
	// when compact finishes in seconds.
	let compactTimer: ReturnType<typeof setTimeout>;
	const compactPromise = Promise.race([
		doRunCustomCompact(narratorId, locale, beforeMessageId),
		new Promise<void>((_, reject) => {
			compactTimer = setTimeout(
				() => reject(new Error("Compact operation timed out after 5 minutes")),
				COMPACT_TIMEOUT_MS,
			);
		}),
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
		// biome-ignore lint/style/noNonNullAssertion: timer is always assigned before race settles
		clearTimeout(compactTimer!);
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
	broadcastToNarrator(narratorId, { type: "compacting", narratorId });

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
		broadcastToNarrator(narratorId, {
			type: "compact_done",
			narratorId,
			contextPercentAfter: contextPercent,
		});
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

// === Segment compact (compress a selected subset of messages) ===

/**
 * Run a segment compact: compress a user-selected set of messages into a
 * single inline summary. Unlike full compact, this does NOT affect the
 * narrator's contextSummary — the summary lives inline in the message stream
 * as a role="user" message so buildHistory includes it in the AI's context.
 */
export async function runSegmentCompact(
	narratorId: string,
	locale: Locale,
	messageIds: string[],
): Promise<void> {
	const existing = compactLocks.get(narratorId);
	if (existing) {
		await existing.catch(() => {});
		broadcastToNarrator(narratorId, { type: "compact_done", narratorId, isSegment: true });
		return;
	}

	let timer: ReturnType<typeof setTimeout>;
	const promise = Promise.race([
		doRunSegmentCompact(narratorId, locale, messageIds),
		new Promise<void>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error("Segment compact timed out after 5 minutes")),
				COMPACT_TIMEOUT_MS,
			);
		}),
	]);
	compactLocks.set(narratorId, promise);
	try {
		await promise;
	} catch (err) {
		logger.error("Segment compact failed or timed out", {
			narratorId,
			error: String(err),
		});
		throw err;
	} finally {
		// biome-ignore lint/style/noNonNullAssertion: timer is always assigned before race settles
		clearTimeout(timer!);
		compactLocks.delete(narratorId);
	}
}

async function doRunSegmentCompact(
	narratorId: string,
	locale: Locale,
	messageIds: string[],
): Promise<void> {
	logger.info("Starting segment compact", { narratorId, messageCount: messageIds.length });

	// Insert a "compacting" marker and hide the target messages
	const { message: markerMsg, hiddenMessageIds } =
		await narratorService.persistSegmentCompactMarker(narratorId, messageIds);
	broadcastToNarrator(narratorId, { type: "message", narratorId, message: markerMsg });
	broadcastToNarrator(narratorId, {
		type: "segment_compact_hide",
		narratorId,
		hiddenMessageIds,
	});
	broadcastToNarrator(narratorId, { type: "compacting", narratorId });

	try {
		// Fetch the messages to summarize (they are still in DB, just hidden from refs)
		const messages = await narratorService.getMessagesForSegmentCompact(narratorId, messageIds);

		if (messages.length === 0) {
			// Nothing to compact — clean up
			await narratorService.deleteSegmentCompact(narratorId, markerMsg.id);
			broadcastToNarrator(narratorId, { type: "compact_done", narratorId, isSegment: true });
			return;
		}

		const { summary, contextPercent } = await narratorContext.generateCompactSummary(
			narratorId,
			locale,
			messages,
			null,
		);

		const finalizedMsg = await narratorService.finalizeSegmentCompact(
			markerMsg.id,
			narratorId,
			summary,
			contextPercent,
		);

		if (finalizedMsg) {
			broadcastToNarrator(narratorId, { type: "message", narratorId, message: finalizedMsg });
		}

		logger.info("Segment compact completed", {
			narratorId,
			messageCount: messageIds.length,
			summaryLength: summary.length,
		});
		broadcastToNarrator(narratorId, {
			type: "compact_done",
			narratorId,
			isSegment: true,
		});
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		logger.error("Segment compact failed", {
			narratorId,
			messageId: markerMsg.id,
			error: errorMsg,
		});

		const failedSummary = `${COMPACT_FAILURE_TEXT}\n${errorMsg}`;
		const failedMsg = await narratorService
			.finalizeSegmentCompact(markerMsg.id, narratorId, failedSummary, undefined, {
				status: "failed",
				error: errorMsg,
			})
			.catch((e) => {
				logger.error("Failed to finalize failed segment compact marker", {
					narratorId,
					messageId: markerMsg.id,
					error: String(e),
				});
				return null;
			});

		if (failedMsg) {
			broadcastToNarrator(narratorId, { type: "message", narratorId, message: failedMsg });
		}

		broadcastToNarrator(narratorId, {
			type: "compact_failed",
			narratorId,
			messageId: markerMsg.id,
		});
		throw err;
	}
}

/**
 * Compute a simple line-level unified diff between two strings.
 * Returns a compact diff string showing only changed lines with context,
 * or null if the texts are identical.
 */
function computeLineDiff(oldText: string, newText: string): string | null {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const CONTEXT = 2;

	// Simple LCS-based diff using O(n*m) DP — fine for plan-sized texts
	const m = oldLines.length;
	const n = newLines.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			if (oldLines[i] === newLines[j]) {
				dp[i][j] = dp[i + 1][j + 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
	}

	// Trace back to produce diff lines
	const diffLines: Array<{ type: "keep" | "del" | "add"; text: string }> = [];
	let i = 0;
	let j = 0;
	while (i < m || j < n) {
		if (i < m && j < n && oldLines[i] === newLines[j]) {
			diffLines.push({ type: "keep", text: oldLines[i] });
			i++;
			j++;
		} else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
			diffLines.push({ type: "add", text: newLines[j] });
			j++;
		} else {
			diffLines.push({ type: "del", text: oldLines[i] });
			i++;
		}
	}

	if (!diffLines.some((l) => l.type !== "keep")) return null;

	// Collect change ranges (indices of non-keep lines)
	const changeIndices: number[] = [];
	for (let k = 0; k < diffLines.length; k++) {
		if (diffLines[k].type !== "keep") changeIndices.push(k);
	}

	// Build hunks: group nearby changes with context lines
	const hunks: string[] = [];
	let hunkStart = Math.max(0, changeIndices[0] - CONTEXT);
	let hunkEnd = Math.min(diffLines.length - 1, changeIndices[0] + CONTEXT);

	for (let ci = 1; ci < changeIndices.length; ci++) {
		const nextStart = Math.max(0, changeIndices[ci] - CONTEXT);
		const nextEnd = Math.min(diffLines.length - 1, changeIndices[ci] + CONTEXT);
		if (nextStart <= hunkEnd + 1) {
			// Merge with current hunk
			hunkEnd = nextEnd;
		} else {
			// Flush current hunk
			const lines: string[] = [];
			for (let h = hunkStart; h <= hunkEnd; h++) {
				const d = diffLines[h];
				if (d.type === "keep") lines.push(`  ${d.text}`);
				else if (d.type === "del") lines.push(`- ${d.text}`);
				else lines.push(`+ ${d.text}`);
			}
			hunks.push(lines.join("\n"));
			hunkStart = nextStart;
			hunkEnd = nextEnd;
		}
	}
	// Flush last hunk
	const lines: string[] = [];
	for (let h = hunkStart; h <= hunkEnd; h++) {
		const d = diffLines[h];
		if (d.type === "keep") lines.push(`  ${d.text}`);
		else if (d.type === "del") lines.push(`- ${d.text}`);
		else lines.push(`+ ${d.text}`);
	}
	hunks.push(lines.join("\n"));

	return hunks.join("\n...\n");
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

/** Build the attached_files hint appended to the user prompt when text files are present. */
function buildAttachedFilesHint(textFiles: TextFileRef[]): string {
	if (textFiles.length === 0) return "";
	const lines = textFiles.map((f) => {
		return `- ${f.filePath} (${f.filename}, ${formatFileSize(f.size)})`;
	});
	return (
		"\n\n<attached_files>\n" +
		"The user has attached the following files for your reference. " +
		"Use the Read tool to access their contents when needed.\n" +
		`${lines.join("\n")}\n` +
		"</attached_files>"
	);
}

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
	rawTextFiles?: File[],
): Promise<{ active: ActiveNarrator; userMsg: typeof narratorMessages.$inferSelect }> {
	const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);

	// Save text files to worktree (now that we have active.cwd)
	const savedTextFiles: TextFileRef[] = [];
	if (rawTextFiles?.length) {
		for (const file of rawTextFiles) {
			savedTextFiles.push(await saveTextFileToWorktree(active.cwd, file));
		}
	}

	const persistBlocks: Array<
		| { type: "text"; text: string }
		| { type: "image"; imageId: string; filename: string; mediaType: string }
		| { type: "text_file"; filename: string; size: number; filePath: string }
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
	if (savedTextFiles.length > 0) {
		for (const tf of savedTextFiles) {
			persistBlocks.push({
				type: "text_file",
				filename: tf.filename,
				size: tf.size,
				filePath: tf.filePath,
			});
		}
	}
	// NOTE: persistBlocks stores the raw user text (without attached_files hint) so that
	// contentJson reflects what the user actually typed. The effectivePrompt (with hint)
	// is stored in contentText and sent to the AI. This intentional split means:
	//   - contentJson (blocks) → frontend display, shows original user input
	//   - contentText → FTS search index + AI prompt, includes file references
	persistBlocks.push({ type: "text", text: prompt });

	// Build the effective prompt with attached file hints
	const effectivePrompt = prompt + buildAttachedFilesHint(savedTextFiles);

	const userMsg = await narratorService.persistUserMessage(
		narratorId,
		effectivePrompt,
		persistBlocks,
		commandText,
		userId,
	);

	await narratorService.updateStatus(narratorId, "thinking", undefined, undefined, true);

	const narrator = await narratorService.getById(narratorId);
	if ((narrator.messageCount ?? 0) <= 1 && !narrator.title) {
		generateQuickTitle(narratorId, prompt, locale).catch(() => {});
	}

	// Start agent loop in background
	runAgentLoop(active, effectivePrompt, images).catch(async (err) => {
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
	textFiles?: File[],
): Promise<typeof narratorMessages.$inferSelect> {
	const { userMsg } = await feedMessage(
		narratorId,
		prompt,
		images,
		locale,
		replyInUserLanguage,
		commandText,
		userId,
		textFiles,
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
	await narratorService.updateStatus(narratorId, "thinking", undefined, undefined, true);

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
 * Continue the agent loop.
 *
 * If the last top-level message is a tool-call assistant turn, resumes by
 * reconstructing the tool-result upload packet (buildHistory produces
 * trailingToolResults).
 *
 * Otherwise (e.g. the assistant's text reply was truncated), sends a
 * locale-aware "please continue" user message via feedMessage so the
 * model receives a properly localised prompt.
 */
export async function continueNarrator(
	narratorId: string,
	locale: Locale = "en",
	replyInUserLanguage = false,
): Promise<{ ok: boolean }> {
	// If the last top-level message is a tool-call assistant turn, replay the
	// tool-result request packet instead of appending a textual "continue".
	const msgs = await narratorService.getMessagesSinceLastCompact(narratorId);
	const lastTopLevelMessage = getLastContinuableTopLevelMessage(msgs);
	const shouldReplayToolResults = shouldReplayToolResultPacket(lastTopLevelMessage);

	if (!shouldReplayToolResults) {
		// No pending tool calls — send a simple "continue" user message.
		const continueText = getToolMessage("userContinue", locale);
		const { userMsg } = await feedMessage(
			narratorId,
			continueText,
			undefined,
			locale,
			replyInUserLanguage,
		);
		broadcastToNarrator(narratorId, {
			type: "user_message",
			narratorId,
			message: userMsg,
		});
		return { ok: true };
	}

	const active = await ensureNarrator(narratorId, locale, replyInUserLanguage);
	await narratorService.updateStatus(narratorId, "thinking", undefined, undefined, true);

	// Pass empty text — buildHistory will reconstruct the trailing tool-result
	// packet so the provider sees the same follow-up turn again.
	runAgentLoop(active, "", undefined).catch(async (err) => {
		logger.error("runAgentLoop unhandled error (continue)", { narratorId, error: String(err) });
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
	await narratorService.updateStatus(narratorId, "thinking", undefined, undefined, true);

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
	const newContentJson: Array<Record<string, string | undefined>> = [
		{ type: "text", text: newContent },
	];

	// Preserve existing images in contentJson
	const existingImages = extractImageRefs(targetMsg.contentJson);
	for (const img of existingImages) {
		newContentJson.push({
			type: "image",
			imageId: img.imageId,
			filename: img.filename,
			mediaType: img.mediaType,
		});
	}

	await db
		.update(narratorMessages)
		.set({
			contentText: newContent,
			contentJson: newContentJson,
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
	await narratorService.updateStatus(narratorId, "thinking", undefined, undefined, true);

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
export async function cleanupPartialMessage(partialId: string, narratorId: string): Promise<void> {
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
 * Finalize or clean up a partial message before retry.
 *
 * If the partial message has tool calls with real execution results
 * (status is success, fail, or running), keep the message — those tools
 * produced side effects that cannot be undone.  Unexecuted tool_calls
 * (initializing / pending) are removed, and the message's contentJson is
 * trimmed to match.  Running tool_calls are marked as fail (interrupted).
 *
 * If no tool call was actually executed, the entire partial message is
 * deleted via {@link cleanupPartialMessage}.
 *
 * @returns `true` if the message was kept (finalized), `false` if deleted.
 */
export async function finalizeOrCleanupPartialMessage(
	partialId: string,
	narratorId: string,
): Promise<boolean> {
	try {
		const toolCalls = await db.query.narratorToolCalls.findMany({
			where: eq(narratorToolCalls.messageId, partialId),
			columns: { id: true, toolUseId: true, status: true },
		});

		// Statuses that indicate the tool was actually executed (side effects occurred)
		const executedStatuses = new Set(["success", "fail", "running"]);
		const executed = toolCalls.filter((tc) => executedStatuses.has(tc.status));

		if (executed.length === 0) {
			// No tool was actually executed — safe to delete everything
			await cleanupPartialMessage(partialId, narratorId);
			return false;
		}

		// Some tools were executed — keep the message, clean up the rest
		const unexecuted = toolCalls.filter((tc) => !executedStatuses.has(tc.status));
		const unexecutedToolUseIds = new Set(unexecuted.map((tc) => tc.toolUseId));

		await db.transaction(async (tx) => {
			// Delete unexecuted tool_call records
			if (unexecuted.length > 0) {
				await tx.delete(narratorToolCalls).where(
					inArray(
						narratorToolCalls.id,
						unexecuted.map((tc) => tc.id),
					),
				);
			}

			// Mark running tool_calls as fail (interrupted by retry)
			const running = executed.filter((tc) => tc.status === "running");
			if (running.length > 0) {
				await tx
					.update(narratorToolCalls)
					.set({
						status: "fail",
						errorMessage: "Interrupted by API error during retry",
					})
					.where(
						inArray(
							narratorToolCalls.id,
							running.map((tc) => tc.id),
						),
					);
			}

			// Remove unexecuted tool_use blocks from contentJson
			if (unexecutedToolUseIds.size > 0) {
				const msg = await tx.query.narratorMessages.findFirst({
					where: eq(narratorMessages.id, partialId),
					columns: { contentJson: true },
				});
				if (msg && Array.isArray(msg.contentJson)) {
					const filtered = (msg.contentJson as Array<Record<string, unknown>>).filter(
						(block) => block.type !== "tool_use" || !unexecutedToolUseIds.has(block.id as string),
					);
					await tx
						.update(narratorMessages)
						.set({ contentJson: filtered })
						.where(eq(narratorMessages.id, partialId));
				}
			}
		});

		logger.info("Finalized partial message with executed tool calls", {
			narratorId,
			partialId,
			executedCount: executed.length,
			removedCount: unexecuted.length,
		});
		return true;
	} catch (err) {
		logger.warn("Failed to finalize partial message, falling back to cleanup", {
			narratorId,
			partialId,
			error: String(err),
		});
		await cleanupPartialMessage(partialId, narratorId);
		return false;
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
	// Clean up any browser sessions owned by this narrator
	import("../lib/browser/session")
		.then(({ cleanupNarrator }) => {
			cleanupNarrator(narratorId).catch((err) => {
				logger.warn("Failed to cleanup browser sessions", { narratorId, error: String(err) });
			});
		})
		.catch((err) => {
			logger.warn("Failed to load browser session module", { narratorId, error: String(err) });
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
		const effectiveModel = resolveEffectiveModel(model);
		active.model = effectiveModel;
		active.provider = resolveProvider(effectiveModel);
		broadcastToNarrator(narratorId, {
			type: "model_changed",
			narratorId,
			model,
		});
	}
}

/**
 * Set a temporary model override for the current agent loop.
 * Persists the original model to DB so it survives server restarts.
 * After the loop finishes, the model will be restored automatically.
 */
export async function setTemporaryModelRestore(
	narratorId: string,
	originalModel: string,
): Promise<void> {
	const now = new Date().toISOString();
	await db
		.update(narrators)
		.set({ pendingModelRestore: originalModel, updatedAt: now })
		.where(eq(narrators.id, narratorId));
}

/**
 * Restore models for all narrators that have a pending temporary model override.
 * Called once at server startup to recover from unclean shutdowns.
 */
export async function restorePendingModelOverrides(): Promise<void> {
	const pending = await db.query.narrators.findMany({
		where: isNotNull(narrators.pendingModelRestore),
		columns: { id: true, pendingModelRestore: true },
	});
	if (pending.length === 0) return;

	const now = new Date().toISOString();
	for (const n of pending) {
		await db
			.update(narrators)
			.set({
				model: n.pendingModelRestore,
				pendingModelRestore: null,
				updatedAt: now,
			})
			.where(eq(narrators.id, n.id));
		logger.info("Restored model from pending temporary override on startup", {
			narratorId: n.id,
			restoreModel: n.pendingModelRestore,
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
			active._planFileId = generateWordSlug();
		}
		// _previousPermissionMode is also persisted in DB by narratorService.updatePermissionMode,
		// so onExitPlanMode will read it from DB if the in-memory value is missing.
	} else {
		active._planFileId = undefined;
		active._previousPermissionMode = undefined;
	}
}

// === Buffered message queue API ===

/** Push a message onto the queue (or unshift to front when position is "front"). */
export function pushBufferedMessage(
	narratorId: string,
	text: string,
	images?: ImageRef[],
	commandText?: string | null,
	createdBy?: string | null,
	creator?: BufferCreator | null,
	textFiles?: File[],
	position: "back" | "front" = "back",
): { ok: boolean; bufferedAt: string; id: string } {
	if (!activeNarrators.has(narratorId)) {
		return { ok: false, bufferedAt: "", id: "" };
	}
	const id = generateShortId();
	const bufferedAt = new Date().toISOString();
	const queue = bufferedMessages.get(narratorId) ?? [];
	const entry = { id, text, images, textFiles, bufferedAt, commandText, createdBy, creator };
	if (position === "front") {
		queue.unshift(entry);
	} else {
		queue.push(entry);
	}
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

/** Reorder the queue by a list of message ids. */
export function reorderBufferedMessages(narratorId: string, orderedIds: string[]): boolean {
	const queue = bufferedMessages.get(narratorId);
	if (!queue || queue.length === 0) return false;
	if (orderedIds.length !== queue.length) return false;
	const byId = new Map(queue.map((m) => [m.id, m]));
	const reordered: BufferedMessage[] = [];
	for (const id of orderedIds) {
		const msg = byId.get(id);
		if (!msg) return false;
		reordered.push(msg);
	}
	bufferedMessages.set(narratorId, reordered);
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
	msgs: readonly Pick<BufferedMessage, "id" | "text" | "bufferedAt" | "images" | "creator">[],
): Array<{
	id: string;
	text: string;
	bufferedAt: string;
	imageCount: number;
	creator?: BufferCreator | null;
}> {
	return msgs.map((m) => ({
		id: m.id,
		text: m.text,
		bufferedAt: m.bufferedAt,
		imageCount: m.images?.length ?? 0,
		creator: m.creator ?? null,
	}));
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

	// Clean up any residual worktree watchers from a previous server run.
	// On restart (or hot reload), old fs.watch handles may leak if the previous
	// process didn't shut down cleanly, causing phantom CPU usage from inotify.
	worktreeWatcher.shutdown();

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
