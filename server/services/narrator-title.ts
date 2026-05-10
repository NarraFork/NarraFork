import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators } from "../db/schema";
import { summaryGenerateWithHistory } from "../lib/agent";
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

		// Sync to chapter.title for chapter-bound narrators
		await syncTitleToChapter(narratorId, title);

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
 * Sync narrator title to the bound chapter's title.
 * Only applies to chapter-bound primary narrators.
 */
async function syncTitleToChapter(narratorId: string, title: string): Promise<void> {
	try {
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { chapterId: true, type: true },
		});
		if (!narrator?.chapterId || narrator.type !== "primary") return;

		// Skip if chapter title is already identical
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, narrator.chapterId),
			columns: { title: true },
		});
		if (chapter?.title === title) return;

		const now = new Date().toISOString();
		await db
			.update(chapters)
			.set({ title, updatedAt: now })
			.where(eq(chapters.id, narrator.chapterId));
	} catch (err) {
		logger.warn("Failed to sync title to chapter (non-fatal)", {
			narratorId,
			title,
			error: String(err),
		});
	}
}

/**
 * Sync chapter title to the bound primary narrator's title.
 * Called when chapter.title is updated directly.
 */
export async function syncTitleToNarrator(chapterId: string, title: string): Promise<void> {
	try {
		const primaryNarrator = await db.query.narrators.findFirst({
			where: and(eq(narrators.chapterId, chapterId), eq(narrators.variant, "primary")),
			columns: { id: true, title: true },
		});
		if (!primaryNarrator) return;
		if (primaryNarrator.title === title) return; // already in sync

		// Directly update DB instead of going through narratorService.updateTitle /
		// persistTitle to avoid a circular sync loop (persistTitle → syncTitleToChapter
		// → back here).  The broadcast + eventBus emit below mirror what persistTitle does.
		const now = new Date().toISOString();
		await db
			.update(narrators)
			.set({ title, updatedAt: now })
			.where(eq(narrators.id, primaryNarrator.id));
		broadcastToNarrator(primaryNarrator.id, {
			type: "title_updated",
			narratorId: primaryNarrator.id,
			title,
		});
		eventBus.emit({
			type: "narrator:title_updated",
			narratorId: primaryNarrator.id,
			title,
		});
	} catch (err) {
		logger.warn("Failed to sync title to narrator (non-fatal)", {
			chapterId,
			title,
			error: String(err),
		});
	}
}

/**
 * Generate a title for a narrator session using the summary model.
 */
export async function generateTitle(narratorId: string, locale: Locale = "en"): Promise<string> {
	const HEAD_COUNT = 1;
	const TAIL_COUNT = 6;

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
			const text = m.contentText ?? "";
			const isRecent = i >= head.length;
			const maxLen = isRecent ? 800 : 200;
			const truncated = text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
			const section = isRecent ? "(recent) " : "(early) ";
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
	const titlePromise = summaryGenerateWithHistory(
		titlePrompt.replace(/<conversation>\s*$/, "").trim(),
		`<conversation>\n${conversationText}\n</conversation>`,
		locale,
		{ narratorId, kind: "title" },
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
	// Guard: if model returned something too long, it's not a valid title
	if (title.length > 80) {
		title = title.slice(0, 50);
	}
	logger.info("Title generation completed", { narratorId, title });
	return title || "New conversation";
}

function buildProvisionalTitle(userMessage: string): string | null {
	const normalized = userMessage.replace(/\s+/g, " ").trim();
	if (!normalized) return null;

	const firstSentence = normalized.match(/^.+?[。！？.!?](?:\s|$)/u)?.[0].trim() ?? normalized;
	const chars = Array.from(firstSentence);
	if (chars.length <= 50) return firstSentence;
	return `${chars.slice(0, 49).join("")}…`;
}

/**
 * Persist an immediate placeholder title from the user's first message.
 * This fills the UI gap while the summary model is still producing a better title.
 */
export async function setProvisionalTitleFromUserMessage(
	narratorId: string,
	userMessage: string,
): Promise<string | null> {
	const title = buildProvisionalTitle(userMessage);
	if (!title) return null;

	const persisted = await persistTitle(narratorId, title);
	if (!persisted) return null;
	logger.info("Provisional title set from first user message", { narratorId, title });
	return title;
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

		logger.info("Quick title generation starting", {
			narratorId,
			model: settings.agent.summaryModel,
			locale,
		});

		const TITLE_TIMEOUT_MS = 30_000;
		const titlePromise = summaryGenerateWithHistory(
			titlePrompt.replace(/<user_message>\s*$/, "").trim(),
			`<user_message>\n${truncated}\n</user_message>`,
			locale,
			{ narratorId, kind: "title" },
		);

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
		if (title.length > 80) {
			title = title.slice(0, 50);
		}
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
