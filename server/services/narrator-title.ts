import { query } from "@anthropic-ai/claude-agent-sdk";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { getPrompt, type Locale } from "../lib/prompt-i18n";
import { settings } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { narratorService } from "./narrator-service";

/**
 * Persist a generated title to DB and broadcast. Isolated so both quick and
 * full title flows share the same error handling / retry path.
 */
async function persistTitle(narratorId: string, title: string): Promise<boolean> {
	try {
		await narratorService.updateTitle(narratorId, title);
		broadcastToNarrator(narratorId, { type: "title_updated", narratorId, title });
		eventBus.emit({ type: "narrator:title_updated", narratorId, title });
		return true;
	} catch (err) {
		logger.error("Failed to persist title after retries", {
			narratorId,
			title,
			error: String(err),
		});
		return false;
	}
}

/**
 * Generate a title for a narrator session using the summary model.
 * Uses Claude Agent SDK query() — same pattern as narrator-context.ts.
 */
export async function generateTitle(
	narratorId: string,
	stderrChunks: string[],
	locale: Locale = "en",
): Promise<string> {
	const messages = await narratorService.getMessages(narratorId, 4);
	if (messages.length === 0) return "New conversation";

	const conversationText = messages
		.map((m) => {
			const role = m.role === "assistant" ? "Assistant" : "User";
			const text = m.contentText || JSON.stringify(m.contentJson);
			const truncated = text.length > 500 ? `${text.slice(0, 500)}...` : text;
			return `[${role}]: ${truncated}`;
		})
		.join("\n\n");

	const titlePrompt = getPrompt("title", locale);

	logger.info("Title generation starting", {
		narratorId,
		model: settings.agent.summaryModel,
		locale,
	});

	// Wrap query() with a timeout — SDK can hang indefinitely
	const TITLE_TIMEOUT_MS = 30_000;
	const titlePromise = (async () => {
		const titleQuery = query({
			prompt: titlePrompt + conversationText,
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
		return title;
	})();

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutHandle = setTimeout(
			() => reject(new Error("Title generation timed out")),
			TITLE_TIMEOUT_MS,
		);
	});

	let title: string;
	try {
		title = await Promise.race([titlePromise, timeoutPromise]);
	} finally {
		clearTimeout(timeoutHandle);
	}

	// Clean up: remove surrounding quotes if present
	title = title.trim().replace(/^["'""]+|["'""]+$/g, "");
	logger.info("Title generation completed", { narratorId, title });
	return title || "New conversation";
}

/**
 * Generate a quick title from just the user message (before AI replies).
 * Fire-and-forget — errors are logged, not thrown.
 */
export async function generateQuickTitle(
	narratorId: string,
	userMessage: string,
	locale: Locale = "en",
): Promise<void> {
	const stderrChunks: string[] = [];
	try {
		const truncated = userMessage.length > 500 ? `${userMessage.slice(0, 500)}...` : userMessage;
		const titlePrompt = getPrompt("title", locale);
		const prompt = `${titlePrompt}[User]: ${truncated}`;

		logger.info("Quick title generation starting", {
			narratorId,
			model: settings.agent.summaryModel,
			locale,
		});

		const TITLE_TIMEOUT_MS = 30_000;
		const titlePromise = (async () => {
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
			return title;
		})();

		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutHandle = setTimeout(
				() => reject(new Error("Quick title generation timed out")),
				TITLE_TIMEOUT_MS,
			);
		});

		let title: string;
		try {
			title = await Promise.race([titlePromise, timeoutPromise]);
		} finally {
			clearTimeout(timeoutHandle);
		}

		title = title.trim().replace(/^["'""]+|["'""]+$/g, "");
		title = title || "New conversation";

		await persistTitle(narratorId, title);
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
export async function generateAndSetTitle(
	narratorId: string,
	locale: Locale = "en",
): Promise<void> {
	const stderrChunks: string[] = [];
	try {
		const title = await generateTitle(narratorId, stderrChunks, locale);
		await persistTitle(narratorId, title);

		logger.info("Narrator title auto-generated", { narratorId, title });
	} catch (err) {
		logger.error("Failed to auto-generate narrator title", {
			narratorId,
			error: String(err),
			stderr: stderrChunks.join(""),
		});
	}
}
