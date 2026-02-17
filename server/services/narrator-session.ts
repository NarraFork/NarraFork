import { EventEmitter } from "node:events";
import {
	type HookCallback,
	type NotificationHookInput,
	type PermissionMode,
	type PermissionResult,
	type Query,
	query,
	type SDKAssistantMessage,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { and, eq } from "drizzle-orm";
import { db, sqlite } from "../db";
import {
	chapters,
	narratorMessages,
	narrators,
	narratorToolCalls,
	permissionRequests,
} from "../db/schema";
import { NotFoundError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { getReplyLanguageInstruction } from "../lib/prompt-i18n";
import { settings } from "../lib/settings";
import { getImagePath, type ImageRef, imageToBase64 } from "../lib/uploads";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { narratorContext } from "./narrator-context";
import { narratorService } from "./narrator-service";
import { generateAndSetTitle, generateQuickTitle, persistTitle } from "./narrator-title";

// === Async message channel for streaming input mode ===

class MessageChannel implements AsyncIterable<SDKUserMessage> {
	private queue: SDKUserMessage[] = [];
	private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
	private closed = false;

	push(msg: SDKUserMessage): void {
		if (this.closed) return;
		if (this.waiting) {
			const resolve = this.waiting;
			this.waiting = null;
			resolve({ value: msg, done: false });
		} else {
			this.queue.push(msg);
		}
	}

	close(): void {
		this.closed = true;
		if (this.waiting) {
			const resolve = this.waiting;
			this.waiting = null;
			resolve({ value: undefined as unknown as SDKUserMessage, done: true });
		}
	}
	async *[Symbol.asyncIterator](): AsyncIterableIterator<SDKUserMessage> {
		while (true) {
			if (this.queue.length > 0) {
				const msg = this.queue.shift();
				if (msg !== undefined) yield msg;
			} else if (this.closed) {
				return;
			} else {
				const result = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
					this.waiting = resolve;
				});
				if (result.done) return;
				yield result.value;
			}
		}
	}
}

// === In-memory state ===

interface ActiveSession {
	query: Query;
	channel: MessageChannel;
	abortController: AbortController;
	narratorId: string;
	sessionId: string | null;
	events: EventEmitter;
	alive: boolean;
	locale: Locale;
	/** Set to true after a resume failure triggered a fresh-session retry */
	_skipResume?: boolean;
	/** Set to true when PreCompact hook fires, signaling session rotation */
	_compactTriggered?: boolean;
	/** Set to true when this session was created with a compact summary */
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

// Narrators whose resume failed — next createSession will skip resume
const resumeFailedNarrators = new Set<string>();

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
	toolName: string,
	input: Record<string, unknown>,
	options: {
		signal: AbortSignal;
		suggestions?: unknown[];
		decisionReason?: string;
		toolUseID: string;
	},
): Promise<PermissionResult> {
	// Auto-allow safe built-in tools that don't need user approval
	const autoAllowTools = ["TodoWrite", "TodoRead"];
	if (autoAllowTools.includes(toolName)) {
		return { behavior: "allow", updatedInput: input };
	}

	// Read permission mode from DB in real-time so mid-session changes take effect
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { permissionMode: true },
	});
	const permMode = narrator?.permissionMode ?? "default";

	// Auto-allow/deny based on current permission mode
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
		// Accept file-editing tools automatically, prompt for others
		const editTools = ["Edit", "Write", "NotebookEdit", "MultiEdit"];
		if (editTools.includes(toolName)) {
			return { behavior: "allow", updatedInput: input };
		}
	}

	const requestId = generateId();
	const now = new Date().toISOString();

	// Look up the narratorToolCalls record by SDK tool_use_id to get its PK.
	const toolCallRecord = await db.query.narratorToolCalls.findFirst({
		where: and(
			eq(narratorToolCalls.narratorId, narratorId),
			eq(narratorToolCalls.toolUseId, options.toolUseID),
		),
	});

	// Create permission request record
	await db.insert(permissionRequests).values({
		id: requestId,
		narratorId,
		toolCallId: toolCallRecord?.id ?? null,
		toolName,
		inputJson: input,
		decisionReason: options.decisionReason,
		suggestions: options.suggestions,
		decision: "pending",
		createdAt: now,
	});

	// Broadcast to WebSocket subscribers
	broadcastToNarrator(narratorId, {
		type: "permission_request",
		narratorId,
		request: {
			id: requestId,
			toolName,
			toolUseId: options.toolUseID,
			inputJson: input,
			decisionReason: options.decisionReason,
			suggestions: options.suggestions,
		},
	});

	eventBus.emit({ type: "narrator:permission_request", narratorId, requestId });

	// Mark narrator as waiting for user decision
	await narratorService.updateStatus(narratorId, "waiting");

	// If already aborted, reject immediately
	if (options.signal.aborted) {
		await db
			.update(permissionRequests)
			.set({ decision: "deny", decidedBy: "aborted", decidedAt: new Date().toISOString() })
			.where(eq(permissionRequests.id, requestId));
		return { behavior: "deny", message: "Session aborted" };
	}

	// Return a promise that resolves when user decides, timeout, or abort
	return new Promise<PermissionResult>((resolve) => {
		const cleanup = () => {
			clearTimeout(timeoutId);
			options.signal.removeEventListener("abort", onAbort);
			pendingPermissions.delete(requestId);
		};

		const timeoutId = setTimeout(async () => {
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

		options.signal.addEventListener("abort", onAbort, { once: true });

		pendingPermissions.set(requestId, {
			resolve,
			timeoutId,
			input,
			narratorId,
			toolUseId: options.toolUseID,
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

// === Session lifecycle (streaming input mode) ===

/**
 * Ensure a long-lived streaming SDK session exists for this narrator.
 * If one is already alive, return it. Otherwise create a new one.
 */
async function ensureSession(
	narratorId: string,
	locale: Locale,
	replyInUserLanguage = false,
): Promise<ActiveSession> {
	const existing = activeSessions.get(narratorId);
	if (existing?.alive) return existing;

	// If another call is already creating a session, wait for it
	const pending = sessionCreationLocks.get(narratorId);
	if (pending) return pending;

	const creation = createSession(narratorId, locale, false, replyInUserLanguage);
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
	skipResume = false,
	replyInUserLanguage = false,
): Promise<ActiveSession> {
	// Clean up dead session if present
	const existing = activeSessions.get(narratorId);
	if (existing) activeSessions.delete(narratorId);

	// Auto-skip resume if a previous resume attempt failed for this narrator
	if (resumeFailedNarrators.has(narratorId)) {
		skipResume = true;
		resumeFailedNarrators.delete(narratorId);
	}

	const narrator = await narratorService.getById(narratorId);

	// Resolve CWD
	let sessionCwd: string;
	let chapter: Awaited<ReturnType<typeof db.query.chapters.findFirst>> | null = null;

	if (narrator.chapterId) {
		const ch = await db.query.chapters.findFirst({
			where: eq(chapters.id, narrator.chapterId),
		});
		if (!ch) throw new NotFoundError("Chapter", narrator.chapterId);
		if (!ch.worktreePath) {
			throw new Error("Chapter has no worktree (dormant?)");
		}
		chapter = ch;
		sessionCwd = ch.worktreePath;
	} else {
		sessionCwd = narrator.cwd || process.env.HOME || "/tmp";
	}

	// Fork detection
	const isFullFork =
		!skipResume &&
		chapter &&
		narrator.inheritMode === "full" &&
		narrator.parentNarratorId &&
		narrator.claudeSessionId &&
		(narrator.messageCount ?? 0) === 0;

	let resumeSessionAt: string | undefined;
	if (isFullFork && chapter?.forkPoint) {
		const fp = chapter.forkPoint as { commitSha: string; narratorMessageUuid?: string };
		resumeSessionAt = fp.narratorMessageUuid;
	}

	// Determine resume session ID (skip if previous resume failed)
	const resumeSessionId = skipResume ? undefined : (narrator.claudeSessionId ?? undefined);

	const abortController = new AbortController();
	const channel = new MessageChannel();
	const events = new EventEmitter();
	events.setMaxListeners(20);

	const onPreCompact: HookCallback = async (_input) => {
		// Let SDK handle compact normally for now.
		// Custom compact logic (runCustomCompact / handleCompactRotation) is preserved
		// and can be activated by setting _compactTriggered = true + interrupting here.
		logger.info("PreCompact triggered, allowing SDK compact", { narratorId });
		broadcastToNarrator(narratorId, { type: "compacting", narratorId });
		return {};
	};

	const onNotification: HookCallback = async (input) => {
		const notification = input as NotificationHookInput;
		if (notification.title) {
			const title = notification.title.trim().replace(/^["'""]+|["'""]+$/g, "");
			if (title) {
				persistTitle(narratorId, title).catch(() => {});
			}
		}
		return {};
	};

	if (skipResume) {
		logger.info("Creating fresh session (resume skipped)", { narratorId });
	}

	// When skipping resume due to failure, generate a context summary to preserve continuity
	let effectiveSystemPrompt = narrator.systemPrompt;
	if (skipResume && narrator.claudeSessionId) {
		try {
			logger.info("Generating context summary for resume-failed session", { narratorId });
			const summary = await narratorContext.generateContextSummary(narratorId, locale);
			const base = effectiveSystemPrompt ?? "";
			const sep = base ? "\n\n" : "";
			effectiveSystemPrompt = `${base}${sep}## Previous Context Summary\n\nThis session was automatically recovered after a resume failure. Here is a summary of the prior conversation:\n\n${summary}`;
			logger.info("Context summary injected into system prompt", {
				narratorId,
				summaryLength: summary.length,
			});
		} catch (err) {
			logger.error("Failed to generate context summary for resume fallback", {
				narratorId,
				error: String(err),
			});
			// Continue without summary — a fresh session is better than no session
		}
	}

	// When a compact summary exists, inject it and start a fresh session (no resume)
	let usedCompactSummary = false;
	if (narrator.contextSummary && !skipResume) {
		skipResume = true;
		usedCompactSummary = true;
		const base = effectiveSystemPrompt ?? "";
		const sep = base ? "\n\n" : "";
		effectiveSystemPrompt = `${base}${sep}## Conversation Context\n\n${narrator.contextSummary}`;
		logger.info("Using compact summary for new session", {
			narratorId,
			summaryLength: narrator.contextSummary.length,
		});
	}

	// Append language instruction when user has "reply in my language" enabled
	if (replyInUserLanguage) {
		const instruction = getReplyLanguageInstruction(locale);
		const base = effectiveSystemPrompt ?? "";
		const sep = base ? "\n\n" : "";
		effectiveSystemPrompt = `${base}${sep}## Language\n\n${instruction}`;
	}

	// When resuming an existing SDK session, skip the heavy claude_code preset
	// and CLAUDE.md loading — the SDK already has the full context from the JSONL.
	// This avoids ~22k of redundant prompt tokens on every resume.
	const isResume = !!resumeSessionId && !isFullFork;

	const systemPromptOption = isResume
		? ""
		: effectiveSystemPrompt
			? { type: "preset" as const, preset: "claude_code" as const, append: effectiveSystemPrompt }
			: { type: "preset" as const, preset: "claude_code" as const };

	const sdkQuery = query({
		prompt: channel,
		options: {
			cwd: sessionCwd,
			model: narrator.model ?? settings.agent.defaultModel,
			resume: resumeSessionId,
			...(isFullFork && { forkSession: true }),
			...(isFullFork && resumeSessionAt && { resumeSessionAt }),
			includePartialMessages: true,
			systemPrompt: systemPromptOption,
			permissionMode: (narrator.sdkPlanMode ? "plan" : "default") as PermissionMode,
			canUseTool: (toolName, input, opts) => handlePermission(narratorId, toolName, input, opts),
			abortController,
			settingSources: ["user", "project"],
			hooks: {
				PreCompact: [{ hooks: [onPreCompact] }],
				Notification: [{ hooks: [onNotification] }],
			},
		},
	});

	const session: ActiveSession = {
		query: sdkQuery,
		channel,
		abortController,
		narratorId,
		sessionId: narrator.claudeSessionId ?? null,
		events,
		alive: true,
		locale,
		_skipResume: skipResume,
		_usedCompactSummary: usedCompactSummary,
	};

	activeSessions.set(narratorId, session);

	// Start detached consumption loop
	consumeSDKMessages(session).catch((err) => {
		logger.error("SDK consumption loop crashed", { narratorId, error: String(err) });
	});

	return session;
}

/**
 * Detached background loop that reads SDK messages and broadcasts events.
 * Runs independently of any SSE connection.
 */
async function consumeSDKMessages(session: ActiveSession): Promise<void> {
	const { narratorId, locale } = session;
	let shouldUpdateTitle = false;
	let titleTracked = false;

	try {
		for await (const message of session.query) {
			// Update session ID from SDK messages
			if ("session_id" in message && message.session_id) {
				session.sessionId = message.session_id as string;
			}

			let event: SessionEvent | null = null;
			try {
				event = await processSDKMessage(narratorId, message);
			} catch (err) {
				// Non-fatal: log and continue — don't kill the session for transient DB errors
				logger.error("processSDKMessage failed, continuing session", {
					narratorId,
					messageType: message.type,
					error: String(err),
				});
			}

			if (event?.type === "assistant_message" && !shouldUpdateTitle && !titleTracked) {
				const narrator = await db.query.narrators.findFirst({
					where: eq(narrators.id, narratorId),
					columns: { messageCount: true, title: true },
				});
				if (narrator && (narrator.messageCount ?? 0) <= 1 && !narrator.title) {
					shouldUpdateTitle = true;
				}
				titleTracked = true;
			}

			// Clear compact summary after first successful response in new session
			if (event?.type === "assistant_message" && session._usedCompactSummary) {
				session._usedCompactSummary = false;
				await db
					.update(narrators)
					.set({ contextSummary: null, updatedAt: new Date().toISOString() })
					.where(eq(narrators.id, narratorId));
			}

			if (event) {
				session.events.emit("event", event);
			}

			// After each turn completes, handle feedback/buffered messages
			if (message.type === "result") {
				// Check if this result was triggered by our PreCompact interrupt
				if (session._compactTriggered) {
					session._compactTriggered = false;
					await handleCompactRotation(session, narratorId, locale);
					continue;
				}

				const fb = pendingFeedback.get(narratorId);
				if (fb) {
					pendingFeedback.delete(narratorId);
					// Auto-feed feedback as a new message
					const userMsg = await narratorService.persistUserMessage(narratorId, fb.feedbackText, [
						{ type: "text", text: fb.feedbackText },
					]);
					session.events.emit("event", { type: "user_message", data: userMsg });
					await narratorService.updateStatus(narratorId, "thinking");
					await feedMessageInternal(session, fb.feedbackText);
					continue;
				}

				const buffered = bufferedMessages.get(narratorId);
				if (buffered) {
					bufferedMessages.delete(narratorId);
					const finalNarrator = await db.query.narrators.findFirst({
						where: eq(narrators.id, narratorId),
						columns: { status: true },
					});
					if (finalNarrator?.status !== "error") {
						broadcastToNarrator(narratorId, {
							type: "buffer_cleared",
							narratorId,
							reason: "sent",
						});
						const userMsg = await narratorService.persistUserMessage(narratorId, buffered.text, [
							{ type: "text", text: buffered.text },
						]);
						session.events.emit("event", { type: "user_message", data: userMsg });
						await narratorService.updateStatus(narratorId, "thinking");
						await feedMessageInternal(session, buffered.text, buffered.images);
						continue;
					}
					broadcastToNarrator(narratorId, {
						type: "buffer_cleared",
						narratorId,
						reason: "session_error",
					});
				}

				// No chained message — this turn is done
				session.events.emit("event", { type: "done", data: null });
			}
		}
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);

		// If compact triggered the interruption, handle it gracefully
		if (session._compactTriggered) {
			session._compactTriggered = false;
			try {
				await handleCompactRotation(session, narratorId, locale);
			} catch (compactErr) {
				logger.error("Compact rotation failed in catch block", {
					narratorId,
					error: String(compactErr),
				});
				session.events.emit("event", { type: "done", data: null });
			}
			return;
		}

		// Detect resume failures (malformed session data from corrupted JSONL)
		const isResumeFailure =
			session.sessionId &&
			!session._skipResume &&
			(errorMsg.includes("Improperly formed request") ||
				errorMsg.includes("400 Bad Request") ||
				errorMsg.includes("invalid_request_error"));

		if (isResumeFailure) {
			logger.warn("Session resume failed, clearing claudeSessionId for fresh start", {
				narratorId,
				error: errorMsg,
			});
			resumeFailedNarrators.add(narratorId);
			// Persist the decision: clear DB session ID so a server restart
			// won't re-attempt resuming the corrupted session
			await db
				.update(narrators)
				.set({ claudeSessionId: null, updatedAt: new Date().toISOString() })
				.where(eq(narrators.id, narratorId));
			await narratorService.updateStatus(
				narratorId,
				"error",
				"Session context corrupted. Send a new message to auto-recover with context summary.",
			);
		} else {
			logger.error("Narrator session error", { narratorId, error: errorMsg });
			await narratorService.updateStatus(narratorId, "error", errorMsg);
		}

		session.events.emit("event", { type: "error", data: { message: errorMsg } });
		session.events.emit("event", { type: "done", data: null });
	} finally {
		session.alive = false;
		activeSessions.delete(narratorId);

		// Clean up SDK resources to prevent process leaks
		session.channel.close();
		session.abortController.abort();

		// Safety net: ensure SSE consumers always receive a done event.
		// Duplicate done is harmless — startSession breaks on the first one.
		session.events.emit("event", { type: "done", data: null });

		session.events.removeAllListeners();

		// Title generation after session ends
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

/**
 * Handle compact-triggered session rotation: run compact, then re-deliver
 * any pending feedback or buffered messages via a new session.
 */
async function handleCompactRotation(
	session: ActiveSession,
	narratorId: string,
	locale: Locale,
): Promise<void> {
	logger.info("Running custom compact after PreCompact interrupt", { narratorId });

	try {
		await runCustomCompact(narratorId, locale);
		broadcastToNarrator(narratorId, { type: "compact_done", narratorId });
	} catch (err) {
		logger.error("Custom compact failed", { narratorId, error: String(err) });
		// Even if compact fails, clear session so next message starts fresh
		await db
			.update(narrators)
			.set({ claudeSessionId: null, updatedAt: new Date().toISOString() })
			.where(eq(narrators.id, narratorId));
		broadcastToNarrator(narratorId, { type: "compact_done", narratorId });
	}

	// Re-deliver pending feedback or buffered messages via a new session
	const fb = pendingFeedback.get(narratorId);
	if (fb) {
		pendingFeedback.delete(narratorId);
		const newSession = await ensureSession(narratorId, locale);
		const userMsg = await narratorService.persistUserMessage(narratorId, fb.feedbackText, [
			{ type: "text", text: fb.feedbackText },
		]);
		newSession.events.emit("event", { type: "user_message", data: userMsg });
		await narratorService.updateStatus(narratorId, "thinking");
		await feedMessageInternal(newSession, fb.feedbackText);
		return;
	}

	const buffered = bufferedMessages.get(narratorId);
	if (buffered) {
		bufferedMessages.delete(narratorId);
		broadcastToNarrator(narratorId, {
			type: "buffer_cleared",
			narratorId,
			reason: "sent",
		});
		const newSession = await ensureSession(narratorId, locale);
		const userMsg = await narratorService.persistUserMessage(narratorId, buffered.text, [
			{ type: "text", text: buffered.text },
		]);
		newSession.events.emit("event", { type: "user_message", data: userMsg });
		await narratorService.updateStatus(narratorId, "thinking");
		await feedMessageInternal(newSession, buffered.text, buffered.images);
		return;
	}

	// No pending messages — session will be recreated on next user message
	session.events.emit("event", { type: "done", data: null });
}

// === Message feeding ===

/** Push a message into an existing session's channel (internal, no persistence). */
async function feedMessageInternal(
	session: ActiveSession,
	text: string,
	images?: ImageRef[],
): Promise<void> {
	const contentBlocks: Array<
		| { type: "text"; text: string }
		| { type: "image"; source: { type: "base64"; media_type: string; data: string } }
	> = [];
	if (images?.length) {
		for (const img of images) {
			const filePath = getImagePath(session.narratorId, img.imageId);
			if (filePath) {
				const data = await imageToBase64(filePath);
				contentBlocks.push({
					type: "image",
					source: { type: "base64", media_type: img.mediaType, data },
				});
			}
		}
	}
	contentBlocks.push({ type: "text", text });

	session.channel.push({
		type: "user",
		message: { role: "user", content: contentBlocks },
		parent_tool_use_id: null,
		session_id: session.sessionId ?? "",
	});
}

/**
 * Feed a new user message into the narrator's streaming session.
 * Creates the session if it doesn't exist yet.
 * Returns the ActiveSession and persisted user message for the caller to emit after subscribing.
 */
async function feedMessage(
	narratorId: string,
	prompt: string,
	images?: ImageRef[],
	locale: Locale = "en",
	replyInUserLanguage = false,
): Promise<{ session: ActiveSession; userMsg: typeof narratorMessages.$inferSelect }> {
	const session = await ensureSession(narratorId, locale, replyInUserLanguage);

	// Persist user message to DB
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

	// Update status
	await narratorService.updateStatus(narratorId, "thinking");

	// Quick title on first message
	const narrator = await narratorService.getById(narratorId);
	if ((narrator.messageCount ?? 0) <= 1 && !narrator.title) {
		generateQuickTitle(narratorId, prompt, locale).catch(() => {});
	}

	// Feed the message into the channel
	await feedMessageInternal(session, prompt, images);

	return { session, userMsg };
}

// === SDK message processing ===

async function processSDKMessage(
	narratorId: string,
	message: SDKMessage,
): Promise<SessionEvent | null> {
	switch (message.type) {
		case "assistant": {
			// Persist session ID
			await narratorService.updateSessionId(narratorId, message.session_id);

			// Persist message + tool calls
			const saved = await narratorService.persistAssistantMessage(
				narratorId,
				message as unknown as Parameters<typeof narratorService.persistAssistantMessage>[1],
			);

			// Check for TodoWrite and persist + broadcast todos snapshot
			const assistantContent = (message as SDKAssistantMessage).message?.content;
			if (Array.isArray(assistantContent)) {
				const todoBlock = assistantContent.find(
					(b: { type: string; name?: string; input?: Record<string, unknown>; id?: string }) =>
						b.type === "tool_use" && b.name === "TodoWrite",
				);
				if (todoBlock?.input?.todos) {
					await narratorService.updateTodos(narratorId, todoBlock.input.todos, todoBlock.id);
					broadcastToNarrator(narratorId, {
						type: "todos_updated",
						narratorId,
						todos: todoBlock.input.todos,
						toolUseId: todoBlock.id,
					});
				}

				// Track EnterPlanMode tool invocations for sdkPlanMode
				for (const block of assistantContent) {
					if (block.type === "tool_use" && block.name === "EnterPlanMode") {
						await narratorService.updateSdkPlanMode(narratorId, true);
						broadcastToNarrator(narratorId, {
							type: "sdk_plan_mode_changed",
							narratorId,
							sdkPlanMode: true,
						});
					}
				}
			}

			// Broadcast full persisted message (with toolCalls) to WebSocket
			const fullMessage = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, saved.id),
				with: { toolCalls: true },
			});
			broadcastToNarrator(narratorId, {
				type: "message",
				narratorId,
				message: fullMessage,
			});

			eventBus.emit({ type: "narrator:message", narratorId, role: "assistant" });

			return { type: "assistant_message", data: saved };
		}

		case "stream_event": {
			broadcastToNarrator(narratorId, {
				type: "stream_event",
				narratorId,
				event: message.event,
			});
			return { type: "stream_event", data: message.event };
		}

		case "user": {
			// User messages from SDK contain tool_result content blocks
			const content = message.message?.content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "tool_result" && block.tool_use_id) {
						const isError = block.is_error ?? false;
						const status = isError ? "failed" : "completed";

						try {
							await narratorService.updateToolCallResult(block.tool_use_id, {
								output: block.content,
								status,
								errorMessage: isError
									? typeof block.content === "string"
										? block.content
										: JSON.stringify(block.content)
									: undefined,
							});
						} catch (err) {
							logger.error("Failed to persist tool call result", {
								narratorId,
								toolUseId: block.tool_use_id,
								error: String(err),
							});
						}

						broadcastToNarrator(narratorId, {
							type: "tool_completed",
							narratorId,
							toolUseId: block.tool_use_id,
							status,
							output: block.content,
						});

						// ExitPlanMode: only leave plan mode when user approved
						if (!isError) {
							try {
								const toolCall = await db.query.narratorToolCalls.findFirst({
									where: eq(narratorToolCalls.toolUseId, block.tool_use_id),
									columns: { toolName: true },
								});
								if (toolCall?.toolName === "ExitPlanMode") {
									await narratorService.updateSdkPlanMode(narratorId, false);
									broadcastToNarrator(narratorId, {
										type: "sdk_plan_mode_changed",
										narratorId,
										sdkPlanMode: false,
									});
								}
							} catch (err) {
								logger.error("Failed to check ExitPlanMode tool result", {
									narratorId,
									toolUseId: block.tool_use_id,
									error: String(err),
								});
							}
						}

						// If this tool had "allow with feedback", interrupt session now
						const fb = pendingFeedback.get(narratorId);
						if (fb && fb.toolUseId === block.tool_use_id) {
							const session = activeSessions.get(narratorId);
							if (session) {
								logger.info("Interrupting session for allow-with-feedback", {
									narratorId,
									toolUseId: fb.toolUseId,
								});
								session.query.interrupt().catch(() => {});
							}
						}
					}
				}
			}
			return null;
		}

		case "tool_progress": {
			broadcastToNarrator(narratorId, {
				type: "tool_progress",
				narratorId,
				toolUseId: message.tool_use_id,
				elapsed: message.elapsed_time_seconds ?? 0,
			});
			return { type: "tool_progress", data: message };
		}

		case "result": {
			const costUsd = message.total_cost_usd ?? 0;
			await narratorService.updateStats(narratorId, costUsd);

			if (message.is_error) {
				const errors = "errors" in message ? (message as { errors: string[] }).errors : [];
				await narratorService.updateStatus(
					narratorId,
					"error",
					errors.join("; ") || message.subtype,
				);
			} else {
				// In streaming mode, "idle" instead of "done" — session stays alive
				await narratorService.updateStatus(narratorId, "idle");
			}

			return {
				type: "result",
				data: {
					subtype: message.subtype,
					totalCostUsd: costUsd,
					numTurns: message.num_turns,
					durationMs: message.duration_ms,
					isError: message.is_error,
				},
			};
		}

		default:
			return null;
	}
}

// === Public API: startSession (compatibility wrapper) ===

/**
 * Start or feed a message into a streaming session.
 * Yields SessionEvent objects for SSE consumption.
 * The underlying SDK session stays alive between calls.
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

export async function interruptSession(narratorId: string): Promise<boolean> {
	const session = activeSessions.get(narratorId);
	if (!session) return false;

	try {
		await session.query.interrupt();
		logger.info("Narrator session interrupted", { narratorId });
		return true;
	} catch (err) {
		logger.error("Failed to interrupt session", { narratorId, error: String(err) });
		return false;
	}
}

/** Gracefully close a streaming session. */
export function closeSession(narratorId: string): void {
	const session = activeSessions.get(narratorId);
	if (!session) return;
	session.alive = false;
	session.channel.close();
	logger.info("Narrator session closed", { narratorId });
}

export function isSessionActive(narratorId: string): boolean {
	return activeSessions.has(narratorId);
}

// === Dynamic session controls ===

export async function updateSessionModel(narratorId: string, model: string): Promise<void> {
	const session = activeSessions.get(narratorId);
	if (session?.alive) {
		await session.query.setModel(model);
	}
}

export async function updateSessionPermissionMode(
	narratorId: string,
	mode: PermissionMode,
): Promise<void> {
	const session = activeSessions.get(narratorId);
	if (session?.alive) {
		await session.query.setPermissionMode(mode);
	}
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
