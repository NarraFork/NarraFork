import {
	type PermissionMode,
	type PermissionResult,
	type Query,
	query,
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
import { settings } from "../lib/settings";
import { getImagePath, type ImageRef, imageToBase64 } from "../lib/uploads";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { narratorService } from "./narrator-service";
import { generateAndSetTitle, generateQuickTitle } from "./narrator-title";
import type { Locale } from "../lib/prompt-i18n";

// === In-memory state ===

interface ActiveSession {
	query: Query;
	abortController: AbortController;
	narratorId: string;
}

const activeSessions = new Map<string, ActiveSession>();

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
	| { type: "user_message"; data: any }
	| { type: "assistant_message"; data: any }
	| { type: "stream_event"; data: any }
	| { type: "tool_progress"; data: any }
	| { type: "result"; data: any }
	| { type: "error"; data: { message: string } }
	| { type: "auto_feedback"; data: { message: string } }
	| { type: "buffered_send"; data: { message: string; images?: ImageRef[] } }
	| { type: "done"; data: null };

// === Permission handling ===

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function handlePermission(
	narratorId: string,
	toolName: string,
	input: Record<string, unknown>,
	options: {
		signal: AbortSignal;
		suggestions?: any[];
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
	// The assistant message (which creates tool call records) is processed before
	// canUseTool fires, so the record should exist.
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

	// Return a promise that resolves when user decides or timeout
	return new Promise<PermissionResult>((resolve) => {
		const timeoutId = setTimeout(async () => {
			pendingPermissions.delete(requestId);
			// Auto-deny on timeout
			await db
				.update(permissionRequests)
				.set({ decision: "deny", decidedBy: "auto_timeout", decidedAt: new Date().toISOString() })
				.where(eq(permissionRequests.id, requestId));
			resolve({ behavior: "deny", message: "Permission request timed out" });
		}, PERMISSION_TIMEOUT_MS);

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

	// Always resolve the pending promise to avoid deadlocking the SDK.
	// If any DB operation below fails, we still need to unblock the session.
	try {
		// Resume thinking status now that user has decided
		await narratorService.updateStatus(pending.narratorId, "thinking");

		// Update DB
		const now = new Date().toISOString();
		await db
			.update(permissionRequests)
			.set({ decision, decidedBy: "user", decidedAt: now, denyMessage })
			.where(eq(permissionRequests.id, requestId));
	} catch (err) {
		logger.error("Failed to update permission state in DB, resolving anyway", {
			requestId,
			error: String(err),
		});
	}

	if (decision === "allow") {
		// Queue feedback for after tool completion — will interrupt session and auto-send
		if (feedbackText?.trim()) {
			pendingFeedback.set(pending.narratorId, {
				toolUseId: pending.toolUseId,
				feedbackText: feedbackText.trim(),
			});
		}
		// For AskUserQuestion, merge answers into the input so the SDK sees them
		const updatedInput = answers ? { ...pending.input, answers } : pending.input;
		pending.resolve({ behavior: "allow", updatedInput });
	} else {
		pending.resolve({ behavior: "deny", message: denyMessage ?? "Permission denied by user" });
	}
}

// === Main session lifecycle ===

export async function* startSession(
	narratorId: string,
	prompt: string,
	images?: ImageRef[],
	locale: Locale = "en",
): AsyncGenerator<SessionEvent> {
	// Prevent concurrent sessions for the same narrator
	if (activeSessions.has(narratorId)) {
		yield { type: "error", data: { message: "A session is already active for this narrator" } };
		yield { type: "done", data: null };
		return;
	}

	const narrator = await narratorService.getById(narratorId);

	// Standalone sessions (no chapter) use home dir; chapter-bound sessions use worktree
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
		// Standalone session — use stored CWD or fall back to HOME
		sessionCwd = narrator.cwd || process.env.HOME || "/tmp";
	}

	// Persist user message with image refs
	const persistBlocks: any[] = [];
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
	yield { type: "user_message", data: userMsg };

	// Build SDK options
	const abortController = new AbortController();

	// Determine if this is a fork-on-first-message scenario (full inheritance mode)
	const isFullFork =
		chapter &&
		narrator.inheritMode === "full" &&
		narrator.parentNarratorId &&
		narrator.claudeSessionId &&
		(narrator.messageCount ?? 0) === 0;

	// For full fork, get the fork point message UUID from the chapter
	let resumeSessionAt: string | undefined;
	if (isFullFork && chapter?.forkPoint) {
		const fp = chapter.forkPoint as { commitSha: string; narratorMessageUuid?: string };
		resumeSessionAt = fp.narratorMessageUuid;
	}

	// Build SDK prompt — use AsyncIterable<SDKUserMessage> when images are present
	let sdkPrompt: string | AsyncIterable<SDKUserMessage> = prompt;
	if (images?.length) {
		const contentBlocks: any[] = [];
		for (const img of images) {
			const filePath = getImagePath(narratorId, img.imageId);
			if (filePath) {
				const data = await imageToBase64(filePath);
				contentBlocks.push({
					type: "image",
					source: { type: "base64", media_type: img.mediaType, data },
				});
			}
		}
		contentBlocks.push({ type: "text", text: prompt });

		async function* singleMessage(): AsyncIterable<SDKUserMessage> {
			yield {
				type: "user",
				message: { role: "user", content: contentBlocks },
				parent_tool_use_id: null,
				session_id: narrator.claudeSessionId ?? "",
			};
		}
		sdkPrompt = singleMessage();
	}

	const sdkQuery = query({
		prompt: sdkPrompt,
		options: {
			cwd: sessionCwd,
			model: narrator.model ?? settings.agent.defaultModel,
			resume: narrator.claudeSessionId ?? undefined,
			...(isFullFork && { forkSession: true }),
			...(isFullFork && resumeSessionAt && { resumeSessionAt }),
			includePartialMessages: true,
			systemPrompt: narrator.systemPrompt
				? { type: "preset", preset: "claude_code", append: narrator.systemPrompt }
				: undefined,
			permissionMode: "default" as PermissionMode,
			canUseTool: (toolName, input, opts) => handlePermission(narratorId, toolName, input, opts),
			abortController,
			settingSources: ["user"],
		},
	});

	activeSessions.set(narratorId, { query: sdkQuery, abortController, narratorId });
	await narratorService.updateStatus(narratorId, "thinking");

	// Phase 1: Generate quick title from user message immediately (fire-and-forget)
	const isFirstMessage = (narrator.messageCount ?? 0) === 0 && !narrator.title;
	let quickTitlePromise: Promise<void> | null = null;
	if (isFirstMessage) {
		quickTitlePromise = generateQuickTitle(narratorId, prompt, locale).catch(() => {});
	}

	let shouldUpdateTitle = false;
	try {
		for await (const message of sdkQuery) {
			const event = await processSDKMessage(narratorId, message);
			if (event?.type === "assistant_message") {
				// Phase 2: After first AI reply, update title with full conversation context
				if (!shouldUpdateTitle && isFirstMessage) {
					shouldUpdateTitle = true;
				}
			}
			if (event) yield event;
		}
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		logger.error("Narrator session error", { narratorId, error: errorMsg });
		await narratorService.updateStatus(narratorId, "error", errorMsg);
		yield { type: "error", data: { message: errorMsg } };
	} finally {
		activeSessions.delete(narratorId);
		// Phase 2: Update title with full conversation after AI reply is done
		// Wait for quick title to finish first to avoid race condition
		if (shouldUpdateTitle && quickTitlePromise) {
			await quickTitlePromise;
			generateAndSetTitle(narratorId, locale).catch(() => {});
		}

		// If there's pending feedback from "allow with feedback", yield it so the
		// SSE route can start a new session with the feedback message
		const fb = pendingFeedback.get(narratorId);
		if (fb) {
			pendingFeedback.delete(narratorId);
			yield { type: "auto_feedback", data: { message: fb.feedbackText } };
		} else {
			// Check for buffered message queued by user while narrator was thinking
			const buffered = bufferedMessages.get(narratorId);
			if (buffered) {
				bufferedMessages.delete(narratorId);
				// Don't auto-send if session errored out
				const finalNarrator = await db.query.narrators.findFirst({
					where: eq(narrators.id, narratorId),
					columns: { status: true },
				});
				if (finalNarrator?.status === "error") {
					broadcastToNarrator(narratorId, {
						type: "buffer_cleared" as any,
						narratorId,
						reason: "session_error",
					});
					yield { type: "done", data: null };
				} else {
					broadcastToNarrator(narratorId, {
						type: "buffer_cleared" as any,
						narratorId,
						reason: "sent",
					});
					yield {
						type: "buffered_send",
						data: { message: buffered.text, images: buffered.images },
					};
				}
			} else {
				yield { type: "done", data: null };
			}
		}
	}
}

async function processSDKMessage(
	narratorId: string,
	message: SDKMessage,
): Promise<SessionEvent | null> {
	switch (message.type) {
		case "assistant": {
			// Persist session ID
			await narratorService.updateSessionId(narratorId, message.session_id);

			// Persist message + tool calls
			const saved = await narratorService.persistAssistantMessage(narratorId, message as any);

			// Check for TodoWrite and persist + broadcast todos snapshot
			const assistantContent = (message as any).message?.content;
			if (Array.isArray(assistantContent)) {
				const todoBlock = assistantContent.find(
					(b: any) => b.type === "tool_use" && b.name === "TodoWrite",
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
			// Forward streaming deltas to WebSocket for real-time UI
			broadcastToNarrator(narratorId, {
				type: "stream_event",
				narratorId,
				event: message.event,
			});
			return { type: "stream_event", data: message.event };
		}

		case "user": {
			// User messages from SDK contain tool_result content blocks
			const content = (message as any).message?.content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "tool_result" && block.tool_use_id) {
						const isError = block.is_error ?? false;
						const status = isError ? "failed" : "completed";

						// Non-critical: persist tool result to DB. Failure should not kill the session.
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
			// Forward tool progress to WebSocket
			broadcastToNarrator(narratorId, {
				type: "tool_progress",
				narratorId,
				toolUseId: (message as any).tool_use_id,
				elapsed: (message as any).elapsed_time_seconds ?? 0,
			});
			return { type: "tool_progress", data: message };
		}

		case "result": {
			const costUsd = message.total_cost_usd ?? 0;
			await narratorService.updateStats(narratorId, costUsd);

			if (message.is_error) {
				const errors = "errors" in message ? (message as any).errors : [];
				await narratorService.updateStatus(
					narratorId,
					"error",
					errors.join("; ") || message.subtype,
				);
			} else {
				await narratorService.updateStatus(narratorId, "done");
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

export function isSessionActive(narratorId: string): boolean {
	return activeSessions.has(narratorId);
}

// === Buffered message API ===

/** Set a buffered message to auto-send when the current session completes. */
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
	// 1. Migrate legacy status values and reset in-progress statuses
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

	// 2. Auto-deny all stale pending permission requests
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

	// 3. Mark all "running" tool calls as "failed" (interrupted by restart)
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
