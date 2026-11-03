/**
 * Prompt library service.
 *
 * `PROMPTS_DIR` is resolved from `NARRAFORK_HOME` at module load, so each test file points
 * the home at a fresh temp dir and only then imports the service. Importing at the top
 * level would bind the developer's real `~/.narrafork`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Service = typeof import("../prompt-library");

let home: string;
let mod: Service;

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "narrafork-prompt-lib-"));
	process.env.NARRAFORK_HOME = home;
	mod = await import("../prompt-library");
});

afterAll(() => {
	delete process.env.NARRAFORK_HOME;
	rmSync(home, { recursive: true, force: true });
});

describe("prompt library", () => {
	test("an untouched library lists as empty rather than failing", async () => {
		await expect(mod.promptLibrary.list()).resolves.toEqual([]);
	});

	test("create round-trips through markdown + frontmatter", async () => {
		const created = await mod.promptLibrary.create({
			name: "Code reviewer",
			description: "Strict review stance",
			content: "You review code.\n",
		});

		expect(created.id).toBeTruthy();
		expect(created.content).toBe("You review code.\n");

		const fetched = await mod.promptLibrary.get(created.id);
		expect(fetched.name).toBe("Code reviewer");
		expect(fetched.description).toBe("Strict review stance");
		expect(fetched.content).toBe("You review code.\n");
		expect(fetched.createdAt).toBeTruthy();
	});

	test("content is stored verbatim — surrounding whitespace is not trimmed", async () => {
		const content = "\n\n  indented first line\n\ttabbed\n\n";
		const created = await mod.promptLibrary.create({ name: "Whitespace", content });
		const fetched = await mod.promptLibrary.get(created.id);
		expect(fetched.content).toBe(content);
	});

	test("names are unique case-insensitively", async () => {
		await mod.promptLibrary.create({ name: "Reviewer", content: "a" });
		await expect(mod.promptLibrary.create({ name: "  reviewer  ", content: "b" })).rejects.toThrow(
			/already exists/,
		);
	});

	test("renaming to its own name is allowed", async () => {
		const created = await mod.promptLibrary.create({ name: "Self rename", content: "a" });
		const updated = await mod.promptLibrary.update(created.id, {
			name: "Self rename",
			content: "b",
		});
		expect(updated.content).toBe("b");
		expect(updated.createdAt).toBe(created.createdAt);
	});

	test("rejects blank name, blank content, and oversized input", async () => {
		await expect(mod.promptLibrary.create({ name: "   ", content: "a" })).rejects.toThrow(/name/);
		await expect(mod.promptLibrary.create({ name: "x", content: "   " })).rejects.toThrow(
			/content/,
		);
		await expect(
			mod.promptLibrary.create({
				name: "x".repeat(mod.MAX_PROMPT_NAME_CHARS + 1),
				content: "a",
			}),
		).rejects.toThrow(/name/);
		await expect(
			mod.promptLibrary.create({
				name: "big",
				content: "a".repeat(mod.MAX_PROMPT_CHARS + 1),
			}),
		).rejects.toThrow(/content/);
	});

	test("a path-shaped id is refused instead of touching the filesystem", async () => {
		await expect(mod.promptLibrary.get("../../etc/passwd")).rejects.toThrow(/Invalid prompt id/);
		await expect(mod.promptLibrary.remove("..\\..\\secret")).rejects.toThrow(/Invalid prompt id/);
	});

	test("missing ids report not-found", async () => {
		await expect(mod.promptLibrary.get("doesnotexist")).rejects.toThrow();
		await expect(mod.promptLibrary.remove("doesnotexist")).rejects.toThrow();
	});

	test("list is newest-updated first", async () => {
		const first = await mod.promptLibrary.create({ name: "Older", content: "a" });
		// Force a distinct timestamp: ISO strings collide inside the same millisecond.
		await Bun.sleep(2);
		const second = await mod.promptLibrary.create({ name: "Newer", content: "b" });

		const listed = await mod.promptLibrary.list();
		const ids = listed.map((entry) => entry.id);
		expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
	});

	test("remove deletes the entry", async () => {
		const created = await mod.promptLibrary.create({ name: "Disposable", content: "a" });
		await mod.promptLibrary.remove(created.id);
		await expect(mod.promptLibrary.get(created.id)).rejects.toThrow();
	});
});
