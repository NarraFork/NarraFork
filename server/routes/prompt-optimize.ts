/**
 * Prompt optimization for text that has NO session yet.
 *
 * Why a separate group rather than one more route on `narratorRoutes`: that router
 * resolves `:id` for every sub-path it serves, so any single-segment POST there is
 * read as a narrator id and answered with "Narrator not found". Splitting the group
 * says what is actually true — nothing about this call is narrator-scoped: it
 * authorizes on the logged-in user, reads no session state, and attaches no
 * conversation context.
 */

import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import { getUserLanguage } from "../lib/i18n";
import { runPromptOptimize } from "../lib/prompts/prompt-optimize-run";
import { optimizeDraftPromptSchema } from "../lib/validators/narrators";

export const promptOptimizeRoutes = new Hono();

/**
 * POST /api/prompt-optimize/draft
 *
 * The composer's ✨ button for a draft prompt stored in a FILE (the new-session
 * dialog's project-prompt box). Same styles and same optimize model as the
 * narrator-scoped route, served from the same `runPromptOptimize`, so the two can
 * never disagree about what "optimized" means.
 */
promptOptimizeRoutes.post("/draft", async (c) => {
	const userId = c.get("user").sub;
	// `withContext`/`messageId` are absent from this schema on purpose: there is no
	// session, so a request asking for context would otherwise look honored.
	const parsed = optimizeDraftPromptSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) {
		// `parse` would throw a raw ZodError, which the app's error serializer does not
		// know and would report as a 500 — a malformed body is the caller's fault.
		throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid request body");
	}
	const { text, style } = parsed.data;
	const locale = await getUserLanguage(userId);
	const result = await runPromptOptimize({
		text,
		style,
		locale,
		userId,
		signal: c.req.raw.signal,
	});
	return c.json(result);
});
