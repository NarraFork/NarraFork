import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join, normalize, resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db, sqlite } from "../db";
import {
	chapters,
	conversationBranches,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../db/schema";
import { type AgentEvent, agentLoop, buildHistory, type PermissionResult } from "../lib/agent";
import { NotFoundError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { getReplyLanguageInstruction, getToolMessage } from "../lib/prompt-i18n";
import { settings } from "../lib/settings";
import type { ImageRef } from "../lib/uploads";
import { getImagePath, imageToBase64 } from "../lib/uploads";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { narratorContext } from "./narrator-context";
import { narratorService } from "./narrator-service";
import { generateAndSetTitle, generateQuickTitle } from "./narrator-title";

// === In-memory state ===


/** Resolve provider name for a given model by looking up settings.agent.customModels. */
function resolveProvider(model: string): string {
	const custom = settings.agent.customModels ?? [];
	const found = custom.find((m: { value: string; provider?: string }) => m.value === model);
}

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
}

const pendingPermissions = new Map<string, PendingPermission>();

// Feedback queued by "allow with feedback" — keyed by narratorId
const pendingFeedback = new Map<string, { toolUseId: string; feedbackText: string }>();

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
		default:
			return [];
	}
}

// and does not access the local filesystem or execute arbitrary commands.
const ALWAYS_ALLOW_TOOLS = ["TodoWrite", "TodoRead", "EnterPlanMode", "ExitPlanMode", "WebSearch"];

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
export function resolvePermissionDecision(
	toolName: string,
	input: Record<string, unknown>,
	permMode: string,
	cwd: string,
): "allow" | "deny" | "ask" {
	if (ALWAYS_ALLOW_TOOLS.includes(toolName)) return "allow";
	if (permMode === "bypassPermissions") return "allow";
	if (permMode === "dontAsk") return "deny";

	const toolPaths = extractToolPaths(toolName, input);
	const hasExternalPath = toolPaths.length > 0 && toolPaths.some((p) => !isInsideWorktree(cwd, p));

	if (!hasExternalPath) {
		if (permMode === "default" && toolName !== "Bash") return "allow";
		if (permMode === "acceptEdits" && ACCEPT_EDITS_AUTO_ALLOW.includes(toolName)) return "allow";
	}

	return "ask";
}

async function handlePermission(
	narratorId: string,
	signal: AbortSignal,
	toolName: string,
	input: Record<string, unknown>,
	toolUseId: string,
	cwd: string,
): Promise<PermissionResult> {
	// Read permission mode from DB in real-time
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { permissionMode: true },
	});
	const permMode = narrator?.permissionMode ?? "default";

	const decision = resolvePermissionDecision(toolName, input, permMode, cwd);
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
		logger.debug("Permission auto-denied", { narratorId, toolName, toolUseId, permMode });
		await db
			.update(narratorToolCalls)
			.set({
				status: "fail",
				errorMessage: "Non-interactive session: all risky operations are denied",
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
			behavior: "deny",
			message: "Non-interactive session: all risky operations are denied",
		};
	}

	const now = new Date().toISOString();

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

	await db
		.update(narratorToolCalls)
		.set({ status: "pending" })
		.where(eq(narratorToolCalls.id, toolCallId));

	broadcastToNarrator(narratorId, {
		type: "permission_request",
		narratorId,
		request: { id: toolCallId, toolName, toolUseId, inputJson: input },
	});
	eventBus.emit({ type: "narrator:permission_request", narratorId, requestId: toolCallId });
	await narratorService.updateStatus(narratorId, "waiting");

	if (signal.aborted) {
		broadcastToNarrator(narratorId, {
			type: "permission_resolved",
			narratorId,
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
			broadcastToNarrator(narratorId, {
				type: "permission_resolved",
				narratorId,
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
			broadcastToNarrator(narratorId, {
				type: "permission_resolved",
				narratorId,
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
			resolve({ behavior: "deny", message: "Session aborted" });
		};

		signal.addEventListener("abort", onAbort, { once: true });

		pendingPermissions.set(toolCallId, {
			resolve,
			cleanup,
			input,
			narratorId,
			toolUseId,
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
	broadcastToNarrator(pending.narratorId, {
		type: "permission_resolved",
		narratorId: pending.narratorId,
		requestId,
		toolUseId: pending.toolUseId,
	});

	try {
		await narratorService.updateStatus(pending.narratorId, "thinking");
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

	// Resolve branch-level session state
	let effectiveSessionId = narrator.claudeSessionId;
	let effectiveContextSummary = narrator.contextSummary;
	if (narrator.activeBranchId) {
		const branch = await db.query.conversationBranches.findFirst({
			where: eq(conversationBranches.id, narrator.activeBranchId),
		});
		if (branch) {
			effectiveSessionId = branch.claudeSessionId ?? null;
			effectiveContextSummary = branch.contextSummary ?? null;
		}
	}

	// Resolve CWD
	let sessionCwd: string;
	if (narrator.chapterId) {
		const ch = await db.query.chapters.findFirst({
			where: eq(chapters.id, narrator.chapterId),
		});
		if (!ch) throw new NotFoundError("Chapter", narrator.chapterId);
		if (!ch.worktreePath) throw new Error("Chapter has no worktree (dormant?)");
		sessionCwd = ch.worktreePath;
	} else {
		sessionCwd = narrator.cwd || process.env.HOME || "/tmp";
	}

	const { prompt: effectiveSystemPrompt, usedCompactSummary } = await buildSystemPrompt(
		{ systemPrompt: narrator.systemPrompt, contextSummary: effectiveContextSummary },
		sessionCwd,
		locale,
		replyInUserLanguage,
	);

	const abortController = new AbortController();
	const events = new EventEmitter();
	events.setMaxListeners(20);

	const sessionModel = narrator.model ?? settings.agent.defaultModel;

	const session: ActiveSession = {
		abortController,
		narratorId,
		conversationId: effectiveSessionId ?? randomUUID(),
		cwd: sessionCwd,
		model: sessionModel,
		provider: resolveProvider(sessionModel),
		systemPrompt: effectiveSystemPrompt,
		events,
		alive: true,
		locale,
		_usedCompactSummary: usedCompactSummary,
		_replyInUserLanguage: replyInUserLanguage,
	};

	activeSessions.set(narratorId, session);
	return session;
}

// === Agent loop execution ===

/** Trigger compact when context usage exceeds this percentage (0–100). */
const COMPACT_CONTEXT_USAGE_PCT = 80;

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
			// Use branch-level context summary if on a branch
			let freshContextSummary = freshNarrator.contextSummary;
			if (freshNarrator.activeBranchId) {
				const branch = await db.query.conversationBranches.findFirst({
					where: eq(conversationBranches.id, freshNarrator.activeBranchId),
				});
				if (branch) {
					freshContextSummary = branch.contextSummary ?? null;
				}
			}
			const { prompt: freshSystemPrompt, usedCompactSummary } = await buildSystemPrompt(
				{ systemPrompt: freshNarrator.systemPrompt, contextSummary: freshContextSummary },
				session.cwd,
				locale,
				session._replyInUserLanguage ?? false,
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
				permissionHandler: (toolName, input, toolUseId) =>
					handlePermission(
						narratorId,
						session.abortController.signal,
						toolName,
						input,
						toolUseId,
						session.cwd,
					),
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
			for await (const event of agentLoop(
				config,
				currentText,
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

			// Agent loop done — update status
			await narratorService.updateStats(narratorId, 0);
			await narratorService.updateStatus(narratorId, "idle");

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
 * Clears claudeSessionId so the next session starts fresh with the summary.
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

	// Determine whether to store summary on branch or narrator
	const narrator = await narratorService.getById(narratorId);
	if (narrator.activeBranchId) {
		await db
			.update(conversationBranches)
			.set({
				contextSummary: summary,
				claudeSessionId: null,
				updatedAt: now,
			})
			.where(eq(conversationBranches.id, narrator.activeBranchId));
	} else {
		await db
			.update(narrators)
			.set({
				contextSummary: summary,
				claudeSessionId: null,
				updatedAt: now,
			})
			.where(eq(narrators.id, narratorId));
	}

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
			// Build SDK-compatible message for persistAssistantMessage
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
					await narratorService.updateTodos(narratorId, tu.input.todos as any[], tu.toolUseId);
					broadcastToNarrator(narratorId, {
						type: "todos_updated",
						narratorId,
						todos: tu.input.todos as any[],
						toolUseId: tu.toolUseId,
					});
				}
				if (tu.name === "EnterPlanMode") {
					await narratorService.updateSdkPlanMode(narratorId, true);
					broadcastToNarrator(narratorId, {
						type: "sdk_plan_mode_changed",
						narratorId,
						sdkPlanMode: true,
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
				const freshN = await db.query.narrators.findFirst({
					where: eq(narrators.id, narratorId),
					columns: { activeBranchId: true },
				});
				if (freshN?.activeBranchId) {
					await db
						.update(conversationBranches)
						.set({ contextSummary: null, updatedAt: new Date().toISOString() })
						.where(eq(conversationBranches.id, freshN.activeBranchId));
				} else {
					await db
						.update(narrators)
						.set({ contextSummary: null, updatedAt: new Date().toISOString() })
						.where(eq(narrators.id, narratorId));
				}
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
			});

			// ExitPlanMode check
			if (!event.isError && event.toolName === "ExitPlanMode") {
				await narratorService.updateSdkPlanMode(narratorId, false);
				broadcastToNarrator(narratorId, {
					type: "sdk_plan_mode_changed",
					narratorId,
					sdkPlanMode: false,
				});
			}
			return null;
		}

		case "error": {
			// Abort is not a real error — treat as interruption
			if (event.message === "Aborted") {
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
