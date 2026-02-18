import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { and, eq } from "drizzle-orm";
import { db, sqlite } from "../db";
import {
	chapters,
	narratorMessages,
	narrators,
	narratorToolCalls,
	permissionRequests,
} from "../db/schema";
import { type AgentEvent, agentLoop, buildHistory, type PermissionResult } from "../lib/agent";
import { NotFoundError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { getReplyLanguageInstruction } from "../lib/prompt-i18n";
import { settings } from "../lib/settings";
import type { ImageRef } from "../lib/uploads";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { narratorContext } from "./narrator-context";
import { narratorService } from "./narrator-service";
import { generateAndSetTitle, generateQuickTitle } from "./narrator-title";

// === In-memory state ===

interface ActiveSession {
	abortController: AbortController;
	narratorId: string;
	conversationId: string;
	cwd: string;
	model: string;
	systemPrompt: string | null;
	events: EventEmitter;
	alive: boolean;
	locale: Locale;
	_usedCompactSummary?: boolean;
}

const activeSessions = new Map<string, ActiveSession>();

// Lock to prevent concurrent session creation for the same narrator
const sessionCreationLocks = new Map<string, Promise<ActiveSession>>();

interface PendingPermission {
	resolve: (result: PermissionResult) => void;
	timeoutId: ReturnType<typeof setTimeout>;
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
	| { type: "done"; data: null };

// === Permission handling ===

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function handlePermission(
	narratorId: string,
	signal: AbortSignal,
	toolName: string,
	input: Record<string, unknown>,
	toolUseId: string,
): Promise<PermissionResult> {
	// Auto-allow safe built-in tools
	const autoAllowTools = ["TodoWrite", "TodoRead"];
	if (autoAllowTools.includes(toolName)) {
		return { behavior: "allow", updatedInput: input };
	}

	// Read permission mode from DB in real-time
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { permissionMode: true },
	});
	const permMode = narrator?.permissionMode ?? "default";

	if (permMode === "bypassPermissions") {
		return { behavior: "allow", updatedInput: input };
	}
	if (permMode === "dontAsk") {
		return {
			behavior: "deny",
			message: "Non-interactive session: all risky operations are denied",
		};
	}
	if (permMode === "acceptEdits") {
		const editTools = ["Edit", "Write", "NotebookEdit", "MultiEdit"];
		if (editTools.includes(toolName)) {
			return { behavior: "allow", updatedInput: input };
		}
	}

	const requestId = generateId();
	const now = new Date().toISOString();

	const toolCallRecord = await db.query.narratorToolCalls.findFirst({
		where: and(
			eq(narratorToolCalls.narratorId, narratorId),
			eq(narratorToolCalls.toolUseId, toolUseId),
		),
	});

	await db.insert(permissionRequests).values({
		id: requestId,
		narratorId,
		toolCallId: toolCallRecord?.id ?? null,
		toolName,
		inputJson: input,
		decision: "pending",
		createdAt: now,
	});

	broadcastToNarrator(narratorId, {
		type: "permission_request",
		narratorId,
		request: { id: requestId, toolName, toolUseId, inputJson: input },
	});
	eventBus.emit({ type: "narrator:permission_request", narratorId, requestId });
	await narratorService.updateStatus(narratorId, "waiting");

	if (signal.aborted) {
		await db
			.update(permissionRequests)
			.set({ decision: "deny", decidedBy: "aborted", decidedAt: new Date().toISOString() })
			.where(eq(permissionRequests.id, requestId));
		return { behavior: "deny", message: "Session aborted" };
	}

	return new Promise<PermissionResult>((resolve) => {
		const cleanup = () => {
			clearTimeout(tid);
			signal.removeEventListener("abort", onAbort);
			pendingPermissions.delete(requestId);
		};

		const tid = setTimeout(async () => {
			cleanup();
			await db
				.update(permissionRequests)
				.set({ decision: "deny", decidedBy: "auto_timeout", decidedAt: new Date().toISOString() })
				.where(eq(permissionRequests.id, requestId));
			resolve({ behavior: "deny", message: "Permission request timed out" });
		}, PERMISSION_TIMEOUT_MS);

		const onAbort = async () => {
			cleanup();
			await db
				.update(permissionRequests)
				.set({ decision: "deny", decidedBy: "aborted", decidedAt: new Date().toISOString() })
				.where(eq(permissionRequests.id, requestId));
			resolve({ behavior: "deny", message: "Session aborted" });
		};

		signal.addEventListener("abort", onAbort, { once: true });

		pendingPermissions.set(requestId, {
			resolve,
			timeoutId: tid,
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
		logger.warn("Permission resolution for unknown request", { requestId });
		return;
	}

	clearTimeout(pending.timeoutId);
	pendingPermissions.delete(requestId);

	// Broadcast to all subscribers so other tabs can clear the permission banner
	broadcastToNarrator(pending.narratorId, {
		type: "permission_resolved",
		narratorId: pending.narratorId,
		requestId,
	});

	try {
		await narratorService.updateStatus(pending.narratorId, "thinking");
		const now = new Date().toISOString();
		const effectiveDenyMessage = denyMessage || feedbackText?.trim() || undefined;
		await db
			.update(permissionRequests)
			.set({ decision, decidedBy: "user", decidedAt: now, denyMessage: effectiveDenyMessage })
			.where(eq(permissionRequests.id, requestId));
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
				await db
					.update(permissionRequests)
					.set({ inputJson: updatedInput })
					.where(eq(permissionRequests.id, requestId));
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

	// Build system prompt
	let effectiveSystemPrompt = narrator.systemPrompt;

	// Inject compact summary if available
	let usedCompactSummary = false;
	if (narrator.contextSummary) {
		usedCompactSummary = true;
		const base = effectiveSystemPrompt ?? "";
		const sep = base ? "\n\n" : "";
		effectiveSystemPrompt = `${base}${sep}## Conversation Context\n\n${narrator.contextSummary}`;
	}

	// Append language instruction
	if (replyInUserLanguage) {
		const instruction = getReplyLanguageInstruction(locale);
		const base = effectiveSystemPrompt ?? "";
		const sep = base ? "\n\n" : "";
		effectiveSystemPrompt = `${base}${sep}## Language\n\n${instruction}`;
	}

	const abortController = new AbortController();
	const events = new EventEmitter();
	events.setMaxListeners(20);

	const session: ActiveSession = {
		abortController,
		narratorId,
		conversationId: narrator.claudeSessionId ?? randomUUID(),
		cwd: sessionCwd,
		model: narrator.model ?? settings.agent.defaultModel,
		systemPrompt: effectiveSystemPrompt,
		events,
		alive: true,
		locale,
		_usedCompactSummary: usedCompactSummary,
	};

	activeSessions.set(narratorId, session);
	return session;
}

// === Agent loop execution ===

const COMPACT_HISTORY_THRESHOLD = 80;

/**
 * Build AgentConfig, start agentLoop(), and consume events.
 * Runs in the background — kicked off by feedMessage().
 * Handles chained messages (feedback/buffered) by looping.
 */
async function runAgentLoop(session: ActiveSession, text: string): Promise<void> {
	const { narratorId, locale } = session;
	let shouldUpdateTitle = false;
	let titleTracked = false;
	let currentText = text;

	try {
		while (session.alive) {
			const dbMessages = await narratorService.getMessages(narratorId, 200);
			const history = buildHistory(dbMessages, session.model);

			// Compact if history is too long
			if (history.length > COMPACT_HISTORY_THRESHOLD) {
				await runCustomCompact(narratorId, locale);
				broadcastToNarrator(narratorId, { type: "compact_done", narratorId });
				// Reload session with summary in system prompt (use DB base to avoid cumulative append)
				const fresh = await narratorService.getById(narratorId);
				if (fresh.contextSummary) {
					const base = fresh.systemPrompt ?? "";
					const sep = base ? "\n\n" : "";
					session.systemPrompt = `${base}${sep}## Conversation Context\n\n${fresh.contextSummary}`;
					session._usedCompactSummary = true;
				}
				history.length = 0;
			}

			const config: import("../lib/agent").AgentConfig = {
				narratorId,
				conversationId: session.conversationId,
				model: session.model,
				cwd: session.cwd,
				systemPrompt: session.systemPrompt ?? undefined,
				signal: session.abortController.signal,
				permissionHandler: (toolName, input, toolUseId) =>
					handlePermission(narratorId, session.abortController.signal, toolName, input, toolUseId),
			};

			// Run one agent loop pass
			for await (const event of agentLoop(config, currentText, history)) {
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
					const userMsg = await narratorService.persistUserMessage(narratorId, buffered.text, [
						{ type: "text", text: buffered.text },
					]);
					broadcastToNarrator(narratorId, { type: "user_message", narratorId, message: userMsg });
					session.events.emit("event", { type: "user_message", data: userMsg });
					await narratorService.updateStatus(narratorId, "thinking");
					currentText = buffered.text;
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
async function runCustomCompact(narratorId: string, locale: Locale): Promise<void> {
	logger.info("Starting custom compact", { narratorId });

	const summary = await narratorContext.generateCompactSummary(narratorId, locale);

	const now = new Date().toISOString();
	await db
		.update(narrators)
		.set({
			contextSummary: summary,
			claudeSessionId: null,
			updatedAt: now,
		})
		.where(eq(narrators.id, narratorId));

	await narratorService.persistCompactMessage(narratorId, summary);
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
	runAgentLoop(session, prompt).catch((err) => {
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
			broadcastToNarrator(narratorId, {
				type: "stream_event",
				narratorId,
				event: { type: "content_block_delta", delta: { text: event.text } },
			});
			session.events.emit("event", {
				type: "stream_event",
				data: { type: "content_block_delta", delta: { text: event.text } },
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
			if (event.text) content.push({ type: "text", text: event.text });
			for (const tu of event.toolUses) {
				content.push({ type: "tool_use", id: tu.toolUseId, name: tu.name, input: tu.input });
			}

			const saved = await narratorService.persistAssistantMessage(narratorId, {
				uuid: event.messageId ?? randomUUID(),
				session_id: session.conversationId,
				message: { content },
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

			// Clear compact summary after first response
			if (session._usedCompactSummary) {
				session._usedCompactSummary = false;
				await db
					.update(narrators)
					.set({ contextSummary: null, updatedAt: new Date().toISOString() })
					.where(eq(narrators.id, narratorId));
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
			const status = event.isError ? "failed" : "completed";
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
			logger.error("Agent loop error", { narratorId, error: event.message });
			await narratorService.updateStatus(narratorId, "error", event.message);
			session.events.emit("event", { type: "error", data: { message: event.message } });
			return null;
		}

		default:
			return null;
	}
}

// === Public API ===

/**
 * Start or feed a message into a session.
 * Yields SessionEvent objects for SSE consumption.
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

export function interruptSession(narratorId: string): boolean {
	const session = activeSessions.get(narratorId);
	if (!session) return false;
	session.abortController.abort();
	logger.info("Narrator session interrupted", { narratorId });
	return true;
}

/** Gracefully close a streaming session. */
export function closeSession(narratorId: string): void {
	const session = activeSessions.get(narratorId);
	if (!session) return;
	session.alive = false;
	session.abortController.abort();
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

	const stalePermissions = await db.query.permissionRequests.findMany({
		where: eq(permissionRequests.decision, "pending"),
	});
	if (stalePermissions.length > 0) {
		await db
			.update(permissionRequests)
			.set({ decision: "deny", decidedBy: "server_restart", decidedAt: now })
			.where(eq(permissionRequests.decision, "pending"));
		logger.info("Stale permission requests auto-denied on startup", {
			count: stalePermissions.length,
		});
	}

	const staleToolCalls = await db.query.narratorToolCalls.findMany({
		where: eq(narratorToolCalls.status, "running"),
	});
	if (staleToolCalls.length > 0) {
		await db
			.update(narratorToolCalls)
			.set({ status: "failed", errorMessage: "Interrupted by server restart" })
			.where(eq(narratorToolCalls.status, "running"));
		logger.info("Stale running tool calls marked as failed on startup", {
			count: staleToolCalls.length,
		});
	}
}
