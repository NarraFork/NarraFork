import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectSkills } from "../skill-service";

const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function projectRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "skill-bounds-"));
	cleanup.push(root);
	return root;
}

function skillMd(name: string): string {
	return `---\nname: "${name}"\ndescription: "probe"\n---\n\nbody\n`;
}

describe("skill loading bounds", () => {
	it("keeps scanning when one SKILL.md is not UTF-8", async () => {
		const root = await projectRoot();
		const skills = join(root, ".narrafork", "skills");
		await mkdir(join(skills, "bad"), { recursive: true });
		await writeFile(join(skills, "bad", "SKILL.md"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
		await mkdir(join(skills, "good"), { recursive: true });
		await writeFile(join(skills, "good", "SKILL.md"), skillMd("good-skill"));

		const loaded = await loadProjectSkills(root);
		expect(loaded.map((skill) => skill.name)).toEqual(["good-skill"]);
	});

	it("does not descend into an oversized skill directory", async () => {
		const root = await projectRoot();
		const skills = join(root, ".narrafork", "skills");
		const huge = join(skills, "huge");
		await mkdir(join(huge, "nested"), { recursive: true });
		await writeFile(join(huge, "SKILL.md"), Buffer.alloc(200_001, 0x61));
		await writeFile(join(huge, "nested", "SKILL.md"), skillMd("nested-skill"));
		await mkdir(join(skills, "container", "real"), { recursive: true });
		await writeFile(join(skills, "container", "real", "SKILL.md"), skillMd("real-nested"));

		const loaded = await loadProjectSkills(root);
		expect(loaded.map((skill) => skill.name)).toEqual(["real-nested"]);
	});

	it("treats an unreadable disabled definition as the skill root", async () => {
		const root = await projectRoot();
		const skills = join(root, ".narrafork", "skills");
		const dir = join(skills, "disabled-bad");
		await mkdir(join(dir, "nested"), { recursive: true });
		await writeFile(join(dir, "SKILL.md.disabled"), Buffer.from([0xff, 0xfe]));
		await writeFile(join(dir, "nested", "SKILL.md"), skillMd("hidden-nested"));

		const loaded = await loadProjectSkills(root);
		expect(loaded.some((skill) => skill.name === "hidden-nested")).toBe(false);
	});
});
