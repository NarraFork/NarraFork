import { query } from "@anthropic-ai/claude-agent-sdk";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { narratorService } from "./narrator-service";

const TITLE_PROMPT = `Based on the following conversation opening, generate a short descriptive title (max 50 characters). Use the same language as the conversation. Reply with ONLY the title text, no quotes, no punctuation wrapping, no explanation.

Conversation:
`;

/**
 * Generate a title for a narrator session using the summary model.
 * Uses Claude Agent SDK query() — same pattern as narrator-context.ts.
 */
export async function generateTitle(narratorId: string, stderrChunks: string[]): Promise<string> {
	const messages = await narratorService.getMessages(narratorId, 4);
	if (messages.length === 0) return "New conversation";

	const conversationText = messages
		.map((m) => {
			const role = m.role === "assistant" ? "Assistant" : "User";
			const text = m.contentText || JSON.stringify(m.contentJson);
			// Truncate long messages to keep prompt small
			const truncated = text.length > 500 ? `${text.slice(0, 500)}...` : text;
			return `[${role}]: ${truncated}`;
		})
		.join("\n\n");

	logger.info("Title generation starting", {
		narratorId,
		model: settings.agent.summaryModel,
	});

	const titleQuery = query({
		prompt: TITLE_PROMPT + conversationText,
		options: {
			model: settings.agent.summaryModel,
			maxTurns: 1,
			tools: [],
			permissionMode: "dontAsk",
			settingSources: ["user"],
			stderr: (data: string) => {
				stderrChunks.push(data);
			},
		},
	});

	let title = "";
	for await (const message of titleQuery) {
		if (message.type === "assistant") {
			for (const block of message.message.content) {
				if (block.type === "text") {
					title += block.text;
				}
			}
		}
	}

	// Clean up: remove surrounding quotes if present
	title = title.trim().replace(/^["'""]+|["'""]+$/g, "");
	return title || "New conversation";
}

/**
 * Generate a quick title from just the user message (before AI replies).
 * Fire-and-forget — errors are logged, not thrown.
 */
export async function generateQuickTitle(narratorId: string, userMessage: string): Promise<void> {
	const stderrChunks: string[] = [];
	try {
		const truncated = userMessage.length > 500 ? `${userMessage.slice(0, 500)}...` : userMessage;
		const prompt = `${TITLE_PROMPT}[User]: ${truncated}`;

		logger.info("Quick title generation starting", {
			narratorId,
			model: settings.agent.summaryModel,
		});

		const titleQuery = query({
			prompt,
			options: {
				model: settings.agent.summaryModel,
				maxTurns: 1,
				tools: [],
				permissionMode: "dontAsk",
				settingSources: ["user"],
				stderr: (data: string) => {
					stderrChunks.push(data);
				},
			},
		});

		let title = "";
		for await (const message of titleQuery) {
			if (message.type === "assistant") {
				for (const block of message.message.content) {
					if (block.type === "text") {
						title += block.text;
					}
				}
			}
		}

		title = title.trim().replace(/^["'""]+|["'""]+$/g, "");
		title = title || "New conversation";

		await narratorService.updateTitle(narratorId, title);
		broadcastToNarrator(narratorId, { type: "title_updated", narratorId, title });
		eventBus.emit({ type: "narrator:title_updated", narratorId, title });
		logger.info("Quick title auto-generated", { narratorId, title });
	} catch (err) {
		logger.error("Failed to generate quick title", {
			narratorId,
			error: String(err),
			stderr: stderrChunks.join(""),
		});
	}
}

/**
 * Generate a title and persist it. Fire-and-forget — errors are logged, not thrown.
 * Also broadcasts the title update via WebSocket and event bus.
 */
export async function generateAndSetTitle(narratorId: string): Promise<void> {
	const stderrChunks: string[] = [];
	try {
		const title = await generateTitle(narratorId, stderrChunks);
		await narratorService.updateTitle(narratorId, title);

		broadcastToNarrator(narratorId, {
			type: "title_updated",
			narratorId,
			title,
		});

		eventBus.emit({ type: "narrator:title_updated", narratorId, title });

		logger.info("Narrator title auto-generated", { narratorId, title });
	} catch (err) {
		logger.error("Failed to auto-generate narrator title", {
			narratorId,
			error: String(err),
			stderr: stderrChunks.join(""),
		});
	}
}
