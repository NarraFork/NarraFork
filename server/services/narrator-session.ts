import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join, normalize, resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db, sqlite } from "../db";
import { chapters, narratorMessages, narrators, narratorToolCalls, projects } from "../db/schema";
import {
	type AgentEvent,
	agentLoop,
	buildHistory,
	type PermissionResult,
	PLAN_MODE_ALLOWED_TOOLS,
} from "../lib/agent";
import { analyzeBashCommand, type BashAnalysis } from "../lib/agent/bash-analyze";
import { NotFoundError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import {
	getPlanModeSystemReminder,
	getReplyLanguageInstruction,
	getToolMessage,
	type Locale,
} from "../lib/prompt-i18n";
import { resolveProvider, settings } from "../lib/settings";
import type { ImageRef } from "../lib/uploads";
import { getImagePath, imageToBase64 } from "../lib/uploads";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { gitService } from "./git-service";
import { autoCommitIfNeeded } from "./narrator-auto-commit";
import { narratorContext } from "./narrator-context";
import { narratorService } from "./narrator-service";
import { generateAndSetTitle, generateQuickTitle } from "./narrator-title";

// === In-memory state ===

// Tools that may modify files on disk — git status is tracked after these complete
const FILE_MUTATING_TOOLS = new Set(["Write", "Edit", "MultiEdit", "Bash", "smartRelocate"]);


interface ActiveSession {
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
	/** Last reported context usage percentage from the provider (0–100) */
	_lastContextUsagePct?: number;
	/** Last reported metering from the provider */
	_lastMeterUsage?: number;
	_lastMeterUnit?: string;
	/** Whether to append language instruction to system prompt */
	_replyInUserLanguage?: boolean;
	/** Set when plan compact aborts the current agent loop — the loop should restart with fresh context */
	_planCompactAborted?: boolean;
	/** Cached chapter ID (set when narrator is bound to an active chapter) */
	_chapterId?: string;
	/** Cached worktree path (set when narrator is bound to an active chapter with a worktree) */
	_worktreePath?: string;
}

const activeSessions = new Map<string, ActiveSession>();

// Lock to prevent concurrent session creation for the same narrator
const sessionCreationLocks = new Map<string, Promise<ActiveSession>>();

interface PendingPermission {
	resolve: (result: PermissionResult) => void;
	cleanup: () => void;
	input: Record<string, unknown>;
	narratorId: string;
	toolUseId: string;
	/** For subagent permissions: broadcast to parent narrator's WS channel instead of own. */
	broadcastTargetId: string;
}

const pendingPermissions = new Map<string, PendingPermission>();

// Feedback queued by "allow with feedback" — keyed by narratorId
const pendingFeedback = new Map<string, { toolUseId: string; feedbackText: string }>();

// Tracks narrators that should run plan compact after ExitPlanMode completes — keyed by narratorId
const pendingPlanCompact = new Set<string>();

// Buffered message queued by user while narrator is thinking — keyed by narratorId
interface BufferedMessage {
	text: string;
	images?: ImageRef[];
	bufferedAt: string;
}
const bufferedMessages = new Map<string, BufferedMessage>();

// === SSE event types yielded to the HTTP response ===

export type SessionEvent =
	| { type: "user_message"; data: unknown }
	| { type: "assistant_message"; data: unknown }
	| { type: "stream_event"; data: unknown }
	| { type: "tool_progress"; data: unknown }
	| { type: "result"; data: unknown }
	| { type: "error"; data: { message: string } }
	| { type: "interrupted"; data: { message: string } }
	| { type: "context_usage"; data: { percentage: number } }
	| { type: "done"; data: null };

// === Permission handling ===

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export function isInsideWorktree(cwd: string, filePath: string): boolean {
	const resolved = normalize(resolve(cwd, filePath));
	const base = normalize(cwd).replace(/\/+$/, "");
	return resolved === base || resolved.startsWith(`${base}/`);
}

export function extractToolPaths(toolName: string, input: Record<string, unknown>): string[] {
	switch (toolName) {
		case "Read":
		case "Write":
		case "Edit":
		case "NotebookEdit":
		case "MultiEdit":
			return typeof input.file_path === "string" ? [input.file_path] : [];
		case "Glob":
		case "Grep":
			return typeof input.path === "string" ? [input.path] : [];
		case "Bash": {
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

// and does not access the local filesystem or execute arbitrary commands.
// Task is auto-allowed because it only spawns a subagent — the subagent's
// individual tools go through their own permission checks.
const ALWAYS_ALLOW_TOOLS = ["TodoWrite", "EnterPlanMode", "WebSearch", "Task"];

const ACCEPT_EDITS_AUTO_ALLOW = [
	"Edit",
	"Write",
	"NotebookEdit",
	"MultiEdit",
	"Read",
	"Glob",
	"Grep",
];

/**
 * Pure decision logic for permission handling.
 * Returns "allow", "deny", or "ask" (needs user confirmation).
 */
/** Tools that always require user approval regardless of permission mode. */
const ALWAYS_ASK_TOOLS = ["ExitPlanMode"];

// TODO: refactor resolvePermissionDecision params into an options object when adding more flags
export function resolvePermissionDecision(
	toolName: string,
	input: Record<string, unknown>,
	permMode: string,
	cwd: string,
	planMode = false,
	bashAnalysis?: BashAnalysis,
	isChapter = false,
): "allow" | "deny" | "ask" | "fatal" {
	// Catastrophic commands are ALWAYS blocked — no override possible
	if (toolName === "Bash" && bashAnalysis?.isCatastrophic) return "fatal";

	// Chapter mode: git branch violations are hard-denied (no bypass)
	if (toolName === "Bash" && isChapter && bashAnalysis?.gitBranchViolations?.length) return "deny";

	// Plan mode: deny mutating tools (except Bash which keeps its normal permission flow)
	if (planMode && !PLAN_MODE_ALLOWED_TOOLS.has(toolName)) return "deny";
	// Plan mode: Task is allowed but only for explore/plan subagents (general has write access)
	if (planMode && toolName === "Task" && input.subagent_type === "general") return "deny";
	if (ALWAYS_ASK_TOOLS.includes(toolName)) return "ask";
	if (ALWAYS_ALLOW_TOOLS.includes(toolName)) return "allow";
	if (permMode === "bypassPermissions") return "allow";
	if (permMode === "dontAsk") return "deny";

	// Bash: AST-based command-level security
	if (toolName === "Bash") {
		if (!bashAnalysis) return "ask";
		if (bashAnalysis.nonWhitelisted.length > 0) return "ask";
		if (bashAnalysis.dangerousPatterns.length > 0) return "ask";
		if (bashAnalysis.hasEnvInjection) return "ask";
		const hasExternalBashPath = bashAnalysis.filePaths.some((p) => !isInsideWorktree(cwd, p));
		if (hasExternalBashPath) return "ask";
		// All commands whitelisted + all paths inside worktree + no dangerous patterns
		if (permMode === "default" || permMode === "acceptEdits") return "allow";
		return "ask";
	}

	const toolPaths = extractToolPaths(toolName, input);
	const hasExternalPath = toolPaths.length > 0 && toolPaths.some((p) => !isInsideWorktree(cwd, p));

	if (!hasExternalPath) {
		if (permMode === "default") return "allow";
		if (permMode === "acceptEdits" && ACCEPT_EDITS_AUTO_ALLOW.includes(toolName)) return "allow";
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
	// Read permission mode and plan mode from DB in real-time
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { permissionMode: true, planMode: true, chapterId: true },
	});
	const permMode = narrator?.permissionMode ?? "default";
	const planMode = narrator?.planMode ?? false;
	const isChapter = !!narrator?.chapterId;

	// Bash command pre-analysis via tree-sitter AST
	let bashAnalysis: BashAnalysis | undefined;
	if (toolName === "Bash" && typeof input.command === "string") {
		try {
			bashAnalysis = await analyzeBashCommand(input.command, cwd, isChapter);
		} catch (err) {
			logger.warn("Bash command analysis failed, falling back to ask", { err });
			// Analysis failure → conservative: ask user
		}
	}

	const decision = resolvePermissionDecision(
		toolName,
		input,
		permMode,
		cwd,
		planMode,
		bashAnalysis,
		isChapter,
	);
	if (decision === "fatal") {
		const reason = bashAnalysis?.catastrophicReason ?? "catastrophic command detected";
		const fatalMsg = `FATAL: ${reason}. Session terminated for safety.`;
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
		return { behavior: "allow", updatedInput: input };
	}
	if (decision === "deny") {
		// Chapter mode git branch violation — provide specific error message
		const branchViolations = bashAnalysis?.gitBranchViolations;
		const denyMsg =
			isChapter && branchViolations?.length
				? `DENIED: Chapter mode restricts git branch operations. Violations: ${branchViolations.join("; ")}. You may only work on the current branch.`
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

	await db
		.update(narratorToolCalls)
		.set({
			status: "pending",
			...(decisionReason ? { permissionDecisionReason: decisionReason } : {}),
		})
		.where(eq(narratorToolCalls.id, toolCallId));

	broadcastToNarrator(wsTarget, {
		type: "permission_request",
		narratorId: wsTarget,
		request: { id: toolCallId, toolName, toolUseId, inputJson: input, decisionReason },
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
				errorMessage: "Session aborted",
				permissionDecidedBy: "aborted",
				permissionDecidedAt: new Date().toISOString(),
			})
			.where(eq(narratorToolCalls.id, toolCallId));
		return { behavior: "deny", message: "Session aborted" };
	}

	return new Promise<PermissionResult>((resolve) => {
		const cleanup = () => {
			clearTimeout(tid);
			signal.removeEventListener("abort", onAbort);
			pendingPermissions.delete(toolCallId);
		};

		const tid = setTimeout(async () => {
			logger.warn("Permission request timed out", {
				narratorId,
				toolCallId,
				toolUseId,
				toolName,
				timeoutMs: PERMISSION_TIMEOUT_MS,
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
					errorMessage: "Permission request timed out",
					permissionDecidedBy: "auto_timeout",
					permissionDecidedAt: new Date().toISOString(),
				})
				.where(eq(narratorToolCalls.id, toolCallId));
			// Restore parent narrator status on timeout
			if (broadcastTargetId && broadcastTargetId !== narratorId) {
				await narratorService.updateStatus(broadcastTargetId, "thinking");
			}
			resolve({ behavior: "deny", message: "Permission request timed out" });
		}, PERMISSION_TIMEOUT_MS);

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
					errorMessage: "Session aborted",
					permissionDecidedBy: "aborted",
					permissionDecidedAt: new Date().toISOString(),
				})
				.where(eq(narratorToolCalls.id, toolCallId));
			// Restore parent narrator status on abort
			if (broadcastTargetId && broadcastTargetId !== narratorId) {
				await narratorService.updateStatus(broadcastTargetId, "thinking");
			}
			resolve({ behavior: "deny", message: "Session aborted" });
		};

		signal.addEventListener("abort", onAbort, { once: true });

		pendingPermissions.set(toolCallId, {
			resolve,
			cleanup,
			input,
			narratorId,
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

	// Broadcast to all subscribers so other tabs can clear the permission banner
	broadcastToNarrator(pending.broadcastTargetId, {
		type: "permission_resolved",
		narratorId: pending.broadcastTargetId,
		requestId,
		toolUseId: pending.toolUseId,
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
		const updatedInput = answers ? { ...pending.input, answers } : pending.input;

		if (answers) {
			try {
				await db
					.update(narratorToolCalls)
					.set({ inputJson: updatedInput })
					.where(eq(narratorToolCalls.toolUseId, pending.toolUseId));
			} catch (err) {
				logger.error("Failed to persist AskUserQuestion answers", {
					requestId,
					error: String(err),
				});
			}
		}

		// Mark for plan compact if requested (ExitPlanMode + reset context)
		if (compactAfter) {
			pendingPlanCompact.add(pending.narratorId);
		}

		pending.resolve({ behavior: "allow", updatedInput });
	} else {
		const message = denyMessage || feedbackText?.trim() || "Permission denied by user";
		pending.resolve({ behavior: "deny", message });
	}
}

// === Session lifecycle ===

/**
 * Ensure an active session exists for this narrator.
 * If one is already alive, return it. Otherwise create a new one.
 */
async function ensureSession(
	narratorId: string,
	locale: Locale,
	replyInUserLanguage = false,
): Promise<ActiveSession> {
	const existing = activeSessions.get(narratorId);
	if (existing?.alive) return existing;

	const pending = sessionCreationLocks.get(narratorId);
	if (pending) return pending;

	const creation = createSession(narratorId, locale, replyInUserLanguage);
	sessionCreationLocks.set(narratorId, creation);
	try {
		return await creation;
	} finally {
		sessionCreationLocks.delete(narratorId);
	}
}

/**
 * Build the effective system prompt dynamically.
 * Reads AGENT.md (fallback CLAUDE.md) from disk each time so changes are picked up mid-session.
 */
async function buildSystemPrompt(
	narrator: { systemPrompt: string | null; contextSummary: string | null },
	cwd: string,
	locale: Locale,
	replyInUserLanguage: boolean,
	planMode = false,
): Promise<{ prompt: string | null; usedCompactSummary: boolean }> {
	let prompt = narrator.systemPrompt;
	let usedCompactSummary = false;

	// Inject compact summary if available
	if (narrator.contextSummary) {
		usedCompactSummary = true;
		const base = prompt ?? "";
		const sep = base ? "\n\n" : "";
		prompt = `${base}${sep}## Conversation Context\n\n${narrator.contextSummary}`;
	}

	// Inject current working directory
	{
		const base = prompt ?? "";
		const sep = base ? "\n\n" : "";
		prompt = `${base}${sep}## Current Working Directory\n\n\`${cwd}\``;
	}

	// Inject AGENT.md (fallback to CLAUDE.md) if present in the working directory
	{
		let agentMdContent: string | null = null;
		for (const filename of ["AGENT.md", "CLAUDE.md"]) {
			try {
				agentMdContent = await readFile(join(cwd, filename), "utf-8");
				break;
			} catch {
				// file not found, try next
			}
		}
		if (agentMdContent) {
			const base = prompt ?? "";
			const sep = base ? "\n\n" : "";
			prompt = `${base}${sep}## Project Instructions\n\n${agentMdContent}`;
		}
	}

	// Append language instruction (always inject unless locale is English)
	if (replyInUserLanguage || locale !== "en") {
		const instruction = getReplyLanguageInstruction(locale);
		const base = prompt ?? "";
		const sep = base ? "\n\n" : "";
		prompt = `${base}${sep}## Language\n\n${instruction}`;
	}

	// Inject plan mode system reminder
	if (planMode) {
		const base = prompt ?? "";
		const sep = base ? "\n\n" : "";
		prompt = `${base}${sep}${getPlanModeSystemReminder(locale)}`;
	}

	return { prompt, usedCompactSummary };
}

async function createSession(
	narratorId: string,
	locale: Locale,
	replyInUserLanguage = false,
): Promise<ActiveSession> {
	const existing = activeSessions.get(narratorId);
	if (existing) {
		existing.abortController.abort();
		activeSessions.delete(narratorId);
	}

	const narrator = await narratorService.getById(narratorId);

	// Use narrator-level session state directly
	const effectiveConversationId = narrator.apiConversationId;
	const effectiveContextSummary = narrator.contextSummary;

	// Resolve CWD and cache chapter info for git tracking
	let sessionCwd: string;
	let sessionChapterId: string | undefined;
	let sessionWorktreePath: string | undefined;
	if (narrator.chapterId) {
		const ch = await db.query.chapters.findFirst({
			where: eq(chapters.id, narrator.chapterId),
		});
		if (!ch) throw new NotFoundError("Chapter", narrator.chapterId);
		if (ch.worktreePath) {
			sessionCwd = ch.worktreePath;
			sessionChapterId = ch.id;
			sessionWorktreePath = ch.worktreePath;
		} else {
			// Chapter is dormant — fall back to project gitPath or narrator cwd
			const project = await db.query.projects.findFirst({
				where: eq(projects.id, ch.projectId),
			});
			sessionCwd = narrator.cwd || project?.gitPath || process.env.HOME || "/tmp";
			logger.info("Chapter dormant, using fallback CWD", {
				chapterId: narrator.chapterId,
				sessionCwd,
			});
		}
	} else {
		sessionCwd = narrator.cwd || process.env.HOME || "/tmp";
	}

	const { prompt: effectiveSystemPrompt, usedCompactSummary } = await buildSystemPrompt(
		{ systemPrompt: narrator.systemPrompt, contextSummary: effectiveContextSummary },
		sessionCwd,
		locale,
		replyInUserLanguage,
		narrator.planMode ?? false,
	);

	const abortController = new AbortController();
	const events = new EventEmitter();
	events.setMaxListeners(20);

	const sessionModel = narrator.model ?? settings.agent.defaultModel;

	const session: ActiveSession = {
		abortController,
		narratorId,
		conversationId: effectiveConversationId ?? randomUUID(),
		cwd: sessionCwd,
		model: sessionModel,
		provider: resolveProvider(sessionModel),
		systemPrompt: effectiveSystemPrompt,
		events,
		alive: true,
		locale,
		_usedCompactSummary: usedCompactSummary,
		_replyInUserLanguage: replyInUserLanguage,
		_chapterId: sessionChapterId,
		_worktreePath: sessionWorktreePath,
	};

	activeSessions.set(narratorId, session);
	return session;
}

// === Agent loop execution ===

/** Trigger compact when context usage exceeds this percentage (0–100). */
const COMPACT_CONTEXT_USAGE_PCT = 80;

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

/**
 * Build AgentConfig, start agentLoop(), and consume events.
 * Runs in the background — kicked off by feedMessage().
 * Handles chained messages (feedback/buffered) by looping.
 */
async function runAgentLoop(
	session: ActiveSession,
	text: string,
	images?: ImageRef[],
): Promise<void> {
	const { narratorId, locale } = session;
	let shouldUpdateTitle = false;
	let titleTracked = false;
	let currentText = text;
	let currentImages = images;

	try {
		while (session.alive) {
			// Always use getMessagesSinceLastCompact: if no compact marker exists it
			// returns all messages; after a compact it only returns post-compact messages
			// (old context is already in the summary injected via system prompt).
			const dbMessages = await narratorService.getMessagesSinceLastCompact(narratorId);
			const { history, trailingToolResults } = await buildHistory(
				dbMessages,
				session.model,
				session.provider,
				narratorId,
			);

			// Rebuild system prompt each iteration so AGENT.md/CLAUDE.md changes are picked up
			const freshNarrator = await narratorService.getById(narratorId);
			const { prompt: freshSystemPrompt, usedCompactSummary } = await buildSystemPrompt(
				{ systemPrompt: freshNarrator.systemPrompt, contextSummary: freshNarrator.contextSummary },
				session.cwd,
				locale,
				session._replyInUserLanguage ?? false,
				freshNarrator.planMode ?? false,
			);
			session.systemPrompt = freshSystemPrompt;
			session._usedCompactSummary = usedCompactSummary;

			const config: import("../lib/agent").AgentConfig = {
				narratorId,
				conversationId: session.conversationId,
				model: session.model,
				provider: session.provider,
				cwd: session.cwd,
				systemPrompt: session.systemPrompt ?? undefined,
				locale,
				signal: session.abortController.signal,
				planMode: freshNarrator.planMode ?? false,
				permissionHandler: (toolName, input, toolUseId) =>
					handlePermission(
						narratorId,
						session.abortController.signal,
						toolName,
						input,
						toolUseId,
						session.cwd,
						locale,
					),
				// onEvent receives only side-channel events (tool_output, tool_progress)
				// from executeTool — NOT yielded events like tool_result or assistant_message.
				onEvent: (event) => {
					processAgentEvent(session, event, {
						titleTracked: true,
						shouldUpdateTitle: false,
					}).catch(() => {});
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
							const b64 = await imageToBase64(filePath);
							const mimeToFormat: Record<string, string> = {
								"image/png": "png",
								"image/jpeg": "jpeg",
								"image/gif": "gif",
								"image/webp": "webp",
							};
							resolved.push({
								format: mimeToFormat[img.mediaType] ?? "png",
								base64: b64,
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

			for await (const event of agentLoop(
				config,
				effectiveText,
				history,
				trailingToolResults,
				loopImages,
			)) {
				if (!session.alive) break;

				const mapped = await processAgentEvent(session, event, {
					titleTracked,
					shouldUpdateTitle,
				});
				if (mapped?.titleUpdate !== undefined) {
					shouldUpdateTitle = mapped.titleUpdate;
					titleTracked = true;
				}
			}

			// Plan compact aborted the agent loop — reset abort controller and
			// restart the while-loop so the next iteration builds fresh history
			// from only post-compact messages.
			if (session._planCompactAborted) {
				session._planCompactAborted = false;
				session.abortController = new AbortController();
				await narratorService.updateStats(narratorId, 0);

				// Always persist a user message to kick off plan execution and continue
				const continuePrompt = getToolMessage("planCompactContinue", locale);

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
				session.events.emit("event", { type: "user_message", data: userMsg });
				await narratorService.updateStatus(narratorId, "thinking");
				currentText = promptText;
				currentImages = undefined;
				continue;
			}

			// Agent loop done — update status
			await narratorService.updateStats(narratorId, 0);
			await narratorService.updateStatus(narratorId, "idle");

			// Auto-commit if there are uncommitted changes (chapter-bound narrators only)
			if (session._worktreePath && session._chapterId) {
				autoCommitIfNeeded(narratorId, session._chapterId, session._worktreePath, locale).catch(
					(err) => logger.error("Auto-commit failed", { narratorId, error: String(err) }),
				);
			}

			// Compact if context usage is high (checked after a complete turn)
			if (
				session._lastContextUsagePct != null &&
				session._lastContextUsagePct >= COMPACT_CONTEXT_USAGE_PCT
			) {
				logger.info("Context usage high, triggering compact", {
					narratorId,
					contextUsagePct: session._lastContextUsagePct,
				});
				await runCustomCompact(narratorId, locale);
				// Reset conversationId so the next loop iteration starts a fresh
				// API conversation instead of continuing the old one.
				session.conversationId = randomUUID();
				broadcastToNarrator(narratorId, { type: "compact_done", narratorId });
				// System prompt will be rebuilt at the top of the next loop iteration
				// via buildSystemPrompt(), which reads fresh contextSummary from DB.
				session._lastContextUsagePct = undefined;
			}

			// Check for chained feedback
			const fb = pendingFeedback.get(narratorId);
			if (fb) {
				pendingFeedback.delete(narratorId);
				const userMsg = await narratorService.persistUserMessage(narratorId, fb.feedbackText, [
					{ type: "text", text: fb.feedbackText },
				]);
				broadcastToNarrator(narratorId, { type: "user_message", narratorId, message: userMsg });
				session.events.emit("event", { type: "user_message", data: userMsg });
				await narratorService.updateStatus(narratorId, "thinking");
				currentText = fb.feedbackText;
				continue;
			}

			// Check for buffered messages
			const buffered = bufferedMessages.get(narratorId);
			if (buffered) {
				bufferedMessages.delete(narratorId);
				const finalNarrator = await db.query.narrators.findFirst({
					where: eq(narrators.id, narratorId),
					columns: { status: true },
				});
				if (finalNarrator?.status !== "error") {
					broadcastToNarrator(narratorId, { type: "buffer_cleared", narratorId, reason: "sent" });
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
					);
					broadcastToNarrator(narratorId, { type: "user_message", narratorId, message: userMsg });
					session.events.emit("event", { type: "user_message", data: userMsg });
					await narratorService.updateStatus(narratorId, "thinking");
					currentText = buffered.text;
					currentImages = buffered.images;
					continue;
				}
				broadcastToNarrator(narratorId, {
					type: "buffer_cleared",
					narratorId,
					reason: "session_error",
				});
			}

			// No chained message — done
			session.events.emit("event", { type: "done", data: null });
			break;
		}
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		logger.error("Narrator session error", { narratorId, error: errorMsg });
		await narratorService.updateStatus(narratorId, "error", errorMsg);
		session.events.emit("event", { type: "error", data: { message: errorMsg } });
		session.events.emit("event", { type: "done", data: null });
	} finally {
		session.alive = false;
		activeSessions.delete(narratorId);
		session.abortController.abort();
		session.events.emit("event", { type: "done", data: null });
		session.events.removeAllListeners();
		if (shouldUpdateTitle) {
			generateAndSetTitle(narratorId, locale).catch(() => {});
		}
	}
}

// === Custom compact (session rotation) ===

/**
 * Run custom compact: generate a summary from DB messages and store it.
 * Clears apiConversationId so the next session starts fresh with the summary.
 */
export async function runCustomCompact(
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

	const { summary, contextPercent } = await narratorContext.generateCompactSummary(
		narratorId,
		locale,
		messages,
	);

	const now = new Date().toISOString();

	// Store summary on narrator
	await db
		.update(narrators)
		.set({
			contextSummary: summary,
			apiConversationId: null,
			updatedAt: now,
		})
		.where(eq(narrators.id, narratorId));

	// Finalize the compacting marker into the final compacted message (with full summary)
	const compactedMsg = await narratorService.finalizeCompactingMessage(
		narratorId,
		summary,
		contextPercent,
	);
	if (compactedMsg) {
		broadcastToNarrator(narratorId, { type: "message", narratorId, message: compactedMsg });
	}
	await narratorService.updateStatus(narratorId, "idle");

	logger.info("Custom compact completed", { narratorId, summaryLength: summary.length });
}

/**
 * Run plan compact: use the plan text directly as compact summary.
 * Skips AI summary generation — the plan itself is the summary.
 */
async function runPlanCompact(narratorId: string, planText: string): Promise<void> {
	logger.info("Starting plan compact", { narratorId, planLength: planText.length });

	const now = new Date().toISOString();

	// Store summary on narrator
	await db
		.update(narrators)
		.set({
			contextSummary: planText,
			apiConversationId: null,
			updatedAt: now,
		})
		.where(eq(narrators.id, narratorId));

	// Insert compact message directly (no compacting intermediate state needed)
	const compactMsg = await narratorService.persistPlanMessage(narratorId, planText);
	if (compactMsg) {
		broadcastToNarrator(narratorId, { type: "message", narratorId, message: compactMsg });
	}

	logger.info("Plan compact completed", { narratorId, summaryLength: planText.length });
}

// === Message feeding ===

/**
 * Persist a user message and kick off the agent loop in the background.
 * Returns the session and persisted message for SSE subscription.
 */
async function feedMessage(
	narratorId: string,
	prompt: string,
	images?: ImageRef[],
	locale: Locale = "en",
	replyInUserLanguage = false,
): Promise<{ session: ActiveSession; userMsg: typeof narratorMessages.$inferSelect }> {
	const session = await ensureSession(narratorId, locale, replyInUserLanguage);

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
	const userMsg = await narratorService.persistUserMessage(narratorId, prompt, persistBlocks);

	await narratorService.updateStatus(narratorId, "thinking");

	const narrator = await narratorService.getById(narratorId);
	if ((narrator.messageCount ?? 0) <= 1 && !narrator.title) {
		generateQuickTitle(narratorId, prompt, locale).catch(() => {});
	}

	// Start agent loop in background
	runAgentLoop(session, prompt, images).catch((err) => {
		logger.error("runAgentLoop unhandled error", { narratorId, error: String(err) });
	});

	return { session, userMsg };
}

// === Agent event processing ===

async function processAgentEvent(
	session: ActiveSession,
	event: AgentEvent,
	state: { titleTracked: boolean; shouldUpdateTitle: boolean },
): Promise<{ titleUpdate?: boolean } | null> {
	const { narratorId } = session;

	switch (event.type) {
		case "stream_text": {
			// the entire assistant turn is just the placeholder dot.
					return null;
				}
				// Subsequent chunk arrived — flush the buffered dot first
					const flushDelta = { type: "text_delta" as const, text: buffered };
					broadcastToNarrator(narratorId, {
						type: "stream_event",
						narratorId,
						event: { type: "content_block_delta", delta: flushDelta },
					});
					session.events.emit("event", {
						type: "stream_event",
						data: { type: "content_block_delta", delta: flushDelta },
					});
				}
			}

			broadcastToNarrator(narratorId, {
				type: "stream_event",
				narratorId,
				event: {
					type: "content_block_delta",
					delta: { type: "text_delta", text: event.text },
				},
			});
			session.events.emit("event", {
				type: "stream_event",
				data: {
					type: "content_block_delta",
					delta: { type: "text_delta", text: event.text },
				},
			});
			return null;
		}

		case "tool_call": {
			broadcastToNarrator(narratorId, {
				type: "tool_started",
				narratorId,
				toolUseId: event.toolUseId,
				toolName: event.toolName,
				input: event.input,
			});
			return null;
		}

		case "assistant_message": {
			// Build message for persistAssistantMessage
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			const content: any[] = [];
			// The model sometimes echoes it back — filter it out to avoid polluting the DB.
			for (const tu of event.toolUses) {
				content.push({ type: "tool_use", id: tu.toolUseId, name: tu.name, input: tu.input });
			}

			const saved = await narratorService.persistAssistantMessage(narratorId, {
				uuid: event.messageId ?? randomUUID(),
				session_id: session.conversationId,
				message: { content },
				contextPercent: session._lastContextUsagePct,
				meterUsage: session._lastMeterUsage,
				meterUnit: session._lastMeterUnit,
			});

			// TodoWrite / EnterPlanMode tracking
			for (const tu of event.toolUses) {
				if (tu.name === "TodoWrite" && tu.input?.todos) {
					// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
					await narratorService.updateTodos(narratorId, tu.input.todos as any[], tu.toolUseId);
					broadcastToNarrator(narratorId, {
						type: "todos_updated",
						narratorId,
						// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
						todos: tu.input.todos as any[],
						toolUseId: tu.toolUseId,
					});
				}
				if (tu.name === "EnterPlanMode") {
					await narratorService.updatePlanMode(narratorId, true);
					broadcastToNarrator(narratorId, {
						type: "plan_mode_changed",
						narratorId,
						planMode: true,
					});
				}
			}

			const fullMessage = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, saved.id),
				with: { toolCalls: true },
			});
			broadcastToNarrator(narratorId, { type: "message", narratorId, message: fullMessage });
			eventBus.emit({ type: "narrator:message", narratorId, role: "assistant" });

			// Clear compact summary from DB after first response so it won't be
			// re-injected if the session is recreated.
			if (session._usedCompactSummary) {
				await db
					.update(narrators)
					.set({ contextSummary: null, updatedAt: new Date().toISOString() })
					.where(eq(narrators.id, narratorId));
				session._usedCompactSummary = false;
			}

			session.events.emit("event", { type: "assistant_message", data: saved });

			// Title tracking
			let titleUpdate: boolean | undefined;
			if (!state.titleTracked) {
				const n = await db.query.narrators.findFirst({
					where: eq(narrators.id, narratorId),
					columns: { messageCount: true, title: true },
				});
				titleUpdate = !!(n && (n.messageCount ?? 0) <= 1 && !n.title);
			}
			return { titleUpdate };
		}

		case "tool_result": {
			const status = event.isError ? "fail" : "success";
			try {
				await narratorService.updateToolCallResult(event.toolUseId, {
					output: event.output,
					status,
					errorMessage: event.isError ? event.output : undefined,
					durationMs: event.durationMs,
				});
			} catch (err) {
				logger.error("Failed to persist tool result", {
					narratorId,
					toolUseId: event.toolUseId,
					error: String(err),
				});
			}

			broadcastToNarrator(narratorId, {
				type: "tool_completed",
				narratorId,
				toolUseId: event.toolUseId,
				status,
				output: event.output,
				durationMs: event.durationMs,
			});

			// Git tracking: async broadcast git status after file-mutating tools
			if (session._worktreePath && session._chapterId && FILE_MUTATING_TOOLS.has(event.toolName)) {
				const chapterId = session._chapterId;
				const worktreePath = session._worktreePath;
				const toolUseId = event.toolUseId;
				gitService.getStatusSummary(worktreePath).then(
					(gitStatus) => {
						broadcastToNarrator(narratorId, {
							type: "git_status",
							narratorId,
							chapterId,
							toolUseId,
							status: gitStatus,
						});
					},
					(err) => {
						logger.debug("Git status tracking failed", {
							narratorId,
							error: String(err),
						});
					},
				);
			}

			// ExitPlanMode check
			if (!event.isError && event.toolName === "ExitPlanMode") {
				await narratorService.updatePlanMode(narratorId, false);
				broadcastToNarrator(narratorId, {
					type: "plan_mode_changed",
					narratorId,
					planMode: false,
				});

				// Plan compact: use the plan text directly as compact summary
				if (pendingPlanCompact.has(narratorId)) {
					pendingPlanCompact.delete(narratorId);
					const planText = event.output;
					if (planText) {
						await runPlanCompact(narratorId, planText);
						// Reset conversationId so the next loop iteration starts a fresh
						// API conversation instead of continuing the old one.
						session.conversationId = randomUUID();
						broadcastToNarrator(narratorId, { type: "compact_done", narratorId });
						// Abort the current agent loop so it doesn't continue with stale
						// context. runAgentLoop will detect _planCompactAborted and restart
						// the loop with fresh history built from post-compact messages.
						session._planCompactAborted = true;
						session.abortController.abort();
					}
				}
			}
			return null;
		}

		case "tool_output": {
			broadcastToNarrator(narratorId, {
				type: "tool_output",
				narratorId,
				toolUseId: event.toolUseId,
				output: event.output,
			});
			return null;
		}

		case "tool_progress": {
			broadcastToNarrator(narratorId, {
				type: "tool_progress",
				narratorId,
				toolUseId: event.toolUseId,
				elapsed: event.elapsed,
			});
			return null;
		}

		case "error": {
			// Abort is not a real error — treat as interruption
			if (event.message === "Aborted") {
				// Plan compact abort — don't treat as user interruption; runAgentLoop
				// handles the restart logic after the for-await loop exits.
				if (session._planCompactAborted) {
					logger.info("Agent loop aborted for plan compact", { narratorId });
					return null;
				}
				logger.info("Agent loop aborted (interrupted)", { narratorId });
				await cleanupOrphanedToolCalls(narratorId, session.locale);
				await narratorService.updateStatus(narratorId, "idle");
				session.events.emit("event", {
					type: "interrupted",
					data: { message: "Session interrupted" },
				});
				return null;
			}
			logger.error("Agent loop error", { narratorId, error: event.message });
			await narratorService.updateStatus(narratorId, "error", event.message);
			session.events.emit("event", { type: "error", data: { message: event.message } });
			return null;
		}

		case "stream_reasoning": {
			broadcastToNarrator(narratorId, {
				type: "stream_event",
				narratorId,
				event: {
					type: "content_block_delta",
					delta: { type: "reasoning_delta", text: event.text },
				},
			});
			session.events.emit("event", {
				type: "stream_event",
				data: {
					type: "content_block_delta",
					delta: { type: "reasoning_delta", text: event.text },
				},
			});
			return null;
		}

		case "context_usage": {
			session._lastContextUsagePct = event.percentage;
			broadcastToNarrator(narratorId, {
				type: "context_usage",
				narratorId,
				percentage: event.percentage,
			});
			session.events.emit("event", {
				type: "context_usage",
				data: { percentage: event.percentage },
			});
			return null;
		}

		case "metering": {
			session._lastMeterUsage = event.usage;
			session._lastMeterUnit = event.unit;
			broadcastToNarrator(narratorId, {
				type: "metering",
				narratorId,
				unit: event.unit,
				unitPlural: event.unitPlural,
				usage: event.usage,
			});
			return null;
		}

		case "invalid_state": {
				narratorId,
				reason: event.reason,
				message: event.message,
			});
				type: "error",
				error: { type: "invalid_state", reason: event.reason, message: event.message },
			};
			broadcastToNarrator(narratorId, {
				type: "stream_event",
				narratorId,
			});
			session.events.emit("event", {
				type: "stream_event",
			});
			return null;
		}

		default:
			return null;
	}
}

// === Public API ===

/**
 * Send a message to a narrator session (fire-and-forget).
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
): Promise<typeof narratorMessages.$inferSelect> {
	const { userMsg } = await feedMessage(narratorId, prompt, images, locale, replyInUserLanguage);
	broadcastToNarrator(narratorId, {
		type: "user_message",
		narratorId,
		message: userMsg,
	});
	return userMsg;
}

/**
 * Start or feed a message into a session.
 * Yields SessionEvent objects for consumption (used by chapter-merge).
 */
export async function* startSession(
	narratorId: string,
	prompt: string,
	images?: ImageRef[],
	locale: Locale = "en",
	replyInUserLanguage = false,
): AsyncGenerator<SessionEvent> {
	let session: ActiveSession;
	let userMsg: typeof narratorMessages.$inferSelect;
	try {
		({ session, userMsg } = await feedMessage(
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

	// Subscribe to session events and yield them
	const eventQueue: SessionEvent[] = [];
	let resolve: (() => void) | null = null;
	let done = false;

	const onEvent = (event: SessionEvent) => {
		eventQueue.push(event);
		if (resolve) {
			const r = resolve;
			resolve = null;
			r();
		}
	};

	session.events.on("event", onEvent);

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
		session.events.off("event", onEvent);
	}
}

// === Session control ===

/**
 * Mark any in-flight tool calls for this narrator as failed.
 * Without this, an interrupt leaves orphaned tool call records in
 * "initializing" / "pending" / "running" state, which breaks the
 */
async function cleanupOrphanedToolCalls(narratorId: string, locale: Locale = "en"): Promise<void> {
	const staleStatuses = ["initializing", "pending", "running"] as const;
	const cleaned = await db
		.update(narratorToolCalls)
		.set({
			status: "fail",
			errorMessage: "Session interrupted by user",
			outputJson: getToolMessage("interruptedByUser", locale),
		})
		.where(
			and(
				eq(narratorToolCalls.narratorId, narratorId),
				inArray(narratorToolCalls.status, [...staleStatuses]),
			),
		)
		.returning({ id: narratorToolCalls.id });
	if (cleaned.length > 0) {
		logger.info("Orphaned tool calls cleaned up after interrupt", {
			narratorId,
			count: cleaned.length,
		});
	}
}

export function interruptSession(narratorId: string): boolean {
	const session = activeSessions.get(narratorId);
	if (!session) return false;
	session.abortController.abort();
	// Fire-and-forget: clean up any in-flight tool calls so the
	// conversation history stays consistent for the next query.
	cleanupOrphanedToolCalls(narratorId, session.locale).catch((err) => {
		logger.error("Failed to clean up orphaned tool calls", { narratorId, error: String(err) });
	});
	logger.info("Narrator session interrupted", { narratorId });
	return true;
}

/** Gracefully close a streaming session. */
export function closeSession(narratorId: string): void {
	const session = activeSessions.get(narratorId);
	if (!session) return;
	session.alive = false;
	session.abortController.abort();
	cleanupOrphanedToolCalls(narratorId, session.locale).catch((err) => {
		logger.error("Failed to clean up orphaned tool calls on close", {
			narratorId,
			error: String(err),
		});
	});
	logger.info("Narrator session closed", { narratorId });
}

export function isSessionActive(narratorId: string): boolean {
	return activeSessions.has(narratorId);
}

// === Dynamic session controls ===

export function updateSessionModel(narratorId: string, model: string): void {
	const session = activeSessions.get(narratorId);
	if (session?.alive) {
		session.model = model;
		session.provider = resolveProvider(model);
	}
}

export function updateSessionPermissionMode(_narratorId: string, _mode: string): void {
	// Permission mode is read from DB in real-time by handlePermission
}

// === Buffered message API ===

/** Set a buffered message to auto-send when the current turn completes. */
export function setBufferedMessage(
	narratorId: string,
	text: string,
	images?: ImageRef[],
): { ok: boolean; bufferedAt: string } {
	if (!activeSessions.has(narratorId)) {
		return { ok: false, bufferedAt: "" };
	}
	const bufferedAt = new Date().toISOString();
	bufferedMessages.set(narratorId, { text, images, bufferedAt });
	return { ok: true, bufferedAt };
}

/** Cancel a buffered message. */
export function clearBufferedMessage(narratorId: string): void {
	bufferedMessages.delete(narratorId);
}

/** Get the current buffered message (for REST hydration). */
export function getBufferedMessage(narratorId: string): BufferedMessage | null {
	return bufferedMessages.get(narratorId) ?? null;
}

// === Startup recovery ===

/** Clean up stale in-progress states left by a previous server run. */
export async function recoverOnStartup(): Promise<void> {
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
}
