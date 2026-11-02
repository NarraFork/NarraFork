/**
 * `/api/prompt-library` — reusable prompts a user pulls into a project prompt.
 *
 * Requires only a login, and is NOT admin-gated: the files live in the instance's own
 * data directory and hold prompts the user wrote for themselves. The name "library"
 * is deliberate — whatever a project prompt takes from an entry is a text copy in
 * AGENTS.md, so deleting an entry never edits an existing file. That is what makes the
 * delete semantics simple and safe: the library is a set of templates, not a foreign key.
 */

import { Hono } from "hono";
import { summaryGenerate } from "../lib/agent";
import { ValidationError } from "../lib/errors";
import { getUserLanguage } from "../lib/i18n";
import { requireAuth } from "../middleware/auth";
import { promptLibrary } from "../services/prompt-library";

export const promptLibraryRoutes = new Hono();

promptLibraryRoutes.use("/*", requireAuth);

/** Mirrors `MAX_PROMPT_CHARS` in the service; a summary request is not a store operation. */
const MAX_CONTENT_CHARS = 10_000;

/**
 * The instruction is localized because the summary is shown as the entry's description
 * to whoever wrote the prompt — the same rule the rest of the app follows for
 * model-generated UI text (see `getUserLanguage`).
 */
function buildSummarizeInstruction(locale: string): string {
	if (locale.startsWith("zh")) {
		return [
			"你是提示词库的整理助手。用户会给你一段提示词正文。",
			"请写一句中文描述，说明这段提示词让模型做什么、适用于什么场景。",
			"要求：只输出这一句话本身，不超过 60 个汉字；不要加引号、标题、项目符号或任何前后缀；",
			"不要复述原文措辞，不要评价好坏，不要提及这是提示词。",
		].join("");
	}
	return [
		"You maintain a library of reusable prompts. The user sends you the body of one prompt. ",
		"Write a single sentence describing what the prompt makes a model do and when to use it. ",
		"Output only that sentence, at most 140 characters, with no quotes, heading, bullet, ",
		"prefix or suffix. Do not echo the original wording, do not judge quality, and do not ",
		"refer to it as a prompt.",
	].join("");
}

function parseBody(raw: unknown): {
	name: string;
	description?: string;
	content: string;
} {
	const body = (raw ?? {}) as { name?: unknown; description?: unknown; content?: unknown };
	if (typeof body.name !== "string" || typeof body.content !== "string") {
		throw new ValidationError("name and content are required");
	}
	if (body.description !== undefined && typeof body.description !== "string") {
		throw new ValidationError("description must be a string");
	}
	return {
		name: body.name,
		description: body.description,
		content: body.content,
	};
}

/** GET /api/prompt-library — every entry, newest updated first. */
promptLibraryRoutes.get("/", async (c) => {
	return c.json(await promptLibrary.list());
});

/**
 * POST /api/prompt-library/summarize — one-line description for a prompt body.
 *
 * Deliberately stateless: it takes text, not an id, so the composer can summarize a
 * draft that was never saved. The summary model is the same one the rest of the app
 * uses for auxiliary text (`summaryGenerate`), so it follows `agent.summaryModel`
 * including `__summary__`.
 *
 * Registered BEFORE `/:id` — Hono matches in order, and "summarize" would otherwise be
 * read as an entry id and answered with 404.
 */
promptLibraryRoutes.post("/summarize", async (c) => {
	const body = (await c.req.json().catch(() => null)) as { content?: unknown } | null;
	if (typeof body?.content !== "string") {
		throw new ValidationError("content is required");
	}
	const content = body.content;
	if (!content.trim()) throw new ValidationError("content is required");
	if (content.length > MAX_CONTENT_CHARS) {
		throw new ValidationError(`content must be at most ${MAX_CONTENT_CHARS} characters`);
	}
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const result = await summaryGenerate(
		content,
		buildSummarizeInstruction(locale),
		{ userId, kind: "internal" },
		c.req.raw.signal,
	);
	return c.json({ summary: result.text.trim() });
});

/** GET /api/prompt-library/:id — one entry, including its full content. */
promptLibraryRoutes.get("/:id", async (c) => {
	return c.json(await promptLibrary.get(c.req.param("id")));
});

/** POST /api/prompt-library — create one entry. */
promptLibraryRoutes.post("/", async (c) => {
	const input = parseBody(await c.req.json().catch(() => null));
	return c.json(await promptLibrary.create(input), 201);
});

/** PUT /api/prompt-library/:id — replace name/description/content. */
promptLibraryRoutes.put("/:id", async (c) => {
	const id = c.req.param("id");
	const input = parseBody(await c.req.json().catch(() => null));
	return c.json(await promptLibrary.update(id, input));
});

/**
 * DELETE /api/prompt-library/:id — remove one entry.
 *
 * Allowed even while narrators exist whose `systemPrompt` matches this text: they
 * already hold their own copy, so deleting the template changes nothing about them.
 * The client asks for confirmation first, and says so in the dialog.
 */
promptLibraryRoutes.delete("/:id", async (c) => {
	await promptLibrary.remove(c.req.param("id"));
	return c.json({ ok: true });
});
