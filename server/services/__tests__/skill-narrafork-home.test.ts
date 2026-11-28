/**
 * Global skills must be READ from the same directory they are WRITTEN to.
 *
 * `createGlobalSkill` and routine materialization write to `$NARRAFORK_HOME/skills`,
 * but the scanner only ever built its search list from `homedir()` — `~/.narrafork/skills`
 * hardcoded. With the default data directory the two expressions produce the same string,
 * so the split went unnoticed; set `NARRAFORK_HOME` elsewhere and every global skill was
 * written into a directory nothing read back. No error, no empty-state hint: the skill
 * appeared in the UI list (which reads the same scan) as simply absent.
 *
 * Use a separate fixture directory explicitly: on Windows and newer Bun releases,
 * homedir() follows the preload's HOME/USERPROFILE overrides, so the default
 * preload directory alone no longer guarantees different read and write roots.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getNarraforkHome } from "@server/lib/narrafork-home";
import { loadGlobalSkills, loadProjectSkills } from "../skill-service";

const NAME = `narrafork-home-probe-${process.pid}`;

const cleanup: string[] = [];
const originalNarraforkHome = process.env.NARRAFORK_HOME;
let customHome: string;

beforeAll(async () => {
	customHome = await mkdtemp(join(tmpdir(), "skill-custom-home-"));
	process.env.NARRAFORK_HOME = customHome;
});

afterAll(async () => {
	if (originalNarraforkHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = originalNarraforkHome;
	await rm(customHome, { recursive: true, force: true });
});

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function writeSkillUnder(baseDir: string, name: string): Promise<string> {
	const dir = join(baseDir, name);
	await mkdir(dir, { recursive: true });
	const file = join(dir, "SKILL.md");
	await writeFile(file, `---\nname: "${name}"\ndescription: "probe"\n---\n\nbody\n`);
	cleanup.push(dir);
	return file;
}

describe("global skill scanning honors NARRAFORK_HOME", () => {
	it("is running with NARRAFORK_HOME outside the home directory", () => {
		// Guards the premise: if these ever coincide, the assertions below would pass
		// against the old hardcoded path too and stop testing anything.
		expect(getNarraforkHome()).not.toBe(resolve(homedir(), ".narrafork"));
	});

	it("discovers a skill written to $NARRAFORK_HOME/skills", async () => {
		const location = await writeSkillUnder(join(getNarraforkHome(), "skills"), NAME);

		const found = (await loadGlobalSkills()).find((s) => s.name === NAME);
		expect(found?.location).toBe(location);
	});

	/**
	 * The user-level directory must not be appended to project/workspace roots: doing so
	 * would report the same global skill once per project as a PROJECT skill, and let it
	 * shadow a genuine project-level skill of the same name.
	 */
	it("does not scan $NARRAFORK_HOME/skills for a project root", async () => {
		await writeSkillUnder(join(getNarraforkHome(), "skills"), NAME);
		const projectRoot = await mkdtemp(join(tmpdir(), "skill-nf-home-"));
		cleanup.push(projectRoot);

		const skills = await loadProjectSkills(projectRoot);
		expect(skills.some((s) => s.name === NAME)).toBe(false);
	});
});
