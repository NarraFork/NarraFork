import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeRuntimeTestDb, getRuntimeTestDb } from "./agent-runtime-test-database";

// Skill listings read on the database Worker (file-backed WAL database).
const { db, sqlite, ready } = getRuntimeTestDb();
await ready;
afterAll(() => closeRuntimeTestDb(sqlite));
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

const { getDraftSlashMenuItems } = await import("../command-service");

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("getDraftSlashMenuItems", () => {
	it("lists the skills visible from the chosen directory without any session", async () => {
		const root = mkdtempSync(join(tmpdir(), "draft-slash-menu-"));
		roots.push(root);
		const dir = join(root, ".claude", "skills", "draft-only-skill");
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "SKILL.md"),
			'---\nname: "draft-only-skill"\ndescription: "found from cwd"\n---\n\nbody\n',
		);

		const menu = await getDraftSlashMenuItems("draft-menu-user", root);

		expect(menu.skills).toContainEqual(
			expect.objectContaining({ name: "draft-only-skill", description: "found from cwd" }),
		);
		expect(menu.commands.map((command) => command.name)).toContain("goal");
		expect(menu.allSkillsBlocked).toBe(false);
	});
});
