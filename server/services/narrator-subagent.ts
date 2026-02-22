import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narratorMessages, narrators } from "../db/schema";
import { type AgentConfig, type AgentEvent, agentLoop, type ToolDefinition } from "../lib/agent";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import {
	getReplyLanguageInstruction,
	getSubagentPrompt,
	type Locale,
	type SubagentType,
} from "../lib/prompt-i18n";
import { resolveProvider, settings } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { narratorService } from "./narrator-service";
import { handlePermission } from "./narrator-session";

// === Subagent type definitions ===

/** Tools available to explore/plan subagents (read-only + Bash for shell inspection) */
const READONLY_TOOLS = new Set(["Read", "Glob", "Grep", "WebSearch", "Bash"]);

/** Tools excluded from general subagents (no nesting, no plan mode) */
const GENERAL_EXCLUDED = new Set(["Task", "EnterPlanMode", "ExitPlanMode", "TodoWrite"]);

/** Tool filter factories per subagent type */
const TOOL_FILTERS: Record<string, (tool: ToolDefinition) => boolean> = {
	explore: (tool) => READONLY_TOOLS.has(tool.name),
	plan: (tool) => READONLY_TOOLS.has(tool.name),
	general: (tool) => !GENERAL_EXCLUDED.has(tool.name),
};

// === Subagent runner ===

/**
 * Build the effective system prompt for a subagent by appending cwd,
 * project instructions (AGENT.md / CLAUDE.md), and language instruction,
 * mirroring the parent narrator's buildSystemPrompt() logic.
 */
async function buildSubagentSystemPrompt(
	subagentType: SubagentType,
	cwd: string,
	locale: Locale,
): Promise<string> {
	let prompt = getSubagentPrompt(subagentType, locale);

	// Inject current working directory
	prompt += `\n\n## Current Working Directory\n\n\`${cwd}\`\n\nAll tools (Bash, Read, Write, Edit, Glob, Grep) already use this as their default working directory. Do NOT \`cd\` into it in Bash commands — it is redundant.`;

	// Inject AGENT.md (fallback to CLAUDE.md) if present
	for (const filename of ["AGENT.md", "CLAUDE.md"]) {
		try {
			const content = await readFile(join(cwd, filename), "utf-8");
			prompt += `\n\n## Project Instructions\n\n${content}`;
			break;
		} catch {
			// file not found, try next
		}
	}

	// Append language instruction
	prompt += `\n\n## Language\n\n${getReplyLanguageInstruction(locale)}`;

	return prompt;
}

export interface RunSubagentInput {
	parentNarratorId: string;
	toolUseId: string;
	subagentType: "explore" | "plan" | "general";
	prompt: string;
	cwd: string;
	signal: AbortSignal;
	locale: string;
	model?: string;
}

/**
 * Run a subagent synchronously (from the parent narrator's perspective).
 * Creates a subagent narrator, runs the agent loop, persists all messages,
 * and returns the final text result.
 */
export async function runSubagent(input: RunSubagentInput): Promise<string> {
	const {
		parentNarratorId,
		toolUseId,
		subagentType,
		prompt,
		cwd,
		signal,
		locale,
		model: explicitModel,
	} = input;

	// Build effective system prompt with cwd, project instructions, and language
	const systemPrompt = await buildSubagentSystemPrompt(subagentType, cwd, locale as Locale);

	// Resolve model: explicit param > per-type setting > parent model > global default
	const subagentPref =
		subagentType !== "general" ? settings.agent.subagentModels?.[subagentType] : undefined;

	// 1. Create subagent narrator
	const subagent = await narratorService.createSubagent({
		parentNarratorId,
		subagentType,
		cwd,
		systemPrompt,
		model: explicitModel || subagentPref || undefined,
	});

	const subagentId = subagent.id;

	// 2. Broadcast subagent_started
	eventBus.emit({
		type: "narrator:subagent_started",
		narratorId: subagentId,
		parentNarratorId,
		toolUseId,
		subagentType,
	});
	broadcastToNarrator(parentNarratorId, {
		type: "subagent_started",
		narratorId: parentNarratorId,
		subagentNarratorId: subagentId,
		toolUseId,
		subagentType,
	});

	// 3. Persist subagent's user message (linked to parent's tool_use)
	await narratorService.persistSubagentUserMessage(subagentId, prompt, toolUseId);

	// 4. Build AgentConfig
	const model = subagent.model ?? settings.agent.defaultModel;
	const provider = resolveProvider(model);
	const conversationId = randomUUID();

	// Build subagent-specific permission handler:
	// - DB queries use subagentId (tool calls are stored under the subagent)
	// - WS broadcasts go to parentNarratorId (frontend subscribes to parent)
	const permissionHandler = (
		toolName: string,
		permInput: Record<string, unknown>,
		permToolUseId: string,
	) =>
		handlePermission(
			subagentId,
			signal,
			toolName,
			permInput,
			permToolUseId,
			cwd,
			locale as Locale,
			parentNarratorId,
		);

	const config: AgentConfig = {
		narratorId: subagentId,
		conversationId,
		model,
		provider,
		cwd,
		systemPrompt,
		locale,
		signal,
		// Use global maxTurns (same as normal narrators); no separate subagent limit
		toolFilter: TOOL_FILTERS[subagentType],
		permissionHandler,
	};

	// 5. Run agent loop and collect events
	let finalText = "";
	let hasError = false;

	try {
		for await (const event of agentLoop(config, prompt, [])) {
			if (signal.aborted) break;
			await processSubagentEvent(event, subagentId, parentNarratorId, toolUseId, model);

			if (event.type === "assistant_message") {
				finalText = event.text || "";
			}
			if (event.type === "error") {
				if (event.message !== "Aborted") {
					finalText = `Error: ${event.message}`;
					hasError = true;
				}
				break;
			}
		}
	} finally {
		// 6. Mark subagent as done (or error)
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({
				status: hasError ? "error" : "done",
				errorMessage: hasError ? finalText : null,
				updatedAt: now,
			})
			.where(eq(narrators.id, subagentId));

		eventBus.emit({
			type: "narrator:subagent_completed",
			narratorId: subagentId,
			parentNarratorId,
			toolUseId,
		});
	}

	// 7. Return result text
	const resultPrefix = `<subagent_id>${subagentId}</subagent_id>\n\n`;
	return resultPrefix + (finalText || "(no output)");
}

/**
 * Process a single agent event from the subagent loop.
 * Persists messages and broadcasts events to the parent narrator's WS subscribers.
 */
async function processSubagentEvent(
	event: AgentEvent,
	subagentId: string,
	parentNarratorId: string,
	parentToolUseId: string,
	subagentModel: string,
): Promise<void> {
	switch (event.type) {
		case "stream_text": {
			broadcastToNarrator(parentNarratorId, {
				type: "stream_event",
				narratorId: parentNarratorId,
				event: {
					type: "content_block_delta",
					delta: { type: "text_delta", text: event.text },
					subagentToolUseId: parentToolUseId,
					subagentNarratorId: subagentId,
				},
			});
			break;
		}

		case "assistant_message": {
			// Build content blocks
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			const content: any[] = [];
			if (event.text) content.push({ type: "text", text: event.text });
			for (const tu of event.toolUses) {
				content.push({ type: "tool_use", id: tu.toolUseId, name: tu.name, input: tu.input });
			}

			const saved = await narratorService.persistAssistantMessage(subagentId, {
				uuid: event.messageId ?? randomUUID(),
				session_id: "",
				parent_tool_use_id: parentToolUseId,
				message: { content },
			});

			// Broadcast the full message to parent narrator's subscribers
			const fullMessage = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, saved.id),
				with: { toolCalls: true },
			});
			broadcastToNarrator(parentNarratorId, {
				type: "message",
				narratorId: parentNarratorId,
				message: fullMessage ? { ...fullMessage, subagentModel } : fullMessage,
			});
			break;
		}

		case "tool_call": {
			broadcastToNarrator(parentNarratorId, {
				type: "tool_started",
				narratorId: parentNarratorId,
				toolUseId: event.toolUseId,
				toolName: event.toolName,
				input: event.input,
			});
			break;
		}

		case "tool_result": {
			try {
				await narratorService.updateToolCallResult(event.toolUseId, {
					output: event.output,
					status: event.isError ? "fail" : "success",
					errorMessage: event.isError ? event.output : undefined,
					durationMs: event.durationMs,
				});
			} catch (err) {
				logger.error("Failed to persist subagent tool result", {
					subagentId,
					toolUseId: event.toolUseId,
					error: String(err),
				});
			}

			broadcastToNarrator(parentNarratorId, {
				type: "tool_completed",
				narratorId: parentNarratorId,
				toolUseId: event.toolUseId,
				status: event.isError ? "fail" : "success",
				output: event.output,
				durationMs: event.durationMs,
			});
			break;
		}

		case "error": {
			if (event.message !== "Aborted") {
				logger.error("Subagent error", { subagentId, parentNarratorId, error: event.message });
			}
			break;
		}

		default:
			break;
	}
}
