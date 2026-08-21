/**
 * Disabling a skill must actually hide it from the model.
 *
 * Two code paths resolve a skill-name collision, and they used to disagree:
 *
 *   - `scanSkillDirs` (behind `loadGlobalSkills`, which the toggle/CRUD routes use)
 *     walks `getSkillSearchDirs` in order and lets each later directory overwrite
 *     the earlier one, so the LAST search dir wins.
 *   - `discoverSkillFiles` (behind `loadSkillSummariesForContext`, which builds the
 *     `<available_skills>` list the model sees) sorted purely by absolute path.
 *
 * Those orders are not the same: `.agents` and `.claude` sort BEFORE `.narrafork`
 * alphabetically but rank AFTER it in the search list. So with the same skill name
 * present in two roots, the toggle renamed the copy in one directory while the
 * model kept reading the still-enabled copy from the other — the switch flipped in
 * the UI and the skill stayed fully available. Silent in both directions: no error,
 * and the UI showed `disabled` because it reads the same list the toggle used.
 *
 * The regression is about ORDERING, so the tests assert which concrete file wins
 * rather than just "some copy is disabled".
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillSummariesForContext } from "../skill-service";

const NAME = "collision-skill";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "skill-precedence-"));
	roots.push(root);
	return root;
}

/** Write a skill named {@link NAME} into `<root>/<relDir>/<NAME>/SKILL.md`. */
async function writeSkill(root: string, relDir: string[], disabled = false): Promise<string> {
	const dir = join(root, ...relDir, NAME);
	await mkdir(dir, { recursive: true });
	const file = join(dir, disabled ? "SKILL.md.disabled" : "SKILL.md");
	await writeFile(
		file,
		`---\nname: "${NAME}"\ndescription: "in ${relDir.join("/")}"\n---\n\nbody\n`,
	);
	return file;
}

async function resolveSkill(root: string) {
	// forceRefresh bypasses the 15s summary TTL so each assertion reads the real
	// filesystem rather than a cache entry written by the previous step.
	const { skills } = await loadSkillSummariesForContext(
		{ projectGitPath: null, cwd: root },
		{ forceRefresh: true },
	);
	return skills.find((s) => s.name === NAME);
}

describe("skill name collisions resolve by search-dir precedence", () => {
	/**
	 * `.agents/skills` ranks AFTER `.narrafork/skills` in `getSkillSearchDirs` — later
	 * means higher priority, since the resolver lets a later entry overwrite an
	 * earlier one — but it sorts FIRST alphabetically. Under the old path-sort it
	 * therefore lost, so a disable applied to it was ignored.
	 *
	 * (`.agents` is not the last search dir overall; `.codex/skills` is, plus
	 * `CODEX_HOME` at the home root. All this case needs is that `.agents` ranks after
	 * `.narrafork` while sorting before it.)
	 */
	it("prefers .agents/skills over .narrafork/skills", async () => {
		const root = makeRoot();
		await writeSkill(root, [".narrafork", "skills"]);
		const agents = await writeSkill(root, [".agents", "skills"]);

		expect((await resolveSkill(root))?.location).toBe(agents);
	});

	it("prefers .claude/skills over .narrafork/skills", async () => {
		const root = makeRoot();
		await writeSkill(root, [".narrafork", "skills"]);
		const claude = await writeSkill(root, [".claude", "skills"]);

		expect((await resolveSkill(root))?.location).toBe(claude);
	});

	/**
	 * THE user-visible bug: disabling the winning copy must disable the skill, not
	 * hand the name to a lower-priority enabled copy.
	 */
	it("stays disabled when the winning copy is disabled and a lower-priority copy is enabled", async () => {
		const root = makeRoot();
		await writeSkill(root, [".narrafork", "skills"]);
		const claude = await writeSkill(root, [".claude", "skills"]);

		expect((await resolveSkill(root))?.disabled).toBeFalsy();

		// Exactly what toggleGlobalSkill does to the winning copy.
		await rename(claude, `${claude}.disabled`);

		const after = await resolveSkill(root);
		expect(after?.location).toBe(`${claude}.disabled`);
		expect(after?.disabled).toBe(true);
	});

	/**
	 * The converse: a disabled LOW-priority copy must not suppress the enabled
	 * high-priority one, or the fix would trade a stuck-on skill for a stuck-off one.
	 */
	it("stays enabled when only a lower-priority copy is disabled", async () => {
		const root = makeRoot();
		await writeSkill(root, [".narrafork", "skills"], true);
		const claude = await writeSkill(root, [".claude", "skills"]);

		const resolved = await resolveSkill(root);
		expect(resolved?.location).toBe(claude);
		expect(resolved?.disabled).toBeFalsy();
	});
});

/**
 * A same-name collision INSIDE one search directory.
 *
 * Cross-directory precedence is settled by `searchDirRank`, but two skills of the
 * same name can also sit in sibling sub-directories of a single search dir. There
 * the winner falls out of arrival order, and `readdir` guarantees none — so the two
 * walkers could pick different copies on the same filesystem (and the same walker
 * could pick differently between runs). Both now sort their directory entries by
 * name, which makes the choice deterministic and identical on both paths.
 *
 * Rare in practice, which is exactly why it must be pinned: a flake here reads as
 * "the disable did not take" once in a while, with nothing to reproduce.
 */
describe("skill name collisions inside ONE search directory", () => {
	/** Write the skill nested one level deeper: `<root>/.narrafork/skills/<sub>/<NAME>`. */
	async function writeNested(root: string, sub: string, disabled = false): Promise<string> {
		return writeSkill(root, [".narrafork", "skills", sub], disabled);
	}

	it("resolves to the same copy on every run (name order, not readdir order)", async () => {
		const root = makeRoot();
		await writeNested(root, "b-second");
		await writeNested(root, "a-first");

		const first = (await resolveSkill(root))?.location;
		const second = (await resolveSkill(root))?.location;
		expect(first).toBeDefined();
		// Deterministic across runs…
		expect(second).toBe(first);
		// …and specifically the LAST name in sort order, since a later arrival
		// overwrites an earlier one in the resolver's map.
		expect(first).toContain(join("skills", "b-second"));
	});

	it("keeps a disabled winner disabled", async () => {
		// The user's disable must survive even when the loser copy is enabled — the
		// same guarantee as the cross-directory case, at this finer granularity.
		const root = makeRoot();
		await writeNested(root, "a-first");
		await writeNested(root, "b-second", true);

		const skill = await resolveSkill(root);
		expect(skill?.disabled).toBe(true);
		expect(skill?.location).toContain(join("skills", "b-second"));
	});
});
