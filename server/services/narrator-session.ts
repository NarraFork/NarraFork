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
import { chapters, narratorMessages, narrators, narratorToolCalls, permissionRequests } from "../db/schema";
import { NotFoundError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import { getImagePath, type ImageRef, imageToBase64 } from "../lib/uploads";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { narratorService } from "./narrator-service";
import { generateAndSetTitle } from "./narrator-title";

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
}

const pendingPermissions = new Map<string, PendingPermission>();

// === SSE event types yielded to the HTTP response ===

export type SessionEvent =
	| { type: "user_message"; data: any }
	| { type: "assistant_message"; data: any }
	| { type: "stream_event"; data: any }
	| { type: "tool_progress"; data: any }
	| { type: "result"; data: any }
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

		pendingPermissions.set(requestId, { resolve, timeoutId, input, narratorId });
	});
}

/** Called from WebSocket when user makes a permission decision */
export async function resolvePermission(
	requestId: string,
	decision: "allow" | "deny",
	denyMessage?: string,
	answers?: Record<string, string>,
): Promise<void> {
	const pending = pendingPermissions.get(requestId);
	if (!pending) {
		logger.warn("Permission resolution for unknown request", { requestId });
		return;
	}

	clearTimeout(pending.timeoutId);
	pendingPermissions.delete(requestId);

	// Resume thinking status now that user has decided
	await narratorService.updateStatus(pending.narratorId, "thinking");

	// Update DB
	const now = new Date().toISOString();
	await db
		.update(permissionRequests)
		.set({ decision, decidedBy: "user", decidedAt: now, denyMessage })
		.where(eq(permissionRequests.id, requestId));

	if (decision === "allow") {
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
	const permMode = (narrator.permissionMode ?? "default") as PermissionMode;

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
			permissionMode: permMode,
			...(permMode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
			canUseTool:
				permMode === "default"
					? (toolName, input, opts) => handlePermission(narratorId, toolName, input, opts)
					: undefined,
			abortController,
			settingSources: ["user"],
		},
	});

	activeSessions.set(narratorId, { query: sdkQuery, abortController, narratorId });
	await narratorService.updateStatus(narratorId, "thinking");

	let shouldGenerateTitle = false;
	try {
		for await (const message of sdkQuery) {
			const event = await processSDKMessage(narratorId, message);
			if (event?.type === "assistant_message") {
				// Check if title generation is needed, but defer it until after the loop
				// to avoid concurrent DB writes with ongoing message processing
				if (!shouldGenerateTitle) {
					const narrator = await narratorService.getById(narratorId);
					if ((narrator.messageCount ?? 0) === 0 && !narrator.title) {
						shouldGenerateTitle = true;
					}
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
		// Generate title after all message processing is done — no concurrent DB writes
		if (shouldGenerateTitle) {
			generateAndSetTitle(narratorId).catch(() => {});
		}
		yield { type: "done", data: null };
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
				type: "message",
				narratorId,
				message: { type: "stream_event", event: message.event },
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
						await narratorService.updateToolCallResult(block.tool_use_id, {
							output: block.content,
							status: isError ? "failed" : "completed",
							errorMessage: isError
								? typeof block.content === "string"
									? block.content
									: JSON.stringify(block.content)
								: undefined,
						});

						broadcastToNarrator(narratorId, {
							type: "tool_progress",
							narratorId,
							toolUseId: block.tool_use_id,
							elapsed: 0,
						});
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
