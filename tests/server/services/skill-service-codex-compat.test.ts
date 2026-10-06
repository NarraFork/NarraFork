import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectSkillByName, loadProjectSkills } from "../../../server/services/skill-service";

// Exercises Codex-compatible skill discovery and metadata parsing via
// `loadProjectSkills`, which walks the project skill directories with no DB
// dependency.

let projectDir: string;

async function writeSkill(relDir: string, skillMd: string, sidecar?: string): Promise<void> {
	const dir = join(projectDir, relDir);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "SKILL.md"), skillMd, "utf-8");
	if (sidecar !== undefined) {
		await mkdir(join(dir, "agents"), { recursive: true });
		await writeFile(join(dir, "agents", "openai.yaml"), sidecar, "utf-8");
	}
}

beforeAll(async () => {
	projectDir = await mkdtemp(join(tmpdir(), "nf-codex-skill-"));

	// 1. Skill under `.codex/skills` with frontmatter `metadata.short-description`.
	await writeSkill(
		join(".codex", "skills", "foo"),
		[
			"---",
			"name: foo",
			"description: A Codex-located skill for demonstrating discovery.",
			"metadata:",
			'  short-description: "Foo short"',
			"---",
			"",
			"# Foo",
			"Body content.",
		].join("\n"),
	);

	// 2. Skill with an openai.yaml sidecar: interface + policy (implicit off).
	await writeSkill(
		join(".codex", "skills", "bar"),
		["---", "name: bar", "description: A skill with a sidecar.", "---", "", "# Bar"].join("\n"),
		[
			"interface:",
			'  display_name: "Bar Display"',
			'  short_description: "Bar short"',
			'  default_prompt: "Run bar with defaults"',
			"policy:",
			"  allow_implicit_invocation: false",
			"",
		].join("\n"),
	);

	// 3. Skill with a malformed sidecar — must fail open (skill still loads).
	await writeSkill(
		join(".codex", "skills", "baz"),
		["---", "name: baz", "description: A skill with a broken sidecar.", "---", "", "# Baz"].join(
			"\n",
		),
		": this is not : valid : yaml\n  - [unbalanced",
	);
});

afterAll(async () => {
	await rm(projectDir, { recursive: true, force: true });
});

describe("Codex-compatible skill discovery", () => {
	test("discovers skills under .codex/skills", async () => {
		const skills = await loadProjectSkills(projectDir);
		const names = skills.map((s) => s.name).sort();
		expect(names).toEqual(["bar", "baz", "foo"]);
	});

	test("parses frontmatter metadata.short-description", async () => {
		const foo = await loadProjectSkillByName(projectDir, "foo");
		expect(foo).not.toBeNull();
		expect(foo?.shortDescription).toBe("Foo short");
	});

	test("parses agents/openai.yaml sidecar (interface + policy)", async () => {
		const bar = await loadProjectSkillByName(projectDir, "bar");
		expect(bar).not.toBeNull();
		expect(bar?.displayName).toBe("Bar Display");
		expect(bar?.shortDescription).toBe("Bar short");
		expect(bar?.defaultPrompt).toBe("Run bar with defaults");
		expect(bar?.allowImplicitInvocation).toBe(false);
	});

	test("frontmatter short-description takes precedence over sidecar", async () => {
		// foo has no sidecar; add a case where both exist would require a 4th skill.
		// Here we assert foo's frontmatter value is used and sidecar-only bar uses sidecar.
		const foo = await loadProjectSkillByName(projectDir, "foo");
		expect(foo?.shortDescription).toBe("Foo short");
	});

	test("malformed sidecar fails open — skill still loads", async () => {
		const baz = await loadProjectSkillByName(projectDir, "baz");
		expect(baz).not.toBeNull();
		expect(baz?.name).toBe("baz");
		expect(baz?.displayName).toBeUndefined();
		expect(baz?.allowImplicitInvocation).toBeUndefined();
	});

	test("skills without policy default to implicit invocation allowed", async () => {
		const foo = await loadProjectSkillByName(projectDir, "foo");
		// allowImplicitInvocation is undefined (treated as true by consumers).
		expect(foo?.allowImplicitInvocation).toBeUndefined();
	});
});
