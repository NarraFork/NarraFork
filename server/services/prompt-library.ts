/**
 * The prompt library: reusable prompt fragments a user can pull into a project
 * prompt (AGENTS.md) from the composer's editor.
 *
 * ── STORAGE ───────────────────────────────────────────────────────────────────
 * One markdown file per prompt under `~/.narrafork/prompt-library/<id>.md`, with
 * frontmatter carrying the metadata and the body holding the prompt itself. This
 * follows the convention the routines module already uses for custom subagents
 * (`custom-subagent-service.ts`), and buys three things a DB column would not:
 *
 *  - a prompt stays a diffable, greppable file the user can back up or hand-edit;
 *  - no schema migration for a feature whose shape may still move;
 *  - the body never has to be JSON-escaped, so a multi-line markdown prompt is
 *    stored exactly as written.
 *
 * ── WHY THE CAP MATCHES `createNarrator` ─────────────────────────────────────
 * `createNarratorSchema.systemPrompt` is capped at 10 000 characters, and a library
 * entry exists only to be copied into that field. Allowing a longer prompt here would
 * let a user build an entry that their own narrator creation then refuses — the
 * failure would arrive at the last step, with the text already written.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { narraforkDir } from "../lib/settings";

export interface PromptLibraryEntry {
	id: string;
	name: string;
	/** Optional one-line summary shown in lists. */
	description: string;
	/** The prompt text itself (the file body). */
	content: string;
	createdAt: string;
	updatedAt: string;
}

export interface PromptLibraryInput {
	name: string;
	description?: string;
	content: string;
}

/** Mirrors `createNarratorSchema.systemPrompt.max(10000)`. */
export const MAX_PROMPT_CHARS = 10_000;
export const MAX_PROMPT_NAME_CHARS = 100;
export const MAX_PROMPT_DESCRIPTION_CHARS = 500;

const PROMPTS_DIR = join(narraforkDir, "prompt-library");

/**
 * Ids are generated here and never taken from the client, so a request cannot name a
 * path. They are also used as filenames, which is why the allow-list is narrow:
 * `generateId` yields `[A-Za-z0-9]` only, so no separator or dot can appear.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

function promptPath(id: string): string {
	if (!ID_PATTERN.test(id)) throw new ValidationError("Invalid prompt id");
	return join(PROMPTS_DIR, `${id}.md`);
}

function normalizeInput(input: PromptLibraryInput): PromptLibraryInput {
	const name = input.name?.trim() ?? "";
	if (!name) throw new ValidationError("name is required");
	if (name.length > MAX_PROMPT_NAME_CHARS) {
		throw new ValidationError(`name must be at most ${MAX_PROMPT_NAME_CHARS} characters`);
	}
	const description = input.description?.trim() ?? "";
	if (description.length > MAX_PROMPT_DESCRIPTION_CHARS) {
		throw new ValidationError(
			`description must be at most ${MAX_PROMPT_DESCRIPTION_CHARS} characters`,
		);
	}
	// The body is NOT trimmed: leading blank lines and trailing newlines are part of the
	// prompt the user wrote, and a "helpful" trim would silently change its formatting.
	const content = input.content ?? "";
	if (!content.trim()) throw new ValidationError("content is required");
	if (content.length > MAX_PROMPT_CHARS) {
		throw new ValidationError(`content must be at most ${MAX_PROMPT_CHARS} characters`);
	}
	return { name, description, content };
}

/** Parse one file. A malformed file is skipped by the caller rather than fatal. */
function parseFile(id: string, raw: string): PromptLibraryEntry | null {
	let parsed: matter.GrayMatterFile<string>;
	try {
		parsed = matter(raw);
	} catch {
		return null;
	}
	const data = parsed.data as Record<string, unknown>;
	const name = typeof data.name === "string" ? data.name.trim() : "";
	if (!name) return null;
	const createdAt = typeof data.createdAt === "string" ? data.createdAt : "";
	const updatedAt = typeof data.updatedAt === "string" ? data.updatedAt : createdAt;
	return {
		id,
		name,
		description: typeof data.description === "string" ? data.description : "",
		content: parsed.content,
		createdAt,
		updatedAt,
	};
}

function serialize(entry: PromptLibraryEntry): string {
	// gray-matter escapes the values itself, so a name containing a colon or quote cannot
	// break the frontmatter block.
	return matter.stringify(entry.content, {
		name: entry.name,
		description: entry.description,
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
	});
}

export class PromptLibraryService {
	async list(): Promise<PromptLibraryEntry[]> {
		let files: string[];
		try {
			files = await readdir(PROMPTS_DIR);
		} catch {
			// A library nobody has written to yet is empty, not an error.
			return [];
		}
		const entries: PromptLibraryEntry[] = [];
		for (const file of files) {
			if (!file.endsWith(".md")) continue;
			const id = file.slice(0, -3);
			if (!ID_PATTERN.test(id)) continue;
			try {
				const entry = parseFile(id, await readFile(join(PROMPTS_DIR, file), "utf-8"));
				if (entry) entries.push(entry);
			} catch (error) {
				// One unreadable file must not take the whole library down.
				logger.warn("Skipping unreadable system prompt", { id, error: String(error) });
			}
		}
		// Newest first: the entry a user just created is the one they are looking for.
		return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async get(id: string): Promise<PromptLibraryEntry> {
		const path = promptPath(id);
		let raw: string;
		try {
			raw = await readFile(path, "utf-8");
		} catch {
			throw new NotFoundError("SystemPrompt", id);
		}
		const entry = parseFile(id, raw);
		if (!entry) throw new AppError("The prompt file is malformed", 500, "PROMPT_MALFORMED");
		return entry;
	}

	/** Names must be distinguishable, so uniqueness is enforced case-insensitively. */
	private async assertNameAvailable(name: string, exceptId?: string): Promise<void> {
		const folded = name.toLocaleLowerCase();
		for (const entry of await this.list()) {
			if (entry.id === exceptId) continue;
			if (entry.name.toLocaleLowerCase() === folded) {
				throw new ValidationError(`A prompt named "${name}" already exists`);
			}
		}
	}

	async create(input: PromptLibraryInput): Promise<PromptLibraryEntry> {
		const normalized = normalizeInput(input);
		await this.assertNameAvailable(normalized.name);
		const now = new Date().toISOString();
		const entry: PromptLibraryEntry = {
			id: generateId(),
			name: normalized.name,
			description: normalized.description ?? "",
			content: normalized.content,
			createdAt: now,
			updatedAt: now,
		};
		await mkdir(PROMPTS_DIR, { recursive: true });
		await writeFile(promptPath(entry.id), serialize(entry), "utf-8");
		return entry;
	}

	async update(id: string, input: PromptLibraryInput): Promise<PromptLibraryEntry> {
		const existing = await this.get(id);
		const normalized = normalizeInput(input);
		await this.assertNameAvailable(normalized.name, id);
		const entry: PromptLibraryEntry = {
			...existing,
			name: normalized.name,
			description: normalized.description ?? "",
			content: normalized.content,
			updatedAt: new Date().toISOString(),
		};
		await writeFile(promptPath(id), serialize(entry), "utf-8");
		return entry;
	}

	async remove(id: string): Promise<void> {
		// Validates the id shape before it ever reaches the filesystem.
		const path = promptPath(id);
		try {
			await rm(path);
		} catch {
			throw new NotFoundError("SystemPrompt", id);
		}
	}
}

export const promptLibrary = new PromptLibraryService();
