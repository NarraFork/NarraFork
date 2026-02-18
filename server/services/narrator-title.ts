import { agentGenerate } from "../lib/agent";
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
export async function persistTitle(narratorId: string, title: string): Promise<boolean> {
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
 */
export async function generateTitle(narratorId: string, locale: Locale = "en"): Promise<string> {
	const HEAD_COUNT = 2;
	const TAIL_COUNT = 4;

	// Two targeted queries with SQL-level filtering (no over-fetch)
	const [head, tail] = await Promise.all([
		narratorService.getEarliestMessages(narratorId, HEAD_COUNT),
		narratorService.getRecentMessages(narratorId, TAIL_COUNT),
	]);

	// Deduplicate: remove tail messages already in head (short conversations)
	const headIds = new Set(head.map((m) => m.id));
	const uniqueTail = tail.filter((m) => !headIds.has(m.id));
	const selected = [...head, ...uniqueTail];

	if (selected.length === 0) return "New conversation";

	const conversationText = selected
		.map((m, i) => {
			const role = m.role === "assistant" ? "Assistant" : "User";
			const text = m.contentText!;
			const maxLen = i >= head.length ? 600 : 300;
			const truncated = text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
			const section = i >= head.length ? "(recent) " : "";
			return `${section}[${role}]: ${truncated}`;
		})
		.join("\n\n");

	const titlePrompt = getPrompt("title", locale);

	logger.info("Title generation starting", {
		narratorId,
		model: settings.agent.summaryModel,
		locale,
	});

	const TITLE_TIMEOUT_MS = 30_000;
	const titlePromise = agentGenerate(
		`${titlePrompt}${conversationText}\n</conversation>`,
		settings.agent.summaryModel,
	);

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
	try {
		const truncated = userMessage.length > 500 ? `${userMessage.slice(0, 500)}...` : userMessage;
		const titlePrompt = getPrompt("quickTitle", locale);
		const prompt = `${titlePrompt}${truncated}\n</user_message>`;

		logger.info("Quick title generation starting", {
			narratorId,
			model: settings.agent.summaryModel,
			locale,
		});

		const TITLE_TIMEOUT_MS = 30_000;
		const titlePromise = agentGenerate(prompt, settings.agent.summaryModel);

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
	try {
		const title = await generateTitle(narratorId, locale);
		await persistTitle(narratorId, title);

		logger.info("Narrator title auto-generated", { narratorId, title });
	} catch (err) {
		logger.error("Failed to auto-generate narrator title", {
			narratorId,
			error: String(err),
		});
	}
}
