import {
	type PermissionMode,
	type PermissionResult,
	type Query,
	query,
	type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, narratorToolCalls, permissionRequests } from "../db/schema";
import { NotFoundError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { narratorService } from "./narrator-service";

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

		pendingPermissions.set(requestId, { resolve, timeoutId });
	});
}

/** Called from WebSocket when user makes a permission decision */
export async function resolvePermission(
	requestId: string,
	decision: "allow" | "deny",
	denyMessage?: string,
): Promise<void> {
	const pending = pendingPermissions.get(requestId);
	if (!pending) {
		logger.warn("Permission resolution for unknown request", { requestId });
		return;
	}

	clearTimeout(pending.timeoutId);
	pendingPermissions.delete(requestId);

	// Update DB
	const now = new Date().toISOString();
	await db
		.update(permissionRequests)
		.set({ decision, decidedBy: "user", decidedAt: now, denyMessage })
		.where(eq(permissionRequests.id, requestId));

	if (decision === "allow") {
		pending.resolve({ behavior: "allow" });
	} else {
		pending.resolve({ behavior: "deny", message: denyMessage ?? "Permission denied by user" });
	}
}

// === Main session lifecycle ===

export async function* startSession(
	narratorId: string,
	prompt: string,
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
		// Standalone session
		sessionCwd = process.env.HOME ?? "/tmp";
	}

	// Persist user message
	const userMsg = await narratorService.persistUserMessage(narratorId, prompt);
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

	const sdkQuery = query({
		prompt,
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

	try {
		for await (const message of sdkQuery) {
			const event = await processSDKMessage(narratorId, message);
			if (event) yield event;
		}
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		logger.error("Narrator session error", { narratorId, error: errorMsg });
		await narratorService.updateStatus(narratorId, "error", errorMsg);
		yield { type: "error", data: { message: errorMsg } };
	} finally {
		activeSessions.delete(narratorId);
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

			// Broadcast to WebSocket
			broadcastToNarrator(narratorId, {
				type: "message",
				narratorId,
				message: { role: "assistant", content: message.message.content },
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
				await narratorService.updateStatus(narratorId, "active");
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
